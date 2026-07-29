export const SEARCH_SOURCE_TYPES = [
  "chapter",
  "outline",
  "character",
  "world",
  "foreshadow",
  "material",
  "memory",
] as const;

export type SearchSourceType = (typeof SEARCH_SOURCE_TYPES)[number];

export interface SearchDocument {
  id: string;
  projectId: string;
  sourceType: SearchSourceType;
  sourceId: string;
  sourceVersionId: string;
  title: string;
  text: string;
  contentHash: string;
  updatedAt: string;
  importance?: number;
  pinned?: boolean;
}

export interface EmbeddingConfiguration {
  modelId: string;
  dimension: number;
}

export interface DocumentEmbedding {
  documentId: string;
  projectId: string;
  sourceVersionId: string;
  contentHash: string;
  modelId: string;
  values: readonly number[];
}

export interface RelationEvidence {
  sourceId: string;
  sourceVersionId: string;
  excerpt?: string;
}

export interface SearchRelation {
  id: string;
  projectId: string;
  fromDocumentId: string;
  toDocumentId: string;
  kind: string;
  weight: number;
  evidence: readonly RelationEvidence[];
}

export interface HybridSearchWeights {
  keyword: number;
  vector: number;
  relation: number;
  rule: number;
}

export interface HybridSearchRequest {
  projectId: string;
  query: string;
  candidateDocumentIds?: readonly string[];
  queryEmbedding?: {
    modelId: string;
    values: readonly number[];
  };
  limit?: number;
  weights?: Partial<HybridSearchWeights>;
}

export interface SearchScoreBreakdown {
  keyword: number;
  vector: number;
  relation: number;
  rule: number;
  total: number;
}

export interface SearchEvidence {
  matchedTerms: readonly string[];
  relationIds: readonly string[];
  sourceVersionId: string;
  contentHash: string;
}

export interface HybridSearchHit {
  document: SearchDocument;
  scores: SearchScoreBreakdown;
  evidence: SearchEvidence;
}

export type SearchCapabilityStatus = "ready" | "disabled" | "rebuild_required" | "degraded";
export type IndexMutationStatus = "ready" | "paused";

export interface SearchHealth {
  generation: number;
  mutationStatus: IndexMutationStatus;
  vectorStatus: SearchCapabilityStatus;
  embeddingConfiguration?: EmbeddingConfiguration;
  documentCount: number;
  embeddingCount: number;
  relationCount: number;
  lastRebuiltAt?: string;
  degradedReasons: readonly string[];
}

export interface HybridSearchResponse {
  hits: readonly HybridSearchHit[];
  health: SearchHealth;
  capabilities: {
    keyword: "ready";
    vector: SearchCapabilityStatus;
    relation: "ready";
  };
  notices: readonly string[];
}

export interface ProjectIndexSnapshot {
  projectId: string;
  documents: readonly SearchDocument[];
  embeddings?: readonly DocumentEmbedding[];
  relations?: readonly SearchRelation[];
  rebuiltAt: string;
}
