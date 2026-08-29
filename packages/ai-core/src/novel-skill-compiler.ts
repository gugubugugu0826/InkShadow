import {
  NovelSkillError,
  NOVEL_SKILL_CONTEXT_LAYERS,
  NOVEL_SKILL_INVOCATION_MODES,
  NOVEL_SKILL_TASKS,
  canonicalNovelSkillConfiguration,
  hashNovelSkillConfiguration,
  validateProjectNovelSkillBinding,
  verifyNovelSkillDefinition,
  type NovelSkillActivationSource,
  type NovelSkillConfigurationSnapshot,
  type NovelSkillContextLayer,
  type NovelSkillDefinition,
  type NovelSkillInvocationItem,
  type NovelSkillInvocationMode,
  type NovelSkillRule,
  type NovelSkillTask,
  type NovelSkillValidationRule,
  type ProjectNovelSkillBinding,
} from "./novel-skill.js";

export const NOVEL_SKILL_COMPILER_VERSION = "novel-skill-compiler@1";
export const MAX_NOVEL_SKILLS_PER_INVOCATION = 6;

export interface CompileNovelSkillsInput {
  readonly projectId: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly maximumSkillTokens: number;
  readonly genreTags: readonly string[];
  readonly explicitSkillIds: readonly string[];
  readonly availableContextLayers: readonly NovelSkillContextLayer[];
  readonly allowExperimental: boolean;
  readonly definitions: readonly NovelSkillDefinition[];
  readonly bindings: readonly ProjectNovelSkillBinding[];
}

export interface CompiledNovelSkillRule extends NovelSkillRule {
  readonly sourceSkillId: string;
  readonly sourceSkillVersion: string;
  readonly precedence: number;
}

export interface CompiledNovelSkillValidationRule extends NovelSkillValidationRule {
  readonly sourceSkillId: string;
  readonly sourceSkillVersion: string;
  readonly precedence: number;
}

export interface CompiledNovelSkills {
  readonly compilerVersion: typeof NOVEL_SKILL_COMPILER_VERSION;
  readonly configuration: NovelSkillConfigurationSnapshot;
  readonly selectionHash: string;
  readonly items: readonly NovelSkillInvocationItem[];
  readonly selectedDefinitions: readonly NovelSkillDefinition[];
  readonly usedSkillTokens: number;
  readonly discardedSkillTokens: number;
  readonly instructionRules: readonly CompiledNovelSkillRule[];
  readonly outputKinds: readonly NovelSkillDefinition["outputContract"]["kind"][];
  readonly outputRules: readonly CompiledNovelSkillRule[];
  readonly validationRules: readonly CompiledNovelSkillValidationRule[];
}

interface MutableDecision {
  readonly definition: NovelSkillDefinition;
  readonly binding: ProjectNovelSkillBinding | null;
  readonly explicit: boolean;
  readonly activationSource: NovelSkillActivationSource;
  readonly effectiveMode: NovelSkillInvocationMode;
  readonly estimatedTokens: number;
  reason: NovelSkillInvocationItem["selectionReason"];
  included: boolean;
}

interface RuleOwner {
  readonly explicit: boolean;
  readonly precedence: number;
}

export async function compileNovelSkills(
  input: CompileNovelSkillsInput,
): Promise<CompiledNovelSkills> {
  return compileNovelSkillsWithScope(input, false);
}

export async function compileFixedNovelSkillEvaluationArm(
  input: CompileNovelSkillsInput,
): Promise<CompiledNovelSkills> {
  return compileNovelSkillsWithScope(input, true);
}

