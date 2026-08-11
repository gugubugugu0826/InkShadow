import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NOVEL_SKILL_EVALUATION_METRICS,
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  createNovelSkillEvaluationExecutionPlan,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  NovelSkillPaidEvaluationControlSqliteStore,
  type SealNovelSkillPaidEvaluationBlindScoresInput,
} from "./novel-skill-paid-evaluation-control-sqlite-store";
import { NovelSkillEvaluationSqliteStore } from "./novel-skill-evaluation-sqlite-store";
import { NovelSkillSqliteStore } from "./novel-skill-sqlite-store";

const migration = [
  "0001_core.sql",
  "0004_model_profiles.sql",
  "0005_ai_generation_governance.sql",
  "0007_model_routing_usage.sql",
  "0030_creative_journeys.sql",
  "0031_model_hub.sql",
  "0032_unified_story_facts.sql",
  "0034_context_compilation_trace.sql",
  "0035_writing_feedback_learning.sql",
  "0036_story_planning_candidates.sql",
  "0037_model_hub_expert_options.sql",
  "0039_project_seeds.sql",
  "0046_model_hub_zhipu_glm.sql",
  "0047_context_compilation_exact_provenance.sql",
  "0048_candidate_application_intents.sql",
  "0056_model_hub_failure_diagnostics.sql",
  "0057_model_hub_content_quality_task.sql",
  "0058_story_settings_import_receipts.sql",
  "0059_generation_preflight_cost_status.sql",
  "0060_novel_skill_registry.sql",
  "0061_novel_skill_evaluation_ledger.sql",
  "0063_novel_skill_evaluation_paid_runner.sql",
  "0064_novel_skill_evaluation_predispatch_authority.sql",
]
  .map((file) =>
    readFileSync(path.join(repositoryRoot(), "packages/data/migrations", file), "utf8"),
  )
  .join("\n");

const NOW = "2026-08-11T00:00:00.000Z";
const STARTED_AT = "2026-08-11T00:00:01.000Z";
const ASSIGNED_AT = "2026-08-11T00:00:02.000Z";
const SCORED_AT = "2026-08-11T00:00:03.000Z";
const SEALED_AT = "2026-08-11T00:00:04.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-8200-000000000001";
const SUITE_ID = "019f9f4a-b3c7-7350-8200-000000000002";
const RUN_ID = "019f9f4a-b3c7-7350-8200-000000000003";
const BATCH_ID = "019f9f4a-b3c7-7350-8200-000000000004";
const SECOND_BATCH_ID = "019f9f4a-b3c7-7350-8200-000000000005";
const REVIEWER_ID = "reviewer-local-01";
const PREFERENCE_CONFIGURATION_HASH = "a".repeat(64);
const CONNECTION_ID = "paid-blind-integration-connection";
const MODEL_SLOTS = [
  { slotId: "text_tier_a", modelTier: "economy" },
  { slotId: "text_tier_b", modelTier: "quality" },
] as const;

interface EvaluationCellRow {
  readonly id: string;
  readonly fixture_id: string;
  readonly task_type: string;
  readonly arm: "no_skill" | "core" | "core_genre" | "core_genre_preferences";
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
}

interface BlindItemPersistenceRow {
  readonly blind_item_id: string;
  readonly observation_id: string;
  readonly randomized_position: number;
}

const openExecutors = new Set<NodeSqliteExecutor>();
let temporaryDirectory = "";
let templateDatabasePath = "";
let databaseSequence = 0;
let fixtureSetupPromise: Promise<void> | undefined;

beforeAll(() => {
  fixtureSetupPromise = prepareTemplateDatabase();
  return fixtureSetupPromise;
}, 60_000);

afterEach(async () => {
  await closeOpenExecutors();
});

afterAll(async () => {
  // If Vitest times out the setup hook, its async work is not cancelled. Wait
  // for the same promise so the template handle closes before removing files.
  await fixtureSetupPromise?.catch(() => undefined);
  await closeOpenExecutors();
  if (temporaryDirectory !== "") {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}, 60_000);

async function prepareTemplateDatabase(): Promise<void> {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "inkshadow-paid-blind-"));
  templateDatabasePath = path.join(temporaryDirectory, "template.sqlite3");
  const executor = new NodeSqliteExecutor(migration, templateDatabasePath);
  try {
    await seedCompleteBlindReviewEvidence(executor);
  } finally {
    await executor.close();
  }
}

