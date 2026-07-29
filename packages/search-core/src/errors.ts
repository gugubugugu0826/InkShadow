export type SearchIndexErrorCode =
  | "INVALID_DOCUMENT"
  | "INVALID_EMBEDDING"
  | "INVALID_RELATION"
  | "INVALID_QUERY"
  | "INVALID_GRAPH_SOURCE"
  | "INVALID_GRAPH_ENTITY"
  | "INVALID_GRAPH_EVIDENCE"
  | "INVALID_GRAPH_RELATION"
  | "INVALID_GRAPH_QUERY"
  | "GRAPH_SEED_NOT_FOUND"
  | "GRAPH_VERSION_CONFLICT"
  | "INDEX_PAUSED"
  | "GENERATION_CONFLICT"
  | "PROJECT_MISMATCH";

export class SearchIndexError extends Error {
  public constructor(
    public readonly code: SearchIndexErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchIndexError";
  }
}
