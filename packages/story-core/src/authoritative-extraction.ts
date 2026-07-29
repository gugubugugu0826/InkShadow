import { StoryCoreError } from "./errors.js";
import { FORMAL_RECORD_KINDS, type FormalRecordKind } from "./formal-record.js";
import { err, ok, type Result } from "./result.js";
import {
  cloneStoryValue,
  createEvidence,
  createStoryValue,
  storyValuesEqual,
  type Evidence,
  type StoryValue,
} from "./safety.js";
import {
  parseSafeIdentifier,
  parseUuidV7,
  type SafeIdentifier,
  type UuidV7,
} from "./value-objects.js";

export const AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION =
  "inkshadow.authoritative-extraction.v1" as const;
export const AUTHORITATIVE_EXTRACTION_MAX_RESPONSE_BYTES = 1_048_576;
export const AUTHORITATIVE_EXTRACTION_MAX_CANDIDATES = 128;
export const AUTHORITATIVE_EXTRACTION_MAX_SOURCE_LENGTH = 5_000_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const EXACT_ROOT_KEYS = [
  "candidates",
  "evaluationVersion",
  "model",
  "prompt",
  "schemaVersion",
  "source",
] as const;
const EXACT_SOURCE_KEYS = [
  "chapterId",
  "checksumSha256",
  "projectId",
  "scope",
  "versionId",
] as const;
const EXACT_SCOPE_KEYS = ["end", "sourceLength", "start"] as const;
const EXACT_PROMPT_KEYS = ["checksumSha256", "registryId", "version"] as const;
const EXACT_MODEL_KEYS = ["id", "provider", "revision"] as const;
const EXACT_CANDIDATE_KEYS = [
  "category",
  "confidence",
  "evidence",
  "key",
  "originalValue",
  "severity",
  "suggestedValue",
  "target",
] as const;
const EXACT_TARGET_KEYS = ["expectedRevision", "kind", "recordId"] as const;
const EXACT_EVIDENCE_KEYS = ["end", "excerpt", "start"] as const;

export const AUTHORITATIVE_EXTRACTION_SEVERITIES = ["info", "warning", "error"] as const;
export type AuthoritativeExtractionSeverity = (typeof AUTHORITATIVE_EXTRACTION_SEVERITIES)[number];

export interface AuthoritativeExtractionScope {
  readonly start: number;
  readonly end: number;
  readonly sourceLength: number;
}

export interface AuthoritativeExtractionSource {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly versionId: UuidV7;
  readonly checksumSha256: string;
  readonly scope: AuthoritativeExtractionScope;
}

export interface AuthoritativePromptSnapshot {
  readonly registryId: SafeIdentifier;
  readonly version: number;
  readonly checksumSha256: string;
}

export interface AuthoritativeModelSnapshot {
  readonly provider: string;
  readonly id: string;
  readonly revision: string;
}

export interface AuthoritativeExtractionProvenance {
  readonly prompt: AuthoritativePromptSnapshot;
  readonly model: AuthoritativeModelSnapshot;
  readonly evaluationVersion: SafeIdentifier;
}

export interface AuthoritativeExtractionTargetBaseline {
  readonly recordId: UuidV7;
  readonly kind: FormalRecordKind;
  readonly expectedRevision: number;
  readonly value: StoryValue;
}

export interface AuthoritativeExtractionCandidate {
  readonly key: SafeIdentifier;
  readonly target: Readonly<{
    recordId: UuidV7;
    kind: FormalRecordKind;
    expectedRevision: number;
  }>;
  readonly category: SafeIdentifier;
  readonly severity: AuthoritativeExtractionSeverity;
  readonly confidence: number;
  readonly originalValue: StoryValue;
  readonly suggestedValue: StoryValue;
  readonly evidence: Evidence;
}

export interface AuthoritativeExtractionEnvelope {
  readonly schemaVersion: typeof AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION;
  readonly source: AuthoritativeExtractionSource;
  readonly prompt: AuthoritativePromptSnapshot;
  readonly model: AuthoritativeModelSnapshot;
  readonly evaluationVersion: SafeIdentifier;
  readonly candidates: readonly AuthoritativeExtractionCandidate[];
}

