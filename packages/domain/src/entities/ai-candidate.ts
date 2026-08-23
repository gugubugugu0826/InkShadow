import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import type { ContentChecksum, IsoUtcTimestamp, UuidV7 } from "../shared/value-objects.js";
import { MAX_CHAPTER_CONTENT_LENGTH, validateChapterContent } from "./chapter.js";

export const AI_CANDIDATE_SOURCES = ["generate", "polish", "extract", "whatif", "agent"] as const;
export type AiCandidateSource = (typeof AI_CANDIDATE_SOURCES)[number];

export const AI_CANDIDATE_PURPOSES = ["prose", "continuation_directions"] as const;
export type AiCandidatePurpose = (typeof AI_CANDIDATE_PURPOSES)[number];

export const AI_CANDIDATE_STATUSES = [
  "streaming",
  "ready",
  "accepted",
  "rejected",
  "expired",
] as const;
export type AiCandidateStatus = (typeof AI_CANDIDATE_STATUSES)[number];

export const AI_CANDIDATE_TASK_INTENTS = [
  "legacy_full_document",
  "continuation",
  "selection_rewrite",
  "whole_chapter_rewrite",
] as const;
export type AiCandidateTaskIntent = (typeof AI_CANDIDATE_TASK_INTENTS)[number];

export type AiCandidateApplicationIntent =
  | Readonly<{
      task: "legacy_full_document" | "whole_chapter_rewrite";
      application: "replace_document";
      payload: "full_document";
      startUtf16: null;
      endUtf16: null;
    }>
  | Readonly<{
      task: "continuation";
      application: "insert_at_cursor";
      payload: "fragment";
      startUtf16: number;
      endUtf16: number;
    }>
  | Readonly<{
      task: "selection_rewrite";
      application: "replace_selection";
      payload: "fragment";
      startUtf16: number;
      endUtf16: number;
    }>;

const LEGACY_FULL_DOCUMENT_INTENT: AiCandidateApplicationIntent = Object.freeze({
  task: "legacy_full_document",
  application: "replace_document",
  payload: "full_document",
  startUtf16: null,
  endUtf16: null,
});

export interface AiCandidateSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7 | null;
  readonly source: AiCandidateSource;
  /**
   * Why this isolated result exists. Optional only for snapshots created
   * before purpose authority was introduced; legacy snapshots are prose.
   */
  readonly purpose?: AiCandidatePurpose;
  readonly baseVersionId: UuidV7 | null;
  readonly content: string;
  readonly contentChecksum: ContentChecksum | null;
  readonly status: AiCandidateStatus;
  /**
   * Monotonic authority for every author-visible mutation after a Candidate is
   * ready. Optional only for snapshots written before revision authority was
   * introduced; legacy snapshots rehydrate at revision 1.
   */
  readonly revision?: number;
  readonly incomplete: boolean;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly decidedAt: IsoUtcTimestamp | null;
  /**
   * Optional only for snapshots written before the application-intent migration.
   * Rehydration normalizes absence to the legacy full-document behavior.
   */
  readonly applicationIntent?: AiCandidateApplicationIntent;
}

export interface CreateStreamingCandidateInput {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7 | null;
  readonly source: AiCandidateSource;
  readonly purpose?: AiCandidatePurpose;
  readonly baseVersionId: UuidV7 | null;
  readonly now: IsoUtcTimestamp;
  readonly applicationIntent?: AiCandidateApplicationIntent;
}

function validateSnapshot(snapshot: AiCandidateSnapshot): Result<AiCandidateSnapshot, AppError> {
  const content = validateChapterContent(snapshot.content);
  if (!content.ok) {
    return content;
  }

  if (snapshot.chapterId !== null && snapshot.baseVersionId === null) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "A chapter candidate must retain its base version.",
      }),
    );
  }

  if (
    snapshot.status !== "streaming" &&
    (snapshot.content.length === 0 || snapshot.contentChecksum === null)
  ) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "A persisted candidate must retain content and checksum.",
      }),
    );
  }

  const isTerminal =
    snapshot.status === "accepted" ||
    snapshot.status === "rejected" ||
    snapshot.status === "expired";
  if (isTerminal !== (snapshot.decidedAt !== null)) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Candidate terminal state and decision time must agree.",
      }),
    );
  }

  const applicationIntent = validateApplicationIntent(snapshot.applicationIntent);
  if (!applicationIntent.ok) {
    return applicationIntent;
  }

  const purpose = snapshot.purpose ?? "prose";
  if (!AI_CANDIDATE_PURPOSES.includes(purpose)) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "The AI candidate purpose is invalid.",
        details: { field: "purpose" },
      }),
    );
  }
  if (purpose === "continuation_directions" && snapshot.status === "accepted") {
    return err(directionCandidateCannotBeAccepted());
  }

  const revision = snapshot.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "The AI candidate revision must be a positive safe integer.",
        details: { field: "revision" },
      }),
    );
  }

  return ok({
    ...snapshot,
    content: content.value,
    purpose,
    applicationIntent: applicationIntent.value,
    revision,
  });
}

