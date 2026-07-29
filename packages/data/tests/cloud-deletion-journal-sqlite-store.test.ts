import { readFileSync } from "node:fs";

import type { CloudDeletionRequestResponse } from "@inkshadow/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CloudDeletionJournalError,
  CloudDeletionJournalSqliteStore,
} from "../src/cloud-deletion-journal-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0019_cloud_deletion_journal.sql", import.meta.url), "utf8"),
].join("\n");

const JOURNAL_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const MUTATION_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const NEXT_MUTATION_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000104";
const NEXT_CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000105";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000106";
const OTHER_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000107";
const DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000108";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000109";
const CANCELLATION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000110";
const NOW = "2026-07-28T01:00:00.000Z";
const LATER = "2026-07-28T01:01:00.000Z";
const HASH = "a".repeat(64);
const PASSWORD = "test-never-persist-deletion-password";

describe("CloudDeletionJournalSqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let store: CloudDeletionJournalSqliteStore;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    store = new CloudDeletionJournalSqliteStore(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("persists a password-free submission and reuses its exact mutation after restart", async () => {
    const first = await store.prepareSubmission(submissionInput());
    expect(first.activeMutation).toMatchObject({
      mutationId: MUTATION_ID,
      confirmationId: CONFIRMATION_ID,
      idempotencyKey: "deletion-idempotency-0001",
      expectedRevision: 4,
      requestBodySha256: HASH,
      state: "prepared",
    });

    const restartedStore = new CloudDeletionJournalSqliteStore(executor);
    const retried = await restartedStore.prepareSubmission({
      ...submissionInput(),
      mutationId: NEXT_MUTATION_ID,
      confirmationId: NEXT_CONFIRMATION_ID,
      idempotencyKey: "deletion-idempotency-0002",
    });
    expect(retried.activeMutation).toEqual(first.activeMutation);

    const schema = executor.database
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('cloud_deletion_journals', 'cloud_deletion_mutations')
         ORDER BY name`,
      )
      .all()
      .map((row) => String((row as { sql: unknown }).sql))
      .join("\n");
    const rows = executor.database
      .prepare(
        `SELECT json_group_array(json_object(
           'journal', journal_id,
           'email', account_email,
           'receipt', latest_receipt_json
         )) AS snapshot
         FROM cloud_deletion_journals`,
      )
      .get() as { snapshot: string };
    expect(schema.toLowerCase()).not.toContain("password");
    expect(rows.snapshot).not.toContain(PASSWORD);
  });

  it("strictly binds receipts, rejects revision equivocation, and preserves local projects", async () => {
    executor.database
      .prepare(
        `INSERT INTO projects (
           id, name, status, revision, deletion_generation, created_at, updated_at,
           archived_at, trashed_at, retention_until, status_before_trash
         ) VALUES (?, '本地项目', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(PROJECT_ID, NOW, NOW);
    await store.prepareSubmission(submissionInput());

    await expect(
      store.recordMutationReceipt(MUTATION_ID, receipt({ targetId: OTHER_PROJECT_ID }), LATER),
    ).rejects.toMatchObject({
      code: "CLOUD_DELETION_JOURNAL_CORRUPT",
    });

    const accepted = await store.recordMutationReceipt(MUTATION_ID, receipt(), LATER);
    expect(accepted.latestReceipt?.deletionRequest).toMatchObject({
      targetId: PROJECT_ID,
      revision: 1,
      state: "grace_period",
      canCancel: true,
    });
    expect(accepted.recoveryAction).toBe("refresh");

    await expect(
      store.recordObservedReceipt(
        JOURNAL_ID,
        receipt({ scheduledFor: "2026-08-28T01:00:00.000Z" }),
        "2026-07-28T01:02:00.000Z",
      ),
    ).rejects.toMatchObject({
      code: "CLOUD_DELETION_JOURNAL_CORRUPT",
    });
    expect(
      executor.database.prepare("SELECT name FROM projects WHERE id = ?").get(PROJECT_ID),
    ).toEqual({ name: "本地项目" });
  });

  it("uses a separate durable idempotency key for cancellation and closes the grace boundary", async () => {
    await store.prepareSubmission(submissionInput());
    const accepted = await store.recordMutationReceipt(MUTATION_ID, receipt(), LATER);
    const cancellation = await store.prepareCancellation({
      journalId: accepted.journalId,
      mutationId: NEXT_MUTATION_ID,
      idempotencyKey: "deletion-cancellation-0001",
      expectedDeletionRevision: 1,
      requestBodySha256: "b".repeat(64),
      preparedAt: "2026-07-28T01:02:00.000Z",
    });
    expect(cancellation.activeMutation).toMatchObject({
      requestType: "cancellation",
      expectedRevision: 1,
      idempotencyKey: "deletion-cancellation-0001",
    });
    expect(cancellation.recoveryAction).toBe("cancel");

    const cancelled = await store.recordMutationReceipt(
      NEXT_MUTATION_ID,
      receipt({
        requestId: CANCELLATION_REQUEST_ID,
        state: "cancelled",
        revision: 2,
        canCancel: false,
        completedAt: "2026-07-28T01:03:00.000Z",
      }),
      "2026-07-28T01:03:00.000Z",
    );
    expect(cancelled.recoveryAction).toBe("none");
    await expect(
      store.prepareCancellation({
        journalId: accepted.journalId,
        mutationId: "019f9f4a-b3c7-7350-9226-000000000111",
        idempotencyKey: "deletion-cancellation-0002",
        expectedDeletionRevision: 2,
        requestBodySha256: "c".repeat(64),
        preparedAt: "2026-07-28T01:04:00.000Z",
      }),
    ).rejects.toBeInstanceOf(CloudDeletionJournalError);

    const restarted = await store.prepareSubmission({
      ...submissionInput(),
      mutationId: "019f9f4a-b3c7-7350-9226-000000000112",
      confirmationId: "019f9f4a-b3c7-7350-9226-000000000113",
      idempotencyKey: "deletion-idempotency-0003",
      expectedRevision: 6,
      requestBodySha256: "d".repeat(64),
      preparedAt: "2026-07-28T01:05:00.000Z",
    });
    expect(restarted).toMatchObject({
      deletionRequestId: null,
      latestReceipt: null,
      recoveryAction: "submit",
    });
    expect(restarted.activeMutation).toMatchObject({
      mutationId: "019f9f4a-b3c7-7350-9226-000000000112",
      confirmationId: "019f9f4a-b3c7-7350-9226-000000000113",
      expectedRevision: 6,
    });
  });

  it("records retryable recovery without persisting raw error details", async () => {
    await store.prepareSubmission(submissionInput());
    const failed = await store.recordMutationFailure({
      mutationId: MUTATION_ID,
      errorCode: "AUTH_NETWORK_UNAVAILABLE",
      retryable: true,
      failedAt: LATER,
    });
    expect(failed).toMatchObject({
      recoveryAction: "submit",
      lastErrorCode: "AUTH_NETWORK_UNAVAILABLE",
    });
    expect(failed.activeMutation).toMatchObject({
      mutationId: MUTATION_ID,
      state: "retryable_error",
      lastErrorCode: "AUTH_NETWORK_UNAVAILABLE",
    });
    expect(await store.listRecoverable()).toHaveLength(1);
  });
});

