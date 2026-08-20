export const EVIDENCE_SOURCE_KINDS = [
  "chapter",
  "story_fact",
  "project_seed",
  "legacy_memory",
  "candidate",
  "causal_projection",
  "graph_projection",
  "other",
] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export const EVIDENCE_CURRENTNESS = ["current", "stale"] as const;
export type EvidenceCurrentness = (typeof EVIDENCE_CURRENTNESS)[number];

export const EVIDENCE_PRIVACY = ["standard", "local_only"] as const;
export type EvidencePrivacy = (typeof EVIDENCE_PRIVACY)[number];

export type EvidenceLocator =
  | Readonly<{
      readonly kind: "utf16";
      readonly startOffset: number;
      readonly endOffset: number;
      readonly sourceLength: number;
    }>
  | Readonly<{
      readonly kind: "stable";
      readonly value: string;
    }>;

/**
 * Content-free evidence identity shared by memory, retrieval, validation and
 * future Agent read tools. `excerptDigest` is a digest only: callers must not
 * persist an excerpt or full chapter alongside this DTO.
 */
export interface EvidenceRef {
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly immutableVersionId: string | null;
  readonly sourceKind: EvidenceSourceKind;
  readonly locator: EvidenceLocator;
  readonly excerptDigest: string;
  readonly sourceCreatedAt: string;
  readonly observedAt: string;
  readonly currentness: EvidenceCurrentness;
  readonly branchId: string | null;
  readonly privacy: EvidencePrivacy;
}

export type CreateEvidenceRefInput = EvidenceRef;

export class EvidenceRefValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EvidenceRefValidationError";
  }
}

export function createEvidenceRef(input: CreateEvidenceRefInput): EvidenceRef {
  if (
    !isBoundedReference(input.projectId) ||
    !isNullableBoundedReference(input.chapterId) ||
    !isNullableBoundedReference(input.immutableVersionId) ||
    !EVIDENCE_SOURCE_KINDS.includes(input.sourceKind) ||
    !SHA256_PATTERN.test(input.excerptDigest) ||
    !isCanonicalTimestamp(input.sourceCreatedAt) ||
    !isCanonicalTimestamp(input.observedAt) ||
    input.observedAt < input.sourceCreatedAt ||
    !EVIDENCE_CURRENTNESS.includes(input.currentness) ||
    !isNullableBoundedReference(input.branchId) ||
    !EVIDENCE_PRIVACY.includes(input.privacy)
  ) {
    throw new EvidenceRefValidationError("Evidence reference metadata is invalid.");
  }
  const locator = validateEvidenceLocator(input.locator);
  if (locator.kind === "utf16" && (input.chapterId === null || input.immutableVersionId === null)) {
    throw new EvidenceRefValidationError(
      "UTF-16 evidence requires a chapter and immutable version identity.",
    );
  }
  return Object.freeze({
    projectId: input.projectId,
    chapterId: input.chapterId,
    immutableVersionId: input.immutableVersionId,
    sourceKind: input.sourceKind,
    locator,
    excerptDigest: input.excerptDigest,
    sourceCreatedAt: input.sourceCreatedAt,
    observedAt: input.observedAt,
    currentness: input.currentness,
    branchId: input.branchId,
    privacy: input.privacy,
  });
}

export const STORY_MEMORY_LAYERS = ["L0", "L1", "L2", "L3"] as const;
export type StoryMemoryLayer = (typeof STORY_MEMORY_LAYERS)[number];

export const STORY_MEMORY_ENTRY_KINDS = [
  "evidence",
  "confirmed_canon",
  "rebuildable_narrative_projection",
  "confirmed_project_core",
  "legacy_compatibility",
  "advisory",
] as const;
export type StoryMemoryEntryKind = (typeof STORY_MEMORY_ENTRY_KINDS)[number];

