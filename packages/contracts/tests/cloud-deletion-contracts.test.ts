import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  CloudAccountDeletionCancellationRequestSchema,
  CloudAccountDeletionLookupRequestSchema,
  CloudAccountDeletionSubmissionRequestSchema,
  CloudDeletionCancellationRequestSchema,
  CloudDeletionRequestSchema,
  CloudDeletionSubmissionRequestSchema,
  CONTRACT_SCHEMA_VERSION,
} from "../src/index.js";
import { INKSHADOW_CLOUD_OPENAPI } from "@inkshadow/contracts/openapi";

const DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000201";
const TARGET_ID = "019f9f4a-b3c7-7350-9226-000000000202";
const CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000203";
const REQUESTED_AT = "2026-07-28T00:00:00.000Z";
const CANCELLABLE_UNTIL = "2026-07-29T00:00:00.000Z";
const SCHEDULED_FOR = "2026-07-30T00:00:00.000Z";
const COMMIT_STARTED_AT = "2026-07-30T00:01:00.000Z";
const LIVE_DATA_PURGED_AT = "2026-07-30T00:02:00.000Z";
const BACKUP_RETAINED_UNTIL = "2026-08-29T00:02:00.000Z";
const COMPLETED_AT = "2026-08-29T00:03:00.000Z";

