import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const beforeSelectionAction = ["0001_core.sql", "0048_candidate_application_intents.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const selectionActionMigration = readFileSync(
  new URL("../migrations/0080_candidate_selection_action.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-200000000001";
const NOW = "2026-08-27T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);

describe("0080 Candidate selection action migration", () => {
  it("keeps historical selection rows compatible and guards every new action identity", async () => {
    const executor = new NodeSqliteExecutor(beforeSelectionAction);
    try {
      await executor.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, '选区动作迁移', ?, ?)",
        [PROJECT_ID, NOW, NOW],
      );
      await insertSelection(executor, candidateId(1), null, false);

      executor.database.exec(selectionActionMigration);
      await expect(
        executor.select<{ selection_action: string | null }>(
          "SELECT selection_action FROM ai_candidates WHERE id = ?",
          [candidateId(1)],
        ),
      ).resolves.toEqual([{ selection_action: null }]);

      await insertSelection(executor, candidateId(2), "expand", true);
      await expect(
        executor.select<{ selection_action: string | null }>(
          "SELECT selection_action FROM ai_candidates WHERE id = ?",
          [candidateId(2)],
        ),
      ).resolves.toEqual([{ selection_action: "expand" }]);

      await expect(insertSelection(executor, candidateId(3), null, true)).rejects.toThrow(
        /invalid AI candidate selection action/u,
      );
      await expect(
        executor.execute(
          `INSERT INTO ai_candidates (
             id, project_id, chapter_id, source, base_version_id, content,
             content_checksum, status, incomplete, created_at, updated_at,
             task_intent, application_mode, payload_kind,
             anchor_start_utf16, anchor_end_utf16, selection_action
           ) VALUES (?, ?, NULL, 'generate', NULL, '续写', ?, 'ready', 0, ?, ?,
                     'continuation', 'insert_at_cursor', 'fragment', 2, 2, 'polish')`,
          [candidateId(4), PROJECT_ID, CHECKSUM, NOW, NOW],
        ),
      ).rejects.toThrow(/invalid AI candidate selection action/u);
      await expect(
        executor.execute("UPDATE ai_candidates SET selection_action = 'shorten' WHERE id = ?", [
          candidateId(2),
        ]),
      ).rejects.toThrow(/immutable/u);
    } finally {
      await executor.close();
    }
  });
});

async function insertSelection(
  executor: NodeSqliteExecutor,
  id: string,
  selectionAction: string | null,
  hasColumn: boolean,
): Promise<void> {
  const actionColumn = hasColumn ? ", selection_action" : "";
  const actionPlaceholder = hasColumn ? ", ?" : "";
  await executor.execute(
    `INSERT INTO ai_candidates (
       id, project_id, chapter_id, source, base_version_id, content,
       content_checksum, status, incomplete, created_at, updated_at,
       task_intent, application_mode, payload_kind,
       anchor_start_utf16, anchor_end_utf16${actionColumn}
     ) VALUES (?, ?, NULL, 'polish', NULL, '隔离片段', ?, 'ready', 0, ?, ?,
               'selection_rewrite', 'replace_selection', 'fragment', 1, 4${actionPlaceholder})`,
    [id, PROJECT_ID, CHECKSUM, NOW, NOW, ...(hasColumn ? [selectionAction] : [])],
  );
}

function candidateId(index: number): string {
  return `019f9f4a-b3c7-7350-9226-20000000000${String(index)}`;
}
