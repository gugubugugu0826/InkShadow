import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import type { IsoUtcTimestamp, UuidV7 } from "../shared/value-objects.js";

export const CHAPTER_STATUSES = ["active", "trashed"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const CHAPTER_PRIVACY_MODES = ["standard", "local_only"] as const;
export type ChapterPrivacyMode = (typeof CHAPTER_PRIVACY_MODES)[number];

export interface ChapterSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly title: string;
  readonly content: string;
  readonly status: ChapterStatus;
  readonly revision: number;
  readonly privacyMode: ChapterPrivacyMode;
  readonly privacyRevision: number;
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
  readonly privacyMode?: ChapterPrivacyMode;
  readonly initialVersionId: UuidV7;
  readonly now: IsoUtcTimestamp;
}

export interface SaveChapterContentInput {
  readonly content: string;
  readonly expectedRevision: number;
  readonly newVersionId: UuidV7;
  readonly now: IsoUtcTimestamp;
}

export interface ChangeChapterPrivacyInput {
  readonly privacyMode: ChapterPrivacyMode;
  readonly expectedPrivacyRevision: number;
  readonly now: IsoUtcTimestamp;
}

type RehydrateChapterSnapshot = Omit<ChapterSnapshot, "privacyMode" | "privacyRevision"> &
  Readonly<{
    /** Missing only in pre-private-chapter browser-development snapshots. */
    privacyMode?: ChapterPrivacyMode;
    /** Missing only in pre-private-chapter browser-development snapshots. */
    privacyRevision?: number;
  }>;

export const MAX_CHAPTER_TITLE_LENGTH = 200;
const MAX_LEGACY_CHAPTER_TITLE_LENGTH = 10_000;
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

function validateSnapshot(snapshot: RehydrateChapterSnapshot): Result<ChapterSnapshot, AppError> {
  const title = preserveLegacyChapterTitle(snapshot.title);
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

  const privacyMode = snapshot.privacyMode ?? "standard";
  const privacyRevision = snapshot.privacyRevision ?? 1;
  if (
    !CHAPTER_PRIVACY_MODES.includes(privacyMode) ||
    !Number.isInteger(privacyRevision) ||
    privacyRevision < 1
  ) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Chapter privacy state is invalid.",
        details: { field: "privacyMode" },
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

  return ok({
    ...snapshot,
    title: title.value,
    content: content.value,
    privacyMode,
    privacyRevision,
  });
}

function preserveLegacyChapterTitle(value: string): Result<string, AppError> {
  if (value.length > MAX_LEGACY_CHAPTER_TITLE_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Persisted chapter title exceeds the safe read boundary.",
        details: { field: "title" },
      }),
    );
  }
  return ok(value);
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
    if (input.privacyMode !== undefined && !CHAPTER_PRIVACY_MODES.includes(input.privacyMode)) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "Chapter privacy mode is invalid.",
          details: { field: "privacyMode" },
        }),
      );
    }

    return ok(
      new Chapter({
        id: input.id,
        projectId: input.projectId,
        title: title.value,
        content: content.value,
        status: "active",
        revision: 1,
        privacyMode: input.privacyMode ?? "standard",
        privacyRevision: 1,
        currentVersionId: input.initialVersionId,
        createdAt: input.now,
        updatedAt: input.now,
        trashedAt: null,
      }),
    );
  }

  static rehydrate(snapshot: RehydrateChapterSnapshot): Result<Chapter, AppError> {
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

  get privacyMode(): ChapterPrivacyMode {
    return this.snapshot.privacyMode;
  }

  get privacyRevision(): number {
    return this.snapshot.privacyRevision;
  }

  get isLocalOnly(): boolean {
    return this.snapshot.privacyMode === "local_only";
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

  changePrivacy(input: ChangeChapterPrivacyInput): Result<Chapter, AppError> {
    const editable = this.assertEditable();
    if (!editable.ok) {
      return editable;
    }
    if (input.expectedPrivacyRevision !== this.snapshot.privacyRevision) {
      return err(
        new AppError({
          code: "VERSION_CONFLICT",
          message: "The chapter privacy setting changed before it could be saved.",
          actions: ["RETRY"],
          details: {
            expectedPrivacyRevision: input.expectedPrivacyRevision,
            actualPrivacyRevision: this.snapshot.privacyRevision,
          },
        }),
      );
    }
    if (!CHAPTER_PRIVACY_MODES.includes(input.privacyMode)) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "Chapter privacy mode is invalid.",
          details: { field: "privacyMode" },
        }),
      );
    }
    if (input.privacyMode === this.snapshot.privacyMode) {
      return err(
        new AppError({
          code: "NO_CHANGES",
          message: "The chapter already uses this privacy setting.",
        }),
      );
    }
    return ok(
      new Chapter({
        ...this.snapshot,
        privacyMode: input.privacyMode,
        privacyRevision: this.snapshot.privacyRevision + 1,
        updatedAt: input.now,
      }),
    );
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
