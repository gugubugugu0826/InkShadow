import {
  canTransitionGenerationState,
  isModelRouteRole,
  type BudgetEnforcement,
  type BudgetLimit,
  type BudgetScope,
  type GenerationPreflightSnapshot,
  type GenerationState,
  type ModelRouteRole,
} from "@inkshadow/ai-core";
import type { SqlExecutor } from "@inkshadow/data";
import type { Clock } from "@inkshadow/domain";

export const DEVELOPMENT_GENERATION_GOVERNANCE_KEY =
  "inkshadow.development.generation-governance.v1";

export interface GenerationBudgetPolicy {
  readonly scopeKey: string;
  readonly scope: Exclude<BudgetScope, "task">;
  readonly projectId: string | null;
  readonly monthKey: string | null;
  readonly currency: string;
  readonly limitMicros: string;
  readonly enforcement: BudgetEnforcement;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveGenerationBudgetPolicyInput {
  readonly scope: Exclude<BudgetScope, "task">;
  readonly projectId: string | null;
  readonly monthKey: string | null;
  readonly currency: string;
  readonly limitMicros: string;
  readonly enforcement: BudgetEnforcement;
  readonly expectedRevision: number | null;
}

export interface PersistedGenerationPreflight {
  readonly checkedAt: string;
  readonly canStart: boolean;
  readonly requiresConfirmation: boolean;
  readonly codes: readonly string[];
  readonly costStatus: GenerationCostStatus;
  readonly estimateMicros: string | null;
  readonly currency: string | null;
  readonly pricingVersion: string | null;
  readonly priceUpdatedAt: string | null;
  readonly inputBytes: number;
  readonly inputTokens: number;
  readonly maximumOutputTokens: number;
  readonly contextWindowTokens: number | null;
}

export type GenerationRouteReason =
  "legacy_default" | "role_primary" | "role_fallback" | "local_demo";

export interface GenerationRouteSelection {
  readonly role: ModelRouteRole;
  readonly reason: GenerationRouteReason;
  readonly fallbackProviderId: string | null;
  readonly fallbackModelId: string | null;
}

export interface GenerationRun {
  readonly id: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly baseVersionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly state: GenerationState;
  readonly revision: number;
  readonly attempt: number;
  readonly inputTokens: number;
  readonly maximumOutputTokens: number;
  readonly estimatedCostMicros: string;
  readonly incurredCostMicros: string;
  readonly costStatus: GenerationCostStatus;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
  readonly preflight: PersistedGenerationPreflight;
  readonly route: GenerationRouteSelection;
  readonly candidateId: string | null;
  readonly failureCode: string | null;
  readonly cancelledAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateGenerationRunInput {
  readonly id: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly baseVersionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly route?: GenerationRouteSelection;
  readonly preflight: GenerationPreflightSnapshot;
}

export interface CreateGenerationRunResult {
  readonly run: GenerationRun;
  readonly created: boolean;
}

export interface TransitionGenerationRunInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly state: GenerationState;
  readonly attempt?: number;
  readonly candidateId?: string | null;
  readonly failureCode?: string | null;
  readonly addIncurredCost?: boolean;
  readonly attemptUsage?: GenerationAttemptUsageInput;
}

export type GenerationCostStatus = "estimated" | "pricing_unavailable";

export type GenerationUsageSource =
  "provider_reported" | "provider_reported_unpriced" | "provider_unavailable" | "local_demo";

export interface GenerationAttemptUsageInput {
  readonly source: GenerationUsageSource;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly usagePricedEstimateMicros: string | null;
}

export interface GenerationAttemptUsage extends GenerationAttemptUsageInput {
  readonly runId: string;
  readonly attempt: number;
  readonly costStatus: GenerationCostStatus;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
  readonly reportedAt: string;
}

export type DeferredGenerationStatus =
  "waiting_network" | "blocked_stale" | "cancelled" | "consumed";

export interface DeferredGenerationRequest {
  readonly id: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly baseVersionId: string;
  readonly modelRole: ModelRouteRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly maximumOutputTokens: number;
  readonly approvedInputTokens: number;
  readonly approvedEstimateMicros: string;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
  readonly status: DeferredGenerationStatus;
  readonly revision: number;
  readonly consumedRunId: string | null;
  readonly cancelledAt: string | null;
  readonly consumedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDeferredGenerationInput {
  readonly id: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly baseVersionId: string;
  readonly modelRole: ModelRouteRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly maximumOutputTokens: number;
  readonly preflight: GenerationPreflightSnapshot;
}

export interface TransitionDeferredGenerationInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly status: Exclude<DeferredGenerationStatus, "waiting_network">;
  readonly consumedRunId?: string;
}

export interface GenerationGovernanceStore {
  saveBudgetPolicy(input: SaveGenerationBudgetPolicyInput): Promise<GenerationBudgetPolicy>;
  listBudgetPolicies(
    projectId: string,
    monthKey: string,
    currency: string,
  ): Promise<readonly GenerationBudgetPolicy[]>;
  getBudgetLimits(
    projectId: string,
    monthKey: string,
    currency: string,
  ): Promise<readonly BudgetLimit[]>;
  createRun(input: CreateGenerationRunInput): Promise<CreateGenerationRunResult>;
  findRunById(runId: string): Promise<GenerationRun | null>;
  listRunsByProjectId(projectId: string): Promise<readonly GenerationRun[]>;
  findRunByIdempotencyKey(idempotencyKey: string): Promise<GenerationRun | null>;
  findLatestRetryableRun(input: {
    readonly chapterId: string;
    readonly baseVersionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly pricingVersion: string;
    readonly estimatedCostMicros: string;
  }): Promise<GenerationRun | null>;
  transitionRun(input: TransitionGenerationRunInput): Promise<GenerationRun>;
  listAttemptUsage(runId: string): Promise<readonly GenerationAttemptUsage[]>;
  createDeferredRequest(
    input: CreateDeferredGenerationInput,
  ): Promise<{ readonly request: DeferredGenerationRequest; readonly created: boolean }>;
  findWaitingDeferredRequest(
    chapterId: string,
    modelRole: ModelRouteRole,
  ): Promise<DeferredGenerationRequest | null>;
  transitionDeferredRequest(
    input: TransitionDeferredGenerationInput,
  ): Promise<DeferredGenerationRequest>;
}

interface BudgetPolicyRow {
  scope_key: string;
  scope: string;
  project_id: string | null;
  month_key: string | null;
  currency: string;
  limit_micros: string;
  enforcement: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface GenerationRunRow {
  id: string;
  task_id: string;
  idempotency_key: string;
  project_id: string;
  chapter_id: string;
  base_version_id: string;
  provider_id: string;
  model_id: string;
  state: string;
  revision: number;
  attempt: number;
  input_tokens: number;
  maximum_output_tokens: number;
  estimated_cost_micros: string;
  incurred_cost_micros: string;
  cost_status: string;
  currency: string;
  pricing_version: string;
  price_updated_at: string;
  preflight_json: string;
  candidate_id: string | null;
  failure_code: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  route_role: string | null;
  route_reason: string | null;
  route_fallback_provider_id: string | null;
  route_fallback_model_id: string | null;
}

interface GenerationAttemptUsageRow {
  run_id: string;
  attempt: number;
  usage_source: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  usage_priced_estimate_micros: string | null;
  cost_status: string;
  currency: string;
  pricing_version: string;
  price_updated_at: string;
  reported_at: string;
}

interface DeferredGenerationRow {
  id: string;
  task_id: string;
  idempotency_key: string;
  project_id: string;
  chapter_id: string;
  base_version_id: string;
  model_role: string;
  provider_id: string;
  model_id: string;
  maximum_output_tokens: number;
  approved_input_tokens: number;
  approved_estimate_micros: string;
  currency: string;
  pricing_version: string;
  price_updated_at: string;
  status: string;
  revision: number;
  consumed_run_id: string | null;
  cancelled_at: string | null;
  consumed_at: string | null;
  created_at: string;
  updated_at: string;
}

export class TauriGenerationGovernanceStore implements GenerationGovernanceStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async saveBudgetPolicy(
    input: SaveGenerationBudgetPolicyInput,
  ): Promise<GenerationBudgetPolicy> {
    const validated = validateBudgetPolicyInput(input);
    return this.executor.transaction(async (transaction) => {
      const existingRows = await transaction.select<BudgetPolicyRow>(
        `${BUDGET_POLICY_SELECT} WHERE scope_key = ?`,
        [validated.scopeKey],
      );
      const existing = existingRows[0] === undefined ? null : hydrateBudgetPolicy(existingRows[0]);
      const now = this.clock.now();
      if (existing === null) {
        if (validated.expectedRevision !== null) {
          throw governanceConflict("AI_BUDGET_REVISION_CONFLICT");
        }
        await transaction.execute(
          `INSERT INTO ai_budget_policies (
             scope_key, scope, project_id, month_key, currency, limit_micros,
             enforcement, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            validated.scopeKey,
            validated.scope,
            validated.projectId,
            validated.monthKey,
            validated.currency,
            validated.limitMicros,
            validated.enforcement,
            now,
            now,
          ],
        );
      } else {
        if (
          validated.expectedRevision === null ||
          existing.revision !== validated.expectedRevision
        ) {
          throw governanceConflict("AI_BUDGET_REVISION_CONFLICT");
        }
        const result = await transaction.execute(
          `UPDATE ai_budget_policies
           SET currency = ?, limit_micros = ?, enforcement = ?,
               revision = ?, updated_at = ?
           WHERE scope_key = ? AND revision = ?`,
          [
            validated.currency,
            validated.limitMicros,
            validated.enforcement,
            existing.revision + 1,
            now,
            validated.scopeKey,
            existing.revision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw governanceConflict("AI_BUDGET_REVISION_CONFLICT");
        }
      }
      const rows = await transaction.select<BudgetPolicyRow>(
        `${BUDGET_POLICY_SELECT} WHERE scope_key = ?`,
        [validated.scopeKey],
      );
      if (rows[0] === undefined) {
        throw governanceError("AI_BUDGET_STORE_FAILED", "Budget policy was not persisted.");
      }
      return hydrateBudgetPolicy(rows[0]);
    });
  }

  public async listBudgetPolicies(
    projectId: string,
    monthKey: string,
    currency: string,
  ): Promise<readonly GenerationBudgetPolicy[]> {
    validateUuid(projectId, "projectId");
    validateMonthKey(monthKey);
    validateCurrency(currency);
    const rows = await this.executor.select<BudgetPolicyRow>(
      `${BUDGET_POLICY_SELECT}
       WHERE currency = ?
         AND (
           (scope = 'project' AND project_id = ?)
           OR (scope = 'month' AND month_key = ?)
         )
       ORDER BY scope ASC`,
      [currency, projectId, monthKey],
    );
    return Object.freeze(rows.map(hydrateBudgetPolicy));
  }

  public async getBudgetLimits(
    projectId: string,
    monthKey: string,
    currency: string,
  ): Promise<readonly BudgetLimit[]> {
    const policies = await this.listBudgetPolicies(projectId, monthKey, currency);
    const rows = await this.executor.select<GenerationRunRow>(
      `${GENERATION_RUN_SELECT}
       WHERE run.currency = ?
         AND (run.project_id = ? OR substr(run.created_at, 1, 7) = ?)`,
      [currency, projectId, monthKey],
    );
    return buildBudgetLimits(policies, rows.map(hydrateGenerationRun), projectId, monthKey);
  }

  public async createRun(input: CreateGenerationRunInput): Promise<CreateGenerationRunResult> {
    const prepared = prepareGenerationRun(input, this.clock.now());
    return this.executor.transaction(async (transaction) => {
      const existingRows = await transaction.select<GenerationRunRow>(
        `${GENERATION_RUN_SELECT} WHERE run.idempotency_key = ?`,
        [prepared.idempotencyKey],
      );
      if (existingRows[0] !== undefined) {
        const existing = hydrateGenerationRun(existingRows[0]);
        if (!sameGenerationRequest(existing, prepared)) {
          throw governanceConflict("AI_GENERATION_IDEMPOTENCY_CONFLICT");
        }
        return { run: existing, created: false };
      }
      await transaction.execute(
        `INSERT INTO ai_generation_runs (
           id, task_id, idempotency_key, project_id, chapter_id, base_version_id,
           provider_id, model_id, state, revision, attempt, input_tokens,
           maximum_output_tokens, estimated_cost_micros, incurred_cost_micros,
           cost_status, currency, pricing_version, price_updated_at, preflight_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 1, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?, ?)`,
        [
          prepared.id,
          prepared.taskId,
          prepared.idempotencyKey,
          prepared.projectId,
          prepared.chapterId,
          prepared.baseVersionId,
          prepared.providerId,
          prepared.modelId,
          prepared.inputTokens,
          prepared.maximumOutputTokens,
          prepared.estimatedCostMicros,
          prepared.costStatus,
          prepared.currency,
          prepared.pricingVersion,
          prepared.priceUpdatedAt,
          JSON.stringify(prepared.preflight),
          prepared.createdAt,
          prepared.updatedAt,
        ],
      );
      await transaction.execute(
        `INSERT INTO ai_generation_route_selections (
           run_id, role, reason, fallback_provider_id, fallback_model_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          prepared.id,
          prepared.route.role,
          prepared.route.reason,
          prepared.route.fallbackProviderId,
          prepared.route.fallbackModelId,
          prepared.createdAt,
        ],
      );
      return { run: prepared, created: true };
    });
  }

  public async findRunById(runId: string): Promise<GenerationRun | null> {
    validateUuid(runId, "runId");
    const rows = await this.executor.select<GenerationRunRow>(
      `${GENERATION_RUN_SELECT} WHERE run.id = ?`,
      [runId],
    );
    return rows[0] === undefined ? null : hydrateGenerationRun(rows[0]);
  }

  public async listRunsByProjectId(projectIdValue: string): Promise<readonly GenerationRun[]> {
    const projectId = validateUuid(projectIdValue, "projectId");
    const rows = await this.executor.select<GenerationRunRow>(
      `${GENERATION_RUN_SELECT}
       WHERE run.project_id = ?
       ORDER BY run.created_at ASC, run.id ASC`,
      [projectId],
    );
    return Object.freeze(rows.map(hydrateGenerationRun));
  }

  public async findRunByIdempotencyKey(idempotencyKey: string): Promise<GenerationRun | null> {
    validateIdempotencyKey(idempotencyKey);
    const rows = await this.executor.select<GenerationRunRow>(
      `${GENERATION_RUN_SELECT} WHERE run.idempotency_key = ?`,
      [idempotencyKey],
    );
    return rows[0] === undefined ? null : hydrateGenerationRun(rows[0]);
  }

  public async findLatestRetryableRun(input: {
    readonly chapterId: string;
    readonly baseVersionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly pricingVersion: string;
    readonly estimatedCostMicros: string;
  }): Promise<GenerationRun | null> {
    const rows = await this.executor.select<GenerationRunRow>(
      `${GENERATION_RUN_SELECT}
       WHERE run.chapter_id = ?
         AND run.base_version_id = ?
         AND run.provider_id = ?
         AND run.model_id = ?
         AND run.pricing_version = ?
         AND run.estimated_cost_micros = ?
         AND run.state = 'failed_retryable'
       ORDER BY run.updated_at DESC, run.id DESC
       LIMIT 1`,
      [
        validateUuid(input.chapterId, "chapterId"),
        validateUuid(input.baseVersionId, "baseVersionId"),
        validateSafeIdentifier(input.providerId, 128, "providerId"),
        validateSafeIdentifier(input.modelId, 512, "modelId"),
        validateSafeIdentifier(input.pricingVersion, 128, "pricingVersion"),
        validateMicros(input.estimatedCostMicros, "estimatedCostMicros"),
      ],
    );
    return rows[0] === undefined ? null : hydrateGenerationRun(rows[0]);
  }

  public async transitionRun(input: TransitionGenerationRunInput): Promise<GenerationRun> {
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<GenerationRunRow>(
        `${GENERATION_RUN_SELECT} WHERE run.id = ?`,
        [validateUuid(input.runId, "runId")],
      );
      if (rows[0] === undefined) {
        throw governanceError("AI_GENERATION_RUN_NOT_FOUND", "Generation run was not found.");
      }
      const current = hydrateGenerationRun(rows[0]);
      const next = evolveGenerationRun(current, input, this.clock.now());
      const attemptUsage =
        input.attemptUsage === undefined
          ? null
          : prepareAttemptUsage(current, input.attemptUsage, next.updatedAt);
      if (attemptUsage !== null) {
        await transaction.execute(
          `INSERT INTO ai_generation_attempt_usage (
             run_id, attempt, usage_source, input_tokens, output_tokens,
             cached_input_tokens, usage_priced_estimate_micros, cost_status, currency,
             pricing_version, price_updated_at, reported_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            attemptUsage.runId,
            attemptUsage.attempt,
            attemptUsage.source,
            attemptUsage.inputTokens,
            attemptUsage.outputTokens,
            attemptUsage.cachedInputTokens,
            attemptUsage.usagePricedEstimateMicros,
            attemptUsage.costStatus,
            attemptUsage.currency,
            attemptUsage.pricingVersion,
            attemptUsage.priceUpdatedAt,
            attemptUsage.reportedAt,
          ],
        );
      }
      const result = await transaction.execute(
        `UPDATE ai_generation_runs
         SET state = ?, revision = ?, attempt = ?, incurred_cost_micros = ?,
             candidate_id = ?, failure_code = ?, cancelled_at = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [
          next.state,
          next.revision,
          next.attempt,
          next.incurredCostMicros,
          next.candidateId,
          next.failureCode,
          next.cancelledAt,
          next.completedAt,
          next.updatedAt,
          next.id,
          current.revision,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw governanceConflict("AI_GENERATION_REVISION_CONFLICT");
      }
      return next;
    });
  }

  public async listAttemptUsage(runIdValue: string): Promise<readonly GenerationAttemptUsage[]> {
    const runId = validateUuid(runIdValue, "runId");
    const rows = await this.executor.select<GenerationAttemptUsageRow>(
      `${ATTEMPT_USAGE_SELECT}
       WHERE run_id = ?
       ORDER BY attempt ASC`,
      [runId],
    );
    return Object.freeze(rows.map(hydrateAttemptUsage));
  }

  public async createDeferredRequest(
    input: CreateDeferredGenerationInput,
  ): Promise<{ readonly request: DeferredGenerationRequest; readonly created: boolean }> {
    const prepared = prepareDeferredRequest(input, this.clock.now());
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<DeferredGenerationRow>(
        `${DEFERRED_GENERATION_SELECT} WHERE idempotency_key = ?`,
        [prepared.idempotencyKey],
      );
      if (rows[0] !== undefined) {
        const existing = hydrateDeferredRequest(rows[0]);
        if (!sameDeferredRequest(existing, prepared)) {
          throw governanceConflict("AI_DEFERRED_IDEMPOTENCY_CONFLICT");
        }
        return { request: existing, created: false };
      }
      await transaction.execute(
        `INSERT INTO ai_deferred_generation_requests (
           id, task_id, idempotency_key, project_id, chapter_id,
           base_version_id, model_role, provider_id, model_id,
           maximum_output_tokens, approved_input_tokens,
           approved_estimate_micros, currency, pricing_version,
           price_updated_at, status, revision, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           'waiting_network', 1, ?, ?
         )`,
        [
          prepared.id,
          prepared.taskId,
          prepared.idempotencyKey,
          prepared.projectId,
          prepared.chapterId,
          prepared.baseVersionId,
          prepared.modelRole,
          prepared.providerId,
          prepared.modelId,
          prepared.maximumOutputTokens,
          prepared.approvedInputTokens,
          prepared.approvedEstimateMicros,
          prepared.currency,
          prepared.pricingVersion,
          prepared.priceUpdatedAt,
          prepared.createdAt,
          prepared.updatedAt,
        ],
      );
      return { request: prepared, created: true };
    });
  }

