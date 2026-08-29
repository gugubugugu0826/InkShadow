import {
  NOVEL_SKILL_COMPILER_VERSION,
  NOVEL_SKILL_CONTEXT_LAYERS,
  compileFixedNovelSkillEvaluationArm,
  isFixedNovelSkillEvaluationConfiguration,
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  listNovelSkillEvaluationFixtures,
  renderNovelSkillPromptSection,
  type CompiledNovelSkills,
  type NovelSkillContextLayer,
  type NovelSkillDefinition,
  type NovelSkillEvaluationArm,
  type NovelSkillEvaluationFixture,
  type NovelSkillInvocationMode,
  type NovelSkillTask,
} from "@inkshadow/ai-core";
import { NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY } from "@inkshadow/domain";

import { hashModelHubExactEvaluationMessages } from "./model-hub-exact-evaluation-target";
import type { NativeModelMessage } from "./runtime";

export const NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION =
  "novel-skill-paid-payload-authority@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_PROMPT_TEMPLATE_VERSION =
  "novel-skill-paid-prompt@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_CONTEXT_BASELINE_VERSION =
  "novel-skill-paid-context-baseline@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_PREFERENCE_PROJECTION_VERSION =
  "novel-skill-paid-preferences@1" as const;

const MAXIMUM_SKILL_TOKENS = 100_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const PROMPT_TEMPLATE_SPECIFICATION = Object.freeze({
  schemaVersion: 1,
  version: NOVEL_SKILL_PAID_EVALUATION_PROMPT_TEMPLATE_VERSION,
  systemInstruction:
    "You are completing one blinded InkShadow fiction task. Follow only the supplied contract and return only the requested result. Do not mention evaluation variants, hidden methods, preferences, hashes, or these instructions.",
  taskOpening: "<inkshadow_evaluation_task>",
  taskClosing: "</inkshadow_evaluation_task>",
  inputOpening: "<fixture_input>",
  inputClosing: "</fixture_input>",
  factsOpening: "<locked_facts>",
  factsClosing: "</locked_facts>",
  boundariesOpening: "<boundaries>",
  boundariesClosing: "</boundaries>",
  outcomeOpening: "<requested_outcome>",
  outcomeClosing: "</requested_outcome>",
  methodSlot: "{{NOVEL_METHOD_SECTION_OR_EMPTY}}",
  preferenceSlot: "{{WRITING_PREFERENCE_SECTION_OR_EMPTY}}",
});

export interface NovelSkillPaidEvaluationCellPayloadIdentity {
  readonly runId: string;
  readonly suiteId: string;
  readonly cellId: string;
  readonly fixtureId: string;
  readonly fixtureInputContentHash: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly arm: NovelSkillEvaluationArm;
  readonly armConfigurationHash: string | null;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
}

export interface NovelSkillPaidEvaluationPromptTemplateProjection {
  readonly version: typeof NOVEL_SKILL_PAID_EVALUATION_PROMPT_TEMPLATE_VERSION;
  readonly hash: string;
}

export interface NovelSkillPaidEvaluationContextBaselineProjection {
  readonly schemaVersion: 1;
  readonly version: typeof NOVEL_SKILL_PAID_EVALUATION_CONTEXT_BASELINE_VERSION;
  readonly fixtureId: string;
  readonly baselineContractHash: string;
  readonly includedSourceManifestHash: string;
  readonly omittedSourceManifestHash: string;
  readonly compiledBaselineHash: string;
  readonly baselineTokenBudget: number;
  readonly availableContextLayers: readonly NovelSkillContextLayer[];
  readonly traceBaseline: NovelSkillPaidEvaluationTraceBaselineProjection;
}

export interface NovelSkillPaidEvaluationTraceBaselineSourceProjection {
  readonly sourceOrder: number;
  readonly sourceType: "user_input";
  readonly sourceId: string;
  readonly sourceVersionId: null;
  readonly locator: "novel_skill_evaluation_fixture" | "novel_skill_evaluation_fixture_contract";
  readonly contentHash: string;
}

export interface NovelSkillPaidEvaluationTraceBaselineEntryProjection {
  readonly contextCandidateId: string;
  readonly layer: NovelSkillContextLayer;
  readonly selectionReason: "fixed_evaluation_context";
  readonly included: true;
  readonly discardedReason: null;
  readonly estimatedTokens: number;
  readonly evaluationOrder: number;
  readonly layerOrder: number;
  readonly priority: number;
  readonly relevanceScore: null;
  readonly required: true;
  readonly budgetRemainingBefore: number;
  readonly budgetRemainingAfter: number;
  readonly sources: readonly NovelSkillPaidEvaluationTraceBaselineSourceProjection[];
}

export interface NovelSkillPaidEvaluationTraceBaselineProjection {
  readonly version: "novel-skill-paid-evaluation-trace-baseline@1";
  readonly taskType: NovelSkillTask;
  readonly maximumContextTokens: number;
  readonly requiredTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly discardedTokens: 0;
  readonly tokenEstimateSource: "utf8_conservative";
  readonly entries: readonly NovelSkillPaidEvaluationTraceBaselineEntryProjection[];
}

export interface NovelSkillPaidEvaluationPreferenceSource {
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly preferenceText: string;
}

export interface NovelSkillPaidEvaluationPreferenceProjection {
  readonly schemaVersion: 1;
  readonly version: typeof NOVEL_SKILL_PAID_EVALUATION_PREFERENCE_PROJECTION_VERSION;
  readonly configurationHash: string;
  readonly sourceManifestHash: string;
  readonly sources: readonly NovelSkillPaidEvaluationPreferenceSource[];
}

export interface CompileNovelSkillPaidEvaluationPayloadInput {
  readonly cell: NovelSkillPaidEvaluationCellPayloadIdentity;
  readonly promptTemplate: NovelSkillPaidEvaluationPromptTemplateProjection;
  readonly contextBaseline: NovelSkillPaidEvaluationContextBaselineProjection;
  readonly preferenceProjection: NovelSkillPaidEvaluationPreferenceProjection | null;
}

