import { StoryCoreError } from "./errors.js";
import type { FormalStoryRecord } from "./formal-record.js";
import { err, ok, type Result } from "./result.js";
import { MAX_MEMORY_TEXT_LENGTH, validateBoundedText } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "./value-objects.js";

export const WHAT_IF_STATUSES = [
  "draft",
  "simulated",
  "promoted_to_outline_draft",
  "discarded",
] as const;
export type WhatIfStatus = (typeof WHAT_IF_STATUSES)[number];

export interface WhatIfEffect {
  readonly id: UuidV7;
  readonly effectType: SafeIdentifier;
  readonly summary: string;
  readonly impactedRecordIds: readonly UuidV7[];
  readonly confidence: number;
}

export interface WhatIfBranchSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly sourceEventId: UuidV7;
  readonly baseTimelineRevision: number;
  readonly hypothesis: string;
  readonly status: WhatIfStatus;
  readonly effects: readonly WhatIfEffect[];
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface WhatIfComparison {
  readonly branchId: UuidV7;
  readonly baseTimelineRevision: number;
  readonly formalTimelineRevision: number;
  readonly formalEventIds: readonly UuidV7[];
  readonly effects: readonly WhatIfEffect[];
  readonly sandbox: true;
  readonly canCommitFormalTimeline: false;
}

export interface OutlineDraftCandidate {
  readonly id: UuidV7;
  readonly sourceBranchId: UuidV7;
  readonly projectId: UuidV7;
  readonly title: string;
  readonly synopsis: string;
  readonly createdBy: UuidV7;
  readonly createdAt: IsoUtcTimestamp;
  readonly target: "outline_draft";
}

