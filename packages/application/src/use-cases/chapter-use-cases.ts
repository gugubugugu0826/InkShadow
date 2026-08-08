import type { SaveState } from "@inkshadow/contracts/states";
import {
  AppError,
  Chapter,
  ChapterVersion,
  RecoveryDraft,
  err,
  ok,
  type ChapterPrivacyMode,
  type ChapterVersionReason,
  type Clock,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";

import type {
  ChapterPrivacyRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentCommitRepository,
  RecoveryDraftRepository,
} from "../ports/chapter-repositories.js";
import type { ContentHasher } from "../ports/content-hasher.js";
import type { ProjectRepository } from "../ports/project-repository.js";
import { ensureProjectAcceptsContent, findProject } from "./shared.js";

export interface CreateChapterCommand {
  readonly projectId: UuidV7;
  readonly title: string;
  readonly content?: string;
  readonly privacyMode?: ChapterPrivacyMode;
  /** Stable ids persisted by a journey before provisioning starts. */
  readonly plannedChapterId?: UuidV7;
  readonly plannedInitialVersionId?: UuidV7;
}

export interface EditChapterCommand {
  readonly chapterId: UuidV7;
  readonly expectedRevision: number;
  readonly content: string;
  readonly cursorOffset: number;
}

export interface SaveChapterCommand {
  readonly chapterId: UuidV7;
  readonly expectedRevision: number;
  readonly reason?: Extract<ChapterVersionReason, "autosave" | "manual" | "recovery">;
}

export interface ChapterSaveOutcome {
  readonly chapter: Chapter;
  readonly version: ChapterVersion | null;
  readonly saveState: SaveState;
}

export interface RestoreChapterVersionCommand {
  readonly chapterId: UuidV7;
  readonly versionId: UuidV7;
  readonly expectedRevision: number;
}

export interface RestoreChapterVersionOutcome {
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly restoredFromVersion: ChapterVersion;
  readonly saveState: SaveState;
}

export interface CreateChapterOutcome {
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly saveState: SaveState;
}

export interface SetChapterPrivacyCommand {
  readonly chapterId: UuidV7;
  readonly privacyMode: ChapterPrivacyMode;
  readonly expectedPrivacyRevision: number;
}

export interface SetChapterPrivacyOutcome {
  readonly chapter: Chapter;
  readonly blockedProjectionCount: number;
  readonly removedOutboxOperationCount: number;
  readonly acknowledgedCloudEvidenceCount: number;
}

/**
 * Changes chapter privacy without manufacturing a正文 version. Its separate
 * privacy revision keeps this metadata CAS independent from content sequence.
 */
export class SetChapterPrivacy {
  public constructor(
    private readonly chapters: ChapterRepository,
    private readonly privacy: ChapterPrivacyRepository,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: SetChapterPrivacyCommand,
  ): Promise<Result<SetChapterPrivacyOutcome, AppError>> {
    const chapterResult = await findChapter(this.chapters, command.chapterId);
    if (!chapterResult.ok) {
      return chapterResult;
    }
    const changed = chapterResult.value.changePrivacy({
      privacyMode: command.privacyMode,
      expectedPrivacyRevision: command.expectedPrivacyRevision,
      now: this.clock.now(),
    });
    if (!changed.ok) {
      return changed;
    }
    const committed = await this.privacy.updatePrivacy(
      changed.value,
      command.expectedPrivacyRevision,
    );
    return committed.ok
      ? ok({
          chapter: committed.value.chapter,
          blockedProjectionCount: committed.value.blockedProjectionCount,
          removedOutboxOperationCount: committed.value.removedOutboxOperationCount,
          acknowledgedCloudEvidenceCount: committed.value.acknowledgedCloudEvidenceCount,
        })
      : committed;
  }
}

export class CreateChapter {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly commits: ContentCommitRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
    private readonly chapters?: ChapterRepository,
    private readonly versions?: ChapterVersionRepository,
  ) {}

  async execute(command: CreateChapterCommand): Promise<Result<CreateChapterOutcome, AppError>> {
    const hasPlannedChapterId = command.plannedChapterId !== undefined;
    const hasPlannedVersionId = command.plannedInitialVersionId !== undefined;
    if (hasPlannedChapterId !== hasPlannedVersionId) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "Crash-safe chapter provisioning requires both planned ids.",
          details: { reason: "PLANNED_CHAPTER_IDS_INCOMPLETE" },
        }),
      );
    }
    if (hasPlannedChapterId && (this.chapters === undefined || this.versions === undefined)) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "Crash-safe chapter recovery repositories are unavailable.",
          details: { reason: "PLANNED_CHAPTER_RECOVERY_UNAVAILABLE" },
        }),
      );
    }

    const project = await findProject(this.projects, command.projectId);
    if (!project.ok) {
      return project;
    }

    const editable = ensureProjectAcceptsContent(project.value);
    if (!editable.ok) {
      return editable;
    }

    const now = this.clock.now();
    const chapterId = command.plannedChapterId ?? this.ids.next();
    const versionId = command.plannedInitialVersionId ?? this.ids.next();
    const content = command.content ?? "";
    const checksum = await this.hasher.sha256(content);
    if (!checksum.ok) {
      return checksum;
    }

    const chapter = Chapter.create({
      id: chapterId,
      projectId: command.projectId,
      title: command.title,
      content,
      ...(command.privacyMode === undefined ? {} : { privacyMode: command.privacyMode }),
      initialVersionId: versionId,
      now,
    });
    if (!chapter.ok) {
      return chapter;
    }

    const version = ChapterVersion.create({
      id: versionId,
      projectId: command.projectId,
      chapterId,
      parentVersionId: null,
      sequence: 1,
      content,
      contentChecksum: checksum.value,
      reason: "created",
      sourceCandidateId: null,
      createdAt: now,
    });
    if (!version.ok) {
      return version;
    }

    if (command.plannedChapterId !== undefined) {
      const recovered = await this.recoverPlannedChapter(chapter.value, version.value);
      if (!recovered.ok) {
        return recovered;
      }
      if (recovered.value !== null) {
        return ok(recovered.value);
      }
    }

    const committed = await this.commits.createChapter({
      chapter: chapter.value,
      initialVersion: version.value,
    });
    if (committed.ok) {
      return ok({
        chapter: chapter.value,
        version: version.value,
        saveState: committed.value.syncQueued ? "pending_sync" : "saved_local",
      });
    }
    if (command.plannedChapterId === undefined) {
      return committed;
    }
    const recovered = await this.recoverPlannedChapter(chapter.value, version.value);
    if (!recovered.ok) {
      return recovered;
    }
    return recovered.value === null ? committed : ok(recovered.value);
  }

  private async recoverPlannedChapter(
    expectedChapter: Chapter,
    expectedVersion: ChapterVersion,
  ): Promise<Result<CreateChapterOutcome | null, AppError>> {
    if (this.chapters === undefined || this.versions === undefined) {
      return ok(null);
    }
    const [chapterResult, versionResult] = await Promise.all([
      this.chapters.findById(expectedChapter.id),
      this.versions.findVersionById(expectedVersion.id),
    ]);
    if (!chapterResult.ok) {
      return chapterResult;
    }
    if (!versionResult.ok) {
      return versionResult;
    }
    if (chapterResult.value === null && versionResult.value === null) {
      return ok(null);
    }
    if (
      chapterResult.value === null ||
      versionResult.value === null ||
      !sameInitialChapter(chapterResult.value, expectedChapter) ||
      !sameInitialVersion(versionResult.value, expectedVersion)
    ) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The planned chapter ids already belong to different content or scope.",
          details: {
            reason: "PLANNED_CHAPTER_SCOPE_MISMATCH",
            chapterId: expectedChapter.id,
            versionId: expectedVersion.id,
          },
        }),
      );
    }
    return ok({
      chapter: chapterResult.value,
      version: versionResult.value,
      saveState: "saved_local",
    });
  }
}

