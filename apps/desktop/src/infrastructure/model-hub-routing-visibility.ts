import {
  MODEL_HUB_CAPABILITIES,
  NOVEL_AI_TASKS,
  type ModelHubCapability,
  type NovelAiTask,
} from "./model-hub-provider-registry";
import {
  preferredCapabilitiesForNovelTask,
  requiredCapabilitiesForNovelTask,
} from "./model-hub-router";
import {
  modelHubReadinessBlockerLabel,
  type ModelHubReadinessBlocker,
} from "./model-hub-readiness";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelProviderConnection,
  NovelTaskRoute,
  RecentAiFailure,
} from "./model-hub-store";

export const MODEL_HUB_TASK_GROUPS = [
  "writing",
  "planning_memory",
  "review_simulation",
  "retrieval_media",
] as const;

export type ModelHubTaskGroup = (typeof MODEL_HUB_TASK_GROUPS)[number];

export type ModelHubOverallState =
  | "unconnected"
  | "validating"
  | "writing_ready"
  | "partial"
  | "complete"
  | "anomaly"
  | "save_failed";

export type ModelHubCapabilityDisplayState =
  | "verified"
  | "catalog_declared"
  | "user_confirmed"
  | "unknown"
  | "failed"
  | "ambiguous"
  | "unsupported";

export interface ModelHubTaskDefinition {
  readonly task: NovelAiTask;
  readonly displayName: string;
  readonly group: ModelHubTaskGroup;
  readonly description: string;
  readonly requiredCapabilities: readonly ModelHubCapability[];
  readonly optionalCapabilities: readonly ModelHubCapability[];
  readonly isCoreWritingTask: boolean;
  readonly impactWhenMissing: string;
  readonly degradedBehavior: string;
}

export interface ModelHubCapabilityProjection {
  readonly capability: ModelHubCapability;
  readonly state: ModelHubCapabilityDisplayState;
  readonly source: ModelCapabilityEvidence["evidenceSource"] | null;
  readonly observedAt: string | null;
  readonly failureCode: string | null;
}

export interface ModelHubModelProjection {
  readonly catalogEntry: ModelCatalogEntry;
  readonly connection: ModelProviderConnection;
  readonly connectionUsable: boolean;
  readonly capabilities: readonly ModelHubCapabilityProjection[];
  readonly lastVerifiedAt: string | null;
  readonly latestProbeFailureCode: string | null;
}

export interface ModelHubTaskProjection {
  readonly definition: ModelHubTaskDefinition;
  readonly route: NovelTaskRoute | null;
  readonly primaryModel: ModelCatalogEntry | null;
  readonly fallbackModel: ModelCatalogEntry | null;
  readonly status: "configured" | "missing" | "failed";
  readonly missingCapabilities: readonly ModelHubCapability[];
  readonly reason: string;
  readonly nextStep: string;
  readonly lastVerifiedAt: string | null;
}

export interface ModelHubMissingCapabilityProjection {
  readonly capability: ModelHubCapability;
  readonly tasks: readonly NovelAiTask[];
  readonly core: boolean;
  readonly blocksBasicWriting: boolean;
  readonly degradedBehavior: string;
}

export interface ModelHubRoutingVisibility {
  readonly state: ModelHubOverallState;
  readonly registryTaskCount: number;
  readonly enabledRouteCount: number;
  readonly missingRouteCount: number;
  readonly manuallyConfiguredCount: number;
  readonly automaticallyConfiguredCount: number;
  readonly legacyConfiguredCount: number;
  readonly coreWritingReady: boolean;
  readonly tasks: readonly ModelHubTaskProjection[];
  readonly models: readonly ModelHubModelProjection[];
  readonly missingCapabilities: readonly ModelHubMissingCapabilityProjection[];
}

