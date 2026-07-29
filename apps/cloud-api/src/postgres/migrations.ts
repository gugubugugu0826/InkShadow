import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

export interface CloudMigrationResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

interface MigrationFile {
  readonly version: number;
  readonly description: string;
  readonly checksumSha256: string;
  readonly sql: string;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly checksum_sha256: string;
}

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/u;
const MIGRATION_LOCK_KEY = 4_948_533_726_663_145;
export const CURRENT_CLOUD_SCHEMA_VERSION = 16;

export function defaultCloudMigrationsDirectory(): string {
  return fileURLToPath(new URL("../../migrations/", import.meta.url));
}

export async function runCloudMigrations(
  pool: Pool,
  migrationsDirectory: string = defaultCloudMigrationsDirectory(),
  afterMigrations?: (client: PoolClient) => Promise<void>,
): Promise<CloudMigrationResult> {
  const migrations = await readMigrationFiles(migrationsDirectory);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await ensureMigrationLedger(client);
    const appliedRows = await client.query<AppliedMigrationRow>(
      `SELECT version, checksum_sha256
       FROM cloud_schema_migrations
       ORDER BY version`,
    );
    const applied = new Map(appliedRows.rows.map((row) => [row.version, row.checksum_sha256]));
    assertAppliedHistory(migrations, applied);

    const appliedVersions: number[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO cloud_schema_migrations (
             version,
             description,
             checksum_sha256
           ) VALUES ($1, $2, $3)`,
          [migration.version, migration.description, migration.checksumSha256],
        );
        await client.query("COMMIT");
        appliedVersions.push(migration.version);
        applied.set(migration.version, migration.checksumSha256);
      } catch (cause: unknown) {
        await client.query("ROLLBACK");
        throw cause;
      }
    }
    await afterMigrations?.(client);

    return Object.freeze({
      appliedVersions: Object.freeze(appliedVersions),
      currentVersion: migrations.at(-1)?.version ?? 0,
    });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {
      // Connection release still happens if PostgreSQL already terminated the session.
    });
    client.release();
  }
}

async function readMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match === null) {
      continue;
    }
    const version = Number(match[1]);
    const description = (match[2] ?? "").replaceAll("_", " ");
    const sql = await readFile(path.join(directory, entry.name), "utf8");
    migrations.push({
      version,
      description,
      checksumSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
      sql,
    });
  }
  migrations.sort((left, right) => left.version - right.version);
  if (migrations.length === 0) {
    throw new Error("No InkShadow cloud migrations were found.");
  }
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Cloud migrations must be contiguous from version 1; expected ${String(expected)}.`,
      );
    }
  }
  if (migrations.at(-1)?.version !== CURRENT_CLOUD_SCHEMA_VERSION) {
    throw new Error(
      `Cloud migrations must end at the declared schema version ${String(CURRENT_CLOUD_SCHEMA_VERSION)}.`,
    );
  }
  return Object.freeze(migrations);
}

async function ensureMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
      checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

function assertAppliedHistory(
  migrations: readonly MigrationFile[],
  applied: ReadonlyMap<number, string>,
): void {
  for (const [version, checksum] of applied) {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (migration === undefined) {
      throw new Error(`Database contains unknown cloud migration ${String(version)}.`);
    }
    if (migration.checksumSha256 !== checksum) {
      throw new Error(`Cloud migration ${String(version)} checksum has changed.`);
    }
  }
}
