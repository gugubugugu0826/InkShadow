import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

export const CONSISTENCY_REPAIR_TASK_TYPE = "consistency.repair-candidate";
export const CONSISTENCY_REPAIR_TASK_OPERATION = "consistency_repair_candidate";

const METADATA_SCHEMA_VERSION = 1;
type ActiveTaskStatus = "queued" | "running" | "waiting_retry" | "paused";

export interface ConsistencyRepairTaskMetadataInput {
  readonly runId: string;
  readonly findingId: string;
  readonly findingRevision: number;
  readonly targetChapterId: string;
  readonly targetVersionId: string;
  readonly generationId: string;
  readonly invocationId: string;
  readonly contextTraceId: string;
  readonly candidateId: string;
  readonly requestFingerprint: string;
  readonly privacyFingerprint: string;
}

interface RepairTaskMetadata extends ConsistencyRepairTaskMetadataInput {
  readonly taskType: typeof CONSISTENCY_REPAIR_TASK_TYPE;
  readonly operation: typeof CONSISTENCY_REPAIR_TASK_OPERATION;
  readonly schemaVersion: typeof METADATA_SCHEMA_VERSION;
  readonly attempt: 1;
  readonly routeTask: "rewrite";
  readonly maximumModelCalls: 1;
  readonly automaticRetryCount: 0;
}

interface RecoveryTaskRow {
  readonly id: string;
  readonly status: ActiveTaskStatus;
  readonly metadataJson: string;
}

interface InvocationRow {
  readonly id: string;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly dispatchedAt: string | null;
  readonly errorCode: string | null;
  readonly revision: number;
}

interface CandidateLinkRow {
  readonly candidateId: string;
}

type RecoveryTerminal =
  | "candidate_committed"
  | "planned_not_dispatched"
  | "bound_not_dispatched"
  | "provider_result_ambiguous"
  | "provider_result_discarded"
  | "known_failure"
  | "cancelled";

/**
 * Persists only bounded, content-free recovery authority in the existing task
 * row. No chapter prose, finding prose, prompt, output or credential is stored.
 */
export function createConsistencyRepairTaskMetadata(
  input: ConsistencyRepairTaskMetadataInput,
): Readonly<Record<string, string | number | boolean>> {
  return Object.freeze({
    taskType: CONSISTENCY_REPAIR_TASK_TYPE,
    operation: CONSISTENCY_REPAIR_TASK_OPERATION,
    schemaVersion: METADATA_SCHEMA_VERSION,
    attempt: 1,
    routeTask: "rewrite",
    maximumModelCalls: 1,
    automaticRetryCount: 0,
    runId: input.runId,
    findingId: input.findingId,
    findingRevision: input.findingRevision,
    targetChapterId: input.targetChapterId,
    targetVersionId: input.targetVersionId,
    generationId: input.generationId,
    invocationId: input.invocationId,
    contextTraceId: input.contextTraceId,
    candidateId: input.candidateId,
    requestFingerprint: input.requestFingerprint,
    privacyFingerprint: input.privacyFingerprint,
  });
}

/**
 * Startup-only reconciliation for the existing task/invocation/trace/Candidate
 * chain. It can only terminalize durable evidence and never dispatches a model,
 * rebuilds a prompt, or creates a Candidate.
 */
export async function recoverConsistencyRepairCandidatesAtStartup(
  executor: SqlExecutor,
  now: string,
): Promise<number> {
  const tasks = await executor.select<RecoveryTaskRow>(
    `SELECT id, status, metadata_json AS metadataJson
     FROM background_tasks
     WHERE task_type = ?
       AND status IN ('queued', 'running', 'waiting_retry', 'paused')
     ORDER BY created_at ASC, id ASC`,
    [CONSISTENCY_REPAIR_TASK_TYPE],
  );
  let recovered = 0;
  for (const task of tasks) {
    recovered += await executor.transaction(async (transaction) => {
      const metadata = parseMetadata(task.metadataJson);
      if (metadata === null) {
        return failTask(
          transaction,
          task.id,
          now,
          "CONSISTENCY_REPAIR_RECOVERY_INVALID",
          "REPAIR_RECOVERY_METADATA_INVALID",
        );
      }
      const output = await findCommittedCandidate(transaction, metadata);
      if (output) {
        return terminalizeTask(transaction, task.id, now, "candidate_committed");
      }
      const invocation = await findInvocation(transaction, metadata.invocationId);
      const terminal = classifyInterruptedRepair(invocation);
      await settleInterruptedInvocation(transaction, invocation, now);
      return terminalizeTask(transaction, task.id, now, terminal, invocation?.errorCode ?? null);
    });
  }
  return recovered;
}

