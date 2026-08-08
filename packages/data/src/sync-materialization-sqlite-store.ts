import { AppError, err, ok, type Result } from "@inkshadow/domain";
import {
  SYNC_OBJECT_TYPES,
  normalizeVersionVector,
  type SyncObjectType,
  type VersionVector,
} from "@inkshadow/sync-core";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export const PROJECT_SYNC_REGISTRATION_STATES = [
  "enabled",
  "enabling",
  "paused",
  "bootstrap_required",
  "error",
  "disabled",
] as const;

export type ProjectSyncRegistrationState = (typeof PROJECT_SYNC_REGISTRATION_STATES)[number];

export interface ProjectSyncRegistration {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly state: ProjectSyncRegistrationState;
  readonly consentRevision: number;
  readonly keyVersion: number;
  readonly revision: number;
  readonly plaintextBootstrapCompleted: boolean;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly enabledAt: string | null;
  readonly pausedAt: string | null;
}

export interface BeginProjectSyncEnableInput {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly consentRevision: number;
  readonly keyVersion: number;
  readonly expectedRevision: number | null;
  readonly begunAt: string;
}

export type ProjectSyncRegistrationTarget =
  | Readonly<{ state: "bootstrap_required" }>
  | Readonly<{ state: "enabled" }>
  | Readonly<{ state: "paused" }>
  | Readonly<{ state: "error"; errorCode: string }>;

export interface TransitionProjectSyncRegistrationInput {
  readonly projectId: string;
  readonly expectedAccountId: string;
  readonly expectedDeviceId: string;
  readonly expectedConsentRevision: number;
  readonly expectedKeyVersion: number;
  readonly expectedRevision: number;
  readonly target: ProjectSyncRegistrationTarget;
  readonly transitionedAt: string;
}

export interface DisableProjectSyncInput {
  readonly projectId: string;
  /**
   * Null is valid only when the caller observed that no durable registration
   * exists. This lets a local disable still revoke orphaned transport without
   * inventing cloud identity.
   */
  readonly expectedAccountId: string | null;
  readonly expectedDeviceId: string | null;
  readonly expectedRevision: number | null;
  readonly disabledAt: string;
}

export type SyncPushGateReason =
  | "allowed"
  | "disabled"
  | "not_enabled"
  | "bootstrap_required"
  | "account_mismatch"
  | "device_mismatch"
  | "consent_revision_mismatch"
  | "key_version_mismatch";

export interface SyncPushGate {
  readonly allowed: boolean;
  readonly reason: SyncPushGateReason;
  readonly registrationRevision: number | null;
}

export interface SyncPushGateInput {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly consentRevision: number;
  readonly keyVersion: number;
}

export type ProjectionOperationPushGateReason =
  | "allowed"
  | "registration_missing"
  | "not_enabled"
  | "account_mismatch"
  | "device_mismatch"
  | "operation_unbound"
  | "authority_mismatch"
  | "chapter_local_only";

export interface ProjectionOperationPushGateInput {
  readonly projectId: string;
  readonly operationId: string;
  readonly activeAccountId: string;
  readonly activeDeviceId: string;
}

export interface ProjectionOperationPushGate {
  readonly allowed: boolean;
  readonly reason: ProjectionOperationPushGateReason;
  readonly registrationRevision: number | null;
}

export type ProjectionOperationPushFenceReason =
  | Exclude<ProjectionOperationPushGateReason, "allowed">
  | "base_cursor_mismatch"
  | "incremental_work_pending"
  | "materialized_checkpoint_mismatch"
  | "outbox_lease_mismatch"
  | "remote_checkpoint_mismatch";

export interface ProjectionOperationPushFenceInput extends ProjectionOperationPushGateInput {
  readonly settledSignedRemoteCursor: string;
  readonly settledDownloadedCheckpointRevision: number;
  readonly settledMaterializedCheckpointRevision: number;
  readonly requestBaseCursor: string | null;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly authorizedAt: string;
  readonly readAcknowledgedAt: () => string;
}

export interface ProjectionOperationPushNetworkResponse {
  readonly acceptedOperations: readonly Readonly<{ readonly operationId: string }>[];
  readonly remoteCursor: string;
}

export type ProjectionOperationPushFenceResult =
  | Readonly<{
      status: "blocked";
      reason: ProjectionOperationPushFenceReason;
      registrationRevision: number | null;
    }>
  | Readonly<{
      status: "pushed";
      response: ProjectionOperationPushNetworkResponse;
      registrationRevision: number;
    }>;

export class ProjectionOperationPushResponseMismatchError extends Error {
  public override readonly name = "ProjectionOperationPushResponseMismatchError";

  public constructor() {
    super("Cloud sync did not acknowledge the exact fenced operation.");
  }
}

export type MaterializedSyncObject =
  | Readonly<{
      projectId: string;
      objectType: SyncObjectType;
      objectId: string;
      objectGeneration: number;
      versionId: string;
      vector: VersionVector;
      payloadSha256: string;
      sourceOperationId: string;
      sourceDeviceId: string;
      sourceDeviceSequence: number;
      state: "present";
      materializedAt: string;
    }>
  | Readonly<{
      projectId: string;
      objectType: SyncObjectType;
      objectId: string;
      objectGeneration: number;
      versionId: null;
      vector: VersionVector;
      payloadSha256: null;
      sourceOperationId: string;
      sourceDeviceId: string;
      sourceDeviceSequence: number;
      state: "deleted";
      materializedAt: string;
    }>;

export interface WriteMaterializedSyncObjectInput {
  readonly object: MaterializedSyncObject;
  readonly expectedSourceOperationId: string | null;
}

