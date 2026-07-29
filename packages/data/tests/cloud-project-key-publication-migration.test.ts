import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0008_project_key_lifecycle.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0009_device_identity_names.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0012_cloud_project_key_publications.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-000000000002";
const NOW = "2026-07-27T00:00:00.000Z";

describe("0012_cloud_project_key_publications SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(migration);
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(PROJECT_ID, "Crash-safe cloud publication", NOW, NOW);
    database
      .prepare(
        `INSERT INTO project_key_versions (
           project_id, key_version, schema_version, algorithm, state,
           revision, created_at, retired_at
         ) VALUES (?, 1, 1, 'AES-256-GCM', 'active', 2, ?, NULL)`,
      )
      .run(PROJECT_ID, NOW);
  });

  afterEach(() => {
    database.close();
  });

  it("is repeatable and stores only an encrypted-request journal", () => {
    expect(() =>
      database.exec(
        readFileSync(
          new URL("../migrations/0012_cloud_project_key_publications.sql", import.meta.url),
          "utf8",
        ),
      ),
    ).not.toThrow();
    database
      .prepare(
        `INSERT INTO cloud_project_key_publications (
           project_id, key_version, idempotency_key, expected_server_revision,
           request_json, state, created_at, updated_at, last_error_code
         ) VALUES (?, 1, ?, NULL, '{}', 'pending', ?, ?, NULL)`,
      )
      .run(PROJECT_ID, IDEMPOTENCY_KEY, NOW, NOW);
    expect(
      database
        .prepare(
          `SELECT project_id, key_version, idempotency_key, state, last_error_code
           FROM cloud_project_key_publications`,
        )
        .get(),
    ).toEqual({
      project_id: PROJECT_ID,
      key_version: 1,
      idempotency_key: IDEMPOTENCY_KEY,
      state: "pending",
      last_error_code: null,
    });
    const columns = (
      database.prepare("PRAGMA table_info(cloud_project_key_publications)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "project_data_key",
        "recovery_code",
        "private_key",
        "access_token",
        "refresh_token",
      ]),
    );
  });

  it("rejects missing versions, invalid route revisions, and ambiguous states", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO cloud_project_key_publications (
             project_id, key_version, idempotency_key, expected_server_revision,
             request_json, state, created_at, updated_at, last_error_code
           ) VALUES (?, 2, ?, 1, '{}', 'pending', ?, ?, NULL)`,
        )
        .run(PROJECT_ID, IDEMPOTENCY_KEY, NOW, NOW),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO cloud_project_key_publications (
             project_id, key_version, idempotency_key, expected_server_revision,
             request_json, state, created_at, updated_at, last_error_code
           ) VALUES (?, 1, ?, 1, '{}', 'pending', ?, ?, NULL)`,
        )
        .run(PROJECT_ID, IDEMPOTENCY_KEY, NOW, NOW),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO cloud_project_key_publications (
             project_id, key_version, idempotency_key, expected_server_revision,
             request_json, state, created_at, updated_at, last_error_code
           ) VALUES (?, 1, ?, NULL, '{}', 'conflicted', ?, ?, NULL)`,
        )
        .run(PROJECT_ID, IDEMPOTENCY_KEY, NOW, NOW),
    ).toThrow(/CHECK constraint failed/);
  });
});
