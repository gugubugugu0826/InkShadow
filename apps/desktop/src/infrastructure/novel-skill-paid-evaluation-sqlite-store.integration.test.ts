import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  createNovelSkillEvaluationExecutionPlan,
  listNovelSkillEvaluationFixtures,
} from "@inkshadow/ai-core";
import { parseIsoUtcTimestamp, type AiCandidateSnapshot } from "@inkshadow/domain";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import type { ContextCompilationTrace } from "./context-compilation-trace-store";
import {
  MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
  MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
  hashModelHubExactEvaluationExecutionLock,
  hashModelHubExactEvaluationRequestProfile,
  inspectModelHubExactEvaluationTarget,
  type ModelHubExactEvaluationDependencies,
  type ModelHubExactEvaluationExecutionResult,
  type ModelHubExactEvaluationInspection,
  type ModelHubExactEvaluationRequestProfile,
} from "./model-hub-exact-evaluation-target";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelProviderConnection,
} from "./model-hub-store";
import {
  NovelSkillEvaluationSqliteStore,
  hashNovelSkillEvaluationModelArtifact,
  hashNovelSkillEvaluationModelIdentity,
} from "./novel-skill-evaluation-sqlite-store";
import {
  NovelSkillPaidEvaluationSqliteStore,
  hashNovelSkillPaidEvaluationCommercialConfirmation,
  hashNovelSkillPaidEvaluationInvariantRequest,
  hashNovelSkillPaidEvaluationTraceBaseline,
  type NovelSkillPaidEvaluationContextBaselineInput,
  type NovelSkillPaidEvaluationRequestProfileInput,
} from "./novel-skill-paid-evaluation-sqlite-store";
import {
  compileNovelSkillPaidEvaluationPayload,
  createNovelSkillPaidEvaluationContextBaselineProjection,
  createNovelSkillPaidEvaluationPromptTemplateProjection,
  resolveNovelSkillPaidEvaluationArmConfigurationHash,
  type NovelSkillPaidEvaluationTraceBaselineProjection,
} from "./novel-skill-paid-evaluation-payload-authority";
import { NovelSkillSqliteStore } from "./novel-skill-sqlite-store";
import type { NativeModelMessage } from "./runtime";

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
const AUTHORIZED_AT = "2026-08-11T00:00:01.000Z";
const STARTED_AT = "2026-08-11T00:00:02.000Z";
const ATTEMPTED_AT = "2026-08-11T00:00:03.000Z";
const RESERVED_AT = "2026-08-11T00:00:04.000Z";
const BOUND_AT = "2026-08-11T00:00:05.000Z";
const DISPATCHED_AT = "2026-08-11T00:00:06.000Z";
const COMPLETED_AT = "2026-08-11T00:00:07.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-8100-000000000001";
const SUITE_ID = "019f9f4a-b3c7-7350-8100-000000000002";
const RUN_ID = "019f9f4a-b3c7-7350-8100-000000000003";
const AUTHORIZATION_ID = "019f9f4a-b3c7-7350-8100-000000000004";
const ATTEMPT_ID = "019f9f4a-b3c7-7350-8100-000000000005";
const RESERVATION_ID = "019f9f4a-b3c7-7350-8100-000000000006";
const TRACE_ID = "019f9f4a-b3c7-7350-8100-000000000007";
const INVOCATION_ID = "019f9f4a-b3c7-7350-8100-000000000008";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-8100-000000000009";
const OBSERVATION_ID = "019f9f4a-b3c7-7350-8100-000000000016";
const FAILED_ATTEMPT_ID = "019f9f4a-b3c7-7350-8100-000000000010";
const FAILED_RESERVATION_ID = "019f9f4a-b3c7-7350-8100-000000000011";
const FAILED_TRACE_ID = "019f9f4a-b3c7-7350-8100-000000000012";
const FAILED_INVOCATION_ID = "019f9f4a-b3c7-7350-8100-000000000013";
const FAILED_CANDIDATE_ID = "019f9f4a-b3c7-7350-8100-000000000014";
const WRONG_PROJECT_ID = "019f9f4a-b3c7-7350-8100-000000000015";
const MODEL_SLOTS = [
  { slotId: "text_tier_a", modelTier: "economy" },
  { slotId: "text_tier_b", modelTier: "quality" },
] as const;

interface FixtureRow {
  readonly fixture_id: string;
  readonly task_type: string;
  readonly contract_hash: string;
  readonly input_content_hash: string;
}

interface CellRow extends FixtureRow {
  readonly id: string;
  readonly arm: "no_skill";
  readonly arm_configuration_hash: null;
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
}

interface ExactTargetFixture {
  readonly connection: ModelProviderConnection;
  readonly catalog: ModelCatalogEntry;
  readonly cost: ModelCostPrivacyProfile;
  readonly evidence: readonly ModelCapabilityEvidence[];
}

const openExecutors = new Set<NodeSqliteExecutor>();

afterEach(async () => {
  await Promise.all([...openExecutors].map((executor) => executor.close()));
  openExecutors.clear();
});

