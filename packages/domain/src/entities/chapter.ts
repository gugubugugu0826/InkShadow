import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import type { IsoUtcTimestamp, UuidV7 } from "../shared/value-objects.js";

export const CHAPTER_STATUSES = ["active", "trashed"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export interface ChapterSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly title: string;
  readonly content: string;
  readonly status: ChapterStatus;
  readonly revision: number;
  readonly currentVersionId: UuidV7;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly trashedAt: IsoUtcTimestamp | null;
}

export interface CreateChapterInput {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly title: string;
  readonly content: string;
  readonly initialVersionId: UuidV7;
  readonly now: IsoUtcTimestamp;
}

export interface SaveChapterContentInput {
  readonly content: string;
  readonly expectedRevision: number;
  readonly newVersionId: UuidV7;
  readonly now: IsoUtcTimestamp;
}

const MAX_CHAPTER_TITLE_LENGTH = 200;
export const MAX_CHAPTER_CONTENT_LENGTH = 5_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function normalizeChapterTitle(value: string): Result<string, AppError> {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CHAPTER_TITLE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: `Chapter title must contain 1-${String(
          MAX_CHAPTER_TITLE_LENGTH,
        )} visible characters.`,
        details: { field: "title" },
      }),
    );
  }

  return ok(normalized);
}

export function validateChapterContent(content: string): Result<string, AppError> {
  if (content.length > MAX_CHAPTER_CONTENT_LENGTH || content.includes("\u0000")) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Chapter content exceeds the supported size or contains invalid data.",
        details: { field: "content" },
      }),
    );
  }

  return ok(content);
}

function validateSnapshot(snapshot: ChapterSnapshot): Result<ChapterSnapshot, AppError> {
  const title = normalizeChapterTitle(snapshot.title);
  if (!title.ok) {
    return title;
  }

  const content = validateChapterContent(snapshot.content);
  if (!content.ok) {
    return content;
  }

  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 1) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Chapter revision must be a positive integer.",
      }),
    );
  }

  const statusIsCoherent =
    (snapshot.status === "active" && snapshot.trashedAt === null) ||
    (snapshot.status === "trashed" && snapshot.trashedAt !== null);
  if (!statusIsCoherent) {
    return err(
      new AppError({
        code: "INVALID_STATE_TRANSITION",
        message: "Chapter lifecycle timestamp does not match its status.",
      }),
    );
  }

  return ok({ ...snapshot, title: title.value, content: content.value });
}

export class Chapter {
  private constructor(private readonly snapshot: ChapterSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  static create(input: CreateChapterInput): Result<Chapter, AppError> {
    const title = normalizeChapterTitle(input.title);
    if (!title.ok) {
      return title;
    }

    const content = validateChapterContent(input.content);
    if (!content.ok) {
      return content;
    }

    return ok(
      new Chapter({
        id: input.id,
        projectId: input.projectId,
        title: title.value,
        content: content.value,
        status: "active",
        revision: 1,
        currentVersionId: input.initialVersionId,
        createdAt: input.now,
        updatedAt: input.now,
        trashedAt: null,
      }),
    );
  }

  static rehydrate(snapshot: ChapterSnapshot): Result<Chapter, AppError> {
    const validated = validateSnapshot(snapshot);
    return validated.ok ? ok(new Chapter(validated.value)) : validated;
  }

  get id(): UuidV7 {
    return this.snapshot.id;
  }

  get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  get title(): string {
    return this.snapshot.title;
  }

  get content(): string {
    return this.snapshot.content;
  }

  get status(): ChapterStatus {
    return this.snapshot.status;
  }

  get revision(): number {
    return this.snapshot.revision;
  }

  get currentVersionId(): UuidV7 {
    return this.snapshot.currentVersionId;
  }

  toSnapshot(): ChapterSnapshot {
    return { ...this.snapshot };
  }

  assertEditable(): Result<true, AppError> {
    if (this.snapshot.status !== "active") {
      return err(
        new AppError({
          code: "CHAPTER_DELETED",
          message: "Restore the chapter before editing it.",
          actions: ["RESTORE"],
        }),
      );
    }

    return ok(true);
  }

  saveContent(input: SaveChapterContentInput): Result<Chapter, AppError> {
    const editable = this.assertEditable();
    if (!editable.ok) {
      return editable;
    }

    if (input.expectedRevision !== this.snapshot.revision) {
      return err(
        new AppError({
          code: "VERSION_CONFLICT",
          message: "The chapter changed after editing began.",
          actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
          details: {
            expectedRevision: input.expectedRevision,
            actualRevision: this.snapshot.revision,
          },
        }),
      );
    }

    const content = validateChapterContent(input.content);
    if (!content.ok) {
      return content;
    }

    if (content.value === this.snapshot.content) {
      return err(
        new AppError({
          code: "NO_CHANGES",
          message: "The chapter content is already stable.",
        }),
      );
    }

    return ok(
      new Chapter({
        ...this.snapshot,
        content: content.value,
        revision: this.snapshot.revision + 1,
        currentVersionId: input.newVersionId,
        updatedAt: input.now,
      }),
    );
  }
}
