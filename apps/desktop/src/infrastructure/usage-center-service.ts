import type { SqlExecutor, SqlPrimitive } from "@inkshadow/data";

import { OPENING_INVOCATION_USAGE_STATUS_SQL } from "./opening-invocation-terminal";

export type UsageEventStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "ambiguous" | "not_dispatched";
export type UsagePrivacyPolicy =
  "cloud_allowed" | "local_preferred" | "local_only" | "not_recorded";
export type UsageDataDestination = "local" | "remote" | "not_recorded";
export type UsageCostSource =
  "provider_usage_estimate" | "model_hub_usage_estimate" | "local_demo_zero" | "unknown";
export type UsageBreakdownDimension = "time" | "project" | "task" | "provider" | "model";

export interface UsageCenterQuery {
  readonly fromInclusive: string | null;
  readonly toExclusive: string | null;
  readonly projectId: string | null;
  readonly task: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly monthKey: string;
  readonly timezoneOffsetMinutes: number;
  readonly detailLimit?: number;
}

export interface UsageCenterEvent {
  readonly id: string;
  readonly source: "generation_attempt" | "model_hub_invocation";
  readonly occurredAt: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly chapterId: string | null;
  readonly chapterName: string | null;
  readonly task: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly status: UsageEventStatus;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly costMicros: string | null;
  readonly currency: string | null;
  readonly costSource: UsageCostSource;
  readonly privacyPolicy: UsagePrivacyPolicy;
  readonly dataDestination: UsageDataDestination;
  readonly errorCode: string | null;
}

export interface UsageCostTotal {
  readonly currency: string;
  readonly micros: string;
  readonly invocationCount: number;
}

export interface UsageAggregate {
  readonly invocationCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly cancelledCount: number;
  readonly activeCount: number;
  readonly localCount: number;
  readonly remoteCount: number;
  readonly destinationUnknownCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly tokenUsageUnknownCount: number;
  readonly costTotals: readonly UsageCostTotal[];
  readonly costUnknownCount: number;
}

export interface UsageBreakdownEntry extends UsageAggregate {
  readonly key: string;
  readonly label: string;
}

export interface UsageFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface UsageCenterFacets {
  readonly projects: readonly UsageFilterOption[];
  readonly tasks: readonly UsageFilterOption[];
  readonly providers: readonly UsageFilterOption[];
  readonly models: readonly UsageFilterOption[];
}

export interface UsageBudgetPolicy {
  readonly scopeKey: string;
  readonly scope: "month" | "project";
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly monthKey: string | null;
  readonly currency: string;
  readonly limitMicros: string;
  readonly enforcement: "warn" | "hard";
  readonly updatedAt: string;
}

export interface UsageCenterSnapshot {
  readonly summary: UsageAggregate;
  readonly records: readonly UsageCenterEvent[];
  readonly totalMatchingRecords: number;
  readonly detailsTruncated: boolean;
  readonly facets: UsageCenterFacets;
  readonly breakdowns: Readonly<Record<UsageBreakdownDimension, readonly UsageBreakdownEntry[]>>;
  readonly budgets: readonly UsageBudgetPolicy[];
}

export interface UsageCenterReader {
  read(query: UsageCenterQuery): Promise<UsageCenterSnapshot>;
}

interface UsageEventRow {
  event_id: string;
  source: string;
  occurred_at: string;
  project_id: string | null;
  project_name: string | null;
  chapter_id: string | null;
  chapter_name: string | null;
  task: string;
  provider_id: string;
  provider_label: string;
  model_id: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_micros: string | null;
  currency: string | null;
  cost_source: string;
  privacy_policy: string;
  data_destination: string;
  error_code: string | null;
}

interface BudgetPolicyRow {
  scope_key: string;
  scope: string;
  project_id: string | null;
  project_name: string | null;
  month_key: string | null;
  currency: string;
  limit_micros: string;
  enforcement: string;
  updated_at: string;
}

const DEFAULT_DETAIL_LIMIT = 200;
const MAXIMUM_DETAIL_LIMIT = 500;
const MAXIMUM_USAGE_EVENTS_PER_READ = 100_000;
const SAFE_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MONTH_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MICROS_PATTERN = /^\d{1,19}$/u;

/**
 * Reads the two durable local usage ledgers without storing prompts,正文 or
 * provider credentials. Continuations are authoritative in
 * ai_generation_attempt_usage, where a project link is available. They are
 * excluded from model_invocation_facts so one provider dispatch is not counted
 * twice. All other Model Hub tasks use the universal invocation ledger.
 */
