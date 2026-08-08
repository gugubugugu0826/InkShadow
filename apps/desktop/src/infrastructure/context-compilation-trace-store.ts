import {
  CONTEXT_EVIDENCE_SOURCE_TYPES,
  CONTEXT_LAYER_ORDER,
  type CompiledContext,
  type ContextEvidenceSourceType,
  type ContextLayer,
  type ContextTokenEstimator,
} from "@inkshadow/ai-core";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

export const DEVELOPMENT_CONTEXT_COMPILATION_TRACE_KEY =
  "inkshadow.development.context-compilation-traces.v1";

export interface ContextCompilationTraceSource {
  readonly sourceType: ContextEvidenceSourceType;
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly locator: string | null;
  readonly contentHash: string | null;
}

export interface ContextCompilationTraceEntry {
  /** Identifier of the compiler input item, not an `ai_candidates.id`. */
  readonly contextCandidateId: string;
  readonly layer: ContextLayer;
  readonly selectionReason: string;
  readonly included: boolean;
  readonly discardedReason: string | null;
  readonly estimatedTokens: number;
  readonly evaluationOrder: number;
  readonly layerOrder: number;
  readonly priority: number;
  readonly relevanceScore: number | null;
  readonly required: boolean;
  readonly budgetRemainingBefore: number;
  readonly budgetRemainingAfter: number;
  readonly sources: readonly ContextCompilationTraceSource[];
}

export interface ContextCompilationTraceExecution {
  /** The exact identifier sent to the native model gateway. */
  readonly generationId: string;
  /** Present for the governed continuation pipeline. */
  readonly generationRunId: string | null;
  /** Present when Model Hub selected and recorded a provider invocation. */
  readonly modelInvocationId: string | null;
}

export interface ContextCompilationTrace {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  /** Stable task identifier such as `continuation`; never task/prompt text. */
  readonly taskType: string;
  readonly maximumContextTokens: number;
  readonly requiredTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly discardedTokens: number;
  readonly tokenEstimateSource: ContextTokenEstimator["source"];
  readonly createdAt: string;
  readonly execution: ContextCompilationTraceExecution | null;
  /** The isolated AI result that consumed this context, never a compiler input id. */
  readonly outputCandidateId: string | null;
  readonly entries: readonly ContextCompilationTraceEntry[];
}

export interface ContextCompilationTraceSummary {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly taskType: string;
  readonly maximumContextTokens: number;
  readonly requiredTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly discardedTokens: number;
  readonly tokenEstimateSource: ContextTokenEstimator["source"];
  readonly candidateCount: number;
  readonly includedCount: number;
  readonly discardedCount: number;
  readonly createdAt: string;
  readonly execution: ContextCompilationTraceExecution | null;
  readonly outputCandidateId: string | null;
}

export interface LinkContextCompilationModelInvocationInput {
  readonly traceId: string;
  readonly modelInvocationId: string;
  readonly linkedAt: string;
}

export interface LinkContextCompilationOutputCandidateInput {
  readonly traceId: string;
  readonly outputCandidateId: string;
  readonly linkedAt: string;
}

export interface ContextCompilationTraceStore {
  save(trace: ContextCompilationTrace): Promise<void>;
  linkModelInvocation(input: LinkContextCompilationModelInvocationInput): Promise<void>;
  linkOutputCandidate(input: LinkContextCompilationOutputCandidateInput): Promise<void>;
  findById(id: string): Promise<ContextCompilationTrace | null>;
  findByOutputCandidateId(outputCandidateId: string): Promise<ContextCompilationTrace | null>;
  listByProjectId(
    projectId: string,
    limit?: number,
  ): Promise<readonly ContextCompilationTraceSummary[]>;
}

export type ContextCompilationTraceStoreErrorCode =
  | "CONTEXT_TRACE_INVALID"
  | "CONTEXT_TRACE_CONFLICT"
  | "CONTEXT_TRACE_CORRUPT"
  | "CONTEXT_TRACE_UNAVAILABLE";

export class ContextCompilationTraceStoreError extends Error {
  public constructor(
    readonly code: ContextCompilationTraceStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ContextCompilationTraceStoreError";
  }
}

export interface CreateContextCompilationTraceInput {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId?: string | null;
  readonly taskType: string;
  readonly compiled: CompiledContext;
  readonly createdAt: string;
  readonly execution?: Readonly<{
    readonly generationId: string;
    readonly generationRunId?: string | null;
    readonly modelInvocationId?: string | null;
  }> | null;
}

const TRACE_SCHEMA_VERSION = 2;
const MAXIMUM_TRACE_ENTRIES = 4_096;
const MAXIMUM_SOURCES_PER_ENTRY = 32;
const MAXIMUM_CONTEXT_TOKENS = 10_000_000;
const MAXIMUM_TOTAL_DISCARDED_TOKENS = Number.MAX_SAFE_INTEGER;
const MAXIMUM_REFERENCE_CHARACTERS = 512;
const MAXIMUM_LOCATOR_CHARACTERS = 2_000;
const MAXIMUM_SELECTION_REASON_CHARACTERS = 2_000;
const DEFAULT_LIST_LIMIT = 50;
const MAXIMUM_LIST_LIMIT = 500;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_TASK_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;
const SAFE_DISCARD_REASON_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TOKEN_ESTIMATE_SOURCES: readonly ContextTokenEstimator["source"][] = [
  "utf8_conservative",
  "provider_tokenizer",
  "custom",
];

