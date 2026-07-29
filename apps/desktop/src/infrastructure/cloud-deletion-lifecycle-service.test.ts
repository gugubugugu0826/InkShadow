import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import type { CloudDeletionRequestResponse, CloudProjectStateResponse } from "@inkshadow/contracts";
import { CloudDeletionJournalSqliteStore } from "@inkshadow/data";
import type { Clock, UuidV7, UuidV7Generator } from "@inkshadow/domain";
import { CryptoContentHasher } from "@inkshadow/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  CloudDeletionLifecycleService,
  matchesAccountDeletionConfirmation,
  matchesProjectDeletionConfirmation,
} from "./cloud-deletion-lifecycle-service";
import type { ConfiguredCloudSessionStatus } from "./cloud-session-coordinator";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0019_cloud_deletion_journal.sql"),
].join("\n");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000201";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000202";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000203";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000204";
const DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000205";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000206";
const NOW = "2026-07-28T02:00:00.000Z";
const PASSWORD = "test-valid-deletion-password";
const EMAIL = "writer@example.com";

describe("CloudDeletionLifecycleService", () => {
  let executor: NodeSqliteExecutor;
  let store: CloudDeletionJournalSqliteStore;
  let api: ReturnType<typeof createApi>;
  let sessionCalls: number;
  let session: {
    runWithSession<Value>(
      operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    ): Promise<Value>;
  };
  let identity: ReturnType<typeof createIdentity>;
  let ids: SequenceIds;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    store = new CloudDeletionJournalSqliteStore(executor);
    api = createApi();
    sessionCalls = 0;
    session = {
      runWithSession: async <Value>(
        operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
      ) => {
        sessionCalls += 1;
        return operation(activeSession());
      },
    };
    identity = createIdentity();
    ids = new SequenceIds();
  });

  afterEach(async () => {
    await executor.close();
  });

  it("clears form password before any await and reuses exact submission after restart", async () => {
    let formPassword = PASSWORD;
    const outbound: { body: unknown; idempotencyKey: string }[] = [];
    api.requestProjectDeletion.mockImplementation((_projectId, body, options) => {
      expect(formPassword).toBe("");
      outbound.push({ body, idempotencyKey: options.idempotencyKey });
      if (outbound.length === 1) {
        return Promise.reject(
          new CloudClientError({
            code: "CLOUD_NETWORK_UNAVAILABLE",
            message: "network detail must not be persisted",
            status: null,
            requestId: null,
            retryable: true,
          }),
        );
      }
      return Promise.resolve(deletionReceipt("project", PROJECT_ID));
    });
    const first = service();
    await expect(
      first.requestProjectDeletion({
        projectId: PROJECT_ID,
        password: formPassword,
        clearPassword: () => {
          formPassword = "";
        },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_NETWORK_UNAVAILABLE" });

    const beforeRestart = await store.findByTarget("project", PROJECT_ID);
    expect(beforeRestart?.activeMutation).toMatchObject({
      state: "retryable_error",
      lastErrorCode: "CLOUD_NETWORK_UNAVAILABLE",
    });
    formPassword = PASSWORD;
    const restarted = new CloudDeletionLifecycleService(
      api,
      session as never,
      identity,
      new CloudDeletionJournalSqliteStore(executor),
      new SequenceIds(100),
      fixedClock(),
      new CryptoContentHasher(),
    );
    const completed = await restarted.requestProjectDeletion({
      projectId: PROJECT_ID,
      password: formPassword,
      clearPassword: () => {
        formPassword = "";
      },
    });

    expect(api.getProjectState).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveLength(2);
    expect(outbound[1]).toEqual(outbound[0]);
    expect(completed.receipt.deletionRequest.state).toBe("grace_period");
    expect(completed.journal.activeMutation?.state).toBe("accepted");

    const persisted = JSON.stringify(
      executor.database
        .prepare(
          `SELECT j.*, m.*
           FROM cloud_deletion_journals j
           JOIN cloud_deletion_mutations m ON m.journal_id = j.journal_id`,
        )
        .all(),
    );
    expect(persisted).not.toContain(PASSWORD);
    expect(persisted).not.toContain("network detail");
  });

  it("clears the local session after authoritative account acceptance", async () => {
    let formPassword = PASSWORD;
    api.requestAccountDeletion.mockImplementation((body) => {
      expect(formPassword).toBe("");
      expect(body.password).toBe(PASSWORD);
      expect(body.email).toBe(EMAIL);
      return Promise.resolve(deletionReceipt("account", ACCOUNT_ID));
    });
    const result = await service().requestAccountDeletion({
      email: EMAIL,
      password: formPassword,
      clearPassword: () => {
        formPassword = "";
      },
    });

    expect(result.journal.accountEmail).toBe(EMAIL);
    expect(result.journal.recoveryAction).toBe("lookup");
    expect(identity.clearLocalSession).toHaveBeenCalledWith(SESSION_ID);
    expect(identity.disableAfterReconciliationFailure).not.toHaveBeenCalled();
  });

  it("recovers a lost account acceptance by confirmationId and persists the authoritative request id", async () => {
    let submittedConfirmationId: string | undefined;
    api.requestAccountDeletion.mockImplementation((body) => {
      submittedConfirmationId = body.confirmationId;
      return Promise.reject(
        new CloudClientError({
          code: "CLOUD_NETWORK_UNAVAILABLE",
          message: "the accepted response was lost",
          status: null,
          requestId: null,
          retryable: true,
        }),
      );
    });
    let formPassword = PASSWORD;
    await expect(
      service().requestAccountDeletion({
        email: EMAIL,
        password: formPassword,
        clearPassword: () => {
          formPassword = "";
        },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_NETWORK_UNAVAILABLE" });

    const prepared = await store.findByTarget("account", ACCOUNT_ID);
    expect(prepared?.deletionRequestId).toBeNull();
    expect(prepared?.activeMutation?.confirmationId).toBe(submittedConfirmationId);
    if (prepared === null) {
      throw new Error("Expected a durable account deletion journal.");
    }

    identity.getStatus.mockResolvedValue(activeSession());
    api.lookupAccountDeletion.mockResolvedValue(deletionReceipt("account", ACCOUNT_ID));
    formPassword = PASSWORD;
    const recovered = await service().lookupAccountDeletion({
      journalId: prepared.journalId,
      email: EMAIL,
      password: formPassword,
      clearPassword: () => {
        formPassword = "";
      },
    });

    expect(api.lookupAccountDeletion).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        email: EMAIL,
        password: PASSWORD,
        confirmationId: submittedConfirmationId,
      },
      {},
    );
    expect(recovered.journal.deletionRequestId).toBe(DELETION_REQUEST_ID);
    expect(recovered.journal.activeMutation).toMatchObject({
      mutationId: prepared.activeMutation?.mutationId,
      responseRequestId: REQUEST_ID,
      responseRevision: 1,
      state: "accepted",
    });
    expect(identity.clearLocalSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("looks up and cancels account deletion without consulting a cloud session", async () => {
    let formPassword = PASSWORD;
    api.requestAccountDeletion.mockResolvedValue(deletionReceipt("account", ACCOUNT_ID));
    const requested = await service().requestAccountDeletion({
      email: EMAIL,
      password: formPassword,
      clearPassword: () => {
        formPassword = "";
      },
    });
    const callsAfterRequest = sessionCalls;
    session.runWithSession = () => Promise.reject(new Error("session must not be consulted"));

    api.lookupAccountDeletion.mockResolvedValue(deletionReceipt("account", ACCOUNT_ID));
    formPassword = PASSWORD;
    await service().lookupAccountDeletion({
      journalId: requested.journal.journalId,
      email: EMAIL,
      password: formPassword,
      clearPassword: () => {
        formPassword = "";
      },
    });
    expect(formPassword).toBe("");

    api.cancelAccountDeletion.mockResolvedValue(
      deletionReceipt("account", ACCOUNT_ID, {
        requestId: "019f9f4a-b3c7-7350-9226-000000000207",
        state: "cancelled",
        revision: 2,
        canCancel: false,
        completedAt: "2026-07-28T02:03:00.000Z",
      }),
    );
    formPassword = PASSWORD;
    const cancelled = await service().cancelAccountDeletion({
      journalId: requested.journal.journalId,
      email: EMAIL,
      password: formPassword,
      clearPassword: () => {
        formPassword = "";
      },
    });

    expect(sessionCalls).toBe(callsAfterRequest);
    expect(api.lookupAccountDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        email: EMAIL,
        password: PASSWORD,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
      {},
    );
    const cancelCall = api.cancelAccountDeletion.mock.calls[0];
    expect(cancelCall?.[0]).toMatchObject({
      email: EMAIL,
      password: PASSWORD,
      expectedDeletionRevision: 1,
    });
    expect(cancelCall?.[1].idempotencyKey).toEqual(expect.any(String));
    expect(cancelled.receipt.deletionRequest.state).toBe("cancelled");
    expect(cancelled.journal.recoveryAction).toBe("none");
  });

  it("requires exact typed project names and normalized account emails", () => {
    expect(matchesProjectDeletionConfirmation("雾港纪事", "雾港纪事")).toBe(true);
    expect(matchesProjectDeletionConfirmation("雾港纪事", " 雾港纪事")).toBe(false);
    expect(matchesProjectDeletionConfirmation("雾港纪事", "雾港纪事 ")).toBe(false);
    expect(matchesAccountDeletionConfirmation("Writer@Example.com", EMAIL)).toBe(true);
    expect(matchesAccountDeletionConfirmation(EMAIL, ` ${EMAIL}`)).toBe(false);
  });

  function service(): CloudDeletionLifecycleService {
    return new CloudDeletionLifecycleService(
      api,
      session as never,
      identity,
      store,
      ids,
      fixedClock(),
      new CryptoContentHasher(),
    );
  }
});

function createApi() {
  return {
    requestProjectDeletion: vi.fn<InkShadowCloudApiClient["requestProjectDeletion"]>(),
    getProjectDeletionRequest: vi.fn<InkShadowCloudApiClient["getProjectDeletionRequest"]>(),
    cancelProjectDeletion: vi.fn<InkShadowCloudApiClient["cancelProjectDeletion"]>(),
    requestAccountDeletion: vi.fn<InkShadowCloudApiClient["requestAccountDeletion"]>(),
    lookupAccountDeletion: vi.fn<InkShadowCloudApiClient["lookupAccountDeletion"]>(),
    cancelAccountDeletion: vi.fn<InkShadowCloudApiClient["cancelAccountDeletion"]>(),
    getProjectState: vi
      .fn<InkShadowCloudApiClient["getProjectState"]>()
      .mockResolvedValue(projectState()),
  };
}

function createIdentity() {
  return {
    getStatus: vi.fn().mockResolvedValue(emptyStatus()),
    clearLocalSession: vi.fn().mockResolvedValue(emptyStatus()),
    disableAfterReconciliationFailure: vi.fn(),
  };
}

function projectState(): CloudProjectStateResponse {
  return {
    schemaVersion: 1,
    requestId: "019f9f4a-b3c7-7350-9226-000000000208",
    project: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 4,
      currentKeyPublication: {
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 4,
        publicationRequestSha256: "a".repeat(64),
        publishedAt: NOW,
      },
      updatedAt: NOW,
      sync: {
        headCursor: "cursor-head-000000000000000000000000000000000001",
        minimumAvailableCursor: "cursor-minimum-000000000000000000000000000000001",
        cursorStatus: "incremental_available",
      },
    },
  };
}

function deletionReceipt(
  targetKind: "account" | "project",
  targetId: string,
  overrides: Partial<
    CloudDeletionRequestResponse["deletionRequest"] & {
      readonly requestId: string;
    }
  > = {},
): CloudDeletionRequestResponse {
  return {
    schemaVersion: 1,
    requestId: overrides.requestId ?? REQUEST_ID,
    deletionRequest: {
      schemaVersion: 1,
      deletionRequestId: DELETION_REQUEST_ID,
      targetKind,
      targetId,
      state: overrides.state ?? "grace_period",
      phase: "freeze",
      revision: overrides.revision ?? 1,
      requestedAt: NOW,
      scheduledFor: "2026-08-27T02:00:00.000Z",
      cancellableUntil: "2026-08-27T02:00:00.000Z",
      commitStartedAt: null,
      liveDataPurgedAt: null,
      backupRetainedUntil: null,
      completedAt: overrides.completedAt ?? null,
      blockedReason: null,
      canCancel: overrides.canCancel ?? true,
      impactSummary: {
        projectCount: targetKind === "project" ? 1 : 4,
        syncOperationCount: 12,
        encryptedChunkCount: 3,
        keyEnvelopeCount: 2,
        deviceCount: targetKind === "account" ? 2 : 0,
        sessionCount: targetKind === "account" ? 3 : 0,
      },
    },
  };
}

function activeSession(): ConfiguredCloudSessionStatus {
  return {
    configured: true,
    account: {
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      state: "active",
      revision: 7,
      verifiedAt: NOW,
      deletionScheduledFor: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    device: {
      schemaVersion: 1,
      device: {
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        state: "trusted",
        publicKeyFingerprint: "a".repeat(64),
        createdAt: NOW,
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: "A".repeat(87),
        publicKeyFingerprint: "a".repeat(64),
        createdAt: NOW,
        revokedAt: null,
      },
      displayName: "测试设备",
      revision: 1,
    },
    session: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      clientVersion: "0.1.0",
      minimumClientVersion: "0.1.0",
      issuedAt: NOW,
      expiresAt: "2026-07-28T04:00:00.000Z",
      revokedAt: null,
    },
    expiry: {
      accessExpiresAt: "2026-07-28T04:00:00.000Z",
      refreshExpiresAt: "2026-08-28T04:00:00.000Z",
    },
  };
}

function emptyStatus() {
  return {
    configured: false,
    account: null,
    device: null,
    session: null,
    expiry: null,
  };
}

function fixedClock(): Clock {
  return { now: () => NOW } as unknown as Clock;
}

class SequenceIds implements UuidV7Generator {
  private value: number;

  public constructor(offset = 0) {
    this.value = 300 + offset;
  }

  public next(): UuidV7 {
    const suffix = String(this.value).padStart(12, "0");
    this.value += 1;
    return `019f9f4a-b3c7-7350-9226-${suffix}` as UuidV7;
  }
}

function readMigration(fileName: string): string {
  const candidates = [
    path.resolve(process.cwd(), "../../packages/data/migrations", fileName),
    path.resolve(process.cwd(), "packages/data/migrations", fileName),
  ];
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (filePath === undefined) {
    throw new Error(`Could not locate ${fileName}.`);
  }
  return readFileSync(filePath, "utf8");
}
