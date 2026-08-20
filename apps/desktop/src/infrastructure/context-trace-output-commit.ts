import type {
  AiCandidate,
  AppError,
  AiCandidateSnapshot,
  AiCandidateStatus,
  Chapter,
  IsoUtcTimestamp,
  Project,
  Result,
  UuidV7,
} from "@inkshadow/domain";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

import type {
  ContextCompilationTrace,
  ContextCompilationTraceStore,
} from "./context-compilation-trace-store";

export type ContextTraceOutputCommitCapability =
  "sqlite_atomic" | "browser_development_compensating";

export type ContextTraceOutputCommitOutcome = "created" | "already_committed";

export interface ContextTraceOutputCommitInput {
  readonly traceId: string;
  readonly candidate: AiCandidate;
  readonly linkedAt: IsoUtcTimestamp;
  /** Optional existing task latch checked atomically before a SQLite output commit. */
  readonly executionTaskId?: UuidV7;
}

export interface ContextTraceOutputCommitUnitOfWork {
  readonly capability: ContextTraceOutputCommitCapability;
  commit(input: ContextTraceOutputCommitInput): Promise<ContextTraceOutputCommitOutcome>;
}

export type ContextTraceOutputCommitErrorCode =
  | "CONTEXT_TRACE_OUTPUT_INVALID"
  | "CONTEXT_TRACE_OUTPUT_CONFLICT"
  | "CONTEXT_TRACE_OUTPUT_CORRUPT"
  | "CONTEXT_TRACE_OUTPUT_TARGET_CHANGED"
  | "CONTEXT_TRACE_OUTPUT_UNAVAILABLE";

export class ContextTraceOutputCommitError extends Error {
  public constructor(
    readonly code: ContextTraceOutputCommitErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ContextTraceOutputCommitError";
  }
}

interface CandidatePersistencePort {
  create(candidate: AiCandidate): Promise<Result<void, AppError>>;
  findById(id: UuidV7): Promise<Result<AiCandidate | null, AppError>>;
  save(
    candidate: AiCandidate,
    expected: Readonly<{ status: AiCandidateStatus; revision: number }>,
  ): Promise<Result<void, AppError>>;
}

interface CreativeTargetAuthorityPort {
  readonly projects: Readonly<{
    findById(id: UuidV7): Promise<Result<Project | null, AppError>>;
  }>;
  readonly chapters: Readonly<{
    findById(id: UuidV7): Promise<Result<Chapter | null, AppError>>;
  }>;
}

interface TraceTargetRow {
  readonly projectId: string;
  readonly chapterId: string | null;
}

interface ProjectAuthorityRow {
  readonly status: string;
}

interface ChapterAuthorityRow {
  readonly projectId: string;
  readonly status: string;
  readonly currentVersionId: string;
}

interface TraceSourceVersionRow {
  readonly sourceVersionId: string | null;
}

interface OutputLinkRow {
  readonly traceId: string;
  readonly candidateId: string;
}

interface CandidateRow {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly source: string;
  readonly baseVersionId: string | null;
  readonly content: string;
  readonly contentChecksum: string | null;
  readonly status: string;
  readonly revision: number;
  readonly incomplete: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
  readonly taskIntent: string;
  readonly applicationMode: string;
  readonly payloadKind: string;
  readonly anchorStartUtf16: number | null;
  readonly anchorEndUtf16: number | null;
}

interface ExecutionTaskGuardRow {
  readonly status: string;
  readonly cancelRequestedAt: string | null;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Production commit boundary for an isolated model result. The ready Candidate
 * and its exact context-output association become durable in one SQLite
 * transaction, so neither side can survive alone after a process failure.
 */
export class SqliteContextTraceOutputCommitUnitOfWork implements ContextTraceOutputCommitUnitOfWork {
  public readonly capability = "sqlite_atomic" as const;

  public constructor(private readonly executor: SqlExecutor) {}

  public async commit(
    inputValue: ContextTraceOutputCommitInput,
  ): Promise<ContextTraceOutputCommitOutcome> {
    const input = normalizeCommitInput(inputValue);
    try {
      return await this.executor.transaction((transaction) =>
        commitSqliteOutput(transaction, input),
      );
    } catch (cause: unknown) {
      throw normalizeCommitFailure(cause);
    }
  }
}

/**
 * Browser development keeps the existing localStorage repositories working.
 * It is deliberately labelled compensating and is never selected by the
 * production Tauri runtime.
 */
export class BrowserDevelopmentContextTraceOutputCommitUnitOfWork implements ContextTraceOutputCommitUnitOfWork {
  public readonly capability = "browser_development_compensating" as const;