export interface SyncMaterializedCheckpoint {
  readonly projectId: string;
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AdvanceSyncMaterializedCheckpointInput {
  readonly projectId: string;
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly expectedRevision: number | null;
  readonly updatedAt: string;
}

export type SyncConflictResolution = "accept_local" | "accept_remote" | "merged" | "dismissed";

export type SyncContentConflict =
  | Readonly<{
      conflictId: string;
      projectId: string;
      objectType: SyncObjectType;
      objectId: string;
      objectGeneration: number;
      localVector: VersionVector;
      remoteVector: VersionVector;
      remoteOperationId: string;
      remoteKind: "upsert";
      remotePayloadSha256: string;
      status: "unresolved";
      resolution: null;
      resolutionOperationId: null;
      revision: number;
      createdAt: string;
      updatedAt: string;
      resolvedAt: null;
    }>
  | Readonly<{
      conflictId: string;
      projectId: string;
      objectType: SyncObjectType;
      objectId: string;
      objectGeneration: number;
      localVector: VersionVector;
      remoteVector: VersionVector;
      remoteOperationId: string;
      remoteKind: "delete";
      remotePayloadSha256: null;
      status: "unresolved";
      resolution: null;
      resolutionOperationId: null;
      revision: number;
      createdAt: string;
      updatedAt: string;
      resolvedAt: null;
    }>
  | Readonly<{
      conflictId: string;
      projectId: string;
      objectType: SyncObjectType;
      objectId: string;
      objectGeneration: number;
      localVector: VersionVector;
      remoteVector: VersionVector;
      remoteOperationId: string;
      remoteKind: "upsert" | "delete";
      remotePayloadSha256: string | null;
      status: "resolved";
      resolution: SyncConflictResolution;
      resolutionOperationId: string | null;
      revision: number;
      createdAt: string;
      updatedAt: string;
      resolvedAt: string;
    }>;

export interface RegisterSyncContentConflictInput {
  readonly conflictId: string;
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly localVector: VersionVector;
  readonly remoteVector: VersionVector;
  readonly remoteOperationId: string;
  readonly remoteKind: "upsert" | "delete";
  readonly remotePayloadSha256: string | null;
  readonly createdAt: string;
}

export interface ResolveSyncContentConflictInput {
  readonly conflictId: string;
  readonly expectedRevision: number;
  readonly resolution: SyncConflictResolution;
  readonly resolutionOperationId: string | null;
  readonly resolvedAt: string;
}

export type SyncProjectionJobStatus =
  "queued" | "leased" | "retry_wait" | "completed" | "failed" | "superseded";

export interface SyncProjectionJob {
  readonly jobId: string;
  readonly projectId: string;
  readonly accountId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly projectionKind: "upsert" | "delete";
  readonly versionId: string | null;
  readonly sourceRevision: number;
  readonly keyVersion: number;
  readonly consentRevision: number;
  readonly deviceId: string;
  readonly status: SyncProjectionJobStatus;
  readonly attempt: number;
  readonly revision: number;
  readonly nextAttemptAt: string | null;
  readonly leaseOwnerId: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly operationId: string | null;
  readonly failureCode: string | null;
  readonly supersededByJobId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
}

export interface EnqueueSyncProjectionJobInput {
  readonly jobId: string;
  readonly projectId: string;
  readonly accountId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly projectionKind: "upsert" | "delete";
  readonly versionId: string | null;
  readonly sourceRevision: number;
  readonly keyVersion: number;
  readonly consentRevision: number;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly nextAttemptAt: string;
}

export interface ClaimSyncProjectionJobInput {
  readonly projectId: string;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly leasedAt: string;
  readonly leaseExpiresAt: string;
}

export interface ReadSyncProjectionBlockingStateInput {
  readonly projectId: string;
  readonly observedAt: string;
}

export interface SyncProjectionAuthority {
  readonly accountId: string;
  readonly deviceId: string;
  readonly keyVersion: number;
  readonly consentRevision: number;
  readonly registrationRevision: number;
}

export type SyncProjectionBlockedReason =
  | "registration_not_enabled"
  | "active_lease"
  | "project_manifest_missing"
  | "predecessor_pending"
  | "claim_raced";

type SyncProjectionBlockingStateBase = Readonly<{
  projectId: string;
  authority: SyncProjectionAuthority | null;
}>;

export type SyncProjectionBlockingState = SyncProjectionBlockingStateBase &
  (
    | Readonly<{ state: "idle" }>
    | Readonly<{
        state: "backoff";
        jobId: string;
        attempt: number;
        nextAttemptAt: string;
        failureCode: string | null;
      }>
    | Readonly<{
        state: "permanent_failure";
        jobId: string;
        attempt: number;
        failureCode: string;
      }>
    | Readonly<{
        state: "attempt_exhausted";
        jobId: string;
        attempt: number;
        failureCode: string;
      }>
    | Readonly<{
        state: "blocked";
        jobId: string;
        reason: SyncProjectionBlockedReason;
        blockerJobId: string | null;
        resumeAt: string | null;
      }>
  );

export interface CompleteSyncProjectionJobInput {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly operationId: string;
  readonly completedAt: string;
}

export interface RetrySyncProjectionJobInput {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly failedAt: string;
  readonly nextAttemptAt: string;
}

export interface FailSyncProjectionJobInput {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly failedAt: string;
}

export interface SupersedeSyncProjectionJobInput {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly supersededByJobId: string;
  readonly supersededAt: string;
}

interface RegistrationDbRow {
  readonly project_id: string;
  readonly account_id: string;
  readonly device_id: string;
  readonly state: string;
  readonly consent_revision: number;
  readonly key_version: number;
  readonly revision: number;
  readonly plaintext_bootstrap_completed: number;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly enabled_at: string | null;
  readonly paused_at: string | null;
}

interface MaterializedObjectDbRow {
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly version_id: string | null;
  readonly vector_json: string;
  readonly payload_sha256: string | null;
  readonly source_operation_id: string;
  readonly source_device_id: string;
  readonly source_device_sequence: number;
  readonly state: string;
  readonly materialized_at: string;
}

interface RemoteCheckpointDbRow {
  readonly signed_remote_cursor: string;
  readonly revision: number;
}

interface MaterializedCheckpointDbRow {
  readonly project_id: string;
  readonly signed_remote_cursor: string;
  readonly downloaded_checkpoint_revision: number;
  readonly revision: number;
  readonly updated_at: string;
}

interface ConflictDbRow {
  readonly conflict_id: string;
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly local_vector_json: string;
  readonly remote_vector_json: string;
  readonly remote_operation_id: string;
  readonly remote_kind: string;
  readonly remote_payload_sha256: string | null;
  readonly status: string;
  readonly resolution: string | null;
  readonly resolution_operation_id: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
}

interface ProjectionJobDbRow {
  readonly job_id: string;
  readonly project_id: string;
  readonly account_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly projection_kind: string;
  readonly version_id: string | null;
  readonly source_revision: number;
  readonly key_version: number;
  readonly consent_revision: number;
  readonly device_id: string;
  readonly status: string;
  readonly attempt: number;
  readonly revision: number;
  readonly next_attempt_at: string | null;
  readonly lease_owner_id: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
  readonly operation_id: string | null;
  readonly failure_code: string | null;
  readonly superseded_by_job_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
}

interface FencedOutboxLeaseDbRow {
  readonly operation_id: string;
}

interface PushFencePendingCountsDbRow {
  readonly snapshot_pending_count: number;
  readonly inbox_pending_count: number;
  readonly content_conflict_count: number;
}

interface UnacknowledgedOutboxCountDbRow {
  readonly count: number;
}

interface ChapterPrivacyDbRow {
  readonly privacy_mode: string;
}

export class SyncMaterializationSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadProjectSyncRegistration(
    projectIdValue: string,
  ): Promise<Result<ProjectSyncRegistration | null, AppError>> {
    return attempt("SYNC_REGISTRATION_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const row = await findRegistration(this.executor, projectId);
      return row === null ? null : rehydrateRegistration(row);
    });
  }

  public async listRunnableProjectSyncRegistrations(): Promise<
    Result<readonly ProjectSyncRegistration[], AppError>
  > {
    return attempt("SYNC_RUNNABLE_REGISTRATIONS_READ_FAILED", async () => {
      const rows = await this.executor.select<RegistrationDbRow>(
        `SELECT *
         FROM project_sync_registrations
         WHERE state IN ('enabled', 'enabling', 'bootstrap_required')
         ORDER BY project_id ASC`,
      );
      return rows.map((row) => rehydrateRegistration(row));
    });
  }

  public async beginProjectSyncEnable(
    inputValue: BeginProjectSyncEnableInput,
  ): Promise<Result<ProjectSyncRegistration, AppError>> {
    return attempt("SYNC_REGISTRATION_BEGIN_ENABLE_FAILED", async () => {
      const input = normalizeBeginEnable(inputValue);
      return this.executor.transaction((transaction) => beginEnable(transaction, input));
    });
  }

  /**
   * Final enrollment commit. The BEGIN IMMEDIATE transaction prevents a local
   * writer from inserting an old-consent outbox operation between the clean
   * transport check and the registration CAS.
   */
  public async beginProjectSyncEnableIfTransportClean(
    inputValue: BeginProjectSyncEnableInput,
  ): Promise<Result<ProjectSyncRegistration, AppError>> {
    return attempt("SYNC_REGISTRATION_BEGIN_ENABLE_IF_TRANSPORT_CLEAN_FAILED", async () => {
      const input = normalizeBeginEnable(inputValue);
      return this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<UnacknowledgedOutboxCountDbRow>(
          `SELECT count(*) AS count
           FROM sync_outbox_operations
           WHERE project_id = ?
             AND status IN ('queued', 'in_flight', 'failed', 'paused')`,
          [input.projectId],
        );
        const count = rows[0]?.count;
        if (!Number.isSafeInteger(count) || count === undefined || count < 0) {
          throw corruptionError("The project outbox enrollment boundary is invalid.");
        }
        if (count > 0) {
          throw new AppError({
            code: "INVALID_STATE_TRANSITION",
            message:
              "Project sync cannot be enabled while an earlier consent epoch has unacknowledged outgoing ciphertext.",
            actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
            details: {
              operation: "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX",
              projectId: input.projectId,
              unacknowledgedOutboxCount: count,
            },
          });
        }
        return beginEnable(transaction, input);
      });
    });
  }

  public async transitionProjectSyncRegistration(
    inputValue: TransitionProjectSyncRegistrationInput,
  ): Promise<Result<ProjectSyncRegistration, AppError>> {
    return attempt("SYNC_REGISTRATION_TRANSITION_FAILED", async () => {
      const input = normalizeRegistrationTransition(inputValue);
      return this.executor.transaction((transaction) => transitionRegistration(transaction, input));
    });
  }

  public async disableProjectSync(
    inputValue: DisableProjectSyncInput,
  ): Promise<Result<ProjectSyncRegistration | null, AppError>> {
    return attempt("SYNC_REGISTRATION_DISABLE_FAILED", async () => {
      const input = normalizeDisable(inputValue);
      return this.executor.transaction((transaction) => disableRegistration(transaction, input));
    });
  }

  public async evaluatePushGate(
    inputValue: SyncPushGateInput,
  ): Promise<Result<SyncPushGate, AppError>> {
    return attempt("SYNC_PUSH_GATE_READ_FAILED", async () => {
      const input = normalizePushGate(inputValue);
      return evaluatePushGate(this.executor, input);
    });
  }

  public async evaluateProjectionOperationPushGate(
    inputValue: ProjectionOperationPushGateInput,
  ): Promise<Result<ProjectionOperationPushGate, AppError>> {
    return attempt("SYNC_PROJECTION_PUSH_GATE_READ_FAILED", async () => {
      const input = {
        projectId: parseUuid(inputValue.projectId, "projectId"),
        operationId: parseUuid(inputValue.operationId, "operationId"),
        activeAccountId: parseUuid(inputValue.activeAccountId, "activeAccountId"),
        activeDeviceId: parseUuid(inputValue.activeDeviceId, "activeDeviceId"),
      };
      return evaluateProjectionOperationPushGate(this.executor, input);
    });
  }

  /**
   * Holds one BEGIN IMMEDIATE transaction from the final plaintext boundary
   * check through the network request and exact outbox acknowledgement.
   *
   * The push callback must perform network I/O only. In particular, it must
   * not call this store or the owning SqlExecutor because that would re-enter
   * the executor while its transaction is locked. Callback failures are
   * deliberately rethrown unchanged so CloudClientError classification and
   * idempotent retries remain owned by the caller.
   */
  public async pushProjectionOperationFenced(
    inputValue: ProjectionOperationPushFenceInput,
    push: () => Promise<ProjectionOperationPushNetworkResponse>,
  ): Promise<ProjectionOperationPushFenceResult> {
    const input = normalizeProjectionOperationPushFence(inputValue);
    if (typeof push !== "function") {
      throw validationError("A fenced projection push callback is required.");
    }
    if (typeof inputValue.readAcknowledgedAt !== "function") {
      throw validationError("A fenced acknowledgement clock is required.");
    }
    const callbackFailure: { caught: boolean; cause: unknown } = {
      caught: false,
      cause: undefined,
    };
    const pushState = { networkAccepted: false };
    try {
      return await this.executor.transaction(async (transaction) => {
        const leaseRows = await transaction.select<FencedOutboxLeaseDbRow>(
          `SELECT operation_id
         FROM sync_outbox_operations
         WHERE operation_id = ?
           AND project_id = ?
           AND device_id = ?
           AND status = 'in_flight'
           AND lease_owner_id = ?
           AND lease_token = ?
           AND lease_expires_at > ?`,
          [
            input.operationId,
            input.projectId,
            input.activeDeviceId,
            input.leaseOwnerId,
            input.leaseToken,
            input.authorizedAt,
          ],
        );
        if (leaseRows.length !== 1) {
          return {
            status: "blocked",
            reason: "outbox_lease_mismatch",
            registrationRevision: null,
          };
        }
        const gate = await evaluateProjectionOperationPushGate(transaction, input);
        if (!gate.allowed) {
          return {
            status: "blocked",
            reason: gate.reason === "allowed" ? "authority_mismatch" : gate.reason,
            registrationRevision: gate.registrationRevision,
          };
        }
        if (gate.registrationRevision === null) {
          throw corruptionError("An allowed projection push gate has no registration revision.");
        }
        const registrationRevision = gate.registrationRevision;
        const boundaryReason = await findProjectionPushBoundaryBlockReason(transaction, input);
        if (boundaryReason !== null) {
          return {
            status: "blocked",
            reason: boundaryReason,
            registrationRevision,
          };
        }
        let response: ProjectionOperationPushNetworkResponse;
        try {
          response = await push();
        } catch (cause: unknown) {
          callbackFailure.caught = true;
          callbackFailure.cause = cause;
          throw cause;
        }
        if (
          response.acceptedOperations.length !== 1 ||
          response.acceptedOperations[0]?.operationId !== input.operationId
        ) {
          throw new ProjectionOperationPushResponseMismatchError();
        }
        parseCursor(response.remoteCursor, "response remoteCursor");
        pushState.networkAccepted = true;
        const acknowledgedAt = parseTimestamp(inputValue.readAcknowledgedAt(), "acknowledgedAt");
        if (Date.parse(acknowledgedAt) < Date.parse(input.authorizedAt)) {
          throw validationError("The fenced acknowledgement predates its authorization.");
        }
        const acknowledged = await transaction.execute(
          `UPDATE sync_outbox_operations
         SET status = 'acknowledged',
             next_attempt_at = NULL,
             lease_owner_id = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             failure_code = NULL,
             acknowledged_at = ?,
             updated_at = ?
         WHERE operation_id = ?
           AND project_id = ?
           AND device_id = ?
           AND status = 'in_flight'
           AND lease_owner_id = ?
           AND lease_token = ?`,
          [
            acknowledgedAt,
            acknowledgedAt,
            input.operationId,
            input.projectId,
            input.activeDeviceId,
            input.leaseOwnerId,
            input.leaseToken,
          ],
        );
        if (acknowledged.rowsAffected !== 1) {
          throw concurrencyError("The fenced sync operation lease changed before acknowledgement.");
        }
        return {
          status: "pushed",
          response,
          registrationRevision,
        };
      });
    } catch (cause: unknown) {
      if (callbackFailure.caught && cause === callbackFailure.cause) {
        throw cause;
      }
      if (cause instanceof ProjectionOperationPushResponseMismatchError) {
        throw cause;
      }
      if (pushState.networkAccepted) {
        throw new AppError({
          code: "REPOSITORY_ERROR",
          message:
            "Cloud accepted the fenced sync operation, but its local acknowledgement did not commit.",
          retryable: true,
          actions: ["RETRY", "CONTACT_SUPPORT"],
          details: {
            operation: "SYNC_FENCED_PUSH_ACKNOWLEDGE_FAILED",
            causeType: cause instanceof Error ? cause.name : "UnknownError",
          },
        });
      }
      throw cause;
    }
  }

  public async findMaterializedObject(
    projectIdValue: string,
    objectTypeValue: SyncObjectType,
    objectIdValue: string,
    objectGenerationValue: number,
  ): Promise<Result<MaterializedSyncObject | null, AppError>> {
    return attempt("SYNC_MATERIALIZED_OBJECT_READ_FAILED", async () => {
      const identity = normalizeObjectIdentity({
        projectId: projectIdValue,
        objectType: objectTypeValue,
        objectId: objectIdValue,
        objectGeneration: objectGenerationValue,
      });
      const row = await findMaterializedObject(this.executor, identity);
      return row === null ? null : rehydrateMaterializedObject(row);
    });
  }

  public async findCurrentMaterializedObject(
    projectIdValue: string,
    objectTypeValue: SyncObjectType,
    objectIdValue: string,
  ): Promise<Result<MaterializedSyncObject | null, AppError>> {
    return attempt("SYNC_CURRENT_MATERIALIZED_OBJECT_READ_FAILED", async () => {
      const identity = normalizeObjectReference({
        projectId: projectIdValue,
        objectType: objectTypeValue,
        objectId: objectIdValue,
      });
      const row = await findCurrentMaterializedObject(this.executor, identity);
      return row === null ? null : rehydrateMaterializedObject(row);
    });
  }

  public async writeMaterializedObject(
    inputValue: WriteMaterializedSyncObjectInput,
  ): Promise<Result<MaterializedSyncObject, AppError>> {
    return attempt("SYNC_MATERIALIZED_OBJECT_WRITE_FAILED", async () => {
      const input = normalizeMaterializedWrite(inputValue);
      return this.executor.transaction((transaction) =>
        writeMaterializedObject(transaction, input),
      );
    });
  }

  public async loadMaterializedCheckpoint(
    projectIdValue: string,
  ): Promise<Result<SyncMaterializedCheckpoint | null, AppError>> {
    return attempt("SYNC_MATERIALIZED_CHECKPOINT_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const row = await findMaterializedCheckpoint(this.executor, projectId);
      return row === null ? null : rehydrateMaterializedCheckpoint(row);
    });
  }

  public async advanceMaterializedCheckpoint(
    inputValue: AdvanceSyncMaterializedCheckpointInput,
  ): Promise<Result<SyncMaterializedCheckpoint, AppError>> {
    return attempt("SYNC_MATERIALIZED_CHECKPOINT_WRITE_FAILED", async () => {
      const input = normalizeCheckpointAdvance(inputValue);
      return this.executor.transaction((transaction) =>
        advanceMaterializedCheckpoint(transaction, input),
      );
    });
  }

  public async loadContentConflict(
    conflictIdValue: string,
  ): Promise<Result<SyncContentConflict | null, AppError>> {
    return attempt("SYNC_CONTENT_CONFLICT_READ_FAILED", async () => {
      const conflictId = parseUuid(conflictIdValue, "conflictId");
      const row = await findConflictById(this.executor, conflictId);
      return row === null ? null : rehydrateConflict(row);
    });
  }

  public async listUnresolvedContentConflicts(
    projectIdValue: string,
    limitValue = 100,
  ): Promise<Result<readonly SyncContentConflict[], AppError>> {
    return attempt("SYNC_CONTENT_CONFLICT_LIST_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const limit = parseBoundedLimit(limitValue, "limit", 1, 500);
      const rows = await this.executor.select<ConflictDbRow>(
        `SELECT *
         FROM sync_content_conflicts
         WHERE project_id = ? AND status = 'unresolved'
         ORDER BY created_at ASC, conflict_id ASC
         LIMIT ?`,
        [projectId, limit],
      );
      return rows.map((row) => rehydrateConflict(row));
    });
  }

  public async registerContentConflict(
    inputValue: RegisterSyncContentConflictInput,
  ): Promise<Result<SyncContentConflict, AppError>> {
    return attempt("SYNC_CONTENT_CONFLICT_REGISTER_FAILED", async () => {
      const input = normalizeConflictRegistration(inputValue);
      return this.executor.transaction((transaction) => registerConflict(transaction, input));
    });
  }

  public async resolveContentConflict(
    inputValue: ResolveSyncContentConflictInput,
  ): Promise<Result<SyncContentConflict, AppError>> {
    return attempt("SYNC_CONTENT_CONFLICT_RESOLVE_FAILED", async () => {
      const input = normalizeConflictResolution(inputValue);
      return this.executor.transaction((transaction) => resolveConflict(transaction, input));
    });
  }

  public async enqueueProjectionJob(
    inputValue: EnqueueSyncProjectionJobInput,
  ): Promise<Result<SyncProjectionJob, AppError>> {
    return attempt("SYNC_PROJECTION_JOB_ENQUEUE_FAILED", async () => {
      const input = normalizeProjectionEnqueue(inputValue);
      return this.executor.transaction((transaction) => enqueueProjectionJob(transaction, input));
    });
  }

  public async claimProjectionJob(
    inputValue: ClaimSyncProjectionJobInput,
  ): Promise<Result<SyncProjectionJob | null, AppError>> {
    return attempt("SYNC_PROJECTION_JOB_CLAIM_FAILED", async () => {
      const input = normalizeProjectionClaim(inputValue);
      return this.executor.transaction((transaction) => claimProjectionJob(transaction, input));
    });
  }

  public async readProjectionBlockingState(
    inputValue: ReadSyncProjectionBlockingStateInput,
  ): Promise<Result<SyncProjectionBlockingState, AppError>> {
    return attempt("SYNC_PROJECTION_BLOCKING_STATE_READ_FAILED", async () => {
      const input = normalizeProjectionBlockingStateRead(inputValue);
      return this.executor.transaction((transaction) =>
        readProjectionBlockingState(transaction, input),
      );
    });
  }

  public async completeProjectionJob(
    inputValue: CompleteSyncProjectionJobInput,
  ): Promise<Result<SyncProjectionJob, AppError>> {
    return attempt("SYNC_PROJECTION_JOB_COMPLETE_FAILED", async () => {
      const input = normalizeProjectionComplete(inputValue);
      return this.executor.transaction((transaction) => completeProjectionJob(transaction, input));
    });
  }

  public async retryProjectionJob(
    inputValue: RetrySyncProjectionJobInput,
  ): Promise<Result<SyncProjectionJob, AppError>> {
    return attempt("SYNC_PROJECTION_JOB_RETRY_FAILED", async () => {
      const input = normalizeProjectionRetry(inputValue);
      return this.executor.transaction((transaction) => retryProjectionJob(transaction, input));
    });
  }

  public async failProjectionJob(
    inputValue: FailSyncProjectionJobInput,
  ): Promise<Result<SyncProjectionJob, AppError>> {
    return attempt("SYNC_PROJECTION_JOB_FAIL_FAILED", async () => {
      const input = normalizeProjectionFail(inputValue);
      return this.executor.transaction((transaction) => failProjectionJob(transaction, input));
    });
  }

  public async supersedeProjectionJob(
    inputValue: SupersedeSyncProjectionJobInput,
  ): Promise<Result<SyncProjectionJob, AppError>> {
    return attempt("SYNC_PROJECTION_JOB_SUPERSEDE_FAILED", async () => {
      const input = normalizeProjectionSupersede(inputValue);
      return this.executor.transaction((transaction) => supersedeProjectionJob(transaction, input));
    });
  }
}

/**
 * Writes only the durable materialization marker on a caller-owned transaction.
 * The caller must treat an error Result as a transaction failure. This helper
 * never starts a nested transaction, so a business mutation and this marker can
 * share one SQLite commit.
 */
export async function writeSyncMaterializedObjectInTransaction(
  transaction: TransactionExecutor,
  inputValue: WriteMaterializedSyncObjectInput,
): Promise<Result<MaterializedSyncObject, AppError>> {
  return attempt("SYNC_MATERIALIZED_OBJECT_ATOMIC_WRITE_FAILED", async () =>
    writeMaterializedObject(transaction, normalizeMaterializedWrite(inputValue)),
  );
}

