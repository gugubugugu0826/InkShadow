import {
  AiCandidate,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type ContentChecksum,
  type IsoUtcTimestamp,
  type UuidV7,
} from "@inkshadow/domain";
import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  ContextTraceOutputCommitError,
  SqliteContextTraceOutputCommitUnitOfWork,
} from "./context-trace-output-commit";

const CORE_MIGRATION = readMigration("0001_core.sql");
const TRACE_MIGRATION = readMigration("0034_context_compilation_trace.sql");
const EXACT_PROVENANCE_MIGRATION = readMigration("0047_context_compilation_exact_provenance.sql");
const CANDIDATE_INTENT_MIGRATION = readMigration("0048_candidate_application_intents.sql");
const CANDIDATE_REVISION_MIGRATION = readMigration("0050_candidate_revision_authority.sql");
const CANDIDATE_PURPOSE_MIGRATION = readMigration("0072_ai_candidate_purpose.sql");
const NOW = iso("2026-08-08T00:00:00.000Z");
const PROJECT_ID = uuid(1);
const SECOND_PROJECT_ID = uuid(2);
const TRACE_ID = uuid(3);
const GENERATION_ID = uuid(4);
const CANDIDATE_ID = uuid(5);
const CHAPTER_ID = uuid(6);
const VERSION_ID = uuid(7);
const SECOND_CHAPTER_ID = uuid(8);
const SECOND_VERSION_ID = uuid(9);

