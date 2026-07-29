import type {
  DocumentEmbedding,
  EmbeddingConfiguration,
  SearchCapabilityStatus,
} from "@inkshadow/search-core";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_DIMENSION = 4_096;
const MAX_EMBEDDINGS_PER_PROJECT = 25_000;
const MAX_RESULT_LIMIT = 1_000;

export type SearchVectorIndexStoreErrorCode =
  | "VECTOR_INDEX_VALIDATION_FAILED"
  | "VECTOR_INDEX_CONFLICT"
  | "VECTOR_INDEX_CORRUPT"
  | "VECTOR_INDEX_UNAVAILABLE";

export class SearchVectorIndexStoreError extends Error {
  public constructor(
    public readonly code: SearchVectorIndexStoreErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SearchVectorIndexStoreError";
  }
}

export interface SearchVectorIndexState {
  readonly projectId: string;
  readonly generation: number;
  readonly configuration: EmbeddingConfiguration;
  readonly status: Exclude<SearchCapabilityStatus, "disabled">;
  readonly embeddingCount: number;
  readonly lastRebuiltAt: string | null;
  readonly updatedAt: string;
}

export interface StoredSearchVectorProject {
  readonly state: SearchVectorIndexState;
  readonly embeddings: readonly DocumentEmbedding[];
}

export interface ConfigureSearchVectorProjectInput {
  readonly projectId: string;
  readonly expectedGeneration: number;
  readonly configuration: EmbeddingConfiguration;
  readonly configuredAt: string;
}

export interface ReplaceSearchVectorProjectInput {
  readonly projectId: string;
  readonly expectedGeneration: number;
  readonly configuration: EmbeddingConfiguration;
  readonly embeddings: readonly DocumentEmbedding[];
  readonly rebuiltAt: string;
}

export interface MarkSearchVectorProjectRebuildRequiredInput {
  readonly projectId: string;
  readonly expectedGeneration: number;
  readonly markedAt: string;
}

export interface SearchVectorQueryInput {
  readonly projectId: string;
  readonly modelId: string;
  readonly values: readonly number[];
  readonly limit?: number;
  readonly candidateDocumentIds?: readonly string[];
}

export interface SearchVectorHit {
  readonly documentId: string;
  readonly similarity: number;
  readonly sourceVersionId: string;
  readonly contentHash: string;
}

export interface SearchVectorQueryResult {
  readonly status: SearchCapabilityStatus;
  readonly generation: number | null;
  readonly hits: readonly SearchVectorHit[];
  readonly notice:
    | null
    | "vector_index_not_configured"
    | "vector_index_rebuild_required"
    | "vector_index_degraded"
    | "vector_query_incompatible"
    | "vector_exact_scan_limit_exceeded";
}

interface StateRow {
  readonly projectId: string;
  readonly generation: number;
  readonly modelId: string;
  readonly dimension: number;
  readonly status: string;
  readonly lastRebuiltAt: string | null;
  readonly updatedAt: string;
  readonly embeddingCount: number;
}

interface VectorRow {
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceVersionId: string;
  readonly contentHash: string;
  readonly modelId: string;
  readonly dimension: number;
  readonly vectorBlob: unknown;
  readonly vectorNorm: number;
}

interface SearchDocumentProvenanceRow {
  readonly documentId: string;
  readonly sourceVersionId: string;
  readonly contentHash: string;
}

