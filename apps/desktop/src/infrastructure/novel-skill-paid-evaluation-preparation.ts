import {
  NOVEL_SKILL_EVALUATION_METRICS,
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  createNovelSkillEvaluationExecutionPlan,
  listNovelSkillEvaluationFixtures,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import { NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY, type Clock } from "@inkshadow/domain";

import {
  MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
  MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
  hashModelHubExactEvaluationRequestProfile,
  inspectModelHubExactEvaluationTarget,
  type InspectModelHubExactEvaluationTargetInput,
  type ModelHubExactEvaluationDependencies,
  type ModelHubExactEvaluationInspection,
  type ModelHubExactEvaluationRequestProfile,
  type ModelHubExactEvaluationTargetSelector,
} from "./model-hub-exact-evaluation-target";
import type { ModelHubTextTask } from "./model-hub-execution-service";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import {
  compileNovelSkillPaidEvaluationPayload,
  createNovelSkillPaidEvaluationContextBaselineProjection,
  createNovelSkillPaidEvaluationPreferenceProjection,
  createNovelSkillPaidEvaluationPromptTemplateProjection,
  type NovelSkillPaidEvaluationPreferenceSource,
} from "./novel-skill-paid-evaluation-payload-authority";
import type {
  NovelSkillPaidEvaluationControlSnapshot,
  NovelSkillPaidEvaluationControlSqliteStore,
  NovelSkillPaidEvaluationControlTarget,
} from "./novel-skill-paid-evaluation-control-sqlite-store";
import type { NovelSkillPaidEvaluationPreparationPort } from "./novel-skill-paid-evaluation-runtime";
import {
  NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
  NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION,
  NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION,
  type CreateNovelSkillPaidEvaluationProtocolInput,
  type NovelSkillPaidEvaluationContextBaselineInput,
  type NovelSkillPaidEvaluationRequestProfileInput,
  type NovelSkillPaidEvaluationSqliteStore,
} from "./novel-skill-paid-evaluation-sqlite-store";
import {
  hashNovelSkillEvaluationModelArtifact,
  hashNovelSkillEvaluationModelIdentity,
  type NovelSkillEvaluationManifestItem,
  type NovelSkillEvaluationSqliteStore,
} from "./novel-skill-evaluation-sqlite-store";

export const NOVEL_SKILL_PAID_EVALUATION_CONTEXT_TOKEN_BUDGET = 7_000 as const;
export const NOVEL_SKILL_PAID_EVALUATION_MAXIMUM_OUTPUT_TOKENS = 4_096 as const;
export const NOVEL_SKILL_PAID_EVALUATION_BLINDING_VERSION = "novel-skill-paid-blinding@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_RANDOMIZATION_VERSION =
  "novel-skill-paid-randomization@1" as const;

const MODEL_SLOTS = Object.freeze([
  Object.freeze({ slotId: "text_tier_a" as const, modelTier: "exact_text_a" }),
  Object.freeze({ slotId: "text_tier_b" as const, modelTier: "exact_text_b" }),
]);
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TARGET_ID_PATTERN = /^\S{1,512}$/u;
export const NOVEL_SKILL_PAID_EVALUATION_PROJECT_NAME_PREFIX =
  "InkShadow Novel Skill paid evaluation" as const;
export const NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE = "novel_skill_paid_evaluation" as const;

const CODE_OWNED_EVALUATION_PREFERENCE_SOURCES = Object.freeze([
  Object.freeze({
    sourceId: "evaluation-preference:narrative-specificity",
    sourceVersionId: "1.0.0",
    preferenceText:
      "叙事应具体、克制，优先使用可感知细节，避免空泛套话，也不要添加题目没有依据的事实。",
  }),
  Object.freeze({
    sourceId: "evaluation-preference:dialogue-restraint",
    sourceVersionId: "1.0.0",
    preferenceText: "对话应简洁并能区分人物，让意图和潜台词推动交流，避免所有人物使用同一种口吻。",
  }),
  Object.freeze({
    sourceId: "evaluation-preference:revision-discipline",
    sourceVersionId: "1.0.0",
    preferenceText: "改写只处理任务明确要求的范围；原文中正确、有效的内容应尽量保留。",
  }),
  Object.freeze({
    sourceId: "evaluation-preference:evidence-first",
    sourceVersionId: "1.0.0",
    preferenceText: "分析或检查结论必须对应题目中的明确证据；证据不足时应保留不确定性。",
  }),
] satisfies readonly NovelSkillPaidEvaluationPreferenceSource[]);

const RUBRIC_SEMANTICS: Readonly<Record<NovelSkillEvaluationMetric, string>> = Object.freeze({
  instruction_following: "Fulfils the requested outcome and every explicit boundary.",
  canon_preservation: "Preserves every locked fact without invention or contradiction.",
  character_consistency: "Keeps character motives, knowledge and behaviour internally consistent.",
  pov_preservation: "Stays within the required point of view and its knowledge boundary.",
  causal_progression: "Makes events follow from prior causes and creates a meaningful next change.",
  scene_function: "Performs the scene or structural function requested by the fixture.",
  dialogue_distinction: "Keeps speakers distinguishable through intent, diction and response.",
  specificity: "Uses concrete, task-relevant detail instead of generic filler.",
  repetition_cliche_control: "Avoids redundant beats, stock phrasing and unsupported melodrama.",
  pacing: "Allocates attention and transitions in proportion to the requested narrative beat.",
  user_preference:
    "Honours supplied preferences without overriding locked facts or task boundaries.",
  unnecessary_rewrite_avoidance:
    "Changes only what the task requires and preserves sound material.",
  evidence_completeness:
    "Makes every judgement traceable to visible fixture and candidate evidence.",
});

const RUBRIC_CONTRACT = Object.freeze({
  schemaVersion: 1,
  version: NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION,
  scoreUnit: "basis_points_0_to_10000",
  requiredMetricCount: 13,
  requiredMetrics: Object.freeze(
    NOVEL_SKILL_EVALUATION_METRICS.map((metric) =>
      Object.freeze({
        metric,
        direction: "higher_is_better",
        blocking: true,
        meaning: RUBRIC_SEMANTICS[metric],
      }),
    ),
  ),
  anchors: Object.freeze([
    Object.freeze({ scoreBasisPoints: 0, meaning: "Clear failure or direct contradiction." }),
    Object.freeze({ scoreBasisPoints: 2_500, meaning: "Major defects materially harm the task." }),
    Object.freeze({
      scoreBasisPoints: 5_000,
      meaning: "Mixed result with important correct and incorrect parts.",
    }),
    Object.freeze({
      scoreBasisPoints: 7_500,
      meaning: "Strong result with limited, non-blocking defects.",
    }),
    Object.freeze({
      scoreBasisPoints: 10_000,
      meaning: "Fully satisfies the visible contract for this metric.",
    }),
  ]),
});

const EVALUATOR_CONTRACT = Object.freeze({
  schemaVersion: 1,
  version: "novel-skill-paid-human-evaluator@1",
  evaluator: "local_human_reviewer",
  evidenceBoundary: "visible_fixture_contract_and_candidate_only",
  requiredCandidateCount: NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
  scoresPerCandidate: NOVEL_SKILL_EVALUATION_METRICS.length,
  missingScorePolicy: "run_ineligible",
  automatedScorePolicy: "forbidden",
  defaultEnablementPolicy: "keep_disabled_until_separate_human_approval",
});

const BLINDING_CONTRACT = Object.freeze({
  schemaVersion: 1,
  version: NOVEL_SKILL_PAID_EVALUATION_BLINDING_VERSION,
  reviewerMaySee: Object.freeze(["fixture_task", "candidate_visible_output"]),
  reviewerMustNotSee: Object.freeze([
    "provider",
    "model",
    "connection",
    "catalog_entry",
    "model_slot",
    "experiment_arm",
    "repetition",
    "cost",
    "persistence_hash",
  ]),
  revealPolicy: "scores_sealed_before_identity_reveal",
  receiptPolicy: "local_immutable_reviewer_receipt",
});

const RANDOMIZATION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  version: NOVEL_SKILL_PAID_EVALUATION_RANDOMIZATION_VERSION,
  populationSize: NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
  positions: "exactly_once_1_through_192",
  algorithm: "cryptographically_secure_unbiased_fisher_yates",
  seedPersistence: "never_persist_raw_random_bytes",
  orderReceipt: "persist_content_free_blind_item_mapping",
});

