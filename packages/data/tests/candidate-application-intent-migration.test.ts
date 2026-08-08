import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const intentMigration = readFileSync(
  new URL("../migrations/0048_candidate_application_intents.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const LEGACY_CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const CONTINUATION_CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const NOW = "2026-08-08T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);

describe("0048 Candidate application intent migration", () => {
  it("backfills legacy rows and enforces immutable task-semantic anchors", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    try {
      await executor.execute(
        `INSERT INTO projects (id, name, created_at, updated_at)
         VALUES (?, 'Candidate migration', ?, ?)`,
        [PROJECT_ID, NOW, NOW],
      );
      await executor.execute(
        `INSERT INTO ai_candidates (
           id, project_id, chapter_id, source, base_version_id,
           content, content_checksum, status, incomplete,
           created_at, updated_at, decided_at
         ) VALUES (?, ?, NULL, 'agent', NULL, 'legacy content', ?, 'ready', 0, ?, ?, NULL)`,
        [LEGACY_CANDIDATE_ID, PROJECT_ID, CHECKSUM, NOW, NOW],
      );

      executor.database.exec(intentMigration);

      const legacy = await executor.select<{
        task_intent: string;
        application_mode: string;
        payload_kind: string;
        anchor_start_utf16: number | null;
        anchor_end_utf16: number | null;
      }>(
        `SELECT task_intent, application_mode, payload_kind,
                anchor_start_utf16, anchor_end_utf16
         FROM ai_candidates WHERE id = ?`,
        [LEGACY_CANDIDATE_ID],
      );
      expect(legacy[0]).toEqual({
        task_intent: "legacy_full_document",
        application_mode: "replace_document",
        payload_kind: "full_document",
        anchor_start_utf16: null,
        anchor_end_utf16: null,
      });

      await executor.execute(
        `INSERT INTO ai_candidates (
           id, project_id, chapter_id, source, base_version_id,
           content, content_checksum, status, incomplete,
           created_at, updated_at, decided_at,
           task_intent, application_mode, payload_kind,
           anchor_start_utf16, anchor_end_utf16
         ) VALUES (?, ?, NULL, 'generate', NULL, '续写片段', ?, 'ready', 0, ?, ?, NULL,
                   'continuation', 'insert_at_cursor', 'fragment', 12, 12)`,
        [CONTINUATION_CANDIDATE_ID, PROJECT_ID, CHECKSUM, NOW, NOW],
      );

      await expect(
        executor.execute(`UPDATE ai_candidates SET anchor_start_utf16 = 11 WHERE id = ?`, [
          CONTINUATION_CANDIDATE_ID,
        ]),
      ).rejects.toThrow(/immutable/u);
      await expect(
        executor.execute(
          `INSERT INTO ai_candidates (
             id, project_id, chapter_id, source, base_version_id,
             content, content_checksum, status, incomplete,
             created_at, updated_at, decided_at,
             task_intent, application_mode, payload_kind,
             anchor_start_utf16, anchor_end_utf16
           ) VALUES ('019f9f4a-b3c7-7350-9226-000000000004', ?, NULL, 'agent', NULL,
                     '错误续写', ?, 'ready', 0, ?, ?, NULL,
                     'continuation', 'insert_at_cursor', 'fragment', 1, 1)`,
          [PROJECT_ID, CHECKSUM, NOW, NOW],
        ),
      ).rejects.toThrow(/invalid AI candidate application intent/u);
    } finally {
      await executor.close();
    }
  });
});
