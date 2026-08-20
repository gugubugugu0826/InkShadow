import type {
  EvidenceRef,
  NarrativeStateAtom,
  NarrativeStateCategory,
  NarrativeStateOmission,
  NarrativeStateReadView,
  StoryMemoryReadRequest,
  StoryMemoryRetrievalScope,
} from "@inkshadow/ai-core";
import type { StoryFactSnapshot } from "@inkshadow/story-core";

export interface NarrativeStateProjectionCandidate {
  readonly snapshot: StoryFactSnapshot;
  readonly content: string;
  readonly evidence: EvidenceRef;
}

/** Normalizes old callers into an explicit, content-free retrieval boundary. */
export function normalizeStoryMemoryRetrievalScope(
  request: StoryMemoryReadRequest,
): StoryMemoryRetrievalScope {
  return Object.freeze({
    projectId: request.projectId,
    currentChapterId: request.currentChapterId ?? null,
    currentImmutableVersionId: request.currentImmutableVersionId ?? null,
    branchId: request.currentBranchId,
    povCharacterId: request.currentPovCharacterId ?? null,
    storyOrder: request.currentStoryOrder ?? null,
    taskType: request.taskType ?? "other",
    destination: request.destination,
    privacy: request.privacy ?? null,
    authorityRevision: request.authorityRevision ?? null,
    observedAt: request.observedAt,
  });
}

/**
 * Deterministic L2 projection over already-authorized, current confirmed facts.
 * It never parses prose, invokes a model, or persists another fact authority.
 */
export function buildNarrativeStateReadView(
  scope: StoryMemoryRetrievalScope,
  candidates: readonly NarrativeStateProjectionCandidate[],
): NarrativeStateReadView {
  const omissions: NarrativeStateOmission[] = scopeOmissions(scope);
  const atoms: NarrativeStateAtom[] = [];

  for (const candidate of candidates) {
    const storyOrder = explicitStoryOrder(candidate.snapshot.structuredValue);
    if (scope.storyOrder !== null && storyOrder !== null && storyOrder > scope.storyOrder) {
      omissions.push(
        Object.freeze({ sourceId: candidate.snapshot.id, reason: "future_story_state" }),
      );
      continue;
    }

    const category = narrativeCategory(candidate.snapshot.factType);
    const povCharacterId = explicitPovCharacter(candidate.snapshot.structuredValue);
    if (
      scope.povCharacterId !== null &&
      isPovCategory(category) &&
      povCharacterId !== null &&
      povCharacterId !== scope.povCharacterId
    ) {
      omissions.push(
        Object.freeze({ sourceId: candidate.snapshot.id, reason: "pov_character_mismatch" }),
      );
      continue;
    }

    atoms.push(
      Object.freeze({
        id: candidate.snapshot.id,
        factType: candidate.snapshot.factType,
        category,
        content: candidate.content,
        effectiveAt: candidate.snapshot.effectiveAt,
        invalidatedAt: candidate.snapshot.invalidatedAt,
        branchId: candidate.snapshot.branchId,
        locked: candidate.snapshot.locked,
        evidence: Object.freeze([candidate.evidence]),
      }),
    );
  }

  const sortedOmissions = Object.freeze(
    [...omissions].sort((left, right) =>
      `${left.sourceId ?? ""}:${left.reason}`.localeCompare(
        `${right.sourceId ?? ""}:${right.reason}`,
      ),
    ),
  );
  return Object.freeze({
    projectId: scope.projectId,
    branchId: scope.branchId,
    currentChapterId: scope.currentChapterId,
    currentImmutableVersionId: scope.currentImmutableVersionId,
    povCharacterId: scope.povCharacterId,
    storyOrder: scope.storyOrder,
    atoms: Object.freeze(
      [...atoms].sort((left, right) =>
        `${left.category}:${left.id}`.localeCompare(`${right.category}:${right.id}`),
      ),
    ),
    omissions: sortedOmissions,
    insufficientEvidence: sortedOmissions.some(({ sourceId }) => sourceId === null),
  });
}