export interface NovelSkillPaidEvaluationProtocolContract {
  readonly contractHash: string;
  readonly rubricContentHash: string;
  readonly evaluatorContractHash: string;
  readonly blindingProtocolVersion: typeof NOVEL_SKILL_PAID_EVALUATION_BLINDING_VERSION;
  readonly blindingProtocolHash: string;
  readonly randomizationProtocolVersion: typeof NOVEL_SKILL_PAID_EVALUATION_RANDOMIZATION_VERSION;
  readonly randomizationProtocolHash: string;
  readonly promptTemplateVersion: string;
  readonly promptTemplateHash: string;
  readonly requestProfiles: readonly NovelSkillPaidEvaluationRequestProfileInput[];
  readonly contextBaselines: readonly NovelSkillPaidEvaluationContextBaselineInput[];
  readonly manifests: Readonly<{
    core: readonly NovelSkillEvaluationManifestItem[];
    coreGenre: readonly NovelSkillEvaluationManifestItem[];
    coreGenrePreferences: readonly NovelSkillEvaluationManifestItem[];
  }>;
  readonly preferenceConfigurationHash: string;
}

export interface ArchivedEvaluationProjectContentCounts {
  readonly chapters: number;
  readonly storyFacts: number;
  readonly projectSeeds: number;
  readonly planningCandidates: number;
  readonly writingPreferences: number;
  readonly settingsReceipts: number;
  readonly skillBindings: number;
}

