import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import type { SearchDocument, SearchSourceType } from "@inkshadow/search-core";

export const DEVELOPMENT_PROJECT_SEARCH_KEY = "inkshadow.development.project-search.v1";

const SEARCH_SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_DOCUMENTS_PER_PROJECT = 100_000;
const MAX_PROJECT_CONTENT_CHARACTERS = 64_000_000;
const MAX_DOCUMENT_TEXT_LENGTH = 2_000_000;
const MAX_DOCUMENT_TITLE_LENGTH = 500;
const MAX_IDENTIFIER_LENGTH = 256;
const SEARCH_SOURCE_TYPES: readonly SearchSourceType[] = [
  "chapter",
  "outline",
  "character",
  "world",
  "foreshadow",
  "material",
  "memory",
];

export interface ProjectSearchSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly revision: number;
  readonly indexedAt: string;
  readonly documents: readonly SearchDocument[];
}

export interface SynchronizeProjectSearchInput {
  readonly projectId: string;
  readonly documents: readonly SearchDocument[];
  readonly indexedAt: string;
  readonly force?: boolean;
}

export interface ProjectSearchSynchronization {
  readonly snapshot: ProjectSearchSnapshot;
  readonly upsertedDocuments: readonly SearchDocument[];
  readonly deletedDocumentIds: readonly string[];
  readonly unchangedCount: number;
  readonly changed: boolean;
}

export interface ProjectSearchKeywordCandidates {
  readonly documentIds: readonly string[] | null;
  readonly backend: "sqlite_fts5" | "in_memory";
  readonly recovered: boolean;
  readonly degraded: boolean;
}

export interface ProjectSearchSnapshotStore {
  loadProject(projectId: string): Promise<ProjectSearchSnapshot | null>;
  synchronizeProject(input: SynchronizeProjectSearchInput): Promise<ProjectSearchSynchronization>;
  findKeywordCandidates(projectId: string, query: string): Promise<ProjectSearchKeywordCandidates>;
  resetProject(projectId: string): Promise<void>;
}

export type ProjectSearchSnapshotStoreErrorCode =
  "SEARCH_SNAPSHOT_CORRUPT" | "SEARCH_SNAPSHOT_CONFLICT" | "SEARCH_SNAPSHOT_UNAVAILABLE";

export class ProjectSearchSnapshotStoreError extends Error {
  public constructor(
    public readonly code: ProjectSearchSnapshotStoreErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProjectSearchSnapshotStoreError";
  }
}

interface SearchIndexStateRow {
  readonly projectId: string;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly documentCount: number;
  readonly contentCharacters: number;
  readonly indexedAt: string;
}

interface SearchIndexDocumentRow {
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly title: string;
  readonly searchText: string;
  readonly contentHash: string;
  readonly sourceUpdatedAt: string;
  readonly importance: number;
  readonly pinned: number;
}

interface SearchCandidateRow {
  readonly documentId: string;
}

