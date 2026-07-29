import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type DeviceProjectKeyEnvelopeContract,
  type EncryptedSyncChunkContract,
  type ProjectKeyVersionContract,
  type RecoveryProjectKeyEnvelopeContract,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";

import type {
  CloudProjectAccessRecord,
  CloudProjectKeySetRecord,
  CloudProjectRecord,
  CloudSyncBatchRecord,
  PersistedSyncChunk,
  PersistedSyncOperation,
  PersistedSyncTombstone,
} from "../domain/project-records.js";
import type {
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
  IdempotencyResultKind,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type { CloudProjectStore, CloudProjectTransaction } from "../repository/project-store.js";
import { hashCanonicalJson } from "../security/canonical-hash.js";

interface ProjectRow extends QueryResultRow {
  readonly created_at: Date;
  readonly current_key_version: number | null;
  readonly deletion_scheduled_for: Date | null;
  readonly minimum_available_remote_sequence: string;
  readonly owner_account_id: string;
  readonly project_id: string;
  readonly revision: string;
  readonly state: CloudProjectRecord["state"];
  readonly sync_compaction_epoch: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface AccessRow extends QueryResultRow {
  readonly account_id: string;
  readonly can_manage_keys: boolean;
  readonly can_sync: boolean;
  readonly created_at: Date;
  readonly project_id: string;
  readonly revision: string;
  readonly revoked_at: Date | null;
  readonly role: CloudProjectAccessRecord["role"];
  readonly tenant_id: string;
}

interface DeviceRow extends QueryResultRow {
  readonly account_id: string;
  readonly algorithm: "DHKEM-P256-HKDF-SHA256";
  readonly client_version: string;
  readonly created_at: Date;
  readonly device_id: string;
  readonly display_name: string;
  readonly public_key: string;
  readonly public_key_fingerprint: string;
  readonly revision: string;
  readonly revoked_at: Date | null;
  readonly state: "revoked" | "trusted";
  readonly updated_at: Date;
}

interface KeyVersionRow extends QueryResultRow {
  readonly algorithm: "AES-256-GCM";
  readonly client_revision: string;
  readonly created_at: Date;
  readonly key_version: number;
  readonly project_id: string;
  readonly publication_published_at: Date | null;
  readonly publication_request_sha256: string | null;
  readonly recovery_algorithm: "ARGON2ID-AES256GCM";
  readonly recovery_ciphertext: string;
  readonly recovery_confirmed_at: Date;
  readonly recovery_created_at: Date;
  readonly recovery_id: string;
  readonly recovery_nonce: string;
  readonly recovery_revoked_at: Date | null;
  readonly recovery_salt: string;
  readonly recovery_verifier: string;
  readonly retired_at: Date | null;
  readonly server_revision: string;
  readonly state: "active" | "retired" | "retiring";
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface DeviceEnvelopeRow extends QueryResultRow {
  readonly algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM";
  readonly ciphertext: string;
  readonly created_at: Date;
  readonly encapsulated_key: string;
  readonly envelope_id: string;
  readonly key_version: number;
  readonly project_id: string;
  readonly recipient_device_id: string;
  readonly recipient_public_key: string;
  readonly recipient_public_key_fingerprint: string;
  readonly revoked_at: Date | null;
  readonly sender_device_id: string;
  readonly sender_public_key: string;
  readonly sender_public_key_fingerprint: string;
  readonly tenant_id: string;
}

interface OperationRow extends QueryResultRow {
  readonly created_at: Date;
  readonly device_id: string;
  readonly device_sequence: string;
  readonly encrypted_chunk_ids: string[];
  readonly kind: "delete" | "upsert";
  readonly object_generation: number;
  readonly object_id: string;
  readonly object_type: SyncOperationContract["objectType"];
  readonly operation_id: string;
  readonly project_id: string;
  readonly received_at: Date;
  readonly remote_sequence: string;
  readonly tenant_id: string;
  readonly version_vector: Readonly<Record<string, number>>;
}

interface ChunkRow extends QueryResultRow {
  readonly algorithm: "AES-256-GCM";
  readonly chunk_id: string;
  readonly chunk_index: number;
  readonly ciphertext: string;
  readonly ciphertext_sha256: string;
  readonly key_version: number;
  readonly nonce: string;
  readonly object_id: string;
  readonly object_type: EncryptedSyncChunkContract["aad"]["objectType"];
  readonly operation_id: string;
  readonly plaintext_bytes: number;
  readonly project_id: string;
  readonly tenant_id: string;
  readonly version_id: string;
}

interface TombstoneRow extends QueryResultRow {
  readonly acknowledged_device_ids: string[];
  readonly deleted_at: Date;
  readonly deleted_by_device_id: string;
  readonly object_generation: number;
  readonly object_id: string;
  readonly object_type: SyncTombstoneContract["objectType"];
  readonly operation_id: string;
  readonly project_id: string;
  readonly retain_until: Date;
  readonly tenant_id: string;
  readonly version_vector: Readonly<Record<string, number>>;
}

interface SyncBatchRow extends QueryResultRow {
  readonly accepted_operations: unknown;
  readonly account_id: string;
  readonly batch_id: string;
  readonly device_id: string;
  readonly project_id: string;
  readonly remote_sequence: string;
  readonly server_time: Date;
  readonly tenant_id: string;
}

interface IdempotencyRow extends QueryResultRow {
  readonly actor_account_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly idempotency_key_hash_sha256: string;
  readonly operation_id: CloudIdempotencyRecord["operationId"];
  readonly request_hash_sha256: string;
  readonly response_snapshot: unknown;
  readonly response_status: number;
  readonly result_digest_sha256: string;
  readonly result_kind: IdempotencyResultKind;
  readonly result_resource_id: string | null;
  readonly scope_hash_sha256: string;
}

export class PostgresCloudProjectStore implements CloudProjectStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudProjectTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudProjectTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresCloudProjectTransaction implements CloudProjectTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async setTenant(tenantId: string): Promise<void> {
    await this.client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
  }

  public async lockIdempotency(scopeHashSha256: string): Promise<void> {
    const signedLockId = BigInt.asIntN(64, BigInt(`0x${scopeHashSha256.slice(0, 16)}`));
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [signedLockId.toString()]);
  }

  public async lockSyncDeviceSequence(
    tenantId: string,
    projectId: string,
    deviceId: string,
  ): Promise<void> {
    const scopeHashSha256 = hashCanonicalJson({
      domain: "sync-device-sequence",
      tenantId,
      projectId,
      deviceId,
    });
    const signedLockId = BigInt.asIntN(64, BigInt(`0x${scopeHashSha256.slice(0, 16)}`));
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [signedLockId.toString()]);
  }

  public async findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null> {
    const result = await this.client.query<IdempotencyRow>(
      `SELECT *
       FROM cloud_idempotency_records
       WHERE scope_hash_sha256 = $1`,
      [scopeHashSha256],
    );
    return result.rows[0] === undefined ? null : mapIdempotency(result.rows[0]);
  }

  public async insertIdempotency(record: CloudIdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_idempotency_records (
         scope_hash_sha256,
         actor_account_id,
         operation_id,
         idempotency_key_hash_sha256,
         request_hash_sha256,
         response_snapshot,
         result_kind,
         result_resource_id,
         result_digest_sha256,
         response_status,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.scopeHashSha256,
        record.actorAccountId,
        record.operationId,
        record.idempotencyKeyHashSha256,
        record.requestHashSha256,
        record.responseSnapshot,
        record.resultKind,
        record.resultResourceId,
        record.resultDigestSha256,
        record.responseStatus,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  public async findProject(
    tenantId: string,
    projectId: string,
    forUpdate = false,
  ): Promise<CloudProjectRecord | null> {
    const result = await this.client.query<ProjectRow>(
      `SELECT *
       FROM cloud_projects
       WHERE tenant_id = $1
         AND project_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, projectId],
    );
    return result.rows[0] === undefined ? null : mapProject(result.rows[0]);
  }

  public async findProjectForSnapshot(
    tenantId: string,
    projectId: string,
  ): Promise<CloudProjectRecord | null> {
    const result = await this.client.query<ProjectRow>(
      `SELECT *
       FROM cloud_projects
       WHERE tenant_id = $1
         AND project_id = $2
       FOR SHARE`,
      [tenantId, projectId],
    );
    return result.rows[0] === undefined ? null : mapProject(result.rows[0]);
  }

  public async insertProject(record: CloudProjectRecord): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO cloud_projects (
         tenant_id,
         project_id,
         owner_account_id,
         state,
         current_key_version,
         minimum_available_remote_sequence,
         sync_compaction_epoch,
         revision,
         created_at,
         updated_at,
         deletion_scheduled_for
       ) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING
       RETURNING project_id`,
      [
        record.tenantId,
        record.projectId,
        record.ownerAccountId,
        record.state,
        record.currentKeyVersion,
        record.minimumAvailableRemoteSequence.toString(),
        record.syncCompactionEpoch.toString(),
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.deletionScheduledFor,
      ],
    );
    return result.rowCount === 1;
  }

  public async updateProject(record: CloudProjectRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_projects
       SET state = $3,
           current_key_version = $4,
           revision = $5,
           updated_at = $6,
           deletion_scheduled_for = $7
       WHERE tenant_id = $1
         AND project_id = $2`,
      [
        record.tenantId,
        record.projectId,
        record.state,
        record.currentKeyVersion,
        record.revision,
        record.updatedAt,
        record.deletionScheduledFor,
      ],
    );
    requireAffectedRow(result.rowCount, "cloud project");
  }

  public async findProjectAccess(
    tenantId: string,
    projectId: string,
    accountId: string,
    forUpdate = false,
  ): Promise<CloudProjectAccessRecord | null> {
    const result = await this.client.query<AccessRow>(
      `SELECT *
       FROM cloud_project_access
       WHERE tenant_id = $1
         AND project_id = $2
         AND account_id = $3${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, projectId, accountId],
    );
    return result.rows[0] === undefined ? null : mapAccess(result.rows[0]);
  }

  public async insertProjectAccess(record: CloudProjectAccessRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_project_access (
         tenant_id,
         project_id,
         account_id,
         role,
         can_manage_keys,
         can_sync,
         revision,
         created_at,
         revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.tenantId,
        record.projectId,
        record.accountId,
        record.role,
        record.canManageKeys,
        record.canSync,
        record.revision,
        record.createdAt,
        record.revokedAt,
      ],
    );
  }

  public async findDevice(
    deviceId: string,
    forUpdate = false,
  ): Promise<RegisteredDeviceRecord | null> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE device_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [deviceId],
    );
    return result.rows[0] === undefined ? null : mapDevice(result.rows[0]);
  }

  public async findDevices(
    deviceIds: readonly string[],
  ): Promise<readonly RegisteredDeviceRecord[]> {
    if (deviceIds.length === 0) {
      return [];
    }
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE device_id = ANY($1::uuid[])
       ORDER BY device_id`,
      [deviceIds],
    );
    return result.rows.map(mapDevice);
  }

  public async listTrustedDevices(accountId: string): Promise<readonly RegisteredDeviceRecord[]> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE account_id = $1
         AND state = 'trusted'
       ORDER BY device_id`,
      [accountId],
    );
    return result.rows.map(mapDevice);
  }

  public async revokeRecipientDeviceEnvelopes(
    tenantId: string,
    recipientDeviceId: string,
    revokedAt: Date,
  ): Promise<number> {
    const result = await this.client.query(
      `UPDATE device_project_key_envelopes
       SET revoked_at = $3
       WHERE tenant_id = $1
         AND recipient_device_id = $2
         AND revoked_at IS NULL`,
      [tenantId, recipientDeviceId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  public async findProjectKeySet(
    tenantId: string,
    projectId: string,
    keyVersion: number,
  ): Promise<CloudProjectKeySetRecord | null> {
    const versionResult = await this.client.query<KeyVersionRow>(
      `SELECT *
       FROM project_key_versions
       WHERE tenant_id = $1
         AND project_id = $2
         AND key_version = $3`,
      [tenantId, projectId, keyVersion],
    );
    const row = versionResult.rows[0];
    if (row === undefined) {
      return null;
    }
    const envelopeResult = await this.client.query<DeviceEnvelopeRow>(
      `SELECT *
       FROM device_project_key_envelopes
       WHERE tenant_id = $1
         AND project_id = $2
         AND key_version = $3
       ORDER BY recipient_device_id`,
      [tenantId, projectId, keyVersion],
    );
    return mapKeySet(row, envelopeResult.rows);
  }

  public async insertProjectKeySet(record: CloudProjectKeySetRecord): Promise<void> {
    const recovery = record.recoveryEnvelope;
    await this.client.query(
      `INSERT INTO project_key_versions (
         tenant_id,
         project_id,
         key_version,
         server_revision,
         algorithm,
         state,
         client_revision,
         recovery_id,
         recovery_algorithm,
         recovery_salt,
         recovery_nonce,
         recovery_ciphertext,
         recovery_verifier,
         recovery_created_at,
         recovery_confirmed_at,
         recovery_revoked_at,
         publication_request_sha256,
         publication_published_at,
         created_at,
         updated_at,
         retired_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21
       )`,
      [
        record.tenantId,
        record.projectId,
        record.keyVersion,
        record.serverRevision,
        record.version.algorithm,
        record.version.state,
        record.version.revision,
        recovery.recoveryId,
        recovery.algorithm,
        recovery.salt,
        recovery.nonce,
        recovery.ciphertext,
        recovery.verifier,
        recovery.createdAt,
        recovery.confirmedAt,
        recovery.revokedAt,
        record.publication.publicationRequestSha256,
        record.publication.publishedAt,
        record.version.createdAt,
        record.updatedAt,
        record.version.retiredAt,
      ],
    );
    for (const envelope of record.deviceEnvelopes) {
      await this.client.query(
        `INSERT INTO device_project_key_envelopes (
           tenant_id,
           project_id,
           key_version,
           envelope_id,
           algorithm,
           sender_device_id,
           sender_public_key,
           sender_public_key_fingerprint,
           recipient_device_id,
           recipient_public_key,
           recipient_public_key_fingerprint,
           encapsulated_key,
           ciphertext,
           created_at,
           revoked_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15
         )`,
        [
          record.tenantId,
          record.projectId,
          record.keyVersion,
          envelope.envelopeId,
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
  }

  public async markProjectKeyRetiring(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    updatedAt: Date,
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE project_key_versions
       SET state = 'retiring',
           client_revision = client_revision + 1,
           updated_at = $4
       WHERE tenant_id = $1
         AND project_id = $2
         AND key_version = $3
         AND state = 'active'`,
      [tenantId, projectId, keyVersion, updatedAt],
    );
    requireAffectedRow(result.rowCount, "active project key");
  }

  public async findSyncOperation(
    tenantId: string,
    projectId: string,
    operationId: string,
  ): Promise<PersistedSyncOperation | null> {
    const result = await this.client.query<OperationRow>(
      `SELECT *
       FROM sync_operations
       WHERE tenant_id = $1
         AND project_id = $2
         AND operation_id = $3`,
      [tenantId, projectId, operationId],
    );
    return result.rows[0] === undefined ? null : mapOperation(result.rows[0]);
  }

  public async findLatestDeviceSequence(
    tenantId: string,
    projectId: string,
    deviceId: string,
  ): Promise<number> {
    const result = await this.client.query<{ maximum_sequence: string }>(
      `SELECT COALESCE(MAX(device_sequence), 0)::text AS maximum_sequence
       FROM sync_operations
       WHERE tenant_id = $1
         AND project_id = $2
         AND device_id = $3`,
      [tenantId, projectId, deviceId],
    );
    return requireSafeInteger(result.rows[0]?.maximum_sequence ?? "0", "device sequence");
  }

  public async insertSyncOperation(
    tenantId: string,
    operation: SyncOperationContract,
    receivedAt: Date,
  ): Promise<bigint> {
    const result = await this.client.query<{ remote_sequence: string }>(
      `INSERT INTO sync_operations (
         tenant_id,
         project_id,
         operation_id,
         device_id,
         device_sequence,
         object_type,
         object_id,
         object_generation,
         kind,
         version_vector,
         encrypted_chunk_ids,
         created_at,
         received_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10::jsonb, $11::uuid[], $12, $13
       )
       RETURNING remote_sequence::text`,
      [
        tenantId,
        operation.projectId,
        operation.operationId,
        operation.deviceId,
        operation.deviceSequence,
        operation.objectType,
        operation.objectId,
        operation.objectGeneration,
        operation.kind,
        JSON.stringify(operation.vector),
        operation.encryptedChunkIds,
        operation.createdAt,
        receivedAt,
      ],
    );
    return requireBigInt(result.rows[0]?.remote_sequence, "remote sequence");
  }

  public async findSyncChunksForOperations(
    tenantId: string,
    projectId: string,
    operationIds: readonly string[],
  ): Promise<readonly PersistedSyncChunk[]> {
    if (operationIds.length === 0) {
      return [];
    }
    const result = await this.client.query<ChunkRow>(
      `SELECT *
       FROM sync_ciphertext_chunks
       WHERE tenant_id = $1
         AND project_id = $2
         AND operation_id = ANY($3::uuid[])
       ORDER BY operation_id, chunk_index`,
      [tenantId, projectId, operationIds],
    );
    return result.rows.map(mapChunk);
  }

  public async insertSyncChunks(chunks: readonly PersistedSyncChunk[]): Promise<void> {
    for (const chunk of chunks) {
      await this.client.query(
        `INSERT INTO sync_ciphertext_chunks (
           tenant_id,
           project_id,
           chunk_id,
           operation_id,
           algorithm,
           nonce,
           ciphertext,
           ciphertext_sha256,
           plaintext_bytes,
           object_type,
           object_id,
           version_id,
           chunk_index,
           key_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13, $14
         )`,
        [
          chunk.tenantId,
          chunk.encrypted.aad.projectId,
          chunk.chunkId,
          chunk.operationId,
          chunk.encrypted.algorithm,
          chunk.encrypted.nonce,
          chunk.encrypted.ciphertext,
          chunk.encrypted.ciphertextSha256,
          chunk.encrypted.plaintextBytes,
          chunk.encrypted.aad.objectType,
          chunk.encrypted.aad.objectId,
          chunk.encrypted.aad.versionId,
          chunk.encrypted.aad.chunkIndex,
          chunk.encrypted.aad.keyVersion,
        ],
      );
    }
  }

  public async insertSyncTombstone(tombstone: PersistedSyncTombstone): Promise<void> {
    await this.client.query(
      `INSERT INTO sync_tombstones (
         tenant_id,
         project_id,
         object_type,
         object_id,
         object_generation,
         operation_id,
         deleted_by_device_id,
         version_vector,
         deleted_at,
         retain_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        tombstone.tenantId,
        tombstone.tombstone.projectId,
        tombstone.tombstone.objectType,
        tombstone.tombstone.objectId,
        tombstone.tombstone.objectGeneration,
        tombstone.operationId,
        tombstone.tombstone.deletedByDeviceId,
        JSON.stringify(tombstone.tombstone.vector),
        tombstone.tombstone.deletedAt,
        tombstone.tombstone.retainUntil,
      ],
    );
  }

  public async findSyncTombstonesForOperations(
    tenantId: string,
    projectId: string,
    operationIds: readonly string[],
  ): Promise<readonly PersistedSyncTombstone[]> {
    if (operationIds.length === 0) {
      return [];
    }
    const result = await this.client.query<TombstoneRow>(
      `${tombstoneSelect()}
       WHERE t.tenant_id = $1
         AND t.project_id = $2
         AND t.operation_id = ANY($3::uuid[])
       GROUP BY
         t.tenant_id, t.project_id, t.object_type, t.object_id, t.object_generation,
         t.operation_id, t.deleted_by_device_id, t.version_vector,
         t.deleted_at, t.retain_until
       ORDER BY t.operation_id`,
      [tenantId, projectId, operationIds],
    );
    return result.rows.map(mapTombstone);
  }

  public async findSyncTombstone(
    tenantId: string,
    projectId: string,
    objectType: SyncTombstoneContract["objectType"],
    objectId: string,
    objectGeneration: number,
  ): Promise<PersistedSyncTombstone | null> {
    const result = await this.client.query<TombstoneRow>(
      `${tombstoneSelect()}
       WHERE t.tenant_id = $1
         AND t.project_id = $2
         AND t.object_type = $3
         AND t.object_id = $4
         AND t.object_generation = $5
       GROUP BY
         t.tenant_id, t.project_id, t.object_type, t.object_id, t.object_generation,
         t.operation_id, t.deleted_by_device_id, t.version_vector,
         t.deleted_at, t.retain_until`,
      [tenantId, projectId, objectType, objectId, objectGeneration],
    );
    return result.rows[0] === undefined ? null : mapTombstone(result.rows[0]);
  }

  public async acknowledgeSyncTombstone(
    tenantId: string,
    projectId: string,
    objectType: SyncTombstoneContract["objectType"],
    objectId: string,
    objectGeneration: number,
    deviceId: string,
    acknowledgedAt: Date,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO sync_tombstone_acknowledgements (
         tenant_id,
         project_id,
         object_type,
         object_id,
         object_generation,
         device_id,
         acknowledged_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (
         tenant_id,
         project_id,
         object_type,
         object_id,
         object_generation,
         device_id
       ) DO UPDATE
       SET acknowledged_at = GREATEST(
         sync_tombstone_acknowledgements.acknowledged_at,
         EXCLUDED.acknowledged_at
       )`,
      [tenantId, projectId, objectType, objectId, objectGeneration, deviceId, acknowledgedAt],
    );
  }

  public async listSyncOperations(
    tenantId: string,
    projectId: string,
    afterSequence: bigint,
    limit: number,
  ): Promise<readonly PersistedSyncOperation[]> {
    const result = await this.client.query<OperationRow>(
      `SELECT *
       FROM sync_operations
       WHERE tenant_id = $1
         AND project_id = $2
         AND remote_sequence > $3::bigint
       ORDER BY remote_sequence
       LIMIT $4`,
      [tenantId, projectId, afterSequence.toString(), limit],
    );
    return result.rows.map(mapOperation);
  }

  public async listCompleteSyncOperations(
    tenantId: string,
    projectId: string,
    afterSequence: bigint,
    throughSequence: bigint,
    limit: number,
  ): Promise<readonly PersistedSyncOperation[]> {
    const result = await this.client.query<OperationRow>(
      `SELECT operation.*
       FROM sync_operations AS operation
       WHERE operation.tenant_id = $1
         AND operation.project_id = $2
         AND operation.remote_sequence > $3::bigint
         AND operation.remote_sequence <= $4::bigint
         AND (
           (
             operation.kind = 'upsert'
             AND NOT EXISTS (
               SELECT 1
               FROM unnest(operation.encrypted_chunk_ids) AS expected(chunk_id)
               WHERE NOT EXISTS (
                 SELECT 1
                 FROM sync_ciphertext_chunks AS chunk
                 WHERE chunk.tenant_id = operation.tenant_id
                   AND chunk.project_id = operation.project_id
                   AND chunk.operation_id = operation.operation_id
                   AND chunk.object_type = operation.object_type
                   AND chunk.chunk_id = expected.chunk_id
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM sync_ciphertext_chunks AS chunk
               WHERE chunk.tenant_id = operation.tenant_id
                 AND chunk.project_id = operation.project_id
                 AND chunk.operation_id = operation.operation_id
                 AND (
                   chunk.object_type <> operation.object_type
                   OR NOT (chunk.chunk_id = ANY(operation.encrypted_chunk_ids))
                 )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM sync_tombstones AS tombstone
               WHERE tombstone.tenant_id = operation.tenant_id
                 AND tombstone.project_id = operation.project_id
                 AND tombstone.operation_id = operation.operation_id
                 AND tombstone.object_type = operation.object_type
             )
           )
           OR
           (
             operation.kind = 'delete'
             AND NOT EXISTS (
               SELECT 1
               FROM sync_ciphertext_chunks AS chunk
               WHERE chunk.tenant_id = operation.tenant_id
                 AND chunk.project_id = operation.project_id
                 AND chunk.operation_id = operation.operation_id
             )
             AND EXISTS (
               SELECT 1
               FROM sync_tombstones AS tombstone
               WHERE tombstone.tenant_id = operation.tenant_id
                 AND tombstone.project_id = operation.project_id
                 AND tombstone.operation_id = operation.operation_id
                 AND tombstone.object_type = operation.object_type
             )
           )
         )
       ORDER BY operation.remote_sequence
       LIMIT $5`,
      [tenantId, projectId, afterSequence.toString(), throughSequence.toString(), limit],
    );
    return result.rows.map(mapOperation);
  }

  public async getMaximumRemoteSequence(tenantId: string, projectId: string): Promise<bigint> {
    const result = await this.client.query<{ maximum_sequence: string }>(
      `SELECT COALESCE(MAX(remote_sequence), 0)::text AS maximum_sequence
       FROM sync_operations
       WHERE tenant_id = $1
         AND project_id = $2`,
      [tenantId, projectId],
    );
    return requireBigInt(result.rows[0]?.maximum_sequence, "maximum remote sequence");
  }

  public async insertSyncBatch(record: CloudSyncBatchRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_sync_batches (
         tenant_id,
         project_id,
         batch_id,
         account_id,
         device_id,
         accepted_operations,
         remote_sequence,
         server_time
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bigint, $8)`,
      [
        record.tenantId,
        record.projectId,
        record.batchId,
        record.accountId,
        record.deviceId,
        JSON.stringify(record.acceptedOperations),
        record.remoteSequence.toString(),
        record.serverTime,
      ],
    );
  }

  public async findSyncBatch(
    tenantId: string,
    projectId: string,
    batchId: string,
  ): Promise<CloudSyncBatchRecord | null> {
    const result = await this.client.query<SyncBatchRow>(
      `SELECT *
       FROM cloud_sync_batches
       WHERE tenant_id = $1
         AND project_id = $2
         AND batch_id = $3`,
      [tenantId, projectId, batchId],
    );
    return result.rows[0] === undefined ? null : mapSyncBatch(result.rows[0]);
  }

  public async insertAuditEvent(record: CloudAuditEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_audit_events (
         event_id,
         request_id,
         actor_account_id,
         actor_device_id,
         tenant_id,
         resource_type,
         resource_id,
         action,
         result,
         redacted_diff,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        record.eventId,
        record.requestId,
        record.actorAccountId,
        record.actorDeviceId,
        record.tenantId,
        record.resourceType,
        record.resourceId,
        record.action,
        record.result,
        JSON.stringify(record.redactedDiff),
        record.createdAt,
      ],
    );
  }
}

function mapProject(row: ProjectRow): CloudProjectRecord {
  return {
    createdAt: requireDate(row.created_at, "project created_at"),
    currentKeyVersion: nullableSafeInteger(row.current_key_version, "current key version"),
    deletionScheduledFor: nullableDate(
      row.deletion_scheduled_for,
      "project deletion_scheduled_for",
    ),
    minimumAvailableRemoteSequence: requireBigInt(
      row.minimum_available_remote_sequence,
      "minimum available remote sequence",
    ),
    ownerAccountId: row.owner_account_id,
    projectId: row.project_id,
    revision: requireSafeInteger(row.revision, "project revision"),
    state: row.state,
    syncCompactionEpoch: requireBigInt(row.sync_compaction_epoch, "sync compaction epoch"),
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "project updated_at"),
  };
}

function mapAccess(row: AccessRow): CloudProjectAccessRecord {
  return {
    accountId: row.account_id,
    canManageKeys: row.can_manage_keys,
    canSync: row.can_sync,
    createdAt: requireDate(row.created_at, "project access created_at"),
    projectId: row.project_id,
    revision: requireSafeInteger(row.revision, "project access revision"),
    revokedAt: nullableDate(row.revoked_at, "project access revoked_at"),
    role: row.role,
    tenantId: row.tenant_id,
  };
}

function mapDevice(row: DeviceRow): RegisteredDeviceRecord {
  return {
    accountId: row.account_id,
    algorithm: row.algorithm,
    clientVersion: row.client_version,
    createdAt: requireDate(row.created_at, "device created_at"),
    deviceId: row.device_id,
    displayName: row.display_name,
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    revision: requireSafeInteger(row.revision, "device revision"),
    revokedAt: nullableDate(row.revoked_at, "device revoked_at"),
    state: row.state,
    updatedAt: requireDate(row.updated_at, "device updated_at"),
  };
}

function mapKeySet(
  row: KeyVersionRow,
  envelopeRows: readonly DeviceEnvelopeRow[],
): CloudProjectKeySetRecord {
  if (
    row.publication_request_sha256 === null ||
    !/^[a-f0-9]{64}$/u.test(row.publication_request_sha256) ||
    row.publication_published_at === null
  ) {
    throw new Error("PostgreSQL returned a project key without an immutable publication receipt.");
  }
  const serverRevision = requireSafeInteger(row.server_revision, "project-key server revision");
  const version: ProjectKeyVersionContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectId: row.project_id,
    keyVersion: row.key_version,
    algorithm: row.algorithm,
    state: row.state,
    revision: requireSafeInteger(row.client_revision, "project-key client revision"),
    createdAt: requireDate(row.created_at, "project-key created_at").toISOString(),
    retiredAt: nullableDate(row.retired_at, "project-key retired_at")?.toISOString() ?? null,
  };
  const recoveryEnvelope: RecoveryProjectKeyEnvelopeContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    algorithm: row.recovery_algorithm,
    recoveryId: row.recovery_id,
    projectId: row.project_id,
    keyVersion: row.key_version,
    kdf: {
      algorithm: "ARGON2ID",
      version: 19,
      memoryKib: 65_536,
      timeCost: 3,
      parallelism: 4,
      outputBytes: 64,
    },
    salt: row.recovery_salt,
    nonce: row.recovery_nonce,
    ciphertext: row.recovery_ciphertext,
    verifier: row.recovery_verifier,
    createdAt: requireDate(row.recovery_created_at, "recovery envelope created_at").toISOString(),
    confirmedAt: requireDate(
      row.recovery_confirmed_at,
      "recovery envelope confirmed_at",
    ).toISOString(),
    revokedAt:
      nullableDate(row.recovery_revoked_at, "recovery envelope revoked_at")?.toISOString() ?? null,
  };
  return {
    deviceEnvelopes: envelopeRows.map(mapDeviceEnvelope),
    keyVersion: row.key_version,
    projectId: row.project_id,
    publication: {
      projectId: row.project_id,
      keyVersion: row.key_version,
      serverRevision,
      publicationRequestSha256: row.publication_request_sha256,
      publishedAt: requireDate(
        row.publication_published_at,
        "project-key publication timestamp",
      ).toISOString(),
    },
    recoveryEnvelope,
    serverRevision,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "project-key updated_at"),
    version,
  };
}

