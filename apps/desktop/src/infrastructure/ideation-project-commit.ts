import type { ContentHasher } from "@inkshadow/application";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import {
  Chapter,
  ChapterVersion,
  Project,
  parseUuidV7 as parseDomainUuid,
  type Clock,
  type UuidV7Generator,
} from "@inkshadow/domain";
import {
  FormalStoryRecord,
  IdeationDraft,
  Outline,
  StoryCoreError,
  err,
  ok,
  type CommitIdeationProjectInput,
  type FormalStoryRecordSnapshot,
  type IdeationProjectCommitUnitOfWork,
  type Result as StoryResult,
} from "@inkshadow/story-core";

interface IdeationDraftRow {
  readonly revision: number;
  readonly status: string;
  readonly project_id: string | null;
  readonly snapshot_json: string;
}

export class SqliteIdeationProjectCommitUnitOfWork implements IdeationProjectCommitUnitOfWork {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  public async commit(
    input: CommitIdeationProjectInput,
  ): Promise<StoryResult<void, StoryCoreError>> {
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
    try {
      await this.executor.transaction(async (transaction) => {
        const current = await requireCurrentDraft(
          transaction,
          input.draft.id,
          input.expectedDraftRevision,
        );
        const currentSeed = current.buildProjectSeed();
        if (!currentSeed.ok || !projectSeedsEqual(currentSeed.value, input.seed)) {
          throw new IdeationCommitAbort(
            new StoryCoreError({
              code: "STORY_REVISION_CONFLICT",
              message: "Ideation answers changed before project creation.",
              retryable: true,
              actions: ["RECOMPARE", "RETRY"],
            }),
          );
        }
        await assertProjectNameAvailable(transaction, artifacts.value.project.name);
        await insertProject(transaction, artifacts.value.project);
        await insertChapter(transaction, artifacts.value.chapter);
        await insertChapterVersion(transaction, artifacts.value.version);
        await insertOutline(transaction, artifacts.value.outline);
        for (const record of artifacts.value.formalRecords) {
          await insertFormalRecord(transaction, record.toSnapshot());
        }
        await insertAuditEvent(transaction, artifacts.value.audit);
        const finalized = input.draft.toSnapshot();
        const changed = await transaction.execute(
          `UPDATE story_ideation_drafts
           SET mode = ?, status = ?, project_id = ?, revision = ?,
               updated_at = ?, snapshot_json = ?
           WHERE id = ? AND revision = ? AND status = 'active' AND project_id IS NULL`,
          [
            finalized.mode,
            finalized.status,
            finalized.projectId,
            finalized.revision,
            finalized.updatedAt,
            JSON.stringify(finalized),
            finalized.id,
            input.expectedDraftRevision,
          ],
        );
        if (changed.rowsAffected !== 1) {
          throw revisionConflict(input.expectedDraftRevision, null);
        }
      });
      return ok(undefined);
    } catch (cause: unknown) {
      return err(
        cause instanceof IdeationCommitAbort
          ? cause.storyError
          : new StoryCoreError({
              code: "STORY_REPOSITORY_ERROR",
              message: "Unable to create the ideation project atomically.",
              retryable: true,
              actions: ["RETRY", "CONTACT_SUPPORT"],
              details: {
                causeName: cause instanceof Error ? cause.name : "UnknownError",
              },
            }),
      );
    }
  }
}

export interface IdeationProjectArtifacts {
  readonly project: Project;
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
  readonly outline: Outline;
  readonly formalRecords: readonly FormalStoryRecord[];
  readonly audit: Readonly<{
    id: string;
    projectId: string;
    requestId: string;
    createdAt: string;
    mode: string;
  }>;
}