export class TauriProjectSearchSnapshotStore implements ProjectSearchSnapshotStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadProject(projectIdValue: string): Promise<ProjectSearchSnapshot | null> {
    const projectId = validateIdentifier(projectIdValue, "projectId");
    try {
      return await readSqlSnapshot(this.executor, projectId);
    } catch (cause: unknown) {
      throw normalizeStoreFailure(cause, "Unable to load the persistent project search snapshot.");
    }
  }

  public async synchronizeProject(
    input: SynchronizeProjectSearchInput,
  ): Promise<ProjectSearchSynchronization> {
    const prepared = prepareSynchronization(input);
    try {
      return await this.synchronizePrepared(prepared);
    } catch (cause: unknown) {
      if (cause instanceof ProjectSearchSnapshotStoreError) {
        throw cause;
      }
      try {
        await this.rebuildFtsProjection();
        return await this.synchronizePrepared(prepared);
      } catch (recoveryCause: unknown) {
        throw normalizeStoreFailure(
          recoveryCause,
          "Unable to synchronize the persistent project search snapshot.",
        );
      }
    }
  }

  private async synchronizePrepared(
    prepared: PreparedSynchronization,
  ): Promise<ProjectSearchSynchronization> {
    return this.executor.transaction(async (transaction) => {
      const current = await readSqlSnapshot(transaction, prepared.projectId);
      const difference = compareSnapshots(current, prepared.documents, prepared.force);
      if (!difference.changed && current !== null) {
        return {
          snapshot: current,
          upsertedDocuments: Object.freeze([]),
          deletedDocumentIds: Object.freeze([]),
          unchangedCount: difference.unchangedCount,
          changed: false,
        };
      }

      const revision = current === null ? 1 : current.revision + 1;
      if (current === null) {
        await transaction.execute(
          `INSERT INTO search_index_state (
             project_id, schema_version, revision, document_count,
             content_characters, indexed_at, updated_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
          [
            prepared.projectId,
            revision,
            prepared.documents.length,
            prepared.contentCharacters,
            prepared.indexedAt,
            prepared.indexedAt,
          ],
        );
      } else {
        for (const documentId of difference.deletedDocumentIds) {
          await transaction.execute(
            `DELETE FROM search_index_documents
             WHERE project_id = ? AND document_id = ?`,
            [prepared.projectId, documentId],
          );
        }
      }

      for (const document of difference.upsertedDocuments) {
        await upsertSqlDocument(transaction, document, prepared.indexedAt);
      }

      if (current !== null) {
        const updated = await transaction.execute(
          `UPDATE search_index_state
           SET revision = ?, document_count = ?, content_characters = ?,
               indexed_at = ?, updated_at = ?
           WHERE project_id = ? AND revision = ?`,
          [
            revision,
            prepared.documents.length,
            prepared.contentCharacters,
            prepared.indexedAt,
            prepared.indexedAt,
            prepared.projectId,
            current.revision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw new ProjectSearchSnapshotStoreError(
            "SEARCH_SNAPSHOT_CONFLICT",
            "The persistent search snapshot changed during synchronization.",
            true,
          );
        }
      }

      return {
        snapshot: createSnapshot(
          prepared.projectId,
          revision,
          prepared.indexedAt,
          prepared.documents,
        ),
        upsertedDocuments: difference.upsertedDocuments,
        deletedDocumentIds: difference.deletedDocumentIds,
        unchangedCount: difference.unchangedCount,
        changed: true,
      };
    });
  }

  private rebuildFtsProjection(): Promise<unknown> {
    return this.executor.execute(
      "INSERT INTO search_index_fts(search_index_fts) VALUES('rebuild')",
    );
  }

  public async resetProject(projectIdValue: string): Promise<void> {
    const projectId = validateIdentifier(projectIdValue, "projectId");
    try {
      await this.resetSqlProject(projectId);
    } catch {
      try {
        await this.rebuildFtsProjection();
        await this.resetSqlProject(projectId);
      } catch (recoveryCause: unknown) {
        throw normalizeStoreFailure(
          recoveryCause,
          "Unable to reset the persistent project search snapshot.",
        );
      }
    }
  }

  private resetSqlProject(projectId: string): Promise<void> {
    return this.executor.transaction(async (transaction) => {
      await transaction.execute("DELETE FROM search_index_documents WHERE project_id = ?", [
        projectId,
      ]);
      await transaction.execute("DELETE FROM search_index_state WHERE project_id = ?", [projectId]);
    });
  }

  public async findKeywordCandidates(
    projectIdValue: string,
    queryValue: string,
  ): Promise<ProjectSearchKeywordCandidates> {
    const projectId = validateIdentifier(projectIdValue, "projectId");
    const query = prepareFtsQuery(queryValue);
    if (query === null) {
      return {
        documentIds: null,
        backend: "in_memory",
        recovered: false,
        degraded: false,
      };
    }
    try {
      return {
        documentIds: await this.selectFtsCandidates(projectId, query),
        backend: "sqlite_fts5",
        recovered: false,
        degraded: false,
      };
    } catch {
      try {
        await this.rebuildFtsProjection();
        return {
          documentIds: await this.selectFtsCandidates(projectId, query),
          backend: "sqlite_fts5",
          recovered: true,
          degraded: false,
        };
      } catch {
        return {
          documentIds: null,
          backend: "in_memory",
          recovered: false,
          degraded: true,
        };
      }
    }
  }

  private async selectFtsCandidates(projectId: string, query: string): Promise<readonly string[]> {
    const rows = await this.executor.select<SearchCandidateRow>(
      `SELECT document.document_id AS documentId
       FROM search_index_fts
       JOIN search_index_documents AS document
         ON document.rowid = search_index_fts.rowid
       WHERE search_index_fts MATCH ?
         AND document.project_id = ?
       ORDER BY bm25(search_index_fts) ASC, document.document_id ASC
       LIMIT 100000`,
      [query, projectId],
    );
    return Object.freeze(
      rows.map(({ documentId }) => validateIdentifier(documentId, "documentId")),
    );
  }
}

interface BrowserSearchDatabase {
  readonly schemaVersion: 1;
  readonly projects: Record<string, ProjectSearchSnapshot>;
}

export class BrowserDevelopmentProjectSearchSnapshotStore implements ProjectSearchSnapshotStore {
  public constructor(private readonly storage: Storage) {}

  public loadProject(projectIdValue: string): Promise<ProjectSearchSnapshot | null> {
    return Promise.resolve().then(() => {
      const projectId = validateIdentifier(projectIdValue, "projectId");
      const snapshot = this.readDatabase().projects[projectId];
      if (snapshot === undefined) {
        return null;
      }
      const validated = validateSnapshot(snapshot);
      if (validated.projectId !== projectId) {
        throw corruptSnapshot("Stored project search key does not match its payload.");
      }
      return validated;
    });
  }

  public synchronizeProject(
    input: SynchronizeProjectSearchInput,
  ): Promise<ProjectSearchSynchronization> {
    return Promise.resolve().then(() => {
      const prepared = prepareSynchronization(input);
      const database = this.readDatabase();
      const stored = database.projects[prepared.projectId];
      const current = stored === undefined ? null : validateSnapshot(stored);
      const difference = compareSnapshots(current, prepared.documents, input.force === true);
      if (!difference.changed && current !== null) {
        return {
          snapshot: current,
          upsertedDocuments: Object.freeze([]),
          deletedDocumentIds: Object.freeze([]),
          unchangedCount: difference.unchangedCount,
          changed: false,
        };
      }

      const snapshot = createSnapshot(
        prepared.projectId,
        current === null ? 1 : current.revision + 1,
        prepared.indexedAt,
        prepared.documents,
      );
      database.projects[prepared.projectId] = snapshot;
      this.writeDatabase(database);
      return {
        snapshot,
        upsertedDocuments: difference.upsertedDocuments,
        deletedDocumentIds: difference.deletedDocumentIds,
        unchangedCount: difference.unchangedCount,
        changed: true,
      };
    });
  }

  public resetProject(projectIdValue: string): Promise<void> {
    return Promise.resolve().then(() => {
      const projectId = validateIdentifier(projectIdValue, "projectId");
      let database: BrowserSearchDatabase;
      try {
        database = this.readDatabase();
      } catch (cause: unknown) {
        if (
          cause instanceof ProjectSearchSnapshotStoreError &&
          cause.code === "SEARCH_SNAPSHOT_CORRUPT"
        ) {
          this.storage.removeItem(DEVELOPMENT_PROJECT_SEARCH_KEY);
          return;
        }
        throw cause;
      }
      const remainingProjects = Object.fromEntries(
        Object.entries(database.projects).filter(([candidateId]) => candidateId !== projectId),
      );
      this.writeDatabase({ ...database, projects: remainingProjects });
    });
  }

  public findKeywordCandidates(): Promise<ProjectSearchKeywordCandidates> {
    return Promise.resolve({
      documentIds: null,
      backend: "in_memory",
      recovered: false,
      degraded: false,
    });
  }

  private readDatabase(): BrowserSearchDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY);
    if (serialized === null) {
      return { schemaVersion: 1, projects: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== SEARCH_SNAPSHOT_SCHEMA_VERSION ||
        !isRecord(parsed.projects)
      ) {
        throw corruptSnapshot("Stored project search database has an invalid shape.");
      }
      return structuredClone(parsed) as unknown as BrowserSearchDatabase;
    } catch (cause: unknown) {
      throw cause instanceof ProjectSearchSnapshotStoreError
        ? cause
        : corruptSnapshot("Stored project search database cannot be decoded.");
    }
  }

  private writeDatabase(database: BrowserSearchDatabase): void {
    try {
      this.storage.setItem(DEVELOPMENT_PROJECT_SEARCH_KEY, JSON.stringify(database));
    } catch {
      throw new ProjectSearchSnapshotStoreError(
        "SEARCH_SNAPSHOT_UNAVAILABLE",
        "The browser development search snapshot could not be persisted.",
        true,
      );
    }
  }
}

interface PreparedSynchronization {
  readonly projectId: string;
  readonly documents: readonly SearchDocument[];
  readonly indexedAt: string;
  readonly contentCharacters: number;
  readonly force: boolean;
}

interface SnapshotDifference {
  readonly upsertedDocuments: readonly SearchDocument[];
  readonly deletedDocumentIds: readonly string[];
  readonly unchangedCount: number;
  readonly changed: boolean;
}

function prepareSynchronization(input: SynchronizeProjectSearchInput): PreparedSynchronization {
  const projectId = validateIdentifier(input.projectId, "projectId");
  const indexedAt = validateIsoTimestamp(input.indexedAt, "indexedAt");
  const documents = validateDocuments(projectId, input.documents);
  return {
    projectId,
    documents,
    indexedAt,
    contentCharacters: documents.reduce((total, document) => total + document.text.length, 0),
    force: input.force === true,
  };
}

async function readSqlSnapshot(
  executor: TransactionExecutor,
  projectId: string,
): Promise<ProjectSearchSnapshot | null> {
  const states = await executor.select<SearchIndexStateRow>(
    `SELECT
       project_id AS projectId,
       schema_version AS schemaVersion,
       revision,
       document_count AS documentCount,
       content_characters AS contentCharacters,
       indexed_at AS indexedAt
     FROM search_index_state
     WHERE project_id = ?`,
    [projectId],
  );
  if (states.length === 0) {
    return null;
  }
  if (states.length !== 1) {
    throw corruptSnapshot("Persistent project search state is not unique.");
  }
  const state = states[0];
  if (state === undefined) {
    throw corruptSnapshot("Persistent project search state is missing.");
  }
  const rows = await executor.select<SearchIndexDocumentRow>(
    `SELECT
       project_id AS projectId,
       document_id AS documentId,
       source_type AS sourceType,
       source_id AS sourceId,
       source_version_id AS sourceVersionId,
       title,
       search_text AS searchText,
       content_hash AS contentHash,
       source_updated_at AS sourceUpdatedAt,
       importance,
       pinned
     FROM search_index_documents
     WHERE project_id = ?
     ORDER BY document_id ASC`,
    [projectId],
  );
  const documents = rows.map(hydrateSqlDocument);
  const snapshot = validateSnapshot({
    schemaVersion: state.schemaVersion,
    projectId: state.projectId,
    revision: state.revision,
    indexedAt: state.indexedAt,
    documents,
  });
  const contentCharacters = snapshot.documents.reduce(
    (total, document) => total + document.text.length,
    0,
  );
  if (
    state.documentCount !== snapshot.documents.length ||
    state.contentCharacters !== contentCharacters
  ) {
    throw corruptSnapshot("Persistent project search counts do not match stored documents.");
  }
  return snapshot;
}

async function upsertSqlDocument(
  executor: TransactionExecutor,
  document: SearchDocument,
  indexedAt: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO search_index_documents (
       project_id, document_id, source_type, source_id, source_version_id,
       title, search_text, normalized_title, normalized_search_text,
       content_hash, source_updated_at, importance, pinned, indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, document_id) DO UPDATE SET
       source_type = excluded.source_type,
       source_id = excluded.source_id,
       source_version_id = excluded.source_version_id,
       title = excluded.title,
       search_text = excluded.search_text,
       normalized_title = excluded.normalized_title,
       normalized_search_text = excluded.normalized_search_text,
       content_hash = excluded.content_hash,
       source_updated_at = excluded.source_updated_at,
       importance = excluded.importance,
       pinned = excluded.pinned,
       indexed_at = excluded.indexed_at`,
    [
      document.projectId,
      document.id,
      document.sourceType,
      document.sourceId,
      document.sourceVersionId,
      document.title,
      document.text,
      normalizePersistentSearchText(document.title),
      normalizePersistentSearchText(document.text),
      document.contentHash,
      document.updatedAt,
      document.importance ?? 0,
      document.pinned === true ? 1 : 0,
      indexedAt,
    ],
  );
}

function hydrateSqlDocument(row: SearchIndexDocumentRow): SearchDocument {
  if (row.pinned !== 0 && row.pinned !== 1) {
    throw corruptSnapshot("Persistent project search pinned state is invalid.");
  }
  return validateDocument({
    id: row.documentId,
    projectId: row.projectId,
    sourceType: row.sourceType as SearchSourceType,
    sourceId: row.sourceId,
    sourceVersionId: row.sourceVersionId,
    title: row.title,
    text: row.searchText,
    contentHash: row.contentHash,
    updatedAt: row.sourceUpdatedAt,
    importance: row.importance,
    pinned: row.pinned === 1,
  });
}

function validateSnapshot(value: unknown): ProjectSearchSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SEARCH_SNAPSHOT_SCHEMA_VERSION ||
    typeof value.projectId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.indexedAt !== "string" ||
    !Array.isArray(value.documents)
  ) {
    throw corruptSnapshot("Stored project search snapshot metadata is invalid.");
  }
  const projectId = validateIdentifier(value.projectId, "projectId");
  const documents = validateDocuments(projectId, value.documents as SearchDocument[]);
  return createSnapshot(
    projectId,
    value.revision as number,
    validateIsoTimestamp(value.indexedAt, "indexedAt"),
    documents,
  );
}

function validateDocuments(
  projectId: string,
  values: readonly SearchDocument[],
): readonly SearchDocument[] {
  if (values.length > MAX_DOCUMENTS_PER_PROJECT) {
    throw corruptSnapshot("Persistent project search document count exceeds its safety bound.");
  }
  const identifiers = new Set<string>();
  let contentCharacters = 0;
  const documents = values.map((value) => {
    const document = validateDocument(value);
    if (document.projectId !== projectId || identifiers.has(document.id)) {
      throw corruptSnapshot("Persistent project search documents are duplicated or misplaced.");
    }
    identifiers.add(document.id);
    contentCharacters += document.text.length;
    if (contentCharacters > MAX_PROJECT_CONTENT_CHARACTERS) {
      throw corruptSnapshot("Persistent project search content exceeds its safety bound.");
    }
    return document;
  });
  return Object.freeze(documents.sort((left, right) => left.id.localeCompare(right.id)));
}

function validateDocument(value: SearchDocument): SearchDocument {
  if (!isRecord(value) || !SEARCH_SOURCE_TYPES.includes(value.sourceType)) {
    throw corruptSnapshot("Persistent project search document type is invalid.");
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (
    title.length === 0 ||
    title.length > MAX_DOCUMENT_TITLE_LENGTH ||
    typeof value.text !== "string" ||
    value.text.length > MAX_DOCUMENT_TEXT_LENGTH ||
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.contentHash)
  ) {
    throw corruptSnapshot("Persistent project search document content is invalid.");
  }
  const importance = value.importance ?? 0;
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw corruptSnapshot("Persistent project search importance is invalid.");
  }
  return Object.freeze({
    id: validateIdentifier(value.id, "document.id"),
    projectId: validateIdentifier(value.projectId, "document.projectId"),
    sourceType: value.sourceType,
    sourceId: validateIdentifier(value.sourceId, "document.sourceId"),
    sourceVersionId: validateIdentifier(value.sourceVersionId, "document.sourceVersionId"),
    title,
    text: value.text,
    contentHash: value.contentHash,
    updatedAt: validateIsoTimestamp(value.updatedAt, "document.updatedAt"),
    importance,
    pinned: value.pinned === true,
  });
}

