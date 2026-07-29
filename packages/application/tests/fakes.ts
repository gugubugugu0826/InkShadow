import {
  type AiCandidate,
  AppError,
  type Project,
  err,
  ok,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidateStatus,
  type Chapter,
  type ChapterVersion,
  type Clock,
  type ContentChecksum,
  type IsoUtcTimestamp,
  type RecoveryDraft,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";

import type {
  AcceptCandidateCommit,
  AiCandidateRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentCommitRepository,
  CreateChapterCommit,
  RecoveryDraftRepository,
  SaveChapterCommit,
  RestoreChapterVersionCommit,
} from "../src/ports/chapter-repositories.js";
import type { ContentHasher } from "../src/ports/content-hasher.js";
import type { ProjectListQuery, ProjectRepository } from "../src/ports/project-repository.js";

export function uuid(value: string): UuidV7 {
  const result = parseUuidV7(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function timestamp(value: string): IsoUtcTimestamp {
  const result = parseIsoUtcTimestamp(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export const NOW = timestamp("2026-07-27T00:00:00.000Z");
export const PROJECT_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000001");
export const CHAPTER_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000002");
export const VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000003");
export const NEXT_VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000004");
export const CANDIDATE_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000005");
export const DRAFT_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000006");

export class FixedClock implements Clock {
  constructor(private readonly value: IsoUtcTimestamp = NOW) {}

  now(): IsoUtcTimestamp {
    return this.value;
  }
}

export class SequenceIds implements UuidV7Generator {
  private index = 0;

  constructor(private readonly values: readonly UuidV7[]) {}

  next(): UuidV7 {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error("Test UUID sequence exhausted");
    }
    this.index += 1;
    return value;
  }
}

export class FixedHasher implements ContentHasher {
  private readonly checksum: ContentChecksum;

  constructor() {
    const parsed = parseContentChecksum("a".repeat(64));
    if (!parsed.ok) {
      throw parsed.error;
    }
    this.checksum = parsed.value;
  }

  sha256(): Promise<Result<ContentChecksum, AppError>> {
    return Promise.resolve(ok(this.checksum));
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<UuidV7, Project>();

  seed(project: Project): void {
    this.projects.set(project.id, project);
  }

  create(project: Project): Promise<Result<void, AppError>> {
    if (this.projects.has(project.id)) {
      return Promise.resolve(
        err(
          new AppError({
            code: "REPOSITORY_ERROR",
            message: "Duplicate project id.",
          }),
        ),
      );
    }
    this.projects.set(project.id, project);
    return Promise.resolve(ok(undefined));
  }

  findById(id: UuidV7): Promise<Result<Project | null, AppError>> {
    return Promise.resolve(ok(this.projects.get(id) ?? null));
  }

  list(query: ProjectListQuery): Promise<Result<readonly Project[], AppError>> {
    const search = query.search?.toLocaleLowerCase() ?? null;
    const projects = [...this.projects.values()].filter((project) => {
      const statusMatches = query.statuses.includes(project.status);
      const searchMatches = search === null || project.name.toLocaleLowerCase().includes(search);
      return statusMatches && searchMatches;
    });
    return Promise.resolve(ok(projects));
  }

  nameExists(
    normalizedName: string,
    excludingProjectId: UuidV7 | null,
  ): Promise<Result<boolean, AppError>> {
    const comparable = normalizedName.toLocaleLowerCase();
    const exists = [...this.projects.values()].some(
      (project) =>
        project.id !== excludingProjectId &&
        project.status !== "trashed" &&
        project.name.toLocaleLowerCase() === comparable,
    );
    return Promise.resolve(ok(exists));
  }

  save(project: Project, expectedRevision: number): Promise<Result<void, AppError>> {
    const existing = this.projects.get(project.id);
    if (existing === undefined) {
      return Promise.resolve(
        err(
          new AppError({
            code: "PROJECT_NOT_FOUND",
            message: "Project not found.",
          }),
        ),
      );
    }
    if (existing.revision !== expectedRevision) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VERSION_CONFLICT",
            message: "Project revision changed.",
          }),
        ),
      );
    }

    this.projects.set(project.id, project);
    return Promise.resolve(ok(undefined));
  }
}

export class InMemoryCandidateRepository implements AiCandidateRepository {
  private readonly candidates = new Map<UuidV7, AiCandidate>();

  seed(candidate: AiCandidate): void {
    this.candidates.set(candidate.id, candidate);
  }

  findById(id: UuidV7): Promise<Result<AiCandidate | null, AppError>> {
    return Promise.resolve(ok(this.candidates.get(id) ?? null));
  }

  save(candidate: AiCandidate, expectedStatus: AiCandidateStatus): Promise<Result<void, AppError>> {
    return Promise.resolve(this.commitExpected(candidate, expectedStatus));
  }

  commitExpected(
    candidate: AiCandidate,
    expectedStatus: AiCandidateStatus,
  ): Result<void, AppError> {
    const existing = this.candidates.get(candidate.id);
    if (existing === undefined) {
      return err(
        new AppError({
          code: "CANDIDATE_NOT_FOUND",
          message: "Candidate not found.",
        }),
      );
    }
    if (existing.status !== expectedStatus) {
      return err(
        new AppError({
          code: "CANDIDATE_ALREADY_DECIDED",
          message: "Candidate status changed.",
        }),
      );
    }
    this.candidates.set(candidate.id, candidate);
    return ok(undefined);
  }
}