export async function findSyncMaterializedObjectInTransaction(
  transaction: TransactionExecutor,
  projectIdValue: string,
  objectTypeValue: SyncObjectType,
  objectIdValue: string,
  objectGenerationValue: number,
): Promise<Result<MaterializedSyncObject | null, AppError>> {
  return attempt("SYNC_MATERIALIZED_OBJECT_ATOMIC_READ_FAILED", async () => {
    const identity = normalizeObjectIdentity({
      projectId: projectIdValue,
      objectType: objectTypeValue,
      objectId: objectIdValue,
      objectGeneration: objectGenerationValue,
    });
    const row = await findMaterializedObject(transaction, identity);
    return row === null ? null : rehydrateMaterializedObject(row);
  });
}

export async function loadProjectSyncRegistrationInTransaction(
  transaction: TransactionExecutor,
  projectIdValue: string,
): Promise<Result<ProjectSyncRegistration | null, AppError>> {
  return attempt("SYNC_REGISTRATION_ATOMIC_READ_FAILED", async () => {
    const projectId = parseUuid(projectIdValue, "projectId");
    const row = await findRegistration(transaction, projectId);
    return row === null ? null : rehydrateRegistration(row);
  });
}

export async function transitionProjectSyncRegistrationInTransaction(
  transaction: TransactionExecutor,
  inputValue: TransitionProjectSyncRegistrationInput,
): Promise<Result<ProjectSyncRegistration, AppError>> {
  return attempt("SYNC_REGISTRATION_ATOMIC_TRANSITION_FAILED", async () => {
    const input = normalizeRegistrationTransition(inputValue);
    return transitionRegistration(transaction, input);
  });
}

export async function findCurrentSyncMaterializedObjectInTransaction(
  transaction: TransactionExecutor,
  projectIdValue: string,
  objectTypeValue: SyncObjectType,
  objectIdValue: string,
): Promise<Result<MaterializedSyncObject | null, AppError>> {
  return attempt("SYNC_CURRENT_MATERIALIZED_OBJECT_ATOMIC_READ_FAILED", async () => {
    const identity = normalizeObjectReference({
      projectId: projectIdValue,
      objectType: objectTypeValue,
      objectId: objectIdValue,
    });
    const row = await findCurrentMaterializedObject(transaction, identity);
    return row === null ? null : rehydrateMaterializedObject(row);
  });
}

/**
 * Advances the plaintext-materialized cursor on a caller-owned transaction.
 * It verifies the exact downloaded cursor/revision and never opens a nested
 * transaction.
 */
export async function advanceSyncMaterializedCheckpointInTransaction(
  transaction: TransactionExecutor,
  inputValue: AdvanceSyncMaterializedCheckpointInput,
): Promise<Result<SyncMaterializedCheckpoint, AppError>> {
  return attempt("SYNC_MATERIALIZED_CHECKPOINT_ATOMIC_WRITE_FAILED", async () =>
    advanceMaterializedCheckpoint(transaction, normalizeCheckpointAdvance(inputValue)),
  );
}

/**
 * Enqueues only opaque business-object/version references on a caller-owned
 * transaction. No plaintext projection payload is accepted by this API.
 */
export async function enqueueSyncProjectionJobInTransaction(
  transaction: TransactionExecutor,
  inputValue: EnqueueSyncProjectionJobInput,
): Promise<Result<SyncProjectionJob, AppError>> {
  return attempt("SYNC_PROJECTION_JOB_ATOMIC_ENQUEUE_FAILED", async () =>
    enqueueProjectionJob(transaction, normalizeProjectionEnqueue(inputValue)),
  );
}

export async function registerSyncContentConflictInTransaction(
  transaction: TransactionExecutor,
  inputValue: RegisterSyncContentConflictInput,
): Promise<Result<SyncContentConflict, AppError>> {
  return attempt("SYNC_CONTENT_CONFLICT_ATOMIC_REGISTER_FAILED", async () =>
    registerConflict(transaction, normalizeConflictRegistration(inputValue)),
  );
}

export async function loadSyncContentConflictInTransaction(
  transaction: TransactionExecutor,
  conflictIdValue: string,
): Promise<Result<SyncContentConflict | null, AppError>> {
  return attempt("SYNC_CONTENT_CONFLICT_ATOMIC_READ_FAILED", async () => {
    const conflictId = parseUuid(conflictIdValue, "conflictId");
    const row = await findConflictById(transaction, conflictId);
    return row === null ? null : rehydrateConflict(row);
  });
}

export async function resolveSyncContentConflictInTransaction(
  transaction: TransactionExecutor,
  inputValue: ResolveSyncContentConflictInput,
): Promise<Result<SyncContentConflict, AppError>> {
  return attempt("SYNC_CONTENT_CONFLICT_ATOMIC_RESOLVE_FAILED", async () =>
    resolveConflict(transaction, normalizeConflictResolution(inputValue)),
  );
}

export async function completeSyncProjectionJobInTransaction(
  transaction: TransactionExecutor,
  inputValue: CompleteSyncProjectionJobInput,
): Promise<Result<SyncProjectionJob, AppError>> {
  return attempt("SYNC_PROJECTION_JOB_ATOMIC_COMPLETE_FAILED", async () =>
    completeProjectionJob(transaction, normalizeProjectionComplete(inputValue)),
  );
}

async function beginEnable(
  transaction: TransactionExecutor,
  input: BeginProjectSyncEnableInput,
): Promise<ProjectSyncRegistration> {
  const existingRow = await findRegistration(transaction, input.projectId);
  if (existingRow === null) {
    if (input.expectedRevision !== null) {
      throw concurrencyError("The project sync registration no longer exists.");
    }
    const inserted = await transaction.execute(
      `INSERT INTO project_sync_registrations (
         project_id, account_id, device_id, state, consent_revision,
         key_version, revision, plaintext_bootstrap_completed,
         last_error_code, created_at, updated_at, enabled_at, paused_at
       ) VALUES (?, ?, ?, 'enabling', ?, ?, 1, 0, NULL, ?, ?, NULL, NULL)`,
      [
        input.projectId,
        input.accountId,
        input.deviceId,
        input.consentRevision,
        input.keyVersion,
        input.begunAt,
        input.begunAt,
      ],
    );
    requireSingleMutation(inserted.rowsAffected, "The project sync registration was not created.");
    return {
      projectId: input.projectId,
      accountId: input.accountId,
      deviceId: input.deviceId,
      state: "enabling",
      consentRevision: input.consentRevision,
      keyVersion: input.keyVersion,
      revision: 1,
      plaintextBootstrapCompleted: false,
      lastErrorCode: null,
      createdAt: input.begunAt,
      updatedAt: input.begunAt,
      enabledAt: null,
      pausedAt: null,
    };
  }

  const existing = rehydrateRegistration(existingRow);
  const replayRevision =
    input.expectedRevision === null ? 1 : incrementRevision(input.expectedRevision);
  if (existing.revision === replayRevision && registrationMatchesBegin(existing, input)) {
    return existing;
  }
  if (input.expectedRevision === null || existing.revision !== input.expectedRevision) {
    throw concurrencyError("The project sync registration revision changed.");
  }

  const nextRevision = incrementRevision(existing.revision);
  const updated = await transaction.execute(
    `UPDATE project_sync_registrations
     SET account_id = ?,
         device_id = ?,
         state = 'enabling',
         consent_revision = ?,
         key_version = ?,
         revision = ?,
         plaintext_bootstrap_completed = 0,
         last_error_code = NULL,
         updated_at = ?,
         enabled_at = NULL,
         paused_at = NULL
     WHERE project_id = ? AND revision = ?`,
    [
      input.accountId,
      input.deviceId,
      input.consentRevision,
      input.keyVersion,
      nextRevision,
      input.begunAt,
      input.projectId,
      existing.revision,
    ],
  );
  requireSingleMutation(updated.rowsAffected, "The project sync registration changed.");
  return {
    projectId: input.projectId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    state: "enabling",
    consentRevision: input.consentRevision,
    keyVersion: input.keyVersion,
    revision: nextRevision,
    plaintextBootstrapCompleted: false,
    lastErrorCode: null,
    createdAt: existing.createdAt,
    updatedAt: input.begunAt,
    enabledAt: null,
    pausedAt: null,
  };
}

async function transitionRegistration(
  transaction: TransactionExecutor,
  input: TransitionProjectSyncRegistrationInput,
): Promise<ProjectSyncRegistration> {
  const row = await findRegistration(transaction, input.projectId);
  if (row === null) {
    throw notFoundError("The project sync registration does not exist.");
  }
  const existing = rehydrateRegistration(row);
  requireRegistrationIdentity(existing, input);
  const target = registrationTarget(existing, input);
  if (
    existing.revision === incrementRevision(input.expectedRevision) &&
    sameRegistration(existing, target)
  ) {
    return existing;
  }
  if (existing.revision !== input.expectedRevision) {
    throw concurrencyError("The project sync registration revision changed.");
  }
  if (!isAllowedRegistrationTransition(existing.state, input.target.state)) {
    throw concurrencyError(
      `Project sync cannot transition from ${existing.state} to ${input.target.state}.`,
    );
  }

  const updated = await transaction.execute(
    `UPDATE project_sync_registrations
     SET state = ?,
         revision = ?,
         plaintext_bootstrap_completed = ?,
         last_error_code = ?,
         updated_at = ?,
         enabled_at = ?,
         paused_at = ?
     WHERE project_id = ? AND revision = ?`,
    [
      target.state,
      target.revision,
      target.plaintextBootstrapCompleted ? 1 : 0,
      target.lastErrorCode,
      target.updatedAt,
      target.enabledAt,
      target.pausedAt,
      target.projectId,
      existing.revision,
    ],
  );
  requireSingleMutation(updated.rowsAffected, "The project sync registration changed.");
  return target;
}