interface BrowserTraceDatabase {
  readonly schemaVersion: 2;
  readonly runs: Readonly<Record<string, ContextCompilationTrace>>;
}

interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly taskType: string;
  readonly maximumContextTokens: number;
  readonly requiredTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly discardedTokens: number;
  readonly tokenEstimateSource: string;
  readonly candidateCount: number;
  readonly includedCount: number;
  readonly discardedCount: number;
  readonly createdAt: string;
  readonly generationId: string | null;
  readonly generationRunId: string | null;
  readonly modelInvocationId: string | null;
  readonly explicitOutputCandidateId: string | null;
}

interface EntryRow {
  readonly contextCandidateId: string;
  readonly layer: string;
  readonly selectionReason: string;
  readonly included: number;
  readonly discardedReason: string | null;
  readonly estimatedTokens: number;
  readonly evaluationOrder: number;
  readonly layerOrder: number;
  readonly priority: number;
  readonly relevanceScore: number | null;
  readonly required: number;
  readonly budgetRemainingBefore: number;
  readonly budgetRemainingAfter: number;
}

interface SourceRow {
  readonly contextCandidateId: string;
  readonly sourceOrder: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly locator: string | null;
  readonly contentHash: string | null;
}

export function createContextCompilationTrace(
  input: CreateContextCompilationTraceInput,
): ContextCompilationTrace {
  return normalizeTrace({
    id: input.id,
    projectId: input.projectId,
    chapterId: input.chapterId ?? null,
    taskType: input.taskType,
    maximumContextTokens: input.compiled.trace.maximumContextTokens,
    requiredTokens: input.compiled.trace.requiredTokens,
    usedTokens: input.compiled.trace.usedTokens,
    remainingTokens: input.compiled.trace.remainingTokens,
    discardedTokens: input.compiled.trace.discardedTokens,
    tokenEstimateSource: input.compiled.trace.tokenEstimateSource,
    createdAt: input.createdAt,
    execution:
      input.execution === undefined || input.execution === null
        ? null
        : {
            generationId: input.execution.generationId,
            generationRunId: input.execution.generationRunId ?? null,
            modelInvocationId: input.execution.modelInvocationId ?? null,
          },
    outputCandidateId: null,
    entries: input.compiled.entries.map((entry) => ({
      contextCandidateId: entry.id,
      layer: entry.layer,
      selectionReason: entry.selectionReason,
      included: entry.included,
      discardedReason: entry.discardedReason,
      estimatedTokens: entry.estimatedTokens,
      evaluationOrder: entry.evaluationOrder,
      layerOrder: entry.layerOrder,
      priority: entry.priority,
      relevanceScore: entry.relevanceScore,
      required: entry.required,
      budgetRemainingBefore: entry.budgetRemainingBefore,
      budgetRemainingAfter: entry.budgetRemainingAfter,
      // Deliberately omit ContextCandidate.content and evidence.excerpt.
      sources: entry.evidence.map((source) => ({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersionId: source.sourceVersionId,
        locator: source.locator,
        contentHash: source.contentHash,
      })),
    })),
  });
}

export class SqliteContextCompilationTraceStore implements ContextCompilationTraceStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async save(traceValue: ContextCompilationTrace): Promise<void> {
    const trace = normalizeTrace(traceValue);
    try {
      await this.executor.transaction(async (transaction) => {
        const existing = await transaction.select<{ readonly id: string }>(
          "SELECT id FROM context_compilation_runs WHERE id = ? LIMIT 1",
          [trace.id],
        );
        if (existing.length > 0) {
          throw traceConflict();
        }
        await insertRun(transaction, trace);
        for (const entry of trace.entries) {
          await insertEntry(transaction, trace.id, entry);
        }
        if (trace.execution !== null) {
          await insertExecutionLink(transaction, trace.id, trace.execution, trace.createdAt);
        }
      });
    } catch (cause: unknown) {
      throw normalizeStoreFailure(cause, "Unable to save the context compilation trace.");
    }
  }

  public async linkModelInvocation(
    inputValue: LinkContextCompilationModelInvocationInput,
  ): Promise<void> {
    const input = normalizeModelInvocationLink(inputValue);
    try {
      await this.executor.transaction(async (transaction) => {
        const existing = await transaction.select<{ readonly modelInvocationId: string }>(
          `SELECT model_invocation_id AS modelInvocationId
           FROM context_compilation_model_invocation_links
           WHERE trace_id = ?
           LIMIT 1`,
          [input.traceId],
        );
        if (existing[0]?.modelInvocationId === input.modelInvocationId) {
          return;
        }
        if (existing.length > 0) {
          throw traceConflict();
        }
        await transaction.execute(
          `INSERT INTO context_compilation_model_invocation_links (
             trace_id, model_invocation_id, linked_at
           ) VALUES (?, ?, ?)`,
          [input.traceId, input.modelInvocationId, input.linkedAt],
        );
      });
    } catch (cause: unknown) {
      throw normalizeStoreFailure(
        cause,
        "Unable to link the model invocation to its context trace.",
      );
    }
  }

  public async linkOutputCandidate(
    inputValue: LinkContextCompilationOutputCandidateInput,
  ): Promise<void> {
    const input = normalizeOutputCandidateLink(inputValue);
    try {
      await this.executor.transaction(async (transaction) => {
        const existing = await transaction.select<{ readonly outputCandidateId: string }>(
          `SELECT ai_candidate_id AS outputCandidateId
           FROM context_compilation_output_candidate_links
           WHERE trace_id = ?
           LIMIT 1`,
          [input.traceId],
        );
        if (existing[0]?.outputCandidateId === input.outputCandidateId) {
          return;
        }
        if (existing.length > 0) {
          throw traceConflict();
        }
        await transaction.execute(
          `INSERT INTO context_compilation_output_candidate_links (
             trace_id, ai_candidate_id, linked_at
           ) VALUES (?, ?, ?)`,
          [input.traceId, input.outputCandidateId, input.linkedAt],
        );
      });
    } catch (cause: unknown) {
      throw normalizeStoreFailure(cause, "Unable to link the AI candidate to its context trace.");
    }
  }

  public async findById(idValue: string): Promise<ContextCompilationTrace | null> {
    const id = validateUuid(idValue, "trace id");
    try {
      return await readSqlTrace(this.executor, id);
    } catch (cause: unknown) {
      throw normalizeStoreFailure(cause, "Unable to read the context compilation trace.");
    }
  }

  public async findByOutputCandidateId(
    outputCandidateIdValue: string,
  ): Promise<ContextCompilationTrace | null> {
    const outputCandidateId = validateUuid(outputCandidateIdValue, "output AI candidate id");
    try {
      const rows = await this.executor.select<{ readonly id: string }>(
        `SELECT trace_id AS id
         FROM context_compilation_output_candidate_links
         WHERE ai_candidate_id = ?
         LIMIT 2`,
        [outputCandidateId],
      );
      if (rows.length > 1) {
        throw corruptTrace();
      }
      return rows[0] === undefined ? null : await readSqlTrace(this.executor, rows[0].id);
    } catch (cause: unknown) {
      throw normalizeStoreFailure(cause, "Unable to find the context trace for this AI candidate.");
    }
  }

  public async listByProjectId(
    projectIdValue: string,
    limitValue = DEFAULT_LIST_LIMIT,
  ): Promise<readonly ContextCompilationTraceSummary[]> {
    const projectId = validateUuid(projectIdValue, "project id");
    const limit = validateLimit(limitValue);
    try {
      const rows = await this.executor.select<RunRow>(
        `${RUN_SELECT}
        WHERE trace.project_id = ?
        ORDER BY trace.created_at DESC, trace.id DESC
        LIMIT ?`,
        [projectId, limit],
      );
      return Object.freeze(rows.map(summaryFromRow));
    } catch (cause: unknown) {
      throw normalizeStoreFailure(cause, "Unable to list context compilation traces.");
    }
  }
}

