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

export const SEARCH_CHUNK_KINDS = [
  "chapter",
  "scene",
  "event",
  "paragraph",
  "dialogue",
  "story_fact_evidence",
] as const;

export type SearchChunkKind = (typeof SEARCH_CHUNK_KINDS)[number];

export const SEARCH_DOCUMENT_AUTHORITIES = [
  "accepted_text",
  "confirmed_fact",
  "rebuildable",
] as const;

export type SearchDocumentAuthority = (typeof SEARCH_DOCUMENT_AUTHORITIES)[number];

export const SEARCH_DOCUMENT_PRIVACY_MODES = ["standard", "local_only"] as const;

export type SearchDocumentPrivacyMode = (typeof SEARCH_DOCUMENT_PRIVACY_MODES)[number];

export const SEARCH_DOCUMENT_CURRENTNESS = ["current", "stale", "legacy_unknown"] as const;

export type SearchDocumentCurrentness = (typeof SEARCH_DOCUMENT_CURRENTNESS)[number];

export const SEARCH_RETRIEVAL_TASK_TYPES = [
  "project_search",
  "continuation",
  "consistency",
  "agent_fts",
] as const;

export type SearchRetrievalTaskType = (typeof SEARCH_RETRIEVAL_TASK_TYPES)[number];

export const SEARCH_RETRIEVAL_PRIVACY_SCOPES = [
  "standard_only",
  "local_only",
  "include_local_only",
] as const;

export type SearchRetrievalPrivacyScope = (typeof SEARCH_RETRIEVAL_PRIVACY_SCOPES)[number];

/**
 * Every field is a hard pre-retrieval filter when present. Callers can leave a
 * field absent only when the source does not yet provide that authority; the
 * store reports the omission instead of inventing branch, POV, or chronology.
 */
export interface SearchRetrievalScope {
  readonly projectId: string;
  readonly taskType: SearchRetrievalTaskType;
  /**
   * Verified local contexts use include_local_only; remote dispatch must use
   * standard_only. local_only is reserved for explicit private-source diagnostics.
   */
  readonly privacy: SearchRetrievalPrivacyScope;
  /** current means the active immutable version of every included source. */
  readonly currentness: SearchDocumentCurrentness;
  /** A source/version pair narrows a diagnostic query to one immutable source. */
  readonly sourceId?: string;
  readonly currentVersionId?: string;
  readonly branchId?: string | null;
  readonly povCharacterId?: string | null;
  readonly maximumStoryOrder?: number;
}

export interface SearchRetrievalScopeTrace {
  readonly taskType: SearchRetrievalTaskType;
  /** Missing caller authority. Generation/Agent queries reject these omissions. */
  readonly omittedHardFilters: readonly ("branch" | "pov" | "story_order")[];
  /** Returned canon that is explicitly neutral because that authority is absent. */
  readonly authorityNeutralOmissions: readonly ("branch" | "pov" | "story_order")[];
  readonly versionMode: "per_source_current" | "single_source_version";
}

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
  /** Defaults to chapter only while decoding pre-0070 derived snapshots. */
  chunkKind?: SearchChunkKind;
  parentDocumentId?: string | null;
  /** JavaScript/DOM-compatible UTF-16 offsets into the accepted source text. */
  utf16Start?: number;
  utf16End?: number;
  /** Exact UTF-16 length of the authoritative source version. */
  sourceLength?: number;
  sceneId?: string | null;
  eventId?: string | null;
  characterIds?: readonly string[];
  locationIds?: readonly string[];
  /** Authoritative narrative-time locator, never inferred from prose. */
  storyTime?: string | null;
  branchId?: string | null;
  povCharacterId?: string | null;
  storyOrder?: number | null;
  authority?: SearchDocumentAuthority;
  privacy?: SearchDocumentPrivacyMode;
  /** Defaults to legacy_unknown, never current, for pre-0070 rows. */
  currentness?: SearchDocumentCurrentness;
  omittedScopeFields?: readonly string[];
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
  /** Present when a persistent hard-filter scope selected the candidate set. */
  retrievalScopeTrace?: SearchRetrievalScopeTrace;
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