async function compileNovelSkillsWithScope(
  input: CompileNovelSkillsInput,
  fixedEvaluationArm: boolean,
): Promise<CompiledNovelSkills> {
  requireCompileBounds(input);
  const definitions = await resolveDefinitions(input.definitions, input.bindings);
  const bindings = validateBindings(input.bindings, input.projectId, definitions);
  const explicitIds = new Set(input.explicitSkillIds);
  for (const skillId of explicitIds) {
    if (!definitions.some((definition) => definition.skillId === skillId)) {
      throw new NovelSkillError(
        "NOVEL_SKILL_INVALID",
        `Explicit novel skill '${skillId}' is not available in the supplied registry.`,
      );
    }
  }
  if (fixedEvaluationArm) {
    requireFixedEvaluationArm(input, definitions, bindings);
  }

  const availableLayers = new Set(input.availableContextLayers);
  const genreTags = new Set(input.genreTags);
  const decisions = definitions.map((definition) => {
    const binding = bindings.get(definition.skillId) ?? null;
    return initialDecision(
      definition,
      binding,
      explicitIds.has(definition.skillId),
      input,
      availableLayers,
      genreTags,
      fixedEvaluationArm,
    );
  });

  resolveExclusiveGroups(decisions);
  applySkillCountBudget(decisions, fixedEvaluationArm ? 64 : MAX_NOVEL_SKILLS_PER_INVOCATION);
  applySkillBudget(decisions, input.maximumSkillTokens, input.invocationMode);

  const selectedDecisions = decisions.filter(({ included }) => included);
  const selectedDefinitions = selectedDecisions.map(({ definition }) => definition);
  const instructionRules = mergeRules(selectedDecisions, "instructions");
  const outputRules = mergeRules(selectedDecisions, "outputContract");
  const validationRules = mergeValidationRules(selectedDecisions);
  const items = decisions.map(toInvocationItem);
  const discardedSkillTokens = items
    .filter(({ included }) => !included)
    .reduce((total, { estimatedTokens }) => total + estimatedTokens, 0);
  const configuration = buildConfiguration(input, definitions, bindings);
  const selectionHash = await hashNovelSkillConfiguration(configuration);
  const usedSkillTokens = estimateRenderedPromptTokens(
    input.invocationMode,
    selectionHash,
    instructionRules,
    outputRules,
    validationRules,
  );
  if (usedSkillTokens > input.maximumSkillTokens) {
    throw new NovelSkillError(
      "NOVEL_SKILL_BUDGET_EXCEEDED",
      "The final rendered novel method section exceeds its reserved skill budget.",
    );
  }

  return Object.freeze({
    compilerVersion: NOVEL_SKILL_COMPILER_VERSION,
    configuration,
    selectionHash,
    items: Object.freeze(items),
    selectedDefinitions: Object.freeze(selectedDefinitions),
    usedSkillTokens,
    discardedSkillTokens,
    instructionRules: Object.freeze(instructionRules),
    outputKinds: Object.freeze([
      ...new Set(selectedDefinitions.map(({ outputContract }) => outputContract.kind)),
    ]),
    outputRules: Object.freeze(outputRules),
    validationRules: Object.freeze(validationRules),
  });
}

export function renderNovelSkillPromptSection(compiled: CompiledNovelSkills): string | null {
  if (compiled.selectedDefinitions.length === 0) {
    return null;
  }
  return renderNovelSkillPromptSectionParts(
    compiled.configuration.invocationMode,
    compiled.selectionHash,
    compiled.instructionRules,
    compiled.outputRules,
    compiled.validationRules,
  );
}

/** Conservative upper bound: a byte-level tokenizer cannot emit more tokens than UTF-8 bytes. */
export function estimateNovelSkillPromptTokens(compiled: CompiledNovelSkills): number {
  const rendered = renderNovelSkillPromptSection(compiled);
  return rendered === null ? 0 : conservativeTokenUpperBound(rendered);
}

function renderNovelSkillPromptSectionParts(
  invocationMode: NovelSkillInvocationMode,
  selectionHash: string,
  instructionRules: readonly CompiledNovelSkillRule[],
  outputRules: readonly CompiledNovelSkillRule[],
  validationRules: readonly CompiledNovelSkillValidationRule[],
): string {
  const lines = [
    "<novel_method>",
    `mode: ${invocationMode}`,
    `selection: ${selectionHash}`,
    "method_rules:",
    ...instructionRules.map(
      ({ ruleId, text, sourceSkillId }) => `- [${sourceSkillId}/${ruleId}] ${text}`,
    ),
  ];
  if (outputRules.length > 0) {
    lines.push(
      "output_contract:",
      ...outputRules.map(
        ({ ruleId, text, sourceSkillId }) => `- [${sourceSkillId}/${ruleId}] ${text}`,
      ),
    );
  }
  lines.push(
    "validation:",
    ...validationRules.map(
      ({ ruleId, text, sourceSkillId, evidenceRequired }) =>
        `- [${sourceSkillId}/${ruleId}] ${text}; evidence_required=${evidenceRequired ? "yes" : "no"}`,
    ),
    "</novel_method>",
  );
  return lines.join("\n");
}