export interface AuthoritativeExtractionValidationContext {
  readonly source: AuthoritativeExtractionSource;
  /**
   * Full current chapter content. It is used only in memory to prove exact
   * evidence offsets and is never part of the durable queue contract.
   */
  readonly chapterContent: string;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly targets: readonly AuthoritativeExtractionTargetBaseline[];
}

export interface AuthoritativeExtractionGoldenThresholds {
  readonly minimumPrecision: number;
  readonly minimumRecall: number;
}

export interface AuthoritativeExtractionMetrics {
  readonly truePositiveCount: number;
  readonly falsePositiveCount: number;
  readonly falseNegativeCount: number;
  readonly predictedCount: number;
  readonly expectedCount: number;
  readonly precision: number;
  readonly recall: number;
  readonly passed: boolean;
}

/**
 * Provider-facing output instruction. It deliberately asks for no prose or
 * Markdown and makes the publication boundary explicit: output is review-only.
 */
export function buildAuthoritativeExtractionOutputInstruction(
  context: Pick<AuthoritativeExtractionValidationContext, "source" | "provenance">,
): string {
  return [
    "Return exactly one JSON object and no Markdown, prose, comments, or code fences.",
    `schemaVersion must equal ${AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION}.`,
    "Every result is a candidate for human review; never claim that formal story state was changed.",
    "Echo the supplied source, prompt, model, and evaluationVersion fields exactly.",
    "Evidence start/end offsets are UTF-16 indexes into the full chapter and excerpt must equal that exact slice.",
    "Use only supplied target record IDs, kinds, revisions, and original values.",
    `source=${canonicalJson(context.source)}`,
    `prompt=${canonicalJson(context.provenance.prompt)}`,
    `model=${canonicalJson(context.provenance.model)}`,
    `evaluationVersion=${JSON.stringify(context.provenance.evaluationVersion)}`,
    "Root keys: schemaVersion,source,prompt,model,evaluationVersion,candidates.",
    "Candidate keys: key,target,category,severity,confidence,originalValue,suggestedValue,evidence.",
  ].join("\n");
}

export function validateAuthoritativeExtractionSource(
  source: AuthoritativeExtractionSource,
): Result<AuthoritativeExtractionSource, StoryCoreError> {
  return parseSource(source);
}

export function validateAuthoritativeExtractionProvenance(
  provenance: AuthoritativeExtractionProvenance,
): Result<AuthoritativeExtractionProvenance, StoryCoreError> {
  const prompt = parsePrompt(provenance.prompt);
  if (!prompt.ok) {
    return prompt;
  }
  const model = parseModel(provenance.model);
  if (!model.ok) {
    return model;
  }
  const evaluationVersion = parseIdentifier(provenance.evaluationVersion, "evaluationVersion");
  if (!evaluationVersion.ok) {
    return evaluationVersion;
  }
  return ok(
    Object.freeze({
      prompt: Object.freeze({ ...prompt.value }),
      model: Object.freeze({ ...model.value }),
      evaluationVersion: evaluationVersion.value,
    }),
  );
}

/**
 * Strict protocol parser. Unknown keys, duplicate semantic candidates,
 * mismatched provenance, stale target baselines, and forged evidence all fail
 * closed before anything can enter the review repository.
 */
