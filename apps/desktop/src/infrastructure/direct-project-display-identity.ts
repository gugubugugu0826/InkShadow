import type { TransactionExecutor } from "@inkshadow/data";
import type { IsoUtcTimestamp, UuidV7 } from "@inkshadow/domain";

import type {
  DevelopmentProjectDisplayIdentityRevisionSnapshot,
  DevelopmentProjectDisplayIdentitySnapshot,
  NormalizedDevelopmentStoredDatabase,
} from "./development-storage";

const CURRENT_IDENTITY_TABLE = "project_display_identities";
const IDENTITY_REVISION_TABLE = "project_display_identity_revisions";

interface SqliteSchemaRow {
  readonly name: string;
}

interface InitialIdentityRevisionRow {
  readonly projectId: string;
  readonly revision: number;
  readonly previousDisplayKind: string | null;
  readonly displayKind: string;
  readonly provenance: string;
  readonly recordedAt: string;
}

/**
 * Records an explicitly created author project in the same SQLite transaction
 * as the project row. Pre-identity test schemas remain supported only when both
 * identity tables are absent. Any partial schema or missing history trigger
 * aborts the caller-owned transaction.
 */
export async function insertExplicitAuthorIdentityIfAvailable(
  transaction: TransactionExecutor,
  projectId: string,
  recordedAt: string,
): Promise<void> {
  const schemaRows = await transaction.select<SqliteSchemaRow>(
    `SELECT name
     FROM sqlite_schema
     WHERE type = 'table' AND name IN (?, ?)
     ORDER BY name`,
    [CURRENT_IDENTITY_TABLE, IDENTITY_REVISION_TABLE],
  );
  const tableNames = new Set(schemaRows.map(({ name }) => name));
  if (tableNames.size === 0) {
    return;
  }
  if (
    tableNames.size !== 2 ||
    !tableNames.has(CURRENT_IDENTITY_TABLE) ||
    !tableNames.has(IDENTITY_REVISION_TABLE)
  ) {
    throw identityIntegrityError("PartialProjectDisplayIdentitySchema");
  }

  const inserted = await transaction.execute(
    `INSERT INTO project_display_identities (
       project_id, display_kind, provenance, revision, created_at, updated_at
     ) VALUES (?, 'author_work', 'explicit_creation', 1, ?, ?)`,
    [projectId, recordedAt, recordedAt],
  );
  if (inserted.rowsAffected !== 1) {
    throw identityIntegrityError("AuthorIdentityInsertDidNotAffectOneRow");
  }

  const revisions = await transaction.select<InitialIdentityRevisionRow>(
    `SELECT project_id AS projectId, revision,
            previous_display_kind AS previousDisplayKind,
            display_kind AS displayKind, provenance,
            recorded_at AS recordedAt
     FROM project_display_identity_revisions
     WHERE project_id = ? AND revision = 1`,
    [projectId],
  );
  const revision = revisions[0];
  if (
    revisions.length !== 1 ||
    revision?.projectId !== projectId ||
    revision.revision !== 1 ||
    revision.previousDisplayKind !== null ||
    revision.displayKind !== "author_work" ||
    revision.provenance !== "explicit_creation" ||
    revision.recordedAt !== recordedAt
  ) {
    throw identityIntegrityError("InitialAuthorIdentityHistoryMissing");
  }
}

/**
 * Adds current identity and immutable revision history to one in-memory
 * development database value before that value is journaled and persisted.
 */
export function appendExplicitAuthorIdentityToDevelopmentDatabase(
  database: Pick<
    NormalizedDevelopmentStoredDatabase,
    "projects" | "projectDisplayIdentities" | "projectDisplayIdentityRevisions"
  >,
  projectId: UuidV7,
  recordedAt: IsoUtcTimestamp,
): void {
  if (!database.projects.some(({ id }) => id === projectId)) {
    throw identityIntegrityError("ProjectMissingBeforeAuthorIdentity");
  }
  if (
    database.projectDisplayIdentities.some((identity) => identity.projectId === projectId) ||
    database.projectDisplayIdentityRevisions.some((revision) => revision.projectId === projectId)
  ) {
    throw identityIntegrityError("DuplicateProjectDisplayIdentity");
  }

  const identity: DevelopmentProjectDisplayIdentitySnapshot = Object.freeze({
    projectId,
    displayKind: "author_work",
    provenance: "explicit_creation",
    recordedAt,
    revision: 1,
  });
  const revision: DevelopmentProjectDisplayIdentityRevisionSnapshot = Object.freeze({
    ...identity,
    previousDisplayKind: null,
  });
  database.projectDisplayIdentities.push(identity);
  database.projectDisplayIdentityRevisions.push(revision);
}

function identityIntegrityError(reason: string): Error {
  const error = new Error(`本地作品分类完整性检查未通过：${reason}。`);
  error.name = "ProjectDisplayIdentityIntegrityError";
  return error;
}