function initialDecision(
  definition: NovelSkillDefinition,
  binding: ProjectNovelSkillBinding | null,
  explicit: boolean,
  input: CompileNovelSkillsInput,
  availableLayers: ReadonlySet<NovelSkillContextLayer>,
  genreTags: ReadonlySet<string>,
  fixedEvaluationArm: boolean,
): MutableDecision {
  const taskOverride = binding?.taskOverrides[input.taskType];
  const enabled = taskOverride?.enabled ?? binding?.enabled ?? definition.defaultEnabled;
  const effectiveMode = taskOverride?.invocationMode ?? input.invocationMode;
  const activationSource = resolveActivationSource(definition, binding, explicit);
  const estimatedTokens = estimateNovelSkillTokens(definition, input.invocationMode);
  if (estimatedTokens > 100_000) {
    throw new NovelSkillError(
      "NOVEL_SKILL_INVALID",
      `Novel skill '${definition.skillId}' cannot fit in the bounded invocation item contract.`,
    );
  }
  let reason: NovelSkillInvocationItem["selectionReason"] = "selected";

  if (
    definition.status !== "active" &&
    !(definition.status === "experimental" && input.allowExperimental)
  ) {
    reason = "status_blocked";
  } else if (!definition.taskTypes.includes(input.taskType)) {
    reason = "task_mismatch";
  } else if (!enabled && !explicit) {
    reason = "not_enabled";
  } else if (binding?.activationMode === "manual" && !explicit && taskOverride?.enabled !== true) {
    reason = "manual_not_requested";
  } else if (!definition.activation.allowedModes.includes(effectiveMode)) {
    reason = "mode_mismatch";
  } else if (
    definition.activation.genreTags.length > 0 &&
    !definition.activation.genreTags.some((tag) => genreTags.has(tag))
  ) {
    reason = "genre_mismatch";
  } else if (
    definition.contextRequirements.requiredLayers.some((layer) => !availableLayers.has(layer))
  ) {
    if (explicit && binding === null && !fixedEvaluationArm) {
      throw new NovelSkillError(
        "NOVEL_SKILL_REQUIRED_CONTEXT_MISSING",
        `Explicit novel skill '${definition.skillId}' is missing required context.`,
      );
    }
    reason = "missing_context";
  }

  return {
    definition,
    binding,
    explicit,
    activationSource,
    effectiveMode,
    estimatedTokens,
    reason,
    included: reason === "selected",
  };
}

function resolveExclusiveGroups(decisions: readonly MutableDecision[]): void {
  const groups = new Map<string, MutableDecision[]>();
  for (const decision of decisions) {
    const group = decision.definition.activation.exclusiveGroup;
    if (!decision.included || group === null) {
      continue;
    }
    const entries = groups.get(group) ?? [];
    entries.push(decision);
    groups.set(group, entries);
  }
  for (const entries of groups.values()) {
    if (entries.length < 2) {
      continue;
    }
    const ordered = [...entries].sort(compareDecisions);
    const winner = ordered[0];
    if (winner === undefined) {
      continue;
    }
    const runnerUp = ordered[1];
    if (runnerUp === undefined) {
      continue;
    }
    const bothProjectBound =
      winner.explicit && runnerUp.explicit && winner.binding !== null && runnerUp.binding !== null;
    if (winner.explicit && runnerUp.explicit && !bothProjectBound) {
      throw new NovelSkillError(
        "NOVEL_SKILL_CONFLICT",
        "Explicit novel skills conflict in the same exclusive group.",
      );
    }
    if (winner.definition.precedence === runnerUp.definition.precedence && !bothProjectBound) {
      throw new NovelSkillError(
        "NOVEL_SKILL_CONFLICT",
        "Novel skill exclusive group has an unresolved equal-precedence conflict.",
      );
    }
    for (const discarded of ordered.slice(1)) {
      discarded.included = false;
      discarded.reason = "conflict";
    }
  }
}

function applySkillCountBudget(decisions: readonly MutableDecision[], maximum: number): void {
  const eligible = decisions.filter(({ included }) => included).sort(compareDecisions);
  if (eligible.slice(maximum).some(({ explicit, binding }) => explicit && binding === null)) {
    throw new NovelSkillError(
      "NOVEL_SKILL_BUDGET_EXCEEDED",
      `At most ${String(maximum)} ad-hoc explicit novel skills may be used in one invocation.`,
    );
  }
  for (const decision of eligible.slice(maximum)) {
    decision.included = false;
    decision.reason = "token_budget_exhausted";
  }
}

