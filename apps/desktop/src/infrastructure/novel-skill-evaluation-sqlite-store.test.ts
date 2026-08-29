import { readFileSync } from "node:fs";
import path from "node:path";

import {
  NOVEL_SKILL_CONTEXT_LAYERS,
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  createNovelSkillEvaluationExecutionPlan,
  type NovelSkillDefinition,
  type NovelSkillEvaluationObservation,
  type NovelSkillInvocationMode,
  type NovelSkillTask,
} from "@inkshadow/ai-core";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  NovelSkillEvaluationSqliteStore,
  hashNovelSkillEvaluationModelArtifact,
  hashNovelSkillEvaluationModelIdentity,
} from "./novel-skill-evaluation-sqlite-store.js";
import { NovelSkillSqliteStore } from "./novel-skill-sqlite-store.js";
import { compileNovelSkillPaidEvaluationArmSkills } from "./novel-skill-paid-evaluation-payload-authority.js";

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
  "0056_model_hub_failure_diagnostics.sql",
  "0057_model_hub_content_quality_task.sql",
  "0058_story_settings_import_receipts.sql",
  "0059_generation_preflight_cost_status.sql",
  "0060_novel_skill_registry.sql",
  "0061_novel_skill_evaluation_ledger.sql",
]
  .map((file) =>
    readFileSync(path.join(repositoryRoot(), "packages/data/migrations", file), "utf8"),
  )
  .join("\n");

const NOW = "2026-08-10T00:00:00.000Z";
const SUITE_ID = "019f9f4a-b3c7-7350-8000-000000000061";
const EVALUATION_PROJECT_ID = "019f9f4a-b3c7-7350-8000-000000000060";
const RUN_ID = "019f9f4a-b3c7-7350-8000-000000000062";
const SECOND_RUN_ID = "019f9f4a-b3c7-7350-8000-000000000063";
const MODEL_SLOTS = [
  { slotId: "text_tier_a", modelTier: "economy" },
  { slotId: "text_tier_b", modelTier: "quality" },
] as const;
function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "../../../..");
}