export interface NovelSkillPaidEvaluationPayloadAuthorityManifest {
  readonly schemaVersion: 1;
  readonly authorityVersion: typeof NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION;
  readonly runId: string;
  readonly suiteId: string;
  readonly cellId: string;
  readonly fixtureId: string;
  readonly fixtureContractHash: string;
  readonly fixtureInputContentHash: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly genreTagsHash: string;
  readonly coverageDimensionsHash: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly armConfigurationHash: string | null;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
  readonly promptTemplateVersion: typeof NOVEL_SKILL_PAID_EVALUATION_PROMPT_TEMPLATE_VERSION;
  readonly promptTemplateHash: string;
  readonly contextBaselineHash: string;
  readonly contextBaselineProjectionHash: string;
  readonly availableContextLayersHash: string;
  readonly skillCompilerVersion: typeof NOVEL_SKILL_COMPILER_VERSION;
  readonly skillSelectionHash: string | null;
  readonly compiledSkillSnapshotHash: string | null;
  readonly renderedSkillSectionHash: string | null;
  readonly preferenceConfigurationHash: string | null;
  readonly preferenceProjectionHash: string | null;
  readonly renderedPreferenceSectionHash: string | null;
  readonly baseMessagePayloadHash: string;
  readonly messagePayloadHash: string;
}

export interface NovelSkillPaidEvaluationAuthoritativePayload {
  readonly messages: readonly NativeModelMessage[];
  readonly manifest: NovelSkillPaidEvaluationPayloadAuthorityManifest;
  readonly manifestHash: string;
  readonly compiledSkills: CompiledNovelSkills | null;
}

export type NovelSkillPaidEvaluationPayloadAuthorityErrorCode =
  | "NOVEL_SKILL_PAID_PAYLOAD_INVALID"
  | "NOVEL_SKILL_PAID_PAYLOAD_FIXTURE_MISMATCH"
  | "NOVEL_SKILL_PAID_PAYLOAD_HASH_MISMATCH"
  | "NOVEL_SKILL_PAID_PAYLOAD_MISMATCH";

export class NovelSkillPaidEvaluationPayloadAuthorityError extends Error {
  public constructor(
    readonly code: NovelSkillPaidEvaluationPayloadAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NovelSkillPaidEvaluationPayloadAuthorityError";
  }
}

interface VerifiedFixture {
  readonly fixture: NovelSkillEvaluationFixture;
  readonly contractHash: string;
  readonly inputContentHash: string;
}

interface PreferenceEvidenceProjection {
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly contentHash: string;
}

/**
 * Returns the only prompt-template identity accepted by the paid evaluator.
 * Template text is code-owned; callers cannot supply or append prompt text.
 */
export async function createNovelSkillPaidEvaluationPromptTemplateProjection(): Promise<NovelSkillPaidEvaluationPromptTemplateProjection> {
  return Object.freeze({
    version: NOVEL_SKILL_PAID_EVALUATION_PROMPT_TEMPLATE_VERSION,
    hash: await sha256Hex(canonicalJson(PROMPT_TEMPLATE_SPECIFICATION)),
  });
}

/**
 * Builds a content-free baseline descriptor from the pinned fixture registry.
 * The fixture body remains in AI Core and is never copied into this projection.
 */
export async function createNovelSkillPaidEvaluationContextBaselineProjection(
  fixtureId: string,
  baselineTokenBudget: number,
): Promise<NovelSkillPaidEvaluationContextBaselineProjection> {
  assertPortableFixtureId(fixtureId);
  assertSafeInteger(baselineTokenBudget, 1, 1_000_000_000, "baseline token budget");
  const verified = await resolveVerifiedFixture(fixtureId);
  const minimumBudget = conservativeTokenUpperBound(canonicalJson(verified.fixture));
  if (baselineTokenBudget < minimumBudget) {
    throw invalid(
      "The context baseline budget cannot contain the complete pinned fixture contract.",
    );
  }
  const availableContextLayers = contextLayersForFixture(verified.fixture);
  let budgetRemaining = baselineTokenBudget;
  const entries = availableContextLayers.map((layer, index) => {
    const estimatedTokens = estimateFixtureLayerTokens(verified.fixture, layer);
    const budgetRemainingBefore = budgetRemaining;
    budgetRemaining -= estimatedTokens;
    if (budgetRemaining < 0) {
      throw invalid(
        "The context baseline budget cannot contain every required pinned fixture layer.",
      );
    }
    return Object.freeze({
      contextCandidateId:
        layer === "current_task"
          ? `evaluation-fixture:${fixtureId}`
          : `evaluation-fixture-layer:${fixtureId}:${layer}`,
      layer,
      selectionReason: "fixed_evaluation_context" as const,
      included: true as const,
      discardedReason: null,
      estimatedTokens,
      evaluationOrder: index + 1,
      layerOrder: NOVEL_SKILL_CONTEXT_LAYERS.indexOf(layer) + 1,
      priority: 100 - index,
      relevanceScore: null,
      required: true as const,
      budgetRemainingBefore,
      budgetRemainingAfter: budgetRemaining,
      sources: Object.freeze([
        Object.freeze({
          sourceOrder: 1,
          sourceType: "user_input" as const,
          sourceId: fixtureId,
          sourceVersionId: null,
          locator:
            layer === "current_task"
              ? ("novel_skill_evaluation_fixture" as const)
              : ("novel_skill_evaluation_fixture_contract" as const),
          contentHash: layer === "current_task" ? verified.inputContentHash : verified.contractHash,
        }),
      ]),
    } satisfies NovelSkillPaidEvaluationTraceBaselineEntryProjection);
  });
  const usedTokens = baselineTokenBudget - budgetRemaining;
  const traceBaseline = Object.freeze({
    version: "novel-skill-paid-evaluation-trace-baseline@1" as const,
    taskType: verified.fixture.taskType,
    maximumContextTokens: baselineTokenBudget,
    requiredTokens: usedTokens,
    usedTokens,
    remainingTokens: budgetRemaining,
    discardedTokens: 0 as const,
    tokenEstimateSource: "utf8_conservative" as const,
    entries: Object.freeze(entries),
  } satisfies NovelSkillPaidEvaluationTraceBaselineProjection);
  const omittedSources = NOVEL_SKILL_CONTEXT_LAYERS.filter(
    (layer) => !availableContextLayers.includes(layer),
  ).map((layer) => Object.freeze({ layer, reason: "not_applicable_to_pinned_fixture" }));
  const includedSourceManifestHash = await sha256Hex(
    canonicalJson(
      entries.map(({ contextCandidateId, layer, sources }) => ({
        contextCandidateId,
        layer,
        sources,
      })),
    ),
  );
  const omittedSourceManifestHash = await sha256Hex(canonicalJson(omittedSources));
  const compiledBaselineHash = await sha256Hex(canonicalJson(traceBaseline));
  return Object.freeze({
    schemaVersion: 1,
    version: NOVEL_SKILL_PAID_EVALUATION_CONTEXT_BASELINE_VERSION,
    fixtureId,
    baselineContractHash: verified.contractHash,
    includedSourceManifestHash,
    omittedSourceManifestHash,
    compiledBaselineHash,
    baselineTokenBudget,
    availableContextLayers,
    traceBaseline,
  });
}

