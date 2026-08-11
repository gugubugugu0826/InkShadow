export const NOVEL_SKILL_TASKS = [
  "idea_discussion",
  "book_start_guidance",
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "outline_planning",
  "scene_breakdown",
  "chapter_summary",
  "long_memory_compression",
  "character_extraction",
  "world_extraction",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
  "what_if_simulation",
  "embedding",
  "rerank",
  "image_generation",
  "vision_understanding",
  "translation",
] as const;

export const NOVEL_SKILL_INVOCATION_MODES = [
  "coach",
  "collaborator",
  "draft",
  "critic",
  "revision",
  "explorer",
] as const;

export const NOVEL_SKILL_CONTEXT_LAYERS = [
  "locked_hard_rules",
  "current_task",
  "scene_goal",
  "pov_known_information",
  "character_current_state",
  "recent_events",
  "related_causal_chain",
  "unresolved_foreshadowing",
  "world_setting",
  "character_voice_samples",
  "semantic_retrieval",
  "rerank_supplement",
] as const;

export const NOVEL_SKILL_STATUSES = [
  "draft",
  "active",
  "disabled",
  "deprecated",
  "experimental",
] as const;

export type NovelSkillTask = (typeof NOVEL_SKILL_TASKS)[number];
export type NovelSkillInvocationMode = (typeof NOVEL_SKILL_INVOCATION_MODES)[number];
export type NovelSkillContextLayer = (typeof NOVEL_SKILL_CONTEXT_LAYERS)[number];
export type NovelSkillStatus = (typeof NOVEL_SKILL_STATUSES)[number];
export type NovelSkillKind = "core" | "genre" | "custom";
export type NovelSkillOwnerScope = "builtin" | "user";
export type NovelSkillBindingActivationMode = "smart" | "manual";

export interface NovelSkillRule {
  readonly ruleId: string;
  readonly text: string;
}

export interface NovelSkillValidationRule extends NovelSkillRule {
  readonly evidenceRequired: boolean;
}

export interface NovelSkillDefinitionDraft {
  readonly skillId: string;
  readonly version: string;
  readonly displayName: string;
  readonly summary: string;
  readonly kind: NovelSkillKind;
  readonly ownerScope: NovelSkillOwnerScope;
  readonly status: NovelSkillStatus;
  readonly defaultEnabled: boolean;
  readonly precedence: number;
  readonly taskTypes: readonly NovelSkillTask[];
  readonly activation: {
    readonly allowedModes: readonly NovelSkillInvocationMode[];
    readonly genreTags: readonly string[];
    readonly exclusiveGroup: string | null;
  };
  readonly contextRequirements: {
    readonly requiredLayers: readonly NovelSkillContextLayer[];
    readonly optionalLayers: readonly NovelSkillContextLayer[];
  };
  readonly instructions: {
    readonly rules: readonly NovelSkillRule[];
  };
  readonly outputContract: {
    readonly kind: "prose" | "analysis" | "structured" | "mixed";
    readonly rules: readonly NovelSkillRule[];
  };
  readonly validation: {
    readonly rules: readonly NovelSkillValidationRule[];
  };
  readonly provenance: {
    readonly url: string | null;
    readonly commit: string | null;
    readonly license: string | null;
  };
  readonly createdAt: string;
}

export interface NovelSkillDefinition extends NovelSkillDefinitionDraft {
  readonly definitionHash: string;
}

export interface NovelSkillTaskOverride {
  readonly enabled: boolean | null;
  readonly invocationMode: NovelSkillInvocationMode | null;
}

