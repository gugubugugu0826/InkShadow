import type { InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import {
  SyncIncrementalSettlementSqliteStore,
  SyncMaterializationSqliteStore,
  SyncSnapshotMaterializationSqliteStore,
  type ProjectSyncRegistration,
  type SqlExecutor,
} from "@inkshadow/data";
import type { SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import type { ProjectKeySqliteStore } from "@inkshadow/data/project-key-sqlite-store";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";

import type { CloudProjectKeyCoordinator } from "./cloud-project-key-coordinator.js";
import {
  CloudProjectSyncEnrollmentService,
  type CloudProjectSyncKeyPublicationPort,
} from "./cloud-project-sync-enrollment-service.js";
import type {
  CloudSessionCoordinator,
  ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator.js";
import { CloudSyncBootstrapCoordinator } from "./cloud-sync-bootstrap-coordinator.js";
import { CloudSyncControlService } from "./cloud-sync-control-service.js";
import { CloudSyncIncrementalSettlementCoordinator } from "./cloud-sync-incremental-settlement-coordinator.js";
import { CloudSyncInitialProjectionSeeder } from "./cloud-sync-initial-projection-seeder.js";
import { CloudSyncOrchestrator, type IncomingApplyOutcome } from "./cloud-sync-orchestrator.js";
import {
  CloudSyncRuntimeService,
  type CloudSyncRuntimeAuthorityBinding,
  type CloudSyncRuntimeOrchestratorFactory,
} from "./cloud-sync-runtime-service.js";
import { CloudSyncSnapshotMaterializationCoordinator } from "./cloud-sync-snapshot-materialization-coordinator.js";
import { CloudSyncSupervisor } from "./cloud-sync-supervisor.js";
import { ContentSyncMaterializer } from "./content-sync-materializer.js";
import {
  IncomingContentDecryptor,
  type PreparedIncomingContentMutation,
} from "./incoming-content-decryptor.js";
import {
  OutgoingContentProjectionWorker,
  type OpenedProjectionProjectKey,
  type ProjectionProjectKeyOpener,
} from "./outgoing-content-projection-worker.js";
import type { ProjectKeyLifecycleService } from "./project-key-lifecycle.js";
import { SqliteSyncConflictResolutionStore } from "./sqlite-sync-conflict-resolution-store.js";
import { SyncConflictResolutionCoordinator } from "./sync-conflict-resolution-coordinator.js";

export interface CloudSyncRuntimeWiringDependencies {
  readonly mode: "tauri" | "browser-development";
  readonly enabled: boolean;
  readonly executor: SqlExecutor | null;
  readonly syncStore: SyncSqliteStore | null;
  readonly api: InkShadowCloudApiClient | null;
  readonly session: CloudSessionCoordinator | null;
  readonly projectSecurity: ProjectKeyLifecycleService | null;
  readonly cloudProjectKeys: CloudProjectKeyCoordinator | null;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
}

export interface CloudSyncEnrollmentWiringDependencies {
  readonly mode: "tauri" | "browser-development";
  readonly enabled: boolean;
  readonly executor: SqlExecutor | null;
  readonly syncStore: SyncSqliteStore | null;
  readonly projectKeyStore: ProjectKeySqliteStore | null;
  readonly session: CloudSessionCoordinator | null;
  readonly cloudProjectKeys: CloudProjectKeyCoordinator | null;
  readonly cloudSync: CloudSyncRuntimeService | null;
  readonly clock: Clock;
}

export interface CloudSyncSupervisorWiringDependencies {
  readonly mode: "tauri" | "browser-development";
  readonly enabled: boolean;
  readonly executor: SqlExecutor | null;
  readonly cloudSync: CloudSyncRuntimeService | null;
}

export interface CloudSyncControlWiringDependencies {
  readonly mode: "tauri" | "browser-development";
  readonly enabled: boolean;
  readonly executor: SqlExecutor | null;
  readonly cloudSync: CloudSyncRuntimeService | null;
  readonly enrollment: CloudProjectSyncEnrollmentService | null;
  readonly clock: Clock;
}

export interface SyncConflictResolutionWiringDependencies {
  readonly mode: "tauri" | "browser-development";
  readonly enabled: boolean;
  readonly executor: SqlExecutor | null;
  readonly syncStore: SyncSqliteStore | null;
  readonly session: CloudSessionCoordinator | null;
  readonly projectSecurity: ProjectKeyLifecycleService | null;
  readonly cloudProjectKeys: CloudProjectKeyCoordinator | null;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
}

/**
 * Constructs the complete protocol-v2 runtime as one fail-closed unit.
 *
 * This function returns before allocating stores, worker identities, key
 * resolvers, or network coordinators unless every production dependency is
 * present and cloud sync is explicitly enabled.
 */
export function createCloudSyncRuntimeService(
  dependencies: CloudSyncRuntimeWiringDependencies,
): CloudSyncRuntimeService | null {
  if (
    dependencies.mode !== "tauri" ||
    !dependencies.enabled ||
    dependencies.executor === null ||
    dependencies.syncStore === null ||
    dependencies.api === null ||
    dependencies.session === null ||
    dependencies.projectSecurity === null ||
    dependencies.cloudProjectKeys === null
  ) {
    return null;
  }

  const { executor, syncStore, api, session, projectSecurity, cloudProjectKeys, ids, clock } =
    dependencies;
  const materializationStore = new SyncMaterializationSqliteStore(executor);
  const snapshotStore = new SyncSnapshotMaterializationSqliteStore(executor);
  const incrementalSettlementStore = new SyncIncrementalSettlementSqliteStore(executor);
  const seeder = new CloudSyncInitialProjectionSeeder(ids);
  const projectKeys = new AuthorityBoundProjectKeyOpener(
    session,
    materializationStore,
    projectSecurity,
    cloudProjectKeys,
  );
  const decryptor = new IncomingContentDecryptor((projectId, keyVersion) =>
    projectKeys.openHistoricalProjectKey(projectId, keyVersion),
  );
  const materializer = new ContentSyncMaterializer(decryptor);
  const bootstrap = new CloudSyncBootstrapCoordinator({
    enabled: true,
    api,
    session,
    store: syncStore,
    clock,
  });
  const snapshotMaterializer = new CloudSyncSnapshotMaterializationCoordinator({
    enabled: true,
    snapshotStore,
    authority: materializationStore,
    materializer,
    seeder,
    clock,
  });
  const incrementalSettlement = new CloudSyncIncrementalSettlementCoordinator({
    enabled: true,
    store: incrementalSettlementStore,
    authority: materializationStore,
    seeder,
    clock,
  });
  const workerId = ids.next();
  const ownerId = ids.next();
  const projectionWorker = new OutgoingContentProjectionWorker({
    executor,
    projectKeys,
    ids,
    clock,
    workerId,
  });
  const orchestrators: CloudSyncRuntimeOrchestratorFactory = {
    create(binding: CloudSyncRuntimeAuthorityBinding) {
      return new CloudSyncOrchestrator<PreparedIncomingContentMutation>({
        enabled: true,
        api,
        session,
        store: syncStore,
        prepareIncoming: (work) => materializer.prepare(work),
        applyPreparedIncoming: async (transaction, exactWork, prepared, context) =>
          toIncomingApplyOutcome(
            await materializer.applyPrepared(transaction, exactWork, prepared, context.now),
          ),
        clock,
        ids,
        ownerId,
        activeDeviceId: binding.deviceId,
        projectionPushAuthority: materializationStore,
        incrementalSettlement,
        projectOutbox: syncStore,
      });
    },
  };

  return new CloudSyncRuntimeService({
    enabled: true,
    session,
    authority: materializationStore,
    projectKeys,
    bootstrap,
    snapshotLocator: syncStore,
    snapshotMaterializer,
    projectionWorker,
    orchestrators,
    clock,
  });
}

/**
 * Constructs the explicit per-project consent boundary separately from the
 * background runtime. Merely configuring cloud sync never enrolls a project.
 */
export function createCloudProjectSyncEnrollmentService(
  dependencies: CloudSyncEnrollmentWiringDependencies,
): CloudProjectSyncEnrollmentService | null {
  if (
    dependencies.mode !== "tauri" ||
    !dependencies.enabled ||
    dependencies.executor === null ||
    dependencies.syncStore === null ||
    dependencies.projectKeyStore === null ||
    dependencies.session === null ||
    dependencies.cloudProjectKeys === null ||
    dependencies.cloudSync === null
  ) {
    return null;
  }

  const authority = new SyncMaterializationSqliteStore(dependencies.executor);
  const keyPublication = new CheckpointAwareCloudProjectKeyPublisher(dependencies.cloudProjectKeys);
  return new CloudProjectSyncEnrollmentService({
    enabled: true,
    session: dependencies.session,
    authority,
    transportAudit: dependencies.syncStore,
    keyStore: dependencies.projectKeyStore,
    keyPublication,
    runtime: dependencies.cloudSync,
    clock: dependencies.clock,
  });
}

/**
 * Constructs the background loop only around an already-complete sync runtime.
 * Registration discovery is read-only, so this boundary cannot enroll a
 * project or manufacture consent.
 */
export function createCloudSyncSupervisor(
  dependencies: CloudSyncSupervisorWiringDependencies,
): CloudSyncSupervisor | null {
  if (
    dependencies.mode !== "tauri" ||
    !dependencies.enabled ||
    dependencies.executor === null ||
    dependencies.cloudSync === null
  ) {
    return null;
  }

  return new CloudSyncSupervisor({
    enabled: true,
    registrations: new SyncMaterializationSqliteStore(dependencies.executor),
    runtime: dependencies.cloudSync,
  });
}

/**
 * Creates explicit project controls only when both the durable runtime and
 * enrollment boundary are available. Browser development therefore cannot
 * accidentally simulate a successful cloud pause or resume.
 */
export function createCloudSyncControlService(
  dependencies: CloudSyncControlWiringDependencies,
): CloudSyncControlService | null {
  if (
    dependencies.mode !== "tauri" ||
    !dependencies.enabled ||
    dependencies.executor === null ||
    dependencies.cloudSync === null ||
    dependencies.enrollment === null
  ) {
    return null;
  }
  return new CloudSyncControlService({
    enabled: true,
    authority: new SyncMaterializationSqliteStore(dependencies.executor),
    runtime: dependencies.cloudSync,
    enrollment: dependencies.enrollment,
    clock: dependencies.clock,
  });
}

/**
 * Reuses the same session-bound project-key authority as the sync runtime.
 * The returned coordinator decrypts a remote branch only for an active local
 * review and persists only the resulting stable versions and encrypted
 * projection jobs.
 */
export function createSyncConflictResolutionCoordinator(
  dependencies: SyncConflictResolutionWiringDependencies,
): SyncConflictResolutionCoordinator | null {
  if (
    dependencies.mode !== "tauri" ||
    !dependencies.enabled ||
    dependencies.executor === null ||
    dependencies.syncStore === null ||
    dependencies.session === null ||
    dependencies.projectSecurity === null ||
    dependencies.cloudProjectKeys === null
  ) {
    return null;
  }

  const authority = new SyncMaterializationSqliteStore(dependencies.executor);
  const projectKeys = new AuthorityBoundProjectKeyOpener(
    dependencies.session,
    authority,
    dependencies.projectSecurity,
    dependencies.cloudProjectKeys,
  );
  const materializer = new ContentSyncMaterializer(
    new IncomingContentDecryptor((projectId, keyVersion) =>
      projectKeys.openHistoricalProjectKey(projectId, keyVersion),
    ),
  );
  const store = new SqliteSyncConflictResolutionStore({
    executor: dependencies.executor,
    syncStore: dependencies.syncStore,
    materializer,
  });
  return new SyncConflictResolutionCoordinator({
    source: store,
    committer: store,
    ids: dependencies.ids,
    clock: dependencies.clock,
  });
}

export class CheckpointAwareCloudProjectKeyPublisher implements CloudProjectSyncKeyPublicationPort {
  public constructor(
    private readonly coordinator: Pick<CloudProjectKeyCoordinator, "ensureProjectKeyPublished">,
  ) {}

  public async ensurePublished(
    requested: Readonly<{
      projectId: string;
      accountId: string;
      deviceId: string;
      devicePublicKeyFingerprint: string;
      keyVersion: number;
    }>,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<
    Readonly<{
      projectId: string;
      accountId: string;
      deviceId: string;
      devicePublicKeyFingerprint: string;
      keyVersion: number;
    }>
  > {
    const publication = await this.coordinator.ensureProjectKeyPublished(requested, options);
    if (
      publication.projectId !== requested.projectId ||
      publication.accountId !== requested.accountId ||
      publication.deviceId !== requested.deviceId ||
      publication.devicePublicKeyFingerprint !== requested.devicePublicKeyFingerprint ||
      publication.keyVersion !== requested.keyVersion
    ) {
      throw publicationAuthorityError(
        "SYNC_ENROLLMENT_KEY_PUBLICATION_RESULT_MISMATCH",
        "Cloud project-key publication did not preserve the requested project authority.",
      );
    }
    return exactPublicationEvidence(requested);
  }
}

interface FrozenKeyAuthority {
  readonly accountId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly consentRevision: number;
  readonly currentKeyVersion: number;
}

/**
 * Keeps both outgoing and historical-key opens bound to the current session
 * and durable registration. Recovery deliberately supplies no recovery code,
 * so the cloud coordinator can use only the current authorized device
 * envelope.
 */
class AuthorityBoundProjectKeyOpener implements ProjectionProjectKeyOpener {
  public constructor(
    private readonly session: Pick<CloudSessionCoordinator, "ensureReady">,
    private readonly authority: Pick<SyncMaterializationSqliteStore, "loadProjectSyncRegistration">,
    private readonly lifecycle: Pick<ProjectKeyLifecycleService, "openProjectDataKeyForDevice">,
    private readonly cloudProjectKeys: Pick<CloudProjectKeyCoordinator, "recoverProjectKeyVersion">,
  ) {}

  public async openProjectDataKeyForDevice(
    projectId: string,
    deviceId: string,
    keyVersion: number,
  ): Promise<OpenedProjectionProjectKey> {
    const frozen = await this.requireAuthority(projectId, deviceId, keyVersion);
    return this.openExactAuthorizedKey(projectId, keyVersion, frozen);
  }

  public async openHistoricalProjectKey(projectId: string, keyVersion: number): Promise<CryptoKey> {
    const session = await this.session.ensureReady();
    const deviceId = session.device.device.deviceId;
    const frozen = await this.requireAuthority(projectId, deviceId, keyVersion, session);
    return (await this.openExactAuthorizedKey(projectId, keyVersion, frozen)).key;
  }

  private async openExactAuthorizedKey(
    projectId: string,
    keyVersion: number,
    frozen: FrozenKeyAuthority,
  ): Promise<OpenedProjectionProjectKey> {
    try {
      const opened = await this.lifecycle.openProjectDataKeyForDevice(
        projectId,
        frozen.deviceId,
        keyVersion,
        {
          accountId: frozen.accountId,
          expectedSessionId: frozen.sessionId,
        },
      );
      return requireExactOpenedKey(opened, projectId, keyVersion);
    } catch {
      const recovered = await this.cloudProjectKeys.recoverProjectKeyVersion(
        projectId,
        keyVersion,
        undefined,
      );
      if (!recovered.cloudDeviceAuthorized) {
        throw keyAuthorityError(
          "SYNC_PROJECT_KEY_DEVICE_ENVELOPE_REQUIRED",
          "The current cloud device does not have an authorized project-key envelope.",
        );
      }
      const rebound = await this.requireAuthority(projectId, frozen.deviceId, keyVersion);
      requireSameKeyAuthority(rebound, frozen);
      return requireExactOpenedKey(recovered.openKey, projectId, keyVersion);
    }
  }

  private async requireAuthority(
    projectId: string,
    requestedDeviceId: string,
    requestedKeyVersion: number,
    readySession?: ConfiguredCloudSessionStatus,
  ): Promise<FrozenKeyAuthority> {
    if (!Number.isSafeInteger(requestedKeyVersion) || requestedKeyVersion < 1) {
      throw keyAuthorityError(
        "SYNC_PROJECT_KEY_VERSION_INVALID",
        "The requested project-key version is invalid.",
      );
    }
    const session = readySession ?? (await this.session.ensureReady());
    const activeDeviceId = session.device.device.deviceId;
    if (activeDeviceId !== requestedDeviceId) {
      throw keyAuthorityError(
        "SYNC_DEVICE_AUTHORITY_MISMATCH",
        "The requested project key is not bound to the active cloud device.",
      );
    }
    const registration = unwrap(await this.authority.loadProjectSyncRegistration(projectId));
    requireKeyRegistration(registration, projectId, session, requestedKeyVersion);
    return {
      accountId: registration.accountId,
      deviceId: registration.deviceId,
      sessionId: session.session.sessionId,
      consentRevision: registration.consentRevision,
      currentKeyVersion: registration.keyVersion,
    };
  }
}

function requireKeyRegistration(
  registration: ProjectSyncRegistration | null,
  projectId: string,
  session: ConfiguredCloudSessionStatus,
  requestedKeyVersion: number,
): asserts registration is ProjectSyncRegistration {
  if (
    registration?.projectId !== projectId ||
    registration.state === "disabled" ||
    registration.state === "paused" ||
    registration.state === "error"
  ) {
    throw keyAuthorityError(
      "SYNC_PROJECT_KEY_AUTHORITY_UNAVAILABLE",
      "The project sync registration does not authorize key access.",
    );
  }
  if (
    registration.accountId !== session.account.accountId ||
    registration.deviceId !== session.device.device.deviceId
  ) {
    throw keyAuthorityError(
      "SYNC_PROJECT_KEY_AUTHORITY_MISMATCH",
      "The project sync registration does not match the active cloud session.",
    );
  }
  if (requestedKeyVersion > registration.keyVersion) {
    throw keyAuthorityError(
      "SYNC_PROJECT_KEY_VERSION_UNAUTHORIZED",
      "The requested project-key version is newer than the authorized registration.",
    );
  }
}

function requireSameKeyAuthority(current: FrozenKeyAuthority, expected: FrozenKeyAuthority): void {
  if (
    current.accountId !== expected.accountId ||
    current.deviceId !== expected.deviceId ||
    current.sessionId !== expected.sessionId ||
    current.consentRevision !== expected.consentRevision ||
    current.currentKeyVersion !== expected.currentKeyVersion
  ) {
    throw keyAuthorityError(
      "SYNC_PROJECT_KEY_AUTHORITY_CHANGED",
      "The project-key authority changed during cloud recovery.",
    );
  }
}

function requireExactOpenedKey(
  opened: Readonly<{ projectId: string; keyVersion: number; key: CryptoKey }>,
  projectId: string,
  keyVersion: number,
): OpenedProjectionProjectKey {
  if (opened.projectId !== projectId || opened.keyVersion !== keyVersion) {
    throw keyAuthorityError(
      "SYNC_PROJECT_KEY_RESULT_MISMATCH",
      "The opened project key does not match the requested version.",
    );
  }
  return {
    projectId: opened.projectId,
    keyVersion: opened.keyVersion,
    key: opened.key,
  };
}

function toIncomingApplyOutcome(
  outcome: Awaited<ReturnType<ContentSyncMaterializer["applyPrepared"]>>,
): IncomingApplyOutcome {
  switch (outcome.status) {
    case "applied":
    case "skipped":
      return { status: outcome.status };
    case "conflict":
      return { status: "conflict", code: "SYNC_CONTENT_CONFLICT" };
    case "retry":
      return { status: "retry", code: outcome.code };
  }
}

function keyAuthorityError(code: string, message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS", "CONTACT_SUPPORT"],
    details: {
      operation: "CLOUD_SYNC_PROJECT_KEY_AUTHORITY",
      reasonCode: code,
    },
  });
}

function exactPublicationEvidence(
  requested: Readonly<{
    projectId: string;
    accountId: string;
    deviceId: string;
    devicePublicKeyFingerprint: string;
    keyVersion: number;
  }>,
): Readonly<{
  projectId: string;
  accountId: string;
  deviceId: string;
  devicePublicKeyFingerprint: string;
  keyVersion: number;
}> {
  return {
    projectId: requested.projectId,
    accountId: requested.accountId,
    deviceId: requested.deviceId,
    devicePublicKeyFingerprint: requested.devicePublicKeyFingerprint,
    keyVersion: requested.keyVersion,
  };
}

function publicationAuthorityError(code: string, message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS", "CONTACT_SUPPORT"],
    details: {
      operation: "CLOUD_SYNC_PROJECT_KEY_PUBLICATION_AUTHORITY",
      reasonCode: code,
    },
  });
}

function unwrap<T>(result: Result<T, AppError>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