/**
 * Seals the one intentional preference-arm variable. Only source locators and
 * content hashes enter the returned configuration identity; prose is retained
 * solely in this transient projection for prompt rendering.
 */
export async function createNovelSkillPaidEvaluationPreferenceProjection(
  sourcesValue: unknown,
): Promise<NovelSkillPaidEvaluationPreferenceProjection> {
  if (!Array.isArray(sourcesValue) || sourcesValue.length < 1 || sourcesValue.length > 64) {
    throw invalid("Preference projection requires between one and 64 bounded sources.");
  }
  const sources = sourcesValue.map((sourceValue) => normalizePreferenceSource(sourceValue));
  const ordered = [...sources].sort(comparePreferenceSources);
  if (new Set(ordered.map(({ sourceId }) => sourceId)).size !== ordered.length) {
    throw invalid("Preference source identifiers must be unique.");
  }
  const evidence = await Promise.all(
    ordered.map(async ({ sourceId, sourceVersionId, preferenceText }) =>
      Object.freeze({
        sourceId,
        sourceVersionId,
        contentHash: await sha256Hex(preferenceText),
      } satisfies PreferenceEvidenceProjection),
    ),
  );
  const configurationHash = await sha256Hex(canonicalJson(evidence));
  const sourceManifestHash = await sha256Hex(
    canonicalJson({
      version: NOVEL_SKILL_PAID_EVALUATION_PREFERENCE_PROJECTION_VERSION,
      evidence,
    }),
  );
  return Object.freeze({
    schemaVersion: 1,
    version: NOVEL_SKILL_PAID_EVALUATION_PREFERENCE_PROJECTION_VERSION,
    configurationHash,
    sourceManifestHash,
    sources: Object.freeze(ordered),
  });
}

/** Computes the exact 0061 suite-manifest hash for one arm's built-in targets. */
export async function resolveNovelSkillPaidEvaluationArmConfigurationHash(
  arm: NovelSkillEvaluationArm,
): Promise<string | null> {
  assertEvaluationArm(arm);
  if (arm === "no_skill") return null;
  return armConfigurationHash(await definitionsForArm(arm));
}

/**
 * The single authority that turns a fixed evaluation cell into gateway-ready
 * messages. Fixture prose is resolved by ID from AI Core, never from a caller.
 */
export async function compileNovelSkillPaidEvaluationPayload(
  inputValue: unknown,
): Promise<NovelSkillPaidEvaluationAuthoritativePayload> {
  const input = normalizeCompileInput(inputValue);
  const verified = await resolveVerifiedFixture(input.cell.fixtureId);
  assertCellMatchesFixture(input.cell, verified);
  await assertPromptTemplateProjection(input.promptTemplate);
  await assertContextBaselineProjection(input.contextBaseline, verified);

  const definitions = await definitionsForArm(input.cell.arm);
  const expectedArmConfigurationHash =
    input.cell.arm === "no_skill" ? null : await armConfigurationHash(definitions);
  if (input.cell.armConfigurationHash !== expectedArmConfigurationHash) {
    throw hashMismatch("The cell arm does not match the immutable built-in definition manifest.");
  }

  const compiledSkills =
    input.cell.arm === "no_skill"
      ? null
      : await compileArmSkills(input.cell, input.contextBaseline, definitions);
  const renderedSkillSection =
    compiledSkills === null ? null : renderNovelSkillPromptSection(compiledSkills);
  const preference = await normalizePreferenceForArm(input.cell.arm, input.preferenceProjection);
  const renderedPreferenceSection =
    preference === null ? null : renderPreferenceSection(preference.sources);

  const baseMessages = buildMessages(verified.fixture, null, null);
  const messages = buildMessages(verified.fixture, renderedSkillSection, renderedPreferenceSection);
  const promptTemplateHash = input.promptTemplate.hash;
  const contextBaselineProjectionHash = await hashContextBaselineProjection(input.contextBaseline);
  const compiledSkillSnapshotHash =
    compiledSkills === null ? null : await hashCompiledSkills(compiledSkills);
  const preferenceProjectionHash =
    preference === null ? null : await hashPreferenceProjection(preference);
  const manifest = Object.freeze({
    schemaVersion: 1,
    authorityVersion: NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION,
    runId: input.cell.runId,
    suiteId: input.cell.suiteId,
    cellId: input.cell.cellId,
    fixtureId: verified.fixture.fixtureId,
    fixtureContractHash: verified.contractHash,
    fixtureInputContentHash: verified.inputContentHash,
    taskType: verified.fixture.taskType,
    invocationMode: verified.fixture.invocationMode,
    genreTagsHash: await sha256Hex(canonicalJson(verified.fixture.genreTags)),
    coverageDimensionsHash: await sha256Hex(canonicalJson(verified.fixture.coverageDimensions)),
    arm: input.cell.arm,
    armConfigurationHash: expectedArmConfigurationHash,
    modelSlotId: input.cell.modelSlotId,
    repetition: input.cell.repetition,
    promptTemplateVersion: input.promptTemplate.version,
    promptTemplateHash,
    contextBaselineHash: input.contextBaseline.compiledBaselineHash,
    contextBaselineProjectionHash,
    availableContextLayersHash: await sha256Hex(
      canonicalJson(input.contextBaseline.availableContextLayers),
    ),
    skillCompilerVersion: NOVEL_SKILL_COMPILER_VERSION,
    skillSelectionHash: compiledSkills?.selectionHash ?? null,
    compiledSkillSnapshotHash,
    renderedSkillSectionHash:
      renderedSkillSection === null ? null : await sha256Hex(renderedSkillSection),
    preferenceConfigurationHash: preference?.configurationHash ?? null,
    preferenceProjectionHash,
    renderedPreferenceSectionHash:
      renderedPreferenceSection === null ? null : await sha256Hex(renderedPreferenceSection),
    baseMessagePayloadHash: await hashNovelSkillPaidEvaluationMessages(baseMessages),
    messagePayloadHash: await hashNovelSkillPaidEvaluationMessages(messages),
  } satisfies NovelSkillPaidEvaluationPayloadAuthorityManifest);
  const manifestHash = await hashNovelSkillPaidEvaluationAuthorityManifest(manifest);
  return Object.freeze({
    messages,
    manifest,
    manifestHash,
    compiledSkills,
  });
}