describe("NovelSkillEvaluationSqliteStore", () => {
  it("stores only suite metadata, then creates an independent exact 192-cell matrix per run", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new NovelSkillEvaluationSqliteStore(executor);
    const manifests = await seedEvaluationProject(executor);
    const plan = createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS);
    expect(plan.cells).toHaveLength(192);
    await store.createSuite({
      suiteId: SUITE_ID,
      evaluationProjectId: EVALUATION_PROJECT_ID,
      manifests,
      preferenceConfigurationHash: "3".repeat(64),
      plan,
      createdAt: NOW,
    });
    await store.createSuite({
      suiteId: SUITE_ID,
      evaluationProjectId: EVALUATION_PROJECT_ID,
      manifests,
      preferenceConfigurationHash: "3".repeat(64),
      plan,
      createdAt: NOW,
    });
    await expect(
      store.createSuite({
        suiteId: SUITE_ID,
        evaluationProjectId: EVALUATION_PROJECT_ID,
        manifests,
        preferenceConfigurationHash: "9".repeat(64),
        plan,
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    await expect(
      executor.select<{
        readonly fixtures: number;
        readonly cells: number;
        readonly textLike: number;
      }>(
        `SELECT
           (SELECT count(*) FROM novel_skill_evaluation_fixtures) AS fixtures,
           (SELECT count(*) FROM novel_skill_evaluation_cells) AS cells,
           (SELECT count(*) FROM pragma_table_info('novel_skill_evaluation_fixtures')
             WHERE name IN ('input', 'input_text', 'prompt', 'prompt_text', 'output', 'output_text')) AS textLike`,
      ),
    ).resolves.toEqual([{ fixtures: 12, cells: 0, textLike: 0 }]);
    await expect(
      executor.execute(
        `UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?`,
        [NOW, EVALUATION_PROJECT_ID],
      ),
    ).rejects.toThrow(/must remain archived/iu);
    await expect(
      executor.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at, trashed_at
         ) VALUES ('evaluation-pollution-chapter', ?, 'Forbidden', '', 'active', 1,
                   'evaluation-pollution-version', ?, ?, NULL)`,
        [EVALUATION_PROJECT_ID, NOW, NOW],
      ),
    ).rejects.toThrow(/cannot contain chapters/iu);
    await expect(
      executor.execute(
        `INSERT INTO story_settings_import_receipts (
           id, project_id, source_sha256, request_sha256, status,
           created_record_ids_json, updated_record_fences_json, created_fact_ids_json,
           created_memory_ids_json, imported_count, skipped_count, created_at, undone_at
         ) VALUES ('evaluation-pollution-receipt', ?, ?, ?, 'committed',
                   '[]', '[]', '[]', '[]', 0, 0, ?, NULL)`,
        [EVALUATION_PROJECT_ID, "a".repeat(64), "b".repeat(64), NOW],
      ),
    ).rejects.toThrow(/cannot contain settings import receipts/iu);

    await expect(
      store.createRun({
        runId: "019f9f4a-b3c7-7350-8000-000000000064",
        suiteId: SUITE_ID,
        modelAssignments: [
          {
            slotId: "text_tier_a",
            modelIdentityHash: "4".repeat(64),
            modelArtifactHash: "6".repeat(64),
          },
          {
            slotId: "text_tier_b",
            modelIdentityHash: "5".repeat(64),
            modelArtifactHash: "6".repeat(64),
          },
        ],
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });

    for (const runId of [RUN_ID, SECOND_RUN_ID]) {
      const runInput = {
        runId,
        suiteId: SUITE_ID,
        modelAssignments: [
          {
            slotId: "text_tier_a",
            modelIdentityHash: "4".repeat(64),
            modelArtifactHash: "6".repeat(64),
          },
          {
            slotId: "text_tier_b",
            modelIdentityHash: "5".repeat(64),
            modelArtifactHash: "7".repeat(64),
          },
        ],
        createdAt: NOW,
      } as const;
      await store.createRun(runInput);
      await store.createRun(runInput);
    }
    await expect(
      store.createRun({
        runId: RUN_ID,
        suiteId: SUITE_ID,
        modelAssignments: [
          {
            slotId: "text_tier_a",
            modelIdentityHash: "8".repeat(64),
            modelArtifactHash: "6".repeat(64),
          },
          {
            slotId: "text_tier_b",
            modelIdentityHash: "5".repeat(64),
            modelArtifactHash: "7".repeat(64),
          },
        ],
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    await expect(
      executor.select<{ readonly run_id: string; readonly count: number }>(
        `SELECT run_id, count(*) AS count FROM novel_skill_evaluation_cells
         GROUP BY run_id ORDER BY run_id`,
      ),
    ).resolves.toEqual([
      { run_id: RUN_ID, count: 192 },
      { run_id: SECOND_RUN_ID, count: 192 },
    ]);
    await store.startRun(SECOND_RUN_ID, NOW);
    const [pendingCell] = await executor.select<{ readonly id: string }>(
      "SELECT id FROM novel_skill_evaluation_cells WHERE run_id = ? ORDER BY id LIMIT 1",
      [SECOND_RUN_ID],
    );
    const pendingAttemptId = "019f9f4a-b3c7-7350-8000-000000000078";
    await store.beginAttempt({
      attemptId: pendingAttemptId,
      runId: SECOND_RUN_ID,
      cellId: pendingCell?.id ?? "missing",
      startedAt: NOW,
    });
    await store.invalidateRun(SECOND_RUN_ID, NOW);
    await expect(
      executor.select<{ readonly invalidated: number }>(
        `SELECT count(*) AS invalidated FROM novel_skill_evaluation_cells
         WHERE run_id = ? AND state = 'invalidated'`,
        [SECOND_RUN_ID],
      ),
    ).resolves.toEqual([{ invalidated: 192 }]);
    await expect(
      executor.select<{ readonly status: string; readonly error_code: string }>(
        "SELECT status, error_code FROM novel_skill_evaluation_attempts WHERE id = ?",
        [pendingAttemptId],
      ),
    ).resolves.toEqual([{ status: "cancelled", error_code: "RUN_INVALIDATED" }]);
    await executor.close();
  });

  it("recomputes the matrix and refuses caller-controlled or incomplete evidence metadata", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new NovelSkillEvaluationSqliteStore(executor);
    const manifests = await seedEvaluationProject(executor);
    const plan = createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS);
    await expect(
      store.createSuite({
        suiteId: SUITE_ID,
        evaluationProjectId: EVALUATION_PROJECT_ID,
        manifests,
        preferenceConfigurationHash: "3".repeat(64),
        plan: { ...plan, cells: plan.cells.slice(1) },
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    await expect(
      executor.select<{ readonly count: number }>(
        "SELECT count(*) AS count FROM novel_skill_evaluation_suites",
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await executor.close();
  });

  it("accepts only a succeeded exact trace/invocation/Candidate receipt and keeps the Candidate isolated", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new NovelSkillEvaluationSqliteStore(executor);
    const manifests = await seedEvaluationProject(executor);
    const modelIdentityHash = await hashNovelSkillEvaluationModelIdentity({
      catalogEntryId: "evaluation-model",
      connectionId: "evaluation-provider",
      modelId: "writer",
      providerKind: "openai",
    });
    const modelArtifactHash = await hashNovelSkillEvaluationModelArtifact({
      modelId: "writer",
      providerKind: "openai",
    });
    await store.createSuite({
      suiteId: SUITE_ID,
      evaluationProjectId: EVALUATION_PROJECT_ID,
      manifests,
      preferenceConfigurationHash: "3".repeat(64),
      plan: createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS),
      createdAt: NOW,
    });
    await store.createRun({
      runId: RUN_ID,
      suiteId: SUITE_ID,
      modelAssignments: [
        { slotId: "text_tier_a", modelIdentityHash, modelArtifactHash },
        {
          slotId: "text_tier_b",
          modelIdentityHash: "5".repeat(64),
          modelArtifactHash: "7".repeat(64),
        },
      ],
      createdAt: NOW,
    });
    await store.startRun(RUN_ID, NOW);
    const [cell] = await executor.select<{
      readonly id: string;
      readonly fixture_id: string;
      readonly task_type: string;
      readonly input_content_hash: string;
    }>(
      `SELECT cell.id, cell.fixture_id, fixture.task_type, fixture.input_content_hash
       FROM novel_skill_evaluation_cells AS cell
       INNER JOIN novel_skill_evaluation_fixtures AS fixture
         ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
       WHERE cell.run_id = ? AND cell.arm = 'no_skill'
         AND cell.model_slot_id = 'text_tier_a' AND cell.repetition = 1
       ORDER BY cell.fixture_id LIMIT 1`,
      [RUN_ID],
    );
    expect(cell).toBeDefined();
    const attemptId = "019f9f4a-b3c7-7350-8000-000000000075";
    await expect(
      store.beginAttempt({
        attemptId,
        runId: RUN_ID,
        cellId: cell?.id ?? "missing",
        startedAt: NOW,
      }),
    ).resolves.toBe(1);
    await expect(
      store.beginAttempt({
        attemptId: "019f9f4a-b3c7-7350-8000-000000000077",
        runId: RUN_ID,
        cellId: cell?.id ?? "missing",
        startedAt: NOW,
      }),
    ).rejects.toBeDefined();
    await expect(store.getStartedAttempt(RUN_ID, cell?.id ?? "missing")).resolves.toMatchObject({
      id: attemptId,
      contextTraceId: null,
      modelInvocationId: null,
    });
    const receipt = await seedSuccessfulCandidateReceipt(
      executor,
      cell?.task_type ?? "continuation",
      cell?.fixture_id ?? "missing",
      cell?.input_content_hash ?? "0".repeat(64),
    );
    await store.bindAttemptDispatch({
      attemptId,
      contextTraceId: receipt.contextTraceId,
      modelInvocationId: receipt.modelInvocationId,
    });
    await expect(store.getStartedAttempt(RUN_ID, cell?.id ?? "missing")).resolves.toMatchObject({
      id: attemptId,
      contextTraceId: receipt.contextTraceId,
      modelInvocationId: receipt.modelInvocationId,
    });
    await expect(
      store.bindAttemptDispatch({
        attemptId,
        contextTraceId: receipt.contextTraceId,
        modelInvocationId: receipt.modelInvocationId,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    await expect(
      store.finishAttempt({
        attemptId,
        status: "succeeded",
        contextTraceId: receipt.contextTraceId,
        modelInvocationId: receipt.modelInvocationId,
        errorCode: null,
        completedAt: NOW,
      }),
    ).resolves.toBeUndefined();
    const observation = {
      observationId: "019f9f4a-b3c7-7350-8000-000000000074",
      fixtureId: cell?.fixture_id ?? "missing",
      arm: "no_skill" as const,
      modelSlotId: "text_tier_a" as const,
      modelTier: "economy",
      repetition: 1,
      modelInvocationId: receipt.modelInvocationId,
      evaluatorVersion: "novel-skill-ab@1" as const,
      completionStatus: "succeeded" as const,
      visibleContentLength: receipt.visibleContentLength,
      finishReason: "stop",
      methodApplicability: { core: false, genre: false },
      scores: fullScores(1),
      latencyMilliseconds: 250,
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostMicros: 30,
    };
    const input = {
      observationId: observation.observationId,
      runId: RUN_ID,
      cellId: cell?.id ?? "missing",
      attemptId,
      contextTraceId: receipt.contextTraceId,
      modelInvocationId: receipt.modelInvocationId,
      outputCandidateId: receipt.outputCandidateId,
      novelSkillSnapshotId: null,
      preferenceConfigurationHash: null,
      resultHash: receipt.resultHash,
      observation,
      reviewerId: "reviewer:test",
      rubricVersion: "novel-skill-human-rubric@1" as const,
      scoredAt: NOW,
      createdAt: NOW,
    };
    await executor.execute(
      "UPDATE model_invocation_facts SET finish_reason = 'max_output_tokens' WHERE id = ?",
      [receipt.modelInvocationId],
    );
    await expect(store.recordObservation(input)).rejects.toThrow(/non-truncated invocation/iu);
    await executor.execute(
      "UPDATE model_invocation_facts SET finish_reason = 'stop' WHERE id = ?",
      [receipt.modelInvocationId],
    );
    await expect(store.recordObservation({ ...input, resultHash: "f".repeat(64) })).rejects.toThrow(
      /exact arm evidence/iu,
    );
    await expect(store.recordObservation(input)).resolves.toBeUndefined();
    await expect(store.getRunProgress(RUN_ID)).resolves.toMatchObject({
      totalCells: 192,
      evidenceCollectedCells: 1,
      scoredCells: 1,
    });
    await expect(
      executor.select<{
        readonly candidate: string;
        readonly state: string;
        readonly scores: number;
      }>(
        `SELECT observation.output_candidate_id AS candidate, cell.state,
                (SELECT count(*) FROM novel_skill_evaluation_scores
                 WHERE observation_id = observation.id) AS scores
         FROM novel_skill_evaluation_observations AS observation
         INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id`,
      ),
    ).resolves.toEqual([{ candidate: receipt.outputCandidateId, state: "observed", scores: 13 }]);
    await expect(
      executor.execute("DELETE FROM ai_candidates WHERE id = ?", [receipt.outputCandidateId]),
    ).rejects.toThrow(/Candidate cannot be deleted/iu);
    await expect(
      executor.execute("UPDATE ai_candidates SET status = 'rejected' WHERE id = ?", [
        receipt.outputCandidateId,
      ]),
    ).rejects.toThrow(/Candidate is frozen/iu);
    await expect(
      executor.execute(
        `INSERT INTO context_compilation_entries (
           run_id, candidate_id, layer, selection_reason, included, discarded_reason,
           estimated_tokens, evaluation_order, layer_order, priority, relevance_score,
           required, budget_remaining_before, budget_remaining_after
         ) VALUES (?, 'evaluation-fixture:late', 'scene_goal', 'late evidence', 0,
                   'not_selected', 1, 99, 3, 0, NULL, 0, 999, 999)`,
        [receipt.contextTraceId],
      ),
    ).rejects.toThrow(/cannot gain entries/iu);
    await expect(
      executor.execute(
        `DELETE FROM context_compilation_entry_sources
         WHERE run_id = ? AND candidate_id = ?`,
        [receipt.contextTraceId, `evaluation-fixture:${cell?.fixture_id ?? "missing"}`],
      ),
    ).rejects.toThrow(/cannot lose sources/iu);
    await expect(
      executor.execute("UPDATE model_invocation_facts SET input_tokens = 11 WHERE id = ?", [
        receipt.modelInvocationId,
      ]),
    ).rejects.toThrow(/invocation is frozen/iu);
    await executor.close();
  });

  it.each([
    ["zh.historical.dialogue.voice", true, false],
    ["zh.slice_of_life.summary", false, false],
    ["zh.campus.first_person.continuation", true, true],
  ] as const)(
    "replays truthful Core/Genre applicability for %s",
    async (fixtureId, expectedCore, expectedGenre) => {
      const executor = new NodeSqliteExecutor(migration);
      const prepared = await prepareSkillArmEvidence(executor, fixtureId);
      expect(prepared.input.observation.methodApplicability).toEqual({
        core: expectedCore,
        genre: expectedGenre,
      });
      const genreItems = prepared.compiled.items.filter(({ skillId }) =>
        skillId.startsWith("genre."),
      );
      expect(genreItems).not.toHaveLength(0);
      expect(genreItems.some(({ included }) => included)).toBe(expectedGenre);
      if (!expectedGenre) {
        expect(
          genreItems.every(
            ({ included, selectionReason }) =>
              !included &&
              ["task_mismatch", "mode_mismatch", "genre_mismatch"].includes(selectionReason),
          ),
        ).toBe(true);
      }
      await expect(prepared.store.recordObservation(prepared.input)).resolves.toBeUndefined();
      await executor.close();
    },
  );

  it("rejects a direct-SQL forged applicable Genre item for the historical voice fixture", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const prepared = await prepareSkillArmEvidence(executor, "zh.historical.dialogue.voice");
    const genreItem = prepared.compiled.items.find(({ skillId }) => skillId.startsWith("genre."));
    expect(genreItem).toBeDefined();
    await executor.execute("DROP TRIGGER novel_skill_invocation_item_immutable");
    await executor.execute(
      `UPDATE novel_skill_invocation_items
       SET included = 1, selection_reason = 'selected', discarded_reason = NULL
       WHERE snapshot_id = ? AND skill_id = ?`,
      [prepared.snapshotId, genreItem?.skillId ?? "missing"],
    );
    const forgedInput = {
      ...prepared.input,
      observation: {
        ...prepared.input.observation,
        methodApplicability: { core: true, genre: true },
      },
    };
    await expect(prepared.store.recordObservation(forgedInput)).rejects.toThrow(
      /successful exact arm evidence/iu,
    );
    await executor.close();
  });

  it("recomputes terminal evidence and rejects a forged persisted ELIGIBLE status", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new NovelSkillEvaluationSqliteStore(executor);
    const manifests = await seedEvaluationProject(executor);
    await store.createSuite({
      suiteId: SUITE_ID,
      evaluationProjectId: EVALUATION_PROJECT_ID,
      manifests,
      preferenceConfigurationHash: "3".repeat(64),
      plan: createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS),
      createdAt: NOW,
    });
    await store.createRun({
      runId: RUN_ID,
      suiteId: SUITE_ID,
      modelAssignments: [
        {
          slotId: "text_tier_a",
          modelIdentityHash: "4".repeat(64),
          modelArtifactHash: "6".repeat(64),
        },
        {
          slotId: "text_tier_b",
          modelIdentityHash: "5".repeat(64),
          modelArtifactHash: "7".repeat(64),
        },
      ],
      createdAt: NOW,
    });
    await store.startRun(RUN_ID, NOW);
    await executor.execute("DROP TRIGGER novel_skill_evaluation_run_revision_guard");
    await executor.execute(
      `UPDATE novel_skill_evaluation_runs
       SET status = 'completed', evaluation_status = 'ELIGIBLE_FOR_REVIEW',
           evaluation_result_hash = ?, completed_at = ?, revision = revision + 1
       WHERE id = ?`,
      ["f".repeat(64), NOW, RUN_ID],
    );
    await expect(store.getRunProgress(RUN_ID)).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_EVIDENCE",
    });
    await expect(
      store.recordManualDecision(
        "019f9f4a-b3c7-7350-8000-000000000079",
        RUN_ID,
        "APPROVE_EXPERIMENTAL_BINDING",
        "e".repeat(64),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_EVIDENCE" });
    await executor.close();
  });

  it("keeps evidence collected but unscored when any of the thirteen human scores is missing", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const prepared = await prepareSkillArmEvidence(executor, "zh.historical.dialogue.voice");
    const { scores, ...observation } = prepared.input.observation;
    const { reviewerId, rubricVersion, scoredAt, ...evidenceInput } = prepared.input;
    await expect(
      prepared.store.recordCollectedEvidence({ ...evidenceInput, observation }),
    ).resolves.toBeUndefined();
    await expect(
      prepared.store.recordManualScores({
        runId: RUN_ID,
        cellId: prepared.input.cellId,
        observationId: prepared.input.observationId,
        scores: { ...scores, dialogue_distinction: null },
        reviewerId,
        rubricVersion,
        scoredAt,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    await expect(prepared.store.getRunProgress(RUN_ID)).resolves.toMatchObject({
      evidenceCollectedCells: 1,
      scoredCells: 0,
    });
    await executor.close();
  });
});

async function prepareSkillArmEvidence(executor: NodeSqliteExecutor, fixtureId: string) {
  const store = new NovelSkillEvaluationSqliteStore(executor);
  const manifests = await seedEvaluationProject(executor);
  const modelIdentityHash = await hashNovelSkillEvaluationModelIdentity({
    catalogEntryId: "evaluation-model",
    connectionId: "evaluation-provider",
    modelId: "writer",
    providerKind: "openai",
  });
  const modelArtifactHash = await hashNovelSkillEvaluationModelArtifact({
    modelId: "writer",
    providerKind: "openai",
  });
  await store.createSuite({
    suiteId: SUITE_ID,
    evaluationProjectId: EVALUATION_PROJECT_ID,
    manifests,
    preferenceConfigurationHash: "3".repeat(64),
    plan: createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS),
    createdAt: NOW,
  });
  await store.createRun({
    runId: RUN_ID,
    suiteId: SUITE_ID,
    modelAssignments: [
      { slotId: "text_tier_a", modelIdentityHash, modelArtifactHash },
      {
        slotId: "text_tier_b",
        modelIdentityHash: "5".repeat(64),
        modelArtifactHash: "7".repeat(64),
      },
    ],
    createdAt: NOW,
  });
  await store.startRun(RUN_ID, NOW);
  const cells = await executor.select<{
    readonly id: string;
    readonly task_type: NovelSkillTask;
    readonly invocation_mode: NovelSkillInvocationMode;
    readonly genre_tags_json: string;
    readonly input_content_hash: string;
    readonly contract_hash: string;
  }>(
    `SELECT cell.id, fixture.task_type, fixture.invocation_mode,
            fixture.genre_tags_json, fixture.input_content_hash, fixture.contract_hash
     FROM novel_skill_evaluation_cells AS cell
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
     WHERE cell.run_id = ? AND cell.fixture_id = ? AND cell.arm = 'core_genre'
       AND cell.model_slot_id = 'text_tier_a' AND cell.repetition = 1`,
    [RUN_ID, fixtureId],
  );
  const cell = cells[0];
  if (cell === undefined) throw new Error(`Missing evaluation cell ${fixtureId}`);
  const attemptId = "019f9f4a-b3c7-7350-8000-000000000075";
  await store.beginAttempt({ attemptId, runId: RUN_ID, cellId: cell.id, startedAt: NOW });
  const receipt = await seedSuccessfulCandidateReceipt(
    executor,
    cell.task_type,
    fixtureId,
    cell.input_content_hash,
    cell.contract_hash,
    NOVEL_SKILL_CONTEXT_LAYERS,
  );
  const definitions: readonly NovelSkillDefinition[] = [
    ...(await createCoreNovelSkillDefinitions()),
    ...(await createGenreNovelSkillDefinitions()),
  ];
  const compiled = await compileNovelSkillPaidEvaluationArmSkills({
    projectId: EVALUATION_PROJECT_ID,
    taskType: cell.task_type,
    invocationMode: cell.invocation_mode,
    maximumSkillTokens: 100_000,
    genreTags: JSON.parse(cell.genre_tags_json) as string[],
    availableContextLayers: NOVEL_SKILL_CONTEXT_LAYERS,
    definitions,
  });
  const snapshotId = "019f9f4a-b3c7-7350-8000-000000000076";
  await new NovelSkillSqliteStore(executor).commitInvocationBeforeDispatch({
    snapshotId,
    projectId: EVALUATION_PROJECT_ID,
    contextTraceId: receipt.contextTraceId,
    modelInvocationId: receipt.modelInvocationId,
    taskType: cell.task_type,
    invocationMode: cell.invocation_mode,
    compiled,
    createdAt: NOW,
  });
  await store.bindAttemptDispatch({
    attemptId,
    contextTraceId: receipt.contextTraceId,
    modelInvocationId: receipt.modelInvocationId,
  });
  await store.finishAttempt({
    attemptId,
    status: "succeeded",
    contextTraceId: receipt.contextTraceId,
    modelInvocationId: receipt.modelInvocationId,
    errorCode: null,
    completedAt: NOW,
  });
  const methodApplicability = {
    core: compiled.items.some(({ skillId, included }) => skillId.startsWith("core.") && included),
    genre: compiled.items.some(({ skillId, included }) => skillId.startsWith("genre.") && included),
  };
  const observation = {
    observationId: "019f9f4a-b3c7-7350-8000-000000000074",
    fixtureId,
    arm: "core_genre" as const,
    modelSlotId: "text_tier_a" as const,
    modelTier: "economy",
    repetition: 1,
    modelInvocationId: receipt.modelInvocationId,
    evaluatorVersion: "novel-skill-ab@1" as const,
    completionStatus: "succeeded" as const,
    visibleContentLength: receipt.visibleContentLength,
    finishReason: "stop",
    methodApplicability,
    scores: fullScores(1),
    latencyMilliseconds: 250,
    inputTokens: 10,
    outputTokens: 20,
    estimatedCostMicros: 30,
  } satisfies NovelSkillEvaluationObservation;
  return {
    store,
    compiled,
    snapshotId,
    input: {
      observationId: observation.observationId,
      runId: RUN_ID,
      cellId: cell.id,
      attemptId,
      contextTraceId: receipt.contextTraceId,
      modelInvocationId: receipt.modelInvocationId,
      outputCandidateId: receipt.outputCandidateId,
      novelSkillSnapshotId: snapshotId,
      preferenceConfigurationHash: null,
      resultHash: receipt.resultHash,
      observation,
      reviewerId: "reviewer:test",
      rubricVersion: "novel-skill-human-rubric@1" as const,
      scoredAt: NOW,
      createdAt: NOW,
    },
  };
}

function fullScores(score: number): NovelSkillEvaluationObservation["scores"] {
  return {
    instruction_following: score,
    canon_preservation: score,
    character_consistency: score,
    pov_preservation: score,
    causal_progression: score,
    scene_function: score,
    dialogue_distinction: score,
    specificity: score,
    repetition_cliche_control: score,
    pacing: score,
    user_preference: score,
    unnecessary_rewrite_avoidance: score,
    evidence_completeness: score,
  };
}

async function seedEvaluationProject(executor: NodeSqliteExecutor) {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at, archived_at,
       trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'InkShadow internal Novel Skill evaluation', 'archived', 1, 0, ?, ?, ?, NULL, NULL, NULL)`,
    [EVALUATION_PROJECT_ID, NOW, NOW, NOW],
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
  return {
    core,
    coreGenre: [...core, ...genre],
    coreGenrePreferences: [...core, ...genre],
  } as const;
}

async function seedSuccessfulCandidateReceipt(
  executor: NodeSqliteExecutor,
  taskType: string,
  fixtureId: string,
  fixtureInputHash: string,
  fixtureContractHash = fixtureInputHash,
  contextLayers: readonly string[] = ["current_task"],
): Promise<{
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
  readonly outputCandidateId: string;
  readonly resultHash: string;
  readonly visibleContentLength: number;
}> {
  const contextTraceId = "019f9f4a-b3c7-7350-8000-000000000070";
  const modelInvocationId = "019f9f4a-b3c7-7350-8000-000000000071";
  const outputCandidateId = "019f9f4a-b3c7-7350-8000-000000000072";
  const generationId = "019f9f4a-b3c7-7350-8000-000000000073";
  const content = "可复核的隔离评测输出";
  const resultHash = await sha256(content);
  const visibleContentLength = Array.from(content).length;
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_state, connection_status, catalog_sync_status, created_at, updated_at
     ) VALUES ('evaluation-provider', 'openai', 'Evaluation provider', 'openai_compatible',
               'https://example.test/v1', 'missing', 'not_tested', 'never', ?, ?)`,
    [NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, catalog_source,
       availability, lifecycle, first_discovered_at, last_seen_at, last_sync_id
     ) VALUES ('evaluation-model', 'evaluation-provider', 'writer', 'Writer', 'manual',
               'available', 'unknown', ?, ?, NULL)`,
    [NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
       model_id_snapshot, route_reason, status, attempt, privacy_policy,
       data_destination, input_tokens, output_tokens, estimated_cost_micros, currency,
       started_at, completed_at, created_at, finish_reason, visible_content_length, streamed
     ) VALUES (?, ?, 'evaluation-provider', 'evaluation-model', 'openai', 'writer',
               'user_override', 'succeeded', 1, 'cloud_allowed', 'remote', 10, 20, '30', 'USD',
               ?, ?, ?, 'stop', ?, 0)`,
    [modelInvocationId, taskType, NOW, "2026-08-10T00:00:00.250Z", NOW, visibleContentLength],
  );
  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type, maximum_context_tokens,
       required_tokens, used_tokens, remaining_tokens, discarded_tokens,
       token_estimate_source, candidate_count, included_count, discarded_count, created_at
     ) VALUES (?, ?, NULL, ?, 1000, 1, 1, 999, 0,
               'utf8_conservative', ?, ?, 0, ?)`,
    [
      contextTraceId,
      EVALUATION_PROJECT_ID,
      taskType,
      contextLayers.length,
      contextLayers.length,
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason, included, discarded_reason,
       estimated_tokens, evaluation_order, layer_order, priority, relevance_score,
       required, budget_remaining_before, budget_remaining_after
      ) VALUES (?, ?, 'current_task', 'Fixed evaluation task contract.', 1, NULL,
                1, 1, 2, 100, 1, 1, 1000, 999)`,
    [contextTraceId, `evaluation-fixture:${fixtureId}`],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entry_sources (
       run_id, candidate_id, source_order, source_type, source_id,
       source_version_id, locator, content_hash
     ) VALUES (?, ?, 1, 'user_input', ?, NULL, 'novel_skill_evaluation_fixture', ?)`,
    [contextTraceId, `evaluation-fixture:${fixtureId}`, fixtureId, fixtureInputHash],
  );
  for (const [index, layer] of contextLayers
    .filter((value) => value !== "current_task")
    .entries()) {
    const candidateId = `evaluation-fixture-layer:${fixtureId}:${layer}`;
    await executor.execute(
      `INSERT INTO context_compilation_entries (
         run_id, candidate_id, layer, selection_reason, included, discarded_reason,
         estimated_tokens, evaluation_order, layer_order, priority, relevance_score,
         required, budget_remaining_before, budget_remaining_after
       ) VALUES (?, ?, ?, 'Fixed evaluation fixture contract layer.', 1, NULL,
                 1, ?, ?, 90, 1, 0, 999, 998)`,
      [contextTraceId, candidateId, layer, index + 2, index + 1],
    );
    await executor.execute(
      `INSERT INTO context_compilation_entry_sources (
         run_id, candidate_id, source_order, source_type, source_id,
         source_version_id, locator, content_hash
       ) VALUES (?, ?, 1, 'user_input', ?, NULL,
                 'novel_skill_evaluation_fixture_contract', ?)`,
      [contextTraceId, candidateId, fixtureId, fixtureContractHash],
    );
  }
  await executor.execute(
    `INSERT INTO ai_candidates (
       id, project_id, chapter_id, source, base_version_id, content, content_checksum,
       status, incomplete, created_at, updated_at, decided_at
     ) VALUES (?, ?, NULL, 'generate', NULL, ?, ?, 'ready', 0, ?, ?, NULL)`,
    [outputCandidateId, EVALUATION_PROJECT_ID, content, resultHash, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, ?, NULL, ?)`,
    [contextTraceId, generationId, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_model_invocation_links (
       trace_id, model_invocation_id, linked_at
     ) VALUES (?, ?, ?)`,
    [contextTraceId, modelInvocationId, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_output_candidate_links (
       trace_id, ai_candidate_id, linked_at
     ) VALUES (?, ?, ?)`,
    [contextTraceId, outputCandidateId, NOW],
  );
  return { contextTraceId, modelInvocationId, outputCandidateId, resultHash, visibleContentLength };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
