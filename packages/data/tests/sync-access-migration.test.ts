import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const syncAccessMigration = readFileSync(
  new URL("../migrations/0003_sync_access.sql", import.meta.url),
  "utf8",
);

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";

describe("0003_sync_access SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(coreMigration);
    database.exec(syncAccessMigration);
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(PROJECT_ID, "密文同步", NOW, NOW);
  });

  afterEach(() => {
    database.close();
  });

  it("is repeatable and creates all ciphertext/access metadata tables", () => {
    expect(() => database.exec(syncAccessMigration)).not.toThrow();

    const rows = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND (
             name LIKE 'sync_%'
             OR name LIKE 'cloud_%'
             OR name LIKE 'registered_%'
             OR name LIKE 'entitlement_%'
             OR name LIKE 'offline_license_%'
             OR name LIKE 'team_membership_%'
           )
         ORDER BY name`,
      )
      .all() as { name: string }[];

    expect(rows.map(({ name }) => name)).toEqual([
      "cloud_account_snapshots",
      "cloud_session_snapshots",
      "entitlement_cache",
      "offline_license_envelopes",
      "registered_device_snapshots",
      "sync_ciphertext_chunks",
      "sync_operation_chunks",
      "sync_outbox_operations",
      "sync_tombstones",
      "sync_transfer_chunks",
      "sync_transfers",
      "team_membership_snapshots",
    ]);
  });

  it("has no column for project keys, bearer credentials, passwords, private keys, or plaintext", () => {
    const tableRows = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND (
             name LIKE 'sync_%'
             OR name LIKE 'cloud_%'
             OR name LIKE 'registered_%'
             OR name LIKE 'entitlement_%'
             OR name LIKE 'offline_license_%'
             OR name LIKE 'team_membership_%'
           )`,
      )
      .all() as { name: string }[];
    const columnNames = tableRows.flatMap(({ name }) =>
      (
        database.prepare(`PRAGMA table_info(${name})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );

    expect(columnNames).not.toContain("project_key");
    expect(columnNames).not.toContain("access_token");
    expect(columnNames).not.toContain("refresh_token");
    expect(columnNames).not.toContain("password");
    expect(columnNames).not.toContain("private_key");
    expect(columnNames).not.toContain("plaintext");
    expect(columnNames).not.toContain("content");
  });

  it("rejects invalid ciphertext and impossible outbox lease states", () => {
    expect(() =>
      insertCiphertextChunk(database, {
        algorithm: "AES-128-GCM",
        nonce: "A".repeat(16),
        hash: "a".repeat(64),
      }),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_outbox_operations (
            operation_id,
            project_id,
            device_id,
            device_sequence,
            object_id,
            object_generation,
            kind,
            vector_json,
            status,
            attempt,
            next_attempt_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, 1, ?, 1, 'delete', ?, 'in_flight', 1, NULL, ?, ?)`,
        )
        .run(
          "019f9f4a-b3c7-7350-9226-000000000004",
          PROJECT_ID,
          DEVICE_ID,
          "019f9f4a-b3c7-7350-9226-000000000005",
          JSON.stringify({ [DEVICE_ID]: 1 }),
          NOW,
          NOW,
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects incoherent account/device lifecycle snapshots", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO cloud_account_snapshots (
            account_id,
            schema_version,
            state,
            revision,
            verified_at,
            deletion_scheduled_for,
            created_at,
            updated_at
          ) VALUES (?, 1, 'active', 1, NULL, NULL, ?, ?)`,
        )
        .run(ACCOUNT_ID, NOW, NOW),
    ).toThrow(/CHECK constraint failed/);

    database
      .prepare(
        `INSERT INTO cloud_account_snapshots (
          account_id,
          schema_version,
          state,
          revision,
          verified_at,
          deletion_scheduled_for,
          created_at,
          updated_at
        ) VALUES (?, 1, 'active', 2, ?, NULL, ?, ?)`,
      )
      .run(ACCOUNT_ID, NOW, NOW, NOW);

    expect(() =>
      database
        .prepare(
          `INSERT INTO registered_device_snapshots (
            device_id,
            account_id,
            schema_version,
            state,
            public_key_fingerprint,
            created_at,
            revoked_at
          ) VALUES (?, ?, 1, 'revoked', ?, ?, NULL)`,
        )
        .run(DEVICE_ID, ACCOUNT_ID, "a".repeat(64), NOW),
    ).toThrow(/CHECK constraint failed/);
  });

  it("passes SQLite integrity and foreign-key checks", () => {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    const violations = database.prepare("PRAGMA foreign_key_check").all();

    expect(integrity.integrity_check).toBe("ok");
    expect(violations).toEqual([]);
  });
});

function insertCiphertextChunk(
  database: DatabaseSync,
  input: { readonly algorithm: string; readonly nonce: string; readonly hash: string },
): void {
  database
    .prepare(
      `INSERT INTO sync_ciphertext_chunks (
        chunk_id,
        project_id,
        object_type,
        object_id,
        version_id,
        chunk_index,
        key_version,
        algorithm,
        nonce,
        ciphertext,
        ciphertext_sha256,
        plaintext_bytes,
        created_at
      ) VALUES (?, ?, 'chapter_version', ?, ?, 0, 1, ?, ?, ?, ?, 4, ?)`,
    )
    .run(
      "019f9f4a-b3c7-7350-9226-000000000006",
      PROJECT_ID,
      "019f9f4a-b3c7-7350-9226-000000000007",
      "019f9f4a-b3c7-7350-9226-000000000008",
      input.algorithm,
      input.nonce,
      "A".repeat(22),
      input.hash,
      NOW,
    );
}
