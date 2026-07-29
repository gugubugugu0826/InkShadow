import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , databasePath, migrationPath] = process.argv;
if (databasePath === undefined || migrationPath === undefined) {
  throw new Error("Expected database and migration paths.");
}

const migration = readFileSync(migrationPath, "utf8");
const database = new DatabaseSync(databasePath);
database.exec(migration);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA synchronous = FULL");

const timestamp = "2026-07-28T09:00:00.000Z";
const projectId = "019f9f4a-b3c7-7350-9226-000000000301";
const chapterId = "019f9f4a-b3c7-7350-9226-000000000302";
const versionId = "019f9f4a-b3c7-7350-9226-000000000303";
const draftId = "019f9f4a-b3c7-7350-9226-000000000304";

database.exec("BEGIN IMMEDIATE");
database
  .prepare(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
  )
  .run(projectId, "真实强退演练", timestamp, timestamp);
database
  .prepare(
    `INSERT INTO chapters (
       id, project_id, title, content, status, revision, current_version_id,
       created_at, updated_at, trashed_at
     ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)`,
  )
  .run(
    chapterId,
    projectId,
    "强退章节",
    "stable-before-hard-kill",
    versionId,
    timestamp,
    timestamp,
  );
database
  .prepare(
    `INSERT INTO chapter_versions (
       id, project_id, chapter_id, parent_version_id, sequence, content,
       content_checksum, reason, source_candidate_id, created_at
     ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
  )
  .run(versionId, projectId, chapterId, "stable-before-hard-kill", "0".repeat(64), timestamp);
database.exec("COMMIT");

database.exec("BEGIN IMMEDIATE");
database
  .prepare(
    `INSERT INTO recovery_drafts (
       id, project_id, chapter_id, base_revision, content, cursor_offset,
       created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
  )
  .run(draftId, projectId, chapterId, "recovery-survives-hard-kill", 12, timestamp, timestamp);
database.exec("COMMIT");

process.stdout.write("RECOVERY_DRAFT_COMMITTED\n");

// The parent deliberately terminates this process without cleanup, modeling
// an OS/task-manager kill after the short-cycle recovery transaction commits.
setInterval(() => undefined, 60_000);
