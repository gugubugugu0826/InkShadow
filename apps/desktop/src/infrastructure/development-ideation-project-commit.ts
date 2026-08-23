import type { ContentHasher } from "@inkshadow/application";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";
import {
  IdeationDraft,
  StoryCoreError,
  err,
  ok,
  type CommitIdeationProjectInput,
  type IdeationProjectCommitUnitOfWork,
  type Result,
} from "@inkshadow/story-core";

import {
  DEVELOPMENT_DATABASE_KEY,
  DEVELOPMENT_IDEATION_JOURNAL_KEY,
  DEVELOPMENT_STORY_STORE_KEY,
  createPreparedIdeationJournal,
  recoverPreparedIdeationCommit,
  restoreStorageValue,
  serializePreparedIdeationJournal,
} from "./development-atomic-journal";
import {
  type DevelopmentLocalAuditEventSnapshot,
  readDevelopmentDatabase,
} from "./development-storage";
import { appendExplicitAuthorIdentityToDevelopmentDatabase } from "./direct-project-display-identity";
import {
  buildIdeationProjectArtifacts,
  projectSeedsEqual,
  type IdeationProjectArtifacts,
  validateCommitInput,
} from "./ideation-project-commit";
import { readDevelopmentStoryDatabase } from "./story-storage";