async function closeOpenExecutors(): Promise<void> {
  await Promise.all([...openExecutors].map((executor) => executor.close()));
  openExecutors.clear();
}

describe("NovelSkillPaidEvaluationControlSqliteStore real SQLite integration", () => {
  it("persists one randomized 192-position batch and exposes only reviewer-safe DTOs", async () => {
    const { executor } = openSeededDatabase("randomized-safe-projection");
    const store = controlStore(executor);

    await expect(store.createBlindReviewBatch(batchInput(BATCH_ID))).resolves.toMatchObject({
      batchId: BATCH_ID,
      runId: RUN_ID,
      reviewerId: REVIEWER_ID,
      itemCount: 192,
    });

    const persisted = await executor.select<BlindItemPersistenceRow>(
      `SELECT blind_item_id, observation_id, randomized_position
       FROM novel_skill_evaluation_review_items
       WHERE batch_id = ? ORDER BY randomized_position`,
      [BATCH_ID],
    );
    expect(persisted).toHaveLength(192);
    expect(new Set(persisted.map(({ observation_id: id }) => id)).size).toBe(192);
    expect(persisted.map(({ randomized_position: position }) => position)).toEqual(
      Array.from({ length: 192 }, (_, index) => index + 1),
    );
    const randomizedObservationIds = persisted.map(({ observation_id: id }) => id);
    expect(randomizedObservationIds).not.toEqual(
      [...randomizedObservationIds].sort((left, right) => left.localeCompare(right, "en")),
    );

    const reviewerBatch = await store.readBlindReviewBatch({
      batchId: BATCH_ID,
      reviewerId: REVIEWER_ID,
    });
    expect(reviewerBatch).toHaveLength(192);
    expect(Object.keys(reviewerBatch[0] ?? {})).toEqual([
      "blindItemId",
      "position",
      "fixtureTaskContent",
      "boundaries",
      "lockedFacts",
      "requestedOutcome",
      "candidateOutput",
      "scores",
    ]);
    const leakedKeys = collectKeys(reviewerBatch).filter((key) =>
      [
        "arm",
        "model",
        "modelid",
        "modelslotid",
        "slot",
        "repetition",
        "cost",
        "hash",
        "observationid",
      ].includes(key.toLowerCase()),
    );
    expect(leakedKeys).toEqual([]);
    expect(Object.isFrozen(reviewerBatch)).toBe(true);
    expect(Object.isFrozen(reviewerBatch[0]?.scores)).toBe(true);
  });

  it("seals exactly 13 scores and one receipt, observes the cell, and retries idempotently", async () => {
    const { executor } = openSeededDatabase("seal-idempotent");
    const store = controlStore(executor);
    await store.createBlindReviewBatch(batchInput(BATCH_ID));
    const items = await store.readBlindReviewBatch({ batchId: BATCH_ID, reviewerId: REVIEWER_ID });
    const first = requiredItem(items, 0);
    const second = requiredItem(items, 1);
    const input = scoreInput(first.blindItemId);

    const receipt = await store.sealBlindScores(input);
    expect(receipt).toMatchObject({
      batchId: BATCH_ID,
      blindItemId: first.blindItemId,
      reviewerId: REVIEWER_ID,
      rubricVersion: "novel-skill-human-rubric@1",
      metricCount: 13,
    });
    expect(receipt.scoresManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await sealedEvidenceCounts(executor, first.blindItemId)).toEqual({
      score_count: 13,
      receipt_count: 1,
      observed_cell_count: 1,
    });

    await expect(store.sealBlindScores(input)).resolves.toEqual(receipt);
    expect(await sealedEvidenceCounts(executor, first.blindItemId)).toEqual({
      score_count: 13,
      receipt_count: 1,
      observed_cell_count: 1,
    });

    const incompleteScores = Object.fromEntries(
      NOVEL_SKILL_EVALUATION_METRICS.slice(0, 12).map((metric) => [metric, 0.71]),
    );
    await expect(
      store.sealBlindScores({
        ...scoreInput(second.blindItemId),
        scores: incompleteScores,
      } as unknown as SealNovelSkillPaidEvaluationBlindScoresInput),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    expect(await sealedEvidenceCounts(executor, second.blindItemId)).toEqual({
      score_count: 0,
      receipt_count: 0,
      observed_cell_count: 0,
    });
  });

  it("rolls back all score and receipt writes after a mid-transaction fault or lost cell CAS", async () => {
    const { executor } = openSeededDatabase("rollback");
    const baseStore = controlStore(executor);
    await baseStore.createBlindReviewBatch(batchInput(BATCH_ID));
    const [first, second] = await baseStore.readBlindReviewBatch({
      batchId: BATCH_ID,
      reviewerId: REVIEWER_ID,
    });
    if (first === undefined || second === undefined) throw new Error("blind items missing");

    const midwayStore = new NovelSkillPaidEvaluationControlSqliteStore(
      new FaultInjectingSqlExecutor(executor, { kind: "score_insert", failAt: 7 }),
    );
    await expect(midwayStore.sealBlindScores(scoreInput(first.blindItemId))).rejects.toThrow(
      "injected score persistence failure",
    );
    expect(await sealedEvidenceCounts(executor, first.blindItemId)).toEqual({
      score_count: 0,
      receipt_count: 0,
      observed_cell_count: 0,
    });

    const lostCasStore = new NovelSkillPaidEvaluationControlSqliteStore(
      new FaultInjectingSqlExecutor(executor, { kind: "cell_cas" }),
    );
    await expect(
      lostCasStore.sealBlindScores(scoreInput(second.blindItemId)),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    expect(await sealedEvidenceCounts(executor, second.blindItemId)).toEqual({
      score_count: 0,
      receipt_count: 0,
      observed_cell_count: 0,
    });
  });

  it("allows only one of two concurrent SQLite connections to create a batch for the run", async () => {
    const { executor: firstExecutor, databasePath } = openSeededDatabase("concurrent-batch");
    const secondExecutor = openExistingDatabase(databasePath);
    const firstStore = controlStore(firstExecutor, 9);
    const secondStore = controlStore(secondExecutor, 23);

    const results = await Promise.allSettled([
      firstStore.createBlindReviewBatch(batchInput(BATCH_ID)),
      secondStore.createBlindReviewBatch(batchInput(SECOND_BATCH_ID)),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(
      firstExecutor.select<{ readonly batch_count: number; readonly item_count: number }>(
        `SELECT count(*) AS batch_count,
                (SELECT count(*) FROM novel_skill_evaluation_review_items) AS item_count
         FROM novel_skill_evaluation_review_batches WHERE run_id = ?`,
        [RUN_ID],
      ),
    ).resolves.toEqual([{ batch_count: 1, item_count: 192 }]);
  });
});

type InjectedFault =
  Readonly<{ kind: "score_insert"; failAt: number }> | Readonly<{ kind: "cell_cas" }>;

class FaultInjectingSqlExecutor implements SqlExecutor {
  public constructor(
    private readonly delegate: NodeSqliteExecutor,
    private readonly fault: InjectedFault,
  ) {}

  public select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues: readonly SqlPrimitive[] = []): Promise<ExecuteResult> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction(async (transaction) => {
      let scoreInsertCount = 0;
      const fault = this.fault;
      const injected: TransactionExecutor = {
        select: <Row extends object>(query: string, bindValues: readonly SqlPrimitive[] = []) =>
          transaction.select<Row>(query, bindValues),
        execute: async (
          query: string,
          bindValues: readonly SqlPrimitive[] = [],
        ): Promise<ExecuteResult> => {
          if (query.includes("INSERT INTO novel_skill_evaluation_scores")) {
            scoreInsertCount += 1;
            if (fault.kind === "score_insert" && scoreInsertCount === fault.failAt) {
              throw new Error("injected score persistence failure");
            }
          }
          if (fault.kind === "cell_cas" && query.includes("SET state = 'observed'")) {
            return { rowsAffected: 0 };
          }
          return transaction.execute(query, bindValues);
        },
      };
      return operation(injected);
    });
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function seedCompleteBlindReviewEvidence(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at, archived_at,
       trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Paid blind review integration', 'archived', 1, 0, ?, ?, ?, NULL, NULL, NULL)`,
    [PROJECT_ID, NOW, NOW, NOW],
  );

  const skillStore = new NovelSkillSqliteStore(executor);
  const coreDefinitions = await createCoreNovelSkillDefinitions();
  const genreDefinitions = await createGenreNovelSkillDefinitions();
  for (const definition of [...coreDefinitions, ...genreDefinitions]) {
    await skillStore.insertDefinition(definition);
  }
  const core = coreDefinitions.map(({ skillId, version, definitionHash, kind }) => ({
    skillId,
    version,
    definitionHash,
    kind: kind as "core",
  }));
  const genre = genreDefinitions.map(({ skillId, version, definitionHash, kind }) => ({
    skillId,
    version,
    definitionHash,
    kind: kind as "genre",
  }));
  const evaluationStore = new NovelSkillEvaluationSqliteStore(executor);
  await evaluationStore.createSuite({
    suiteId: SUITE_ID,
    evaluationProjectId: PROJECT_ID,
    plan: createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS),
    manifests: {
      core,
      coreGenre: [...core, ...genre],
      coreGenrePreferences: [...core, ...genre],
    },
    preferenceConfigurationHash: PREFERENCE_CONFIGURATION_HASH,
    createdAt: NOW,
  });
  await evaluationStore.createRun({
    runId: RUN_ID,
    suiteId: SUITE_ID,
    modelAssignments: [
      {
        slotId: "text_tier_a",
        modelIdentityHash: "1".repeat(64),
        modelArtifactHash: "2".repeat(64),
      },
      {
        slotId: "text_tier_b",
        modelIdentityHash: "3".repeat(64),
        modelArtifactHash: "4".repeat(64),
      },
    ],
    createdAt: NOW,
  });
  await evaluationStore.startRun(RUN_ID, STARTED_AT);
  await seedLocalModelConnection(executor);

  // The paid dispatch Store's full settled-output chain is covered by its own
  // real-SQLite integration. This fixture keeps all foreign keys valid and all
  // 0063 blind-review guards active, while bypassing only the two upstream
  // insertion guards that would otherwise require 192 provider settlements.
  executor.database.exec(`
    DROP TRIGGER novel_skill_evaluation_attempt_insert_guard;
    DROP TRIGGER novel_skill_evaluation_observation_trace_guard;
  `);

  const cells = await executor.select<EvaluationCellRow>(
    `SELECT cell.id, cell.fixture_id, fixture.task_type, cell.arm,
            cell.arm_configuration_hash, cell.model_slot_id, cell.repetition
     FROM novel_skill_evaluation_cells AS cell
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
     WHERE cell.run_id = ?
     ORDER BY cell.fixture_id, cell.arm, cell.model_slot_id, cell.repetition`,
    [RUN_ID],
  );
  if (cells.length !== 192) throw new Error("expected exact 192-cell evaluation matrix");

  for (const [index, cell] of cells.entries()) {
    await seedCompletedObservationChain(executor, cell, index + 1);
  }
  await seedPaidProtocol(executor);

  const foreignKeyViolations = await executor.select<Record<string, SqlPrimitive>>(
    "PRAGMA foreign_key_check",
  );
  if (foreignKeyViolations.length !== 0) {
    throw new Error("paid blind review fixture contains a foreign-key violation");
  }
}

async function seedCompletedObservationChain(
  executor: NodeSqliteExecutor,
  cell: EvaluationCellRow,
  index: number,
): Promise<void> {
  const observationId = uuid(10_000 + index);
  const attemptId = uuid(20_000 + index);
  const traceId = uuid(30_000 + index);
  const invocationId = uuid(40_000 + index);
  const candidateId = uuid(50_000 + index);
  const content = `隔离盲评候选正文 ${String(index)}`;
  const resultHash = await sha256Hex(content);

  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type, maximum_context_tokens, required_tokens,
       used_tokens, remaining_tokens, discarded_tokens, token_estimate_source,
       candidate_count, included_count, discarded_count, created_at
     ) VALUES (?, ?, NULL, ?, 7000, 1, 1, 6999, 0, 'utf8_conservative', 1, 1, 0, ?)`,
    [traceId, PROJECT_ID, cell.task_type, NOW],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, route_task, connection_id, catalog_entry_id, provider_kind_snapshot,
       model_id_snapshot, route_reason, status, attempt, fallback_from_invocation_id,
       privacy_policy, data_destination, maximum_cost_micros, currency,
       input_tokens, output_tokens, cached_input_tokens, estimated_cost_micros,
       error_code, error_summary, started_at, completed_at, created_at, revision,
       diagnostic_request_id, failure_stage, failure_retryable, http_status,
       finish_reason, visible_content_length, reasoning_present, streamed,
       requested_max_output_tokens
     ) VALUES (
       ?, ?, NULL, ?, NULL, 'ollama', 'blind-review-fixture', 'legacy', 'succeeded', 1,
       NULL, 'local_preferred', 'local', NULL, NULL, 1, 1, 0, NULL, NULL, NULL,
       ?, ?, ?, 1, NULL, NULL, NULL, NULL, 'stop', ?, 0, 1, 64
     )`,
    [invocationId, cell.task_type, CONNECTION_ID, NOW, NOW, NOW, content.length],
  );
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, ?, NULL, ?)`,
    [traceId, invocationId, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_model_invocation_links (
       trace_id, model_invocation_id, linked_at
     ) VALUES (?, ?, ?)`,
    [traceId, invocationId, NOW],
  );
  await executor.execute(
    `INSERT INTO ai_candidates (
       id, project_id, chapter_id, source, base_version_id, content, content_checksum,
       status, incomplete, created_at, updated_at, decided_at,
       task_intent, application_mode, payload_kind, anchor_start_utf16, anchor_end_utf16
     ) VALUES (
       ?, ?, NULL, 'generate', NULL, ?, ?, 'ready', 0, ?, ?, NULL,
       'legacy_full_document', 'replace_document', 'full_document', NULL, NULL
     )`,
    [candidateId, PROJECT_ID, content, resultHash, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_output_candidate_links (
       trace_id, ai_candidate_id, linked_at
     ) VALUES (?, ?, ?)`,
    [traceId, candidateId, NOW],
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_attempts (
       id, run_id, cell_id, attempt_number, status, context_trace_id,
       model_invocation_id, error_code, started_at, completed_at
     ) VALUES (?, ?, ?, 1, 'succeeded', ?, ?, NULL, ?, ?)`,
    [attemptId, RUN_ID, cell.id, traceId, invocationId, NOW, NOW],
  );
  const [modelIdentityHash, modelArtifactHash] =
    cell.model_slot_id === "text_tier_a"
      ? ["1".repeat(64), "2".repeat(64)]
      : ["3".repeat(64), "4".repeat(64)];
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_observations (
       id, run_id, cell_id, attempt_id, context_trace_id, model_invocation_id,
       output_candidate_id, novel_skill_snapshot_id, model_identity_hash,
       model_artifact_hash, arm_configuration_hash, preference_configuration_hash,
       evaluator_version, result_hash, latency_milliseconds, input_tokens,
       output_tokens, estimated_cost_micros, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'novel-skill-ab@1', ?, 1, 1, 1, 0, ?)`,
    [
      observationId,
      RUN_ID,
      cell.id,
      attemptId,
      traceId,
      invocationId,
      candidateId,
      modelIdentityHash,
      modelArtifactHash,
      cell.arm_configuration_hash,
      cell.arm === "core_genre_preferences" ? PREFERENCE_CONFIGURATION_HASH : null,
      resultHash,
      NOW,
    ],
  );
}

async function seedLocalModelConnection(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, region, workspace_id, endpoint_id,
       base_url, credential_ref, credential_state, connection_status, catalog_sync_status,
       last_tested_at, last_catalog_synced_at, last_error_code, last_error_summary,
       legacy_provider_id, enabled, revision, created_at, updated_at,
       authentication_mode, credential_header_name, model_discovery_path,
       text_generation_path, embedding_path, request_timeout_ms, retry_limit
     ) VALUES (
       ?, 'ollama', 'Blind review fixture', 'ollama', NULL, NULL, NULL,
       'http://127.0.0.1.invalid', NULL, 'missing', 'not_tested', 'never',
       NULL, NULL, NULL, NULL, NULL, 0, 1, ?, ?, 'none', NULL, NULL, NULL, NULL, 30000, 0
     )`,
    [CONNECTION_ID, NOW, NOW],
  );
}

