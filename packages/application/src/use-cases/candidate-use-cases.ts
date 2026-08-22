import {
  type AiCandidate,
  type AiCandidateApplicationIntent,
  AppError,
  ChapterVersion,
  err,
  ok,
  type Chapter,
  type ChapterVersionSnapshot,
  type Clock,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import type { SaveState } from "@inkshadow/contracts/states";

import type {
  AiCandidateRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentCommitRepository,
} from "../ports/chapter-repositories.js";
import type { ContentHasher } from "../ports/content-hasher.js";
import {
  planCandidateApplication,
  type CandidateApplicationPlan,
  type CandidateApplicationStrategy,
  type CandidateMergePlanningError,
  type CandidateMergeSnapshot,
} from "./candidate-merge-planner.js";

export interface CandidateCommand {
  readonly candidateId: UuidV7;
  /** Revision of the exact Candidate text shown when the author chose this action. */
  readonly expectedCandidateRevision: number;
}

export interface AcceptCandidateCommand extends CandidateCommand {
  readonly strategy?: CandidateApplicationStrategy;
  /**
   * Author-edited suggestion text. It remains isolated until this command
   * atomically accepts the candidate and creates the next stable version.
   */
  readonly editedContent?: string;
  /** Persisted acceptance-time responsibility for local story-fact organization. */
  readonly organizeLocalStoryFacts?: boolean;
}

export interface AcceptCandidateOutcome {
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly candidate: AiCandidate;
  readonly plan: CandidateApplicationPlan;
  readonly saveState: SaveState;
}

export interface ReviseCandidateCommand extends CandidateCommand {
  readonly content: string;
}

/** Persists author edits while the text remains an isolated, ready Candidate. */
export class ReviseAiCandidate {
  constructor(
    private readonly candidates: AiCandidateRepository,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  async execute(command: ReviseCandidateCommand): Promise<Result<AiCandidate, AppError>> {
    const candidate = await findCandidate(this.candidates, command.candidateId);
    if (!candidate.ok) {
      return candidate;
    }
    const authorityError = validateDisplayedCandidateRevision(
      candidate.value,
      command.expectedCandidateRevision,
    );
    if (authorityError !== null) {
      return err(authorityError);
    }
    const checksum = await this.hasher.sha256(command.content);
    if (!checksum.ok) {
      return checksum;
    }
    const revised = candidate.value.reviseReadyContent(
      command.content,
      checksum.value,
      this.clock.now(),
    );
    if (!revised.ok) {
      return revised;
    }
    const persisted = await this.candidates.save(revised.value, {
      status: "ready",
      revision: command.expectedCandidateRevision,
    });
    return persisted.ok ? revised : persisted;
  }
}

export class AcceptAiCandidate {
  constructor(
    private readonly candidates: AiCandidateRepository,
    private readonly chapters: ChapterRepository,
    private readonly commits: ContentCommitRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
    /**
     * Optional only for the legacy whole-accept constructor. Without a version
     * reader, acceptance is allowed solely when the candidate base id is still
     * the chapter's current version id; stale baselines always fail closed.
     */
    private readonly versions?: ChapterVersionRepository,
  ) {}

  async execute(
    command: AcceptCandidateCommand,
  ): Promise<Result<AcceptCandidateOutcome, AppError>> {
    const candidate = await findCandidate(this.candidates, command.candidateId);
    if (!candidate.ok) {
      return candidate;
    }
    const authorityError = validateDisplayedCandidateRevision(
      candidate.value,
      command.expectedCandidateRevision,
    );
    if (authorityError !== null) {
      return err(authorityError);
    }
    if (candidate.value.status !== "ready") {
      return err(
        new AppError({
          code:
            candidate.value.status === "streaming"
              ? "CANDIDATE_NOT_READY"
              : "CANDIDATE_ALREADY_DECIDED",
          message: "Only a ready, undecided candidate can be accepted.",
        }),
      );
    }

    if (candidate.value.chapterId === null) {
      return err(
        new AppError({
          code: "CANDIDATE_TARGET_MISSING",
          message: "This candidate is not bound to a chapter.",
        }),
      );
    }

    const chapterResult = await this.chapters.findById(candidate.value.chapterId);
    if (!chapterResult.ok) {
      return chapterResult;
    }
    if (chapterResult.value === null) {
      return err(
        new AppError({
          code: "CHAPTER_NOT_FOUND",
          message: "The candidate chapter does not exist.",
        }),
      );
    }
    const chapter = chapterResult.value;
    const editable = chapter.assertEditable();
    if (!editable.ok) {
      return editable;
    }

    if (candidate.value.projectId !== chapter.projectId || candidate.value.baseVersionId === null) {
      return err(
        baseVersionChanged("The candidate baseline does not belong to this chapter.", {
          candidateProjectId: candidate.value.projectId,
          chapterProjectId: chapter.projectId,
        }),
      );
    }

    const loadedBaseline = await this.loadBaseline(candidate.value, chapter);
    if (!loadedBaseline.ok) {
      return loadedBaseline;
    }
    const currentChecksum = await this.hasher.sha256(chapter.content);
    if (!currentChecksum.ok) {
      return currentChecksum;
    }
    const baseline: CandidateMergeSnapshot = loadedBaseline.value ?? {
      revision: chapter.revision,
      contentDigest: currentChecksum.value,
      content: chapter.content,
    };
    const storedCandidateChecksum = await this.hasher.sha256(candidate.value.content);
    if (!storedCandidateChecksum.ok) {
      return storedCandidateChecksum;
    }
    if (
      candidate.value.contentChecksum === null ||
      storedCandidateChecksum.value !== candidate.value.contentChecksum
    ) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The AI candidate failed its content checksum and was not accepted.",
          details: {
            candidateId: candidate.value.id,
            reason: "CANDIDATE_CONTENT_CHECKSUM_MISMATCH",
          },
        }),
      );
    }
    const now = this.clock.now();
    let candidateForAcceptance = candidate.value;
    if (
      command.editedContent !== undefined &&
      command.editedContent !== candidateForAcceptance.content
    ) {
      const editedChecksum = await this.hasher.sha256(command.editedContent);
      if (!editedChecksum.ok) {
        return editedChecksum;
      }
      const revised = candidateForAcceptance.reviseReadyContent(
        command.editedContent,
        editedChecksum.value,
        now,
      );
      if (!revised.ok) {
        return revised;
      }
      candidateForAcceptance = revised.value;
    }
    const strategy = command.strategy ?? defaultApplicationStrategy(candidateForAcceptance);
    const intentError = validateStrategyAgainstIntent(
      candidateForAcceptance.applicationIntent,
      strategy,
      chapter.content.length,
      baseline.content.length,
    );
    if (intentError !== null) {
      return err(intentError);
    }
    const planned = planCandidateApplication({
      baseline,
      current: {
        revision: chapter.revision,
        contentDigest: currentChecksum.value,
        content: chapter.content,
      },
      candidateContent: candidateForAcceptance.content,
      strategy,
    });
    if (planned.status === "conflict") {
      return err(
        baseVersionChanged("The chapter changed after this candidate was created.", {
          baselineRevision: planned.conflict.baseline.revision,
          currentRevision: planned.conflict.current.revision,
          contentDigestChanged: planned.conflict.contentDigestChanged,
          revisionChanged: planned.conflict.revisionChanged,
        }),
      );
    }
    if (planned.status === "error") {
      return err(planningErrorToAppError(planned.error));
    }
    if (planned.plan.resultContent === chapter.content) {
      return err(
        new AppError({
          code: "NO_CHANGES",
          message: "The candidate application does not change the stable chapter.",
          details: { strategy: planned.plan.strategy },
        }),
      );
    }

    const checksum = await this.hasher.sha256(planned.plan.resultContent);
    if (!checksum.ok) {
      return checksum;
    }

    const versionId = this.ids.next();
    const savedChapter = chapter.saveContent({
      content: planned.plan.resultContent,
      expectedRevision: chapter.revision,
      newVersionId: versionId,
      now,
    });
    if (!savedChapter.ok) {
      return savedChapter;
    }

    const version = ChapterVersion.create({
      id: versionId,
      projectId: chapter.projectId,
      chapterId: chapter.id,
      parentVersionId: chapter.currentVersionId,
      sequence: savedChapter.value.revision,
      content: planned.plan.resultContent,
      contentChecksum: checksum.value,
      reason: "candidate_accept",
      sourceCandidateId: candidate.value.id,
      organizeLocalStoryFacts: command.organizeLocalStoryFacts ?? false,
      createdAt: now,
    });
    if (!version.ok) {
      return version;
    }

    const acceptedCandidate = candidateForAcceptance.accept(now);
    if (!acceptedCandidate.ok) {
      return acceptedCandidate;
    }

    const committed = await this.commits.acceptCandidate({
      chapter: savedChapter.value,
      version: version.value,
      candidate: acceptedCandidate.value,
      expectedChapterRevision: chapter.revision,
      expectedCandidateStatus: "ready",
      expectedCandidateRevision: command.expectedCandidateRevision,
      organizeLocalStoryFacts: command.organizeLocalStoryFacts ?? false,
    });
    return committed.ok
      ? ok({
          chapter: savedChapter.value,
          version: version.value,
          candidate: acceptedCandidate.value,
          plan: planned.plan,
          saveState: committed.value.syncQueued ? "pending_sync" : "saved_local",
        })
      : committed;
  }

  private async loadBaseline(
    candidate: AiCandidate,
    chapter: Chapter,
  ): Promise<Result<CandidateMergeSnapshot | null, AppError>> {
    const baseVersionId = candidate.baseVersionId;
    if (baseVersionId === null) {
      return err(
        baseVersionChanged("The candidate baseline version is missing.", {
          reason: "BASE_VERSION_ID_MISSING",
        }),
      );
    }
    if (this.versions === undefined) {
      return baseVersionId === chapter.currentVersionId
        ? ok(null)
        : err(
            baseVersionChanged("The chapter changed after this candidate was created.", {
              reason: "VERSION_REPOSITORY_REQUIRED_FOR_STALE_BASELINE",
            }),
          );
    }

    const loaded = await this.versions.findVersionById(baseVersionId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        baseVersionChanged("The candidate baseline version is no longer available.", {
          baseVersionId: candidate.baseVersionId ?? "missing",
          reason: "BASE_VERSION_NOT_FOUND",
        }),
      );
    }
    const snapshot = loaded.value.toSnapshot();
    const identityError = validateBaseVersionIdentity(snapshot, candidate, chapter);
    if (identityError !== null) {
      return err(identityError);
    }
    const verifiedChecksum = await this.hasher.sha256(snapshot.content);
    if (!verifiedChecksum.ok) {
      return verifiedChecksum;
    }
    if (verifiedChecksum.value !== snapshot.contentChecksum) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The candidate baseline version failed its content checksum.",
          details: {
            baseVersionId: snapshot.id,
            reason: "BASE_VERSION_CHECKSUM_MISMATCH",
          },
        }),
      );
    }
    return ok({
      revision: snapshot.sequence,
      contentDigest: snapshot.contentChecksum,
      content: snapshot.content,
    });
  }
}