export interface BuildModelHubRoutingVisibilityInput {
  readonly connections: readonly ModelProviderConnection[];
  readonly catalog: readonly ModelCatalogEntry[];
  readonly routes: readonly NovelTaskRoute[];
  readonly capabilityEvidence: readonly ModelCapabilityEvidence[];
  readonly recentAiFailures: readonly RecentAiFailure[];
  readonly now: string;
  readonly validating: boolean;
  readonly loadFailed: boolean;
  readonly saveFailed: boolean;
  /** Safe blockers from the exact no-dispatch resolver used by generation. */
  readonly exactBlockers?: readonly ModelHubReadinessBlocker[];
}

export interface AiRoutingDiagnosticSummary {
  readonly registryTaskCount: number;
  readonly enabledRouteCount: number;
  readonly missingRouteCount: number;
  readonly manuallyConfiguredCount: number;
  readonly automaticallyConfiguredCount: number;
  readonly coreWritingReady: boolean;
  readonly missingCapabilities: readonly ModelHubCapability[];
}

const TASK_GROUP_BY_TASK: Readonly<Record<NovelAiTask, ModelHubTaskGroup>> = Object.freeze({
  idea_discussion: "writing",
  book_start_guidance: "writing",
  prose_generation: "writing",
  continuation: "writing",
  rewrite: "writing",
  polish: "writing",
  outline_planning: "planning_memory",
  scene_breakdown: "planning_memory",
  chapter_summary: "planning_memory",
  long_memory_compression: "planning_memory",
  character_extraction: "planning_memory",
  world_extraction: "planning_memory",
  contradiction_check: "review_simulation",
  pov_check: "review_simulation",
  character_voice_check: "review_simulation",
  content_quality_check: "review_simulation",
  what_if_simulation: "review_simulation",
  embedding: "retrieval_media",
  rerank: "retrieval_media",
  image_generation: "retrieval_media",
  vision_understanding: "retrieval_media",
  translation: "retrieval_media",
});

const TASK_DISPLAY_NAME: Readonly<Record<NovelAiTask, string>> = Object.freeze({
  idea_discussion: "灵感讨论",
  book_start_guidance: "开书引导",
  prose_generation: "正文生成",
  continuation: "续写",
  rewrite: "改写",
  polish: "润色",
  outline_planning: "大纲规划",
  scene_breakdown: "场景拆解",
  chapter_summary: "章节摘要",
  long_memory_compression: "长期记忆压缩",
  character_extraction: "人物提取",
  world_extraction: "世界设定提取",
  contradiction_check: "矛盾检查",
  pov_check: "视角边界检查",
  character_voice_check: "人物说话一致性",
  content_quality_check: "深度复核",
  what_if_simulation: "剧情试演",
  embedding: "语义记忆",
  rerank: "检索精排",
  image_generation: "小说配图",
  vision_understanding: "图片理解",
  translation: "翻译",
});

const CORE_WRITING_TASKS = new Set<NovelAiTask>([
  "idea_discussion",
  "book_start_guidance",
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
]);

const TASK_DESCRIPTION: Readonly<Record<NovelAiTask, string>> = Object.freeze({
  idea_discussion: "围绕灵感快速讨论方向。",
  book_start_guidance: "把一句想法整理成可继续创作的开头。",
  prose_generation: "生成新的小说正文候选。",
  continuation: "依据当前正文继续下一段或下一场景。",
  rewrite: "按明确目标生成隔离的改写版本。",
  polish: "在不改变主要情节的前提下润色文字。",
  outline_planning: "规划故事方向和章节大纲。",
  scene_breakdown: "把章节目标拆成可执行场景。",
  chapter_summary: "提炼章节摘要供后续写作参考。",
  long_memory_compression: "压缩长篇信息，控制上下文长度。",
  character_extraction: "从正文识别人物候选设定。",
  world_extraction: "从正文识别世界规则候选。",
  contradiction_check: "查找有证据的事实冲突。",
  pov_check: "检查视角人物是否知道不该知道的信息。",
  character_voice_check: "检查人物说话方式是否明显漂移。",
  content_quality_check: "综合复核内容质量和结构问题。",
  what_if_simulation: "试演另一条剧情及其连锁影响。",
  embedding: "建立跨章节语义召回索引。",
  rerank: "对检索到的故事资料再次排序。",
  image_generation: "生成小说封面、角色或场景配图。",
  vision_understanding: "理解用户提供的图片内容。",
  translation: "在语言之间转换小说内容。",
});