export async function buildIdeationProjectArtifacts(
  input: CommitIdeationProjectInput,
  dependencies: Readonly<{
    ids: UuidV7Generator;
    clock: Clock;
    hasher: ContentHasher;
  }>,
): Promise<StoryResult<IdeationProjectArtifacts, StoryCoreError>> {
  const projectId = parseDomainUuid(input.projectId);
  if (!projectId.ok) {
    return domainFailure(projectId.error);
  }
  const now = dependencies.clock.now();
  const chapterId = dependencies.ids.next();
  const versionId = dependencies.ids.next();
  const actorId = dependencies.ids.next();
  const project = Project.create({
    id: projectId.value,
    name: input.seed.projectName,
    now,
  });
  if (!project.ok) {
    return domainFailure(project.error);
  }
  const checksum = await dependencies.hasher.sha256("");
  if (!checksum.ok) {
    return domainFailure(checksum.error);
  }
  const chapter = Chapter.create({
    id: chapterId,
    projectId: projectId.value,
    title: "第一章",
    content: "",
    initialVersionId: versionId,
    now,
  });
  if (!chapter.ok) {
    return domainFailure(chapter.error);
  }
  const version = ChapterVersion.create({
    id: versionId,
    projectId: projectId.value,
    chapterId,
    parentVersionId: null,
    sequence: 1,
    content: "",
    contentChecksum: checksum.value,
    reason: "created",
    sourceCandidateId: null,
    createdAt: now,
  });
  if (!version.ok) {
    return domainFailure(version.error);
  }

  const initialOutline = Outline.create({
    projectId: projectId.value,
    bookId: dependencies.ids.next(),
    title: input.seed.projectName,
    synopsis: input.seed.synopsis || "尚未填写项目简介。",
    now,
  });
  if (!initialOutline.ok) {
    return initialOutline;
  }
  const volumeId = dependencies.ids.next();
  const withVolume = initialOutline.value.addNode({
    id: volumeId,
    kind: "volume",
    parentId: initialOutline.value.toSnapshot().nodes[0]?.id ?? "",
    title: "第一卷",
    synopsis: input.seed.plotRoute || "尚未填写剧情路线。",
    expectedRevision: initialOutline.value.revision,
    now,
  });
  if (!withVolume.ok) {
    return withVolume;
  }
  const outline = withVolume.value.addNode({
    id: dependencies.ids.next(),
    kind: "chapter",
    parentId: volumeId,
    title: "第一章",
    synopsis: input.seed.firstChapterGoal,
    expectedRevision: withVolume.value.revision,
    now,
  });
  if (!outline.ok) {
    return outline;
  }

  const formalRecords: FormalStoryRecord[] = [];
  if (input.seed.keyCharacters.length > 0 || input.seed.protagonistDrive.length > 0) {
    const character = FormalStoryRecord.create({
      id: dependencies.ids.next(),
      projectId: projectId.value,
      kind: "character",
      recordKey: "ideation.key_characters",
      value: {
        summary: input.seed.keyCharacters,
        protagonistDrive: input.seed.protagonistDrive,
        origin: "ideation",
      },
      actorId,
      humanConfirmed: true,
      now,
    });
    if (!character.ok) {
      return character;
    }
    formalRecords.push(character.value);
  }
  if (input.seed.worldSkeleton.length > 0) {
    const world = FormalStoryRecord.create({
      id: dependencies.ids.next(),
      projectId: projectId.value,
      kind: "world_rule",
      recordKey: "ideation.world_skeleton",
      value: {
        summary: input.seed.worldSkeleton,
        origin: "ideation",
      },
      actorId,
      humanConfirmed: true,
      now,
    });
    if (!world.ok) {
      return world;
    }
    formalRecords.push(world.value);
  }

  return ok(
    Object.freeze({
      project: project.value,
      chapter: chapter.value,
      version: version.value,
      outline: outline.value,
      formalRecords: Object.freeze(formalRecords),
      audit: Object.freeze({
        id: dependencies.ids.next(),
        projectId: projectId.value,
        requestId: dependencies.ids.next(),
        createdAt: now,
        mode: input.draft.toSnapshot().mode,
      }),
    }),
  );
}

export function validateCommitInput(
  input: CommitIdeationProjectInput,
): StoryResult<void, StoryCoreError> {
  const draft = input.draft.toSnapshot();
  const built = input.draft.status === "finalized" ? null : input.draft.buildProjectSeed();
  if (
    draft.status !== "finalized" ||
    draft.projectId !== input.projectId ||
    draft.revision !== input.expectedDraftRevision + 1 ||
    input.seed.sourceDraftId !== draft.id ||
    built !== null
  ) {
    return err(
      new StoryCoreError({
        code: "IDEATION_INVALID_TRANSITION",
        message: "Finalized ideation commit input is inconsistent.",
        actions: ["RESUME_IDEATION"],
      }),
    );
  }
  return ok(undefined);
}

