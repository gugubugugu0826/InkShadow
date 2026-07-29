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
  RegisteredDeviceRecord,
} from "../domain/records.js";

export interface CloudProjectTransaction {
  setTenant(tenantId: string): Promise<void>;

  lockIdempotency(scopeHashSha256: string): Promise<void>;
  lockSyncDeviceSequence(tenantId: string, projectId: string, deviceId: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null>;
  insertIdempotency(record: CloudIdempotencyRecord): Promise<void>;

  findProject(
    tenantId: string,
    projectId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectRecord | null>;
  findProjectForSnapshot(tenantId: string, projectId: string): Promise<CloudProjectRecord | null>;
  insertProject(record: CloudProjectRecord): Promise<boolean>;
  updateProject(record: CloudProjectRecord): Promise<void>;
  findProjectAccess(
    tenantId: string,
    projectId: string,
    accountId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectAccessRecord | null>;
  insertProjectAccess(record: CloudProjectAccessRecord): Promise<void>;

  findDevice(deviceId: string, forUpdate?: boolean): Promise<RegisteredDeviceRecord | null>;
  findDevices(deviceIds: readonly string[]): Promise<readonly RegisteredDeviceRecord[]>;
  listTrustedDevices(accountId: string): Promise<readonly RegisteredDeviceRecord[]>;
  revokeRecipientDeviceEnvelopes(
    tenantId: string,
    recipientDeviceId: string,
    revokedAt: Date,
  ): Promise<number>;

  findProjectKeySet(
    tenantId: string,
    projectId: string,
    keyVersion: number,
  ): Promise<CloudProjectKeySetRecord | null>;
  insertProjectKeySet(record: CloudProjectKeySetRecord): Promise<void>;
  markProjectKeyRetiring(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    updatedAt: Date,
  ): Promise<void>;

  findSyncOperation(
    tenantId: string,
    projectId: string,
    operationId: string,
  ): Promise<PersistedSyncOperation | null>;
  findLatestDeviceSequence(tenantId: string, projectId: string, deviceId: string): Promise<number>;
  insertSyncOperation(
    tenantId: string,
    operation: PersistedSyncOperation["operation"],
    receivedAt: Date,
  ): Promise<bigint>;
  findSyncChunksForOperations(
    tenantId: string,
    projectId: string,
    operationIds: readonly string[],
  ): Promise<readonly PersistedSyncChunk[]>;
  insertSyncChunks(chunks: readonly PersistedSyncChunk[]): Promise<void>;
  insertSyncTombstone(tombstone: PersistedSyncTombstone): Promise<void>;
  findSyncTombstonesForOperations(
    tenantId: string,
    projectId: string,
    operationIds: readonly string[],
  ): Promise<readonly PersistedSyncTombstone[]>;
  findSyncTombstone(
    tenantId: string,
    projectId: string,
    objectType: PersistedSyncTombstone["tombstone"]["objectType"],
    objectId: string,
    objectGeneration: number,
  ): Promise<PersistedSyncTombstone | null>;
  acknowledgeSyncTombstone(
    tenantId: string,
    projectId: string,
    objectType: PersistedSyncTombstone["tombstone"]["objectType"],
    objectId: string,
    objectGeneration: number,
    deviceId: string,
    acknowledgedAt: Date,
  ): Promise<void>;
  listSyncOperations(
    tenantId: string,
    projectId: string,
    afterSequence: bigint,
    limit: number,
  ): Promise<readonly PersistedSyncOperation[]>;
  listCompleteSyncOperations(
    tenantId: string,
    projectId: string,
    afterSequence: bigint,
    throughSequence: bigint,
    limit: number,
  ): Promise<readonly PersistedSyncOperation[]>;
  getMaximumRemoteSequence(tenantId: string, projectId: string): Promise<bigint>;

  insertSyncBatch(record: CloudSyncBatchRecord): Promise<void>;
  findSyncBatch(
    tenantId: string,
    projectId: string,
    batchId: string,
  ): Promise<CloudSyncBatchRecord | null>;

  insertAuditEvent(record: CloudAuditEventRecord): Promise<void>;
}

export interface CloudProjectStore {
  transaction<T>(operation: (transaction: CloudProjectTransaction) => Promise<T>): Promise<T>;
}
