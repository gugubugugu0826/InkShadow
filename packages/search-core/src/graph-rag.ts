import { SearchIndexError } from "./errors.js";

export const MAX_GRAPH_SOURCE_CONTENT_LENGTH = 2_000_000;
const MAX_LABEL_LENGTH = 500;
const MAX_EVIDENCE_LENGTH = 20_000;
const MAX_SEEDS = 32;
const MAX_DEPTH = 6;
const MAX_NODES = 1_000;
const MAX_EDGES = 5_000;
const GRAPH_RELATION_POLARITIES: readonly string[] = ["affirmed", "negated"];
const GRAPH_TRAVERSAL_DIRECTIONS: readonly string[] = ["outgoing", "incoming", "both"];

export type GraphSourceVersionState = "current" | "superseded" | "deleted";
export type GraphRelationPolarity = "affirmed" | "negated";
export type GraphTraversalDirection = "outgoing" | "incoming" | "both";

export interface GraphSourceVersion {
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  contentHash: string;
  content: string;
  createdAt: string;
}

export interface GraphStoredSourceVersion {
  source: GraphSourceVersion;
  state: GraphSourceVersionState;
  invalidatedAt?: string;
}

export interface GraphRagProjectSnapshot {
  projectId: string;
  sourceVersions: readonly GraphStoredSourceVersion[];
  entities: readonly GraphEntity[];
  relations: readonly GraphRelation[];
}

export interface GraphSourceReference {
  sourceId: string;
  sourceVersionId: string;
  contentHash: string;
}

export interface GraphEntity {
  id: string;
  projectId: string;
  kind: string;
  label: string;
  source: GraphSourceReference;
  documentId?: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface GraphEvidenceSpan {
  startOffset: number;
  endOffset: number;
  encoding: "utf16";
}

export interface GraphEvidenceCitation {
  label: string;
  locator: string;
}

export interface GraphRelationEvidence {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  contentHash: string;
  span: GraphEvidenceSpan;
  quote: string;
  spanHash: string;
  citation: GraphEvidenceCitation;
}

export interface GraphRelation {
  id: string;
  projectId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  polarity: GraphRelationPolarity;
  confidence: number;
  evidence: readonly GraphRelationEvidence[];
  updatedAt: string;
  deletedAt?: string;
}

export interface GraphTraversalLimits {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
}

export interface GraphRagQuery {
  projectId: string;
  seedEntityIds: readonly string[];
  direction?: GraphTraversalDirection;
  relationKinds?: readonly string[];
  minimumConfidence?: number;
  limits?: Partial<GraphTraversalLimits>;
}

export interface GraphRelationAssertionCandidate {
  polarity: GraphRelationPolarity;
  relationIds: readonly string[];
  confidence: number;
  evidence: readonly GraphRelationEvidence[];
}

export interface GraphRelationCandidate {
  candidateId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  depth: number;
  relationScore: number;
  assertions: readonly GraphRelationAssertionCandidate[];
  conflict: {
    detected: boolean;
    polarities: readonly GraphRelationPolarity[];
  };
  explanation: {
    scoreSource: "relation";
    traversalDirection: "outgoing" | "incoming";
    reachedEntityId: string;
    duplicateRelationsCollapsed: number;
  };
}

export interface GraphEntityCandidate {
  entity: GraphEntity;
  depth: number;
  seedEntityId: string;
  relationScore: number;
  pathCandidateIds: readonly string[];
}

/**
 * A deliberately relation-only score that callers can fuse into the existing
 * hybrid ranking. It never claims to be an embedding or semantic similarity.
 */
export interface GraphHybridFusionCandidate {
  entityId: string;
  documentId?: string;
  relationScore: number;
  relationCandidateIds: readonly string[];
  explanation: {
    scoreSource: "relation";
    seedEntityId: string;
    depth: number;
  };
}

export interface GraphRagResponse {
  seedEntityIds: readonly string[];
  entities: readonly GraphEntityCandidate[];
  relationCandidates: readonly GraphRelationCandidate[];
  fusionCandidates: readonly GraphHybridFusionCandidate[];
  limits: GraphTraversalLimits & {
    nodeLimitReached: boolean;
    edgeLimitReached: boolean;
    depthLimitReached: boolean;
  };
  capabilities: {
    relation: "ready" | "degraded";
    embeddingContribution: "not_used";
  };
  notices: readonly string[];
}

interface GraphProjectState {
  sourceVersions: Map<string, GraphStoredSourceVersion>;
  currentSourceVersions: Map<string, string>;
  entities: Map<string, GraphEntity>;
  relations: Map<string, GraphRelation>;
}

interface ActiveSemanticEdge {
  candidateId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  assertions: GraphRelationAssertionCandidate[];
  maximumConfidence: number;
}

interface QueueEntry {
  entityId: string;
  depth: number;
  seedEntityId: string;
  relationScore: number;
  pathCandidateIds: string[];
}

interface TraversalEdge {
  edge: ActiveSemanticEdge;
  reachedEntityId: string;
  traversalDirection: "outgoing" | "incoming";
}

const DEFAULT_LIMITS: GraphTraversalLimits = {
  maxDepth: 2,
  maxNodes: 100,
  maxEdges: 250,
};

export class InMemoryGraphRagIndex {
  private readonly projects = new Map<string, GraphProjectState>();

  /**
   * Restores a persisted derived projection without treating superseded source
   * versions as new writes. Every stored record is revalidated in TypeScript,
   * including UTF-16 evidence spans, before the project becomes queryable.
   */
  public restoreProject(snapshot: GraphRagProjectSnapshot): void {
    const restored = validateProjectSnapshot(snapshot);
    this.projects.set(restored.projectId, restored.state);
  }