export class BrowserDevelopmentContextCompilationTraceStore implements ContextCompilationTraceStore {
  public constructor(private readonly storage: Storage) {}

  public save(traceValue: ContextCompilationTrace): Promise<void> {
    return Promise.resolve().then(() => {
      const trace = normalizeTrace(traceValue);
      const database = this.readDatabase();
      if (database.runs[trace.id] !== undefined) {
        throw traceConflict();
      }
      this.writeDatabase({
        schemaVersion: TRACE_SCHEMA_VERSION,
        runs: { ...database.runs, [trace.id]: trace },
      });
    });
  }

  public linkModelInvocation(
    inputValue: LinkContextCompilationModelInvocationInput,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const input = normalizeModelInvocationLink(inputValue);
      const database = this.readDatabase();
      const trace = database.runs[input.traceId];
      if (trace?.execution === null || trace === undefined) {
        throw traceConflict();
      }
      if (trace.execution.modelInvocationId === input.modelInvocationId) {
        return;
      }
      if (trace.execution.modelInvocationId !== null) {
        throw traceConflict();
      }
      const duplicate = Object.values(database.runs).some(
        (candidate) => candidate.execution?.modelInvocationId === input.modelInvocationId,
      );
      if (duplicate) {
        throw traceConflict();
      }
      const linked = normalizeTrace({
        ...trace,
        execution: { ...trace.execution, modelInvocationId: input.modelInvocationId },
      });
      this.writeDatabase({
        schemaVersion: TRACE_SCHEMA_VERSION,
        runs: { ...database.runs, [trace.id]: linked },
      });
    });
  }

  public linkOutputCandidate(
    inputValue: LinkContextCompilationOutputCandidateInput,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const input = normalizeOutputCandidateLink(inputValue);
      const database = this.readDatabase();
      const trace = database.runs[input.traceId];
      if (trace?.execution === undefined || trace.execution === null) {
        throw traceConflict();
      }
      if (trace.outputCandidateId === input.outputCandidateId) {
        return;
      }
      if (
        trace.outputCandidateId !== null ||
        Object.values(database.runs).some(
          (candidate) => candidate.outputCandidateId === input.outputCandidateId,
        )
      ) {
        throw traceConflict();
      }
      const linked = normalizeTrace({ ...trace, outputCandidateId: input.outputCandidateId });
      this.writeDatabase({
        schemaVersion: TRACE_SCHEMA_VERSION,
        runs: { ...database.runs, [trace.id]: linked },
      });
    });
  }

  public findById(idValue: string): Promise<ContextCompilationTrace | null> {
    return Promise.resolve().then(() => {
      const id = validateUuid(idValue, "trace id");
      return this.readDatabase().runs[id] ?? null;
    });
  }

  public findByOutputCandidateId(
    outputCandidateIdValue: string,
  ): Promise<ContextCompilationTrace | null> {
    return Promise.resolve().then(() => {
      const outputCandidateId = validateUuid(outputCandidateIdValue, "output AI candidate id");
      const matches = Object.values(this.readDatabase().runs).filter(
        (trace) => trace.outputCandidateId === outputCandidateId,
      );
      if (matches.length > 1) {
        throw corruptTrace();
      }
      return matches[0] ?? null;
    });
  }

  public listByProjectId(
    projectIdValue: string,
    limitValue = DEFAULT_LIST_LIMIT,
  ): Promise<readonly ContextCompilationTraceSummary[]> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "project id");
      const limit = validateLimit(limitValue);
      return Object.freeze(
        Object.values(this.readDatabase().runs)
          .filter((trace) => trace.projectId === projectId)
          .sort(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
          )
          .slice(0, limit)
          .map(summaryFromTrace),
      );
    });
  }

  private readDatabase(): BrowserTraceDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_CONTEXT_COMPILATION_TRACE_KEY);
    if (serialized === null) {
      return Object.freeze({ schemaVersion: TRACE_SCHEMA_VERSION, runs: Object.freeze({}) });
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isRecord(parsed) ||
        !hasExactKeys(parsed, ["schemaVersion", "runs"]) ||
        (parsed.schemaVersion !== 1 && parsed.schemaVersion !== TRACE_SCHEMA_VERSION) ||
        !isRecord(parsed.runs)
      ) {
        throw corruptTrace();
      }
      const runs: Record<string, ContextCompilationTrace> = {};
      for (const [id, value] of Object.entries(parsed.runs)) {
        const trace = normalizeTrace(
          parsed.schemaVersion === 1 ? upgradeLegacyBrowserTrace(value) : value,
          true,
        );
        if (trace.id !== id) {
          throw corruptTrace();
        }
        runs[id] = trace;
      }
      return Object.freeze({ schemaVersion: TRACE_SCHEMA_VERSION, runs: Object.freeze(runs) });
    } catch (cause: unknown) {
      if (
        cause instanceof ContextCompilationTraceStoreError &&
        cause.code === "CONTEXT_TRACE_CORRUPT"
      ) {
        throw cause;
      }
      throw corruptTrace();
    }
  }

  private writeDatabase(database: BrowserTraceDatabase): void {
    try {
      this.storage.setItem(DEVELOPMENT_CONTEXT_COMPILATION_TRACE_KEY, JSON.stringify(database));
    } catch {
      throw new ContextCompilationTraceStoreError(
        "CONTEXT_TRACE_UNAVAILABLE",
        "Browser storage could not save the context compilation trace.",
        true,
      );
    }
  }
}

