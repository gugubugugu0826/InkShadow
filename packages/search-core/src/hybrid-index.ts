import type {
  DocumentEmbedding,
  EmbeddingConfiguration,
  HybridSearchHit,
  HybridSearchRequest,
  HybridSearchResponse,
  HybridSearchWeights,
  ProjectIndexSnapshot,
  SearchCapabilityStatus,
  SearchDocument,
  SearchHealth,
  SearchRelation,
} from "./contracts.js";
import { SearchIndexError } from "./errors.js";
import { normalizeSearchText, tokenizeForSearch, validateAndNormalizeQuery } from "./tokenizer.js";

const DEFAULT_WEIGHTS: HybridSearchWeights = {
  keyword: 0.45,
  vector: 0.35,
  relation: 0.1,
  rule: 0.1,
};

const MAX_DOCUMENT_LENGTH = 2_000_000;
const MAX_DOCUMENT_TITLE_LENGTH = 500;
const MAX_RESULTS = 100;
const MAX_RELATION_DEPTH = 2;

interface ProjectState {
  documents: Map<string, SearchDocument>;
  embeddings: Map<string, DocumentEmbedding>;
  relations: Map<string, SearchRelation>;
  lastRebuiltAt?: string;
}

interface MutableIndexState {
  projects: Map<string, ProjectState>;
  generation: number;
}

interface ScoreCandidate {
  document: SearchDocument;
  keyword: number;
  vector: number;
  relation: number;
  rule: number;
  matchedTerms: string[];
  relationIds: string[];
}

export class InMemoryHybridSearchIndex {
  private state: MutableIndexState = {
    projects: new Map(),
    generation: 0,
  };

  private mutationPaused = false;
  private embeddingConfiguration: EmbeddingConfiguration | undefined;
  private vectorStatus: SearchCapabilityStatus = "disabled";
  private degradedReasons = new Set<string>();

  public constructor(configuration?: EmbeddingConfiguration) {
    if (configuration !== undefined) {
      this.embeddingConfiguration = validateEmbeddingConfiguration(configuration);
      this.vectorStatus = "ready";
    }
  }

  public configureEmbedding(configuration?: EmbeddingConfiguration): SearchHealth {
    this.assertMutationAllowed();

    if (configuration === undefined) {
      this.embeddingConfiguration = undefined;
      this.vectorStatus = "disabled";
      this.degradedReasons.delete("embedding_configuration_changed");
      this.state.generation += 1;
      return this.health();
    }

    const validated = validateEmbeddingConfiguration(configuration);
    const current = this.embeddingConfiguration;
    this.embeddingConfiguration = validated;

    if (
      current !== undefined &&
      (current.modelId !== validated.modelId || current.dimension !== validated.dimension) &&
      this.embeddingCount() > 0
    ) {
      this.vectorStatus = "rebuild_required";
      this.degradedReasons.add("embedding_configuration_changed");
    } else {
      this.vectorStatus = "ready";
      this.degradedReasons.delete("embedding_configuration_changed");
    }

    this.state.generation += 1;
    return this.health();
  }

  public pauseIndexing(): SearchHealth {
    this.mutationPaused = true;
    return this.health();
  }

  public resumeIndexing(): SearchHealth {
    this.mutationPaused = false;
    return this.health();
  }

  public upsertDocument(document: SearchDocument, embedding?: DocumentEmbedding): SearchHealth {
    this.assertMutationAllowed();
    const validatedDocument = validateDocument(document);
    const validatedEmbedding =
      embedding === undefined
        ? undefined
        : validateEmbedding(embedding, validatedDocument, this.embeddingConfiguration);
    const project = this.getOrCreateProject(validatedDocument.projectId);

    project.documents.set(validatedDocument.id, validatedDocument);
    if (validatedEmbedding === undefined) {
      project.embeddings.delete(validatedDocument.id);
    } else {
      project.embeddings.set(validatedDocument.id, validatedEmbedding);
    }
    this.removeStaleRelations(project);
    this.state.generation += 1;
    return this.health();
  }

  public deleteDocument(projectId: string, documentId: string): SearchHealth {
    this.assertMutationAllowed();
    const project = this.state.projects.get(requireIdentifier(projectId, "projectId"));
    if (project === undefined) {
      return this.health();
    }

    const existed = project.documents.delete(requireIdentifier(documentId, "documentId"));
    project.embeddings.delete(documentId);
    for (const [relationId, relation] of project.relations) {
      if (relation.fromDocumentId === documentId || relation.toDocumentId === documentId) {
        project.relations.delete(relationId);
      }
    }

    if (existed) {
      this.state.generation += 1;
    }
    return this.health();
  }