export function parseAuthoritativeExtractionOutput(
  raw: string,
  context: AuthoritativeExtractionValidationContext,
): Result<AuthoritativeExtractionEnvelope, StoryCoreError> {
  const validatedContext = validateContext(context);
  if (!validatedContext.ok) {
    return validatedContext;
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    new TextEncoder().encode(raw).byteLength > AUTHORITATIVE_EXTRACTION_MAX_RESPONSE_BYTES
  ) {
    return outputError("Provider output is empty or exceeds the extraction response limit.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return outputError("Provider output must be one valid JSON object without code fences.");
  }
  const root = exactObject(decoded, EXACT_ROOT_KEYS, "root");
  if (!root.ok) {
    return root;
  }
  if (root.value.schemaVersion !== AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION) {
    return outputError("Extraction schemaVersion is unsupported.");
  }

  const source = parseSource(root.value.source);
  if (!source.ok) {
    return source;
  }
  const prompt = parsePrompt(root.value.prompt);
  if (!prompt.ok) {
    return prompt;
  }
  const model = parseModel(root.value.model);
  if (!model.ok) {
    return model;
  }
  const evaluationVersion = parseIdentifier(root.value.evaluationVersion, "evaluationVersion");
  if (!evaluationVersion.ok) {
    return evaluationVersion;
  }
  if (
    canonicalJson(source.value) !== canonicalJson(validatedContext.value.source) ||
    canonicalJson(prompt.value) !== canonicalJson(validatedContext.value.provenance.prompt) ||
    canonicalJson(model.value) !== canonicalJson(validatedContext.value.provenance.model) ||
    evaluationVersion.value !== validatedContext.value.provenance.evaluationVersion
  ) {
    return outputError("Provider output provenance does not match the authorized request.");
  }

  if (
    !Array.isArray(root.value.candidates) ||
    root.value.candidates.length > AUTHORITATIVE_EXTRACTION_MAX_CANDIDATES
  ) {
    return outputError("Extraction candidates must be a bounded array.");
  }
  const targetBaselines = new Map(
    validatedContext.value.targets.map((target) => [target.recordId, target] as const),
  );
  const keys = new Set<string>();
  const semanticIdentities = new Set<string>();
  const candidates: AuthoritativeExtractionCandidate[] = [];
  for (const rawCandidate of root.value.candidates) {
    const candidate = parseCandidate(rawCandidate, validatedContext.value, targetBaselines);
    if (!candidate.ok) {
      return candidate;
    }
    const identity = authoritativeExtractionCandidateIdentity(candidate.value);
    if (keys.has(candidate.value.key) || semanticIdentities.has(identity)) {
      return outputError("Extraction output contains a duplicate candidate.");
    }
    keys.add(candidate.value.key);
    semanticIdentities.add(identity);
    candidates.push(candidate.value);
  }

  return ok(
    Object.freeze({
      schemaVersion: AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION,
      source: cloneSource(source.value),
      prompt: Object.freeze({ ...prompt.value }),
      model: Object.freeze({ ...model.value }),
      evaluationVersion: evaluationVersion.value,
      candidates: Object.freeze(candidates),
    }),
  );
}

export function evaluateAuthoritativeExtractionCandidates(
  predicted: readonly AuthoritativeExtractionCandidate[],
  expected: readonly AuthoritativeExtractionCandidate[],
  thresholds: AuthoritativeExtractionGoldenThresholds,
): Result<AuthoritativeExtractionMetrics, StoryCoreError> {
  if (
    !isRatio(thresholds.minimumPrecision) ||
    !isRatio(thresholds.minimumRecall) ||
    predicted.length > AUTHORITATIVE_EXTRACTION_MAX_CANDIDATES ||
    expected.length > AUTHORITATIVE_EXTRACTION_MAX_CANDIDATES
  ) {
    return outputError("Golden evaluation thresholds or candidate counts are invalid.");
  }
  const predictedIds = new Set(predicted.map(authoritativeExtractionCandidateIdentity));
  const expectedIds = new Set(expected.map(authoritativeExtractionCandidateIdentity));
  if (predictedIds.size !== predicted.length || expectedIds.size !== expected.length) {
    return outputError("Golden evaluation candidates must be semantically unique.");
  }
  let truePositiveCount = 0;
  for (const identity of predictedIds) {
    if (expectedIds.has(identity)) {
      truePositiveCount += 1;
    }
  }
  const falsePositiveCount = predictedIds.size - truePositiveCount;
  const falseNegativeCount = expectedIds.size - truePositiveCount;
  const precision =
    predictedIds.size === 0 ? 1 : truePositiveCount / Math.max(1, predictedIds.size);
  const recall = expectedIds.size === 0 ? 1 : truePositiveCount / expectedIds.size;
  return ok(
    Object.freeze({
      truePositiveCount,
      falsePositiveCount,
      falseNegativeCount,
      predictedCount: predictedIds.size,
      expectedCount: expectedIds.size,
      precision,
      recall,
      passed: precision >= thresholds.minimumPrecision && recall >= thresholds.minimumRecall,
    }),
  );
}

export function authoritativeExtractionCandidateIdentity(
  candidate: AuthoritativeExtractionCandidate,
): string {
  return canonicalJson({
    category: candidate.category,
    evidence: {
      end: candidate.evidence.range.end,
      excerpt: candidate.evidence.excerpt,
      start: candidate.evidence.range.start,
    },
    suggestedValue: candidate.suggestedValue,
    target: candidate.target,
  });
}

function validateContext(
  context: AuthoritativeExtractionValidationContext,
): Result<AuthoritativeExtractionValidationContext, StoryCoreError> {
  const source = parseSource(context.source);
  if (!source.ok) {
    return source;
  }
  const prompt = parsePrompt(context.provenance.prompt);
  if (!prompt.ok) {
    return prompt;
  }
  const model = parseModel(context.provenance.model);
  if (!model.ok) {
    return model;
  }
  const evaluationVersion = parseIdentifier(
    context.provenance.evaluationVersion,
    "evaluationVersion",
  );
  if (!evaluationVersion.ok) {
    return evaluationVersion;
  }
  if (
    typeof context.chapterContent !== "string" ||
    context.chapterContent.length !== source.value.scope.sourceLength ||
    context.chapterContent.length > AUTHORITATIVE_EXTRACTION_MAX_SOURCE_LENGTH
  ) {
    return outputError("Extraction source length does not match the current chapter.");
  }

  const targets: AuthoritativeExtractionTargetBaseline[] = [];
  const targetIds = new Set<string>();
  for (const target of context.targets) {
    const recordId = parseUuidV7(target.recordId);
    const value = createStoryValue(target.value);
    if (
      !recordId.ok ||
      !value.ok ||
      !FORMAL_RECORD_KINDS.includes(target.kind) ||
      !Number.isSafeInteger(target.expectedRevision) ||
      target.expectedRevision < 1 ||
      targetIds.has(target.recordId)
    ) {
      return outputError("Extraction target baseline is invalid or duplicated.");
    }
    targetIds.add(recordId.value);
    targets.push(
      Object.freeze({
        recordId: recordId.value,
        kind: target.kind,
        expectedRevision: target.expectedRevision,
        value: cloneStoryValue(value.value),
      }),
    );
  }
  return ok({
    source: cloneSource(source.value),
    chapterContent: context.chapterContent,
    provenance: Object.freeze({
      prompt: Object.freeze({ ...prompt.value }),
      model: Object.freeze({ ...model.value }),
      evaluationVersion: evaluationVersion.value,
    }),
    targets: Object.freeze(targets),
  });
}

function parseSource(value: unknown): Result<AuthoritativeExtractionSource, StoryCoreError> {
  const source = exactObject(value, EXACT_SOURCE_KEYS, "source");
  if (!source.ok) {
    return source;
  }
  const projectId = parseProtocolUuid(source.value.projectId, "source.projectId");
  if (!projectId.ok) {
    return projectId;
  }
  const chapterId = parseProtocolUuid(source.value.chapterId, "source.chapterId");
  if (!chapterId.ok) {
    return chapterId;
  }
  const versionId = parseProtocolUuid(source.value.versionId, "source.versionId");
  if (!versionId.ok) {
    return versionId;
  }
  const checksum = parseSha256(source.value.checksumSha256, "source.checksumSha256");
  if (!checksum.ok) {
    return checksum;
  }
  const scope = parseScope(source.value.scope);
  if (!scope.ok) {
    return scope;
  }
  return ok(
    Object.freeze({
      projectId: projectId.value,
      chapterId: chapterId.value,
      versionId: versionId.value,
      checksumSha256: checksum.value,
      scope: scope.value,
    }),
  );
}

function parseScope(value: unknown): Result<AuthoritativeExtractionScope, StoryCoreError> {
  const scope = exactObject(value, EXACT_SCOPE_KEYS, "source.scope");
  if (!scope.ok) {
    return scope;
  }
  const { start, end, sourceLength } = scope.value;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(sourceLength) ||
    (sourceLength as number) < 1 ||
    (sourceLength as number) > AUTHORITATIVE_EXTRACTION_MAX_SOURCE_LENGTH ||
    (start as number) < 0 ||
    (end as number) <= (start as number) ||
    (end as number) > (sourceLength as number)
  ) {
    return outputError("Extraction source scope is invalid.");
  }
  return ok(
    Object.freeze({
      start: start as number,
      end: end as number,
      sourceLength: sourceLength as number,
    }),
  );
}