async function insertRun(
  transaction: TransactionExecutor,
  trace: ContextCompilationTrace,
): Promise<void> {
  const includedCount = trace.entries.filter(({ included }) => included).length;
  await transaction.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type,
       maximum_context_tokens, required_tokens, used_tokens,
       remaining_tokens, discarded_tokens, token_estimate_source,
       candidate_count, included_count, discarded_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trace.id,
      trace.projectId,
      trace.chapterId,
      trace.taskType,
      trace.maximumContextTokens,
      trace.requiredTokens,
      trace.usedTokens,
      trace.remainingTokens,
      trace.discardedTokens,
      trace.tokenEstimateSource,
      trace.entries.length,
      includedCount,
      trace.entries.length - includedCount,
      trace.createdAt,
    ],
  );
}

async function insertEntry(
  transaction: TransactionExecutor,
  runId: string,
  entry: ContextCompilationTraceEntry,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason,
       included, discarded_reason, estimated_tokens,
       evaluation_order, layer_order, priority, relevance_score,
       required, budget_remaining_before, budget_remaining_after
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      entry.contextCandidateId,
      entry.layer,
      entry.selectionReason,
      entry.included ? 1 : 0,
      entry.discardedReason,
      entry.estimatedTokens,
      entry.evaluationOrder,
      entry.layerOrder,
      entry.priority,
      entry.relevanceScore,
      entry.required ? 1 : 0,
      entry.budgetRemainingBefore,
      entry.budgetRemainingAfter,
    ],
  );
  for (const [sourceIndex, source] of entry.sources.entries()) {
    await transaction.execute(
      `INSERT INTO context_compilation_entry_sources (
         run_id, candidate_id, source_order, source_type, source_id,
         source_version_id, locator, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        entry.contextCandidateId,
        sourceIndex + 1,
        source.sourceType,
        source.sourceId,
        source.sourceVersionId,
        source.locator,
        source.contentHash,
      ],
    );
  }
}

async function insertExecutionLink(
  transaction: TransactionExecutor,
  traceId: string,
  execution: ContextCompilationTraceExecution,
  createdAt: string,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, ?, ?, ?)`,
    [traceId, execution.generationId, execution.generationRunId, createdAt],
  );
  if (execution.modelInvocationId !== null) {
    await transaction.execute(
      `INSERT INTO context_compilation_model_invocation_links (
         trace_id, model_invocation_id, linked_at
       ) VALUES (?, ?, ?)`,
      [traceId, execution.modelInvocationId, createdAt],
    );
  }
}