export interface ProjectNovelSkillBinding {
  readonly projectId: string;
  readonly skillId: string;
  readonly pinnedVersion: string;
  readonly enabled: boolean;
  readonly activationMode: NovelSkillBindingActivationMode;
  readonly taskOverrides: Readonly<Partial<Record<NovelSkillTask, NovelSkillTaskOverride>>>;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NovelSkillConfigurationSnapshot {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly maximumSkillTokens: number;
  readonly experimentalAllowed: boolean;
  readonly genreTags: readonly string[];
  readonly explicitSkillIds: readonly string[];
  readonly availableContextLayers: readonly NovelSkillContextLayer[];
  readonly consideredDefinitions: readonly {
    readonly skillId: string;
    readonly version: string;
    readonly definitionHash: string;
    readonly kind: NovelSkillKind;
    readonly status: NovelSkillStatus;
  }[];
  readonly bindings: readonly {
    readonly skillId: string;
    readonly version: string;
    readonly enabled: boolean;
    readonly activationMode: NovelSkillBindingActivationMode;
    readonly taskEnabled: boolean | null;
    readonly taskInvocationMode: NovelSkillInvocationMode | null;
    readonly revision: number;
  }[];
}

export type NovelSkillActivationSource =
  "explicit" | "project_binding" | "smart_core" | "smart_genre" | "default" | "registry";

export type NovelSkillSelectionReason =
  | "selected"
  | "not_enabled"
  | "manual_not_requested"
  | "task_mismatch"
  | "mode_mismatch"
  | "genre_mismatch"
  | "status_blocked"
  | "missing_context"
  | "conflict"
  | "token_budget_exhausted";

const NOVEL_SKILL_ACTIVATION_SOURCES: readonly NovelSkillActivationSource[] = [
  "explicit",
  "project_binding",
  "smart_core",
  "smart_genre",
  "default",
  "registry",
];

const NOVEL_SKILL_SELECTION_REASONS: readonly NovelSkillSelectionReason[] = [
  "selected",
  "not_enabled",
  "manual_not_requested",
  "task_mismatch",
  "mode_mismatch",
  "genre_mismatch",
  "status_blocked",
  "missing_context",
  "conflict",
  "token_budget_exhausted",
];

const NOVEL_SKILL_DISCARDED_REASONS = NOVEL_SKILL_SELECTION_REASONS.filter(
  (reason): reason is Exclude<NovelSkillSelectionReason, "selected"> => reason !== "selected",
);

export interface NovelSkillInvocationItem {
  readonly skillId: string;
  readonly skillVersion: string;
  readonly definitionHash: string;
  readonly activationSource: NovelSkillActivationSource;
  readonly selectionReason: NovelSkillSelectionReason;
  readonly precedence: number;
  readonly included: boolean;
  readonly discardedReason: Exclude<NovelSkillSelectionReason, "selected"> | null;
  readonly estimatedTokens: number;
}

export type NovelSkillErrorCode =
  | "NOVEL_SKILL_INVALID"
  | "NOVEL_SKILL_HASH_MISMATCH"
  | "NOVEL_SKILL_BINDING_INVALID"
  | "NOVEL_SKILL_CONFIGURATION_INVALID"
  | "NOVEL_SKILL_CONFLICT"
  | "NOVEL_SKILL_REQUIRED_CONTEXT_MISSING"
  | "NOVEL_SKILL_BUDGET_EXCEEDED";

export class NovelSkillError extends Error {
  public constructor(
    readonly code: NovelSkillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NovelSkillError";
  }
}

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SKILL_ID_PATTERN = /^(?=.{3,96}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/u;
const PORTABLE_VALUE_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;
const ISO_UTC_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function validateNovelSkillDefinitionDraft(
  value: NovelSkillDefinitionDraft,
): NovelSkillDefinitionDraft {
  validateNovelSkillDefinitionShape(value, false);
  return value;
}

export function validateNovelSkillDefinition(value: NovelSkillDefinition): NovelSkillDefinition {
  validateNovelSkillDefinitionShape(value, true);
  return value;
}

function validateNovelSkillDefinitionShape(
  value: NovelSkillDefinitionDraft | NovelSkillDefinition,
  includesHash: boolean,
): void {
  assertExactKeys(
    value,
    [
      "skillId",
      "version",
      "displayName",
      "summary",
      "kind",
      "ownerScope",
      "status",
      "defaultEnabled",
      "precedence",
      "taskTypes",
      "activation",
      "contextRequirements",
      "instructions",
      "outputContract",
      "validation",
      "provenance",
      "createdAt",
      ...(includesHash ? ["definitionHash"] : []),
    ],
    "Novel skill definition",
    "NOVEL_SKILL_INVALID",
  );
  requireSkillId(value.skillId, "skillId");
  requireVersion(value.version);
  requireText(value.displayName, 120, "displayName");
  requireText(value.summary, 500, "summary");
  requireOneOf(value.kind, ["core", "genre", "custom"] as const, "kind");
  requireOneOf(value.ownerScope, ["builtin", "user"] as const, "ownerScope");
  requireOneOf(value.status, NOVEL_SKILL_STATUSES, "status");
  if (value.ownerScope === "builtin" && value.kind === "custom") {
    invalid("Built-in skills cannot use the custom kind.");
  }
  if (value.ownerScope === "user" && value.kind !== "custom") {
    invalid("User-created skills must use the custom kind.");
  }
  if (typeof value.defaultEnabled !== "boolean") {
    invalid("Novel skill defaultEnabled must be boolean.");
  }
  if (value.defaultEnabled && value.status !== "active") {
    invalid("Only an active, evaluated skill may be enabled by default.");
  }
  requireInteger(value.precedence, 100, 699, "precedence");
  requireUniqueMembers(value.taskTypes, NOVEL_SKILL_TASKS, 1, 22, "taskTypes");
  assertExactKeys(
    value.activation,
    ["allowedModes", "genreTags", "exclusiveGroup"],
    "Novel skill activation",
    "NOVEL_SKILL_INVALID",
  );
  requireUniqueMembers(
    value.activation.allowedModes,
    NOVEL_SKILL_INVOCATION_MODES,
    1,
    NOVEL_SKILL_INVOCATION_MODES.length,
    "activation.allowedModes",
  );
  requireIdentifiers(value.activation.genreTags, 16, "activation.genreTags");
  if (value.activation.exclusiveGroup !== null) {
    requireIdentifier(value.activation.exclusiveGroup, "activation.exclusiveGroup");
  }
  assertExactKeys(
    value.contextRequirements,
    ["requiredLayers", "optionalLayers"],
    "Novel skill context requirements",
    "NOVEL_SKILL_INVALID",
  );
  requireUniqueMembers(
    value.contextRequirements.requiredLayers,
    NOVEL_SKILL_CONTEXT_LAYERS,
    0,
    NOVEL_SKILL_CONTEXT_LAYERS.length,
    "contextRequirements.requiredLayers",
  );
  requireUniqueMembers(
    value.contextRequirements.optionalLayers,
    NOVEL_SKILL_CONTEXT_LAYERS,
    0,
    NOVEL_SKILL_CONTEXT_LAYERS.length,
    "contextRequirements.optionalLayers",
  );
  if (
    value.contextRequirements.requiredLayers.some((layer) =>
      value.contextRequirements.optionalLayers.includes(layer),
    )
  ) {
    invalid("A context layer cannot be both required and optional.");
  }
  assertExactKeys(value.instructions, ["rules"], "Novel skill instructions", "NOVEL_SKILL_INVALID");
  validateRules(value.instructions.rules, 1, 32, "instructions.rules");
  assertExactKeys(
    value.outputContract,
    ["kind", "rules"],
    "Novel skill output contract",
    "NOVEL_SKILL_INVALID",
  );
  requireOneOf(
    value.outputContract.kind,
    ["prose", "analysis", "structured", "mixed"] as const,
    "outputContract.kind",
  );
  validateRules(value.outputContract.rules, 0, 16, "outputContract.rules");
  assertExactKeys(value.validation, ["rules"], "Novel skill validation", "NOVEL_SKILL_INVALID");
  validateRules(value.validation.rules, 1, 24, "validation.rules", true);
  assertExactKeys(
    value.provenance,
    ["url", "commit", "license"],
    "Novel skill provenance",
    "NOVEL_SKILL_INVALID",
  );
  if (value.provenance.url !== null) {
    if (
      typeof value.provenance.url !== "string" ||
      value.provenance.url.length > 1000 ||
      !value.provenance.url.startsWith("https://") ||
      UNSAFE_CONTROL_PATTERN.test(value.provenance.url)
    ) {
      invalid("Skill provenance URL must be a bounded HTTPS URL.");
    }
  }
  if (
    value.provenance.commit !== null &&
    (typeof value.provenance.commit !== "string" || !COMMIT_PATTERN.test(value.provenance.commit))
  ) {
    invalid("Skill provenance commit must be a lowercase hexadecimal revision.");
  }
  if (value.provenance.license !== null) {
    requireText(value.provenance.license, 64, "provenance.license");
  }
  requireIsoUtc(value.createdAt, "createdAt");
  if (includesHash && !SHA256_PATTERN.test((value as NovelSkillDefinition).definitionHash)) {
    invalid("Novel skill definition hash must be a lowercase SHA-256 digest.");
  }
}

export async function sealNovelSkillDefinition(
  draft: NovelSkillDefinitionDraft,
): Promise<NovelSkillDefinition> {
  validateNovelSkillDefinitionDraft(draft);
  const definitionHash = await sha256Hex(canonicalNovelSkillDefinition(draft));
  return Object.freeze({ ...draft, definitionHash });
}

export async function verifyNovelSkillDefinition(
  definition: NovelSkillDefinition,
): Promise<NovelSkillDefinition> {
  validateNovelSkillDefinition(definition);
  const expected = await sha256Hex(canonicalNovelSkillDefinition(definition));
  if (definition.definitionHash !== expected) {
    throw new NovelSkillError(
      "NOVEL_SKILL_HASH_MISMATCH",
      "Novel skill definition content does not match its immutable hash.",
    );
  }
  return definition;
}

export function validateProjectNovelSkillBinding(
  value: ProjectNovelSkillBinding,
): ProjectNovelSkillBinding {
  assertExactKeys(
    value,
    [
      "projectId",
      "skillId",
      "pinnedVersion",
      "enabled",
      "activationMode",
      "taskOverrides",
      "revision",
      "createdAt",
      "updatedAt",
    ],
    "Novel skill binding",
    "NOVEL_SKILL_BINDING_INVALID",
  );
  requireIdentifier(value.projectId, "projectId", "NOVEL_SKILL_BINDING_INVALID");
  requireSkillId(value.skillId, "skillId", "NOVEL_SKILL_BINDING_INVALID");
  requireVersion(value.pinnedVersion, "NOVEL_SKILL_BINDING_INVALID");
  if (typeof value.enabled !== "boolean") {
    bindingInvalid("Binding enabled value must be boolean.");
  }
  requireOneOf(
    value.activationMode,
    ["smart", "manual"] as const,
    "activationMode",
    "NOVEL_SKILL_BINDING_INVALID",
  );
  requireInteger(value.revision, 1, 2_147_483_647, "revision", "NOVEL_SKILL_BINDING_INVALID");
  requireIsoUtc(value.createdAt, "createdAt", "NOVEL_SKILL_BINDING_INVALID");
  requireIsoUtc(value.updatedAt, "updatedAt", "NOVEL_SKILL_BINDING_INVALID");
  if (value.updatedAt < value.createdAt) {
    bindingInvalid("Binding updatedAt cannot precede createdAt.");
  }
  assertPlainRecord(value.taskOverrides, "Binding task overrides", "NOVEL_SKILL_BINDING_INVALID");
  const entries = Object.entries(value.taskOverrides) as readonly [
    string,
    NovelSkillTaskOverride | undefined,
  ][];
  if (entries.length > NOVEL_SKILL_TASKS.length) {
    bindingInvalid("Binding has too many task overrides.");
  }
  for (const [task, override] of entries) {
    if (!NOVEL_SKILL_TASKS.includes(task as NovelSkillTask) || override === undefined) {
      bindingInvalid("Binding contains an unsupported task override.");
    }
    assertExactKeys(
      override,
      ["enabled", "invocationMode"],
      "Binding task override",
      "NOVEL_SKILL_BINDING_INVALID",
    );
    if (
      override.invocationMode !== null &&
      !NOVEL_SKILL_INVOCATION_MODES.includes(override.invocationMode)
    ) {
      bindingInvalid("Binding task override contains an unsupported invocation mode.");
    }
    if (override.enabled !== null && typeof override.enabled !== "boolean") {
      bindingInvalid("Binding task override enabled value must be boolean or null.");
    }
    if (override.enabled === null && override.invocationMode === null) {
      bindingInvalid("Binding task override cannot be an all-null no-op.");
    }
  }
  return value;
}

export function validateNovelSkillConfigurationSnapshot(
  value: NovelSkillConfigurationSnapshot,
): NovelSkillConfigurationSnapshot {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "compilerVersion",
      "taskType",
      "invocationMode",
      "maximumSkillTokens",
      "experimentalAllowed",
      "genreTags",
      "explicitSkillIds",
      "availableContextLayers",
      "consideredDefinitions",
      "bindings",
    ],
    "Novel skill configuration",
    "NOVEL_SKILL_CONFIGURATION_INVALID",
  );
  if (!isSchemaVersionOne(value.schemaVersion)) {
    configurationInvalid("Novel skill configuration schema version is unsupported.");
  }
  requirePortableValue(value.compilerVersion, "compilerVersion");
  requireOneOf(value.taskType, NOVEL_SKILL_TASKS, "taskType", "NOVEL_SKILL_CONFIGURATION_INVALID");
  requireOneOf(
    value.invocationMode,
    NOVEL_SKILL_INVOCATION_MODES,
    "invocationMode",
    "NOVEL_SKILL_CONFIGURATION_INVALID",
  );
  requireInteger(
    value.maximumSkillTokens,
    0,
    100_000,
    "maximumSkillTokens",
    "NOVEL_SKILL_CONFIGURATION_INVALID",
  );
  if (typeof value.experimentalAllowed !== "boolean") {
    configurationInvalid("experimentalAllowed must be boolean.");
  }
  requireIdentifiers(value.genreTags, 16, "genreTags", "NOVEL_SKILL_CONFIGURATION_INVALID");
  requireSkillIdentifiers(
    value.explicitSkillIds,
    32,
    "explicitSkillIds",
    "NOVEL_SKILL_CONFIGURATION_INVALID",
  );
  requireUniqueMembers(
    value.availableContextLayers,
    NOVEL_SKILL_CONTEXT_LAYERS,
    0,
    NOVEL_SKILL_CONTEXT_LAYERS.length,
    "availableContextLayers",
  );
  const consideredDefinitionValues: unknown = value.consideredDefinitions;
  const bindingValues: unknown = value.bindings;
  if (
    !Array.isArray(consideredDefinitionValues) ||
    !Array.isArray(bindingValues) ||
    consideredDefinitionValues.length > 64 ||
    bindingValues.length > 64
  ) {
    configurationInvalid("Novel skill configuration contains too many references.");
  }
  const definitions = new Set<string>();
  for (const referenceValue of consideredDefinitionValues as readonly unknown[]) {
    assertExactKeys(
      referenceValue,
      ["skillId", "version", "definitionHash", "kind", "status"],
      "Considered definition reference",
      "NOVEL_SKILL_CONFIGURATION_INVALID",
    );
    const skillId = referenceValue.skillId;
    const version = referenceValue.version;
    const definitionHash = referenceValue.definitionHash;
    const kind = referenceValue.kind;
    const status = referenceValue.status;
    requireSkillId(skillId, "consideredDefinitions.skillId", "NOVEL_SKILL_CONFIGURATION_INVALID");
    requireVersion(version, "NOVEL_SKILL_CONFIGURATION_INVALID");
    if (typeof definitionHash !== "string" || !SHA256_PATTERN.test(definitionHash)) {
      configurationInvalid("Considered definition hash is invalid.");
    }
    requireOneOf(
      kind,
      ["core", "genre", "custom"] as const,
      "kind",
      "NOVEL_SKILL_CONFIGURATION_INVALID",
    );
    requireOneOf(status, NOVEL_SKILL_STATUSES, "status", "NOVEL_SKILL_CONFIGURATION_INVALID");
    const key = `${skillId}@${version}`;
    if (definitions.has(key)) {
      configurationInvalid("Considered definition references must be unique.");
    }
    definitions.add(key);
  }
  const bindings = new Set<string>();
  for (const bindingValue of bindingValues as readonly unknown[]) {
    assertExactKeys(
      bindingValue,
      [
        "skillId",
        "version",
        "enabled",
        "activationMode",
        "taskEnabled",
        "taskInvocationMode",
        "revision",
      ],
      "Binding snapshot",
      "NOVEL_SKILL_CONFIGURATION_INVALID",
    );
    const skillId = bindingValue.skillId;
    const version = bindingValue.version;
    const enabled = bindingValue.enabled;
    const activationMode = bindingValue.activationMode;
    const taskInvocationMode = bindingValue.taskInvocationMode;
    const taskEnabled = bindingValue.taskEnabled;
    const revision = bindingValue.revision;
    requireSkillId(skillId, "bindings.skillId", "NOVEL_SKILL_CONFIGURATION_INVALID");
    requireVersion(version, "NOVEL_SKILL_CONFIGURATION_INVALID");
    if (typeof enabled !== "boolean") {
      configurationInvalid("Binding snapshot enabled value must be boolean.");
    }
    requireOneOf(
      activationMode,
      ["smart", "manual"] as const,
      "bindings.activationMode",
      "NOVEL_SKILL_CONFIGURATION_INVALID",
    );
    if (
      taskInvocationMode !== null &&
      (typeof taskInvocationMode !== "string" ||
        !NOVEL_SKILL_INVOCATION_MODES.includes(taskInvocationMode as NovelSkillInvocationMode))
    ) {
      configurationInvalid("Binding snapshot contains an invalid task invocation mode.");
    }
    if (taskEnabled !== null && typeof taskEnabled !== "boolean") {
      configurationInvalid("Binding snapshot taskEnabled value must be boolean or null.");
    }
    requireInteger(
      revision,
      1,
      2_147_483_647,
      "bindings.revision",
      "NOVEL_SKILL_CONFIGURATION_INVALID",
    );
    if (bindings.has(skillId)) {
      configurationInvalid("Binding snapshots must be unique per skill.");
    }
    if (!definitions.has(`${skillId}@${version}`)) {
      configurationInvalid("Binding snapshot must reference a considered immutable definition.");
    }
    bindings.add(skillId);
  }
  assertConfigurationIsContentFree(value);
  return value;
}