/** Strictly hashes a two-message payload; extra message fields are rejected. */
export async function hashNovelSkillPaidEvaluationMessages(
  messagesValue: unknown,
): Promise<string> {
  const messages = normalizeMessages(messagesValue);
  return hashModelHubExactEvaluationMessages(messages);
}

/** Strictly hashes the content-free authority manifest. */
export async function hashNovelSkillPaidEvaluationAuthorityManifest(
  manifestValue: unknown,
): Promise<string> {
  const manifest = normalizeManifest(manifestValue);
  return sha256Hex(canonicalJson(manifest));
}

/**
 * Rebuilds authority from the pinned registry and rejects any changed message,
 * manifest, compiled snapshot, extra key, or cross-fixture replay.
 */
export async function validateNovelSkillPaidEvaluationPayloadAuthority(
  payloadValue: unknown,
  inputValue: unknown,
): Promise<NovelSkillPaidEvaluationAuthoritativePayload> {
  assertExactObjectKeys(
    payloadValue,
    ["messages", "manifest", "manifestHash", "compiledSkills"],
    "authoritative payload",
  );
  const payload = payloadValue as unknown as NovelSkillPaidEvaluationAuthoritativePayload;
  assertHash(payload.manifestHash, "manifest hash");
  const suppliedManifestHash = await hashNovelSkillPaidEvaluationAuthorityManifest(
    payload.manifest,
  );
  if (suppliedManifestHash !== payload.manifestHash) {
    throw hashMismatch("The authority manifest hash does not match its fields.");
  }
  await hashNovelSkillPaidEvaluationMessages(payload.messages);
  const expected = await compileNovelSkillPaidEvaluationPayload(inputValue);
  if (canonicalJson(payload) !== canonicalJson(expected)) {
    throw new NovelSkillPaidEvaluationPayloadAuthorityError(
      "NOVEL_SKILL_PAID_PAYLOAD_MISMATCH",
      "The supplied payload is not the exact authority result for this cell.",
    );
  }
  return expected;
}

async function resolveVerifiedFixture(fixtureId: string): Promise<VerifiedFixture> {
  const fixtures = listNovelSkillEvaluationFixtures();
  if (fixtures.length !== 12) {
    throw fixtureMismatch("The built-in evaluation registry is not the fixed 12-fixture suite.");
  }
  let selected: VerifiedFixture | null = null;
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    const pinned = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY[index];
    if (fixture === undefined || pinned === undefined) {
      throw fixtureMismatch("The built-in evaluation registry is incomplete.");
    }
    const contractHash = await sha256Hex(canonicalJson(fixture));
    const inputContentHash = await sha256Hex(fixture.input);
    if (
      fixture.fixtureId !== pinned.fixtureId ||
      fixture.taskType !== pinned.taskType ||
      fixture.invocationMode !== pinned.invocationMode ||
      !sameStrings(fixture.genreTags, pinned.genreTags) ||
      !sameStrings(fixture.coverageDimensions, pinned.coverageDimensions) ||
      contractHash !== pinned.contractHash ||
      inputContentHash !== pinned.inputContentHash
    ) {
      throw fixtureMismatch("A built-in evaluation fixture no longer matches its pinned identity.");
    }
    if (fixture.fixtureId === fixtureId) {
      selected = Object.freeze({ fixture, contractHash, inputContentHash });
    }
  }
  if (selected === null) {
    throw fixtureMismatch("The requested fixture is not in the fixed built-in registry.");
  }
  return selected;
}

function contextLayersForFixture(
  fixture: NovelSkillEvaluationFixture,
): readonly NovelSkillContextLayer[] {
  const requested = new Set<NovelSkillContextLayer>([
    "locked_hard_rules",
    "current_task",
    "scene_goal",
  ]);
  const coverage = new Set(fixture.coverageDimensions);
  if (coverage.has("pov")) requested.add("pov_known_information");
  return Object.freeze(NOVEL_SKILL_CONTEXT_LAYERS.filter((layer) => requested.has(layer)));
}

function estimateFixtureLayerTokens(
  fixture: NovelSkillEvaluationFixture,
  layer: NovelSkillContextLayer,
): number {
  switch (layer) {
    case "current_task":
      return conservativeTokenUpperBound(fixture.input);
    case "locked_hard_rules":
      return conservativeTokenUpperBound(
        canonicalJson({ lockedFacts: fixture.lockedFacts, boundaries: fixture.boundaries }),
      );
    case "scene_goal":
      return conservativeTokenUpperBound(fixture.requestedOutcome);
    case "pov_known_information":
      return conservativeTokenUpperBound(canonicalJson(fixture.lockedFacts));
    default:
      throw invalid("The fixed fixture projected an unsupported context layer.");
  }
}

async function definitionsForArm(
  arm: NovelSkillEvaluationArm,
): Promise<readonly NovelSkillDefinition[]> {
  if (arm === "no_skill") return Object.freeze([]);
  const core = await createCoreNovelSkillDefinitions();
  if (arm === "core") return Object.freeze([...core]);
  const genre = await createGenreNovelSkillDefinitions();
  return Object.freeze([...core, ...genre]);
}