async function readSqlTrace(
  executor: Pick<SqlExecutor, "select">,
  id: string,
): Promise<ContextCompilationTrace | null> {
  const runRows = await executor.select<RunRow>(`${RUN_SELECT} WHERE trace.id = ? LIMIT 1`, [id]);
  const run = runRows[0];
  if (run === undefined) {
    return null;
  }
  const entries = await executor.select<EntryRow>(
    `SELECT
       candidate_id AS contextCandidateId,
       layer,
       selection_reason AS selectionReason,
       included,
       discarded_reason AS discardedReason,
       estimated_tokens AS estimatedTokens,
       evaluation_order AS evaluationOrder,
       layer_order AS layerOrder,
       priority,
       relevance_score AS relevanceScore,
       required,
       budget_remaining_before AS budgetRemainingBefore,
       budget_remaining_after AS budgetRemainingAfter
     FROM context_compilation_entries
     WHERE run_id = ?
     ORDER BY evaluation_order ASC`,
    [id],
  );
  const sourceRows = await executor.select<SourceRow>(
    `SELECT
       candidate_id AS contextCandidateId,
       source_order AS sourceOrder,
       source_type AS sourceType,
       source_id AS sourceId,
       source_version_id AS sourceVersionId,
       locator,
       content_hash AS contentHash
     FROM context_compilation_entry_sources
     WHERE run_id = ?
     ORDER BY candidate_id ASC, source_order ASC`,
    [id],
  );
  const sourcesByCandidate = new Map<string, SourceRow[]>();
  for (const source of sourceRows) {
    const sources = sourcesByCandidate.get(source.contextCandidateId) ?? [];
    if (source.sourceOrder !== sources.length + 1) {
      throw corruptTrace();
    }
    sources.push(source);
    sourcesByCandidate.set(source.contextCandidateId, sources);
  }
  const trace = normalizeTrace(
    {
      id: run.id,
      projectId: run.projectId,
      chapterId: run.chapterId,
      taskType: run.taskType,
      maximumContextTokens: run.maximumContextTokens,
      requiredTokens: run.requiredTokens,
      usedTokens: run.usedTokens,
      remainingTokens: run.remainingTokens,
      discardedTokens: run.discardedTokens,
      tokenEstimateSource: run.tokenEstimateSource,
      createdAt: run.createdAt,
      execution: executionFromRow(run),
      outputCandidateId: outputCandidateIdFromRow(run),
      entries: entries.map((entry) => ({
        contextCandidateId: entry.contextCandidateId,
        layer: entry.layer,
        selectionReason: entry.selectionReason,
        included: entry.included === 1,
        discardedReason: entry.discardedReason,
        estimatedTokens: entry.estimatedTokens,
        evaluationOrder: entry.evaluationOrder,
        layerOrder: entry.layerOrder,
        priority: entry.priority,
        relevanceScore: entry.relevanceScore,
        required: entry.required === 1,
        budgetRemainingBefore: entry.budgetRemainingBefore,
        budgetRemainingAfter: entry.budgetRemainingAfter,
        sources: (sourcesByCandidate.get(entry.contextCandidateId) ?? []).map((source) => ({
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceVersionId: source.sourceVersionId,
          locator: source.locator,
          contentHash: source.contentHash,
        })),
      })),
    },
    true,
  );
  const includedCount = trace.entries.filter(({ included }) => included).length;
  if (
    trace.entries.length !== run.candidateCount ||
    includedCount !== run.includedCount ||
    trace.entries.length - includedCount !== run.discardedCount
  ) {
    throw corruptTrace();
  }
  return trace;
}

const RUN_SELECT = `SELECT
  trace.id,
  trace.project_id AS projectId,
  trace.chapter_id AS chapterId,
  trace.task_type AS taskType,
  trace.maximum_context_tokens AS maximumContextTokens,
  trace.required_tokens AS requiredTokens,
  trace.used_tokens AS usedTokens,
  trace.remaining_tokens AS remainingTokens,
  trace.discarded_tokens AS discardedTokens,
  trace.token_estimate_source AS tokenEstimateSource,
  trace.candidate_count AS candidateCount,
  trace.included_count AS includedCount,
  trace.discarded_count AS discardedCount,
  trace.created_at AS createdAt,
  execution.generation_id AS generationId,
  execution.generation_run_id AS generationRunId,
  invocation.model_invocation_id AS modelInvocationId,
  output_link.ai_candidate_id AS explicitOutputCandidateId
FROM context_compilation_runs AS trace
LEFT JOIN context_compilation_execution_links AS execution
  ON execution.trace_id = trace.id
LEFT JOIN context_compilation_model_invocation_links AS invocation
  ON invocation.trace_id = trace.id
LEFT JOIN context_compilation_output_candidate_links AS output_link
  ON output_link.trace_id = trace.id`;