export class SearchVectorSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadProject(projectIdValue: string): Promise<StoredSearchVectorProject | null> {
    const projectId = validateIdentifier(projectIdValue, "projectId");
    try {
      const state = await readState(this.executor, projectId);
      if (state === null) {
        return null;
      }
      const rows = await readVectorRows(this.executor, projectId);
      if (rows.length !== state.embeddingCount) {
        throw corrupt("Vector index state does not match its embedding rows.");
      }
      const embeddings = rows.map((row) => rowToEmbedding(row, state.configuration));
      return Object.freeze({
        state,
        embeddings: Object.freeze(embeddings),
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to load the local vector index.");
    }
  }

  public async configureProject(
    input: ConfigureSearchVectorProjectInput,
  ): Promise<SearchVectorIndexState> {
    const projectId = validateIdentifier(input.projectId, "projectId");
    const configuration = validateConfiguration(input.configuration);
    const configuredAt = validateTimestamp(input.configuredAt, "configuredAt");
    validateExpectedGeneration(input.expectedGeneration);

    try {
      return await this.executor.transaction(async (transaction) => {
        const current = await readState(transaction, projectId);
        assertExpectedGeneration(current, input.expectedGeneration);
        if (
          current !== null &&
          current.configuration.modelId === configuration.modelId &&
          current.configuration.dimension === configuration.dimension
        ) {
          return current;
        }
        const generation = input.expectedGeneration + 1;
        if (current === null) {
          await transaction.execute(
            `INSERT INTO search_vector_index_state (
               project_id, schema_version, generation, model_id, dimension,
               status, last_rebuilt_at, updated_at
             ) VALUES (?, 1, ?, ?, ?, 'rebuild_required', NULL, ?)`,
            [projectId, generation, configuration.modelId, configuration.dimension, configuredAt],
          );
        } else {
          const updated = await transaction.execute(
            `UPDATE search_vector_index_state
             SET generation = ?, model_id = ?, dimension = ?,
                 status = 'rebuild_required', updated_at = ?
             WHERE project_id = ? AND generation = ?`,
            [
              generation,
              configuration.modelId,
              configuration.dimension,
              configuredAt,
              projectId,
              input.expectedGeneration,
            ],
          );
          if (updated.rowsAffected !== 1) {
            throw conflict(input.expectedGeneration, null);
          }
        }
        return requireState(transaction, projectId);
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to configure the local vector index.");
    }
  }

  public async replaceProject(
    input: ReplaceSearchVectorProjectInput,
  ): Promise<SearchVectorIndexState> {
    const projectId = validateIdentifier(input.projectId, "projectId");
    const configuration = validateConfiguration(input.configuration);
    const rebuiltAt = validateTimestamp(input.rebuiltAt, "rebuiltAt");
    validateExpectedGeneration(input.expectedGeneration);
    const embeddings = validateReplacementEmbeddings(projectId, configuration, input.embeddings);

    try {
      return await this.executor.transaction(async (transaction) => {
        const current = await readState(transaction, projectId);
        assertExpectedGeneration(current, input.expectedGeneration);
        const documents = await readDocumentProvenance(transaction, projectId);
        validateEmbeddingSources(embeddings, documents);
        const generation = input.expectedGeneration + 1;

        if (current === null) {
          await transaction.execute(
            `INSERT INTO search_vector_index_state (
               project_id, schema_version, generation, model_id, dimension,
               status, last_rebuilt_at, updated_at
             ) VALUES (?, 1, ?, ?, ?, 'ready', ?, ?)`,
            [
              projectId,
              generation,
              configuration.modelId,
              configuration.dimension,
              rebuiltAt,
              rebuiltAt,
            ],
          );
        } else {
          const updated = await transaction.execute(
            `UPDATE search_vector_index_state
             SET generation = ?, model_id = ?, dimension = ?, status = 'ready',
                 last_rebuilt_at = ?, updated_at = ?
             WHERE project_id = ? AND generation = ?`,
            [
              generation,
              configuration.modelId,
              configuration.dimension,
              rebuiltAt,
              rebuiltAt,
              projectId,
              input.expectedGeneration,
            ],
          );
          if (updated.rowsAffected !== 1) {
            throw conflict(input.expectedGeneration, null);
          }
          await transaction.execute("DELETE FROM search_vector_embeddings WHERE project_id = ?", [
            projectId,
          ]);
        }

        for (const embedding of embeddings) {
          const encoded = encodeVector(embedding.values);
          await transaction.execute(
            `INSERT INTO search_vector_embeddings (
               project_id, document_id, source_version_id, content_hash,
               model_id, dimension, vector_blob, vector_norm, indexed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              projectId,
              embedding.documentId,
              embedding.sourceVersionId,
              embedding.contentHash,
              embedding.modelId,
              configuration.dimension,
              encoded.bytes,
              encoded.norm,
              rebuiltAt,
            ],
          );
        }
        return requireState(transaction, projectId);
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to replace the local vector index atomically.");
    }
  }

  public async markProjectRebuildRequired(
    input: MarkSearchVectorProjectRebuildRequiredInput,
  ): Promise<SearchVectorIndexState | null> {
    const projectId = validateIdentifier(input.projectId, "projectId");
    const markedAt = validateTimestamp(input.markedAt, "markedAt");
    validateExpectedGeneration(input.expectedGeneration);

    try {
      return await this.executor.transaction(async (transaction) => {
        const current = await readState(transaction, projectId);
        assertExpectedGeneration(current, input.expectedGeneration);
        if (current === null || current.status === "rebuild_required") {
          return current;
        }
        const generation = current.generation + 1;
        const updated = await transaction.execute(
          `UPDATE search_vector_index_state
           SET generation = ?, status = 'rebuild_required', updated_at = ?
           WHERE project_id = ? AND generation = ?`,
          [generation, markedAt, projectId, current.generation],
        );
        if (updated.rowsAffected !== 1) {
          throw conflict(current.generation, null);
        }
        return requireState(transaction, projectId);
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to mark the local vector index for rebuild.");
    }
  }

  public async findNearest(input: SearchVectorQueryInput): Promise<SearchVectorQueryResult> {
    const projectId = validateIdentifier(input.projectId, "projectId");
    const modelId = validateModelId(input.modelId);
    const limit = validateLimit(input.limit ?? 20);
    const candidates = validateCandidateIds(input.candidateDocumentIds);

    try {
      const state = await readState(this.executor, projectId);
      if (state === null) {
        return emptyQueryResult("disabled", null, "vector_index_not_configured");
      }
      if (state.status !== "ready") {
        return emptyQueryResult(
          state.status,
          state.generation,
          state.status === "rebuild_required"
            ? "vector_index_rebuild_required"
            : "vector_index_degraded",
        );
      }
      if (
        state.configuration.modelId !== modelId ||
        state.configuration.dimension !== input.values.length
      ) {
        return emptyQueryResult("ready", state.generation, "vector_query_incompatible");
      }
      const query = validateVector(input.values, state.configuration.dimension, "query vector");
      const rows = await readVectorRows(this.executor, projectId);
      if (rows.length !== state.embeddingCount) {
        throw corrupt("A vector source changed without a completed index rebuild.");
      }
      const filtered =
        candidates === null ? rows : rows.filter(({ documentId }) => candidates.has(documentId));
      if (filtered.length > MAX_EMBEDDINGS_PER_PROJECT) {
        return emptyQueryResult("degraded", state.generation, "vector_exact_scan_limit_exceeded");
      }

      const hits = filtered
        .map((row): SearchVectorHit => {
          const embedding = rowToEmbedding(row, state.configuration);
          return Object.freeze({
            documentId: embedding.documentId,
            similarity: round(normalizeCosine(cosine(query, embedding.values))),
            sourceVersionId: embedding.sourceVersionId,
            contentHash: embedding.contentHash,
          });
        })
        .sort(
          (left, right) =>
            right.similarity - left.similarity || left.documentId.localeCompare(right.documentId),
        )
        .slice(0, limit);
      return Object.freeze({
        status: "ready",
        generation: state.generation,
        hits: Object.freeze(hits),
        notice: null,
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to query the local vector index.");
    }
  }

  public async resetProject(projectIdValue: string): Promise<void> {
    const projectId = validateIdentifier(projectIdValue, "projectId");
    try {
      await this.executor.execute("DELETE FROM search_vector_index_state WHERE project_id = ?", [
        projectId,
      ]);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to reset the local vector index.");
    }
  }
}

function validateReplacementEmbeddings(
  projectId: string,
  configuration: EmbeddingConfiguration,
  values: readonly DocumentEmbedding[],
): readonly DocumentEmbedding[] {
  if (values.length > MAX_EMBEDDINGS_PER_PROJECT) {
    throw validation("The exact vector index exceeds the supported project bound.");
  }
  const seen = new Set<string>();
  return Object.freeze(
    values.map((value) => {
      const documentId = validateIdentifier(value.documentId, "documentId");
      if (seen.has(documentId)) {
        throw validation("A vector rebuild contains a duplicate document.");
      }
      seen.add(documentId);
      if (
        validateIdentifier(value.projectId, "embeddingProjectId") !== projectId ||
        validateModelId(value.modelId) !== configuration.modelId
      ) {
        throw validation("A vector embedding is outside the requested project configuration.");
      }
      return Object.freeze({
        documentId,
        projectId,
        sourceVersionId: validateIdentifier(value.sourceVersionId, "sourceVersionId"),
        contentHash: validateHash(value.contentHash),
        modelId: configuration.modelId,
        values: Object.freeze(
          validateVector(value.values, configuration.dimension, "document vector"),
        ),
      });
    }),
  );
}

function validateEmbeddingSources(
  embeddings: readonly DocumentEmbedding[],
  rows: readonly SearchDocumentProvenanceRow[],
): void {
  const sources = new Map(rows.map((row) => [row.documentId, row]));
  for (const embedding of embeddings) {
    const source = sources.get(embedding.documentId);
    if (source === undefined) {
      throw conflict(0, null, "An embedding source changed before the rebuild was committed.");
    }
    if (
      source.sourceVersionId !== embedding.sourceVersionId ||
      source.contentHash !== embedding.contentHash
    ) {
      throw conflict(0, null, "An embedding source changed before the rebuild was committed.");
    }
  }
}

async function readState(
  executor: TransactionExecutor,
  projectId: string,
): Promise<SearchVectorIndexState | null> {
  const rows = await executor.select<StateRow>(
    `SELECT
       state.project_id AS projectId,
       state.generation AS generation,
       state.model_id AS modelId,
       state.dimension AS dimension,
       state.status AS status,
       state.last_rebuilt_at AS lastRebuiltAt,
       state.updated_at AS updatedAt,
       COUNT(embedding.document_id) AS embeddingCount
     FROM search_vector_index_state AS state
     LEFT JOIN search_vector_embeddings AS embedding
       ON embedding.project_id = state.project_id
     WHERE state.project_id = ?
     GROUP BY
       state.project_id, state.generation, state.model_id, state.dimension,
       state.status, state.last_rebuilt_at, state.updated_at`,
    [projectId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const status = parseStatus(row.status);
  const lastRebuiltAt =
    row.lastRebuiltAt === null ? null : validateTimestamp(row.lastRebuiltAt, "lastRebuiltAt");
  if (status === "ready" && lastRebuiltAt === null) {
    throw corrupt("A ready vector index has no rebuild timestamp.");
  }
  return Object.freeze({
    projectId: validateIdentifier(row.projectId, "storedProjectId"),
    generation: validateStoredGeneration(row.generation),
    configuration: validateConfiguration({
      modelId: row.modelId,
      dimension: row.dimension,
    }),
    status,
    embeddingCount: validateCount(row.embeddingCount),
    lastRebuiltAt,
    updatedAt: validateTimestamp(row.updatedAt, "updatedAt"),
  });
}

async function requireState(
  executor: TransactionExecutor,
  projectId: string,
): Promise<SearchVectorIndexState> {
  const state = await readState(executor, projectId);
  if (state === null) {
    throw corrupt("The vector index state disappeared during its transaction.");
  }
  return state;
}

function readVectorRows(executor: TransactionExecutor, projectId: string): Promise<VectorRow[]> {
  return executor.select<VectorRow>(
    `SELECT
       embedding.project_id AS projectId,
       embedding.document_id AS documentId,
       embedding.source_version_id AS sourceVersionId,
       embedding.content_hash AS contentHash,
       embedding.model_id AS modelId,
       embedding.dimension AS dimension,
       embedding.vector_blob AS vectorBlob,
       embedding.vector_norm AS vectorNorm
     FROM search_vector_embeddings AS embedding
     JOIN search_index_documents AS document
       ON document.project_id = embedding.project_id
      AND document.document_id = embedding.document_id
      AND document.source_version_id = embedding.source_version_id
      AND document.content_hash = embedding.content_hash
     WHERE embedding.project_id = ?
     ORDER BY embedding.document_id ASC`,
    [projectId],
  );
}

function readDocumentProvenance(
  executor: TransactionExecutor,
  projectId: string,
): Promise<SearchDocumentProvenanceRow[]> {
  return executor.select<SearchDocumentProvenanceRow>(
    `SELECT
       document_id AS documentId,
       source_version_id AS sourceVersionId,
       content_hash AS contentHash
     FROM search_index_documents
     WHERE project_id = ?
     ORDER BY document_id ASC`,
    [projectId],
  );
}

function rowToEmbedding(row: VectorRow, configuration: EmbeddingConfiguration): DocumentEmbedding {
  if (
    validateModelId(row.modelId) !== configuration.modelId ||
    row.dimension !== configuration.dimension
  ) {
    throw corrupt("A stored vector does not match the active embedding configuration.");
  }
  const values = decodeVector(row.vectorBlob, configuration.dimension);
  const norm = vectorNorm(values);
  if (
    !Number.isFinite(row.vectorNorm) ||
    row.vectorNorm <= 0 ||
    Math.abs(norm - row.vectorNorm) > Math.max(1e-5, norm * 1e-5)
  ) {
    throw corrupt("A stored vector norm is inconsistent with its bytes.");
  }
  return Object.freeze({
    documentId: validateIdentifier(row.documentId, "storedDocumentId"),
    projectId: validateIdentifier(row.projectId, "storedProjectId"),
    sourceVersionId: validateIdentifier(row.sourceVersionId, "storedSourceVersionId"),
    contentHash: validateHash(row.contentHash),
    modelId: configuration.modelId,
    values: Object.freeze(values),
  });
}

function validateConfiguration(value: EmbeddingConfiguration): EmbeddingConfiguration {
  if (
    !Number.isSafeInteger(value.dimension) ||
    value.dimension < 1 ||
    value.dimension > MAX_DIMENSION
  ) {
    throw validation("The embedding dimension is outside the supported range.");
  }
  return Object.freeze({
    modelId: validateModelId(value.modelId),
    dimension: value.dimension,
  });
}

function validateModelId(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > MAX_MODEL_ID_LENGTH ||
    value.includes("\u0000")
  ) {
    throw validation("The embedding model identifier is invalid.");
  }
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes("\u0000")
  ) {
    throw validation(`The ${label} is invalid.`);
  }
  return value;
}

function validateHash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw validation("The vector content hash is invalid.");
  }
  return value;
}

function validateTimestamp(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    !value.endsWith("Z")
  ) {
    throw validation(`The ${label} timestamp is invalid.`);
  }
  return value;
}

function validateExpectedGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validation("The expected vector-index generation is invalid.");
  }
}

function validateStoredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw corrupt("The stored vector-index generation is invalid.");
  }
  return value;
}

function validateCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EMBEDDINGS_PER_PROJECT) {
    throw corrupt("The stored vector-index count is invalid.");
  }
  return value;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESULT_LIMIT) {
    throw validation("The vector result limit is invalid.");
  }
  return value;
}

function validateCandidateIds(values: readonly string[] | undefined): ReadonlySet<string> | null {
  if (values === undefined) {
    return null;
  }
  if (values.length > 100_000) {
    throw validation("The vector candidate set exceeds the supported bound.");
  }
  return new Set(values.map((value) => validateIdentifier(value, "candidateDocumentId")));
}

function validateVector(
  values: readonly number[],
  dimension: number,
  label: string,
): readonly number[] {
  if (values.length !== dimension || !values.every(Number.isFinite)) {
    throw validation(`The ${label} has an invalid dimension or value.`);
  }
  if (vectorNorm(values) === 0) {
    throw validation(`The ${label} cannot be a zero vector.`);
  }
  return Array.from(values);
}

function encodeVector(values: readonly number[]): Readonly<{ bytes: Uint8Array; norm: number }> {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) {
    view.setFloat32(index * 4, value, true);
  }
  const rounded = decodeVector(bytes, values.length);
  return Object.freeze({ bytes, norm: vectorNorm(rounded) });
}

function decodeVector(value: unknown, dimension: number): number[] {
  const bytes = toByteArray(value);
  if (bytes.byteLength !== dimension * 4) {
    throw corrupt("A stored vector byte length is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Array.from({ length: dimension }, (_, index) => view.getFloat32(index * 4, true));
  if (!values.every(Number.isFinite) || vectorNorm(values) === 0) {
    throw corrupt("A stored vector contains invalid values.");
  }
  return values;
}

function toByteArray(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item < 256)
  ) {
    return Uint8Array.from(value as number[]);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    Array.isArray((value as { readonly data?: unknown }).data)
  ) {
    return toByteArray((value as { readonly data: unknown }).data);
  }
  throw corrupt("A stored vector is not a supported byte representation.");
}

function vectorNorm(values: readonly number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftSquared) * Math.sqrt(rightSquared);
  return denominator === 0 ? 0 : dot / denominator;
}

function normalizeCosine(value: number): number {
  return Math.min(1, Math.max(0, (value + 1) / 2));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseStatus(value: string): Exclude<SearchCapabilityStatus, "disabled"> {
  if (value === "ready" || value === "rebuild_required" || value === "degraded") {
    return value;
  }
  throw corrupt("The stored vector-index status is invalid.");
}

function assertExpectedGeneration(
  current: SearchVectorIndexState | null,
  expectedGeneration: number,
): void {
  const actual = current?.generation ?? 0;
  if (actual !== expectedGeneration) {
    throw conflict(expectedGeneration, actual);
  }
}

function emptyQueryResult(
  status: SearchCapabilityStatus,
  generation: number | null,
  notice: Exclude<SearchVectorQueryResult["notice"], null>,
): SearchVectorQueryResult {
  return Object.freeze({
    status,
    generation,
    hits: Object.freeze([]),
    notice,
  });
}

function validation(message: string): SearchVectorIndexStoreError {
  return new SearchVectorIndexStoreError("VECTOR_INDEX_VALIDATION_FAILED", message, false);
}

function conflict(
  expected: number,
  actual: number | null,
  message = "The local vector index changed before the operation could commit.",
): SearchVectorIndexStoreError {
  return new SearchVectorIndexStoreError(
    "VECTOR_INDEX_CONFLICT",
    `${message} Expected generation ${String(expected)}; actual ${actual === null ? "unknown" : String(actual)}.`,
    true,
  );
}

function corrupt(message: string): SearchVectorIndexStoreError {
  return new SearchVectorIndexStoreError("VECTOR_INDEX_CORRUPT", message, true);
}

function normalizeFailure(cause: unknown, message: string): SearchVectorIndexStoreError {
  return cause instanceof SearchVectorIndexStoreError
    ? cause
    : new SearchVectorIndexStoreError("VECTOR_INDEX_UNAVAILABLE", message, true);
}