function compareSnapshots(
  current: ProjectSearchSnapshot | null,
  desired: readonly SearchDocument[],
  force: boolean,
): SnapshotDifference {
  const currentById = new Map(current?.documents.map((document) => [document.id, document]) ?? []);
  const desiredIds = new Set(desired.map(({ id }) => id));
  const upsertedDocuments = force
    ? [...desired]
    : desired.filter((document) => {
        const stored = currentById.get(document.id);
        return stored === undefined || !sameDocument(stored, document);
      });
  const deletedDocumentIds =
    current === null
      ? []
      : current.documents
          .filter(({ id }) => !desiredIds.has(id))
          .map(({ id }) => id)
          .sort();
  const unchangedCount = desired.length - upsertedDocuments.length;
  return {
    upsertedDocuments: Object.freeze(upsertedDocuments),
    deletedDocumentIds: Object.freeze(deletedDocumentIds),
    unchangedCount,
    changed:
      current === null || force || upsertedDocuments.length > 0 || deletedDocumentIds.length > 0,
  };
}

function sameDocument(left: SearchDocument, right: SearchDocument): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.sourceType === right.sourceType &&
    left.sourceId === right.sourceId &&
    left.sourceVersionId === right.sourceVersionId &&
    left.title === right.title &&
    left.text === right.text &&
    left.contentHash === right.contentHash &&
    left.updatedAt === right.updatedAt &&
    (left.importance ?? 0) === (right.importance ?? 0) &&
    (left.pinned === true) === (right.pinned === true)
  );
}