function normalizeTrace(value: unknown, stored = false): ContextCompilationTrace {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "projectId",
      "chapterId",
      "taskType",
      "maximumContextTokens",
      "requiredTokens",
      "usedTokens",
      "remainingTokens",
      "discardedTokens",
      "tokenEstimateSource",
      "createdAt",
      "execution",
      "outputCandidateId",
      "entries",
    ]) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > MAXIMUM_TRACE_ENTRIES
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  const id = validateUuid(value.id, "trace id", stored);
  const projectId = validateUuid(value.projectId, "project id", stored);
  const chapterId =
    value.chapterId === null ? null : validateUuid(value.chapterId, "chapter id", stored);
  if (typeof value.taskType !== "string" || !SAFE_TASK_PATTERN.test(value.taskType)) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  const maximumContextTokens = validateInteger(
    value.maximumContextTokens,
    1,
    MAXIMUM_CONTEXT_TOKENS,
    stored,
  );
  const requiredTokens = validateInteger(value.requiredTokens, 0, MAXIMUM_CONTEXT_TOKENS, stored);
  const usedTokens = validateInteger(value.usedTokens, 0, MAXIMUM_CONTEXT_TOKENS, stored);
  const remainingTokens = validateInteger(value.remainingTokens, 0, MAXIMUM_CONTEXT_TOKENS, stored);
  const discardedTokens = validateInteger(
    value.discardedTokens,
    0,
    MAXIMUM_TOTAL_DISCARDED_TOKENS,
    stored,
  );
  if (
    typeof value.tokenEstimateSource !== "string" ||
    !TOKEN_ESTIMATE_SOURCES.includes(
      value.tokenEstimateSource as ContextTokenEstimator["source"],
    ) ||
    typeof value.createdAt !== "string" ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  const execution = normalizeExecution(value.execution, stored);
  const outputCandidateId =
    value.outputCandidateId === null
      ? null
      : validateUuid(value.outputCandidateId, "output AI candidate id", stored);

  const candidateIds = new Set<string>();
  const entries = value.entries.map((entry, index) =>
    normalizeEntry(entry, index, maximumContextTokens, candidateIds, stored),
  );
  const calculatedRequired = entries.reduce(
    (total, entry) => total + (entry.required ? entry.estimatedTokens : 0),
    0,
  );
  const calculatedUsed = entries.reduce(
    (total, entry) => total + (entry.included ? entry.estimatedTokens : 0),
    0,
  );
  const calculatedDiscarded = entries.reduce(
    (total, entry) => total + (entry.included ? 0 : entry.estimatedTokens),
    0,
  );
  if (
    entries.some(
      (entry, index) =>
        index > 0 && entry.budgetRemainingBefore !== entries[index - 1]?.budgetRemainingAfter,
    ) ||
    requiredTokens !== calculatedRequired ||
    usedTokens !== calculatedUsed ||
    discardedTokens !== calculatedDiscarded ||
    remainingTokens !== maximumContextTokens - usedTokens
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }

  return Object.freeze({
    id,
    projectId,
    chapterId,
    taskType: value.taskType,
    maximumContextTokens,
    requiredTokens,
    usedTokens,
    remainingTokens,
    discardedTokens,
    tokenEstimateSource: value.tokenEstimateSource as ContextTokenEstimator["source"],
    createdAt: value.createdAt,
    execution,
    outputCandidateId,
    entries: Object.freeze(entries),
  });
}

function normalizeExecution(
  value: unknown,
  stored: boolean,
): ContextCompilationTraceExecution | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["generationId", "generationRunId", "modelInvocationId"])
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  return Object.freeze({
    generationId: validateUuid(value.generationId, "generation id", stored),
    generationRunId:
      value.generationRunId === null
        ? null
        : validateUuid(value.generationRunId, "generation run id", stored),
    modelInvocationId:
      value.modelInvocationId === null
        ? null
        : validateUuid(value.modelInvocationId, "model invocation id", stored),
  });
}

function normalizeEntry(
  value: unknown,
  index: number,
  maximumContextTokens: number,
  candidateIds: Set<string>,
  stored: boolean,
): ContextCompilationTraceEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contextCandidateId",
      "layer",
      "selectionReason",
      "included",
      "discardedReason",
      "estimatedTokens",
      "evaluationOrder",
      "layerOrder",
      "priority",
      "relevanceScore",
      "required",
      "budgetRemainingBefore",
      "budgetRemainingAfter",
      "sources",
    ]) ||
    !isSafeReference(value.contextCandidateId) ||
    candidateIds.has(value.contextCandidateId) ||
    typeof value.layer !== "string" ||
    !CONTEXT_LAYER_ORDER.includes(value.layer as ContextLayer) ||
    typeof value.selectionReason !== "string" ||
    !isBoundedText(value.selectionReason, MAXIMUM_SELECTION_REASON_CHARACTERS) ||
    typeof value.included !== "boolean" ||
    (value.discardedReason !== null &&
      (typeof value.discardedReason !== "string" ||
        !SAFE_DISCARD_REASON_PATTERN.test(value.discardedReason))) ||
    typeof value.required !== "boolean" ||
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > MAXIMUM_SOURCES_PER_ENTRY
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  const estimatedTokens = validateInteger(value.estimatedTokens, 1, MAXIMUM_CONTEXT_TOKENS, stored);
  const evaluationOrder = validateInteger(value.evaluationOrder, 1, MAXIMUM_TRACE_ENTRIES, stored);
  const layerOrder = validateInteger(value.layerOrder, 1, CONTEXT_LAYER_ORDER.length, stored);
  const priority = validateInteger(value.priority, -1_000, 1_000, stored);
  const budgetBefore = validateInteger(
    value.budgetRemainingBefore,
    0,
    maximumContextTokens,
    stored,
  );
  const budgetAfter = validateInteger(value.budgetRemainingAfter, 0, maximumContextTokens, stored);
  if (
    evaluationOrder !== index + 1 ||
    layerOrder !== CONTEXT_LAYER_ORDER.indexOf(value.layer as ContextLayer) + 1 ||
    (index === 0 && budgetBefore !== maximumContextTokens) ||
    (value.included &&
      (value.discardedReason !== null || budgetAfter !== budgetBefore - estimatedTokens)) ||
    (!value.included && (value.discardedReason === null || budgetAfter !== budgetBefore)) ||
    (value.required && !value.included) ||
    (value.relevanceScore !== null &&
      (typeof value.relevanceScore !== "number" ||
        !Number.isFinite(value.relevanceScore) ||
        value.relevanceScore < 0 ||
        value.relevanceScore > 1))
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  candidateIds.add(value.contextCandidateId);
  const sources = value.sources.map((source) => normalizeSource(source, stored));
  return Object.freeze({
    contextCandidateId: value.contextCandidateId,
    layer: value.layer as ContextLayer,
    selectionReason: value.selectionReason,
    included: value.included,
    discardedReason: value.discardedReason,
    estimatedTokens,
    evaluationOrder,
    layerOrder,
    priority,
    relevanceScore: value.relevanceScore,
    required: value.required,
    budgetRemainingBefore: budgetBefore,
    budgetRemainingAfter: budgetAfter,
    sources: Object.freeze(sources),
  });
}

