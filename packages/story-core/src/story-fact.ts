import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import {
  cloneStoryValue,
  createStoryValue,
  validateBoundedText,
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

export const STORY_FACT_STATUSES = [
  "formal",
  "temporary",
  "unconfirmed",
  "deprecated",
  "branch",
] as const;
export type StoryFactStatus = (typeof STORY_FACT_STATUSES)[number];

export const STORY_FACT_ORIGINS = ["user", "ai_extraction", "import", "legacy", "system"] as const;
export type StoryFactOrigin = (typeof STORY_FACT_ORIGINS)[number];

/**
 * System-derived facts in this allow-list are disposable projections. They
 * may be rebuilt from immutable source material, but must never be promoted
 * or mutated as if a user had confirmed them.
 */
export const REBUILDABLE_STORY_FACT_TYPES = [
  "chapter_summary",
  "pacing_metric",
  "analysis_tag",
  "search_index_marker",
] as const;

export function isRebuildableStoryFactType(factType: string): boolean {
  return (REBUILDABLE_STORY_FACT_TYPES as readonly string[]).includes(factType);
}

export const STORY_FACT_SOURCE_KINDS = [
  "chapter_span",
  "legacy_record",
  "review_decision",
  "user_statement",
  "import_source",
  "system_derivation",
] as const;
export type StoryFactSourceKind = (typeof STORY_FACT_SOURCE_KINDS)[number];

export const STORY_FACT_REVISION_CHANGE_KINDS = [
  "created",
  "legacy_backfill",
  "confirmed",
  "governance_updated",
  "deprecated",
] as const;
export type StoryFactRevisionChangeKind = (typeof STORY_FACT_REVISION_CHANGE_KINDS)[number];

export interface StoryFactSourceSnapshot {
  readonly kind: StoryFactSourceKind;
  readonly reference: string;
  /** UTF-16 code-unit offsets, matching JavaScript string indexing. */
  readonly chapterId: UuidV7 | null;
  readonly versionId: UuidV7 | null;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly sourceLength: number | null;
  readonly excerpt: string | null;
}

export interface StoryFactSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly factType: SafeIdentifier;
  readonly contentText: string | null;
  readonly structuredValue: StoryValue | null;
  readonly source: StoryFactSourceSnapshot;
  /** Narrative-time locator. It is intentionally not constrained to wall-clock time. */
  readonly effectiveAt: string | null;
  /** Narrative-time locator at which this fact stops applying. */
  readonly invalidatedAt: string | null;
  readonly branchId: UuidV7 | null;
  readonly confidence: number;
  readonly status: StoryFactStatus;
  readonly origin: StoryFactOrigin;
  readonly userConfirmed: boolean;
  readonly locked: boolean;
  readonly deprecated: boolean;
  readonly needsReview: boolean;
  readonly confirmedByActorId: UuidV7 | null;
  readonly confirmedAt: IsoUtcTimestamp | null;
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateStoryFactInput {
  readonly id: string;
  readonly projectId: string;
  readonly factType: string;
  readonly contentText?: string | null;
  readonly structuredValue?: unknown;
  readonly source: Readonly<{
    readonly kind: StoryFactSourceKind;
    readonly reference: string;
    readonly chapterId?: string | null;
    readonly versionId?: string | null;
    readonly startOffset?: number | null;
    readonly endOffset?: number | null;
    readonly sourceLength?: number | null;
    readonly excerpt?: string | null;
  }>;
  readonly effectiveAt?: string | null;
  readonly invalidatedAt?: string | null;
  readonly branchId?: string | null;
  readonly confidence: number;
  readonly status: Exclude<StoryFactStatus, "deprecated">;
  readonly origin: StoryFactOrigin;
  readonly needsReview: boolean;
  readonly locked?: boolean;
  readonly humanConfirmed: unknown;
  readonly confirmationActorId?: string | null;
  readonly now: string;
}

export interface StoryFactListFilter {
  readonly status?: StoryFactStatus;
  readonly factType?: string;
  readonly branchId?: string | null;
  readonly needsReview?: boolean;
}

export interface StoryFactRevision {
  readonly fact: StoryFact;
  readonly changeKind: StoryFactRevisionChangeKind;
  readonly recordedAt: IsoUtcTimestamp;
}

export interface StoryFactStore {
  create(fact: StoryFact): Promise<Result<void, StoryCoreError>>;
  findById(id: UuidV7): Promise<Result<StoryFact | null, StoryCoreError>>;
  listByProjectId(
    projectId: UuidV7,
    filter?: StoryFactListFilter,
  ): Promise<Result<readonly StoryFact[], StoryCoreError>>;
  save(fact: StoryFact, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
  listRevisions(factId: UuidV7): Promise<Result<readonly StoryFactRevision[], StoryCoreError>>;
}

export class StoryFact {
  private constructor(private readonly snapshot: StoryFactSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: CreateStoryFactInput): Result<StoryFact, StoryCoreError> {
    if (input.status === "formal" && input.origin !== "user") {
      return factValidationError(
        "AI, imported, legacy, and system facts must be reviewed before becoming formal.",
      );
    }
    if (input.status === "formal" && input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    if (input.status !== "formal" && input.humanConfirmed !== false) {
      return factValidationError("A non-formal fact cannot carry a hidden confirmation.");
    }
    if (input.status === "formal" && input.needsReview) {
      return factValidationError("A formal fact cannot remain in the review queue.");
    }
    if (input.status !== "formal" && input.locked === true) {
      return factValidationError("Only a formal fact can be locked.");
    }
    if (input.origin === "ai_extraction" && !input.needsReview) {
      return factValidationError("AI-extracted facts must start unconfirmed and require review.");
    }
    if ((input.origin === "legacy" || input.origin === "import") && !input.needsReview) {
      return factValidationError(
        "Imported and legacy facts must be reviewed before they can become formal.",
      );
    }

    const now = parseCanonicalTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const confirmationActorId =
      input.status === "formal"
        ? parseRequiredUuid(input.confirmationActorId, "A formal fact requires a confirming actor.")
        : ok(null);
    if (!confirmationActorId.ok) {
      return confirmationActorId;
    }

    return StoryFact.rehydrate(
      {
        id: input.id as UuidV7,
        projectId: input.projectId as UuidV7,
        factType: input.factType as SafeIdentifier,
        contentText: input.contentText ?? null,
        structuredValue:
          input.structuredValue === undefined || input.structuredValue === null
            ? null
            : (input.structuredValue as StoryValue),
        source: {
          kind: input.source.kind,
          reference: input.source.reference,
          chapterId: (input.source.chapterId ?? null) as UuidV7 | null,
          versionId: (input.source.versionId ?? null) as UuidV7 | null,
          startOffset: input.source.startOffset ?? null,
          endOffset: input.source.endOffset ?? null,
          sourceLength: input.source.sourceLength ?? null,
          excerpt: input.source.excerpt ?? null,
        },
        effectiveAt: input.effectiveAt ?? null,
        invalidatedAt: input.invalidatedAt ?? null,
        branchId: (input.branchId ?? null) as UuidV7 | null,
        confidence: input.confidence,
        status: input.status,
        origin: input.origin,
        userConfirmed: input.status === "formal",
        locked: input.status === "formal" && (input.locked ?? false),
        deprecated: false,
        needsReview: input.status === "formal" ? false : input.needsReview,
        confirmedByActorId: confirmationActorId.value,
        confirmedAt: input.status === "formal" ? now.value : null,
        revision: 1,
        createdAt: now.value,
        updatedAt: now.value,
      },
      true,
    );
  }

  public static rehydrate(
    snapshot: StoryFactSnapshot,
    creating = false,
  ): Result<StoryFact, StoryCoreError> {
    const validated = validateStoryFactSnapshot(snapshot, creating);
    return validated.ok ? ok(new StoryFact(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public get status(): StoryFactStatus {
    return this.snapshot.status;
  }

  public toSnapshot(): StoryFactSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  public confirm(input: {
    readonly actorId: string;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly lock?: boolean;
    readonly now: string;
  }): Result<StoryFact, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    if (this.snapshot.status !== "temporary" && this.snapshot.status !== "unconfirmed") {
      return invalidTransition("Only a temporary or unconfirmed fact can be confirmed.");
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    const now = validateMutation(input.expectedRevision, input.now, this.snapshot);
    if (!now.ok) {
      return now;
    }
    return StoryFact.rehydrate({
      ...this.snapshot,
      status: "formal",
      userConfirmed: true,
      locked: input.lock ?? false,
      needsReview: false,
      confirmedByActorId: actorId.value,
      confirmedAt: now.value,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  public setLocked(input: {
    readonly locked: boolean;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<StoryFact, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    if (this.snapshot.status !== "formal" || typeof input.locked !== "boolean") {
      return invalidTransition("Only a formal fact can change its lock state.");
    }
    const now = validateMutation(input.expectedRevision, input.now, this.snapshot);
    if (!now.ok) {
      return now;
    }
    if (input.locked === this.snapshot.locked) {
      return ok(this);
    }
    return StoryFact.rehydrate({
      ...this.snapshot,
      locked: input.locked,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  public deprecate(input: {
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<StoryFact, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanDecisionError();
    }
    if (this.snapshot.status === "deprecated") {
      return invalidTransition("The story fact is already deprecated.");
    }
    if (this.snapshot.status === "branch") {
      return invalidTransition(
        "Branch facts stay isolated; replace or discard the branch instead of changing the fact in place.",
      );
    }
    const now = validateMutation(input.expectedRevision, input.now, this.snapshot);
    if (!now.ok) {
      return now;
    }
    return StoryFact.rehydrate({
      ...this.snapshot,
      status: "deprecated",
      locked: false,
      deprecated: true,
      needsReview: false,
      branchId: null,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  /**
   * Retires only an unreviewed system projection that can be rebuilt from its
   * source. This deliberately has no `humanConfirmed` argument: it is not a
   * shortcut for changing user or formal story truth.
   */
  public deprecateRebuildableSystemFact(input: {
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<StoryFact, StoryCoreError> {
    if (
      !isRebuildableStoryFactType(this.snapshot.factType) ||
      this.snapshot.status !== "temporary" ||
      this.snapshot.origin !== "system" ||
      this.snapshot.userConfirmed ||
      this.snapshot.locked ||
      this.snapshot.deprecated ||
      this.snapshot.needsReview ||
      this.snapshot.branchId !== null
    ) {
      return invalidTransition(
        "Only an active, unreviewed system-derived rebuildable fact can be retired automatically.",
      );
    }
    const now = validateMutation(input.expectedRevision, input.now, this.snapshot);
    if (!now.ok) {
      return now;
    }
    return StoryFact.rehydrate({
      ...this.snapshot,
      status: "deprecated",
      deprecated: true,
      needsReview: false,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }
}

function validateStoryFactSnapshot(
  snapshot: StoryFactSnapshot,
  creating: boolean,
): Result<StoryFactSnapshot, StoryCoreError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const projectId = parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  const factType = parseSafeIdentifier(snapshot.factType);
  if (!factType.ok) {
    return factType;
  }
  const contentText =
    snapshot.contentText === null
      ? ok(null)
      : validateBoundedText(snapshot.contentText, 10_000, "Story fact content");
  if (!contentText.ok) {
    return contentText;
  }
  const structuredValue =
    snapshot.structuredValue === null ? ok(null) : createStoryValue(snapshot.structuredValue);
  if (!structuredValue.ok) {
    return structuredValue;
  }
  if (contentText.value === null && structuredValue.value === null) {
    return factValidationError("A story fact needs text or a structured value.");
  }
  const source = validateSource(snapshot.source);
  if (!source.ok) {
    return source;
  }
  const effectiveAt = validateOptionalNarrativeTime(snapshot.effectiveAt, "effectiveAt");
  if (!effectiveAt.ok) {
    return effectiveAt;
  }
  const invalidatedAt = validateOptionalNarrativeTime(snapshot.invalidatedAt, "invalidatedAt");
  if (!invalidatedAt.ok) {
    return invalidatedAt;
  }
  const branchId = snapshot.branchId === null ? ok(null) : parseUuidV7(snapshot.branchId);
  if (!branchId.ok) {
    return branchId;
  }
  const confirmedByActorId =
    snapshot.confirmedByActorId === null ? ok(null) : parseUuidV7(snapshot.confirmedByActorId);
  if (!confirmedByActorId.ok) {
    return confirmedByActorId;
  }
  const confirmedAt =
    snapshot.confirmedAt === null ? ok(null) : parseCanonicalTimestamp(snapshot.confirmedAt);
  if (!confirmedAt.ok) {
    return confirmedAt;
  }
  const createdAt = parseCanonicalTimestamp(snapshot.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseCanonicalTimestamp(snapshot.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }

  const confirmationConsistent =
    (snapshot.userConfirmed && confirmedByActorId.value !== null && confirmedAt.value !== null) ||
    (!snapshot.userConfirmed && confirmedByActorId.value === null && confirmedAt.value === null);
  const branchConsistent =
    (snapshot.status === "branch" && branchId.value !== null) ||
    (snapshot.status !== "branch" && branchId.value === null);
  const deprecatedConsistent =
    (snapshot.status === "deprecated" && snapshot.deprecated && !snapshot.locked) ||
    (snapshot.status !== "deprecated" && !snapshot.deprecated);
  const formalConsistent =
    snapshot.status !== "formal" ||
    (snapshot.userConfirmed &&
      !snapshot.deprecated &&
      !snapshot.needsReview &&
      branchId.value === null);
  const provisionalConsistent =
    (snapshot.status !== "temporary" &&
      snapshot.status !== "unconfirmed" &&
      snapshot.status !== "branch") ||
    (!snapshot.userConfirmed && !snapshot.locked);
  const aiConsistent =
    snapshot.origin !== "ai_extraction" ||
    snapshot.status === "formal" ||
    snapshot.status === "deprecated" ||
    (!snapshot.userConfirmed && !snapshot.locked && snapshot.needsReview);
  const legacyConsistent =
    snapshot.origin !== "legacy" ||
    snapshot.status === "formal" ||
    snapshot.status === "deprecated" ||
    snapshot.needsReview;
  const importConsistent =
    snapshot.origin !== "import" ||
    snapshot.status === "formal" ||
    snapshot.status === "deprecated" ||
    snapshot.needsReview;

  if (
    !STORY_FACT_STATUSES.includes(snapshot.status) ||
    !STORY_FACT_ORIGINS.includes(snapshot.origin) ||
    !Number.isFinite(snapshot.confidence) ||
    snapshot.confidence < 0 ||
    snapshot.confidence > 1 ||
    typeof snapshot.userConfirmed !== "boolean" ||
    typeof snapshot.locked !== "boolean" ||
    typeof snapshot.deprecated !== "boolean" ||
    typeof snapshot.needsReview !== "boolean" ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    (creating && snapshot.revision !== 1) ||
    (creating && snapshot.status === "deprecated") ||
    (creating && snapshot.status === "formal" && snapshot.origin !== "user") ||
    !confirmationConsistent ||
    !branchConsistent ||
    !deprecatedConsistent ||
    !formalConsistent ||
    !provisionalConsistent ||
    !aiConsistent ||
    !legacyConsistent ||
    !importConsistent ||
    (snapshot.locked && snapshot.status !== "formal") ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0 ||
    (confirmedAt.value !== null && compareTimestamps(confirmedAt.value, createdAt.value) < 0) ||
    (confirmedAt.value !== null && compareTimestamps(confirmedAt.value, updatedAt.value) > 0)
  ) {
    return factValidationError("Story fact lifecycle or evidence state is invalid.");
  }

  return ok({
    id: id.value,
    projectId: projectId.value,
    factType: factType.value,
    contentText: contentText.value,
    structuredValue: structuredValue.value === null ? null : cloneStoryValue(structuredValue.value),
    source: source.value,
    effectiveAt: effectiveAt.value,
    invalidatedAt: invalidatedAt.value,
    branchId: branchId.value,
    confidence: snapshot.confidence,
    status: snapshot.status,
    origin: snapshot.origin,
    userConfirmed: snapshot.userConfirmed,
    locked: snapshot.locked,
    deprecated: snapshot.deprecated,
    needsReview: snapshot.needsReview,
    confirmedByActorId: confirmedByActorId.value,
    confirmedAt: confirmedAt.value,
    revision: snapshot.revision,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function validateSource(
  source: StoryFactSourceSnapshot,
): Result<StoryFactSourceSnapshot, StoryCoreError> {
  if (!STORY_FACT_SOURCE_KINDS.includes(source.kind)) {
    return factValidationError("Story fact source kind is invalid.");
  }
  const reference = validateBoundedText(source.reference, 1_000, "Evidence reference");
  if (!reference.ok) {
    return reference;
  }
  if (source.kind !== "chapter_span") {
    if (
      source.chapterId !== null ||
      source.versionId !== null ||
      source.startOffset !== null ||
      source.endOffset !== null ||
      source.sourceLength !== null ||
      source.excerpt !== null
    ) {
      return factValidationError("Only chapter-span evidence can carry source text offsets.");
    }
    return ok(Object.freeze({ ...source, reference: reference.value }));
  }

  if (
    source.chapterId === null ||
    source.versionId === null ||
    source.startOffset === null ||
    source.endOffset === null ||
    source.sourceLength === null ||
    source.excerpt === null
  ) {
    return factValidationError("Chapter evidence requires a complete version and text span.");
  }
  const chapterId = parseUuidV7(source.chapterId);
  if (!chapterId.ok) {
    return chapterId;
  }
  const versionId = parseUuidV7(source.versionId);
  if (!versionId.ok) {
    return versionId;
  }
  const excerpt = createStoryValue(source.excerpt);
  if (
    !excerpt.ok ||
    typeof excerpt.value !== "string" ||
    excerpt.value.length < 1 ||
    excerpt.value.length > 2_000
  ) {
    return excerpt.ok ? factValidationError("Story fact evidence excerpt is invalid.") : excerpt;
  }
  if (
    !Number.isSafeInteger(source.startOffset) ||
    !Number.isSafeInteger(source.endOffset) ||
    !Number.isSafeInteger(source.sourceLength) ||
    source.startOffset < 0 ||
    source.endOffset <= source.startOffset ||
    source.endOffset > source.sourceLength ||
    source.sourceLength > 5_000_000 ||
    source.endOffset - source.startOffset !== source.excerpt.length
  ) {
    return factValidationError("Story fact source offsets do not match the evidence excerpt.");
  }
  return ok(
    Object.freeze({
      kind: source.kind,
      reference: reference.value,
      chapterId: chapterId.value,
      versionId: versionId.value,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      sourceLength: source.sourceLength,
      excerpt: excerpt.value,
    }),
  );
}

function validateMutation(
  expectedRevision: number,
  nowValue: string,
  snapshot: StoryFactSnapshot,
): Result<IsoUtcTimestamp, StoryCoreError> {
  if (expectedRevision !== snapshot.revision) {
    return err(
      new StoryCoreError({
        code: "STORY_REVISION_CONFLICT",
        message: "Story fact changed before this operation.",
        retryable: true,
        actions: ["RECOMPARE", "RETRY"],
        details: { expectedRevision, actualRevision: snapshot.revision },
      }),
    );
  }
  const now = parseCanonicalTimestamp(nowValue);
  if (!now.ok) {
    return now;
  }
  return compareTimestamps(now.value, snapshot.updatedAt) < 0
    ? factValidationError("Story fact mutation time cannot move backwards.")
    : now;
}

function validateOptionalNarrativeTime(
  value: string | null,
  field: string,
): Result<string | null, StoryCoreError> {
  return value === null ? ok(null) : validateBoundedText(value, 500, field);
}

function parseCanonicalTimestamp(value: string): Result<IsoUtcTimestamp, StoryCoreError> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return factValidationError("Story fact timestamps must use canonical millisecond UTC format.");
  }
  return parseIsoUtcTimestamp(value);
}

function parseRequiredUuid(
  value: string | null | undefined,
  message: string,
): Result<UuidV7, StoryCoreError> {
  return value === null || value === undefined ? factValidationError(message) : parseUuidV7(value);
}

function cloneSnapshot(snapshot: StoryFactSnapshot): StoryFactSnapshot {
  return {
    ...snapshot,
    structuredValue:
      snapshot.structuredValue === null ? null : cloneStoryValue(snapshot.structuredValue),
    source: Object.freeze({ ...snapshot.source }),
  };
}

function humanDecisionError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Formal story facts require an explicit user confirmation.",
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}

function invalidTransition(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_FACT_INVALID_TRANSITION",
      message,
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}

function factValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}
