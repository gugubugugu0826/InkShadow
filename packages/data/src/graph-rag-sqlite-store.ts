import {
  GraphRagIndexingService,
  QueryGraphRagContext,
  type DeleteGraphEntityCommand,
  type DeleteGraphRelationCommand,
  type GraphRagMutationReceipt,
  type GraphRagProjectionRepository,
  type GraphRagProjectionStatus,
  type InvalidateGraphSourceVersionCommand,
  type PersistedGraphRagProject,
  type ReplaceGraphRagProjectCommand,
  type UpsertGraphEntityCommand,
  type UpsertGraphRelationCommand,
  type UpsertGraphSourceVersionCommand,
} from "@inkshadow/application";
import { AppError, err, ok, type Result } from "@inkshadow/domain";
import {
  InMemoryGraphRagIndex,
  SearchIndexError,
  type GraphEntity,
  type GraphRagProjectSnapshot,
  type GraphRelation,
  type GraphRelationEvidence,
  type GraphSourceVersion,
  type GraphStoredSourceVersion,
} from "@inkshadow/search-core";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

interface ProjectionStateRow {
  readonly project_id: string;
  readonly schema_version: number;
  readonly revision: number;
  readonly status: string;
  readonly source_version_count: number;
  readonly entity_count: number;
  readonly relation_count: number;
  readonly evidence_count: number;
  readonly last_rebuilt_at: string | null;
  readonly updated_at: string;
}

interface SourceVersionRow {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_version_id: string;
  readonly content_hash: string;
  readonly content: string;
  readonly state: string;
  readonly created_at: string;
  readonly invalidated_at: string | null;
}

interface EntityRow {
  readonly project_id: string;
  readonly entity_id: string;
  readonly kind: string;
  readonly label: string;
  readonly source_id: string;
  readonly source_version_id: string;
  readonly source_content_hash: string;
  readonly document_id: string | null;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

interface RelationRow {
  readonly project_id: string;
  readonly relation_id: string;
  readonly from_entity_id: string;
  readonly to_entity_id: string;
  readonly kind: string;
  readonly polarity: string;
  readonly confidence: number;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

interface RelationIdentityRow {
  readonly relation_id: string;
  readonly from_entity_id: string;
  readonly to_entity_id: string;
  readonly kind: string;
  readonly polarity: string;
}

interface EvidenceRow {
  readonly project_id: string;
  readonly evidence_id: string;
  readonly relation_id: string;
  readonly ordinal: number;
  readonly source_id: string;
  readonly source_version_id: string;
  readonly source_content_hash: string;
  readonly span_start_offset: number;
  readonly span_end_offset: number;
  readonly span_encoding: string;
  readonly quote: string;
  readonly span_hash: string;
  readonly citation_label: string;
  readonly citation_locator: string;
}

interface ProjectionCounts {
  readonly sourceVersions: number;
  readonly entities: number;
  readonly relations: number;
  readonly evidence: number;
}

interface MutationContext {
  readonly state: ProjectionStateRow | null;
  readonly previousRevision: number;
  readonly revision: number;
  readonly snapshot: GraphRagProjectSnapshot;
}

type ProjectionMutation = (index: InMemoryGraphRagIndex, projectId: string) => void;

type ProjectionWriter = (
  transaction: TransactionExecutor,
  before: GraphRagProjectSnapshot,
  after: GraphRagProjectSnapshot,
) => Promise<void>;

const PROJECTION_STATE_COLUMNS = `
  project_id,
  schema_version,
  revision,
  status,
  source_version_count,
  entity_count,
  relation_count,
  evidence_count,
  last_rebuilt_at,
  updated_at
`;
const MAX_STABLE_GRAPH_READ_ATTEMPTS = 3;

/**
 * SQLite implementation of the GraphRAG projection port.
 *
 * Formal prose is intentionally absent from this API. Source text is copied
 * into a rebuildable local projection solely so every evidence citation can
 * be rechecked against its authoritative hash and exact UTF-16 span.
 */
export class GraphRagSqliteRepository implements GraphRagProjectionRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadProject(
    projectIdValue: string,
  ): Promise<Result<PersistedGraphRagProject | null, AppError>> {
    const projectId = normalizeIdentifier(projectIdValue, "projectId");
    if (!projectId.ok) {
      return projectId;
    }
    try {
      const projection = await readStableProject(this.executor, projectId.value);
      return ok(projection);
    } catch (cause: unknown) {
      return err(normalizeReadError(cause, projectId.value));
    }
  }