function submissionInput() {
  return {
    journalId: JOURNAL_ID,
    mutationId: MUTATION_ID,
    targetKind: "project" as const,
    targetId: PROJECT_ID,
    accountEmail: null,
    confirmationId: CONFIRMATION_ID,
    idempotencyKey: "deletion-idempotency-0001",
    expectedRevision: 4,
    requestBodySha256: HASH,
    preparedAt: NOW,
  };
}

function receipt(
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
      targetKind: "project",
      targetId: overrides.targetId ?? PROJECT_ID,
      state: overrides.state ?? "grace_period",
      phase: "freeze",
      revision: overrides.revision ?? 1,
      requestedAt: NOW,
      scheduledFor: overrides.scheduledFor ?? "2026-08-27T01:00:00.000Z",
      cancellableUntil: "2026-08-27T01:00:00.000Z",
      commitStartedAt: null,
      liveDataPurgedAt: null,
      backupRetainedUntil: null,
      completedAt: overrides.completedAt ?? null,
      blockedReason: null,
      canCancel: overrides.canCancel ?? true,
      impactSummary: {
        projectCount: 1,
        syncOperationCount: 12,
        encryptedChunkCount: 3,
        keyEnvelopeCount: 2,
        deviceCount: 0,
        sessionCount: 0,
      },
    },
  };
}