async function disableRegistration(
  transaction: TransactionExecutor,
  input: DisableProjectSyncInput,
): Promise<ProjectSyncRegistration | null> {
  const row = await findRegistration(transaction, input.projectId);
  if (row === null) {
    if (
      input.expectedRevision !== null ||
      input.expectedAccountId !== null ||
      input.expectedDeviceId !== null
    ) {
      throw concurrencyError("The project sync registration no longer exists.");
    }
    await revokeProjectSyncTransport(transaction, input.projectId, input.disabledAt);
    return null;
  }
  const existing = rehydrateRegistration(row);
  if (input.expectedAccountId === null || input.expectedDeviceId === null) {
    throw concurrencyError("The project sync registration was created before local disable.");
  }
  if (
    existing.accountId !== input.expectedAccountId ||
    existing.deviceId !== input.expectedDeviceId
  ) {
    throw concurrencyError("The project sync registration identity changed.");
  }
  if (existing.revision === input.expectedRevision && existing.state === "disabled") {
    await revokeProjectSyncTransport(transaction, input.projectId, input.disabledAt);
    return existing;
  }
  if (
    input.expectedRevision !== null &&
    existing.revision === incrementRevision(input.expectedRevision) &&
    existing.state === "disabled" &&
    existing.updatedAt === input.disabledAt
  ) {
    await revokeProjectSyncTransport(transaction, input.projectId, input.disabledAt);
    return existing;
  }
  if (input.expectedRevision === null || existing.revision !== input.expectedRevision) {
    throw concurrencyError("The project sync registration revision changed.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const updated = await transaction.execute(
    `UPDATE project_sync_registrations
     SET state = 'disabled',
         revision = ?,
         plaintext_bootstrap_completed = 0,
         last_error_code = NULL,
         updated_at = ?,
         enabled_at = NULL,
         paused_at = NULL
     WHERE project_id = ? AND revision = ?`,
    [nextRevision, input.disabledAt, input.projectId, existing.revision],
  );
  requireSingleMutation(updated.rowsAffected, "The project sync registration changed.");
  await revokeProjectSyncTransport(transaction, input.projectId, input.disabledAt);
  return {
    ...existing,
    state: "disabled",
    revision: nextRevision,
    plaintextBootstrapCompleted: false,
    lastErrorCode: null,
    updatedAt: input.disabledAt,
    enabledAt: null,
    pausedAt: null,
  };
}

async function revokeProjectSyncTransport(
  transaction: TransactionExecutor,
  projectId: string,
  revokedAt: string,
): Promise<void> {
  await transaction.execute(
    `UPDATE sync_outbox_operations
     SET status = 'paused',
         next_attempt_at = NULL,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = 'SYNC_CONSENT_REVOKED',
         updated_at = ?
     WHERE project_id = ? AND status <> 'acknowledged'`,
    [revokedAt, projectId],
  );
  // Projection jobs are authority-bound work references, not the transport or
  // materialized audit ledgers. Removing them prevents a later consent epoch
  // from inheriting or reusing plaintext work authorized by the old epoch.
  await transaction.execute("DELETE FROM sync_projection_jobs WHERE project_id = ?", [projectId]);
}

async function evaluatePushGate(
  executor: TransactionExecutor,
  input: SyncPushGateInput,
): Promise<SyncPushGate> {
  const row = await findRegistration(executor, input.projectId);
  if (row === null) {
    return { allowed: false, reason: "disabled", registrationRevision: null };
  }
  const registration = rehydrateRegistration(row);
  if (registration.state === "disabled") {
    return {
      allowed: false,
      reason: "disabled",
      registrationRevision: registration.revision,
    };
  }
  if (registration.state !== "enabled") {
    return {
      allowed: false,
      reason: registration.state === "bootstrap_required" ? "bootstrap_required" : "not_enabled",
      registrationRevision: registration.revision,
    };
  }
  if (!registration.plaintextBootstrapCompleted) {
    return {
      allowed: false,
      reason: "bootstrap_required",
      registrationRevision: registration.revision,
    };
  }
  if (registration.accountId !== input.accountId) {
    return {
      allowed: false,
      reason: "account_mismatch",
      registrationRevision: registration.revision,
    };
  }
  if (registration.deviceId !== input.deviceId) {
    return {
      allowed: false,
      reason: "device_mismatch",
      registrationRevision: registration.revision,
    };
  }
  if (registration.consentRevision !== input.consentRevision) {
    return {
      allowed: false,
      reason: "consent_revision_mismatch",
      registrationRevision: registration.revision,
    };
  }
  if (registration.keyVersion !== input.keyVersion) {
    return {
      allowed: false,
      reason: "key_version_mismatch",
      registrationRevision: registration.revision,
    };
  }
  return {
    allowed: true,
    reason: "allowed",
    registrationRevision: registration.revision,
  };
}

async function evaluateProjectionOperationPushGate(
  executor: TransactionExecutor,
  input: ProjectionOperationPushGateInput,
): Promise<ProjectionOperationPushGate> {
  const registrationRow = await findRegistration(executor, input.projectId);
  if (registrationRow === null) {
    return {
      allowed: false,
      reason: "registration_missing",
      registrationRevision: null,
    };
  }
  const registration = rehydrateRegistration(registrationRow);
  if (registration.state !== "enabled" || !registration.plaintextBootstrapCompleted) {
    return {
      allowed: false,
      reason: "not_enabled",
      registrationRevision: registration.revision,
    };
  }
  if (registration.accountId !== input.activeAccountId) {
    return {
      allowed: false,
      reason: "account_mismatch",
      registrationRevision: registration.revision,
    };
  }
  if (registration.deviceId !== input.activeDeviceId) {
    return {
      allowed: false,
      reason: "device_mismatch",
      registrationRevision: registration.revision,
    };
  }

  const rows = await executor.select<ProjectionJobDbRow>(
    `SELECT *
     FROM sync_projection_jobs
     WHERE project_id = ? AND operation_id = ? AND status = 'completed'`,
    [input.projectId, input.operationId],
  );
  if (rows.length > 1) {
    throw corruptionError("A projected operation is bound to multiple jobs.");
  }
  if (rows[0] === undefined) {
    return {
      allowed: false,
      reason: "operation_unbound",
      registrationRevision: registration.revision,
    };
  }
  const job = rehydrateProjectionJob(rows[0]);
  if (job.objectType === "chapter_version" && job.projectionKind === "upsert") {
    const privacyRows = await executor.select<ChapterPrivacyDbRow>(
      `SELECT privacy_mode
       FROM chapters
       WHERE id = ? AND project_id = ?`,
      [job.objectId, job.projectId],
    );
    if (privacyRows.length !== 1) {
      return {
        allowed: false,
        reason: "operation_unbound",
        registrationRevision: registration.revision,
      };
    }
    if (privacyRows[0]?.privacy_mode === "local_only") {
      return {
        allowed: false,
        reason: "chapter_local_only",
        registrationRevision: registration.revision,
      };
    }
  }
  if (
    job.accountId !== registration.accountId ||
    job.deviceId !== registration.deviceId ||
    job.keyVersion !== registration.keyVersion ||
    job.consentRevision !== registration.consentRevision
  ) {
    return {
      allowed: false,
      reason: "authority_mismatch",
      registrationRevision: registration.revision,
    };
  }
  return {
    allowed: true,
    reason: "allowed",
    registrationRevision: registration.revision,
  };
}

async function findProjectionPushBoundaryBlockReason(
  transaction: TransactionExecutor,
  input: ProjectionOperationPushFenceInput,
): Promise<
  | "base_cursor_mismatch"
  | "incremental_work_pending"
  | "materialized_checkpoint_mismatch"
  | "remote_checkpoint_mismatch"
  | null
> {
  if (input.requestBaseCursor !== input.settledSignedRemoteCursor) {
    return "base_cursor_mismatch";
  }
  const remoteRows = await transaction.select<RemoteCheckpointDbRow>(
    `SELECT signed_remote_cursor, revision
     FROM sync_remote_checkpoints
     WHERE project_id = ?`,
    [input.projectId],
  );
  if (
    remoteRows.length !== 1 ||
    remoteRows[0]?.signed_remote_cursor !== input.settledSignedRemoteCursor ||
    remoteRows[0].revision !== input.settledDownloadedCheckpointRevision
  ) {
    return "remote_checkpoint_mismatch";
  }
  const materializedRows = await transaction.select<MaterializedCheckpointDbRow>(
    `SELECT project_id, signed_remote_cursor, downloaded_checkpoint_revision, revision, updated_at
     FROM sync_materialized_checkpoints
     WHERE project_id = ?`,
    [input.projectId],
  );
  if (
    materializedRows.length !== 1 ||
    materializedRows[0]?.signed_remote_cursor !== input.settledSignedRemoteCursor ||
    materializedRows[0].downloaded_checkpoint_revision !==
      input.settledDownloadedCheckpointRevision ||
    materializedRows[0].revision !== input.settledMaterializedCheckpointRevision
  ) {
    return "materialized_checkpoint_mismatch";
  }
  const pendingRows = await transaction.select<PushFencePendingCountsDbRow>(
    `SELECT
       (
         SELECT count(*)
         FROM sync_snapshot_staging_sessions
         WHERE project_id = ?
       ) AS snapshot_pending_count,
       (
         SELECT count(*)
         FROM sync_inbox_operations
         WHERE project_id = ?
           AND status IN ('received', 'applying', 'failed', 'conflict')
       ) AS inbox_pending_count,
       (
         SELECT count(*)
         FROM sync_content_conflicts
         WHERE project_id = ? AND status = 'unresolved'
       ) AS content_conflict_count`,
    [input.projectId, input.projectId, input.projectId],
  );
  const pending = pendingRows[0];
  if (
    pending?.snapshot_pending_count !== 0 ||
    pending.inbox_pending_count !== 0 ||
    pending.content_conflict_count !== 0
  ) {
    return "incremental_work_pending";
  }
  return null;
}

async function writeMaterializedObject(
  transaction: TransactionExecutor,
  input: WriteMaterializedSyncObjectInput,
): Promise<MaterializedSyncObject> {
  const object = input.object;
  const identity = normalizeObjectIdentity(object);
  const [existingRow, sourceRows] = await Promise.all([
    findMaterializedObject(transaction, identity),
    transaction.select<MaterializedObjectDbRow>(
      `SELECT *
       FROM sync_materialized_objects
       WHERE project_id = ? AND source_operation_id = ?`,
      [object.projectId, object.sourceOperationId],
    ),
  ]);
  const existing = existingRow === null ? null : rehydrateMaterializedObject(existingRow);
  if (existing !== null && sameMaterializedObject(existing, object)) {
    return existing;
  }
  if (sourceRows.length > 1) {
    throw corruptionError("A source operation maps to multiple materialized objects.");
  }
  if (sourceRows[0] !== undefined) {
    const sourceObject = rehydrateMaterializedObject(sourceRows[0]);
    if (!sameMaterializedObject(sourceObject, object)) {
      throw concurrencyError("The source operation is already materialized differently.");
    }
    return sourceObject;
  }
  if (
    (existing === null && input.expectedSourceOperationId !== null) ||
    (existing !== null && input.expectedSourceOperationId !== existing.sourceOperationId)
  ) {
    throw concurrencyError("The materialized object changed.");
  }

  const result = await transaction.execute(
    `INSERT INTO sync_materialized_objects (
       project_id, object_type, object_id, object_generation, version_id,
       vector_json, payload_sha256, source_operation_id, source_device_id,
       source_device_sequence, state, materialized_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, object_type, object_id, object_generation) DO UPDATE SET
       version_id = excluded.version_id,
       vector_json = excluded.vector_json,
       payload_sha256 = excluded.payload_sha256,
       source_operation_id = excluded.source_operation_id,
       source_device_id = excluded.source_device_id,
       source_device_sequence = excluded.source_device_sequence,
       state = excluded.state,
       materialized_at = excluded.materialized_at`,
    [
      object.projectId,
      object.objectType,
      object.objectId,
      object.objectGeneration,
      object.versionId,
      serializeVector(object.vector),
      object.payloadSha256,
      object.sourceOperationId,
      object.sourceDeviceId,
      object.sourceDeviceSequence,
      object.state,
      object.materializedAt,
    ],
  );
  requireSingleMutation(result.rowsAffected, "The materialized object was not saved.");
  return object;
}

async function advanceMaterializedCheckpoint(
  transaction: TransactionExecutor,
  input: AdvanceSyncMaterializedCheckpointInput,
): Promise<SyncMaterializedCheckpoint> {
  const existingRow = await findMaterializedCheckpoint(transaction, input.projectId);
  if (existingRow !== null) {
    const existing = rehydrateMaterializedCheckpoint(existingRow);
    const replayRevision =
      input.expectedRevision === null ? 1 : incrementRevision(input.expectedRevision);
    if (
      existing.revision === replayRevision &&
      existing.signedRemoteCursor === input.signedRemoteCursor &&
      existing.downloadedCheckpointRevision === input.downloadedCheckpointRevision &&
      existing.updatedAt === input.updatedAt
    ) {
      return existing;
    }
  }

  const remoteRows = await transaction.select<RemoteCheckpointDbRow>(
    `SELECT signed_remote_cursor, revision
     FROM sync_remote_checkpoints
     WHERE project_id = ?`,
    [input.projectId],
  );
  if (remoteRows.length !== 1) {
    if (remoteRows.length > 1) {
      throw corruptionError("The downloaded sync checkpoint is duplicated.");
    }
    throw concurrencyError("No downloaded sync checkpoint exists for materialization.");
  }
  const remote = remoteRows[0];
  if (
    remote === undefined ||
    parseCursor(remote.signed_remote_cursor, "downloadedSignedRemoteCursor") !==
      input.signedRemoteCursor ||
    parsePositiveInteger(remote.revision, "downloadedCheckpointRevision") !==
      input.downloadedCheckpointRevision
  ) {
    throw concurrencyError(
      "The materialized checkpoint must match the exact downloaded checkpoint.",
    );
  }
  if (existingRow === null) {
    if (input.expectedRevision !== null) {
      throw concurrencyError("The materialized checkpoint no longer exists.");
    }
    const inserted = await transaction.execute(
      `INSERT INTO sync_materialized_checkpoints (
         project_id, signed_remote_cursor, downloaded_checkpoint_revision,
         revision, updated_at
       ) VALUES (?, ?, ?, 1, ?)`,
      [
        input.projectId,
        input.signedRemoteCursor,
        input.downloadedCheckpointRevision,
        input.updatedAt,
      ],
    );
    requireSingleMutation(inserted.rowsAffected, "The materialized checkpoint was not created.");
    return {
      projectId: input.projectId,
      signedRemoteCursor: input.signedRemoteCursor,
      downloadedCheckpointRevision: input.downloadedCheckpointRevision,
      revision: 1,
      updatedAt: input.updatedAt,
    };
  }
  const existing = rehydrateMaterializedCheckpoint(existingRow);
  if (input.expectedRevision === null || existing.revision !== input.expectedRevision) {
    throw concurrencyError("The materialized checkpoint revision changed.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const updated = await transaction.execute(
    `UPDATE sync_materialized_checkpoints
     SET signed_remote_cursor = ?,
         downloaded_checkpoint_revision = ?,
         revision = ?,
         updated_at = ?
     WHERE project_id = ? AND revision = ?`,
    [
      input.signedRemoteCursor,
      input.downloadedCheckpointRevision,
      nextRevision,
      input.updatedAt,
      input.projectId,
      existing.revision,
    ],
  );
  requireSingleMutation(updated.rowsAffected, "The materialized checkpoint changed.");
  return {
    projectId: input.projectId,
    signedRemoteCursor: input.signedRemoteCursor,
    downloadedCheckpointRevision: input.downloadedCheckpointRevision,
    revision: nextRevision,
    updatedAt: input.updatedAt,
  };
}

async function registerConflict(
  transaction: TransactionExecutor,
  input: RegisterSyncContentConflictInput,
): Promise<SyncContentConflict> {
  const existingById = await findConflictById(transaction, input.conflictId);
  const target = unresolvedConflict(input);
  if (existingById !== null) {
    const existing = rehydrateConflict(existingById);
    if (sameConflict(existing, target)) {
      return existing;
    }
    throw concurrencyError("The conflict identifier is already registered differently.");
  }
  const operationRows = await transaction.select<ConflictDbRow>(
    `SELECT *
     FROM sync_content_conflicts
     WHERE project_id = ?
       AND remote_operation_id = ?`,
    [input.projectId, input.remoteOperationId],
  );
  if (operationRows.length > 1) {
    throw corruptionError("A remote operation maps to multiple conflict records.");
  }
  if (operationRows[0] !== undefined) {
    rehydrateConflict(operationRows[0]);
    throw concurrencyError("The remote operation is already registered under another conflict.");
  }

  const inserted = await transaction.execute(
    `INSERT INTO sync_content_conflicts (
       conflict_id, project_id, object_type, object_id, object_generation,
       local_vector_json, remote_vector_json, remote_operation_id, remote_kind,
       remote_payload_sha256, status, resolution, resolution_operation_id,
       revision, created_at, updated_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', NULL, NULL, 1, ?, ?, NULL)`,
    [
      target.conflictId,
      target.projectId,
      target.objectType,
      target.objectId,
      target.objectGeneration,
      serializeVector(target.localVector),
      serializeVector(target.remoteVector),
      target.remoteOperationId,
      target.remoteKind,
      target.remotePayloadSha256,
      target.createdAt,
      target.updatedAt,
    ],
  );
  requireSingleMutation(inserted.rowsAffected, "The sync conflict was not registered.");
  return target;
}

async function resolveConflict(
  transaction: TransactionExecutor,
  input: ResolveSyncContentConflictInput,
): Promise<SyncContentConflict> {
  const row = await findConflictById(transaction, input.conflictId);
  if (row === null) {
    throw notFoundError("The sync content conflict does not exist.");
  }
  const existing = rehydrateConflict(row);
  if (
    existing.status === "resolved" &&
    existing.revision === incrementRevision(input.expectedRevision) &&
    existing.resolution === input.resolution &&
    existing.resolutionOperationId === input.resolutionOperationId &&
    existing.resolvedAt === input.resolvedAt &&
    existing.updatedAt === input.resolvedAt
  ) {
    return existing;
  }
  if (existing.status !== "unresolved" || existing.revision !== input.expectedRevision) {
    throw concurrencyError("The sync conflict resolution state changed.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const updated = await transaction.execute(
    `UPDATE sync_content_conflicts
     SET status = 'resolved',
         resolution = ?,
         resolution_operation_id = ?,
         revision = ?,
         updated_at = ?,
         resolved_at = ?
     WHERE conflict_id = ? AND status = 'unresolved' AND revision = ?`,
    [
      input.resolution,
      input.resolutionOperationId,
      nextRevision,
      input.resolvedAt,
      input.resolvedAt,
      input.conflictId,
      existing.revision,
    ],
  );
  requireSingleMutation(updated.rowsAffected, "The sync conflict resolution state changed.");
  return {
    ...existing,
    status: "resolved",
    resolution: input.resolution,
    resolutionOperationId: input.resolutionOperationId,
    revision: nextRevision,
    updatedAt: input.resolvedAt,
    resolvedAt: input.resolvedAt,
  };
}

async function enqueueProjectionJob(
  transaction: TransactionExecutor,
  input: EnqueueSyncProjectionJobInput,
): Promise<SyncProjectionJob> {
  const existingById = await findProjectionJob(transaction, input.jobId);
  const target = queuedProjectionJob(input);
  if (existingById !== null) {
    const existing = rehydrateProjectionJob(existingById);
    if (sameProjectionJob(existing, target)) {
      return existing;
    }
    throw concurrencyError("The projection job identifier is already used differently.");
  }

  const gate = await evaluatePushGate(transaction, {
    projectId: input.projectId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    consentRevision: input.consentRevision,
    keyVersion: input.keyVersion,
  });
  if (!gate.allowed) {
    throw concurrencyError(`The project push gate is closed: ${gate.reason}.`);
  }

  const identityRows = await transaction.select<ProjectionJobDbRow>(
    `SELECT *
     FROM sync_projection_jobs
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?
       AND projection_kind = ?
     ORDER BY source_revision DESC, created_at DESC, job_id DESC`,
    [
      input.projectId,
      input.objectType,
      input.objectId,
      input.objectGeneration,
      input.projectionKind,
    ],
  );
  const jobs = identityRows.map(rehydrateProjectionJob);
  const exact = jobs.find(
    (job) =>
      job.sourceRevision === input.sourceRevision &&
      job.accountId === input.accountId &&
      job.keyVersion === input.keyVersion &&
      job.consentRevision === input.consentRevision &&
      job.deviceId === input.deviceId,
  );
  if (exact !== undefined) {
    throw concurrencyError("The projection source revision is already queued differently.");
  }
  const newestSourceRevision = jobs[0]?.sourceRevision;
  if (
    newestSourceRevision !== undefined &&
    newestSourceRevision > input.sourceRevision &&
    input.objectType !== "chapter_version"
  ) {
    throw concurrencyError("A newer projection source revision already exists.");
  }
  if (
    input.objectType === "chapter_version" &&
    jobs.some(
      (job) =>
        job.sourceRevision > input.sourceRevision &&
        (job.status === "leased" || job.status === "completed"),
    )
  ) {
    throw concurrencyError(
      "A newer chapter projection advanced before its missing predecessor was queued.",
    );
  }

  const inserted = await transaction.execute(
    `INSERT INTO sync_projection_jobs (
       job_id, project_id, account_id, object_type, object_id, object_generation,
       projection_kind, version_id, source_revision, key_version,
       consent_revision, device_id, status, attempt, revision,
       next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
       operation_id, failure_code, superseded_by_job_id, created_at,
       updated_at, terminal_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 1, ?,
       NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
     )`,
    [
      target.jobId,
      target.projectId,
      target.accountId,
      target.objectType,
      target.objectId,
      target.objectGeneration,
      target.projectionKind,
      target.versionId,
      target.sourceRevision,
      target.keyVersion,
      target.consentRevision,
      target.deviceId,
      target.nextAttemptAt,
      target.createdAt,
      target.updatedAt,
    ],
  );
  requireSingleMutation(inserted.rowsAffected, "The projection job was not queued.");

  await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'superseded',
         revision = revision + 1,
         next_attempt_at = NULL,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = NULL,
         superseded_by_job_id = ?,
         updated_at = ?,
         terminal_at = ?
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?
       AND projection_kind = ?
       AND job_id <> ?
       AND status IN ('queued', 'leased', 'retry_wait')
       AND (
         (
           ? <> 'chapter_version'
           AND source_revision < ?
         )
         OR (
           source_revision = ?
           AND (
             account_id <> ?
             OR key_version <> ?
             OR consent_revision <> ?
             OR device_id <> ?
           )
         )
       )`,
    [
      target.jobId,
      target.createdAt,
      target.createdAt,
      target.projectId,
      target.objectType,
      target.objectId,
      target.objectGeneration,
      target.projectionKind,
      target.jobId,
      target.objectType,
      target.sourceRevision,
      target.sourceRevision,
      target.accountId,
      target.keyVersion,
      target.consentRevision,
      target.deviceId,
    ],
  );
  return target;
}

async function claimProjectionJob(
  transaction: TransactionExecutor,
  input: ClaimSyncProjectionJobInput,
): Promise<SyncProjectionJob | null> {
  const replayRows = await transaction.select<ProjectionJobDbRow>(
    `SELECT *
     FROM sync_projection_jobs
     WHERE lease_token = ?`,
    [input.leaseToken],
  );
  if (replayRows.length > 1) {
    throw corruptionError("A projection lease token is duplicated.");
  }
  if (replayRows[0] !== undefined) {
    const replay = rehydrateProjectionJob(replayRows[0]);
    if (
      replay.status === "leased" &&
      replay.projectId === input.projectId &&
      replay.leaseOwnerId === input.leaseOwnerId &&
      replay.leaseExpiresAt === input.leaseExpiresAt &&
      replay.updatedAt === input.leasedAt
    ) {
      return replay;
    }
    throw concurrencyError("The projection lease token is already used differently.");
  }

  await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'retry_wait',
         revision = revision + 1,
         next_attempt_at = ?,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = 'LEASE_EXPIRED',
         updated_at = ?
     WHERE project_id = ?
       AND status = 'leased'
       AND lease_expires_at <= ?`,
    [input.leasedAt, input.leasedAt, input.projectId, input.leasedAt],
  );

  const rows = await transaction.select<ProjectionJobDbRow>(
    `SELECT job.*
     FROM sync_projection_jobs AS job
     JOIN project_sync_registrations AS registration
       ON registration.project_id = job.project_id
     WHERE job.project_id = ?
       AND job.status IN ('queued', 'retry_wait')
       AND job.next_attempt_at <= ?
       AND registration.state = 'enabled'
       AND registration.plaintext_bootstrap_completed = 1
       AND registration.account_id = job.account_id
       AND registration.device_id = job.device_id
       AND registration.key_version = job.key_version
       AND registration.consent_revision = job.consent_revision
       AND (
         job.object_type = 'project_manifest'
         OR EXISTS (
           SELECT 1
           FROM sync_materialized_objects AS manifest
           WHERE manifest.project_id = job.project_id
             AND manifest.object_type = 'project_manifest'
             AND manifest.object_id = job.project_id
             AND manifest.state = 'present'
             AND NOT EXISTS (
               SELECT 1
               FROM sync_materialized_objects AS newer_manifest
               WHERE newer_manifest.project_id = manifest.project_id
                 AND newer_manifest.object_type = manifest.object_type
                 AND newer_manifest.object_id = manifest.object_id
                 AND newer_manifest.object_generation > manifest.object_generation
             )
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM sync_projection_jobs AS active_lease
         WHERE active_lease.project_id = job.project_id
           AND active_lease.device_id = job.device_id
           AND active_lease.status = 'leased'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM sync_projection_jobs AS predecessor
         WHERE predecessor.project_id = job.project_id
           AND predecessor.account_id = job.account_id
           AND predecessor.device_id = job.device_id
           AND predecessor.key_version = job.key_version
           AND predecessor.consent_revision = job.consent_revision
           AND predecessor.object_type = job.object_type
           AND predecessor.object_id = job.object_id
           AND predecessor.status <> 'completed'
           AND (
             predecessor.object_generation < job.object_generation
             OR (
               job.object_type = 'chapter_version'
               AND predecessor.object_generation = job.object_generation
               AND predecessor.source_revision < job.source_revision
             )
           )
       )
     ORDER BY job.next_attempt_at, job.created_at, job.job_id
     LIMIT 1`,
    [input.projectId, input.leasedAt],
  );
  if (rows[0] === undefined) {
    return null;
  }
  const existing = rehydrateProjectionJob(rows[0]);
  if (existing.attempt >= 100) {
    const exhausted = await transaction.execute(
      `UPDATE sync_projection_jobs
       SET status = 'failed',
           revision = revision + 1,
           next_attempt_at = NULL,
           failure_code = 'ATTEMPT_LIMIT_EXCEEDED',
           updated_at = ?,
           terminal_at = ?
       WHERE job_id = ? AND revision = ? AND status IN ('queued', 'retry_wait')`,
      [input.leasedAt, input.leasedAt, existing.jobId, existing.revision],
    );
    requireSingleMutation(exhausted.rowsAffected, "The projection job changed.");
    return null;
  }
  const nextRevision = incrementRevision(existing.revision);
  const updated = await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'leased',
         attempt = attempt + 1,
         revision = ?,
         next_attempt_at = NULL,
         lease_owner_id = ?,
         lease_token = ?,
         lease_expires_at = ?,
         failure_code = NULL,
         updated_at = ?
     WHERE job_id = ?
       AND revision = ?
       AND status IN ('queued', 'retry_wait')
       AND next_attempt_at <= ?`,
    [
      nextRevision,
      input.leaseOwnerId,
      input.leaseToken,
      input.leaseExpiresAt,
      input.leasedAt,
      existing.jobId,
      existing.revision,
      input.leasedAt,
    ],
  );
  requireSingleMutation(updated.rowsAffected, "The projection job changed before it was leased.");
  return {
    ...existing,
    status: "leased",
    attempt: existing.attempt + 1,
    revision: nextRevision,
    nextAttemptAt: null,
    leaseOwnerId: input.leaseOwnerId,
    leaseToken: input.leaseToken,
    leaseExpiresAt: input.leaseExpiresAt,
    failureCode: null,
    updatedAt: input.leasedAt,
  };
}

async function readProjectionBlockingState(
  transaction: TransactionExecutor,
  input: ReadSyncProjectionBlockingStateInput,
): Promise<SyncProjectionBlockingState> {
  const registrationRow = await findRegistration(transaction, input.projectId);
  if (registrationRow === null) {
    return {
      projectId: input.projectId,
      authority: null,
      state: "idle",
    };
  }
  const registration = rehydrateRegistration(registrationRow);
  const authority: SyncProjectionAuthority = {
    accountId: registration.accountId,
    deviceId: registration.deviceId,
    keyVersion: registration.keyVersion,
    consentRevision: registration.consentRevision,
    registrationRevision: registration.revision,
  };
  const rows = await transaction.select<ProjectionJobDbRow>(
    `SELECT *
     FROM sync_projection_jobs
     WHERE project_id = ?
       AND account_id = ?
       AND device_id = ?
       AND key_version = ?
       AND consent_revision = ?
       AND status <> 'completed'
     ORDER BY
       CASE WHEN next_attempt_at IS NULL THEN 1 ELSE 0 END,
       next_attempt_at,
       created_at,
       job_id`,
    [
      input.projectId,
      authority.accountId,
      authority.deviceId,
      authority.keyVersion,
      authority.consentRevision,
    ],
  );
  const jobs = rows.map(rehydrateProjectionJob);
  const visibleJobs = jobs.filter((job) => job.status !== "superseded");
  const common = {
    projectId: input.projectId,
    authority,
  };
  if (visibleJobs.length === 0) {
    return {
      ...common,
      state: "idle",
    };
  }

  const exhausted = visibleJobs.find(
    (job) =>
      job.failureCode === "ATTEMPT_LIMIT_EXCEEDED" ||
      (job.status !== "leased" && job.attempt >= 100),
  );
  if (exhausted !== undefined) {
    return {
      ...common,
      state: "attempt_exhausted",
      jobId: exhausted.jobId,
      attempt: exhausted.attempt,
      failureCode: exhausted.failureCode ?? "ATTEMPT_LIMIT_EXCEEDED",
    };
  }

  const permanentlyFailed = visibleJobs.find((job) => job.status === "failed");
  if (permanentlyFailed !== undefined) {
    return {
      ...common,
      state: "permanent_failure",
      jobId: permanentlyFailed.jobId,
      attempt: permanentlyFailed.attempt,
      failureCode: requireProjectionFailureCode(permanentlyFailed),
    };
  }

  const firstPending = requireFirstProjectionJob(visibleJobs);
  if (registration.state !== "enabled" || !registration.plaintextBootstrapCompleted) {
    return {
      ...common,
      state: "blocked",
      jobId: firstPending.jobId,
      reason: "registration_not_enabled",
      blockerJobId: null,
      resumeAt: null,
    };
  }

  const activeLeaseRows = await transaction.select<ProjectionJobDbRow>(
    `SELECT *
     FROM sync_projection_jobs
     WHERE project_id = ?
       AND device_id = ?
       AND status = 'leased'
       AND lease_expires_at > ?
     ORDER BY lease_expires_at, created_at, job_id
     LIMIT 1`,
    [input.projectId, authority.deviceId, input.observedAt],
  );
  const activeLease =
    activeLeaseRows[0] === undefined ? null : rehydrateProjectionJob(activeLeaseRows[0]);
  if (activeLease !== null) {
    return {
      ...common,
      state: "blocked",
      jobId: firstPending.jobId,
      reason: "active_lease",
      blockerJobId: activeLease.jobId,
      resumeAt: requireProjectionLeaseExpiry(activeLease),
    };
  }

  const observedMilliseconds = Date.parse(input.observedAt);
  const dueJobs = visibleJobs.filter(
    (job) =>
      (job.status === "queued" || job.status === "retry_wait") &&
      job.nextAttemptAt !== null &&
      Date.parse(job.nextAttemptAt) <= observedMilliseconds,
  );
  for (const job of dueJobs) {
    if (job.objectType === "chapter_version") {
      const manifestRow = await findCurrentMaterializedObject(transaction, {
        projectId: input.projectId,
        objectType: "project_manifest",
        objectId: input.projectId,
      });
      const manifest = manifestRow === null ? null : rehydrateMaterializedObject(manifestRow);
      if (manifest?.state !== "present") {
        return {
          ...common,
          state: "blocked",
          jobId: job.jobId,
          reason: "project_manifest_missing",
          blockerJobId: null,
          resumeAt: null,
        };
      }
    }

    const predecessor = jobs.find(
      (candidate) =>
        candidate.jobId !== job.jobId &&
        candidate.objectType === job.objectType &&
        candidate.objectId === job.objectId &&
        (candidate.objectGeneration < job.objectGeneration ||
          (job.objectType === "chapter_version" &&
            candidate.objectGeneration === job.objectGeneration &&
            candidate.sourceRevision < job.sourceRevision)),
    );
    if (predecessor !== undefined) {
      if (
        (predecessor.status === "queued" || predecessor.status === "retry_wait") &&
        predecessor.nextAttemptAt !== null &&
        Date.parse(predecessor.nextAttemptAt) > observedMilliseconds
      ) {
        return {
          ...common,
          state: "backoff",
          jobId: predecessor.jobId,
          attempt: predecessor.attempt,
          nextAttemptAt: predecessor.nextAttemptAt,
          failureCode: predecessor.failureCode,
        };
      }
      return {
        ...common,
        state: "blocked",
        jobId: job.jobId,
        reason: "predecessor_pending",
        blockerJobId: predecessor.jobId,
        resumeAt: predecessor.leaseExpiresAt,
      };
    }

    return {
      ...common,
      state: "blocked",
      jobId: job.jobId,
      reason: "claim_raced",
      blockerJobId: null,
      resumeAt: null,
    };
  }

  const waiting = visibleJobs.find(
    (job) =>
      (job.status === "queued" || job.status === "retry_wait") &&
      job.nextAttemptAt !== null &&
      Date.parse(job.nextAttemptAt) > observedMilliseconds,
  );
  if (waiting !== undefined && waiting.nextAttemptAt !== null) {
    return {
      ...common,
      state: "backoff",
      jobId: waiting.jobId,
      attempt: waiting.attempt,
      nextAttemptAt: waiting.nextAttemptAt,
      failureCode: waiting.failureCode,
    };
  }

  return {
    ...common,
    state: "blocked",
    jobId: firstPending.jobId,
    reason: "claim_raced",
    blockerJobId: null,
    resumeAt: null,
  };
}

async function completeProjectionJob(
  transaction: TransactionExecutor,
  input: CompleteSyncProjectionJobInput,
): Promise<SyncProjectionJob> {
  const existing = await requireProjectionJob(transaction, input.jobId);
  if (
    existing.status === "completed" &&
    existing.revision === incrementRevision(input.expectedRevision) &&
    existing.operationId === input.operationId &&
    existing.updatedAt === input.completedAt &&
    existing.terminalAt === input.completedAt
  ) {
    return existing;
  }
  requireProjectionLease(existing, input);
  if (existing.revision !== input.expectedRevision) {
    throw concurrencyError("The projection job revision changed.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const result = await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'completed',
         revision = ?,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         operation_id = ?,
         updated_at = ?,
         terminal_at = ?
     WHERE job_id = ? AND revision = ? AND status = 'leased'
       AND lease_owner_id = ? AND lease_token = ?`,
    [
      nextRevision,
      input.operationId,
      input.completedAt,
      input.completedAt,
      input.jobId,
      existing.revision,
      input.leaseOwnerId,
      input.leaseToken,
    ],
  );
  requireSingleMutation(result.rowsAffected, "The projection job lease changed.");
  return {
    ...existing,
    status: "completed",
    revision: nextRevision,
    leaseOwnerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    operationId: input.operationId,
    updatedAt: input.completedAt,
    terminalAt: input.completedAt,
  };
}

async function retryProjectionJob(
  transaction: TransactionExecutor,
  input: RetrySyncProjectionJobInput,
): Promise<SyncProjectionJob> {
  const existing = await requireProjectionJob(transaction, input.jobId);
  if (
    existing.status === "retry_wait" &&
    existing.revision === incrementRevision(input.expectedRevision) &&
    existing.failureCode === input.failureCode &&
    existing.updatedAt === input.failedAt &&
    existing.nextAttemptAt === input.nextAttemptAt
  ) {
    return existing;
  }
  requireProjectionLease(existing, input);
  if (existing.revision !== input.expectedRevision) {
    throw concurrencyError("The projection job revision changed.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const result = await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'retry_wait',
         revision = ?,
         next_attempt_at = ?,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = ?,
         updated_at = ?
     WHERE job_id = ? AND revision = ? AND status = 'leased'
       AND lease_owner_id = ? AND lease_token = ?`,
    [
      nextRevision,
      input.nextAttemptAt,
      input.failureCode,
      input.failedAt,
      input.jobId,
      existing.revision,
      input.leaseOwnerId,
      input.leaseToken,
    ],
  );
  requireSingleMutation(result.rowsAffected, "The projection job lease changed.");
  return {
    ...existing,
    status: "retry_wait",
    revision: nextRevision,
    nextAttemptAt: input.nextAttemptAt,
    leaseOwnerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    failureCode: input.failureCode,
    updatedAt: input.failedAt,
  };
}

async function failProjectionJob(
  transaction: TransactionExecutor,
  input: FailSyncProjectionJobInput,
): Promise<SyncProjectionJob> {
  const existing = await requireProjectionJob(transaction, input.jobId);
  if (
    existing.status === "failed" &&
    existing.revision === incrementRevision(input.expectedRevision) &&
    existing.failureCode === input.failureCode &&
    existing.updatedAt === input.failedAt &&
    existing.terminalAt === input.failedAt
  ) {
    return existing;
  }
  requireProjectionLease(existing, input);
  if (existing.revision !== input.expectedRevision) {
    throw concurrencyError("The projection job revision changed.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const result = await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'failed',
         revision = ?,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = ?,
         updated_at = ?,
         terminal_at = ?
     WHERE job_id = ? AND revision = ? AND status = 'leased'
       AND lease_owner_id = ? AND lease_token = ?`,
    [
      nextRevision,
      input.failureCode,
      input.failedAt,
      input.failedAt,
      input.jobId,
      existing.revision,
      input.leaseOwnerId,
      input.leaseToken,
    ],
  );
  requireSingleMutation(result.rowsAffected, "The projection job lease changed.");
  return {
    ...existing,
    status: "failed",
    revision: nextRevision,
    leaseOwnerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    failureCode: input.failureCode,
    updatedAt: input.failedAt,
    terminalAt: input.failedAt,
  };
}

async function supersedeProjectionJob(
  transaction: TransactionExecutor,
  input: SupersedeSyncProjectionJobInput,
): Promise<SyncProjectionJob> {
  const existing = await requireProjectionJob(transaction, input.jobId);
  if (
    existing.status === "superseded" &&
    existing.revision === incrementRevision(input.expectedRevision) &&
    existing.supersededByJobId === input.supersededByJobId &&
    existing.updatedAt === input.supersededAt &&
    existing.terminalAt === input.supersededAt
  ) {
    return existing;
  }
  if (
    existing.revision !== input.expectedRevision ||
    !["queued", "leased", "retry_wait"].includes(existing.status)
  ) {
    throw concurrencyError("The projection job cannot be superseded from its current state.");
  }
  const nextRevision = incrementRevision(existing.revision);
  const result = await transaction.execute(
    `UPDATE sync_projection_jobs
     SET status = 'superseded',
         revision = ?,
         next_attempt_at = NULL,
         lease_owner_id = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = NULL,
         superseded_by_job_id = ?,
         updated_at = ?,
         terminal_at = ?
     WHERE job_id = ? AND revision = ?
       AND status IN ('queued', 'leased', 'retry_wait')`,
    [
      nextRevision,
      input.supersededByJobId,
      input.supersededAt,
      input.supersededAt,
      input.jobId,
      existing.revision,
    ],
  );
  requireSingleMutation(result.rowsAffected, "The projection job state changed.");
  return {
    ...existing,
    status: "superseded",
    revision: nextRevision,
    nextAttemptAt: null,
    leaseOwnerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    failureCode: null,
    supersededByJobId: input.supersededByJobId,
    updatedAt: input.supersededAt,
    terminalAt: input.supersededAt,
  };
}

async function findRegistration(
  executor: TransactionExecutor,
  projectId: string,
): Promise<RegistrationDbRow | null> {
  const rows = await executor.select<RegistrationDbRow>(
    "SELECT * FROM project_sync_registrations WHERE project_id = ?",
    [projectId],
  );
  return requireAtMostOne(rows, "The project sync registration is duplicated.");
}

async function findMaterializedObject(
  executor: TransactionExecutor,
  identity: {
    readonly projectId: string;
    readonly objectType: SyncObjectType;
    readonly objectId: string;
    readonly objectGeneration: number;
  },
): Promise<MaterializedObjectDbRow | null> {
  const rows = await executor.select<MaterializedObjectDbRow>(
    `SELECT *
     FROM sync_materialized_objects
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?`,
    [identity.projectId, identity.objectType, identity.objectId, identity.objectGeneration],
  );
  return requireAtMostOne(rows, "The materialized object identity is duplicated.");
}

async function findCurrentMaterializedObject(
  executor: TransactionExecutor,
  identity: {
    readonly projectId: string;
    readonly objectType: SyncObjectType;
    readonly objectId: string;
  },
): Promise<MaterializedObjectDbRow | null> {
  const rows = await executor.select<MaterializedObjectDbRow>(
    `SELECT *
     FROM sync_materialized_objects
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
     ORDER BY object_generation DESC
     LIMIT 1`,
    [identity.projectId, identity.objectType, identity.objectId],
  );
  return requireAtMostOne(rows, "The current materialized object query is inconsistent.");
}

async function findMaterializedCheckpoint(
  executor: TransactionExecutor,
  projectId: string,
): Promise<MaterializedCheckpointDbRow | null> {
  const rows = await executor.select<MaterializedCheckpointDbRow>(
    "SELECT * FROM sync_materialized_checkpoints WHERE project_id = ?",
    [projectId],
  );
  return requireAtMostOne(rows, "The materialized checkpoint is duplicated.");
}

async function findConflictById(
  executor: TransactionExecutor,
  conflictId: string,
): Promise<ConflictDbRow | null> {
  const rows = await executor.select<ConflictDbRow>(
    "SELECT * FROM sync_content_conflicts WHERE conflict_id = ?",
    [conflictId],
  );
  return requireAtMostOne(rows, "The sync content conflict is duplicated.");
}

async function findProjectionJob(
  executor: TransactionExecutor,
  jobId: string,
): Promise<ProjectionJobDbRow | null> {
  const rows = await executor.select<ProjectionJobDbRow>(
    "SELECT * FROM sync_projection_jobs WHERE job_id = ?",
    [jobId],
  );
  return requireAtMostOne(rows, "The projection job is duplicated.");
}

async function requireProjectionJob(
  executor: TransactionExecutor,
  jobId: string,
): Promise<SyncProjectionJob> {
  const row = await findProjectionJob(executor, jobId);
  if (row === null) {
    throw notFoundError("The projection job does not exist.");
  }
  return rehydrateProjectionJob(row);
}

function normalizeBeginEnable(input: BeginProjectSyncEnableInput): BeginProjectSyncEnableInput {
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    accountId: parseUuid(input.accountId, "accountId"),
    deviceId: parseUuid(input.deviceId, "deviceId"),
    consentRevision: parsePositiveInteger(input.consentRevision, "consentRevision"),
    keyVersion: parseKeyVersion(input.keyVersion),
    expectedRevision: parseNullableRevision(input.expectedRevision, "expectedRevision"),
    begunAt: parseTimestamp(input.begunAt, "begunAt"),
  };
}

function normalizeRegistrationTransition(
  input: TransitionProjectSyncRegistrationInput,
): TransitionProjectSyncRegistrationInput {
  const state = parseOneOf(
    input.target.state,
    ["bootstrap_required", "enabled", "paused", "error"] as const,
    "target.state",
  );
  const target: ProjectSyncRegistrationTarget =
    state === "error"
      ? {
          state,
          errorCode: parseErrorCode(
            "errorCode" in input.target ? input.target.errorCode : "",
            "target.errorCode",
          ),
        }
      : { state };
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    expectedAccountId: parseUuid(input.expectedAccountId, "expectedAccountId"),
    expectedDeviceId: parseUuid(input.expectedDeviceId, "expectedDeviceId"),
    expectedConsentRevision: parsePositiveInteger(
      input.expectedConsentRevision,
      "expectedConsentRevision",
    ),
    expectedKeyVersion: parseKeyVersion(input.expectedKeyVersion),
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    target,
    transitionedAt: parseTimestamp(input.transitionedAt, "transitionedAt"),
  };
}

