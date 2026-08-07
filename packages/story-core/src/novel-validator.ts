export const DETERMINISTIC_NOVEL_FACT_TYPES = [
  "character_life_status",
  "character_age",
  "character_identity",
  "relationship",
  "event_time",
  "entity_location",
  "item_ownership",
  "ability_state",
  "world_property",
  "character_knowledge",
] as const;

export type DeterministicNovelFactType = (typeof DETERMINISTIC_NOVEL_FACT_TYPES)[number];

export const NOVEL_VALIDATION_ISSUE_TYPES = [
  "character_life_status_conflict",
  "character_age_conflict",
  "character_identity_conflict",
  "relationship_conflict",
  "timeline_conflict",
  "location_conflict",
  "item_ownership_conflict",
  "ability_conflict",
  "world_setting_conflict",
  "world_hard_rule_conflict",
  "knowledge_boundary_conflict",
  "pov_boundary_violation",
] as const;

export type NovelValidationIssueType = (typeof NOVEL_VALIDATION_ISSUE_TYPES)[number];

export const NOVEL_EVIDENCE_SOURCE_KINDS = [
  "chapter",
  "story_fact",
  "character_state",
  "relationship",
  "timeline",
  "world_rule",
  "import",
] as const;

export type NovelEvidenceSourceKind = (typeof NOVEL_EVIDENCE_SOURCE_KINDS)[number];
export type NovelFactValue = string | number | boolean;

export interface NovelEvidenceReference {
  readonly sourceKind: NovelEvidenceSourceKind;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface NovelEffectiveRange {
  readonly startOrder: number;
  readonly endOrder: number | null;
}

interface NovelFactAssertionBase {
  readonly id: string;
  readonly factType: DeterministicNovelFactType;
  readonly subjectId: string;
  readonly attributeKey: string;
  /** Null means the assertion applies to every story branch. */
  readonly branchId: string | null;
  readonly effectiveRange: NovelEffectiveRange;
  readonly value: NovelFactValue;
  readonly evidence: readonly NovelEvidenceReference[];
}

export interface NovelCurrentClaim extends NovelFactAssertionBase {
  readonly basis: "explicit_text" | "inferred";
  readonly claimText: string;
  readonly povContext?: Readonly<{
    readonly mode: "first_person" | "third_person_limited";
    readonly characterId: string;
  }> | null;
}

export interface NovelReferenceFact extends NovelFactAssertionBase {
  readonly status: "confirmed" | "candidate" | "deprecated";
  readonly factText: string;
}

export const NOVEL_HARD_RULE_OPERATORS = [
  "equals",
  "not_equals",
  "one_of",
  "not_one_of",
  "minimum",
  "maximum",
] as const;

export type NovelHardRuleOperator = (typeof NOVEL_HARD_RULE_OPERATORS)[number];

export interface NovelHardRule {
  readonly id: string;
  readonly locked: true;
  readonly targetFactType: DeterministicNovelFactType;
  readonly subjectId: string;
  readonly attributeKey: string;
  readonly branchId: string | null;
  readonly effectiveRange: NovelEffectiveRange;
  readonly operator: NovelHardRuleOperator;
  readonly expectedValue: NovelFactValue | readonly NovelFactValue[];
  readonly ruleText: string;
  readonly evidence: readonly NovelEvidenceReference[];
}

export interface NovelValidationInput {
  readonly currentClaims: readonly NovelCurrentClaim[];
  readonly referenceFacts: readonly NovelReferenceFact[];
  readonly hardRules: readonly NovelHardRule[];
}

export const NOVEL_VALIDATION_ACTIONS = [
  "revise_current_text",
  "review_confirmed_fact",
  "update_timeline",
  "review_hard_rule",
  "mark_allowed_exception",
  "add_information_acquisition",
  "change_pov",
] as const;

export type NovelValidationAction = (typeof NOVEL_VALIDATION_ACTIONS)[number];
export type NovelValidationSeverity = "warning" | "error";

export interface NovelValidationIssueClaim {
  readonly id: string;
  readonly factType: DeterministicNovelFactType;
  readonly subjectId: string;
  readonly attributeKey: string;
  readonly value: NovelFactValue;
  readonly text: string;
  readonly evidence: readonly NovelEvidenceReference[];
}

export interface NovelValidationConflictFact {
  readonly id: string;
  readonly source: "confirmed_fact" | "locked_hard_rule";
  readonly factType: DeterministicNovelFactType;
  readonly subjectId: string;
  readonly attributeKey: string;
  readonly value: NovelFactValue | readonly NovelFactValue[];
  readonly operator: NovelHardRuleOperator | "equals";
  readonly statement: string;
  readonly evidence: readonly NovelEvidenceReference[];
}

export interface NovelValidationIssue {
  readonly id: string;
  readonly detector: "deterministic";
  readonly issueType: NovelValidationIssueType;
  readonly severity: NovelValidationSeverity;
  readonly currentClaim: NovelValidationIssueClaim;
  readonly conflictingFact: NovelValidationConflictFact;
  readonly overlap: NovelEffectiveRange;
  readonly suggestion: Readonly<{
    readonly summary: string;
    readonly actions: readonly NovelValidationAction[];
  }>;
}

export const NOVEL_VALIDATION_SKIP_REASONS = [
  "current_claim_not_explicit",
  "current_claim_missing_evidence",
  "reference_fact_not_confirmed",
  "reference_fact_missing_evidence",
  "hard_rule_missing_evidence",
] as const;

export type NovelValidationSkipReason = (typeof NOVEL_VALIDATION_SKIP_REASONS)[number];

export interface NovelValidationSkippedCheck {
  readonly source: "current_claim" | "reference_fact" | "hard_rule";
  readonly sourceId: string;
  readonly reason: NovelValidationSkipReason;
}

export interface NovelValidationResult {
  readonly issues: readonly NovelValidationIssue[];
  readonly skippedChecks: readonly NovelValidationSkippedCheck[];
  readonly capabilities: Readonly<{
    deterministicValidation: "ready";
    ambiguousModelReview: "separate_read_only_service";
  }>;
}

export type NovelValidatorInputErrorCode = "NOVEL_VALIDATOR_INPUT_INVALID";

export class NovelValidatorInputError extends Error {
  public readonly code: NovelValidatorInputErrorCode = "NOVEL_VALIDATOR_INPUT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "NovelValidatorInputError";
  }
}