function scopeOmissions(scope: StoryMemoryRetrievalScope): NarrativeStateOmission[] {
  const omissions: NarrativeStateOmission[] = [];
  if (scope.currentChapterId === null) {
    omissions.push(Object.freeze({ sourceId: null, reason: "current_chapter_scope_missing" }));
  }
  if (scope.currentImmutableVersionId === null) {
    omissions.push(Object.freeze({ sourceId: null, reason: "current_version_scope_missing" }));
  }
  if (scope.povCharacterId === null) {
    omissions.push(Object.freeze({ sourceId: null, reason: "pov_scope_missing" }));
  }
  if (scope.storyOrder === null) {
    omissions.push(Object.freeze({ sourceId: null, reason: "story_time_scope_missing" }));
  }
  if (scope.authorityRevision === null) {
    omissions.push(Object.freeze({ sourceId: null, reason: "authority_revision_missing" }));
  }
  return omissions;
}

function narrativeCategory(factType: string): NarrativeStateCategory {
  const normalized = factType.toLowerCase();
  if (normalized.includes("scene_goal")) return "scene_goal";
  if (normalized.includes("timeline") || normalized.includes("event_time")) return "time";
  if (normalized.includes("location")) return "location";
  if (normalized.includes("pov_forbidden") || normalized.includes("knowledge_boundary")) {
    return "pov_forbidden_knowledge";
  }
  if (normalized.includes("pov") || normalized.includes("knowledge")) return "pov";
  if (normalized.includes("relationship")) return "relationship_change";
  if (normalized.includes("character_state") || normalized.includes("state_change")) {
    return "state_change";
  }
  if (normalized.includes("character")) return "character";
  if (normalized.includes("foreshadow")) return "foreshadow";
  if (normalized.includes("unresolved")) return "unresolved";
  if (normalized.includes("causal")) return "causal";
  if (normalized.includes("plotline") || normalized.includes("plot_line")) return "plotline";
  if (normalized.includes("pacing") || normalized.includes("tension")) return "pacing";
  if (normalized.includes("emotion")) return "emotion";
  if (
    normalized.includes("world") ||
    normalized.includes("identity") ||
    normalized.includes("rule")
  ) {
    return "new_fact";
  }
  return "other";
}

function isPovCategory(category: NarrativeStateCategory): boolean {
  return category === "pov" || category === "pov_forbidden_knowledge";
}

function explicitStoryOrder(value: unknown): number | null {
  const record = asRecord(value);
  return firstSafeOrder([
    nested(record, "effectiveRange", "startOrder"),
    nested(record, "projection", "pov", "effectiveRange", "startOrder"),
    nested(record, "projection", "narrative", "chapterOrder"),
    nested(record, "narrativeTime", "order"),
    nested(record, "state", "effectiveRange", "startOrder"),
    nested(record, "state", "acquiredAt"),
  ]);
}

function explicitPovCharacter(value: unknown): string | null {
  const record = asRecord(value);
  return firstSafeReference([
    nested(record, "characterId"),
    nested(record, "povContext", "characterId"),
    nested(record, "projection", "pov", "characterId"),
    nested(record, "state", "characterId"),
  ]);
}

function nested(record: Readonly<Record<string, unknown>> | null, ...path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    const currentRecord = asRecord(current);
    if (currentRecord === null) return null;
    current = currentRecord[key];
  }
  return current;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function firstSafeOrder(values: readonly unknown[]): number | null {
  const value = values.find(
    (candidate): candidate is number =>
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      candidate <= 1_000_000_000_000,
  );
  return value ?? null;
}

function firstSafeReference(values: readonly unknown[]): string | null {
  const value = values.find(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= 512 &&
      candidate.trim() === candidate &&
      !/[\u0000-\u001f\u007f]/u.test(candidate),
  );
  return value ?? null;
}