const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("atomic context trace output commit", () => {
  it("commits a ready Candidate and its exact trace association in one SQLite transaction", async () => {
    const executor = await sqliteExecutor();
    const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(executor);
    const candidate = readyCandidate(
      CANDIDATE_ID,
      PROJECT_ID,
      "原始正文保持不变，AI 结果被隔离。",
      "a",
    );

    await expect(unitOfWork.commit({ traceId: TRACE_ID, candidate, linkedAt: NOW })).resolves.toBe(
      "created",
    );

    expect(unitOfWork.capability).toBe("sqlite_atomic");
    await expect(countRows(executor, "ai_candidates")).resolves.toBe(1);
    await expect(countRows(executor, "context_compilation_output_candidate_links")).resolves.toBe(
      1,
    );
    await expect(
      executor.select<{ readonly candidateId: string }>(
        `SELECT ai_candidate_id AS candidateId
         FROM context_compilation_output_candidate_links
         WHERE trace_id = ?`,
        [TRACE_ID],
      ),
    ).resolves.toEqual([{ candidateId: CANDIDATE_ID }]);
  });

  it("rolls the Candidate back when the association write fails after its INSERT", async () => {
    const executor = await sqliteExecutor();
    const failingExecutor = new FailOutputAssociationExecutor(executor);
    const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(failingExecutor);
    const candidate = readyCandidate(CANDIDATE_ID, PROJECT_ID, "不得留下无追溯候选。", "b");

    await expect(
      unitOfWork.commit({ traceId: TRACE_ID, candidate, linkedAt: NOW }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_OUTPUT_UNAVAILABLE" });

    expect(failingExecutor.candidateInsertObserved).toBe(true);
    expect(failingExecutor.outputLinkFailureInjected).toBe(true);
    await expect(countRows(executor, "ai_candidates")).resolves.toBe(0);
    await expect(countRows(executor, "context_compilation_output_candidate_links")).resolves.toBe(
      0,
    );
  });

  it("treats an exact retry as idempotent without duplicating either record", async () => {
    const executor = await sqliteExecutor();
    const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(executor);
    const candidate = readyCandidate(CANDIDATE_ID, PROJECT_ID, "完全相同的重试只保存一次。", "c");
    const input = { traceId: TRACE_ID, candidate, linkedAt: NOW } as const;

    await expect(unitOfWork.commit(input)).resolves.toBe("created");
    await expect(unitOfWork.commit(input)).resolves.toBe("already_committed");
    await expect(countRows(executor, "ai_candidates")).resolves.toBe(1);
    await expect(countRows(executor, "context_compilation_output_candidate_links")).resolves.toBe(
      1,
    );
  });

  it("fails closed when the same Candidate id is retried with different content", async () => {
    const executor = await sqliteExecutor();
    const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(executor);
    const original = readyCandidate(CANDIDATE_ID, PROJECT_ID, "第一次输出。", "d");
    const conflicting = readyCandidate(CANDIDATE_ID, PROJECT_ID, "同一 id 的不同输出。", "e");

    await unitOfWork.commit({ traceId: TRACE_ID, candidate: original, linkedAt: NOW });
    await expect(
      unitOfWork.commit({ traceId: TRACE_ID, candidate: conflicting, linkedAt: NOW }),
    ).rejects.toBeInstanceOf(ContextTraceOutputCommitError);
    await expect(
      unitOfWork.commit({ traceId: TRACE_ID, candidate: conflicting, linkedAt: NOW }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_OUTPUT_CONFLICT" });

    const rows = await executor.select<{ readonly content: string }>(
      "SELECT content FROM ai_candidates WHERE id = ?",
      [CANDIDATE_ID],
    );
    expect(rows).toEqual([{ content: "第一次输出。" }]);
    await expect(countRows(executor, "context_compilation_output_candidate_links")).resolves.toBe(
      1,
    );
  });

  it("rejects a Candidate for another project before any durable write", async () => {
    const executor = await sqliteExecutor();
    const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(executor);
    const candidate = readyCandidate(CANDIDATE_ID, SECOND_PROJECT_ID, "错误作品的输出。", "f");

    await expect(
      unitOfWork.commit({ traceId: TRACE_ID, candidate, linkedAt: NOW }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_OUTPUT_CONFLICT" });
    await expect(countRows(executor, "ai_candidates")).resolves.toBe(0);
    await expect(countRows(executor, "context_compilation_output_candidate_links")).resolves.toBe(
      0,
    );
  });

  it.each([
    {
      name: "project archive",
      mutate: (executor: SqlExecutor) =>
        executor.execute(
          `UPDATE projects
           SET status = 'archived', archived_at = ?
           WHERE id = ?`,
          [NOW, PROJECT_ID],
        ),
    },
    {
      name: "accepted chapter version change",
      mutate: async (executor: SqlExecutor) => {
        const nextVersionId = uuid(10);
        await executor.execute(
          `INSERT INTO chapter_versions (
             id, project_id, chapter_id, parent_version_id, sequence, content,
             content_checksum, reason, source_candidate_id, created_at
           ) VALUES (?, ?, ?, ?, 2, 'new accepted text', ?, 'manual', NULL, ?)`,
          [nextVersionId, PROJECT_ID, CHAPTER_ID, VERSION_ID, "f".repeat(64), NOW],
        );
        return executor.execute(
          `UPDATE chapters
           SET current_version_id = ?, revision = revision + 1, content = 'new accepted text',
               updated_at = ?
           WHERE id = ?`,
          [nextVersionId, NOW, CHAPTER_ID],
        );
      },
    },
  ])("fails closed when a $name wins before the atomic output commit", async ({ mutate }) => {
    const executor = await sqliteExecutor();
    const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(executor);
    const candidate = readyCandidate(CANDIDATE_ID, PROJECT_ID, "stale output", "f");
    await mutate(executor);

    await expect(
      unitOfWork.commit({ traceId: TRACE_ID, candidate, linkedAt: NOW }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_OUTPUT_TARGET_CHANGED", retryable: true });
    await expect(countRows(executor, "ai_candidates")).resolves.toBe(0);
    await expect(countRows(executor, "context_compilation_output_candidate_links")).resolves.toBe(
      0,
    );
  });
});

class FailOutputAssociationExecutor implements SqlExecutor {
  public candidateInsertObserved = false;
  public outputLinkFailureInjected = false;

  public constructor(private readonly delegate: SqlExecutor) {}

  public select<Row extends object>(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, bindValues?: readonly SqlPrimitive[]) =>
          transaction.select<Row>(query, bindValues),
        execute: (query: string, bindValues?: readonly SqlPrimitive[]) => {
          if (query.includes("INSERT INTO ai_candidates")) {
            this.candidateInsertObserved = true;
          }
          if (query.includes("INSERT INTO context_compilation_output_candidate_links")) {
            this.outputLinkFailureInjected = true;
            return Promise.reject(new Error("simulated process failure before association write"));
          }
          return transaction.execute(query, bindValues);
        },
      }),
    );
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function sqliteExecutor(): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(
    `${CORE_MIGRATION}\n${TRACE_MIGRATION}\n
     CREATE TABLE ai_generation_runs (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       chapter_id TEXT,
       candidate_id TEXT
     );
     CREATE TABLE model_invocation_facts (id TEXT PRIMARY KEY);
     ${EXACT_PROVENANCE_MIGRATION}
     ${CANDIDATE_INTENT_MIGRATION}
     ${CANDIDATE_REVISION_MIGRATION}
     ${CANDIDATE_PURPOSE_MIGRATION}`,
  );
  executors.push(executor);
  for (const [id, name] of [
    [PROJECT_ID, "原子提交测试"],
    [SECOND_PROJECT_ID, "其他作品"],
  ] as const) {
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, ?, 'active', 1, 0, ?, ?)`,
      [id, name, NOW, NOW],
    );
  }
  for (const [projectId, chapterId, versionId] of [
    [PROJECT_ID, CHAPTER_ID, VERSION_ID],
    [SECOND_PROJECT_ID, SECOND_CHAPTER_ID, SECOND_VERSION_ID],
  ] as const) {
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at
         ) VALUES (?, ?, 'Chapter', 'accepted text', 'active', 1, ?, ?, ?)`,
        [chapterId, projectId, versionId, NOW, NOW],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, 'accepted text', ?, 'created', NULL, ?)`,
        [versionId, projectId, chapterId, "a".repeat(64), NOW],
      );
    });
  }
  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type, maximum_context_tokens,
       required_tokens, used_tokens, remaining_tokens, discarded_tokens,
       token_estimate_source, candidate_count, included_count, discarded_count, created_at
     ) VALUES (?, ?, ?, 'continuation', 100, 1, 1, 99, 0, 'custom', 1, 1, 0, ?)`,
    [TRACE_ID, PROJECT_ID, CHAPTER_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason, included, discarded_reason,
       estimated_tokens, evaluation_order, layer_order, priority, relevance_score,
       required, budget_remaining_before, budget_remaining_after
     ) VALUES (?, 'current-task', 'current_task', 'Author requested this exact task.',
               1, NULL, 1, 1, 2, 1000, 1, 1, 100, 99)`,
    [TRACE_ID],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entry_sources (
       run_id, candidate_id, source_order, source_type, source_id,
       source_version_id, locator, content_hash
     ) VALUES (?, 'current-task', 1, 'generation_task', 'continuation-test', ?, NULL, NULL)`,
    [TRACE_ID, VERSION_ID],
  );
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, ?, NULL, ?)`,
    [TRACE_ID, GENERATION_ID, NOW],
  );
  return executor;
}

function readyCandidate(
  id: UuidV7,
  projectId: UuidV7,
  content: string,
  checksumCharacter: string,
): AiCandidate {
  const chapterId = projectId === SECOND_PROJECT_ID ? SECOND_CHAPTER_ID : CHAPTER_ID;
  const baseVersionId = projectId === SECOND_PROJECT_ID ? SECOND_VERSION_ID : VERSION_ID;
  const streaming = AiCandidate.createStreaming({
    id,
    projectId,
    chapterId,
    source: "generate",
    baseVersionId,
    now: NOW,
  });
  if (!streaming.ok) {
    throw streaming.error;
  }
  const ready = streaming.value.markReady(content, checksum(checksumCharacter.repeat(64)), NOW);
  if (!ready.ok) {
    throw ready.error;
  }
  return ready.value;
}

async function countRows(executor: SqlExecutor, table: string): Promise<number> {
  if (!/^[a-z_]+$/u.test(table)) {
    throw new Error("Unsafe test table name.");
  }
  const rows = await executor.select<{ readonly count: number }>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return rows[0]?.count ?? -1;
}

function uuid(sequence: number): UuidV7 {
  const parsed = parseUuidV7(`019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function iso(value: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function checksum(value: string): ContentChecksum {
  const parsed = parseContentChecksum(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
