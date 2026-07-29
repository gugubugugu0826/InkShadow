import {
  CloudProjectKeyPublishRequestSchema,
  CloudProjectKeyPublicationReceiptSchema,
  CloudProjectKeySetSchema,
  DeviceProjectKeyEnvelopeContractSchema,
  IsoUtcTimestampSchema,
  ProjectKeyVersionContractSchema,
  RecoveryProjectKeyEnvelopeContractSchema,
  UuidV7Schema,
  hashCloudProjectKeyPublication,
  type CloudProjectKeyPublicationReceipt,
  type CloudProjectKeySet,
  type CloudProjectKeyPublishRequest,
  type DeviceProjectKeyEnvelopeContract,
  type ProjectKeyVersionContract,
  type RecoveryProjectKeyEnvelopeContract,
} from "@inkshadow/contracts";
import { AppError, err, ok, type Result } from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export type DevicePublicKeyOrigin = "local_os_credential" | "remote_registered";
export type DevicePublicKeyState = "trusted" | "revoked" | "credential_missing";

export interface DevicePublicKeyRecord {
  readonly schemaVersion: 1;
  readonly deviceId: string;
  readonly accountId: string | null;
  readonly algorithm: "DHKEM-P256-HKDF-SHA256";
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly displayName: string;
  readonly keyOrigin: DevicePublicKeyOrigin;
  readonly state: DevicePublicKeyState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface PendingProjectKeySetup {
  readonly version: ProjectKeyVersionContract;
  readonly deviceEnvelope: DeviceProjectKeyEnvelopeContract;
  readonly recoveryEnvelope: RecoveryProjectKeyEnvelopeContract;
}

export interface PendingProjectKeyRotation {
  readonly expectedCurrentKeyVersion: number;
  readonly version: ProjectKeyVersionContract;
  readonly deviceEnvelopes: readonly DeviceProjectKeyEnvelopeContract[];
  readonly recoveryEnvelope: RecoveryProjectKeyEnvelopeContract;
}

export interface SaveCloudProjectKeySetInput {
  readonly keySet: CloudProjectKeySet;
  readonly makeCurrent: boolean;
  readonly completedPublicationIdempotencyKey?: string;
  readonly localDeviceEnvelope?: DeviceProjectKeyEnvelopeContract;
}

export interface CloudProjectKeyCheckpoint {
  readonly projectId: string;
  readonly currentKeyVersion: number;
  readonly serverRevision: number;
  readonly updatedAt: string;
}

export interface CloudProjectKeyPublication {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly idempotencyKey: string;
  readonly expectedServerRevision: number | null;
  readonly request: CloudProjectKeyPublishRequest;
  readonly state: "pending" | "conflicted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastErrorCode: string | null;
}

export interface BeginCloudProjectKeyPublicationInput {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly idempotencyKey: string;
  readonly request: CloudProjectKeyPublishRequest;
  readonly createdAt: string;
}

export interface MarkCloudProjectKeyPublicationConflictInput {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly idempotencyKey: string;
  readonly errorCode: string;
  readonly updatedAt: string;
}

export interface ResolveCloudProjectKeyPublicationInput {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly idempotencyKey: string;
  readonly receipt: CloudProjectKeyPublicationReceipt;
}

export interface RebaseCloudProjectKeyPublicationInput {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly idempotencyKey: string;
  readonly nextIdempotencyKey: string;
  readonly observedCurrentPublication: CloudProjectKeyPublicationReceipt | null;
  readonly updatedAt: string;
}

export interface ProjectKeyBundle {
  readonly version: ProjectKeyVersionContract;
  readonly deviceEnvelope: DeviceProjectKeyEnvelopeContract;
  readonly recoveryEnvelope: RecoveryProjectKeyEnvelopeContract;
}

export type TeamProjectKeyReceiptState =
  "active" | "superseded" | "authority_unavailable" | "credential_missing";

export interface TeamProjectKeyReceiptMetadata {
  readonly schemaVersion: 1;
  readonly receiptKind: "team_managed_device_envelope";
  readonly teamId: string;
  readonly projectId: string;
  readonly keyVersion: number;
  readonly accountId: string;
  readonly deviceId: string;
  readonly envelopeId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly senderDeviceId: string;
  readonly senderPublicKeyFingerprint: string;
  readonly recipientPublicKeyFingerprint: string;
  readonly projectKeyFingerprint: string;
  readonly nativeStorageRef: string;
  readonly nativeReceiptFingerprint: string;
  readonly currentServerRevision: number;
  readonly currentKeyUpdatedAt: string;
  readonly envelopeCreatedAt: string;
  readonly state: TeamProjectKeyReceiptState;
  readonly receivedAt: string;
  readonly lastVerifiedAt: string;
  readonly stateUpdatedAt: string;
}

export type SaveTeamProjectKeyReceiptInput = Omit<
  TeamProjectKeyReceiptMetadata,
  "state" | "receivedAt" | "lastVerifiedAt" | "stateUpdatedAt"
> &
  Readonly<{ receivedAt: string }>;

export interface TeamProjectKeyReceiptScope {
  readonly teamId?: string;
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly keyVersion?: number;
}

export interface MarkTeamProjectKeyReceiptStateInput {
  readonly nativeStorageRef: string;
  readonly nativeReceiptFingerprint: string;
  readonly expectedState: TeamProjectKeyReceiptState;
  readonly nextState: Extract<
    TeamProjectKeyReceiptState,
    "authority_unavailable" | "credential_missing"
  >;
  readonly updatedAt: string;
}

export interface ConfirmRecoveryInput {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly recoveryId: string;
  readonly expectedRevision: number;
  readonly confirmedAt: string;
}

export interface AbandonPendingProjectKeySetupInput {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly expectedRevision: number;
}

export interface ProjectKeyStoreHealth {
  readonly deviceKeysByState: Readonly<Record<DevicePublicKeyState, number>>;
  readonly keyVersionsByState: Readonly<
    Record<"pending_confirmation" | "active" | "retiring" | "retired", number>
  >;
  readonly currentDeviceEnvelopeCount: number;
  readonly pendingRecoveryEnvelopeCount: number;
  readonly confirmedRecoveryEnvelopeCount: number;
}

interface StatusCountRow {
  readonly status: string;
  readonly count: number;
}

interface CountRow {
  readonly count: number;
}

interface DevicePublicKeyDbRow {
  readonly device_id: string;
  readonly account_id: string | null;
  readonly schema_version: number;
  readonly algorithm: string;
  readonly public_key: string;
  readonly public_key_fingerprint: string;
  readonly display_name: string;
  readonly key_origin: string;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at: string | null;
}

interface ProjectKeyVersionDbRow {
  readonly project_id: string;
  readonly key_version: number;
  readonly schema_version: number;
  readonly algorithm: string;
  readonly state: string;
  readonly revision: number;
  readonly created_at: string;
  readonly retired_at: string | null;
}

interface DeviceEnvelopeDbRow {
  readonly envelope_id: string;
  readonly project_id: string;
  readonly key_version: number;
  readonly schema_version: number;
  readonly algorithm: string;
  readonly sender_device_id: string;
  readonly sender_public_key: string;
  readonly sender_public_key_fingerprint: string;
  readonly recipient_device_id: string;
  readonly recipient_public_key: string;
  readonly recipient_public_key_fingerprint: string;
  readonly encapsulated_key: string;
  readonly ciphertext: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

interface RecoveryEnvelopeDbRow {
  readonly recovery_id: string;
  readonly project_id: string;
  readonly key_version: number;
  readonly schema_version: number;
  readonly algorithm: string;
  readonly kdf_algorithm: string;
  readonly kdf_version: number;
  readonly memory_kib: number;
  readonly time_cost: number;
  readonly parallelism: number;
  readonly output_bytes: number;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly verifier: string;
  readonly status: string;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly revoked_at: string | null;
}

interface CloudProjectKeyCheckpointDbRow {
  readonly project_id: string;
  readonly current_key_version: number;
  readonly server_revision: number;
  readonly updated_at: string;
}

interface CloudProjectKeyPublicationDbRow {
  readonly project_id: string;
  readonly key_version: number;
  readonly idempotency_key: string;
  readonly expected_server_revision: number | null;
  readonly request_json: string;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_error_code: string | null;
}

interface TeamProjectKeyReceiptDbRow {
  readonly native_storage_ref: string;
  readonly schema_version: number;
  readonly receipt_kind: string;
  readonly team_id: string;
  readonly project_id: string;
  readonly key_version: number;
  readonly account_id: string;
  readonly device_id: string;
  readonly envelope_id: string;
  readonly membership_id: string;
  readonly membership_revision: number;
  readonly assignment_id: string;
  readonly assignment_revision: number;
  readonly sender_device_id: string;
  readonly sender_public_key_fingerprint: string;
  readonly recipient_public_key_fingerprint: string;
  readonly project_key_fingerprint: string;
  readonly native_receipt_fingerprint: string;
  readonly current_server_revision: number;
  readonly current_key_updated_at: string;
  readonly envelope_created_at: string;
  readonly state: string;
  readonly received_at: string;
  readonly last_verified_at: string;
  readonly state_updated_at: string;
}

export class ProjectKeySqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async health(): Promise<Result<ProjectKeyStoreHealth, AppError>> {
    return attempt("PROJECT_KEY_HEALTH_FAILED", async () => {
      const [deviceRows, versionRows, envelopeRows, pendingRows, confirmedRows] = await Promise.all(
        [
          this.executor.select<StatusCountRow>(
            `SELECT state AS status, count(*) AS count
             FROM device_public_key_records
             GROUP BY state`,
          ),
          this.executor.select<StatusCountRow>(
            `SELECT state AS status, count(*) AS count
             FROM project_key_versions
             GROUP BY state`,
          ),
          this.executor.select<CountRow>(
            `SELECT count(*) AS count
             FROM project_device_key_envelopes
             WHERE revoked_at IS NULL`,
          ),
          this.executor.select<CountRow>(
            `SELECT count(*) AS count
             FROM project_recovery_key_envelopes
             WHERE status = 'pending_confirmation'`,
          ),
          this.executor.select<CountRow>(
            `SELECT count(*) AS count
             FROM project_recovery_key_envelopes
             WHERE status = 'confirmed'`,
          ),
        ],
      );
      return {
        deviceKeysByState: buildStatusCounts(
          ["trusted", "revoked", "credential_missing"],
          deviceRows,
        ),
        keyVersionsByState: buildStatusCounts(
          ["pending_confirmation", "active", "retiring", "retired"],
          versionRows,
        ),
        currentDeviceEnvelopeCount: requireCount(envelopeRows[0]?.count),
        pendingRecoveryEnvelopeCount: requireCount(pendingRows[0]?.count),
        confirmedRecoveryEnvelopeCount: requireCount(confirmedRows[0]?.count),
      };
    });
  }

  public async saveDevicePublicKey(
    recordValue: DevicePublicKeyRecord,
  ): Promise<Result<void, AppError>> {
    return attempt("DEVICE_PUBLIC_KEY_SAVE_FAILED", async () => {
      const record = normalizeDevicePublicKey(recordValue);
      await this.executor.transaction(async (transaction) => {
        const existingRow = await findDevicePublicKeyRow(transaction, record.deviceId);
        if (existingRow !== null) {
          const existing = rehydrateDevicePublicKey(existingRow);
          validateDevicePublicKeyTransition(existing, record);
          if (JSON.stringify(existing) === JSON.stringify(record)) {
            return;
          }
        }

        await transaction.execute(
          `INSERT INTO device_public_key_records (
           device_id, account_id, schema_version, algorithm, public_key,
             public_key_fingerprint, display_name, key_origin, state,
             created_at, updated_at, revoked_at
           ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             account_id = excluded.account_id,
             display_name = excluded.display_name,
             state = excluded.state,
             updated_at = excluded.updated_at,
             revoked_at = excluded.revoked_at`,
          [
            record.deviceId,
            record.accountId,
            record.algorithm,
            record.publicKey,
            record.publicKeyFingerprint,
            record.displayName,
            record.keyOrigin,
            record.state,
            record.createdAt,
            record.updatedAt,
            record.revokedAt,
          ],
        );
      });
    });
  }