export function validateNovelSkillInvocationItem(
  value: NovelSkillInvocationItem,
): NovelSkillInvocationItem {
  assertExactKeys(
    value,
    [
      "skillId",
      "skillVersion",
      "definitionHash",
      "activationSource",
      "selectionReason",
      "precedence",
      "included",
      "discardedReason",
      "estimatedTokens",
    ],
    "Novel skill invocation item",
    "NOVEL_SKILL_CONFIGURATION_INVALID",
  );
  requireSkillId(value.skillId, "skillId", "NOVEL_SKILL_CONFIGURATION_INVALID");
  requireVersion(value.skillVersion, "NOVEL_SKILL_CONFIGURATION_INVALID");
  if (!SHA256_PATTERN.test(value.definitionHash)) {
    configurationInvalid("Invocation item definition hash is invalid.");
  }
  if (!NOVEL_SKILL_ACTIVATION_SOURCES.includes(value.activationSource)) {
    configurationInvalid("Invocation item activation source is invalid.");
  }
  if (!NOVEL_SKILL_SELECTION_REASONS.includes(value.selectionReason)) {
    configurationInvalid("Invocation item selection reason is invalid.");
  }
  if (
    value.discardedReason !== null &&
    !NOVEL_SKILL_DISCARDED_REASONS.includes(value.discardedReason)
  ) {
    configurationInvalid("Invocation item discarded reason is invalid.");
  }
  requireInteger(value.precedence, 100, 699, "precedence", "NOVEL_SKILL_CONFIGURATION_INVALID");
  requireInteger(
    value.estimatedTokens,
    1,
    100_000,
    "estimatedTokens",
    "NOVEL_SKILL_CONFIGURATION_INVALID",
  );
  if (typeof value.included !== "boolean") {
    configurationInvalid("Invocation item included value must be boolean.");
  }
  if (
    (value.included && (value.selectionReason !== "selected" || value.discardedReason !== null)) ||
    (!value.included &&
      (value.selectionReason === "selected" || value.discardedReason !== value.selectionReason))
  ) {
    configurationInvalid("Invocation item selection decision is inconsistent.");
  }
  return value;
}