async function requireCurrentDraft(
  transaction: TransactionExecutor,
  id: string,
  expectedRevision: number,
): Promise<IdeationDraft> {
  const rows = await transaction.select<IdeationDraftRow>(
    `SELECT revision, status, project_id, snapshot_json
     FROM story_ideation_drafts
     WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new IdeationCommitAbort(
      new StoryCoreError({
        code: "IDEATION_DRAFT_NOT_FOUND",
        message: "Ideation draft was not found.",
        actions: ["RESUME_IDEATION"],
      }),
    );
  }
  if (row.revision !== expectedRevision || row.status !== "active" || row.project_id !== null) {
    throw revisionConflict(expectedRevision, row.revision);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.snapshot_json) as unknown;
  } catch {
    throw corruptDraft();
  }
  const draft = IdeationDraft.rehydrate(snapshot as ReturnType<IdeationDraft["toSnapshot"]>);
  if (!draft.ok || draft.value.id !== id || draft.value.revision !== row.revision) {
    throw corruptDraft();
  }
  return draft.value;
}

async function assertProjectNameAvailable(
  transaction: TransactionExecutor,
  normalizedName: string,
): Promise<void> {
  const rows = await transaction.select<{ found: number }>(
    `SELECT EXISTS(
       SELECT 1 FROM projects
       WHERE status <> 'trashed' AND lower(name) = lower(?)
     ) AS found`,
    [normalizedName],
  );
  if (rows[0]?.found === 1) {
    throw new IdeationCommitAbort(
      new StoryCoreError({
        code: "STORY_VALIDATION_FAILED",
        message: "A visible project already uses this name.",
        actions: ["RESUME_IDEATION"],
        details: { field: "projectName" },
      }),
    );
  }
}

async function insertProject(transaction: TransactionExecutor, project: Project): Promise<void> {
  const snapshot = project.toSnapshot();
  await transaction.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.name,
      snapshot.status,
      snapshot.revision,
      snapshot.deletionGeneration,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.archivedAt,
      snapshot.trashedAt,
      snapshot.retentionUntil,
      snapshot.statusBeforeTrash,
    ],
  );
}

async function insertChapter(transaction: TransactionExecutor, chapter: Chapter): Promise<void> {
  const snapshot = chapter.toSnapshot();
  await transaction.execute(
    `INSERT INTO chapters (
       id, project_id, title, content, status, revision, current_version_id,
       created_at, updated_at, trashed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.title,
      snapshot.content,
      snapshot.status,
      snapshot.revision,
      snapshot.currentVersionId,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.trashedAt,
    ],
  );
}

async function insertChapterVersion(
  transaction: TransactionExecutor,
  version: ChapterVersion,
): Promise<void> {
  const snapshot = version.toSnapshot();
  await transaction.execute(
    `INSERT INTO chapter_versions (
       id, project_id, chapter_id, parent_version_id, sequence, content,
       content_checksum, reason, source_candidate_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.chapterId,
      snapshot.parentVersionId,
      snapshot.sequence,
      snapshot.content,
      snapshot.contentChecksum,
      snapshot.reason,
      snapshot.sourceCandidateId,
      snapshot.createdAt,
    ],
  );
}

async function insertOutline(transaction: TransactionExecutor, outline: Outline): Promise<void> {
  const snapshot = outline.toSnapshot();
  await transaction.execute(
    `INSERT INTO story_outlines (project_id, revision, snapshot_json)
     VALUES (?, ?, ?)`,
    [snapshot.projectId, snapshot.revision, JSON.stringify(snapshot)],
  );
}

async function insertFormalRecord(
  transaction: TransactionExecutor,
  snapshot: FormalStoryRecordSnapshot,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO story_formal_records (
       id, project_id, kind, record_key, revision, current_version,
       created_at, updated_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.kind,
      snapshot.recordKey,
      snapshot.revision,
      snapshot.currentVersion,
      snapshot.createdAt,
      snapshot.updatedAt,
      JSON.stringify(snapshot),
    ],
  );
}

async function insertAuditEvent(
  transaction: TransactionExecutor,
  audit: Readonly<{
    id: string;
    projectId: string;
    requestId: string;
    createdAt: string;
    mode: string;
  }>,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO local_audit_events (
       id, project_id, entity_type, entity_id, action, request_id,
       metadata_json, created_at
     ) VALUES (?, ?, 'project', ?, 'create_from_ideation', ?, ?, ?)`,
    [
      audit.id,
      audit.projectId,
      audit.projectId,
      audit.requestId,
      JSON.stringify({ source: "ideation", mode: audit.mode }),
      audit.createdAt,
    ],
  );
}

export function projectSeedsEqual(
  left: CommitIdeationProjectInput["seed"],
  right: CommitIdeationProjectInput["seed"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function domainFailure(error: {
  readonly code: string;
  readonly message: string;
}): StoryResult<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code:
        error.code === "VALIDATION_FAILED" ? "STORY_VALIDATION_FAILED" : "STORY_REPOSITORY_ERROR",
      message:
        error.code === "VALIDATION_FAILED"
          ? "Ideation output failed project validation."
          : "Ideation output preparation failed.",
      retryable: error.code !== "VALIDATION_FAILED",
      actions: error.code === "VALIDATION_FAILED" ? ["RESUME_IDEATION"] : ["RETRY"],
      details: { causeCode: error.code },
    }),
  );
}

function revisionConflict(
  expectedRevision: number,
  actualRevision: number | null,
): IdeationCommitAbort {
  return new IdeationCommitAbort(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Ideation draft changed before atomic project creation.",
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: { expectedRevision, actualRevision },
    }),
  );
}

function corruptDraft(): IdeationCommitAbort {
  return new IdeationCommitAbort(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message: "Stored ideation data failed integrity validation.",
      actions: ["CONTACT_SUPPORT"],
    }),
  );
}

class IdeationCommitAbort extends Error {
  public constructor(public readonly storyError: StoryCoreError) {
    super(storyError.message);
    this.name = "IdeationCommitAbort";
  }
}