  public async findWaitingDeferredRequest(
    chapterIdValue: string,
    modelRoleValue: ModelRouteRole,
  ): Promise<DeferredGenerationRequest | null> {
    const chapterId = validateUuid(chapterIdValue, "chapterId");
    const modelRole = validateModelRole(modelRoleValue);
    const rows = await this.executor.select<DeferredGenerationRow>(
      `${DEFERRED_GENERATION_SELECT}
       WHERE chapter_id = ? AND model_role = ? AND status = 'waiting_network'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [chapterId, modelRole],
    );
    return rows[0] === undefined ? null : hydrateDeferredRequest(rows[0]);
  }

  public async transitionDeferredRequest(
    input: TransitionDeferredGenerationInput,
  ): Promise<DeferredGenerationRequest> {
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<DeferredGenerationRow>(
        `${DEFERRED_GENERATION_SELECT} WHERE id = ?`,
        [validateUuid(input.id, "id")],
      );
      if (rows[0] === undefined) {
        throw governanceError(
          "AI_DEFERRED_REQUEST_NOT_FOUND",
          "Deferred generation request was not found.",
        );
      }
      const current = hydrateDeferredRequest(rows[0]);
      const next = evolveDeferredRequest(current, input, this.clock.now());
      const result = await transaction.execute(
        `UPDATE ai_deferred_generation_requests
         SET status = ?, revision = ?, consumed_run_id = ?, cancelled_at = ?,
             consumed_at = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [
          next.status,
          next.revision,
          next.consumedRunId,
          next.cancelledAt,
          next.consumedAt,
          next.updatedAt,
          next.id,
          current.revision,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw governanceConflict("AI_DEFERRED_REVISION_CONFLICT");
      }
      return next;
    });
  }
}