function sameInitialChapter(actual: Chapter, expected: Chapter): boolean {
  const current = actual.toSnapshot();
  const planned = expected.toSnapshot();
  return (
    current.id === planned.id &&
    current.projectId === planned.projectId &&
    current.title === planned.title &&
    current.content === planned.content &&
    current.status === "active" &&
    current.revision === 1 &&
    current.privacyMode === planned.privacyMode &&
    current.privacyRevision === 1 &&
    current.currentVersionId === planned.currentVersionId
  );
}

function sameInitialVersion(actual: ChapterVersion, expected: ChapterVersion): boolean {
  const current = actual.toSnapshot();
  const planned = expected.toSnapshot();
  return (
    current.id === planned.id &&
    current.projectId === planned.projectId &&
    current.chapterId === planned.chapterId &&
    current.parentVersionId === null &&
    current.sequence === 1 &&
    current.content === planned.content &&
    current.contentChecksum === planned.contentChecksum &&
    current.reason === "created" &&
    current.sourceCandidateId === null
  );
}

export class EditChapter {
  constructor(
    private readonly chapters: ChapterRepository,
    private readonly drafts: RecoveryDraftRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  async execute(
    command: EditChapterCommand,
  ): Promise<Result<Readonly<{ draft: RecoveryDraft; saveState: SaveState }>, AppError>> {
    const chapter = await findChapter(this.chapters, command.chapterId);
    if (!chapter.ok) {
      return chapter;
    }

    const editable = chapter.value.assertEditable();
    if (!editable.ok) {
      return editable;
    }

    if (chapter.value.revision !== command.expectedRevision) {
      return err(versionConflict(command.expectedRevision, chapter.value.revision));
    }

    const existing = await this.drafts.findByChapterId(command.chapterId);
    if (!existing.ok) {
      return existing;
    }

    const now = this.clock.now();
    let draft: Result<RecoveryDraft, AppError>;
    if (existing.value === null) {
      draft = RecoveryDraft.create({
        id: this.ids.next(),
        projectId: chapter.value.projectId,
        chapterId: chapter.value.id,
        baseRevision: command.expectedRevision,
        content: command.content,
        cursorOffset: command.cursorOffset,
        now,
      });
    } else if (existing.value.baseRevision !== command.expectedRevision) {
      return err(
        new AppError({
          code: "BASE_VERSION_CHANGED",
          message: "The recovery draft belongs to an older chapter version.",
          actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
        }),
      );
    } else {
      draft = existing.value.update(command.content, command.cursorOffset, now);
    }

    if (!draft.ok) {
      return draft;
    }

    const persisted = await this.drafts.upsert(draft.value);
    return persisted.ok ? ok({ draft: draft.value, saveState: "dirty" }) : persisted;
  }
}

export class SaveChapter {
  constructor(
    private readonly chapters: ChapterRepository,
    private readonly drafts: RecoveryDraftRepository,
    private readonly commits: ContentCommitRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  async execute(command: SaveChapterCommand): Promise<Result<ChapterSaveOutcome, AppError>> {
    const chapter = await findChapter(this.chapters, command.chapterId);
    if (!chapter.ok) {
      return chapter;
    }

    const editable = chapter.value.assertEditable();
    if (!editable.ok) {
      return editable;
    }

    if (chapter.value.revision !== command.expectedRevision) {
      return err(versionConflict(command.expectedRevision, chapter.value.revision));
    }

    const draft = await this.drafts.findByChapterId(command.chapterId);
    if (!draft.ok) {
      return draft;
    }
    if (draft.value === null) {
      return err(
        new AppError({
          code: "RECOVERY_DRAFT_NOT_FOUND",
          message: "There is no recovery draft to save.",
        }),
      );
    }
    if (draft.value.baseRevision !== chapter.value.revision) {
      return err(
        new AppError({
          code: "BASE_VERSION_CHANGED",
          message: "The stable chapter changed after this draft was created.",
          actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
        }),
      );
    }

    if (draft.value.content === chapter.value.content) {
      const removed = await this.drafts.delete(chapter.value.id, draft.value.id);
      return removed.ok
        ? ok({
            chapter: chapter.value,
            version: null,
            saveState: "saved_local",
          })
        : removed;
    }

    const now = this.clock.now();
    const versionId = this.ids.next();
    const checksum = await this.hasher.sha256(draft.value.content);
    if (!checksum.ok) {
      return checksum;
    }

    const savedChapter = chapter.value.saveContent({
      content: draft.value.content,
      expectedRevision: command.expectedRevision,
      newVersionId: versionId,
      now,
    });
    if (!savedChapter.ok) {
      return savedChapter;
    }

    const version = ChapterVersion.create({
      id: versionId,
      projectId: chapter.value.projectId,
      chapterId: chapter.value.id,
      parentVersionId: chapter.value.currentVersionId,
      sequence: savedChapter.value.revision,
      content: draft.value.content,
      contentChecksum: checksum.value,
      reason: command.reason ?? "autosave",
      sourceCandidateId: null,
      createdAt: now,
    });
    if (!version.ok) {
      return version;
    }

    const committed = await this.commits.saveChapter({
      chapter: savedChapter.value,
      version: version.value,
      recoveryDraftId: draft.value.id,
      expectedChapterRevision: command.expectedRevision,
    });
    return committed.ok
      ? ok({
          chapter: savedChapter.value,
          version: version.value,
          saveState: committed.value.syncQueued ? "pending_sync" : "saved_local",
        })
      : committed;
  }
}

export class RestoreChapterVersion {
  constructor(
    private readonly chapters: ChapterRepository,
    private readonly versions: ChapterVersionRepository,
    private readonly commits: ContentCommitRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  async execute(
    command: RestoreChapterVersionCommand,
  ): Promise<Result<RestoreChapterVersionOutcome, AppError>> {
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "The expected chapter revision must be a positive safe integer.",
          details: { field: "expectedRevision" },
        }),
      );
    }