export interface ArchivedEvaluationProjectSnapshot {
  readonly projectId: string;
  readonly displayName: string;
  readonly purpose: typeof NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE;
  readonly ownerRunId: string;
  readonly status: "active" | "archived" | "trashed";
  readonly archivedAt: string | null;
  readonly trashedAt: string | null;
  readonly contentCounts: ArchivedEvaluationProjectContentCounts;
}

/** Persistence-owned seam: implementations create once, then re-read and verify on every call. */
export interface ArchivedEvaluationProjectPort {
  ensureDedicatedArchivedEmptyProject(
    input: Readonly<
      NovelSkillPaidEvaluationArchivedProjectIdentity & {
        requestedAt: string;
      }
    >,
  ): Promise<ArchivedEvaluationProjectSnapshot>;
}

export interface NovelSkillPaidEvaluationArchivedProjectIdentity {
  readonly projectId: string;
  readonly ownerRunId: string;
  readonly displayName: string;
  readonly purpose: typeof NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE;
}

type PreparationEvaluationStorePort = Pick<
  NovelSkillEvaluationSqliteStore,
  "createRun" | "createSuite"
>;

type PreparationPaidStorePort = Pick<
  NovelSkillPaidEvaluationSqliteStore,
  "bindExactModelTargets" | "createExecutionProtocol" | "quoteCommercialRun"
>;

type PreparationControlStorePort = Pick<
  NovelSkillPaidEvaluationControlSqliteStore,
  "getControlSnapshot" | "listTargets"
>;

export interface NovelSkillPaidEvaluationPreparationExactTargetPort {
  inspect(
    dependencies: ModelHubExactEvaluationDependencies,
    input: InspectModelHubExactEvaluationTargetInput,
  ): Promise<ModelHubExactEvaluationInspection>;
}

export interface NovelSkillPaidEvaluationPreparationOptions {
  readonly clock: Clock;
  readonly evaluationStore: PreparationEvaluationStorePort;
  readonly paidStore: PreparationPaidStorePort;
  readonly controlStore: PreparationControlStorePort;
  readonly archivedProjectPort: ArchivedEvaluationProjectPort;
  readonly exactTargetDependencies: Omit<ModelHubExactEvaluationDependencies, "modelHub"> &
    Readonly<{
      modelHub: ModelHubExactEvaluationDependencies["modelHub"] &
        Readonly<{
          listConnections(): Promise<
            readonly Readonly<{ id: string; providerKind: ModelProviderKind }>[]
          >;
        }>;
    }>;
  /** Tests may replace inspection only; production uses the exact Model Hub inspector. */
  readonly exactTargetPort?: NovelSkillPaidEvaluationPreparationExactTargetPort;
}

export type NovelSkillPaidEvaluationPreparationErrorCode =
  | "NOVEL_SKILL_PAID_PREPARATION_INVALID"
  | "NOVEL_SKILL_PAID_PREPARATION_PROJECT_UNSAFE"
  | "NOVEL_SKILL_PAID_PREPARATION_STATE_CONFLICT"
  | "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED";

export class NovelSkillPaidEvaluationPreparationError extends Error {
  public constructor(
    readonly code: NovelSkillPaidEvaluationPreparationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillPaidEvaluationPreparationError";
  }
}

const DEFAULT_EXACT_TARGET_PORT: NovelSkillPaidEvaluationPreparationExactTargetPort = Object.freeze(
  {
    inspect: inspectModelHubExactEvaluationTarget,
  },
);

const runPreparationLocks = new Map<string, Promise<void>>();

/**
 * Creates the content-free 0061/0063 plan and exact target locks. It only reads
 * Model Hub authority and never invokes the provider generation boundary.
 */
export class NovelSkillPaidEvaluationPreparation implements NovelSkillPaidEvaluationPreparationPort {
  public constructor(private readonly options: NovelSkillPaidEvaluationPreparationOptions) {}