interface BrowserGenerationGovernanceDatabase {
  readonly schemaVersion: 2;
  policies: GenerationBudgetPolicy[];
  runs: GenerationRun[];
  attemptUsage: GenerationAttemptUsage[];
  deferredRequests: DeferredGenerationRequest[];
}

export class BrowserDevelopmentGenerationGovernanceStore implements GenerationGovernanceStore {
  public constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  public saveBudgetPolicy(input: SaveGenerationBudgetPolicyInput): Promise<GenerationBudgetPolicy> {
    return this.mutate((database) => {
      const validated = validateBudgetPolicyInput(input);
      const index = database.policies.findIndex(({ scopeKey }) => scopeKey === validated.scopeKey);
      const existing = database.policies[index] ?? null;
      if (
        (existing === null && validated.expectedRevision !== null) ||
        (existing !== null &&
          (validated.expectedRevision === null || existing.revision !== validated.expectedRevision))
      ) {
        throw governanceConflict("AI_BUDGET_REVISION_CONFLICT");
      }
      const now = this.clock.now();
      const policy = validateBudgetPolicy({
        ...validated,
        revision: existing === null ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (index === -1) {
        database.policies.push(policy);
      } else {
        database.policies[index] = policy;
      }
      return policy;
    });
  }

  public listBudgetPolicies(
    projectId: string,
    monthKey: string,
    currency: string,
  ): Promise<readonly GenerationBudgetPolicy[]> {
    return Promise.resolve().then(() => {
      validateUuid(projectId, "projectId");
      validateMonthKey(monthKey);
      validateCurrency(currency);
      return Object.freeze(
        this.read()
          .policies.filter(
            (policy) =>
              policy.currency === currency &&
              ((policy.scope === "project" && policy.projectId === projectId) ||
                (policy.scope === "month" && policy.monthKey === monthKey)),
          )
          .sort((left, right) => left.scope.localeCompare(right.scope)),
      );
    });
  }

  public async getBudgetLimits(
    projectId: string,
    monthKey: string,
    currency: string,
  ): Promise<readonly BudgetLimit[]> {
    const policies = await this.listBudgetPolicies(projectId, monthKey, currency);
    return buildBudgetLimits(
      policies,
      this.read().runs.filter((run) => run.currency === currency),
      projectId,
      monthKey,
    );
  }

  public createRun(input: CreateGenerationRunInput): Promise<CreateGenerationRunResult> {
    return this.mutate((database) => {
      const prepared = prepareGenerationRun(input, this.clock.now());
      const existing = database.runs.find(
        ({ idempotencyKey }) => idempotencyKey === prepared.idempotencyKey,
      );
      if (existing !== undefined) {
        if (!sameGenerationRequest(existing, prepared)) {
          throw governanceConflict("AI_GENERATION_IDEMPOTENCY_CONFLICT");
        }
        return { run: existing, created: false };
      }
      database.runs.push(prepared);
      return { run: prepared, created: true };
    });
  }

  public findRunById(runId: string): Promise<GenerationRun | null> {
    return Promise.resolve().then(() => {
      validateUuid(runId, "runId");
      return this.read().runs.find(({ id }) => id === runId) ?? null;
    });
  }

  public listRunsByProjectId(projectIdValue: string): Promise<readonly GenerationRun[]> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "projectId");
      return Object.freeze(
        this.read()
          .runs.filter((run) => run.projectId === projectId)
          .map(validateGenerationRun)
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          ),
      );
    });
  }

  public findRunByIdempotencyKey(idempotencyKey: string): Promise<GenerationRun | null> {
    return Promise.resolve().then(() => {
      validateIdempotencyKey(idempotencyKey);
      return this.read().runs.find((run) => run.idempotencyKey === idempotencyKey) ?? null;
    });
  }

  public findLatestRetryableRun(input: {
    readonly chapterId: string;
    readonly baseVersionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly pricingVersion: string;
    readonly estimatedCostMicros: string;
  }): Promise<GenerationRun | null> {
    return Promise.resolve().then(() => {
      validateUuid(input.chapterId, "chapterId");
      validateUuid(input.baseVersionId, "baseVersionId");
      validateSafeIdentifier(input.providerId, 128, "providerId");
      validateSafeIdentifier(input.modelId, 512, "modelId");
      validateSafeIdentifier(input.pricingVersion, 128, "pricingVersion");
      validateMicros(input.estimatedCostMicros, "estimatedCostMicros");
      return (
        this.read()
          .runs.filter(
            (run) =>
              run.chapterId === input.chapterId &&
              run.baseVersionId === input.baseVersionId &&
              run.providerId === input.providerId &&
              run.modelId === input.modelId &&
              run.pricingVersion === input.pricingVersion &&
              run.estimatedCostMicros === input.estimatedCostMicros &&
              run.state === "failed_retryable",
          )
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
          )[0] ?? null
      );
    });
  }

  public transitionRun(input: TransitionGenerationRunInput): Promise<GenerationRun> {
    return this.mutate((database) => {
      const index = database.runs.findIndex(({ id }) => id === input.runId);
      const current = database.runs[index];
      if (current === undefined) {
        throw governanceError("AI_GENERATION_RUN_NOT_FOUND", "Generation run was not found.");
      }
      const next = evolveGenerationRun(current, input, this.clock.now());
      if (input.attemptUsage !== undefined) {
        const usage = prepareAttemptUsage(current, input.attemptUsage, next.updatedAt);
        if (
          database.attemptUsage.some(
            ({ runId, attempt }) => runId === usage.runId && attempt === usage.attempt,
          )
        ) {
          throw governanceConflict("AI_GENERATION_USAGE_CONFLICT");
        }
        database.attemptUsage.push(usage);
      }
      database.runs[index] = next;
      return next;
    });
  }

  public listAttemptUsage(runIdValue: string): Promise<readonly GenerationAttemptUsage[]> {
    return Promise.resolve().then(() => {
      const runId = validateUuid(runIdValue, "runId");
      return Object.freeze(
        this.read()
          .attemptUsage.filter((usage) => usage.runId === runId)
          .map(validateAttemptUsage)
          .sort((left, right) => left.attempt - right.attempt),
      );
    });
  }

  public createDeferredRequest(
    input: CreateDeferredGenerationInput,
  ): Promise<{ readonly request: DeferredGenerationRequest; readonly created: boolean }> {
    return this.mutate((database) => {
      const prepared = prepareDeferredRequest(input, this.clock.now());
      const existing = database.deferredRequests.find(
        ({ idempotencyKey }) => idempotencyKey === prepared.idempotencyKey,
      );
      if (existing !== undefined) {
        if (!sameDeferredRequest(existing, prepared)) {
          throw governanceConflict("AI_DEFERRED_IDEMPOTENCY_CONFLICT");
        }
        return { request: existing, created: false };
      }
      if (
        database.deferredRequests.some(
          (request) =>
            request.chapterId === prepared.chapterId &&
            request.modelRole === prepared.modelRole &&
            request.status === "waiting_network",
        )
      ) {
        throw governanceConflict("AI_DEFERRED_ACTIVE_CONFLICT");
      }
      database.deferredRequests.push(prepared);
      return { request: prepared, created: true };
    });
  }

  public findWaitingDeferredRequest(
    chapterIdValue: string,
    modelRoleValue: ModelRouteRole,
  ): Promise<DeferredGenerationRequest | null> {
    return Promise.resolve().then(() => {
      const chapterId = validateUuid(chapterIdValue, "chapterId");
      const modelRole = validateModelRole(modelRoleValue);
      return (
        this.read()
          .deferredRequests.filter(
            (request) =>
              request.chapterId === chapterId &&
              request.modelRole === modelRole &&
              request.status === "waiting_network",
          )
          .map(validateDeferredRequest)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
          )[0] ?? null
      );
    });
  }

  public transitionDeferredRequest(
    input: TransitionDeferredGenerationInput,
  ): Promise<DeferredGenerationRequest> {
    return this.mutate((database) => {
      const index = database.deferredRequests.findIndex(({ id }) => id === input.id);
      const current = database.deferredRequests[index];
      if (current === undefined) {
        throw governanceError(
          "AI_DEFERRED_REQUEST_NOT_FOUND",
          "Deferred generation request was not found.",
        );
      }
      const next = evolveDeferredRequest(current, input, this.clock.now());
      database.deferredRequests[index] = next;
      return next;
    });
  }

  private read(): BrowserGenerationGovernanceDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_GENERATION_GOVERNANCE_KEY);
    if (serialized === null) {
      return {
        schemaVersion: 2,
        policies: [],
        runs: [],
        attemptUsage: [],
        deferredRequests: [],
      };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      const migrated = migrateBrowserGenerationDatabase(parsed);
      if (
        !isObject(migrated) ||
        migrated.schemaVersion !== 2 ||
        !Array.isArray(migrated.policies) ||
        !Array.isArray(migrated.runs) ||
        !Array.isArray(migrated.attemptUsage) ||
        !Array.isArray(migrated.deferredRequests) ||
        containsProhibitedGenerationKey(migrated)
      ) {
        throw new Error("Invalid generation governance database shape.");
      }
      const database = structuredClone(migrated) as unknown as BrowserGenerationGovernanceDatabase;
      database.policies = database.policies.map(validateBudgetPolicy);
      database.runs = database.runs.map(validateGenerationRun);
      database.attemptUsage = database.attemptUsage.map(validateAttemptUsage);
      database.deferredRequests = database.deferredRequests.map(validateDeferredRequest);
      return database;
    } catch (cause: unknown) {
      throw cause instanceof GenerationGovernanceError
        ? cause
        : governanceError(
            "AI_GENERATION_STORE_CORRUPT",
            "Stored generation governance data failed integrity validation.",
          );
    }
  }

  private mutate<Value>(
    operation: (database: BrowserGenerationGovernanceDatabase) => Value,
  ): Promise<Value> {
    try {
      const database = this.read();
      const value = operation(database);
      this.storage.setItem(DEVELOPMENT_GENERATION_GOVERNANCE_KEY, JSON.stringify(database));
      return Promise.resolve(value);
    } catch (cause: unknown) {
      return Promise.reject(
        cause instanceof GenerationGovernanceError
          ? cause
          : governanceError("AI_GENERATION_STORE_FAILED", "Unable to update generation data."),
      );
    }
  }
}

