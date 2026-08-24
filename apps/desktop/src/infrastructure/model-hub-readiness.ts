import type { NovelAiTask } from "./model-hub-provider-registry";
import type { ModelCatalogEntry, ModelProviderConnection, NovelTaskRoute } from "./model-hub-store";

export const MODEL_HUB_READINESS_CHANGED_EVENT = "inkshadow:model-hub-readiness-changed";

/**
 * Catalog and capability evidence can expire without any store mutation. Keep
 * every long-lived readiness surface close to the exact dispatch resolver's
 * current-time decision instead of waiting for navigation or a manual retry.
 */
export const MODEL_HUB_READINESS_REFRESH_INTERVAL_MS = 30_000;

export const USER_FACING_MODEL_HUB_STATES = [
  "unconnected",
  "checking",
  "basic_ready",
  "fully_ready",
  "partially_unavailable",
  "connection_failed",
  "quota_insufficient",
] as const;

export type UserFacingModelHubState = (typeof USER_FACING_MODEL_HUB_STATES)[number];

export type ModelHubReadinessTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ModelHubReadinessProjection {
  readonly state: UserFacingModelHubState;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly tone: ModelHubReadinessTone;
  readonly enabledConnectionCount: number;
  readonly usableConnectionCount: number;
  readonly runnableCoreTaskCount: number;
  readonly totalCoreTaskCount: number;
  readonly missingCoreTasks: readonly NovelAiTask[];
  readonly exactBlockers: readonly ModelHubReadinessBlocker[];
}

export interface ModelHubReadinessBlocker {
  readonly task: NovelAiTask;
  readonly code: string;
}

export interface ProjectModelHubReadinessInput {
  readonly connections: readonly ModelProviderConnection[];
  readonly catalog: readonly ModelCatalogEntry[];
  readonly routes: readonly NovelTaskRoute[];
  readonly transientChecking?: boolean;
  readonly loadFailed?: boolean;
  /** Tasks rejected by the exact, no-dispatch resolver after the shallow store projection. */
  readonly exactBlockedTasks?: readonly NovelAiTask[];
  /** Safe blocker codes produced by the same resolver used before dispatch. */
  readonly exactBlockers?: readonly ModelHubReadinessBlocker[];
  readonly now?: string;
}

export const MODEL_HUB_STATE_EXPLANATIONS: Readonly<
  Record<UserFacingModelHubState, Readonly<{ label: string; description: string }>>
> = Object.freeze({
  unconnected: Object.freeze({
    label: "未连接",
    description: "先连接并测试一个模型，AI 才能参与创作。",
  }),
  checking: Object.freeze({
    label: "正在验证",
    description: "正在检查网络、凭据、模型目录和可用能力。",
  }),
  basic_ready: Object.freeze({
    label: "基础配置可用",
    description:
      "正文生成、续写、改写和润色所需的连接、模型与创作任务安排已通过基础检查；当前作品仍会在发送前单独检查隐私、参考资料和请求长度。",
  }),
  fully_ready: Object.freeze({
    label: "基础配置完整",
    description:
      "写作、续写、润色、长程记忆和核心检查的基础配置均已通过；每个章节在发送前仍会单独检查。",
  }),
  partially_unavailable: Object.freeze({
    label: "部分能力不可用",
    description:
      "部分任务的基础配置已通过；缺失任务会明确停止或使用已配置的备用模型，当前请求仍需单独检查。",
  }),
  connection_failed: Object.freeze({
    label: "连接失败",
    description: "请检查网络、接口密钥或本机模型服务后重试；正文和已保存版本不会丢失。",
  }),
  quota_insufficient: Object.freeze({
    label: "额度不足",
    description: "供应商报告余额、账单或额度问题；请充值、调整上限或切换模型。",
  }),
});

const BASIC_WRITING_TASKS: readonly NovelAiTask[] = Object.freeze([
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
]);

const COMPLETE_WRITING_TASKS: readonly NovelAiTask[] = Object.freeze([
  ...BASIC_WRITING_TASKS,
  "chapter_summary",
  "long_memory_compression",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
]);

