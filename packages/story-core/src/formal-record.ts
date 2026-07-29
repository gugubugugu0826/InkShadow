import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { cloneStoryValue, createStoryValue, storyValuesEqual, type StoryValue } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "./value-objects.js";

export const FORMAL_RECORD_KINDS = [
  "character",
  "world_rule",
  "foreshadow",
  "timeline_event",
] as const;
export type FormalRecordKind = (typeof FORMAL_RECORD_KINDS)[number];

export const FORMAL_VERSION_REASONS = [
  "created",
  "manual",
  "suggestion_accepted",
  "suggestion_modified",
  "undo",
] as const;
export type FormalVersionReason = (typeof FORMAL_VERSION_REASONS)[number];

export interface FormalRecordVersion {
  readonly version: number;
  readonly value: StoryValue;
  readonly previousVersion: number | null;
  readonly restoredFromVersion: number | null;
  readonly reason: FormalVersionReason;
  readonly sourceReviewItemId: UuidV7 | null;
  readonly actorId: UuidV7;
  readonly createdAt: IsoUtcTimestamp;
}

export interface FormalStoryRecordSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly kind: FormalRecordKind;
  readonly recordKey: SafeIdentifier;
  readonly revision: number;
  readonly currentVersion: number;
  readonly versions: readonly FormalRecordVersion[];
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateFormalStoryRecordInput {
  readonly id: string;
  readonly projectId: string;
  readonly kind: FormalRecordKind;
  readonly recordKey: string;
  readonly value: unknown;
  readonly actorId: string;
  readonly humanConfirmed: unknown;
  readonly now: string;
}

export interface DomainChangePlanSnapshot {
  readonly id: UuidV7;
  readonly reviewItemId: UuidV7;
  readonly targetRecordId: UuidV7;
  readonly targetRecordKind: FormalRecordKind;
  readonly expectedRecordRevision: number;
  readonly mode: "accepted" | "modified";
  readonly originalValue: StoryValue;
  readonly suggestedValue: StoryValue;
  readonly finalValue: StoryValue;
  readonly actorId: UuidV7;
  readonly createdAt: IsoUtcTimestamp;
}

export interface CreateHumanDomainChangePlanInput {
  readonly id: string;
  readonly reviewItemId: string;
  readonly targetRecordId: string;
  readonly targetRecordKind: FormalRecordKind;
  readonly expectedRecordRevision: number;
  readonly mode: "accepted" | "modified";
  readonly originalValue: unknown;
  readonly suggestedValue: unknown;
  readonly finalValue: unknown;
  readonly actorId: string;
  readonly humanConfirmed: unknown;
  readonly now: string;
}

export class DomainChangePlan {
  private constructor(private readonly snapshot: DomainChangePlanSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static fromHumanDecision(
    input: CreateHumanDomainChangePlanInput,
  ): Result<DomainChangePlan, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return err(
        new StoryCoreError({
          code: "HUMAN_DECISION_REQUIRED",
          message: "Formal story changes require an explicit human confirmation.",
          actions: ["REVIEW_EVIDENCE"],
        }),
      );
    }
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const reviewItemId = parseUuidV7(input.reviewItemId);
    if (!reviewItemId.ok) {
      return reviewItemId;
    }
    const targetRecordId = parseUuidV7(input.targetRecordId);
    if (!targetRecordId.ok) {
      return targetRecordId;
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const originalValue = createStoryValue(input.originalValue);
    if (!originalValue.ok) {
      return originalValue;
    }
    const suggestedValue = createStoryValue(input.suggestedValue);
    if (!suggestedValue.ok) {
      return suggestedValue;
    }
    const finalValue = createStoryValue(input.finalValue);
    if (!finalValue.ok) {
      return finalValue;
    }
    if (
      !FORMAL_RECORD_KINDS.includes(input.targetRecordKind) ||
      !Number.isSafeInteger(input.expectedRecordRevision) ||
      input.expectedRecordRevision < 1 ||
      storyValuesEqual(originalValue.value, suggestedValue.value) ||
      storyValuesEqual(originalValue.value, finalValue.value) ||
      (input.mode === "accepted" && !storyValuesEqual(finalValue.value, suggestedValue.value)) ||
      (input.mode === "modified" && storyValuesEqual(finalValue.value, suggestedValue.value))
    ) {
      return formalValidationError("Domain change plan is invalid.");
    }

    return ok(
      new DomainChangePlan({
        id: id.value,
        reviewItemId: reviewItemId.value,
        targetRecordId: targetRecordId.value,
        targetRecordKind: input.targetRecordKind,
        expectedRecordRevision: input.expectedRecordRevision,
        mode: input.mode,
        originalValue: originalValue.value,
        suggestedValue: suggestedValue.value,
        finalValue: finalValue.value,
        actorId: actorId.value,
        createdAt: now.value,
      }),
    );
  }