/**
 * A native cancellation acknowledgement after the durable dispatch receipt is
 * not proof that the Provider did no work. Reclassify that physical receipt as
 * ambiguous where possible; a late durable success remains succeeded but is
 * still discarded by the repair service.
 */
export async function settleDispatchedRepairCancellationAsAmbiguous(
  executor: SqlExecutor,
  taskId: string,
  invocationId: string,
  now: string,
): Promise<void> {
  await executor.transaction(async (transaction) => {
    const invocation = await findInvocation(transaction, invocationId);
    if (
      typeof invocation?.dispatchedAt !== "string" ||
      (invocation.status !== "running" && invocation.status !== "cancelled")
    ) {
      await failTask(
        transaction,
        taskId,
        now,
        "CONSISTENCY_REPAIR_RESULT_AMBIGUOUS",
        "PROVIDER_RESULT_AMBIGUOUS",
      );
      return;
    }
    const result = await transaction.execute(
      `UPDATE model_invocation_facts
       SET status = 'timed_out', error_code = 'PROVIDER_RESULT_AMBIGUOUS',
           error_summary = ?, completed_at = COALESCE(completed_at, ?),
           revision = revision + 1
       WHERE id = ? AND revision = ?
         AND status IN ('running', 'cancelled')
         AND provider_dispatch_started_at IS NOT NULL`,
      [
        "修复建议在模型发送后被取消，结果不确定且不会自动重发；正文和版本未改变。",
        now,
        invocation.id,
        invocation.revision,
      ],
    );
    if (result.rowsAffected !== 1) {
      const current = await findInvocation(transaction, invocationId);
      if (current?.status !== "timed_out" || current.errorCode !== "PROVIDER_RESULT_AMBIGUOUS") {
        throw new Error("Consistency repair cancellation lost its invocation CAS boundary.");
      }
    }
    await failTask(
      transaction,
      taskId,
      now,
      "CONSISTENCY_REPAIR_RESULT_AMBIGUOUS",
      "PROVIDER_RESULT_AMBIGUOUS",
    );
  });
}

async function findCommittedCandidate(
  transaction: TransactionExecutor,
  metadata: RepairTaskMetadata,
): Promise<boolean> {
  const rows = await transaction.select<CandidateLinkRow>(
    `SELECT output.ai_candidate_id AS candidateId
     FROM context_compilation_output_candidate_links AS output
     INNER JOIN ai_candidates AS candidate ON candidate.id = output.ai_candidate_id
     WHERE output.trace_id = ?
     LIMIT 1`,
    [metadata.contextTraceId],
  );
  const row = rows[0];
  return row?.candidateId === metadata.candidateId;
}

async function findInvocation(
  transaction: Pick<TransactionExecutor, "select">,
  invocationId: string,
): Promise<InvocationRow | null> {
  const rows = await transaction.select<InvocationRow>(
    `SELECT id, status, provider_dispatch_started_at AS dispatchedAt,
            error_code AS errorCode, revision
     FROM model_invocation_facts
     WHERE id = ?
     LIMIT 1`,
    [invocationId],
  );
  return rows[0] ?? null;
}

function classifyInterruptedRepair(invocation: InvocationRow | null): RecoveryTerminal {
  if (invocation === null) return "planned_not_dispatched";
  if (invocation.status === "succeeded") return "provider_result_discarded";
  if (
    invocation.dispatchedAt !== null &&
    (invocation.status === "running" ||
      invocation.status === "cancelled" ||
      invocation.status === "timed_out")
  ) {
    return "provider_result_ambiguous";
  }
  if (invocation.status === "failed") return "known_failure";
  if (invocation.status === "cancelled") return "cancelled";
  return "bound_not_dispatched";
}