function mapDeviceEnvelope(row: DeviceEnvelopeRow): DeviceProjectKeyEnvelopeContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
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
    createdAt: requireDate(row.created_at, "device envelope created_at").toISOString(),
    revokedAt: nullableDate(row.revoked_at, "device envelope revoked_at")?.toISOString() ?? null,
  };
}

function mapOperation(row: OperationRow): PersistedSyncOperation {
  const operation: SyncOperationContract = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId: row.operation_id,
    projectId: row.project_id,
    deviceId: row.device_id,
    deviceSequence: requireSafeInteger(row.device_sequence, "device sequence"),
    objectType: row.object_type,
    objectId: row.object_id,
    objectGeneration: requireSafeInteger(row.object_generation, "object generation"),
    kind: row.kind,
    vector: row.version_vector,
    encryptedChunkIds: row.encrypted_chunk_ids,
    createdAt: requireDate(row.created_at, "operation created_at").toISOString(),
  };
  return {
    operation,
    receivedAt: requireDate(row.received_at, "operation received_at"),
    remoteSequence: requireBigInt(row.remote_sequence, "remote sequence"),
    tenantId: row.tenant_id,
  };
}

function mapChunk(row: ChunkRow): PersistedSyncChunk {
  return {
    chunkId: row.chunk_id,
    encrypted: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: row.algorithm,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      ciphertextSha256: row.ciphertext_sha256,
      plaintextBytes: requireSafeInteger(row.plaintext_bytes, "plaintext byte count"),
      aad: {
        projectId: row.project_id,
        objectType: row.object_type,
        objectId: row.object_id,
        versionId: row.version_id,
        chunkIndex: requireSafeInteger(row.chunk_index, "chunk index"),
        keyVersion: requireSafeInteger(row.key_version, "chunk key version"),
      },
    },
    operationId: row.operation_id,
    tenantId: row.tenant_id,
  };
}

