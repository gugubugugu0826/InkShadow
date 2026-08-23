import { parseUuidV7 } from "@inkshadow/domain";
import type { CreateTaskInput, TaskSnapshot } from "@inkshadow/task-engine";

import type { CreativeJourneyRecord, CreativeJourneyStore } from "./creative-journey-store";
import type { TaskCenterStore } from "./task-center-store";

export const OPENING_JOURNEY_TASK_TYPE = "ai.opening.generate";
export const OPENING_JOURNEY_TASK_OPERATION = "creative_opening";

export type OpeningJourneyRunStage =
  | "journey_saved"
  | "workspace_provisioning"
  | "preflight"
  | "awaiting_confirmation"
  | "confirmed"
  | "invocation_reserving"
  | "provider_waiting"
  | "result_pending"
  | "completed"
  | "failed"
  | "cancelled_before_confirmation";

export interface OpeningJourneyRunV1 extends Readonly<Record<string, unknown>> {
  readonly version: 1;
  readonly journeyId: string;
  readonly batchId: string;
  readonly taskId: string;
  /** Stable local support number. It is also the batch correlation identifier. */
  readonly supportId: string;
  readonly requestIds: readonly string[];
  readonly stage: OpeningJourneyRunStage;
  readonly startedAt: string;
  readonly stageStartedAt: string;
  readonly deadlineAt: string;
  readonly terminalAt: string | null;
  readonly failureCode: string | null;
  /** Provider calls are never retried automatically. */
  readonly autoRetryCount: 0;
}

export interface OpeningJourneyRunInvocationState {
  readonly requestId: string;
  readonly status: "missing" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly providerDispatchStartedAt: string | null;
}

export class OpeningJourneyTaskScopeError extends Error {
  public readonly code = "OPENING_JOURNEY_TASK_SCOPE_MISMATCH";

  public constructor(public readonly supportId: string) {
    super("已有开书任务与当前构思批次不一致。墨影已停止继续处理，不会复用、改写或自动重发。");
    this.name = "OpeningJourneyTaskScopeError";
  }
}

export class OpeningJourneyRunScopeError extends Error {
  public readonly code = "OPENING_JOURNEY_RUN_SCOPE_MISMATCH";

  public constructor(public readonly supportId: string | null) {
    super("保存的开书进度无法安全读取。墨影已停止继续处理，不会改写这条记录或自动重发。");
    this.name = "OpeningJourneyRunScopeError";
  }
}
export type OpeningJourneyRunRecoveryDecision =
  | "continue_waiting"
  | "cancel_before_confirmation"
  | "fail_not_sent"
  | "result_pending"
  | "settled";

const TERMINAL_STAGES = new Set<OpeningJourneyRunStage>([
  "result_pending",
  "completed",
  "failed",
  "cancelled_before_confirmation",
]);
const BEFORE_CONFIRMATION_STAGES = new Set<OpeningJourneyRunStage>([
  "journey_saved",
  "workspace_provisioning",
  "preflight",
  "awaiting_confirmation",
]);
const STAGE_ORDER: Readonly<Record<OpeningJourneyRunStage, number>> = Object.freeze({
  journey_saved: 0,
  workspace_provisioning: 1,
  preflight: 2,
  awaiting_confirmation: 3,
  confirmed: 4,
  invocation_reserving: 5,
  provider_waiting: 6,
  result_pending: 7,
  completed: 7,
  failed: 7,
  cancelled_before_confirmation: 7,
});
const ALLOWED_STAGE_TRANSITIONS: Readonly<
  Record<OpeningJourneyRunStage, ReadonlySet<OpeningJourneyRunStage>>
> = Object.freeze({
  journey_saved: new Set<OpeningJourneyRunStage>([
    "workspace_provisioning",
    "failed",
    "cancelled_before_confirmation",
  ]),
  workspace_provisioning: new Set<OpeningJourneyRunStage>([
    "preflight",
    "failed",
    "cancelled_before_confirmation",
  ]),
  preflight: new Set<OpeningJourneyRunStage>([
    "awaiting_confirmation",
    "failed",
    "cancelled_before_confirmation",
  ]),
  awaiting_confirmation: new Set<OpeningJourneyRunStage>([
    "confirmed",
    "failed",
    "cancelled_before_confirmation",
  ]),
  confirmed: new Set<OpeningJourneyRunStage>(["invocation_reserving", "failed"]),
  invocation_reserving: new Set<OpeningJourneyRunStage>(["provider_waiting", "failed"]),
  provider_waiting: new Set<OpeningJourneyRunStage>(["result_pending", "completed", "failed"]),
  result_pending: new Set<OpeningJourneyRunStage>(),
  completed: new Set<OpeningJourneyRunStage>(),
  failed: new Set<OpeningJourneyRunStage>(),
  cancelled_before_confirmation: new Set<OpeningJourneyRunStage>(),
});