  public upsertSourceVersion(
    command: UpsertGraphSourceVersionCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.incrementalMutation(
      command.source.projectId,
      command.expectedRevision,
      command.mutatedAt,
      (index) => {
        index.upsertSourceVersion(command.source);
      },
      async (transaction, before, after) => {
        const sourceId = command.source.sourceId.trim();
        const beforeById = new Map(
          before.sourceVersions
            .filter(({ source }) => source.sourceId === sourceId)
            .map((stored) => [stored.source.sourceVersionId, stored]),
        );
        for (const stored of after.sourceVersions.filter(
          ({ source }) => source.sourceId === sourceId,
        )) {
          const previous = beforeById.get(stored.source.sourceVersionId);
          if (previous === undefined) {
            await insertSourceVersion(transaction, stored);
          } else if (
            previous.state !== stored.state ||
            previous.invalidatedAt !== stored.invalidatedAt
          ) {
            await updateSourceState(transaction, stored);
          }
        }
      },
    );
  }

  public invalidateSourceVersion(
    command: InvalidateGraphSourceVersionCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.incrementalMutation(
      command.projectId,
      command.expectedRevision,
      command.mutatedAt,
      (index, projectId) => {
        index.invalidateSourceVersion(
          projectId,
          command.sourceId,
          command.sourceVersionId,
          command.state,
          command.mutatedAt,
        );
      },
      async (transaction, _before, after) => {
        const stored = after.sourceVersions.find(
          ({ source }) =>
            source.sourceId === command.sourceId.trim() &&
            source.sourceVersionId === command.sourceVersionId.trim(),
        );
        if (stored === undefined) {
          throw corruptProjection(command.projectId, "GRAPH_SOURCE_DISAPPEARED");
        }
        await updateSourceState(transaction, stored);
      },
    );
  }

  public upsertEntity(
    command: UpsertGraphEntityCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.incrementalMutation(
      command.entity.projectId,
      command.expectedRevision,
      command.mutatedAt,
      (index) => {
        index.upsertEntity(command.entity);
      },
      async (transaction, _before, after) => {
        const entity = after.entities.find(({ id }) => id === command.entity.id.trim());
        if (entity === undefined) {
          throw corruptProjection(command.entity.projectId, "GRAPH_ENTITY_DISAPPEARED");
        }
        await upsertEntity(transaction, entity);
      },
    );
  }

  public softDeleteEntity(
    command: DeleteGraphEntityCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.incrementalMutation(
      command.projectId,
      command.expectedRevision,
      command.mutatedAt,
      (index, projectId) => {
        index.softDeleteEntity(projectId, command.entityId, command.mutatedAt);
      },
      async (transaction, _before, after) => {
        const entity = after.entities.find(({ id }) => id === command.entityId.trim());
        if (entity !== undefined) {
          await upsertEntity(transaction, entity);
        }
      },
    );
  }

  public upsertRelation(
    command: UpsertGraphRelationCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.incrementalMutation(
      command.relation.projectId,
      command.expectedRevision,
      command.mutatedAt,
      (index) => {
        index.upsertRelation(command.relation);
      },
      async (transaction, before, after) => {
        const relationId = command.relation.id.trim();
        if (before.relations.some(({ id }) => id === relationId)) {
          return;
        }
        const relation = after.relations.find(({ id }) => id === relationId);
        if (relation === undefined) {
          throw corruptProjection(command.relation.projectId, "GRAPH_RELATION_DISAPPEARED");
        }
        await insertRelation(transaction, relation);
      },
    );
  }

  public softDeleteRelation(
    command: DeleteGraphRelationCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.incrementalMutation(
      command.projectId,
      command.expectedRevision,
      command.mutatedAt,
      (index, projectId) => {
        index.softDeleteRelation(projectId, command.relationId, command.mutatedAt);
      },
      async (transaction, _before, after) => {
        const relation = after.relations.find(({ id }) => id === command.relationId.trim());
        if (relation !== undefined) {
          const updated = await transaction.execute(
            `UPDATE graph_rag_relations
             SET deleted_at = ?
             WHERE project_id = ? AND relation_id = ?`,
            [relation.deletedAt ?? null, relation.projectId, relation.id],
          );
          if (updated.rowsAffected !== 1) {
            throw corruptProjection(command.projectId, "GRAPH_RELATION_DISAPPEARED");
          }
        }
      },
    );
  }