function normalizeDisable(input: DisableProjectSyncInput): DisableProjectSyncInput {
  const hasAccount = input.expectedAccountId !== null;
  const hasDevice = input.expectedDeviceId !== null;
  if (hasAccount !== hasDevice) {
    throw validationError(
      "expectedAccountId and expectedDeviceId must both be present or both be null.",
    );
  }
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    expectedAccountId:
      input.expectedAccountId === null
        ? null
        : parseUuid(input.expectedAccountId, "expectedAccountId"),
    expectedDeviceId:
      input.expectedDeviceId === null
        ? null
        : parseUuid(input.expectedDeviceId, "expectedDeviceId"),
    expectedRevision: parseNullableRevision(input.expectedRevision, "expectedRevision"),
    disabledAt: parseTimestamp(input.disabledAt, "disabledAt"),
  };
}

function normalizePushGate(input: SyncPushGateInput): SyncPushGateInput {
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    accountId: parseUuid(input.accountId, "accountId"),
    deviceId: parseUuid(input.deviceId, "deviceId"),
    consentRevision: parsePositiveInteger(input.consentRevision, "consentRevision"),
    keyVersion: parseKeyVersion(input.keyVersion),
  };
}

function normalizeProjectionOperationPushFence(
  input: ProjectionOperationPushFenceInput,
): ProjectionOperationPushFenceInput {
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    operationId: parseUuid(input.operationId, "operationId"),
    activeAccountId: parseUuid(input.activeAccountId, "activeAccountId"),
    activeDeviceId: parseUuid(input.activeDeviceId, "activeDeviceId"),
    settledSignedRemoteCursor: parseCursor(
      input.settledSignedRemoteCursor,
      "settledSignedRemoteCursor",
    ),
    settledDownloadedCheckpointRevision: parsePositiveInteger(
      input.settledDownloadedCheckpointRevision,
      "settledDownloadedCheckpointRevision",
    ),
    settledMaterializedCheckpointRevision: parsePositiveInteger(
      input.settledMaterializedCheckpointRevision,
      "settledMaterializedCheckpointRevision",
    ),
    requestBaseCursor:
      input.requestBaseCursor === null
        ? null
        : parseCursor(input.requestBaseCursor, "requestBaseCursor"),
    leaseOwnerId: parseUuid(input.leaseOwnerId, "leaseOwnerId"),
    leaseToken: parseUuid(input.leaseToken, "leaseToken"),
    authorizedAt: parseTimestamp(input.authorizedAt, "authorizedAt"),
    readAcknowledgedAt: input.readAcknowledgedAt,
  };
}

