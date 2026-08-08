import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const revisionMigration = readFileSync(
  new URL("../migrations/0050_candidate_revision_authority.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const NOW = "2026-08-08T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);

describe("0050 Candidate revision authority migration", () => {
  it("backfills legacy rows at revision one and rejects invalid revisions", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    try {
      await executor.execute(
        `INSERT INTO projects (id, name, created_at, updated_at)
         VALUES (?, 'Candidate revision migration', ?, ?)`,
        [PROJECT_ID, NOW, NOW],
      );
      await executor.execute(
        `INSERT INTO ai_candidates (
           id, project_id, chapter_id, source, base_version_id,
           content, content_checksum, status, incomplete,
           created_at, updated_at, decided_at
         ) VALUES (?, ?, NULL, 'agent', NULL, 'legacy content', ?, 'ready', 0, ?, ?, NULL)`,
        [CANDIDATE_ID, PROJECT_ID, CHECKSUM, NOW, NOW],
      );

      executor.database.exec(revisionMigration);

      await expect(
        executor.select<{ readonly revision: number }>(
          "SELECT revision FROM ai_candidates WHERE id = ?",
          [CANDIDATE_ID],
        ),
      ).resolves.toEqual([{ revision: 1 }]);
      await expect(
        executor.execute("UPDATE ai_candidates SET revision = 0 WHERE id = ?", [CANDIDATE_ID]),
      ).rejects.toThrow(/CHECK constraint failed/u);
    } finally {
      await executor.close();
    }
  });
});