  public async replaceProject(
    command: ReplaceGraphRagProjectCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    const mutatedAt = normalizeTimestamp(command.mutatedAt, "mutatedAt");
    const expectedRevision = normalizeExpectedRevision(command.expectedRevision);
    if (!mutatedAt.ok) {
      return mutatedAt;
    }
    if (!expectedRevision.ok) {
      return expectedRevision;
    }

    const index = new InMemoryGraphRagIndex();
    try {
      index.restoreProject(command.snapshot);
    } catch (cause: unknown) {
      return err(normalizeGraphInputError(cause));
    }
    const canonical = index.snapshotProject(command.snapshot.projectId);
    if (canonical === undefined) {
      return err(validationError("The graph project snapshot is invalid."));
    }

    try {
      const receipt = await this.executor.transaction(async (transaction) => {
        const context = await prepareMutation(
          transaction,
          canonical.projectId,
          expectedRevision.value,
          mutatedAt.value,
          true,
        );
        await ensureProjectionState(transaction, canonical.projectId, context, mutatedAt.value);
        await transaction.execute("DELETE FROM graph_rag_source_versions WHERE project_id = ?", [
          canonical.projectId,
        ]);
        await writeProjectSnapshot(transaction, canonical);
        await finalizeProjectionState(
          transaction,
          canonical.projectId,
          context,
          mutatedAt.value,
          mutatedAt.value,
        );
        return mutationReceipt(canonical.projectId, context, mutatedAt.value);
      });
      return ok(receipt);
    } catch (cause: unknown) {
      return err(normalizeMutationError(cause, canonical.projectId));
    }
  }

