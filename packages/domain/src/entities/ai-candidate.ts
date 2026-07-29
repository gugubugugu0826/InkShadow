import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import type { ContentChecksum, IsoUtcTimestamp, UuidV7 } from "../shared/value-objects.js";
import { validateChapterContent } from "./chapter.js";

export const AI_CANDIDATE_SOURCES = ["generate", "polish", "extract", "whatif", "agent"] as const;
export type AiCandidateSource = (typeof AI_CANDIDATE_SOURCES)[number];

export const AI_CANDIDATE_STATUSES = [
  "streaming",
  "ready",
  "accepted",
  "rejected",
  "expired",
] as const;
export type AiCandidateStatus = (typeof AI_CANDIDATE_STATUSES)[number];

export interface AiCandidateSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7 | null;
  readonly source: AiCandidateSource;
  readonly baseVersionId: UuidV7 | null;
  readonly content: string;
  readonly contentChecksum: ContentChecksum | null;
  readonly status: AiCandidateStatus;
  readonly incomplete: boolean;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly decidedAt: IsoUtcTimestamp | null;
}

export interface CreateStreamingCandidateInput {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7 | null;
  readonly source: AiCandidateSource;
  readonly baseVersionId: UuidV7 | null;
  readonly now: IsoUtcTimestamp;
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

  return ok({ ...snapshot, content: content.value });
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

    return ok(
      new AiCandidate({
        id: input.id,
        projectId: input.projectId,
        chapterId: input.chapterId,
        source: input.source,
        baseVersionId: input.baseVersionId,
        content: "",
        contentChecksum: null,
        status: "streaming",
        incomplete: false,
        createdAt: input.now,
        updatedAt: input.now,
        decidedAt: null,
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

  get content(): string {
    return this.snapshot.content;
  }

  get status(): AiCandidateStatus {
    return this.snapshot.status;
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

  accept(now: IsoUtcTimestamp): Result<AiCandidate, AppError> {
    return this.decide("accepted", now);
  }

  reject(now: IsoUtcTimestamp): Result<AiCandidate, AppError> {
    return this.decide("rejected", now);
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

    return ok(
      new AiCandidate({
        ...this.snapshot,
        status,
        updatedAt: now,
        decidedAt: now,
      }),
    );
  }
}