export class SqliteUsageCenterService implements UsageCenterReader {
  public constructor(private readonly executor: Pick<SqlExecutor, "select">) {}

  public async read(query: UsageCenterQuery): Promise<UsageCenterSnapshot> {
    const validated = validateQuery(query);
    const { sql, values } = buildTimeBoundUsageQuery(validated);
    const rows = await this.executor.select<UsageEventRow>(sql, values);
    if (rows.length > MAXIMUM_USAGE_EVENTS_PER_READ) {
      throw new UsageCenterError(
        "USAGE_CENTER_RANGE_TOO_LARGE",
        "所选时间范围内的调用记录过多。请缩短时间范围后重试，以免显示不完整的汇总。",
      );
    }

    const timeBoundEvents = rows.map(hydrateUsageEvent);
    const facets = buildFacets(timeBoundEvents);
    const matchingEvents = timeBoundEvents.filter((event) => matchesQuery(event, validated));
    const records = Object.freeze(matchingEvents.slice(0, validated.detailLimit));
    const budgets = await this.readBudgets(validated);

    return Object.freeze({
      summary: aggregateUsage(matchingEvents),
      records,
      totalMatchingRecords: matchingEvents.length,
      detailsTruncated: matchingEvents.length > records.length,
      facets,
      breakdowns: Object.freeze({
        time: buildBreakdown(
          matchingEvents,
          (event) => localDateKey(event.occurredAt, validated.timezoneOffsetMinutes),
          (key) => key,
          "time",
        ),
        project: buildBreakdown(
          matchingEvents,
          (event) => event.projectId ?? "__unlinked__",
          (_key, event) => event.projectName ?? "未关联作品",
          "count",
        ),
        task: buildBreakdown(
          matchingEvents,
          (event) => event.task,
          (key) => taskLabel(key),
          "count",
        ),
        provider: buildBreakdown(
          matchingEvents,
          (event) => event.providerId,
          (_key, event) => event.providerLabel,
          "count",
        ),
        model: buildBreakdown(
          matchingEvents,
          (event) => event.modelId,
          (key) => key,
          "count",
        ),
      }),
      budgets,
    });
  }

  private async readBudgets(
    query: ValidatedUsageCenterQuery,
  ): Promise<readonly UsageBudgetPolicy[]> {
    const rows = await this.executor.select<BudgetPolicyRow>(
      `SELECT
         policy.scope_key, policy.scope, policy.project_id,
         project.name AS project_name, policy.month_key, policy.currency,
         policy.limit_micros, policy.enforcement, policy.updated_at
       FROM ai_budget_policies AS policy
       LEFT JOIN projects AS project ON project.id = policy.project_id
       WHERE (policy.scope = 'month' AND policy.month_key = ?)
          OR (policy.scope = 'project' AND policy.project_id = ?)
       ORDER BY policy.scope ASC, policy.currency ASC, policy.scope_key ASC`,
      [query.monthKey, query.projectId],
    );
    return Object.freeze(rows.map(hydrateBudgetPolicy));
  }
}

export class UsageCenterError extends Error {
  public readonly retryable = true;

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UsageCenterError";
  }
}

interface ValidatedUsageCenterQuery extends UsageCenterQuery {
  readonly detailLimit: number;
}

function validateQuery(query: UsageCenterQuery): ValidatedUsageCenterQuery {
  const fromInclusive = validateOptionalTimestamp(query.fromInclusive, "fromInclusive");
  const toExclusive = validateOptionalTimestamp(query.toExclusive, "toExclusive");
  if (
    fromInclusive !== null &&
    toExclusive !== null &&
    Date.parse(fromInclusive) >= Date.parse(toExclusive)
  ) {
    throw invalidQuery("结束时间必须晚于开始时间。");
  }
  if (!MONTH_KEY_PATTERN.test(query.monthKey)) {
    throw invalidQuery("monthKey 必须使用 YYYY-MM 格式。");
  }
  if (
    !Number.isInteger(query.timezoneOffsetMinutes) ||
    query.timezoneOffsetMinutes < -840 ||
    query.timezoneOffsetMinutes > 840
  ) {
    throw invalidQuery("timezoneOffsetMinutes 超出有效范围。");
  }
  const detailLimit = query.detailLimit ?? DEFAULT_DETAIL_LIMIT;
  if (!Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > MAXIMUM_DETAIL_LIMIT) {
    throw invalidQuery(`detailLimit 必须在 1 到 ${String(MAXIMUM_DETAIL_LIMIT)} 之间。`);
  }
  return Object.freeze({
    fromInclusive,
    toExclusive,
    projectId: validateOptionalIdentifier(query.projectId, "projectId", 128),
    task: validateOptionalIdentifier(query.task, "task", 128),
    providerId: validateOptionalIdentifier(query.providerId, "providerId", 128),
    modelId: validateOptionalIdentifier(query.modelId, "modelId", 512),
    monthKey: query.monthKey,
    timezoneOffsetMinutes: query.timezoneOffsetMinutes,
    detailLimit,
  });
}