describe("cloud permanent-deletion contracts", () => {
  it("freezes the six routes and keeps password reauthentication on native-only operations", () => {
    expect(
      CLOUD_API_OPERATIONS.filter((operation) => operation.operationId.includes("Deletions")).map(
        (operation) => ({
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          authenticated: operation.requiresAuthentication,
          idempotent: operation.requiresIdempotencyKey,
          nativePassword: operation.requiresNativePasswordBoundary,
        }),
      ),
    ).toEqual([
      {
        operationId: "accountDeletions.request",
        method: "post",
        path: "/v1/account/deletion-requests",
        authenticated: true,
        idempotent: true,
        nativePassword: true,
      },
      {
        operationId: "accountDeletions.lookup",
        method: "post",
        path: "/v1/account/deletion-request-lookups",
        authenticated: false,
        idempotent: false,
        nativePassword: true,
      },
      {
        operationId: "accountDeletions.cancel",
        method: "post",
        path: "/v1/account/deletion-cancellations",
        authenticated: false,
        idempotent: true,
        nativePassword: true,
      },
      {
        operationId: "projectDeletions.request",
        method: "post",
        path: "/v1/projects/{projectId}/deletion-requests",
        authenticated: true,
        idempotent: true,
        nativePassword: true,
      },
      {
        operationId: "projectDeletions.get",
        method: "get",
        path: "/v1/projects/{projectId}/deletion-request",
        authenticated: true,
        idempotent: false,
        nativePassword: false,
      },
      {
        operationId: "projectDeletions.cancel",
        method: "post",
        path: "/v1/projects/{projectId}/deletion-cancellations",
        authenticated: true,
        idempotent: true,
        nativePassword: false,
      },
    ]);

    const openApi = INKSHADOW_CLOUD_OPENAPI as {
      readonly paths: {
        readonly "/v1/account/deletion-requests": {
          readonly post: { readonly description: string };
        };
      };
      readonly components: {
        readonly schemas: {
          readonly AccountDeletionLookupRequest: {
            readonly oneOf: readonly unknown[];
            readonly anyOf?: readonly unknown[];
          };
        };
      };
    };
    expect(openApi.paths["/v1/account/deletion-requests"].post.description).toContain(
      "every account session has already been revoked",
    );
    expect(openApi.components.schemas.AccountDeletionLookupRequest.oneOf).toHaveLength(2);
    expect(openApi.components.schemas.AccountDeletionLookupRequest.anyOf).toBeUndefined();
  });

  it("accepts only the exact state, phase, cancellation and timestamp matrix", () => {
    const valid = [
      deletionRequest({
        state: "grace_period",
        phase: "freeze",
        canCancel: true,
      }),
      deletionRequest({
        state: "blocked",
        phase: "freeze",
        canCancel: true,
        blockedReason: "legal_hold_active",
      }),
      deletionRequest({
        state: "purging",
        phase: "derived",
        canCancel: false,
        commitStartedAt: COMMIT_STARTED_AT,
      }),
      deletionRequest({
        state: "purging",
        phase: "verify",
        canCancel: false,
        commitStartedAt: COMMIT_STARTED_AT,
        liveDataPurgedAt: LIVE_DATA_PURGED_AT,
      }),
      deletionRequest({
        state: "backup_retention",
        phase: "backup_wait",
        canCancel: false,
        commitStartedAt: COMMIT_STARTED_AT,
        liveDataPurgedAt: LIVE_DATA_PURGED_AT,
        backupRetainedUntil: BACKUP_RETAINED_UNTIL,
      }),
      deletionRequest({
        state: "purged",
        phase: "complete",
        canCancel: false,
        commitStartedAt: COMMIT_STARTED_AT,
        liveDataPurgedAt: LIVE_DATA_PURGED_AT,
        completedAt: "2026-07-30T00:03:00.000Z",
      }),
      deletionRequest({
        state: "purged",
        phase: "complete",
        canCancel: false,
        commitStartedAt: COMMIT_STARTED_AT,
        liveDataPurgedAt: LIVE_DATA_PURGED_AT,
        backupRetainedUntil: BACKUP_RETAINED_UNTIL,
        completedAt: COMPLETED_AT,
      }),
      deletionRequest({
        state: "cancelled",
        phase: "freeze",
        canCancel: false,
        completedAt: "2026-07-28T12:00:00.000Z",
      }),
    ];

    for (const record of valid) {
      expect(CloudDeletionRequestSchema.safeParse(record).success, record.state).toBe(true);
    }

    for (const record of [
      { ...valid[0], canCancel: false },
      { ...valid[1], blockedReason: null },
      { ...valid[2], phase: "freeze" },
      { ...valid[2], liveDataPurgedAt: LIVE_DATA_PURGED_AT },
      { ...valid[3], liveDataPurgedAt: null },
      { ...valid[4], backupRetainedUntil: null },
      { ...valid[5], completedAt: null },
      { ...valid[7], commitStartedAt: COMMIT_STARTED_AT },
    ]) {
      expect(CloudDeletionRequestSchema.safeParse(record).success).toBe(false);
    }
  });

  it("enforces chronological progress and target-specific count-only impact", () => {
    const project = deletionRequest({
      state: "grace_period",
      phase: "freeze",
      canCancel: true,
    });
    expect(CloudDeletionRequestSchema.safeParse(project).success).toBe(true);
    expect(
      CloudDeletionRequestSchema.safeParse({
        ...project,
        scheduledFor: "2026-07-28T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      CloudDeletionRequestSchema.safeParse({
        ...project,
        impactSummary: { ...project.impactSummary, projectCount: 2 },
      }).success,
    ).toBe(false);
    expect(
      CloudDeletionRequestSchema.safeParse({
        ...project,
        impactSummary: { ...project.impactSummary, ciphertextBytes: 42 },
      }).success,
    ).toBe(false);

    expect(
      CloudDeletionRequestSchema.safeParse({
        ...project,
        targetKind: "account",
        impactSummary: {
          ...project.impactSummary,
          projectCount: 0,
          deviceCount: 2,
          sessionCount: 3,
        },
      }).success,
    ).toBe(true);
  });

  it("keeps password-bearing submissions and account proofs strict and bounded", () => {
    const submission = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedRevision: 4,
      confirmationId: CONFIRMATION_ID,
      password: "test-correct-horse-battery-staple",
    };
    expect(CloudDeletionSubmissionRequestSchema.safeParse(submission).success).toBe(true);
    expect(
      CloudAccountDeletionSubmissionRequestSchema.safeParse({
        ...submission,
        email: " Writer@Example.COM ",
      }).success,
    ).toBe(true);
    expect(CloudAccountDeletionSubmissionRequestSchema.safeParse(submission).success).toBe(false);
    expect(
      CloudDeletionSubmissionRequestSchema.safeParse({
        ...submission,
        accessToken: "must-not-be-accepted",
      }).success,
    ).toBe(false);
    expect(
      CloudDeletionSubmissionRequestSchema.safeParse({
        ...submission,
        password: "test-correct\nhorse-battery-staple",
      }).success,
    ).toBe(false);
    expect(
      CloudDeletionSubmissionRequestSchema.safeParse({
        ...submission,
        password: "🔐".repeat(128),
      }).success,
    ).toBe(true);
    expect(
      CloudDeletionSubmissionRequestSchema.safeParse({
        ...submission,
        password: "🔐".repeat(129),
      }).success,
    ).toBe(false);

    const cancellation = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deletionRequestId: DELETION_REQUEST_ID,
      expectedDeletionRevision: 2,
    };
    expect(CloudDeletionCancellationRequestSchema.safeParse(cancellation).success).toBe(true);

    const accountProof = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deletionRequestId: DELETION_REQUEST_ID,
      email: " Writer@Example.COM ",
      password: submission.password,
    };
    const parsedLookup = CloudAccountDeletionLookupRequestSchema.parse(accountProof);
    expect(parsedLookup.email).toBe("writer@example.com");
    expect(
      CloudAccountDeletionLookupRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        confirmationId: CONFIRMATION_ID,
        email: accountProof.email,
        password: accountProof.password,
      }).success,
    ).toBe(true);
    expect(
      CloudAccountDeletionLookupRequestSchema.safeParse({
        ...accountProof,
        confirmationId: CONFIRMATION_ID,
      }).success,
    ).toBe(false);
    expect(
      CloudAccountDeletionLookupRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: accountProof.email,
        password: accountProof.password,
      }).success,
    ).toBe(false);
    expect(
      CloudAccountDeletionCancellationRequestSchema.safeParse({
        ...accountProof,
        expectedDeletionRevision: 2,
      }).success,
    ).toBe(true);
    expect(
      CloudAccountDeletionLookupRequestSchema.safeParse({
        ...accountProof,
        expectedDeletionRevision: 2,
      }).success,
    ).toBe(false);
  });
});

