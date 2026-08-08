import {
  parseProjectSeed,
  parseUuidV7,
  type ProjectSeed,
  type ProjectSeedRecord,
  type ProjectSeedStore,
} from "@inkshadow/domain";

import type { SqlExecutor } from "./executor.js";

interface ProjectSeedRow {
  readonly project_id: string;
  readonly seed_id: string;
  readonly journey_kind: string;
  readonly schema_version: number;
  readonly payload_json: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite authority for a project's creation input after the project exists. */
export class ProjectSeedSqliteStore implements ProjectSeedStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async findByProjectId(projectIdValue: string): Promise<ProjectSeedRecord | null> {
    const projectId = requireProjectId(projectIdValue);
    const rows = await this.executor.select<ProjectSeedRow>(
      `${PROJECT_SEED_SELECT} WHERE project_id = ?`,
      [projectId],
    );
    return rows[0] === undefined ? null : hydrateProjectSeed(rows[0]);
  }

  public async saveForProject(
    projectIdValue: string,
    seedValue: ProjectSeed,
  ): Promise<ProjectSeedRecord> {
    const projectId = requireProjectId(projectIdValue);
    const seed = parseProjectSeed(seedValue);
    if (seed === null) {
      throw projectSeedStoreError(
        "PROJECT_SEED_INVALID",
        "The project creation seed is not valid and was not saved.",
      );
    }

    await this.executor.execute(
      `INSERT INTO project_seeds (
         project_id, seed_id, journey_kind, schema_version, payload_json,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         seed_id = excluded.seed_id,
         journey_kind = excluded.journey_kind,
         schema_version = excluded.schema_version,
         payload_json = excluded.payload_json,
         revision = project_seeds.revision + 1,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= project_seeds.updated_at`,
      [
        projectId,
        seed.seedId,
        seed.journeyKind,
        seed.version,
        JSON.stringify(seed),
        seed.createdAt,
        seed.updatedAt,
      ],
    );

    const saved = await this.findByProjectId(projectId);
    if (saved === null) {
      throw projectSeedStoreError(
        "PROJECT_SEED_WRITE_FAILED",
        "The project creation seed could not be read after saving.",
      );
    }
    return saved;
  }
}

export class ProjectSeedStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectSeedStoreError";
  }
}

function hydrateProjectSeed(row: ProjectSeedRow): ProjectSeedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    throw projectSeedStoreError(
      "PROJECT_SEED_STORE_CORRUPT",
      "The saved project creation seed is not readable.",
    );
  }
  const seed = parseProjectSeed(parsed);
  if (
    seed?.seedId !== row.seed_id ||
    seed.journeyKind !== row.journey_kind ||
    seed.version !== row.schema_version ||
    seed.createdAt !== row.created_at ||
    seed.updatedAt !== row.updated_at ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    throw projectSeedStoreError(
      "PROJECT_SEED_STORE_CORRUPT",
      "The saved project creation seed does not match its database record.",
    );
  }
  return Object.freeze({
    projectId: requireProjectId(row.project_id),
    seed,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function requireProjectId(value: string): string {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw projectSeedStoreError("PROJECT_SEED_PROJECT_INVALID", "Project id is not valid.");
  }
  return parsed.value;
}

function projectSeedStoreError(code: string, message: string): ProjectSeedStoreError {
  return new ProjectSeedStoreError(code, message);
}

const PROJECT_SEED_SELECT = `SELECT
  project_id, seed_id, journey_kind, schema_version, payload_json,
  revision, created_at, updated_at
FROM project_seeds`;
