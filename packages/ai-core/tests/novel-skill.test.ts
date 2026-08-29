import { describe, expect, it } from "vitest";

import {
  MAX_NOVEL_SKILLS_PER_INVOCATION,
  NOVEL_SKILL_EVALUATION_FIXTURES,
  compileFixedNovelSkillEvaluationArm,
  compileNovelSkills,
  createCoreNovelSkillDefinitions,
  createNovelSkillEvaluationExecutionPlan,
  createNovelSkillEvaluationPlan,
  estimateNovelSkillPromptTokens,
  evaluateNovelSkillAbEvidence,
  isFixedNovelSkillEvaluationConfiguration,
  sealNovelSkillDefinition,
  validateNovelSkillConfigurationSnapshot,
  validateNovelSkillInvocationItem,
  validateProjectNovelSkillBinding,
  type NovelSkillDefinitionDraft,
  type NovelSkillEvaluationObservation,
  type ProjectNovelSkillBinding,
} from "../src/index.js";

const PROJECT_ID = "019f9f4a-b3c-7350-9226-000000000001";
const NOW = "2026-08-10T00:00:00.000Z";
const EVALUATION_MODEL_SLOTS = [
  { slotId: "text_tier_a", modelTier: "economy" },
  { slotId: "text_tier_b", modelTier: "quality" },
] as const;