async function armConfigurationHash(definitions: readonly NovelSkillDefinition[]): Promise<string> {
  const manifest = definitions
    .map(({ skillId, version, definitionHash, kind }) => ({
      skillId,
      version,
      definitionHash,
      kind,
    }))
    .sort((left, right) =>
      `${left.skillId}/${left.version}`.localeCompare(`${right.skillId}/${right.version}`, "en"),
    );
  if (
    manifest.length < 1 ||
    manifest.length > 64 ||
    new Set(manifest.map(({ skillId }) => skillId)).size !== manifest.length
  ) {
    throw invalid("The immutable built-in definition manifest is invalid.");
  }
  return sha256Hex(canonicalJson(manifest));
}

async function compileArmSkills(
  cell: NovelSkillPaidEvaluationCellPayloadIdentity,
  baseline: NovelSkillPaidEvaluationContextBaselineProjection,
  definitions: readonly NovelSkillDefinition[],
): Promise<CompiledNovelSkills> {
  const genres = (await resolveVerifiedFixture(cell.fixtureId)).fixture.genreTags;
  return compileNovelSkillPaidEvaluationArmSkills({
    projectId: cell.suiteId,
    taskType: cell.taskType,
    invocationMode: cell.invocationMode,
    maximumSkillTokens: MAXIMUM_SKILL_TOKENS,
    genreTags: genres,
    availableContextLayers: baseline.availableContextLayers,
    definitions,
  });
}

export async function compileNovelSkillPaidEvaluationArmSkills(input: {
  readonly projectId: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly maximumSkillTokens: number;
  readonly genreTags: readonly string[];
  readonly availableContextLayers: readonly NovelSkillContextLayer[];
  readonly definitions: readonly NovelSkillDefinition[];
}): Promise<CompiledNovelSkills> {
  const fixedSkillIds = input.definitions.map(({ skillId }) => skillId);
  const compiled = await compileFixedNovelSkillEvaluationArm({
    ...input,
    explicitSkillIds: fixedSkillIds,
    allowExperimental: true,
    bindings: [],
  });
  if (
    !isFixedNovelSkillEvaluationConfiguration(compiled.configuration) ||
    compiled.configuration.bindings.length !== 0 ||
    !sameStrings(compiled.configuration.explicitSkillIds, [...fixedSkillIds].sort(compareText)) ||
    compiled.items.some(({ activationSource }) => activationSource !== "explicit")
  ) {
    throw invalid("The built-in Novel Skill compiler did not reproduce the bounded fixed arm.");
  }
  return compiled;
}

function buildMessages(
  fixture: NovelSkillEvaluationFixture,
  renderedSkillSection: string | null,
  renderedPreferenceSection: string | null,
): readonly NativeModelMessage[] {
  const userContent = [
    PROMPT_TEMPLATE_SPECIFICATION.taskOpening,
    `language: ${fixture.language}`,
    `task_type: ${fixture.taskType}`,
    `invocation_mode: ${fixture.invocationMode}`,
    PROMPT_TEMPLATE_SPECIFICATION.inputOpening,
    fixture.input,
    PROMPT_TEMPLATE_SPECIFICATION.inputClosing,
    PROMPT_TEMPLATE_SPECIFICATION.factsOpening,
    ...fixture.lockedFacts.map((fact) => `- ${fact}`),
    PROMPT_TEMPLATE_SPECIFICATION.factsClosing,
    PROMPT_TEMPLATE_SPECIFICATION.boundariesOpening,
    ...fixture.boundaries.map((boundary) => `- ${boundary}`),
    PROMPT_TEMPLATE_SPECIFICATION.boundariesClosing,
    PROMPT_TEMPLATE_SPECIFICATION.outcomeOpening,
    fixture.requestedOutcome,
    PROMPT_TEMPLATE_SPECIFICATION.outcomeClosing,
    PROMPT_TEMPLATE_SPECIFICATION.taskClosing,
    ...(renderedSkillSection === null ? [] : [renderedSkillSection]),
    ...(renderedPreferenceSection === null ? [] : [renderedPreferenceSection]),
  ].join("\n");
  return Object.freeze([
    Object.freeze({
      role: "system" as const,
      content: PROMPT_TEMPLATE_SPECIFICATION.systemInstruction,
    }),
    Object.freeze({ role: "user" as const, content: userContent }),
  ]);
}

function renderPreferenceSection(
  sources: readonly NovelSkillPaidEvaluationPreferenceSource[],
): string {
  return [
    "<writing_preferences>",
    ...sources.map(({ preferenceText }) => `- ${preferenceText}`),
    "</writing_preferences>",
  ].join("\n");
}

async function normalizePreferenceForArm(
  arm: NovelSkillEvaluationArm,
  value: NovelSkillPaidEvaluationPreferenceProjection | null,
): Promise<NovelSkillPaidEvaluationPreferenceProjection | null> {
  if (arm !== "core_genre_preferences") {
    if (value !== null) {
      throw invalid("Only the preference arm may contain a preference projection.");
    }
    return null;
  }
  if (value === null) {
    throw invalid("The preference arm requires its exact sealed preference projection.");
  }
  const expected = await createNovelSkillPaidEvaluationPreferenceProjection(value.sources);
  assertExactObjectKeys(
    value,
    ["schemaVersion", "version", "configurationHash", "sourceManifestHash", "sources"],
    "preference projection",
  );
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw hashMismatch("The preference projection does not match its bounded sources.");
  }
  return expected;
}

async function assertPromptTemplateProjection(
  value: NovelSkillPaidEvaluationPromptTemplateProjection,
): Promise<void> {
  assertExactObjectKeys(value, ["version", "hash"], "prompt template projection");
  const expected = await createNovelSkillPaidEvaluationPromptTemplateProjection();
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw hashMismatch("The prompt template projection is not the frozen paid template.");
  }
}

