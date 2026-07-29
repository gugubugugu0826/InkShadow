import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import type { IsoUtcTimestamp, UuidV7 } from "../shared/value-objects.js";
import { validateChapterContent } from "./chapter.js";

export interface RecoveryDraftSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly baseRevision: number;
  readonly content: string;
  readonly cursorOffset: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateRecoveryDraftInput {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly baseRevision: number;
  readonly content: string;
  readonly cursorOffset: number;
  readonly now: IsoUtcTimestamp;
}

function validateDraftInput(
  content: string,
  baseRevision: number,
  cursorOffset: number,
): Result<string, AppError> {
  const validatedContent = validateChapterContent(content);
  if (!validatedContent.ok) {
    return validatedContent;
  }

  if (!Number.isInteger(baseRevision) || baseRevision < 1) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Recovery draft base revision must be a positive integer.",
      }),
    );
  }

  if (!Number.isInteger(cursorOffset) || cursorOffset < 0 || cursorOffset > content.length) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Recovery draft cursor must be inside the content.",
        details: { field: "cursorOffset" },
      }),
    );
  }

  return validatedContent;
}

export class RecoveryDraft {
  private constructor(private readonly snapshot: RecoveryDraftSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  static create(input: CreateRecoveryDraftInput): Result<RecoveryDraft, AppError> {
    const content = validateDraftInput(input.content, input.baseRevision, input.cursorOffset);
    if (!content.ok) {
      return content;
    }

    return ok(
      new RecoveryDraft({
        id: input.id,
        projectId: input.projectId,
        chapterId: input.chapterId,
        baseRevision: input.baseRevision,
        content: content.value,
        cursorOffset: input.cursorOffset,
        createdAt: input.now,
        updatedAt: input.now,
      }),
    );
  }

  static rehydrate(snapshot: RecoveryDraftSnapshot): Result<RecoveryDraft, AppError> {
    const content = validateDraftInput(
      snapshot.content,
      snapshot.baseRevision,
      snapshot.cursorOffset,
    );
    return content.ok ? ok(new RecoveryDraft({ ...snapshot, content: content.value })) : content;
  }

  get id(): UuidV7 {
    return this.snapshot.id;
  }

  get chapterId(): UuidV7 {
    return this.snapshot.chapterId;
  }

  get baseRevision(): number {
    return this.snapshot.baseRevision;
  }

  get content(): string {
    return this.snapshot.content;
  }

  toSnapshot(): RecoveryDraftSnapshot {
    return { ...this.snapshot };
  }

  update(
    content: string,
    cursorOffset: number,
    now: IsoUtcTimestamp,
  ): Result<RecoveryDraft, AppError> {
    const validated = validateDraftInput(content, this.snapshot.baseRevision, cursorOffset);
    if (!validated.ok) {
      return validated;
    }

    return ok(
      new RecoveryDraft({
        ...this.snapshot,
        content: validated.value,
        cursorOffset,
        updatedAt: now,
      }),
    );
  }
}