const TASK_MISSING_IMPACT: Readonly<Record<NovelAiTask, string>> = Object.freeze({
  idea_discussion: "不能使用 AI 讨论灵感，但仍可手动记录想法。",
  book_start_guidance: "不能用一句话生成开头，但仍可手动创建作品。",
  prose_generation: "不能生成新的正文候选，手动写作不受影响。",
  continuation: "不能由 AI 自动续写，已有正文和手动输入不受影响。",
  rewrite: "不能生成改写候选，原文不会受影响。",
  polish: "不能生成润色候选，原文不会受影响。",
  outline_planning: "不能自动规划大纲，仍可手动编辑规划。",
  scene_breakdown: "不能自动拆解场景，仍可手动添加场景。",
  chapter_summary: "不会自动生成章节摘要，正文仍可正常保存。",
  long_memory_compression: "长篇上下文压缩不可用，系统会使用较短的最近内容。",
  character_extraction: "不会自动提出人物设定候选，仍可手动维护人物。",
  world_extraction: "不会自动提出世界规则候选，仍可手动维护规则。",
  contradiction_check: "不能执行 AI 模糊矛盾复核，确定性检查仍可继续。",
  pov_check: "不能执行 AI 视角边界复核，手动检查不受影响。",
  character_voice_check: "不能执行人物声纹复核，正文创作不受影响。",
  content_quality_check: "不能执行深度复核，基础写作仍可继续。",
  what_if_simulation: "不能试演另一条剧情，不影响当前正式剧情。",
  embedding: "跨章节语义召回不可用，继续使用最近正文和关键词检索。",
  rerank: "检索结果不会二次精排，继续使用本地确定性排序。",
  image_generation: "不能生成小说配图，不影响文字写作。",
  vision_understanding: "不能理解图片，不影响纯文字创作。",
  translation: "不能自动翻译，不影响原语言写作。",
});

const SOURCE_PRIORITY: Readonly<Record<ModelCapabilityEvidence["evidenceSource"], number>> =
  Object.freeze({
    user_confirmed: 5,
    lightweight_probe: 4,
    provider_metadata: 3,
    official_preset: 2,
    legacy: 1,
  });

export const MODEL_HUB_TASK_REGISTRY: readonly ModelHubTaskDefinition[] = Object.freeze(
  NOVEL_AI_TASKS.map((task) =>
    Object.freeze({
      task,
      displayName: TASK_DISPLAY_NAME[task],
      group: TASK_GROUP_BY_TASK[task],
      description: TASK_DESCRIPTION[task],
      requiredCapabilities: requiredCapabilitiesForNovelTask(task),
      optionalCapabilities: preferredCapabilitiesForNovelTask(task),
      isCoreWritingTask: CORE_WRITING_TASKS.has(task),
      impactWhenMissing: TASK_MISSING_IMPACT[task],
      degradedBehavior: TASK_MISSING_IMPACT[task],
    }),
  ),
);