  public snapshotProject(projectId: string): GraphRagProjectSnapshot | undefined {
    const normalizedProjectId = requireIdentifier(projectId, "projectId");
    const project = this.projects.get(normalizedProjectId);
    if (project === undefined) {
      return undefined;
    }
    return {
      projectId: normalizedProjectId,
      sourceVersions: [...project.sourceVersions.values()]
        .sort(compareStoredSourceVersions)
        .map((stored) => ({
          source: { ...stored.source },
          state: stored.state,
          ...(stored.invalidatedAt === undefined ? {} : { invalidatedAt: stored.invalidatedAt }),
        })),
      entities: [...project.entities.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(cloneEntity),
      relations: [...project.relations.values()].sort(compareRelations).map((relation) => ({
        ...relation,
        evidence: relation.evidence.map(cloneEvidence),
      })),
    };
  }

  public upsertSourceVersion(source: GraphSourceVersion): void {
    const validated = validateSourceVersion(source);
    const project = this.getOrCreateProject(validated.projectId);
    const key = sourceVersionKey(validated.sourceId, validated.sourceVersionId);
    const existing = project.sourceVersions.get(key);

    if (existing !== undefined && !sameSourceVersion(existing.source, validated)) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "A source version is immutable and cannot be replaced with different content.",
      );
    }