function validateOptionalTimestamp(value: string | null, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalidQuery(`${field} 必须是 UTC ISO 时间。`);
  }
  return value;
}

function validateOptionalIdentifier(
  value: string | null,
  field: string,
  maximumLength: number,
): string | null {
  if (value === null) {
    return null;
  }
  if (value.length > maximumLength || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw invalidQuery(`${field} 不是有效的筛选值。`);
  }
  return value;
}

function invalidQuery(message: string): UsageCenterError {
  return new UsageCenterError("USAGE_CENTER_INVALID_QUERY", message);
}

function buildTimeBoundUsageQuery(query: ValidatedUsageCenterQuery): {
  readonly sql: string;
  readonly values: readonly SqlPrimitive[];
} {
  const clauses: string[] = [];
  const values: SqlPrimitive[] = [];
  if (query.fromInclusive !== null) {
    clauses.push("event.occurred_at >= ?");
    values.push(query.fromInclusive);
  }
  if (query.toExclusive !== null) {
    clauses.push("event.occurred_at < ?");
    values.push(query.toExclusive);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  values.push(MAXIMUM_USAGE_EVENTS_PER_READ + 1);
  return {
    sql: `${USAGE_EVENTS_CTE}
      SELECT
        event.event_id, event.source, event.occurred_at,
        event.project_id, event.project_name, event.chapter_id, event.chapter_name, event.task,
        event.provider_id, event.provider_label, event.model_id,
        event.status, event.input_tokens, event.output_tokens,
        event.cached_input_tokens, event.cost_micros, event.currency,
        event.cost_source, event.privacy_policy, event.data_destination,
        event.error_code
      FROM usage_events AS event
      ${where}
      ORDER BY event.occurred_at DESC, event.event_id ASC
      LIMIT ?`,
    values,
  };
}

const USAGE_EVENTS_CTE = `WITH usage_events AS (
  SELECT
    'generation:' || usage.run_id || ':' || CAST(usage.attempt AS TEXT) AS event_id,
    'generation_attempt' AS source,
    usage.reported_at AS occurred_at,
    run.project_id AS project_id,
    project.name AS project_name,
    run.chapter_id AS chapter_id,
    chapter.title AS chapter_name,
    'continuation' AS task,
    run.provider_id AS provider_id,
    COALESCE(hub_connection.display_name, '历史 AI 服务') AS provider_label,
    run.model_id AS model_id,
    CASE
      WHEN usage.attempt < run.attempt THEN 'failed'
      WHEN run.state IN ('candidate_ready', 'completed') THEN 'succeeded'
      WHEN run.state IN ('failed_retryable', 'failed_final', 'blocked') THEN 'failed'
      WHEN run.state = 'cancelled' THEN 'cancelled'
      WHEN run.state IN ('retrieving', 'generating', 'validating') THEN 'running'
      ELSE 'queued'
    END AS status,
    usage.input_tokens AS input_tokens,
    usage.output_tokens AS output_tokens,
    usage.cached_input_tokens AS cached_input_tokens,
    usage.usage_priced_estimate_micros AS cost_micros,
    usage.currency AS currency,
    CASE
      WHEN usage.usage_source = 'provider_reported' THEN 'provider_usage_estimate'
      WHEN usage.usage_source = 'local_demo' THEN 'local_demo_zero'
      ELSE 'unknown'
    END AS cost_source,
    CASE
      WHEN route.role = 'local_private' THEN 'local_only'
      ELSE 'not_recorded'
    END AS privacy_policy,
    CASE
      WHEN usage.usage_source = 'local_demo'
        OR hub_connection.provider_kind = 'ollama'
        OR legacy_profile.provider = 'ollama'
      THEN 'local'
      ELSE 'not_recorded'
    END AS data_destination,
    CASE
      WHEN usage.attempt = run.attempt THEN run.failure_code
      ELSE 'AI_GENERATION_RETRY_ATTEMPT_FAILED'
    END AS error_code
  FROM ai_generation_attempt_usage AS usage
  JOIN ai_generation_runs AS run ON run.id = usage.run_id
  JOIN projects AS project ON project.id = run.project_id
  JOIN chapters AS chapter ON chapter.id = run.chapter_id
  LEFT JOIN ai_generation_route_selections AS route ON route.run_id = run.id
  LEFT JOIN model_provider_connections AS hub_connection ON hub_connection.id = run.provider_id
  LEFT JOIN model_profiles AS legacy_profile ON legacy_profile.provider_id = run.provider_id

  UNION ALL

  SELECT
    'hub:' || invocation.id AS event_id,
    'model_hub_invocation' AS source,
    COALESCE(invocation.completed_at, invocation.started_at, invocation.created_at) AS occurred_at,
    trace.project_id AS project_id,
    project.name AS project_name,
    trace.chapter_id AS chapter_id,
    chapter.title AS chapter_name,
    invocation.task AS task,
    invocation.connection_id AS provider_id,
    COALESCE(connection.display_name, '历史 AI 服务') AS provider_label,
    invocation.model_id_snapshot AS model_id,
    ${OPENING_INVOCATION_USAGE_STATUS_SQL} AS status,
    invocation.input_tokens AS input_tokens,
    invocation.output_tokens AS output_tokens,
    invocation.cached_input_tokens AS cached_input_tokens,
    invocation.estimated_cost_micros AS cost_micros,
    invocation.currency AS currency,
    CASE
      WHEN invocation.estimated_cost_micros IS NOT NULL THEN 'model_hub_usage_estimate'
      ELSE 'unknown'
    END AS cost_source,
    invocation.privacy_policy AS privacy_policy,
    invocation.data_destination AS data_destination,
    invocation.error_code AS error_code
  FROM model_invocation_facts AS invocation
  LEFT JOIN model_provider_connections AS connection ON connection.id = invocation.connection_id
  LEFT JOIN context_compilation_model_invocation_links AS invocation_link
    ON invocation_link.model_invocation_id = invocation.id
  LEFT JOIN context_compilation_runs AS trace ON trace.id = invocation_link.trace_id
  LEFT JOIN projects AS project ON project.id = trace.project_id
  LEFT JOIN chapters AS chapter ON chapter.id = trace.chapter_id
  WHERE invocation.task <> 'continuation'
)`;

function hydrateUsageEvent(row: UsageEventRow): UsageCenterEvent {
  const source =
    row.source === "generation_attempt"
      ? "generation_attempt"
      : row.source === "model_hub_invocation"
        ? "model_hub_invocation"
        : null;
  if (source === null) {
    throw corruptLedger("调用记录来源无效。");
  }
  const status = parseStatus(row.status);
  const privacyPolicy = parsePrivacyPolicy(row.privacy_policy);
  const dataDestination = parseDataDestination(row.data_destination);
  const costSource = parseCostSource(row.cost_source);
  const costMicros = validateNullableMicros(row.cost_micros, "调用费用");
  const currency = validateNullableCurrency(row.currency);
  if ((costMicros === null) !== (currency === null) && costSource !== "unknown") {
    throw corruptLedger("调用费用与币种记录不完整。");
  }
  if (costSource === "unknown" && costMicros !== null) {
    throw corruptLedger("未知费用来源不能包含金额。");
  }
  if (costSource !== "unknown" && costMicros === null) {
    throw corruptLedger("已计价调用缺少金额。");
  }
  return Object.freeze({
    id: row.event_id,
    source,
    occurredAt: validateTimestamp(row.occurred_at),
    projectId: row.project_id,
    projectName: row.project_name,
    chapterId: row.chapter_id,
    chapterName: row.chapter_name,
    task: validateRequiredText(row.task, "任务", 128),
    providerId: validateRequiredText(row.provider_id, "供应商", 128),
    providerLabel: validateRequiredText(row.provider_label, "供应商名称", 160),
    modelId: validateRequiredText(row.model_id, "模型", 512),
    status,
    inputTokens: validateNullableTokenCount(row.input_tokens),
    outputTokens: validateNullableTokenCount(row.output_tokens),
    cachedInputTokens: validateNullableTokenCount(row.cached_input_tokens),
    costMicros,
    currency,
    costSource,
    privacyPolicy,
    dataDestination,
    errorCode: row.error_code,
  });
}

function hydrateBudgetPolicy(row: BudgetPolicyRow): UsageBudgetPolicy {
  if (row.scope !== "month" && row.scope !== "project") {
    throw corruptLedger("预算范围无效。");
  }
  if (row.enforcement !== "warn" && row.enforcement !== "hard") {
    throw corruptLedger("预算执行方式无效。");
  }
  return Object.freeze({
    scopeKey: validateRequiredText(row.scope_key, "预算标识", 256),
    scope: row.scope,
    projectId: row.project_id,
    projectName: row.project_name,
    monthKey: row.month_key,
    currency: validateCurrency(row.currency),
    limitMicros: validateMicros(row.limit_micros, "预算上限"),
    enforcement: row.enforcement,
    updatedAt: validateTimestamp(row.updated_at),
  });
}

function matchesQuery(event: UsageCenterEvent, query: ValidatedUsageCenterQuery): boolean {
  return (
    (query.projectId === null || event.projectId === query.projectId) &&
    (query.task === null || event.task === query.task) &&
    (query.providerId === null || event.providerId === query.providerId) &&
    (query.modelId === null || event.modelId === query.modelId)
  );
}

function buildFacets(events: readonly UsageCenterEvent[]): UsageCenterFacets {
  return Object.freeze({
    projects: uniqueOptions(
      events.flatMap((event) =>
        event.projectId === null
          ? []
          : [{ value: event.projectId, label: event.projectName ?? event.projectId }],
      ),
    ),
    tasks: uniqueOptions(
      events.map((event) => ({ value: event.task, label: taskLabel(event.task) })),
    ),
    providers: uniqueOptions(
      events.map((event) => ({ value: event.providerId, label: event.providerLabel })),
    ),
    models: uniqueOptions(events.map((event) => ({ value: event.modelId, label: event.modelId }))),
  });
}

function uniqueOptions(options: readonly UsageFilterOption[]): readonly UsageFilterOption[] {
  const byValue = new Map<string, UsageFilterOption>();
  for (const option of options) {
    if (!byValue.has(option.value)) {
      byValue.set(option.value, Object.freeze(option));
    }
  }
  return Object.freeze(
    [...byValue.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label, "zh-CN") || left.value.localeCompare(right.value),
    ),
  );
}