function normalizeSource(value: unknown, stored: boolean): ContextCompilationTraceSource {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sourceType", "sourceId", "sourceVersionId", "locator", "contentHash"]) ||
    typeof value.sourceType !== "string" ||
    !CONTEXT_EVIDENCE_SOURCE_TYPES.includes(value.sourceType as ContextEvidenceSourceType) ||
    !isSafeReference(value.sourceId) ||
    (value.sourceVersionId !== null && !isSafeReference(value.sourceVersionId)) ||
    (value.locator !== null &&
      (typeof value.locator !== "string" ||
        !isBoundedText(value.locator, MAXIMUM_LOCATOR_CHARACTERS))) ||
    (value.contentHash !== null && !isSafeReference(value.contentHash))
  ) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  return Object.freeze({
    sourceType: value.sourceType as ContextEvidenceSourceType,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    locator: value.locator,
    contentHash: value.contentHash,
  });
}

function summaryFromRow(row: RunRow): ContextCompilationTraceSummary {
  return normalizeSummary({
    id: row.id,
    projectId: row.projectId,
    chapterId: row.chapterId,
    taskType: row.taskType,
    maximumContextTokens: row.maximumContextTokens,
    requiredTokens: row.requiredTokens,
    usedTokens: row.usedTokens,
    remainingTokens: row.remainingTokens,
    discardedTokens: row.discardedTokens,
    tokenEstimateSource: row.tokenEstimateSource,
    candidateCount: row.candidateCount,
    includedCount: row.includedCount,
    discardedCount: row.discardedCount,
    createdAt: row.createdAt,
    execution: executionFromRow(row),
    outputCandidateId: outputCandidateIdFromRow(row),
  });
}

function summaryFromTrace(trace: ContextCompilationTrace): ContextCompilationTraceSummary {
  const includedCount = trace.entries.filter(({ included }) => included).length;
  return Object.freeze({
    id: trace.id,
    projectId: trace.projectId,
    chapterId: trace.chapterId,
    taskType: trace.taskType,
    maximumContextTokens: trace.maximumContextTokens,
    requiredTokens: trace.requiredTokens,
    usedTokens: trace.usedTokens,
    remainingTokens: trace.remainingTokens,
    discardedTokens: trace.discardedTokens,
    tokenEstimateSource: trace.tokenEstimateSource,
    candidateCount: trace.entries.length,
    includedCount,
    discardedCount: trace.entries.length - includedCount,
    createdAt: trace.createdAt,
    execution: trace.execution,
    outputCandidateId: trace.outputCandidateId,
  });
}

function normalizeSummary(value: unknown): ContextCompilationTraceSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "projectId",
      "chapterId",
      "taskType",
      "maximumContextTokens",
      "requiredTokens",
      "usedTokens",
      "remainingTokens",
      "discardedTokens",
      "tokenEstimateSource",
      "candidateCount",
      "includedCount",
      "discardedCount",
      "createdAt",
      "execution",
      "outputCandidateId",
    ])
  ) {
    throw corruptTrace();
  }
  const id = validateUuid(value.id, "trace id", true);
  const projectId = validateUuid(value.projectId, "project id", true);
  const chapterId =
    value.chapterId === null ? null : validateUuid(value.chapterId, "chapter id", true);
  const maximumContextTokens = validateInteger(
    value.maximumContextTokens,
    1,
    MAXIMUM_CONTEXT_TOKENS,
    true,
  );
  const requiredTokens = validateInteger(value.requiredTokens, 0, maximumContextTokens, true);
  const usedTokens = validateInteger(value.usedTokens, 0, maximumContextTokens, true);
  const remainingTokens = validateInteger(value.remainingTokens, 0, maximumContextTokens, true);
  const discardedTokens = validateInteger(
    value.discardedTokens,
    0,
    MAXIMUM_TOTAL_DISCARDED_TOKENS,
    true,
  );
  const candidateCount = validateInteger(value.candidateCount, 1, MAXIMUM_TRACE_ENTRIES, true);
  const includedCount = validateInteger(value.includedCount, 1, candidateCount, true);
  const discardedCount = validateInteger(value.discardedCount, 0, candidateCount, true);
  const execution = normalizeExecution(value.execution, true);
  const outputCandidateId =
    value.outputCandidateId === null
      ? null
      : validateUuid(value.outputCandidateId, "output AI candidate id", true);
  if (
    typeof value.taskType !== "string" ||
    !SAFE_TASK_PATTERN.test(value.taskType) ||
    typeof value.tokenEstimateSource !== "string" ||
    !TOKEN_ESTIMATE_SOURCES.includes(
      value.tokenEstimateSource as ContextTokenEstimator["source"],
    ) ||
    typeof value.createdAt !== "string" ||
    !isCanonicalTimestamp(value.createdAt) ||
    requiredTokens > usedTokens ||
    remainingTokens !== maximumContextTokens - usedTokens ||
    includedCount + discardedCount !== candidateCount
  ) {
    throw corruptTrace();
  }
  return Object.freeze({
    id,
    projectId,
    chapterId,
    taskType: value.taskType,
    maximumContextTokens,
    requiredTokens,
    usedTokens,
    remainingTokens,
    discardedTokens,
    tokenEstimateSource: value.tokenEstimateSource as ContextTokenEstimator["source"],
    candidateCount,
    includedCount,
    discardedCount,
    createdAt: value.createdAt,
    execution,
    outputCandidateId,
  });
}