  public async findDevicePublicKey(
    deviceIdValue: string,
  ): Promise<Result<DevicePublicKeyRecord | null, AppError>> {
    return attempt("DEVICE_PUBLIC_KEY_READ_FAILED", async () => {
      const deviceId = parseUuid(deviceIdValue, "deviceId");
      const row = await findDevicePublicKeyRow(this.executor, deviceId);
      return row === null ? null : rehydrateDevicePublicKey(row);
    });
  }

  public async listLocalDevicePublicKeys(): Promise<
    Result<readonly DevicePublicKeyRecord[], AppError>
  > {
    return attempt("DEVICE_PUBLIC_KEY_LIST_FAILED", async () => {
      const rows = await this.executor.select<DevicePublicKeyDbRow>(
        `SELECT *
         FROM device_public_key_records
         WHERE key_origin = 'local_os_credential'
         ORDER BY created_at DESC, device_id DESC`,
      );
      return rows.map(rehydrateDevicePublicKey);
    });
  }

  public async beginProjectKeySetup(
    setupValue: PendingProjectKeySetup,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    return attempt("PROJECT_KEY_SETUP_SAVE_FAILED", async () => {
      const setup = normalizePendingSetup(setupValue);
      return this.executor.transaction(async (transaction) => {
        await verifyEnvelopeDevices(transaction, setup.deviceEnvelope);
        const existingVersion = await findProjectKeyVersionRow(
          transaction,
          setup.version.projectId,
          setup.version.keyVersion,
        );
        const existingDeviceEnvelope = await findDeviceEnvelopeRow(
          transaction,
          setup.deviceEnvelope.envelopeId,
        );
        const existingRecoveryEnvelope = await findRecoveryEnvelopeRow(
          transaction,
          setup.recoveryEnvelope.recoveryId,
        );

        if (
          existingVersion !== null ||
          existingDeviceEnvelope !== null ||
          existingRecoveryEnvelope !== null
        ) {
          if (
            existingVersion !== null &&
            existingDeviceEnvelope !== null &&
            existingRecoveryEnvelope !== null
          ) {
            const existing = {
              version: rehydrateProjectKeyVersion(existingVersion),
              deviceEnvelope: rehydrateDeviceEnvelope(existingDeviceEnvelope),
              recoveryEnvelope: rehydrateRecoveryEnvelope(existingRecoveryEnvelope),
            };
            if (JSON.stringify(existing) === JSON.stringify(setup)) {
              return existing;
            }
          }
          throw concurrencyError("The project key setup identifiers already contain other data.");
        }

        await insertProjectKeyVersion(transaction, setup.version);
        await insertDeviceEnvelope(transaction, setup.deviceEnvelope);
        await insertRecoveryEnvelope(transaction, setup.recoveryEnvelope, "pending_confirmation");
        return setup;
      });
    });
  }

  public async beginProjectKeyRotation(
    rotationValue: PendingProjectKeyRotation,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    return attempt("PROJECT_KEY_ROTATION_SAVE_FAILED", async () => {
      const rotation = normalizePendingRotation(rotationValue);
      return this.executor.transaction(async (transaction) => {
        const activeRows = await transaction.select<ProjectKeyVersionDbRow>(
          `SELECT *
           FROM project_key_versions
           WHERE project_id = ? AND state = 'active'
           ORDER BY key_version DESC`,
          [rotation.version.projectId],
        );
        if (
          activeRows.length !== 1 ||
          activeRows[0]?.key_version !== rotation.expectedCurrentKeyVersion ||
          rotation.version.keyVersion !== rotation.expectedCurrentKeyVersion + 1
        ) {
          throw concurrencyError("The current project key changed before rotation preparation.");
        }
        for (const envelope of rotation.deviceEnvelopes) {
          await verifyEnvelopeDevices(transaction, envelope);
        }
        const existingVersion = await findProjectKeyVersionRow(
          transaction,
          rotation.version.projectId,
          rotation.version.keyVersion,
        );
        if (existingVersion !== null) {
          const existing = await loadBundleWithinTransaction(
            transaction,
            rotation.version.projectId,
            rotation.version.keyVersion,
            rotation.deviceEnvelopes[0]?.recipientDeviceId ?? null,
          );
          if (await samePendingRotation(transaction, rotation, existing)) {
            return existing;
          }
          throw concurrencyError("The pending project-key rotation already contains other data.");
        }
        await insertProjectKeyVersion(transaction, rotation.version);
        for (const envelope of rotation.deviceEnvelopes) {
          await insertDeviceEnvelope(transaction, envelope);
        }
        await insertRecoveryEnvelope(
          transaction,
          rotation.recoveryEnvelope,
          "pending_confirmation",
        );
        return loadBundleWithinTransaction(
          transaction,
          rotation.version.projectId,
          rotation.version.keyVersion,
          rotation.deviceEnvelopes[0]?.recipientDeviceId ?? null,
        );
      });
    });
  }

  public async confirmRecovery(
    inputValue: ConfirmRecoveryInput,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    return attempt("PROJECT_KEY_RECOVERY_CONFIRM_FAILED", async () => {
      const input = normalizeConfirmation(inputValue);
      return this.executor.transaction(async (transaction) => {
        const versionRow = await findProjectKeyVersionRow(
          transaction,
          input.projectId,
          input.keyVersion,
        );
        const recoveryRow = await findRecoveryEnvelopeRow(transaction, input.recoveryId);
        if (versionRow === null || recoveryRow === null) {
          throw notFoundError("The pending project key setup does not exist.");
        }
        const version = rehydrateProjectKeyVersion(versionRow);
        const recovery = rehydrateRecoveryEnvelope(recoveryRow);
        if (recovery.projectId !== input.projectId || recovery.keyVersion !== input.keyVersion) {
          throw validationError("The recovery envelope does not belong to the key version.");
        }

        if (
          recoveryRow.status === "confirmed" &&
          recovery.confirmedAt === input.confirmedAt &&
          version.state === "active" &&
          version.revision === input.expectedRevision + 1
        ) {
          return loadBundleWithinTransaction(transaction, input.projectId, input.keyVersion, null);
        }
        if (
          recoveryRow.status !== "pending_confirmation" ||
          recovery.confirmedAt !== null ||
          recovery.revokedAt !== null ||
          version.state !== "pending_confirmation" ||
          version.revision !== input.expectedRevision
        ) {
          throw concurrencyError("The pending project key setup changed before confirmation.");
        }

        const activeRows = await transaction.select<ProjectKeyVersionDbRow>(
          `SELECT *
           FROM project_key_versions
           WHERE project_id = ? AND state = 'active'
           ORDER BY key_version DESC`,
          [input.projectId],
        );
        if (
          activeRows.length > 1 ||
          (input.keyVersion === 1 && activeRows.length !== 0) ||
          (input.keyVersion > 1 &&
            (activeRows.length !== 1 || activeRows[0]?.key_version !== input.keyVersion - 1))
        ) {
          throw concurrencyError("The active project key is not the rotation predecessor.");
        }
        if (activeRows[0] !== undefined) {
          const retired = await transaction.execute(
            `UPDATE project_key_versions
             SET state = 'retiring', revision = revision + 1
             WHERE project_id = ?
               AND key_version = ?
               AND state = 'active'
               AND revision = ?`,
            [input.projectId, activeRows[0].key_version, activeRows[0].revision],
          );
          if (retired.rowsAffected !== 1) {
            throw concurrencyError("The active project key changed during rotation.");
          }
        }
        const recoveryUpdate = await transaction.execute(
          `UPDATE project_recovery_key_envelopes
           SET status = 'confirmed', confirmed_at = ?
           WHERE recovery_id = ?
             AND status = 'pending_confirmation'
             AND confirmed_at IS NULL
             AND revoked_at IS NULL`,
          [input.confirmedAt, input.recoveryId],
        );
        const versionUpdate = await transaction.execute(
          `UPDATE project_key_versions
           SET state = 'active', revision = revision + 1
           WHERE project_id = ?
             AND key_version = ?
             AND state = 'pending_confirmation'
             AND revision = ?`,
          [input.projectId, input.keyVersion, input.expectedRevision],
        );
        if (recoveryUpdate.rowsAffected !== 1 || versionUpdate.rowsAffected !== 1) {
          throw concurrencyError("The pending project key setup changed before confirmation.");
        }
        return loadBundleWithinTransaction(transaction, input.projectId, input.keyVersion, null);
      });
    });
  }

  public async confirmRecoveryForPublication(
    inputValue: ConfirmRecoveryInput,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    return attempt("PROJECT_KEY_PUBLICATION_CONFIRM_FAILED", async () => {
      const input = normalizeConfirmation(inputValue);
      return this.executor.transaction(async (transaction) => {
        const versionRow = await findProjectKeyVersionRow(
          transaction,
          input.projectId,
          input.keyVersion,
        );
        const recoveryRow = await findRecoveryEnvelopeRow(transaction, input.recoveryId);
        if (versionRow === null || recoveryRow === null) {
          throw notFoundError("The pending project key setup does not exist.");
        }
        const version = rehydrateProjectKeyVersion(versionRow);
        const recovery = rehydrateRecoveryEnvelope(recoveryRow);
        if (recovery.projectId !== input.projectId || recovery.keyVersion !== input.keyVersion) {
          throw validationError("The recovery envelope does not belong to the key version.");
        }
        const activeRows = await transaction.select<ProjectKeyVersionDbRow>(
          `SELECT *
           FROM project_key_versions
           WHERE project_id = ? AND state = 'active'
           ORDER BY key_version DESC`,
          [input.projectId],
        );
        if (
          activeRows.length > 1 ||
          (input.keyVersion === 1 && activeRows.length !== 0) ||
          (input.keyVersion > 1 &&
            (activeRows.length !== 1 || activeRows[0]?.key_version !== input.keyVersion - 1))
        ) {
          throw concurrencyError("The active project key is not the publication predecessor.");
        }
        if (
          recoveryRow.status === "confirmed" &&
          recovery.confirmedAt === input.confirmedAt &&
          version.state === "pending_confirmation" &&
          version.revision === input.expectedRevision
        ) {
          return loadBundleWithinTransaction(transaction, input.projectId, input.keyVersion, null);
        }
        if (
          recoveryRow.status !== "pending_confirmation" ||
          recovery.confirmedAt !== null ||
          recovery.revokedAt !== null ||
          version.state !== "pending_confirmation" ||
          version.revision !== input.expectedRevision
        ) {
          throw concurrencyError("The pending project key setup changed before confirmation.");
        }
        const confirmed = await transaction.execute(
          `UPDATE project_recovery_key_envelopes
           SET status = 'confirmed', confirmed_at = ?
           WHERE recovery_id = ?
             AND status = 'pending_confirmation'
             AND confirmed_at IS NULL
             AND revoked_at IS NULL`,
          [input.confirmedAt, input.recoveryId],
        );
        if (confirmed.rowsAffected !== 1) {
          throw concurrencyError("The recovery envelope changed during confirmation.");
        }
        return loadBundleWithinTransaction(transaction, input.projectId, input.keyVersion, null);
      });
    });
  }