    const previousCurrentVersionId = project.currentSourceVersions.get(validated.sourceId);
    if (existing !== undefined && previousCurrentVersionId !== validated.sourceVersionId) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "A superseded source version cannot be made current again.",
      );
    }
    if (existing === undefined) {
      const latestStored = [...project.sourceVersions.values()]
        .filter(({ source: stored }) => stored.sourceId === validated.sourceId)
        .sort(
          (left, right) =>
            right.source.createdAt.localeCompare(left.source.createdAt) ||
            right.source.sourceVersionId.localeCompare(left.source.sourceVersionId),
        )[0];
      if (
        latestStored !== undefined &&
        (Date.parse(validated.createdAt) <= Date.parse(latestStored.source.createdAt) ||
          (latestStored.invalidatedAt !== undefined &&
            Date.parse(validated.createdAt) < Date.parse(latestStored.invalidatedAt)))
      ) {
        throw new SearchIndexError(
          "GRAPH_VERSION_CONFLICT",
          "A new source version must be newer than every persisted version and invalidation.",
        );
      }
    }
    if (
      previousCurrentVersionId !== undefined &&
      previousCurrentVersionId !== validated.sourceVersionId
    ) {
      const previous = project.sourceVersions.get(
        sourceVersionKey(validated.sourceId, previousCurrentVersionId),
      );
      if (previous !== undefined) {
        if (Date.parse(validated.createdAt) <= Date.parse(previous.source.createdAt)) {
          throw new SearchIndexError(
            "GRAPH_VERSION_CONFLICT",
            "A new source version must be chronologically newer than the current version.",
          );
        }
        project.sourceVersions.set(sourceVersionKey(validated.sourceId, previousCurrentVersionId), {
          ...previous,
          state: "superseded",
          invalidatedAt: validated.createdAt,
        });
      }
    }

    project.sourceVersions.set(key, {
      source: validated,
      state: "current",
    });
    project.currentSourceVersions.set(validated.sourceId, validated.sourceVersionId);
  }

  public invalidateSourceVersion(
    projectId: string,
    sourceId: string,
    sourceVersionId: string,
    state: GraphSourceVersionState,
    invalidatedAt: string,
  ): void {
    const validatedProjectId = requireIdentifier(projectId, "projectId");
    const validatedSourceId = requireIdentifier(sourceId, "sourceId");
    const validatedVersionId = requireIdentifier(sourceVersionId, "sourceVersionId");
    const project = this.projects.get(validatedProjectId);
    const key = sourceVersionKey(validatedSourceId, validatedVersionId);
    const current = project?.sourceVersions.get(key);
    if (project === undefined || current === undefined) {
      throw new SearchIndexError("INVALID_GRAPH_SOURCE", "The source version does not exist.");
    }
    if (
      !["superseded", "deleted"].includes(state) ||
      Date.parse(requireIsoDate(invalidatedAt, "invalidatedAt")) <
        Date.parse(current.source.createdAt)
    ) {
      throw new SearchIndexError(
        "INVALID_GRAPH_SOURCE",
        "The source invalidation state or timestamp is invalid.",
      );
    }
    if (
      current.invalidatedAt !== undefined &&
      Date.parse(invalidatedAt) < Date.parse(current.invalidatedAt)
    ) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "A source invalidation timestamp cannot move backwards.",
      );
    }
    if (current.state === "deleted" && state !== "deleted") {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "A deleted source version cannot be restored into the graph projection.",
      );
    }

    project.sourceVersions.set(key, {
      ...current,
      state,
      invalidatedAt,
    });
    if (project.currentSourceVersions.get(validatedSourceId) === validatedVersionId) {
      project.currentSourceVersions.delete(validatedSourceId);
    }
  }

  public upsertEntity(entity: GraphEntity): void {
    const validated = validateEntity(entity);
    const project = this.getOrCreateProject(validated.projectId);
    this.assertCurrentSourceReference(project, validated.source, "entity");
    const existing = project.entities.get(validated.id);
    if (
      existing !== undefined &&
      !sameEntity(existing, validated) &&
      (this.isEntityActive(project, existing) ||
        Date.parse(validated.updatedAt) <= Date.parse(existing.updatedAt))
    ) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "An active or newer graph entity cannot be overwritten.",
      );
    }
    project.entities.set(validated.id, validated);
  }

  public softDeleteEntity(projectId: string, entityId: string, deletedAt: string): void {
    const project = this.projects.get(requireIdentifier(projectId, "projectId"));
    const validatedEntityId = requireIdentifier(entityId, "entityId");
    const existing = project?.entities.get(validatedEntityId);
    if (existing === undefined) {
      return;
    }
    const validatedDeletedAt = requireIsoDate(deletedAt, "deletedAt");
    if (Date.parse(validatedDeletedAt) < Date.parse(existing.updatedAt)) {
      throw new SearchIndexError(
        "INVALID_GRAPH_ENTITY",
        "Entity deletion cannot predate its latest update.",
      );
    }
    project?.entities.set(validatedEntityId, {
      ...existing,
      deletedAt: validatedDeletedAt,
    });
  }

  public upsertRelation(relation: GraphRelation): void {
    const validated = validateRelation(relation);
    const project = this.projects.get(validated.projectId);
    if (project === undefined) {
      throw new SearchIndexError(
        "INVALID_GRAPH_RELATION",
        "A relation may only reference active entities in its project.",
      );
    }

    const from = project.entities.get(validated.fromEntityId);
    const to = project.entities.get(validated.toEntityId);
    if (!this.isEntityActive(project, from) || !this.isEntityActive(project, to)) {
      throw new SearchIndexError(
        "INVALID_GRAPH_RELATION",
        "A relation may only reference active entities in its project.",
      );
    }
    for (const evidence of validated.evidence) {
      this.assertEvidence(project, validated.projectId, evidence);
    }
    const existing = project.relations.get(validated.id);
    if (existing !== undefined && !sameRelation(existing, validated)) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "A graph relation identifier is immutable and cannot be rebound.",
      );
    }
    project.relations.set(validated.id, validated);
  }

  public softDeleteRelation(projectId: string, relationId: string, deletedAt: string): void {
    const project = this.projects.get(requireIdentifier(projectId, "projectId"));
    const validatedRelationId = requireIdentifier(relationId, "relationId");
    const existing = project?.relations.get(validatedRelationId);
    if (existing === undefined) {
      return;
    }
    const validatedDeletedAt = requireIsoDate(deletedAt, "deletedAt");
    if (Date.parse(validatedDeletedAt) < Date.parse(existing.updatedAt)) {
      throw new SearchIndexError(
        "INVALID_GRAPH_RELATION",
        "Relation deletion cannot predate its latest update.",
      );
    }
    project?.relations.set(validatedRelationId, {
      ...existing,
      deletedAt: validatedDeletedAt,
    });
  }

  public deleteProject(projectId: string): void {
    this.projects.delete(requireIdentifier(projectId, "projectId"));
  }

  public query(request: GraphRagQuery): GraphRagResponse {
    const projectId = requireIdentifier(request.projectId, "projectId");
    const seedEntityIds = validateSeeds(request.seedEntityIds);
    const limits = validateLimits(request.limits, seedEntityIds.length);
    const direction = validateDirection(request.direction);
    const minimumConfidence = validateMinimumConfidence(request.minimumConfidence);
    const relationKinds = validateRelationKinds(request.relationKinds);
    const project = this.projects.get(projectId);

    if (
      project === undefined ||
      seedEntityIds.some((seedId) => !this.isEntityActive(project, project.entities.get(seedId)))
    ) {
      throw new SearchIndexError(
        "GRAPH_SEED_NOT_FOUND",
        "One or more graph seeds are unavailable in the requested project.",
      );
    }

    const notices = new Set<string>();
    const activeEntities = new Map(
      [...project.entities.entries()].filter(([, entity]) => this.isEntityActive(project, entity)),
    );
    if (activeEntities.size < project.entities.size) {
      notices.add("graph_stale_or_deleted_entities_filtered");
    }

    const { edges, staleEvidenceFiltered } = this.buildActiveSemanticEdges(
      project,
      activeEntities,
      relationKinds,
      minimumConfidence,
    );
    if (staleEvidenceFiltered) {
      notices.add("graph_stale_or_missing_evidence_filtered");
    }
    const adjacency = buildAdjacency(edges, direction);
    const queue: QueueEntry[] = seedEntityIds.map((entityId) => ({
      entityId,
      depth: 0,
      seedEntityId: entityId,
      relationScore: 0,
      pathCandidateIds: [],
    }));
    const visited = new Set(seedEntityIds);
    const entityCandidates = [...queue];
    const relationCandidates: GraphRelationCandidate[] = [];
    let nodeLimitReached = false;
    let edgeLimitReached = false;
    let depthLimitReached = false;

    for (const current of queue) {
      const adjacent = adjacency.get(current.entityId) ?? [];
      if (current.depth >= limits.maxDepth) {
        if (adjacent.some(({ reachedEntityId }) => !visited.has(reachedEntityId))) {
          depthLimitReached = true;
        }
        continue;
      }

      for (const traversal of adjacent) {
        if (visited.has(traversal.reachedEntityId)) {
          continue;
        }
        if (relationCandidates.length >= limits.maxEdges) {
          edgeLimitReached = true;
          break;
        }
        if (visited.size >= limits.maxNodes) {
          nodeLimitReached = true;
          break;
        }

        const nextDepth = current.depth + 1;
        const relationScore = round(traversal.edge.maximumConfidence / nextDepth);
        const candidate = toRelationCandidate(traversal, nextDepth, relationScore);
        const next: QueueEntry = {
          entityId: traversal.reachedEntityId,
          depth: nextDepth,
          seedEntityId: current.seedEntityId,
          relationScore,
          pathCandidateIds: [...current.pathCandidateIds, candidate.candidateId],
        };
        visited.add(next.entityId);
        queue.push(next);
        entityCandidates.push(next);
        relationCandidates.push(candidate);
      }
    }

    const entities = entityCandidates.map((candidate) => ({
      entity: cloneEntity(requireEntity(activeEntities, candidate.entityId)),
      depth: candidate.depth,
      seedEntityId: candidate.seedEntityId,
      relationScore: candidate.relationScore,
      pathCandidateIds: [...candidate.pathCandidateIds],
    }));
    const fusionCandidates = entities
      .filter(({ depth }) => depth > 0)
      .map(({ entity, depth, seedEntityId, relationScore, pathCandidateIds }) => ({
        entityId: entity.id,
        ...(entity.documentId === undefined ? {} : { documentId: entity.documentId }),
        relationScore,
        relationCandidateIds: [...pathCandidateIds],
        explanation: {
          scoreSource: "relation" as const,
          seedEntityId,
          depth,
        },
      }));

    if (nodeLimitReached) {
      notices.add("graph_node_limit_reached");
    }
    if (edgeLimitReached) {
      notices.add("graph_edge_limit_reached");
    }
    if (depthLimitReached) {
      notices.add("graph_depth_limit_reached");
    }

    return {
      seedEntityIds,
      entities,
      relationCandidates,
      fusionCandidates,
      limits: {
        ...limits,
        nodeLimitReached,
        edgeLimitReached,
        depthLimitReached,
      },
      capabilities: {
        relation: staleEvidenceFiltered ? "degraded" : "ready",
        embeddingContribution: "not_used",
      },
      notices: [...notices].sort(),
    };
  }

  private buildActiveSemanticEdges(
    project: GraphProjectState,
    activeEntities: ReadonlyMap<string, GraphEntity>,
    relationKinds: ReadonlySet<string> | undefined,
    minimumConfidence: number,
  ): { edges: ActiveSemanticEdge[]; staleEvidenceFiltered: boolean } {
    const grouped = new Map<string, Map<GraphRelationPolarity, GraphRelation[]>>();
    let staleEvidenceFiltered = false;

    for (const relation of project.relations.values()) {
      if (
        relation.deletedAt !== undefined ||
        !activeEntities.has(relation.fromEntityId) ||
        !activeEntities.has(relation.toEntityId) ||
        relation.confidence < minimumConfidence ||
        (relationKinds !== undefined && !relationKinds.has(relation.kind))
      ) {
        continue;
      }
      const activeEvidence = relation.evidence.filter((evidence) =>
        this.isEvidenceActive(project, relation.projectId, evidence),
      );
      if (activeEvidence.length !== relation.evidence.length) {
        staleEvidenceFiltered = true;
      }
      if (activeEvidence.length === 0) {
        continue;
      }
      const activeRelation: GraphRelation = {
        ...relation,
        evidence: activeEvidence,
      };
      const key = semanticEdgeKey(relation);
      const byPolarity = grouped.get(key) ?? new Map<GraphRelationPolarity, GraphRelation[]>();
      const duplicates = byPolarity.get(relation.polarity) ?? [];
      duplicates.push(activeRelation);
      byPolarity.set(relation.polarity, duplicates);
      grouped.set(key, byPolarity);
    }

    const edges = [...grouped.entries()]
      .map(([candidateId, byPolarity]) => {
        const allRelations = [...byPolarity.values()].flat();
        const first = allRelations.sort(compareRelations)[0];
        if (first === undefined) {
          return undefined;
        }
        const assertions = [...byPolarity.entries()]
          .map(([polarity, relations]) => toAssertion(polarity, relations))
          .sort(compareAssertions);
        return {
          candidateId,
          fromEntityId: first.fromEntityId,
          toEntityId: first.toEntityId,
          kind: first.kind,
          assertions,
          maximumConfidence: Math.max(...assertions.map((assertion) => assertion.confidence)),
        };
      })
      .filter((edge): edge is ActiveSemanticEdge => edge !== undefined)
      .sort(compareSemanticEdges);
    return { edges, staleEvidenceFiltered };
  }

  private assertCurrentSourceReference(
    project: GraphProjectState,
    reference: GraphSourceReference,
    owner: string,
  ): void {
    const record = project.sourceVersions.get(
      sourceVersionKey(reference.sourceId, reference.sourceVersionId),
    );
    if (
      record?.state !== "current" ||
      project.currentSourceVersions.get(reference.sourceId) !== reference.sourceVersionId ||
      record.source.contentHash !== reference.contentHash
    ) {
      throw new SearchIndexError(
        "INVALID_GRAPH_SOURCE",
        `The ${owner} source reference is not the current version in this project.`,
      );
    }
  }

  private assertEvidence(
    project: GraphProjectState,
    relationProjectId: string,
    evidence: GraphRelationEvidence,
  ): void {
    if (!this.isEvidenceActive(project, relationProjectId, evidence)) {
      throw new SearchIndexError(
        "INVALID_GRAPH_EVIDENCE",
        "Relation evidence must resolve to an exact current source span in the same project.",
      );
    }
  }

  private isEvidenceActive(
    project: GraphProjectState,
    relationProjectId: string,
    evidence: GraphRelationEvidence,
  ): boolean {
    if (evidence.projectId !== relationProjectId) {
      return false;
    }
    const record = project.sourceVersions.get(
      sourceVersionKey(evidence.sourceId, evidence.sourceVersionId),
    );
    if (
      record?.state !== "current" ||
      project.currentSourceVersions.get(evidence.sourceId) !== evidence.sourceVersionId ||
      record.source.projectId !== relationProjectId ||
      record.source.contentHash !== evidence.contentHash
    ) {
      return false;
    }
    const quote = record.source.content.slice(evidence.span.startOffset, evidence.span.endOffset);
    return (
      isUtf16CodePointBoundary(record.source.content, evidence.span.startOffset) &&
      isUtf16CodePointBoundary(record.source.content, evidence.span.endOffset) &&
      quote === evidence.quote &&
      graphEvidenceSpanHash(quote) === evidence.spanHash
    );
  }

  private isEntityActive(project: GraphProjectState, entity: GraphEntity | undefined): boolean {
    if (entity === undefined || entity.deletedAt !== undefined) {
      return false;
    }
    const record = project.sourceVersions.get(
      sourceVersionKey(entity.source.sourceId, entity.source.sourceVersionId),
    );
    return (
      record?.state === "current" &&
      project.currentSourceVersions.get(entity.source.sourceId) === entity.source.sourceVersionId &&
      record.source.contentHash === entity.source.contentHash
    );
  }

  private getOrCreateProject(projectId: string): GraphProjectState {
    const existing = this.projects.get(projectId);
    if (existing !== undefined) {
      return existing;
    }
    const created: GraphProjectState = {
      sourceVersions: new Map(),
      currentSourceVersions: new Map(),
      entities: new Map(),
      relations: new Map(),
    };
    this.projects.set(projectId, created);
    return created;
  }
}