  public upsertRelation(relation: SearchRelation): SearchHealth {
    this.assertMutationAllowed();
    const validated = validateRelation(relation);
    const project = this.state.projects.get(validated.projectId);
    if (
      project === undefined ||
      !project.documents.has(validated.fromDocumentId) ||
      !project.documents.has(validated.toDocumentId)
    ) {
      throw new SearchIndexError(
        "INVALID_RELATION",
        "A relation may only reference indexed documents from the same project.",
      );
    }

    project.relations.set(validated.id, validated);
    this.state.generation += 1;
    return this.health();
  }

  public deleteProject(projectId: string): SearchHealth {
    this.assertMutationAllowed();
    if (this.state.projects.delete(requireIdentifier(projectId, "projectId"))) {
      this.state.generation += 1;
    }
    return this.health();
  }

  public markProjectSynced(projectId: string, syncedAt: string): SearchHealth {
    this.assertMutationAllowed();
    const project = this.getOrCreateProject(requireIdentifier(projectId, "projectId"));
    project.lastRebuiltAt = requireIsoDate(syncedAt, "syncedAt");
    return this.health();
  }

  public rebuildProject(
    snapshot: ProjectIndexSnapshot,
    expectedGeneration = this.state.generation,
  ): SearchHealth {
    this.assertMutationAllowed();
    if (expectedGeneration !== this.state.generation) {
      throw new SearchIndexError(
        "GENERATION_CONFLICT",
        "The index changed before the rebuild could be committed.",
      );
    }

    const projectId = requireIdentifier(snapshot.projectId, "projectId");
    const nextProject: ProjectState = {
      documents: new Map(),
      embeddings: new Map(),
      relations: new Map(),
      lastRebuiltAt: requireIsoDate(snapshot.rebuiltAt, "rebuiltAt"),
    };

    for (const document of snapshot.documents) {
      const validated = validateDocument(document);
      if (validated.projectId !== projectId) {
        throw new SearchIndexError(
          "PROJECT_MISMATCH",
          "Every rebuilt document must belong to the requested project.",
        );
      }
      if (nextProject.documents.has(validated.id)) {
        throw new SearchIndexError("INVALID_DOCUMENT", "Document identifiers must be unique.");
      }
      nextProject.documents.set(validated.id, validated);
    }

    for (const embedding of snapshot.embeddings ?? []) {
      const document = nextProject.documents.get(embedding.documentId);
      if (document === undefined) {
        throw new SearchIndexError(
          "INVALID_EMBEDDING",
          "Every embedding must reference a rebuilt document.",
        );
      }
      nextProject.embeddings.set(
        embedding.documentId,
        validateEmbedding(embedding, document, this.embeddingConfiguration),
      );
    }

    for (const relation of snapshot.relations ?? []) {
      const validated = validateRelation(relation);
      if (
        validated.projectId !== projectId ||
        !nextProject.documents.has(validated.fromDocumentId) ||
        !nextProject.documents.has(validated.toDocumentId) ||
        nextProject.relations.has(validated.id)
      ) {
        throw new SearchIndexError(
          "INVALID_RELATION",
          "Every rebuilt relation must be unique and remain inside the project.",
        );
      }
      nextProject.relations.set(validated.id, validated);
    }

    const nextProjects = new Map(this.state.projects);
    nextProjects.set(projectId, nextProject);
    this.state = {
      projects: nextProjects,
      generation: this.state.generation + 1,
    };

    if (this.embeddingConfiguration === undefined) {
      this.vectorStatus = "disabled";
    } else {
      this.vectorStatus = "ready";
      this.degradedReasons.delete("embedding_configuration_changed");
    }
    return this.health();
  }