  public async abandonPendingProjectKeySetup(
    inputValue: AbandonPendingProjectKeySetupInput,
  ): Promise<Result<void, AppError>> {
    return attempt("PROJECT_KEY_SETUP_ABANDON_FAILED", async () => {
      const input = normalizeAbandonment(inputValue);
      await this.executor.transaction(async (transaction) => {
        const versionRow = await findProjectKeyVersionRow(
          transaction,
          input.projectId,
          input.keyVersion,
        );
        if (versionRow === null) {
          throw notFoundError("The pending project key setup does not exist.");
        }
        const version = rehydrateProjectKeyVersion(versionRow);
        if (
          version.state !== "pending_confirmation" ||
          version.revision !== input.expectedRevision
        ) {
          throw concurrencyError(
            "Only an unchanged, unconfirmed project key setup can be abandoned.",
          );
        }
        const recoveryRows = await transaction.select<RecoveryEnvelopeDbRow>(
          `SELECT *
           FROM project_recovery_key_envelopes
           WHERE project_id = ? AND key_version = ?
           ORDER BY created_at DESC, recovery_id DESC
           LIMIT 1`,
          [input.projectId, input.keyVersion],
        );
        const recoveryRow = recoveryRows[0];
        if (
          recoveryRow?.status !== "pending_confirmation" ||
          recoveryRow.confirmed_at !== null ||
          recoveryRow.revoked_at !== null
        ) {
          throw concurrencyError(
            "A recovery-confirmed project key cannot be abandoned while publication may exist.",
          );
        }
        const deleted = await transaction.execute(
          `DELETE FROM project_key_versions
           WHERE project_id = ?
             AND key_version = ?
             AND state = 'pending_confirmation'
             AND revision = ?`,
          [input.projectId, input.keyVersion, input.expectedRevision],
        );
        if (deleted.rowsAffected !== 1) {
          throw concurrencyError(
            "The pending project key setup changed before it could be abandoned.",
          );
        }
      });
    });
  }

  public async loadProjectKeyBundle(
    projectIdValue: string,
    deviceIdValue: string,
    keyVersionValue?: number,
  ): Promise<Result<ProjectKeyBundle | null, AppError>> {
    return attempt("PROJECT_KEY_BUNDLE_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const deviceId = parseUuid(deviceIdValue, "deviceId");
      const keyVersion =
        keyVersionValue === undefined ? null : parsePositiveInteger(keyVersionValue, "keyVersion");
      const versionRow =
        keyVersion === null
          ? ((
              await this.executor.select<ProjectKeyVersionDbRow>(
                `SELECT *
                 FROM project_key_versions
                 WHERE project_id = ?
                   AND state IN ('pending_confirmation', 'active', 'retiring')
                 ORDER BY key_version DESC
                 LIMIT 1`,
                [projectId],
              )
            )[0] ?? null)
          : await findProjectKeyVersionRow(this.executor, projectId, keyVersion);
      if (versionRow === null) {
        return null;
      }
      return loadBundleWithinTransaction(
        this.executor,
        projectId,
        versionRow.key_version,
        deviceId,
      );
    });
  }

  public async saveTeamProjectKeyReceipt(
    inputValue: SaveTeamProjectKeyReceiptInput,
  ): Promise<Result<TeamProjectKeyReceiptMetadata, AppError>> {
    return attempt("TEAM_PROJECT_KEY_RECEIPT_SAVE_FAILED", async () => {
      const input = normalizeTeamProjectKeyReceipt(inputValue);
      return this.executor.transaction(async (transaction) => {
        const scopeRows = await transaction.select<TeamProjectKeyReceiptDbRow>(
          `SELECT *
           FROM team_project_key_receipts
           WHERE team_id = ?
             AND project_id = ?
             AND account_id = ?
             AND device_id = ?
           ORDER BY key_version DESC`,
          [input.teamId, input.projectId, input.accountId, input.deviceId],
        );
        if (
          scopeRows.some(
            (row) =>
              row.key_version > input.keyVersion ||
              row.current_server_revision > input.currentServerRevision ||
              Date.parse(row.current_key_updated_at) > Date.parse(input.currentKeyUpdatedAt),
          )
        ) {
          throw concurrencyError(
            "A team project-key receipt cannot roll back newer local authority.",
          );
        }

        const existingRow = scopeRows.find((row) => row.key_version === input.keyVersion) ?? null;
        if (existingRow !== null) {
          const existing = rehydrateTeamProjectKeyReceipt(existingRow);
          if (Date.parse(input.receivedAt) < Date.parse(existing.lastVerifiedAt)) {
            throw concurrencyError(
              "A team project-key receipt retry cannot move local verification time backwards.",
            );
          }
          if (sameTeamProjectKeyReceiptAuthority(existing, input)) {
            if (existing.state !== "active") {
              await supersedeOtherActiveTeamReceipts(transaction, input);
            }
            const updated = await transaction.execute(
              `UPDATE team_project_key_receipts
               SET state = 'active',
                   last_verified_at = ?,
                   state_updated_at = CASE WHEN state = 'active' THEN state_updated_at ELSE ? END
               WHERE native_storage_ref = ?
                 AND native_receipt_fingerprint = ?`,
              [
                input.receivedAt,
                input.receivedAt,
                input.nativeStorageRef,
                input.nativeReceiptFingerprint,
              ],
            );
            if (updated.rowsAffected !== 1) {
              throw concurrencyError(
                "The team project-key receipt changed during idempotent verification.",
              );
            }
            return requireTeamProjectKeyReceiptByStorageRef(transaction, input.nativeStorageRef);
          }
          if (
            input.currentServerRevision <= existing.currentServerRevision ||
            Date.parse(input.currentKeyUpdatedAt) < Date.parse(existing.currentKeyUpdatedAt) ||
            existing.nativeStorageRef !== input.nativeStorageRef
          ) {
            throw concurrencyError(
              "Conflicting team project-key receipt authority cannot replace local history.",
            );
          }
          if (existing.state !== "active") {
            await supersedeOtherActiveTeamReceipts(transaction, input);
          }
          const updated = await transaction.execute(
            `UPDATE team_project_key_receipts
             SET envelope_id = ?,
                 membership_id = ?,
                 membership_revision = ?,
                 assignment_id = ?,
                 assignment_revision = ?,
                 sender_device_id = ?,
                 sender_public_key_fingerprint = ?,
                 recipient_public_key_fingerprint = ?,
                 project_key_fingerprint = ?,
                 native_receipt_fingerprint = ?,
                 current_server_revision = ?,
                 current_key_updated_at = ?,
                 envelope_created_at = ?,
                 state = 'active',
                 last_verified_at = ?,
                 state_updated_at = ?
             WHERE native_storage_ref = ?
               AND current_server_revision = ?
               AND native_receipt_fingerprint = ?`,
            [
              input.envelopeId,
              input.membershipId,
              input.membershipRevision,
              input.assignmentId,
              input.assignmentRevision,
              input.senderDeviceId,
              input.senderPublicKeyFingerprint,
              input.recipientPublicKeyFingerprint,
              input.projectKeyFingerprint,
              input.nativeReceiptFingerprint,
              input.currentServerRevision,
              input.currentKeyUpdatedAt,
              input.envelopeCreatedAt,
              input.receivedAt,
              input.receivedAt,
              existing.nativeStorageRef,
              existing.currentServerRevision,
              existing.nativeReceiptFingerprint,
            ],
          );
          if (updated.rowsAffected !== 1) {
            throw concurrencyError(
              "The team project-key receipt changed during authority reconciliation.",
            );
          }
          return requireTeamProjectKeyReceiptByStorageRef(transaction, input.nativeStorageRef);
        }

        await supersedeOtherActiveTeamReceipts(transaction, input);
        await transaction.execute(
          `INSERT INTO team_project_key_receipts (
             native_storage_ref, schema_version, receipt_kind,
             team_id, project_id, key_version, account_id, device_id,
             envelope_id, membership_id, membership_revision,
             assignment_id, assignment_revision, sender_device_id,
             sender_public_key_fingerprint, recipient_public_key_fingerprint,
             project_key_fingerprint, native_receipt_fingerprint,
             current_server_revision, current_key_updated_at, envelope_created_at,
             state, received_at, last_verified_at, state_updated_at
           ) VALUES (
             ?, 1, 'team_managed_device_envelope',
             ?, ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?,
             ?, ?,
             ?, ?,
             ?, ?, ?,
             'active', ?, ?, ?
           )`,
          [
            input.nativeStorageRef,
            input.teamId,
            input.projectId,
            input.keyVersion,
            input.accountId,
            input.deviceId,
            input.envelopeId,
            input.membershipId,
            input.membershipRevision,
            input.assignmentId,
            input.assignmentRevision,
            input.senderDeviceId,
            input.senderPublicKeyFingerprint,
            input.recipientPublicKeyFingerprint,
            input.projectKeyFingerprint,
            input.nativeReceiptFingerprint,
            input.currentServerRevision,
            input.currentKeyUpdatedAt,
            input.envelopeCreatedAt,
            input.receivedAt,
            input.receivedAt,
            input.receivedAt,
          ],
        );
        return requireTeamProjectKeyReceiptByStorageRef(transaction, input.nativeStorageRef);
      });
    });
  }

  public async loadTeamProjectKeyReceipt(
    scopeValue: TeamProjectKeyReceiptScope,
  ): Promise<Result<TeamProjectKeyReceiptMetadata | null, AppError>> {
    return attempt("TEAM_PROJECT_KEY_RECEIPT_READ_FAILED", async () => {
      const scope = normalizeTeamProjectKeyReceiptScope(scopeValue);
      const rows = await this.executor.select<TeamProjectKeyReceiptDbRow>(
        `SELECT *
         FROM team_project_key_receipts
         WHERE project_id = ?
           AND account_id = ?
           AND device_id = ?
           ${scope.teamId === undefined ? "" : "AND team_id = ?"}
           ${scope.keyVersion === undefined ? "" : "AND key_version = ?"}
         ORDER BY
           key_version DESC,
           current_server_revision DESC,
           CASE state
             WHEN 'active' THEN 0
             WHEN 'authority_unavailable' THEN 1
             WHEN 'credential_missing' THEN 2
             ELSE 3
           END
         LIMIT 1`,
        [
          scope.projectId,
          scope.accountId,
          scope.deviceId,
          ...(scope.teamId === undefined ? [] : [scope.teamId]),
          ...(scope.keyVersion === undefined ? [] : [scope.keyVersion]),
        ],
      );
      return rows[0] === undefined ? null : rehydrateTeamProjectKeyReceipt(rows[0]);
    });
  }

  public async transitionTeamProjectKeyReceiptState(
    inputValue: MarkTeamProjectKeyReceiptStateInput,
  ): Promise<Result<TeamProjectKeyReceiptMetadata, AppError>> {
    return attempt("TEAM_PROJECT_KEY_RECEIPT_STATE_FAILED", async () => {
      const input = normalizeTeamProjectKeyReceiptStateTransition(inputValue);
      return this.executor.transaction(async (transaction) => {
        const current = await requireTeamProjectKeyReceiptByStorageRef(
          transaction,
          input.nativeStorageRef,
        );
        if (
          current.nativeReceiptFingerprint !== input.nativeReceiptFingerprint ||
          current.state !== input.expectedState ||
          Date.parse(input.updatedAt) < Date.parse(current.stateUpdatedAt)
        ) {
          throw concurrencyError(
            "The team project-key receipt state changed before the transition.",
          );
        }
        if (current.state === "superseded") {
          throw concurrencyError("A superseded team project-key receipt is immutable.");
        }
        const updated = await transaction.execute(
          `UPDATE team_project_key_receipts
           SET state = ?, state_updated_at = ?
           WHERE native_storage_ref = ?
             AND native_receipt_fingerprint = ?
             AND state = ?`,
          [
            input.nextState,
            input.updatedAt,
            input.nativeStorageRef,
            input.nativeReceiptFingerprint,
            input.expectedState,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError(
            "The team project-key receipt state changed during the transition.",
          );
        }
        return requireTeamProjectKeyReceiptByStorageRef(transaction, input.nativeStorageRef);
      });
    });
  }

  public async listDeviceEnvelopes(
    projectIdValue: string,
    keyVersionValue: number,
  ): Promise<Result<readonly DeviceProjectKeyEnvelopeContract[], AppError>> {
    return attempt("PROJECT_DEVICE_ENVELOPE_LIST_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const keyVersion = parsePositiveInteger(keyVersionValue, "keyVersion");
      const rows = await this.executor.select<DeviceEnvelopeDbRow>(
        `SELECT *
         FROM project_device_key_envelopes
         WHERE project_id = ?
           AND key_version = ?
           AND revoked_at IS NULL
         ORDER BY recipient_device_id ASC, envelope_id ASC`,
        [projectId, keyVersion],
      );
      return rows.map(rehydrateDeviceEnvelope);
    });
  }