function validateProjectSnapshot(snapshot: GraphRagProjectSnapshot): {
  projectId: string;
  state: GraphProjectState;
} {
  const projectId = requireIdentifier(snapshot.projectId, "snapshot.projectId");
  const sourceVersions = new Map<string, GraphStoredSourceVersion>();
  const currentSourceVersions = new Map<string, string>();
  const versionsBySource = new Map<string, GraphStoredSourceVersion[]>();

  for (const storedValue of snapshot.sourceVersions) {
    const source = validateSourceVersion(storedValue.source);
    if (source.projectId !== projectId) {
      throw new SearchIndexError(
        "INVALID_GRAPH_SOURCE",
        "A restored source version belongs to another project.",
      );
    }
    if (!["current", "superseded", "deleted"].includes(storedValue.state)) {
      throw new SearchIndexError(
        "INVALID_GRAPH_SOURCE",
        "A restored source version has an invalid state.",
      );
    }
    const invalidatedAt =
      storedValue.invalidatedAt === undefined
        ? undefined
        : requireIsoDate(storedValue.invalidatedAt, "source.invalidatedAt");
    if (
      (storedValue.state === "current" && invalidatedAt !== undefined) ||
      (storedValue.state !== "current" && invalidatedAt === undefined) ||
      (invalidatedAt !== undefined && Date.parse(invalidatedAt) < Date.parse(source.createdAt))
    ) {
      throw new SearchIndexError(
        "INVALID_GRAPH_SOURCE",
        "A restored source version has inconsistent invalidation metadata.",
      );
    }

    const key = sourceVersionKey(source.sourceId, source.sourceVersionId);
    if (sourceVersions.has(key)) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "A restored graph contains duplicate source-version identities.",
      );
    }
    const stored: GraphStoredSourceVersion = {
      source,
      state: storedValue.state,
      ...(invalidatedAt === undefined ? {} : { invalidatedAt }),
    };
    sourceVersions.set(key, stored);
    const related = versionsBySource.get(source.sourceId) ?? [];
    related.push(stored);
    versionsBySource.set(source.sourceId, related);

    if (stored.state === "current") {
      if (currentSourceVersions.has(source.sourceId)) {
        throw new SearchIndexError(
          "GRAPH_VERSION_CONFLICT",
          "A source may have only one current graph version.",
        );
      }
      currentSourceVersions.set(source.sourceId, source.sourceVersionId);
    }
  }

  for (const versions of versionsBySource.values()) {
    const ordered = [...versions].sort(
      (left, right) =>
        left.source.createdAt.localeCompare(right.source.createdAt) ||
        left.source.sourceVersionId.localeCompare(right.source.sourceVersionId),
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (
        previous === undefined ||
        current === undefined ||
        previous.source.createdAt === current.source.createdAt
      ) {
        throw new SearchIndexError(
          "GRAPH_VERSION_CONFLICT",
          "Persisted source versions must have a strict chronological order.",
        );
      }
    }
    const current = ordered.find(({ state }) => state === "current");
    const latest = ordered.at(-1);
    if (current !== undefined && current !== latest) {
      throw new SearchIndexError(
        "GRAPH_VERSION_CONFLICT",
        "Only the newest persisted source version may be current.",
      );
    }
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const previous = ordered[index];
      const next = ordered[index + 1];
      if (
        previous?.invalidatedAt !== undefined &&
        next !== undefined &&
        Date.parse(next.source.createdAt) < Date.parse(previous.invalidatedAt)
      ) {
        throw new SearchIndexError(
          "GRAPH_VERSION_CONFLICT",
          "A persisted source version predates the prior version's invalidation.",
        );
      }
    }
  }

  const entities = new Map<string, GraphEntity>();
  for (const entityValue of snapshot.entities) {
    const entity = validateEntity(entityValue);
    if (entity.projectId !== projectId || entities.has(entity.id)) {
      throw new SearchIndexError(
        "INVALID_GRAPH_ENTITY",
        "A restored entity has a duplicate identity or belongs to another project.",
      );
    }
    const source = sourceVersions.get(
      sourceVersionKey(entity.source.sourceId, entity.source.sourceVersionId),
    );
    if (
      source?.source.contentHash !== entity.source.contentHash ||
      Date.parse(entity.deletedAt ?? entity.updatedAt) < Date.parse(entity.updatedAt)
    ) {
      throw new SearchIndexError(
        "INVALID_GRAPH_ENTITY",
        "A restored entity has invalid source or deletion metadata.",
      );
    }
    entities.set(entity.id, cloneEntity(entity));
  }

  const relations = new Map<string, GraphRelation>();
  const evidenceIds = new Set<string>();
  for (const relationValue of snapshot.relations) {
    const relation = validateRelation(relationValue);
    if (
      relation.projectId !== projectId ||
      relations.has(relation.id) ||
      !entities.has(relation.fromEntityId) ||
      !entities.has(relation.toEntityId) ||
      Date.parse(relation.deletedAt ?? relation.updatedAt) < Date.parse(relation.updatedAt)
    ) {
      throw new SearchIndexError(
        "INVALID_GRAPH_RELATION",
        "A restored relation has invalid identity, endpoints, or deletion metadata.",
      );
    }
    for (const evidence of relation.evidence) {
      if (evidenceIds.has(evidence.id)) {
        throw new SearchIndexError(
          "INVALID_GRAPH_EVIDENCE",
          "A restored evidence identity is bound more than once.",
        );
      }
      evidenceIds.add(evidence.id);
      const source = sourceVersions.get(
        sourceVersionKey(evidence.sourceId, evidence.sourceVersionId),
      );
      const exactQuote = source?.source.content.slice(
        evidence.span.startOffset,
        evidence.span.endOffset,
      );
      if (
        source?.source.projectId !== projectId ||
        source.source.contentHash !== evidence.contentHash ||
        !isUtf16CodePointBoundary(source.source.content, evidence.span.startOffset) ||
        !isUtf16CodePointBoundary(source.source.content, evidence.span.endOffset) ||
        exactQuote !== evidence.quote ||
        graphEvidenceSpanHash(evidence.quote) !== evidence.spanHash
      ) {
        throw new SearchIndexError(
          "INVALID_GRAPH_EVIDENCE",
          "Restored evidence does not match its authoritative UTF-16 source span.",
        );
      }
    }
    relations.set(relation.id, {
      ...relation,
      evidence: relation.evidence.map(cloneEvidence),
    });
  }

  return {
    projectId,
    state: {
      sourceVersions,
      currentSourceVersions,
      entities,
      relations,
    },
  };
}