describe("NovelSkillPaidEvaluationSqliteStore real SQLite integration", () => {
  it("commits one exact authorized success chain and rolls back a rejected mid-transaction binding", async () => {
    const executor = new NodeSqliteExecutor(migration);
    openExecutors.add(executor);
    const evaluationStore = new NovelSkillEvaluationSqliteStore(executor);
    const paidStore = new NovelSkillPaidEvaluationSqliteStore(executor);

    const manifests = await seedEvaluationProject(executor);
    const plan = createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS);
    expect(plan.cells).toHaveLength(192);
    await evaluationStore.createSuite({
      suiteId: SUITE_ID,
      evaluationProjectId: PROJECT_ID,
      manifests,
      preferenceConfigurationHash: await sha256Hex("paid-integration-preferences@1"),
      plan,
      createdAt: NOW,
    });

    const fixtures = await executor.select<FixtureRow>(
      `SELECT fixture_id, task_type, contract_hash, input_content_hash
       FROM novel_skill_evaluation_fixtures WHERE suite_id = ? ORDER BY fixture_id`,
      [SUITE_ID],
    );
    expect(fixtures).toHaveLength(12);

    const authorityBaselines = new Map(
      await Promise.all(
        fixtures.map(
          async (fixture) =>
            [
              fixture.fixture_id,
              await createNovelSkillPaidEvaluationContextBaselineProjection(
                fixture.fixture_id,
                7_000,
              ),
            ] as const,
        ),
      ),
    );
    const traces = new Map(
      fixtures.map((fixture) => {
        const baseline = requiredMapValue(authorityBaselines, fixture.fixture_id);
        const trace = evaluationTrace({
          baseline: baseline.traceBaseline,
          traceId: TRACE_ID,
          invocationId: INVOCATION_ID,
          projectId: PROJECT_ID,
          createdAt: NOW,
        });
        return [fixture.fixture_id, trace] as const;
      }),
    );
    const requestProfiles = await buildRequestProfiles(fixtures);
    const contextBaselines = await Promise.all(
      fixtures.map(async (fixture): Promise<NovelSkillPaidEvaluationContextBaselineInput> => {
        const baseline = requiredMapValue(authorityBaselines, fixture.fixture_id);
        expect(
          await hashNovelSkillPaidEvaluationTraceBaseline(
            requiredMapValue(traces, fixture.fixture_id),
          ),
        ).toBe(baseline.compiledBaselineHash);
        return {
          fixtureId: fixture.fixture_id,
          baselineContractHash: baseline.baselineContractHash,
          includedSourceManifestHash: baseline.includedSourceManifestHash,
          omittedSourceManifestHash: baseline.omittedSourceManifestHash,
          compiledBaselineHash: baseline.compiledBaselineHash,
          baselineTokenBudget: baseline.baselineTokenBudget,
        };
      }),
    );
    const promptTemplate = await createNovelSkillPaidEvaluationPromptTemplateProjection();
    const promptTemplateHash = promptTemplate.hash;
    const protocol = await paidStore.createExecutionProtocol({
      suiteId: SUITE_ID,
      promptTemplateVersion: promptTemplate.version,
      promptTemplateHash,
      rubricContentHash: await sha256Hex("paid-integration-rubric@1"),
      evaluatorContractHash: await sha256Hex("paid-integration-evaluator@1"),
      blindingProtocolVersion: "paid-integration-blinding@1",
      blindingProtocolHash: await sha256Hex("paid-integration-blinding@1"),
      randomizationProtocolVersion: "paid-integration-randomization@1",
      randomizationProtocolHash: await sha256Hex("paid-integration-randomization@1"),
      requestProfiles,
      contextBaselines,
      createdAt: NOW,
    });

    const targetFixtures = [exactTargetFixture("a"), exactTargetFixture("b")] as const;
    for (const target of targetFixtures) await seedExactTarget(executor, target);
    const targetIdentities = await Promise.all(
      targetFixtures.map(async ({ connection, catalog }) => ({
        modelIdentityHash: await hashNovelSkillEvaluationModelIdentity({
          catalogEntryId: catalog.id,
          connectionId: connection.id,
          modelId: catalog.providerModelId,
          providerKind: connection.providerKind,
        }),
        modelArtifactHash: await hashNovelSkillEvaluationModelArtifact({
          modelId: catalog.providerModelId,
          providerKind: connection.providerKind,
        }),
      })),
    );
    const targetAIdentity = requiredArrayItem(targetIdentities, 0, "target A identity");
    const targetBIdentity = requiredArrayItem(targetIdentities, 1, "target B identity");
    await evaluationStore.createRun({
      runId: RUN_ID,
      suiteId: SUITE_ID,
      modelAssignments: [
        { slotId: "text_tier_a", ...targetAIdentity },
        { slotId: "text_tier_b", ...targetBIdentity },
      ],
      createdAt: NOW,
    });
    await expect(
      executor.select<{ readonly count: number }>(
        "SELECT count(*) AS count FROM novel_skill_evaluation_cells WHERE run_id = ?",
        [RUN_ID],
      ),
    ).resolves.toEqual([{ count: 192 }]);

    const inspections = await Promise.all(
      targetFixtures.map((target) => inspectTarget(target, requestProfile("continuation"))),
    );
    const targetAInspection = requiredArrayItem(inspections, 0, "target A inspection");
    const targetBInspection = requiredArrayItem(inspections, 1, "target B inspection");
    expect(targetAInspection.executionLockHash).toBe(
      await hashModelHubExactEvaluationExecutionLock({
        targetIdentityHash: targetAInspection.target.targetIdentityHash,
        requestProfileHash: targetAInspection.requestProfileHash,
        payloadHash: targetAInspection.payloadHash,
        currency: targetAInspection.pricing.currency,
        estimatedMaximumCostMicros: targetAInspection.pricing.estimatedMaximumCostMicros,
      }),
    );
    await paidStore.bindExactModelTargets(
      RUN_ID,
      [
        {
          modelSlotId: "text_tier_a",
          inspection: targetAInspection,
          artifactIdentitySource: "provider_model_id",
        },
        {
          modelSlotId: "text_tier_b",
          inspection: targetBInspection,
          artifactIdentitySource: "provider_model_id",
        },
      ],
      NOW,
    );
    const quote = await paidStore.quoteCommercialRun(RUN_ID);
    expect(quote.authorizedCallCount).toBe(192);
    expect(quote.currencies).toHaveLength(1);
    const hardCeilings = quote.currencies.map(({ currency, estimatedMaximumCostMicros }) => ({
      currency,
      hardCeilingMicros: estimatedMaximumCostMicros,
    }));
    await paidStore.authorizeCommercialRun({
      authorizationId: AUTHORIZATION_ID,
      runId: RUN_ID,
      quoteHash: quote.quoteHash,
      confirmationHash: await hashNovelSkillPaidEvaluationCommercialConfirmation({
        quote,
        hardCeilings,
      }),
      hardCeilings,
      authorizedAt: AUTHORIZED_AT,
    });
    await paidStore.startAuthorizedRun(RUN_ID, STARTED_AT);

    const [cell, rejectedCell] = await executor.select<CellRow>(
      `SELECT cell.id, cell.arm, cell.arm_configuration_hash,
              cell.model_slot_id, cell.repetition, fixture.fixture_id,
              fixture.task_type, fixture.contract_hash, fixture.input_content_hash
       FROM novel_skill_evaluation_cells AS cell
       INNER JOIN novel_skill_evaluation_fixtures AS fixture
         ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
       WHERE cell.run_id = ? AND cell.model_slot_id = 'text_tier_a'
         AND cell.arm = 'no_skill'
       ORDER BY cell.id LIMIT 2`,
      [RUN_ID],
    );
    if (cell === undefined || rejectedCell === undefined) throw new Error("test cells missing");
    const fixedFixture = listNovelSkillEvaluationFixtures().find(
      ({ fixtureId }) => fixtureId === cell.fixture_id,
    );
    if (fixedFixture === undefined) throw new Error("selected fixed fixture missing");
    const authorityBaseline = requiredMapValue(authorityBaselines, cell.fixture_id);
    const payloadAuthorityInput = {
      cell: {
        runId: RUN_ID,
        suiteId: SUITE_ID,
        cellId: cell.id,
        fixtureId: cell.fixture_id,
        fixtureInputContentHash: cell.input_content_hash,
        taskType: fixedFixture.taskType,
        invocationMode: fixedFixture.invocationMode,
        arm: cell.arm,
        armConfigurationHash: await resolveNovelSkillPaidEvaluationArmConfigurationHash(cell.arm),
        modelSlotId: cell.model_slot_id,
        repetition: cell.repetition,
      },
      promptTemplate,
      contextBaseline: authorityBaseline,
      preferenceProjection: null,
    };
    const payloadAuthority = await compileNovelSkillPaidEvaluationPayload(payloadAuthorityInput);
    const activeInspection = await inspectTarget(
      targetFixtures[0],
      requestProfile(cell.task_type),
      payloadAuthority.messages,
    );
    expect(activeInspection.messagePayloadHash).toBe(payloadAuthority.manifest.messagePayloadHash);
    const activeProfile = requiredProfile(requestProfiles, cell.task_type);
    const activeBaseline = requiredBaseline(contextBaselines, cell.fixture_id);

    await evaluationStore.beginAttempt({
      attemptId: ATTEMPT_ID,
      runId: RUN_ID,
      cellId: cell.id,
      startedAt: ATTEMPTED_AT,
    });
    const trace = evaluationTrace({
      baseline: authorityBaseline.traceBaseline,
      traceId: TRACE_ID,
      invocationId: INVOCATION_ID,
      projectId: PROJECT_ID,
      createdAt: ATTEMPTED_AT,
    });
    expect(await hashNovelSkillPaidEvaluationTraceBaseline(trace)).toBe(
      activeBaseline.compiledBaselineHash,
    );
    const invariantRequestHash = await hashNovelSkillPaidEvaluationInvariantRequest({
      runId: RUN_ID,
      suiteId: SUITE_ID,
      fixtureId: cell.fixture_id,
      taskType: cell.task_type,
      modelSlotId: cell.model_slot_id,
      repetition: cell.repetition,
      protocolHash: protocol.protocolHash,
      requestProfileHash: activeProfile.requestProfileHash,
      contextBaselineHash: activeBaseline.compiledBaselineHash,
      promptTemplateHash,
    });
    const receipt = {
      generationId: INVOCATION_ID,
      target: activeInspection.target,
      requestProfileHash: activeProfile.requestProfileHash,
      messagePayloadHash: activeInspection.messagePayloadHash,
      payloadHash: activeInspection.payloadHash,
      executionLockHash: activeInspection.executionLockHash,
      currency: activeInspection.pricing.currency,
      estimatedMaximumCostMicros: activeInspection.pricing.estimatedMaximumCostMicros,
      dataDestination: activeInspection.dataDestination,
    } as const;
    expect(receipt.executionLockHash).toBe(
      await hashModelHubExactEvaluationExecutionLock({
        targetIdentityHash: receipt.target.targetIdentityHash,
        requestProfileHash: receipt.requestProfileHash,
        payloadHash: receipt.payloadHash,
        currency: receipt.currency,
        estimatedMaximumCostMicros: receipt.estimatedMaximumCostMicros,
      }),
    );
    const bound = await paidStore.reserveAndBindAttemptDispatch({
      reservation: {
        reservationId: RESERVATION_ID,
        authorizationId: AUTHORIZATION_ID,
        runId: RUN_ID,
        cellId: cell.id,
        attemptId: ATTEMPT_ID,
        modelSlotId: cell.model_slot_id,
        dispatchGeneration: 1,
        plannedContextTraceId: TRACE_ID,
        plannedModelInvocationId: INVOCATION_ID,
        plannedCandidateId: CANDIDATE_ID,
        receipt,
        contextBaselineHash: activeBaseline.compiledBaselineHash,
        promptTemplateHash,
        invariantRequestHash,
        skillConfigurationHash: null,
        preferenceConfigurationHash: null,
        idempotencyKeyHash: await sha256Hex("paid-integration-idempotency-success"),
        reservedAt: RESERVED_AT,
      },
      trace,
      payloadAuthorityInput,
      payloadAuthority,
      boundAt: BOUND_AT,
    });
    expect(bound).toMatchObject({ state: "bound", revision: 2 });
    const dispatched = await paidStore.markDispatchStarted(
      RESERVATION_ID,
      bound.revision,
      DISPATCHED_AT,
    );
    expect(dispatched).toMatchObject({ state: "dispatched", revision: 3 });

    const output = "雨停了。灯影沿着旧信封的折痕安静下来。🌧️";
    const visibleOutputHash = await sha256Hex(output);
    const result: ModelHubExactEvaluationExecutionResult = {
      text: output,
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 },
      streamed: true,
      visibleOutputHash,
      visibleContentLength: Array.from(output).length,
      estimatedActualCostMicros: "1",
      currency: receipt.currency,
      dataDestination: receipt.dataDestination,
      target: receipt.target,
      requestProfileHash: receipt.requestProfileHash,
      messagePayloadHash: receipt.messagePayloadHash,
      payloadHash: receipt.payloadHash,
      executionLockHash: receipt.executionLockHash,
    };
    const candidate: AiCandidateSnapshot = {
      id: CANDIDATE_ID,
      projectId: PROJECT_ID,
      chapterId: null,
      source: "generate",
      baseVersionId: null,
      content: output,
      contentChecksum: visibleOutputHash,
      status: "ready",
      revision: 1,
      incomplete: false,
      createdAt: COMPLETED_AT,
      updatedAt: COMPLETED_AT,
      decidedAt: null,
    } as AiCandidateSnapshot;
    const settled = await paidStore.settleDispatchSuccess({
      reservationId: RESERVATION_ID,
      expectedRevision: dispatched.revision,
      candidate,
      result,
      completedAt: COMPLETED_AT,
    });
    expect(settled).toMatchObject({ state: "settled", revision: 4 });

    await expect(
      executor.select<{
        readonly reservation_state: string;
        readonly settlement_outcome: string;
        readonly attempt_status: string;
        readonly invocation_status: string;
        readonly candidate_status: string;
        readonly trace_id: string;
        readonly invocation_id: string;
        readonly candidate_id: string;
        readonly candidate_project_id: string;
        readonly candidate_content: string;
        readonly version_count: number;
      }>(
        `SELECT reservation.state AS reservation_state,
                reservation.settlement_outcome,
                attempt.status AS attempt_status,
                invocation.status AS invocation_status,
                candidate.status AS candidate_status,
                trace.id AS trace_id,
                invocation.id AS invocation_id,
                candidate.id AS candidate_id,
                candidate.project_id AS candidate_project_id,
                candidate.content AS candidate_content,
                (SELECT count(*) FROM chapter_versions WHERE project_id = ?) AS version_count
         FROM novel_skill_evaluation_dispatch_reservations AS reservation
         INNER JOIN novel_skill_evaluation_attempts AS attempt
           ON attempt.id = reservation.attempt_id
          AND attempt.context_trace_id = reservation.planned_context_trace_id
          AND attempt.model_invocation_id = reservation.planned_model_invocation_id
         INNER JOIN context_compilation_runs AS trace
           ON trace.id = reservation.planned_context_trace_id
         INNER JOIN context_compilation_model_invocation_links AS invocation_link
           ON invocation_link.trace_id = trace.id
          AND invocation_link.model_invocation_id = reservation.planned_model_invocation_id
         INNER JOIN model_invocation_facts AS invocation
           ON invocation.id = invocation_link.model_invocation_id
         INNER JOIN context_compilation_output_candidate_links AS candidate_link
           ON candidate_link.trace_id = trace.id
          AND candidate_link.ai_candidate_id = reservation.output_candidate_id
         INNER JOIN ai_candidates AS candidate ON candidate.id = candidate_link.ai_candidate_id
         WHERE reservation.id = ?`,
        [PROJECT_ID, RESERVATION_ID],
      ),
    ).resolves.toEqual([
      {
        reservation_state: "settled",
        settlement_outcome: "succeeded",
        attempt_status: "succeeded",
        invocation_status: "succeeded",
        candidate_status: "ready",
        trace_id: TRACE_ID,
        invocation_id: INVOCATION_ID,
        candidate_id: CANDIDATE_ID,
        candidate_project_id: PROJECT_ID,
        candidate_content: output,
        version_count: 0,
      },
    ]);

    await expect(
      evaluationStore.repairSettledObservation({
        observationId: OBSERVATION_ID,
        runId: RUN_ID,
        cellId: cell.id,
        createdAt: COMPLETED_AT,
      }),
    ).resolves.toEqual({ observationId: OBSERVATION_ID, repaired: true });
    await expect(
      evaluationStore.repairSettledObservation({
        observationId: OBSERVATION_ID,
        runId: RUN_ID,
        cellId: cell.id,
        createdAt: COMPLETED_AT,
      }),
    ).resolves.toEqual({ observationId: OBSERVATION_ID, repaired: false });
    await expect(
      executor.select<{
        readonly id: string;
        readonly result_hash: string;
        readonly context_trace_id: string;
        readonly model_invocation_id: string;
        readonly output_candidate_id: string;
      }>(
        `SELECT id, result_hash, context_trace_id, model_invocation_id, output_candidate_id
         FROM novel_skill_evaluation_observations WHERE id = ?`,
        [OBSERVATION_ID],
      ),
    ).resolves.toEqual([
      {
        id: OBSERVATION_ID,
        result_hash: visibleOutputHash,
        context_trace_id: TRACE_ID,
        model_invocation_id: INVOCATION_ID,
        output_candidate_id: CANDIDATE_ID,
      },
    ]);

    await evaluationStore.beginAttempt({
      attemptId: FAILED_ATTEMPT_ID,
      runId: RUN_ID,
      cellId: rejectedCell.id,
      startedAt: ATTEMPTED_AT,
    });
    const rejectedProfile = requiredProfile(requestProfiles, rejectedCell.task_type);
    const rejectedBaseline = requiredBaseline(contextBaselines, rejectedCell.fixture_id);
    const rejectedAuthorityBaseline = requiredMapValue(authorityBaselines, rejectedCell.fixture_id);
    const rejectedFixedFixture = listNovelSkillEvaluationFixtures().find(
      ({ fixtureId }) => fixtureId === rejectedCell.fixture_id,
    );
    if (rejectedFixedFixture === undefined) throw new Error("rejected fixed fixture missing");
    const rejectedPayloadAuthorityInput = {
      cell: {
        runId: RUN_ID,
        suiteId: SUITE_ID,
        cellId: rejectedCell.id,
        fixtureId: rejectedCell.fixture_id,
        fixtureInputContentHash: rejectedCell.input_content_hash,
        taskType: rejectedFixedFixture.taskType,
        invocationMode: rejectedFixedFixture.invocationMode,
        arm: rejectedCell.arm,
        armConfigurationHash: await resolveNovelSkillPaidEvaluationArmConfigurationHash(
          rejectedCell.arm,
        ),
        modelSlotId: rejectedCell.model_slot_id,
        repetition: rejectedCell.repetition,
      },
      promptTemplate,
      contextBaseline: rejectedAuthorityBaseline,
      preferenceProjection: null,
    };
    const rejectedPayloadAuthority = await compileNovelSkillPaidEvaluationPayload(
      rejectedPayloadAuthorityInput,
    );
    const rejectedInspection = await inspectTarget(
      targetFixtures[0],
      requestProfile(rejectedCell.task_type),
      rejectedPayloadAuthority.messages,
    );
    const rejectedTrace = evaluationTrace({
      baseline: rejectedAuthorityBaseline.traceBaseline,
      traceId: FAILED_TRACE_ID,
      invocationId: FAILED_INVOCATION_ID,
      projectId: WRONG_PROJECT_ID,
      createdAt: ATTEMPTED_AT,
    });
    expect(await hashNovelSkillPaidEvaluationTraceBaseline(rejectedTrace)).toBe(
      rejectedBaseline.compiledBaselineHash,
    );
    const rejectedInvariantHash = await hashNovelSkillPaidEvaluationInvariantRequest({
      runId: RUN_ID,
      suiteId: SUITE_ID,
      fixtureId: rejectedCell.fixture_id,
      taskType: rejectedCell.task_type,
      modelSlotId: rejectedCell.model_slot_id,
      repetition: rejectedCell.repetition,
      protocolHash: protocol.protocolHash,
      requestProfileHash: rejectedProfile.requestProfileHash,
      contextBaselineHash: rejectedBaseline.compiledBaselineHash,
      promptTemplateHash,
    });
    await expect(
      paidStore.reserveAndBindAttemptDispatch({
        reservation: {
          reservationId: FAILED_RESERVATION_ID,
          authorizationId: AUTHORIZATION_ID,
          runId: RUN_ID,
          cellId: rejectedCell.id,
          attemptId: FAILED_ATTEMPT_ID,
          modelSlotId: rejectedCell.model_slot_id,
          dispatchGeneration: 1,
          plannedContextTraceId: FAILED_TRACE_ID,
          plannedModelInvocationId: FAILED_INVOCATION_ID,
          plannedCandidateId: FAILED_CANDIDATE_ID,
          receipt: {
            generationId: FAILED_INVOCATION_ID,
            target: rejectedInspection.target,
            requestProfileHash: rejectedInspection.requestProfileHash,
            messagePayloadHash: rejectedInspection.messagePayloadHash,
            payloadHash: rejectedInspection.payloadHash,
            executionLockHash: rejectedInspection.executionLockHash,
            currency: rejectedInspection.pricing.currency,
            estimatedMaximumCostMicros: rejectedInspection.pricing.estimatedMaximumCostMicros,
            dataDestination: rejectedInspection.dataDestination,
          },
          contextBaselineHash: rejectedBaseline.compiledBaselineHash,
          promptTemplateHash,
          invariantRequestHash: rejectedInvariantHash,
          skillConfigurationHash: null,
          preferenceConfigurationHash: null,
          idempotencyKeyHash: await sha256Hex("paid-integration-idempotency-rejected"),
          reservedAt: RESERVED_AT,
        },
        trace: rejectedTrace,
        payloadAuthorityInput: rejectedPayloadAuthorityInput,
        payloadAuthority: rejectedPayloadAuthority,
        boundAt: BOUND_AT,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });

    await expect(
      executor.select<{
        readonly reservations: number;
        readonly traces: number;
        readonly invocations: number;
        readonly candidates: number;
        readonly attempt_status: string;
        readonly attempt_trace_id: string | null;
        readonly attempt_invocation_id: string | null;
      }>(
        `SELECT
           (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations
             WHERE id = ?) AS reservations,
           (SELECT count(*) FROM context_compilation_runs WHERE id = ?) AS traces,
           (SELECT count(*) FROM model_invocation_facts WHERE id = ?) AS invocations,
           (SELECT count(*) FROM ai_candidates WHERE id = ?) AS candidates,
           attempt.status AS attempt_status,
           attempt.context_trace_id AS attempt_trace_id,
           attempt.model_invocation_id AS attempt_invocation_id
         FROM novel_skill_evaluation_attempts AS attempt WHERE attempt.id = ?`,
        [
          FAILED_RESERVATION_ID,
          FAILED_TRACE_ID,
          FAILED_INVOCATION_ID,
          FAILED_CANDIDATE_ID,
          FAILED_ATTEMPT_ID,
        ],
      ),
    ).resolves.toEqual([
      {
        reservations: 0,
        traces: 0,
        invocations: 0,
        candidates: 0,
        attempt_status: "started",
        attempt_trace_id: null,
        attempt_invocation_id: null,
      },
    ]);
  });
});