function normalizeMaterializedWrite(
  input: WriteMaterializedSyncObjectInput,
): WriteMaterializedSyncObjectInput {
  const object = input.object;
  const rawObject = object as unknown as Readonly<Record<string, unknown>>;
  if (
    rawObject.state !== "present" &&
    !(
      rawObject.state === "deleted" &&
      rawObject.versionId === null &&
      rawObject.payloadSha256 === null
    )
  ) {
    throw validationError("The materialized object state is invalid.");
  }
  const identity = normalizeObjectIdentity(object);
  const sourceDeviceId = parseUuid(object.sourceDeviceId, "sourceDeviceId");
  const sourceDeviceSequence = parsePositiveInteger(
    object.sourceDeviceSequence,
    "sourceDeviceSequence",
  );
  const vector = parseVector(object.vector, "vector");
  if (vector[sourceDeviceId] !== sourceDeviceSequence) {
    throw validationError(
      "The materialized object source sequence must match its version-vector counter.",
    );
  }
  const common = {
    ...identity,
    vector,
    sourceOperationId: parseUuid(object.sourceOperationId, "sourceOperationId"),
    sourceDeviceId,
    sourceDeviceSequence,
    materializedAt: parseTimestamp(object.materializedAt, "materializedAt"),
  };
  const normalized: MaterializedSyncObject =
    object.state === "present"
      ? {
          ...common,
          state: "present",
          versionId: parseUuid(object.versionId, "versionId"),
          payloadSha256: parseSha256(object.payloadSha256, "payloadSha256"),
        }
      : {
          ...common,
          state: "deleted",
          versionId: null,
          payloadSha256: null,
        };
  return {
    object: normalized,
    expectedSourceOperationId:
      input.expectedSourceOperationId === null
        ? null
        : parseUuid(input.expectedSourceOperationId, "expectedSourceOperationId"),
  };
}

function normalizeCheckpointAdvance(
  input: AdvanceSyncMaterializedCheckpointInput,
): AdvanceSyncMaterializedCheckpointInput {
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    signedRemoteCursor: parseCursor(input.signedRemoteCursor, "signedRemoteCursor"),
    downloadedCheckpointRevision: parsePositiveInteger(
      input.downloadedCheckpointRevision,
      "downloadedCheckpointRevision",
    ),
    expectedRevision: parseNullableRevision(input.expectedRevision, "expectedRevision"),
    updatedAt: parseTimestamp(input.updatedAt, "updatedAt"),
  };
}

function normalizeConflictRegistration(
  input: RegisterSyncContentConflictInput,
): RegisterSyncContentConflictInput {
  const remoteKind = parseOneOf(input.remoteKind, ["upsert", "delete"] as const, "remoteKind");
  const remotePayloadSha256 =
    input.remotePayloadSha256 === null
      ? null
      : parseSha256(input.remotePayloadSha256, "remotePayloadSha256");
  if (
    (remoteKind === "upsert" && remotePayloadSha256 === null) ||
    (remoteKind === "delete" && remotePayloadSha256 !== null)
  ) {
    throw validationError("The remote conflict payload reference is inconsistent.");
  }
  return {
    conflictId: parseUuid(input.conflictId, "conflictId"),
    ...normalizeObjectIdentity(input),
    localVector: parseVector(input.localVector, "localVector"),
    remoteVector: parseVector(input.remoteVector, "remoteVector"),
    remoteOperationId: parseUuid(input.remoteOperationId, "remoteOperationId"),
    remoteKind,
    remotePayloadSha256,
    createdAt: parseTimestamp(input.createdAt, "createdAt"),
  };
}

function normalizeConflictResolution(
  input: ResolveSyncContentConflictInput,
): ResolveSyncContentConflictInput {
  return {
    conflictId: parseUuid(input.conflictId, "conflictId"),
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    resolution: parseOneOf(
      input.resolution,
      ["accept_local", "accept_remote", "merged", "dismissed"] as const,
      "resolution",
    ),
    resolutionOperationId:
      input.resolutionOperationId === null
        ? null
        : parseUuid(input.resolutionOperationId, "resolutionOperationId"),
    resolvedAt: parseTimestamp(input.resolvedAt, "resolvedAt"),
  };
}

