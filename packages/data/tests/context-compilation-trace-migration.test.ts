import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0034_context_compilation_trace.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";

describe("context compilation trace migration", () => {
  it("is idempotent and exposes no place for creative content, prompts, excerpts, or vectors", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    await insertProject(executor);

    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();
    const tables = await executor.select<{ readonly name: string; readonly sql: string }>(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE type = 'table'
         AND name IN (
           'context_compilation_runs',
           'context_compilation_entries',
           'context_compilation_entry_sources'
         )
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "context_compilation_entries",
      "context_compilation_entry_sources",
      "context_compilation_runs",
    ]);

    const columns = new Map<string, readonly string[]>();
    for (const { name } of tables) {
      const rows = await executor.select<{ readonly name: string }>(`PRAGMA table_info(${name})`);
      columns.set(
        name,
        rows.map(({ name: columnName }) => columnName),
      );
    }
    expect(columns.get("context_compilation_runs")).toEqual([
      "id",
      "project_id",
      "chapter_id",
      "task_type",
      "maximum_context_tokens",
      "required_tokens",
      "used_tokens",
      "remaining_tokens",
      "discarded_tokens",
      "token_estimate_source",
      "candidate_count",
      "included_count",
      "discarded_count",
      "created_at",
    ]);
    expect(columns.get("context_compilation_entries")).not.toEqual(
      expect.arrayContaining(["content", "prompt", "candidate_content", "excerpt", "vector"]),
    );
    expect(columns.get("context_compilation_entry_sources")).toEqual([
      "run_id",
      "candidate_id",
      "source_order",
      "source_type",
      "source_id",
      "source_version_id",
      "locator",
      "content_hash",
    ]);
    for (const { sql } of tables) {
      expect(sql).not.toMatch(/\b(?:prompt|excerpt|embedding|vector)\b/iu);
    }
    await executor.close();
  });

  it("enforces budget decisions, source shape, project ownership, and immutability", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await insertProject(executor);
    await insertRun(executor);
    await insertEntry(executor, {
      candidateId: "current-task",
      included: 1,
      discardedReason: null,
      estimatedTokens: 2,
      evaluationOrder: 1,
      before: 5,
      after: 3,
      required: 1,
    });
    await insertEntry(executor, {
      candidateId: "large-scene",
      included: 0,
      discardedReason: "token_budget_exhausted",
      estimatedTokens: 10,
      evaluationOrder: 2,
      before: 3,
      after: 3,
      required: 0,
    });
    await executor.execute(
      `INSERT INTO context_compilation_entry_sources (
         run_id, candidate_id, source_order, source_type, source_id,
         source_version_id, locator, content_hash
       ) VALUES ('trace-1', 'current-task', 1, 'generation_task', 'task-1',
                 'task-v1', 'task:continuation', 'abc123')`,
    );

    await expect(
      insertEntry(executor, {
        candidateId: "invalid-decision",
        included: 1,
        discardedReason: "token_budget_exhausted",
        estimatedTokens: 1,
        evaluationOrder: 3,
        before: 3,
        after: 2,
        required: 0,
      }),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `INSERT INTO context_compilation_entry_sources (
           run_id, candidate_id, source_order, source_type, source_id,
           source_version_id, locator, content_hash
         ) VALUES ('trace-1', 'current-task', 2, 'not-a-source', 'source-2',
                   NULL, NULL, NULL)`,
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `INSERT INTO context_compilation_runs (
           id, project_id, chapter_id, task_type,
           maximum_context_tokens, required_tokens, used_tokens,
           remaining_tokens, discarded_tokens, token_estimate_source,
           candidate_count, included_count, discarded_count, created_at
         ) VALUES (
           'bad-chapter', ?, 'missing-chapter', 'continuation',
           5, 1, 1, 4, 0, 'custom', 1, 1, 0, ?
         )`,
        [PROJECT_ID, NOW],
      ),
    ).rejects.toThrow(/chapter/iu);
    await expect(
      executor.execute(
        "UPDATE context_compilation_runs SET task_type = 'rewrite' WHERE id = 'trace-1'",
      ),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      executor.execute(
        "UPDATE context_compilation_entries SET priority = 2 WHERE run_id = 'trace-1'",
      ),
    ).rejects.toThrow(/immutable/iu);

    expect(
      await executor.select<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM context_compilation_entries WHERE run_id = 'trace-1'",
      ),
    ).toEqual([{ count: 2 }]);
    await executor.close();
  });
});

async function insertProject(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at
     ) VALUES (?, '上下文审计迁移测试', 'active', 1, 0, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
}

async function insertRun(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type,
       maximum_context_tokens, required_tokens, used_tokens,
       remaining_tokens, discarded_tokens, token_estimate_source,
       candidate_count, included_count, discarded_count, created_at
     ) VALUES (
       'trace-1', ?, NULL, 'continuation',
       5, 2, 2, 3, 10, 'custom', 2, 1, 1, ?
     )`,
    [PROJECT_ID, NOW],
  );
}

async function insertEntry(
  executor: NodeSqliteExecutor,
  input: Readonly<{
    candidateId: string;
    included: 0 | 1;
    discardedReason: string | null;
    estimatedTokens: number;
    evaluationOrder: number;
    before: number;
    after: number;
    required: 0 | 1;
  }>,
): Promise<void> {
  await executor.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason,
       included, discarded_reason, estimated_tokens,
       evaluation_order, layer_order, priority, relevance_score,
       required, budget_remaining_before, budget_remaining_after
     ) VALUES (
       'trace-1', ?, 'current_task', 'Explicit task audit reason.',
       ?, ?, ?, ?, 2, 0, NULL, ?, ?, ?
     )`,
    [
      input.candidateId,
      input.included,
      input.discardedReason,
      input.estimatedTokens,
      input.evaluationOrder,
      input.required,
      input.before,
      input.after,
    ],
  );
}
