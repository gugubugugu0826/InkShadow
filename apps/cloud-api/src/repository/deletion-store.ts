import type { CloudDeletionBlockedReason, CloudDeletionTargetKind } from "@inkshadow/contracts";

import type {
  CloudDeletionImpactRecord,
  CloudDeletionJobProjectRecord,
  CloudDeletionJobRecord,
  CloudDeletionMarkerRecord,
  CloudRetentionHoldRecord,
} from "../domain/deletion-records.js";
import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudAccountRecord,
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
} from "../domain/records.js";

export type CloudDeletionCancellationResult =
  | {
      readonly job: CloudDeletionJobRecord;
      readonly kind: "cancelled";
    }
  | {
      readonly kind: "not_cancellable" | "not_found" | "revision_mismatch";
    };

export interface CloudDeletionTransaction {
  setTenant(tenantId: string): Promise<void>;

  lockIdempotency(scopeHashSha256: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null>;
  insertIdempotency(record: CloudIdempotencyRecord): Promise<void>;

  findAccountById(accountId: string, forUpdate?: boolean): Promise<CloudAccountRecord | null>;
  findAccountByEmail(
    emailCanonical: string,
    forUpdate?: boolean,
  ): Promise<CloudAccountRecord | null>;
  accountRequiresOwnershipTransfer(accountId: string): Promise<boolean>;
  findProject(
    tenantId: string,
    projectId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectRecord | null>;
  listOwnedProjects(
    tenantId: string,
    ownerAccountId: string,
    afterProjectId: string | null,
    limit: number,
    forUpdate?: boolean,
  ): Promise<readonly CloudProjectRecord[]>;
  listActiveProjectDeletionJobsForOwner(
    tenantId: string,
    ownerAccountId: string,
    afterProjectId: string | null,
    limit: number,
    forUpdate?: boolean,
  ): Promise<readonly CloudDeletionJobRecord[]>;

  findDeletionJob(
    tenantId: string,
    deletionRequestId: string,
    forUpdate?: boolean,
  ): Promise<CloudDeletionJobRecord | null>;
  findDeletionJobByConfirmation(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
    confirmationId: string,
    forUpdate?: boolean,
  ): Promise<CloudDeletionJobRecord | null>;
  findActiveDeletionJob(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
    forUpdate?: boolean,
  ): Promise<CloudDeletionJobRecord | null>;
  findLatestDeletionJobForTarget(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
    forUpdate?: boolean,
  ): Promise<CloudDeletionJobRecord | null>;
  insertDeletionJob(record: CloudDeletionJobRecord): Promise<void>;
  updateDeletionJob(record: CloudDeletionJobRecord, expectedRevision: number): Promise<boolean>;
  cancelDeletionJob(
    tenantId: string,
    deletionRequestId: string,
    expectedRevision: number,
    cancelledAt: Date,
  ): Promise<CloudDeletionCancellationResult>;

  insertDeletionJobProject(record: CloudDeletionJobProjectRecord): Promise<void>;
  listDeletionJobProjects(
    tenantId: string,
    deletionRequestId: string,
    afterOrdinal: number | null,
    limit: number,
    forUpdate?: boolean,
  ): Promise<readonly CloudDeletionJobProjectRecord[]>;

  calculateProjectImpact(tenantId: string, projectId: string): Promise<CloudDeletionImpactRecord>;
  calculateAccountImpact(tenantId: string, accountId: string): Promise<CloudDeletionImpactRecord>;

  freezeProject(
    tenantId: string,
    projectId: string,
    expectedRevision: number,
    scheduledFor: Date,
    updatedAt: Date,
  ): Promise<boolean>;
  restoreProject(
    tenantId: string,
    projectId: string,
    deletionScheduledFor: Date,
    originalState: CloudDeletionJobProjectRecord["originalState"],
    originalDeletionScheduledFor: Date | null,
    updatedAt: Date,
  ): Promise<boolean>;
  freezeAccount(
    accountId: string,
    expectedRevision: number,
    scheduledFor: Date,
    updatedAt: Date,
  ): Promise<boolean>;
  restoreAccount(accountId: string, deletionScheduledFor: Date, updatedAt: Date): Promise<boolean>;
  revokeSessionsForAccount(accountId: string, revokedAt: Date): Promise<number>;

  findActiveRetentionHoldReason(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
  ): Promise<CloudDeletionBlockedReason | null>;
  insertRetentionHold(record: CloudRetentionHoldRecord): Promise<void>;
  releaseRetentionHold(tenantId: string, holdId: string, releasedAt: Date): Promise<boolean>;
  insertDeletionMarker(record: CloudDeletionMarkerRecord): Promise<void>;

  insertAuditEvent(record: CloudAuditEventRecord): Promise<void>;
}

export interface CloudDeletionStore {
  transaction<T>(operation: (transaction: CloudDeletionTransaction) => Promise<T>): Promise<T>;
}