export class BrowserDevelopmentIdeationProjectCommitUnitOfWork implements IdeationProjectCommitUnitOfWork {
  public constructor(
    private readonly storage: Storage,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  public async commit(input: CommitIdeationProjectInput): Promise<Result<void, StoryCoreError>> {
    const validated = validateCommitInput(input);
    if (!validated.ok) {
      return validated;
    }
    const artifacts = await buildIdeationProjectArtifacts(input, {
      ids: this.ids,
      clock: this.clock,
      hasher: this.hasher,
    });
    if (!artifacts.ok) {
      return artifacts;
    }

    let developmentBefore: string | null | undefined;
    let storyBefore: string | null | undefined;
    let journalPrepared = false;
    try {
      recoverPreparedIdeationCommit(this.storage);
      developmentBefore = this.storage.getItem(DEVELOPMENT_DATABASE_KEY);
      storyBefore = this.storage.getItem(DEVELOPMENT_STORY_STORE_KEY);
      const developmentBeforeSchemaVersion = readDevelopmentSchemaVersion(developmentBefore);
      const development = readDevelopmentDatabase(this.storage);
      const story = readDevelopmentStoryDatabase(this.storage);
      const currentDraft = requireCurrentDraft(
        story.ideationDrafts[input.draft.id],
        input.draft.id,
        input.expectedDraftRevision,
      );
      const currentSeed = currentDraft.buildProjectSeed();
      if (!currentSeed.ok || !projectSeedsEqual(currentSeed.value, input.seed)) {
        throw revisionConflict(input.expectedDraftRevision, currentDraft.revision);
      }

      assertProjectNameAvailable(development.projects, artifacts.value.project.name);
      assertArtifactIdsAvailable(development, story, artifacts.value);

      const project = artifacts.value.project.toSnapshot();
      development.projects.push(project);
      appendExplicitAuthorIdentityToDevelopmentDatabase(development, project.id, project.createdAt);
      development.chapters.push(artifacts.value.chapter.toSnapshot());
      development.versions.push(artifacts.value.version.toSnapshot());
      development.auditEvents.push(createAuditEvent(artifacts.value.audit));
      const outline = artifacts.value.outline.toSnapshot();
      story.outlines[outline.projectId] = outline;
      for (const record of artifacts.value.formalRecords) {
        const snapshot = record.toSnapshot();
        story.formalRecords[snapshot.id] = snapshot;
      }
      story.ideationDrafts[input.draft.id] = input.draft.toSnapshot();

      const developmentAfter = JSON.stringify(development);
      const storyAfter = JSON.stringify(story);
      if (storyBefore === null) {
        throw repositoryFailure("MissingIdeationStoryStore");
      }
      const journal = createPreparedIdeationJournal({
        developmentBefore,
        developmentAfter,
        developmentBeforeSchemaVersion,
        storyBefore,
        storyAfter,
        artifacts: {
          projectId: artifacts.value.project.id,
          chapterId: artifacts.value.chapter.id,
          versionId: artifacts.value.version.id,
          auditId: artifacts.value.audit.id,
          formalRecordIds: artifacts.value.formalRecords.map(({ id }) => id),
          draft: {
            id: input.draft.id,
            expectedRevision: input.expectedDraftRevision,
            finalizedRevision: input.draft.revision,
            previousUpdatedAt: currentDraft.toSnapshot().updatedAt,
          },
        },
      });

      assertStorageUnchanged(this.storage, developmentBefore, storyBefore);
      this.storage.setItem(
        DEVELOPMENT_IDEATION_JOURNAL_KEY,
        serializePreparedIdeationJournal(journal),
      );
      journalPrepared = true;
      this.storage.setItem(DEVELOPMENT_DATABASE_KEY, developmentAfter);
      this.storage.setItem(DEVELOPMENT_STORY_STORE_KEY, storyAfter);
      this.storage.removeItem(DEVELOPMENT_IDEATION_JOURNAL_KEY);
      journalPrepared = false;
      return ok(undefined);
    } catch (cause: unknown) {
      if (
        journalPrepared &&
        developmentBefore !== undefined &&
        storyBefore !== undefined &&
        storyBefore !== null
      ) {
        try {
          restoreExactBeforeState(this.storage, developmentBefore, storyBefore);
          this.storage.removeItem(DEVELOPMENT_IDEATION_JOURNAL_KEY);
          journalPrepared = false;
        } catch {
          // The prepared journal remains the recovery authority after restart.
        }
      }
      return err(normalizeCommitError(cause));
    }
  }
}

function requireCurrentDraft(
  snapshot: ReturnType<IdeationDraft["toSnapshot"]> | undefined,
  id: string,
  expectedRevision: number,
): IdeationDraft {
  if (snapshot === undefined) {
    throw new BrowserIdeationCommitAbort(
      new StoryCoreError({
        code: "IDEATION_DRAFT_NOT_FOUND",
        message: "Ideation draft was not found.",
        actions: ["RESUME_IDEATION"],
      }),
    );
  }
  const current = IdeationDraft.rehydrate(snapshot);
  if (!current.ok || current.value.id !== id) {
    throw repositoryFailure("CorruptIdeationDraft");
  }
  if (
    current.value.revision !== expectedRevision ||
    current.value.status !== "active" ||
    current.value.projectId !== null
  ) {
    throw revisionConflict(expectedRevision, current.value.revision);
  }
  return current.value;
}

function assertProjectNameAvailable(
  projects: readonly Readonly<{
    status: string;
    name: string;
  }>[],
  name: string,
): void {
  if (
    projects.some(
      (project) =>
        project.status !== "trashed" &&
        project.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    throw new BrowserIdeationCommitAbort(
      new StoryCoreError({
        code: "STORY_VALIDATION_FAILED",
        message: "A visible project already uses this name.",
        actions: ["RESUME_IDEATION"],
        details: { field: "projectName" },
      }),
    );
  }
}

function assertArtifactIdsAvailable(
  development: ReturnType<typeof readDevelopmentDatabase>,
  story: ReturnType<typeof readDevelopmentStoryDatabase>,
  artifacts: IdeationProjectArtifacts,
): void {
  const project = artifacts.project.toSnapshot();
  const chapter = artifacts.chapter.toSnapshot();
  const version = artifacts.version.toSnapshot();
  if (development.projects.some(({ id }) => id === project.id)) {
    throw repositoryFailure("DuplicateProjectId");
  }
  if (development.chapters.some(({ id }) => id === chapter.id)) {
    throw repositoryFailure("DuplicateChapterId");
  }
  if (development.versions.some(({ id }) => id === version.id)) {
    throw repositoryFailure("DuplicateChapterVersionId");
  }
  if (development.auditEvents.some(({ id }) => id === artifacts.audit.id)) {
    throw repositoryFailure("DuplicateAuditId");
  }
  if (story.outlines[project.id] !== undefined) {
    throw repositoryFailure("DuplicateOutlineProjectId");
  }

  const formalIds = new Set<string>();
  for (const record of artifacts.formalRecords) {
    const snapshot = record.toSnapshot();
    if (formalIds.has(snapshot.id) || story.formalRecords[snapshot.id] !== undefined) {
      throw repositoryFailure("DuplicateFormalRecordId");
    }
    formalIds.add(snapshot.id);
    if (
      Object.values(story.formalRecords).some(
        (existing) =>
          existing.projectId === snapshot.projectId &&
          existing.kind === snapshot.kind &&
          existing.recordKey === snapshot.recordKey,
      )
    ) {
      throw repositoryFailure("DuplicateFormalRecordKey");
    }
  }
}

function createAuditEvent(
  audit: Readonly<{
    id: string;
    projectId: string;
    requestId: string;
    createdAt: string;
    mode: string;
  }>,
): DevelopmentLocalAuditEventSnapshot {
  return Object.freeze({
    id: audit.id,
    projectId: audit.projectId,
    entityType: "project",
    entityId: audit.projectId,
    action: "create_from_ideation",
    requestId: audit.requestId,
    metadata: Object.freeze({
      source: "ideation",
      mode: audit.mode,
    }),
    createdAt: audit.createdAt,
  });
}

function readDevelopmentSchemaVersion(serialized: string | null): 0 | 1 | 2 {
  if (serialized === null) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "schemaVersion" in parsed &&
      (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)
    ) {
      return parsed.schemaVersion;
    }
  } catch {
    // The stable error below intentionally excludes persisted content.
  }
  throw repositoryFailure("InvalidDevelopmentSchemaVersion");
}

