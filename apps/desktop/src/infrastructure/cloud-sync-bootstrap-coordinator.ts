import { CloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import type { CloudSyncSnapshotResponse } from "@inkshadow/contracts";
import type {
  SyncRemoteCheckpoint,
  SyncSnapshotStagingSummary,
  SyncSqliteStore,
} from "@inkshadow/data/sync-sqlite-store";
import { AppError, type Clock, type Result } from "@inkshadow/domain";

import {
  CloudSessionCoordinatorError,
  type CloudSessionCoordinator,
} from "./cloud-session-coordinator";

const DEFAULT_SNAPSHOT_PAGE_SIZE = 128;
const DEFAULT_MAXIMUM_SNAPSHOT_PAGES = 64;
const DEFAULT_MAXIMUM_SNAPSHOT_RESTARTS = 2;

export type CloudSyncBootstrapApi = Pick<
  InkShadowCloudApiClient,
  "getProjectState" | "getSyncSnapshot"
>;

export type CloudSyncBootstrapSession = Pick<CloudSessionCoordinator, "runWithSession">;

export type CloudSyncBootstrapPersistence = Pick<
  SyncSqliteStore,
  | "commitStagedSyncSnapshot"
  | "discardStagedSyncSnapshot"
  | "readRemoteCheckpoint"
  | "readStagedSyncSnapshot"
  | "stageSyncSnapshotPage"
>;

export interface CloudSyncBootstrapLimits {
  readonly pageSize?: number;
  readonly maximumPages?: number;
  readonly maximumRestarts?: number;
}

export interface CloudSyncBootstrapCoordinatorDependencies {
  /**
   * Snapshot bootstrap is opt-in. A missing value is deliberately disabled.
   */
  readonly enabled?: boolean;
  readonly api: CloudSyncBootstrapApi;
  readonly session: CloudSyncBootstrapSession;
  readonly store: CloudSyncBootstrapPersistence;
  readonly clock: Clock;
  readonly limits?: CloudSyncBootstrapLimits;
}

export interface RunCloudSyncBootstrapOptions {
  readonly signal?: AbortSignal;
  /**
   * Runtime-owned frozen-registration check. It is evaluated before every
   * network page and again before persisting a response.
   */
  readonly assertAuthority?: () => Promise<void>;
}

export type CloudSyncBootstrapState =
  | "aborted"
  | "auth_blocked"
  | "ciphertext_baseline_committed"
  | "ciphertext_bootstrap_incomplete"
  | "disabled"
  | "incremental_available"
  | "offline"
  | "permanent_paused"
  | "retryable";

export type CloudSyncBootstrapFailureCategory =
  "auth_blocked" | "bootstrap_incomplete" | "offline" | "permanent_paused" | "retryable";

export interface CloudSyncBootstrapFailure {
  readonly category: CloudSyncBootstrapFailureCategory;
  readonly code: string;
}

/**
 * `ciphertext_baseline_committed` is intentionally not a "synced" state.
 * The data store has atomically replaced only the encrypted chunk/tombstone
 * baseline and its remote checkpoint. A separate durable materializer must
 * prove that the snapshot operations reached plaintext business state before
 * any caller may enable push.
 */
export interface CloudSyncBootstrapResult {
  readonly projectId: string;
  readonly state: CloudSyncBootstrapState;
  readonly pushAllowed: boolean;
  readonly plaintextMaterializationRequired: boolean;
  readonly pagesFetched: number;
  readonly restarts: number;
  readonly checkpoint: SyncRemoteCheckpoint | null;
  readonly failure: CloudSyncBootstrapFailure | null;
}

interface NormalizedLimits {
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly maximumRestarts: number;
}

interface FixedSnapshotIdentity {
  readonly snapshotId: string;
  readonly snapshotExpiresAt: string;
  readonly snapshotSignedRemoteCursor: string;
}

class LocalSnapshotExpiryError extends Error {
  public constructor() {
    super("The staged cloud snapshot expired before its next page could be committed.");
    this.name = "LocalSnapshotExpiryError";
  }
}

/**
 * Performs ciphertext-only recovery for an expired cloud cursor.
 *
 * This coordinator is deliberately independent from the continuous sync
 * orchestrator. Its result is a fail-closed boundary: snapshot staging,
 * snapshot commit, abort, and retry exhaustion all keep push disabled.
 */
export class CloudSyncBootstrapCoordinator {
  private readonly enabled: boolean;
  private readonly api: CloudSyncBootstrapApi;
  private readonly session: CloudSyncBootstrapSession;
  private readonly store: CloudSyncBootstrapPersistence;
  private readonly clock: Clock;
  private readonly limits: NormalizedLimits;
  private readonly activeProjects = new Map<string, Promise<CloudSyncBootstrapResult>>();

  public constructor(dependencies: CloudSyncBootstrapCoordinatorDependencies) {
    this.enabled = dependencies.enabled === true;
    this.api = dependencies.api;
    this.session = dependencies.session;
    this.store = dependencies.store;
    this.clock = dependencies.clock;
    this.limits = normalizeLimits(dependencies.limits ?? {});
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public runProjectBootstrap(
    projectId: string,
    options: RunCloudSyncBootstrapOptions = {},
  ): Promise<CloudSyncBootstrapResult> {
    const active = this.activeProjects.get(projectId);
    if (active !== undefined) {
      return active;
    }
    const bootstrap = this.executeProjectBootstrap(projectId, options).finally(() => {
      if (this.activeProjects.get(projectId) === bootstrap) {
        this.activeProjects.delete(projectId);
      }
    });
    this.activeProjects.set(projectId, bootstrap);
    return bootstrap;
  }

  private async executeProjectBootstrap(
    projectId: string,
    options: RunCloudSyncBootstrapOptions,
  ): Promise<CloudSyncBootstrapResult> {
    if (!this.enabled) {
      return result(projectId, "disabled", false, false, 0, 0, null, null);
    }
    if (isSignalAborted(options.signal)) {
      return aborted(projectId, 0, 0, null);
    }

    let pagesFetched = 0;
    let restarts = 0;
    let epochFloor = 0;
    let checkpoint: SyncRemoteCheckpoint | null = null;

    for (;;) {
      let activeStaging: SyncSnapshotStagingSummary | null = null;
      try {
        await assertBootstrapBoundary(options);
        checkpoint = unwrap(await this.store.readRemoteCheckpoint(projectId));
        await assertBootstrapBoundary(options);
        const projectState = await this.session.runWithSession(
          () =>
            this.api.getProjectState(projectId, {
              cursor: checkpoint?.signedRemoteCursor ?? null,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            }),
          options.signal === undefined ? {} : { signal: options.signal },
        );
        await assertBootstrapBoundary(options);

        const persisted = unwrap(await this.store.readStagedSyncSnapshot(projectId));
        await assertBootstrapBoundary(options);
        if (persisted !== null) {
          epochFloor = Math.max(epochFloor, persisted.epoch);
        }

        if (projectState.project.sync.cursorStatus === "incremental_available") {
          return await this.finishIncrementalPath(
            projectId,
            checkpoint,
            persisted,
            pagesFetched,
            restarts,
            options,
          );
        }

        let epoch: number;
        if (
          persisted?.state === "staging" &&
          sameCheckpoint(persisted.baseCheckpoint, checkpoint)
        ) {
          activeStaging = persisted;
          epoch = persisted.epoch;
        } else {
          if (persisted?.state === "staging") {
            unwrap(
              await this.store.discardStagedSyncSnapshot({
                snapshotId: persisted.snapshotId,
                projectId,
                epoch: persisted.epoch,
              }),
            );
          }
          epoch = nextEpoch(epochFloor);
          epochFloor = epoch;
        }

        if (activeStaging?.pagesComplete === true) {
          return await this.commitCiphertextBaseline(
            projectId,
            activeStaging,
            pagesFetched,
            restarts,
            options,
          );
        }

        let fixedIdentity: FixedSnapshotIdentity | null =
          activeStaging === null
            ? null
            : {
                snapshotId: activeStaging.snapshotId,
                snapshotExpiresAt: activeStaging.snapshotExpiresAt,
                snapshotSignedRemoteCursor: activeStaging.snapshotSignedRemoteCursor,
              };
        let requestCursor = activeStaging?.nextSnapshotCursor ?? null;
        let pageIndex = activeStaging?.nextPageIndex ?? 0;

        for (;;) {
          await assertBootstrapBoundary(options);
          if (
            fixedIdentity !== null &&
            hasExpired(fixedIdentity.snapshotExpiresAt, this.clock.now())
          ) {
            throw new LocalSnapshotExpiryError();
          }
          if (pagesFetched >= this.limits.maximumPages) {
            return result(
              projectId,
              "ciphertext_bootstrap_incomplete",
              false,
              false,
              pagesFetched,
              restarts,
              checkpoint,
              {
                category: "bootstrap_incomplete",
                code: "SYNC_SNAPSHOT_PAGE_LIMIT_REACHED",
              },
            );
          }

          const response = await this.session.runWithSession(
            () =>
              this.api.getSyncSnapshot(projectId, {
                cursor: requestCursor,
                limit: this.limits.pageSize,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              }),
            options.signal === undefined ? {} : { signal: options.signal },
          );
          pagesFetched += 1;
          await assertBootstrapBoundary(options);
          const receivedAt = this.clock.now();
          fixedIdentity = validateSnapshotPage(response, fixedIdentity, requestCursor, receivedAt);

          await assertBootstrapBoundary(options);
          const staged = unwrap(
            await this.store.stageSyncSnapshotPage({
              snapshotId: response.snapshotId,
              projectId,
              epoch,
              pageIndex,
              resumeCursor: requestCursor,
              snapshotExpiresAt: response.snapshotExpiresAt,
              snapshotSignedRemoteCursor: response.resumeCursor,
              nextSnapshotCursor: response.nextSnapshotCursor,
              finalSignedRemoteCursor: response.hasMore ? null : response.resumeCursor,
              operations: response.operations,
              chunks: response.chunks,
              tombstones: response.tombstones,
              receivedAt,
            }),
          );
          await assertBootstrapBoundary(options);
          activeStaging = staged.snapshot;
          assertStagingAdvanced(
            activeStaging,
            checkpoint,
            fixedIdentity,
            epoch,
            pageIndex,
            response.nextSnapshotCursor,
            response.hasMore,
          );

          if (!response.hasMore) {
            await assertBootstrapBoundary(options);
            return await this.commitCiphertextBaseline(
              projectId,
              activeStaging,
              pagesFetched,
              restarts,
              options,
            );
          }
          requestCursor = response.nextSnapshotCursor;
          pageIndex += 1;
        }
      } catch (cause: unknown) {
        if (isAbort(cause, options.signal)) {
          return aborted(projectId, pagesFetched, restarts, checkpoint);
        }
        if (!isSnapshotExpiry(cause)) {
          const failure = classifyBootstrapFailure(cause);
          if (failure === null) {
            throw cause;
          }
          return result(
            projectId,
            failure.state,
            false,
            false,
            pagesFetched,
            restarts,
            checkpoint,
            { category: failure.state, code: failure.code },
          );
        }

        if (activeStaging === null) {
          const persisted = unwrap(await this.store.readStagedSyncSnapshot(projectId));
          if (persisted?.state === "staging") {
            activeStaging = persisted;
          }
        }
        if (activeStaging?.state === "staging") {
          unwrap(
            await this.store.discardStagedSyncSnapshot({
              snapshotId: activeStaging.snapshotId,
              projectId,
              epoch: activeStaging.epoch,
            }),
          );
          epochFloor = Math.max(epochFloor, activeStaging.epoch);
          activeStaging = null;
        }
        restarts += 1;
        if (restarts > this.limits.maximumRestarts) {
          return result(
            projectId,
            "ciphertext_bootstrap_incomplete",
            false,
            false,
            pagesFetched,
            restarts,
            checkpoint,
            { category: "bootstrap_incomplete", code: "SYNC_CURSOR_EXPIRED" },
          );
        }
      }
    }
  }

  private async finishIncrementalPath(
    projectId: string,
    checkpoint: SyncRemoteCheckpoint,
    persisted: SyncSnapshotStagingSummary | null,
    pagesFetched: number,
    restarts: number,
    options: RunCloudSyncBootstrapOptions,
  ): Promise<CloudSyncBootstrapResult> {
    await assertBootstrapBoundary(options);
    if (persisted?.state === "committed") {
      return result(
        projectId,
        "ciphertext_baseline_committed",
        false,
        true,
        pagesFetched,
        restarts,
        checkpoint,
        null,
      );
    }
    if (persisted?.state === "staging") {
      await assertBootstrapBoundary(options);
      unwrap(
        await this.store.discardStagedSyncSnapshot({
          snapshotId: persisted.snapshotId,
          projectId,
          epoch: persisted.epoch,
        }),
      );
      await assertBootstrapBoundary(options);
      const remaining = unwrap(await this.store.readStagedSyncSnapshot(projectId));
      if (remaining?.state === "staging") {
        throw stateError(
          "Cloud push cannot be enabled while a snapshot staging session remains active.",
        );
      }
      if (remaining?.state === "committed") {
        return result(
          projectId,
          "ciphertext_baseline_committed",
          false,
          true,
          pagesFetched,
          restarts,
          checkpoint,
          null,
        );
      }
    }
    return result(
      projectId,
      "incremental_available",
      false,
      true,
      pagesFetched,
      restarts,
      checkpoint,
      null,
    );
  }

  private async commitCiphertextBaseline(
    projectId: string,
    staging: SyncSnapshotStagingSummary,
    pagesFetched: number,
    restarts: number,
    options: RunCloudSyncBootstrapOptions,
  ): Promise<CloudSyncBootstrapResult> {
    await assertBootstrapBoundary(options);
    const signal = options.signal;
    const preflight = await this.session.runWithSession(
      () =>
        this.api.getProjectState(projectId, {
          cursor: staging.snapshotSignedRemoteCursor,
          ...(signal === undefined ? {} : { signal }),
        }),
      signal === undefined ? {} : { signal },
    );
    await assertBootstrapBoundary(options);
    if (preflight.project.sync.cursorStatus !== "incremental_available") {
      throw new LocalSnapshotExpiryError();
    }
    await assertBootstrapBoundary(options);
    const committed = unwrap(
      await this.store.commitStagedSyncSnapshot({
        snapshotId: staging.snapshotId,
        projectId,
        epoch: staging.epoch,
        now: this.clock.now(),
      }),
    );
    await assertBootstrapBoundary(options);
    if (
      committed.snapshotId !== staging.snapshotId ||
      committed.projectId !== projectId ||
      committed.epoch !== staging.epoch ||
      committed.checkpoint.projectId !== projectId ||
      committed.checkpoint.signedRemoteCursor !== staging.snapshotSignedRemoteCursor
    ) {
      throw stateError("The committed ciphertext snapshot receipt is inconsistent.");
    }
    return result(
      projectId,
      "ciphertext_baseline_committed",
      false,
      true,
      pagesFetched,
      restarts,
      committed.checkpoint,
      null,
    );
  }
}

function normalizeLimits(limits: CloudSyncBootstrapLimits): NormalizedLimits {
  return {
    pageSize: requireBoundedInteger(
      limits.pageSize ?? DEFAULT_SNAPSHOT_PAGE_SIZE,
      "pageSize",
      1,
      256,
    ),
    maximumPages: requireBoundedInteger(
      limits.maximumPages ?? DEFAULT_MAXIMUM_SNAPSHOT_PAGES,
      "maximumPages",
      1,
      1_024,
    ),
    maximumRestarts: requireBoundedInteger(
      limits.maximumRestarts ?? DEFAULT_MAXIMUM_SNAPSHOT_RESTARTS,
      "maximumRestarts",
      0,
      8,
    ),
  };
}

function requireBoundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} is outside the supported range.`);
  }
  return value;
}

function nextEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) {
    throw stateError("The local cloud snapshot epoch cannot advance safely.");
  }
  return epoch + 1;
}

function validateSnapshotPage(
  response: CloudSyncSnapshotResponse,
  fixed: FixedSnapshotIdentity | null,
  requestCursor: string | null,
  receivedAt: string,
): FixedSnapshotIdentity {
  if (response.hasMore !== (response.nextSnapshotCursor !== null)) {
    throw protocolError("Cloud snapshot pagination state is inconsistent.", response.requestId);
  }
  if (response.nextSnapshotCursor !== null && response.nextSnapshotCursor === requestCursor) {
    throw protocolError(
      "Cloud snapshot pagination did not advance its continuation cursor.",
      response.requestId,
    );
  }
  if (hasExpired(response.snapshotExpiresAt, receivedAt)) {
    throw new LocalSnapshotExpiryError();
  }
  if (fixed === null) {
    return {
      snapshotId: response.snapshotId,
      snapshotExpiresAt: response.snapshotExpiresAt,
      snapshotSignedRemoteCursor: response.resumeCursor,
    };
  }
  if (fixed.snapshotId !== response.snapshotId) {
    throw protocolError("Cloud snapshot identity changed between pages.", response.requestId);
  }
  if (fixed.snapshotExpiresAt !== response.snapshotExpiresAt) {
    throw protocolError("Cloud snapshot expiry changed between pages.", response.requestId);
  }
  if (fixed.snapshotSignedRemoteCursor !== response.resumeCursor) {
    throw protocolError(
      "Cloud snapshot remote high-water cursor changed between pages.",
      response.requestId,
    );
  }
  return {
    ...fixed,
    snapshotExpiresAt: response.snapshotExpiresAt,
  };
}

function assertStagingAdvanced(
  staging: SyncSnapshotStagingSummary,
  baseCheckpoint: SyncRemoteCheckpoint,
  fixed: FixedSnapshotIdentity,
  epoch: number,
  pageIndex: number,
  nextSnapshotCursor: string | null,
  hasMore: boolean,
): void {
  if (
    staging.state !== "staging" ||
    staging.snapshotId !== fixed.snapshotId ||
    staging.projectId !== baseCheckpoint.projectId ||
    staging.epoch !== epoch ||
    staging.snapshotExpiresAt !== fixed.snapshotExpiresAt ||
    staging.snapshotSignedRemoteCursor !== fixed.snapshotSignedRemoteCursor ||
    staging.nextPageIndex !== pageIndex + 1 ||
    staging.nextSnapshotCursor !== nextSnapshotCursor ||
    staging.pagesComplete !== !hasMore ||
    staging.finalSignedRemoteCursor !== (hasMore ? null : fixed.snapshotSignedRemoteCursor) ||
    !sameCheckpoint(staging.baseCheckpoint, baseCheckpoint)
  ) {
    throw stateError("The local ciphertext snapshot staging receipt is inconsistent.");
  }
}

function sameCheckpoint(left: SyncRemoteCheckpoint, right: SyncRemoteCheckpoint): boolean {
  return (
    left.projectId === right.projectId &&
    left.signedRemoteCursor === right.signedRemoteCursor &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt
  );
}

function hasExpired(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

function unwrap<Value>(value: Result<Value, AppError>): Value {
  if (!value.ok) {
    throw value.error;
  }
  return value.value;
}

function stateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    retryable: false,
    actions: ["CONTACT_SUPPORT"],
  });
}

function protocolError(message: string, requestId: string): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    message,
    status: null,
    requestId,
    retryable: false,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}

interface ClassifiedBootstrapFailure {
  readonly state: "auth_blocked" | "offline" | "permanent_paused" | "retryable";
  readonly code: string;
}

function classifyBootstrapFailure(cause: unknown): ClassifiedBootstrapFailure | null {
  if (cause instanceof CloudSessionCoordinatorError) {
    return {
      state: "auth_blocked",
      code: normalizeFailureCode(cause.sourceCode, "CLOUD_AUTHENTICATION_REQUIRED"),
    };
  }
  if (cause instanceof CloudClientError) {
    const code = normalizeFailureCode(cause.code, "CLOUD_SYNC_BOOTSTRAP_FAILED");
    if (
      cause.code === "AUTH_NETWORK_UNAVAILABLE" ||
      cause.code === "CLOUD_NETWORK_UNAVAILABLE" ||
      cause.code === "CLOUD_REQUEST_TIMEOUT"
    ) {
      return { state: "offline", code };
    }
    if (
      cause.code === "ACCESS_FORBIDDEN" ||
      cause.code === "AUTH_ACCOUNT_FROZEN" ||
      cause.code === "AUTH_ACCOUNT_LOCKED" ||
      cause.code === "AUTH_DEVICE_REVOKED" ||
      cause.code === "AUTH_EMAIL_UNVERIFIED" ||
      cause.code === "AUTH_INVALID_CREDENTIALS" ||
      cause.code === "AUTH_REFRESH_REPLAYED" ||
      cause.code === "AUTH_SESSION_EXPIRED" ||
      cause.code === "AUTH_SESSION_REVOKED" ||
      cause.code === "AUTH_UPGRADE_REQUIRED" ||
      cause.code === "CLOUD_AUTHENTICATION_REQUIRED"
    ) {
      return { state: "auth_blocked", code };
    }
    return {
      state: cause.retryable ? "retryable" : "permanent_paused",
      code,
    };
  }
  if (cause instanceof AppError) {
    return {
      state: cause.retryable ? "retryable" : "permanent_paused",
      code: normalizeFailureCode(cause.code, "LOCAL_SYNC_BOOTSTRAP_FAILED"),
    };
  }
  return null;
}

function normalizeFailureCode(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : fallback;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function assertBootstrapBoundary(options: RunCloudSyncBootstrapOptions): Promise<void> {
  throwIfAborted(options.signal);
  await options.assertAuthority?.();
  throwIfAborted(options.signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isSignalAborted(signal)) {
    throw new DOMException("The cloud ciphertext bootstrap was aborted.", "AbortError");
  }
}

function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  return (
    isSignalAborted(signal) ||
    (cause instanceof CloudClientError && cause.code === "CLOUD_REQUEST_ABORTED") ||
    (cause instanceof DOMException && cause.name === "AbortError")
  );
}

function isSnapshotExpiry(cause: unknown): boolean {
  return (
    cause instanceof LocalSnapshotExpiryError ||
    (cause instanceof CloudClientError && cause.code === "SYNC_CURSOR_EXPIRED")
  );
}

function aborted(
  projectId: string,
  pagesFetched: number,
  restarts: number,
  checkpoint: SyncRemoteCheckpoint | null,
): CloudSyncBootstrapResult {
  return result(projectId, "aborted", false, false, pagesFetched, restarts, checkpoint, null);
}

function result(
  projectId: string,
  state: CloudSyncBootstrapState,
  pushAllowed: boolean,
  plaintextMaterializationRequired: boolean,
  pagesFetched: number,
  restarts: number,
  checkpoint: SyncRemoteCheckpoint | null,
  failure: CloudSyncBootstrapFailure | null,
): CloudSyncBootstrapResult {
  return {
    projectId,
    state,
    pushAllowed,
    plaintextMaterializationRequired,
    pagesFetched,
    restarts,
    checkpoint,
    failure,
  };
}
