import { StoryCoreError } from "./errors.js";
import { DomainChangePlan, FORMAL_RECORD_KINDS, type FormalRecordKind } from "./formal-record.js";
import { err, ok, type Result } from "./result.js";
import {
  cloneStoryValue,
  createEvidence,
  createStoryValue,
  storyValuesEqual,
  validateSourceIds,
  type Evidence,
  type StoryValue,
} from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "./value-objects.js";

export const REVIEW_ITEM_STATUSES = [
  "pending",
  "accepted",
  "modified",
  "rejected",
  "deferred",
] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];

export const REVIEW_ITEM_TYPES = ["extraction", "consistency"] as const;
export type ReviewItemType = (typeof REVIEW_ITEM_TYPES)[number];

export const REVIEW_SEVERITIES = ["info", "warning", "error"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_DECISION_KINDS = [
  "accepted",
  "modified",
  "rejected",
  "deferred",
  "resumed",
] as const;
export type ReviewDecisionKind = (typeof REVIEW_DECISION_KINDS)[number];

const HUMAN_REVIEW_DECISION_KINDS = ["accept", "modify", "reject", "defer", "resume"] as const;

export interface ReviewDecisionRecord {
  readonly id: UuidV7;
  readonly kind: ReviewDecisionKind;
  readonly actorId: UuidV7;
  readonly finalValue: StoryValue | null;
  readonly decidedAt: IsoUtcTimestamp;
  readonly remindAt: IsoUtcTimestamp | null;
}

export interface StructuredReviewItemSnapshot<ItemType extends ReviewItemType = ReviewItemType> {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly itemType: ItemType;
  readonly category: SafeIdentifier;
  readonly severity: ReviewSeverity;
  readonly targetRecordId: UuidV7;
  readonly targetRecordKind: FormalRecordKind;
  readonly sourceChapterId: UuidV7;
  readonly sourceVersionId: UuidV7;
  readonly evidence: Evidence;
  readonly confidence: number;
  readonly originalValue: StoryValue;
  readonly suggestedValue: StoryValue;
  readonly finalValue: StoryValue | null;
  readonly status: ReviewItemStatus;
  readonly revision: number;
  readonly deferredUntil: IsoUtcTimestamp | null;
  readonly decisions: readonly ReviewDecisionRecord[];
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateStructuredReviewItemInput {
  readonly id: string;
  readonly projectId: string;
  readonly category: string;
  readonly severity?: ReviewSeverity;
  readonly targetRecordId: string;
  readonly targetRecordKind: FormalRecordKind;
  readonly sourceChapterId: string;
  readonly sourceVersionId: string;
  readonly evidence: Readonly<{
    excerpt: string;
    start: number;
    end: number;
    sourceLength: number;
  }>;
  readonly confidence: number;
  readonly originalValue: unknown;
  readonly suggestedValue: unknown;
  readonly now: string;
}

export interface HumanReviewDecisionInput {
  readonly kind: "accept" | "modify" | "reject" | "defer" | "resume";
  readonly decisionId: string;
  readonly actorId: string;
  readonly humanConfirmed: unknown;
  readonly expectedRevision: number;
  readonly expectedRecordRevision?: number;
  readonly modifiedValue?: unknown;
  readonly remindAt?: string;
  readonly now: string;
}

export interface ReviewDecisionOutcome<ItemType extends ReviewItemType = ReviewItemType> {
  readonly item: StructuredReviewItem<ItemType>;
  readonly plan: DomainChangePlan | null;
}

export class StructuredReviewItem<ItemType extends ReviewItemType = ReviewItemType> {
  private constructor(private readonly snapshot: StructuredReviewItemSnapshot<ItemType>) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create<ItemType extends ReviewItemType>(
    itemType: ItemType,
    input: CreateStructuredReviewItemInput,
  ): Result<StructuredReviewItem<ItemType>, StoryCoreError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const projectId = parseUuidV7(input.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const category = parseSafeIdentifier(input.category);
    if (!category.ok) {
      return category;
    }
    const targetRecordId = parseUuidV7(input.targetRecordId);
    if (!targetRecordId.ok) {
      return targetRecordId;
    }
    const source = validateSourceIds(input);
    if (!source.ok) {
      return source;
    }
    const evidence = createEvidence(input.evidence);
    if (!evidence.ok) {
      return evidence;
    }
    const originalValue = createStoryValue(input.originalValue);
    if (!originalValue.ok) {
      return originalValue;
    }
    const suggestedValue = createStoryValue(input.suggestedValue);
    if (!suggestedValue.ok) {
      return suggestedValue;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const severity = input.severity ?? "info";
    if (
      !REVIEW_ITEM_TYPES.includes(itemType) ||
      !REVIEW_SEVERITIES.includes(severity) ||
      !FORMAL_RECORD_KINDS.includes(input.targetRecordKind) ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1 ||
      storyValuesEqual(originalValue.value, suggestedValue.value)
    ) {
      return reviewValidationError("Structured review item fields are invalid.");
    }

    return ok(
      new StructuredReviewItem({
        id: id.value,
        projectId: projectId.value,
        itemType,
        category: category.value,
        severity,
        targetRecordId: targetRecordId.value,
        targetRecordKind: input.targetRecordKind,
        sourceChapterId: source.value.sourceChapterId,
        sourceVersionId: source.value.sourceVersionId,
        evidence: evidence.value,
        confidence: input.confidence,
        originalValue: originalValue.value,
        suggestedValue: suggestedValue.value,
        finalValue: null,
        status: "pending",
        revision: 1,
        deferredUntil: null,
        decisions: Object.freeze([]),
        createdAt: now.value,
        updatedAt: now.value,
      }),
    );
  }

  public static rehydrate<ItemType extends ReviewItemType>(
    snapshot: StructuredReviewItemSnapshot<ItemType>,
  ): Result<StructuredReviewItem<ItemType>, StoryCoreError> {
    const validated = validateReviewItemSnapshot(snapshot);
    return validated.ok ? ok(new StructuredReviewItem(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get itemType(): ItemType {
    return this.snapshot.itemType;
  }

  public get status(): ReviewItemStatus {
    return this.snapshot.status;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public get targetRecordId(): UuidV7 {
    return this.snapshot.targetRecordId;
  }

  public get targetRecordKind(): FormalRecordKind {
    return this.snapshot.targetRecordKind;
  }

  public get originalValue(): StoryValue {
    return cloneStoryValue(this.snapshot.originalValue);
  }

  public toSnapshot(): StructuredReviewItemSnapshot<ItemType> {
    return cloneReviewItemSnapshot(this.snapshot);
  }

  public decide(
    input: HumanReviewDecisionInput,
  ): Result<ReviewDecisionOutcome<ItemType>, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    if (!HUMAN_REVIEW_DECISION_KINDS.some((kind) => kind === input.kind)) {
      return reviewValidationError("Review decision kind is invalid.");
    }
    if (input.expectedRevision !== this.snapshot.revision) {
      return reviewRevisionConflict(input.expectedRevision, this.snapshot.revision);
    }
    if (this.snapshot.status !== "pending" && this.snapshot.status !== "deferred") {
      return reviewTransitionError("Only pending or deferred review items can be decided.");
    }

    const decisionId = parseUuidV7(input.decisionId);
    if (!decisionId.ok) {
      return decisionId;
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(now.value, this.snapshot.updatedAt) < 0) {
      return reviewValidationError("Review decision time cannot move backwards.");
    }

    if (input.kind === "resume") {
      if (this.snapshot.status !== "deferred") {
        return reviewTransitionError("Only a deferred review item can resume.");
      }
      return this.finishDecision({
        status: "pending",
        finalValue: null,
        deferredUntil: null,
        record: {
          id: decisionId.value,
          kind: "resumed",
          actorId: actorId.value,
          finalValue: null,
          decidedAt: now.value,
          remindAt: null,
        },
        plan: null,
      });
    }

    if (input.kind === "defer") {
      if (input.remindAt === undefined) {
        return reviewValidationError("Deferred review item requires a reminder time.");
      }
      const remindAt = parseIsoUtcTimestamp(input.remindAt);
      if (!remindAt.ok) {
        return remindAt;
      }
      if (compareTimestamps(remindAt.value, now.value) <= 0) {
        return reviewValidationError("Deferred reminder must be in the future.");
      }
      return this.finishDecision({
        status: "deferred",
        finalValue: null,
        deferredUntil: remindAt.value,
        record: {
          id: decisionId.value,
          kind: "deferred",
          actorId: actorId.value,
          finalValue: null,
          decidedAt: now.value,
          remindAt: remindAt.value,
        },
        plan: null,
      });
    }

    if (input.kind === "reject") {
      return this.finishDecision({
        status: "rejected",
        finalValue: null,
        deferredUntil: null,
        record: {
          id: decisionId.value,
          kind: "rejected",
          actorId: actorId.value,
          finalValue: null,
          decidedAt: now.value,
          remindAt: null,
        },
        plan: null,
      });
    }

    if (
      input.expectedRecordRevision === undefined ||
      !Number.isSafeInteger(input.expectedRecordRevision) ||
      input.expectedRecordRevision < 1
    ) {
      return reviewValidationError("Accepted review item requires target expected revision.");
    }
    let finalValue = this.snapshot.suggestedValue;
    let mode: "accepted" | "modified" = "accepted";
    if (input.kind === "modify") {
      if (input.modifiedValue === undefined) {
        return reviewValidationError("Modified decision requires the user's final value.");
      }
      const modified = createStoryValue(input.modifiedValue);
      if (!modified.ok) {
        return modified;
      }
      if (storyValuesEqual(modified.value, this.snapshot.suggestedValue)) {
        return reviewValidationError("Unchanged suggestion should use the accept decision.");
      }
      finalValue = modified.value;
      mode = "modified";
    }
    const plan = DomainChangePlan.fromHumanDecision({
      id: decisionId.value,
      reviewItemId: this.snapshot.id,
      targetRecordId: this.snapshot.targetRecordId,
      targetRecordKind: this.snapshot.targetRecordKind,
      expectedRecordRevision: input.expectedRecordRevision,
      mode,
      originalValue: this.snapshot.originalValue,
      suggestedValue: this.snapshot.suggestedValue,
      finalValue,
      actorId: actorId.value,
      humanConfirmed: true,
      now: now.value,
    });
    if (!plan.ok) {
      return plan;
    }
    return this.finishDecision({
      status: mode,
      finalValue,
      deferredUntil: null,
      record: {
        id: decisionId.value,
        kind: mode,
        actorId: actorId.value,
        finalValue,
        decidedAt: now.value,
        remindAt: null,
      },
      plan: plan.value,
    });
  }

  private finishDecision(input: {
    readonly status: ReviewItemStatus;
    readonly finalValue: StoryValue | null;
    readonly deferredUntil: IsoUtcTimestamp | null;
    readonly record: ReviewDecisionRecord;
    readonly plan: DomainChangePlan | null;
  }): Result<ReviewDecisionOutcome<ItemType>, StoryCoreError> {
    const next = StructuredReviewItem.rehydrate<ItemType>({
      ...this.snapshot,
      status: input.status,
      finalValue: input.finalValue === null ? null : cloneStoryValue(input.finalValue),
      deferredUntil: input.deferredUntil,
      decisions: Object.freeze([...this.snapshot.decisions, cloneDecision(input.record)]),
      revision: this.snapshot.revision + 1,
      updatedAt: input.record.decidedAt,
    });
    return next.ok ? ok({ item: next.value, plan: input.plan }) : next;
  }
}

export type ExtractionSuggestion = StructuredReviewItem<"extraction">;
export const ExtractionSuggestion = Object.freeze({
  create: (input: CreateStructuredReviewItemInput): Result<ExtractionSuggestion, StoryCoreError> =>
    StructuredReviewItem.create("extraction", input),
  rehydrate: (
    snapshot: StructuredReviewItemSnapshot<"extraction">,
  ): Result<ExtractionSuggestion, StoryCoreError> => StructuredReviewItem.rehydrate(snapshot),
});

export type ConsistencyIssue = StructuredReviewItem<"consistency">;
export const ConsistencyIssue = Object.freeze({
  create: (input: CreateStructuredReviewItemInput): Result<ConsistencyIssue, StoryCoreError> =>
    StructuredReviewItem.create("consistency", input),
  rehydrate: (
    snapshot: StructuredReviewItemSnapshot<"consistency">,
  ): Result<ConsistencyIssue, StoryCoreError> => StructuredReviewItem.rehydrate(snapshot),
});

function validateReviewItemSnapshot<ItemType extends ReviewItemType>(
  snapshot: StructuredReviewItemSnapshot<ItemType>,
): Result<StructuredReviewItemSnapshot<ItemType>, StoryCoreError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const projectId = parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  const category = parseSafeIdentifier(snapshot.category);
  if (!category.ok) {
    return category;
  }
  const targetRecordId = parseUuidV7(snapshot.targetRecordId);
  if (!targetRecordId.ok) {
    return targetRecordId;
  }
  const source = validateSourceIds(snapshot);
  if (!source.ok) {
    return source;
  }
  const evidence = createEvidence({
    excerpt: snapshot.evidence.excerpt,
    ...snapshot.evidence.range,
  });
  if (!evidence.ok) {
    return evidence;
  }
  const originalValue = createStoryValue(snapshot.originalValue);
  if (!originalValue.ok) {
    return originalValue;
  }
  const suggestedValue = createStoryValue(snapshot.suggestedValue);
  if (!suggestedValue.ok) {
    return suggestedValue;
  }
  const finalValue =
    snapshot.finalValue === null ? ok(null) : createStoryValue(snapshot.finalValue);
  if (!finalValue.ok) {
    return finalValue;
  }
  const deferredUntil =
    snapshot.deferredUntil === null ? ok(null) : parseIsoUtcTimestamp(snapshot.deferredUntil);
  if (!deferredUntil.ok) {
    return deferredUntil;
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
    !REVIEW_ITEM_TYPES.includes(snapshot.itemType) ||
    !REVIEW_SEVERITIES.includes(snapshot.severity) ||
    !REVIEW_ITEM_STATUSES.includes(snapshot.status) ||
    !FORMAL_RECORD_KINDS.includes(snapshot.targetRecordKind) ||
    !Number.isFinite(snapshot.confidence) ||
    snapshot.confidence < 0 ||
    snapshot.confidence > 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    snapshot.decisions.length > 100_000 ||
    snapshot.revision !== snapshot.decisions.length + 1 ||
    storyValuesEqual(originalValue.value, suggestedValue.value) ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0
  ) {
    return reviewValidationError("Structured review item snapshot is invalid.");
  }

  const decisions: ReviewDecisionRecord[] = [];
  const decisionIds = new Set<UuidV7>();
  let replayedStatus: ReviewItemStatus = "pending";
  let replayedFinalValue: StoryValue | null = null;
  let replayedDeferredUntil: IsoUtcTimestamp | null = null;
  let previousDecisionAt = createdAt.value;
  for (const decision of snapshot.decisions) {
    const validated = validateDecision(decision);
    if (!validated.ok) {
      return validated;
    }
    const record = validated.value;
    if (
      decisionIds.has(record.id) ||
      compareTimestamps(record.decidedAt, previousDecisionAt) < 0 ||
      replayedStatus === "accepted" ||
      replayedStatus === "modified" ||
      replayedStatus === "rejected"
    ) {
      return reviewValidationError("Review decision history cannot be replayed.");
    }
    if (record.kind === "resumed") {
      if (replayedStatus !== "deferred") {
        return reviewValidationError("Only a deferred review item can contain a resume decision.");
      }
      replayedStatus = "pending";
      replayedFinalValue = null;
      replayedDeferredUntil = null;
    } else if (record.kind === "deferred") {
      replayedStatus = "deferred";
      replayedFinalValue = null;
      replayedDeferredUntil = record.remindAt;
    } else if (record.kind === "rejected") {
      replayedStatus = "rejected";
      replayedFinalValue = null;
      replayedDeferredUntil = null;
    } else if (record.kind === "accepted") {
      if (
        record.finalValue === null ||
        !storyValuesEqual(record.finalValue, suggestedValue.value)
      ) {
        return reviewValidationError("Accepted decision must preserve the suggested value.");
      }
      replayedStatus = "accepted";
      replayedFinalValue = record.finalValue;
      replayedDeferredUntil = null;
    } else {
      if (
        record.finalValue === null ||
        storyValuesEqual(record.finalValue, suggestedValue.value) ||
        storyValuesEqual(record.finalValue, originalValue.value)
      ) {
        return reviewValidationError("Modified decision must contain a distinct final value.");
      }
      replayedStatus = "modified";
      replayedFinalValue = record.finalValue;
      replayedDeferredUntil = null;
    }
    decisionIds.add(record.id);
    decisions.push(record);
    previousDecisionAt = record.decidedAt;
  }

  const finalValueMatches =
    replayedFinalValue === null
      ? finalValue.value === null
      : finalValue.value !== null && storyValuesEqual(finalValue.value, replayedFinalValue);
  const deferredUntilMatches =
    replayedDeferredUntil === null
      ? deferredUntil.value === null
      : deferredUntil.value !== null &&
        compareTimestamps(deferredUntil.value, replayedDeferredUntil) === 0;
  const expectedUpdatedAt = decisions.at(-1)?.decidedAt ?? createdAt.value;
  if (
    snapshot.status !== replayedStatus ||
    !finalValueMatches ||
    !deferredUntilMatches ||
    compareTimestamps(updatedAt.value, expectedUpdatedAt) !== 0
  ) {
    return reviewValidationError("Review decision history does not match current status.");
  }

  return ok({
    id: id.value,
    projectId: projectId.value,
    itemType: snapshot.itemType,
    category: category.value,
    severity: snapshot.severity,
    targetRecordId: targetRecordId.value,
    targetRecordKind: snapshot.targetRecordKind,
    sourceChapterId: source.value.sourceChapterId,
    sourceVersionId: source.value.sourceVersionId,
    evidence: evidence.value,
    confidence: snapshot.confidence,
    originalValue: originalValue.value,
    suggestedValue: suggestedValue.value,
    finalValue: finalValue.value,
    status: snapshot.status,
    revision: snapshot.revision,
    deferredUntil: deferredUntil.value,
    decisions: Object.freeze(decisions),
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function validateDecision(
  decision: ReviewDecisionRecord,
): Result<ReviewDecisionRecord, StoryCoreError> {
  const id = parseUuidV7(decision.id);
  if (!id.ok) {
    return id;
  }
  const actorId = parseUuidV7(decision.actorId);
  if (!actorId.ok) {
    return actorId;
  }
  const decidedAt = parseIsoUtcTimestamp(decision.decidedAt);
  if (!decidedAt.ok) {
    return decidedAt;
  }
  const remindAt = decision.remindAt === null ? ok(null) : parseIsoUtcTimestamp(decision.remindAt);
  if (!remindAt.ok) {
    return remindAt;
  }
  const finalValue =
    decision.finalValue === null ? ok(null) : createStoryValue(decision.finalValue);
  if (!finalValue.ok) {
    return finalValue;
  }
  const valueDecision = decision.kind === "accepted" || decision.kind === "modified";
  if (
    !REVIEW_DECISION_KINDS.includes(decision.kind) ||
    valueDecision !== (finalValue.value !== null) ||
    (decision.kind === "deferred") !== (remindAt.value !== null) ||
    (remindAt.value !== null && compareTimestamps(remindAt.value, decidedAt.value) <= 0)
  ) {
    return reviewValidationError("Review decision record is invalid.");
  }
  return ok(
    Object.freeze({
      id: id.value,
      kind: decision.kind,
      actorId: actorId.value,
      finalValue: finalValue.value,
      decidedAt: decidedAt.value,
      remindAt: remindAt.value,
    }),
  );
}

function cloneReviewItemSnapshot<ItemType extends ReviewItemType>(
  snapshot: StructuredReviewItemSnapshot<ItemType>,
): StructuredReviewItemSnapshot<ItemType> {
  return {
    ...snapshot,
    evidence: Object.freeze({
      excerpt: snapshot.evidence.excerpt,
      range: Object.freeze({ ...snapshot.evidence.range }),
    }),
    originalValue: cloneStoryValue(snapshot.originalValue),
    suggestedValue: cloneStoryValue(snapshot.suggestedValue),
    finalValue: snapshot.finalValue === null ? null : cloneStoryValue(snapshot.finalValue),
    decisions: Object.freeze(snapshot.decisions.map(cloneDecision)),
  };
}

function cloneDecision(decision: ReviewDecisionRecord): ReviewDecisionRecord {
  return Object.freeze({
    ...decision,
    finalValue: decision.finalValue === null ? null : cloneStoryValue(decision.finalValue),
  });
}

function reviewValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function reviewTransitionError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "REVIEW_INVALID_TRANSITION",
      message,
    }),
  );
}

function humanDecisionError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Review item cannot produce a formal change without explicit human confirmation.",
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}

function reviewRevisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Review item changed before this decision.",
      retryable: true,
      actions: ["RETRY", "RECOMPARE"],
      details: { expectedRevision, actualRevision },
    }),
  );
}