function applySkillBudget(
  decisions: readonly MutableDecision[],
  maximumSkillTokens: number,
  invocationMode: NovelSkillInvocationMode,
): void {
  const eligible = decisions.filter(({ included }) => included).sort(compareDecisions);
  for (const decision of eligible) {
    decision.included = false;
  }
  for (const decision of eligible) {
    decision.included = true;
    const selected = decisions.filter(({ included }) => included);
    const renderedTokens = estimateRenderedDecisionTokens(selected, invocationMode);
    if (renderedTokens <= maximumSkillTokens) {
      continue;
    }
    decision.included = false;
    if (decision.explicit && decision.binding === null) {
      throw new NovelSkillError(
        "NOVEL_SKILL_BUDGET_EXCEEDED",
        `Explicit novel skill '${decision.definition.skillId}' exceeds the reserved skill budget.`,
      );
    }
    decision.reason = "token_budget_exhausted";
  }
}

function mergeRules(
  decisions: readonly MutableDecision[],
  source: "instructions" | "outputContract",
): CompiledNovelSkillRule[] {
  const resolved = new Map<string, CompiledNovelSkillRule>();
  const owners = new Map<string, RuleOwner>();
  for (const decision of [...decisions].sort(compareDecisions)) {
    const { definition } = decision;
    const rules = definition[source].rules;
    for (const rule of rules) {
      const candidate: CompiledNovelSkillRule = {
        ...rule,
        sourceSkillId: definition.skillId,
        sourceSkillVersion: definition.version,
        precedence: definition.precedence,
      };
      const current = resolved.get(rule.ruleId);
      const currentOwner = owners.get(rule.ruleId);
      if (current === undefined || candidate.text === current.text) {
        resolved.set(rule.ruleId, current ?? candidate);
        owners.set(rule.ruleId, currentOwner ?? ownerOf(decision));
      } else if (decision.explicit && currentOwner?.explicit === true) {
        throw new NovelSkillError(
          "NOVEL_SKILL_CONFLICT",
          `Explicit novel skills disagree on rule '${rule.ruleId}'.`,
        );
      } else if (decision.explicit && currentOwner?.explicit !== true) {
        resolved.set(rule.ruleId, candidate);
        owners.set(rule.ruleId, ownerOf(decision));
      } else if (currentOwner?.explicit === true) {
        continue;
      } else if (candidate.precedence > current.precedence) {
        resolved.set(rule.ruleId, candidate);
        owners.set(rule.ruleId, ownerOf(decision));
      } else if (candidate.precedence === current.precedence) {
        throw new NovelSkillError(
          "NOVEL_SKILL_CONFLICT",
          `Novel skill rule '${rule.ruleId}' has an unresolved equal-precedence conflict.`,
        );
      }
    }
  }
  return [...resolved.values()].sort(compareCompiledRules);
}

function mergeValidationRules(
  decisions: readonly MutableDecision[],
): CompiledNovelSkillValidationRule[] {
  const resolved = new Map<string, CompiledNovelSkillValidationRule>();
  const owners = new Map<string, RuleOwner>();
  for (const decision of [...decisions].sort(compareDecisions)) {
    const { definition } = decision;
    for (const rule of definition.validation.rules) {
      const candidate: CompiledNovelSkillValidationRule = {
        ...rule,
        sourceSkillId: definition.skillId,
        sourceSkillVersion: definition.version,
        precedence: definition.precedence,
      };
      const current = resolved.get(rule.ruleId);
      const currentOwner = owners.get(rule.ruleId);
      if (
        current === undefined ||
        (candidate.text === current.text && candidate.evidenceRequired === current.evidenceRequired)
      ) {
        resolved.set(rule.ruleId, current ?? candidate);
        owners.set(rule.ruleId, currentOwner ?? ownerOf(decision));
      } else if (decision.explicit && currentOwner?.explicit === true) {
        throw new NovelSkillError(
          "NOVEL_SKILL_CONFLICT",
          `Explicit novel skills disagree on validation '${rule.ruleId}'.`,
        );
      } else if (decision.explicit && currentOwner?.explicit !== true) {
        resolved.set(rule.ruleId, candidate);
        owners.set(rule.ruleId, ownerOf(decision));
      } else if (currentOwner?.explicit === true) {
        continue;
      } else if (candidate.precedence > current.precedence) {
        resolved.set(rule.ruleId, candidate);
        owners.set(rule.ruleId, ownerOf(decision));
      } else if (candidate.precedence === current.precedence) {
        throw new NovelSkillError(
          "NOVEL_SKILL_CONFLICT",
          `Novel skill validation '${rule.ruleId}' has an unresolved equal-precedence conflict.`,
        );
      }
    }
  }
  return [...resolved.values()].sort(compareCompiledRules);
}

