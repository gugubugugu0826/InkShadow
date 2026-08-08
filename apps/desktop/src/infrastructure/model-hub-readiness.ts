import type { NovelAiTask } from "./model-hub-provider-registry";
import type { ModelCatalogEntry, ModelProviderConnection, NovelTaskRoute } from "./model-hub-store";

export const MODEL_HUB_READINESS_CHANGED_EVENT = "inkshadow:model-hub-readiness-changed";

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
}

export interface ProjectModelHubReadinessInput {
  readonly connections: readonly ModelProviderConnection[];
  readonly catalog: readonly ModelCatalogEntry[];
  readonly routes: readonly NovelTaskRoute[];
  readonly transientChecking?: boolean;
  readonly loadFailed?: boolean;
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
    label: "基础写作可用",
    description: "正文生成、续写、改写和润色已经可用；长程回顾或深度检查可能尚未配置。",
  }),
  fully_ready: Object.freeze({
    label: "完整可用",
    description: "写作、续写、润色、长程记忆和核心检查都已有可运行的 AI 分工。",
  }),
  partially_unavailable: Object.freeze({
    label: "部分能力不可用",
    description: "已有连接仍可承担部分任务；缺失任务会明确停止或使用已配置的备用模型。",
  }),
  connection_failed: Object.freeze({
    label: "连接失败",
    description: "请检查网络、API Key 或本机模型服务后重试；正文和已保存版本不会丢失。",
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

export function projectModelHubReadiness(
  input: ProjectModelHubReadinessInput,
): ModelHubReadinessProjection {
  const enabledConnections = input.connections.filter(({ enabled }) => enabled);
  const now = normalizeNow(input.now);
  const base = {
    enabledConnectionCount: enabledConnections.length,
    totalCoreTaskCount: COMPLETE_WRITING_TASKS.length,
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
  const runnableTasks: NovelAiTask[] = [];
  let usesFallback = false;
  for (const task of COMPLETE_WRITING_TASKS) {
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
  base: Readonly<{ enabledConnectionCount: number; totalCoreTaskCount: number }>,
  usableConnectionCount: number,
  runnableCoreTaskCount: number,
  missingCoreTasks: readonly NovelAiTask[],
): ModelHubReadinessProjection {
  const copy = MODEL_HUB_STATE_EXPLANATIONS[state];
  const taskSummary =
    state === "basic_ready" || state === "fully_ready" || state === "partially_unavailable"
      ? ` 当前 ${String(runnableCoreTaskCount)} / ${String(base.totalCoreTaskCount)} 类核心任务可运行。`
      : "";
  return Object.freeze({
    state,
    label: copy.label,
    shortLabel:
      state === "fully_ready"
        ? "AI 写作已就绪"
        : state === "basic_ready"
          ? "AI 基础写作可用"
          : `AI ${copy.label}`,
    description: `${copy.description}${taskSummary}`,
    tone: readinessTone(state),
    enabledConnectionCount: base.enabledConnectionCount,
    usableConnectionCount,
    runnableCoreTaskCount,
    totalCoreTaskCount: base.totalCoreTaskCount,
    missingCoreTasks: Object.freeze([...missingCoreTasks]),
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