function aggregateUsage(events: readonly UsageCenterEvent[]): UsageAggregate {
  let successCount = 0;
  let failureCount = 0;
  let cancelledCount = 0;
  let activeCount = 0;
  let localCount = 0;
  let remoteCount = 0;
  let destinationUnknownCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let tokenUsageUnknownCount = 0;
  let costUnknownCount = 0;
  const costs = new Map<string, { micros: bigint; invocationCount: number }>();

  for (const event of events) {
    if (event.status === "succeeded") successCount += 1;
    else if (event.status === "failed" || event.status === "ambiguous") failureCount += 1;
    else if (event.status === "cancelled" || event.status === "not_dispatched") cancelledCount += 1;
    else activeCount += 1;

    if (event.dataDestination === "local") localCount += 1;
    else if (event.dataDestination === "remote") remoteCount += 1;
    else destinationUnknownCount += 1;

    if (event.inputTokens === null || event.outputTokens === null) {
      tokenUsageUnknownCount += 1;
    } else {
      inputTokens = addSafeInteger(inputTokens, event.inputTokens, "输入 token 汇总");
      outputTokens = addSafeInteger(outputTokens, event.outputTokens, "输出 token 汇总");
      cachedInputTokens = addSafeInteger(
        cachedInputTokens,
        event.cachedInputTokens ?? 0,
        "缓存 token 汇总",
      );
    }

    if (event.costMicros === null || event.currency === null) {
      costUnknownCount += 1;
    } else {
      const current = costs.get(event.currency) ?? { micros: 0n, invocationCount: 0 };
      current.micros += BigInt(event.costMicros);
      current.invocationCount += 1;
      costs.set(event.currency, current);
    }
  }

  return Object.freeze({
    invocationCount: events.length,
    successCount,
    failureCount,
    cancelledCount,
    activeCount,
    localCount,
    remoteCount,
    destinationUnknownCount,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    tokenUsageUnknownCount,
    costTotals: Object.freeze(
      [...costs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, value]) =>
          Object.freeze({
            currency,
            micros: value.micros.toString(),
            invocationCount: value.invocationCount,
          }),
        ),
    ),
    costUnknownCount,
  });
}