/**
 * Future model-assisted review must implement this separate port. The
 * deterministic validator never calls it and never labels its output as a
 * deterministic issue.
 */
export interface AmbiguousNovelReviewPort {
  review(request: AmbiguousNovelReviewRequest): Promise<readonly AmbiguousNovelReviewFinding[]>;
}

export interface AmbiguousNovelReviewRequest {
  readonly projectId: string;
  readonly passage: string;
  readonly evidence: readonly NovelEvidenceReference[];
  readonly requestedChecks: readonly string[];
}

export interface AmbiguousNovelReviewFinding {
  readonly kind: "model_assisted_unverified";
  readonly category: string;
  readonly summary: string;
  readonly evidence: readonly NovelEvidenceReference[];
  readonly requiresHumanReview: true;
}

const MAXIMUM_CLAIMS = 4_096;
const MAXIMUM_REFERENCE_FACTS = 8_192;
const MAXIMUM_HARD_RULES = 2_048;
const MAXIMUM_TEXT_CHARACTERS = 200_000;
const MAXIMUM_EVIDENCE_REFERENCES = 16;
const MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS = 20_000;
const MAXIMUM_EVIDENCE_SOURCE_CHARACTERS = 2_000_000;
const MAXIMUM_REFERENCE_CHARACTERS = 2_000;
const MAXIMUM_STORY_ORDER = 1_000_000_000_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

interface ValidatedInput {
  readonly currentClaims: readonly NovelCurrentClaim[];
  readonly referenceFacts: readonly NovelReferenceFact[];
  readonly hardRules: readonly NovelHardRule[];
}