async function resolveDefinitions(
  values: readonly NovelSkillDefinition[],
  bindingValues: readonly ProjectNovelSkillBinding[],
): Promise<NovelSkillDefinition[]> {
  if (values.length > 64) {
    throw new NovelSkillError(
      "NOVEL_SKILL_INVALID",
      "A compile may consider at most 64 skill definitions.",
    );
  }
  const byKey = new Map<string, NovelSkillDefinition>();
  const bySkill = new Map<string, NovelSkillDefinition[]>();
  for (const value of values) {
    const definition = await verifyNovelSkillDefinition(value);
    const key = `${definition.skillId}@${definition.version}`;
    if (byKey.has(key)) {
      throw new NovelSkillError(
        "NOVEL_SKILL_INVALID",
        "Novel skill definition references must be unique.",
      );
    }
    byKey.set(key, definition);
    const versions = bySkill.get(definition.skillId) ?? [];
    versions.push(definition);
    bySkill.set(definition.skillId, versions);
  }
  const bindings = new Map(bindingValues.map((binding) => [binding.skillId, binding]));
  const resolved: NovelSkillDefinition[] = [];
  for (const [skillId, versions] of bySkill) {
    const pinned = bindings.get(skillId)?.pinnedVersion;
    const definition =
      pinned === undefined
        ? [...versions].sort((left, right) => compareVersions(right.version, left.version))[0]
        : versions.find(({ version }) => version === pinned);
    if (definition === undefined) {
      throw new NovelSkillError(
        "NOVEL_SKILL_BINDING_INVALID",
        `Binding for '${skillId}' references an unavailable immutable definition version.`,
      );
    }
    resolved.push(definition);
  }
  return resolved.sort((left, right) => left.skillId.localeCompare(right.skillId, "en"));
}

function validateBindings(
  values: readonly ProjectNovelSkillBinding[],
  projectId: string,
  definitions: readonly NovelSkillDefinition[],
): ReadonlyMap<string, ProjectNovelSkillBinding> {
  if (values.length > 64) {
    throw new NovelSkillError(
      "NOVEL_SKILL_BINDING_INVALID",
      "A project may compile at most 64 bindings.",
    );
  }
  const definitionsByKey = new Set(
    definitions.map(({ skillId, version }) => `${skillId}@${version}`),
  );
  const bindings = new Map<string, ProjectNovelSkillBinding>();
  for (const value of values) {
    const binding = validateProjectNovelSkillBinding(value);
    if (binding.projectId !== projectId || bindings.has(binding.skillId)) {
      throw new NovelSkillError(
        "NOVEL_SKILL_BINDING_INVALID",
        "Novel skill bindings must be unique and belong to the compiled project.",
      );
    }
    if (!definitionsByKey.has(`${binding.skillId}@${binding.pinnedVersion}`)) {
      throw new NovelSkillError(
        "NOVEL_SKILL_BINDING_INVALID",
        "Novel skill binding does not match the resolved immutable definition.",
      );
    }
    bindings.set(binding.skillId, binding);
  }
  return bindings;
}