  public async preparePersistedRun(
    input: Readonly<{
      runId: string;
      exactTargetIds: readonly [string, string];
    }>,
  ): Promise<void> {
    validatePreparationInput(input);
    const preceding = runPreparationLocks.get(input.runId);
    const operation = (preceding ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.prepareUnlocked(input));
    runPreparationLocks.set(input.runId, operation);
    try {
      await operation;
    } finally {
      if (runPreparationLocks.get(input.runId) === operation) {
        runPreparationLocks.delete(input.runId);
      }
    }
  }

  private async prepareUnlocked(
    input: Readonly<{
      runId: string;
      exactTargetIds: readonly [string, string];
    }>,
  ): Promise<void> {
    const suiteId = await deterministicUuidV7("novel-skill-paid-suite@1", input.runId);
    const contract = await createNovelSkillPaidEvaluationProtocolContract();
    const targetSelectors = await Promise.all(
      input.exactTargetIds.map((targetId) =>
        resolveExactTargetSelector(this.options.exactTargetDependencies, targetId),
      ),
    );
    const inspections = await inspectPreparationTargets({
      runId: input.runId,
      suiteId,
      targetSelectors,
      contract,
      dependencies: this.options.exactTargetDependencies,
      exactTargetPort: this.options.exactTargetPort ?? DEFAULT_EXACT_TARGET_PORT,
    });
    const assignments = await Promise.all(
      inspections.map(async (inspection, index) => ({
        slotId: MODEL_SLOTS[index]?.slotId ?? failMissingSlot(),
        modelIdentityHash: await hashNovelSkillEvaluationModelIdentity({
          catalogEntryId: inspection.target.catalogEntryId,
          connectionId: inspection.target.connectionId,
          modelId: inspection.target.modelId,
          providerKind: inspection.target.providerKind,
        }),
        modelArtifactHash: await hashNovelSkillEvaluationModelArtifact({
          modelId: inspection.target.modelId,
          providerKind: inspection.target.providerKind,
        }),
      })),
    );
    if (new Set(assignments.map(({ modelArtifactHash }) => modelArtifactHash)).size !== 2) {
      throw preparationError(
        "NOVEL_SKILL_PAID_PREPARATION_INVALID",
        "Paid evaluation requires two different exact provider model artifacts.",
      );
    }
    const existing = await this.options.controlStore.getControlSnapshot(input.runId);
    const projectIdentity = await novelSkillPaidEvaluationArchivedProjectIdentity(input.runId);
    const project = await this.options.archivedProjectPort.ensureDedicatedArchivedEmptyProject({
      ...projectIdentity,
      requestedAt: this.options.clock.now(),
    });
    assertSafeEvaluationProject(project, projectIdentity);

    if (existing !== null && existing.status !== "planned") {
      throw preparationError(
        "NOVEL_SKILL_PAID_PREPARATION_STATE_CONFLICT",
        "Only a planned paid evaluation run can replay its local preparation authority.",
      );
    }

    // Each Store operation is an independent atomic transaction. Their exact
    // read-before-insert replay contracts make this ordered sequence resumable
    // after a crash at any transaction boundary without deleting evidence.
    const createdAt = createdAtFromRunUuidV7(input.runId);
    const plan = createNovelSkillEvaluationExecutionPlan(MODEL_SLOTS);
    if (plan.cells.length !== NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT) {
      throw preparationError(
        "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
        "The code-owned evaluation plan is no longer the exact 192-cell matrix.",
      );
    }
    await this.options.evaluationStore.createSuite({
      suiteId,
      evaluationProjectId: project.projectId,
      plan,
      manifests: contract.manifests,
      preferenceConfigurationHash: contract.preferenceConfigurationHash,
      createdAt,
    });
    await this.options.paidStore.createExecutionProtocol(
      protocolInput(suiteId, contract, createdAt),
    );
    await this.options.evaluationStore.createRun({
      runId: input.runId,
      suiteId,
      modelAssignments: assignments,
      createdAt,
    });
    await this.options.paidStore.bindExactModelTargets(
      input.runId,
      inspections.map((inspection, index) => ({
        modelSlotId: MODEL_SLOTS[index]?.slotId ?? failMissingSlot(),
        inspection,
        artifactIdentitySource: "provider_model_id" as const,
      })),
      createdAt,
    );
    const completed = await this.options.controlStore.getControlSnapshot(input.runId);
    if (completed === null) {
      throw preparationError(
        "NOVEL_SKILL_PAID_PREPARATION_STATE_CONFLICT",
        "The persisted evaluation run is missing after preparation.",
      );
    }
    await this.assertIdempotentExistingRun({
      input,
      suiteId,
      existing: completed,
      contract,
      inspections,
    });
  }