export class GenerationGovernanceError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GenerationGovernanceError";
  }
}

function prepareGenerationRun(input: CreateGenerationRunInput, now: string): GenerationRun {
  if (!input.preflight.canStart) {
    throw governanceError(
      "AI_GENERATION_PREFLIGHT_BLOCKED",
      "A blocked preflight cannot create a generation run.",
    );
  }
  const estimate = input.preflight.estimate;
  const costStatus: GenerationCostStatus = estimate === null ? "pricing_unavailable" : "estimated";
  const run: GenerationRun = {
    id: validateUuid(input.id, "id"),
    taskId: validateUuid(input.taskId, "taskId"),
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    projectId: validateUuid(input.projectId, "projectId"),
    chapterId: validateUuid(input.chapterId, "chapterId"),
    baseVersionId: validateUuid(input.baseVersionId, "baseVersionId"),
    providerId: validateSafeIdentifier(input.providerId, 128, "providerId"),
    modelId: validateSafeIdentifier(input.modelId, 512, "modelId"),
    state: "queued",
    revision: 1,
    attempt: 1,
    inputTokens: input.preflight.inputTokens,
    maximumOutputTokens: input.preflight.maximumOutputTokens,
    estimatedCostMicros: estimate?.micros.toString() ?? "0",
    incurredCostMicros: "0",
    costStatus,
    currency: validateCurrency(estimate?.currency ?? "XXX"),
    pricingVersion: validateSafeIdentifier(
      estimate?.pricingVersion ?? "pricing_unavailable",
      128,
      "pricingVersion",
    ),
    priceUpdatedAt: validateTimestamp(estimate?.priceUpdatedAt ?? now),
    preflight: serializePreflight(input.preflight),
    route: validateRouteSelection(
      input.route ?? {
        role: "high_quality",
        reason: "legacy_default",
        fallbackProviderId: null,
        fallbackModelId: null,
      },
    ),
    candidateId: null,
    failureCode: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: validateTimestamp(now),
    updatedAt: validateTimestamp(now),
  };
  return validateGenerationRun(run);
}