export function buildModelHubRoutingVisibility(
  input: BuildModelHubRoutingVisibilityInput,
): ModelHubRoutingVisibility {
  const usableConnections = new Map(
    input.connections
      .filter(
        ({ enabled, connectionStatus }) =>
          enabled && (connectionStatus === "ready" || connectionStatus === "degraded"),
      )
      .map((connection) => [connection.id, connection] as const),
  );
  const enabledConnections = new Map(
    input.connections
      .filter(({ enabled }) => enabled)
      .map((connection) => [connection.id, connection]),
  );
  const catalogById = new Map(input.catalog.map((entry) => [entry.id, entry] as const));
  const modelProjections = input.catalog.flatMap((entry) => {
    const connection = enabledConnections.get(entry.connectionId);
    if (connection === undefined || entry.availability !== "available") return [];
    return [projectModel(input, connection, entry, usableConnections.has(connection.id))];
  });
  const modelByCatalogId = new Map(
    modelProjections.map((model) => [model.catalogEntry.id, model] as const),
  );
  const enabledRoutes = input.routes.filter(({ enabled }) => enabled);
  const routeByTask = new Map(enabledRoutes.map((route) => [route.task, route] as const));
  const exactBlockerByTask = new Map(
    (input.exactBlockers ?? []).map((blocker) => [blocker.task, blocker] as const),
  );
  const taskProjections = MODEL_HUB_TASK_REGISTRY.map((definition) => {
    const route = routeByTask.get(definition.task) ?? null;
    if (route === null) {
      const missingCapabilities = definition.requiredCapabilities.filter(
        (capability) => !modelProjections.some((model) => supports(model, capability)),
      );
      return Object.freeze({
        definition,
        route: null,
        primaryModel: null,
        fallbackModel: null,
        status: "missing" as const,
        missingCapabilities: Object.freeze(missingCapabilities),
        reason:
          missingCapabilities.length === 0
            ? "已有模型能力，但这项任务尚未分配模型。"
            : `当前没有模型提供所需的${missingCapabilities.map(capabilityLabel).join("、")}能力。`,
        nextStep:
          missingCapabilities.length === 0
            ? "重新应用 AI 分工，或在专家模式中为这一项选择模型。"
            : `连接并验证支持${missingCapabilities.map(capabilityLabel).join("、")}的模型。`,
        lastVerifiedAt: null,
      });
    }

    const primaryModel = catalogById.get(route.primaryCatalogEntryId) ?? null;
    const fallbackModel =
      route.fallbackCatalogEntryId === null
        ? null
        : (catalogById.get(route.fallbackCatalogEntryId) ?? null);
    const primaryProjection = modelByCatalogId.get(route.primaryCatalogEntryId);
    const missingCapabilities = definition.requiredCapabilities.filter(
      (capability) => primaryProjection === undefined || !supports(primaryProjection, capability),
    );
    const exactBlocker = exactBlockerByTask.get(definition.task);
    const failed =
      exactBlocker !== undefined ||
      primaryProjection === undefined ||
      missingCapabilities.length > 0;
    return Object.freeze({
      definition,
      route,
      primaryModel,
      fallbackModel,
      status: failed ? ("failed" as const) : ("configured" as const),
      missingCapabilities: Object.freeze(missingCapabilities),
      reason: failed
        ? exactBlocker !== undefined
          ? `基础配置检查未通过：${modelHubReadinessBlockerLabel(exactBlocker.code)}。`
          : primaryModel === null
            ? "已保存的主模型已不在当前模型目录中。"
            : primaryProjection === undefined
              ? "已保存的主模型当前未连接或不可用。"
              : `主模型缺少有效的${missingCapabilities.map(capabilityLabel).join("、")}能力证据。`
        : "任务已分配给当前可用且能力匹配的模型。",
      nextStep: failed
        ? exactBlocker !== undefined
          ? "前往“连接与模型”修复后重新验证；不要通过重复生成绕过确定性错误。"
          : "检查连接和能力验证，或在专家模式中重新选择这一项的模型。"
        : "无需操作。",
      lastVerifiedAt: primaryProjection?.lastVerifiedAt ?? null,
    });
  });

  const coreWritingReady = taskProjections
    .filter(({ definition }) => definition.isCoreWritingTask)
    .every(({ status }) => status === "configured");
  const missingCapabilities = buildMissingCapabilityProjection(taskProjections);
  const enabledRouteCount = enabledRoutes.length;
  const hasUsableConnection = usableConnections.size > 0;
  const hasFailedRoute = taskProjections.some(({ status }) => status === "failed");
  const state: ModelHubOverallState = input.saveFailed
    ? "save_failed"
    : input.validating
      ? "validating"
      : input.loadFailed || (!hasUsableConnection && input.connections.length > 0) || hasFailedRoute
        ? "anomaly"
        : input.connections.length === 0
          ? "unconnected"
          : enabledRouteCount === NOVEL_AI_TASKS.length
            ? "complete"
            : coreWritingReady
              ? "writing_ready"
              : enabledRouteCount > 0
                ? "partial"
                : "partial";

  return Object.freeze({
    state,
    registryTaskCount: NOVEL_AI_TASKS.length,
    enabledRouteCount,
    missingRouteCount: NOVEL_AI_TASKS.length - enabledRouteCount,
    manuallyConfiguredCount: enabledRoutes.filter(({ routeOrigin }) => routeOrigin === "user")
      .length,
    automaticallyConfiguredCount: enabledRoutes.filter(
      ({ routeOrigin }) => routeOrigin === "automatic",
    ).length,
    legacyConfiguredCount: enabledRoutes.filter(({ routeOrigin }) => routeOrigin === "legacy")
      .length,
    coreWritingReady,
    tasks: Object.freeze(taskProjections),
    models: Object.freeze(modelProjections),
    missingCapabilities,
  });
}