  private async assertIdempotentExistingRun(
    input: Readonly<{
      input: Readonly<{ runId: string; exactTargetIds: readonly [string, string] }>;
      suiteId: string;
      existing: NovelSkillPaidEvaluationControlSnapshot;
      contract: NovelSkillPaidEvaluationProtocolContract;
      inspections: readonly [ModelHubExactEvaluationInspection, ModelHubExactEvaluationInspection];
    }>,
  ): Promise<void> {
    if (
      input.existing.suiteId !== input.suiteId ||
      input.existing.totalCells !== NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT ||
      !input.existing.protocolConfigured ||
      input.existing.exactTargetCount !== 2 ||
      input.existing.status === "invalidated"
    ) {
      throw preparationError(
        "NOVEL_SKILL_PAID_PREPARATION_STATE_CONFLICT",
        "An incomplete or different paid evaluation run already owns this run identifier.",
      );
    }
    const [targets, quote] = await Promise.all([
      this.options.controlStore.listTargets(input.input.runId),
      this.options.paidStore.quoteCommercialRun(input.input.runId),
    ]);
    const orderedTargets = [...targets].sort((left, right) =>
      left.modelSlotId.localeCompare(right.modelSlotId, "en"),
    );
    const expectedProtocolHash = await hashNovelSkillPaidEvaluationPersistedProtocol(
      input.suiteId,
      input.contract,
    );
    if (
      quote.runId !== input.input.runId ||
      quote.protocolHash !== expectedProtocolHash ||
      (quote as { readonly authorizedCallCount: number }).authorizedCallCount !==
        NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT ||
      orderedTargets.length !== 2 ||
      !orderedTargets.every((target, index) =>
        targetMatches(
          target,
          input.input.exactTargetIds[index] ?? "",
          input.inspections[index] ?? failMissingInspection(),
        ),
      )
    ) {
      throw preparationError(
        "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
        "The persisted protocol or exact target locks differ from the current code-owned authority.",
      );
    }
  }
}

export function createNovelSkillPaidEvaluationPreparation(
  options: NovelSkillPaidEvaluationPreparationOptions,
): NovelSkillPaidEvaluationPreparationPort {
  return new NovelSkillPaidEvaluationPreparation(options);
}

/** Stable authority shared by preparation and the production CreateProject/ArchiveProject adapter. */
export async function novelSkillPaidEvaluationArchivedProjectIdentity(
  runId: string,
): Promise<NovelSkillPaidEvaluationArchivedProjectIdentity> {
  if (!UUID_V7_PATTERN.test(runId)) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_INVALID",
      "The paid evaluation project owner must be a UUIDv7 run.",
    );
  }
  return Object.freeze({
    projectId: await deterministicUuidV7("novel-skill-paid-project@1", runId),
    ownerRunId: runId,
    displayName: `${NOVEL_SKILL_PAID_EVALUATION_PROJECT_NAME_PREFIX} · ${runId}`,
    purpose: NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE,
  });
}