function evolveGenerationRun(
  current: GenerationRun,
  input: TransitionGenerationRunInput,
  nowValue: string,
): GenerationRun {
  if (current.revision !== input.expectedRevision) {
    throw governanceConflict("AI_GENERATION_REVISION_CONFLICT");
  }
  if (input.state !== current.state && !canTransitionGenerationState(current.state, input.state)) {
    throw governanceError(
      "AI_GENERATION_ILLEGAL_TRANSITION",
      `Generation cannot transition from ${current.state} to ${input.state}.`,
    );
  }
  const now = validateTimestamp(nowValue);
  const candidateId =
    input.candidateId === undefined
      ? current.candidateId
      : input.candidateId === null
        ? null
        : validateUuid(input.candidateId, "candidateId");
  if ((input.state === "candidate_ready" || input.state === "completed") && candidateId === null) {
    throw governanceError(
      "AI_GENERATION_CANDIDATE_REQUIRED",
      "A ready or completed generation run must retain its candidate.",
    );
  }
  const addCost =
    input.addIncurredCost === true && current.costStatus === "estimated"
      ? BigInt(current.estimatedCostMicros)
      : 0n;
  return validateGenerationRun({
    ...current,
    state: input.state,
    revision: current.revision + 1,
    attempt: input.attempt ?? current.attempt,
    incurredCostMicros: (BigInt(current.incurredCostMicros) + addCost).toString(),
    candidateId,
    failureCode:
      input.failureCode === undefined
        ? current.failureCode
        : input.failureCode === null
          ? null
          : validateErrorCode(input.failureCode),
    cancelledAt: input.state === "cancelled" ? now : null,
    completedAt: input.state === "completed" ? now : null,
    updatedAt: now,
  });
}

function serializePreflight(preflight: GenerationPreflightSnapshot): PersistedGenerationPreflight {
  const estimate = preflight.estimate;
  return Object.freeze({
    checkedAt: validateTimestamp(preflight.checkedAt),
    canStart: preflight.canStart,
    requiresConfirmation: preflight.requiresConfirmation,
    codes: Object.freeze(preflight.checks.map(({ code }) => code)),
    costStatus: estimate === null ? "pricing_unavailable" : "estimated",
    estimateMicros: estimate?.micros.toString() ?? null,
    currency: estimate === null ? null : validateCurrency(estimate.currency),
    pricingVersion:
      estimate === null
        ? null
        : validateSafeIdentifier(estimate.pricingVersion, 128, "pricingVersion"),
    priceUpdatedAt: estimate === null ? null : validateTimestamp(estimate.priceUpdatedAt),
    inputBytes: preflight.inputBytes,
    inputTokens: preflight.inputTokens,
    maximumOutputTokens: preflight.maximumOutputTokens,
    contextWindowTokens: preflight.contextWindowTokens,
  });
}

function buildBudgetLimits(
  policies: readonly GenerationBudgetPolicy[],
  runs: readonly GenerationRun[],
  projectId: string,
  monthKey: string,
): readonly BudgetLimit[] {
  return Object.freeze(
    policies
      .filter(
        (policy) =>
          (policy.scope === "project" && policy.projectId === projectId) ||
          (policy.scope === "month" && policy.monthKey === monthKey),
      )
      .sort((left, right) => left.scope.localeCompare(right.scope))
      .map((policy): BudgetLimit => {
        const relevant = runs.filter((run) =>
          policy.scope === "project"
            ? run.projectId === projectId
            : run.createdAt.startsWith(`${monthKey}-`),
        );
        return {
          scope: policy.scope,
          limitMicros: BigInt(policy.limitMicros),
          spentMicros: relevant.reduce((sum, run) => sum + costCommittedOrReserved(run), 0n),
          enforcement: policy.enforcement,
        };
      }),
  );
}

function costCommittedOrReserved(run: GenerationRun): bigint {
  const incurred = BigInt(run.incurredCostMicros);
  if (
    run.costStatus === "estimated" &&
    (run.state === "queued" ||
      run.state === "retrieving" ||
      run.state === "generating" ||
      run.state === "validating")
  ) {
    const estimate = BigInt(run.estimatedCostMicros);
    return incurred + estimate;
  }
  return incurred;
}

function validateBudgetPolicyInput(input: SaveGenerationBudgetPolicyInput): Omit<
  GenerationBudgetPolicy,
  "revision" | "createdAt" | "updatedAt"
