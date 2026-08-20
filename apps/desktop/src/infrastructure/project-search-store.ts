import type { SqlExecutor, SqlPrimitive, TransactionExecutor } from "@inkshadow/data";
import {
  SEARCH_CHUNK_KINDS,
  SEARCH_DOCUMENT_AUTHORITIES,
  SEARCH_DOCUMENT_CURRENTNESS,
  SEARCH_DOCUMENT_PRIVACY_MODES,
  SEARCH_RETRIEVAL_PRIVACY_SCOPES,
  SEARCH_RETRIEVAL_TASK_TYPES,
  type SearchChunkKind,
  type SearchDocument,
  type SearchDocumentAuthority,
  type SearchDocumentCurrentness,
  type SearchDocumentPrivacyMode,
  type SearchRetrievalScope,
  type SearchRetrievalScopeTrace,
  type SearchRetrievalTaskType,
  type SearchSourceType,
} from "@inkshadow/search-core";

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
  readonly scopeTrace: SearchRetrievalScopeTrace;
}

export interface ProjectSearchSnapshotStore {
  loadProject(projectId: string): Promise<ProjectSearchSnapshot | null>;
  synchronizeProject(input: SynchronizeProjectSearchInput): Promise<ProjectSearchSynchronization>;
  findKeywordCandidates(
    projectId: string,
    query: string,
    scope: SearchRetrievalScope,
  ): Promise<ProjectSearchKeywordCandidates>;
  resetProject(projectId: string): Promise<void>;
}

export type ProjectSearchSnapshotStoreErrorCode =
  | "SEARCH_SNAPSHOT_CORRUPT"
  | "SEARCH_SNAPSHOT_CONFLICT"
  | "SEARCH_SNAPSHOT_UNAVAILABLE"
  | "SEARCH_SCOPE_INVALID";

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
  readonly chunkKind: string;
  readonly parentDocumentId: string | null;
  readonly utf16Start: number;
  readonly utf16End: number;
  readonly sourceLength: number;
  readonly sceneId: string | null;
  readonly eventId: string | null;
  readonly characterIdsJson: string;
  readonly locationIdsJson: string;
  readonly storyTime: string | null;
  readonly branchId: string | null;
  readonly povCharacterId: string | null;
  readonly storyOrder: number | null;
  readonly authority: string;
  readonly privacy: string;
  readonly currentness: string;
  readonly omittedScopeFieldsJson: string;
}

interface SearchCandidateRow {
  readonly documentId: string;
  readonly branchId: string | null;
  readonly povCharacterId: string | null;
  readonly storyOrder: number | null;
}

