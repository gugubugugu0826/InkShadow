import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0008_project_key_lifecycle.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0009_device_identity_names.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";

describe("0008_project_key_lifecycle SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(migration);
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(PROJECT_ID, "加密项目", NOW, NOW);
    insertDevice(database, DEVICE_ID);
  });

  afterEach(() => {
    database.close();
  });

  it("is repeatable and creates only public metadata and ciphertext-envelope tables", () => {
    const keyMigration = readFileSync(
      new URL("../migrations/0008_project_key_lifecycle.sql", import.meta.url),
      "utf8",
    );
    expect(() => database.exec(keyMigration)).not.toThrow();

    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND name IN (
             'device_public_key_records',
             'project_key_versions',
             'project_device_key_envelopes',
             'project_recovery_key_envelopes'
           )
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual([
      "device_public_key_records",
      "project_device_key_envelopes",
      "project_key_versions",
      "project_recovery_key_envelopes",
    ]);

    const columns = tables.flatMap(({ name }) =>
      (
        database.prepare(`PRAGMA table_info(${name})`).all() as {
          name: string;
        }[]
      ).map(({ name: columnName }) => columnName),
    );
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "private_key",
        "project_data_key",
        "raw_project_data_key",
        "recovery_code",
        "kek",
        "plaintext",
        "secret",
      ]),
    );
    expect(columns).toContain("display_name");
  });

  it("adds a constrained non-secret device display name", () => {
    expect(
      database
        .prepare("SELECT display_name FROM device_public_key_records WHERE device_id = ?")
        .get(DEVICE_ID),
    ).toEqual({ display_name: "此设备" });
    expect(() =>
      database
        .prepare("UPDATE device_public_key_records SET display_name = ? WHERE device_id = ?")
        .run(" ", DEVICE_ID),
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces one active key version and the frozen recovery profile", () => {
    insertKeyVersion(database, 1, "active");
    expect(() => insertKeyVersion(database, 2, "active")).toThrow(/UNIQUE constraint failed/);

    expect(() =>
      database
        .prepare(
          `INSERT INTO project_recovery_key_envelopes (
             recovery_id, project_id, key_version, schema_version, algorithm,
             kdf_algorithm, kdf_version, memory_kib, time_cost, parallelism,
             output_bytes, salt, nonce, ciphertext, verifier, status,
             created_at, confirmed_at, revoked_at
           ) VALUES (?, ?, 1, 1, 'ARGON2ID-AES256GCM',
             'ARGON2ID', 19, 1024, 3, 4, 64, ?, ?, ?, ?,
             'confirmed', ?, ?, NULL)`,
        )
        .run(
          "019f9f4a-b3c7-7350-9226-000000000003",
          PROJECT_ID,
          "A".repeat(22),
          "B".repeat(16),
          "C".repeat(64),
          "D".repeat(43),
          NOW,
          NOW,
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("binds device envelopes to known public keys and project key versions", () => {
    insertKeyVersion(database, 1, "pending_confirmation");
    expect(() =>
      database
        .prepare(
          `INSERT INTO project_device_key_envelopes (
             envelope_id, project_id, key_version, schema_version, algorithm,
             sender_device_id, sender_public_key, sender_public_key_fingerprint,
             recipient_device_id, recipient_public_key, recipient_public_key_fingerprint,
             encapsulated_key, ciphertext, created_at, revoked_at
           ) VALUES (?, ?, 1, 1, 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM',
             ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          "019f9f4a-b3c7-7350-9226-000000000004",
          PROJECT_ID,
          "019f9f4a-b3c7-7350-9226-000000000099",
          "A".repeat(87),
          "a".repeat(64),
          DEVICE_ID,
          "A".repeat(87),
          "a".repeat(64),
          "B".repeat(87),
          "C".repeat(64),
          NOW,
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("passes SQLite integrity and foreign-key checks", () => {
    expect(
      (database.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

function insertDevice(database: DatabaseSync, deviceId: string): void {
  database
    .prepare(
      `INSERT INTO device_public_key_records (
         device_id, account_id, schema_version, algorithm, public_key,
         public_key_fingerprint, key_origin, state, created_at, updated_at, revoked_at
       ) VALUES (?, NULL, 1, 'DHKEM-P256-HKDF-SHA256', ?, ?,
         'local_os_credential', 'trusted', ?, ?, NULL)`,
    )
    .run(deviceId, "A".repeat(87), "a".repeat(64), NOW, NOW);
}

function insertKeyVersion(
  database: DatabaseSync,
  keyVersion: number,
  state: "pending_confirmation" | "active",
): void {
  database
    .prepare(
      `INSERT INTO project_key_versions (
         project_id, key_version, schema_version, algorithm, state,
         revision, created_at, retired_at
       ) VALUES (?, ?, 1, 'AES-256-GCM', ?, 1, ?, NULL)`,
    )
    .run(PROJECT_ID, keyVersion, state, NOW);
}