function createSnapshot(
  projectId: string,
  revision: number,
  indexedAt: string,
  documents: readonly SearchDocument[],
): ProjectSearchSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    projectId,
    revision,
    indexedAt,
    documents: Object.freeze(documents.map((document) => Object.freeze({ ...document }))),
  });
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw corruptSnapshot(`${field} is not a string identifier.`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw corruptSnapshot(`${field} is not a safe identifier.`);
  }
  return normalized;
}

function validateIsoTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw corruptSnapshot(`${field} is not an exact UTC ISO timestamp.`);
  }
  return value;
}

function prepareFtsQuery(value: string): string | null {
  const normalized = normalizePersistentSearchText(value);
  if (normalized.length < 3 || normalized.includes(" ")) {
    return null;
  }
  const trigrams = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }
  return [...trigrams].map((trigram) => `"${trigram.replaceAll('"', '""')}"`).join(" OR ");
}

function normalizePersistentSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, " ").trim();
}

function normalizeStoreFailure(cause: unknown, message: string): ProjectSearchSnapshotStoreError {
  return cause instanceof ProjectSearchSnapshotStoreError
    ? cause
    : new ProjectSearchSnapshotStoreError("SEARCH_SNAPSHOT_UNAVAILABLE", message, true);
}

function corruptSnapshot(message: string): ProjectSearchSnapshotStoreError {
  return new ProjectSearchSnapshotStoreError("SEARCH_SNAPSHOT_CORRUPT", message, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