export function graphEvidenceSpanHash(value: string): string {
  // This deterministic fingerprint detects accidental/stale span mismatches.
  // Exact quote and authoritative source-hash equality remain mandatory; this
  // non-cryptographic value is never used as an authentication boundary.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export type GraphSourceContentIssue = "empty" | "ill_formed_utf16" | "too_large" | "unsafe_control";

export function graphSourceContentIssue(value: string): GraphSourceContentIssue | null {
  if (value.length === 0) {
    return "empty";
  }
  if (value.length > MAX_GRAPH_SOURCE_CONTENT_LENGTH) {
    return "too_large";
  }
  if (!isWellFormedUtf16(value)) {
    return "ill_formed_utf16";
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return "unsafe_control";
  }
  return null;
}

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isUtf16CodePointBoundary(value: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
    return false;
  }
  if (offset === 0 || offset === value.length) {
    return true;
  }
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function validateSourceVersion(source: GraphSourceVersion): GraphSourceVersion {
  if (graphSourceContentIssue(source.content) !== null) {
    throw new SearchIndexError(
      "INVALID_GRAPH_SOURCE",
      "Graph source content is empty, too large, ill-formed, or contains unsafe controls.",
    );
  }
  return {
    projectId: requireIdentifier(source.projectId, "source.projectId"),
    sourceId: requireIdentifier(source.sourceId, "source.sourceId"),
    sourceVersionId: requireIdentifier(source.sourceVersionId, "source.sourceVersionId"),
    contentHash: requireSha256(source.contentHash, "source.contentHash"),
    content: source.content,
    createdAt: requireIsoDate(source.createdAt, "source.createdAt"),
  };
}

function validateEntity(entity: GraphEntity): GraphEntity {
  const label = requireText(entity.label, "entity.label", MAX_LABEL_LENGTH);
  return {
    id: requireIdentifier(entity.id, "entity.id"),
    projectId: requireIdentifier(entity.projectId, "entity.projectId"),
    kind: requireIdentifier(entity.kind, "entity.kind"),
    label,
    source: {
      sourceId: requireIdentifier(entity.source.sourceId, "entity.source.sourceId"),
      sourceVersionId: requireIdentifier(
        entity.source.sourceVersionId,
        "entity.source.sourceVersionId",
      ),
      contentHash: requireSha256(entity.source.contentHash, "entity.source.contentHash"),
    },
    ...(entity.documentId === undefined
      ? {}
      : { documentId: requireIdentifier(entity.documentId, "entity.documentId") }),
    updatedAt: requireIsoDate(entity.updatedAt, "entity.updatedAt"),
    ...(entity.deletedAt === undefined
      ? {}
      : { deletedAt: requireIsoDate(entity.deletedAt, "entity.deletedAt") }),
  };
}

function validateRelation(relation: GraphRelation): GraphRelation {
  const fromEntityId = requireIdentifier(relation.fromEntityId, "relation.fromEntityId");
  const toEntityId = requireIdentifier(relation.toEntityId, "relation.toEntityId");
  if (
    fromEntityId === toEntityId ||
    !Number.isFinite(relation.confidence) ||
    relation.confidence <= 0 ||
    relation.confidence > 1 ||
    relation.evidence.length === 0
  ) {
    throw new SearchIndexError("INVALID_GRAPH_RELATION", "Graph relation fields are invalid.");
  }
  if (!GRAPH_RELATION_POLARITIES.includes(relation.polarity)) {
    throw new SearchIndexError("INVALID_GRAPH_RELATION", "Graph relation polarity is invalid.");
  }
  if (relation.evidence.length > 100) {
    throw new SearchIndexError(
      "INVALID_GRAPH_RELATION",
      "A graph relation has too many evidence records.",
    );
  }
  const projectId = requireIdentifier(relation.projectId, "relation.projectId");
  return {
    id: requireIdentifier(relation.id, "relation.id"),
    projectId,
    fromEntityId,
    toEntityId,
    kind: requireIdentifier(relation.kind, "relation.kind"),
    polarity: relation.polarity,
    confidence: relation.confidence,
    evidence: relation.evidence.map((evidence) => validateEvidence(evidence, projectId)),
    updatedAt: requireIsoDate(relation.updatedAt, "relation.updatedAt"),
    ...(relation.deletedAt === undefined
      ? {}
      : { deletedAt: requireIsoDate(relation.deletedAt, "relation.deletedAt") }),
  };
}

function validateEvidence(
  evidence: GraphRelationEvidence,
  relationProjectId: string,
): GraphRelationEvidence {
  const startOffset = evidence.span.startOffset;
  const endOffset = evidence.span.endOffset;
  if (
    evidence.projectId !== relationProjectId ||
    (evidence.span.encoding as string) !== "utf16" ||
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset - startOffset > MAX_EVIDENCE_LENGTH ||
    evidence.quote.length !== endOffset - startOffset ||
    !isWellFormedUtf16(evidence.quote)
  ) {
    throw new SearchIndexError(
      "INVALID_GRAPH_EVIDENCE",
      "Graph evidence project or span is invalid.",
    );
  }
  return {
    id: requireIdentifier(evidence.id, "evidence.id"),
    projectId: requireIdentifier(evidence.projectId, "evidence.projectId"),
    sourceId: requireIdentifier(evidence.sourceId, "evidence.sourceId"),
    sourceVersionId: requireIdentifier(evidence.sourceVersionId, "evidence.sourceVersionId"),
    contentHash: requireSha256(evidence.contentHash, "evidence.contentHash"),
    span: {
      startOffset,
      endOffset,
      encoding: "utf16",
    },
    quote: evidence.quote,
    spanHash: requireSpanFingerprint(evidence.spanHash),
    citation: {
      label: requireText(evidence.citation.label, "evidence.citation.label", MAX_LABEL_LENGTH),
      locator: requireText(
        evidence.citation.locator,
        "evidence.citation.locator",
        MAX_LABEL_LENGTH,
      ),
    },
  };
}

function validateSeeds(values: readonly string[]): string[] {
  if (values.length === 0 || values.length > MAX_SEEDS) {
    throw new SearchIndexError(
      "INVALID_GRAPH_QUERY",
      `Graph queries require between 1 and ${String(MAX_SEEDS)} seeds.`,
    );
  }
  return [...new Set(values.map((value) => requireIdentifier(value, "seedEntityId")))].sort();
}

function validateLimits(
  input: Partial<GraphTraversalLimits> | undefined,
  seedCount: number,
): GraphTraversalLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    limits.maxDepth > MAX_DEPTH ||
    !Number.isSafeInteger(limits.maxNodes) ||
    limits.maxNodes < seedCount ||
    limits.maxNodes > MAX_NODES ||
    !Number.isSafeInteger(limits.maxEdges) ||
    limits.maxEdges < 0 ||
    limits.maxEdges > MAX_EDGES
  ) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", "Graph traversal limits are invalid.");
  }
  return limits;
}