function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "../../../..");
}

async function seedEvaluationProject(executor: NodeSqliteExecutor) {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at, archived_at,
       trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Paid evaluation integration', 'archived', 1, 0, ?, ?, ?, NULL, NULL, NULL)`,
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
  return {
    core,
    coreGenre: [...core, ...genre],
    coreGenrePreferences: [...core, ...genre],
  } as const;
}

async function buildRequestProfiles(
  fixtures: readonly FixtureRow[],
): Promise<readonly NovelSkillPaidEvaluationRequestProfileInput[]> {
  const tasks = [...new Set(fixtures.map(({ task_type }) => task_type))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  return Promise.all(
    tasks.map(async (taskType) => {
      const profile = requestProfile(taskType);
      return {
        taskType,
        profileVersion: profile.version,
        requestProfileHash: await hashModelHubExactEvaluationRequestProfile(profile),
        maximumInputTokens: profile.maximumInputTokens,
        maximumOutputTokens: profile.maximumOutputTokens,
        temperatureBasisPoints: profile.temperatureBasisPoints,
        topPBasisPoints: profile.topPBasisPoints,
        streaming: true,
        stopPolicyHash: profile.stopPolicyHash,
      } as const;
    }),
  );
}

function requestProfile(task: string): ModelHubExactEvaluationRequestProfile {
  return {
    version: MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
    task: task as ModelHubExactEvaluationRequestProfile["task"],
    maximumInputTokens: 7_000,
    maximumOutputTokens: 64,
    temperatureBasisPoints: 0,
    topPBasisPoints: 10_000,
    reasoningMode: "disabled",
    responseFormat: "text",
    streaming: true,
    stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
    providerCallPolicy: "single_attempt",
  };
}

function evaluationTrace(
  input: Readonly<{
    baseline: NovelSkillPaidEvaluationTraceBaselineProjection;
    traceId: string;
    invocationId: string;
    projectId: string;
    createdAt: string;
  }>,
): ContextCompilationTrace {
  return {
    id: input.traceId,
    projectId: input.projectId,
    chapterId: null,
    taskType: input.baseline.taskType,
    maximumContextTokens: input.baseline.maximumContextTokens,
    requiredTokens: input.baseline.requiredTokens,
    usedTokens: input.baseline.usedTokens,
    remainingTokens: input.baseline.remainingTokens,
    discardedTokens: input.baseline.discardedTokens,
    tokenEstimateSource: input.baseline.tokenEstimateSource,
    createdAt: input.createdAt,
    execution: {
      generationId: input.invocationId,
      generationRunId: null,
      modelInvocationId: input.invocationId,
    },
    outputCandidateId: null,
    entries: input.baseline.entries.map(({ sources, ...entry }) => ({
      ...entry,
      sources: sources.map(({ sourceType, sourceId, sourceVersionId, locator, contentHash }) => ({
        sourceType,
        sourceId,
        sourceVersionId,
        locator,
        contentHash,
      })),
    })),
  };
}

function exactTargetFixture(suffix: "a" | "b"): ExactTargetFixture {
  const connectionId = `paid-integration-connection-${suffix}`;
  const catalogId = `paid-integration-catalog-${suffix}`;
  const modelId = `paid-integration-model-${suffix}`;
  const connection: ModelProviderConnection = {
    id: connectionId,
    providerKind: "deepseek",
    displayName: `Paid integration target ${suffix}`,
    protocol: "openai_compatible",
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: `https://${suffix}.paid-integration.example.test/v1`,
    credentialRef: `keyring:model-hub:${connectionId}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    credentialHeaderName: null,
    modelDiscoveryPath: null,
    textGenerationPath: null,
    embeddingPath: null,
    requestTimeoutMs: 30_000,
    retryLimit: 0,
    connectionStatus: "ready",
    catalogSyncStatus: "succeeded",
    lastTestedAt: NOW,
    lastCatalogSyncedAt: NOW,
    lastErrorCode: null,
    lastErrorSummary: null,
    legacyProviderId: null,
    enabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const catalog: ModelCatalogEntry = {
    id: catalogId,
    connectionId,
    providerModelId: modelId,
    displayName: `Paid integration model ${suffix}`,
    ownedBy: null,
    catalogSource: "manual",
    availability: "available",
    lifecycle: "stable",
    inputTokenLimit: 200_000,
    outputTokenLimit: 20_000,
    firstDiscoveredAt: NOW,
    lastSeenAt: NOW,
    staleAfter: null,
    lastSyncId: null,
    revision: 1,
  };
  const cost: ModelCostPrivacyProfile = {
    catalogEntryId: catalogId,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "2000",
    cachedInputMicrosPerMillionTokens: "500",
    pricingVersion: "paid-integration-price@1",
    priceUpdatedAt: NOW,
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "provider_default",
    evidenceSource: "user_confirmed",
    evidenceVersion: "paid-integration-price@1",
    evidenceSummary: null,
    evidenceUpdatedAt: NOW,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const evidence: readonly ModelCapabilityEvidence[] = [
    {
      id: `paid-integration-evidence-${suffix}`,
      catalogEntryId: catalogId,
      scanId: null,
      capability: "text_generation",
      verdict: "supported",
      evidenceSource: "user_confirmed",
      evidenceVersion: "paid-integration-capability@1",
      evidenceSummary: null,
      observedAt: NOW,
      expiresAt: null,
    },
  ];
  return { connection, catalog, cost, evidence };
}

async function inspectTarget(
  target: ExactTargetFixture,
  profile: ModelHubExactEvaluationRequestProfile,
  messagesOrFixtureInput:
    readonly NativeModelMessage[] | string = "Private fixture text used only to derive a receipt.",
): Promise<ModelHubExactEvaluationInspection> {
  const dependencies: ModelHubExactEvaluationDependencies = {
    modelHub: {
      findConnection: (id) =>
        Promise.resolve(id === target.connection.id ? target.connection : null),
      listCatalog: (connectionId) =>
        Promise.resolve(connectionId === target.connection.id ? [target.catalog] : []),
      listCapabilityEvidence: (catalogEntryId) =>
        Promise.resolve(catalogEntryId === target.catalog.id ? target.evidence : []),
      findCostPrivacyProfile: (catalogEntryId) =>
        Promise.resolve(catalogEntryId === target.catalog.id ? target.cost : null),
    },
    modelGateway: {
      available: true,
      generate: () => Promise.reject(new Error("integration inspection must not dispatch")),
    },
    credentials: { getSummary: () => Promise.resolve({ configured: true }) },
    clock: { now: () => isoUtcTimestamp(NOW) },
  };
  return inspectModelHubExactEvaluationTarget(dependencies, {
    target: {
      connectionId: target.connection.id,
      catalogEntryId: target.catalog.id,
      providerKind: target.connection.providerKind,
      modelId: target.catalog.providerModelId,
    },
    requestProfile: profile,
    messages:
      typeof messagesOrFixtureInput === "string"
        ? [{ role: "user", content: messagesOrFixtureInput }]
        : messagesOrFixtureInput,
  });
}

async function seedExactTarget(
  executor: NodeSqliteExecutor,
  target: ExactTargetFixture,
): Promise<void> {
  const { connection, catalog, cost, evidence } = target;
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, region, workspace_id, endpoint_id,
       base_url, credential_ref, credential_state, connection_status, catalog_sync_status,
       last_tested_at, last_catalog_synced_at, last_error_code, last_error_summary,
       legacy_provider_id, enabled, revision, created_at, updated_at,
       authentication_mode, credential_header_name, model_discovery_path,
       text_generation_path, embedding_path, request_timeout_ms, retry_limit
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      connection.id,
      connection.providerKind,
      connection.displayName,
      connection.protocol,
      connection.region,
      connection.workspaceId,
      connection.endpointId,
      connection.baseUrl,
      connection.credentialRef,
      connection.credentialState,
      connection.connectionStatus,
      connection.catalogSyncStatus,
      connection.lastTestedAt,
      connection.lastCatalogSyncedAt,
      connection.lastErrorCode,
      connection.lastErrorSummary,
      connection.legacyProviderId,
      connection.revision,
      connection.createdAt,
      connection.updatedAt,
      connection.authenticationMode,
      connection.credentialHeaderName,
      connection.modelDiscoveryPath,
      connection.textGenerationPath,
      connection.embeddingPath,
      connection.requestTimeoutMs,
      connection.retryLimit,
    ],
  );
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, owned_by, catalog_source,
       availability, lifecycle, input_token_limit, output_token_limit,
       first_discovered_at, last_seen_at, stale_after, last_sync_id, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      catalog.id,
      catalog.connectionId,
      catalog.providerModelId,
      catalog.displayName,
      catalog.ownedBy,
      catalog.catalogSource,
      catalog.availability,
      catalog.lifecycle,
      catalog.inputTokenLimit,
      catalog.outputTokenLimit,
      catalog.firstDiscoveredAt,
      catalog.lastSeenAt,
      catalog.staleAfter,
      catalog.lastSyncId,
      catalog.revision,
    ],
  );
  await executor.execute(
    `INSERT INTO model_cost_privacy_profiles (
       catalog_entry_id, currency, input_micros_per_million_tokens,
       output_micros_per_million_tokens, cached_input_micros_per_million_tokens,
       pricing_version, price_updated_at, data_destination, retention_policy,
       training_policy, evidence_source, evidence_version, evidence_summary,
       evidence_updated_at, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cost.catalogEntryId,
      cost.currency,
      cost.inputMicrosPerMillionTokens,
      cost.outputMicrosPerMillionTokens,
      cost.cachedInputMicrosPerMillionTokens,
      cost.pricingVersion,
      cost.priceUpdatedAt,
      cost.dataDestination,
      cost.retentionPolicy,
      cost.trainingPolicy,
      cost.evidenceSource,
      cost.evidenceVersion,
      cost.evidenceSummary,
      cost.evidenceUpdatedAt,
      cost.revision,
      cost.createdAt,
      cost.updatedAt,
    ],
  );
  for (const item of evidence) {
    await executor.execute(
      `INSERT INTO model_capability_evidence (
         id, catalog_entry_id, scan_id, capability, verdict, evidence_source,
         evidence_version, evidence_summary, observed_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.catalogEntryId,
        item.scanId,
        item.capability,
        item.verdict,
        item.evidenceSource,
        item.evidenceVersion,
        item.evidenceSummary,
        item.observedAt,
        item.expiresAt,
      ],
    );
  }
}

function requiredProfile(
  profiles: readonly NovelSkillPaidEvaluationRequestProfileInput[],
  taskType: string,
): NovelSkillPaidEvaluationRequestProfileInput {
  const profile = profiles.find((candidate) => candidate.taskType === taskType);
  if (profile === undefined) throw new Error(`request profile missing for ${taskType}`);
  return profile;
}

function requiredBaseline(
  baselines: readonly NovelSkillPaidEvaluationContextBaselineInput[],
  fixtureId: string,
): NovelSkillPaidEvaluationContextBaselineInput {
  const baseline = baselines.find((candidate) => candidate.fixtureId === fixtureId);
  if (baseline === undefined) throw new Error(`context baseline missing for ${fixtureId}`);
  return baseline;
}

function requiredMapValue<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key);
  if (value === undefined) throw new Error("required map value missing");
  return value;
}

function requiredArrayItem<Value>(values: readonly Value[], index: number, label: string): Value {
  const value = values[index];
  if (value === undefined) throw new Error(`${label} missing`);
  return value;
}

function isoUtcTimestamp(value: string) {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw new Error(`invalid test timestamp: ${value}`);
  return parsed.value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