describe("Novel Skill registry and compiler", () => {
  it("ships seven original Core definitions as experimental and disabled by default", async () => {
    const definitions = await createCoreNovelSkillDefinitions();

    expect(definitions).toHaveLength(7);
    expect(definitions.every(({ status }) => status === "experimental")).toBe(true);
    expect(definitions.every(({ defaultEnabled }) => defaultEnabled === false)).toBe(true);
    expect(new Set(definitions.map(({ definitionHash }) => definitionHash)).size).toBe(7);

    const compiled = await compileNovelSkills({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 2_000,
      genreTags: ["campus_romance"],
      explicitSkillIds: [],
      availableContextLayers: ["current_task", "scene_goal", "pov_known_information"],
      allowExperimental: false,
      definitions,
      bindings: [],
    });

    expect(compiled.selectedDefinitions).toEqual([]);
    expect(
      compiled.items.every(({ selectionReason }) => selectionReason === "status_blocked"),
    ).toBe(true);
  });

  it("requires explicit expert consent before a manual experimental binding is compiled", async () => {
    const definitions = await createCoreNovelSkillDefinitions();
    const scene = definitions.find(({ skillId }) => skillId === "core.scene_craft");
    expect(scene).toBeDefined();
    const binding = projectBinding("core.scene_craft", scene?.version ?? "1.0.0", "manual");

    const compiled = await compileNovelSkills({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 2_000,
      genreTags: [],
      explicitSkillIds: ["core.scene_craft"],
      availableContextLayers: ["current_task", "scene_goal"],
      allowExperimental: true,
      definitions,
      bindings: [binding],
    });

    expect(compiled.selectedDefinitions.map(({ skillId }) => skillId)).toEqual([
      "core.scene_craft",
    ]);
    expect(compiled.configuration.experimentalAllowed).toBe(true);
    expect(compiled.configuration.bindings[0]?.activationMode).toBe("manual");
    expect(compiled.selectionHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("lets an explicit lower-precedence method win over an automatic exclusive method", async () => {
    const automatic = await sealNovelSkillDefinition(
      draft({
        skillId: "core.auto_method",
        precedence: 600,
        defaultEnabled: true,
        exclusiveGroup: "scene_method",
        ruleText: "自动方法",
      }),
    );
    const explicit = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.author_method",
        kind: "custom",
        ownerScope: "user",
        precedence: 300,
        defaultEnabled: false,
        exclusiveGroup: "scene_method",
        ruleText: "作者明确选择的方法",
      }),
    );

    const compiled = await compileNovelSkills({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 1_000,
      genreTags: [],
      explicitSkillIds: [explicit.skillId],
      availableContextLayers: ["current_task"],
      allowExperimental: false,
      definitions: [automatic, explicit],
      bindings: [],
    });

    expect(compiled.selectedDefinitions.map(({ skillId }) => skillId)).toEqual([
      "custom.author_method",
    ]);
    expect(compiled.items.find(({ skillId }) => skillId === automatic.skillId)).toMatchObject({
      included: false,
      discardedReason: "conflict",
    });
  });

  it("fails closed when two explicitly selected methods conflict", async () => {
    const left = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.left",
        kind: "custom",
        ownerScope: "user",
        exclusiveGroup: "method",
      }),
    );
    const right = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.right",
        kind: "custom",
        ownerScope: "user",
        exclusiveGroup: "method",
      }),
    );

    await expect(
      compileNovelSkills({
        projectId: PROJECT_ID,
        taskType: "continuation",
        invocationMode: "draft",
        maximumSkillTokens: 1_000,
        genreTags: [],
        explicitSkillIds: [left.skillId, right.skillId],
        availableContextLayers: ["current_task"],
        allowExperimental: false,
        definitions: [left, right],
        bindings: [],
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_CONFLICT" });
  });

  it("records deterministic conflict omissions for skills already enabled in a project", async () => {
    const higher = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.project_higher",
        kind: "custom",
        ownerScope: "user",
        precedence: 550,
        exclusiveGroup: "project_method",
      }),
    );
    const lower = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.project_lower",
        kind: "custom",
        ownerScope: "user",
        precedence: 450,
        exclusiveGroup: "project_method",
      }),
    );
    const bindings = [
      projectBinding(higher.skillId, higher.version, "manual"),
      projectBinding(lower.skillId, lower.version, "manual"),
    ];

    const compiled = await compileNovelSkills({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 1_000,
      genreTags: [],
      explicitSkillIds: [lower.skillId, higher.skillId],
      availableContextLayers: ["current_task"],
      allowExperimental: false,
      definitions: [lower, higher],
      bindings,
    });

    expect(compiled.selectedDefinitions.map(({ skillId }) => skillId)).toEqual([higher.skillId]);
    expect(compiled.items.find(({ skillId }) => skillId === lower.skillId)).toMatchObject({
      included: false,
      discardedReason: "conflict",
    });
  });

  it("gives an explicit rule priority and rejects two explicit rule disagreements", async () => {
    const automatic = await sealNovelSkillDefinition(
      draft({
        skillId: "core.auto_rule",
        precedence: 600,
        defaultEnabled: true,
        ruleId: "shared.rule",
        ruleText: "自动规则",
      }),
    );
    const explicit = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.author_rule",
        kind: "custom",
        ownerScope: "user",
        precedence: 300,
        ruleId: "shared.rule",
        ruleText: "作者规则",
      }),
    );
    const base = {
      projectId: PROJECT_ID,
      taskType: "continuation" as const,
      invocationMode: "draft" as const,
      maximumSkillTokens: 1_000,
      genreTags: [],
      availableContextLayers: ["current_task"] as const,
      allowExperimental: false,
      definitions: [automatic, explicit],
      bindings: [],
    };

    const compiled = await compileNovelSkills({ ...base, explicitSkillIds: [explicit.skillId] });
    expect(compiled.instructionRules.find(({ ruleId }) => ruleId === "shared.rule")?.text).toBe(
      "作者规则",
    );

    await expect(
      compileNovelSkills({
        ...base,
        explicitSkillIds: [automatic.skillId, explicit.skillId],
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_CONFLICT" });
  });

  it("rejects free text in replay configuration and all-null task overrides", () => {
    expect(() =>
      validateProjectNovelSkillBinding({
        ...projectBinding("core.scene_craft", "1.0.0", "smart"),
        taskOverrides: { continuation: { enabled: null, invocationMode: null } },
      }),
    ).toThrow(/all-null/u);

    expect(() =>
      validateNovelSkillConfigurationSnapshot({
        schemaVersion: 1,
        compilerVersion: "novel-skill-compiler@1",
        taskType: "continuation",
        invocationMode: "draft",
        maximumSkillTokens: 1_000,
        experimentalAllowed: false,
        genreTags: [],
        explicitSkillIds: [],
        availableContextLayers: ["current_task"],
        consideredDefinitions: [],
        bindings: [],
        prompt: "正文不应进入这里",
      } as never),
    ).toThrow(/missing or unsupported fields/u);
  });

  it("budgets the complete rendered method section with a conservative UTF-8 bound", async () => {
    const definition = await sealNovelSkillDefinition(
      draft({
        skillId: "custom.final_render_budget",
        kind: "custom",
        ownerScope: "user",
        ruleText: `逐句保持因果与视角边界。${"界".repeat(700)}`,
      }),
    );
    const base = {
      projectId: PROJECT_ID,
      taskType: "continuation" as const,
      invocationMode: "draft" as const,
      genreTags: [],
      explicitSkillIds: [definition.skillId],
      availableContextLayers: ["current_task"] as const,
      allowExperimental: false,
      definitions: [definition],
      bindings: [],
    };
    const measured = await compileNovelSkills({ ...base, maximumSkillTokens: 100_000 });

    expect(measured.usedSkillTokens).toBe(estimateNovelSkillPromptTokens(measured));
    expect(measured.usedSkillTokens).toBeGreaterThan(
      definition.instructions.rules[0]?.text.length ?? 0,
    );
    await expect(
      compileNovelSkills({
        ...base,
        maximumSkillTokens: measured.usedSkillTokens - 1,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_BUDGET_EXCEEDED" });
    const exact = await compileNovelSkills({
      ...base,
      maximumSkillTokens: measured.usedSkillTokens,
    });
    expect(estimateNovelSkillPromptTokens(exact)).toBeLessThanOrEqual(
      exact.configuration.maximumSkillTokens,
    );
  });

  it("records project-enabled skills omitted by the skill count and text budgets", async () => {
    const definitions = await Promise.all(
      Array.from(
        { length: MAX_NOVEL_SKILLS_PER_INVOCATION + 2 },
        async (_, index) =>
          await sealNovelSkillDefinition(
            draft({
              skillId: `custom.project_count_${String(index + 1)}`,
              kind: "custom",
              ownerScope: "user",
              precedence: 550 - index,
            }),
          ),
      ),
    );
    const bindings = definitions.map((definition) =>
      projectBinding(definition.skillId, definition.version, "manual"),
    );
    const base = {
      projectId: PROJECT_ID,
      taskType: "continuation" as const,
      invocationMode: "draft" as const,
      genreTags: [] as const,
      explicitSkillIds: definitions.map(({ skillId }) => skillId),
      availableContextLayers: ["current_task"] as const,
      allowExperimental: false,
      definitions,
      bindings,
    };
    const countLimited = await compileNovelSkills({
      ...base,
      maximumSkillTokens: 100_000,
    });
    expect(countLimited.selectedDefinitions).toHaveLength(MAX_NOVEL_SKILLS_PER_INVOCATION);
    expect(
      countLimited.items.filter(
        ({ included, discardedReason }) =>
          !included && discardedReason === "token_budget_exhausted",
      ),
    ).toHaveLength(2);

    const textLimited = await compileNovelSkills({
      ...base,
      maximumSkillTokens: 1,
    });
    expect(textLimited.selectedDefinitions).toHaveLength(0);
    expect(
      textLimited.items.every(
        ({ included, discardedReason }) =>
          !included && discardedReason === "token_budget_exhausted",
      ),
    ).toBe(true);
  });

  it("keeps ordinary explicit selections at six and reserves the wider fixed arm for built-ins", async () => {
    const definitions = await Promise.all(
      Array.from(
        { length: MAX_NOVEL_SKILLS_PER_INVOCATION + 2 },
        async (_, index) =>
          await sealNovelSkillDefinition(
            draft({
              skillId: `core.fixed_evaluation_${String(index + 1)}`,
              kind: "core",
              ownerScope: "builtin",
              precedence: 550 - index,
            }),
          ),
      ),
    );
    const base = {
      projectId: PROJECT_ID,
      taskType: "continuation" as const,
      invocationMode: "draft" as const,
      maximumSkillTokens: 100_000,
      genreTags: [] as const,
      explicitSkillIds: definitions.map(({ skillId }) => skillId),
      availableContextLayers: ["current_task"] as const,
      allowExperimental: true,
      definitions,
      bindings: [],
    };

    await expect(compileNovelSkills(base)).rejects.toMatchObject({
      code: "NOVEL_SKILL_BUDGET_EXCEEDED",
    });
    const fixed = await compileFixedNovelSkillEvaluationArm(base);
    expect(fixed.selectedDefinitions).toHaveLength(MAX_NOVEL_SKILLS_PER_INVOCATION + 2);
    expect(isFixedNovelSkillEvaluationConfiguration(fixed.configuration)).toBe(true);

    const userDefinition = await sealNovelSkillDefinition(
      draft({ skillId: "custom.not_a_fixed_arm", kind: "custom", ownerScope: "user" }),
    );
    await expect(
      compileFixedNovelSkillEvaluationArm({
        ...base,
        explicitSkillIds: [...base.explicitSkillIds, userDefinition.skillId],
        definitions: [...definitions, userDefinition],
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_INVALID" });
  });

  it("rejects non-boolean values and malformed containers at runtime", async () => {
    const definition = await sealNovelSkillDefinition(
      draft({ skillId: "custom.strict_runtime", kind: "custom", ownerScope: "user" }),
    );
    const validInput = {
      projectId: PROJECT_ID,
      taskType: "continuation" as const,
      invocationMode: "draft" as const,
      maximumSkillTokens: 1_000,
      genreTags: [],
      explicitSkillIds: [definition.skillId],
      availableContextLayers: ["current_task"] as const,
      allowExperimental: false,
      definitions: [definition],
      bindings: [],
    };

    await expect(
      compileNovelSkills({ ...validInput, allowExperimental: 1 } as never),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_INVALID" });
    await expect(
      compileNovelSkills({ ...validInput, definitions: {} } as never),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_INVALID" });
    expect(() =>
      validateProjectNovelSkillBinding({
        ...projectBinding(definition.skillId, definition.version, "smart"),
        enabled: "true",
      } as never),
    ).toThrow(expect.objectContaining({ code: "NOVEL_SKILL_BINDING_INVALID" }));
    expect(() =>
      validateProjectNovelSkillBinding({
        ...projectBinding(definition.skillId, definition.version, "smart"),
        taskOverrides: [],
      } as never),
    ).toThrow(expect.objectContaining({ code: "NOVEL_SKILL_BINDING_INVALID" }));

    const compiled = await compileNovelSkills(validInput);
    const item = compiled.items[0];
    expect(item).toBeDefined();
    expect(() => validateNovelSkillInvocationItem({ ...item, included: 1 } as never)).toThrow(
      expect.objectContaining({ code: "NOVEL_SKILL_CONFIGURATION_INVALID" }),
    );
    expect(() =>
      validateNovelSkillConfigurationSnapshot({
        ...compiled.configuration,
        experimentalAllowed: 0,
      } as never),
    ).toThrow(expect.objectContaining({ code: "NOVEL_SKILL_CONFIGURATION_INVALID" }));
  });

  it("orders semantic versions without losing integer precision", async () => {
    const lower = await sealNovelSkillDefinition({
      ...draft({ skillId: "core.bigint_version", defaultEnabled: true }),
      version: "9007199254740992.0.0",
    });
    const higher = await sealNovelSkillDefinition({
      ...draft({ skillId: "core.bigint_version", defaultEnabled: true }),
      version: "9007199254740993.0.0",
    });

    const compiled = await compileNovelSkills({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 2_000,
      genreTags: [],
      explicitSkillIds: [],
      availableContextLayers: ["current_task"],
      allowExperimental: false,
      definitions: [lower, higher],
      bindings: [],
    });

    expect(compiled.selectedDefinitions).toHaveLength(1);
    expect(compiled.selectedDefinitions[0]?.version).toBe("9007199254740993.0.0");
    expect(compiled.items[0]?.skillVersion).toBe("9007199254740993.0.0");
  });
});

describe("Novel Skill A/B gate", () => {
  it("uses original Chinese fixtures and stays NOT_EVALUATED without provider evidence", () => {
    const plan = createNovelSkillEvaluationPlan();
    const result = evaluateNovelSkillAbEvidence([], EVALUATION_MODEL_SLOTS);

    expect(plan.status).toBe("NOT_EVALUATED");
    expect(plan.fixtures).toHaveLength(12);
    expect(plan.fixtures.slice(0, NOVEL_SKILL_EVALUATION_FIXTURES.length)).toEqual(
      NOVEL_SKILL_EVALUATION_FIXTURES,
    );
    expect(plan.fixtures.every(({ origin }) => origin === "inkshadow_original")).toBe(true);
    expect(result).toMatchObject({
      status: "NOT_EVALUATED",
      defaultEnablement: "KEEP_DISABLED",
      observationCount: 0,
    });
    expect(result.missingCells).toHaveLength(12 * 4 * 2 * 2);
  });

  it("creates the complete two-tier, four-arm, repeated execution matrix without enabling a Skill", () => {
    const plan = createNovelSkillEvaluationExecutionPlan([
      { slotId: "text_tier_a", modelTier: "economy" },
      { slotId: "text_tier_b", modelTier: "quality" },
    ]);
    expect(plan.status).toBe("NOT_EVALUATED");
    expect(plan.minimumRepetitionsPerCell).toBeGreaterThanOrEqual(2);
    expect(plan.cells).toHaveLength(12 * 4 * 2 * 2);
    expect(
      new Set(
        plan.cells.map(
          ({ fixtureId, arm, modelSlotId, repetition }) =>
            `${fixtureId}/${arm}/${modelSlotId}/${String(repetition)}`,
        ),
      ),
    ).toHaveLength(plan.cells.length);
    expect(() =>
      createNovelSkillEvaluationExecutionPlan([
        { slotId: "text_tier_a", modelTier: "same" },
        { slotId: "text_tier_b", modelTier: "same" },
      ]),
    ).toThrow(/two distinct/u);
  });

  it("requires unique cell repetitions and unique provider invocation receipts", () => {
    const first = evaluationObservation({
      observationId: "observation-1",
      modelInvocationId: "invocation-1",
      repetition: 1,
    });

    expect(() =>
      evaluateNovelSkillAbEvidence(
        [
          first,
          evaluationObservation({
            observationId: "observation-2",
            modelInvocationId: "invocation-2",
            repetition: 1,
          }),
        ],
        EVALUATION_MODEL_SLOTS,
      ),
    ).toThrow(/not auditable/u);
    expect(() =>
      evaluateNovelSkillAbEvidence(
        [
          first,
          evaluationObservation({
            observationId: "observation-2",
            modelInvocationId: "invocation-1",
            repetition: 2,
          }),
        ],
        EVALUATION_MODEL_SLOTS,
      ),
    ).toThrow(/not auditable/u);
  });

  it.each(["instruction_following", "dialogue_distinction", "user_preference"] as const)(
    "rejects a missing %s A/B score",
    (metric) => {
      const observation = evaluationObservation({
        observationId: "observation-blocking-null",
        modelInvocationId: "invocation-blocking-null",
        repetition: 1,
      });

      expect(() =>
        evaluateNovelSkillAbEvidence(
          [
            {
              ...observation,
              scores: { ...observation.scores, [metric]: null },
            },
          ],
          EVALUATION_MODEL_SLOTS,
        ),
      ).toThrow(/requires all thirteen scores/u);
    },
  );

  it("requires all 192 exact cells and evaluates each model and incremental arm independently", () => {
    const complete = completeEvaluationObservations();
    expect(evaluateNovelSkillAbEvidence(complete, EVALUATION_MODEL_SLOTS)).toMatchObject({
      status: "ELIGIBLE_FOR_REVIEW",
      expectedCellCount: 192,
      completedCellCount: 192,
      regressions: [],
    });
    expect(
      evaluateNovelSkillAbEvidence(
        complete.filter(({ modelSlotId }) => modelSlotId === "text_tier_a"),
        EVALUATION_MODEL_SLOTS,
      ),
    ).toMatchObject({ status: "EVIDENCE_INCOMPLETE", completedCellCount: 96 });

    const oneModelRegression = complete.map((observation) =>
      observation.modelSlotId === "text_tier_b" && observation.arm === "core_genre"
        ? {
            ...observation,
            scores: { ...observation.scores, canon_preservation: 0.1 },
          }
        : observation,
    );
    const failed = evaluateNovelSkillAbEvidence(oneModelRegression, EVALUATION_MODEL_SLOTS);
    expect(failed.status).toBe("FAILED");
    expect(failed.regressions).toContain("text_tier_b:canon_preservation:core_genre_below_core");

    const equalScores = complete.map((observation) => ({
      ...observation,
      scores: evaluationScores(0.9),
    }));
    expect(evaluateNovelSkillAbEvidence(equalScores, EVALUATION_MODEL_SLOTS)).toMatchObject({
      status: "FAILED",
      regressions: expect.arrayContaining([
        "text_tier_a:improvement:core_no_demonstrated_improvement",
        "text_tier_b:improvement:core_no_demonstrated_improvement",
      ]),
    });

    const secondModelFlat = complete.map((observation) =>
      observation.modelSlotId === "text_tier_b"
        ? { ...observation, scores: evaluationScores(0.9) }
        : observation,
    );
    expect(evaluateNovelSkillAbEvidence(secondModelFlat, EVALUATION_MODEL_SLOTS)).toMatchObject({
      status: "FAILED",
      regressions: expect.arrayContaining([
        "text_tier_b:improvement:core_no_demonstrated_improvement",
      ]),
    });
  });

  it("blocks truncated/empty/failed receipts and conservative latency or cost regressions", () => {
    const first = completeEvaluationObservations()[0];
    expect(first).toBeDefined();
    for (const invalid of [
      { ...first, completionStatus: "failed" },
      { ...first, visibleContentLength: 0 },
      { ...first, finishReason: "length" },
      { ...first, finishReason: "max_tokens" },
      { ...first, finishReason: "max_output_tokens" },
    ]) {
      expect(() =>
        evaluateNovelSkillAbEvidence(
          [invalid as NovelSkillEvaluationObservation],
          EVALUATION_MODEL_SLOTS,
        ),
      ).toThrow(/not auditable/u);
    }

    const guarded = completeEvaluationObservations().map((observation) =>
      observation.modelSlotId === "text_tier_a" && observation.arm === "core"
        ? { ...observation, latencyMilliseconds: 6_000, estimatedCostMicros: 1_200 }
        : observation,
    );
    const result = evaluateNovelSkillAbEvidence(guarded, EVALUATION_MODEL_SLOTS);
    expect(result.status).toBe("FAILED");
    expect(result.regressions).toEqual(
      expect.arrayContaining([
        "text_tier_a:latency:core_above_no_skill",
        "text_tier_a:cost:core_above_no_skill",
      ]),
    );

    const missingCost = completeEvaluationObservations().map((observation, index) =>
      index === 0 ? { ...observation, estimatedCostMicros: null } : observation,
    );
    const missingCostResult = evaluateNovelSkillAbEvidence(missingCost, EVALUATION_MODEL_SLOTS);
    expect(missingCostResult.status).toBe("FAILED");
    expect(missingCostResult.regressions).toContain("text_tier_a:cost:core_evidence_missing");
  });
});

function completeEvaluationObservations(): readonly NovelSkillEvaluationObservation[] {
  return createNovelSkillEvaluationExecutionPlan(EVALUATION_MODEL_SLOTS).cells.map(
    (cell, index) => ({
      observationId: `observation-${String(index + 1)}`,
      fixtureId: cell.fixtureId,
      arm: cell.arm,
      modelSlotId: cell.modelSlotId,
      modelTier: cell.modelTier,
      repetition: cell.repetition,
      modelInvocationId: `invocation-${String(index + 1)}`,
      evaluatorVersion: "novel-skill-ab@1",
      completionStatus: "succeeded",
      visibleContentLength: 128,
      finishReason: "stop",
      methodApplicability: {
        core: cell.arm !== "no_skill",
        genre: cell.arm === "core_genre" || cell.arm === "core_genre_preferences",
      },
      scores: evaluationScores(
        cell.arm === "no_skill"
          ? 0.7
          : cell.arm === "core"
            ? 0.73
            : cell.arm === "core_genre"
              ? 0.76
              : 0.79,
      ),
      latencyMilliseconds: 100,
      inputTokens: 100,
      outputTokens: 100,
      estimatedCostMicros: 100,
    }),
  );
}

function evaluationObservation(overrides: {
  readonly observationId: string;
  readonly modelInvocationId: string;
  readonly repetition: number;
}): NovelSkillEvaluationObservation {
  return {
    observationId: overrides.observationId,
    fixtureId: NOVEL_SKILL_EVALUATION_FIXTURES[0]?.fixtureId ?? "missing-fixture",
    arm: "core",
    modelSlotId: "text_tier_b",
    modelTier: "quality",
    repetition: overrides.repetition,
    modelInvocationId: overrides.modelInvocationId,
    evaluatorVersion: "novel-skill-ab@1",
    completionStatus: "succeeded",
    visibleContentLength: 128,
    finishReason: "stop",
    methodApplicability: { core: true, genre: false },
    scores: evaluationScores(1),
    latencyMilliseconds: 100,
    inputTokens: 100,
    outputTokens: 100,
    estimatedCostMicros: 100,
  };
}

function evaluationScores(score: number): NovelSkillEvaluationObservation["scores"] {
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

function projectBinding(
  skillId: string,
  pinnedVersion: string,
  activationMode: ProjectNovelSkillBinding["activationMode"],
): ProjectNovelSkillBinding {
  return {
    projectId: PROJECT_ID,
    skillId,
    pinnedVersion,
    enabled: true,
    activationMode,
    taskOverrides: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function draft(overrides: {
  readonly skillId: string;
  readonly kind?: NovelSkillDefinitionDraft["kind"];
  readonly ownerScope?: NovelSkillDefinitionDraft["ownerScope"];
  readonly precedence?: number;
  readonly defaultEnabled?: boolean;
  readonly exclusiveGroup?: string | null;
  readonly ruleId?: string;
  readonly ruleText?: string;
}): NovelSkillDefinitionDraft {
  return {
    skillId: overrides.skillId,
    version: "1.0.0",
    displayName: overrides.skillId,
    summary: "用于编译器测试的原创方法。",
    kind: overrides.kind ?? "core",
    ownerScope: overrides.ownerScope ?? "builtin",
    status: "active",
    defaultEnabled: overrides.defaultEnabled ?? false,
    precedence: overrides.precedence ?? 500,
    taskTypes: ["continuation"],
    activation: {
      allowedModes: ["draft"],
      genreTags: [],
      exclusiveGroup: overrides.exclusiveGroup ?? null,
    },
    contextRequirements: { requiredLayers: ["current_task"], optionalLayers: [] },
    instructions: {
      rules: [
        {
          ruleId: overrides.ruleId ?? `${overrides.skillId}.rule`,
          text: overrides.ruleText ?? "执行测试方法。",
        },
      ],
    },
    outputContract: { kind: "prose", rules: [] },
    validation: {
      rules: [
        { ruleId: `${overrides.skillId}.check`, text: "检查测试方法。", evidenceRequired: false },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: NOW,
  };
}
