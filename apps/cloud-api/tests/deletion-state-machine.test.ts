import { describe, expect, it } from "vitest";

import { CloudDeletionRequestSchema } from "@inkshadow/contracts";

import {
  evaluateCloudDeletionJob,
  isCloudDeletionCancellable,
  nextCloudDeletionPhase,
  toCloudDeletionRequest,
  type CloudDeletionJobRecord,
} from "../src/domain/deletion-records.js";

describe("cloud deletion state machine", () => {
  it("blocks before commit and resumes the grace period when the hold clears", () => {
    const job = deletionJob();
    const beforeSchedule = new Date("2026-08-01T00:30:00.000Z");

    expect(evaluateCloudDeletionJob(job, beforeSchedule, "legal_hold_active")).toEqual({
      kind: "blocked",
      reason: "legal_hold_active",
    });
    expect(evaluateCloudDeletionJob({ ...job, state: "blocked" }, beforeSchedule, null)).toEqual({
      kind: "wait",
      until: job.scheduledFor,
    });
    expect(evaluateCloudDeletionJob(job, job.scheduledFor, null)).toEqual({
      kind: "begin_commit",
    });
  });

  it("routes committed work through persisted phases and backup retention", () => {
    const committed = deletionJob({
      commitStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      phase: "ciphertext",
      state: "purging",
    });
    expect(
      evaluateCloudDeletionJob(
        committed,
        new Date("2026-08-02T00:01:00.000Z"),
        "legal_hold_active",
      ),
    ).toEqual({ kind: "process_phase", phase: "ciphertext" });

    const backupDeadline = new Date("2026-08-03T00:00:00.000Z");
    const backup = deletionJob({
      backupRetainedUntil: backupDeadline,
      commitStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      liveDataPurgedAt: new Date("2026-08-02T00:01:00.000Z"),
      phase: "backup_wait",
      state: "backup_retention",
    });
    expect(evaluateCloudDeletionJob(backup, new Date("2026-08-02T12:00:00.000Z"), null)).toEqual({
      kind: "wait",
      until: backupDeadline,
    });
    expect(evaluateCloudDeletionJob(backup, backupDeadline, null)).toEqual({
      kind: "complete_backup_retention",
    });
  });

  it("has a single irreversible cancellation boundary", () => {
    const job = deletionJob();
    expect(isCloudDeletionCancellable(job, job.cancellableUntil)).toBe(true);
    expect(isCloudDeletionCancellable(job, new Date(job.cancellableUntil.getTime() + 1))).toBe(
      false,
    );
    expect(
      isCloudDeletionCancellable(
        {
          ...job,
          commitStartedAt: job.scheduledFor,
          phase: "derived",
          state: "purging",
        },
        job.scheduledFor,
      ),
    ).toBe(false);
  });

  it("maps every destructive phase in order and emits a contract-valid response", () => {
    expect(
      ["derived", "ciphertext", "keys", "access", "marker", "verify"].map((phase) =>
        nextCloudDeletionPhase(
          phase as "access" | "ciphertext" | "derived" | "keys" | "marker" | "verify",
        ),
      ),
    ).toEqual(["ciphertext", "keys", "access", "marker", "verify", "complete"]);

    expect(() =>
      CloudDeletionRequestSchema.parse(
        toCloudDeletionRequest(deletionJob(), new Date("2026-08-01T00:30:00.000Z")),
      ),
    ).not.toThrow();
  });
});

function deletionJob(replacement: Partial<CloudDeletionJobRecord> = {}): CloudDeletionJobRecord {
  return {
    attemptCount: 0,
    backupRetainedUntil: null,
    backupRetentionSeconds: 0,
    blockedReason: null,
    cancellableUntil: new Date("2026-08-01T12:00:00.000Z"),
    commitStartedAt: null,
    completedAt: null,
    confirmationId: "0198ab00-0000-7000-8000-000000000002",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deletionRequestId: "0198ab00-0000-7000-8000-000000000001",
    impact: {
      deviceCount: 0,
      encryptedChunkCount: 2,
      keyEnvelopeCount: 1,
      projectCount: 1,
      sessionCount: 0,
      syncOperationCount: 2,
    },
    lastFailureCode: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    liveDataPurgedAt: null,
    nextAttemptAt: new Date("2026-08-01T00:00:00.000Z"),
    phase: "freeze",
    requestedAt: new Date("2026-08-01T00:00:00.000Z"),
    requestedByAccountId: "0198ab00-0000-7000-8000-000000000003",
    revision: 1,
    scheduledFor: new Date("2026-08-02T00:00:00.000Z"),
    state: "grace_period",
    targetId: "0198ab00-0000-7000-8000-000000000004",
    targetKind: "project",
    tenantId: "0198ab00-0000-7000-8000-000000000003",
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...replacement,
  };
}