export function toAiRoutingDiagnosticSummary(
  visibility: ModelHubRoutingVisibility,
): AiRoutingDiagnosticSummary {
  return Object.freeze({
    registryTaskCount: visibility.registryTaskCount,
    enabledRouteCount: visibility.enabledRouteCount,
    missingRouteCount: visibility.missingRouteCount,
    manuallyConfiguredCount: visibility.manuallyConfiguredCount,
    automaticallyConfiguredCount: visibility.automaticallyConfiguredCount,
    coreWritingReady: visibility.coreWritingReady,
    missingCapabilities: Object.freeze(
      visibility.missingCapabilities.map(({ capability }) => capability),
    ),
  });
}

export function modelHubTaskGroupLabel(group: ModelHubTaskGroup): string {
  const labels: Readonly<Record<ModelHubTaskGroup, string>> = Object.freeze({
    writing: "写作",
    planning_memory: "规划与记忆",
    review_simulation: "检查与推演",
    retrieval_media: "检索与素材",
  });
  return labels[group];
}

export function capabilityLabel(capability: ModelHubCapability): string {
  const labels: Readonly<Record<ModelHubCapability, string>> = Object.freeze({
    text_generation: "文本生成",
    reasoning: "推理",
    structured_output: "结构化输出",
    embedding: "语义向量",
    rerank: "结果重排",
    image_generation: "图片生成",
    vision: "图片理解",
    translation: "翻译",
    tool_calling: "工具调用",
    token_counting: "Token 计数",
    streaming: "流式输出",
    long_context: "长上下文",
  });
  return labels[capability];
}

