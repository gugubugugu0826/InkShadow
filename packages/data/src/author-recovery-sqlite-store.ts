import { parseUuidV7 } from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export interface AuthorRecoveryRecord {
  readonly projectId: string;
  readonly kind: string;
  readonly schemaVersion: string;
  readonly payloadJson: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveAuthorRecoveryInput {
  readonly projectId: string;
  readonly kind: string;
  readonly schemaVersion: string;
  readonly payloadJson: string;
  readonly expectedRevision: number | null;
  readonly now: string;
}

export interface AuthorRecoveryStore {
  find(projectId: string, kind: string): Promise<AuthorRecoveryRecord | null>;
  save(input: SaveAuthorRecoveryInput): Promise<AuthorRecoveryRecord>;
  delete(projectId: string, kind: string, expectedRevision: number): Promise<boolean>;
}

interface AuthorRecoveryRow {
  readonly project_id: string;
  readonly kind: string;
  readonly schema_version: string;
  readonly payload_json: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite authority for author-authored recovery payloads included in backup and restore. */
export class AuthorRecoverySqliteStore implements AuthorRecoveryStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async find(
    projectIdValue: string,
    kindValue: string,
  ): Promise<AuthorRecoveryRecord | null> {
    const projectId = requireProjectId(projectIdValue);
    const kind = requireKind(kindValue);
    return findWithExecutor(this.executor, projectId, kind);
  }

  public async save(input: SaveAuthorRecoveryInput): Promise<AuthorRecoveryRecord> {
    const projectId = requireProjectId(input.projectId);
    const kind = requireKind(input.kind);
    requireSchemaVersion(input.schemaVersion);
    requirePayloadObject(input.payloadJson);
    requireTimestamp(input.now);
    if (
      input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    ) {
      throw authorRecoveryError(
        "AUTHOR_RECOVERY_REVISION_INVALID",
        "Recovery record revision is invalid.",
      );
    }

    return this.executor.transaction(async (transaction) => {
      const write =
        input.expectedRevision === null
          ? await transaction.execute(
              `INSERT INTO author_recovery_records (
                 project_id, kind, schema_version, payload_json,
                 revision, created_at, updated_at
               ) VALUES (?, ?, ?, ?, 1, ?, ?)
               ON CONFLICT(project_id, kind) DO NOTHING`,
              [projectId, kind, input.schemaVersion, input.payloadJson, input.now, input.now],
            )
          : await transaction.execute(
              `UPDATE author_recovery_records
               SET schema_version = ?, payload_json = ?,
                   revision = revision + 1, updated_at = ?
               WHERE project_id = ? AND kind = ? AND revision = ?`,
              [
                input.schemaVersion,
                input.payloadJson,
                input.now,
                projectId,
                kind,
                input.expectedRevision,
              ],
            );
      if (write.rowsAffected !== 1) throw new AuthorRecoveryConflictError();
      const saved = await findWithExecutor(transaction, projectId, kind);
      if (saved === null) {
        throw authorRecoveryError(
          "AUTHOR_RECOVERY_WRITE_FAILED",
          "Recovery record could not be read after saving.",
        );
      }
      return saved;
    });
  }

  public async delete(
    projectIdValue: string,
    kindValue: string,
    expectedRevision: number,
  ): Promise<boolean> {
    const projectId = requireProjectId(projectIdValue);
    const kind = requireKind(kindValue);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw authorRecoveryError(
        "AUTHOR_RECOVERY_REVISION_INVALID",
        "Recovery record revision is invalid.",
      );
    }
    return this.executor.transaction(async (transaction) => {
      const deleted = await transaction.execute(
        `DELETE FROM author_recovery_records
         WHERE project_id = ? AND kind = ? AND revision = ?`,
        [projectId, kind, expectedRevision],
      );
      if (deleted.rowsAffected === 1) return true;
      if ((await findWithExecutor(transaction, projectId, kind)) === null) return false;
      throw new AuthorRecoveryConflictError();
    });
  }
}

export class AuthorRecoveryStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthorRecoveryStoreError";
  }
}

export class AuthorRecoveryConflictError extends AuthorRecoveryStoreError {
  public constructor() {
    super("AUTHOR_RECOVERY_CONFLICT", "Recovery record changed before this operation completed.");
    this.name = "AuthorRecoveryConflictError";
  }
}

async function findWithExecutor(
  executor: TransactionExecutor,
  projectId: string,
  kind: string,
): Promise<AuthorRecoveryRecord | null> {
  const rows = await executor.select<AuthorRecoveryRow>(
    `SELECT project_id, kind, schema_version, payload_json,
            revision, created_at, updated_at
     FROM author_recovery_records
     WHERE project_id = ? AND kind = ?`,
    [projectId, kind],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (
    row.project_id !== projectId ||
    row.kind !== kind ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    throw authorRecoveryError(
      "AUTHOR_RECOVERY_STORE_CORRUPT",
      "Recovery record metadata is not readable.",
    );
  }
  return Object.freeze({
    projectId: row.project_id,
    kind: row.kind,
    schemaVersion: row.schema_version,
    payloadJson: row.payload_json,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function requireProjectId(value: string): string {
  const parsed = parseUuidV7(value);
  if (!parsed.ok)
    throw authorRecoveryError("AUTHOR_RECOVERY_PROJECT_INVALID", "Project id is invalid.");
  return parsed.value;
}

function requireKind(value: string): string {
  if (!/^[a-z0-9_]{1,64}$/u.test(value)) {
    throw authorRecoveryError("AUTHOR_RECOVERY_KIND_INVALID", "Recovery record kind is invalid.");
  }
  return value;
}

function requireSchemaVersion(value: string): void {
  if (value.length < 1 || value.length > 128) {
    throw authorRecoveryError(
      "AUTHOR_RECOVERY_SCHEMA_INVALID",
      "Recovery record schema is invalid.",
    );
  }
}

function requirePayloadObject(value: string): void {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
  } catch {
    throw authorRecoveryError(
      "AUTHOR_RECOVERY_PAYLOAD_INVALID",
      "Recovery record payload is invalid.",
    );
  }
}

function requireTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw authorRecoveryError(
      "AUTHOR_RECOVERY_TIMESTAMP_INVALID",
      "Recovery record timestamp is invalid.",
    );
  }
}

function authorRecoveryError(code: string, message: string): AuthorRecoveryStoreError {
  return new AuthorRecoveryStoreError(code, message);
}
