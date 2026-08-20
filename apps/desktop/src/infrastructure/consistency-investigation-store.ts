import type { EvidenceRef } from "@inkshadow/ai-core";
import {
  createTaskIfAbsentInTransaction,
  type SqlExecutor,
  type TransactionExecutor,
} from "@inkshadow/data";
import { Task } from "@inkshadow/task-engine";

import { recoverConsistencyInvestigationRuns } from "./consistency-investigation-recovery";

export const CONSISTENCY_INVESTIGATION_TASK_TYPE = "consistency_investigation";
export const CONSISTENCY_INVESTIGATION_OPERATION = "long_form_consistency_investigation";

export const CONSISTENCY_INVESTIGATION_STATUSES = [
  "planned",
  "dispatched",
  "observing",
  "verifying",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "not_dispatched",
  "ambiguous",
] as const;
export type ConsistencyInvestigationStatus = (typeof CONSISTENCY_INVESTIGATION_STATUSES)[number];

export const CONSISTENCY_INVESTIGATION_TOOL_NAMES = [
  "read_story_memory",
  "search_fts",
  "inspect_fact",
  "inspect_causal",
  "validate_evidence",
] as const;
export type ConsistencyInvestigationToolName =
  (typeof CONSISTENCY_INVESTIGATION_TOOL_NAMES)[number];

export type ConsistencyInvestigationStepName =
  ConsistencyInvestigationToolName | "model_synthesis" | "verify_findings";

export type ConsistencyInvestigationStepStatus =
  | "reserved"
  | "bound"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_dispatched"
  | "ambiguous";

export interface ConsistencyInvestigationPolicy {
  readonly maximumModelCalls: 1;
  readonly maximumToolSteps: 5;
  readonly maximumContextCharacters: number;
  readonly maximumOutputTokens: number;
  readonly maximumDurationMs: number;
  readonly automaticRetryCount: 0;
}

