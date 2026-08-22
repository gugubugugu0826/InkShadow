import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import type { ContentChecksum, IsoUtcTimestamp, UuidV7 } from "../shared/value-objects.js";
import { validateChapterContent } from "./chapter.js";

export const CHAPTER_VERSION_REASONS = [
  "created",
  "autosave",
  "manual",
  "candidate_accept",
  "recovery",
  "import",
] as const;

export type ChapterVersionReason = (typeof CHAPTER_VERSION_REASONS)[number];

export interface ChapterVersionSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly parentVersionId: UuidV7 | null;
  readonly sequence: number;
  readonly content: string;
  readonly contentChecksum: ContentChecksum;
  readonly reason: ChapterVersionReason;
  readonly sourceCandidateId: UuidV7 | null;
  /**
   * Immutable responsibility captured when this version was committed.
   * Historical snapshots that predate the field are normalized to false.
   */
  readonly organizeLocalStoryFacts: boolean;
  readonly createdAt: IsoUtcTimestamp;
}

export type CreateChapterVersionSnapshot = Omit<ChapterVersionSnapshot, "organizeLocalStoryFacts"> &
  Readonly<{
    readonly organizeLocalStoryFacts?: boolean;
  }>;

export class ChapterVersion {
  private constructor(private readonly snapshot: ChapterVersionSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  static create(snapshot: CreateChapterVersionSnapshot): Result<ChapterVersion, AppError> {
    const content = validateChapterContent(snapshot.content);
    if (!content.ok) {
      return content;
    }

    if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 1) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "Chapter version sequence must be a positive integer.",
        }),
      );
    }

    if (snapshot.sequence === 1 && snapshot.parentVersionId !== null) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "The first chapter version cannot have a parent.",
        }),
      );
    }

    if (snapshot.sequence > 1 && snapshot.parentVersionId === null) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "A later chapter version must retain its parent.",
        }),
      );
    }

    const isCandidateVersion = snapshot.reason === "candidate_accept";
    if (isCandidateVersion !== (snapshot.sourceCandidateId !== null)) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "Candidate versions must retain exactly one source candidate.",
        }),
      );
    }

    return ok(
      new ChapterVersion({
        ...snapshot,
        content: content.value,
        organizeLocalStoryFacts: snapshot.organizeLocalStoryFacts === true,
      }),
    );
  }

  get id(): UuidV7 {
    return this.snapshot.id;
  }

  get sequence(): number {
    return this.snapshot.sequence;
  }

  toSnapshot(): ChapterVersionSnapshot {
    return { ...this.snapshot };
  }
}
