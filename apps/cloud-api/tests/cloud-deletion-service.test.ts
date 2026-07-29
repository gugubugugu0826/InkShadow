import { describe, expect, it, vi, type Mocked } from "vitest";

import { CONTRACT_SCHEMA_VERSION, CloudDeletionRequestResponseSchema } from "@inkshadow/contracts";

import { toCloudDeletionRequest } from "../src/domain/deletion-records.js";
import type {
  CloudDeletionImpactRecord,
  CloudDeletionJobRecord,
} from "../src/domain/deletion-records.js";
import type { CloudProjectRecord } from "../src/domain/project-records.js";
import type { CloudAccountRecord, CloudIdempotencyRecord } from "../src/domain/records.js";
import type {
  CloudDeletionStore,
  CloudDeletionTransaction,
} from "../src/repository/deletion-store.js";
import { hashCanonicalJson } from "../src/security/canonical-hash.js";
import type { PasswordHasher } from "../src/security/passwords.js";
import { CloudDeletionDomainService } from "../src/service/cloud-deletion-service.js";
import type { CloudMutationContext, CloudPrincipal } from "../src/service/identity-service.js";

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000401";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000402";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000403";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000404";
const SECOND_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000405";
const DELETION_ID = "019f9f4a-b3c7-7350-9226-000000000406";
const CHILD_DELETION_ID = "019f9f4a-b3c7-7350-9226-000000000407";
const CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000408";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000409";
const PASSWORD = "test-correct-horse-battery-staple";
const PASSWORD_HASH = "encoded-password-hash";
const NOW = new Date("2026-07-28T01:00:00.000Z");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

const principal: CloudPrincipal = {
  accountId: ACCOUNT_ID,
  deviceId: DEVICE_ID,
  sessionId: SESSION_ID,
};