export function validateNovelConsistency(input: NovelValidationInput): NovelValidationResult {
  const validated = validateInput(input);
  const issues: NovelValidationIssue[] = [];
  const skipped = new Map<string, NovelValidationSkippedCheck>();

  for (const fact of validated.referenceFacts) {
    if (fact.status !== "confirmed") {
      rememberSkip(skipped, "reference_fact", fact.id, "reference_fact_not_confirmed");
    } else if (fact.evidence.length === 0) {
      rememberSkip(skipped, "reference_fact", fact.id, "reference_fact_missing_evidence");
    }
  }
  for (const rule of validated.hardRules) {
    if (rule.evidence.length === 0) {
      rememberSkip(skipped, "hard_rule", rule.id, "hard_rule_missing_evidence");
    }
  }

  for (const claim of validated.currentClaims) {
    if (claim.basis !== "explicit_text") {
      rememberSkip(skipped, "current_claim", claim.id, "current_claim_not_explicit");
      continue;
    }
    if (claim.evidence.length === 0) {
      rememberSkip(skipped, "current_claim", claim.id, "current_claim_missing_evidence");
      continue;
    }

    for (const fact of validated.referenceFacts) {
      if (
        fact.status !== "confirmed" ||
        fact.evidence.length === 0 ||
        !factsAreComparable(claim, fact)
      ) {
        continue;
      }
      const overlap = intersectRanges(claim.effectiveRange, fact.effectiveRange);
      if (overlap === null || factValuesEqual(claim.value, fact.value)) {
        continue;
      }
      issues.push(createFactConflictIssue(claim, fact, overlap));
    }

    for (const rule of validated.hardRules) {
      if (rule.evidence.length === 0 || !ruleAppliesToClaim(rule, claim)) {
        continue;
      }
      const overlap = intersectRanges(claim.effectiveRange, rule.effectiveRange);
      if (overlap === null || hardRuleAllows(rule, claim.value)) {
        continue;
      }
      issues.push(createHardRuleIssue(claim, rule, overlap));
    }
  }

  return Object.freeze({
    issues: Object.freeze(issues.sort(compareIssues)),
    skippedChecks: Object.freeze([...skipped.values()].sort(compareSkippedChecks)),
    capabilities: Object.freeze({
      deterministicValidation: "ready",
      ambiguousModelReview: "separate_read_only_service",
    }),
  });
}

function validateInput(input: NovelValidationInput): ValidatedInput {
  if (
    !isRecord(input) ||
    !Array.isArray(input.currentClaims) ||
    !Array.isArray(input.referenceFacts) ||
    !Array.isArray(input.hardRules) ||
    input.currentClaims.length > MAXIMUM_CLAIMS ||
    input.referenceFacts.length > MAXIMUM_REFERENCE_FACTS ||
    input.hardRules.length > MAXIMUM_HARD_RULES
  ) {
    throw invalidInput("Novel validator collection bounds are invalid.");
  }

  const ids = new Set<string>();
  return Object.freeze({
    currentClaims: Object.freeze(
      input.currentClaims.map((claim: unknown) => validateCurrentClaim(claim, ids)),
    ),
    referenceFacts: Object.freeze(
      input.referenceFacts.map((fact: unknown) => validateReferenceFact(fact, ids)),
    ),
    hardRules: Object.freeze(input.hardRules.map((rule: unknown) => validateHardRule(rule, ids))),
  });
}

function validateCurrentClaim(value: unknown, ids: Set<string>): NovelCurrentClaim {
  const base = validateFactAssertion(value, ids);
  if (
    !isRecord(value) ||
    (value.basis !== "explicit_text" && value.basis !== "inferred") ||
    !isBoundedText(value.claimText, MAXIMUM_TEXT_CHARACTERS) ||
    (value.povContext !== undefined &&
      value.povContext !== null &&
      !isValidPovContext(value.povContext, base))
  ) {
    throw invalidInput("A current novel claim is invalid.");
  }
  const povContext =
    value.povContext === undefined || value.povContext === null
      ? null
      : Object.freeze({
          mode: value.povContext.mode,
          characterId: value.povContext.characterId,
        });
  return Object.freeze({
    ...base,
    basis: value.basis,
    claimText: value.claimText,
    povContext,
  });
}

