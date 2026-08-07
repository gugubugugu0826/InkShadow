import {
  compileContext,
  type ContextCandidate,
  type ContextTokenEstimator,
} from "@inkshadow/ai-core";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  BrowserDevelopmentContextCompilationTraceStore,
  ContextCompilationTraceStoreError,
  DEVELOPMENT_CONTEXT_COMPILATION_TRACE_KEY,
  SqliteContextCompilationTraceStore,
  createContextCompilationTrace,
  type ContextCompilationTrace,
  type ContextCompilationTraceEntry,
} from "./context-compilation-trace-store";

const coreMigration = readMigration("0001_core.sql");
const traceMigration = readMigration("0034_context_compilation_trace.sql");
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const TRACE_ID = uuid(2);
const SECOND_TRACE_ID = uuid(3);
const CANDIDATE_CONTENT_MARKER = "PRIVATE-CANDIDATE-CONTENT-DO-NOT-PERSIST";
const EVIDENCE_EXCERPT_MARKER = "PRIVATE-EVIDENCE-EXCERPT-DO-NOT-PERSIST";
const EXACT_ESTIMATOR: ContextTokenEstimator = {
  source: "custom",
  estimateTokens(text) {
    return Number.parseInt(text.split(":", 1)[0] ?? "", 10);
  },
};

const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  window.localStorage.clear();
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("context compilation trace stores", () => {
  it("projects a compiled context into a content-free immutable trace", () => {
    const trace = makeTrace(TRACE_ID);

    expect(trace).toMatchObject({
      id: TRACE_ID,
      projectId: PROJECT_ID,
      chapterId: null,
      taskType: "continuation",
      maximumContextTokens: 5,
      requiredTokens: 4,
      usedTokens: 5,
      remainingTokens: 0,
      discardedTokens: 10,
      tokenEstimateSource: "custom",
    });
    expect(trace.entries.map(({ included }) => included)).toEqual([true, true, false, true]);
    expect(trace.entries[2]).toMatchObject({
      candidateId: "scene-large",
      included: false,
      discardedReason: "token_budget_exhausted",
      estimatedTokens: 10,
      evaluationOrder: 3,
    });
    expect(trace.entries[0]?.sources[0]).toEqual({
      sourceType: "story_rule",
      sourceId: "source-locked-rule",
      sourceVersionId: "version-locked-rule",
      locator: "locked_hard_rules:locked-rule",
      contentHash: "hash-locked-rule",
    });
    expect(JSON.stringify(trace)).not.toContain(CANDIDATE_CONTENT_MARKER);
    expect(JSON.stringify(trace)).not.toContain(EVIDENCE_EXCERPT_MARKER);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.entries)).toBe(true);
    expect(Object.isFrozen(trace.entries[0]?.sources)).toBe(true);
  });

  it("round-trips a trace through SQLite and lists content-free summaries", async () => {
    const executor = await sqliteExecutor();
    const store = new SqliteContextCompilationTraceStore(executor);
    const trace = makeTrace(TRACE_ID);

    await store.save(trace);
    await expect(store.findById(TRACE_ID)).resolves.toEqual(trace);
    await expect(store.listByProjectId(PROJECT_ID)).resolves.toEqual([
      {
        id: TRACE_ID,
        projectId: PROJECT_ID,
        chapterId: null,
        taskType: "continuation",
        maximumContextTokens: 5,
        requiredTokens: 4,
        usedTokens: 5,
        remainingTokens: 0,
        discardedTokens: 10,
        tokenEstimateSource: "custom",
        candidateCount: 4,
        includedCount: 3,
        discardedCount: 1,
        createdAt: NOW,
      },
    ]);
    const entryRows = await executor.select<Record<string, unknown>>(
      "SELECT * FROM context_compilation_entries WHERE run_id = ?",
      [TRACE_ID],
    );
    const sourceRows = await executor.select<Record<string, unknown>>(
      "SELECT * FROM context_compilation_entry_sources WHERE run_id = ?",
      [TRACE_ID],
    );
    const persisted = JSON.stringify({ entryRows, sourceRows });
    expect(persisted).not.toContain(CANDIDATE_CONTENT_MARKER);
    expect(persisted).not.toContain(EVIDENCE_EXCERPT_MARKER);
    expect(sourceRows[0]).not.toHaveProperty("excerpt");
    expect(entryRows[0]).not.toHaveProperty("content");
    await expect(store.save(trace)).rejects.toMatchObject({ code: "CONTEXT_TRACE_CONFLICT" });
  });

  it("keeps browser-development parity and fails closed on extra sensitive fields", async () => {
    const store = new BrowserDevelopmentContextCompilationTraceStore(window.localStorage);
    const first = makeTrace(TRACE_ID);
    const second = makeTrace(SECOND_TRACE_ID, "2026-08-01T00:01:00.000Z");

    await store.save(first);
    await store.save(second);
    const serialized = window.localStorage.getItem(DEVELOPMENT_CONTEXT_COMPILATION_TRACE_KEY);
    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain(CANDIDATE_CONTENT_MARKER);
    expect(serialized).not.toContain(EVIDENCE_EXCERPT_MARKER);
    await expect(store.findById(TRACE_ID)).resolves.toEqual(first);
    expect((await store.listByProjectId(PROJECT_ID, 1))[0]?.id).toBe(SECOND_TRACE_ID);

    window.localStorage.setItem(
      DEVELOPMENT_CONTEXT_COMPILATION_TRACE_KEY,
      (serialized ?? "").replace(
        '"candidateId"',
        `"content":"${CANDIDATE_CONTENT_MARKER}","candidateId"`,
      ),
    );
    await expect(store.findById(TRACE_ID)).rejects.toMatchObject({
      code: "CONTEXT_TRACE_CORRUPT",
    });
  });

  it("rejects extra prompt, content, or excerpt fields before either store can persist them", async () => {
    const executor = await sqliteExecutor();
    const stores = [
      new SqliteContextCompilationTraceStore(executor),
      new BrowserDevelopmentContextCompilationTraceStore(window.localStorage),
    ];
    const trace = makeTrace(TRACE_ID);
    const firstEntry = trace.entries[0];
    if (firstEntry === undefined) {
      throw new Error("Expected a trace entry.");
    }
    const firstSource = firstEntry.sources[0];
    if (firstSource === undefined) {
      throw new Error("Expected a trace source.");
    }
    const unsafeEntry = {
      ...firstEntry,
      content: CANDIDATE_CONTENT_MARKER,
    } as unknown as ContextCompilationTraceEntry;
    const unsafeSourceEntry = {
      ...firstEntry,
      sources: [
        {
          ...firstSource,
          excerpt: EVIDENCE_EXCERPT_MARKER,
        },
      ],
    } as unknown as ContextCompilationTraceEntry;
    const unsafeTraces = [
      {
        ...trace,
        prompt: "PRIVATE-PROMPT-DO-NOT-PERSIST",
      } as ContextCompilationTrace,
      {
        ...trace,
        entries: [unsafeEntry, ...trace.entries.slice(1)],
      } as ContextCompilationTrace,
      {
        ...trace,
        entries: [unsafeSourceEntry, ...trace.entries.slice(1)],
      } as ContextCompilationTrace,
    ];

    for (const store of stores) {
      for (const unsafeTrace of unsafeTraces) {
        await expect(store.save(unsafeTrace)).rejects.toBeInstanceOf(
          ContextCompilationTraceStoreError,
        );
      }
      await expect(store.findById(TRACE_ID)).resolves.toBeNull();
    }
  });

  it("detects stored token-accounting corruption instead of returning a plausible audit", async () => {
    const executor = await sqliteExecutor();
    const store = new SqliteContextCompilationTraceStore(executor);
    await store.save(makeTrace(TRACE_ID));

    executor.database.exec("DROP TRIGGER context_compilation_run_immutable");
    await executor.execute(
      "UPDATE context_compilation_runs SET used_tokens = 4, remaining_tokens = 1 WHERE id = ?",
      [TRACE_ID],
    );
    await expect(store.findById(TRACE_ID)).rejects.toMatchObject({
      code: "CONTEXT_TRACE_CORRUPT",
    });
  });
});