describe("CloudDeletionDomainService", () => {
  it("reauthenticates an owner, freezes the exact project revision and stores no credential body", async () => {
    const transaction = transactionStub();
    const { service, passwordHasher } = serviceWith(transaction);

    const response = await service.requestProjectDeletion(
      principal,
      PROJECT_ID,
      projectSubmission(),
      mutationContext("project-delete-idempotency-0001"),
    );

    expect(CloudDeletionRequestResponseSchema.parse(response).deletionRequest).toMatchObject({
      targetKind: "project",
      targetId: PROJECT_ID,
      state: "grace_period",
      revision: 1,
    });
    expect(response.deletionRequest.scheduledFor).toBe(
      new Date(NOW.getTime() + THIRTY_DAYS_MS).toISOString(),
    );
    expect(passwordHasher.verify).toHaveBeenCalledWith(PASSWORD, PASSWORD_HASH);
    expect(transaction.freezeProject.mock.calls).toEqual([
      [ACCOUNT_ID, PROJECT_ID, 4, new Date(NOW.getTime() + THIRTY_DAYS_MS), NOW],
    ]);

    const idempotency = transaction.insertIdempotency.mock.calls[0]?.[0];
    expect(idempotency).toMatchObject({
      actorAccountId: ACCOUNT_ID,
      responseSnapshot: {
        response,
        snapshotKind: "deletion_job_v1",
        tenantId: ACCOUNT_ID,
      },
      resultKind: "deletion_job",
      resultResourceId: DELETION_ID,
    });
    expect(idempotency?.requestHashSha256).toBe(
      hashCanonicalJson({
        confirmationId: CONFIRMATION_ID,
        expectedRevision: 4,
        projectId: PROJECT_ID,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        targetKind: "project",
      }),
    );
    expect(idempotency?.requestHashSha256).not.toBe(
      hashCanonicalJson({
        projectId: PROJECT_ID,
        request: projectSubmission(),
        targetKind: "project",
      }),
    );
    expect(JSON.stringify(idempotency)).not.toContain(PASSWORD);
    expect(JSON.stringify(idempotency)).not.toContain(CONFIRMATION_ID);
    const audit = transaction.insertAuditEvent.mock.calls[0]?.[0];
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit)).not.toContain(CONFIRMATION_ID);
  });

  it("atomically cancels cancellable child jobs, freezes a bounded project set and revokes sessions", async () => {
    const child = deletionJob({
      deletionRequestId: CHILD_DELETION_ID,
      targetId: PROJECT_ID,
      targetKind: "project",
    });
    const first = project();
    const second = project({
      projectId: SECOND_PROJECT_ID,
      revision: 8,
    });
    const transaction = transactionStub({
      calculateAccountImpact: vi.fn(() =>
        Promise.resolve(impact({ projectCount: 2, sessionCount: 3 })),
      ),
      cancelDeletionJob: vi.fn(() =>
        Promise.resolve({
          job: deletionJob({
            ...child,
            completedAt: NOW,
            revision: 2,
            state: "cancelled",
          }),
          kind: "cancelled" as const,
        }),
      ),
      listActiveProjectDeletionJobsForOwner: vi
        .fn()
        .mockResolvedValueOnce([child])
        .mockResolvedValueOnce([]),
      listOwnedProjects: vi.fn().mockResolvedValueOnce([first, second]),
    });
    const { service } = serviceWith(transaction);

    const response = await service.requestAccountDeletion(
      principal,
      accountSubmission(),
      mutationContext("account-delete-idempotency-0001"),
    );

    expect(response.deletionRequest).toMatchObject({
      targetKind: "account",
      targetId: ACCOUNT_ID,
      impactSummary: { projectCount: 2, sessionCount: 3 },
    });
    expect(transaction.cancelDeletionJob.mock.calls).toEqual([
      [ACCOUNT_ID, CHILD_DELETION_ID, 1, NOW],
    ]);
    expect(transaction.insertDeletionJobProject.mock.calls).toHaveLength(2);
    expect(transaction.freezeProject.mock.calls[0]).toEqual([
      ACCOUNT_ID,
      PROJECT_ID,
      4,
      expect.any(Date),
      NOW,
    ]);
    expect(transaction.freezeProject.mock.calls[1]).toEqual([
      ACCOUNT_ID,
      SECOND_PROJECT_ID,
      8,
      expect.any(Date),
      NOW,
    ]);
    expect(transaction.freezeAccount.mock.calls).toEqual([[ACCOUNT_ID, 7, expect.any(Date), NOW]]);
    expect(transaction.revokeSessionsForAccount.mock.calls).toEqual([[ACCOUNT_ID, NOW]]);
    expect(
      firstCallOrder(transaction.revokeSessionsForAccount.mock.invocationCallOrder),
    ).toBeLessThan(firstCallOrder(transaction.insertIdempotency.mock.invocationCallOrder));
    expect(transaction.insertIdempotency.mock.calls[0]?.[0].requestHashSha256).toBe(
      hashCanonicalJson({
        confirmationId: CONFIRMATION_ID,
        email: "writer@example.test",
        expectedRevision: 7,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        targetId: ACCOUNT_ID,
        targetKind: "account",
      }),
    );
  });

  it("rolls back the account workflow before freezing when a child deletion crossed commit", async () => {
    const child = deletionJob({
      commitStartedAt: NOW,
      deletionRequestId: CHILD_DELETION_ID,
      phase: "derived",
      state: "purging",
      targetId: PROJECT_ID,
      targetKind: "project",
    });
    const transaction = transactionStub({
      cancelDeletionJob: vi.fn(() => Promise.resolve({ kind: "not_cancellable" as const })),
      listActiveProjectDeletionJobsForOwner: vi
        .fn()
        .mockResolvedValueOnce([child])
        .mockResolvedValueOnce([]),
    });
    const { service } = serviceWith(transaction);

    await expect(
      service.requestAccountDeletion(
        principal,
        accountSubmission(),
        mutationContext("account-delete-idempotency-0002"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(transaction.freezeAccount.mock.calls).toHaveLength(0);
    expect(transaction.insertDeletionJob.mock.calls).toHaveLength(0);
  });

  it("requires the bearer account email and password to agree before account freeze", async () => {
    const transaction = transactionStub();
    const { service } = serviceWith(transaction);

    await expect(
      service.requestAccountDeletion(
        principal,
        { ...accountSubmission(), email: "different@example.test" },
        mutationContext("account-delete-idempotency-0003"),
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    expect(transaction.insertDeletionJob.mock.calls).toHaveLength(0);
    expect(transaction.revokeSessionsForAccount.mock.calls).toHaveLength(0);
  });

  it("requires team ownership transfer before mutating an account deletion workflow", async () => {
    const transaction = transactionStub({
      accountRequiresOwnershipTransfer: vi.fn(() => Promise.resolve(true)),
    });
    const { service } = serviceWith(transaction);

    await expect(
      service.requestAccountDeletion(
        principal,
        accountSubmission(),
        mutationContext("account-delete-idempotency-0004"),
      ),
    ).rejects.toMatchObject({
      code: "ACCESS_FORBIDDEN",
      httpStatus: 403,
      message:
        "Resolve team ownership and collaborative project access assignments before scheduling account deletion.",
    });

    expect(transaction.listActiveProjectDeletionJobsForOwner.mock.calls).toHaveLength(0);
    expect(transaction.cancelDeletionJob.mock.calls).toHaveLength(0);
    expect(transaction.insertDeletionJob.mock.calls).toHaveLength(0);
    expect(transaction.freezeAccount.mock.calls).toHaveLength(0);
    expect(transaction.revokeSessionsForAccount.mock.calls).toHaveLength(0);
    expect(transaction.insertAuditEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        action: "account.deletion_denied",
        redactedDiff: { reason: "ownership_transfer_required" },
        result: "denied",
      }),
    );
  });

  it("locks the deletion job before its target when cancelling to match the worker lock order", async () => {
    const scheduledFor = new Date(NOW.getTime() + THIRTY_DAYS_MS);
    const cancelledProjectJob = deletionJob({
      completedAt: NOW,
      revision: 2,
      state: "cancelled",
      targetId: PROJECT_ID,
      targetKind: "project",
    });
    const projectTransaction = transactionStub({
      cancelDeletionJob: vi.fn(() =>
        Promise.resolve({ job: cancelledProjectJob, kind: "cancelled" as const }),
      ),
      findDeletionJob: vi.fn(() =>
        Promise.resolve(
          deletionJob({
            targetId: PROJECT_ID,
            targetKind: "project",
          }),
        ),
      ),
      findProject: vi.fn(() =>
        Promise.resolve(
          project({
            deletionScheduledFor: scheduledFor,
            state: "deletion_scheduled",
          }),
        ),
      ),
    });
    await serviceWith(projectTransaction).service.cancelProjectDeletion(
      principal,
      PROJECT_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deletionRequestId: DELETION_ID,
        expectedDeletionRevision: 1,
      },
      mutationContext("project-delete-cancel-order-0001"),
    );
    expect(
      firstCallOrder(projectTransaction.findDeletionJob.mock.invocationCallOrder),
    ).toBeLessThan(firstCallOrder(projectTransaction.findProject.mock.invocationCallOrder));
    expect(projectTransaction.insertIdempotency.mock.calls[0]?.[0].requestHashSha256).toBe(
      hashCanonicalJson({
        deletionRequestId: DELETION_ID,
        expectedDeletionRevision: 1,
        projectId: PROJECT_ID,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        targetKind: "project",
      }),
    );

    const scheduledAccount = account({
      deletionScheduledFor: scheduledFor,
      state: "deletion_scheduled",
    });
    const cancelledAccountJob = deletionJob({
      completedAt: NOW,
      revision: 2,
      state: "cancelled",
    });
    const accountTransaction = transactionStub({
      cancelDeletionJob: vi.fn(() =>
        Promise.resolve({ job: cancelledAccountJob, kind: "cancelled" as const }),
      ),
      findAccountByEmail: vi.fn(() => Promise.resolve(scheduledAccount)),
      findAccountById: vi.fn(() => Promise.resolve(scheduledAccount)),
      findDeletionJob: vi.fn(() => Promise.resolve(deletionJob())),
    });
    await serviceWith(accountTransaction).service.cancelAccountDeletion(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deletionRequestId: DELETION_ID,
        email: scheduledAccount.emailCanonical,
        expectedDeletionRevision: 1,
        password: PASSWORD,
      },
      mutationContext("account-delete-cancel-order-0001"),
    );
    expect(accountTransaction.findAccountByEmail.mock.calls).toEqual([
      [scheduledAccount.emailCanonical, false],
    ]);
    expect(
      firstCallOrder(accountTransaction.findDeletionJob.mock.invocationCallOrder),
    ).toBeLessThan(firstCallOrder(accountTransaction.findAccountById.mock.invocationCallOrder));
    expect(accountTransaction.findAccountById.mock.calls).toEqual([[ACCOUNT_ID, true]]);
    expect(accountTransaction.insertIdempotency.mock.calls[0]?.[0].requestHashSha256).toBe(
      hashCanonicalJson({
        deletionRequestId: DELETION_ID,
        email: scheduledAccount.emailCanonical,
        expectedDeletionRevision: 1,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        targetKind: "account",
      }),
    );
  });

  it("recovers the authoritative deletionRequestId from confirmationId plus credentials", async () => {
    const job = deletionJob({
      targetId: ACCOUNT_ID,
      targetKind: "account",
    });
    const transaction = transactionStub({
      findDeletionJobByConfirmation: vi.fn(() => Promise.resolve(job)),
    });
    const { service } = serviceWith(transaction);

    const response = await service.lookupAccountDeletion(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        confirmationId: CONFIRMATION_ID,
        email: "writer@example.test",
        password: PASSWORD,
      },
      { requestId: REQUEST_ID },
    );

    expect(response.deletionRequest.deletionRequestId).toBe(DELETION_ID);
    expect(transaction.findDeletionJobByConfirmation.mock.calls).toEqual([
      [ACCOUNT_ID, "account", ACCOUNT_ID, CONFIRMATION_ID, false],
    ]);
  });

  it("normalizes an unknown proof and a bad password to the same credential error", async () => {
    const unknownTransaction = transactionStub({
      findDeletionJobByConfirmation: vi.fn(() => Promise.resolve(null)),
    });
    const badPasswordTransaction = transactionStub();
    const unknown = serviceWith(unknownTransaction).service;
    const badPassword = serviceWith(badPasswordTransaction, false).service;
    const request = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      confirmationId: CONFIRMATION_ID,
      email: "writer@example.test",
      password: PASSWORD,
    } as const;

    await expect(
      unknown.lookupAccountDeletion(request, { requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS", httpStatus: 401 });
    await expect(
      badPassword.lookupAccountDeletion(request, { requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS", httpStatus: 401 });
  });

  it("replays the same project mutation after password rotation without persisting a credential digest", async () => {
    const request = projectSubmission();
    const requestHash = hashCanonicalJson({
      confirmationId: request.confirmationId,
      expectedRevision: request.expectedRevision,
      projectId: PROJECT_ID,
      schemaVersion: request.schemaVersion,
      targetKind: "project",
    });
    const job = deletionJob({
      targetId: PROJECT_ID,
      targetKind: "project",
    });
    const transaction = transactionStub({
      findDeletionJob: vi.fn(() => Promise.resolve(job)),
      findIdempotency: vi.fn(() =>
        Promise.resolve(
          idempotencyRecord({
            operationId: "projectDeletions.request",
            requestHashSha256: requestHash,
          }),
        ),
      ),
    });
    const { service, passwordHasher } = serviceWith(transaction);

    const response = await service.requestProjectDeletion(
      principal,
      PROJECT_ID,
      {
        ...request,
        password: "test-rotated-project-deletion-password",
      },
      mutationContext("project-delete-idempotency-0001"),
    );

    expect(response.requestId).toBe(REQUEST_ID);
    expect(response.deletionRequest.deletionRequestId).toBe(DELETION_ID);
    expect(passwordHasher.verify).not.toHaveBeenCalled();
    expect(transaction.insertDeletionJob.mock.calls).toHaveLength(0);
  });
});

function serviceWith(
  transaction: ReturnType<typeof transactionStub>,
  passwordMatches = true,
): {
  readonly passwordHasher: {
    readonly hash: ReturnType<typeof vi.fn<PasswordHasher["hash"]>>;
    readonly verify: ReturnType<typeof vi.fn<PasswordHasher["verify"]>>;
  };
  readonly service: CloudDeletionDomainService;
} {
  const passwordHasher = {
    hash: vi.fn<PasswordHasher["hash"]>(() => Promise.resolve("dummy-password-hash")),
    verify: vi.fn<PasswordHasher["verify"]>(() => Promise.resolve(passwordMatches)),
  };
  const store: CloudDeletionStore = {
    transaction: (operation) => operation(transaction),
  };
  return {
    passwordHasher,
    service: new CloudDeletionDomainService({
      clock: () => NOW,
      passwordHasher,
      store,
      uuid: () => DELETION_ID,
    }),
  };
}

type MockedDeletionTransaction = Mocked<CloudDeletionTransaction>;

function transactionStub(
  overrides: Partial<MockedDeletionTransaction> = {},
): MockedDeletionTransaction {
  const base = {
    setTenant: vi.fn(() => Promise.resolve()),
    lockIdempotency: vi.fn(() => Promise.resolve()),
    findIdempotency: vi.fn(() => Promise.resolve(null)),
    insertIdempotency: vi.fn(() => Promise.resolve()),
    findAccountById: vi.fn(() => Promise.resolve(account())),
    findAccountByEmail: vi.fn(() => Promise.resolve(account())),
    accountRequiresOwnershipTransfer: vi.fn(() => Promise.resolve(false)),
    findProject: vi.fn(() => Promise.resolve(project())),
    listOwnedProjects: vi.fn(() => Promise.resolve([])),
    listActiveProjectDeletionJobsForOwner: vi.fn(() => Promise.resolve([])),
    findDeletionJob: vi.fn(() => Promise.resolve(null)),
    findDeletionJobByConfirmation: vi.fn(() => Promise.resolve(null)),
    findActiveDeletionJob: vi.fn(() => Promise.resolve(null)),
    findLatestDeletionJobForTarget: vi.fn(() => Promise.resolve(null)),
    insertDeletionJob: vi.fn(() => Promise.resolve()),
    updateDeletionJob: vi.fn(() => Promise.resolve(true)),
    cancelDeletionJob: vi.fn(() => Promise.resolve({ kind: "not_found" as const })),
    insertDeletionJobProject: vi.fn(() => Promise.resolve()),
    listDeletionJobProjects: vi.fn(() => Promise.resolve([])),
    calculateProjectImpact: vi.fn(() => Promise.resolve(impact({ projectCount: 1 }))),
    calculateAccountImpact: vi.fn(() => Promise.resolve(impact())),
    freezeProject: vi.fn(() => Promise.resolve(true)),
    restoreProject: vi.fn(() => Promise.resolve(true)),
    freezeAccount: vi.fn(() => Promise.resolve(true)),
    restoreAccount: vi.fn(() => Promise.resolve(true)),
    revokeSessionsForAccount: vi.fn(() => Promise.resolve(3)),
    findActiveRetentionHoldReason: vi.fn(() => Promise.resolve(null)),
    insertRetentionHold: vi.fn(() => Promise.resolve()),
    releaseRetentionHold: vi.fn(() => Promise.resolve(true)),
    insertDeletionMarker: vi.fn(() => Promise.resolve()),
    insertAuditEvent: vi.fn(() => Promise.resolve()),
  } satisfies MockedDeletionTransaction;
  return Object.assign(base, overrides);
}

function account(replacement: Partial<CloudAccountRecord> = {}): CloudAccountRecord {
  return {
    accountId: ACCOUNT_ID,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletionScheduledFor: null,
    emailCanonical: "writer@example.test",
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    passwordHash: PASSWORD_HASH,
    revision: 7,
    state: "active",
    updatedAt: NOW,
    verifiedAt: new Date("2026-01-01T00:01:00.000Z"),
    ...replacement,
  };
}

function project(replacement: Partial<CloudProjectRecord> = {}): CloudProjectRecord {
  return {
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    currentKeyVersion: 1,
    deletionScheduledFor: null,
    minimumAvailableRemoteSequence: 0n,
    ownerAccountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    revision: 4,
    state: "active",
    syncCompactionEpoch: 0n,
    tenantId: ACCOUNT_ID,
    updatedAt: NOW,
    ...replacement,
  };
}

function deletionJob(replacement: Partial<CloudDeletionJobRecord> = {}): CloudDeletionJobRecord {
  return {
    attemptCount: 0,
    backupRetainedUntil: null,
    backupRetentionSeconds: 30 * 24 * 60 * 60,
    blockedReason: null,
    cancellableUntil: new Date(NOW.getTime() + THIRTY_DAYS_MS),
    commitStartedAt: null,
    completedAt: null,
    confirmationId: CONFIRMATION_ID,
    createdAt: NOW,
    deletionRequestId: DELETION_ID,
    impact: impact({ projectCount: 1 }),
    lastFailureCode: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    liveDataPurgedAt: null,
    nextAttemptAt: new Date(NOW.getTime() + THIRTY_DAYS_MS),
    phase: "freeze",
    requestedAt: NOW,
    requestedByAccountId: ACCOUNT_ID,
    revision: 1,
    scheduledFor: new Date(NOW.getTime() + THIRTY_DAYS_MS),
    state: "grace_period",
    targetId: ACCOUNT_ID,
    targetKind: "account",
    tenantId: ACCOUNT_ID,
    updatedAt: NOW,
    ...replacement,
  };
}

function impact(replacement: Partial<CloudDeletionImpactRecord> = {}): CloudDeletionImpactRecord {
  return {
    deviceCount: 0,
    encryptedChunkCount: 0,
    keyEnvelopeCount: 0,
    projectCount: 0,
    sessionCount: 0,
    syncOperationCount: 0,
    ...replacement,
  };
}

function projectSubmission() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    confirmationId: CONFIRMATION_ID,
    expectedRevision: 4,
    password: PASSWORD,
  } as const;
}

function accountSubmission() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    confirmationId: CONFIRMATION_ID,
    email: "writer@example.test",
    expectedRevision: 7,
    password: PASSWORD,
  } as const;
}

function mutationContext(idempotencyKey: string): CloudMutationContext {
  return {
    idempotencyKey,
    requestId: REQUEST_ID,
  };
}

function idempotencyRecord(
  replacement: Partial<CloudIdempotencyRecord> = {},
): CloudIdempotencyRecord {
  const response = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    deletionRequest: toCloudDeletionRequest(
      deletionJob({
        targetId: PROJECT_ID,
        targetKind: "project",
      }),
      NOW,
    ),
  };
  return {
    actorAccountId: ACCOUNT_ID,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    idempotencyKeyHashSha256: "a".repeat(64),
    operationId: "projectDeletions.request",
    requestHashSha256: "b".repeat(64),
    responseSnapshot: {
      response,
      snapshotKind: "deletion_job_v1",
      tenantId: ACCOUNT_ID,
    },
    responseStatus: 202,
    resultDigestSha256: hashCanonicalJson(response),
    resultKind: "deletion_job",
    resultResourceId: DELETION_ID,
    scopeHashSha256: "d".repeat(64),
    ...replacement,
  };
}

function firstCallOrder(invocationCallOrder: readonly number[]): number {
  const order = invocationCallOrder[0];
  if (order === undefined) {
    throw new Error("Expected the mock to have been called.");
  }
  return order;
}