export function canonicalNovelSkillDefinition(value: NovelSkillDefinitionDraft): string {
  const payload: NovelSkillDefinitionDraft = {
    skillId: value.skillId,
    version: value.version,
    displayName: value.displayName,
    summary: value.summary,
    kind: value.kind,
    ownerScope: value.ownerScope,
    status: value.status,
    defaultEnabled: value.defaultEnabled,
    precedence: value.precedence,
    taskTypes: [...value.taskTypes],
    activation: {
      allowedModes: [...value.activation.allowedModes],
      genreTags: [...value.activation.genreTags],
      exclusiveGroup: value.activation.exclusiveGroup,
    },
    contextRequirements: {
      requiredLayers: [...value.contextRequirements.requiredLayers],
      optionalLayers: [...value.contextRequirements.optionalLayers],
    },
    instructions: { rules: value.instructions.rules.map((rule) => ({ ...rule })) },
    outputContract: {
      kind: value.outputContract.kind,
      rules: value.outputContract.rules.map((rule) => ({ ...rule })),
    },
    validation: {
      rules: value.validation.rules.map((rule) => ({ ...rule })),
    },
    provenance: { ...value.provenance },
    createdAt: value.createdAt,
  };
  return canonicalJson(payload);
}

export function canonicalNovelSkillConfiguration(value: NovelSkillConfigurationSnapshot): string {
  validateNovelSkillConfigurationSnapshot(value);
  return canonicalJson(value);
}