    const chapter = await findChapter(this.chapters, command.chapterId);
    if (!chapter.ok) {
      return chapter;
    }
    const editable = chapter.value.assertEditable();
    if (!editable.ok) {
      return editable;
    }
    if (chapter.value.revision !== command.expectedRevision) {
      return err(versionConflict(command.expectedRevision, chapter.value.revision));
    }

    const selected = await this.versions.findVersionById(command.versionId);
    if (!selected.ok) {
      return selected;
    }
    if (selected.value === null) {
      return err(
        historicalVersionUnavailable("The selected chapter version is no longer available.", {
          reason: "CHAPTER_VERSION_NOT_FOUND",
          versionId: command.versionId,
        }),
      );
    }
    const selectedSnapshot = selected.value.toSnapshot();
    if (
      selectedSnapshot.id !== command.versionId ||
      selectedSnapshot.chapterId !== chapter.value.id ||
      selectedSnapshot.projectId !== chapter.value.projectId
    ) {
      return err(
        historicalVersionUnavailable("The selected version does not belong to this chapter.", {
          reason: "CHAPTER_VERSION_OWNERSHIP_MISMATCH",
        }),
      );
    }
    if (selectedSnapshot.sequence > chapter.value.revision) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The selected chapter version is ahead of the stable chapter.",
          details: {
            chapterRevision: chapter.value.revision,
            reason: "CHAPTER_VERSION_SEQUENCE_INVALID",
            versionSequence: selectedSnapshot.sequence,
          },
        }),
      );
    }

    const verifiedChecksum = await this.hasher.sha256(selectedSnapshot.content);
    if (!verifiedChecksum.ok) {
      return verifiedChecksum;
    }
    if (verifiedChecksum.value !== selectedSnapshot.contentChecksum) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The selected chapter version failed its content checksum.",
          details: {
            reason: "CHAPTER_VERSION_CHECKSUM_MISMATCH",
            versionId: selectedSnapshot.id,
          },
        }),
      );
    }
    if (selectedSnapshot.content === chapter.value.content) {
      return err(
        new AppError({
          code: "NO_CHANGES",
          message: "The selected version already matches the stable chapter.",
          details: { versionId: selectedSnapshot.id },
        }),
      );
    }

    const now = this.clock.now();
    const newVersionId = this.ids.next();
    const restoredChapter = chapter.value.saveContent({
      content: selectedSnapshot.content,
      expectedRevision: command.expectedRevision,
      newVersionId,
      now,
    });
    if (!restoredChapter.ok) {
      return restoredChapter;
    }
    const restoredVersion = ChapterVersion.create({
      id: newVersionId,
      projectId: chapter.value.projectId,
      chapterId: chapter.value.id,
      parentVersionId: chapter.value.currentVersionId,
      sequence: restoredChapter.value.revision,
      content: selectedSnapshot.content,
      contentChecksum: verifiedChecksum.value,
      reason: "recovery",
      sourceCandidateId: null,
      createdAt: now,
    });
    if (!restoredVersion.ok) {
      return restoredVersion;
    }

    const committed = await this.commits.restoreChapterVersion({
      chapter: restoredChapter.value,
      version: restoredVersion.value,
      expectedChapterRevision: command.expectedRevision,
    });
    return committed.ok
      ? ok({
          chapter: restoredChapter.value,
          version: restoredVersion.value,
          restoredFromVersion: selected.value,
          saveState: committed.value.syncQueued ? "pending_sync" : "saved_local",
        })
      : committed;
  }
}

export class ListChapterVersions {
  constructor(private readonly versions: ChapterVersionRepository) {}

  execute(chapterId: UuidV7): Promise<Result<readonly ChapterVersion[], AppError>> {
    return this.versions.listByChapterId(chapterId);
  }
}

async function findChapter(
  repository: ChapterRepository,
  chapterId: UuidV7,
): Promise<Result<Chapter, AppError>> {
  const found = await repository.findById(chapterId);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return err(
      new AppError({
        code: "CHAPTER_NOT_FOUND",
        message: "The chapter does not exist.",
      }),
    );
  }
  return ok(found.value);
}

function versionConflict(expectedRevision: number, actualRevision: number): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: "The chapter changed after editing began.",
    actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
    details: { expectedRevision, actualRevision },
  });
}

function historicalVersionUnavailable(
  message: string,
  details: Readonly<Record<string, unknown>>,
): AppError {
  return new AppError({
    code: "BASE_VERSION_CHANGED",
    message,
    actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
    details,
  });
}