export function createOpeningJourneyRun(input: {
  readonly journeyId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly requestIds: readonly string[];
  readonly now: string;
  readonly timeoutMs: number;
}): OpeningJourneyRunV1 {
  const startedAt = normalizeTimestamp(input.now, "opening run start");
  if (
    !isUuidV7(input.journeyId) ||
    !isUuidV7(input.batchId) ||
    !isUuidV7(input.taskId) ||
    input.requestIds.length === 0 ||
    new Set(input.requestIds).size !== input.requestIds.length ||
    input.requestIds.some((requestId) => !isUuidV7(requestId)) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1
  ) {
    throw new Error("Opening journey run identifiers or timeout are invalid.");
  }
  return Object.freeze({
    version: 1 as const,
    journeyId: input.journeyId,
    batchId: input.batchId,
    taskId: input.taskId,
    supportId: input.batchId,
    requestIds: Object.freeze([...input.requestIds]),
    stage: "journey_saved" as const,
    startedAt,
    stageStartedAt: startedAt,
    deadlineAt: new Date(Date.parse(startedAt) + input.timeoutMs).toISOString(),
    terminalAt: null,
    failureCode: null,
    autoRetryCount: 0 as const,
  });
}

export function advanceOpeningJourneyRun(
  current: OpeningJourneyRunV1,
  input: {
    readonly stage: OpeningJourneyRunStage;
    readonly now: string;
    readonly failureCode?: string | null;
  },
): OpeningJourneyRunV1 {
  const now = normalizeTimestamp(input.now, "opening run stage");
  if (current.stage === input.stage) return current;
  if (TERMINAL_STAGES.has(current.stage)) {
    throw new Error("A terminal opening journey run cannot advance again.");
  }
  if (!ALLOWED_STAGE_TRANSITIONS[current.stage].has(input.stage)) {
    throw new Error("Opening journey run transition is not allowed from the current stage.");
  }
  if (Date.parse(now) < Date.parse(current.stageStartedAt)) {
    throw new Error("Opening journey run stage time cannot move backwards.");
  }
  const terminal = TERMINAL_STAGES.has(input.stage);
  return Object.freeze({
    ...current,
    stage: input.stage,
    stageStartedAt: now,
    terminalAt: terminal ? now : null,
    failureCode: input.failureCode ?? null,
    autoRetryCount: 0 as const,
  });
}