function buildBreakdown(
  events: readonly UsageCenterEvent[],
  keyFor: (event: UsageCenterEvent) => string,
  labelFor: (key: string, event: UsageCenterEvent) => string,
  sort: "time" | "count",
): readonly UsageBreakdownEntry[] {
  const groups = new Map<string, { label: string; events: UsageCenterEvent[] }>();
  for (const event of events) {
    const key = keyFor(event);
    const group = groups.get(key) ?? { label: labelFor(key, event), events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.entries()]
      .map(([key, group]) =>
        Object.freeze({ key, label: group.label, ...aggregateUsage(group.events) }),
      )
      .sort((left, right) =>
        sort === "time"
          ? right.key.localeCompare(left.key)
          : right.invocationCount - left.invocationCount ||
            left.label.localeCompare(right.label, "zh-CN"),
      ),
  );
}

function localDateKey(timestamp: string, timezoneOffsetMinutes: number): string {
  const localTime = Date.parse(timestamp) - timezoneOffsetMinutes * 60_000;
  return new Date(localTime).toISOString().slice(0, 10);
}

function taskLabel(task: string): string {
  return TASK_LABELS[task] ?? "其他模型任务";
}

export const TASK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  capability_probe: "模型能力验证",
  idea_discussion: "灵感讨论",
  book_start_guidance: "开书引导",
  prose_generation: "正文生成",
  continuation: "续写",
  rewrite: "改写",
  polish: "润色",
  outline_planning: "大纲规划",
  scene_breakdown: "场景拆解",
  chapter_summary: "章节摘要",
  long_memory_compression: "长程记忆整理",
  character_extraction: "人物提取",
  world_extraction: "世界设定提取",
  contradiction_check: "矛盾检查",
  pov_check: "视角检查",
  character_voice_check: "人物声纹检查",
  content_quality_check: "内容质量检查",
  what_if_simulation: "剧情试演",
  embedding: "语义记忆",
  rerank: "资料重排",
  image_generation: "生成配图",
  vision_understanding: "图片理解",
  translation: "翻译",
});