async function assertContextBaselineProjection(
  value: NovelSkillPaidEvaluationContextBaselineProjection,
  verified: VerifiedFixture,
): Promise<void> {
  assertExactObjectKeys(
    value,
    [
      "schemaVersion",
      "version",
      "fixtureId",
      "baselineContractHash",
      "includedSourceManifestHash",
      "omittedSourceManifestHash",
      "compiledBaselineHash",
      "baselineTokenBudget",
      "availableContextLayers",
      "traceBaseline",
    ],
    "context baseline projection",
  );
  assertTraceBaselineProjection(value.traceBaseline);
  const expected = await createNovelSkillPaidEvaluationContextBaselineProjection(
    verified.fixture.fixtureId,
    value.baselineTokenBudget,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw hashMismatch("The context baseline does not match the pinned fixture projection.");
  }
}

async function hashContextBaselineProjection(
  value: NovelSkillPaidEvaluationContextBaselineProjection,
): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

async function hashPreferenceProjection(
  value: NovelSkillPaidEvaluationPreferenceProjection,
): Promise<string> {
  const evidence = await preferenceEvidence(value.sources);
  return sha256Hex(
    canonicalJson({
      schemaVersion: value.schemaVersion,
      version: value.version,
      configurationHash: value.configurationHash,
      sourceManifestHash: value.sourceManifestHash,
      evidence,
    }),
  );
}

async function preferenceEvidence(
  sources: readonly NovelSkillPaidEvaluationPreferenceSource[],
): Promise<readonly PreferenceEvidenceProjection[]> {
  return Promise.all(
    [...sources].sort(comparePreferenceSources).map(async (source) => ({
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      contentHash: await sha256Hex(source.preferenceText),
    })),
  );
}

async function hashCompiledSkills(compiled: CompiledNovelSkills): Promise<string> {
  return sha256Hex(
    canonicalJson({
      compilerVersion: compiled.compilerVersion,
      configuration: compiled.configuration,
      selectionHash: compiled.selectionHash,
      items: compiled.items,
      selectedDefinitions: compiled.selectedDefinitions.map(
        ({ skillId, version, definitionHash }) => ({ skillId, version, definitionHash }),
      ),
      usedSkillTokens: compiled.usedSkillTokens,
      discardedSkillTokens: compiled.discardedSkillTokens,
      instructionRules: compiled.instructionRules,
      outputKinds: compiled.outputKinds,
      outputRules: compiled.outputRules,
      validationRules: compiled.validationRules,
      renderedSection: renderNovelSkillPromptSection(compiled),
    }),
  );
}

function normalizeCompileInput(value: unknown): CompileNovelSkillPaidEvaluationPayloadInput {
  assertExactObjectKeys(
    value,
    ["cell", "promptTemplate", "contextBaseline", "preferenceProjection"],
    "payload compile input",
  );
  const input = value as unknown as CompileNovelSkillPaidEvaluationPayloadInput;
  normalizeCell(input.cell);
  assertExactObjectKeys(input.promptTemplate, ["version", "hash"], "prompt template projection");
  assertExactObjectKeys(
    input.contextBaseline,
    [
      "schemaVersion",
      "version",
      "fixtureId",
      "baselineContractHash",
      "includedSourceManifestHash",
      "omittedSourceManifestHash",
      "compiledBaselineHash",
      "baselineTokenBudget",
      "availableContextLayers",
      "traceBaseline",
    ],
    "context baseline projection",
  );
  assertTraceBaselineProjection(input.contextBaseline.traceBaseline);
  if (input.preferenceProjection !== null) {
    assertExactObjectKeys(
      input.preferenceProjection,
      ["schemaVersion", "version", "configurationHash", "sourceManifestHash", "sources"],
      "preference projection",
    );
    if (!Array.isArray(input.preferenceProjection.sources)) {
      throw invalid("Preference projection sources must be an array.");
    }
    for (const source of input.preferenceProjection.sources) normalizePreferenceSource(source);
  }
  return input;
}

function assertTraceBaselineProjection(
  value: unknown,
): asserts value is NovelSkillPaidEvaluationTraceBaselineProjection {
  assertExactObjectKeys(
    value,
    [
      "version",
      "taskType",
      "maximumContextTokens",
      "requiredTokens",
      "usedTokens",
      "remainingTokens",
      "discardedTokens",
      "tokenEstimateSource",
      "entries",
    ],
    "trace baseline projection",
  );
  const raw = value;
  if (
    raw.version !== "novel-skill-paid-evaluation-trace-baseline@1" ||
    raw.tokenEstimateSource !== "utf8_conservative" ||
    raw.discardedTokens !== 0 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length < 1 ||
    raw.entries.length > NOVEL_SKILL_CONTEXT_LAYERS.length
  ) {
    throw invalid("The trace baseline projection is outside the fixed contract.");
  }
  const entries: readonly unknown[] = raw.entries;
  for (const [valueToCheck, label] of [
    [raw.maximumContextTokens, "trace maximum context tokens"],
    [raw.requiredTokens, "trace required tokens"],
    [raw.usedTokens, "trace used tokens"],
    [raw.remainingTokens, "trace remaining tokens"],
  ] as const) {
    assertSafeInteger(valueToCheck, 0, 1_000_000_000, label);
  }
  if (
    raw.requiredTokens !== raw.usedTokens ||
    (raw.usedTokens as number) + (raw.remainingTokens as number) !== raw.maximumContextTokens
  ) {
    throw invalid("The trace baseline token accounting is inconsistent.");
  }
  for (const [entryIndex, entryValue] of entries.entries()) {
    assertExactObjectKeys(
      entryValue,
      [
        "contextCandidateId",
        "layer",
        "selectionReason",
        "included",
        "discardedReason",
        "estimatedTokens",
        "evaluationOrder",
        "layerOrder",
        "priority",
        "relevanceScore",
        "required",
        "budgetRemainingBefore",
        "budgetRemainingAfter",
        "sources",
      ],
      "trace baseline entry",
    );
    if (
      typeof entryValue.contextCandidateId !== "string" ||
      !PORTABLE_SOURCE_ID_PATTERN.test(entryValue.contextCandidateId) ||
      !NOVEL_SKILL_CONTEXT_LAYERS.includes(entryValue.layer as NovelSkillContextLayer) ||
      entryValue.selectionReason !== "fixed_evaluation_context" ||
      entryValue.included !== true ||
      entryValue.discardedReason !== null ||
      entryValue.evaluationOrder !== entryIndex + 1 ||
      entryValue.relevanceScore !== null ||
      entryValue.required !== true ||
      !Array.isArray(entryValue.sources) ||
      entryValue.sources.length !== 1
    ) {
      throw invalid("A trace baseline entry is outside the fixed contract.");
    }
    const sources: readonly unknown[] = entryValue.sources;
    for (const [valueToCheck, label] of [
      [entryValue.estimatedTokens, "entry estimated tokens"],
      [entryValue.layerOrder, "entry layer order"],
      [entryValue.priority, "entry priority"],
      [entryValue.budgetRemainingBefore, "entry budget before"],
      [entryValue.budgetRemainingAfter, "entry budget after"],
    ] as const) {
      assertSafeInteger(valueToCheck, 0, 1_000_000_000, label);
    }
    const sourceValue = sources[0];
    assertExactObjectKeys(
      sourceValue,
      ["sourceOrder", "sourceType", "sourceId", "sourceVersionId", "locator", "contentHash"],
      "trace baseline source",
    );
    if (
      sourceValue.sourceOrder !== 1 ||
      sourceValue.sourceType !== "user_input" ||
      typeof sourceValue.sourceId !== "string" ||
      !PORTABLE_SOURCE_ID_PATTERN.test(sourceValue.sourceId) ||
      sourceValue.sourceVersionId !== null ||
      !["novel_skill_evaluation_fixture", "novel_skill_evaluation_fixture_contract"].includes(
        sourceValue.locator as string,
      )
    ) {
      throw invalid("A trace baseline source is outside the fixed contract.");
    }
    assertHash(sourceValue.contentHash, "trace baseline source content hash");
  }
}