export class WhatIfBranch {
  private constructor(private readonly snapshot: WhatIfBranchSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: {
    readonly id: string;
    readonly projectId: string;
    readonly sourceEventId: string;
    readonly baseTimelineRevision: number;
    readonly hypothesis: string;
    readonly now: string;
  }): Result<WhatIfBranch, StoryCoreError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const projectId = parseUuidV7(input.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const sourceEventId = parseUuidV7(input.sourceEventId);
    if (!sourceEventId.ok) {
      return sourceEventId;
    }
    const hypothesis = validateBoundedText(
      input.hypothesis,
      MAX_MEMORY_TEXT_LENGTH,
      "What-if hypothesis",
    );
    if (!hypothesis.ok) {
      return hypothesis;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (!Number.isSafeInteger(input.baseTimelineRevision) || input.baseTimelineRevision < 1) {
      return whatIfValidationError("What-if timeline baseline is invalid.");
    }
    return ok(
      new WhatIfBranch({
        id: id.value,
        projectId: projectId.value,
        sourceEventId: sourceEventId.value,
        baseTimelineRevision: input.baseTimelineRevision,
        hypothesis: hypothesis.value,
        status: "draft",
        effects: Object.freeze([]),
        revision: 1,
        createdAt: now.value,
        updatedAt: now.value,
      }),
    );
  }

  public static rehydrate(snapshot: WhatIfBranchSnapshot): Result<WhatIfBranch, StoryCoreError> {
    const validated = validateWhatIfSnapshot(snapshot);
    return validated.ok ? ok(new WhatIfBranch(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get status(): WhatIfStatus {
    return this.snapshot.status;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public toSnapshot(): WhatIfBranchSnapshot {
    return cloneWhatIfSnapshot(this.snapshot);
  }

  public recordSimulation(input: {
    readonly effects: readonly Readonly<{
      id: string;
      effectType: string;
      summary: string;
      impactedRecordIds: readonly string[];
      confidence: number;
    }>[];
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<WhatIfBranch, StoryCoreError> {
    const revision = this.requireRevision(input.expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    if (this.snapshot.status !== "draft" && this.snapshot.status !== "simulated") {
      return whatIfTransitionError("Only an active sandbox branch can record simulation effects.");
    }
    if (input.effects.length === 0 || input.effects.length > 64) {
      return whatIfValidationError("What-if simulation requires a bounded effect set.");
    }
    const effects: WhatIfEffect[] = [];
    for (const effect of input.effects) {
      const validated = validateEffect(effect);
      if (!validated.ok) {
        return validated;
      }
      effects.push(validated.value);
    }
    if (new Set(effects.map((effect) => effect.id)).size !== effects.length) {
      return whatIfValidationError("What-if effect identifiers must be unique.");
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }
    return WhatIfBranch.rehydrate({
      ...this.snapshot,
      status: "simulated",
      effects: Object.freeze(effects),
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  public compareToFormalTimeline(
    formalTimelineRevision: number,
    events: readonly FormalStoryRecord[],
  ): Result<WhatIfComparison, StoryCoreError> {
    if (this.snapshot.status !== "simulated") {
      return whatIfTransitionError("What-if branch must be simulated before comparison.");
    }
    if (
      !Number.isSafeInteger(formalTimelineRevision) ||
      formalTimelineRevision < 1 ||
      formalTimelineRevision < this.snapshot.baseTimelineRevision ||
      events.some(
        (event) => event.kind !== "timeline_event" || event.projectId !== this.snapshot.projectId,
      )
    ) {
      return whatIfValidationError("Formal timeline comparison input is invalid.");
    }
    const formalEventIds = events.map((event) => event.id);
    if (
      new Set(formalEventIds).size !== formalEventIds.length ||
      !formalEventIds.includes(this.snapshot.sourceEventId)
    ) {
      return whatIfValidationError(
        "Formal timeline must uniquely contain the branch source event.",
      );
    }
    return ok(
      Object.freeze({
        branchId: this.snapshot.id,
        baseTimelineRevision: this.snapshot.baseTimelineRevision,
        formalTimelineRevision,
        formalEventIds: Object.freeze(formalEventIds),
        effects: Object.freeze(this.snapshot.effects.map(cloneEffect)),
        sandbox: true,
        canCommitFormalTimeline: false,
      }),
    );
  }

  public promoteToOutlineDraft(input: {
    readonly draftId: string;
    readonly title: string;
    readonly synopsis: string;
    readonly actorId: string;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<
    Readonly<{
      branch: WhatIfBranch;
      draft: OutlineDraftCandidate;
    }>,
    StoryCoreError
  > {
    if (input.humanConfirmed !== true) {
      return err(
        new StoryCoreError({
          code: "HUMAN_DECISION_REQUIRED",
          message: "Promoting a What-if result requires explicit human confirmation.",
        }),
      );
    }
    const revision = this.requireRevision(input.expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    if (this.snapshot.status !== "simulated") {
      return whatIfTransitionError("Only a simulated branch can become an outline draft.");
    }
    const draftId = parseUuidV7(input.draftId);
    if (!draftId.ok) {
      return draftId;
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const title = validateBoundedText(input.title, 200, "Outline draft title");
    if (!title.ok) {
      return title;
    }
    const synopsis = validateBoundedText(
      input.synopsis,
      MAX_MEMORY_TEXT_LENGTH,
      "Outline draft synopsis",
    );
    if (!synopsis.ok) {
      return synopsis;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }
    const branch = WhatIfBranch.rehydrate({
      ...this.snapshot,
      status: "promoted_to_outline_draft",
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
    if (!branch.ok) {
      return branch;
    }
    return ok({
      branch: branch.value,
      draft: Object.freeze({
        id: draftId.value,
        sourceBranchId: this.snapshot.id,
        projectId: this.snapshot.projectId,
        title: title.value,
        synopsis: synopsis.value,
        createdBy: actorId.value,
        createdAt: now.value,
        target: "outline_draft",
      }),
    });
  }

  public discard(expectedRevision: number, nowValue: string): Result<WhatIfBranch, StoryCoreError> {
    const revision = this.requireRevision(expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    if (
      this.snapshot.status === "discarded" ||
      this.snapshot.status === "promoted_to_outline_draft"
    ) {
      return whatIfTransitionError("Completed What-if branch cannot be discarded again.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }
    return WhatIfBranch.rehydrate({
      ...this.snapshot,
      status: "discarded",
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  public requestFormalTimelineCommit(): Result<never, StoryCoreError> {
    return err(
      new StoryCoreError({
        code: "WHAT_IF_FORMAL_COMMIT_FORBIDDEN",
        message: "What-if branches are sandbox comparisons and cannot commit the formal timeline.",
        actions: ["DISCARD_BRANCH"],
      }),
    );
  }

  private requireRevision(expectedRevision: number): Result<true, StoryCoreError> {
    if (expectedRevision !== this.snapshot.revision) {
      return err(
        new StoryCoreError({
          code: "STORY_REVISION_CONFLICT",
          message: "What-if branch changed before this operation.",
          retryable: true,
          actions: ["RETRY", "RECOMPARE"],
          details: {
            expectedRevision,
            actualRevision: this.snapshot.revision,
          },
        }),
      );
    }
    return ok(true);
  }

  private requireMutationTime(now: IsoUtcTimestamp): Result<true, StoryCoreError> {
    return compareTimestamps(now, this.snapshot.updatedAt) < 0
      ? whatIfValidationError("What-if branch mutation time cannot move backwards.")
      : ok(true);
  }
}

function validateWhatIfSnapshot(
  snapshot: WhatIfBranchSnapshot,
): Result<WhatIfBranchSnapshot, StoryCoreError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const projectId = parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  const sourceEventId = parseUuidV7(snapshot.sourceEventId);
  if (!sourceEventId.ok) {
    return sourceEventId;
  }
  const hypothesis = validateBoundedText(
    snapshot.hypothesis,
    MAX_MEMORY_TEXT_LENGTH,
    "What-if hypothesis",
  );
  if (!hypothesis.ok) {
    return hypothesis;
  }
  const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseIsoUtcTimestamp(snapshot.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  if (
    !WHAT_IF_STATUSES.includes(snapshot.status) ||
    !Number.isSafeInteger(snapshot.baseTimelineRevision) ||
    snapshot.baseTimelineRevision < 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    snapshot.effects.length > 64 ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0 ||
    (snapshot.status === "draft" &&
      (snapshot.revision !== 1 ||
        snapshot.effects.length !== 0 ||
        compareTimestamps(updatedAt.value, createdAt.value) !== 0)) ||
    (snapshot.status === "simulated" && (snapshot.revision < 2 || snapshot.effects.length === 0)) ||
    (snapshot.status === "promoted_to_outline_draft" &&
      (snapshot.revision < 3 || snapshot.effects.length === 0)) ||
    (snapshot.status === "discarded" &&
      !(
        (snapshot.revision === 2 && snapshot.effects.length === 0) ||
        (snapshot.revision >= 3 && snapshot.effects.length > 0)
      ))
  ) {
    return whatIfValidationError("What-if branch snapshot is invalid.");
  }
  const effects: WhatIfEffect[] = [];
  const effectIds = new Set<UuidV7>();
  for (const effect of snapshot.effects) {
    const validated = validateEffect(effect);
    if (!validated.ok) {
      return validated;
    }
    if (effectIds.has(validated.value.id)) {
      return whatIfValidationError("What-if effect identifiers must be unique.");
    }
    effectIds.add(validated.value.id);
    effects.push(validated.value);
  }
  return ok({
    id: id.value,
    projectId: projectId.value,
    sourceEventId: sourceEventId.value,
    baseTimelineRevision: snapshot.baseTimelineRevision,
    hypothesis: hypothesis.value,
    status: snapshot.status,
    effects: Object.freeze(effects),
    revision: snapshot.revision,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function validateEffect(
  effect: Readonly<{
    id: string;
    effectType: string;
    summary: string;
    impactedRecordIds: readonly string[];
    confidence: number;
  }>,
): Result<WhatIfEffect, StoryCoreError> {
  const id = parseUuidV7(effect.id);
  if (!id.ok) {
    return id;
  }
  const effectType = parseSafeIdentifier(effect.effectType);
  if (!effectType.ok) {
    return effectType;
  }
  const summary = validateBoundedText(
    effect.summary,
    MAX_MEMORY_TEXT_LENGTH,
    "What-if effect summary",
  );
  if (!summary.ok) {
    return summary;
  }
  if (
    effect.impactedRecordIds.length > 64 ||
    !Number.isFinite(effect.confidence) ||
    effect.confidence < 0 ||
    effect.confidence > 1
  ) {
    return whatIfValidationError("What-if effect is invalid.");
  }
  const impactedRecordIds: UuidV7[] = [];
  for (const recordId of effect.impactedRecordIds) {
    const parsed = parseUuidV7(recordId);
    if (!parsed.ok) {
      return parsed;
    }
    impactedRecordIds.push(parsed.value);
  }
  if (new Set(impactedRecordIds).size !== impactedRecordIds.length) {
    return whatIfValidationError("What-if impacted record identifiers must be unique.");
  }
  return ok(
    Object.freeze({
      id: id.value,
      effectType: effectType.value,
      summary: summary.value,
      impactedRecordIds: Object.freeze(impactedRecordIds),
      confidence: effect.confidence,
    }),
  );
}

function cloneWhatIfSnapshot(snapshot: WhatIfBranchSnapshot): WhatIfBranchSnapshot {
  return {
    ...snapshot,
    effects: Object.freeze(snapshot.effects.map(cloneEffect)),
  };
}

function cloneEffect(effect: WhatIfEffect): WhatIfEffect {
  return Object.freeze({
    ...effect,
    impactedRecordIds: Object.freeze([...effect.impactedRecordIds]),
  });
}

function whatIfValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function whatIfTransitionError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "WHAT_IF_INVALID_TRANSITION",
      message,
    }),
  );
}
