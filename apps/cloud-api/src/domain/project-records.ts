import type {
  CloudProjectKeyPublicationReceipt,
  DeviceProjectKeyEnvelopeContract,
  EncryptedSyncChunkContract,
  ProjectKeyVersionContract,
  RecoveryProjectKeyEnvelopeContract,
  SyncOperationContract,
  SyncTombstoneContract,
} from "@inkshadow/contracts";

export interface CloudProjectRecord {
  readonly createdAt: Date;
  readonly currentKeyVersion: number | null;
  readonly deletionScheduledFor: Date | null;
  readonly minimumAvailableRemoteSequence: bigint;
  readonly ownerAccountId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: "active" | "deleted" | "deletion_scheduled";
  readonly syncCompactionEpoch: bigint;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudProjectAccessRecord {
  readonly accountId: string;
  readonly canManageKeys: boolean;
  readonly canSync: boolean;
  readonly createdAt: Date;
  readonly projectId: string;
  readonly revision: number;
  readonly revokedAt: Date | null;
  readonly role: "admin" | "author" | "owner" | "read_only" | "reviewer";
  readonly tenantId: string;
}

export interface CloudProjectKeySetRecord {
  readonly deviceEnvelopes: readonly DeviceProjectKeyEnvelopeContract[];
  readonly keyVersion: number;
  readonly projectId: string;
  readonly publication: CloudProjectKeyPublicationReceipt;
  readonly recoveryEnvelope: RecoveryProjectKeyEnvelopeContract;
  readonly serverRevision: number;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: ProjectKeyVersionContract;
}

export interface PersistedSyncOperation {
  readonly operation: SyncOperationContract;
  readonly receivedAt: Date;
  readonly remoteSequence: bigint;
  readonly tenantId: string;
}

export interface PersistedSyncChunk {
  readonly chunkId: string;
  readonly encrypted: EncryptedSyncChunkContract;
  readonly operationId: string;
  readonly tenantId: string;
}

export interface PersistedSyncTombstone {
  readonly operationId: string;
  readonly tenantId: string;
  readonly tombstone: SyncTombstoneContract;
}

export interface CloudSyncBatchRecord {
  readonly acceptedOperations: readonly {
    readonly disposition: "accepted" | "duplicate";
    readonly operationId: string;
  }[];
  readonly accountId: string;
  readonly batchId: string;
  readonly deviceId: string;
  readonly projectId: string;
  readonly remoteSequence: bigint;
  readonly serverTime: Date;
  readonly tenantId: string;
}