  public search(request: HybridSearchRequest): HybridSearchResponse {
    const projectId = requireIdentifier(request.projectId, "projectId");
    let query: string;
    try {
      query = validateAndNormalizeQuery(request.query);
    } catch {
      throw new SearchIndexError("INVALID_QUERY", "The search query is empty or too long.");
    }

    const limit = validateLimit(request.limit);
    const weights = normalizeWeights(request.weights);
    const project = this.state.projects.get(projectId);
    const notices: string[] = [];
    const queryEmbedding = this.validateQueryEmbedding(request, notices);
    const candidateDocumentIds = validateCandidateDocumentIds(request.candidateDocumentIds);

    if (project === undefined) {
      return {
        hits: [],
        health: this.health(),
        capabilities: {
          keyword: "ready",
          vector: this.vectorStatus,
          relation: "ready",
        },
        notices,
      };
    }

    const queryTokens = tokenizeForSearch(query);
    const candidates = [...project.documents.values()]
      .filter(
        (document) => candidateDocumentIds === undefined || candidateDocumentIds.has(document.id),
      )
      .map((document) => this.scoreDocument(document, project, query, queryTokens, queryEmbedding));
    this.applyRelationScores(project, candidates);

    const hits = candidates
      .map((candidate) => toHit(candidate, weights))
      .filter((hit) => hit.scores.total > 0)
      .sort(compareHits)
      .slice(0, limit);

    return {
      hits,
      health: this.health(),
      capabilities: {
        keyword: "ready",
        vector: this.vectorStatus,
        relation: "ready",
      },
      notices,
    };
  }

  public health(): SearchHealth {
    const lastRebuiltAt = [...this.state.projects.values()]
      .map((project) => project.lastRebuiltAt)
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);

    return {
      generation: this.state.generation,
      mutationStatus: this.mutationPaused ? "paused" : "ready",
      vectorStatus: this.vectorStatus,
      ...(this.embeddingConfiguration === undefined
        ? {}
        : { embeddingConfiguration: { ...this.embeddingConfiguration } }),
      documentCount: [...this.state.projects.values()].reduce(
        (total, project) => total + project.documents.size,
        0,
      ),
      embeddingCount: this.embeddingCount(),
      relationCount: [...this.state.projects.values()].reduce(
        (total, project) => total + project.relations.size,
        0,
      ),
      ...(lastRebuiltAt === undefined ? {} : { lastRebuiltAt }),
      degradedReasons: [...this.degradedReasons].sort(),
    };
  }

  private scoreDocument(
    document: SearchDocument,
    project: ProjectState,
    query: string,
    queryTokens: readonly string[],
    queryEmbedding: readonly number[] | undefined,
  ): ScoreCandidate {
    const normalizedTitle = normalizeSearchText(document.title);
    const normalizedText = normalizeSearchText(document.text);
    const matchedTerms = queryTokens.filter(
      (token) => normalizedTitle.includes(token) || normalizedText.includes(token),
    );
    const exactMatch = normalizedTitle.includes(query) || normalizedText.includes(query) ? 1 : 0;
    const termCoverage = queryTokens.length === 0 ? 0 : matchedTerms.length / queryTokens.length;
    const titleBoost = normalizedTitle.includes(query) ? 0.2 : 0;
    const keyword = clamp01(termCoverage * 0.75 + exactMatch * 0.15 + titleBoost);

    const embedding = project.embeddings.get(document.id);
    const vector =
      queryEmbedding === undefined || embedding === undefined
        ? 0
        : normalizeCosine(cosineSimilarity(queryEmbedding, embedding.values));
    const importance = document.importance ?? 0;
    const rule = clamp01(importance * 0.7 + (document.pinned === true ? 0.3 : 0));

    return {
      document,
      keyword,
      vector,
      relation: 0,
      rule,
      matchedTerms,
      relationIds: [],
    };
  }

  private applyRelationScores(project: ProjectState, candidates: ScoreCandidate[]): void {
    const candidateById = new Map(
      candidates.map((candidate) => [candidate.document.id, candidate]),
    );
    const seeds = candidates
      .filter((candidate) => candidate.keyword > 0 || candidate.vector > 0)
      .sort((left, right) => right.keyword + right.vector - (left.keyword + left.vector))
      .slice(0, 5);
    const adjacency = new Map<string, SearchRelation[]>();

    for (const relation of project.relations.values()) {
      appendRelation(adjacency, relation.fromDocumentId, relation);
      appendRelation(adjacency, relation.toDocumentId, relation);
    }

    for (const seed of seeds) {
      const visited = new Set([seed.document.id]);
      let frontier = [seed.document.id];
      for (let depth = 1; depth <= MAX_RELATION_DEPTH && frontier.length > 0; depth += 1) {
        const next: string[] = [];
        for (const documentId of frontier) {
          for (const relation of adjacency.get(documentId) ?? []) {
            const relatedId =
              relation.fromDocumentId === documentId
                ? relation.toDocumentId
                : relation.fromDocumentId;
            if (visited.has(relatedId)) {
              continue;
            }
            visited.add(relatedId);
            next.push(relatedId);
            const candidate = candidateById.get(relatedId);
            if (candidate !== undefined) {
              candidate.relation = Math.max(candidate.relation, clamp01(relation.weight / depth));
              candidate.relationIds.push(relation.id);
            }
          }
        }
        frontier = next;
      }
    }

    for (const candidate of candidates) {
      candidate.relationIds = [...new Set(candidate.relationIds)].sort();
    }
  }

  private validateQueryEmbedding(
    request: HybridSearchRequest,
    notices: string[],
  ): readonly number[] | undefined {
    if (request.queryEmbedding === undefined) {
      if (this.embeddingConfiguration !== undefined) {
        notices.push("vector_query_unavailable_keyword_relation_fallback");
      }
      return undefined;
    }

    const configuration = this.embeddingConfiguration;
    if (
      configuration === undefined ||
      this.vectorStatus !== "ready" ||
      request.queryEmbedding.modelId !== configuration.modelId ||
      request.queryEmbedding.values.length !== configuration.dimension ||
      !request.queryEmbedding.values.every(Number.isFinite)
    ) {
      notices.push("vector_query_incompatible_keyword_relation_fallback");
      return undefined;
    }
    return [...request.queryEmbedding.values];
  }

  private getOrCreateProject(projectId: string): ProjectState {
    const current = this.state.projects.get(projectId);
    if (current !== undefined) {
      return current;
    }
    const created: ProjectState = {
      documents: new Map(),
      embeddings: new Map(),
      relations: new Map(),
    };
    this.state.projects.set(projectId, created);
    return created;
  }

  private removeStaleRelations(project: ProjectState): void {
    for (const [relationId, relation] of project.relations) {
      if (
        !project.documents.has(relation.fromDocumentId) ||
        !project.documents.has(relation.toDocumentId)
      ) {
        project.relations.delete(relationId);
      }
    }
  }

  private embeddingCount(): number {
    return [...this.state.projects.values()].reduce(
      (total, project) => total + project.embeddings.size,
      0,
    );
  }

  private assertMutationAllowed(): void {
    if (this.mutationPaused) {
      throw new SearchIndexError("INDEX_PAUSED", "Index mutations are paused.");
    }
  }
}