function validateReferenceFact(value: unknown, ids: Set<string>): NovelReferenceFact {
  const base = validateFactAssertion(value, ids);
  if (
    !isRecord(value) ||
    !["confirmed", "candidate", "deprecated"].includes(String(value.status)) ||
    !isBoundedText(value.factText, MAXIMUM_TEXT_CHARACTERS)
  ) {
    throw invalidInput("A reference novel fact is invalid.");
  }
  return Object.freeze({
    ...base,
    status: value.status as NovelReferenceFact["status"],
    factText: value.factText,
  });
}

function validateFactAssertion(value: unknown, ids: Set<string>): NovelFactAssertionBase {
  if (
    !isRecord(value) ||
    !isSafeReference(value.id, 512) ||
    ids.has(value.id) ||
    !isDeterministicFactType(value.factType) ||
    !isSafeReference(value.subjectId, 512) ||
    !isSafeReference(value.attributeKey, 512) ||
    !isNullableSafeReference(value.branchId, 512) ||
    !isNovelFactValue(value.value) ||
    !factValueMatchesType(value.factType, value.value) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAXIMUM_EVIDENCE_REFERENCES
  ) {
    throw invalidInput("A structured novel fact assertion is invalid.");
  }
  const effectiveRange = validateEffectiveRange(value.effectiveRange);
  ids.add(value.id);
  return Object.freeze({
    id: value.id,
    factType: value.factType,
    subjectId: value.subjectId,
    attributeKey: value.attributeKey,
    branchId: value.branchId,
    effectiveRange,
    value: normalizeFactValue(value.value),
    evidence: Object.freeze(value.evidence.map(validateEvidence)),
  });
}

function validateHardRule(value: unknown, ids: Set<string>): NovelHardRule {
  if (
    !isRecord(value) ||
    !isSafeReference(value.id, 512) ||
    ids.has(value.id) ||
    value.locked !== true ||
    !isDeterministicFactType(value.targetFactType) ||
    !isSafeReference(value.subjectId, 512) ||
    !isSafeReference(value.attributeKey, 512) ||
    !isNullableSafeReference(value.branchId, 512) ||
    !isHardRuleOperator(value.operator) ||
    !isBoundedText(value.ruleText, MAXIMUM_TEXT_CHARACTERS) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAXIMUM_EVIDENCE_REFERENCES
  ) {
    throw invalidInput("A locked novel hard rule is invalid.");
  }
  const expectedValue = validateRuleExpectedValue(
    value.operator,
    value.targetFactType,
    value.expectedValue,
  );
  ids.add(value.id);
  return Object.freeze({
    id: value.id,
    locked: true,
    targetFactType: value.targetFactType,
    subjectId: value.subjectId,
    attributeKey: value.attributeKey,
    branchId: value.branchId,
    effectiveRange: validateEffectiveRange(value.effectiveRange),
    operator: value.operator,
    expectedValue,
    ruleText: value.ruleText,
    evidence: Object.freeze(value.evidence.map(validateEvidence)),
  });
}

function validateRuleExpectedValue(
  operator: NovelHardRuleOperator,
  targetFactType: DeterministicNovelFactType,
  value: unknown,
): NovelFactValue | readonly NovelFactValue[] {
  if (operator === "one_of" || operator === "not_one_of") {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 100 ||
      !value.every(
        (candidate) =>
          isNovelFactValue(candidate) && factValueMatchesType(targetFactType, candidate),
      )
    ) {
      throw invalidInput("A set-based hard rule requires bounded primitive values.");
    }
    const normalized = value.map(normalizeFactValue);
    if (new Set(normalized.map(stableFactValueKey)).size !== normalized.length) {
      throw invalidInput("A set-based hard rule cannot contain duplicate values.");
    }
    return Object.freeze(normalized);
  }
  if (!isNovelFactValue(value) || !factValueMatchesType(targetFactType, value)) {
    throw invalidInput("A hard rule requires a primitive expected value.");
  }
  if ((operator === "minimum" || operator === "maximum") && typeof value !== "number") {
    throw invalidInput("Minimum and maximum hard rules require numeric values.");
  }
  return normalizeFactValue(value);
}