function assertStorageUnchanged(
  storage: Storage,
  developmentBefore: string | null,
  storyBefore: string,
): void {
  if (
    storage.getItem(DEVELOPMENT_DATABASE_KEY) !== developmentBefore ||
    storage.getItem(DEVELOPMENT_STORY_STORE_KEY) !== storyBefore
  ) {
    throw revisionConflict(null, null);
  }
}

function restoreExactBeforeState(
  storage: Storage,
  developmentBefore: string | null,
  storyBefore: string,
): void {
  if (storage.getItem(DEVELOPMENT_DATABASE_KEY) !== developmentBefore) {
    restoreStorageValue(storage, DEVELOPMENT_DATABASE_KEY, developmentBefore);
  }
  if (storage.getItem(DEVELOPMENT_STORY_STORE_KEY) !== storyBefore) {
    restoreStorageValue(storage, DEVELOPMENT_STORY_STORE_KEY, storyBefore);
  }
}

function normalizeCommitError(cause: unknown): StoryCoreError {
  if (cause instanceof BrowserIdeationCommitAbort) {
    return cause.storyError;
  }
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "Unable to create the ideation project atomically.",
    retryable: true,
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: {
      causeName: cause instanceof Error ? cause.name : "UnknownError",
    },
  });
}

function revisionConflict(
  expectedRevision: number | null,
  actualRevision: number | null,
): BrowserIdeationCommitAbort {
  return new BrowserIdeationCommitAbort(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Ideation draft changed before atomic project creation.",
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: { expectedRevision, actualRevision },
    }),
  );
}

function repositoryFailure(cause: string): BrowserIdeationCommitAbort {
  return new BrowserIdeationCommitAbort(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message: "Stored ideation data failed integrity validation.",
      actions: ["CONTACT_SUPPORT"],
      details: { cause },
    }),
  );
}

class BrowserIdeationCommitAbort extends Error {
  public constructor(public readonly storyError: StoryCoreError) {
    super(storyError.message);
    this.name = "BrowserIdeationCommitAbort";
  }
}