export async function hashNovelSkillConfiguration(
  value: NovelSkillConfigurationSnapshot,
): Promise<string> {
  return sha256Hex(canonicalNovelSkillConfiguration(value));
}

function validateRules(
  rules: unknown,
  minimum: number,
  maximum: number,
  field: string,
  validationRules = false,
): void {
  if (!Array.isArray(rules)) {
    invalid(`${field} must be an array.`);
  }
  if (rules.length < minimum || rules.length > maximum) {
    invalid(`${field} must contain between ${String(minimum)} and ${String(maximum)} rules.`);
  }
  const identifiers = new Set<string>();
  for (const value of rules) {
    assertExactKeys(
      value,
      validationRules ? ["ruleId", "text", "evidenceRequired"] : ["ruleId", "text"],
      field,
      "NOVEL_SKILL_INVALID",
    );
    const rule = value as unknown as NovelSkillRule | NovelSkillValidationRule;
    requireIdentifier(rule.ruleId, `${field}.ruleId`);
    requireText(rule.text, 1000, `${field}.text`);
    if (identifiers.has(rule.ruleId)) {
      invalid(`${field} rule identifiers must be unique.`);
    }
    if (
      validationRules &&
      typeof (rule as NovelSkillValidationRule).evidenceRequired !== "boolean"
    ) {
      invalid(`${field} must declare whether exact evidence is required.`);
    }
    identifiers.add(rule.ruleId);
  }
}

