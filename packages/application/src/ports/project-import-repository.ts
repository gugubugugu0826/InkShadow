import type { AppError, Chapter, ChapterVersion, Project, Result } from "@inkshadow/domain";

export interface ImportedChapterCommit {
  readonly chapter: Chapter;
  readonly initialVersion: ChapterVersion;
}

export interface ImportProjectCommit {
  readonly project: Project;
  readonly chapters: readonly ImportedChapterCommit[];
}

/**
 * Writes an imported project and every initial chapter version atomically.
 * Implementations must leave no project or chapter rows behind on failure.
 */
export interface ProjectImportCommitRepository {
  commitImport(commit: ImportProjectCommit): Promise<Result<void, AppError>>;
}