export interface StoryMemoryReadEntry {
  readonly id: string;
  readonly layer: StoryMemoryLayer | null;
  readonly kind: StoryMemoryEntryKind;
  /** Transient read projection; it is not a persistence contract. */
  readonly content: string;
  readonly evidence: readonly EvidenceRef[];
  readonly rebuildable: boolean;
}

export type StoryMemoryTaskType =
  | "continuation"
  | "consistency_investigation"
  | "character_voice"
  | "pov"
  | "pacing"
  | "overall_review"
  | "other";

/**
 * The normalized retrieval boundary carried by every memory read. Nullable
 * fields mean the caller did not have author-confirmed scope; consumers must
 * treat the corresponding omission as insufficient evidence, never infer it
 * from prose.
 */
export interface StoryMemoryRetrievalScope {
  readonly projectId: string;
  readonly currentChapterId: string | null;
  readonly currentImmutableVersionId: string | null;
  readonly branchId: string | null;
  readonly povCharacterId: string | null;
  readonly storyOrder: number | null;
  readonly taskType: StoryMemoryTaskType;
  readonly destination: "local" | "remote";
  readonly privacy: EvidencePrivacy | null;
  readonly authorityRevision: number | null;
  readonly observedAt: string;
}

export const NARRATIVE_STATE_CATEGORIES = [
  "scene_goal",
  "time",
  "location",
  "pov",
  "character",
  "state_change",
  "relationship_change",
  "new_fact",
  "foreshadow",
  "unresolved",
  "causal",
  "plotline",
  "pacing",
  "emotion",
  "pov_forbidden_knowledge",
  "other",
] as const;
export type NarrativeStateCategory = (typeof NARRATIVE_STATE_CATEGORIES)[number];

export interface NarrativeStateAtom {
  readonly id: string;
  readonly factType: string;
  readonly category: NarrativeStateCategory;
  readonly content: string;
  readonly effectiveAt: string | null;
  readonly invalidatedAt: string | null;
  readonly branchId: string | null;
  readonly locked: boolean;
  readonly evidence: readonly EvidenceRef[];
}

export type NarrativeStateOmissionReason =
  | "current_chapter_scope_missing"
  | "current_version_scope_missing"
  | "pov_scope_missing"
  | "story_time_scope_missing"
  | "authority_revision_missing"
  | "future_story_state"
  | "pov_character_mismatch";

export interface NarrativeStateOmission {
  readonly sourceId: string | null;
  readonly reason: NarrativeStateOmissionReason;
}

export interface NarrativeStateReadView {
  readonly projectId: string;
  readonly branchId: string | null;
  readonly currentChapterId: string | null;
  readonly currentImmutableVersionId: string | null;
  readonly povCharacterId: string | null;
  readonly storyOrder: number | null;
  readonly atoms: readonly NarrativeStateAtom[];
  readonly omissions: readonly NarrativeStateOmission[];
  readonly insufficientEvidence: boolean;
}

export type StoryMemoryContextDecisionReason =
  | "included_authority"
  | "included_projection"
  | "included_legacy_compatibility"
  | "included_author_preference"
  | "excluded_unconfirmed"
  | "excluded_stale"
  | "excluded_branch"
  | "excluded_privacy"
  | "excluded_rejected_candidate"
  | "excluded_other"
  | "insufficient_scope";

export interface StoryMemoryContextDecision {
  readonly sourceId: string;
  readonly included: boolean;
  readonly layer: StoryMemoryLayer | null;
  readonly reason: StoryMemoryContextDecisionReason;
  readonly evidenceRefCount: number;
}

export interface StoryMemoryActiveTaskState {
  readonly taskType: StoryMemoryTaskType;
  readonly status: "ready" | "insufficient_evidence";
  readonly missingRequirements: readonly NarrativeStateOmissionReason[];
}

