import {
  parseProjectSeed,
  parseUuidV7,
  type ProjectSeed,
  type ProjectSeedRecord,
  type ProjectSeedStore,
} from "@inkshadow/domain";

import { DEVELOPMENT_CREATIVE_JOURNEY_KEY } from "./creative-journey-store";

export const DEVELOPMENT_PROJECT_SEED_KEY = "inkshadow.development.project-seeds.v1";

const LEGACY_IMPORT_JOURNEY_KEY = "inkshadow.import-rewrite-journey.v2";
const LEGACY_PROFESSIONAL_CREATE_KEY = "inkshadow.professional-create-recovery.v1";

interface BrowserProjectSeedDatabase {
  readonly schemaVersion: 1;
  readonly records: Record<string, ProjectSeedRecord>;
}

/** A durable browser-development implementation backed by the caller's local Storage. */
export class BrowserProjectSeedStore implements ProjectSeedStore {
  public constructor(private readonly storage: Storage) {}

  public findByProjectId(projectIdValue: string): Promise<ProjectSeedRecord | null> {
    return Promise.resolve().then(() => {
      const projectId = requireProjectId(projectIdValue);
      return this.read().records[projectId] ?? null;
    });
  }

  public saveForProject(
    projectIdValue: string,
    seedValue: ProjectSeed,
  ): Promise<ProjectSeedRecord> {
    return Promise.resolve().then(() => {
      const projectId = requireProjectId(projectIdValue);
      const seed = requireSeed(seedValue);
      const database = this.read();
      const existing = database.records[projectId];
      if (existing !== undefined && existing.updatedAt > seed.updatedAt) {
        return existing;
      }
      const saved = freezeRecord({
        projectId,
        seed,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? seed.createdAt,
        updatedAt: seed.updatedAt,
      });
      database.records[projectId] = saved;
      this.write(database);
      return saved;
    });
  }

  private read(): BrowserProjectSeedDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_PROJECT_SEED_KEY);
    if (serialized === null) {
      const migrated = legacyDatabase(this.storage);
      this.write(migrated);
      return migrated;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.records)) {
        throw new Error("Invalid browser ProjectSeed database.");
      }
      const records: Record<string, ProjectSeedRecord> = {};
      for (const [projectId, value] of Object.entries(parsed.records)) {
        const record = requireStoredRecord(value);
        if (record.projectId !== projectId) {
          throw new Error("ProjectSeed record key does not match its project.");
        }
        records[projectId] = record;
      }
      return { schemaVersion: 1, records };
    } catch (cause: unknown) {
      throw cause instanceof BrowserProjectSeedStoreError
        ? cause
        : browserStoreError(
            "PROJECT_SEED_STORE_CORRUPT",
            "The local project creation seed store is not readable.",
          );
    }
  }

  private write(database: BrowserProjectSeedDatabase): void {
    this.storage.setItem(DEVELOPMENT_PROJECT_SEED_KEY, JSON.stringify(database));
  }
}

/**
 * Imports valid legacy page/journey snapshots into any project-owned store.
 * Broken and deleted-project entries remain isolated and never block runtime startup.
 */
export async function backfillLegacyProjectSeeds(
  store: ProjectSeedStore,
  storage: Storage,
): Promise<number> {
  let imported = 0;
  for (const candidate of collectLegacyCandidates(storage)) {
    try {
      const existing = await store.findByProjectId(candidate.projectId);
      if (existing !== null && existing.updatedAt >= candidate.seed.updatedAt) {
        continue;
      }
      await store.saveForProject(candidate.projectId, candidate.seed);
      imported += 1;
    } catch {
      // A legacy pointer can outlive a deleted project. Its original recovery JSON is retained;
      // one bad pointer must not prevent the local-first runtime from opening.
    }
  }
  return imported;
}

export class BrowserProjectSeedStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserProjectSeedStoreError";
  }
}

