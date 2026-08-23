import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const displayIdentityMigration = readFileSync(
  new URL("../migrations/0077_project_display_identities.sql", import.meta.url),
  "utf8",
);
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("project display identity content safety", () => {
  it("does not alter authoritative chapter text or immutable versions", async () => {
    const executor = new NodeSqliteExecutor(`
      ${coreMigration}
      CREATE TABLE novel_skill_evaluation_suites (
        id TEXT PRIMARY KEY NOT NULL,
        evaluation_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );
    `);
    executors.push(executor);
    executor.database.exec(`
      INSERT INTO projects (
        id, name, status, revision, deletion_generation, created_at, updated_at
      ) VALUES (
        '019fa720-0000-7000-8000-000000000001', '正文保护', 'active', 1, 0,
        '2026-08-23T03:00:00.000Z', '2026-08-23T03:00:00.000Z'
      );
      BEGIN;
      INSERT INTO chapters (
        id, project_id, title, content, status, revision, current_version_id,
        created_at, updated_at, trashed_at
      ) VALUES (
        '019fa720-1000-7000-8000-000000000001',
        '019fa720-0000-7000-8000-000000000001', '第一章',
        '迁移前后必须完全一致。', 'active', 1,
        '019fa720-2000-7000-8000-000000000001',
        '2026-08-23T03:00:00.000Z', '2026-08-23T03:00:00.000Z', NULL
      );
      INSERT INTO chapter_versions (
        id, project_id, chapter_id, parent_version_id, sequence, content,
        content_checksum, reason, source_candidate_id, created_at
      ) VALUES (
        '019fa720-2000-7000-8000-000000000001',
        '019fa720-0000-7000-8000-000000000001',
        '019fa720-1000-7000-8000-000000000001', NULL, 1,
        '迁移前后必须完全一致。',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'created', NULL, '2026-08-23T03:00:00.000Z'
      );
      COMMIT;
    `);
    const authorityQuery = `
      SELECT chapter.content AS chapterContent, chapter.revision AS chapterRevision,
             chapter.current_version_id AS currentVersionId,
             version.content AS versionContent,
             version.content_checksum AS versionChecksum,
             version.sequence AS versionSequence
      FROM chapters AS chapter
      INNER JOIN chapter_versions AS version ON version.id = chapter.current_version_id
    `;
    const before = await executor.select(authorityQuery);

    executor.database.exec(displayIdentityMigration);

    expect(await executor.select(authorityQuery)).toEqual(before);
  });
});