function validateApplicationIntent(
  value: AiCandidateApplicationIntent | undefined,
): Result<AiCandidateApplicationIntent, AppError> {
  const intent = value ?? LEGACY_FULL_DOCUMENT_INTENT;
  const raw = intent as unknown as Readonly<{
    task: unknown;
    application: unknown;
    payload: unknown;
    startUtf16: unknown;
    endUtf16: unknown;
  }>;
  const invalid = (): Result<AiCandidateApplicationIntent, AppError> =>
    err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "The AI candidate application intent is invalid.",
        details: { field: "applicationIntent" },
      }),
    );

  if (
    (raw.task === "legacy_full_document" || raw.task === "whole_chapter_rewrite") &&
    raw.application === "replace_document" &&
    raw.payload === "full_document" &&
    raw.startUtf16 === null &&
    raw.endUtf16 === null
  ) {
    return ok(
      Object.freeze({
        task: raw.task,
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      }),
    );
  }
  if (
    raw.task === "continuation" &&
    raw.application === "insert_at_cursor" &&
    raw.payload === "fragment" &&
    validUtf16Offset(raw.startUtf16) &&
    raw.endUtf16 === raw.startUtf16
  ) {
    return ok(
      Object.freeze({
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: raw.startUtf16,
        endUtf16: raw.startUtf16,
      }),
    );
  }
  if (
    raw.task === "selection_rewrite" &&
    raw.application === "replace_selection" &&
    raw.payload === "fragment" &&
    validUtf16Offset(raw.startUtf16) &&
    validUtf16Offset(raw.endUtf16) &&
    raw.endUtf16 > raw.startUtf16
  ) {
    return ok(
      Object.freeze({
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: raw.startUtf16,
        endUtf16: raw.endUtf16,
      }),
    );
  }
  return invalid();
}

function validUtf16Offset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_CHAPTER_CONTENT_LENGTH
  );
}