function validateEffectiveRange(value: unknown): NovelEffectiveRange {
  if (
    !isRecord(value) ||
    typeof value.startOrder !== "number" ||
    !Number.isSafeInteger(value.startOrder) ||
    Math.abs(value.startOrder) > MAXIMUM_STORY_ORDER ||
    (value.endOrder !== null &&
      (typeof value.endOrder !== "number" ||
        !Number.isSafeInteger(value.endOrder) ||
        Math.abs(value.endOrder) > MAXIMUM_STORY_ORDER ||
        value.endOrder < value.startOrder))
  ) {
    throw invalidInput("A novel fact effective range is invalid.");
  }
  return Object.freeze({
    startOrder: value.startOrder,
    endOrder: value.endOrder,
  });
}

function validateEvidence(value: unknown): NovelEvidenceReference {
  if (
    !isRecord(value) ||
    !isEvidenceSourceKind(value.sourceKind) ||
    !isSafeReference(value.sourceId, 512) ||
    !isSafeReference(value.sourceVersionId, 512) ||
    typeof value.contentHash !== "string" ||
    !SHA256_PATTERN.test(value.contentHash) ||
    !isBoundedText(value.locator, MAXIMUM_REFERENCE_CHARACTERS) ||
    !isBoundedText(value.excerpt, MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS) ||
    typeof value.startOffset !== "number" ||
    !Number.isSafeInteger(value.startOffset) ||
    typeof value.endOffset !== "number" ||
    !Number.isSafeInteger(value.endOffset) ||
    typeof value.sourceLength !== "number" ||
    !Number.isSafeInteger(value.sourceLength) ||
    value.sourceLength > MAXIMUM_EVIDENCE_SOURCE_CHARACTERS ||
    value.startOffset < 0 ||
    value.endOffset <= value.startOffset ||
    value.endOffset > value.sourceLength ||
    value.excerpt.length !== value.endOffset - value.startOffset
  ) {
    throw invalidInput("Novel validation evidence must have exact versioned offsets and a hash.");
  }
  return Object.freeze({
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    contentHash: value.contentHash,
    locator: value.locator,
    excerpt: value.excerpt,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
    sourceLength: value.sourceLength,
  });
}

function factsAreComparable(claim: NovelCurrentClaim, fact: NovelReferenceFact): boolean {
  return (
    claim.factType === fact.factType &&
    claim.subjectId === fact.subjectId &&
    claim.attributeKey === fact.attributeKey &&
    branchesOverlap(claim.branchId, fact.branchId)
  );
}

function ruleAppliesToClaim(rule: NovelHardRule, claim: NovelCurrentClaim): boolean {
  return (
    rule.targetFactType === claim.factType &&
    rule.subjectId === claim.subjectId &&
    rule.attributeKey === claim.attributeKey &&
    branchesOverlap(rule.branchId, claim.branchId)
  );
}