function defaultApplicationStrategy(candidate: AiCandidate): CandidateApplicationStrategy {
  const intent = candidate.applicationIntent;
  if (intent.task === "legacy_full_document") {
    return { kind: "accept_all" };
  }
  switch (intent.application) {
    case "insert_at_cursor":
      return { kind: "insert_at_cursor", cursorUtf16: intent.startUtf16 };
    case "replace_selection":
      return {
        kind: "replace_selection",
        selection: { start: intent.startUtf16, end: intent.endUtf16 },
      };
    case "replace_document":
      return { kind: "overwrite_document" };
  }
}

function validateStrategyAgainstIntent(
  intent: AiCandidateApplicationIntent,
  strategy: CandidateApplicationStrategy,
  currentDocumentLength: number,
  baselineDocumentLength: number,
): AppError | null {
  if (intent.task === "legacy_full_document") {
    return null;
  }
  if (intent.task === "whole_chapter_rewrite") {
    const matchesWholeChapterStrategy =
      strategy.kind === "overwrite_document" ||
      (strategy.kind === "insert_at_cursor" &&
        strategy.cursorUtf16 === currentDocumentLength &&
        strategy.cursorUtf16 === baselineDocumentLength);
    return matchesWholeChapterStrategy
      ? null
      : new AppError({
          code: "VALIDATION_FAILED",
          message:
            "A whole-chapter rewrite can only replace the chapter or append after its current end.",
          details: {
            candidatePlanningCode: "CANDIDATE_APPLICATION_INTENT_MISMATCH",
            expectedApplication: "replace_document_or_append_document_end",
            actualStrategy: strategy.kind,
          },
        });
  }
  const matchesContinuation =
    intent.application === "insert_at_cursor" &&
    strategy.kind === "insert_at_cursor" &&
    strategy.cursorUtf16 === intent.startUtf16;
  const matchesSelection =
    intent.application === "replace_selection" &&
    strategy.kind === "replace_selection" &&
    strategy.selection.start === intent.startUtf16 &&
    strategy.selection.end === intent.endUtf16;
  return matchesContinuation || matchesSelection
    ? null
    : new AppError({
        code: "VALIDATION_FAILED",
        message: "The Candidate fragment can only be applied to its original task anchor.",
        details: {
          candidatePlanningCode: "CANDIDATE_APPLICATION_INTENT_MISMATCH",
          expectedApplication: intent.application,
          actualStrategy: strategy.kind,
        },
      });
}

