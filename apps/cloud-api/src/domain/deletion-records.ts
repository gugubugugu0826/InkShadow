import {
  CONTRACT_SCHEMA_VERSION,
  type CloudDeletionBlockedReason,
  type CloudDeletionImpactSummary,
  type CloudDeletionPhase,
  type CloudDeletionRequest,
  type CloudDeletionState,
  type CloudDeletionTargetKind,
} from "@inkshadow/contracts";

export const DELETED_ACCOUNT_PASSWORD_SENTINEL = "!INKSHADOW_ACCOUNT_DELETED_NO_CREDENTIAL!";

export interface CloudDeletionImpactRecord {
  readonly deviceCount: number;
  readonly encryptedChunkCount: number;
  readonly keyEnvelopeCount: number;
  readonly projectCount: number;
  readonly sessionCount: number;
  readonly syncOperationCount: number;
}

export interface CloudDeletionJobRecord {
  readonly attemptCount: number;
  readonly backupRetainedUntil: Date | null;
  readonly backupRetentionSeconds: number;
  readonly blockedReason: CloudDeletionBlockedReason | null;
  readonly cancellableUntil: Date;
  readonly commitStartedAt: Date | null;
  readonly completedAt: Date | null;
  readonly confirmationId: string;
  readonly createdAt: Date;
  readonly deletionRequestId: string;
  readonly impact: CloudDeletionImpactRecord;
  readonly lastFailureCode: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseOwner: string | null;
  readonly liveDataPurgedAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly phase: CloudDeletionPhase;
  readonly requestedAt: Date;
  readonly requestedByAccountId: string;
  readonly revision: number;
  readonly scheduledFor: Date;
  readonly state: CloudDeletionState;
  readonly targetId: string;
  readonly targetKind: CloudDeletionTargetKind;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudDeletionJobProjectRecord {
  readonly completedAt: Date | null;
  readonly deletionRequestId: string;
  readonly ordinal: number;
  readonly originalDeletionScheduledFor: Date | null;
  readonly originalState: "active" | "deletion_scheduled";
  readonly phase: Exclude<CloudDeletionPhase, "backup_wait" | "freeze">;
  readonly projectId: string;
  readonly projectRevisionAtFreeze: number;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudDeletionMarkerRecord {
  readonly deletedAt: Date;
  readonly deletionRequestId: string;
  readonly targetId: string;
  readonly targetKind: CloudDeletionTargetKind;
  readonly tenantId: string;
}

export interface CloudRetentionHoldRecord {
  readonly holdId: string;
  readonly placedAt: Date;
  readonly reason: CloudDeletionBlockedReason;
  readonly releasedAt: Date | null;
  readonly targetId: string;
  readonly targetKind: CloudDeletionTargetKind;
  readonly tenantId: string;
}

export type CloudDeletionEvaluation =
  | {
      readonly kind: "begin_commit";
    }
  | {
      readonly kind: "blocked";
      readonly reason: CloudDeletionBlockedReason;
    }
  | {
      readonly kind: "complete_backup_retention";
    }
  | {
      readonly kind: "process_phase";
      readonly phase: Exclude<CloudDeletionPhase, "backup_wait" | "complete" | "freeze">;
    }
  | {
      readonly kind: "terminal";
    }
  | {
      readonly kind: "wait";
      readonly until: Date;
    };

export function evaluateCloudDeletionJob(
  job: CloudDeletionJobRecord,
  now: Date,
  blocker: CloudDeletionBlockedReason | null,
): CloudDeletionEvaluation {
  requireValidDate(now, "deletion evaluation time");
  if (job.state === "cancelled" || job.state === "purged") {
    return { kind: "terminal" };
  }
  if (job.commitStartedAt === null) {
    if (blocker !== null) {
      return { kind: "blocked", reason: blocker };
    }
    if (now < job.scheduledFor) {
      return { kind: "wait", until: job.scheduledFor };
    }
    return { kind: "begin_commit" };
  }
  if (job.state === "backup_retention") {
    const retainedUntil = job.backupRetainedUntil;
    if (retainedUntil === null) {
      throw new Error("Backup-retention deletion is missing its retention deadline.");
    }
    return now < retainedUntil
      ? { kind: "wait", until: retainedUntil }
      : { kind: "complete_backup_retention" };
  }
  if (job.state !== "purging") {
    throw new Error("Committed deletion has an invalid active state.");
  }
  if (job.phase === "freeze" || job.phase === "backup_wait" || job.phase === "complete") {
    throw new Error("Purging deletion has an invalid phase.");
  }
  return { kind: "process_phase", phase: job.phase };
}

export function isCloudDeletionCancellable(job: CloudDeletionJobRecord, now: Date): boolean {
  requireValidDate(now, "deletion cancellation time");
  return (
    (job.state === "grace_period" || job.state === "blocked") &&
    job.commitStartedAt === null &&
    now <= job.cancellableUntil
  );
}

export function nextCloudDeletionPhase(
  phase: Exclude<CloudDeletionPhase, "backup_wait" | "complete" | "freeze">,
): Exclude<CloudDeletionPhase, "freeze"> {
  switch (phase) {
    case "derived":
      return "ciphertext";
    case "ciphertext":
      return "keys";
    case "keys":
      return "access";
    case "access":
      return "marker";
    case "marker":
      return "verify";
    case "verify":
      return "complete";
  }
}

export function toCloudDeletionRequest(
  job: CloudDeletionJobRecord,
  now: Date,
): CloudDeletionRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    deletionRequestId: job.deletionRequestId,
    targetKind: job.targetKind,
    targetId: job.targetId,
    state: job.state,
    phase: job.phase,
    revision: job.revision,
    requestedAt: job.requestedAt.toISOString(),
    scheduledFor: job.scheduledFor.toISOString(),
    cancellableUntil: job.cancellableUntil.toISOString(),
    commitStartedAt: job.commitStartedAt?.toISOString() ?? null,
    liveDataPurgedAt: job.liveDataPurgedAt?.toISOString() ?? null,
    backupRetainedUntil: job.backupRetainedUntil?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    blockedReason: job.blockedReason,
    canCancel: isCloudDeletionCancellable(job, now),
    impactSummary: toImpactSummary(job.impact),
  };
}

function toImpactSummary(impact: CloudDeletionImpactRecord): CloudDeletionImpactSummary {
  return {
    projectCount: requireNonnegativeSafeInteger(impact.projectCount, "project impact count"),
    syncOperationCount: requireNonnegativeSafeInteger(
      impact.syncOperationCount,
      "sync-operation impact count",
    ),
    encryptedChunkCount: requireNonnegativeSafeInteger(
      impact.encryptedChunkCount,
      "encrypted-chunk impact count",
    ),
    keyEnvelopeCount: requireNonnegativeSafeInteger(
      impact.keyEnvelopeCount,
      "key-envelope impact count",
    ),
    deviceCount: requireNonnegativeSafeInteger(impact.deviceCount, "device impact count"),
    sessionCount: requireNonnegativeSafeInteger(impact.sessionCount, "session impact count"),
  };
}

function requireNonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Cloud deletion has an invalid ${label}.`);
  }
  return value;
}

function requireValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Cloud ${label} is invalid.`);
  }
}
