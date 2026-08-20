import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import type { TaskCenterStore } from "./task-center-store";

export interface RecoveredConsistencyInvestigation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly status: "succeeded" | "partial" | "not_dispatched" | "ambiguous";
}

interface InterruptedRunRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly status: "planned" | "dispatched" | "observing" | "verifying";
  readonly revision: number;
  readonly droppedFindingCount: number;
}

interface InterruptedInvocationRow {
  readonly invocationId: string | null;
  readonly dispatchedAt: string | null;
  readonly invocationStatus:
    "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | null;
  readonly invocationRevision: number | null;
}

export async function recoverConsistencyInvestigationRuns(
  executor: SqlExecutor,
  now: string,
): Promise<readonly RecoveredConsistencyInvestigation[]> {
  const rows = await executor.select<InterruptedRunRow>(
    `SELECT id, idempotency_key AS idempotencyKey, status, revision,
            dropped_finding_count AS droppedFindingCount
     FROM consistency_investigation_runs
     WHERE status IN ('planned', 'dispatched', 'observing', 'verifying')
     ORDER BY created_at ASC, id ASC`,
  );
  const recovered: RecoveredConsistencyInvestigation[] = [];
  for (const row of rows) {
    if (row.status === "verifying") {
      const status = row.droppedFindingCount > 0 ? "partial" : "succeeded";
      await executor.transaction(async (transaction) => {
        await transaction.execute(
          `UPDATE consistency_investigation_steps
           SET status = 'succeeded', terminal_cause = 'RECOVERED_VERIFIED_EVIDENCE',
               updated_at = ?, completed_at = ?
           WHERE run_id = ? AND step_kind = 'verifier' AND status = 'reserved'`,
          [now, now, row.id],
        );
        const result = await transaction.execute(
          `UPDATE consistency_investigation_runs
           SET status = ?, revision = revision + 1, updated_at = ?, completed_at = ?
           WHERE id = ? AND revision = ? AND status = 'verifying'`,
          [status, now, now, row.id, row.revision],
        );
        assertSingleRecovery(result.rowsAffected);
      });
      recovered.push(Object.freeze({ id: row.id, idempotencyKey: row.idempotencyKey, status }));
      continue;
    }

    const status = await executor.transaction(async (transaction) => {
      const dispatchRows = await transaction.select<InterruptedInvocationRow>(
        `SELECT COALESCE(step.invocation_id, step.planned_invocation_id) AS invocationId,
                invocation.provider_dispatch_started_at AS dispatchedAt,
                invocation.status AS invocationStatus,
                invocation.revision AS invocationRevision
         FROM consistency_investigation_steps AS step
         LEFT JOIN model_invocation_facts AS invocation
           ON invocation.id = COALESCE(step.invocation_id, step.planned_invocation_id)
         WHERE step.run_id = ? AND step.step_kind = 'model'
         LIMIT 1`,
        [row.id],
      );
      const boundary = dispatchRows[0] ?? {
        invocationId: null,
        dispatchedAt: null,
        invocationStatus: null,
        invocationRevision: null,
      };
      const dispatched = boundary.dispatchedAt !== null;
      const recoveredStatus = dispatched ? "ambiguous" : "not_dispatched";
      await settleInterruptedInvocation(transaction, boundary, now);
      await transaction.execute(
        `UPDATE consistency_investigation_steps
         SET status = ?, terminal_cause = ?, updated_at = ?, completed_at = ?
         WHERE run_id = ? AND status IN ('reserved', 'bound', 'dispatched')`,
        [
          recoveredStatus,
          dispatched ? "RESTART_AFTER_DISPATCH" : "RESTART_BEFORE_DISPATCH",
          now,
          now,
          row.id,
        ],
      );
      const result = await transaction.execute(
        `UPDATE consistency_investigation_runs
         SET status = ?, revision = revision + 1, updated_at = ?, completed_at = ?
         WHERE id = ? AND revision = ? AND status IN ('planned', 'dispatched', 'observing')`,
        [recoveredStatus, now, now, row.id, row.revision],
      );
      assertSingleRecovery(result.rowsAffected);
      return recoveredStatus;
    });
    recovered.push(Object.freeze({ id: row.id, idempotencyKey: row.idempotencyKey, status }));
  }
  return Object.freeze(recovered);
}

async function settleInterruptedInvocation(
  transaction: TransactionExecutor,
  boundary: InterruptedInvocationRow,
  now: string,
): Promise<void> {
  if (
    boundary.invocationId === null ||
    boundary.invocationStatus !== "running" ||
    boundary.invocationRevision === null
  ) {
    return;
  }
  const dispatched = boundary.dispatchedAt !== null;
  const result = await transaction.execute(
    `UPDATE model_invocation_facts
     SET status = ?, error_code = ?, error_summary = ?, completed_at = ?, revision = revision + 1
     WHERE id = ? AND status = 'running' AND revision = ?
       AND provider_dispatch_started_at IS ${dispatched ? "NOT NULL" : "NULL"}`,
    [
      dispatched ? "timed_out" : "cancelled",
      dispatched ? "PROVIDER_RESULT_AMBIGUOUS" : null,
      dispatched ? "应用在模型发送后中断，结果不确定且不会自动重发；正文和版本未改变。" : null,
      now,
      boundary.invocationId,
      boundary.invocationRevision,
    ],
  );
  assertSingleRecovery(result.rowsAffected);
}