function normalizeProjectionEnqueue(
  input: EnqueueSyncProjectionJobInput,
): EnqueueSyncProjectionJobInput {
  const projectionKind = parseOneOf(
    input.projectionKind,
    ["upsert", "delete"] as const,
    "projectionKind",
  );
  const versionId = input.versionId === null ? null : parseUuid(input.versionId, "versionId");
  if (
    (projectionKind === "upsert" && versionId === null) ||
    (projectionKind === "delete" && versionId !== null)
  ) {
    throw validationError("The projection kind and version reference are inconsistent.");
  }
  const createdAt = parseTimestamp(input.createdAt, "createdAt");
  const nextAttemptAt = parseTimestamp(input.nextAttemptAt, "nextAttemptAt");
  if (Date.parse(nextAttemptAt) < Date.parse(createdAt)) {
    throw validationError("The projection retry time cannot precede creation.");
  }
  return {
    jobId: parseUuid(input.jobId, "jobId"),
    projectId: parseUuid(input.projectId, "projectId"),
    accountId: parseUuid(input.accountId, "accountId"),
    objectType: parseObjectType(input.objectType),
    objectId: parseUuid(input.objectId, "objectId"),
    objectGeneration: parsePositiveInteger(input.objectGeneration, "objectGeneration"),
    projectionKind,
    versionId,
    sourceRevision: parsePositiveInteger(input.sourceRevision, "sourceRevision"),
    keyVersion: parseKeyVersion(input.keyVersion),
    consentRevision: parsePositiveInteger(input.consentRevision, "consentRevision"),
    deviceId: parseUuid(input.deviceId, "deviceId"),
    createdAt,
    nextAttemptAt,
  };
}

function normalizeProjectionClaim(input: ClaimSyncProjectionJobInput): ClaimSyncProjectionJobInput {
  const leasedAt = parseTimestamp(input.leasedAt, "leasedAt");
  const leaseExpiresAt = parseTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(leasedAt)) {
    throw validationError("The projection lease must expire after it starts.");
  }
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    leaseOwnerId: parseUuid(input.leaseOwnerId, "leaseOwnerId"),
    leaseToken: parseUuid(input.leaseToken, "leaseToken"),
    leasedAt,
    leaseExpiresAt,
  };
}

function normalizeProjectionBlockingStateRead(
  input: ReadSyncProjectionBlockingStateInput,
): ReadSyncProjectionBlockingStateInput {
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    observedAt: parseTimestamp(input.observedAt, "observedAt"),
  };
}

function normalizeProjectionComplete(
  input: CompleteSyncProjectionJobInput,
): CompleteSyncProjectionJobInput {
  return {
    jobId: parseUuid(input.jobId, "jobId"),
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    leaseOwnerId: parseUuid(input.leaseOwnerId, "leaseOwnerId"),
    leaseToken: parseUuid(input.leaseToken, "leaseToken"),
    operationId: parseUuid(input.operationId, "operationId"),
    completedAt: parseTimestamp(input.completedAt, "completedAt"),
  };
}

function normalizeProjectionRetry(input: RetrySyncProjectionJobInput): RetrySyncProjectionJobInput {
  const failedAt = parseTimestamp(input.failedAt, "failedAt");
  const nextAttemptAt = parseTimestamp(input.nextAttemptAt, "nextAttemptAt");
  if (Date.parse(nextAttemptAt) <= Date.parse(failedAt)) {
    throw validationError("The projection retry time must be after the failed attempt.");
  }
  return {
    jobId: parseUuid(input.jobId, "jobId"),
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    leaseOwnerId: parseUuid(input.leaseOwnerId, "leaseOwnerId"),
    leaseToken: parseUuid(input.leaseToken, "leaseToken"),
    failureCode: parseErrorCode(input.failureCode, "failureCode"),
    failedAt,
    nextAttemptAt,
  };
}

function normalizeProjectionFail(input: FailSyncProjectionJobInput): FailSyncProjectionJobInput {
  return {
    jobId: parseUuid(input.jobId, "jobId"),
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    leaseOwnerId: parseUuid(input.leaseOwnerId, "leaseOwnerId"),
    leaseToken: parseUuid(input.leaseToken, "leaseToken"),
    failureCode: parseErrorCode(input.failureCode, "failureCode"),
    failedAt: parseTimestamp(input.failedAt, "failedAt"),
  };
}

function normalizeProjectionSupersede(
  input: SupersedeSyncProjectionJobInput,
): SupersedeSyncProjectionJobInput {
  const jobId = parseUuid(input.jobId, "jobId");
  const supersededByJobId = parseUuid(input.supersededByJobId, "supersededByJobId");
  if (jobId === supersededByJobId) {
    throw validationError("A projection job cannot supersede itself.");
  }
  return {
    jobId,
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    supersededByJobId,
    supersededAt: parseTimestamp(input.supersededAt, "supersededAt"),
  };
}

function normalizeObjectIdentity(value: {
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
}): {
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
} {
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    objectType: parseObjectType(value.objectType),
    objectId: parseUuid(value.objectId, "objectId"),
    objectGeneration: parsePositiveInteger(value.objectGeneration, "objectGeneration"),
  };
}

function normalizeObjectReference(value: {
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
}): {
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
} {
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    objectType: parseObjectType(value.objectType),
    objectId: parseUuid(value.objectId, "objectId"),
  };
}

function rehydrateRegistration(row: RegistrationDbRow): ProjectSyncRegistration {
  const state = parseStoredOneOf(row.state, PROJECT_SYNC_REGISTRATION_STATES, "registration.state");
  const bootstrap = parseStoredBoolean(
    row.plaintext_bootstrap_completed,
    "registration.plaintextBootstrapCompleted",
  );
  const registration: ProjectSyncRegistration = {
    projectId: parseStoredUuid(row.project_id, "registration.projectId"),
    accountId: parseStoredUuid(row.account_id, "registration.accountId"),
    deviceId: parseStoredUuid(row.device_id, "registration.deviceId"),
    state,
    consentRevision: parseStoredPositiveInteger(
      row.consent_revision,
      "registration.consentRevision",
    ),
    keyVersion: parseStoredKeyVersion(row.key_version),
    revision: parseStoredPositiveInteger(row.revision, "registration.revision"),
    plaintextBootstrapCompleted: bootstrap,
    lastErrorCode:
      row.last_error_code === null
        ? null
        : parseStoredErrorCode(row.last_error_code, "registration.lastErrorCode"),
    createdAt: parseStoredTimestamp(row.created_at, "registration.createdAt"),
    updatedAt: parseStoredTimestamp(row.updated_at, "registration.updatedAt"),
    enabledAt:
      row.enabled_at === null
        ? null
        : parseStoredTimestamp(row.enabled_at, "registration.enabledAt"),
    pausedAt:
      row.paused_at === null ? null : parseStoredTimestamp(row.paused_at, "registration.pausedAt"),
  };
  validateStoredRegistration(registration);
  return registration;
}

function rehydrateMaterializedObject(row: MaterializedObjectDbRow): MaterializedSyncObject {
  const common = {
    projectId: parseStoredUuid(row.project_id, "materialized.projectId"),
    objectType: parseStoredObjectType(row.object_type),
    objectId: parseStoredUuid(row.object_id, "materialized.objectId"),
    objectGeneration: parseStoredPositiveInteger(
      row.object_generation,
      "materialized.objectGeneration",
    ),
    vector: parseStoredVector(row.vector_json, "materialized.vector"),
    sourceOperationId: parseStoredUuid(row.source_operation_id, "materialized.sourceOperationId"),
    sourceDeviceId: parseStoredUuid(row.source_device_id, "materialized.sourceDeviceId"),
    sourceDeviceSequence: parseStoredPositiveInteger(
      row.source_device_sequence,
      "materialized.sourceDeviceSequence",
    ),
    materializedAt: parseStoredTimestamp(row.materialized_at, "materialized.materializedAt"),
  };
  if (common.vector[common.sourceDeviceId] !== common.sourceDeviceSequence) {
    throw corruptionError("The materialized source sequence and vector diverge.");
  }
  if (row.state === "present" && row.version_id !== null && row.payload_sha256 !== null) {
    return {
      ...common,
      state: "present",
      versionId: parseStoredUuid(row.version_id, "materialized.versionId"),
      payloadSha256: parseStoredSha256(row.payload_sha256, "materialized.payloadSha256"),
    };
  }
  if (row.state === "deleted" && row.version_id === null && row.payload_sha256 === null) {
    return {
      ...common,
      state: "deleted",
      versionId: null,
      payloadSha256: null,
    };
  }
  throw corruptionError("The materialized object state is inconsistent.");
}

function rehydrateMaterializedCheckpoint(
  row: MaterializedCheckpointDbRow,
): SyncMaterializedCheckpoint {
  return {
    projectId: parseStoredUuid(row.project_id, "checkpoint.projectId"),
    signedRemoteCursor: parseStoredCursor(
      row.signed_remote_cursor,
      "checkpoint.signedRemoteCursor",
    ),
    downloadedCheckpointRevision: parseStoredPositiveInteger(
      row.downloaded_checkpoint_revision,
      "checkpoint.downloadedCheckpointRevision",
    ),
    revision: parseStoredPositiveInteger(row.revision, "checkpoint.revision"),
    updatedAt: parseStoredTimestamp(row.updated_at, "checkpoint.updatedAt"),
  };
}

function rehydrateConflict(row: ConflictDbRow): SyncContentConflict {
  const common = {
    conflictId: parseStoredUuid(row.conflict_id, "conflict.conflictId"),
    projectId: parseStoredUuid(row.project_id, "conflict.projectId"),
    objectType: parseStoredObjectType(row.object_type),
    objectId: parseStoredUuid(row.object_id, "conflict.objectId"),
    objectGeneration: parseStoredPositiveInteger(
      row.object_generation,
      "conflict.objectGeneration",
    ),
    localVector: parseStoredVector(row.local_vector_json, "conflict.localVector"),
    remoteVector: parseStoredVector(row.remote_vector_json, "conflict.remoteVector"),
    remoteOperationId: parseStoredUuid(row.remote_operation_id, "conflict.remoteOperationId"),
    revision: parseStoredPositiveInteger(row.revision, "conflict.revision"),
    createdAt: parseStoredTimestamp(row.created_at, "conflict.createdAt"),
    updatedAt: parseStoredTimestamp(row.updated_at, "conflict.updatedAt"),
  };
  const remoteKind = parseStoredOneOf(
    row.remote_kind,
    ["upsert", "delete"] as const,
    "conflict.remoteKind",
  );
  const remotePayloadSha256 =
    row.remote_payload_sha256 === null
      ? null
      : parseStoredSha256(row.remote_payload_sha256, "conflict.remotePayloadSha256");
  if (
    (remoteKind === "upsert" && remotePayloadSha256 === null) ||
    (remoteKind === "delete" && remotePayloadSha256 !== null)
  ) {
    throw corruptionError("The conflict payload reference is inconsistent.");
  }
  if (
    row.status === "unresolved" &&
    row.resolution === null &&
    row.resolution_operation_id === null &&
    row.resolved_at === null
  ) {
    if (remoteKind === "upsert") {
      return {
        ...common,
        remoteKind,
        remotePayloadSha256: remotePayloadSha256 ?? missingStoredConflictPayloadReference(),
        status: "unresolved",
        resolution: null,
        resolutionOperationId: null,
        resolvedAt: null,
      };
    }
    return {
      ...common,
      remoteKind,
      remotePayloadSha256: null,
      status: "unresolved",
      resolution: null,
      resolutionOperationId: null,
      resolvedAt: null,
    };
  }
  if (row.status === "resolved" && row.resolution !== null && row.resolved_at !== null) {
    return {
      ...common,
      remoteKind,
      remotePayloadSha256,
      status: "resolved",
      resolution: parseStoredOneOf(
        row.resolution,
        ["accept_local", "accept_remote", "merged", "dismissed"] as const,
        "conflict.resolution",
      ),
      resolutionOperationId:
        row.resolution_operation_id === null
          ? null
          : parseStoredUuid(row.resolution_operation_id, "conflict.resolutionOperationId"),
      resolvedAt: parseStoredTimestamp(row.resolved_at, "conflict.resolvedAt"),
    };
  }
  throw corruptionError("The sync content conflict state is inconsistent.");
}

function rehydrateProjectionJob(row: ProjectionJobDbRow): SyncProjectionJob {
  const status = parseStoredOneOf(
    row.status,
    ["queued", "leased", "retry_wait", "completed", "failed", "superseded"] as const,
    "projection.status",
  );
  const projectionKind = parseStoredOneOf(
    row.projection_kind,
    ["upsert", "delete"] as const,
    "projection.projectionKind",
  );
  const versionId =
    row.version_id === null ? null : parseStoredUuid(row.version_id, "projection.versionId");
  if (
    (projectionKind === "upsert" && versionId === null) ||
    (projectionKind === "delete" && versionId !== null)
  ) {
    throw corruptionError("The projection kind and version reference diverge.");
  }
  const job: SyncProjectionJob = {
    jobId: parseStoredUuid(row.job_id, "projection.jobId"),
    projectId: parseStoredUuid(row.project_id, "projection.projectId"),
    accountId: parseStoredUuid(row.account_id, "projection.accountId"),
    objectType: parseStoredObjectType(row.object_type),
    objectId: parseStoredUuid(row.object_id, "projection.objectId"),
    objectGeneration: parseStoredPositiveInteger(
      row.object_generation,
      "projection.objectGeneration",
    ),
    projectionKind,
    versionId,
    sourceRevision: parseStoredPositiveInteger(row.source_revision, "projection.sourceRevision"),
    keyVersion: parseStoredKeyVersion(row.key_version),
    consentRevision: parseStoredPositiveInteger(row.consent_revision, "projection.consentRevision"),
    deviceId: parseStoredUuid(row.device_id, "projection.deviceId"),
    status,
    attempt: parseStoredNonNegativeInteger(row.attempt, "projection.attempt"),
    revision: parseStoredPositiveInteger(row.revision, "projection.revision"),
    nextAttemptAt:
      row.next_attempt_at === null
        ? null
        : parseStoredTimestamp(row.next_attempt_at, "projection.nextAttemptAt"),
    leaseOwnerId:
      row.lease_owner_id === null
        ? null
        : parseStoredUuid(row.lease_owner_id, "projection.leaseOwnerId"),
    leaseToken:
      row.lease_token === null ? null : parseStoredUuid(row.lease_token, "projection.leaseToken"),
    leaseExpiresAt:
      row.lease_expires_at === null
        ? null
        : parseStoredTimestamp(row.lease_expires_at, "projection.leaseExpiresAt"),
    operationId:
      row.operation_id === null
        ? null
        : parseStoredUuid(row.operation_id, "projection.operationId"),
    failureCode:
      row.failure_code === null
        ? null
        : parseStoredErrorCode(row.failure_code, "projection.failureCode"),
    supersededByJobId:
      row.superseded_by_job_id === null
        ? null
        : parseStoredUuid(row.superseded_by_job_id, "projection.supersededByJobId"),
    createdAt: parseStoredTimestamp(row.created_at, "projection.createdAt"),
    updatedAt: parseStoredTimestamp(row.updated_at, "projection.updatedAt"),
    terminalAt:
      row.terminal_at === null
        ? null
        : parseStoredTimestamp(row.terminal_at, "projection.terminalAt"),
  };
  validateStoredProjectionJob(job);
  return job;
}