function buildConfiguration(
  input: CompileNovelSkillsInput,
  definitions: readonly NovelSkillDefinition[],
  bindings: ReadonlyMap<string, ProjectNovelSkillBinding>,
): NovelSkillConfigurationSnapshot {
  const configuration: NovelSkillConfigurationSnapshot = {
    schemaVersion: 1,
    compilerVersion: NOVEL_SKILL_COMPILER_VERSION,
    taskType: input.taskType,
    invocationMode: input.invocationMode,
    maximumSkillTokens: input.maximumSkillTokens,
    experimentalAllowed: input.allowExperimental,
    genreTags: Object.freeze([...input.genreTags].sort()),
    explicitSkillIds: Object.freeze([...input.explicitSkillIds].sort()),
    availableContextLayers: Object.freeze(
      NOVEL_SKILL_CONTEXT_LAYERS.filter((layer) => input.availableContextLayers.includes(layer)),
    ),
    consideredDefinitions: Object.freeze(
      definitions.map(({ skillId, version, definitionHash, kind, status }) => ({
        skillId,
        version,
        definitionHash,
        kind,
        status,
      })),
    ),
    bindings: Object.freeze(
      [...bindings.values()]
        .sort((left, right) => left.skillId.localeCompare(right.skillId, "en"))
        .map((binding) => {
          const taskOverride = binding.taskOverrides[input.taskType];
          return {
            skillId: binding.skillId,
            version: binding.pinnedVersion,
            enabled: binding.enabled,
            activationMode: binding.activationMode,
            taskEnabled: taskOverride?.enabled ?? null,
            taskInvocationMode: taskOverride?.invocationMode ?? null,
            revision: binding.revision,
          };
        }),
    ),
  };
  canonicalNovelSkillConfiguration(configuration);
  return Object.freeze(configuration);
}

export function isFixedNovelSkillEvaluationConfiguration(
  configuration: NovelSkillConfigurationSnapshot,
): boolean {
  const explicit = new Set(configuration.explicitSkillIds);
  return (
    configuration.experimentalAllowed &&
    configuration.bindings.length === 0 &&
    configuration.consideredDefinitions.length > 0 &&
    explicit.size === configuration.consideredDefinitions.length &&
    configuration.consideredDefinitions.every(
      ({ skillId, kind }) => kind !== "custom" && explicit.has(skillId),
    )
  );
}

function requireFixedEvaluationArm(
  input: CompileNovelSkillsInput,
  definitions: readonly NovelSkillDefinition[],
  bindings: ReadonlyMap<string, ProjectNovelSkillBinding>,
): void {
  const explicit = new Set(input.explicitSkillIds);
  if (
    !input.allowExperimental ||
    bindings.size !== 0 ||
    definitions.length === 0 ||
    explicit.size !== definitions.length ||
    definitions.some(
      ({ skillId, ownerScope, kind }) =>
        ownerScope !== "builtin" || kind === "custom" || !explicit.has(skillId),
    )
  ) {
    throw new NovelSkillError(
      "NOVEL_SKILL_INVALID",
      "Fixed evaluation arms must contain only the complete immutable built-in definition set.",
    );
  }
}

function toInvocationItem(decision: MutableDecision): NovelSkillInvocationItem {
  return Object.freeze({
    skillId: decision.definition.skillId,
    skillVersion: decision.definition.version,
    definitionHash: decision.definition.definitionHash,
    activationSource: decision.activationSource,
    selectionReason: decision.reason,
    precedence: decision.definition.precedence,
    included: decision.included,
    discardedReason: decision.included
      ? null
      : (decision.reason as Exclude<NovelSkillInvocationItem["selectionReason"], "selected">),
    estimatedTokens: decision.estimatedTokens,
  });
}

function resolveActivationSource(
  definition: NovelSkillDefinition,
  binding: ProjectNovelSkillBinding | null,
  explicit: boolean,
): NovelSkillActivationSource {
  if (explicit) {
    return "explicit";
  }
  if (binding !== null) {
    if (binding.activationMode === "manual") {
      return "project_binding";
    }
    return definition.kind === "genre" ? "smart_genre" : "smart_core";
  }
  return definition.defaultEnabled ? "default" : "registry";
}

function estimateNovelSkillTokens(
  definition: NovelSkillDefinition,
  invocationMode: NovelSkillInvocationMode,
): number {
  const instructionRules = definition.instructions.rules.map((rule) => ({
    ...rule,
    sourceSkillId: definition.skillId,
    sourceSkillVersion: definition.version,
    precedence: definition.precedence,
  }));
  const outputRules = definition.outputContract.rules.map((rule) => ({
    ...rule,
    sourceSkillId: definition.skillId,
    sourceSkillVersion: definition.version,
    precedence: definition.precedence,
  }));
  const validationRules = definition.validation.rules.map((rule) => ({
    ...rule,
    sourceSkillId: definition.skillId,
    sourceSkillVersion: definition.version,
    precedence: definition.precedence,
  }));
  return estimateRenderedPromptTokens(
    invocationMode,
    "0".repeat(64),
    instructionRules,
    outputRules,
    validationRules,
  );
}