function parseStatus(value: string): UsageEventStatus {
  if (
    [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "ambiguous",
      "not_dispatched",
    ].includes(value)
  ) {
    return value as UsageEventStatus;
  }
  throw corruptLedger("调用状态无效。");
}

function parsePrivacyPolicy(value: string): UsagePrivacyPolicy {
  if (["cloud_allowed", "local_preferred", "local_only", "not_recorded"].includes(value)) {
    return value as UsagePrivacyPolicy;
  }
  throw corruptLedger("调用隐私策略无效。");
}

function parseDataDestination(value: string): UsageDataDestination {
  if (["local", "remote", "not_recorded"].includes(value)) {
    return value as UsageDataDestination;
  }
  throw corruptLedger("调用去向无效。");
}

function parseCostSource(value: string): UsageCostSource {
  if (
    ["provider_usage_estimate", "model_hub_usage_estimate", "local_demo_zero", "unknown"].includes(
      value,
    )
  ) {
    return value as UsageCostSource;
  }
  throw corruptLedger("费用来源无效。");
}

function validateTimestamp(value: string): string {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw corruptLedger("调用时间无效。");
  }
  return value;
}

function validateRequiredText(value: string, field: string, maximumLength: number): string {
  if (value.length === 0 || value.length > maximumLength || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw corruptLedger(`${field}记录无效。`);
  }
  return value;
}

function validateNullableTokenCount(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw corruptLedger("Token 记录无效。");
  }
  return value;
}

function validateNullableMicros(value: string | null, field: string): string | null {
  return value === null ? null : validateMicros(value, field);
}

function validateMicros(value: string, field: string): string {
  if (!MICROS_PATTERN.test(value)) {
    throw corruptLedger(`${field}记录无效。`);
  }
  return value;
}

function validateNullableCurrency(value: string | null): string | null {
  return value === null ? null : validateCurrency(value);
}

function validateCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw corruptLedger("费用币种记录无效。");
  }
  return value;
}

function addSafeInteger(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw corruptLedger(`${field}超出安全范围。`);
  }
  return result;
}

function corruptLedger(message: string): UsageCenterError {
  return new UsageCenterError("USAGE_CENTER_LEDGER_INVALID", message);
}