function executionFromRow(row: RunRow): ContextCompilationTraceExecution | null {
  if (row.generationId === null) {
    if (row.generationRunId !== null || row.modelInvocationId !== null) {
      throw corruptTrace();
    }
    return null;
  }
  return normalizeExecution(
    {
      generationId: row.generationId,
      generationRunId: row.generationRunId,
      modelInvocationId: row.modelInvocationId,
    },
    true,
  );
}

function outputCandidateIdFromRow(row: RunRow): string | null {
  const outputCandidateId = row.explicitOutputCandidateId;
  return outputCandidateId === null
    ? null
    : validateUuid(outputCandidateId, "output AI candidate id", true);
}

function validateUuid(value: unknown, field: string, stored = false): string {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
    if (stored) {
      throw corruptTrace();
    }
    throw new ContextCompilationTraceStoreError(
      "CONTEXT_TRACE_INVALID",
      `The context compilation ${field} must be a UUIDv7.`,
    );
  }
  return value;
}

function normalizeModelInvocationLink(value: unknown): LinkContextCompilationModelInvocationInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["traceId", "modelInvocationId", "linkedAt"]) ||
    typeof value.linkedAt !== "string" ||
    !isCanonicalTimestamp(value.linkedAt)
  ) {
    throw invalidTrace();
  }
  return Object.freeze({
    traceId: validateUuid(value.traceId, "trace id"),
    modelInvocationId: validateUuid(value.modelInvocationId, "model invocation id"),
    linkedAt: value.linkedAt,
  });
}

function normalizeOutputCandidateLink(value: unknown): LinkContextCompilationOutputCandidateInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["traceId", "outputCandidateId", "linkedAt"]) ||
    typeof value.linkedAt !== "string" ||
    !isCanonicalTimestamp(value.linkedAt)
  ) {
    throw invalidTrace();
  }
  return Object.freeze({
    traceId: validateUuid(value.traceId, "trace id"),
    outputCandidateId: validateUuid(value.outputCandidateId, "output AI candidate id"),
    linkedAt: value.linkedAt,
  });
}

function upgradeLegacyBrowserTrace(value: unknown): unknown {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "projectId",
      "chapterId",
      "taskType",
      "maximumContextTokens",
      "requiredTokens",
      "usedTokens",
      "remainingTokens",
      "discardedTokens",
      "tokenEstimateSource",
      "createdAt",
      "entries",
    ]) ||
    !Array.isArray(value.entries)
  ) {
    throw corruptTrace();
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        "candidateId",
        "layer",
        "selectionReason",
        "included",
        "discardedReason",
        "estimatedTokens",
        "evaluationOrder",
        "layerOrder",
        "priority",
        "relevanceScore",
        "required",
        "budgetRemainingBefore",
        "budgetRemainingAfter",
        "sources",
      ])
    ) {
      throw corruptTrace();
    }
    return {
      contextCandidateId: entry.candidateId,
      layer: entry.layer,
      selectionReason: entry.selectionReason,
      included: entry.included,
      discardedReason: entry.discardedReason,
      estimatedTokens: entry.estimatedTokens,
      evaluationOrder: entry.evaluationOrder,
      layerOrder: entry.layerOrder,
      priority: entry.priority,
      relevanceScore: entry.relevanceScore,
      required: entry.required,
      budgetRemainingBefore: entry.budgetRemainingBefore,
      budgetRemainingAfter: entry.budgetRemainingAfter,
      sources: entry.sources,
    };
  });
  return {
    id: value.id,
    projectId: value.projectId,
    chapterId: value.chapterId,
    taskType: value.taskType,
    maximumContextTokens: value.maximumContextTokens,
    requiredTokens: value.requiredTokens,
    usedTokens: value.usedTokens,
    remainingTokens: value.remainingTokens,
    discardedTokens: value.discardedTokens,
    tokenEstimateSource: value.tokenEstimateSource,
    createdAt: value.createdAt,
    execution: null,
    outputCandidateId: null,
    entries,
  };
}

function validateInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  stored: boolean,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw stored ? corruptTrace() : invalidTrace();
  }
  return value as number;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_LIST_LIMIT) {
    throw invalidTrace();
  }
  return value;
}

function isSafeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAXIMUM_REFERENCE_CHARACTERS &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isBoundedText(value: string, maximumLength: number): boolean {
  return (
    value.trim().length >= 1 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isCanonicalTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function invalidTrace(): ContextCompilationTraceStoreError {
  return new ContextCompilationTraceStoreError(
    "CONTEXT_TRACE_INVALID",
    "The context compilation trace violates its content-free audit contract.",
  );
}

function traceConflict(): ContextCompilationTraceStoreError {
  return new ContextCompilationTraceStoreError(
    "CONTEXT_TRACE_CONFLICT",
    "A context compilation trace with this identifier already exists.",
  );
}

function corruptTrace(): ContextCompilationTraceStoreError {
  return new ContextCompilationTraceStoreError(
    "CONTEXT_TRACE_CORRUPT",
    "Stored context compilation audit data failed integrity validation.",
  );
}

function normalizeStoreFailure(cause: unknown, message: string): ContextCompilationTraceStoreError {
  if (cause instanceof ContextCompilationTraceStoreError) {
    return cause;
  }
  return new ContextCompilationTraceStoreError("CONTEXT_TRACE_UNAVAILABLE", message, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
