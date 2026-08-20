import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  ConsistencyInvestigationSqliteStore,
  type CreateConsistencyInvestigationRunInput,
} from "./consistency-investigation-store";

const taskMigration = readMigration("0002_tasks_notifications.sql");
const investigationMigration = readMigration("0067_consistency_investigation_agent.sql");
const invocationReservationMigration = readMigration(
  "0069_consistency_investigation_invocation_reservation.sql",
);
const parents = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE model_provider_connections (id TEXT PRIMARY KEY);
  CREATE TABLE model_catalog_entries (id TEXT PRIMARY KEY);
  CREATE TABLE context_compilation_runs (id TEXT PRIMARY KEY);
  CREATE TABLE context_compilation_execution_links (
    trace_id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE context_compilation_model_invocation_links (
    trace_id TEXT PRIMARY KEY,
    model_invocation_id TEXT NOT NULL UNIQUE,
    linked_at TEXT NOT NULL
  );
  CREATE TABLE model_invocation_facts (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    error_code TEXT,
    error_summary TEXT,
    provider_dispatch_started_at TEXT,
    completed_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    current_version_id TEXT
  );
  CREATE TABLE chapter_versions (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    project_id TEXT NOT NULL
  );
`;
const migration = `${parents}\n${taskMigration}\n${investigationMigration}\n${invocationReservationMigration}`;
const NOW = "2026-08-18T00:00:00.000Z";
const LATER = "2026-08-18T00:00:01.000Z";
const PROJECT_ID = uuid(1);
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map(async (executor) => executor.close()));
});

describe("ConsistencyInvestigationSqliteStore", () => {
  it("atomically reuses the background task and one idempotent planned run", async () => {
    const { executor, store } = await harness();
    const input = plannedInput(10);
    const first = await store.createPlanned(input);
    const duplicate = await store.createPlanned(input);

    expect(duplicate).toEqual(first);
    await expect(
      executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM consistency_investigation_runs",
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM background_tasks WHERE task_type = 'consistency_investigation'",
      ),
    ).resolves.toEqual([{ count: 1 }]);
    expect(await store.listSteps(first.id)).toHaveLength(7);
  });

  it("recovers reserved or bound work as not_dispatched without a network receipt", async () => {
    const { store } = await harness();
    const run = await store.createPlanned(plannedInput(20));
    const modelStep = (await store.listSteps(run.id)).find(
      ({ name }) => name === "model_synthesis",
    );
    if (modelStep === undefined) throw new Error("model step missing");
    await store.transitionStep({
      stepId: modelStep.id,
      from: ["reserved"],
      status: "bound",
      now: NOW,
    });

    const recovered = await store.recoverInterrupted(LATER);

    expect(recovered).toMatchObject([{ id: run.id, status: "not_dispatched" }]);
    expect((await store.listSteps(run.id)).every(({ status }) => status === "not_dispatched")).toBe(
      true,
    );
  });

  it("recovers an unknown post-dispatch result as ambiguous and never plans another call", async () => {
    const { executor, store } = await harness();
    const run = await store.createPlanned(plannedInput(30));
    const invocationId = uuid(39);
    const modelStep = (await store.listSteps(run.id)).find(
      ({ name }) => name === "model_synthesis",
    );
    if (modelStep === undefined) throw new Error("model step missing");
    await store.transitionStep({
      stepId: modelStep.id,
      from: ["reserved"],
      status: "bound",
      now: NOW,
      plannedInvocationId: invocationId,
    });
    await executor.execute(
      `INSERT INTO model_invocation_facts (id, task, provider_dispatch_started_at)
       VALUES (?, 'contradiction_check', ?)`,
      [invocationId, NOW],
    );

    const recovered = await store.recoverInterrupted(LATER);

    expect(recovered).toMatchObject([{ id: run.id, status: "ambiguous" }]);
    expect(await store.listByProjectId(PROJECT_ID)).toHaveLength(1);
    await expect(
      executor.select<{ count: number; status: string; errorCode: string | null }>(
        `SELECT COUNT(*) AS count, status, error_code AS errorCode
         FROM model_invocation_facts GROUP BY status, error_code`,
      ),
    ).resolves.toEqual([{ count: 1, status: "timed_out", errorCode: "PROVIDER_RESULT_AMBIGUOUS" }]);
  });

  it("stores only exact current EvidenceRef metadata and completes local verification after restart", async () => {
    const { executor, store } = await harness();
    const run = await store.createPlanned(plannedInput(40));
    const invocationId = uuid(49);
    const steps = await store.listSteps(run.id);
    const modelStep = steps.find(({ name }) => name === "model_synthesis");
    if (modelStep === undefined) throw new Error("model step missing");
    await store.transitionStep({
      stepId: modelStep.id,
      from: ["reserved"],
      status: "bound",
      now: NOW,
      plannedInvocationId: invocationId,
    });
    await executor.execute(
      `INSERT INTO model_invocation_facts (id, task, provider_dispatch_started_at)
       VALUES (?, 'contradiction_check', ?)`,
      [invocationId, NOW],
    );
    const observing = await store.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      from: ["planned"],
      status: "observing",
      now: NOW,
    });
    const succeededModelStep = await store.transitionStep({
      stepId: modelStep.id,
      from: ["bound"],
      status: "succeeded",
      now: NOW,
      observationDigest: "f".repeat(64),
      terminalCause: "MODEL_RESPONSE_CONFIRMED",
    });
    await store.saveFindings({
      runId: run.id,
      expectedRevision: observing.revision,
      modelStepId: succeededModelStep.id,
      summary: "发现一项需要作者复核的时间顺序。",
      findings: [
        {
          id: uuid(59),
          severity: "warning",
          authorityGroup: "accepted_body",
          category: "timeline",
          title: "事件顺序冲突",
          explanation: "两处已接受正文给出了互不相容的先后关系。",
          evidence: [
            {
              projectId: PROJECT_ID,
              chapterId: uuid(2),
              immutableVersionId: uuid(3),
              sourceKind: "chapter",
              locator: { kind: "utf16", startOffset: 0, endOffset: 4, sourceLength: 4 },
              excerptDigest: "e".repeat(64),
              sourceCreatedAt: NOW,
              observedAt: NOW,
              currentness: "current",
              branchId: null,
              privacy: "standard",
            },
          ],
        },
      ],
      droppedFindingCount: 0,
      now: NOW,
    });

    const recovered = await store.recoverInterrupted(LATER);
    const findings = await store.listFindings(run.id);

    expect(recovered).toMatchObject([{ id: run.id, status: "succeeded", findingCount: 1 }]);
    expect(findings).toMatchObject([
      {
        title: "事件顺序冲突",
        evidence: [{ chapterId: uuid(2), immutableVersionId: uuid(3) }],
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("正文原文");
  });
});

async function harness(): Promise<
  Readonly<{
    executor: NodeSqliteExecutor;
    store: ConsistencyInvestigationSqliteStore;
  }>
> {
  const executor = new NodeSqliteExecutor(migration);
  executors.push(executor);
  await executor.execute("INSERT INTO projects (id) VALUES (?)", [PROJECT_ID]);
  await executor.execute("INSERT INTO model_provider_connections (id) VALUES ('connection-1')");
  await executor.execute("INSERT INTO model_catalog_entries (id) VALUES ('catalog-1')");
  await executor.execute(
    `INSERT INTO chapters (id, project_id, current_version_id) VALUES (?, ?, ?)`,
    [uuid(2), PROJECT_ID, uuid(3)],
  );
  await executor.execute(
    `INSERT INTO chapter_versions (id, chapter_id, project_id) VALUES (?, ?, ?)`,
    [uuid(3), uuid(2), PROJECT_ID],
  );
  return { executor, store: new ConsistencyInvestigationSqliteStore(executor) };
}

function plannedInput(sequence: number): CreateConsistencyInvestigationRunInput {
  const stepIds = [0, 1, 2, 3, 4, 5, 6].map((offset) => uuid(sequence + 10 + offset)) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    run: {
      id: uuid(sequence),
      taskId: uuid(sequence + 1),
      projectId: PROJECT_ID,
      restartOfRunId: null,
      idempotencyKey: `consistency-investigation:${String(sequence)}`,
      requestFingerprint: sequence.toString(16).padStart(64, "0"),
      chapterCount: 1,
      policy: {
        maximumModelCalls: 1,
        maximumToolSteps: 5,
        maximumContextCharacters: 120_000,
        maximumOutputTokens: 4_096,
        maximumDurationMs: 120_000,
        automaticRetryCount: 0,
      },
      estimatedInputTokens: 100,
      estimatedMaximumCostMicros: null,
      currency: null,
      connectionId: "connection-1",
      catalogEntryId: "catalog-1",
      providerKind: "fake",
      modelId: "fake-model",
      privacyFingerprint: "a".repeat(64),
      generationId: uuid(sequence + 2),
      createdAt: NOW,
    },
    stepIds,
    stepInputDigests: {
      read_story_memory: "1".repeat(64),
      inspect_fact: "2".repeat(64),
      search_fts: "3".repeat(64),
      inspect_causal: "4".repeat(64),
      validate_evidence: "5".repeat(64),
      model_synthesis: "6".repeat(64),
      verify_findings: "7".repeat(64),
    },
  };
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function readMigration(name: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) throw new Error("InkShadow workspace root could not be located.");
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", name), "utf8");
}