export interface ConsistencyInvestigationRun {
  readonly id: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly restartOfRunId: string | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly status: ConsistencyInvestigationStatus;
  readonly chapterCount: number;
  readonly policy: ConsistencyInvestigationPolicy;
  readonly estimatedInputTokens: number;
  readonly estimatedMaximumCostMicros: string | null;
  readonly currency: string | null;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: string;
  readonly modelId: string;
  readonly privacyFingerprint: string;
  readonly contextTraceId: string | null;
  readonly generationId: string;
  readonly summary: string | null;
  readonly findingCount: number;
  readonly droppedFindingCount: number;
  readonly cancellationRequested: boolean;
  readonly failureCode: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface ConsistencyInvestigationStep {
  readonly id: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly kind: "local_tool" | "model" | "verifier";
  readonly name: ConsistencyInvestigationStepName;
  readonly version: string;
  readonly permission: "local_read_only" | "model_dispatch" | "local_verify";
  readonly inputDigest: string;
  readonly status: ConsistencyInvestigationStepStatus;
  /** Exact Model Hub invocation id reserved before any ledger row is started. */
  readonly plannedInvocationId: string | null;
  readonly invocationId: string | null;
  readonly observationDigest: string | null;
  readonly terminalCause: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export type ConsistencyInvestigationFindingStatus = "pending" | "ignored" | "allowed";
export type ConsistencyInvestigationFindingSeverity = "info" | "warning" | "error";
export type ConsistencyInvestigationFindingCategory =
  "character" | "location" | "timeline" | "pov" | "world" | "causal" | "other";

export interface ConsistencyInvestigationFinding {
  readonly id: string;
  readonly runId: string;
  readonly modelStepId: string;
  readonly ordinal: number;
  readonly severity: ConsistencyInvestigationFindingSeverity;
  readonly authorityGroup: "accepted_body" | "confirmed_fact" | "mixed";
  readonly category: ConsistencyInvestigationFindingCategory;
  readonly title: string;
  readonly explanation: string;
  readonly status: ConsistencyInvestigationFindingStatus;
  readonly evidence: readonly EvidenceRef[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

export interface ConsistencyInvestigationDispatchBoundary {
  readonly invocationId: string | null;
  readonly providerDispatchStartedAt: string | null;
}

export interface CreateConsistencyInvestigationRunInput {
  readonly run: Omit<
    ConsistencyInvestigationRun,
    | "status"
    | "contextTraceId"
    | "summary"
    | "findingCount"
    | "droppedFindingCount"
    | "cancellationRequested"
    | "failureCode"
    | "revision"
    | "updatedAt"
    | "completedAt"
  >;
  readonly stepIds: readonly [string, string, string, string, string, string, string];
  readonly stepInputDigests: Readonly<Record<ConsistencyInvestigationStepName, string>>;
}

export interface PersistedConsistencyFindingInput {
  readonly id: string;
  readonly severity: ConsistencyInvestigationFindingSeverity;
  readonly authorityGroup: ConsistencyInvestigationFinding["authorityGroup"];
  readonly category: ConsistencyInvestigationFindingCategory;
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly EvidenceRef[];
}

interface RunRow {
  readonly id: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly restartOfRunId: string | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly status: string;
  readonly chapterCount: number;
  readonly maximumModelCalls: number;
  readonly maximumToolSteps: number;
  readonly maximumContextCharacters: number;
  readonly maximumOutputTokens: number;
  readonly maximumDurationMs: number;
  readonly automaticRetryCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatedMaximumCostMicros: string | null;
  readonly currency: string | null;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: string;
  readonly modelId: string;
  readonly privacyFingerprint: string;
  readonly contextTraceId: string | null;
  readonly generationId: string;
  readonly summary: string | null;
  readonly findingCount: number;
  readonly droppedFindingCount: number;
  readonly cancellationRequested: number;
  readonly failureCode: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface StepRow {
  readonly id: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly kind: ConsistencyInvestigationStep["kind"];
  readonly name: ConsistencyInvestigationStepName;
  readonly version: string;
  readonly permission: ConsistencyInvestigationStep["permission"];
  readonly inputDigest: string;
  readonly status: ConsistencyInvestigationStepStatus;
  readonly plannedInvocationId: string | null;
  readonly invocationId: string | null;
  readonly observationDigest: string | null;
  readonly terminalCause: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface FindingRow {
  readonly id: string;
  readonly runId: string;
  readonly modelStepId: string;
  readonly ordinal: number;
  readonly severity: ConsistencyInvestigationFindingSeverity;
  readonly authorityGroup: ConsistencyInvestigationFinding["authorityGroup"];
  readonly category: ConsistencyInvestigationFindingCategory;
  readonly title: string;
  readonly explanation: string;
  readonly status: ConsistencyInvestigationFindingStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

interface EvidenceRow {
  readonly findingId: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly immutableVersionId: string | null;
  readonly sourceKind: EvidenceRef["sourceKind"];
  readonly locatorJson: string;
  readonly excerptDigest: string;
  readonly sourceCreatedAt: string;
  readonly observedAt: string;
  readonly currentness: EvidenceRef["currentness"];
  readonly branchId: string | null;
  readonly privacy: EvidenceRef["privacy"];
}

const RUN_SELECT = `SELECT
  id, task_id AS taskId, project_id AS projectId,
  restart_of_run_id AS restartOfRunId, idempotency_key AS idempotencyKey,
  request_fingerprint AS requestFingerprint, status, chapter_count AS chapterCount,
  maximum_model_calls AS maximumModelCalls, maximum_tool_steps AS maximumToolSteps,
  maximum_context_characters AS maximumContextCharacters,
  maximum_output_tokens AS maximumOutputTokens, maximum_duration_ms AS maximumDurationMs,
  automatic_retry_count AS automaticRetryCount,
  estimated_input_tokens AS estimatedInputTokens,
  estimated_maximum_cost_micros AS estimatedMaximumCostMicros, currency,
  connection_id AS connectionId, catalog_entry_id AS catalogEntryId,
  provider_kind_snapshot AS providerKind, model_id_snapshot AS modelId,
  privacy_fingerprint AS privacyFingerprint, context_trace_id AS contextTraceId,
  generation_id AS generationId, summary, finding_count AS findingCount,
  dropped_finding_count AS droppedFindingCount,
  cancellation_requested AS cancellationRequested, failure_code AS failureCode,
  revision, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
FROM consistency_investigation_runs`;

const STEP_SELECT = `SELECT
  id, run_id AS runId, ordinal, step_kind AS kind, tool_name AS name,
  tool_version AS version, permission, input_digest AS inputDigest, status,
  planned_invocation_id AS plannedInvocationId, invocation_id AS invocationId,
  observation_digest AS observationDigest,
  terminal_cause AS terminalCause, created_at AS createdAt,
  updated_at AS updatedAt, completed_at AS completedAt
FROM consistency_investigation_steps`;

const FINDING_SELECT = `SELECT
  id, run_id AS runId, model_step_id AS modelStepId, ordinal, severity,
  authority_group AS authorityGroup, category, title, explanation, status,
  revision, created_at AS createdAt, updated_at AS updatedAt, decided_at AS decidedAt
FROM consistency_investigation_findings`;

export class ConsistencyInvestigationSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async createPlanned(
    input: CreateConsistencyInvestigationRunInput,
  ): Promise<ConsistencyInvestigationRun> {
    const { run } = input;
    return this.executor.transaction(async (transaction) => {
      const existing = await transaction.select<RunRow>(
        `${RUN_SELECT} WHERE project_id = ? AND idempotency_key = ? LIMIT 1`,
        [run.projectId, run.idempotencyKey],
      );
      if (existing[0] !== undefined) {
        const hydrated = hydrateRun(existing[0]);
        if (hydrated.requestFingerprint !== run.requestFingerprint) {
          throw new ConsistencyInvestigationStoreError(
            "INVESTIGATION_IDEMPOTENCY_CONFLICT",
            "The investigation idempotency key is already bound to another request.",
          );
        }
        return hydrated;
      }

      const task = unwrapTask(
        Task.create({
          id: run.taskId,
          type: CONSISTENCY_INVESTIGATION_TASK_TYPE,
          idempotencyKey: run.idempotencyKey,
          metadata: {
            operation: CONSISTENCY_INVESTIGATION_OPERATION,
            projectId: run.projectId,
            runId: run.id,
          },
          priority: 50,
          maxAttempts: 1,
          now: run.createdAt,
        }),
      );
      const taskReceipt = await createTaskIfAbsentInTransaction(transaction, task);
      if (!taskReceipt.task.isSameRequestAs(task)) {
        throw new ConsistencyInvestigationStoreError(
          "INVESTIGATION_TASK_CONFLICT",
          "The durable task identity belongs to another request.",
        );
      }

      await transaction.execute(
        `INSERT INTO consistency_investigation_runs (
           id, task_id, project_id, restart_of_run_id, idempotency_key,
           request_fingerprint, status, chapter_count, maximum_model_calls,
           maximum_tool_steps, maximum_context_characters, maximum_output_tokens,
           maximum_duration_ms, automatic_retry_count, estimated_input_tokens,
           estimated_maximum_cost_micros, currency, connection_id, catalog_entry_id,
           provider_kind_snapshot, model_id_snapshot, privacy_fingerprint,
           context_trace_id, generation_id, summary, finding_count,
           dropped_finding_count, cancellation_requested, failure_code, revision,
           created_at, updated_at, completed_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           NULL, ?, NULL, 0, 0, 0, NULL, 1, ?, ?, NULL
         )`,
        [
          run.id,
          run.taskId,
          run.projectId,
          run.restartOfRunId,
          run.idempotencyKey,
          run.requestFingerprint,
          run.chapterCount,
          run.policy.maximumModelCalls,
          run.policy.maximumToolSteps,
          run.policy.maximumContextCharacters,
          run.policy.maximumOutputTokens,
          run.policy.maximumDurationMs,
          run.policy.automaticRetryCount,
          run.estimatedInputTokens,
          run.estimatedMaximumCostMicros,
          run.currency,
          run.connectionId,
          run.catalogEntryId,
          run.providerKind,
          run.modelId,
          run.privacyFingerprint,
          run.generationId,
          run.createdAt,
          run.createdAt,
        ],
      );
      await insertPlannedSteps(transaction, input);
      return this.requireById(run.id, transaction);
    });
  }

  public async findById(runId: string): Promise<ConsistencyInvestigationRun | null> {
    const rows = await this.executor.select<RunRow>(`${RUN_SELECT} WHERE id = ? LIMIT 1`, [runId]);
    return rows[0] === undefined ? null : hydrateRun(rows[0]);
  }

  public async listByProjectId(
    projectId: string,
    limit = 20,
  ): Promise<readonly ConsistencyInvestigationRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ConsistencyInvestigationStoreError(
        "INVESTIGATION_QUERY_INVALID",
        "Investigation history limit is invalid.",
      );
    }
    const rows = await this.executor.select<RunRow>(
      `${RUN_SELECT} WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [projectId, limit],
    );
    return Object.freeze(rows.map(hydrateRun));
  }

  public async listSteps(runId: string): Promise<readonly ConsistencyInvestigationStep[]> {
    const rows = await this.executor.select<StepRow>(
      `${STEP_SELECT} WHERE run_id = ? ORDER BY ordinal ASC`,
      [runId],
    );
    return Object.freeze(rows.map(hydrateStep));
  }

  public async listFindings(runId: string): Promise<readonly ConsistencyInvestigationFinding[]> {
    const rows = await this.executor.select<FindingRow>(
      `${FINDING_SELECT} WHERE run_id = ? ORDER BY ordinal ASC`,
      [runId],
    );
    const evidenceRows = await this.executor.select<EvidenceRow>(
      `SELECT finding_id AS findingId, project_id AS projectId,
              chapter_id AS chapterId, immutable_version_id AS immutableVersionId,
              source_kind AS sourceKind, locator_json AS locatorJson,
              excerpt_digest AS excerptDigest, source_created_at AS sourceCreatedAt,
              observed_at AS observedAt, currentness, branch_id AS branchId, privacy
       FROM consistency_investigation_evidence
       WHERE finding_id IN (
         SELECT id FROM consistency_investigation_findings WHERE run_id = ?
       )
       ORDER BY finding_id ASC, ordinal ASC`,
      [runId],
    );
    const evidenceByFinding = new Map<string, EvidenceRef[]>();
    for (const row of evidenceRows) {
      const evidence = hydrateEvidence(row);
      const list = evidenceByFinding.get(row.findingId) ?? [];
      list.push(evidence);
      evidenceByFinding.set(row.findingId, list);
    }
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({ ...row, evidence: Object.freeze(evidenceByFinding.get(row.id) ?? []) }),
      ),
    );
  }

  public async attachContextTrace(
    runId: string,
    traceId: string,
    expectedRevision: number,
    now: string,
  ): Promise<ConsistencyInvestigationRun> {
    await this.casRun(
      `context_trace_id = ?, revision = revision + 1, updated_at = ?`,
      [traceId, now],
      runId,
      expectedRevision,
      ["planned"],
    );
    return this.requireById(runId);
  }

  public async transitionRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly from: readonly ConsistencyInvestigationStatus[];
    readonly status: ConsistencyInvestigationStatus;
    readonly now: string;
    readonly summary?: string | null;
    readonly failureCode?: string | null;
    readonly cancellationRequested?: boolean;
  }): Promise<ConsistencyInvestigationRun> {
    const terminal = isTerminalRunStatus(input.status);
    const summary = input.summary === undefined ? null : input.summary;
    const failureCode = input.failureCode === undefined ? null : input.failureCode;
    await this.casRun(
      `status = ?, summary = COALESCE(?, summary), failure_code = ?,
       cancellation_requested = CASE WHEN ? = 1 THEN 1 ELSE cancellation_requested END,
       revision = revision + 1, updated_at = ?, completed_at = ?`,
      [
        input.status,
        summary,
        failureCode,
        input.cancellationRequested === true ? 1 : 0,
        input.now,
        terminal ? input.now : null,
      ],
      input.runId,
      input.expectedRevision,
      input.from,
    );
    return this.requireById(input.runId);
  }

  public async requestCancellation(
    runId: string,
    expectedRevision: number,
    now: string,
  ): Promise<ConsistencyInvestigationRun> {
    await this.casRun(
      `cancellation_requested = 1, revision = revision + 1, updated_at = ?`,
      [now],
      runId,
      expectedRevision,
      ["planned", "dispatched", "observing", "verifying"],
    );
    return this.requireById(runId);
  }

  public async transitionStep(input: {
    readonly stepId: string;
    readonly from: readonly ConsistencyInvestigationStepStatus[];
    readonly status: ConsistencyInvestigationStepStatus;
    readonly now: string;
    readonly plannedInvocationId?: string | null;
    readonly invocationId?: string | null;
    readonly observationDigest?: string | null;
    readonly terminalCause?: string | null;
  }): Promise<ConsistencyInvestigationStep> {
    const terminal = isTerminalStepStatus(input.status);
    const placeholders = input.from.map(() => "?").join(", ");
    const result = await this.executor.execute(
      `UPDATE consistency_investigation_steps
       SET status = ?, planned_invocation_id = COALESCE(?, planned_invocation_id),
           invocation_id = COALESCE(?, invocation_id),
           observation_digest = COALESCE(?, observation_digest),
           terminal_cause = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
      [
        input.status,
        input.plannedInvocationId ?? null,
        input.invocationId ?? null,
        input.observationDigest ?? null,
        input.terminalCause ?? null,
        input.now,
        terminal ? input.now : null,
        input.stepId,
        ...input.from,
      ],
    );
    if (result.rowsAffected !== 1) throw stepConflict();
    const rows = await this.executor.select<StepRow>(`${STEP_SELECT} WHERE id = ? LIMIT 1`, [
      input.stepId,
    ]);
    if (rows[0] === undefined) throw stepConflict();
    return hydrateStep(rows[0]);
  }

  public async saveFindings(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly modelStepId: string;
    readonly summary: string;
    readonly findings: readonly PersistedConsistencyFindingInput[];
    readonly droppedFindingCount: number;
    readonly now: string;
  }): Promise<ConsistencyInvestigationRun> {
    return this.executor.transaction(async (transaction) => {
      const run = await this.requireById(input.runId, transaction);
      if (run.revision !== input.expectedRevision || run.status !== "observing") {
        throw runConflict();
      }
      for (const [index, finding] of input.findings.entries()) {
        await transaction.execute(
          `INSERT INTO consistency_investigation_findings (
             id, run_id, model_step_id, ordinal, severity, authority_group,
             category, title, explanation, status, revision, created_at, updated_at, decided_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, NULL)`,
          [
            finding.id,
            input.runId,
            input.modelStepId,
            index + 1,
            finding.severity,
            finding.authorityGroup,
            finding.category,
            finding.title,
            finding.explanation,
            input.now,
            input.now,
          ],
        );
        for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
          await transaction.execute(
            `INSERT INTO consistency_investigation_evidence (
               finding_id, ordinal, project_id, chapter_id, immutable_version_id,
               source_kind, locator_json, excerpt_digest, source_created_at,
               observed_at, currentness, branch_id, privacy
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              finding.id,
              evidenceIndex,
              evidence.projectId,
              evidence.chapterId,
              evidence.immutableVersionId,
              evidence.sourceKind,
              JSON.stringify(evidence.locator),
              evidence.excerptDigest,
              evidence.sourceCreatedAt,
              evidence.observedAt,
              evidence.currentness,
              evidence.branchId,
              evidence.privacy,
            ],
          );
        }
      }
      const result = await transaction.execute(
        `UPDATE consistency_investigation_runs
         SET status = 'verifying', summary = ?, finding_count = ?,
             dropped_finding_count = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'observing' AND revision = ?`,
        [
          input.summary,
          input.findings.length,
          input.droppedFindingCount,
          input.now,
          input.runId,
          input.expectedRevision,
        ],
      );
      if (result.rowsAffected !== 1) throw runConflict();
      return this.requireById(input.runId, transaction);
    });
  }

  public async decideFinding(input: {
    readonly findingId: string;
    readonly expectedRevision: number;
    readonly decision: "ignored" | "allowed";
    readonly now: string;
  }): Promise<ConsistencyInvestigationFinding> {
    const result = await this.executor.execute(
      `UPDATE consistency_investigation_findings
       SET status = ?, revision = revision + 1, updated_at = ?, decided_at = ?
       WHERE id = ? AND status = 'pending' AND revision = ?`,
      [input.decision, input.now, input.now, input.findingId, input.expectedRevision],
    );
    if (result.rowsAffected !== 1) {
      throw new ConsistencyInvestigationStoreError(
        "INVESTIGATION_FINDING_CONFLICT",
        "The finding changed before the decision was saved.",
      );
    }
    const rows = await this.executor.select<FindingRow>(`${FINDING_SELECT} WHERE id = ? LIMIT 1`, [
      input.findingId,
    ]);
    const row = rows[0];
    if (row === undefined) throw runConflict();
    return Object.freeze({ ...row, evidence: Object.freeze([]) });
  }

  public async recoverInterrupted(now: string): Promise<readonly ConsistencyInvestigationRun[]> {
    const receipts = await recoverConsistencyInvestigationRuns(this.executor, now);
    return Object.freeze(await Promise.all(receipts.map(async ({ id }) => this.requireById(id))));
  }

  public async findDispatchBoundary(
    runId: string,
  ): Promise<ConsistencyInvestigationDispatchBoundary> {
    const rows = await this.executor.select<ConsistencyInvestigationDispatchBoundary>(
      `SELECT COALESCE(step.invocation_id, step.planned_invocation_id) AS invocationId,
              invocation.provider_dispatch_started_at AS providerDispatchStartedAt
       FROM consistency_investigation_steps AS step
       LEFT JOIN model_invocation_facts AS invocation
         ON invocation.id = COALESCE(step.invocation_id, step.planned_invocation_id)
       WHERE step.run_id = ? AND step.step_kind = 'model'
       LIMIT 1`,
      [runId],
    );
    return Object.freeze(rows[0] ?? { invocationId: null, providerDispatchStartedAt: null });
  }

  private async casRun(
    setters: string,
    values: readonly (string | number | null)[],
    runId: string,
    expectedRevision: number,
    statuses: readonly ConsistencyInvestigationStatus[],
  ): Promise<void> {
    const placeholders = statuses.map(() => "?").join(", ");
    const result = await this.executor.execute(
      `UPDATE consistency_investigation_runs SET ${setters}
       WHERE id = ? AND revision = ? AND status IN (${placeholders})`,
      [...values, runId, expectedRevision, ...statuses],
    );
    if (result.rowsAffected !== 1) throw runConflict();
  }

  private async requireById(
    runId: string,
    executor: SqlExecutor | TransactionExecutor = this.executor,
  ): Promise<ConsistencyInvestigationRun> {
    const rows = await executor.select<RunRow>(`${RUN_SELECT} WHERE id = ? LIMIT 1`, [runId]);
    if (rows[0] === undefined) {
      throw new ConsistencyInvestigationStoreError(
        "INVESTIGATION_NOT_FOUND",
        "The consistency investigation was not found.",
      );
    }
    return hydrateRun(rows[0]);
  }
}

export class ConsistencyInvestigationStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConsistencyInvestigationStoreError";
  }
}

async function insertPlannedSteps(
  transaction: TransactionExecutor,
  input: CreateConsistencyInvestigationRunInput,
): Promise<void> {
  const definitions: readonly Readonly<{
    name: ConsistencyInvestigationStepName;
    kind: ConsistencyInvestigationStep["kind"];
    permission: ConsistencyInvestigationStep["permission"];
  }>[] = [
    { name: "read_story_memory", kind: "local_tool", permission: "local_read_only" },
    { name: "inspect_fact", kind: "local_tool", permission: "local_read_only" },
    { name: "search_fts", kind: "local_tool", permission: "local_read_only" },
    { name: "inspect_causal", kind: "local_tool", permission: "local_read_only" },
    { name: "validate_evidence", kind: "local_tool", permission: "local_read_only" },
    { name: "model_synthesis", kind: "model", permission: "model_dispatch" },
    { name: "verify_findings", kind: "verifier", permission: "local_verify" },
  ];
  for (const [index, definition] of definitions.entries()) {
    await transaction.execute(
      `INSERT INTO consistency_investigation_steps (
         id, run_id, ordinal, step_kind, tool_name, tool_version, permission,
         input_digest, status, invocation_id, observation_digest, terminal_cause,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, '1', ?, ?, 'reserved', NULL, NULL, NULL, ?, ?, NULL)`,
      [
        input.stepIds[index] ?? "",
        input.run.id,
        index + 1,
        definition.kind,
        definition.name,
        definition.permission,
        input.stepInputDigests[definition.name],
        input.run.createdAt,
        input.run.createdAt,
      ],
    );
  }
}

function hydrateRun(row: RunRow): ConsistencyInvestigationRun {
  if (!CONSISTENCY_INVESTIGATION_STATUSES.includes(row.status as ConsistencyInvestigationStatus)) {
    throw new ConsistencyInvestigationStoreError(
      "INVESTIGATION_CORRUPT",
      "The stored investigation status is invalid.",
    );
  }
  return Object.freeze({
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    restartOfRunId: row.restartOfRunId,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    status: row.status as ConsistencyInvestigationStatus,
    chapterCount: row.chapterCount,
    policy: Object.freeze({
      maximumModelCalls: 1,
      maximumToolSteps: 5,
      maximumContextCharacters: row.maximumContextCharacters,
      maximumOutputTokens: row.maximumOutputTokens,
      maximumDurationMs: row.maximumDurationMs,
      automaticRetryCount: 0,
    }),
    estimatedInputTokens: row.estimatedInputTokens,
    estimatedMaximumCostMicros: row.estimatedMaximumCostMicros,
    currency: row.currency,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    providerKind: row.providerKind,
    modelId: row.modelId,
    privacyFingerprint: row.privacyFingerprint,
    contextTraceId: row.contextTraceId,
    generationId: row.generationId,
    summary: row.summary,
    findingCount: row.findingCount,
    droppedFindingCount: row.droppedFindingCount,
    cancellationRequested: row.cancellationRequested === 1,
    failureCode: row.failureCode,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  });
}

function hydrateStep(row: StepRow): ConsistencyInvestigationStep {
  return Object.freeze({ ...row });
}

function hydrateEvidence(row: EvidenceRow): EvidenceRef {
  const locator = JSON.parse(row.locatorJson) as EvidenceRef["locator"];
  return Object.freeze({
    projectId: row.projectId,
    chapterId: row.chapterId,
    immutableVersionId: row.immutableVersionId,
    sourceKind: row.sourceKind,
    locator,
    excerptDigest: row.excerptDigest,
    sourceCreatedAt: row.sourceCreatedAt,
    observedAt: row.observedAt,
    currentness: row.currentness,
    branchId: row.branchId,
    privacy: row.privacy,
  });
}

function unwrapTask(result: ReturnType<typeof Task.create>): Task {
  if (!result.ok) throw result.error;
  return result.value;
}

function isTerminalRunStatus(status: ConsistencyInvestigationStatus): boolean {
  return ["succeeded", "partial", "failed", "cancelled", "not_dispatched", "ambiguous"].includes(
    status,
  );
}

function isTerminalStepStatus(status: ConsistencyInvestigationStepStatus): boolean {
  return ["succeeded", "failed", "cancelled", "not_dispatched", "ambiguous"].includes(status);
}

function runConflict(): ConsistencyInvestigationStoreError {
  return new ConsistencyInvestigationStoreError(
    "INVESTIGATION_REVISION_CONFLICT",
    "The investigation changed before the transition was saved.",
  );
}

function stepConflict(): ConsistencyInvestigationStoreError {
  return new ConsistencyInvestigationStoreError(
    "INVESTIGATION_STEP_CONFLICT",
    "The investigation step changed before the transition was saved.",
  );
}