  public toSnapshot(): DomainChangePlanSnapshot {
    return {
      ...this.snapshot,
      originalValue: cloneStoryValue(this.snapshot.originalValue),
      suggestedValue: cloneStoryValue(this.snapshot.suggestedValue),
      finalValue: cloneStoryValue(this.snapshot.finalValue),
    };
  }
}

export class FormalStoryRecord {
  private constructor(private readonly snapshot: FormalStoryRecordSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(
    input: CreateFormalStoryRecordInput,
  ): Result<FormalStoryRecord, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const projectId = parseUuidV7(input.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const recordKey = parseSafeIdentifier(input.recordKey);
    if (!recordKey.ok) {
      return recordKey;
    }
    const value = createStoryValue(input.value);
    if (!value.ok) {
      return value;
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (!FORMAL_RECORD_KINDS.includes(input.kind)) {
      return formalValidationError("Formal story record kind is invalid.");
    }
    const initialVersion: FormalRecordVersion = Object.freeze({
      version: 1,
      value: value.value,
      previousVersion: null,
      restoredFromVersion: null,
      reason: "created",
      sourceReviewItemId: null,
      actorId: actorId.value,
      createdAt: now.value,
    });
    return ok(
      new FormalStoryRecord({
        id: id.value,
        projectId: projectId.value,
        kind: input.kind,
        recordKey: recordKey.value,
        revision: 1,
        currentVersion: 1,
        versions: Object.freeze([initialVersion]),
        createdAt: now.value,
        updatedAt: now.value,
      }),
    );
  }

  public static rehydrate(
    snapshot: FormalStoryRecordSnapshot,
  ): Result<FormalStoryRecord, StoryCoreError> {
    const validated = validateFormalRecordSnapshot(snapshot);
    return validated.ok ? ok(new FormalStoryRecord(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get kind(): FormalRecordKind {
    return this.snapshot.kind;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public get currentValue(): StoryValue {
    const version = this.snapshot.versions.find(
      (candidate) => candidate.version === this.snapshot.currentVersion,
    );
    if (version === undefined) {
      throw new Error("Validated formal record lost its current version.");
    }
    return cloneStoryValue(version.value);
  }

  public toSnapshot(): FormalStoryRecordSnapshot {
    return cloneFormalRecordSnapshot(this.snapshot);
  }

  public applyChangePlan(
    plan: DomainChangePlan,
    expectedRevision: number,
    nowValue: string,
  ): Result<FormalStoryRecord, StoryCoreError> {
    const revision = this.requireRevision(expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const planSnapshot = plan.toSnapshot();
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (
      planSnapshot.targetRecordId !== this.snapshot.id ||
      planSnapshot.targetRecordKind !== this.snapshot.kind ||
      planSnapshot.expectedRecordRevision !== this.snapshot.revision ||
      !storyValuesEqual(planSnapshot.originalValue, this.currentValue) ||
      compareTimestamps(planSnapshot.createdAt, now.value) > 0
    ) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_PLAN_MISMATCH",
          message: "Human decision plan no longer matches the formal record baseline.",
          actions: ["RECOMPARE", "REVIEW_EVIDENCE"],
        }),
      );
    }
    return this.appendVersion({
      value: planSnapshot.finalValue,
      reason: planSnapshot.mode === "accepted" ? "suggestion_accepted" : "suggestion_modified",
      sourceReviewItemId: planSnapshot.reviewItemId,
      actorId: planSnapshot.actorId,
      restoredFromVersion: null,
      now: now.value,
    });
  }

  public editManually(input: {
    readonly value: unknown;
    readonly actorId: string;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<FormalStoryRecord, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    const revision = this.requireRevision(input.expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const value = createStoryValue(input.value);
    if (!value.ok) {
      return value;
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (storyValuesEqual(value.value, this.currentValue)) {
      return formalValidationError("Formal story value is unchanged.");
    }
    return this.appendVersion({
      value: value.value,
      reason: "manual",
      sourceReviewItemId: null,
      actorId: actorId.value,
      restoredFromVersion: null,
      now: now.value,
    });
  }

  public undo(input: {
    readonly targetVersion: number;
    readonly actorId: string;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<FormalStoryRecord, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    const revision = this.requireRevision(input.expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const target = this.snapshot.versions.find(
      (version) => version.version === input.targetVersion,
    );
    if (target === undefined) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_VERSION_NOT_FOUND",
          message: "Requested formal story version was not found.",
        }),
      );
    }
    if (storyValuesEqual(target.value, this.currentValue)) {
      return formalValidationError("Undo target already matches the current formal value.");
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    return this.appendVersion({
      value: target.value,
      reason: "undo",
      sourceReviewItemId: null,
      actorId: actorId.value,
      restoredFromVersion: target.version,
      now: now.value,
    });
  }

  private appendVersion(input: {
    readonly value: StoryValue;
    readonly reason: FormalVersionReason;
    readonly sourceReviewItemId: UuidV7 | null;
    readonly actorId: UuidV7;
    readonly restoredFromVersion: number | null;
    readonly now: IsoUtcTimestamp;
  }): Result<FormalStoryRecord, StoryCoreError> {
    if (compareTimestamps(input.now, this.snapshot.updatedAt) < 0) {
      return formalValidationError("Formal story record mutation time cannot move backwards.");
    }
    const version = this.snapshot.currentVersion + 1;
    const appended: FormalRecordVersion = Object.freeze({
      version,
      value: cloneStoryValue(input.value),
      previousVersion: this.snapshot.currentVersion,
      restoredFromVersion: input.restoredFromVersion,
      reason: input.reason,
      sourceReviewItemId: input.sourceReviewItemId,
      actorId: input.actorId,
      createdAt: input.now,
    });
    return FormalStoryRecord.rehydrate({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      currentVersion: version,
      versions: Object.freeze([...this.snapshot.versions, appended]),
      updatedAt: input.now,
    });
  }

  private requireRevision(expectedRevision: number): Result<true, StoryCoreError> {
    if (expectedRevision !== this.snapshot.revision) {
      return revisionConflict(expectedRevision, this.snapshot.revision);
    }
    return ok(true);
  }
}

type KindSpecificCreateInput = Omit<CreateFormalStoryRecordInput, "kind">;

export type CharacterRecord = FormalStoryRecord;
export const CharacterRecord = createKindFactory("character");

export type WorldRule = FormalStoryRecord;
export const WorldRule = createKindFactory("world_rule");

export type ForeshadowRecord = FormalStoryRecord;
export const ForeshadowRecord = createKindFactory("foreshadow");

export type TimelineEvent = FormalStoryRecord;
export const TimelineEvent = createKindFactory("timeline_event");

function createKindFactory(kind: FormalRecordKind): Readonly<{
  create(input: KindSpecificCreateInput): Result<FormalStoryRecord, StoryCoreError>;
}> {
  return Object.freeze({
    create: (input: KindSpecificCreateInput) => FormalStoryRecord.create({ ...input, kind }),
  });
}

function validateFormalRecordSnapshot(
  snapshot: FormalStoryRecordSnapshot,
): Result<FormalStoryRecordSnapshot, StoryCoreError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const projectId = parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  const recordKey = parseSafeIdentifier(snapshot.recordKey);
  if (!recordKey.ok) {
    return recordKey;
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
    !FORMAL_RECORD_KINDS.includes(snapshot.kind) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !Number.isSafeInteger(snapshot.currentVersion) ||
    snapshot.currentVersion < 1 ||
    snapshot.versions.length > 100_000 ||
    snapshot.versions.length !== snapshot.currentVersion ||
    snapshot.revision !== snapshot.currentVersion ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0
  ) {
    return formalValidationError("Formal story record counters are invalid.");
  }

  const versions: FormalRecordVersion[] = [];
  const sourceReviewItemIds = new Set<UuidV7>();
  let previousCreatedAt = createdAt.value;
  for (let index = 0; index < snapshot.versions.length; index += 1) {
    const version = snapshot.versions[index];
    if (version === undefined) {
      return formalValidationError("Formal record version is missing.");
    }
    const validated = validateVersion(version, index + 1);
    if (!validated.ok) {
      return validated;
    }
    if (
      (index === 0 && compareTimestamps(validated.value.createdAt, createdAt.value) !== 0) ||
      compareTimestamps(validated.value.createdAt, previousCreatedAt) < 0
    ) {
      return formalValidationError("Formal record version timestamps are out of order.");
    }
    const previousVersion = versions.at(-1);
    if (
      previousVersion !== undefined &&
      storyValuesEqual(previousVersion.value, validated.value.value)
    ) {
      return formalValidationError("Formal record versions must represent actual value changes.");
    }
    if (
      validated.value.reason === "undo" &&
      (validated.value.restoredFromVersion === null ||
        !storyValuesEqual(
          validated.value.value,
          versions[validated.value.restoredFromVersion - 1]?.value ?? null,
        ))
    ) {
      return formalValidationError(
        "Undo version must restore the value of its referenced version.",
      );
    }
    if (validated.value.sourceReviewItemId !== null) {
      if (sourceReviewItemIds.has(validated.value.sourceReviewItemId)) {
        return formalValidationError("A review item can change a formal record only once.");
      }
      sourceReviewItemIds.add(validated.value.sourceReviewItemId);
    }
    versions.push(validated.value);
    previousCreatedAt = validated.value.createdAt;
  }
  const latestVersion = versions.at(-1);
  if (
    latestVersion === undefined ||
    compareTimestamps(updatedAt.value, latestVersion.createdAt) !== 0
  ) {
    return formalValidationError("Formal record update time must match its latest version.");
  }
  return ok({
    id: id.value,
    projectId: projectId.value,
    kind: snapshot.kind,
    recordKey: recordKey.value,
    revision: snapshot.revision,
    currentVersion: snapshot.currentVersion,
    versions: Object.freeze(versions),
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function validateVersion(
  version: FormalRecordVersion,
  expectedVersion: number,
): Result<FormalRecordVersion, StoryCoreError> {
  const value = createStoryValue(version.value);
  if (!value.ok) {
    return value;
  }
  const actorId = parseUuidV7(version.actorId);
  if (!actorId.ok) {
    return actorId;
  }
  const sourceReviewItemId =
    version.sourceReviewItemId === null ? ok(null) : parseUuidV7(version.sourceReviewItemId);
  if (!sourceReviewItemId.ok) {
    return sourceReviewItemId;
  }
  const createdAt = parseIsoUtcTimestamp(version.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const validFirst =
    expectedVersion === 1 && version.previousVersion === null && version.reason === "created";
  const validLater =
    expectedVersion > 1 &&
    version.previousVersion === expectedVersion - 1 &&
    version.reason !== "created";
  const suggestionReason =
    version.reason === "suggestion_accepted" || version.reason === "suggestion_modified";
  if (
    version.version !== expectedVersion ||
    !FORMAL_VERSION_REASONS.includes(version.reason) ||
    (!validFirst && !validLater) ||
    suggestionReason !== (sourceReviewItemId.value !== null) ||
    (version.reason === "undo") !== (version.restoredFromVersion !== null) ||
    (version.restoredFromVersion !== null &&
      (!Number.isSafeInteger(version.restoredFromVersion) ||
        version.restoredFromVersion < 1 ||
        version.restoredFromVersion >= version.version))
  ) {
    return formalValidationError("Formal record version chain is invalid.");
  }
  return ok(
    Object.freeze({
      version: version.version,
      value: value.value,
      previousVersion: version.previousVersion,
      restoredFromVersion: version.restoredFromVersion,
      reason: version.reason,
      sourceReviewItemId: sourceReviewItemId.value,
      actorId: actorId.value,
      createdAt: createdAt.value,
    }),
  );
}

function cloneFormalRecordSnapshot(snapshot: FormalStoryRecordSnapshot): FormalStoryRecordSnapshot {
  return {
    ...snapshot,
    versions: Object.freeze(
      snapshot.versions.map((version) =>
        Object.freeze({
          ...version,
          value: cloneStoryValue(version.value),
        }),
      ),
    ),
  };
}

function formalValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function humanDecisionError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Formal story records require explicit human confirmation.",
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}

function revisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Formal story record changed before this operation.",
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: { expectedRevision, actualRevision },
    }),
  );
}
