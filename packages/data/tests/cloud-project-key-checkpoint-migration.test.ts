import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0008_project_key_lifecycle.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0009_device_identity_names.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0011_cloud_project_key_checkpoints.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const NOW = "2026-07-27T00:00:00.000Z";

describe("0011_cloud_project_key_checkpoints SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(migration);
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(PROJECT_ID, "云密钥检查点", NOW, NOW);
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

  it("is repeatable and stores only monotonic public publication metadata", () => {
    expect(() =>
      database.exec(
        readFileSync(
          new URL("../migrations/0011_cloud_project_key_checkpoints.sql", import.meta.url),
          "utf8",
        ),
      ),
    ).not.toThrow();
    database
      .prepare(
        `INSERT INTO cloud_project_key_checkpoints (
           project_id, current_key_version, server_revision, updated_at
         ) VALUES (?, 1, 1, ?)`,
      )
      .run(PROJECT_ID, NOW);
    expect(
      database
        .prepare(
          `SELECT project_id, current_key_version, server_revision, updated_at
           FROM cloud_project_key_checkpoints`,
        )
        .get(),
    ).toEqual({
      project_id: PROJECT_ID,
      current_key_version: 1,
      server_revision: 1,
      updated_at: NOW,
    });
    const columns = (
      database.prepare("PRAGMA table_info(cloud_project_key_checkpoints)").all() as {
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

  it("rejects missing key versions and invalid revisions", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO cloud_project_key_checkpoints (
             project_id, current_key_version, server_revision, updated_at
           ) VALUES (?, 2, 1, ?)`,
        )
        .run(PROJECT_ID, NOW),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO cloud_project_key_checkpoints (
             project_id, current_key_version, server_revision, updated_at
           ) VALUES (?, 1, 0, ?)`,
        )
        .run(PROJECT_ID, NOW),
    ).toThrow(/CHECK constraint failed/);
  });
});
