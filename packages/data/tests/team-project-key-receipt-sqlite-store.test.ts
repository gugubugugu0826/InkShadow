import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProjectKeySqliteStore,
  type SaveTeamProjectKeyReceiptInput,
} from "../src/project-key-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const receiptMigration = readFileSync(
  new URL("../migrations/0022_team_project_key_receipts.sql", import.meta.url),
  "utf8",
);
const migration = `${coreMigration}\n${receiptMigration}`;

const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000104";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000105";
const NEXT_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000106";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000107";
const ASSIGNMENT_ID = "019f9f4a-b3c7-7350-9226-000000000108";
const SENDER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000109";
const NOW = "2026-07-28T01:00:00.000Z";
const LATER = "2026-07-28T01:01:00.000Z";
const LATEST = "2026-07-28T01:02:00.000Z";

describe("team project-key receipt metadata", () => {
  let executor: NodeSqliteExecutor;
  let store: ProjectKeySqliteStore;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    store = new ProjectKeySqliteStore(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("stores only non-secret metadata and is idempotent under exact retry", async () => {
    const input = receipt();
    const first = await store.saveTeamProjectKeyReceipt(input);
    const replay = await store.saveTeamProjectKeyReceipt({ ...input, receivedAt: LATER });

    expect(first).toMatchObject({
      ok: true,
      value: {
        state: "active",
        receivedAt: NOW,
        lastVerifiedAt: NOW,
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        state: "active",
        receivedAt: NOW,
        lastVerifiedAt: LATER,
      },
    });

    const rows = await executor.select<Record<string, unknown>>(
      "SELECT * FROM team_project_key_receipts",
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(
      /ciphertext|encapsulated|private.?key|raw.?project|recovery.?code|recovery.?envelope/u,
    );
    expect(serialized).not.toContain("secret-envelope-canary");
  });

  it("rejects conflicts and rollback while superseding older openable versions", async () => {
    const first = receipt();
    expect(await store.saveTeamProjectKeyReceipt(first)).toMatchObject({ ok: true });

    expect(
      await store.saveTeamProjectKeyReceipt({
        ...first,
        nativeReceiptFingerprint: "f".repeat(64),
        receivedAt: LATER,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });

    const second = receipt({
      keyVersion: 2,
      envelopeId: NEXT_ENVELOPE_ID,
      nativeStorageRef: `team_project_key_receipt_v1_${"c".repeat(64)}`,
      nativeReceiptFingerprint: "d".repeat(64),
      currentServerRevision: 2,
      currentKeyUpdatedAt: LATER,
      receivedAt: LATER,
    });
    const secondSaved = await store.saveTeamProjectKeyReceipt(second);
    expect(secondSaved).toMatchObject({
      ok: true,
      value: { keyVersion: 2, state: "active" },
    });
    if (!secondSaved.ok) {
      return;
    }
    expect(
      await store.loadTeamProjectKeyReceipt({
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        keyVersion: 1,
      }),
    ).toMatchObject({ ok: true, value: { state: "superseded" } });
    expect(await store.saveTeamProjectKeyReceipt({ ...first, receivedAt: LATEST })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(
      await store.transitionTeamProjectKeyReceiptState({
        nativeStorageRef: secondSaved.value.nativeStorageRef,
        nativeReceiptFingerprint: secondSaved.value.nativeReceiptFingerprint,
        expectedState: "active",
        nextState: "credential_missing",
        updatedAt: LATEST,
      }),
    ).toMatchObject({ ok: true, value: { keyVersion: 2, state: "credential_missing" } });
    expect(
      await store.loadTeamProjectKeyReceipt({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
      }),
    ).toMatchObject({
      ok: true,
      value: { keyVersion: 2, state: "credential_missing" },
    });
  });

  it("uses exact CAS when marking a missing native credential", async () => {
    const saved = await store.saveTeamProjectKeyReceipt(receipt());
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(
      await store.transitionTeamProjectKeyReceiptState({
        nativeStorageRef: saved.value.nativeStorageRef,
        nativeReceiptFingerprint: "f".repeat(64),
        expectedState: "active",
        nextState: "credential_missing",
        updatedAt: LATER,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(
      await store.transitionTeamProjectKeyReceiptState({
        nativeStorageRef: saved.value.nativeStorageRef,
        nativeReceiptFingerprint: saved.value.nativeReceiptFingerprint,
        expectedState: "active",
        nextState: "credential_missing",
        updatedAt: LATER,
      }),
    ).toMatchObject({
      ok: true,
      value: { state: "credential_missing", stateUpdatedAt: LATER },
    });
  });
});

describe("0022_team_project_key_receipts migration", () => {
  it("is repeatable and admits no secret-bearing columns", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(migration);
      expect(() => database.exec(receiptMigration)).not.toThrow();
      const columns = database.prepare("PRAGMA table_info(team_project_key_receipts)").all() as {
        name: string;
      }[];
      const names = columns.map(({ name }) => name);
      expect(names).not.toEqual(
        expect.arrayContaining([
          "ciphertext",
          "encapsulated_key",
          "private_key",
          "raw_project_data_key",
          "recovery_code",
          "recovery_envelope",
        ]),
      );
      expect(names).toEqual(
        expect.arrayContaining([
          "native_storage_ref",
          "native_receipt_fingerprint",
          "current_server_revision",
          "project_key_fingerprint",
        ]),
      );
    } finally {
      database.close();
    }
  });
});

function receipt(
  overrides: Partial<SaveTeamProjectKeyReceiptInput> = {},
): SaveTeamProjectKeyReceiptInput {
  return {
    schemaVersion: 1,
    receiptKind: "team_managed_device_envelope",
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 1,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    envelopeId: ENVELOPE_ID,
    membershipId: MEMBERSHIP_ID,
    membershipRevision: 1,
    assignmentId: ASSIGNMENT_ID,
    assignmentRevision: 1,
    senderDeviceId: SENDER_DEVICE_ID,
    senderPublicKeyFingerprint: "a".repeat(64),
    recipientPublicKeyFingerprint: "b".repeat(64),
    projectKeyFingerprint: "c".repeat(64),
    nativeStorageRef: `team_project_key_receipt_v1_${"a".repeat(64)}`,
    nativeReceiptFingerprint: "b".repeat(64),
    currentServerRevision: 1,
    currentKeyUpdatedAt: NOW,
    envelopeCreatedAt: NOW,
    receivedAt: NOW,
    ...overrides,
  };
}