> & {
  readonly expectedRevision: number | null;
} {
  let projectId: string | null;
  let monthKey: string | null;
  let scopeKey: string;
  if (input.scope === "project") {
    projectId = validateUuid(input.projectId ?? "", "projectId");
    monthKey = input.monthKey;
    scopeKey = `project:${projectId}`;
  } else {
    projectId = input.projectId;
    monthKey = validateMonthKey(input.monthKey ?? "");
    scopeKey = `month:${monthKey}`;
  }
  if (
    (input.scope === "project" && input.monthKey !== null) ||
    (input.scope === "month" && input.projectId !== null) ||
    (input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
  ) {
    throw governanceError("AI_BUDGET_INVALID", "Budget scope or revision is invalid.");
  }
  const limitMicros = validateMicros(input.limitMicros, "limitMicros");
  return Object.freeze({
    scopeKey,
    scope: input.scope,
    projectId,
    monthKey,
    currency: validateCurrency(input.currency),
    limitMicros,
    enforcement: validateBudgetEnforcement(input.enforcement),
    expectedRevision: input.expectedRevision,
  });
}

function validateBudgetPolicy(policy: GenerationBudgetPolicy): GenerationBudgetPolicy {
  const validated = validateBudgetPolicyInput({
    scope: policy.scope,
    projectId: policy.projectId,
    monthKey: policy.monthKey,
    currency: policy.currency,
    limitMicros: policy.limitMicros,
    enforcement: policy.enforcement,
    expectedRevision: policy.revision,
  });
  if (
    validated.scopeKey !== policy.scopeKey ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1
  ) {
    throw governanceError("AI_BUDGET_STORE_CORRUPT", "Stored budget policy is invalid.");
  }
  return Object.freeze({
    scopeKey: validated.scopeKey,
    scope: validated.scope,
    projectId: validated.projectId,
    monthKey: validated.monthKey,
    currency: validated.currency,
    limitMicros: validated.limitMicros,
    enforcement: validated.enforcement,
    revision: policy.revision,
    createdAt: validateTimestamp(policy.createdAt),
    updatedAt: validateTimestamp(policy.updatedAt),
  });
}

function hydrateBudgetPolicy(row: BudgetPolicyRow): GenerationBudgetPolicy {
  return validateBudgetPolicy({
    scopeKey: row.scope_key,
    scope: row.scope as GenerationBudgetPolicy["scope"],
    projectId: row.project_id,
    monthKey: row.month_key,
    currency: row.currency,
    limitMicros: row.limit_micros,
    enforcement: row.enforcement as BudgetEnforcement,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateGenerationRun(row: GenerationRunRow): GenerationRun {
  let preflight: unknown;
  try {
    preflight = JSON.parse(row.preflight_json);
  } catch {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored generation preflight is invalid.");
  }
  return validateGenerationRun({
    id: row.id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    baseVersionId: row.base_version_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    state: row.state as GenerationState,
    revision: row.revision,
    attempt: row.attempt,
    inputTokens: row.input_tokens,
    maximumOutputTokens: row.maximum_output_tokens,
    estimatedCostMicros: row.estimated_cost_micros,
    incurredCostMicros: row.incurred_cost_micros,
    costStatus: row.cost_status as GenerationCostStatus,
    currency: row.currency,
    pricingVersion: row.pricing_version,
    priceUpdatedAt: row.price_updated_at,
    preflight: preflight as PersistedGenerationPreflight,
    route:
      row.route_role === null || row.route_reason === null
        ? {
            role: "high_quality",
            reason: "legacy_default",
            fallbackProviderId: null,
            fallbackModelId: null,
          }
        : {
            role: row.route_role as ModelRouteRole,
            reason: row.route_reason as GenerationRouteReason,
            fallbackProviderId: row.route_fallback_provider_id,
            fallbackModelId: row.route_fallback_model_id,
          },
    candidateId: row.candidate_id,
    failureCode: row.failure_code,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function validateGenerationRun(run: GenerationRun): GenerationRun {
  const costStatus = (run as Partial<GenerationRun>).costStatus ?? "estimated";
  if (
    !Number.isSafeInteger(run.revision) ||
    run.revision < 1 ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt < 1 ||
    run.attempt > 100 ||
    !Number.isSafeInteger(run.inputTokens) ||
    run.inputTokens < 0 ||
    !Number.isSafeInteger(run.maximumOutputTokens) ||
    run.maximumOutputTokens < 0 ||
    (run.state === "cancelled") !== (run.cancelledAt !== null) ||
    (run.state === "completed") !== (run.completedAt !== null)
  ) {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored generation run is invalid.");
  }
  validateUuid(run.id, "id");
  validateUuid(run.taskId, "taskId");
  validateIdempotencyKey(run.idempotencyKey);
  validateUuid(run.projectId, "projectId");
  validateUuid(run.chapterId, "chapterId");
  validateUuid(run.baseVersionId, "baseVersionId");
  validateSafeIdentifier(run.providerId, 128, "providerId");
  validateSafeIdentifier(run.modelId, 512, "modelId");
  validateMicros(run.estimatedCostMicros, "estimatedCostMicros");
  validateMicros(run.incurredCostMicros, "incurredCostMicros");
  if (
    !(["estimated", "pricing_unavailable"] as readonly string[]).includes(costStatus) ||
    (costStatus === "pricing_unavailable" &&
      (run.estimatedCostMicros !== "0" ||
        run.currency !== "XXX" ||
        run.pricingVersion !== "pricing_unavailable"))
  ) {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored cost status is invalid.");
  }
  validateCurrency(run.currency);
  validateSafeIdentifier(run.pricingVersion, 128, "pricingVersion");
  validateTimestamp(run.priceUpdatedAt);
  validatePersistedPreflight(run.preflight);
  const route = validateRouteSelection(run.route);
  if (run.candidateId !== null) {
    validateUuid(run.candidateId, "candidateId");
  }
  if (run.failureCode !== null) {
    validateErrorCode(run.failureCode);
  }
  if (run.cancelledAt !== null) {
    validateTimestamp(run.cancelledAt);
  }
  if (run.completedAt !== null) {
    validateTimestamp(run.completedAt);
  }
  validateTimestamp(run.createdAt);
  validateTimestamp(run.updatedAt);
  return Object.freeze({
    ...run,
    costStatus,
    route,
    preflight: Object.freeze({ ...run.preflight }),
  });
}

function validatePersistedPreflight(
  preflight: PersistedGenerationPreflight,
): PersistedGenerationPreflight {
  if (!isObject(preflight)) {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored generation preflight is invalid.");
  }
  const costStatus = (preflight as Partial<PersistedGenerationPreflight>).costStatus ?? "estimated";
  if (
    typeof preflight.canStart !== "boolean" ||
    typeof preflight.requiresConfirmation !== "boolean" ||
    !Array.isArray(preflight.codes) ||
    preflight.codes.length > 32 ||
    preflight.codes.some(
      (code) => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{2,80}$/u.test(code),
    ) ||
    !Number.isSafeInteger(preflight.inputBytes) ||
    preflight.inputBytes < 0 ||
    !Number.isSafeInteger(preflight.inputTokens) ||
    preflight.inputTokens < 0 ||
    !Number.isSafeInteger(preflight.maximumOutputTokens) ||
    preflight.maximumOutputTokens < 0 ||
    (preflight.contextWindowTokens !== null &&
      (!Number.isSafeInteger(preflight.contextWindowTokens) || preflight.contextWindowTokens < 1))
  ) {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored generation preflight is invalid.");
  }
  validateTimestamp(preflight.checkedAt);
  if (!(["estimated", "pricing_unavailable"] as readonly string[]).includes(costStatus)) {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored preflight cost is invalid.");
  }
  if (costStatus === "estimated") {
    validateMicros(preflight.estimateMicros ?? "", "estimateMicros");
    validateCurrency(preflight.currency ?? "");
    validateSafeIdentifier(preflight.pricingVersion ?? "", 128, "pricingVersion");
    validateTimestamp(preflight.priceUpdatedAt ?? "");
  } else if (
    preflight.estimateMicros !== null ||
    preflight.currency !== null ||
    preflight.pricingVersion !== null ||
    preflight.priceUpdatedAt !== null
  ) {
    throw governanceError("AI_GENERATION_STORE_CORRUPT", "Stored preflight cost is invalid.");
  }
  return Object.freeze({ ...preflight, costStatus });
}

function sameGenerationRequest(left: GenerationRun, right: GenerationRun): boolean {
  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.chapterId === right.chapterId &&
    left.baseVersionId === right.baseVersionId &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.route.role === right.route.role &&
    left.route.reason === right.route.reason &&
    left.route.fallbackProviderId === right.route.fallbackProviderId &&
    left.route.fallbackModelId === right.route.fallbackModelId &&
    left.inputTokens === right.inputTokens &&
    left.maximumOutputTokens === right.maximumOutputTokens &&
    left.costStatus === right.costStatus &&
    left.pricingVersion === right.pricingVersion &&
    left.estimatedCostMicros === right.estimatedCostMicros
  );
}

function validateRouteSelection(route: GenerationRouteSelection): GenerationRouteSelection {
  const validReason = (
    ["legacy_default", "role_primary", "role_fallback", "local_demo"] as readonly string[]
  ).includes(route.reason);
  if (!validReason || (route.fallbackProviderId === null) !== (route.fallbackModelId === null)) {
    throw governanceError("AI_GENERATION_INVALID", "Generation route selection is invalid.");
  }
  return Object.freeze({
    role: validateModelRole(route.role),
    reason: route.reason,
    fallbackProviderId:
      route.fallbackProviderId === null
        ? null
        : validateSafeIdentifier(route.fallbackProviderId, 128, "fallbackProviderId"),
    fallbackModelId:
      route.fallbackModelId === null
        ? null
        : validateSafeIdentifier(route.fallbackModelId, 512, "fallbackModelId"),
  });
}

function prepareAttemptUsage(
  run: GenerationRun,
  input: GenerationAttemptUsageInput,
  reportedAt: string,
): GenerationAttemptUsage {
  return validateAttemptUsage({
    ...input,
    runId: run.id,
    attempt: run.attempt,
    costStatus: run.costStatus,
    currency: run.currency,
    pricingVersion: run.pricingVersion,
    priceUpdatedAt: run.priceUpdatedAt,
    reportedAt,
  });
}

function hydrateAttemptUsage(row: GenerationAttemptUsageRow): GenerationAttemptUsage {
  return validateAttemptUsage({
    runId: row.run_id,
    attempt: row.attempt,
    source: row.usage_source as GenerationUsageSource,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    usagePricedEstimateMicros: row.usage_priced_estimate_micros,
    costStatus: row.cost_status as GenerationCostStatus,
    currency: row.currency,
    pricingVersion: row.pricing_version,
    priceUpdatedAt: row.price_updated_at,
    reportedAt: row.reported_at,
  });
}

function validateAttemptUsage(usage: GenerationAttemptUsage): GenerationAttemptUsage {
  const costStatus =
    (usage as Partial<GenerationAttemptUsage>).costStatus ??
    (usage.source === "provider_reported_unpriced" ? "pricing_unavailable" : "estimated");
  const validToken = (value: number | null): boolean =>
    value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000);
  if (
    !Number.isSafeInteger(usage.attempt) ||
    usage.attempt < 1 ||
    usage.attempt > 100 ||
    !validToken(usage.inputTokens) ||
    !validToken(usage.outputTokens) ||
    !validToken(usage.cachedInputTokens)
  ) {
    throw governanceError("AI_GENERATION_USAGE_INVALID", "Generation attempt usage is invalid.");
  }
  const providerReported =
    usage.source === "provider_reported" &&
    costStatus === "estimated" &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    (usage.cachedInputTokens === null || usage.cachedInputTokens <= usage.inputTokens) &&
    usage.usagePricedEstimateMicros !== null;
  const providerReportedUnpriced =
    usage.source === "provider_reported_unpriced" &&
    costStatus === "pricing_unavailable" &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    (usage.cachedInputTokens === null || usage.cachedInputTokens <= usage.inputTokens) &&
    usage.usagePricedEstimateMicros === null;
  const providerUnavailable =
    usage.source === "provider_unavailable" &&
    usage.inputTokens === null &&
    usage.outputTokens === null &&
    usage.cachedInputTokens === null &&
    usage.usagePricedEstimateMicros === null;
  const localDemo =
    usage.source === "local_demo" &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.usagePricedEstimateMicros === "0";
  if (!providerReported && !providerReportedUnpriced && !providerUnavailable && !localDemo) {
    throw governanceError(
      "AI_GENERATION_USAGE_INVALID",
      "Usage source and token values are inconsistent.",
    );
  }
  validateUuid(usage.runId, "runId");
  if (usage.usagePricedEstimateMicros !== null) {
    validateMicros(usage.usagePricedEstimateMicros, "usagePricedEstimateMicros");
  }
  validateCurrency(usage.currency);
  validateSafeIdentifier(usage.pricingVersion, 128, "pricingVersion");
  validateTimestamp(usage.priceUpdatedAt);
  validateTimestamp(usage.reportedAt);
  return Object.freeze({ ...usage, costStatus });
}

function prepareDeferredRequest(
  input: CreateDeferredGenerationInput,
  nowValue: string,
): DeferredGenerationRequest {
  const estimate = input.preflight.estimate;
  const blockingCodes = input.preflight.checks
    .filter(({ severity }) => severity === "blocking")
    .map(({ code }) => code);
  if (
    input.preflight.canStart ||
    estimate === null ||
    blockingCodes.length !== 1 ||
    blockingCodes[0] !== "NETWORK_OFFLINE" ||
    input.maximumOutputTokens !== input.preflight.maximumOutputTokens
  ) {
    throw governanceError(
      "AI_DEFERRED_PREFLIGHT_INELIGIBLE",
      "Only an otherwise-ready remote generation blocked by network availability can be deferred.",
    );
  }
  const now = validateTimestamp(nowValue);
  return validateDeferredRequest({
    id: validateUuid(input.id, "id"),
    taskId: validateUuid(input.taskId, "taskId"),
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    projectId: validateUuid(input.projectId, "projectId"),
    chapterId: validateUuid(input.chapterId, "chapterId"),
    baseVersionId: validateUuid(input.baseVersionId, "baseVersionId"),
    modelRole: validateModelRole(input.modelRole),
    providerId: validateSafeIdentifier(input.providerId, 128, "providerId"),
    modelId: validateSafeIdentifier(input.modelId, 512, "modelId"),
    maximumOutputTokens: input.maximumOutputTokens,
    approvedInputTokens: input.preflight.inputTokens,
    approvedEstimateMicros: estimate.micros.toString(),
    currency: estimate.currency,
    pricingVersion: estimate.pricingVersion,
    priceUpdatedAt: estimate.priceUpdatedAt,
    status: "waiting_network",
    revision: 1,
    consumedRunId: null,
    cancelledAt: null,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

function hydrateDeferredRequest(row: DeferredGenerationRow): DeferredGenerationRequest {
  return validateDeferredRequest({
    id: row.id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    baseVersionId: row.base_version_id,
    modelRole: row.model_role as ModelRouteRole,
    providerId: row.provider_id,
    modelId: row.model_id,
    maximumOutputTokens: row.maximum_output_tokens,
    approvedInputTokens: row.approved_input_tokens,
    approvedEstimateMicros: row.approved_estimate_micros,
    currency: row.currency,
    pricingVersion: row.pricing_version,
    priceUpdatedAt: row.price_updated_at,
    status: row.status as DeferredGenerationStatus,
    revision: row.revision,
    consumedRunId: row.consumed_run_id,
    cancelledAt: row.cancelled_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function validateDeferredRequest(request: DeferredGenerationRequest): DeferredGenerationRequest {
  const validStatus = (
    ["waiting_network", "blocked_stale", "cancelled", "consumed"] as readonly string[]
  ).includes(request.status);
  if (
    !validStatus ||
    !Number.isSafeInteger(request.revision) ||
    request.revision < 1 ||
    !Number.isSafeInteger(request.maximumOutputTokens) ||
    request.maximumOutputTokens < 0 ||
    !Number.isSafeInteger(request.approvedInputTokens) ||
    request.approvedInputTokens < 0 ||
    (request.status === "cancelled") !== (request.cancelledAt !== null) ||
    (request.status === "consumed") !==
      (request.consumedAt !== null && request.consumedRunId !== null) ||
    (request.status !== "consumed" &&
      (request.consumedAt !== null || request.consumedRunId !== null))
  ) {
    throw governanceError(
      "AI_DEFERRED_STORE_CORRUPT",
      "Stored deferred generation request is invalid.",
    );
  }
  validateUuid(request.id, "id");
  validateUuid(request.taskId, "taskId");
  validateIdempotencyKey(request.idempotencyKey);
  validateUuid(request.projectId, "projectId");
  validateUuid(request.chapterId, "chapterId");
  validateUuid(request.baseVersionId, "baseVersionId");
  validateModelRole(request.modelRole);
  validateSafeIdentifier(request.providerId, 128, "providerId");
  validateSafeIdentifier(request.modelId, 512, "modelId");
  validateMicros(request.approvedEstimateMicros, "approvedEstimateMicros");
  validateCurrency(request.currency);
  validateSafeIdentifier(request.pricingVersion, 128, "pricingVersion");
  validateTimestamp(request.priceUpdatedAt);
  if (request.consumedRunId !== null) {
    validateUuid(request.consumedRunId, "consumedRunId");
  }
  if (request.cancelledAt !== null) {
    validateTimestamp(request.cancelledAt);
  }
  if (request.consumedAt !== null) {
    validateTimestamp(request.consumedAt);
  }
  validateTimestamp(request.createdAt);
  validateTimestamp(request.updatedAt);
  return Object.freeze({ ...request });
}

function evolveDeferredRequest(
  current: DeferredGenerationRequest,
  input: TransitionDeferredGenerationInput,
  nowValue: string,
): DeferredGenerationRequest {
  if (current.revision !== input.expectedRevision) {
    throw governanceConflict("AI_DEFERRED_REVISION_CONFLICT");
  }
  if (current.status !== "waiting_network") {
    throw governanceError(
      "AI_DEFERRED_ILLEGAL_TRANSITION",
      "Only a waiting deferred request can change state.",
    );
  }
  const now = validateTimestamp(nowValue);
  const consumedRunId =
    input.status === "consumed" ? validateUuid(input.consumedRunId ?? "", "consumedRunId") : null;
  if (input.status !== "consumed" && input.consumedRunId !== undefined) {
    throw governanceError(
      "AI_DEFERRED_ILLEGAL_TRANSITION",
      "Only a consumed deferred request can reference a generation run.",
    );
  }
  return validateDeferredRequest({
    ...current,
    status: input.status,
    revision: current.revision + 1,
    consumedRunId,
    cancelledAt: input.status === "cancelled" ? now : null,
    consumedAt: input.status === "consumed" ? now : null,
    updatedAt: now,
  });
}

function sameDeferredRequest(
  left: DeferredGenerationRequest,
  right: DeferredGenerationRequest,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.chapterId === right.chapterId &&
    left.baseVersionId === right.baseVersionId &&
    left.modelRole === right.modelRole &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.maximumOutputTokens === right.maximumOutputTokens &&
    left.approvedInputTokens === right.approvedInputTokens &&
    left.approvedEstimateMicros === right.approvedEstimateMicros &&
    left.currency === right.currency &&
    left.pricingVersion === right.pricingVersion
  );
}

function validateModelRole(value: unknown): ModelRouteRole {
  if (!isModelRouteRole(value)) {
    throw governanceError("AI_GENERATION_INVALID", "Model role is invalid.");
  }
  return value;
}

function validateUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw governanceError("AI_GENERATION_INVALID", `${field} must be a UUIDv7.`);
  }
  return value.toLowerCase();
}

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,199}$/u.test(value)) {
    throw governanceError("AI_GENERATION_INVALID", "Idempotency key is invalid.");
  }
  return value;
}

function validateSafeIdentifier(value: string, maximum: number, field: string): string {
  if (
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw governanceError("AI_GENERATION_INVALID", `${field} is invalid.`);
  }
  return value;
}

function validateCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw governanceError("AI_GENERATION_INVALID", "Currency is invalid.");
  }
  return value;
}

function validateMicros(value: string, field: string): string {
  if (!/^\d{1,19}$/u.test(value) || BigInt(value) > 9_000_000_000_000_000_000n) {
    throw governanceError("AI_GENERATION_INVALID", `${field} is invalid.`);
  }
  return value;
}

function validateMonthKey(value: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    throw governanceError("AI_BUDGET_INVALID", "Month key is invalid.");
  }
  return value;
}

function validateBudgetEnforcement(value: unknown): BudgetEnforcement {
  if (value !== "warn" && value !== "hard") {
    throw governanceError("AI_BUDGET_INVALID", "Budget enforcement is invalid.");
  }
  return value;
}

function validateTimestamp(value: string): string {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw governanceError("AI_GENERATION_INVALID", "Timestamp is invalid.");
  }
  return value;
}

function validateErrorCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,79}$/u.test(value)) {
    throw governanceError("AI_GENERATION_INVALID", "Failure code is invalid.");
  }
  return value;
}