function validateDocument(document: SearchDocument): SearchDocument {
  const title = document.title.trim();
  const text = document.text.normalize("NFC");
  const importance = document.importance ?? 0;
  if (
    title.length === 0 ||
    title.length > MAX_DOCUMENT_TITLE_LENGTH ||
    text.length > MAX_DOCUMENT_LENGTH ||
    !Number.isFinite(importance) ||
    importance < 0 ||
    importance > 1
  ) {
    throw new SearchIndexError("INVALID_DOCUMENT", "Search document fields are invalid.");
  }

  return {
    ...document,
    id: requireIdentifier(document.id, "document.id"),
    projectId: requireIdentifier(document.projectId, "document.projectId"),
    sourceId: requireIdentifier(document.sourceId, "document.sourceId"),
    sourceVersionId: requireIdentifier(document.sourceVersionId, "document.sourceVersionId"),
    contentHash: requireIdentifier(document.contentHash, "document.contentHash"),
    updatedAt: requireIsoDate(document.updatedAt, "document.updatedAt"),
    title,
    text,
    importance,
    pinned: document.pinned === true,
  };
}

function validateEmbeddingConfiguration(
  configuration: EmbeddingConfiguration,
): EmbeddingConfiguration {
  const modelId = requireIdentifier(configuration.modelId, "modelId");
  if (
    !Number.isSafeInteger(configuration.dimension) ||
    configuration.dimension < 1 ||
    configuration.dimension > 65_536
  ) {
    throw new SearchIndexError("INVALID_EMBEDDING", "Embedding dimension is invalid.");
  }
  return { modelId, dimension: configuration.dimension };
}

function validateEmbedding(
  embedding: DocumentEmbedding,
  document: SearchDocument,
  configuration?: EmbeddingConfiguration,
): DocumentEmbedding {
  if (
    configuration === undefined ||
    embedding.documentId !== document.id ||
    embedding.projectId !== document.projectId ||
    embedding.sourceVersionId !== document.sourceVersionId ||
    embedding.contentHash !== document.contentHash ||
    embedding.modelId !== configuration.modelId ||
    embedding.values.length !== configuration.dimension ||
    !embedding.values.every(Number.isFinite)
  ) {
    throw new SearchIndexError(
      "INVALID_EMBEDDING",
      "Embedding provenance, model, dimension, or values are invalid.",
    );
  }

  return {
    ...embedding,
    values: [...embedding.values],
  };
}