function assertConfigurationIsContentFree(value: NovelSkillConfigurationSnapshot): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_768 || UNSAFE_CONTROL_PATTERN.test(serialized)) {
    configurationInvalid("Novel skill configuration is too large or contains unsafe controls.");
  }
  const forbiddenKey =
    /credential|secret|api.?key|chapter|story.?fact|prompt|message|response|reasoning|instruction|excerpt|^(?:text|body|content)$/iu;
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (!PORTABLE_VALUE_PATTERN.test(entry)) {
        configurationInvalid("Novel skill configuration may contain identifiers only.");
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (forbiddenKey.test(key)) {
          configurationInvalid("Novel skill configuration contains a forbidden content field.");
        }
        visit(child);
      }
    }
  };
  visit(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireText(value: unknown, maximum: number, field: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    UNSAFE_CONTROL_PATTERN.test(value)
  ) {
    invalid(`${field} must be non-empty, trimmed, bounded text without unsafe controls.`);
  }
}

function requireIdentifier(
  value: unknown,
  field: string,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): void {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new NovelSkillError(code, `${field} must be a bounded portable identifier.`);
  }
}

function requireSkillId(
  value: unknown,
  field: string,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): asserts value is string {
  if (typeof value !== "string" || !SKILL_ID_PATTERN.test(value)) {
    throw new NovelSkillError(
      code,
      `${field} must be a portable skill identifier containing 3 to 96 characters.`,
    );
  }
}