function governanceConflict(code: string): GenerationGovernanceError {
  return new GenerationGovernanceError(
    code,
    "Generation governance data changed concurrently.",
    true,
  );
}

function governanceError(code: string, message: string): GenerationGovernanceError {
  return new GenerationGovernanceError(code, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateBrowserGenerationDatabase(value: unknown): unknown {
  if (!isObject(value) || !Array.isArray(value.policies) || !Array.isArray(value.runs)) {
    return value;
  }
  if (value.schemaVersion === 2) {
    return value;
  }
  if (value.schemaVersion !== 1) {
    return value;
  }
  const runs = (value.runs as unknown[]).map((run): unknown =>
    isObject(run) && !("route" in run)
      ? {
          ...run,
          route: {
            role: "high_quality",
            reason: "legacy_default",
            fallbackProviderId: null,
            fallbackModelId: null,
          },
        }
      : run,
  );
  return {
    schemaVersion: 2,
    policies: value.policies,
    runs,
    attemptUsage: [],
    deferredRequests: [],
  };
}

function containsProhibitedGenerationKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProhibitedGenerationKey);
  }
  if (!isObject(value)) {
    return false;
  }
  const prohibited = new Set([
    "apikey",
    "authorization",
    "content",
    "credential",
    "messages",
    "password",
    "prompt",
    "secret",
  ]);
  return Object.entries(value).some(
    ([key, nested]) =>
      prohibited.has(key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase()) ||
      containsProhibitedGenerationKey(nested),
  );
}

