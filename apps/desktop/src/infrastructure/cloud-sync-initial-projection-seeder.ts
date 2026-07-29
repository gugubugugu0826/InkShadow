import {
  enqueueSyncProjectionJobInTransaction,
  findCurrentSyncMaterializedObjectInTransaction,
  loadProjectSyncRegistrationInTransaction,
  type EnqueueSyncProjectionJobInput,
  type ProjectSyncRegistration,
  type TransactionExecutor,
} from "@inkshadow/data";
import {
  AppError,
  parseIsoUtcTimestamp,
  type Result,
  type UuidV7Generator,
} from "@inkshadow/domain";

export interface InitialProjectionSeedResult {
  readonly projectId: string;
  readonly enqueuedJobIds: readonly string[];
  readonly skippedJobIds: readonly string[];
}

interface ProjectSeedRow {
  readonly id: string;
  readonly status: string;
  readonly revision: number;
  readonly deletion_generation: number;
}

interface ChapterSeedRow {
  readonly id: string;
  readonly created_at: string;
}

interface ChapterVersionSeedRow {
  readonly id: string;
  readonly sequence: number;
}

interface ExistingProjectionJobRow {
  readonly job_id: string;
  readonly account_id: string;
  readonly version_id: string | null;
  readonly source_revision: number;
  readonly key_version: number;
  readonly consent_revision: number;
  readonly device_id: string;
}

type SeedCandidate = Omit<
  EnqueueSyncProjectionJobInput,
  | "jobId"
  | "accountId"
  | "keyVersion"
  | "consentRevision"
  | "deviceId"
  | "createdAt"
  | "nextAttemptAt"
>;

/**
 * Seeds opaque local object references after cloud sync has been enabled.
 *
 * The caller owns the surrounding SQLite transaction. Failures are thrown so
 * the caller cannot accidentally commit a partially seeded project.
 */
export class CloudSyncInitialProjectionSeeder {
  public constructor(private readonly ids: Pick<UuidV7Generator, "next">) {}

  public async seedProjectInTransaction(
    transaction: TransactionExecutor,
    enabledRegistration: ProjectSyncRegistration,
    seededAtValue: string,
  ): Promise<InitialProjectionSeedResult> {
    try {
      const seededAt = requireResult(parseIsoUtcTimestamp(seededAtValue));
      const registration = await this.requireCurrentEnabledRegistration(
        transaction,
        enabledRegistration,
      );
      const project = await requireProject(transaction, registration.projectId);
      const candidates = await buildSeedCandidates(transaction, project);
      const enqueuedJobIds: string[] = [];
      const skippedJobIds: string[] = [];

      for (const candidate of candidates) {
        const existingJobId = await findExactExistingSeed(transaction, candidate, registration);
        if (existingJobId !== null) {
          skippedJobIds.push(existingJobId);
          continue;
        }

        const queued = requireResult(
          await enqueueSyncProjectionJobInTransaction(transaction, {
            ...candidate,
            jobId: this.ids.next(),
            accountId: registration.accountId,
            keyVersion: registration.keyVersion,
            consentRevision: registration.consentRevision,
            deviceId: registration.deviceId,
            createdAt: seededAt,
            nextAttemptAt: seededAt,
          }),
        );
        enqueuedJobIds.push(queued.jobId);
      }

      return {
        projectId: registration.projectId,
        enqueuedJobIds,
        skippedJobIds,
      };
    } catch (cause: unknown) {
      if (cause instanceof AppError) {
        throw cause;
      }
      throw new AppError({
        code: "REPOSITORY_ERROR",
        message: "The initial cloud projection seed could not be committed.",
        retryable: true,
        actions: ["RETRY", "OPEN_SETTINGS", "CONTACT_SUPPORT"],
        details: {
          operation: "SYNC_INITIAL_PROJECTION_SEED",
          causeType: cause instanceof Error ? cause.name : "UnknownError",
        },
      });
    }
  }

  private async requireCurrentEnabledRegistration(
    transaction: TransactionExecutor,
    supplied: ProjectSyncRegistration,
  ): Promise<ProjectSyncRegistration> {
    const current = requireResult(
      await loadProjectSyncRegistrationInTransaction(transaction, supplied.projectId),
    );
    if (current?.state !== "enabled" || !current.plaintextBootstrapCompleted) {
      throw stateError("Initial projection requires an enabled project sync registration.");
    }
    if (
      supplied.state !== "enabled" ||
      !supplied.plaintextBootstrapCompleted ||
      current.accountId !== supplied.accountId ||
      current.deviceId !== supplied.deviceId ||
      current.keyVersion !== supplied.keyVersion ||
      current.consentRevision !== supplied.consentRevision ||
      current.revision !== supplied.revision
    ) {
      throw stateError("The project sync registration changed before initial projection.");
    }
    return current;
  }
}