export function modelHubReadinessBlockerLabel(code: string): string {
  if (code === "MODEL_HUB_CREDENTIAL_MISSING") return "接口密钥已删除或不可用";
  if (code === "MODEL_HUB_CONNECTION_NOT_READY") return "供应商连接尚未通过测试";
  if (code === "MODEL_HUB_CAPABILITY_NOT_VERIFIED") return "模型能力尚未完成验证";
  if (code === "MODEL_HUB_ROUTE_NOT_CONFIGURED") return "这项创作任务安排尚未配置";
  if (code === "MODEL_HUB_ROUTE_DISABLED") return "这项创作任务安排已停用";
  if (code === "MODEL_HUB_ROUTE_TARGET_MISSING") return "创作任务安排引用的模型已经不存在";
  if (code === "MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE") return "模型目录信息已失效或过期";
  if (code === "MODEL_HUB_CONTEXT_LIMIT_EXCEEDED") return "所选模型的上下文上限不足";
  if (code === "MODEL_CONTEXT_WINDOW_EXHAUSTED") {
    return "当前请求的输出长度与必要上下文超过模型窗口";
  }
  if (code === "MODEL_HUB_DATA_DESTINATION_UNKNOWN") {
    return "模型的数据去向与隐私信息尚未确认";
  }
  if (code.startsWith("MODEL_HUB_COST_")) return "费用信息或费用上限阻止本次发送";
  if (code === "MODEL_HUB_PRIVACY_BLOCKED" || code === "PRIVATE_CHAPTER_LOCAL_ONLY") {
    return "当前隐私规则不允许使用这个模型";
  }
  if (code === "MODEL_HUB_GATEWAY_UNAVAILABLE") return "当前环境不能使用已连接的模型";
  if (code === "STORY_CONTEXT_COMPILATION_FAILED") return "当前作品的上下文未能安全整理";
  return "基础配置检查尚未通过";
}

export function modelHubReadinessTaskLabel(task: string): string {
  const labels: Readonly<Record<string, string>> = Object.freeze({
    prose_generation: "正文生成",
    continuation: "续写",
    rewrite: "改写",
    polish: "润色",
    chapter_summary: "章节摘要",
    long_memory_compression: "长期记忆",
    contradiction_check: "矛盾检查",
    pov_check: "视角检查",
    character_voice_check: "人物说话一致性",
    content_quality_check: "内容质量复核",
  });
  return labels[task] ?? "当前 AI 任务";
}

export function projectModelHubReadiness(
  input: ProjectModelHubReadinessInput,
): ModelHubReadinessProjection {
  const enabledConnections = input.connections.filter(({ enabled }) => enabled);
  const now = normalizeNow(input.now);
  const exactBlockers = Object.freeze([
    ...(input.exactBlockers ?? []),
    ...(input.exactBlockedTasks ?? []).map((task) =>
      Object.freeze({ task, code: "MODEL_HUB_PREFLIGHT_FAILED" }),
    ),
  ]);
  const base = {
    enabledConnectionCount: enabledConnections.length,
    totalCoreTaskCount: COMPLETE_WRITING_TASKS.length,
    exactBlockers,
  } as const;

  if (
    input.transientChecking === true ||
    enabledConnections.some(
      ({ connectionStatus, catalogSyncStatus }) =>
        connectionStatus === "checking" || catalogSyncStatus === "syncing",
    )
  ) {
    return projection("checking", base, 0, 0, COMPLETE_WRITING_TASKS);
  }

  if (enabledConnections.length === 0 && input.loadFailed === true) {
    return projection("connection_failed", base, 0, 0, COMPLETE_WRITING_TASKS);
  }

  if (enabledConnections.length === 0) {
    return projection("unconnected", base, 0, 0, COMPLETE_WRITING_TASKS);
  }

  const usableConnections = enabledConnections.filter(
    ({ connectionStatus }) => connectionStatus === "ready" || connectionStatus === "degraded",
  );
  const usableConnectionIds = new Set(usableConnections.map(({ id }) => id));
  const healthyCatalogIds = new Set(
    input.catalog
      .filter(
        ({ connectionId, availability, lifecycle, staleAfter }) =>
          usableConnectionIds.has(connectionId) &&
          availability === "available" &&
          lifecycle !== "deprecated" &&
          (staleAfter === null || staleAfter > now),
      )
      .map(({ id }) => id),
  );
  const hasQuotaFailure = enabledConnections.some(hasQuotaOrBillingFailure);

  if (usableConnections.length === 0) {
    if (hasQuotaFailure) {
      return projection("quota_insufficient", base, 0, 0, COMPLETE_WRITING_TASKS);
    }
    const hasFailure =
      input.loadFailed === true ||
      enabledConnections.some(({ connectionStatus }) => connectionStatus === "error");
    return projection(
      hasFailure ? "connection_failed" : "unconnected",
      base,
      0,
      0,
      COMPLETE_WRITING_TASKS,
    );
  }

  const routeByTask = new Map(input.routes.map((route) => [route.task, route]));
  const exactBlockedTasks = new Set(exactBlockers.map(({ task }) => task));
  const runnableTasks: NovelAiTask[] = [];
  let usesFallback = false;
  for (const task of COMPLETE_WRITING_TASKS) {
    if (exactBlockedTasks.has(task)) continue;
    const route = routeByTask.get(task);
    if (!route?.enabled) continue;
    if (healthyCatalogIds.has(route.primaryCatalogEntryId)) {
      runnableTasks.push(task);
      continue;
    }
    if (
      route.failurePolicy === "use_fallback" &&
      route.fallbackCatalogEntryId !== null &&
      healthyCatalogIds.has(route.fallbackCatalogEntryId)
    ) {
      runnableTasks.push(task);
      usesFallback = true;
    }
  }

  const runnableSet = new Set(runnableTasks);
  const missingCoreTasks = COMPLETE_WRITING_TASKS.filter((task) => !runnableSet.has(task));
  const allBasicTasksRun = BASIC_WRITING_TASKS.every((task) => runnableSet.has(task));
  const allCompleteTasksRun = missingCoreTasks.length === 0;
  const connectionDegraded = usableConnections.some(
    ({ connectionStatus, catalogSyncStatus }) =>
      connectionStatus === "degraded" || catalogSyncStatus === "partial",
  );

  if (hasQuotaFailure && runnableTasks.length === 0) {
    return projection(
      "quota_insufficient",
      base,
      usableConnections.length,
      runnableTasks.length,
      missingCoreTasks,
    );
  }
  if (usesFallback || connectionDegraded || hasQuotaFailure) {
    return projection(
      "partially_unavailable",
      base,
      usableConnections.length,
      runnableTasks.length,
      missingCoreTasks,
    );
  }
  if (allCompleteTasksRun) {
    return projection(
      "fully_ready",
      base,
      usableConnections.length,
      runnableTasks.length,
      missingCoreTasks,
    );
  }
  if (allBasicTasksRun) {
    return projection(
      "basic_ready",
      base,
      usableConnections.length,
      runnableTasks.length,
      missingCoreTasks,
    );
  }
  return projection(
    "partially_unavailable",
    base,
    usableConnections.length,
    runnableTasks.length,
    missingCoreTasks,
  );
}