  public constructor(
    private readonly candidates: CandidatePersistencePort,
    private readonly traces: ContextCompilationTraceStore,
    private readonly authority: CreativeTargetAuthorityPort,
  ) {}

  public async commit(
    inputValue: ContextTraceOutputCommitInput,
  ): Promise<ContextTraceOutputCommitOutcome> {
    const input = normalizeCommitInput(inputValue);
    if (input.executionTaskId !== null) {
      throw new ContextTraceOutputCommitError(
        "CONTEXT_TRACE_OUTPUT_UNAVAILABLE",
        "The development Candidate commit cannot enforce the production task cancellation latch.",
      );
    }
    try {
      const trace = await this.traces.findById(input.traceId);
      if (trace?.execution === undefined || trace.execution === null) {
        throw corruptOutput("The context trace has no exact generation binding.");
      }
      if (
        trace.projectId !== input.snapshot.projectId ||
        trace.chapterId !== input.snapshot.chapterId
      ) {
        throw outputConflict();
      }
      await assertDevelopmentCreativeTargetCurrent(this.authority, trace, input.snapshot);
      if (trace.outputCandidateId !== null && trace.outputCandidateId !== input.snapshot.id) {
        throw outputConflict();
      }

      const existingResult = await this.candidates.findById(input.candidate.id);
      if (!existingResult.ok) {
        throw existingResult.error;
      }
      const existing = existingResult.value;
      if (existing !== null && !candidateSnapshotsEqual(existing.toSnapshot(), input.snapshot)) {
        throw outputConflict();
      }
      if (trace.outputCandidateId === input.snapshot.id) {
        if (existing === null) {
          throw corruptOutput("The context trace points to a missing AI Candidate.");
        }
        return "already_committed";
      }

      let created = false;
      if (existing === null) {
        await assertDevelopmentCreativeTargetCurrent(this.authority, trace, input.snapshot);
        const saved = await this.candidates.create(input.candidate);
        if (!saved.ok) {
          throw saved.error;
        }
        created = true;
      }
      try {
        await assertDevelopmentCreativeTargetCurrent(this.authority, trace, input.snapshot);
        await this.traces.linkOutputCandidate({
          traceId: input.traceId,
          outputCandidateId: input.snapshot.id,
          linkedAt: input.linkedAt,
        });
      } catch (cause: unknown) {
        if (created) {
          await expireDevelopmentCandidate(this.candidates, input.candidate, input.linkedAt);
        }
        throw cause;
      }
      return created ? "created" : "already_committed";
    } catch (cause: unknown) {
      throw normalizeCommitFailure(cause);
    }
  }
}

interface NormalizedCommitInput {
  readonly traceId: string;
  readonly candidate: AiCandidate;
  readonly snapshot: AiCandidateSnapshot;
  readonly linkedAt: IsoUtcTimestamp;
  readonly executionTaskId: UuidV7 | null;
}

function normalizeCommitInput(input: ContextTraceOutputCommitInput): NormalizedCommitInput {
  if (!UUID_V7_PATTERN.test(input.traceId)) {
    throw invalidOutput("The context trace id must be a UUIDv7.");
  }
  const snapshot = input.candidate.toSnapshot();
  if (snapshot.status !== "ready" || snapshot.decidedAt !== null) {
    throw invalidOutput("Only a ready, undecided AI Candidate can be committed.");
  }
  if (snapshot.chapterId === null || snapshot.baseVersionId === null) {
    throw invalidOutput(
      "A creative context output must target one chapter and its exact accepted base version.",
    );
  }
  if (new Date(input.linkedAt).toISOString() !== input.linkedAt) {
    throw invalidOutput("The output association timestamp must be canonical UTC.");
  }
  if (input.executionTaskId !== undefined && !UUID_V7_PATTERN.test(input.executionTaskId)) {
    throw invalidOutput("The execution task cancellation guard must be a UUIDv7.");
  }
  return Object.freeze({
    ...input,
    snapshot: Object.freeze(snapshot),
    executionTaskId: input.executionTaskId ?? null,
  });
}

async function commitSqliteOutput(
  transaction: TransactionExecutor,
  input: NormalizedCommitInput,
): Promise<ContextTraceOutputCommitOutcome> {
  await assertSqliteExecutionTaskCanCommit(transaction, input.executionTaskId);
  const traceRows = await transaction.select<TraceTargetRow>(
    `SELECT project_id AS projectId, chapter_id AS chapterId
     FROM context_compilation_runs
     WHERE id = ?
     LIMIT 2`,
    [input.traceId],
  );
  if (traceRows.length !== 1) {
    throw corruptOutput("The context trace is missing or duplicated.");
  }
  const trace = traceRows[0];
  if (
    trace?.projectId !== input.snapshot.projectId ||
    trace.chapterId !== input.snapshot.chapterId
  ) {
    throw outputConflict();
  }
  const executionRows = await transaction.select<{ readonly traceId: string }>(
    `SELECT trace_id AS traceId
     FROM context_compilation_execution_links
     WHERE trace_id = ?
     LIMIT 2`,
    [input.traceId],
  );
  if (executionRows.length !== 1) {
    throw corruptOutput("The context trace has no exact generation binding.");
  }
  await assertSqliteCreativeTargetCurrent(transaction, trace, input.snapshot, input.traceId);

  const linkRows = await transaction.select<OutputLinkRow>(
    `SELECT trace_id AS traceId, ai_candidate_id AS candidateId
     FROM context_compilation_output_candidate_links
     WHERE trace_id = ? OR ai_candidate_id = ?
     LIMIT 3`,
    [input.traceId, input.snapshot.id],
  );
  if (linkRows.length > 1) {
    throw corruptOutput("The context output association is duplicated.");
  }
  const existingLink = linkRows[0];
  if (
    existingLink !== undefined &&
    (existingLink.traceId !== input.traceId || existingLink.candidateId !== input.snapshot.id)
  ) {
    throw outputConflict();
  }

  const candidateRows = await selectCandidateRows(transaction, input.snapshot.id);
  if (candidateRows.length > 1) {
    throw corruptOutput("The AI Candidate is duplicated.");
  }
  const existingCandidate = candidateRows[0];
  if (existingCandidate !== undefined && !candidateRowMatches(existingCandidate, input.snapshot)) {
    throw outputConflict();
  }
  if (existingLink !== undefined) {
    if (existingCandidate === undefined) {
      throw corruptOutput("The context output association points to a missing AI Candidate.");
    }
    return "already_committed";
  }

  await assertSqliteExecutionTaskCanCommit(transaction, input.executionTaskId);
  if (existingCandidate === undefined) {
    await insertCandidate(transaction, input.snapshot);
  }
  await transaction.execute(
    `INSERT INTO context_compilation_output_candidate_links (
       trace_id, ai_candidate_id, linked_at
     ) VALUES (?, ?, ?)`,
    [input.traceId, input.snapshot.id, input.linkedAt],
  );
  return existingCandidate === undefined ? "created" : "already_committed";
}

async function assertSqliteExecutionTaskCanCommit(
  transaction: TransactionExecutor,
  executionTaskId: UuidV7 | null,
): Promise<void> {
  if (executionTaskId === null) return;
  const rows = await transaction.select<ExecutionTaskGuardRow>(
    `SELECT status, cancel_requested_at AS cancelRequestedAt
     FROM background_tasks
     WHERE id = ?
     LIMIT 2`,
    [executionTaskId],
  );
  if (rows.length !== 1 || rows[0]?.status !== "running" || rows[0].cancelRequestedAt !== null) {
    throw outputTargetChanged();
  }
}

async function assertSqliteCreativeTargetCurrent(
  transaction: TransactionExecutor,
  trace: TraceTargetRow,
  snapshot: AiCandidateSnapshot,
  traceId: string,
): Promise<void> {
  if (trace.chapterId === null || snapshot.chapterId === null || snapshot.baseVersionId === null) {
    throw invalidOutput("A creative context output requires exact chapter and version authority.");
  }
  const projectRows = await transaction.select<ProjectAuthorityRow>(
    `SELECT status
     FROM projects
     WHERE id = ?
     LIMIT 2`,
    [snapshot.projectId],
  );
  const chapterRows = await transaction.select<ChapterAuthorityRow>(
    `SELECT project_id AS projectId, status, current_version_id AS currentVersionId
     FROM chapters
     WHERE id = ?
     LIMIT 2`,
    [snapshot.chapterId],
  );
  const sourceVersions = await transaction.select<TraceSourceVersionRow>(
    `SELECT source.source_version_id AS sourceVersionId
     FROM context_compilation_entries AS entry
     INNER JOIN context_compilation_entry_sources AS source
       ON source.run_id = entry.run_id
      AND source.candidate_id = entry.candidate_id
     WHERE entry.run_id = ?
       AND entry.layer = 'current_task'
       AND entry.included = 1
       AND source.source_type IN ('generation_task', 'chapter')
     ORDER BY source.source_order`,
    [traceId],
  );
  if (
    projectRows.length !== 1 ||
    projectRows[0]?.status !== "active" ||
    chapterRows.length !== 1 ||
    chapterRows[0]?.projectId !== snapshot.projectId ||
    chapterRows[0].status !== "active" ||
    chapterRows[0].currentVersionId !== snapshot.baseVersionId ||
    sourceVersions.length === 0 ||
    sourceVersions.some(({ sourceVersionId }) => sourceVersionId !== snapshot.baseVersionId)
  ) {
    throw outputTargetChanged();
  }
}

async function assertDevelopmentCreativeTargetCurrent(
  authority: CreativeTargetAuthorityPort,
  trace: ContextCompilationTrace,
  snapshot: AiCandidateSnapshot,
): Promise<void> {
  if (snapshot.chapterId === null || snapshot.baseVersionId === null) {
    throw invalidOutput("A creative context output requires exact chapter and version authority.");
  }
  const [projectResult, chapterResult] = await Promise.all([
    authority.projects.findById(snapshot.projectId),
    authority.chapters.findById(snapshot.chapterId),
  ]);
  if (!projectResult.ok) throw projectResult.error;
  if (!chapterResult.ok) throw chapterResult.error;
  const currentTaskSources = trace.entries
    .filter(({ layer, included }) => layer === "current_task" && included)
    .flatMap(({ sources }) => sources)
    .filter(({ sourceType }) => sourceType === "generation_task" || sourceType === "chapter");
  if (
    projectResult.value?.status !== "active" ||
    chapterResult.value?.status !== "active" ||
    chapterResult.value.projectId !== snapshot.projectId ||
    chapterResult.value.currentVersionId !== snapshot.baseVersionId ||
    currentTaskSources.length === 0 ||
    currentTaskSources.some(({ sourceVersionId }) => sourceVersionId !== snapshot.baseVersionId)
  ) {
    throw outputTargetChanged();
  }
}

function selectCandidateRows(
  transaction: TransactionExecutor,
  candidateId: string,
): Promise<CandidateRow[]> {
  return transaction.select<CandidateRow>(
    `SELECT
       id,
       project_id AS projectId,
       chapter_id AS chapterId,
       source,
       base_version_id AS baseVersionId,
       content,
       content_checksum AS contentChecksum,
       status,
       revision,
       incomplete,
       created_at AS createdAt,
       updated_at AS updatedAt,
       decided_at AS decidedAt,
       task_intent AS taskIntent,
       application_mode AS applicationMode,
       payload_kind AS payloadKind,
       anchor_start_utf16 AS anchorStartUtf16,
       anchor_end_utf16 AS anchorEndUtf16
     FROM ai_candidates
     WHERE id = ?
     LIMIT 2`,
    [candidateId],
  );
}

function insertCandidate(
  transaction: TransactionExecutor,
  snapshot: AiCandidateSnapshot,
): Promise<unknown> {
  return transaction.execute(
    `INSERT INTO ai_candidates (
       id,
       project_id,
       chapter_id,
       source,
       base_version_id,
       content,
       content_checksum,
       status,
       revision,
       incomplete,
       created_at,
       updated_at,
       decided_at,
       task_intent,
       application_mode,
       payload_kind,
       anchor_start_utf16,
       anchor_end_utf16
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.chapterId,
      snapshot.source,
      snapshot.baseVersionId,
      snapshot.content,
      snapshot.contentChecksum,
      snapshot.status,
      snapshot.revision ?? 1,
      snapshot.incomplete ? 1 : 0,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.decidedAt,
      snapshot.applicationIntent?.task ?? "legacy_full_document",
      snapshot.applicationIntent?.application ?? "replace_document",
      snapshot.applicationIntent?.payload ?? "full_document",
      snapshot.applicationIntent?.startUtf16 ?? null,
      snapshot.applicationIntent?.endUtf16 ?? null,
    ],
  );
}

function candidateRowMatches(row: CandidateRow, snapshot: AiCandidateSnapshot): boolean {
  return (
    row.id === snapshot.id &&
    row.projectId === snapshot.projectId &&
    row.chapterId === snapshot.chapterId &&
    row.source === snapshot.source &&
    row.baseVersionId === snapshot.baseVersionId &&
    row.content === snapshot.content &&
    row.contentChecksum === snapshot.contentChecksum &&
    row.status === snapshot.status &&
    row.revision === (snapshot.revision ?? 1) &&
    row.incomplete === (snapshot.incomplete ? 1 : 0) &&
    row.createdAt === snapshot.createdAt &&
    row.updatedAt === snapshot.updatedAt &&
    row.decidedAt === snapshot.decidedAt &&
    row.taskIntent === (snapshot.applicationIntent?.task ?? "legacy_full_document") &&
    row.applicationMode === (snapshot.applicationIntent?.application ?? "replace_document") &&
    row.payloadKind === (snapshot.applicationIntent?.payload ?? "full_document") &&
    row.anchorStartUtf16 === (snapshot.applicationIntent?.startUtf16 ?? null) &&
    row.anchorEndUtf16 === (snapshot.applicationIntent?.endUtf16 ?? null)
  );
}

function candidateSnapshotsEqual(left: AiCandidateSnapshot, right: AiCandidateSnapshot): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.chapterId === right.chapterId &&
    left.source === right.source &&
    left.baseVersionId === right.baseVersionId &&
    left.content === right.content &&
    left.contentChecksum === right.contentChecksum &&
    left.status === right.status &&
    (left.revision ?? 1) === (right.revision ?? 1) &&
    left.incomplete === right.incomplete &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.decidedAt === right.decidedAt &&
    (left.applicationIntent?.task ?? "legacy_full_document") ===
      (right.applicationIntent?.task ?? "legacy_full_document") &&
    (left.applicationIntent?.application ?? "replace_document") ===
      (right.applicationIntent?.application ?? "replace_document") &&
    (left.applicationIntent?.payload ?? "full_document") ===
      (right.applicationIntent?.payload ?? "full_document") &&
    (left.applicationIntent?.startUtf16 ?? null) ===
      (right.applicationIntent?.startUtf16 ?? null) &&
    (left.applicationIntent?.endUtf16 ?? null) === (right.applicationIntent?.endUtf16 ?? null)
  );
}

async function expireDevelopmentCandidate(
  candidates: CandidatePersistencePort,
  candidate: AiCandidate,
  now: IsoUtcTimestamp,
): Promise<void> {
  const expired = candidate.expire(now);
  if (!expired.ok) {
    return;
  }
  await candidates
    .save(expired.value, { status: "ready", revision: candidate.revision })
    .catch(() => undefined);
}

function invalidOutput(message: string): ContextTraceOutputCommitError {
  return new ContextTraceOutputCommitError("CONTEXT_TRACE_OUTPUT_INVALID", message);
}

function outputConflict(): ContextTraceOutputCommitError {
  return new ContextTraceOutputCommitError(
    "CONTEXT_TRACE_OUTPUT_CONFLICT",
    "The context trace or AI Candidate is already bound to a different output.",
  );
}

function corruptOutput(message: string): ContextTraceOutputCommitError {
  return new ContextTraceOutputCommitError("CONTEXT_TRACE_OUTPUT_CORRUPT", message);
}

function outputTargetChanged(): ContextTraceOutputCommitError {
  return new ContextTraceOutputCommitError(
    "CONTEXT_TRACE_OUTPUT_TARGET_CHANGED",
    "The project, chapter, accepted version, or context source changed before the AI Candidate could be committed.",
    true,
  );
}

function normalizeCommitFailure(cause: unknown): ContextTraceOutputCommitError {
  if (cause instanceof ContextTraceOutputCommitError) {
    return cause;
  }
  return new ContextTraceOutputCommitError(
    "CONTEXT_TRACE_OUTPUT_UNAVAILABLE",
    "Unable to atomically commit the AI Candidate and context output association.",
    true,
  );
}