function parsePrompt(value: unknown): Result<AuthoritativePromptSnapshot, StoryCoreError> {
  const prompt = exactObject(value, EXACT_PROMPT_KEYS, "prompt");
  if (!prompt.ok) {
    return prompt;
  }
  const registryId = parseIdentifier(prompt.value.registryId, "prompt.registryId");
  const checksum = parseSha256(prompt.value.checksumSha256, "prompt.checksumSha256");
  if (
    !registryId.ok ||
    !checksum.ok ||
    !Number.isSafeInteger(prompt.value.version) ||
    (prompt.value.version as number) < 1
  ) {
    return outputError("Extraction prompt snapshot is invalid.");
  }
  return ok(
    Object.freeze({
      registryId: registryId.value,
      version: prompt.value.version as number,
      checksumSha256: checksum.value,
    }),
  );
}

function parseModel(value: unknown): Result<AuthoritativeModelSnapshot, StoryCoreError> {
  const model = exactObject(value, EXACT_MODEL_KEYS, "model");
  if (!model.ok) {
    return model;
  }
  if (
    typeof model.value.provider !== "string" ||
    typeof model.value.id !== "string" ||
    typeof model.value.revision !== "string" ||
    !MODEL_IDENTIFIER_PATTERN.test(model.value.provider) ||
    !MODEL_IDENTIFIER_PATTERN.test(model.value.id) ||
    !MODEL_IDENTIFIER_PATTERN.test(model.value.revision)
  ) {
    return outputError("Extraction model snapshot is invalid.");
  }
  return ok(
    Object.freeze({
      provider: model.value.provider,
      id: model.value.id,
      revision: model.value.revision,
    }),
  );
}