function estimateRenderedDecisionTokens(
  decisions: readonly MutableDecision[],
  invocationMode: NovelSkillInvocationMode,
): number {
  if (decisions.length === 0) {
    return 0;
  }
  return estimateRenderedPromptTokens(
    invocationMode,
    "0".repeat(64),
    mergeRules(decisions, "instructions"),
    mergeRules(decisions, "outputContract"),
    mergeValidationRules(decisions),
  );
}

function estimateRenderedPromptTokens(
  invocationMode: NovelSkillInvocationMode,
  selectionHash: string,
  instructionRules: readonly CompiledNovelSkillRule[],
  outputRules: readonly CompiledNovelSkillRule[],
  validationRules: readonly CompiledNovelSkillValidationRule[],
): number {
  if (instructionRules.length === 0 && outputRules.length === 0 && validationRules.length === 0) {
    return 0;
  }
  return conservativeTokenUpperBound(
    renderNovelSkillPromptSectionParts(
      invocationMode,
      selectionHash,
      instructionRules,
      outputRules,
      validationRules,
    ),
  );
}

function conservativeTokenUpperBound(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requireCompileBounds(value: unknown): asserts value is CompileNovelSkillsInput {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ) {
    throw new NovelSkillError(
      "NOVEL_SKILL_INVALID",
      "Novel skill compile input must be an object.",
    );
  }
  const input = value as Record<string, unknown>;
  const genreTagsValue = input.genreTags;
  const explicitSkillIdsValue = input.explicitSkillIds;
  const availableContextLayersValue = input.availableContextLayers;
  const genreTags = Array.isArray(genreTagsValue) ? (genreTagsValue as readonly unknown[]) : null;
  const explicitSkillIds = Array.isArray(explicitSkillIdsValue)
    ? (explicitSkillIdsValue as readonly unknown[])
    : null;
  const availableContextLayers = Array.isArray(availableContextLayersValue)
    ? (availableContextLayersValue as readonly unknown[])
    : null;
  if (
    typeof input.projectId !== "string" ||
    typeof input.taskType !== "string" ||
    !NOVEL_SKILL_TASKS.includes(input.taskType as NovelSkillTask) ||
    typeof input.invocationMode !== "string" ||
    !NOVEL_SKILL_INVOCATION_MODES.includes(input.invocationMode as NovelSkillInvocationMode) ||
    typeof input.allowExperimental !== "boolean" ||
    genreTags === null ||
    explicitSkillIds === null ||
    availableContextLayers === null ||
    !Array.isArray(input.definitions) ||
    !Array.isArray(input.bindings) ||
    typeof input.maximumSkillTokens !== "number" ||
    !Number.isSafeInteger(input.maximumSkillTokens) ||
    input.maximumSkillTokens < 0 ||
    input.maximumSkillTokens > 100_000 ||
    genreTags.length > 16 ||
    explicitSkillIds.length > 32 ||
    new Set(genreTags).size !== genreTags.length ||
    new Set(explicitSkillIds).size !== explicitSkillIds.length ||
    new Set(availableContextLayers).size !== availableContextLayers.length ||
    genreTags.some(
      (value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(value),
    ) ||
    explicitSkillIds.some(
      (value) =>
        typeof value !== "string" || !/^(?=.{3,96}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/u.test(value),
    ) ||
    availableContextLayers.some(
      (layer) =>
        typeof layer !== "string" ||
        !NOVEL_SKILL_CONTEXT_LAYERS.includes(layer as NovelSkillContextLayer),
    )
  ) {
    throw new NovelSkillError(
      "NOVEL_SKILL_INVALID",
      "Novel skill compile input is not bounded or unique.",
    );
  }
}

function compareDecisions(left: MutableDecision, right: MutableDecision): number {
  if (left.explicit !== right.explicit) {
    return left.explicit ? -1 : 1;
  }
  if (left.definition.precedence !== right.definition.precedence) {
    return right.definition.precedence - left.definition.precedence;
  }
  return left.definition.skillId.localeCompare(right.definition.skillId, "en");
}

function ownerOf(decision: MutableDecision): RuleOwner {
  return { explicit: decision.explicit, precedence: decision.definition.precedence };
}

function compareCompiledRules(
  left: CompiledNovelSkillRule | CompiledNovelSkillValidationRule,
  right: CompiledNovelSkillRule | CompiledNovelSkillValidationRule,
): number {
  return right.precedence - left.precedence || left.ruleId.localeCompare(right.ruleId, "en");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }
  return 0;
}
