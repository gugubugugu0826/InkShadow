import type {
  AiCandidate,
  AiCandidateStatus,
  AppError,
  Chapter,
  ChapterVersion,
  RecoveryDraft,
  Result,
  UuidV7,
} from "@inkshadow/domain";

export interface ChapterRepository {
  findById(id: UuidV7): Promise<Result<Chapter | null, AppError>>;
  listByProjectId(projectId: UuidV7): Promise<Result<readonly Chapter[], AppError>>;
}

export interface ChapterVersionRepository {
  findVersionById(id: UuidV7): Promise<Result<ChapterVersion | null, AppError>>;
  listByChapterId(chapterId: UuidV7): Promise<Result<readonly ChapterVersion[], AppError>>;
}

export interface RecoveryDraftRepository {
  findByChapterId(chapterId: UuidV7): Promise<Result<RecoveryDraft | null, AppError>>;
  upsert(draft: RecoveryDraft): Promise<Result<void, AppError>>;
  delete(chapterId: UuidV7, draftId: UuidV7): Promise<Result<void, AppError>>;
}

export interface AiCandidateRepository {
  findById(id: UuidV7): Promise<Result<AiCandidate | null, AppError>>;
  save(candidate: AiCandidate, expectedStatus: AiCandidateStatus): Promise<Result<void, AppError>>;
}

export interface CreateChapterCommit {
  readonly chapter: Chapter;
  readonly initialVersion: ChapterVersion;
}

export interface SaveChapterCommit {
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly recoveryDraftId: UuidV7;
  readonly expectedChapterRevision: number;
}

export interface AcceptCandidateCommit {
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly candidate: AiCandidate;
  readonly expectedChapterRevision: number;
  readonly expectedCandidateStatus: AiCandidateStatus;
}

export interface RestoreChapterVersionCommit {
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly expectedChapterRevision: number;
}

export interface ContentCommitReceipt {
  readonly syncQueued: boolean;
}

export interface ContentCommitRepository {
  createChapter(commit: CreateChapterCommit): Promise<Result<ContentCommitReceipt, AppError>>;
  saveChapter(commit: SaveChapterCommit): Promise<Result<ContentCommitReceipt, AppError>>;
  acceptCandidate(commit: AcceptCandidateCommit): Promise<Result<ContentCommitReceipt, AppError>>;
  restoreChapterVersion(
    commit: RestoreChapterVersionCommit,
  ): Promise<Result<ContentCommitReceipt, AppError>>;
}