  private async incrementalMutation(
    projectIdValue: string,
    expectedRevisionValue: number,
    mutatedAtValue: string,
    mutate: ProjectionMutation,
    write: ProjectionWriter,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    const projectId = normalizeIdentifier(projectIdValue, "projectId");
    const expectedRevision = normalizeExpectedRevision(expectedRevisionValue);
    const mutatedAt = normalizeTimestamp(mutatedAtValue, "mutatedAt");
    if (!projectId.ok) {
      return projectId;
    }
    if (!expectedRevision.ok) {
      return expectedRevision;
    }
    if (!mutatedAt.ok) {
      return mutatedAt;
    }

    try {
      const receipt = await this.executor.transaction(async (transaction) => {
        const context = await prepareMutation(
          transaction,
          projectId.value,
          expectedRevision.value,
          mutatedAt.value,
          false,
        );
        const index = new InMemoryGraphRagIndex();
        index.restoreProject(context.snapshot);
        try {
          mutate(index, projectId.value);
        } catch (cause: unknown) {
          throw normalizeGraphInputError(cause);
        }
        const after = index.snapshotProject(projectId.value);
        if (after === undefined) {
          throw corruptProjection(projectId.value, "GRAPH_PROJECT_DISAPPEARED");
        }

        await ensureProjectionState(transaction, projectId.value, context, mutatedAt.value);
        await write(transaction, context.snapshot, after);
        await finalizeProjectionState(
          transaction,
          projectId.value,
          context,
          mutatedAt.value,
          context.state?.last_rebuilt_at ?? null,
        );
        return mutationReceipt(projectId.value, context, mutatedAt.value);
      });
      return ok(receipt);
    } catch (cause: unknown) {
      return err(normalizeMutationError(cause, projectId.value));
    }
  }
}

export interface GraphRagSqliteSlice {
  readonly repository: GraphRagSqliteRepository;
  readonly indexing: GraphRagIndexingService;
  readonly querying: QueryGraphRagContext;
}

export function createGraphRagSqliteSlice(executor: SqlExecutor): GraphRagSqliteSlice {
  const repository = new GraphRagSqliteRepository(executor);
  return {
    repository,
    indexing: new GraphRagIndexingService(repository),
    querying: new QueryGraphRagContext(repository),
  };
}

async function prepareMutation(
  transaction: TransactionExecutor,
  projectId: string,
  expectedRevision: number,
  mutatedAt: string,
  allowRecovery: boolean,
): Promise<MutationContext> {
  await requireProject(transaction, projectId);
  const state = await readProjectionState(transaction, projectId);
  const previousRevision = state?.revision ?? 0;
  if (previousRevision !== expectedRevision) {
    throw revisionConflict(projectId, expectedRevision, previousRevision);
  }
  if (state !== null && mutatedAt < state.updated_at) {
    throw revisionConflict(projectId, expectedRevision, previousRevision);
  }
  if (!allowRecovery && state !== null && state.status !== "ready") {
    throw new AppError({
      code: "INVALID_STATE_TRANSITION",
      message: "The graph projection is not accepting incremental mutations.",
      actions: ["RETRY"],
      details: { projectId, status: state.status },
    });
  }

  const snapshot =
    state === null || allowRecovery
      ? emptyProjectSnapshot(projectId)
      : await readValidatedProjectSnapshot(transaction, state);
  return {
    state,
    previousRevision,
    revision: previousRevision + 1,
    snapshot,
  };
}

async function ensureProjectionState(
  transaction: TransactionExecutor,
  projectId: string,
  context: MutationContext,
  mutatedAt: string,
): Promise<void> {
  if (context.state !== null) {
    return;
  }
  await transaction.execute(
    `INSERT INTO graph_rag_projection_state (
       project_id, schema_version, revision, status,
       source_version_count, entity_count, relation_count, evidence_count,
       last_rebuilt_at, updated_at
     ) VALUES (?, 1, 1, 'ready', 0, 0, 0, 0, NULL, ?)`,
    [projectId, mutatedAt],
  );
}

async function finalizeProjectionState(
  transaction: TransactionExecutor,
  projectId: string,
  context: MutationContext,
  mutatedAt: string,
  lastRebuiltAt: string | null,
): Promise<void> {
  const counts = await readProjectionCounts(transaction, projectId);
  const updated = await transaction.execute(
    `UPDATE graph_rag_projection_state
     SET revision = ?, status = 'ready',
         source_version_count = ?, entity_count = ?,
         relation_count = ?, evidence_count = ?,
         last_rebuilt_at = ?, updated_at = ?
     WHERE project_id = ? AND revision = ?`,
    [
      context.revision,
      counts.sourceVersions,
      counts.entities,
      counts.relations,
      counts.evidence,
      lastRebuiltAt,
      mutatedAt,
      projectId,
      context.state?.revision ?? 1,
    ],
  );
  if (updated.rowsAffected !== 1) {
    throw revisionConflict(projectId, context.previousRevision, context.previousRevision);
  }
}

async function readStableProject(
  executor: SqlExecutor,
  projectId: string,
): Promise<PersistedGraphRagProject | null> {
  for (let attempt = 1; attempt <= MAX_STABLE_GRAPH_READ_ATTEMPTS; attempt += 1) {
    const before = await readProjectionState(executor, projectId);
    if (before === null) {
      const after = await readProjectionState(executor, projectId);
      if (after === null) {
        return null;
      }
      continue;
    }

    const snapshot = await readProjectSnapshot(executor, projectId);
    const counts = await readProjectionCounts(executor, projectId);
    const after = await readProjectionState(executor, projectId);
    if (!projectionStatesEqual(before, after)) {
      continue;
    }
    return persistedProject(before, validateProjectionSnapshot(before, snapshot, counts));
  }
  throw unstableProjection(projectId);
}

function persistedProject(
  state: ProjectionStateRow,
  snapshot: GraphRagProjectSnapshot,
): PersistedGraphRagProject {
  return {
    ...snapshot,
    revision: state.revision,
    status: parseProjectionStatus(state.status, state.project_id),
    updatedAt: requireStoredTimestamp(state.updated_at, state.project_id),
    ...(state.last_rebuilt_at === null
      ? {}
      : { lastRebuiltAt: requireStoredTimestamp(state.last_rebuilt_at, state.project_id) }),
  };
}

async function readValidatedProjectSnapshot(
  transaction: TransactionExecutor,
  state: ProjectionStateRow,
): Promise<GraphRagProjectSnapshot> {
  const snapshot = await readProjectSnapshot(transaction, state.project_id);
  const counts = await readProjectionCounts(transaction, state.project_id);
  return validateProjectionSnapshot(state, snapshot, counts);
}

function validateProjectionSnapshot(
  state: ProjectionStateRow,
  snapshot: GraphRagProjectSnapshot,
  counts: ProjectionCounts,
): GraphRagProjectSnapshot {
  if (state.schema_version !== 1 || state.revision < 1) {
    throw corruptProjection(state.project_id, "GRAPH_STATE_INVALID");
  }
  if (
    counts.sourceVersions !== state.source_version_count ||
    counts.entities !== state.entity_count ||
    counts.relations !== state.relation_count ||
    counts.evidence !== state.evidence_count
  ) {
    throw corruptProjection(state.project_id, "GRAPH_COUNT_MISMATCH");
  }
  const index = new InMemoryGraphRagIndex();
  try {
    index.restoreProject(snapshot);
  } catch {
    throw corruptProjection(state.project_id, "GRAPH_RECORD_VALIDATION_FAILED");
  }
  return index.snapshotProject(state.project_id) ?? emptyProjectSnapshot(state.project_id);
}

function projectionStatesEqual(
  left: ProjectionStateRow,
  right: ProjectionStateRow | null,
): boolean {
  return (
    right !== null &&
    left.project_id === right.project_id &&
    left.schema_version === right.schema_version &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.source_version_count === right.source_version_count &&
    left.entity_count === right.entity_count &&
    left.relation_count === right.relation_count &&
    left.evidence_count === right.evidence_count &&
    left.last_rebuilt_at === right.last_rebuilt_at &&
    left.updated_at === right.updated_at
  );
}

async function readProjectSnapshot(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<GraphRagProjectSnapshot> {
  const sourceRows = await transaction.select<SourceVersionRow>(
    `SELECT project_id, source_id, source_version_id, content_hash, content,
            state, created_at, invalidated_at
     FROM graph_rag_source_versions
     WHERE project_id = ?
     ORDER BY source_id, created_at, source_version_id`,
    [projectId],
  );
  const entityRows = await transaction.select<EntityRow>(
    `SELECT project_id, entity_id, kind, label, source_id, source_version_id,
            source_content_hash, document_id, updated_at, deleted_at
     FROM graph_rag_entities
     WHERE project_id = ?
     ORDER BY entity_id`,
    [projectId],
  );
  const relationRows = await transaction.select<RelationRow>(
    `SELECT project_id, relation_id, from_entity_id, to_entity_id, kind,
            polarity, confidence, updated_at, deleted_at
     FROM graph_rag_relations
     WHERE project_id = ?
     ORDER BY relation_id`,
    [projectId],
  );
  const evidenceRows = await transaction.select<EvidenceRow>(
    `SELECT project_id, evidence_id, relation_id, ordinal, source_id,
            source_version_id, source_content_hash, span_start_offset,
            span_end_offset, span_encoding, quote, span_hash,
            citation_label, citation_locator
     FROM graph_rag_relation_evidence
     WHERE project_id = ?
     ORDER BY relation_id, ordinal, evidence_id`,
    [projectId],
  );
  const evidenceByRelation = new Map<string, GraphRelationEvidence[]>();
  for (const row of evidenceRows) {
    const evidence = hydrateEvidence(row);
    const related = evidenceByRelation.get(row.relation_id) ?? [];
    related.push(evidence);
    evidenceByRelation.set(row.relation_id, related);
  }
  return {
    projectId,
    sourceVersions: sourceRows.map(hydrateSourceVersion),
    entities: entityRows.map(hydrateEntity),
    relations: relationRows.map((row) =>
      hydrateRelation(row, evidenceByRelation.get(row.relation_id) ?? []),
    ),
  };
}

async function writeProjectSnapshot(
  transaction: TransactionExecutor,
  snapshot: GraphRagProjectSnapshot,
): Promise<void> {
  for (const source of snapshot.sourceVersions) {
    await insertSourceVersion(transaction, source);
  }
  for (const entity of snapshot.entities) {
    await insertEntity(transaction, entity);
  }
  for (const relation of snapshot.relations) {
    await insertRelation(transaction, relation);
  }
}

async function insertSourceVersion(
  transaction: TransactionExecutor,
  stored: GraphStoredSourceVersion,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO graph_rag_source_versions (
       project_id, source_id, source_version_id, content_hash, content,
       state, created_at, invalidated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stored.source.projectId,
      stored.source.sourceId,
      stored.source.sourceVersionId,
      stored.source.contentHash,
      stored.source.content,
      stored.state,
      stored.source.createdAt,
      stored.invalidatedAt ?? null,
    ],
  );
}

async function updateSourceState(
  transaction: TransactionExecutor,
  stored: GraphStoredSourceVersion,
): Promise<void> {
  const updated = await transaction.execute(
    `UPDATE graph_rag_source_versions
     SET state = ?, invalidated_at = ?
     WHERE project_id = ? AND source_id = ? AND source_version_id = ?`,
    [
      stored.state,
      stored.invalidatedAt ?? null,
      stored.source.projectId,
      stored.source.sourceId,
      stored.source.sourceVersionId,
    ],
  );
  if (updated.rowsAffected !== 1) {
    throw corruptProjection(stored.source.projectId, "GRAPH_SOURCE_DISAPPEARED");
  }
}

async function insertEntity(transaction: TransactionExecutor, entity: GraphEntity): Promise<void> {
  await transaction.execute(
    `INSERT INTO graph_rag_entities (
       project_id, entity_id, kind, label, source_id, source_version_id,
       source_content_hash, document_id, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entity.projectId,
      entity.id,
      entity.kind,
      entity.label,
      entity.source.sourceId,
      entity.source.sourceVersionId,
      entity.source.contentHash,
      entity.documentId ?? null,
      entity.updatedAt,
      entity.deletedAt ?? null,
    ],
  );
}

async function upsertEntity(transaction: TransactionExecutor, entity: GraphEntity): Promise<void> {
  await transaction.execute(
    `INSERT INTO graph_rag_entities (
       project_id, entity_id, kind, label, source_id, source_version_id,
       source_content_hash, document_id, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, entity_id) DO UPDATE SET
       kind = excluded.kind,
       label = excluded.label,
       source_id = excluded.source_id,
       source_version_id = excluded.source_version_id,
       source_content_hash = excluded.source_content_hash,
       document_id = excluded.document_id,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
    [
      entity.projectId,
      entity.id,
      entity.kind,
      entity.label,
      entity.source.sourceId,
      entity.source.sourceVersionId,
      entity.source.contentHash,
      entity.documentId ?? null,
      entity.updatedAt,
      entity.deletedAt ?? null,
    ],
  );
}

async function insertRelation(
  transaction: TransactionExecutor,
  relation: GraphRelation,
): Promise<void> {
  await ensureRelationIdentity(transaction, relation);
  await transaction.execute(
    `INSERT INTO graph_rag_relations (
       project_id, relation_id, from_entity_id, to_entity_id, kind,
       polarity, confidence, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      relation.projectId,
      relation.id,
      relation.fromEntityId,
      relation.toEntityId,
      relation.kind,
      relation.polarity,
      relation.confidence,
      relation.updatedAt,
      relation.deletedAt ?? null,
    ],
  );
  for (const [ordinal, evidence] of relation.evidence.entries()) {
    await insertEvidence(transaction, relation.id, ordinal, evidence);
  }
}

async function ensureRelationIdentity(
  transaction: TransactionExecutor,
  relation: GraphRelation,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO graph_rag_relation_identities (
       project_id, relation_id, from_entity_id, to_entity_id,
       kind, polarity, first_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, relation_id) DO NOTHING`,
    [
      relation.projectId,
      relation.id,
      relation.fromEntityId,
      relation.toEntityId,
      relation.kind,
      relation.polarity,
      relation.updatedAt,
    ],
  );
  const rows = await transaction.select<RelationIdentityRow>(
    `SELECT relation_id, from_entity_id, to_entity_id, kind, polarity
     FROM graph_rag_relation_identities
     WHERE project_id = ? AND relation_id = ?`,
    [relation.projectId, relation.id],
  );
  const identity = rows[0];
  if (
    identity?.from_entity_id !== relation.fromEntityId ||
    identity.to_entity_id !== relation.toEntityId ||
    identity.kind !== relation.kind ||
    identity.polarity !== relation.polarity ||
    rows.length !== 1
  ) {
    throw new AppError({
      code: "VERSION_CONFLICT",
      message: "A graph relation identifier cannot be rebound.",
      actions: ["RETRY"],
      details: {
        projectId: relation.projectId,
        relationId: relation.id,
      },
    });
  }
}

async function insertEvidence(
  transaction: TransactionExecutor,
  relationId: string,
  ordinal: number,
  evidence: GraphRelationEvidence,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO graph_rag_relation_evidence (
       project_id, evidence_id, relation_id, ordinal,
       source_id, source_version_id, source_content_hash,
       span_start_offset, span_end_offset, span_encoding,
       quote, span_hash, citation_label, citation_locator
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'utf16', ?, ?, ?, ?)`,
    [
      evidence.projectId,
      evidence.id,
      relationId,
      ordinal,
      evidence.sourceId,
      evidence.sourceVersionId,
      evidence.contentHash,
      evidence.span.startOffset,
      evidence.span.endOffset,
      evidence.quote,
      evidence.spanHash,
      evidence.citation.label,
      evidence.citation.locator,
    ],
  );
}

async function readProjectionState(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<ProjectionStateRow | null> {
  const rows = await transaction.select<ProjectionStateRow>(
    `SELECT ${PROJECTION_STATE_COLUMNS}
     FROM graph_rag_projection_state
     WHERE project_id = ?`,
    [projectId],
  );
  if (rows.length > 1) {
    throw corruptProjection(projectId, "GRAPH_STATE_DUPLICATE");
  }
  return rows[0] ?? null;
}

async function readProjectionCounts(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<ProjectionCounts> {
  const rows = await transaction.select<{
    source_versions: number;
    entities: number;
    relations: number;
    evidence: number;
  }>(
    `SELECT
       (SELECT count(*) FROM graph_rag_source_versions WHERE project_id = ?) AS source_versions,
       (SELECT count(*) FROM graph_rag_entities WHERE project_id = ?) AS entities,
       (SELECT count(*) FROM graph_rag_relations WHERE project_id = ?) AS relations,
       (SELECT count(*) FROM graph_rag_relation_evidence WHERE project_id = ?) AS evidence`,
    [projectId, projectId, projectId, projectId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw corruptProjection(projectId, "GRAPH_COUNTS_UNAVAILABLE");
  }
  return {
    sourceVersions: row.source_versions,
    entities: row.entities,
    relations: row.relations,
    evidence: row.evidence,
  };
}

async function requireProject(transaction: TransactionExecutor, projectId: string): Promise<void> {
  const rows = await transaction.select<{ found: number }>(
    "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?) AS found",
    [projectId],
  );
  if (rows[0]?.found !== 1) {
    throw new AppError({
      code: "PROJECT_NOT_FOUND",
      message: "The project does not exist.",
      details: { projectId },
    });
  }
}

function hydrateSourceVersion(row: SourceVersionRow): GraphStoredSourceVersion {
  const source: GraphSourceVersion = {
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    contentHash: row.content_hash,
    content: row.content,
    createdAt: row.created_at,
  };
  if (row.state === "current") {
    return { source, state: "current" };
  }
  if (row.state !== "superseded" && row.state !== "deleted") {
    throw corruptProjection(row.project_id, "GRAPH_SOURCE_STATE_INVALID");
  }
  if (row.invalidated_at === null) {
    throw corruptProjection(row.project_id, "GRAPH_SOURCE_INVALIDATION_MISSING");
  }
  return {
    source,
    state: row.state,
    invalidatedAt: row.invalidated_at,
  };
}

function hydrateEntity(row: EntityRow): GraphEntity {
  return {
    id: row.entity_id,
    projectId: row.project_id,
    kind: row.kind,
    label: row.label,
    source: {
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      contentHash: row.source_content_hash,
    },
    ...(row.document_id === null ? {} : { documentId: row.document_id }),
    updatedAt: row.updated_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}

function hydrateRelation(
  row: RelationRow,
  evidence: readonly GraphRelationEvidence[],
): GraphRelation {
  if (row.polarity !== "affirmed" && row.polarity !== "negated") {
    throw corruptProjection(row.project_id, "GRAPH_RELATION_POLARITY_INVALID");
  }
  return {
    id: row.relation_id,
    projectId: row.project_id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    kind: row.kind,
    polarity: row.polarity,
    confidence: row.confidence,
    evidence,
    updatedAt: row.updated_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}

function hydrateEvidence(row: EvidenceRow): GraphRelationEvidence {
  if (row.span_encoding !== "utf16") {
    throw corruptProjection(row.project_id, "GRAPH_EVIDENCE_ENCODING_INVALID");
  }
  return {
    id: row.evidence_id,
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    contentHash: row.source_content_hash,
    span: {
      startOffset: row.span_start_offset,
      endOffset: row.span_end_offset,
      encoding: "utf16",
    },
    quote: row.quote,
    spanHash: row.span_hash,
    citation: {
      label: row.citation_label,
      locator: row.citation_locator,
    },
  };
}

function emptyProjectSnapshot(projectId: string): GraphRagProjectSnapshot {
  return {
    projectId,
    sourceVersions: [],
    entities: [],
    relations: [],
  };
}

function mutationReceipt(
  projectId: string,
  context: MutationContext,
  updatedAt: string,
): GraphRagMutationReceipt {
  return {
    projectId,
    previousRevision: context.previousRevision,
    revision: context.revision,
    updatedAt,
  };
}

function parseProjectionStatus(value: string, projectId: string): GraphRagProjectionStatus {
  if (value !== "ready" && value !== "paused" && value !== "corrupt") {
    throw corruptProjection(projectId, "GRAPH_STATE_STATUS_INVALID");
  }
  return value;
}

function requireStoredTimestamp(value: string, projectId: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw corruptProjection(projectId, "GRAPH_TIMESTAMP_INVALID");
  }
  return value;
}

function normalizeIdentifier(value: string, field: string): Result<string, AppError> {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return err(validationError(`${field} is invalid.`));
  }
  return ok(normalized);
}

function normalizeExpectedRevision(value: number): Result<number, AppError> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return err(validationError("expectedRevision must be a non-negative safe integer."));
  }
  return ok(value);
}

function normalizeTimestamp(value: string, field: string): Result<string, AppError> {
  if (!isCanonicalTimestamp(value)) {
    return err(validationError(`${field} must be a canonical ISO timestamp.`));
  }
  return ok(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeGraphInputError(cause: unknown): AppError {
  if (!(cause instanceof SearchIndexError)) {
    return validationError("The graph projection input is invalid.");
  }
  if (cause.code === "GRAPH_VERSION_CONFLICT") {
    return new AppError({
      code: "VERSION_CONFLICT",
      message: cause.message,
      actions: ["RETRY"],
      details: { graphErrorCode: cause.code },
    });
  }
  return new AppError({
    code: "VALIDATION_FAILED",
    message: cause.message,
    details: { graphErrorCode: cause.code },
  });
}

function normalizeReadError(cause: unknown, projectId: string): AppError {
  return cause instanceof AppError ? cause : corruptProjection(projectId, "GRAPH_READ_FAILED");
}

function normalizeMutationError(cause: unknown, projectId: string): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The local graph projection mutation could not be committed.",
    retryable: true,
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: {
      operation: "GRAPH_RAG_MUTATION_FAILED",
      projectId,
      cause: cause instanceof Error ? cause.name : "UnknownDatabaseError",
    },
  });
}

function validationError(message: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message,
  });
}

function revisionConflict(
  projectId: string,
  expectedRevision: number,
  actualRevision: number,
): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: "The graph projection changed before this operation completed.",
    actions: ["RETRY"],
    details: { projectId, expectedRevision, actualRevision },
  });
}

function unstableProjection(projectId: string): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: "The graph projection changed repeatedly while it was being read.",
    retryable: true,
    actions: ["RETRY"],
    details: {
      operation: "GRAPH_RAG_STABLE_READ",
      projectId,
      attempts: MAX_STABLE_GRAPH_READ_ATTEMPTS,
    },
  });
}

function corruptProjection(projectId: string, operation: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "Stored graph projection data did not pass integrity validation.",
    actions: ["CONTACT_SUPPORT"],
    details: { projectId, operation },
  });
}