/** No caller supplies a rubric, evaluator, blinding, randomization or protocol hash. */
export async function createNovelSkillPaidEvaluationProtocolContract(): Promise<NovelSkillPaidEvaluationProtocolContract> {
  if (
    (NOVEL_SKILL_EVALUATION_METRICS as readonly unknown[]).length !== 13 ||
    Object.keys(RUBRIC_SEMANTICS).length !== NOVEL_SKILL_EVALUATION_METRICS.length
  ) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
      "The code-owned human rubric is no longer the fixed 13-metric contract.",
    );
  }
  const fixtures = listNovelSkillEvaluationFixtures();
  if (fixtures.length !== 12) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
      "The code-owned fixture registry is no longer the fixed 12-fixture suite.",
    );
  }
  const [coreDefinitions, genreDefinitions, promptTemplate, preferenceProjection] =
    await Promise.all([
      createCoreNovelSkillDefinitions(),
      createGenreNovelSkillDefinitions(),
      createNovelSkillPaidEvaluationPromptTemplateProjection(),
      createNovelSkillPaidEvaluationPreferenceProjection(
        listNovelSkillPaidEvaluationPreferenceSources(),
      ),
    ]);
  const core = coreDefinitions.map(toManifestItem);
  const genre = genreDefinitions.map(toManifestItem);
  const taskTypes = [...new Set(fixtures.map(({ taskType }) => taskType))].sort(compareText);
  const requestProfiles = await Promise.all(
    taskTypes.map(async (taskType): Promise<NovelSkillPaidEvaluationRequestProfileInput> => {
      const profile = createNovelSkillPaidEvaluationRequestProfile(taskType as ModelHubTextTask);
      return Object.freeze({
        taskType,
        profileVersion: profile.version,
        requestProfileHash: await hashModelHubExactEvaluationRequestProfile(profile),
        maximumInputTokens: profile.maximumInputTokens,
        maximumOutputTokens: profile.maximumOutputTokens,
        temperatureBasisPoints: profile.temperatureBasisPoints,
        topPBasisPoints: profile.topPBasisPoints,
        streaming: true,
        stopPolicyHash: profile.stopPolicyHash,
      });
    }),
  );
  const contextBaselines = await Promise.all(
    [...fixtures]
      .sort((left, right) => compareText(left.fixtureId, right.fixtureId))
      .map(async ({ fixtureId }): Promise<NovelSkillPaidEvaluationContextBaselineInput> => {
        const baseline = await createNovelSkillPaidEvaluationContextBaselineProjection(
          fixtureId,
          NOVEL_SKILL_PAID_EVALUATION_CONTEXT_TOKEN_BUDGET,
        );
        return Object.freeze({
          fixtureId,
          baselineContractHash: baseline.baselineContractHash,
          includedSourceManifestHash: baseline.includedSourceManifestHash,
          omittedSourceManifestHash: baseline.omittedSourceManifestHash,
          compiledBaselineHash: baseline.compiledBaselineHash,
          baselineTokenBudget: baseline.baselineTokenBudget,
        });
      }),
  );
  const rubricContentHash = await hashCanonical(RUBRIC_CONTRACT);
  const evaluatorContractHash = await hashCanonical(EVALUATOR_CONTRACT);
  const blindingProtocolHash = await hashCanonical(BLINDING_CONTRACT);
  const randomizationProtocolHash = await hashCanonical(RANDOMIZATION_CONTRACT);
  const manifests = Object.freeze({
    core: Object.freeze(core),
    coreGenre: Object.freeze([...core, ...genre]),
    coreGenrePreferences: Object.freeze([...core, ...genre]),
  });
  const contractIdentity = Object.freeze({
    schemaVersion: 1,
    executionProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION,
    callCount: NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
    fixtureCount: fixtures.length,
    armCount: 4,
    modelSlotCount: 2,
    repetitionCount: 2,
    promptTemplateVersion: promptTemplate.version,
    promptTemplateHash: promptTemplate.hash,
    rubricVersion: NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION,
    rubricContentHash,
    evaluatorContractHash,
    blindingProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_BLINDING_VERSION,
    blindingProtocolHash,
    randomizationProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_RANDOMIZATION_VERSION,
    randomizationProtocolHash,
    requestProfiles,
    contextBaselines,
    manifests,
    preferenceConfigurationHash: preferenceProjection.configurationHash,
  });
  return Object.freeze({
    contractHash: await hashCanonical(contractIdentity),
    rubricContentHash,
    evaluatorContractHash,
    blindingProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_BLINDING_VERSION,
    blindingProtocolHash,
    randomizationProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_RANDOMIZATION_VERSION,
    randomizationProtocolHash,
    promptTemplateVersion: promptTemplate.version,
    promptTemplateHash: promptTemplate.hash,
    requestProfiles: Object.freeze(requestProfiles),
    contextBaselines: Object.freeze(contextBaselines),
    manifests,
    preferenceConfigurationHash: preferenceProjection.configurationHash,
  });
}

/** Fixed original evaluation preferences; never reads a user's real writing profile. */
export function listNovelSkillPaidEvaluationPreferenceSources(): readonly NovelSkillPaidEvaluationPreferenceSource[] {
  return CODE_OWNED_EVALUATION_PREFERENCE_SOURCES;
}

export function createNovelSkillPaidEvaluationRequestProfile(
  task: ModelHubTextTask,
): ModelHubExactEvaluationRequestProfile {
  return Object.freeze({
    version: MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
    task,
    maximumInputTokens: NOVEL_SKILL_PAID_EVALUATION_CONTEXT_TOKEN_BUDGET,
    maximumOutputTokens: NOVEL_SKILL_PAID_EVALUATION_MAXIMUM_OUTPUT_TOKENS,
    temperatureBasisPoints: 0,
    topPBasisPoints: 10_000,
    reasoningMode: "disabled",
    responseFormat: "text",
    streaming: true,
    stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
    providerCallPolicy: "single_attempt",
  });
}