export function readOpeningJourneyRun(value: unknown): OpeningJourneyRunV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as Readonly<Record<string, unknown>>;
  if (
    run.version !== 1 ||
    typeof run.journeyId !== "string" ||
    !isUuidV7(run.journeyId) ||
    typeof run.batchId !== "string" ||
    !isUuidV7(run.batchId) ||
    typeof run.taskId !== "string" ||
    !isUuidV7(run.taskId) ||
    typeof run.supportId !== "string" ||
    !isUuidV7(run.supportId) ||
    !Array.isArray(run.requestIds) ||
    run.requestIds.length === 0 ||
    run.requestIds.some((requestId) => typeof requestId !== "string" || !isUuidV7(requestId)) ||
    typeof run.stage !== "string" ||
    !(run.stage in STAGE_ORDER) ||
    typeof run.startedAt !== "string" ||
    typeof run.stageStartedAt !== "string" ||
    typeof run.deadlineAt !== "string" ||
    (run.terminalAt !== null && typeof run.terminalAt !== "string") ||
    (run.failureCode !== null && typeof run.failureCode !== "string") ||
    run.autoRetryCount !== 0
  ) {
    return null;
  }
  try {
    const normalized = Object.freeze({
      version: 1 as const,
      journeyId: run.journeyId,
      batchId: run.batchId,
      taskId: run.taskId,
      supportId: run.supportId,
      requestIds: Object.freeze([...(run.requestIds as string[])]),
      stage: run.stage as OpeningJourneyRunStage,
      startedAt: normalizeTimestamp(run.startedAt, "opening run start"),
      stageStartedAt: normalizeTimestamp(run.stageStartedAt, "opening run stage"),
      deadlineAt: normalizeTimestamp(run.deadlineAt, "opening run deadline"),
      terminalAt:
        run.terminalAt === null ? null : normalizeTimestamp(run.terminalAt, "opening run terminal"),
      failureCode: run.failureCode,
      autoRetryCount: 0 as const,
    });
    if (
      normalized.supportId !== normalized.batchId ||
      new Set(normalized.requestIds).size !== normalized.requestIds.length ||
      TERMINAL_STAGES.has(normalized.stage) !== (normalized.terminalAt !== null) ||
      Date.parse(normalized.deadlineAt) <= Date.parse(normalized.startedAt) ||
      Date.parse(normalized.stageStartedAt) < Date.parse(normalized.startedAt) ||
      (normalized.terminalAt !== null &&
        (Date.parse(normalized.terminalAt) < Date.parse(normalized.startedAt) ||
          Date.parse(normalized.terminalAt) < Date.parse(normalized.stageStartedAt)))
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function openingJourneyRunElapsedMs(run: OpeningJourneyRunV1, nowValue: string): number {
  const now = Date.parse(normalizeTimestamp(nowValue, "opening run elapsed time"));
  const ended = run.terminalAt === null ? now : Date.parse(run.terminalAt);
  return Math.max(0, ended - Date.parse(run.startedAt));
}
export function isOpeningJourneyRunTerminal(run: OpeningJourneyRunV1): boolean {
  return TERMINAL_STAGES.has(run.stage);
}

export function openingJourneyRunRecoveryDecision(input: {
  readonly run: OpeningJourneyRunV1;
  readonly now: string;
  readonly pageExited: boolean;
  readonly invocations: readonly OpeningJourneyRunInvocationState[];
}): OpeningJourneyRunRecoveryDecision {
  if (TERMINAL_STAGES.has(input.run.stage)) return "settled";
  if (input.pageExited && BEFORE_CONFIRMATION_STAGES.has(input.run.stage)) {
    return "cancel_before_confirmation";
  }
  if (
    Date.parse(normalizeTimestamp(input.now, "opening recovery time")) <
    Date.parse(input.run.deadlineAt)
  ) {
    return "continue_waiting";
  }
  const knownInvocations = input.invocations.filter(({ status }) => status !== "missing");
  return knownInvocations.some(
    ({ providerDispatchStartedAt }) => providerDispatchStartedAt !== null,
  )
    ? "result_pending"
    : "fail_not_sent";
}

export async function checkpointOpeningJourneyRun(
  store: CreativeJourneyStore,
  journeyId: string,
  input: {
    readonly stage: OpeningJourneyRunStage;
    readonly now: string;
    readonly failureCode?: string | null;
  },
): Promise<CreativeJourneyRecord> {
  let latest = await store.findById(journeyId);
  if (latest === null) {
    throw new Error("Opening journey was not found while saving its run stage.");
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = readOpeningJourneyRun(latest.snapshot.openingRun);
    if (run?.journeyId !== journeyId || latest.id !== journeyId) {
      throw new OpeningJourneyRunScopeError(
        trustedOpeningJourneyRunSupportId(latest.snapshot.openingRun),
      );
    }
    if (run.stage === input.stage || TERMINAL_STAGES.has(run.stage)) return latest;
    const nextRun = advanceOpeningJourneyRun(run, input);
    const updated = Object.freeze({
      ...latest,
      revision: latest.revision + 1,
      snapshot: Object.freeze({
        ...latest.snapshot,
        openingRun: nextRun,
      }),
      updatedAt: normalizeTimestamp(input.now, "opening run checkpoint"),
    });
    try {
      await store.update(updated, latest.revision);
      return updated;
    } catch (cause: unknown) {
      const current = await store.findById(journeyId);
      if (current === null) throw cause;
      if (current.revision <= latest.revision) throw cause;
      latest = current;
    }
  }
  throw new Error("Opening journey run changed too often to save its next stage.");
}

export function openingJourneyTaskInput(run: OpeningJourneyRunV1, now: string): CreateTaskInput {
  return Object.freeze({
    id: run.taskId,
    type: OPENING_JOURNEY_TASK_TYPE,
    idempotencyKey: `idea.opening:${run.journeyId}:${run.batchId}`,
    metadata: Object.freeze({
      operation: OPENING_JOURNEY_TASK_OPERATION,
      journeyId: run.journeyId,
      batchId: run.batchId,
      supportId: run.supportId,
      requestCount: run.requestIds.length,
      autoRetryCount: 0,
    }),
    priority: 85,
    maxAttempts: 1,
    now: normalizeTimestamp(now, "opening task creation"),
  });
}

export async function ensureOpeningJourneyTask(
  taskCenter: TaskCenterStore,
  run: OpeningJourneyRunV1,
  now: string,
): Promise<TaskSnapshot> {
  const input = openingJourneyTaskInput(run, now);
  const existing = await taskCenter.findTaskByIdempotencyKey(input.idempotencyKey);
  const task = existing ?? (await taskCenter.enqueueTask(input)).task;
  return assertOpeningJourneyTaskMatchesRun(task, run, input.idempotencyKey);
}

function assertOpeningJourneyTaskMatchesRun(
  task: TaskSnapshot,
  run: OpeningJourneyRunV1,
  idempotencyKey: string,
): TaskSnapshot {
  if (!openingJourneyTaskMatchesRun(task, run, idempotencyKey)) {
    throw new OpeningJourneyTaskScopeError(run.supportId);
  }
  return task;
}

function openingJourneyTaskMatchesRun(
  task: TaskSnapshot,
  run: OpeningJourneyRunV1,
  idempotencyKey: string,
): boolean {
  const metadata = task.metadata;
  return (
    task.id === run.taskId &&
    task.type === OPENING_JOURNEY_TASK_TYPE &&
    task.idempotencyKey === idempotencyKey &&
    task.priority === 85 &&
    task.maxAttempts === 1 &&
    metadata.operation === OPENING_JOURNEY_TASK_OPERATION &&
    metadata.journeyId === run.journeyId &&
    metadata.batchId === run.batchId &&
    metadata.supportId === run.supportId &&
    metadata.requestCount === run.requestIds.length &&
    metadata.autoRetryCount === 0 &&
    (task.progress === null || task.progress.step in OPENING_TASK_PROGRESS_ORDER) &&
    openingJourneyTaskStatusMatchesRun(task, run.stage)
  );
}

function openingJourneyTaskStatusMatchesRun(
  task: TaskSnapshot,
  stage: OpeningJourneyRunStage,
): boolean {
  if (stage !== "cancelled_before_confirmation" && task.cancelRequestedAt !== null) {
    return false;
  }
  if (stage === "completed") {
    return task.status === "queued" || task.status === "running" || task.status === "succeeded";
  }
  if (stage === "failed" || stage === "result_pending") {
    return task.status === "queued" || task.status === "running" || task.status === "failed";
  }
  if (stage === "cancelled_before_confirmation") {
    return task.status === "queued" || task.status === "running" || task.status === "cancelled";
  }
  return task.status === "queued" || task.status === "running";
}

export async function projectOpeningJourneyTaskStage(
  taskCenter: TaskCenterStore,
  run: OpeningJourneyRunV1,
  step: "opening.invocation" | "opening.provider_waiting",
  nowValue: string,
): Promise<TaskSnapshot> {
  const now = normalizeTimestamp(nowValue, "opening task progress");
  const idempotencyKey = openingJourneyTaskInput(run, now).idempotencyKey;
  let task = await ensureOpeningJourneyTask(taskCenter, run, now);
  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < OPENING_TASK_PROJECTION_MAX_ATTEMPTS; attempt += 1) {
    if (
      task.status === "succeeded" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      task.cancelRequestedAt !== null ||
      openingJourneyTaskReachedStep(task, step)
    ) {
      return task;
    }
    if (task.status === "queued") {
      try {
        task = assertOpeningJourneyTaskMatchesRun(
          await taskCenter.startTask(
            task.id,
            "opening-journey-ui",
            run.taskId,
            new Date(Math.max(Date.parse(run.deadlineAt), Date.parse(now) + 60_000)).toISOString(),
          ),
          run,
          idempotencyKey,
        );
      } catch (cause: unknown) {
        if (!isTaskSequenceConflict(cause)) throw cause;
        lastConflict = cause;
        task = await rereadOpeningJourneyTaskAfterConflict(taskCenter, run, idempotencyKey, cause);
        if (openingJourneyTaskReachedStep(task, step)) return task;
        if (attempt === OPENING_TASK_PROJECTION_MAX_ATTEMPTS - 1) throw cause;
        continue;
      }
    }
    if (task.status !== "running") {
      throw new OpeningJourneyTaskScopeError(run.supportId);
    }
    if (openingJourneyTaskReachedStep(task, step)) return task;
    try {
      const reported = assertOpeningJourneyTaskMatchesRun(
        await taskCenter.reportTaskProgress(task.id, run.taskId, step, 0, null),
        run,
        idempotencyKey,
      );
      if (!openingJourneyTaskReachedStep(reported, step)) {
        throw new OpeningJourneyTaskScopeError(run.supportId);
      }
      return reported;
    } catch (cause: unknown) {
      if (!isTaskSequenceConflict(cause)) throw cause;
      lastConflict = cause;
      task = await rereadOpeningJourneyTaskAfterConflict(taskCenter, run, idempotencyKey, cause);
      if (openingJourneyTaskReachedStep(task, step)) return task;
      if (attempt === OPENING_TASK_PROJECTION_MAX_ATTEMPTS - 1) throw cause;
    }
  }
  throw lastConflict;
}

export async function settleOpeningJourneyTask(
  taskCenter: TaskCenterStore,
  run: OpeningJourneyRunV1,
  input:
    | Readonly<{ status: "succeeded"; now: string }>
    | Readonly<{ status: "cancelled"; now: string }>
    | Readonly<{ status: "failed"; now: string; failureCode: string; causeCode?: string | null }>,
): Promise<TaskSnapshot> {
  const now = normalizeTimestamp(input.now, "opening task settlement");
  let task = await ensureOpeningJourneyTask(taskCenter, run, now);
  if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
    return task;
  }
  if (input.status === "cancelled") {
    task = await taskCenter.cancelTask(task.id);
    return task.status === "running"
      ? taskCenter.acknowledgeTaskCancellation(task.id, run.taskId)
      : task;
  }
  if (task.status !== "running") {
    task = await taskCenter.startTask(
      task.id,
      "opening-journey-ui",
      run.taskId,
      new Date(Math.max(Date.parse(run.deadlineAt), Date.parse(now) + 60_000)).toISOString(),
    );
  }
  if (input.status === "succeeded") {
    return taskCenter.completeTask(task.id, run.taskId);
  }
  return taskCenter.failTask(
    task.id,
    run.taskId,
    {
      code: safeFailureCode(input.failureCode) ?? "OPENING_GENERATION_FAILED",
      causeCode: input.causeCode === undefined ? null : safeFailureCode(input.causeCode),
      retryable: false,
      actions: ["EXPORT_DIAGNOSTICS", "CONTACT_SUPPORT"],
      requestId: run.supportId,
    },
    null,
  );
}

function normalizeTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label} timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function safeFailureCode(value: string | null): string | null {
  if (value === null) return null;
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : "OPENING_GENERATION_FAILED";
}

const OPENING_TASK_PROJECTION_MAX_ATTEMPTS = 4;
const OPENING_TASK_PROGRESS_ORDER = Object.freeze({
  "opening.invocation": 0,
  "opening.provider_waiting": 1,
} as const);

function openingJourneyTaskReachedStep(
  task: TaskSnapshot,
  target: keyof typeof OPENING_TASK_PROGRESS_ORDER,
): boolean {
  const current = task.progress?.step;
  return (
    current !== undefined &&
    current in OPENING_TASK_PROGRESS_ORDER &&
    OPENING_TASK_PROGRESS_ORDER[current as keyof typeof OPENING_TASK_PROGRESS_ORDER] >=
      OPENING_TASK_PROGRESS_ORDER[target]
  );
}

async function rereadOpeningJourneyTaskAfterConflict(
  taskCenter: TaskCenterStore,
  run: OpeningJourneyRunV1,
  idempotencyKey: string,
  conflict: unknown,
): Promise<TaskSnapshot> {
  const task = await taskCenter.findTaskByIdempotencyKey(idempotencyKey);
  if (task === null) throw conflict;
  return assertOpeningJourneyTaskMatchesRun(task, run, idempotencyKey);
}

function isTaskSequenceConflict(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "TASK_SEQUENCE_CONFLICT"
  );
}

function trustedOpeningJourneyRunSupportId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as Readonly<Record<string, unknown>>;
  return typeof run.batchId === "string" &&
    typeof run.supportId === "string" &&
    run.batchId === run.supportId &&
    isUuidV7(run.supportId)
    ? run.supportId
    : null;
}

function isUuidV7(value: string): boolean {
  return parseUuidV7(value).ok;
}