function requireIdentifiers(
  values: unknown,
  maximum: number,
  field: string,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): void {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    new Set(values as readonly unknown[]).size !== values.length
  ) {
    throw new NovelSkillError(code, `${field} must be unique and bounded.`);
  }
  values.forEach((value) => requireIdentifier(value, field, code));
}

function requireSkillIdentifiers(
  values: unknown,
  maximum: number,
  field: string,
  code: NovelSkillErrorCode,
): void {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    new Set(values as readonly unknown[]).size !== values.length
  ) {
    throw new NovelSkillError(code, `${field} must be unique and bounded.`);
  }
  values.forEach((value) => requireSkillId(value, field, code));
}

function requireVersion(
  value: unknown,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): asserts value is string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value) || value.length > 32) {
    throw new NovelSkillError(code, "Novel skill version must be a bounded semantic version.");
  }
}

function requirePortableValue(value: unknown, field: string): void {
  if (typeof value !== "string" || !PORTABLE_VALUE_PATTERN.test(value)) {
    configurationInvalid(`${field} must be a bounded portable value.`);
  }
}

function requireIsoUtc(
  value: unknown,
  field: string,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): void {
  if (
    typeof value !== "string" ||
    !ISO_UTC_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new NovelSkillError(code, `${field} must be an ISO UTC timestamp with milliseconds.`);
  }
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new NovelSkillError(
      code,
      `${field} must be an integer from ${String(minimum)} to ${String(maximum)}.`,
    );
  }
}