function branchesOverlap(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

function intersectRanges(
  left: NovelEffectiveRange,
  right: NovelEffectiveRange,
): NovelEffectiveRange | null {
  const startOrder = Math.max(left.startOrder, right.startOrder);
  const leftEnd = left.endOrder ?? Number.POSITIVE_INFINITY;
  const rightEnd = right.endOrder ?? Number.POSITIVE_INFINITY;
  const end = Math.min(leftEnd, rightEnd);
  return startOrder > end
    ? null
    : Object.freeze({
        startOrder,
        endOrder: Number.isFinite(end) ? end : null,
      });
}

function hardRuleAllows(rule: NovelHardRule, actual: NovelFactValue): boolean {
  switch (rule.operator) {
    case "equals":
      return factValuesEqual(actual, rule.expectedValue as NovelFactValue);
    case "not_equals":
      return !factValuesEqual(actual, rule.expectedValue as NovelFactValue);
    case "one_of":
      return (rule.expectedValue as readonly NovelFactValue[]).some((expected) =>
        factValuesEqual(actual, expected),
      );
    case "not_one_of":
      return !(rule.expectedValue as readonly NovelFactValue[]).some((expected) =>
        factValuesEqual(actual, expected),
      );
    case "minimum":
      return typeof actual === "number" && actual >= (rule.expectedValue as number);
    case "maximum":
      return typeof actual === "number" && actual <= (rule.expectedValue as number);
  }
}

function createFactConflictIssue(
  claim: NovelCurrentClaim,
  fact: NovelReferenceFact,
  overlap: NovelEffectiveRange,
): NovelValidationIssue {
  const issueType = issueTypeForFactConflict(claim, fact);
  const suggestion = suggestionForIssue(issueType);
  return Object.freeze({
    id: `det:${issueType}:${claim.id}:${fact.id}`,
    detector: "deterministic",
    issueType,
    severity: severityForIssue(issueType),
    currentClaim: snapshotCurrentClaim(claim),
    conflictingFact: Object.freeze({
      id: fact.id,
      source: "confirmed_fact",
      factType: fact.factType,
      subjectId: fact.subjectId,
      attributeKey: fact.attributeKey,
      value: fact.value,
      operator: "equals",
      statement: fact.factText,
      evidence: fact.evidence,
    }),
    overlap,
    suggestion,
  });
}

function createHardRuleIssue(
  claim: NovelCurrentClaim,
  rule: NovelHardRule,
  overlap: NovelEffectiveRange,
): NovelValidationIssue {
  return Object.freeze({
    id: `det:world_hard_rule_conflict:${claim.id}:${rule.id}`,
    detector: "deterministic",
    issueType: "world_hard_rule_conflict",
    severity: "error",
    currentClaim: snapshotCurrentClaim(claim),
    conflictingFact: Object.freeze({
      id: rule.id,
      source: "locked_hard_rule",
      factType: rule.targetFactType,
      subjectId: rule.subjectId,
      attributeKey: rule.attributeKey,
      value: rule.expectedValue,
      operator: rule.operator,
      statement: rule.ruleText,
      evidence: rule.evidence,
    }),
    overlap,
    suggestion: suggestionForIssue("world_hard_rule_conflict"),
  });
}

function snapshotCurrentClaim(claim: NovelCurrentClaim): NovelValidationIssueClaim {
  return Object.freeze({
    id: claim.id,
    factType: claim.factType,
    subjectId: claim.subjectId,
    attributeKey: claim.attributeKey,
    value: claim.value,
    text: claim.claimText,
    evidence: claim.evidence,
  });
}

function issueTypeForFactConflict(
  claim: NovelCurrentClaim,
  fact: NovelReferenceFact,
): NovelValidationIssueType {
  switch (claim.factType) {
    case "character_life_status":
      return "character_life_status_conflict";
    case "character_age":
      return "character_age_conflict";
    case "character_identity":
      return "character_identity_conflict";
    case "relationship":
      return "relationship_conflict";
    case "event_time":
      return "timeline_conflict";
    case "entity_location":
      return "location_conflict";
    case "item_ownership":
      return "item_ownership_conflict";
    case "ability_state":
      return "ability_conflict";
    case "world_property":
      return "world_setting_conflict";
    case "character_knowledge":
      return claim.povContext !== null &&
        claim.povContext !== undefined &&
        claim.value === "known" &&
        fact.value !== "known"
        ? "pov_boundary_violation"
        : "knowledge_boundary_conflict";
  }
}

function severityForIssue(issueType: NovelValidationIssueType): NovelValidationSeverity {
  return issueType === "knowledge_boundary_conflict" ? "warning" : "error";
}

function suggestionForIssue(
  issueType: NovelValidationIssueType,
): NovelValidationIssue["suggestion"] {
  switch (issueType) {
    case "timeline_conflict":
    case "location_conflict":
      return freezeSuggestion(
        "Revise the current passage to match the confirmed timeline, or review and update the confirmed fact with human approval.",
        ["revise_current_text", "update_timeline", "review_confirmed_fact"],
      );
    case "world_hard_rule_conflict":
      return freezeSuggestion(
        "Revise the current passage to obey the locked world rule, or explicitly review the rule and record an allowed exception.",
        ["revise_current_text", "review_hard_rule", "mark_allowed_exception"],
      );
    case "pov_boundary_violation":
      return freezeSuggestion(
        "Remove the unavailable knowledge from this POV, add an earlier supported acquisition event, or change the scene POV.",
        ["revise_current_text", "add_information_acquisition", "change_pov"],
      );
    case "knowledge_boundary_conflict":
      return freezeSuggestion(
        "Revise the knowledge claim or add a supported information-acquisition event before updating the confirmed boundary.",
        ["revise_current_text", "add_information_acquisition", "review_confirmed_fact"],
      );
    default:
      return freezeSuggestion(
        "Revise the current passage to match the confirmed fact, or review the confirmed fact before changing it.",
        ["revise_current_text", "review_confirmed_fact"],
      );
  }
}

function freezeSuggestion(
  summary: string,
  actions: readonly NovelValidationAction[],
): NovelValidationIssue["suggestion"] {
  return Object.freeze({
    summary,
    actions: Object.freeze([...actions]),
  });
}

function isValidPovContext(
  value: unknown,
  fact: NovelFactAssertionBase,
): value is NonNullable<NovelCurrentClaim["povContext"]> {
  return (
    isRecord(value) &&
    (value.mode === "first_person" || value.mode === "third_person_limited") &&
    isSafeReference(value.characterId, 512) &&
    fact.factType === "character_knowledge" &&
    value.characterId === fact.subjectId
  );
}

function factValueMatchesType(
  factType: DeterministicNovelFactType,
  value: NovelFactValue,
): boolean {
  switch (factType) {
    case "character_life_status":
      return value === "alive" || value === "dead";
    case "character_age":
      return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000
      );
    case "character_identity":
    case "entity_location":
    case "item_ownership":
      return typeof value === "string";
    case "relationship":
      return typeof value === "string" || typeof value === "boolean";
    case "event_time":
      return typeof value === "string" || typeof value === "number";
    case "character_knowledge":
      return ["known", "unknown", "suspected", "false_belief"].includes(String(value));
    default:
      return true;
  }
}