function validateDirection(value: GraphTraversalDirection | undefined): GraphTraversalDirection {
  if (value === undefined) {
    return "both";
  }
  if (!GRAPH_TRAVERSAL_DIRECTIONS.includes(value)) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", "Graph traversal direction is invalid.");
  }
  return value;
}

function validateMinimumConfidence(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new SearchIndexError(
      "INVALID_GRAPH_QUERY",
      "Graph minimum confidence must be between zero and one.",
    );
  }
  return value;
}

function validateRelationKinds(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (values.length === 0 || values.length > 100) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", "Graph relation kind filter is invalid.");
  }
  return new Set(values.map((value) => requireIdentifier(value, "relationKind")));
}

function buildAdjacency(
  edges: readonly ActiveSemanticEdge[],
  direction: GraphTraversalDirection,
): Map<string, TraversalEdge[]> {
  const adjacency = new Map<string, TraversalEdge[]>();
  for (const edge of edges) {
    if (direction === "outgoing" || direction === "both") {
      appendTraversal(adjacency, edge.fromEntityId, {
        edge,
        reachedEntityId: edge.toEntityId,
        traversalDirection: "outgoing",
      });
    }
    if (direction === "incoming" || direction === "both") {
      appendTraversal(adjacency, edge.toEntityId, {
        edge,
        reachedEntityId: edge.fromEntityId,
        traversalDirection: "incoming",
      });
    }
  }
  for (const traversals of adjacency.values()) {
    traversals.sort(compareTraversalEdges);
  }
  return adjacency;
}