function legacyDatabase(storage: Storage): BrowserProjectSeedDatabase {
  const records: Record<string, ProjectSeedRecord> = {};
  for (const candidate of collectLegacyCandidates(storage)) {
    const existing = records[candidate.projectId];
    if (existing !== undefined && existing.updatedAt >= candidate.seed.updatedAt) {
      continue;
    }
    records[candidate.projectId] = freezeRecord({
      projectId: candidate.projectId,
      seed: candidate.seed,
      revision: 1,
      createdAt: candidate.seed.createdAt,
      updatedAt: candidate.seed.updatedAt,
    });
  }
  return { schemaVersion: 1, records };
}

function collectLegacyCandidates(
  storage: Storage,
): readonly Readonly<{ projectId: string; seed: ProjectSeed }>[] {
  const candidates: { projectId: string; seed: ProjectSeed }[] = [];
  collectCreativeJourneyCandidates(
    readStorageJson(storage, DEVELOPMENT_CREATIVE_JOURNEY_KEY),
    candidates,
  );
  collectSingleRecoveryCandidate(readStorageJson(storage, LEGACY_IMPORT_JOURNEY_KEY), candidates);
  collectSingleRecoveryCandidate(
    readStorageJson(storage, LEGACY_PROFESSIONAL_CREATE_KEY),
    candidates,
  );
  return candidates;
}

function collectCreativeJourneyCandidates(
  value: unknown,
  candidates: { projectId: string; seed: ProjectSeed }[],
): void {
  if (!isRecord(value) || !isRecord(value.journeys)) return;
  for (const journey of Object.values(value.journeys)) {
    if (!isRecord(journey) || !isRecord(journey.snapshot)) continue;
    appendCandidate(journey.projectId, journey.snapshot.projectSeed, candidates);
  }
}

function collectSingleRecoveryCandidate(
  value: unknown,
  candidates: { projectId: string; seed: ProjectSeed }[],
): void {
  if (!isRecord(value)) return;
  const importedWork = isRecord(value.importedWork) ? value.importedWork : null;
  appendCandidate(value.projectId ?? importedWork?.projectId, value.projectSeed, candidates);
}

function appendCandidate(
  projectIdValue: unknown,
  seedValue: unknown,
  candidates: { projectId: string; seed: ProjectSeed }[],
): void {
  if (typeof projectIdValue !== "string") return;
  const projectId = parseUuidV7(projectIdValue);
  const seed = parseProjectSeed(seedValue);
  if (!projectId.ok || seed === null) return;
  candidates.push({ projectId: projectId.value, seed });
}

function readStorageJson(storage: Storage, key: string): unknown {
  try {
    const serialized = storage.getItem(key);
    return serialized === null ? null : (JSON.parse(serialized) as unknown);
  } catch {
    return null;
  }
}

function requireStoredRecord(value: unknown): ProjectSeedRecord {
  if (
    !isRecord(value) ||
    typeof value.projectId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw browserStoreError("PROJECT_SEED_STORE_CORRUPT", "A local ProjectSeed record is invalid.");
  }
  const projectId = requireProjectId(value.projectId);
  const seed = requireSeed(value.seed);
  if (
    value.createdAt !== seed.createdAt ||
    value.updatedAt !== seed.updatedAt ||
    value.updatedAt < value.createdAt
  ) {
    throw browserStoreError(
      "PROJECT_SEED_STORE_CORRUPT",
      "A local ProjectSeed record timestamp is invalid.",
    );
  }
  return freezeRecord({
    projectId,
    seed,
    revision: Number(value.revision),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function freezeRecord(record: ProjectSeedRecord): ProjectSeedRecord {
  return Object.freeze({ ...record });
}

function requireSeed(value: unknown): ProjectSeed {
  const seed = parseProjectSeed(value);
  if (seed === null) {
    throw browserStoreError("PROJECT_SEED_INVALID", "The project creation seed is invalid.");
  }
  return seed;
}

function requireProjectId(value: string): string {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw browserStoreError("PROJECT_SEED_PROJECT_INVALID", "Project id is invalid.");
  }
  return parsed.value;
}

function browserStoreError(code: string, message: string): BrowserProjectSeedStoreError {
  return new BrowserProjectSeedStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
