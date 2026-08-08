import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const leaseMigration = readFileSync(
  new URL("../migrations/0045_project_remote_dispatch_leases.sql", import.meta.url),
  "utf8",
);

const NOW = "2026-08-08T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const OTHER_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const OTHER_CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const OTHER_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000007";

describe("project remote dispatch lease migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(coreMigration);
    database.exec(
      "ALTER TABLE chapters ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'standard' CHECK (privacy_mode IN ('standard', 'local_only'))",
    );
    database.exec(
      "ALTER TABLE chapters ADD COLUMN privacy_revision INTEGER NOT NULL DEFAULT 1 CHECK (privacy_revision BETWEEN 1 AND 9007199254740991)",
    );
    database.exec(leaseMigration);
    seedProject(database, PROJECT_ID, CHAPTER_ID, VERSION_ID, "standard");
    seedProject(database, OTHER_PROJECT_ID, OTHER_CHAPTER_ID, OTHER_VERSION_ID, "local_only");
  });

  afterEach(() => {
    database.close();
  });

  it("blocks only privacy-tainting writes while a remote request lease is active", () => {
    insertLease(database);

    expect(() =>
      database
        .prepare("UPDATE chapters SET content = ?, revision = revision + 1 WHERE id = ?")
        .run("ordinary autosave remains available", CHAPTER_ID),
    ).not.toThrow();
    expect(() =>
      database
        .prepare("UPDATE chapters SET privacy_mode = 'local_only' WHERE id = ?")
        .run(CHAPTER_ID),
    ).toThrow(/INKSHADOW_REMOTE_DISPATCH_ACTIVE/u);
    expect(() =>
      database
        .prepare("UPDATE chapters SET project_id = ? WHERE id = ?")
        .run(PROJECT_ID, OTHER_CHAPTER_ID),
    ).toThrow(/INKSHADOW_REMOTE_DISPATCH_ACTIVE/u);
    expect(() => database.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT_ID)).toThrow(
      /INKSHADOW_REMOTE_DISPATCH_ACTIVE/u,
    );
  });

  it("allows the delayed privacy transition after the exact lease is released", () => {
    insertLease(database);
    database.prepare("DELETE FROM project_remote_dispatch_leases WHERE lease_id = ?").run(LEASE_ID);

    expect(() =>
      database
        .prepare(
          "UPDATE chapters SET privacy_mode = 'local_only', privacy_revision = privacy_revision + 1 WHERE id = ?",
        )
        .run(CHAPTER_ID),
    ).not.toThrow();
  });

  it("keeps lease authority immutable and rejects new local-only chapters", () => {
    insertLease(database);
    expect(() =>
      database
        .prepare(
          "UPDATE project_remote_dispatch_leases SET network_deadline_at = ? WHERE lease_id = ?",
        )
        .run("2026-08-08T00:20:00.000Z", LEASE_ID),
    ).toThrow(/INKSHADOW_REMOTE_DISPATCH_LEASE_IMMUTABLE/u);

    database.exec("PRAGMA defer_foreign_keys = ON");
    expect(() =>
      database
        .prepare(
          `INSERT INTO chapters (
             id, project_id, title, content, status, revision, current_version_id,
             created_at, updated_at, trashed_at, privacy_mode, privacy_revision
           ) VALUES (?, ?, 'Private', '', 'active', 1, ?, ?, ?, NULL, 'local_only', 1)`,
        )
        .run(
          "019f9f4a-b3c7-7350-9226-000000000008",
          PROJECT_ID,
          "019f9f4a-b3c7-7350-9226-000000000009",
          NOW,
          NOW,
        ),
    ).toThrow(/INKSHADOW_REMOTE_DISPATCH_ACTIVE/u);
  });
});

function insertLease(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO project_remote_dispatch_leases (
         lease_id, project_id, operation_kind, operation_id, owner_runtime_id,
         authority_fingerprint, acquired_at, network_deadline_at
       ) VALUES (?, ?, 'generation', 'generation-1', 'runtime-owner-0001', ?, ?, ?)`,
    )
    .run(LEASE_ID, PROJECT_ID, "a".repeat(64), NOW, "2026-08-08T00:12:00.000Z");
}

function seedProject(
  database: DatabaseSync,
  projectId: string,
  chapterId: string,
  versionId: string,
  privacyMode: "standard" | "local_only",
): void {
  database.exec("BEGIN");
  database
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(projectId, projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chapters (
         id, project_id, title, content, current_version_id,
         created_at, updated_at, privacy_mode, privacy_revision
       ) VALUES (?, ?, 'Chapter', '', ?, ?, ?, ?, 1)`,
    )
    .run(chapterId, projectId, versionId, NOW, NOW, privacyMode);
  database
    .prepare(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, sequence, reason, content,
         content_checksum, created_at
       ) VALUES (?, ?, ?, 1, 'created', '', ?, ?)`,
    )
    .run(versionId, projectId, chapterId, "a".repeat(64), NOW);
  database.exec("COMMIT");
}