interface ScopedCandidates {
  readonly documentIds: readonly string[];
  readonly scopeTrace: SearchRetrievalScopeTrace;
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
    scopeValue: SearchRetrievalScope,
  ): Promise<ProjectSearchKeywordCandidates> {
    const projectId = validateIdentifier(projectIdValue, "projectId");
    const scope = prepareRetrievalScope(projectId, scopeValue);
    const query = prepareFtsQuery(queryValue);
    if (query === null) {
      const candidates = await this.selectScopeCandidates(scope);
      return {
        documentIds: candidates.documentIds,
        backend: "in_memory",
        recovered: false,
        degraded: false,
        scopeTrace: candidates.scopeTrace,
      };
    }
    try {
      const candidates = await this.selectFtsCandidates(query, scope);
      return {
        documentIds: candidates.documentIds,
        backend: "sqlite_fts5",
        recovered: false,
        degraded: false,
        scopeTrace: candidates.scopeTrace,
      };
    } catch {
      if (scope.readOnly) {
        return {
          documentIds: Object.freeze([]),
          backend: "sqlite_fts5",
          recovered: false,
          degraded: true,
          scopeTrace: scope.trace,
        };
      }
      try {
        await this.rebuildFtsProjection();
        const candidates = await this.selectFtsCandidates(query, scope);
        return {
          documentIds: candidates.documentIds,
          backend: "sqlite_fts5",
          recovered: true,
          degraded: false,
          scopeTrace: candidates.scopeTrace,
        };
      } catch {
        return {
          documentIds: Object.freeze([]),
          backend: "sqlite_fts5",
          recovered: false,
          degraded: true,
          scopeTrace: scope.trace,
        };
      }
    }
  }

  private async selectFtsCandidates(
    query: string,
    scope: PreparedSearchRetrievalScope,
  ): Promise<ScopedCandidates> {
    const filter = buildScopedWhere(scope, "document");
    const rows = await this.executor.select<SearchCandidateRow>(
      `SELECT document.document_id AS documentId,
              document.branch_id AS branchId,
              document.pov_character_id AS povCharacterId,
              document.story_order AS storyOrder
       FROM search_index_fts
       JOIN search_index_documents AS document
         ON document.rowid = search_index_fts.rowid
       WHERE search_index_fts MATCH ?
         AND ${filter.sql}
       ORDER BY bm25(search_index_fts) ASC, document.document_id ASC
       LIMIT 100000`,
      [query, ...filter.parameters],
    );
    return createScopedCandidates(scope, rows);
  }

  private async selectScopeCandidates(
    scope: PreparedSearchRetrievalScope,
  ): Promise<ScopedCandidates> {
    const filter = buildScopedWhere(scope, "document");
    const rows = await this.executor.select<SearchCandidateRow>(
      `SELECT document.document_id AS documentId,
              document.branch_id AS branchId,
              document.pov_character_id AS povCharacterId,
              document.story_order AS storyOrder
       FROM search_index_documents AS document
       WHERE ${filter.sql}
       ORDER BY document.document_id ASC
       LIMIT 100000`,
      filter.parameters,
    );
    return createScopedCandidates(scope, rows);
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

  public findKeywordCandidates(
    projectIdValue: string,
    _query: string,
    scopeValue: SearchRetrievalScope,
  ): Promise<ProjectSearchKeywordCandidates> {
    return Promise.resolve().then(() => {
      const projectId = validateIdentifier(projectIdValue, "projectId");
      const scope = prepareRetrievalScope(projectId, scopeValue);
      const stored = this.readDatabase().projects[projectId];
      const documents = stored === undefined ? [] : validateSnapshot(stored).documents;
      const candidates = documents
        .filter((document) => documentMatchesScope(document, scope))
        .map((document) => ({
          documentId: document.id,
          branchId: document.branchId ?? null,
          povCharacterId: document.povCharacterId ?? null,
          storyOrder: document.storyOrder ?? null,
        }));
      const scoped = createScopedCandidates(scope, candidates);
      return {
        documentIds: scoped.documentIds,
        backend: "in_memory",
        recovered: false,
        degraded: false,
        scopeTrace: scoped.scopeTrace,
      };
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

interface PreparedSearchRetrievalScope {
  readonly projectId: string;
  readonly taskType: SearchRetrievalTaskType;
  readonly privacy: SearchRetrievalScope["privacy"];
  readonly currentness: SearchDocumentCurrentness;
  readonly sourceId: string | undefined;
  readonly currentVersionId: string | undefined;
  readonly branch: Readonly<{ provided: boolean; value: string | null }>;
  readonly pov: Readonly<{ provided: boolean; value: string | null }>;
  readonly maximumStoryOrder: number | undefined;
  readonly authorities: readonly SearchDocumentAuthority[];
  readonly chunkKinds: readonly SearchChunkKind[];
  readonly readOnly: boolean;
  readonly trace: SearchRetrievalScopeTrace;
}

interface SqlScopeFilter {
  readonly sql: string;
  readonly parameters: readonly SqlPrimitive[];
}

const TASK_AUTHORITIES: Readonly<
  Record<SearchRetrievalTaskType, readonly SearchDocumentAuthority[]>
> = Object.freeze({
  project_search: Object.freeze(["accepted_text", "confirmed_fact", "rebuildable"] as const),
  continuation: Object.freeze(["accepted_text", "confirmed_fact"] as const),
  consistency: Object.freeze(["accepted_text", "confirmed_fact", "rebuildable"] as const),
  agent_fts: Object.freeze(["accepted_text", "confirmed_fact"] as const),
});

const TASK_CHUNK_KINDS: Readonly<Record<SearchRetrievalTaskType, readonly SearchChunkKind[]>> =
  Object.freeze({
    project_search: Object.freeze(["chapter", "scene", "event", "story_fact_evidence"] as const),
    continuation: Object.freeze([
      "chapter",
      "event",
      "paragraph",
      "dialogue",
      "story_fact_evidence",
    ] as const),
    consistency: Object.freeze([...SEARCH_CHUNK_KINDS]),
    agent_fts: Object.freeze([...SEARCH_CHUNK_KINDS]),
  });

export function defaultProjectSearchRetrievalScope(projectId: string): SearchRetrievalScope {
  return Object.freeze({
    projectId,
    taskType: "project_search",
    privacy: "include_local_only",
    currentness: "current",
  });
}

function prepareRetrievalScope(
  projectId: string,
  value: SearchRetrievalScope,
): PreparedSearchRetrievalScope {
  if (
    !isRecord(value) ||
    validateScopeIdentifier(value.projectId, "scope.projectId") !== projectId ||
    !SEARCH_RETRIEVAL_TASK_TYPES.includes(value.taskType) ||
    !SEARCH_RETRIEVAL_PRIVACY_SCOPES.includes(value.privacy) ||
    !SEARCH_DOCUMENT_CURRENTNESS.includes(value.currentness)
  ) {
    throw invalidScope("Project search retrieval scope is invalid.");
  }
  const currentVersionId =
    value.currentVersionId === undefined
      ? undefined
      : validateScopeIdentifier(value.currentVersionId, "scope.currentVersionId");
  const sourceId =
    value.sourceId === undefined
      ? undefined
      : validateScopeIdentifier(value.sourceId, "scope.sourceId");
  if ((sourceId === undefined) !== (currentVersionId === undefined)) {
    throw invalidScope("A version filter must identify exactly one source and version.");
  }
  const branch = Object.freeze({
    provided: value.branchId !== undefined,
    value:
      value.branchId === undefined
        ? null
        : validateNullableScopeIdentifier(value.branchId, "scope.branchId"),
  });
  const pov = Object.freeze({
    provided: value.povCharacterId !== undefined,
    value:
      value.povCharacterId === undefined
        ? null
        : validateNullableScopeIdentifier(value.povCharacterId, "scope.povCharacterId"),
  });
  const maximumStoryOrder = value.maximumStoryOrder;
  if (
    maximumStoryOrder !== undefined &&
    (!Number.isSafeInteger(maximumStoryOrder) || maximumStoryOrder < 0)
  ) {
    throw invalidScope("Project search story-order scope is invalid.");
  }
  const omittedHardFilters: SearchRetrievalScopeTrace["omittedHardFilters"][number][] = [];
  if (!branch.provided) {
    omittedHardFilters.push("branch");
  }
  if (!pov.provided) {
    omittedHardFilters.push("pov");
  }
  if (maximumStoryOrder === undefined) {
    omittedHardFilters.push("story_order");
  }
  if (
    (value.taskType === "agent_fts" || value.taskType === "continuation") &&
    (omittedHardFilters.length > 0 || value.currentness !== "current")
  ) {
    throw invalidScope(
      "Generation and Agent FTS scopes require current per-source rows, branch, POV, and story-order authority.",
    );
  }
  return Object.freeze({
    projectId,
    taskType: value.taskType,
    privacy: value.privacy,
    currentness: value.currentness,
    sourceId,
    currentVersionId,
    branch,
    pov,
    maximumStoryOrder,
    authorities: TASK_AUTHORITIES[value.taskType],
    chunkKinds: TASK_CHUNK_KINDS[value.taskType],
    readOnly: value.taskType !== "project_search",
    trace: Object.freeze({
      taskType: value.taskType,
      omittedHardFilters: Object.freeze(omittedHardFilters),
      authorityNeutralOmissions: Object.freeze([]),
      versionMode:
        sourceId === undefined ? "per_source_current" : ("single_source_version" as const),
    }),
  });
}

function buildScopedWhere(scope: PreparedSearchRetrievalScope, alias: "document"): SqlScopeFilter {
  const clauses = [
    `${alias}.project_id = ?`,
    `${alias}.currentness = ?`,
    `${alias}.privacy IN (${privacyValues(scope.privacy)
      .map(() => "?")
      .join(", ")})`,
    `${alias}.authority IN (${scope.authorities.map(() => "?").join(", ")})`,
    `${alias}.chunk_kind IN (${scope.chunkKinds.map(() => "?").join(", ")})`,
  ];
  const parameters: SqlPrimitive[] = [
    scope.projectId,
    scope.currentness,
    ...privacyValues(scope.privacy),
    ...scope.authorities,
    ...scope.chunkKinds,
  ];
  if (scope.sourceId !== undefined && scope.currentVersionId !== undefined) {
    clauses.push(`${alias}.source_id = ?`, `${alias}.source_version_id = ?`);
    parameters.push(scope.sourceId, scope.currentVersionId);
  }
  appendAuthorityNeutralScope(clauses, parameters, `${alias}.branch_id`, scope.branch);
  appendAuthorityNeutralScope(clauses, parameters, `${alias}.pov_character_id`, scope.pov);
  if (scope.maximumStoryOrder !== undefined) {
    clauses.push(
      `(${alias}.story_order <= ? OR (` +
        `${alias}.story_order IS NULL AND ${alias}.branch_id IS NULL ` +
        `AND ${alias}.pov_character_id IS NULL))`,
    );
    parameters.push(scope.maximumStoryOrder);
  }
  return Object.freeze({ sql: clauses.join(" AND "), parameters: Object.freeze(parameters) });
}

function appendAuthorityNeutralScope(
  clauses: string[],
  parameters: SqlPrimitive[],
  column: string,
  filter: Readonly<{ provided: boolean; value: string | null }>,
): void {
  if (!filter.provided) {
    return;
  }
  if (filter.value === null) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`(${column} IS NULL OR ${column} = ?)`);
  parameters.push(filter.value);
}

function privacyValues(
  privacy: SearchRetrievalScope["privacy"],
): readonly SearchDocumentPrivacyMode[] {
  switch (privacy) {
    case "standard_only":
      return Object.freeze(["standard"]);
    case "local_only":
      return Object.freeze(["local_only"]);
    case "include_local_only":
      return Object.freeze(["standard", "local_only"]);
  }
}

function documentMatchesScope(
  document: SearchDocument,
  scope: PreparedSearchRetrievalScope,
): boolean {
  return (
    document.projectId === scope.projectId &&
    document.currentness === scope.currentness &&
    privacyValues(scope.privacy).includes(document.privacy ?? "standard") &&
    scope.authorities.includes(document.authority ?? "rebuildable") &&
    scope.chunkKinds.includes(document.chunkKind ?? "chapter") &&
    (scope.sourceId === undefined ||
      (document.sourceId === scope.sourceId &&
        document.sourceVersionId === scope.currentVersionId)) &&
    (!scope.branch.provided ||
      document.branchId === null ||
      document.branchId === undefined ||
      document.branchId === scope.branch.value) &&
    (!scope.pov.provided ||
      document.povCharacterId === null ||
      document.povCharacterId === undefined ||
      document.povCharacterId === scope.pov.value) &&
    (scope.maximumStoryOrder === undefined ||
      (document.storyOrder !== null &&
        document.storyOrder !== undefined &&
        document.storyOrder <= scope.maximumStoryOrder) ||
      ((document.storyOrder === null || document.storyOrder === undefined) &&
        (document.branchId === null || document.branchId === undefined) &&
        (document.povCharacterId === null || document.povCharacterId === undefined)))
  );
}

function createScopedCandidates(
  scope: PreparedSearchRetrievalScope,
  rows: readonly SearchCandidateRow[],
): ScopedCandidates {
  const validated = rows.map((row) => {
    if (row.storyOrder !== null && (!Number.isSafeInteger(row.storyOrder) || row.storyOrder < 0)) {
      throw corruptSnapshot("Persistent project search story order is invalid.");
    }
    return {
      documentId: validateIdentifier(row.documentId, "documentId"),
      branchId: validateNullableIdentifier(row.branchId, "candidate.branchId"),
      povCharacterId: validateNullableIdentifier(row.povCharacterId, "candidate.povCharacterId"),
      storyOrder: row.storyOrder,
    };
  });
  const authorityNeutralOmissions: SearchRetrievalScopeTrace["authorityNeutralOmissions"][number][] =
    [];
  if (
    scope.branch.provided &&
    scope.branch.value !== null &&
    validated.some(({ branchId }) => branchId === null)
  ) {
    authorityNeutralOmissions.push("branch");
  }
  if (
    scope.pov.provided &&
    scope.pov.value !== null &&
    validated.some(({ povCharacterId }) => povCharacterId === null)
  ) {
    authorityNeutralOmissions.push("pov");
  }
  if (
    scope.maximumStoryOrder !== undefined &&
    validated.some(
      ({ branchId, povCharacterId, storyOrder }) =>
        storyOrder === null && branchId === null && povCharacterId === null,
    )
  ) {
    authorityNeutralOmissions.push("story_order");
  }
  return Object.freeze({
    documentIds: Object.freeze(validated.map(({ documentId }) => documentId)),
    scopeTrace: Object.freeze({
      ...scope.trace,
      authorityNeutralOmissions: Object.freeze(authorityNeutralOmissions),
    }),
  });
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
       pinned,
       chunk_kind AS chunkKind,
       parent_document_id AS parentDocumentId,
       utf16_start AS utf16Start,
       utf16_end AS utf16End,
       source_length AS sourceLength,
       scene_id AS sceneId,
       event_id AS eventId,
       character_ids_json AS characterIdsJson,
       location_ids_json AS locationIdsJson,
       story_time AS storyTime,
       branch_id AS branchId,
       pov_character_id AS povCharacterId,
       story_order AS storyOrder,
       authority,
       privacy,
       currentness,
       omitted_scope_fields_json AS omittedScopeFieldsJson
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
       content_hash, source_updated_at, importance, pinned, indexed_at,
       chunk_kind, parent_document_id, utf16_start, utf16_end,
       source_length, scene_id, event_id, character_ids_json,
       location_ids_json, story_time,
       branch_id, pov_character_id, story_order, authority, privacy,
       currentness, omitted_scope_fields_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       indexed_at = excluded.indexed_at,
       chunk_kind = excluded.chunk_kind,
       parent_document_id = excluded.parent_document_id,
       utf16_start = excluded.utf16_start,
       utf16_end = excluded.utf16_end,
       source_length = excluded.source_length,
       scene_id = excluded.scene_id,
       event_id = excluded.event_id,
       character_ids_json = excluded.character_ids_json,
       location_ids_json = excluded.location_ids_json,
       story_time = excluded.story_time,
       branch_id = excluded.branch_id,
       pov_character_id = excluded.pov_character_id,
       story_order = excluded.story_order,
       authority = excluded.authority,
       privacy = excluded.privacy,
       currentness = excluded.currentness,
       omitted_scope_fields_json = excluded.omitted_scope_fields_json`,
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
      document.chunkKind ?? "chapter",
      document.parentDocumentId ?? null,
      document.utf16Start ?? 0,
      document.utf16End ?? 0,
      document.sourceLength ?? document.text.length,
      document.sceneId ?? null,
      document.eventId ?? null,
      JSON.stringify(document.characterIds ?? []),
      JSON.stringify(document.locationIds ?? []),
      document.storyTime ?? null,
      document.branchId ?? null,
      document.povCharacterId ?? null,
      document.storyOrder ?? null,
      document.authority ?? "rebuildable",
      document.privacy ?? "standard",
      document.currentness ?? "legacy_unknown",
      JSON.stringify(document.omittedScopeFields ?? []),
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
    chunkKind: row.chunkKind as SearchChunkKind,
    parentDocumentId: row.parentDocumentId,
    utf16Start: row.utf16Start,
    utf16End: row.utf16End,
    sourceLength: row.sourceLength,
    sceneId: row.sceneId,
    eventId: row.eventId,
    characterIds: parseIdentifierList(row.characterIdsJson, "characterIds"),
    locationIds: parseIdentifierList(row.locationIdsJson, "locationIds"),
    storyTime: row.storyTime,
    branchId: row.branchId,
    povCharacterId: row.povCharacterId,
    storyOrder: row.storyOrder,
    authority: row.authority as SearchDocumentAuthority,
    privacy: row.privacy as SearchDocumentPrivacyMode,
    currentness: row.currentness as SearchDocumentCurrentness,
    omittedScopeFields: parseOmittedScopeFields(row.omittedScopeFieldsJson),
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
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  for (const document of documents) {
    if (document.parentDocumentId === null || document.parentDocumentId === undefined) {
      continue;
    }
    const parent = documentsById.get(document.parentDocumentId);
    const supportedCrossSourceEvidenceParent =
      document.chunkKind === "story_fact_evidence" &&
      parent?.sourceType === "chapter" &&
      parent.chunkKind === "chapter";
    if (
      parent?.projectId !== document.projectId ||
      (!supportedCrossSourceEvidenceParent && parent.sourceId !== document.sourceId) ||
      parent.sourceVersionId !== document.sourceVersionId ||
      parent.utf16Start === undefined ||
      parent.utf16End === undefined ||
      parent.sourceLength === undefined ||
      document.utf16Start === undefined ||
      document.utf16End === undefined ||
      document.sourceLength === undefined ||
      parent.sourceLength !== document.sourceLength ||
      parent.utf16Start > document.utf16Start ||
      parent.utf16End < document.utf16End
    ) {
      throw corruptSnapshot("Persistent project search parent evidence is invalid.");
    }
  }
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
  const chunkKind = value.chunkKind ?? "chapter";
  const authority = value.authority ?? "rebuildable";
  const privacy = value.privacy ?? "standard";
  const currentness = value.currentness ?? "legacy_unknown";
  const utf16Start = value.utf16Start ?? 0;
  const utf16End = value.utf16End ?? 0;
  const sourceLength =
    value.sourceLength ?? (currentness === "legacy_unknown" ? value.text.length : Number.NaN);
  const parentDocumentId =
    value.parentDocumentId === undefined || value.parentDocumentId === null
      ? null
      : validateIdentifier(value.parentDocumentId, "document.parentDocumentId");
  const sceneId = validateNullableIdentifier(value.sceneId, "document.sceneId");
  const eventId = validateNullableIdentifier(value.eventId, "document.eventId");
  const characterIds = validateIdentifierList(value.characterIds ?? [], "document.characterIds");
  const locationIds = validateIdentifierList(value.locationIds ?? [], "document.locationIds");
  const storyTime = validateNullableBoundedText(value.storyTime, "document.storyTime", 500);
  const branchId = validateNullableIdentifier(value.branchId, "document.branchId");
  const povCharacterId = validateNullableIdentifier(
    value.povCharacterId,
    "document.povCharacterId",
  );
  const storyOrder = value.storyOrder ?? null;
  const omittedScopeFields = validateOmittedScopeFields(
    value.omittedScopeFields ?? [
      "current_version",
      "branch",
      "pov",
      "story_order",
      "scene",
      "event",
      "characters",
      "locations",
      "story_time",
    ],
  );
  if (
    !SEARCH_CHUNK_KINDS.includes(chunkKind) ||
    !SEARCH_DOCUMENT_AUTHORITIES.includes(authority) ||
    !SEARCH_DOCUMENT_PRIVACY_MODES.includes(privacy) ||
    !SEARCH_DOCUMENT_CURRENTNESS.includes(currentness) ||
    !Number.isSafeInteger(utf16Start) ||
    !Number.isSafeInteger(utf16End) ||
    !Number.isSafeInteger(sourceLength) ||
    utf16Start < 0 ||
    utf16End < utf16Start ||
    sourceLength < utf16End ||
    (currentness !== "legacy_unknown" && utf16End - utf16Start !== value.text.length) ||
    (storyOrder !== null && (!Number.isSafeInteger(storyOrder) || storyOrder < 0))
  ) {
    throw corruptSnapshot("Persistent project search retrieval evidence is invalid.");
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
    chunkKind,
    parentDocumentId,
    utf16Start,
    utf16End,
    sourceLength,
    sceneId,
    eventId,
    characterIds,
    locationIds,
    storyTime,
    branchId,
    povCharacterId,
    storyOrder,
    authority,
    privacy,
    currentness,
    omittedScopeFields,
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
    (left.pinned === true) === (right.pinned === true) &&
    left.chunkKind === right.chunkKind &&
    left.parentDocumentId === right.parentDocumentId &&
    left.utf16Start === right.utf16Start &&
    left.utf16End === right.utf16End &&
    left.sourceLength === right.sourceLength &&
    left.sceneId === right.sceneId &&
    left.eventId === right.eventId &&
    sameStringList(left.characterIds, right.characterIds) &&
    sameStringList(left.locationIds, right.locationIds) &&
    left.storyTime === right.storyTime &&
    left.branchId === right.branchId &&
    left.povCharacterId === right.povCharacterId &&
    left.storyOrder === right.storyOrder &&
    left.authority === right.authority &&
    left.privacy === right.privacy &&
    left.currentness === right.currentness &&
    sameStringList(left.omittedScopeFields, right.omittedScopeFields)
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

function validateNullableIdentifier(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : validateIdentifier(value, field);
}

function validateIdentifierList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) {
    throw corruptSnapshot(`${field} is not a bounded identifier list.`);
  }
  const identifiers = value.map((identifier) => validateIdentifier(identifier, field)).sort();
  if (new Set(identifiers).size !== identifiers.length) {
    throw corruptSnapshot(`${field} contains duplicate identifiers.`);
  }
  return Object.freeze(identifiers);
}

function parseIdentifierList(value: string, field: string): readonly string[] {
  try {
    return validateIdentifierList(JSON.parse(value) as unknown, `document.${field}`);
  } catch (cause: unknown) {
    if (cause instanceof ProjectSearchSnapshotStoreError) {
      throw cause;
    }
    throw corruptSnapshot(`Persistent project search ${field} cannot be decoded.`);
  }
}

function validateNullableBoundedText(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw corruptSnapshot(`${field} is not text.`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw corruptSnapshot(`${field} is not bounded safe text.`);
  }
  return normalized;
}

function validateScopeIdentifier(value: unknown, field: string): string {
  try {
    return validateIdentifier(value, field);
  } catch {
    throw invalidScope(`${field} is not a safe identifier.`);
  }
}

function validateNullableScopeIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : validateScopeIdentifier(value, field);
}

function validateOmittedScopeFields(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw corruptSnapshot("Persistent project search omission evidence is invalid.");
  }
  const fields = value.map((field) => validateIdentifier(field, "document.omittedScopeField"));
  if (new Set(fields).size !== fields.length) {
    throw corruptSnapshot("Persistent project search omission evidence is duplicated.");
  }
  return Object.freeze([...fields].sort());
}

function parseOmittedScopeFields(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((field) => typeof field !== "string")) {
      throw new Error("invalid omission evidence");
    }
    return validateOmittedScopeFields(parsed);
  } catch {
    throw corruptSnapshot("Persistent project search omission evidence cannot be decoded.");
  }
}

function sameStringList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftValues = left ?? [];
  const rightValues = right ?? [];
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
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
  const trigrams = new Set<string>();
  for (const term of normalized.split(" ")) {
    for (let index = 0; index <= term.length - 3; index += 1) {
      trigrams.add(term.slice(index, index + 3));
    }
  }
  if (trigrams.size === 0) {
    return null;
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

function invalidScope(message: string): ProjectSearchSnapshotStoreError {
  return new ProjectSearchSnapshotStoreError("SEARCH_SCOPE_INVALID", message, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