function mapTombstone(row: TombstoneRow): PersistedSyncTombstone {
  const tombstone: SyncTombstoneContract = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    projectId: row.project_id,
    objectType: row.object_type,
    objectId: row.object_id,
    objectGeneration: requireSafeInteger(row.object_generation, "tombstone generation"),
    deletedByDeviceId: row.deleted_by_device_id,
    vector: row.version_vector,
    deletedAt: requireDate(row.deleted_at, "tombstone deleted_at").toISOString(),
    retainUntil: requireDate(row.retain_until, "tombstone retain_until").toISOString(),
    acknowledgedDeviceIds: row.acknowledged_device_ids,
  };
  return {
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    tombstone,
  };
}

function mapSyncBatch(row: SyncBatchRow): CloudSyncBatchRecord {
  return {
    acceptedOperations: parseAcceptedOperations(row.accepted_operations),
    accountId: row.account_id,
    batchId: row.batch_id,
    deviceId: row.device_id,
    projectId: row.project_id,
    remoteSequence: requireBigInt(row.remote_sequence, "sync-batch remote sequence"),
    serverTime: requireDate(row.server_time, "sync-batch server_time"),
    tenantId: row.tenant_id,
  };
}

function mapIdempotency(row: IdempotencyRow): CloudIdempotencyRecord {
  return {
    actorAccountId: row.actor_account_id,
    createdAt: requireDate(row.created_at, "idempotency created_at"),
    expiresAt: requireDate(row.expires_at, "idempotency expires_at"),
    idempotencyKeyHashSha256: row.idempotency_key_hash_sha256,
    operationId: row.operation_id,
    requestHashSha256: row.request_hash_sha256,
    responseSnapshot: row.response_snapshot,
    responseStatus: requireSafeInteger(row.response_status, "idempotency response_status"),
    resultDigestSha256: row.result_digest_sha256,
    resultKind: row.result_kind,
    resultResourceId: row.result_resource_id,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function parseAcceptedOperations(value: unknown): CloudSyncBatchRecord["acceptedOperations"] {
  if (!Array.isArray(value)) {
    throw new Error("PostgreSQL returned invalid sync-batch dispositions.");
  }
  return value.map((candidate: unknown) => {
    if (!isUnknownRecord(candidate)) {
      throw new Error("PostgreSQL returned an invalid sync-batch disposition.");
    }
    const operationId = candidate.operationId;
    const disposition = candidate.disposition;
    if (
      typeof operationId !== "string" ||
      (disposition !== "accepted" && disposition !== "duplicate")
    ) {
      throw new Error("PostgreSQL returned an invalid sync-batch disposition.");
    }
    return {
      disposition,
      operationId,
    };
  });
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tombstoneSelect(): string {
  return `SELECT
            t.tenant_id,
            t.project_id,
            t.object_type,
            t.object_id,
            t.object_generation,
            t.operation_id,
            t.deleted_by_device_id,
            t.version_vector,
            t.deleted_at,
            t.retain_until,
            COALESCE(
              ARRAY_AGG(a.device_id ORDER BY a.device_id)
                FILTER (WHERE a.device_id IS NOT NULL),
              ARRAY[]::uuid[]
            ) AS acknowledged_device_ids
          FROM sync_tombstones t
          LEFT JOIN sync_tombstone_acknowledgements a
            ON a.tenant_id = t.tenant_id
           AND a.project_id = t.project_id
           AND a.object_type = t.object_type
           AND a.object_id = t.object_id
           AND a.object_generation = t.object_generation`;
}

function requireAffectedRow(rowCount: number | null, resource: string): void {
  if (rowCount !== 1) {
    throw new Error(`Expected exactly one ${resource} row to be updated.`);
  }
}

function requireSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an unsafe ${label}.`);
  }
  return parsed;
}

function nullableSafeInteger(value: number | null, label: string): number | null {
  return value === null ? null : requireSafeInteger(value, label);
}

function requireBigInt(value: string | undefined, label: string): bigint {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return BigInt(value);
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return value;
}

function nullableDate(value: Date | null, label: string): Date | null {
  return value === null ? null : requireDate(value, label);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original transaction failure remains the actionable error.
  }
}
