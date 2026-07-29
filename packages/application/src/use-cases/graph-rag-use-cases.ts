import { AppError, err, ok, type Result } from "@inkshadow/domain";
import {
  InMemoryGraphRagIndex,
  SearchIndexError,
  type GraphRagQuery,
  type GraphRagResponse,
  type GraphSourceReference,
} from "@inkshadow/search-core";

import type {
  DeleteGraphEntityCommand,
  DeleteGraphRelationCommand,
  GraphRagMutationReceipt,
  GraphRagProjectionRepository,
  InvalidateGraphSourceVersionCommand,
  ReplaceGraphRagProjectCommand,
  PersistedGraphRagProject,
  UpsertGraphEntityCommand,
  UpsertGraphRelationCommand,
  UpsertGraphSourceVersionCommand,
} from "../ports/graph-rag-repository.js";

export interface AuditableGraphContextCandidate {
  readonly kind: "graph_context_candidate";
  readonly publicationBoundary: "candidate_only";
  readonly formalContentWriteAllowed: false;
  readonly requiresExplicitAcceptance: true;
  readonly projectId: string;
  readonly projectionRevision: number;
  readonly query: GraphRagQuery;
  readonly sourceReferences: readonly GraphSourceReference[];
  readonly result: GraphRagResponse;
}

/**
 * Application boundary for derived graph writes. It has no formal-content
 * repository dependency, so indexing can never mutate chapters or accepted
 * story records.
 */
export class GraphRagIndexingService {
  public constructor(private readonly repository: GraphRagProjectionRepository) {}

  public upsertSourceVersion(
    command: UpsertGraphSourceVersionCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.upsertSourceVersion(command);
  }

  public invalidateSourceVersion(
    command: InvalidateGraphSourceVersionCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.invalidateSourceVersion(command);
  }

  public upsertEntity(
    command: UpsertGraphEntityCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.upsertEntity(command);
  }

  public softDeleteEntity(
    command: DeleteGraphEntityCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.softDeleteEntity(command);
  }

  public upsertRelation(
    command: UpsertGraphRelationCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.upsertRelation(command);
  }

  public softDeleteRelation(
    command: DeleteGraphRelationCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.softDeleteRelation(command);
  }

  public replaceProject(
    command: ReplaceGraphRagProjectCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    return this.repository.replaceProject(command);
  }
}

export class QueryGraphRagContext {
  public constructor(private readonly repository: GraphRagProjectionRepository) {}

  public async execute(
    query: GraphRagQuery,
  ): Promise<Result<AuditableGraphContextCandidate, AppError>> {
    const loaded = await this.repository.loadProject(query.projectId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "The requested project has no graph projection.",
          details: { projectId: query.projectId },
        }),
      );
    }
    return this.executeLoaded(loaded.value, query);
  }

  /**
   * Queries a projection already loaded and integrity-checked by a repository.
   * Atomic runtime adapters use this path so freshness metadata and graph rows
   * are read from one snapshot without a second repository scan.
   */
  public executeLoaded(
    loaded: PersistedGraphRagProject,
    query: GraphRagQuery,
  ): Result<AuditableGraphContextCandidate, AppError> {
    if (loaded.status === "paused") {
      return err(
        new AppError({
          code: "INVALID_STATE_TRANSITION",
          message: "The graph projection is paused and cannot serve context.",
          retryable: true,
          actions: ["RETRY"],
          details: { projectId: query.projectId },
        }),
      );
    }
    if (loaded.status === "corrupt") {
      return err(corruptProjectionError(query.projectId));
    }
    if (loaded.projectId !== query.projectId.trim()) {
      return err(corruptProjectionError(query.projectId));
    }

    const index = new InMemoryGraphRagIndex();
    try {
      index.restoreProject(loaded);
    } catch {
      return err(corruptProjectionError(query.projectId));
    }

    try {
      const result = index.query(query);
      return ok({
        kind: "graph_context_candidate",
        publicationBoundary: "candidate_only",
        formalContentWriteAllowed: false,
        requiresExplicitAcceptance: true,
        projectId: loaded.projectId,
        projectionRevision: loaded.revision,
        query: resolvedQuery(query, result),
        sourceReferences: collectSourceReferences(result),
        result,
      });
    } catch (cause: unknown) {
      if (cause instanceof SearchIndexError) {
        return err(
          new AppError({
            code: "VALIDATION_FAILED",
            message: cause.message,
            details: { graphErrorCode: cause.code },
          }),
        );
      }
      return err(corruptProjectionError(query.projectId));
    }
  }
}

function resolvedQuery(query: GraphRagQuery, result: GraphRagResponse): GraphRagQuery {
  return {
    projectId: query.projectId.trim(),
    seedEntityIds: [...result.seedEntityIds],
    direction: query.direction ?? "both",
    ...(query.relationKinds === undefined
      ? {}
      : {
          relationKinds: [...new Set(query.relationKinds.map((kind) => kind.trim()))].sort(),
        }),
    minimumConfidence: query.minimumConfidence ?? 0,
    limits: {
      maxDepth: result.limits.maxDepth,
      maxNodes: result.limits.maxNodes,
      maxEdges: result.limits.maxEdges,
    },
  };
}

function collectSourceReferences(result: GraphRagResponse): readonly GraphSourceReference[] {
  const references = new Map<string, GraphSourceReference>();
  for (const { entity } of result.entities) {
    const reference = entity.source;
    references.set(sourceReferenceKey(reference), { ...reference });
  }
  for (const relation of result.relationCandidates) {
    for (const assertion of relation.assertions) {
      for (const evidence of assertion.evidence) {
        const reference: GraphSourceReference = {
          sourceId: evidence.sourceId,
          sourceVersionId: evidence.sourceVersionId,
          contentHash: evidence.contentHash,
        };
        references.set(sourceReferenceKey(reference), reference);
      }
    }
  }
  return Object.freeze(
    [...references.values()].sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.sourceVersionId.localeCompare(right.sourceVersionId) ||
        left.contentHash.localeCompare(right.contentHash),
    ),
  );
}

function sourceReferenceKey(reference: GraphSourceReference): string {
  return JSON.stringify([reference.sourceId, reference.sourceVersionId, reference.contentHash]);
}

function corruptProjectionError(projectId: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The local graph projection failed integrity validation.",
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: {
      operation: "GRAPH_RAG_PROJECTION_CORRUPT",
      projectId,
    },
  });
}