function appendTraversal(
  adjacency: Map<string, TraversalEdge[]>,
  entityId: string,
  traversal: TraversalEdge,
): void {
  const current = adjacency.get(entityId) ?? [];
  current.push(traversal);
  adjacency.set(entityId, current);
}

function toAssertion(
  polarity: GraphRelationPolarity,
  relations: readonly GraphRelation[],
): GraphRelationAssertionCandidate {
  const sortedRelations = [...relations].sort(compareRelations);
  const evidenceBySpan = new Map<string, GraphRelationEvidence>();
  for (const relation of sortedRelations) {
    for (const evidence of relation.evidence) {
      const key = evidenceSemanticKey(evidence);
      const existing = evidenceBySpan.get(key);
      if (existing === undefined || evidence.id.localeCompare(existing.id) < 0) {
        evidenceBySpan.set(key, evidence);
      }
    }
  }
  return {
    polarity,
    relationIds: sortedRelations.map(({ id }) => id),
    confidence: Math.max(...sortedRelations.map(({ confidence }) => confidence)),
    evidence: [...evidenceBySpan.values()].sort(compareEvidence).map(cloneEvidence),
  };
}

function toRelationCandidate(
  traversal: TraversalEdge,
  depth: number,
  relationScore: number,
): GraphRelationCandidate {
  const polarities = traversal.edge.assertions.map(({ polarity }) => polarity).sort();
  const duplicateCount =
    traversal.edge.assertions.reduce(
      (total, assertion) => total + assertion.relationIds.length,
      0,
    ) - traversal.edge.assertions.length;
  return {
    candidateId: traversal.edge.candidateId,
    fromEntityId: traversal.edge.fromEntityId,
    toEntityId: traversal.edge.toEntityId,
    kind: traversal.edge.kind,
    depth,
    relationScore,
    assertions: traversal.edge.assertions.map((assertion) => ({
      ...assertion,
      relationIds: [...assertion.relationIds],
      evidence: assertion.evidence.map(cloneEvidence),
    })),
    conflict: {
      detected: polarities.length > 1,
      polarities,
    },
    explanation: {
      scoreSource: "relation",
      traversalDirection: traversal.traversalDirection,
      reachedEntityId: traversal.reachedEntityId,
      duplicateRelationsCollapsed: duplicateCount,
    },
  };
}

