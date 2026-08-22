import type {
  AiCandidate,
  AiCandidateStatus,
  AppError,
  Chapter,
  ChapterPrivacyMode,
  ChapterStatus,
  ChapterVersion,
  RecoveryDraft,
  Result,
  UuidV7,
} from "@inkshadow/domain";

export interface ChapterPrivacyAuthoritySnapshot {
  readonly chapterId: UuidV7;
  readonly currentVersionId: UuidV7;
  readonly chapterRevision: number;
  readonly privacyRevision: number;
  readonly privacyMode: ChapterPrivacyMode;
  readonly status: ChapterStatus;
}

export interface ChapterRepository {
  findById(id: UuidV7): Promise<Result<Chapter | null, AppError>>;
  listByProjectId(projectId: UuidV7): Promise<Result<readonly Chapter[], AppError>>;
  /**
   * Production privacy routing should use this metadata-only projection so
   * building an egress receipt never loads chapter正文 into the authority.
   * The optional fallback keeps older adapters/test doubles compatible.
   */
  listPrivacyAuthorityByProjectId?(
    projectId: UuidV7,
  ): Promise<Result<readonly ChapterPrivacyAuthoritySnapshot[], AppError>>;
}

export interface ChapterVersionRepository {
  findVersionById(id: UuidV7): Promise<Result<ChapterVersion | null, AppError>>;
  listByChapterId(chapterId: UuidV7): Promise<Result<readonly ChapterVersion[], AppError>>;
}

export interface ChapterPrivacyCommitReceipt {
  readonly chapter: Chapter;
  /** Pending plaintext projection jobs closed before encryption. */
  readonly blockedProjectionCount: number;
  /** Unacknowledged encrypted operations removed from the upload queue. */
  readonly removedOutboxOperationCount: number;
  /** Positive local evidence of a cloud acknowledgement; zero is not proof of absence. */
  readonly acknowledgedCloudEvidenceCount: number;
}

export interface ChapterPrivacyRepository {
  updatePrivacy(
    chapter: Chapter,
    expectedPrivacyRevision: number,
  ): Promise<Result<ChapterPrivacyCommitReceipt, AppError>>;
}

export interface ChapterPrivacyState {
  readonly chapterId: UuidV7;
  readonly mode: ChapterPrivacyMode;
  readonly revision: number;
}

export interface RecoveryDraftRepository {
  findByChapterId(chapterId: UuidV7): Promise<Result<RecoveryDraft | null, AppError>>;
  upsert(draft: RecoveryDraft): Promise<Result<void, AppError>>;
  delete(chapterId: UuidV7, draftId: UuidV7): Promise<Result<void, AppError>>;
}

export interface AiCandidateRepository {
  findById(id: UuidV7): Promise<Result<AiCandidate | null, AppError>>;
  save(
    candidate: AiCandidate,
    expected: Readonly<{ status: AiCandidateStatus; revision: number }>,
  ): Promise<Result<void, AppError>>;
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
  readonly expectedCandidateRevision: number;
  /**
   * Durable decision made at acceptance time. Older callers omit it and are
   * treated as not owning automatic local story-fact organization.
   */
  readonly organizeLocalStoryFacts?: boolean;
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