async function requireProject(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<ProjectSeedRow> {
  const rows = await transaction.select<ProjectSeedRow>(
    `SELECT id, status, revision, deletion_generation
     FROM projects
     WHERE id = ?`,
    [projectId],
  );
  const project = rows[0];
  if (project === undefined) {
    throw new AppError({
      code: "PROJECT_NOT_FOUND",
      message: "The project to seed does not exist.",
      actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    });
  }
  if (rows.length !== 1) {
    throw new AppError({
      code: "REPOSITORY_ERROR",
      message: "The project seed source is duplicated.",
      actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    });
  }
  return project;
}

async function buildSeedCandidates(
  transaction: TransactionExecutor,
  project: ProjectSeedRow,
): Promise<readonly SeedCandidate[]> {
  const manifestMarker = requireResult(
    await findCurrentSyncMaterializedObjectInTransaction(
      transaction,
      project.id,
      "project_manifest",
      project.id,
    ),
  );
  if (project.status === "trashed") {
    if (
      project.deletion_generation % 2 === 1 &&
      manifestMarker?.state === "deleted" &&
      manifestMarker.objectGeneration === project.deletion_generation + 1
    ) {
      // The committed remote tombstone is already authoritative. Re-seeding
      // plaintext would resurrect the project at the same generation.
      return [];
    }
    throw stateError("Restore a locally trashed project before enabling cloud sync.");
  }
  if (
    (project.status !== "active" && project.status !== "archived") ||
    project.deletion_generation % 2 !== 0
  ) {
    throw stateError("The project lifecycle generation is not seedable.");
  }
  const candidates: SeedCandidate[] = [
    {
      projectId: project.id,
      objectType: "project_manifest",
      objectId: project.id,
      objectGeneration: project.deletion_generation + 1,
      projectionKind: "upsert",
      versionId: project.id,
      sourceRevision: project.revision,
    },
  ];
  const chapters = await transaction.select<ChapterSeedRow>(
    `SELECT id, created_at
     FROM chapters
     WHERE project_id = ? AND status = 'active'
     ORDER BY created_at, id`,
    [project.id],
  );

  for (const chapter of chapters) {
    const marker = requireResult(
      await findCurrentSyncMaterializedObjectInTransaction(
        transaction,
        project.id,
        "chapter_version",
        chapter.id,
      ),
    );
    const objectGeneration =
      marker === null
        ? 1
        : marker.state === "deleted"
          ? marker.objectGeneration + 1
          : marker.objectGeneration;
    const versions = await transaction.select<ChapterVersionSeedRow>(
      `SELECT id, sequence
       FROM chapter_versions
       WHERE project_id = ? AND chapter_id = ?
       ORDER BY sequence, id`,
      [project.id, chapter.id],
    );
    if (versions.length === 0) {
      throw new AppError({
        code: "REPOSITORY_ERROR",
        message: "A chapter has no immutable version to seed.",
        actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
        details: { operation: "SYNC_INITIAL_PROJECTION_SOURCE_INVALID" },
      });
    }
    for (const version of versions) {
      candidates.push({
        projectId: project.id,
        objectType: "chapter_version",
        objectId: chapter.id,
        objectGeneration,
        projectionKind: "upsert",
        versionId: version.id,
        sourceRevision: version.sequence,
      });
    }
  }
  return candidates;
}

async function findExactExistingSeed(
  transaction: TransactionExecutor,
  candidate: SeedCandidate,
  registration: ProjectSyncRegistration,
): Promise<string | null> {
  const rows = await transaction.select<ExistingProjectionJobRow>(
    `SELECT job_id, account_id, version_id, source_revision, key_version,
            consent_revision, device_id
     FROM sync_projection_jobs
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?
       AND projection_kind = ?
       AND source_revision = ?`,
    [
      candidate.projectId,
      candidate.objectType,
      candidate.objectId,
      candidate.objectGeneration,
      candidate.projectionKind,
      candidate.sourceRevision,
    ],
  );
  if (rows.length === 0) {
    return null;
  }
  const authorityRows = rows.filter(({ account_id }) => account_id === registration.accountId);
  if (authorityRows.length === 0) {
    return null;
  }
  const row = authorityRows[0];
  if (
    authorityRows.length === 1 &&
    row?.version_id === candidate.versionId &&
    row.source_revision === candidate.sourceRevision &&
    row.key_version === registration.keyVersion &&
    row.consent_revision === registration.consentRevision &&
    row.device_id === registration.deviceId
  ) {
    return row.job_id;
  }
  throw stateError("A different projection seed already occupies this source identity.");
}

function requireResult<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function stateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS"],
  });
}