async function inspectPreparationTargets(
  input: Readonly<{
    runId: string;
    suiteId: string;
    targetSelectors: readonly ModelHubExactEvaluationTargetSelector[];
    contract: NovelSkillPaidEvaluationProtocolContract;
    dependencies: ModelHubExactEvaluationDependencies;
    exactTargetPort: NovelSkillPaidEvaluationPreparationExactTargetPort;
  }>,
): Promise<readonly [ModelHubExactEvaluationInspection, ModelHubExactEvaluationInspection]> {
  const fixture = [...listNovelSkillEvaluationFixtures()].sort((left, right) =>
    compareText(left.fixtureId, right.fixtureId),
  )[0];
  const pinned = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.find(
    ({ fixtureId }) => fixture?.fixtureId === fixtureId,
  );
  if (fixture === undefined || pinned === undefined) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
      "The code-owned inspection fixture is unavailable.",
    );
  }
  const promptTemplate = await createNovelSkillPaidEvaluationPromptTemplateProjection();
  const contextBaseline = await createNovelSkillPaidEvaluationContextBaselineProjection(
    fixture.fixtureId,
    NOVEL_SKILL_PAID_EVALUATION_CONTEXT_TOKEN_BUDGET,
  );
  const payload = await compileNovelSkillPaidEvaluationPayload({
    cell: {
      runId: input.runId,
      suiteId: input.suiteId,
      cellId: await deterministicUuidV7("novel-skill-paid-inspection-cell@1", input.runId),
      fixtureId: fixture.fixtureId,
      fixtureInputContentHash: pinned.inputContentHash,
      taskType: fixture.taskType,
      invocationMode: fixture.invocationMode,
      arm: "no_skill",
      armConfigurationHash: null,
      modelSlotId: "text_tier_a",
      repetition: 1,
    },
    promptTemplate,
    contextBaseline,
    preferenceProjection: null,
  });
  const profile = createNovelSkillPaidEvaluationRequestProfile(
    fixture.taskType as ModelHubTextTask,
  );
  const inspections = await Promise.all(
    input.targetSelectors.map((target) =>
      input.exactTargetPort.inspect(input.dependencies, {
        target,
        requestProfile: profile,
        messages: payload.messages,
      }),
    ),
  );
  const first = inspections[0];
  const second = inspections[1];
  if (first === undefined || second === undefined || inspections.length !== 2) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_INVALID",
      "Exactly two live exact target inspections are required.",
    );
  }
  return Object.freeze([first, second]);
}

async function resolveExactTargetSelector(
  dependencies: NovelSkillPaidEvaluationPreparationOptions["exactTargetDependencies"],
  targetId: string,
): Promise<ModelHubExactEvaluationTargetSelector> {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_INVALID",
      "An exact target identifier must be one bounded Model Hub catalog entry id.",
    );
  }
  const catalogEntryId = targetId;
  const connections = await dependencies.modelHub.listConnections();
  const matches = (
    await Promise.all(
      connections.map(async (connection) =>
        (await dependencies.modelHub.listCatalog(connection.id))
          .filter(({ id }) => id === catalogEntryId)
          .map((entry) => ({ connection, entry })),
      ),
    )
  ).flat();
  const match = matches[0];
  if (
    match === undefined ||
    matches.length !== 1 ||
    match.entry.connectionId !== match.connection.id
  ) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_INVALID",
      "The selected exact Model Hub target does not exist as one connection/catalog pair.",
    );
  }
  return Object.freeze({
    connectionId: match.connection.id,
    catalogEntryId,
    providerKind: match.connection.providerKind,
    modelId: match.entry.providerModelId,
  });
}

function protocolInput(
  suiteId: string,
  contract: NovelSkillPaidEvaluationProtocolContract,
  createdAt: string,
): CreateNovelSkillPaidEvaluationProtocolInput {
  return {
    suiteId,
    promptTemplateVersion: contract.promptTemplateVersion,
    promptTemplateHash: contract.promptTemplateHash,
    rubricContentHash: contract.rubricContentHash,
    evaluatorContractHash: contract.evaluatorContractHash,
    blindingProtocolVersion: contract.blindingProtocolVersion,
    blindingProtocolHash: contract.blindingProtocolHash,
    randomizationProtocolVersion: contract.randomizationProtocolVersion,
    randomizationProtocolHash: contract.randomizationProtocolHash,
    requestProfiles: contract.requestProfiles,
    contextBaselines: contract.contextBaselines,
    createdAt,
  };
}