function isSchemaVersionOne(value: unknown): value is 1 {
  return value === 1;
}

function requireOneOf(
  value: unknown,
  allowed: readonly string[],
  field: string,
  code: NovelSkillErrorCode = "NOVEL_SKILL_INVALID",
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new NovelSkillError(code, `${field} is not supported.`);
  }
}

function requireUniqueMembers(
  values: unknown,
  allowed: readonly string[],
  minimum: number,
  maximum: number,
  field: string,
): asserts values is readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length < minimum ||
    values.length > maximum ||
    new Set(values as readonly unknown[]).size !== values.length ||
    values.some((value) => typeof value !== "string" || !allowed.includes(value))
  ) {
    invalid(`${field} contains unsupported, duplicate, or unbounded values.`);
  }
}

function assertExactKeys(
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
  code: NovelSkillErrorCode,
): asserts value is Record<string, unknown> {
  assertPlainRecord(value, field, code);
  const keys = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new NovelSkillError(code, `${field} contains missing or unsupported fields.`);
  }
}

function assertPlainRecord(
  value: unknown,
  field: string,
  code: NovelSkillErrorCode,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ) {
    throw new NovelSkillError(code, `${field} must be a plain object.`);
  }
}

function invalid(message: string): never {
  throw new NovelSkillError("NOVEL_SKILL_INVALID", message);
}

function bindingInvalid(message: string): never {
  throw new NovelSkillError("NOVEL_SKILL_BINDING_INVALID", message);
}

function configurationInvalid(message: string): never {
  throw new NovelSkillError("NOVEL_SKILL_CONFIGURATION_INVALID", message);
}