function projection(
  state: UserFacingModelHubState,
  base: Readonly<{
    enabledConnectionCount: number;
    totalCoreTaskCount: number;
    exactBlockers: readonly ModelHubReadinessBlocker[];
  }>,
  usableConnectionCount: number,
  runnableCoreTaskCount: number,
  missingCoreTasks: readonly NovelAiTask[],
): ModelHubReadinessProjection {
  const copy = MODEL_HUB_STATE_EXPLANATIONS[state];
  const taskSummary =
    state === "basic_ready" || state === "fully_ready" || state === "partially_unavailable"
      ? ` 当前 ${String(runnableCoreTaskCount)} / ${String(base.totalCoreTaskCount)} 类任务通过基础配置检查。`
      : "";
  return Object.freeze({
    state,
    label: copy.label,
    shortLabel:
      state === "fully_ready" || state === "basic_ready" ? "AI 基础连接可用" : `AI ${copy.label}`,
    description: `${copy.description}${taskSummary}`,
    tone: readinessTone(state),
    enabledConnectionCount: base.enabledConnectionCount,
    usableConnectionCount,
    runnableCoreTaskCount,
    totalCoreTaskCount: base.totalCoreTaskCount,
    missingCoreTasks: Object.freeze([...missingCoreTasks]),
    exactBlockers: Object.freeze([...base.exactBlockers]),
  });
}

function readinessTone(state: UserFacingModelHubState): ModelHubReadinessTone {
  if (state === "fully_ready" || state === "basic_ready") return "success";
  if (state === "checking") return "info";
  if (state === "connection_failed") return "danger";
  if (state === "partially_unavailable" || state === "quota_insufficient") return "warning";
  return "neutral";
}

function hasQuotaOrBillingFailure(connection: ModelProviderConnection): boolean {
  const evidence = `${connection.lastErrorCode ?? ""} ${connection.lastErrorSummary ?? ""}`;
  return /(?:quota|insufficient[_ -]?(?:balance|credit|funds)|billing|payment[_ -]?required|credit[_ -]?(?:exhausted|limit)|budget[_ -]?exceeded)/iu.test(
    evidence,
  );
}

function normalizeNow(value: string | undefined): string {
  if (value !== undefined && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}