function sameSourceVersion(left: GraphSourceVersion, right: GraphSourceVersion): boolean {
  return (
    left.projectId === right.projectId &&
    left.sourceId === right.sourceId &&
    left.sourceVersionId === right.sourceVersionId &&
    left.contentHash === right.contentHash &&
    left.content === right.content &&
    left.createdAt === right.createdAt
  );
}

function sameEntity(left: GraphEntity, right: GraphEntity): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.documentId === right.documentId &&
    left.source.sourceId === right.source.sourceId &&
    left.source.sourceVersionId === right.source.sourceVersionId &&
    left.source.contentHash === right.source.contentHash &&
    left.updatedAt === right.updatedAt &&
    left.deletedAt === right.deletedAt
  );
}

function sameRelation(left: GraphRelation, right: GraphRelation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceVersionKey(sourceId: string, sourceVersionId: string): string {
  return JSON.stringify([sourceId, sourceVersionId]);
}

function semanticEdgeKey(relation: GraphRelation): string {
  return JSON.stringify([relation.fromEntityId, relation.kind, relation.toEntityId]);
}

function evidenceSemanticKey(evidence: GraphRelationEvidence): string {
  return JSON.stringify([
    evidence.sourceId,
    evidence.sourceVersionId,
    evidence.span.startOffset,
    evidence.span.endOffset,
    evidence.spanHash,
  ]);
}

function compareRelations(left: GraphRelation, right: GraphRelation): number {
  return (
    right.confidence - left.confidence ||
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareStoredSourceVersions(
  left: GraphStoredSourceVersion,
  right: GraphStoredSourceVersion,
): number {
  return (
    left.source.sourceId.localeCompare(right.source.sourceId) ||
    left.source.createdAt.localeCompare(right.source.createdAt) ||
    left.source.sourceVersionId.localeCompare(right.source.sourceVersionId)
  );
}

function compareAssertions(
  left: GraphRelationAssertionCandidate,
  right: GraphRelationAssertionCandidate,
): number {
  return left.polarity.localeCompare(right.polarity);
}

function compareSemanticEdges(left: ActiveSemanticEdge, right: ActiveSemanticEdge): number {
  return (
    right.maximumConfidence - left.maximumConfidence ||
    left.candidateId.localeCompare(right.candidateId)
  );
}

function compareTraversalEdges(left: TraversalEdge, right: TraversalEdge): number {
  return (
    right.edge.maximumConfidence - left.edge.maximumConfidence ||
    left.reachedEntityId.localeCompare(right.reachedEntityId) ||
    left.edge.candidateId.localeCompare(right.edge.candidateId) ||
    left.traversalDirection.localeCompare(right.traversalDirection)
  );
}

function compareEvidence(left: GraphRelationEvidence, right: GraphRelationEvidence): number {
  return (
    left.sourceId.localeCompare(right.sourceId) ||
    left.sourceVersionId.localeCompare(right.sourceVersionId) ||
    left.span.startOffset - right.span.startOffset ||
    left.span.endOffset - right.span.endOffset ||
    left.id.localeCompare(right.id)
  );
}

function requireEntity(entities: ReadonlyMap<string, GraphEntity>, entityId: string): GraphEntity {
  const entity = entities.get(entityId);
  if (entity === undefined) {
    throw new SearchIndexError(
      "GRAPH_SEED_NOT_FOUND",
      "A traversed graph entity became unavailable.",
    );
  }
  return entity;
}

function cloneEntity(entity: GraphEntity): GraphEntity {
  return {
    ...entity,
    source: { ...entity.source },
  };
}

function cloneEvidence(evidence: GraphRelationEvidence): GraphRelationEvidence {
  return {
    ...evidence,
    span: { ...evidence.span },
    citation: { ...evidence.citation },
  };
}

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", `${field} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", `${field} is invalid.`);
  }
  return normalized;
}

function requireSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", `${field} must be a SHA-256 digest.`);
  }
  return value;
}

function requireSpanFingerprint(value: string): string {
  if (!/^fnv1a64:[a-f0-9]{16}$/u.test(value)) {
    throw new SearchIndexError("INVALID_GRAPH_EVIDENCE", "Evidence span fingerprint is invalid.");
  }
  return value;
}

function requireIsoDate(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new SearchIndexError("INVALID_GRAPH_QUERY", `${field} must be an ISO timestamp.`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