function deletionRequest(
  progress: Partial<{
    state: "grace_period" | "blocked" | "purging" | "backup_retention" | "purged" | "cancelled";
    phase:
      | "freeze"
      | "derived"
      | "ciphertext"
      | "keys"
      | "access"
      | "marker"
      | "verify"
      | "backup_wait"
      | "complete";
    canCancel: boolean;
    commitStartedAt: string | null;
    liveDataPurgedAt: string | null;
    backupRetainedUntil: string | null;
    completedAt: string | null;
    blockedReason:
      "legal_hold_active" | "ownership_transfer_required" | "external_purge_pending" | null;
  }>,
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    deletionRequestId: DELETION_REQUEST_ID,
    targetKind: "project" as const,
    targetId: TARGET_ID,
    state: "grace_period" as const,
    phase: "freeze" as const,
    revision: 1,
    requestedAt: REQUESTED_AT,
    scheduledFor: SCHEDULED_FOR,
    cancellableUntil: CANCELLABLE_UNTIL,
    commitStartedAt: null,
    liveDataPurgedAt: null,
    backupRetainedUntil: null,
    completedAt: null,
    blockedReason: null,
    canCancel: true,
    impactSummary: {
      projectCount: 1,
      syncOperationCount: 12,
      encryptedChunkCount: 18,
      keyEnvelopeCount: 2,
      deviceCount: 0,
      sessionCount: 0,
    },
    ...progress,
  };
}