/** Canonical 0063 protocol identity derived exclusively from the code-owned contract. */
export async function hashNovelSkillPaidEvaluationPersistedProtocol(
  suiteId: string,
  contract: NovelSkillPaidEvaluationProtocolContract,
): Promise<string> {
  const requestProfileManifestHash = await hashCanonical(contract.requestProfiles);
  const contextBaselineManifestHash = await hashCanonical(contract.contextBaselines);
  return hashCanonical({
    schemaVersion: 1,
    executionProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION,
    suiteId,
    requestProfileManifestHash,
    contextBaselineManifestHash,
    promptTemplateVersion: contract.promptTemplateVersion,
    promptTemplateHash: contract.promptTemplateHash,
    rubricVersion: NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION,
    rubricContentHash: contract.rubricContentHash,
    evaluatorContractHash: contract.evaluatorContractHash,
    blindingProtocolVersion: contract.blindingProtocolVersion,
    blindingProtocolHash: contract.blindingProtocolHash,
    randomizationProtocolVersion: contract.randomizationProtocolVersion,
    randomizationProtocolHash: contract.randomizationProtocolHash,
  });
}

function assertSafeEvaluationProject(
  project: ArchivedEvaluationProjectSnapshot,
  identity: NovelSkillPaidEvaluationArchivedProjectIdentity,
): void {
  if (
    project.projectId !== identity.projectId ||
    project.displayName !== identity.displayName ||
    project.ownerRunId !== identity.ownerRunId ||
    (project as { readonly purpose: unknown }).purpose !==
      NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE ||
    !UUID_V7_PATTERN.test(project.projectId) ||
    project.status !== "archived" ||
    project.archivedAt === null ||
    project.trashedAt !== null ||
    Object.values(project.contentCounts).some(
      (count) => !Number.isSafeInteger(count) || count !== 0,
    )
  ) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_PROJECT_UNSAFE",
      "Paid evaluation requires its own archived, identifiable and content-free project.",
    );
  }
}

function targetMatches(
  target: NovelSkillPaidEvaluationControlTarget,
  targetId: string,
  inspection: ModelHubExactEvaluationInspection,
): boolean {
  return (
    target.catalogEntryId === targetId &&
    target.connectionId === inspection.target.connectionId &&
    target.catalogEntryId === inspection.target.catalogEntryId &&
    target.providerKind === inspection.target.providerKind &&
    target.providerModelId === inspection.target.modelId &&
    target.targetHash === inspection.target.targetIdentityHash &&
    target.pricingSnapshotHash === inspection.target.costProfileHash &&
    target.currency === inspection.pricing.currency
  );
}

function validatePreparationInput(
  input: Readonly<{
    runId: string;
    exactTargetIds: readonly [string, string];
  }>,
): void {
  if (!UUID_V7_PATTERN.test(input.runId) || input.exactTargetIds[0] === input.exactTargetIds[1]) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_INVALID",
      "Paid evaluation requires one UUIDv7 run and two different exact targets.",
    );
  }
}

function toManifestItem(
  definition: Awaited<ReturnType<typeof createCoreNovelSkillDefinitions>>[number],
): NovelSkillEvaluationManifestItem {
  if (definition.kind !== "core" && definition.kind !== "genre") {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
      "A code-owned evaluation manifest contains an unsupported Skill kind.",
    );
  }
  return Object.freeze({
    skillId: definition.skillId,
    version: definition.version,
    definitionHash: definition.definitionHash,
    kind: definition.kind,
  });
}

async function deterministicUuidV7(namespace: string, runId: string): Promise<string> {
  const digest = await hashCanonical({ namespace, runId });
  const compactRunId = runId.replaceAll("-", "");
  const timestamp = compactRunId.slice(0, 12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${digest.slice(0, 3)}-8${digest.slice(3, 6)}-${digest.slice(6, 18)}`;
}

function createdAtFromRunUuidV7(runId: string): string {
  const timestampHex = runId.replaceAll("-", "").slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);
  const createdAt = new Date(timestamp).toISOString();
  if (
    !Number.isSafeInteger(timestamp) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt)
  ) {
    throw preparationError(
      "NOVEL_SKILL_PAID_PREPARATION_INVALID",
      "The UUIDv7 run does not contain a valid deterministic creation timestamp.",
    );
  }
  return createdAt;
}

async function hashCanonical(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function failMissingSlot(): never {
  throw preparationError(
    "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
    "The code-owned two-slot plan is incomplete.",
  );
}

function failMissingInspection(): never {
  throw preparationError(
    "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
    "The live exact target inspection set is incomplete.",
  );
}

function preparationError(
  code: NovelSkillPaidEvaluationPreparationErrorCode,
  message: string,
  cause?: unknown,
): NovelSkillPaidEvaluationPreparationError {
  return new NovelSkillPaidEvaluationPreparationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