function makeTrace(id: string, createdAt = NOW): ContextCompilationTrace {
  const candidates: readonly ContextCandidate[] = [
    candidate("locked_hard_rules", "locked-rule", 2, true),
    candidate("current_task", "current-task", 2, true),
    candidate("scene_goal", "scene-large", 10),
    candidate("semantic_retrieval", "semantic-small", 1),
  ];
  return createContextCompilationTrace({
    id,
    projectId: PROJECT_ID,
    taskType: "continuation",
    compiled: compileContext({
      maximumContextTokens: 5,
      candidates,
      tokenEstimator: EXACT_ESTIMATOR,
    }),
    createdAt,
  });
}

function candidate(
  layer: ContextCandidate["layer"],
  id: string,
  tokens: number,
  required = false,
): ContextCandidate {
  return {
    id,
    layer,
    content: `${String(tokens)}:${CANDIDATE_CONTENT_MARKER}:${id}`,
    selectionReason: required
      ? `The user explicitly required ${id}.`
      : `The current task made ${id} relevant.`,
    evidence: [
      {
        sourceType: layer === "locked_hard_rules" ? "story_rule" : "other",
        sourceId: `source-${id}`,
        sourceVersionId: `version-${id}`,
        locator: `${layer}:${id}`,
        contentHash: `hash-${id}`,
        excerpt: EVIDENCE_EXCERPT_MARKER,
      },
    ],
  };
}

async function sqliteExecutor(): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(`${coreMigration}\n${traceMigration}`);
  executors.push(executor);
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at
     ) VALUES (?, '上下文追踪测试', 'active', 1, 0, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
  return executor;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
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