  public async beginCloudProjectKeyPublication(
    inputValue: BeginCloudProjectKeyPublicationInput,
  ): Promise<Result<CloudProjectKeyPublication, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_PUBLICATION_BEGIN_FAILED", async () => {
      const input = normalizeCloudProjectKeyPublication(inputValue);
      return this.executor.transaction(async (transaction) => {
        const existing = await findCloudProjectKeyPublication(
          transaction,
          input.projectId,
          input.keyVersion,
        );
        if (existing !== null) {
          const rehydrated = rehydrateCloudProjectKeyPublication(existing);
          if (
            rehydrated.idempotencyKey === input.idempotencyKey &&
            rehydrated.createdAt === input.createdAt &&
            JSON.stringify(rehydrated.request) === JSON.stringify(input.request)
          ) {
            return rehydrated;
          }
          throw concurrencyError(
            "Another project-key publication is already durable for this version.",
          );
        }
        await assertPublicationMatchesLocalState(transaction, input);
        await transaction.execute(
          `INSERT INTO cloud_project_key_publications (
             project_id, key_version, idempotency_key, expected_server_revision,
             request_json, state, created_at, updated_at, last_error_code
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
          [
            input.projectId,
            input.keyVersion,
            input.idempotencyKey,
            input.request.expectedServerRevision,
            JSON.stringify(input.request),
            input.createdAt,
            input.createdAt,
          ],
        );
        return {
          projectId: input.projectId,
          keyVersion: input.keyVersion,
          idempotencyKey: input.idempotencyKey,
          expectedServerRevision: input.request.expectedServerRevision,
          request: input.request,
          state: "pending",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          lastErrorCode: null,
        };
      });
    });
  }

  public async loadCloudProjectKeyPublication(
    projectIdValue: string,
    keyVersionValue: number,
  ): Promise<Result<CloudProjectKeyPublication | null, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_PUBLICATION_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const keyVersion = parsePositiveInteger(keyVersionValue, "keyVersion");
      const row = await findCloudProjectKeyPublication(this.executor, projectId, keyVersion);
      return row === null ? null : rehydrateCloudProjectKeyPublication(row);
    });
  }

  public async markCloudProjectKeyPublicationConflicted(
    inputValue: MarkCloudProjectKeyPublicationConflictInput,
  ): Promise<Result<CloudProjectKeyPublication, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_PUBLICATION_CONFLICT_FAILED", async () => {
      const input = normalizeCloudProjectKeyPublicationConflict(inputValue);
      return this.executor.transaction(async (transaction) => {
        const existingRow = await findCloudProjectKeyPublication(
          transaction,
          input.projectId,
          input.keyVersion,
        );
        if (existingRow === null) {
          throw notFoundError("The durable project-key publication does not exist.");
        }
        const existing = rehydrateCloudProjectKeyPublication(existingRow);
        if (
          existing.idempotencyKey !== input.idempotencyKey ||
          Date.parse(input.updatedAt) < Date.parse(existing.updatedAt)
        ) {
          throw concurrencyError("The durable project-key publication changed.");
        }
        if (
          existing.state === "conflicted" &&
          existing.lastErrorCode === input.errorCode &&
          existing.updatedAt === input.updatedAt
        ) {
          return existing;
        }
        const updated = await transaction.execute(
          `UPDATE cloud_project_key_publications
           SET state = 'conflicted', updated_at = ?, last_error_code = ?
           WHERE project_id = ? AND key_version = ? AND idempotency_key = ?`,
          [
            input.updatedAt,
            input.errorCode,
            input.projectId,
            input.keyVersion,
            input.idempotencyKey,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError("The durable project-key publication changed.");
        }
        return {
          ...existing,
          state: "conflicted",
          updatedAt: input.updatedAt,
          lastErrorCode: input.errorCode,
        };
      });
    });
  }

  public async resolveCloudProjectKeyPublication(
    inputValue: ResolveCloudProjectKeyPublicationInput,
  ): Promise<Result<CloudProjectKeySet, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_PUBLICATION_RESOLVE_FAILED", async () => {
      const input = normalizeCloudProjectKeyPublicationResolution(inputValue);
      return this.executor.transaction(async (transaction) => {
        const publication = await requireCloudProjectKeyPublication(
          transaction,
          input.projectId,
          input.keyVersion,
          input.idempotencyKey,
        );
        if (!(await cloudProjectKeyPublicationReceiptMatches(publication, input.receipt))) {
          throw validationError(
            "The immutable cloud publication receipt does not match the durable request.",
          );
        }
        const keySet = parseWithSchema(CloudProjectKeySetSchema, {
          schemaVersion: 1,
          projectId: publication.projectId,
          keyVersion: publication.keyVersion,
          serverRevision: input.receipt.serverRevision,
          publication: input.receipt,
          version: publication.request.version,
          recoveryEnvelope: publication.request.recoveryEnvelope,
          deviceEnvelopes: publication.request.deviceEnvelopes,
          updatedAt: input.receipt.publishedAt,
        });
        const checkpoint = await findCloudProjectKeyCheckpoint(transaction, publication.projectId);
        if (checkpoint !== null) {
          const keyDirection = Math.sign(checkpoint.current_key_version - publication.keyVersion);
          const revisionDirection = Math.sign(
            checkpoint.server_revision - input.receipt.serverRevision,
          );
          if (keyDirection !== revisionDirection) {
            throw concurrencyError(
              "The cloud project-key checkpoint version and revision must advance together.",
            );
          }
          if (keyDirection >= 0) {
            await deleteCloudProjectKeyPublication(transaction, publication);
            return keySet;
          }
        }
        await saveCloudProjectKeySetWithinTransaction(transaction, {
          keySet,
          makeCurrent: true,
          completedPublicationIdempotencyKey: publication.idempotencyKey,
        });
        return keySet;
      });
    });
  }

  public async rebaseCloudProjectKeyPublication(
    inputValue: RebaseCloudProjectKeyPublicationInput,
  ): Promise<Result<CloudProjectKeyPublication, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_PUBLICATION_REBASE_FAILED", async () => {
      const input = normalizeCloudProjectKeyPublicationRebase(inputValue);
      return this.executor.transaction(async (transaction) => {
        const publication = await requireCloudProjectKeyPublication(
          transaction,
          input.projectId,
          input.keyVersion,
          input.idempotencyKey,
        );
        if (Date.parse(input.updatedAt) < Date.parse(publication.updatedAt)) {
          throw concurrencyError("The durable project-key publication changed.");
        }
        await assertCloudProjectKeyPublicationRebaseAnchor(
          transaction,
          publication,
          input.observedCurrentPublication,
        );
        const updated = await transaction.execute(
          `UPDATE cloud_project_key_publications
           SET idempotency_key = ?, state = 'pending', updated_at = ?, last_error_code = NULL
           WHERE project_id = ? AND key_version = ? AND idempotency_key = ?`,
          [
            input.nextIdempotencyKey,
            input.updatedAt,
            publication.projectId,
            publication.keyVersion,
            publication.idempotencyKey,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError("The durable project-key publication changed.");
        }
        return {
          ...publication,
          idempotencyKey: input.nextIdempotencyKey,
          state: "pending",
          updatedAt: input.updatedAt,
          lastErrorCode: null,
        };
      });
    });
  }

  public async saveCloudProjectKeySet(
    inputValue: SaveCloudProjectKeySetInput,
  ): Promise<Result<CloudProjectKeyCheckpoint | null, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_SET_SAVE_FAILED", async () => {
      const input = normalizeCloudProjectKeySetInput(inputValue);
      return this.executor.transaction((transaction) =>
        saveCloudProjectKeySetWithinTransaction(transaction, input),
      );
    });
  }

  public async saveDeviceEnvelope(
    envelopeValue: DeviceProjectKeyEnvelopeContract,
  ): Promise<Result<void, AppError>> {
    return attempt("PROJECT_DEVICE_ENVELOPE_SAVE_FAILED", async () => {
      const envelope = parseWithSchema(DeviceProjectKeyEnvelopeContractSchema, envelopeValue);
      await this.executor.transaction(async (transaction) => {
        const version = await findProjectKeyVersionRow(
          transaction,
          envelope.projectId,
          envelope.keyVersion,
        );
        if (version === null) {
          throw notFoundError("The project-key version does not exist.");
        }
        await verifyEnvelopeDevices(transaction, envelope);
        await saveDeviceEnvelopeRecord(transaction, envelope);
      });
    });
  }

  public async loadCloudProjectKeyCheckpoint(
    projectIdValue: string,
  ): Promise<Result<CloudProjectKeyCheckpoint | null, AppError>> {
    return attempt("CLOUD_PROJECT_KEY_CHECKPOINT_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const row = await findCloudProjectKeyCheckpoint(this.executor, projectId);
      return row === null
        ? null
        : {
            projectId: row.project_id,
            currentKeyVersion: parsePositiveInteger(row.current_key_version, "currentKeyVersion"),
            serverRevision: parsePositiveInteger(row.server_revision, "serverRevision"),
            updatedAt: parseTimestamp(row.updated_at, "updatedAt"),
          };
    });
  }
}

async function saveCloudProjectKeySetWithinTransaction(
  transaction: TransactionExecutor,
  input: SaveCloudProjectKeySetInput,
): Promise<CloudProjectKeyCheckpoint | null> {
  const publication =
    input.completedPublicationIdempotencyKey === undefined
      ? null
      : await requireMatchingCloudProjectKeyPublication(
          transaction,
          input.keySet,
          input.completedPublicationIdempotencyKey,
        );
  for (const envelope of input.keySet.deviceEnvelopes) {
    await verifyEnvelopeDevices(transaction, envelope, false);
  }
  if (input.localDeviceEnvelope !== undefined) {
    await verifyEnvelopeDevices(transaction, input.localDeviceEnvelope);
  }
  await saveCloudVersion(transaction, input.keySet.version, input.makeCurrent);
  await saveCloudRecoveryEnvelope(transaction, input.keySet.recoveryEnvelope);
  for (const envelope of input.keySet.deviceEnvelopes) {
    await saveDeviceEnvelopeRecord(transaction, envelope, true);
  }
  if (input.localDeviceEnvelope !== undefined) {
    await saveDeviceEnvelopeRecord(transaction, input.localDeviceEnvelope);
  }
  if (!input.makeCurrent) {
    return null;
  }
  const existing = await findCloudProjectKeyCheckpoint(transaction, input.keySet.projectId);
  if (existing !== null) {
    const keyDirection = Math.sign(input.keySet.keyVersion - existing.current_key_version);
    const revisionDirection = Math.sign(input.keySet.serverRevision - existing.server_revision);
    if (keyDirection < 0 || revisionDirection < 0 || keyDirection !== revisionDirection) {
      throw concurrencyError(
        "The cloud project-key checkpoint version and revision must advance together.",
      );
    }
  }
  await transaction.execute(
    `INSERT INTO cloud_project_key_checkpoints (
       project_id, current_key_version, server_revision, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       current_key_version = excluded.current_key_version,
       server_revision = excluded.server_revision,
       updated_at = excluded.updated_at`,
    [
      input.keySet.projectId,
      input.keySet.keyVersion,
      input.keySet.serverRevision,
      input.keySet.updatedAt,
    ],
  );
  if (publication !== null) {
    await deleteCloudProjectKeyPublication(transaction, publication);
  }
  return {
    projectId: input.keySet.projectId,
    currentKeyVersion: input.keySet.keyVersion,
    serverRevision: input.keySet.serverRevision,
    updatedAt: input.keySet.updatedAt,
  };
}

async function deleteCloudProjectKeyPublication(
  transaction: TransactionExecutor,
  publication: CloudProjectKeyPublication,
): Promise<void> {
  const deleted = await transaction.execute(
    `DELETE FROM cloud_project_key_publications
     WHERE project_id = ? AND key_version = ? AND idempotency_key = ?`,
    [publication.projectId, publication.keyVersion, publication.idempotencyKey],
  );
  if (deleted.rowsAffected !== 1) {
    throw concurrencyError("The durable project-key publication changed.");
  }
}

function normalizePendingSetup(value: PendingProjectKeySetup): ProjectKeyBundle {
  const version = parseWithSchema(ProjectKeyVersionContractSchema, value.version);
  const deviceEnvelope = parseWithSchema(
    DeviceProjectKeyEnvelopeContractSchema,
    value.deviceEnvelope,
  );
  const recoveryEnvelope = parseWithSchema(
    RecoveryProjectKeyEnvelopeContractSchema,
    value.recoveryEnvelope,
  );
  if (
    version.state !== "pending_confirmation" ||
    version.revision !== 1 ||
    version.retiredAt !== null ||
    deviceEnvelope.revokedAt !== null ||
    recoveryEnvelope.confirmedAt !== null ||
    recoveryEnvelope.revokedAt !== null ||
    deviceEnvelope.projectId !== version.projectId ||
    deviceEnvelope.keyVersion !== version.keyVersion ||
    recoveryEnvelope.projectId !== version.projectId ||
    recoveryEnvelope.keyVersion !== version.keyVersion
  ) {
    throw validationError("The pending project key setup is inconsistent.");
  }
  return { version, deviceEnvelope, recoveryEnvelope };
}

function normalizePendingRotation(value: PendingProjectKeyRotation): PendingProjectKeyRotation {
  const expectedCurrentKeyVersion = parsePositiveInteger(
    value.expectedCurrentKeyVersion,
    "expectedCurrentKeyVersion",
  );
  const version = parseWithSchema(ProjectKeyVersionContractSchema, value.version);
  const recoveryEnvelope = parseWithSchema(
    RecoveryProjectKeyEnvelopeContractSchema,
    value.recoveryEnvelope,
  );
  const deviceEnvelopes = value.deviceEnvelopes.map((envelope) =>
    parseWithSchema(DeviceProjectKeyEnvelopeContractSchema, envelope),
  );
  if (
    version.state !== "pending_confirmation" ||
    version.revision !== 1 ||
    version.retiredAt !== null ||
    version.keyVersion !== expectedCurrentKeyVersion + 1 ||
    deviceEnvelopes.length < 1 ||
    deviceEnvelopes.length > 1_024 ||
    new Set(deviceEnvelopes.map(({ recipientDeviceId }) => recipientDeviceId)).size !==
      deviceEnvelopes.length ||
    deviceEnvelopes.some(
      (envelope) =>
        envelope.projectId !== version.projectId ||
        envelope.keyVersion !== version.keyVersion ||
        envelope.revokedAt !== null,
    ) ||
    recoveryEnvelope.projectId !== version.projectId ||
    recoveryEnvelope.keyVersion !== version.keyVersion ||
    recoveryEnvelope.confirmedAt !== null ||
    recoveryEnvelope.revokedAt !== null
  ) {
    throw validationError("The pending project-key rotation is inconsistent.");
  }
  return {
    expectedCurrentKeyVersion,
    version,
    deviceEnvelopes,
    recoveryEnvelope,
  };
}

function normalizeCloudProjectKeySetInput(
  value: SaveCloudProjectKeySetInput,
): SaveCloudProjectKeySetInput {
  const keySet = parseWithSchema(CloudProjectKeySetSchema, value.keySet);
  if (typeof value.makeCurrent !== "boolean") {
    throw validationError("The cloud project-key checkpoint intent is invalid.");
  }
  if (value.makeCurrent && keySet.version.state !== "active") {
    throw validationError("Only an active cloud project-key version can become current.");
  }
  const completedPublicationIdempotencyKey =
    value.completedPublicationIdempotencyKey === undefined
      ? undefined
      : parseUuid(value.completedPublicationIdempotencyKey, "completedPublicationIdempotencyKey");
  if (completedPublicationIdempotencyKey !== undefined && !value.makeCurrent) {
    throw validationError("A completed publication must advance the cloud checkpoint.");
  }
  const localDeviceEnvelope =
    value.localDeviceEnvelope === undefined
      ? undefined
      : parseWithSchema(DeviceProjectKeyEnvelopeContractSchema, value.localDeviceEnvelope);
  if (
    localDeviceEnvelope !== undefined &&
    (localDeviceEnvelope.projectId !== keySet.projectId ||
      localDeviceEnvelope.keyVersion !== keySet.keyVersion ||
      localDeviceEnvelope.revokedAt !== null ||
      keySet.deviceEnvelopes.some(
        (envelope) => envelope.recipientDeviceId === localDeviceEnvelope.recipientDeviceId,
      ))
  ) {
    throw validationError("The local recovery envelope conflicts with the cloud key set.");
  }
  return {
    keySet,
    makeCurrent: value.makeCurrent,
    ...(completedPublicationIdempotencyKey === undefined
      ? {}
      : { completedPublicationIdempotencyKey }),
    ...(localDeviceEnvelope === undefined ? {} : { localDeviceEnvelope }),
  };
}

function normalizeCloudProjectKeyPublication(
  value: BeginCloudProjectKeyPublicationInput,
): BeginCloudProjectKeyPublicationInput {
  const projectId = parseUuid(value.projectId, "projectId");
  const keyVersion = parsePositiveInteger(value.keyVersion, "keyVersion");
  const idempotencyKey = parseUuid(value.idempotencyKey, "idempotencyKey");
  const request = parseWithSchema(CloudProjectKeyPublishRequestSchema, value.request);
  const createdAt = parseTimestamp(value.createdAt, "createdAt");
  if (
    request.version.projectId !== projectId ||
    request.version.keyVersion !== keyVersion ||
    (keyVersion === 1) !== (request.expectedServerRevision === null)
  ) {
    throw validationError("The durable publication does not match its project-key route.");
  }
  return { projectId, keyVersion, idempotencyKey, request, createdAt };
}

function normalizeCloudProjectKeyPublicationConflict(
  value: MarkCloudProjectKeyPublicationConflictInput,
): MarkCloudProjectKeyPublicationConflictInput {
  const errorCode = value.errorCode.trim();
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(errorCode)) {
    throw validationError("The cloud publication error code is invalid.");
  }
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion"),
    idempotencyKey: parseUuid(value.idempotencyKey, "idempotencyKey"),
    errorCode,
    updatedAt: parseTimestamp(value.updatedAt, "updatedAt"),
  };
}

function normalizeCloudProjectKeyPublicationResolution(
  value: ResolveCloudProjectKeyPublicationInput,
): ResolveCloudProjectKeyPublicationInput {
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion"),
    idempotencyKey: parseUuid(value.idempotencyKey, "idempotencyKey"),
    receipt: parseWithSchema(CloudProjectKeyPublicationReceiptSchema, value.receipt),
  };
}

function normalizeCloudProjectKeyPublicationRebase(
  value: RebaseCloudProjectKeyPublicationInput,
): RebaseCloudProjectKeyPublicationInput {
  const idempotencyKey = parseUuid(value.idempotencyKey, "idempotencyKey");
  const nextIdempotencyKey = parseUuid(value.nextIdempotencyKey, "nextIdempotencyKey");
  if (idempotencyKey === nextIdempotencyKey) {
    throw validationError("A rebased publication requires a fresh idempotency key.");
  }
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion"),
    idempotencyKey,
    nextIdempotencyKey,
    observedCurrentPublication:
      value.observedCurrentPublication === null
        ? null
        : parseWithSchema(
            CloudProjectKeyPublicationReceiptSchema,
            value.observedCurrentPublication,
          ),
    updatedAt: parseTimestamp(value.updatedAt, "updatedAt"),
  };
}

async function samePendingRotation(
  transaction: TransactionExecutor,
  rotation: PendingProjectKeyRotation,
  existing: ProjectKeyBundle,
): Promise<boolean> {
  if (
    JSON.stringify(existing.version) !== JSON.stringify(rotation.version) ||
    JSON.stringify(existing.recoveryEnvelope) !== JSON.stringify(rotation.recoveryEnvelope)
  ) {
    return false;
  }
  const rows = await transaction.select<DeviceEnvelopeDbRow>(
    `SELECT *
     FROM project_device_key_envelopes
     WHERE project_id = ? AND key_version = ?
     ORDER BY recipient_device_id, envelope_id`,
    [rotation.version.projectId, rotation.version.keyVersion],
  );
  const stored = rows.map(rehydrateDeviceEnvelope).sort(compareDeviceEnvelopes);
  const supplied = [...rotation.deviceEnvelopes].sort(compareDeviceEnvelopes);
  return JSON.stringify(stored) === JSON.stringify(supplied);
}

function compareDeviceEnvelopes(
  left: DeviceProjectKeyEnvelopeContract,
  right: DeviceProjectKeyEnvelopeContract,
): number {
  return (
    left.recipientDeviceId.localeCompare(right.recipientDeviceId) ||
    left.envelopeId.localeCompare(right.envelopeId)
  );
}

function normalizeTeamProjectKeyReceipt(
  value: SaveTeamProjectKeyReceiptInput,
): SaveTeamProjectKeyReceiptInput {
  const schemaVersion: unknown = value.schemaVersion;
  const receiptKind: unknown = value.receiptKind;
  if (
    schemaVersion !== 1 ||
    receiptKind !== "team_managed_device_envelope" ||
    !/^team_project_key_receipt_v1_[a-f0-9]{64}$/u.test(value.nativeStorageRef) ||
    !/^[a-f0-9]{64}$/u.test(value.nativeReceiptFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(value.senderPublicKeyFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(value.recipientPublicKeyFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(value.projectKeyFingerprint)
  ) {
    throw validationError("The team project-key receipt metadata is invalid.");
  }
  return {
    schemaVersion: 1,
    receiptKind: "team_managed_device_envelope",
    teamId: parseUuid(value.teamId, "teamId"),
    projectId: parseUuid(value.projectId, "projectId"),
    keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion"),
    accountId: parseUuid(value.accountId, "accountId"),
    deviceId: parseUuid(value.deviceId, "deviceId"),
    envelopeId: parseUuid(value.envelopeId, "envelopeId"),
    membershipId: parseUuid(value.membershipId, "membershipId"),
    membershipRevision: parsePortablePositiveInteger(
      value.membershipRevision,
      "membershipRevision",
    ),
    assignmentId: parseUuid(value.assignmentId, "assignmentId"),
    assignmentRevision: parsePortablePositiveInteger(
      value.assignmentRevision,
      "assignmentRevision",
    ),
    senderDeviceId: parseUuid(value.senderDeviceId, "senderDeviceId"),
    senderPublicKeyFingerprint: value.senderPublicKeyFingerprint,
    recipientPublicKeyFingerprint: value.recipientPublicKeyFingerprint,
    projectKeyFingerprint: value.projectKeyFingerprint,
    nativeStorageRef: value.nativeStorageRef,
    nativeReceiptFingerprint: value.nativeReceiptFingerprint,
    currentServerRevision: parsePortablePositiveInteger(
      value.currentServerRevision,
      "currentServerRevision",
    ),
    currentKeyUpdatedAt: parseTimestamp(value.currentKeyUpdatedAt, "currentKeyUpdatedAt"),
    envelopeCreatedAt: parseTimestamp(value.envelopeCreatedAt, "envelopeCreatedAt"),
    receivedAt: parseTimestamp(value.receivedAt, "receivedAt"),
  };
}

function normalizeTeamProjectKeyReceiptScope(
  value: TeamProjectKeyReceiptScope,
): TeamProjectKeyReceiptScope {
  return {
    ...(value.teamId === undefined ? {} : { teamId: parseUuid(value.teamId, "teamId") }),
    projectId: parseUuid(value.projectId, "projectId"),
    accountId: parseUuid(value.accountId, "accountId"),
    deviceId: parseUuid(value.deviceId, "deviceId"),
    ...(value.keyVersion === undefined
      ? {}
      : { keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion") }),
  };
}

function normalizeTeamProjectKeyReceiptStateTransition(
  value: MarkTeamProjectKeyReceiptStateInput,
): MarkTeamProjectKeyReceiptStateInput {
  if (
    !/^team_project_key_receipt_v1_[a-f0-9]{64}$/u.test(value.nativeStorageRef) ||
    !/^[a-f0-9]{64}$/u.test(value.nativeReceiptFingerprint) ||
    !["active", "superseded", "authority_unavailable", "credential_missing"].includes(
      value.expectedState,
    ) ||
    !["authority_unavailable", "credential_missing"].includes(value.nextState) ||
    value.expectedState === value.nextState
  ) {
    throw validationError("The team project-key receipt state transition is invalid.");
  }
  return {
    nativeStorageRef: value.nativeStorageRef,
    nativeReceiptFingerprint: value.nativeReceiptFingerprint,
    expectedState: value.expectedState,
    nextState: value.nextState,
    updatedAt: parseTimestamp(value.updatedAt, "updatedAt"),
  };
}

function sameTeamProjectKeyReceiptAuthority(
  existing: TeamProjectKeyReceiptMetadata,
  input: SaveTeamProjectKeyReceiptInput,
): boolean {
  return (
    existing.teamId === input.teamId &&
    existing.projectId === input.projectId &&
    existing.keyVersion === input.keyVersion &&
    existing.accountId === input.accountId &&
    existing.deviceId === input.deviceId &&
    existing.envelopeId === input.envelopeId &&
    existing.membershipId === input.membershipId &&
    existing.membershipRevision === input.membershipRevision &&
    existing.assignmentId === input.assignmentId &&
    existing.assignmentRevision === input.assignmentRevision &&
    existing.senderDeviceId === input.senderDeviceId &&
    existing.senderPublicKeyFingerprint === input.senderPublicKeyFingerprint &&
    existing.recipientPublicKeyFingerprint === input.recipientPublicKeyFingerprint &&
    existing.projectKeyFingerprint === input.projectKeyFingerprint &&
    existing.nativeStorageRef === input.nativeStorageRef &&
    existing.nativeReceiptFingerprint === input.nativeReceiptFingerprint &&
    existing.currentServerRevision === input.currentServerRevision &&
    existing.currentKeyUpdatedAt === input.currentKeyUpdatedAt &&
    existing.envelopeCreatedAt === input.envelopeCreatedAt
  );
}

function normalizeDevicePublicKey(value: DevicePublicKeyRecord): DevicePublicKeyRecord {
  const deviceId = parseUuid(value.deviceId, "deviceId");
  const accountId = value.accountId === null ? null : parseUuid(value.accountId, "accountId");
  const schemaVersion: unknown = value.schemaVersion;
  const algorithm: unknown = value.algorithm;
  if (
    schemaVersion !== 1 ||
    algorithm !== "DHKEM-P256-HKDF-SHA256" ||
    !/^[A-Za-z0-9_-]{87}$/u.test(value.publicKey) ||
    !/^[a-f0-9]{64}$/u.test(value.publicKeyFingerprint) ||
    value.displayName !== value.displayName.trim() ||
    value.displayName.length < 1 ||
    value.displayName.length > 80 ||
    !["local_os_credential", "remote_registered"].includes(value.keyOrigin) ||
    !["trusted", "revoked", "credential_missing"].includes(value.state)
  ) {
    throw validationError("The device public-key record is invalid.");
  }
  const createdAt = parseTimestamp(value.createdAt, "createdAt");
  const updatedAt = parseTimestamp(value.updatedAt, "updatedAt");
  const revokedAt = value.revokedAt === null ? null : parseTimestamp(value.revokedAt, "revokedAt");
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (value.state === "revoked") !== (revokedAt !== null) ||
    (revokedAt !== null && Date.parse(revokedAt) < Date.parse(createdAt))
  ) {
    throw validationError("The device public-key lifecycle is inconsistent.");
  }
  return {
    schemaVersion: 1,
    deviceId,
    accountId,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: value.publicKey,
    publicKeyFingerprint: value.publicKeyFingerprint,
    displayName: value.displayName,
    keyOrigin: value.keyOrigin,
    state: value.state,
    createdAt,
    updatedAt,
    revokedAt,
  };
}

function validateDevicePublicKeyTransition(
  current: DevicePublicKeyRecord,
  next: DevicePublicKeyRecord,
): void {
  if (
    current.publicKey !== next.publicKey ||
    current.publicKeyFingerprint !== next.publicKeyFingerprint ||
    current.keyOrigin !== next.keyOrigin ||
    current.createdAt !== next.createdAt ||
    (current.accountId !== null && current.accountId !== next.accountId) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) {
    throw validationError("Immutable device public-key metadata cannot be replaced.");
  }
  if (current.state === "revoked" && next.state !== "revoked") {
    throw concurrencyError("A revoked device public key cannot become trusted again.");
  }
}

function normalizeConfirmation(value: ConfirmRecoveryInput): ConfirmRecoveryInput {
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion"),
    recoveryId: parseUuid(value.recoveryId, "recoveryId"),
    expectedRevision: parsePositiveInteger(value.expectedRevision, "expectedRevision"),
    confirmedAt: parseTimestamp(value.confirmedAt, "confirmedAt"),
  };
}

function normalizeAbandonment(
  value: AbandonPendingProjectKeySetupInput,
): AbandonPendingProjectKeySetupInput {
  return {
    projectId: parseUuid(value.projectId, "projectId"),
    keyVersion: parsePositiveInteger(value.keyVersion, "keyVersion"),
    expectedRevision: parsePositiveInteger(value.expectedRevision, "expectedRevision"),
  };
}

async function verifyEnvelopeDevices(
  executor: TransactionExecutor,
  envelope: DeviceProjectKeyEnvelopeContract,
  requireTrusted = true,
): Promise<void> {
  const [senderRow, recipientRow] = await Promise.all([
    findDevicePublicKeyRow(executor, envelope.senderDeviceId),
    findDevicePublicKeyRow(executor, envelope.recipientDeviceId),
  ]);
  if (senderRow === null || recipientRow === null) {
    throw validationError("Project key envelopes require registered device public keys.");
  }
  const sender = rehydrateDevicePublicKey(senderRow);
  const recipient = rehydrateDevicePublicKey(recipientRow);
  if (
    (requireTrusted && (sender.state !== "trusted" || recipient.state !== "trusted")) ||
    sender.publicKey !== envelope.senderPublicKey ||
    sender.publicKeyFingerprint !== envelope.senderPublicKeyFingerprint ||
    recipient.publicKey !== envelope.recipientPublicKey ||
    recipient.publicKeyFingerprint !== envelope.recipientPublicKeyFingerprint
  ) {
    throw validationError("Project key envelope device metadata does not match trusted keys.");
  }
}

async function saveCloudVersion(
  transaction: TransactionExecutor,
  version: ProjectKeyVersionContract,
  allowActivation: boolean,
): Promise<void> {
  const existingRow = await findProjectKeyVersionRow(
    transaction,
    version.projectId,
    version.keyVersion,
  );
  if (existingRow === null) {
    if (version.state === "active") {
      if (!allowActivation) {
        throw validationError(
          "An active historical cloud project key cannot change the local current key.",
        );
      }
      await transaction.execute(
        `UPDATE project_key_versions
         SET state = 'retiring', revision = revision + 1
         WHERE project_id = ? AND state = 'active'`,
        [version.projectId],
      );
    }
    await insertProjectKeyVersion(transaction, version);
    return;
  }
  const existing = rehydrateProjectKeyVersion(existingRow);
  if (
    existing.projectId !== version.projectId ||
    existing.keyVersion !== version.keyVersion ||
    existing.createdAt !== version.createdAt ||
    version.revision < existing.revision ||
    !isAllowedProjectKeyStateTransition(existing.state, version.state)
  ) {
    throw validationError("Cloud project-key version metadata conflicts with local history.");
  }
  if (JSON.stringify(existing) === JSON.stringify(version)) {
    return;
  }
  if (version.state === "active") {
    if (!allowActivation && existing.state !== "active") {
      throw validationError(
        "An active historical cloud project key cannot change the local current key.",
      );
    }
    await transaction.execute(
      `UPDATE project_key_versions
       SET state = 'retiring', revision = revision + 1
       WHERE project_id = ? AND state = 'active' AND key_version <> ?`,
      [version.projectId, version.keyVersion],
    );
  }
  const updated = await transaction.execute(
    `UPDATE project_key_versions
     SET state = ?, revision = ?, retired_at = ?
     WHERE project_id = ? AND key_version = ? AND revision = ?`,
    [
      version.state,
      version.revision,
      version.retiredAt,
      version.projectId,
      version.keyVersion,
      existing.revision,
    ],
  );
  if (updated.rowsAffected !== 1) {
    throw concurrencyError("The local project-key version changed during cloud reconciliation.");
  }
}

async function assertPublicationMatchesLocalState(
  transaction: TransactionExecutor,
  input: BeginCloudProjectKeyPublicationInput,
): Promise<void> {
  const [versionRow, recoveryRow, checkpoint, deviceRows] = await Promise.all([
    findProjectKeyVersionRow(transaction, input.projectId, input.keyVersion),
    findRecoveryEnvelopeRow(transaction, input.request.recoveryEnvelope.recoveryId),
    findCloudProjectKeyCheckpoint(transaction, input.projectId),
    transaction.select<DeviceEnvelopeDbRow>(
      `SELECT *
       FROM project_device_key_envelopes
       WHERE project_id = ?
         AND key_version = ?
         AND revoked_at IS NULL
       ORDER BY recipient_device_id, envelope_id`,
      [input.projectId, input.keyVersion],
    ),
  ]);
  if (versionRow === null || recoveryRow === null) {
    throw notFoundError("The project-key material to publish does not exist.");
  }

  const localVersion = rehydrateProjectKeyVersion(versionRow);
  const localRecoveryEnvelope = rehydrateRecoveryEnvelope(recoveryRow);
  const localDeviceEnvelopes = deviceRows.map(rehydrateDeviceEnvelope).sort(compareDeviceEnvelopes);
  const requestedDeviceEnvelopes = [...input.request.deviceEnvelopes].sort(compareDeviceEnvelopes);
  const exactVersion = JSON.stringify(localVersion) === JSON.stringify(input.request.version);
  const stagedVersion =
    localVersion.state === "pending_confirmation" &&
    input.request.version.state === "active" &&
    input.request.version.revision === localVersion.revision + 1 &&
    input.request.version.projectId === localVersion.projectId &&
    input.request.version.keyVersion === localVersion.keyVersion &&
    input.request.version.createdAt === localVersion.createdAt &&
    input.request.version.retiredAt === null;
  const checkpointMatches =
    input.request.expectedServerRevision === null
      ? checkpoint === null && input.keyVersion === 1
      : checkpoint !== null &&
        checkpoint.current_key_version === input.keyVersion - 1 &&
        checkpoint.server_revision === input.request.expectedServerRevision;

  if (
    (!exactVersion && !stagedVersion) ||
    JSON.stringify(localRecoveryEnvelope) !== JSON.stringify(input.request.recoveryEnvelope) ||
    JSON.stringify(localDeviceEnvelopes) !== JSON.stringify(requestedDeviceEnvelopes) ||
    !checkpointMatches
  ) {
    throw validationError(
      "The durable publication does not match the local project-key state and checkpoint.",
    );
  }
  for (const envelope of input.request.deviceEnvelopes) {
    await verifyEnvelopeDevices(transaction, envelope);
  }
}

function isAllowedProjectKeyStateTransition(
  current: ProjectKeyVersionContract["state"],
  next: ProjectKeyVersionContract["state"],
): boolean {
  const allowed: Record<
    ProjectKeyVersionContract["state"],
    readonly ProjectKeyVersionContract["state"][]
  > = {
    pending_confirmation: ["pending_confirmation", "active"],
    active: ["active", "retiring"],
    retiring: ["retiring", "retired"],
    retired: ["retired"],
  };
  return allowed[current].includes(next);
}

async function saveCloudRecoveryEnvelope(
  transaction: TransactionExecutor,
  envelope: RecoveryProjectKeyEnvelopeContract,
): Promise<void> {
  const existingRow = await findRecoveryEnvelopeRow(transaction, envelope.recoveryId);
  if (existingRow === null) {
    await insertRecoveryEnvelope(transaction, envelope, "confirmed");
    return;
  }
  const existing = rehydrateRecoveryEnvelope(existingRow);
  if (JSON.stringify(existing) === JSON.stringify(envelope)) {
    return;
  }
  if (
    existing.projectId !== envelope.projectId ||
    existing.keyVersion !== envelope.keyVersion ||
    JSON.stringify(existing.kdf) !== JSON.stringify(envelope.kdf) ||
    existing.salt !== envelope.salt ||
    existing.nonce !== envelope.nonce ||
    existing.ciphertext !== envelope.ciphertext ||
    existing.verifier !== envelope.verifier ||
    existing.createdAt !== envelope.createdAt ||
    existing.confirmedAt !== null ||
    existing.revokedAt !== null ||
    envelope.confirmedAt === null ||
    envelope.revokedAt !== null
  ) {
    throw validationError("Cloud recovery-envelope metadata conflicts with local history.");
  }
  const updated = await transaction.execute(
    `UPDATE project_recovery_key_envelopes
     SET status = 'confirmed', confirmed_at = ?
     WHERE recovery_id = ?
       AND status = 'pending_confirmation'
       AND confirmed_at IS NULL
       AND revoked_at IS NULL`,
    [envelope.confirmedAt, envelope.recoveryId],
  );
  if (updated.rowsAffected !== 1) {
    throw concurrencyError("The recovery envelope changed during cloud reconciliation.");
  }
}

async function requireMatchingCloudProjectKeyPublication(
  transaction: TransactionExecutor,
  keySet: CloudProjectKeySet,
  idempotencyKey: string,
): Promise<CloudProjectKeyPublication> {
  const publication = await requireCloudProjectKeyPublication(
    transaction,
    keySet.projectId,
    keySet.keyVersion,
    idempotencyKey,
  );
  if (!(await cloudProjectKeySetMatchesPublication(keySet, publication))) {
    throw validationError("The cloud project-key response does not match its durable request.");
  }
  return publication;
}

async function requireCloudProjectKeyPublication(
  transaction: TransactionExecutor,
  projectId: string,
  keyVersion: number,
  idempotencyKey: string,
): Promise<CloudProjectKeyPublication> {
  const row = await findCloudProjectKeyPublication(transaction, projectId, keyVersion);
  if (row === null) {
    throw notFoundError("The durable project-key publication does not exist.");
  }
  const publication = rehydrateCloudProjectKeyPublication(row);
  if (publication.idempotencyKey !== idempotencyKey) {
    throw concurrencyError("The durable project-key publication changed.");
  }
  return publication;
}

async function cloudProjectKeySetMatchesPublication(
  keySet: CloudProjectKeySet,
  publication: CloudProjectKeyPublication,
): Promise<boolean> {
  const request = publication.request;
  const expectedServerRevision = request.expectedServerRevision ?? 0;
  const publicationRequestSha256 = await hashCloudProjectKeyPublication(
    publication.projectId,
    publication.keyVersion,
    request,
  );
  return (
    keySet.projectId === publication.projectId &&
    keySet.keyVersion === publication.keyVersion &&
    keySet.serverRevision === expectedServerRevision + 1 &&
    keySet.publication.publicationRequestSha256 === publicationRequestSha256 &&
    JSON.stringify(keySet.version) === JSON.stringify(request.version) &&
    JSON.stringify(keySet.recoveryEnvelope) === JSON.stringify(request.recoveryEnvelope) &&
    JSON.stringify([...keySet.deviceEnvelopes].sort(compareDeviceEnvelopes)) ===
      JSON.stringify([...request.deviceEnvelopes].sort(compareDeviceEnvelopes))
  );
}

async function cloudProjectKeyPublicationReceiptMatches(
  publication: CloudProjectKeyPublication,
  receipt: CloudProjectKeyPublicationReceipt,
): Promise<boolean> {
  const publicationRequestSha256 = await hashCloudProjectKeyPublication(
    publication.projectId,
    publication.keyVersion,
    publication.request,
  );
  return (
    receipt.projectId === publication.projectId &&
    receipt.keyVersion === publication.keyVersion &&
    receipt.serverRevision === (publication.expectedServerRevision ?? 0) + 1 &&
    receipt.publicationRequestSha256 === publicationRequestSha256
  );
}

async function assertCloudProjectKeyPublicationRebaseAnchor(
  transaction: TransactionExecutor,
  publication: CloudProjectKeyPublication,
  observedCurrentPublication: CloudProjectKeyPublicationReceipt | null,
): Promise<void> {
  const checkpoint = await findCloudProjectKeyCheckpoint(transaction, publication.projectId);
  if (publication.expectedServerRevision === null) {
    if (
      publication.keyVersion !== 1 ||
      checkpoint !== null ||
      observedCurrentPublication !== null
    ) {
      throw validationError(
        "An initial publication can only be rebased after observing an absent cloud project.",
      );
    }
    return;
  }
  if (
    checkpoint?.current_key_version !== publication.keyVersion - 1 ||
    checkpoint.server_revision !== publication.expectedServerRevision ||
    observedCurrentPublication?.projectId !== publication.projectId ||
    observedCurrentPublication.keyVersion !== publication.keyVersion - 1 ||
    observedCurrentPublication.serverRevision !== publication.expectedServerRevision
  ) {
    throw validationError(
      "The immutable cloud publication receipt is not the durable journal predecessor.",
    );
  }
}

async function saveDeviceEnvelopeRecord(
  transaction: TransactionExecutor,
  envelope: DeviceProjectKeyEnvelopeContract,
  allowRevocation = false,
): Promise<void> {
  const existingRow = await findDeviceEnvelopeRow(transaction, envelope.envelopeId);
  if (existingRow !== null) {
    const existing = rehydrateDeviceEnvelope(existingRow);
    if (JSON.stringify(existing) === JSON.stringify(envelope)) {
      return;
    }
    if (
      !allowRevocation ||
      existing.revokedAt !== null ||
      envelope.revokedAt === null ||
      !sameDeviceEnvelopeCiphertext(existing, envelope)
    ) {
      throw validationError("A device-envelope identifier contains other ciphertext.");
    }
    const updated = await transaction.execute(
      `UPDATE project_device_key_envelopes
       SET revoked_at = ?
       WHERE envelope_id = ? AND revoked_at IS NULL`,
      [envelope.revokedAt, envelope.envelopeId],
    );
    if (updated.rowsAffected !== 1) {
      throw concurrencyError("The device envelope changed during cloud reconciliation.");
    }
    return;
  }
  await insertDeviceEnvelope(transaction, envelope);
}

function sameDeviceEnvelopeCiphertext(
  left: DeviceProjectKeyEnvelopeContract,
  right: DeviceProjectKeyEnvelopeContract,
): boolean {
  const { revokedAt: leftRevokedAt, ...leftCiphertext } = left;
  const { revokedAt: rightRevokedAt, ...rightCiphertext } = right;
  void leftRevokedAt;
  void rightRevokedAt;
  return JSON.stringify(leftCiphertext) === JSON.stringify(rightCiphertext);
}

async function insertProjectKeyVersion(
  executor: TransactionExecutor,
  version: ProjectKeyVersionContract,
): Promise<void> {
  await executor.execute(
    `INSERT INTO project_key_versions (
       project_id, key_version, schema_version, algorithm, state,
       revision, created_at, retired_at
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      version.projectId,
      version.keyVersion,
      version.algorithm,
      version.state,
      version.revision,
      version.createdAt,
      version.retiredAt,
    ],
  );
}

async function insertDeviceEnvelope(
  executor: TransactionExecutor,
  envelope: DeviceProjectKeyEnvelopeContract,
): Promise<void> {
  await executor.execute(
    `INSERT INTO project_device_key_envelopes (
       envelope_id, project_id, key_version, schema_version, algorithm,
       sender_device_id, sender_public_key, sender_public_key_fingerprint,
       recipient_device_id, recipient_public_key, recipient_public_key_fingerprint,
       encapsulated_key, ciphertext, created_at, revoked_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      envelope.envelopeId,
      envelope.projectId,
      envelope.keyVersion,
      envelope.algorithm,
      envelope.senderDeviceId,
      envelope.senderPublicKey,
      envelope.senderPublicKeyFingerprint,
      envelope.recipientDeviceId,
      envelope.recipientPublicKey,
      envelope.recipientPublicKeyFingerprint,
      envelope.encapsulatedKey,
      envelope.ciphertext,
      envelope.createdAt,
      envelope.revokedAt,
    ],
  );
}

async function insertRecoveryEnvelope(
  executor: TransactionExecutor,
  envelope: RecoveryProjectKeyEnvelopeContract,
  status: "pending_confirmation" | "confirmed" | "revoked",
): Promise<void> {
  await executor.execute(
    `INSERT INTO project_recovery_key_envelopes (
       recovery_id, project_id, key_version, schema_version, algorithm,
       kdf_algorithm, kdf_version, memory_kib, time_cost, parallelism,
       output_bytes, salt, nonce, ciphertext, verifier, status,
       created_at, confirmed_at, revoked_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      envelope.recoveryId,
      envelope.projectId,
      envelope.keyVersion,
      envelope.algorithm,
      envelope.kdf.algorithm,
      envelope.kdf.version,
      envelope.kdf.memoryKib,
      envelope.kdf.timeCost,
      envelope.kdf.parallelism,
      envelope.kdf.outputBytes,
      envelope.salt,
      envelope.nonce,
      envelope.ciphertext,
      envelope.verifier,
      status,
      envelope.createdAt,
      envelope.confirmedAt,
      envelope.revokedAt,
    ],
  );
}

async function supersedeOtherActiveTeamReceipts(
  transaction: TransactionExecutor,
  input: SaveTeamProjectKeyReceiptInput,
): Promise<void> {
  await transaction.execute(
    `UPDATE team_project_key_receipts
     SET state = 'superseded', state_updated_at = ?
     WHERE team_id = ?
       AND project_id = ?
       AND account_id = ?
       AND device_id = ?
       AND state = 'active'
       AND native_storage_ref <> ?`,
    [
      input.receivedAt,
      input.teamId,
      input.projectId,
      input.accountId,
      input.deviceId,
      input.nativeStorageRef,
    ],
  );
}

async function requireTeamProjectKeyReceiptByStorageRef(
  executor: TransactionExecutor,
  nativeStorageRef: string,
): Promise<TeamProjectKeyReceiptMetadata> {
  const rows = await executor.select<TeamProjectKeyReceiptDbRow>(
    `SELECT *
     FROM team_project_key_receipts
     WHERE native_storage_ref = ?
     LIMIT 1`,
    [nativeStorageRef],
  );
  if (rows[0] === undefined) {
    throw concurrencyError("The team project-key receipt disappeared during the transaction.");
  }
  return rehydrateTeamProjectKeyReceipt(rows[0]);
}

async function loadBundleWithinTransaction(
  executor: TransactionExecutor,
  projectId: string,
  keyVersion: number,
  deviceId: string | null,
): Promise<ProjectKeyBundle> {
  const versionRow = await findProjectKeyVersionRow(executor, projectId, keyVersion);
  const deviceRows = await executor.select<DeviceEnvelopeDbRow>(
    `SELECT *
     FROM project_device_key_envelopes
     WHERE project_id = ?
       AND key_version = ?
       AND revoked_at IS NULL
       ${deviceId === null ? "" : "AND recipient_device_id = ?"}
     ORDER BY created_at DESC, envelope_id DESC
     LIMIT 1`,
    deviceId === null ? [projectId, keyVersion] : [projectId, keyVersion, deviceId],
  );
  const recoveryRows = await executor.select<RecoveryEnvelopeDbRow>(
    `SELECT *
     FROM project_recovery_key_envelopes
     WHERE project_id = ?
       AND key_version = ?
       AND status <> 'revoked'
     ORDER BY created_at DESC, recovery_id DESC
     LIMIT 1`,
    [projectId, keyVersion],
  );
  if (versionRow === null || deviceRows[0] === undefined || recoveryRows[0] === undefined) {
    throw repositoryCorruptionError("The project key bundle is incomplete.");
  }
  return {
    version: rehydrateProjectKeyVersion(versionRow),
    deviceEnvelope: rehydrateDeviceEnvelope(deviceRows[0]),
    recoveryEnvelope: rehydrateRecoveryEnvelope(recoveryRows[0]),
  };
}

async function findDevicePublicKeyRow(
  executor: TransactionExecutor,
  deviceId: string,
): Promise<DevicePublicKeyDbRow | null> {
  const rows = await executor.select<DevicePublicKeyDbRow>(
    "SELECT * FROM device_public_key_records WHERE device_id = ? LIMIT 1",
    [deviceId],
  );
  return rows[0] ?? null;
}

async function findProjectKeyVersionRow(
  executor: TransactionExecutor,
  projectId: string,
  keyVersion: number,
): Promise<ProjectKeyVersionDbRow | null> {
  const rows = await executor.select<ProjectKeyVersionDbRow>(
    `SELECT *
     FROM project_key_versions
     WHERE project_id = ? AND key_version = ?
     LIMIT 1`,
    [projectId, keyVersion],
  );
  return rows[0] ?? null;
}

async function findCloudProjectKeyCheckpoint(
  executor: TransactionExecutor,
  projectId: string,
): Promise<CloudProjectKeyCheckpointDbRow | null> {
  const rows = await executor.select<CloudProjectKeyCheckpointDbRow>(
    `SELECT project_id, current_key_version, server_revision, updated_at
     FROM cloud_project_key_checkpoints
     WHERE project_id = ?
     LIMIT 1`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function findCloudProjectKeyPublication(
  executor: TransactionExecutor,
  projectId: string,
  keyVersion: number,
): Promise<CloudProjectKeyPublicationDbRow | null> {
  const rows = await executor.select<CloudProjectKeyPublicationDbRow>(
    `SELECT project_id, key_version, idempotency_key, expected_server_revision,
            request_json, state, created_at, updated_at, last_error_code
     FROM cloud_project_key_publications
     WHERE project_id = ? AND key_version = ?
     LIMIT 1`,
    [projectId, keyVersion],
  );
  return rows[0] ?? null;
}

async function findDeviceEnvelopeRow(
  executor: TransactionExecutor,
  envelopeId: string,
): Promise<DeviceEnvelopeDbRow | null> {
  const rows = await executor.select<DeviceEnvelopeDbRow>(
    "SELECT * FROM project_device_key_envelopes WHERE envelope_id = ? LIMIT 1",
    [envelopeId],
  );
  return rows[0] ?? null;
}

async function findRecoveryEnvelopeRow(
  executor: TransactionExecutor,
  recoveryId: string,
): Promise<RecoveryEnvelopeDbRow | null> {
  const rows = await executor.select<RecoveryEnvelopeDbRow>(
    "SELECT * FROM project_recovery_key_envelopes WHERE recovery_id = ? LIMIT 1",
    [recoveryId],
  );
  return rows[0] ?? null;
}

function rehydrateDevicePublicKey(row: DevicePublicKeyDbRow): DevicePublicKeyRecord {
  return normalizeDevicePublicKey({
    schemaVersion: row.schema_version as 1,
    deviceId: row.device_id,
    accountId: row.account_id,
    algorithm: row.algorithm as "DHKEM-P256-HKDF-SHA256",
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    displayName: row.display_name,
    keyOrigin: row.key_origin as DevicePublicKeyOrigin,
    state: row.state as DevicePublicKeyState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
}

function rehydrateProjectKeyVersion(row: ProjectKeyVersionDbRow): ProjectKeyVersionContract {
  return parseStoredWithSchema(ProjectKeyVersionContractSchema, {
    schemaVersion: row.schema_version,
    projectId: row.project_id,
    keyVersion: row.key_version,
    algorithm: row.algorithm,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  });
}

function rehydrateDeviceEnvelope(row: DeviceEnvelopeDbRow): DeviceProjectKeyEnvelopeContract {
  return parseStoredWithSchema(DeviceProjectKeyEnvelopeContractSchema, {
    schemaVersion: row.schema_version,
    algorithm: row.algorithm,
    envelopeId: row.envelope_id,
    projectId: row.project_id,
    keyVersion: row.key_version,
    senderDeviceId: row.sender_device_id,
    senderPublicKey: row.sender_public_key,
    senderPublicKeyFingerprint: row.sender_public_key_fingerprint,
    recipientDeviceId: row.recipient_device_id,
    recipientPublicKey: row.recipient_public_key,
    recipientPublicKeyFingerprint: row.recipient_public_key_fingerprint,
    encapsulatedKey: row.encapsulated_key,
    ciphertext: row.ciphertext,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  });
}

function rehydrateRecoveryEnvelope(row: RecoveryEnvelopeDbRow): RecoveryProjectKeyEnvelopeContract {
  return parseStoredWithSchema(RecoveryProjectKeyEnvelopeContractSchema, {
    schemaVersion: row.schema_version,
    algorithm: row.algorithm,
    recoveryId: row.recovery_id,
    projectId: row.project_id,
    keyVersion: row.key_version,
    kdf: {
      algorithm: row.kdf_algorithm,
      version: row.kdf_version,
      memoryKib: row.memory_kib,
      timeCost: row.time_cost,
      parallelism: row.parallelism,
      outputBytes: row.output_bytes,
    },
    salt: row.salt,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    verifier: row.verifier,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    revokedAt: row.revoked_at,
  });
}

function rehydrateTeamProjectKeyReceipt(
  row: TeamProjectKeyReceiptDbRow,
): TeamProjectKeyReceiptMetadata {
  const normalized = normalizeTeamProjectKeyReceipt({
    schemaVersion: row.schema_version as 1,
    receiptKind: row.receipt_kind as "team_managed_device_envelope",
    teamId: row.team_id,
    projectId: row.project_id,
    keyVersion: row.key_version,
    accountId: row.account_id,
    deviceId: row.device_id,
    envelopeId: row.envelope_id,
    membershipId: row.membership_id,
    membershipRevision: row.membership_revision,
    assignmentId: row.assignment_id,
    assignmentRevision: row.assignment_revision,
    senderDeviceId: row.sender_device_id,
    senderPublicKeyFingerprint: row.sender_public_key_fingerprint,
    recipientPublicKeyFingerprint: row.recipient_public_key_fingerprint,
    projectKeyFingerprint: row.project_key_fingerprint,
    nativeStorageRef: row.native_storage_ref,
    nativeReceiptFingerprint: row.native_receipt_fingerprint,
    currentServerRevision: row.current_server_revision,
    currentKeyUpdatedAt: row.current_key_updated_at,
    envelopeCreatedAt: row.envelope_created_at,
    receivedAt: row.received_at,
  });
  const lastVerifiedAt = parseTimestamp(row.last_verified_at, "lastVerifiedAt");
  const stateUpdatedAt = parseTimestamp(row.state_updated_at, "stateUpdatedAt");
  if (
    !["active", "superseded", "authority_unavailable", "credential_missing"].includes(row.state) ||
    Date.parse(lastVerifiedAt) < Date.parse(normalized.receivedAt) ||
    Date.parse(stateUpdatedAt) < Date.parse(normalized.receivedAt)
  ) {
    throw repositoryCorruptionError("Stored team project-key receipt metadata is inconsistent.");
  }
  return {
    ...normalized,
    state: row.state as TeamProjectKeyReceiptState,
    lastVerifiedAt,
    stateUpdatedAt,
  };
}

function rehydrateCloudProjectKeyPublication(
  row: CloudProjectKeyPublicationDbRow,
): CloudProjectKeyPublication {
  let parsedRequest: unknown;
  try {
    parsedRequest = JSON.parse(row.request_json) as unknown;
  } catch {
    throw repositoryCorruptionError("Stored cloud project-key publication JSON is invalid.");
  }
  const request = parseStoredWithSchema(CloudProjectKeyPublishRequestSchema, parsedRequest);
  const projectId = parseUuid(row.project_id, "projectId");
  const keyVersion = parsePositiveInteger(row.key_version, "keyVersion");
  const idempotencyKey = parseUuid(row.idempotency_key, "idempotencyKey");
  const expectedServerRevision =
    row.expected_server_revision === null
      ? null
      : parsePositiveInteger(row.expected_server_revision, "expectedServerRevision");
  const createdAt = parseTimestamp(row.created_at, "createdAt");
  const updatedAt = parseTimestamp(row.updated_at, "updatedAt");
  if (
    !["pending", "conflicted"].includes(row.state) ||
    request.version.projectId !== projectId ||
    request.version.keyVersion !== keyVersion ||
    request.expectedServerRevision !== expectedServerRevision ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (row.state === "pending") !== (row.last_error_code === null)
  ) {
    throw repositoryCorruptionError("Stored cloud project-key publication is inconsistent.");
  }
  return {
    projectId,
    keyVersion,
    idempotencyKey,
    expectedServerRevision,
    request,
    state: row.state as CloudProjectKeyPublication["state"],
    createdAt,
    updatedAt,
    lastErrorCode: row.last_error_code,
  };
}

function parseUuid(value: string, field: string): string {
  return parseField(UuidV7Schema, value, field);
}

function parseTimestamp(value: string, field: string): string {
  return parseField(IsoUtcTimestampSchema, value, field);
}

function parsePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw validationError(`${field} must be a positive 32-bit integer.`);
  }
  return value;
}

function parsePortablePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive portable integer.`);
  }
  return value;
}

function parseField(
  schema: { safeParse(value: unknown): { success: true; data: string } | { success: false } },
  value: unknown,
  field: string,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} is invalid.`);
  }
  return parsed.data;
}

function parseWithSchema<Output>(
  schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false } },
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The project key contract is invalid.");
  }
  return parsed.data;
}

function parseStoredWithSchema<Output>(
  schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false } },
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw repositoryCorruptionError("Stored project key metadata is invalid.");
  }
  return parsed.data;
}

function buildStatusCounts<const Status extends string>(
  statuses: readonly Status[],
  rows: readonly StatusCountRow[],
): Readonly<Record<Status, number>> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  for (const row of rows) {
    if (!statuses.includes(row.status as Status)) {
      throw repositoryCorruptionError("Stored project key status is invalid.");
    }
    counts[row.status as Status] = requireCount(row.count);
  }
  return counts;
}

function requireCount(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw repositoryCorruptionError("Stored project key count is invalid.");
  }
  return value;
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
        message: "The local project-key store could not complete the operation.",
        retryable: true,
        actions: ["RETRY", "CONTACT_SUPPORT"],
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

function repositoryCorruptionError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    details: { operation: "PROJECT_KEY_LOCAL_RECORD_INVALID" },
  });
}