function normalizeCell(value: unknown): NovelSkillPaidEvaluationCellPayloadIdentity {
  assertExactObjectKeys(
    value,
    [
      "runId",
      "suiteId",
      "cellId",
      "fixtureId",
      "fixtureInputContentHash",
      "taskType",
      "invocationMode",
      "arm",
      "armConfigurationHash",
      "modelSlotId",
      "repetition",
    ],
    "cell identity",
  );
  const raw = value;
  const cell = value as unknown as NovelSkillPaidEvaluationCellPayloadIdentity;
  assertUuidV7(cell.runId, "run ID");
  assertUuidV7(cell.suiteId, "suite ID");
  assertUuidV7(cell.cellId, "cell ID");
  assertPortableFixtureId(cell.fixtureId);
  assertHash(cell.fixtureInputContentHash, "fixture input hash");
  assertEvaluationArm(cell.arm);
  if (cell.armConfigurationHash !== null) {
    assertHash(cell.armConfigurationHash, "arm configuration hash");
  }
  if (!(["text_tier_a", "text_tier_b"] as readonly unknown[]).includes(raw.modelSlotId)) {
    throw invalid("The model slot is outside the fixed two-slot matrix.");
  }
  if (raw.repetition !== 1 && raw.repetition !== 2) {
    throw invalid("The repetition is outside the fixed two-pass matrix.");
  }
  return cell;
}

function normalizePreferenceSource(value: unknown): NovelSkillPaidEvaluationPreferenceSource {
  assertExactObjectKeys(
    value,
    ["sourceId", "sourceVersionId", "preferenceText"],
    "preference source",
  );
  const source = value as unknown as NovelSkillPaidEvaluationPreferenceSource;
  if (
    typeof source.sourceId !== "string" ||
    !PORTABLE_SOURCE_ID_PATTERN.test(source.sourceId) ||
    (source.sourceVersionId !== null &&
      (typeof source.sourceVersionId !== "string" ||
        !PORTABLE_SOURCE_ID_PATTERN.test(source.sourceVersionId))) ||
    typeof source.preferenceText !== "string" ||
    source.preferenceText !== source.preferenceText.trim() ||
    source.preferenceText.length < 1 ||
    Array.from(source.preferenceText).length > 2_000 ||
    CONTROL_CHARACTER_PATTERN.test(source.preferenceText)
  ) {
    throw invalid("A preference source contains invalid or unbounded data.");
  }
  return Object.freeze({
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    preferenceText: source.preferenceText,
  });
}

function normalizeMessages(value: unknown): readonly NativeModelMessage[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalid("The paid payload must contain exactly one system and one user message.");
  }
  const messages = value.map((messageValue, index) => {
    assertExactObjectKeys(messageValue, ["role", "content"], "model message");
    const message = messageValue as unknown as NativeModelMessage;
    const expectedRole = index === 0 ? "system" : "user";
    if (
      message.role !== expectedRole ||
      typeof message.content !== "string" ||
      message.content.length < 1 ||
      CONTROL_CHARACTER_PATTERN.test(message.content)
    ) {
      throw invalid("The paid payload contains an invalid model message.");
    }
    return Object.freeze({ role: message.role, content: message.content });
  });
  return Object.freeze(messages);
}