export class RejectAiCandidate {
  constructor(
    private readonly candidates: AiCandidateRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: CandidateCommand): Promise<Result<AiCandidate, AppError>> {
    const candidate = await findCandidate(this.candidates, command.candidateId);
    if (!candidate.ok) {
      return candidate;
    }

    const authorityError = validateDisplayedCandidateRevision(
      candidate.value,
      command.expectedCandidateRevision,
    );
    if (authorityError !== null) {
      return err(authorityError);
    }

    const rejected = candidate.value.reject(this.clock.now());
    if (!rejected.ok) {
      return rejected;
    }

    const persisted = await this.candidates.save(rejected.value, {
      status: "ready",
      revision: command.expectedCandidateRevision,
    });
    return persisted.ok ? rejected : persisted;
  }
}

function validateDisplayedCandidateRevision(
  candidate: AiCandidate,
  expectedRevision: number,
): AppError | null {
  return candidate.revision === expectedRevision
    ? null
    : new AppError({
        code: "VERSION_CONFLICT",
        message: "The AI candidate was revised after it was shown. Review the latest text first.",
        actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
        details: {
          entityType: "candidate",
          candidateId: candidate.id,
          expectedRevision,
          actualRevision: candidate.revision,
        },
      });
}

async function findCandidate(
  repository: AiCandidateRepository,
  candidateId: UuidV7,
): Promise<Result<AiCandidate, AppError>> {
  const found = await repository.findById(candidateId);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return err(
      new AppError({
        code: "CANDIDATE_NOT_FOUND",
        message: "The AI candidate does not exist.",
      }),
    );
  }
  return ok(found.value);
}

function validateBaseVersionIdentity(
  version: ChapterVersionSnapshot,
  candidate: AiCandidate,
  chapter: Chapter,
): AppError | null {
  if (
    version.id !== candidate.baseVersionId ||
    version.chapterId !== chapter.id ||
    version.projectId !== chapter.projectId
  ) {
    return baseVersionChanged("The candidate baseline version has inconsistent ownership.", {
      reason: "BASE_VERSION_IDENTITY_MISMATCH",
    });
  }
  return null;
}

function planningErrorToAppError(error: CandidateMergePlanningError): AppError {
  const code =
    error.code === "SNAPSHOT_IDENTITY_MISMATCH" ? "REPOSITORY_ERROR" : "VALIDATION_FAILED";
  return new AppError({
    code,
    message: error.message,
    details: {
      candidatePlanningCode: error.code,
      ...error.context,
    },
  });
}

function baseVersionChanged(message: string, details: Readonly<Record<string, unknown>>): AppError {
  return new AppError({
    code: "BASE_VERSION_CHANGED",
    message,
    actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
    details,
  });
}