function unresolvedConflict(input: RegisterSyncContentConflictInput): SyncContentConflict {
  const common = {
    conflictId: input.conflictId,
    projectId: input.projectId,
    objectType: input.objectType,
    objectId: input.objectId,
    objectGeneration: input.objectGeneration,
    localVector: input.localVector,
    remoteVector: input.remoteVector,
    remoteOperationId: input.remoteOperationId,
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    status: "unresolved" as const,
    resolution: null,
    resolutionOperationId: null,
    resolvedAt: null,
  };
  return input.remoteKind === "upsert"
    ? {
        ...common,
        remoteKind: "upsert",
        remotePayloadSha256: input.remotePayloadSha256 ?? missingConflictPayloadReference(),
      }
    : { ...common, remoteKind: "delete", remotePayloadSha256: null };
}

function queuedProjectionJob(input: EnqueueSyncProjectionJobInput): SyncProjectionJob {
  return {
    jobId: input.jobId,
    projectId: input.projectId,
    accountId: input.accountId,
    objectType: input.objectType,
    objectId: input.objectId,
    objectGeneration: input.objectGeneration,
    projectionKind: input.projectionKind,
    versionId: input.versionId,
    sourceRevision: input.sourceRevision,
    keyVersion: input.keyVersion,
    consentRevision: input.consentRevision,
    deviceId: input.deviceId,
    status: "queued",
    attempt: 0,
    revision: 1,
    nextAttemptAt: input.nextAttemptAt,
    leaseOwnerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    operationId: null,
    failureCode: null,
    supersededByJobId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    terminalAt: null,
  };
}

function registrationTarget(
  existing: ProjectSyncRegistration,
  input: TransitionProjectSyncRegistrationInput,
): ProjectSyncRegistration {
  const revision = incrementRevision(input.expectedRevision);
  switch (input.target.state) {
    case "bootstrap_required":
      return {
        ...existing,
        state: "bootstrap_required",
        revision,
        plaintextBootstrapCompleted: false,
        lastErrorCode: null,
        updatedAt: input.transitionedAt,
        enabledAt: null,
        pausedAt: null,
      };
    case "enabled":
      return {
        ...existing,
        state: "enabled",
        revision,
        plaintextBootstrapCompleted: true,
        lastErrorCode: null,
        updatedAt: input.transitionedAt,
        enabledAt: input.transitionedAt,
        pausedAt: null,
      };
    case "paused":
      return {
        ...existing,
        state: "paused",
        revision,
        lastErrorCode: null,
        updatedAt: input.transitionedAt,
        pausedAt: input.transitionedAt,
      };
    case "error":
      return {
        ...existing,
        state: "error",
        revision,
        lastErrorCode: input.target.errorCode,
        updatedAt: input.transitionedAt,
        pausedAt: null,
      };
  }
}

function registrationMatchesBegin(
  registration: ProjectSyncRegistration,
  input: BeginProjectSyncEnableInput,
): boolean {
  return (
    registration.accountId === input.accountId &&
    registration.deviceId === input.deviceId &&
    registration.state === "enabling" &&
    registration.consentRevision === input.consentRevision &&
    registration.keyVersion === input.keyVersion &&
    !registration.plaintextBootstrapCompleted &&
    registration.lastErrorCode === null &&
    registration.updatedAt === input.begunAt &&
    registration.enabledAt === null &&
    registration.pausedAt === null
  );
}

function requireRegistrationIdentity(
  existing: ProjectSyncRegistration,
  input: TransitionProjectSyncRegistrationInput,
): void {
  if (
    existing.accountId !== input.expectedAccountId ||
    existing.deviceId !== input.expectedDeviceId ||
    existing.consentRevision !== input.expectedConsentRevision ||
    existing.keyVersion !== input.expectedKeyVersion
  ) {
    throw concurrencyError("The project sync registration identity or authority changed.");
  }
}

function isAllowedRegistrationTransition(
  from: ProjectSyncRegistrationState,
  to: ProjectSyncRegistrationTarget["state"],
): boolean {
  const allowed: Readonly<
    Record<ProjectSyncRegistrationState, readonly ProjectSyncRegistrationTarget["state"][]>
  > = {
    disabled: [],
    enabling: ["bootstrap_required", "enabled", "paused", "error"],
    bootstrap_required: ["enabled", "paused", "error"],
    enabled: ["bootstrap_required", "paused", "error"],
    paused: ["error"],
    error: ["paused"],
  };
  return allowed[from].includes(to);
}

function requireProjectionLease(
  job: SyncProjectionJob,
  input: { readonly leaseOwnerId: string; readonly leaseToken: string },
): void {
  if (
    job.status !== "leased" ||
    job.leaseOwnerId !== input.leaseOwnerId ||
    job.leaseToken !== input.leaseToken
  ) {
    throw concurrencyError("The projection job lease changed.");
  }
}

function requireFirstProjectionJob(jobs: readonly SyncProjectionJob[]): SyncProjectionJob {
  const job = jobs[0];
  if (job === undefined) {
    throw corruptionError("The projection blocking state has no pending job.");
  }
  return job;
}

function requireProjectionFailureCode(job: SyncProjectionJob): string {
  if (job.failureCode === null) {
    throw corruptionError("A failed projection job has no failure code.");
  }
  return job.failureCode;
}

function requireProjectionLeaseExpiry(job: SyncProjectionJob): string {
  if (job.leaseExpiresAt === null) {
    throw corruptionError("A leased projection job has no expiry.");
  }
  return job.leaseExpiresAt;
}

function sameRegistration(left: ProjectSyncRegistration, right: ProjectSyncRegistration): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameMaterializedObject(
  left: MaterializedSyncObject,
  right: MaterializedSyncObject,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameConflict(left: SyncContentConflict, right: SyncContentConflict): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProjectionJob(left: SyncProjectionJob, right: SyncProjectionJob): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateStoredRegistration(registration: ProjectSyncRegistration): void {
  const valid =
    (registration.state === "disabled" &&
      !registration.plaintextBootstrapCompleted &&
      registration.lastErrorCode === null &&
      registration.enabledAt === null &&
      registration.pausedAt === null) ||
    ((registration.state === "enabling" || registration.state === "bootstrap_required") &&
      !registration.plaintextBootstrapCompleted &&
      registration.lastErrorCode === null &&
      registration.enabledAt === null &&
      registration.pausedAt === null) ||
    (registration.state === "enabled" &&
      registration.plaintextBootstrapCompleted &&
      registration.lastErrorCode === null &&
      registration.enabledAt !== null &&
      registration.pausedAt === null) ||
    (registration.state === "paused" &&
      registration.lastErrorCode === null &&
      registration.pausedAt !== null &&
      ((registration.plaintextBootstrapCompleted && registration.enabledAt !== null) ||
        (!registration.plaintextBootstrapCompleted && registration.enabledAt === null))) ||
    (registration.state === "error" &&
      registration.lastErrorCode !== null &&
      registration.pausedAt === null &&
      ((registration.plaintextBootstrapCompleted && registration.enabledAt !== null) ||
        (!registration.plaintextBootstrapCompleted && registration.enabledAt === null)));
  if (
    !valid ||
    Date.parse(registration.updatedAt) < Date.parse(registration.createdAt) ||
    (registration.enabledAt !== null &&
      (Date.parse(registration.enabledAt) < Date.parse(registration.createdAt) ||
        Date.parse(registration.enabledAt) > Date.parse(registration.updatedAt))) ||
    (registration.pausedAt !== null &&
      (Date.parse(registration.pausedAt) < Date.parse(registration.createdAt) ||
        Date.parse(registration.pausedAt) > Date.parse(registration.updatedAt)))
  ) {
    throw corruptionError("The project sync registration state is inconsistent.");
  }
}

function validateStoredProjectionJob(job: SyncProjectionJob): void {
  const noLease =
    job.leaseOwnerId === null && job.leaseToken === null && job.leaseExpiresAt === null;
  const valid =
    (job.status === "queued" &&
      job.attempt === 0 &&
      job.nextAttemptAt !== null &&
      noLease &&
      job.operationId === null &&
      job.failureCode === null &&
      job.supersededByJobId === null &&
      job.terminalAt === null) ||
    (job.status === "leased" &&
      job.attempt >= 1 &&
      job.nextAttemptAt === null &&
      job.leaseOwnerId !== null &&
      job.leaseToken !== null &&
      job.leaseExpiresAt !== null &&
      job.operationId === null &&
      job.failureCode === null &&
      job.supersededByJobId === null &&
      job.terminalAt === null) ||
    (job.status === "retry_wait" &&
      job.attempt >= 1 &&
      job.nextAttemptAt !== null &&
      noLease &&
      job.operationId === null &&
      job.failureCode !== null &&
      job.supersededByJobId === null &&
      job.terminalAt === null) ||
    (job.status === "completed" &&
      job.attempt >= 1 &&
      job.nextAttemptAt === null &&
      noLease &&
      job.operationId !== null &&
      job.failureCode === null &&
      job.supersededByJobId === null &&
      job.terminalAt !== null) ||
    (job.status === "failed" &&
      job.attempt >= 1 &&
      job.nextAttemptAt === null &&
      noLease &&
      job.operationId === null &&
      job.failureCode !== null &&
      job.supersededByJobId === null &&
      job.terminalAt !== null) ||
    (job.status === "superseded" &&
      job.nextAttemptAt === null &&
      noLease &&
      job.operationId === null &&
      job.failureCode === null &&
      job.supersededByJobId !== null &&
      job.terminalAt !== null);
  if (!valid || job.attempt > 100) {
    throw corruptionError("The projection job state is inconsistent.");
  }
}

function serializeVector(vector: VersionVector): string {
  return JSON.stringify(vector);
}

function missingConflictPayloadReference(): never {
  throw validationError("An upsert conflict requires a remote payload hash.");
}

function missingStoredConflictPayloadReference(): never {
  throw corruptionError("A stored upsert conflict is missing its payload hash.");
}

function parseVector(value: VersionVector, field: string): VersionVector {
  const unknownValue: unknown = value;
  if (typeof unknownValue !== "object" || unknownValue === null || Array.isArray(unknownValue)) {
    throw validationError(`${field} must be a version-vector object.`);
  }
  try {
    return normalizeVersionVector(unknownValue as VersionVector);
  } catch {
    throw validationError(`${field} is not a valid version vector.`);
  }
}

function parseStoredVector(value: string, field: string): VersionVector {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw corruptionError(`${field} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corruptionError(`${field} is not a version-vector object.`);
  }
  try {
    return normalizeVersionVector(parsed as VersionVector);
  } catch {
    throw corruptionError(`${field} is not a valid version vector.`);
  }
}

function parseUuid(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw validationError(`${field} must be a UUIDv7.`);
  }
  return value.toLowerCase();
}

function parseStoredUuid(value: string, field: string): string {
  try {
    return parseUuid(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored UUIDv7.`);
  }
}

function parseIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw validationError(`${field} is not a valid sync identifier.`);
  }
  return value;
}

function parseObjectType(value: SyncObjectType): SyncObjectType {
  if (!SYNC_OBJECT_TYPES.includes(value)) {
    throw validationError("objectType is not supported.");
  }
  return value;
}

function parseStoredObjectType(value: string): SyncObjectType {
  if (!SYNC_OBJECT_TYPES.includes(value as SyncObjectType)) {
    throw corruptionError("The stored object type is not supported.");
  }
  return value as SyncObjectType;
}

function parsePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function parseBoundedLimit(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw validationError(
      `${field} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}

function parseStoredPositiveInteger(value: number, field: string): number {
  try {
    return parsePositiveInteger(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored positive integer.`);
  }
}

function parseStoredNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw corruptionError(`${field} is not a stored non-negative integer.`);
  }
  return value;
}

function parseKeyVersion(value: number): number {
  const parsed = parsePositiveInteger(value, "keyVersion");
  if (parsed > 2_147_483_647) {
    throw validationError("keyVersion exceeds the supported range.");
  }
  return parsed;
}

function parseStoredKeyVersion(value: number): number {
  try {
    return parseKeyVersion(value);
  } catch {
    throw corruptionError("The stored key version is invalid.");
  }
}

function parseNullableRevision(value: number | null, field: string): number | null {
  return value === null ? null : parsePositiveInteger(value, field);
}

function incrementRevision(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw concurrencyError("The local revision is exhausted.");
  }
  return value + 1;
}

function parseTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw validationError(`${field} must be an ISO 8601 UTC timestamp.`);
  }
  return value;
}

function parseStoredTimestamp(value: string, field: string): string {
  try {
    return parseTimestamp(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored UTC timestamp.`);
  }
}

function parseSha256(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw validationError(`${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function parseStoredSha256(value: string, field: string): string {
  try {
    return parseSha256(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored SHA-256 digest.`);
  }
}

function parseCursor(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw validationError(`${field} is not a valid signed remote cursor.`);
  }
  return value;
}

function parseStoredCursor(value: string, field: string): string {
  try {
    return parseCursor(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored signed remote cursor.`);
  }
}

function parseErrorCode(value: string, field: string): string {
  const code = parseIdentifier(value, field);
  if (code.length > 120 || !/^[A-Z0-9_.:-]+$/u.test(code)) {
    throw validationError(`${field} must be an uppercase machine-readable code.`);
  }
  return code;
}

function parseStoredErrorCode(value: string, field: string): string {
  try {
    return parseErrorCode(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored error code.`);
  }
}

function parseOneOf<const Value extends string>(
  value: string,
  allowed: readonly Value[],
  field: string,
): Value {
  if (!allowed.includes(value as Value)) {
    throw validationError(`${field} is not supported.`);
  }
  return value as Value;
}

function parseStoredOneOf<const Value extends string>(
  value: string,
  allowed: readonly Value[],
  field: string,
): Value {
  if (!allowed.includes(value as Value)) {
    throw corruptionError(`${field} is not a supported stored value.`);
  }
  return value as Value;
}

function parseStoredBoolean(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw corruptionError(`${field} is not a stored boolean.`);
  }
  return value === 1;
}

function requireAtMostOne<Row>(rows: readonly Row[], duplicateMessage: string): Row | null {
  if (rows.length > 1) {
    throw corruptionError(duplicateMessage);
  }
  return rows[0] ?? null;
}

function requireSingleMutation(rowsAffected: number, message: string): void {
  if (rowsAffected !== 1) {
    throw concurrencyError(message);
  }
}

async function attempt<Value>(
  operation: string,
  run: () => Promise<Value>,
): Promise<Result<Value, AppError>> {
  try {
    return ok(await run());
  } catch (cause: unknown) {
    if (cause instanceof AppError) {
      return err(cause);
    }
    return err(
      new AppError({
        code: "REPOSITORY_ERROR",
        message: "The local sync authority store could not complete the operation.",
        retryable: true,
        actions: ["RETRY", "OPEN_SETTINGS", "CONTACT_SUPPORT"],
        details: {
          operation,
          causeType: cause instanceof Error ? cause.name : "UnknownError",
        },
      }),
    );
  }
}

function validationError(message: string): AppError {
  return new AppError({ code: "VALIDATION_FAILED", message });
}

function concurrencyError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS"],
  });
}

function notFoundError(message: string): AppError {
  return new AppError({
    code: "PROJECT_NOT_FOUND",
    message,
    actions: ["OPEN_SETTINGS"],
  });
}

function corruptionError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    details: { operation: "SYNC_AUTHORITY_LOCAL_RECORD_INVALID" },
  });
}