const BUDGET_POLICY_SELECT = `SELECT
  scope_key, scope, project_id, month_key, currency, limit_micros,
  enforcement, revision, created_at, updated_at
FROM ai_budget_policies`;

const GENERATION_RUN_SELECT = `SELECT
  run.id, run.task_id, run.idempotency_key, run.project_id,
  run.chapter_id, run.base_version_id, run.provider_id, run.model_id,
  run.state, run.revision, run.attempt, run.input_tokens,
  run.maximum_output_tokens, run.estimated_cost_micros,
  run.incurred_cost_micros, run.cost_status, run.currency, run.pricing_version,
  run.price_updated_at, run.preflight_json, run.candidate_id,
  run.failure_code, run.cancelled_at, run.completed_at,
  run.created_at, run.updated_at,
  route.role AS route_role,
  route.reason AS route_reason,
  route.fallback_provider_id AS route_fallback_provider_id,
  route.fallback_model_id AS route_fallback_model_id
FROM ai_generation_runs AS run
LEFT JOIN ai_generation_route_selections AS route
  ON route.run_id = run.id`;

const ATTEMPT_USAGE_SELECT = `SELECT
  run_id, attempt, usage_source, input_tokens, output_tokens,
  cached_input_tokens, usage_priced_estimate_micros, cost_status, currency,
  pricing_version, price_updated_at, reported_at
FROM ai_generation_attempt_usage`;

const DEFERRED_GENERATION_SELECT = `SELECT
  id, task_id, idempotency_key, project_id, chapter_id,
  base_version_id, model_role, provider_id, model_id,
  maximum_output_tokens, approved_input_tokens,
  approved_estimate_micros, currency, pricing_version,
  price_updated_at, status, revision, consumed_run_id,
  cancelled_at, consumed_at, created_at, updated_at
FROM ai_deferred_generation_requests`;