async function seedPaidProtocol(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_protocols (
       suite_id, schema_version, execution_protocol_version, protocol_hash,
       request_profile_manifest_hash, context_baseline_manifest_hash,
       prompt_template_version, prompt_template_hash, rubric_version,
       rubric_content_hash, evaluator_contract_hash, blinding_protocol_version,
       blinding_protocol_hash, randomization_protocol_version,
       randomization_protocol_hash, created_at
     ) VALUES (
       ?, 1, 'novel-skill-paid-ab@1', ?, ?, ?, 'paid-blind-prompt@1', ?,
       'novel-skill-human-rubric@1', ?, ?, 'paid-blind-review@1', ?,
       'paid-blind-random@1', ?, ?
     )`,
    [
      SUITE_ID,
      "5".repeat(64),
      "6".repeat(64),
      "7".repeat(64),
      "8".repeat(64),
      "9".repeat(64),
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      NOW,
    ],
  );
}

function openSeededDatabase(label: string): {
  readonly executor: NodeSqliteExecutor;
  readonly databasePath: string;
} {
  databaseSequence += 1;
  const databasePath = path.join(
    temporaryDirectory,
    `${String(databaseSequence).padStart(3, "0")}-${label}.sqlite3`,
  );
  copyFileSync(templateDatabasePath, databasePath);
  return { executor: openExistingDatabase(databasePath), databasePath };
}

function openExistingDatabase(databasePath: string): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor("", databasePath);
  executor.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1;");
  openExecutors.add(executor);
  return executor;
}

function controlStore(
  executor: SqlExecutor,
  randomOffset = 1,
): NovelSkillPaidEvaluationControlSqliteStore {
  return new NovelSkillPaidEvaluationControlSqliteStore(executor, (length) =>
    Uint8Array.from({ length }, (_, index) => (index + randomOffset) % 256),
  );
}

function batchInput(batchId: string) {
  return {
    batchId,
    runId: RUN_ID,
    reviewerId: REVIEWER_ID,
    createdAt: ASSIGNED_AT,
  } as const;
}

function scoreInput(blindItemId: string): SealNovelSkillPaidEvaluationBlindScoresInput {
  return {
    batchId: BATCH_ID,
    blindItemId,
    reviewerId: REVIEWER_ID,
    scores: Object.fromEntries(
      NOVEL_SKILL_EVALUATION_METRICS.map((metric) => [metric, 0.73]),
    ) as Readonly<Record<NovelSkillEvaluationMetric, number>>,
    scoredAt: SCORED_AT,
    sealedAt: SEALED_AT,
  };
}

async function sealedEvidenceCounts(
  executor: NodeSqliteExecutor,
  blindItemId: string,
): Promise<{
  readonly score_count: number;
  readonly receipt_count: number;
  readonly observed_cell_count: number;
}> {
  const rows = await executor.select<{
    readonly score_count: number;
    readonly receipt_count: number;
    readonly observed_cell_count: number;
  }>(
    `SELECT
       (SELECT count(*) FROM novel_skill_evaluation_scores AS score
        INNER JOIN novel_skill_evaluation_review_items AS item
          ON item.observation_id = score.observation_id
        WHERE item.batch_id = ? AND item.blind_item_id = ?) AS score_count,
       (SELECT count(*) FROM novel_skill_evaluation_review_receipts
        WHERE batch_id = ? AND blind_item_id = ?) AS receipt_count,
       (SELECT count(*) FROM novel_skill_evaluation_review_items AS item
        INNER JOIN novel_skill_evaluation_observations AS observation
          ON observation.id = item.observation_id
        INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id
        WHERE item.batch_id = ? AND item.blind_item_id = ? AND cell.state = 'observed')
         AS observed_cell_count`,
    [BATCH_ID, blindItemId, BATCH_ID, blindItemId, BATCH_ID, blindItemId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("sealed evidence counts missing");
  return row;
}

function requiredItem<Items extends readonly unknown[]>(
  items: Items,
  index: number,
): Items[number] {
  const item = items[index];
  if (item === undefined) throw new Error(`blind item ${String(index)} missing`);
  return item;
}

function collectKeys(value: unknown): readonly string[] {
  const keys = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      keys.add(key);
      visit(child);
    }
  };
  visit(value);
  return [...keys];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuid(index: number): string {
  return `019f9f4a-b3c7-7350-8200-${index.toString(16).padStart(12, "0")}`;
}

function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "../../../..");
}