export class AiCandidate {
  private constructor(private readonly snapshot: AiCandidateSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  static createStreaming(input: CreateStreamingCandidateInput): Result<AiCandidate, AppError> {
    if (input.chapterId !== null && input.baseVersionId === null) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "A chapter candidate must retain its base version.",
        }),
      );
    }

    const applicationIntent = validateApplicationIntent(input.applicationIntent);
    if (!applicationIntent.ok) {
      return applicationIntent;
    }

    return ok(
      new AiCandidate({
        id: input.id,
        projectId: input.projectId,
        chapterId: input.chapterId,
        source: input.source,
        purpose: input.purpose ?? "prose",
        baseVersionId: input.baseVersionId,
        content: "",
        contentChecksum: null,
        status: "streaming",
        revision: 1,
        incomplete: false,
        createdAt: input.now,
        updatedAt: input.now,
        decidedAt: null,
        applicationIntent: applicationIntent.value,
      }),
    );
  }

  static rehydrate(snapshot: AiCandidateSnapshot): Result<AiCandidate, AppError> {
    const validated = validateSnapshot(snapshot);
    return validated.ok ? ok(new AiCandidate(validated.value)) : validated;
  }

  get id(): UuidV7 {
    return this.snapshot.id;
  }

  get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  get chapterId(): UuidV7 | null {
    return this.snapshot.chapterId;
  }

  get baseVersionId(): UuidV7 | null {
    return this.snapshot.baseVersionId;
  }

  get purpose(): AiCandidatePurpose {
    return this.snapshot.purpose ?? "prose";
  }

  get content(): string {
    return this.snapshot.content;
  }

  get contentChecksum(): ContentChecksum | null {
    return this.snapshot.contentChecksum;
  }

  get status(): AiCandidateStatus {
    return this.snapshot.status;
  }

  get revision(): number {
    return this.snapshot.revision ?? 1;
  }

  get applicationIntent(): AiCandidateApplicationIntent {
    return this.snapshot.applicationIntent ?? LEGACY_FULL_DOCUMENT_INTENT;
  }

  toSnapshot(): AiCandidateSnapshot {
    return { ...this.snapshot };
  }

  markReady(
    content: string,
    contentChecksum: ContentChecksum,
    now: IsoUtcTimestamp,
    incomplete = false,
  ): Result<AiCandidate, AppError> {
    if (this.snapshot.status !== "streaming") {
      return err(
        new AppError({
          code: "INVALID_STATE_TRANSITION",
          message: "Only a streaming candidate can become ready.",
          details: { status: this.snapshot.status },
        }),
      );
    }

    const validatedContent = validateChapterContent(content);
    if (!validatedContent.ok) {
      return validatedContent;
    }

    if (validatedContent.value.length === 0) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "A ready candidate cannot be empty.",
        }),
      );
    }
    return ok(
      new AiCandidate({
        ...this.snapshot,
        content: validatedContent.value,
        contentChecksum,
        status: "ready",
        incomplete,
        updatedAt: now,
      }),
    );
  }

  reviseReadyContent(
    content: string,
    contentChecksum: ContentChecksum,
    now: IsoUtcTimestamp,
  ): Result<AiCandidate, AppError> {
    if (this.snapshot.status !== "ready") {
      return err(
        new AppError({
          code:
            this.snapshot.status === "streaming"
              ? "CANDIDATE_NOT_READY"
              : "CANDIDATE_ALREADY_DECIDED",
          message: "Only a ready, undecided candidate can be revised.",
          details: { status: this.snapshot.status },
        }),
      );
    }

    const validatedContent = validateChapterContent(content);
    if (!validatedContent.ok) {
      return validatedContent;
    }
    if (validatedContent.value.length === 0) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "A revised candidate cannot be empty.",
        }),
      );
    }
    const nextRevision = this.nextRevision();
    if (!nextRevision.ok) {
      return nextRevision;
    }

    return ok(
      new AiCandidate({
        ...this.snapshot,
        content: validatedContent.value,
        contentChecksum,
        revision: nextRevision.value,
        updatedAt: now,
      }),
    );
  }

  accept(now: IsoUtcTimestamp): Result<AiCandidate, AppError> {
    if (this.purpose === "continuation_directions") {
      return err(directionCandidateCannotBeAccepted());
    }
    return this.decide("accepted", now);
  }

  reject(now: IsoUtcTimestamp): Result<AiCandidate, AppError> {
    return this.decide("rejected", now);
  }

  retain(now: IsoUtcTimestamp): Result<AiCandidate, AppError> {
    if (this.snapshot.status !== "ready") {
      const code =
        this.snapshot.status === "accepted" ||
        this.snapshot.status === "rejected" ||
        this.snapshot.status === "expired"
          ? "CANDIDATE_ALREADY_DECIDED"
          : "CANDIDATE_NOT_READY";
      return err(
        new AppError({
          code,
          message: "Only a ready, undecided candidate can be retained.",
          details: { status: this.snapshot.status },
        }),
      );
    }
    const nextRevision = this.nextRevision();
    if (!nextRevision.ok) {
      return nextRevision;
    }

    return ok(
      new AiCandidate({
        ...this.snapshot,
        revision: nextRevision.value,
        updatedAt: now,
      }),
    );
  }

  expire(now: IsoUtcTimestamp): Result<AiCandidate, AppError> {
    return this.decide("expired", now);
  }

  private decide(
    status: Exclude<AiCandidateStatus, "streaming" | "ready">,
    now: IsoUtcTimestamp,
  ): Result<AiCandidate, AppError> {
    if (this.snapshot.status !== "ready") {
      const code =
        this.snapshot.status === "accepted" ||
        this.snapshot.status === "rejected" ||
        this.snapshot.status === "expired"
          ? "CANDIDATE_ALREADY_DECIDED"
          : "CANDIDATE_NOT_READY";
      return err(
        new AppError({
          code,
          message: "Only a ready, undecided candidate can be decided.",
          details: { status: this.snapshot.status },
        }),
      );
    }
    const nextRevision = this.nextRevision();
    if (!nextRevision.ok) {
      return nextRevision;
    }

    return ok(
      new AiCandidate({
        ...this.snapshot,
        status,
        revision: nextRevision.value,
        updatedAt: now,
        decidedAt: now,
      }),
    );
  }

  private nextRevision(): Result<number, AppError> {
    return this.revision < Number.MAX_SAFE_INTEGER
      ? ok(this.revision + 1)
      : err(
          new AppError({
            code: "VERSION_CONFLICT",
            message: "The AI candidate revision authority is exhausted.",
            actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
            details: { reason: "CANDIDATE_REVISION_EXHAUSTED", revision: this.revision },
          }),
        );
  }
}

function directionCandidateCannotBeAccepted(): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "创作方向只能用于选择后续写法，不能直接写入正文。",
    details: { field: "purpose", reason: "CONTINUATION_DIRECTIONS_NOT_ACCEPTABLE" },
  });
}