export async function recoverConsistencyInvestigationsAtStartup(
  input: Readonly<{
    executor: SqlExecutor;
    taskCenter: TaskCenterStore;
    clock: Clock;
    ids: UuidV7Generator;
  }>,
): Promise<number> {
  // Keep the public dependencies stable for the desktop factory while task
  // reconciliation is committed directly beside its authoritative run.
  void input.taskCenter;
  void input.ids;
  const now = input.clock.now();
  await recoverConsistencyInvestigationRuns(input.executor, now);
  return reconcileTerminalInvestigationTasks(input.executor, now);
}

interface TerminalInvestigationTaskRow {
  readonly runId: string;
  readonly taskId: string;
  readonly status:
    "succeeded" | "partial" | "failed" | "cancelled" | "not_dispatched" | "ambiguous";
  readonly failureCode: string | null;
}

async function reconcileTerminalInvestigationTasks(
  executor: SqlExecutor,
  now: string,
): Promise<number> {
  return executor.transaction(async (transaction) => {
    const rows = await transaction.select<TerminalInvestigationTaskRow>(
      `SELECT run.id AS runId, run.task_id AS taskId, run.status,
              run.failure_code AS failureCode
       FROM consistency_investigation_runs AS run
       INNER JOIN background_tasks AS task ON task.id = run.task_id
       WHERE run.status IN (
         'succeeded', 'partial', 'failed', 'cancelled', 'not_dispatched', 'ambiguous'
       )
         AND task.status IN ('queued', 'running', 'waiting_retry', 'paused')
       ORDER BY run.completed_at ASC, run.id ASC`,
    );
    let reconciled = 0;
    for (const row of rows) {
      const result = ["succeeded", "partial"].includes(row.status)
        ? await completeRecoveredTask(transaction, row, now)
        : row.status === "cancelled"
          ? await cancelRecoveredTask(transaction, row, now)
          : await failRecoveredTask(transaction, row, now);
      reconciled += result.rowsAffected;
    }
    return reconciled;
  });
}

function completeRecoveredTask(
  transaction: TransactionExecutor,
  row: TerminalInvestigationTaskRow,
  now: string,
) {
  return transaction.execute(
    `UPDATE background_tasks
     SET status = 'succeeded', sequence = sequence + 1, run_after = NULL,
         lease_owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         failure_code = NULL, failure_cause_code = NULL, failure_retryable = NULL,
         failure_actions_json = NULL, failure_request_id = NULL,
         cancel_requested_at = NULL, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'waiting_retry', 'paused')`,
    [now, now, row.taskId],
  );
}

function cancelRecoveredTask(
  transaction: TransactionExecutor,
  row: TerminalInvestigationTaskRow,
  now: string,
) {
  return transaction.execute(
    `UPDATE background_tasks
     SET status = 'cancelled', sequence = sequence + 1, run_after = NULL,
         lease_owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         failure_code = NULL, failure_cause_code = NULL, failure_retryable = NULL,
         failure_actions_json = NULL, failure_request_id = NULL,
         cancel_requested_at = COALESCE(cancel_requested_at, ?),
         updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'waiting_retry', 'paused')`,
    [now, now, now, row.taskId],
  );
}

function failRecoveredTask(
  transaction: TransactionExecutor,
  row: TerminalInvestigationTaskRow,
  now: string,
) {
  const failure = recoveredTaskFailure(row);
  return transaction.execute(
    `UPDATE background_tasks
     SET status = 'failed', sequence = sequence + 1, run_after = NULL,
         lease_owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         failure_code = ?, failure_cause_code = ?, failure_retryable = 0,
         failure_actions_json = '["EXPORT_DIAGNOSTICS"]', failure_request_id = ?,
         cancel_requested_at = NULL, updated_at = ?, finished_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'waiting_retry', 'paused')`,
    [
      failure.code,
      failure.causeCode,
      `consistency-investigation/${row.runId}`,
      now,
      now,
      row.taskId,
    ],
  );
}

function recoveredTaskFailure(row: TerminalInvestigationTaskRow): Readonly<{
  code: string;
  causeCode: string;
}> {
  if (row.status === "ambiguous") {
    return { code: "AGENT_RESULT_AMBIGUOUS", causeCode: "RESTART_AFTER_PROVIDER_DISPATCH" };
  }
  if (row.status === "not_dispatched") {
    return { code: "AGENT_NOT_DISPATCHED", causeCode: "RESTART_BEFORE_PROVIDER_DISPATCH" };
  }
  return {
    code: "AGENT_RESULT_INVALID",
    causeCode: row.failureCode ?? "AGENT_RUN_FAILED",
  };
}

function assertSingleRecovery(rowsAffected: number): void {
  if (rowsAffected !== 1) {
    throw new Error("Consistency investigation recovery lost its compare-and-swap boundary.");
  }
}