async function settleInterruptedInvocation(
  transaction: TransactionExecutor,
  invocation: InvocationRow | null,
  now: string,
): Promise<void> {
  if (invocation === null) return;
  const dispatched = invocation.dispatchedAt !== null;
  if (invocation.status === "cancelled" && !dispatched) return;
  if (
    invocation.status !== "running" &&
    invocation.status !== "queued" &&
    !(invocation.status === "cancelled" && dispatched)
  ) {
    return;
  }
  const result = await transaction.execute(
    `UPDATE model_invocation_facts
     SET status = ?, error_code = ?, error_summary = ?,
         started_at = COALESCE(started_at, ?), completed_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ? AND status = ?
       AND provider_dispatch_started_at IS ${dispatched ? "NOT NULL" : "NULL"}`,
    [
      dispatched ? "timed_out" : "cancelled",
      dispatched ? "PROVIDER_RESULT_AMBIGUOUS" : null,
      dispatched ? "应用在修复建议发送后中断，结果不确定且不会自动重发；正文和版本未改变。" : null,
      now,
      now,
      invocation.id,
      invocation.revision,
      invocation.status,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw new Error("Consistency repair recovery lost its invocation CAS boundary.");
  }
}

function terminalizeTask(
  transaction: TransactionExecutor,
  taskId: string,
  now: string,
  terminal: RecoveryTerminal,
  invocationErrorCode: string | null = null,
): Promise<number> {
  if (terminal === "candidate_committed") return completeTask(transaction, taskId, now);
  if (terminal === "planned_not_dispatched" || terminal === "cancelled") {
    return cancelTask(transaction, taskId, now);
  }
  if (terminal === "provider_result_ambiguous") {
    return failTask(
      transaction,
      taskId,
      now,
      "CONSISTENCY_REPAIR_RESULT_AMBIGUOUS",
      "PROVIDER_RESULT_AMBIGUOUS",
    );
  }
  if (terminal === "provider_result_discarded") {
    return failTask(
      transaction,
      taskId,
      now,
      "CONSISTENCY_REPAIR_RESULT_DISCARDED",
      "RESTART_AFTER_PROVIDER_SUCCESS",
    );
  }
  return failTask(
    transaction,
    taskId,
    now,
    terminal === "bound_not_dispatched"
      ? "CONSISTENCY_REPAIR_NOT_DISPATCHED"
      : "CONSISTENCY_REPAIR_FAILED",
    terminal === "bound_not_dispatched"
      ? "RESTART_BEFORE_PROVIDER_DISPATCH"
      : (invocationErrorCode ?? "CONSISTENCY_REPAIR_FAILED"),
  );
}

async function completeTask(
  transaction: TransactionExecutor,
  taskId: string,
  now: string,
): Promise<number> {
  const result = await transaction.execute(
    `UPDATE background_tasks
     SET status = 'succeeded', sequence = sequence + 1, run_after = NULL,
         lease_owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         failure_code = NULL, failure_cause_code = NULL, failure_retryable = NULL,
         failure_actions_json = NULL, failure_request_id = NULL,
         cancel_requested_at = NULL, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'waiting_retry', 'paused')`,
    [now, now, taskId],
  );
  return result.rowsAffected;
}

async function cancelTask(
  transaction: TransactionExecutor,
  taskId: string,
  now: string,
): Promise<number> {
  const result = await transaction.execute(
    `UPDATE background_tasks
     SET status = 'cancelled', sequence = sequence + 1, run_after = NULL,
         lease_owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         failure_code = NULL, failure_cause_code = NULL, failure_retryable = NULL,
         failure_actions_json = NULL, failure_request_id = NULL,
         cancel_requested_at = COALESCE(cancel_requested_at, ?),
         updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'waiting_retry', 'paused')`,
    [now, now, now, taskId],
  );
  return result.rowsAffected;
}

async function failTask(
  transaction: TransactionExecutor,
  taskId: string,
  now: string,
  code: string,
  causeCode: string,
): Promise<number> {
  const result = await transaction.execute(
    `UPDATE background_tasks
     SET status = 'failed', sequence = sequence + 1, run_after = NULL,
         lease_owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         failure_code = ?, failure_cause_code = ?, failure_retryable = 0,
         failure_actions_json = '["EXPORT_DIAGNOSTICS"]', failure_request_id = ?,
         cancel_requested_at = NULL, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'waiting_retry', 'paused')`,
    [code, causeCode, `consistency-repair/${taskId}`, now, now, taskId],
  );
  return result.rowsAffected;
}

function parseMetadata(serialized: string): RepairTaskMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.taskType !== CONSISTENCY_REPAIR_TASK_TYPE ||
    value.operation !== CONSISTENCY_REPAIR_TASK_OPERATION ||
    value.schemaVersion !== METADATA_SCHEMA_VERSION ||
    value.attempt !== 1 ||
    value.routeTask !== "rewrite" ||
    value.maximumModelCalls !== 1 ||
    value.automaticRetryCount !== 0 ||
    typeof value.findingRevision !== "number" ||
    !Number.isSafeInteger(value.findingRevision)
  ) {
    return null;
  }
  for (const key of [
    "runId",
    "findingId",
    "targetChapterId",
    "targetVersionId",
    "generationId",
    "invocationId",
    "contextTraceId",
    "candidateId",
    "requestFingerprint",
    "privacyFingerprint",
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) return null;
  }
  return value as unknown as RepairTaskMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