export class InMemoryContentStore
  implements
    ChapterRepository,
    ChapterVersionRepository,
    RecoveryDraftRepository,
    ContentCommitRepository
{
  private readonly chapters = new Map<UuidV7, Chapter>();
  private readonly versions = new Map<UuidV7, ChapterVersion[]>();
  private readonly drafts = new Map<UuidV7, RecoveryDraft>();
  failNextCandidateCommit = false;
  failNextRestoreCommit = false;
  syncQueued = false;

  constructor(private readonly candidates: InMemoryCandidateRepository) {}

  findById(id: UuidV7): Promise<Result<Chapter | null, AppError>> {
    return Promise.resolve(ok(this.chapters.get(id) ?? null));
  }

  listByProjectId(projectId: UuidV7): Promise<Result<readonly Chapter[], AppError>> {
    return Promise.resolve(
      ok([...this.chapters.values()].filter((chapter) => chapter.projectId === projectId)),
    );
  }

  listByChapterId(chapterId: UuidV7): Promise<Result<readonly ChapterVersion[], AppError>> {
    return Promise.resolve(ok(this.versions.get(chapterId) ?? []));
  }

  findVersionById(id: UuidV7): Promise<Result<ChapterVersion | null, AppError>> {
    for (const versions of this.versions.values()) {
      const version = versions.find((item) => item.toSnapshot().id === id);
      if (version !== undefined) {
        return Promise.resolve(ok(version));
      }
    }
    return Promise.resolve(ok(null));
  }

  findByChapterId(chapterId: UuidV7): Promise<Result<RecoveryDraft | null, AppError>> {
    return Promise.resolve(ok(this.drafts.get(chapterId) ?? null));
  }

  upsert(draft: RecoveryDraft): Promise<Result<void, AppError>> {
    this.drafts.set(draft.chapterId, draft);
    return Promise.resolve(ok(undefined));
  }

  delete(chapterId: UuidV7, draftId: UuidV7): Promise<Result<void, AppError>> {
    const existing = this.drafts.get(chapterId);
    if (existing !== undefined && existing.id === draftId) {
      this.drafts.delete(chapterId);
    }
    return Promise.resolve(ok(undefined));
  }

  createChapter(
    commit: CreateChapterCommit,
  ): Promise<Result<Readonly<{ syncQueued: boolean }>, AppError>> {
    if (this.chapters.has(commit.chapter.id)) {
      return Promise.resolve(
        err(
          new AppError({
            code: "REPOSITORY_ERROR",
            message: "Duplicate chapter id.",
          }),
        ),
      );
    }
    this.chapters.set(commit.chapter.id, commit.chapter);
    this.versions.set(commit.chapter.id, [commit.initialVersion]);
    return Promise.resolve(ok({ syncQueued: this.syncQueued }));
  }

  saveChapter(
    commit: SaveChapterCommit,
  ): Promise<Result<Readonly<{ syncQueued: boolean }>, AppError>> {
    const existing = this.chapters.get(commit.chapter.id);
    if (existing === undefined || existing.revision !== commit.expectedChapterRevision) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VERSION_CONFLICT",
            message: "Chapter revision changed.",
          }),
        ),
      );
    }

    this.chapters.set(commit.chapter.id, commit.chapter);
    const versions = this.versions.get(commit.chapter.id) ?? [];
    this.versions.set(commit.chapter.id, [...versions, commit.version]);
    this.drafts.delete(commit.chapter.id);
    return Promise.resolve(ok({ syncQueued: this.syncQueued }));
  }

  acceptCandidate(
    commit: AcceptCandidateCommit,
  ): Promise<Result<Readonly<{ syncQueued: boolean }>, AppError>> {
    if (this.failNextCandidateCommit) {
      this.failNextCandidateCommit = false;
      return Promise.resolve(
        err(
          new AppError({
            code: "SAVE_FAILED",
            message: "Injected atomic commit failure.",
            retryable: true,
            actions: ["RETRY"],
          }),
        ),
      );
    }

    const existing = this.chapters.get(commit.chapter.id);
    if (existing === undefined || existing.revision !== commit.expectedChapterRevision) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VERSION_CONFLICT",
            message: "Chapter revision changed.",
          }),
        ),
      );
    }

    const candidateResult = this.candidates.commitExpected(
      commit.candidate,
      commit.expectedCandidateStatus,
    );
    if (!candidateResult.ok) {
      return Promise.resolve(candidateResult);
    }

    this.chapters.set(commit.chapter.id, commit.chapter);
    const versions = this.versions.get(commit.chapter.id) ?? [];
    this.versions.set(commit.chapter.id, [...versions, commit.version]);
    return Promise.resolve(ok({ syncQueued: this.syncQueued }));
  }

  restoreChapterVersion(
    commit: RestoreChapterVersionCommit,
  ): Promise<Result<Readonly<{ syncQueued: boolean }>, AppError>> {
    if (this.failNextRestoreCommit) {
      this.failNextRestoreCommit = false;
      return Promise.resolve(
        err(
          new AppError({
            code: "SAVE_FAILED",
            message: "Injected restore commit failure.",
            retryable: true,
            actions: ["RETRY"],
          }),
        ),
      );
    }

    const existing = this.chapters.get(commit.chapter.id);
    if (existing === undefined || existing.revision !== commit.expectedChapterRevision) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VERSION_CONFLICT",
            message: "Chapter revision changed.",
          }),
        ),
      );
    }
    this.chapters.set(commit.chapter.id, commit.chapter);
    const versions = this.versions.get(commit.chapter.id) ?? [];
    this.versions.set(commit.chapter.id, [...versions, commit.version]);
    return Promise.resolve(ok({ syncQueued: this.syncQueued }));
  }
}