function normalizeManifest(value: unknown): NovelSkillPaidEvaluationPayloadAuthorityManifest {
  const keys = [
    "schemaVersion",
    "authorityVersion",
    "runId",
    "suiteId",
    "cellId",
    "fixtureId",
    "fixtureContractHash",
    "fixtureInputContentHash",
    "taskType",
    "invocationMode",
    "genreTagsHash",
    "coverageDimensionsHash",
    "arm",
    "armConfigurationHash",
    "modelSlotId",
    "repetition",
    "promptTemplateVersion",
    "promptTemplateHash",
    "contextBaselineHash",
    "contextBaselineProjectionHash",
    "availableContextLayersHash",
    "skillCompilerVersion",
    "skillSelectionHash",
    "compiledSkillSnapshotHash",
    "renderedSkillSectionHash",
    "preferenceConfigurationHash",
    "preferenceProjectionHash",
    "renderedPreferenceSectionHash",
    "baseMessagePayloadHash",
    "messagePayloadHash",
  ] as const;
  assertExactObjectKeys(value, keys, "payload authority manifest");
  const raw = value;
  const manifest = value as unknown as NovelSkillPaidEvaluationPayloadAuthorityManifest;
  if (
    raw.schemaVersion !== 1 ||
    raw.authorityVersion !== NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION ||
    raw.promptTemplateVersion !== NOVEL_SKILL_PAID_EVALUATION_PROMPT_TEMPLATE_VERSION ||
    raw.skillCompilerVersion !== NOVEL_SKILL_COMPILER_VERSION
  ) {
    throw invalid("The payload authority manifest uses an unsupported version.");
  }
  assertUuidV7(manifest.runId, "manifest run ID");
  assertUuidV7(manifest.suiteId, "manifest suite ID");
  assertUuidV7(manifest.cellId, "manifest cell ID");
  assertPortableFixtureId(manifest.fixtureId);
  assertEvaluationArm(manifest.arm);
  for (const [hash, label] of [
    [manifest.fixtureContractHash, "fixture contract hash"],
    [manifest.fixtureInputContentHash, "fixture input hash"],
    [manifest.genreTagsHash, "genre tags hash"],
    [manifest.coverageDimensionsHash, "coverage dimensions hash"],
    [manifest.promptTemplateHash, "prompt template hash"],
    [manifest.contextBaselineHash, "context baseline hash"],
    [manifest.contextBaselineProjectionHash, "context baseline projection hash"],
    [manifest.availableContextLayersHash, "context layer hash"],
    [manifest.baseMessagePayloadHash, "base payload hash"],
    [manifest.messagePayloadHash, "message payload hash"],
  ] as const) {
    assertHash(hash, label);
  }
  for (const [hash, label] of [
    [manifest.armConfigurationHash, "arm configuration hash"],
    [manifest.skillSelectionHash, "skill selection hash"],
    [manifest.compiledSkillSnapshotHash, "compiled Skill snapshot hash"],
    [manifest.renderedSkillSectionHash, "rendered Skill section hash"],
    [manifest.preferenceConfigurationHash, "preference configuration hash"],
    [manifest.preferenceProjectionHash, "preference projection hash"],
    [manifest.renderedPreferenceSectionHash, "rendered preference section hash"],
  ] as const) {
    if (hash !== null) assertHash(hash, label);
  }
  const hasSkills = manifest.arm !== "no_skill";
  const hasPreferences = manifest.arm === "core_genre_preferences";
  if (
    (hasSkills &&
      (manifest.armConfigurationHash === null ||
        manifest.skillSelectionHash === null ||
        manifest.compiledSkillSnapshotHash === null)) ||
    (!hasSkills &&
      (manifest.armConfigurationHash !== null ||
        manifest.skillSelectionHash !== null ||
        manifest.compiledSkillSnapshotHash !== null ||
        manifest.renderedSkillSectionHash !== null)) ||
    (hasPreferences &&
      (manifest.preferenceConfigurationHash === null ||
        manifest.preferenceProjectionHash === null ||
        manifest.renderedPreferenceSectionHash === null)) ||
    (!hasPreferences &&
      (manifest.preferenceConfigurationHash !== null ||
        manifest.preferenceProjectionHash !== null ||
        manifest.renderedPreferenceSectionHash !== null)) ||
    !(["text_tier_a", "text_tier_b"] as readonly unknown[]).includes(raw.modelSlotId) ||
    (raw.repetition !== 1 && raw.repetition !== 2)
  ) {
    throw invalid("The authority manifest has inconsistent arm fields.");
  }
  return manifest;
}

function assertCellMatchesFixture(
  cell: NovelSkillPaidEvaluationCellPayloadIdentity,
  verified: VerifiedFixture,
): void {
  if (
    cell.fixtureInputContentHash !== verified.inputContentHash ||
    cell.taskType !== verified.fixture.taskType ||
    cell.invocationMode !== verified.fixture.invocationMode
  ) {
    throw fixtureMismatch("The cell identity does not match its pinned built-in fixture.");
  }
  if (
    (cell.arm === "no_skill" && cell.armConfigurationHash !== null) ||
    (cell.arm !== "no_skill" && cell.armConfigurationHash === null)
  ) {
    throw fixtureMismatch("The cell arm configuration is inconsistent with its arm.");
  }
}

function comparePreferenceSources(
  left: NovelSkillPaidEvaluationPreferenceSource,
  right: NovelSkillPaidEvaluationPreferenceSource,
): number {
  return `${left.sourceId}/${left.sourceVersionId ?? ""}`.localeCompare(
    `${right.sourceId}/${right.sourceVersionId ?? ""}`,
    "en",
  );
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function assertExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ) {
    throw invalid(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (!sameStrings(actual, expected)) {
    throw invalid(`${label} contains missing or unsupported fields.`);
  }
}

function assertUuidV7(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
    throw invalid(`${label} must be a canonical UUIDv7.`);
  }
}

function assertPortableFixtureId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{2,95}$/u.test(value)) {
    throw invalid("The fixture ID is not a bounded built-in locator.");
  }
}

function assertEvaluationArm(value: unknown): asserts value is NovelSkillEvaluationArm {
  if (
    !(["no_skill", "core", "core_genre", "core_genre_preferences"] as const).includes(
      value as NovelSkillEvaluationArm,
    )
  ) {
    throw invalid("The evaluation arm is not part of the fixed matrix.");
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw invalid(`${label} must be a lowercase SHA-256 value.`);
  }
}

function assertSafeInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(`${label} is outside its safe range.`);
  }
}

function conservativeTokenUpperBound(value: string): number {
  return new TextEncoder().encode(value).length;
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(message: string): NovelSkillPaidEvaluationPayloadAuthorityError {
  return new NovelSkillPaidEvaluationPayloadAuthorityError(
    "NOVEL_SKILL_PAID_PAYLOAD_INVALID",
    message,
  );
}

function fixtureMismatch(message: string): NovelSkillPaidEvaluationPayloadAuthorityError {
  return new NovelSkillPaidEvaluationPayloadAuthorityError(
    "NOVEL_SKILL_PAID_PAYLOAD_FIXTURE_MISMATCH",
    message,
  );
}

function hashMismatch(message: string): NovelSkillPaidEvaluationPayloadAuthorityError {
  return new NovelSkillPaidEvaluationPayloadAuthorityError(
    "NOVEL_SKILL_PAID_PAYLOAD_HASH_MISMATCH",
    message,
  );
}