function projectModel(
  input: BuildModelHubRoutingVisibilityInput,
  connection: ModelProviderConnection,
  catalogEntry: ModelCatalogEntry,
  connectionUsable: boolean,
): ModelHubModelProjection {
  const relevantEvidence = input.capabilityEvidence.filter(
    (evidence) => evidence.catalogEntryId === catalogEntry.id,
  );
  const latestProbeFailure = input.recentAiFailures
    .filter(
      (failure) =>
        failure.taskType === "capability_probe" &&
        failure.connectionId === connection.id &&
        failure.modelId === catalogEntry.providerModelId,
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
  const capabilities = MODEL_HUB_CAPABILITIES.map((capability) => {
    const evidence = selectEvidence(relevantEvidence, capability, input.now);
    // Scan timestamps have millisecond precision. When success evidence and a
    // failure tie, their order is not provable, so the ordinary view must fail
    // closed instead of presenting the model as verified.
    const failedAfterEvidence =
      capability === "text_generation" &&
      latestProbeFailure !== undefined &&
      (evidence === null || latestProbeFailure.timestamp >= evidence.observedAt);
    if (failedAfterEvidence) {
      return Object.freeze({
        capability,
        state:
          latestProbeFailure.normalizedErrorCode === "PROVIDER_RESULT_AMBIGUOUS"
            ? ("ambiguous" as const)
            : ("failed" as const),
        source: "lightweight_probe" as const,
        observedAt: latestProbeFailure.timestamp,
        failureCode: latestProbeFailure.normalizedErrorCode,
      });
    }
    if (evidence === null || evidence.verdict === "unknown") {
      return Object.freeze({
        capability,
        state: "unknown" as const,
        source: evidence?.evidenceSource ?? null,
        observedAt: evidence?.observedAt ?? null,
        failureCode: null,
      });
    }
    if (evidence.verdict === "unsupported") {
      return Object.freeze({
        capability,
        state: "unsupported" as const,
        source: evidence.evidenceSource,
        observedAt: evidence.observedAt,
        failureCode: null,
      });
    }
    const state: ModelHubCapabilityDisplayState =
      evidence.evidenceSource === "lightweight_probe"
        ? "verified"
        : evidence.evidenceSource === "user_confirmed"
          ? "user_confirmed"
          : "catalog_declared";
    return Object.freeze({
      capability,
      state,
      source: evidence.evidenceSource,
      observedAt: evidence.observedAt,
      failureCode: null,
    });
  });
  const observedTimes = capabilities.flatMap(({ observedAt }) =>
    observedAt === null ? [] : [observedAt],
  );
  return Object.freeze({
    catalogEntry,
    connection,
    connectionUsable,
    capabilities: Object.freeze(capabilities),
    lastVerifiedAt:
      observedTimes.length === 0
        ? connection.lastTestedAt
        : (observedTimes.sort((left, right) => right.localeCompare(left))[0] ?? null),
    latestProbeFailureCode:
      capabilities.find(({ capability }) => capability === "text_generation")?.state === "failed" ||
      capabilities.find(({ capability }) => capability === "text_generation")?.state === "ambiguous"
        ? (latestProbeFailure?.normalizedErrorCode ?? null)
        : null,
  });
}

function supports(model: ModelHubModelProjection, capability: ModelHubCapability): boolean {
  if (!model.connectionUsable) return false;
  const state = model.capabilities.find((candidate) => candidate.capability === capability)?.state;
  if (capability === "structured_output") {
    return state === "verified" || state === "user_confirmed";
  }
  return state === "verified" || state === "catalog_declared" || state === "user_confirmed";
}

function selectEvidence(
  evidence: readonly ModelCapabilityEvidence[],
  capability: ModelHubCapability,
  now: string,
): ModelCapabilityEvidence | null {
  return (
    evidence
      .filter(
        (candidate) =>
          candidate.capability === capability &&
          (candidate.expiresAt === null || candidate.expiresAt > now),
      )
      .sort(
        (left, right) =>
          SOURCE_PRIORITY[right.evidenceSource] - SOURCE_PRIORITY[left.evidenceSource] ||
          right.observedAt.localeCompare(left.observedAt) ||
          left.id.localeCompare(right.id),
      )[0] ?? null
  );
}

function buildMissingCapabilityProjection(
  tasks: readonly ModelHubTaskProjection[],
): readonly ModelHubMissingCapabilityProjection[] {
  return Object.freeze(
    MODEL_HUB_CAPABILITIES.flatMap((capability) => {
      const affected = tasks.filter(
        ({ status, missingCapabilities }) =>
          status !== "configured" && missingCapabilities.includes(capability),
      );
      if (affected.length === 0) return [];
      const core = affected.some(({ definition }) => definition.isCoreWritingTask);
      return [
        Object.freeze({
          capability,
          tasks: Object.freeze(affected.map(({ definition }) => definition.task)),
          core,
          blocksBasicWriting: core,
          degradedBehavior: affected.map(({ definition }) => definition.degradedBehavior)[0] ?? "",
        }),
      ];
    }),
  );
}