export const STORY_MEMORY_EXCLUSION_REASONS = [
  "unconfirmed",
  "stale_version",
  "other_branch",
  "private_remote_denied",
  "rejected_candidate",
  "needs_review",
  "deprecated",
  "temporary_not_rebuildable",
  "disabled",
  "excluded_by_user",
  "source_unavailable",
] as const;
export type StoryMemoryExclusionReason = (typeof STORY_MEMORY_EXCLUSION_REASONS)[number];

export interface StoryMemoryExclusion {
  readonly sourceId: string;
  readonly sourceKind: EvidenceSourceKind;
  readonly attemptedLayer: StoryMemoryLayer | null;
  readonly reason: StoryMemoryExclusionReason;
  readonly evidence: EvidenceRef | null;
}

export interface StoryMemoryReadRequest {
  readonly projectId: string;
  /** Null is the main story line. */
  readonly currentBranchId: string | null;
  readonly currentChapterId?: string | null;
  readonly currentImmutableVersionId?: string | null;
  /** Only author-confirmed metadata may be supplied here. */
  readonly currentPovCharacterId?: string | null;
  /** Only an author-confirmed narrative order may be supplied here. */
  readonly currentStoryOrder?: number | null;
  readonly taskType?: StoryMemoryTaskType;
  readonly privacy?: EvidencePrivacy | null;
  readonly authorityRevision?: number | null;
  readonly destination: "local" | "remote";
  readonly observedAt: string;
}

export interface StoryMemoryReadResult {
  readonly projectId: string;
  readonly observedAt: string;
  readonly scope: StoryMemoryRetrievalScope;
  readonly layers: Readonly<{
    readonly L0: readonly StoryMemoryReadEntry[];
    readonly L1: readonly StoryMemoryReadEntry[];
    readonly L2: readonly StoryMemoryReadEntry[];
    readonly L3: readonly StoryMemoryReadEntry[];
  }>;
  readonly legacy: readonly StoryMemoryReadEntry[];
  readonly advisory: readonly StoryMemoryReadEntry[];
  readonly exclusions: readonly StoryMemoryExclusion[];
  readonly projectCore: readonly StoryMemoryReadEntry[];
  readonly canonFacts: readonly StoryMemoryReadEntry[];
  readonly narrativeState: NarrativeStateReadView;
  readonly authorPreferences: readonly StoryMemoryReadEntry[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly retrievalCandidates: readonly StoryMemoryReadEntry[];
  readonly contextDecisionTrace: readonly StoryMemoryContextDecision[];
  readonly activeTaskState: StoryMemoryActiveTaskState;
}

/** Application-layer, read-only composition over existing authorities. */
export interface StoryMemoryReadModel {
  read(request: StoryMemoryReadRequest): Promise<StoryMemoryReadResult>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAXIMUM_REFERENCE_CHARACTERS = 2_000;

function validateEvidenceLocator(locator: EvidenceLocator): EvidenceLocator {
  if (locator.kind === "stable") {
    if (!isBoundedReference(locator.value, MAXIMUM_REFERENCE_CHARACTERS)) {
      throw new EvidenceRefValidationError("Stable evidence locator is invalid.");
    }
    return Object.freeze({ kind: "stable" as const, value: locator.value });
  }
  if (
    !Number.isSafeInteger(locator.startOffset) ||
    !Number.isSafeInteger(locator.endOffset) ||
    !Number.isSafeInteger(locator.sourceLength) ||
    locator.startOffset < 0 ||
    locator.endOffset <= locator.startOffset ||
    locator.sourceLength < locator.endOffset
  ) {
    throw new EvidenceRefValidationError("UTF-16 evidence locator is invalid.");
  }
  return Object.freeze({
    kind: "utf16" as const,
    startOffset: locator.startOffset,
    endOffset: locator.endOffset,
    sourceLength: locator.sourceLength,
  });
}

function isBoundedReference(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isNullableBoundedReference(value: unknown): value is string | null {
  return value === null || isBoundedReference(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