function parseCandidate(
  value: unknown,
  context: AuthoritativeExtractionValidationContext,
  baselines: ReadonlyMap<string, AuthoritativeExtractionTargetBaseline>,
): Result<AuthoritativeExtractionCandidate, StoryCoreError> {
  const candidate = exactObject(value, EXACT_CANDIDATE_KEYS, "candidate");
  if (!candidate.ok) {
    return candidate;
  }
  const key = parseIdentifier(candidate.value.key, "candidate.key");
  const category = parseIdentifier(candidate.value.category, "candidate.category");
  const target = exactObject(candidate.value.target, EXACT_TARGET_KEYS, "candidate.target");
  const evidenceInput = exactObject(
    candidate.value.evidence,
    EXACT_EVIDENCE_KEYS,
    "candidate.evidence",
  );
  if (!key.ok) {
    return key;
  }
  if (!category.ok) {
    return category;
  }
  if (!target.ok) {
    return target;
  }
  if (!evidenceInput.ok) {
    return evidenceInput;
  }
  const recordId = parseProtocolUuid(target.value.recordId, "candidate.target.recordId");
  if (!recordId.ok) {
    return recordId;
  }
  const baseline = baselines.get(recordId.value);
  if (
    baseline === undefined ||
    !FORMAL_RECORD_KINDS.includes(target.value.kind as FormalRecordKind) ||
    target.value.kind !== baseline.kind ||
    target.value.expectedRevision !== baseline.expectedRevision
  ) {
    return outputError("Extraction candidate target is not an authorized current baseline.");
  }
  if (
    !AUTHORITATIVE_EXTRACTION_SEVERITIES.includes(
      candidate.value.severity as AuthoritativeExtractionSeverity,
    ) ||
    !isRatio(candidate.value.confidence)
  ) {
    return outputError("Extraction candidate severity or confidence is invalid.");
  }
  const originalValue = createStoryValue(candidate.value.originalValue);
  const suggestedValue = createStoryValue(candidate.value.suggestedValue);
  if (!originalValue.ok || !suggestedValue.ok) {
    return outputError("Extraction candidate values do not match the target baseline.");
  }
  if (
    !storyValuesEqual(originalValue.value, baseline.value) ||
    storyValuesEqual(originalValue.value, suggestedValue.value)
  ) {
    return outputError("Extraction candidate values do not match the target baseline.");
  }

  const evidence = createEvidence({
    excerpt: evidenceInput.value.excerpt as string,
    start: evidenceInput.value.start as number,
    end: evidenceInput.value.end as number,
    sourceLength: context.source.scope.sourceLength,
  });
  if (!evidence.ok) {
    return outputError("Extraction candidate evidence range is invalid.");
  }
  if (
    evidence.value.range.start < context.source.scope.start ||
    evidence.value.range.end > context.source.scope.end ||
    context.chapterContent.slice(evidence.value.range.start, evidence.value.range.end) !==
      evidence.value.excerpt
  ) {
    return outputError(
      "Extraction candidate evidence is outside scope or not an exact source slice.",
    );
  }

  return ok(
    Object.freeze({
      key: key.value,
      target: Object.freeze({
        recordId: recordId.value,
        kind: baseline.kind,
        expectedRevision: baseline.expectedRevision,
      }),
      category: category.value,
      severity: candidate.value.severity as AuthoritativeExtractionSeverity,
      confidence: candidate.value.confidence,
      originalValue: cloneStoryValue(originalValue.value),
      suggestedValue: cloneStoryValue(suggestedValue.value),
      evidence: Object.freeze({
        excerpt: evidence.value.excerpt,
        range: Object.freeze({ ...evidence.value.range }),
      }),
    }),
  );
}

function exactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  path: string,
): Result<Record<Keys[number], unknown>, StoryCoreError> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return outputError(`${path} must be a plain object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return outputError(`${path} contains missing or unknown fields.`);
  }
  return ok(value as Record<Keys[number], unknown>);
}

function parseProtocolUuid(value: unknown, field: string): Result<UuidV7, StoryCoreError> {
  if (typeof value !== "string") {
    return outputError(`${field} must be a UUIDv7.`);
  }
  const parsed = parseUuidV7(value);
  return parsed.ok ? parsed : outputError(`${field} must be a UUIDv7.`);
}

function parseIdentifier(value: unknown, field: string): Result<SafeIdentifier, StoryCoreError> {
  if (typeof value !== "string") {
    return outputError(`${field} must be a stable identifier.`);
  }
  const parsed = parseSafeIdentifier(value);
  return parsed.ok ? parsed : outputError(`${field} must be a stable identifier.`);
}

function parseSha256(value: unknown, field: string): Result<string, StoryCoreError> {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? ok(value)
    : outputError(`${field} must be a lowercase SHA-256 digest.`);
}

function cloneSource(source: AuthoritativeExtractionSource): AuthoritativeExtractionSource {
  return Object.freeze({
    ...source,
    scope: Object.freeze({ ...source.scope }),
  });
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical extraction JSON must be JSON-compatible.");
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function outputError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "EXTRACTION_OUTPUT_INVALID",
      message,
      actions: ["RETRY", "REVIEW_EVIDENCE"],
    }),
  );
}