function validateRelation(relation: SearchRelation): SearchRelation {
  if (
    relation.fromDocumentId === relation.toDocumentId ||
    !Number.isFinite(relation.weight) ||
    relation.weight <= 0 ||
    relation.weight > 1 ||
    relation.evidence.length === 0
  ) {
    throw new SearchIndexError("INVALID_RELATION", "Search relation fields are invalid.");
  }

  return {
    ...relation,
    id: requireIdentifier(relation.id, "relation.id"),
    projectId: requireIdentifier(relation.projectId, "relation.projectId"),
    fromDocumentId: requireIdentifier(relation.fromDocumentId, "relation.fromDocumentId"),
    toDocumentId: requireIdentifier(relation.toDocumentId, "relation.toDocumentId"),
    kind: requireIdentifier(relation.kind, "relation.kind"),
    evidence: relation.evidence.map((evidence) => ({
      sourceId: requireIdentifier(evidence.sourceId, "relation.evidence.sourceId"),
      sourceVersionId: requireIdentifier(
        evidence.sourceVersionId,
        "relation.evidence.sourceVersionId",
      ),
      ...(evidence.excerpt === undefined ? {} : { excerpt: evidence.excerpt.slice(0, 1_000) }),
    })),
  };
}

function normalizeWeights(weights?: Partial<HybridSearchWeights>): HybridSearchWeights {
  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  const entries = Object.values(merged);
  if (entries.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new SearchIndexError("INVALID_QUERY", "Search weights must be finite and non-negative.");
  }
  const total = entries.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    throw new SearchIndexError("INVALID_QUERY", "At least one search weight must be positive.");
  }
  return {
    keyword: merged.keyword / total,
    vector: merged.vector / total,
    relation: merged.relation / total,
    rule: merged.rule / total,
  };
}

function validateLimit(limit?: number): number {
  if (limit === undefined) {
    return 20;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new SearchIndexError(
      "INVALID_QUERY",
      `Search limit must be between 1 and ${String(MAX_RESULTS)}.`,
    );
  }
  return limit;
}

function validateCandidateDocumentIds(values?: readonly string[]): ReadonlySet<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (values.length > 100_000) {
    throw new SearchIndexError(
      "INVALID_QUERY",
      "Search candidate document count exceeds the supported bound.",
    );
  }
  return new Set(values.map((value) => requireIdentifier(value, "candidateDocumentId")));
}

function toHit(candidate: ScoreCandidate, weights: HybridSearchWeights): HybridSearchHit {
  const total = clamp01(
    candidate.keyword * weights.keyword +
      candidate.vector * weights.vector +
      candidate.relation * weights.relation +
      candidate.rule * weights.rule,
  );
  return {
    document: { ...candidate.document },
    scores: {
      keyword: round(candidate.keyword),
      vector: round(candidate.vector),
      relation: round(candidate.relation),
      rule: round(candidate.rule),
      total: round(total),
    },
    evidence: {
      matchedTerms: [...candidate.matchedTerms],
      relationIds: [...candidate.relationIds],
      sourceVersionId: candidate.document.sourceVersionId,
      contentHash: candidate.document.contentHash,
    },
  };
}

function compareHits(left: HybridSearchHit, right: HybridSearchHit): number {
  return (
    right.scores.total - left.scores.total ||
    right.scores.keyword - left.scores.keyword ||
    right.document.updatedAt.localeCompare(left.document.updatedAt) ||
    left.document.id.localeCompare(right.document.id)
  );
}

function appendRelation(
  adjacency: Map<string, SearchRelation[]>,
  documentId: string,
  relation: SearchRelation,
): void {
  const current = adjacency.get(documentId) ?? [];
  current.push(relation);
  adjacency.set(documentId, current);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function normalizeCosine(value: number): number {
  return clamp01((value + 1) / 2);
}

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new SearchIndexError("INVALID_DOCUMENT", `${field} is invalid.`);
  }
  return normalized;
}

function requireIsoDate(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new SearchIndexError("INVALID_DOCUMENT", `${field} must be an ISO timestamp.`);
  }
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