function isNovelFactValue(value: unknown): value is NovelFactValue {
  return (
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= MAXIMUM_REFERENCE_CHARACTERS &&
      !CONTROL_CHARACTER_PATTERN.test(value)) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function normalizeFactValue(value: NovelFactValue): NovelFactValue {
  return typeof value === "number" && Object.is(value, -0) ? 0 : value;
}

function factValuesEqual(left: NovelFactValue, right: NovelFactValue): boolean {
  return (
    typeof left === typeof right && Object.is(normalizeFactValue(left), normalizeFactValue(right))
  );
}

function stableFactValueKey(value: NovelFactValue): string {
  return `${typeof value}:${String(normalizeFactValue(value))}`;
}

function rememberSkip(
  skipped: Map<string, NovelValidationSkippedCheck>,
  source: NovelValidationSkippedCheck["source"],
  sourceId: string,
  reason: NovelValidationSkipReason,
): void {
  const key = `${source}:${sourceId}:${reason}`;
  skipped.set(key, Object.freeze({ source, sourceId, reason }));
}

function compareIssues(left: NovelValidationIssue, right: NovelValidationIssue): number {
  return (
    left.issueType.localeCompare(right.issueType) ||
    left.currentClaim.id.localeCompare(right.currentClaim.id) ||
    left.conflictingFact.id.localeCompare(right.conflictingFact.id)
  );
}

function compareSkippedChecks(
  left: NovelValidationSkippedCheck,
  right: NovelValidationSkippedCheck,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.reason.localeCompare(right.reason)
  );
}

function isDeterministicFactType(value: unknown): value is DeterministicNovelFactType {
  return DETERMINISTIC_NOVEL_FACT_TYPES.includes(value as DeterministicNovelFactType);
}

function isHardRuleOperator(value: unknown): value is NovelHardRuleOperator {
  return NOVEL_HARD_RULE_OPERATORS.includes(value as NovelHardRuleOperator);
}

function isEvidenceSourceKind(value: unknown): value is NovelEvidenceSourceKind {
  return NOVEL_EVIDENCE_SOURCE_KINDS.includes(value as NovelEvidenceSourceKind);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isSafeReference(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isNullableSafeReference(value: unknown, maximumLength: number): value is string | null {
  return value === null || isSafeReference(value, maximumLength);
}

function invalidInput(message: string): NovelValidatorInputError {
  return new NovelValidatorInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
