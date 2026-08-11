import { MODEL_ROUTE_ROLES, type ModelRouteRole } from "@inkshadow/ai-core";

import {
  NOVEL_AI_TASKS,
  isLoopbackModelBaseUrl,
  type ModelHubCapability,
  type ModelHubScheme,
  type NovelAiTask,
} from "./model-hub-provider-registry";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelEvaluationResult,
  ModelHubPrivacyPolicy,
  ModelProviderConnection,
  NovelTaskRoute,
} from "./model-hub-store";

export type AutomaticModelHubScheme = Exclude<ModelHubScheme, "custom">;

export interface ModelHubRoutingCandidate {
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly capabilities: readonly ModelCapabilityEvidence[];
  readonly costPrivacy: ModelCostPrivacyProfile | null;
  readonly evaluations: readonly ModelEvaluationResult[];
}

export interface PlannedNovelTaskRoute {
  readonly task: NovelAiTask;
  readonly primaryCatalogEntryId: string;
  readonly primaryConnectionId: string;
  readonly fallbackCatalogEntryId: string | null;
  readonly fallbackConnectionId: string | null;
  readonly parameterPolicy: Readonly<Record<string, never>>;
  readonly maximumCostMicros: null;
  readonly currency: null;
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly failurePolicy: NovelTaskRoute["failurePolicy"];
  readonly routeOrigin: "automatic";
  readonly enabled: true;
}

export interface ModelHubRoutingPlan {
  readonly scheme: AutomaticModelHubScheme;
  readonly routes: readonly PlannedNovelTaskRoute[];
  readonly unroutableTasks: readonly NovelAiTask[];
}

export interface BuildModelHubRoutingPlanInput {
  readonly scheme: AutomaticModelHubScheme;
  readonly candidates: readonly ModelHubRoutingCandidate[];
  readonly now: string;
  readonly tasks?: readonly NovelAiTask[];
}

export interface PlannedLegacyRoleRoute {
  readonly role: ModelRouteRole;
  readonly primaryConnectionId: string;
  readonly primaryModelId: string;
  readonly fallbackConnectionId: string | null;
  readonly fallbackModelId: string | null;
}

export interface LegacyCompatibilityPlan {
  readonly routes: readonly PlannedLegacyRoleRoute[];
  readonly rolesToClear: readonly ModelRouteRole[];
}

const TASK_REQUIRED_CAPABILITIES: Readonly<Record<NovelAiTask, readonly ModelHubCapability[]>> =
  Object.freeze({
    idea_discussion: ["text_generation"],
    book_start_guidance: ["text_generation"],
    prose_generation: ["text_generation"],
    continuation: ["text_generation"],
    rewrite: ["text_generation"],
    polish: ["text_generation"],
    outline_planning: ["text_generation"],
    scene_breakdown: ["text_generation"],
    chapter_summary: ["text_generation"],
    long_memory_compression: ["text_generation"],
    character_extraction: ["text_generation"],
    world_extraction: ["text_generation"],
    contradiction_check: ["text_generation"],
    pov_check: ["text_generation"],
    character_voice_check: ["text_generation"],
    content_quality_check: ["text_generation"],
    what_if_simulation: ["text_generation", "structured_output"],
    embedding: ["embedding"],
    rerank: ["rerank"],
    image_generation: ["image_generation"],
    vision_understanding: ["vision"],
    translation: ["translation"],
  });

const TASK_PREFERRED_CAPABILITIES: Readonly<Record<NovelAiTask, readonly ModelHubCapability[]>> =
  Object.freeze({
    idea_discussion: ["streaming"],
    book_start_guidance: ["reasoning", "structured_output"],
    prose_generation: ["long_context", "streaming"],
    continuation: ["long_context", "streaming"],
    rewrite: ["long_context"],
    polish: ["long_context"],
    outline_planning: ["reasoning", "structured_output"],
    scene_breakdown: ["reasoning", "structured_output"],
    chapter_summary: ["long_context", "structured_output"],
    long_memory_compression: ["long_context", "structured_output"],
    character_extraction: ["structured_output", "long_context"],
    world_extraction: ["structured_output", "long_context"],
    contradiction_check: ["reasoning", "structured_output", "long_context"],
    pov_check: ["reasoning", "structured_output", "long_context"],
    character_voice_check: ["reasoning", "long_context"],
    content_quality_check: ["reasoning", "structured_output", "long_context"],
    what_if_simulation: ["reasoning", "long_context"],
    embedding: ["token_counting"],
    rerank: ["long_context"],
    image_generation: [],
    vision_understanding: ["reasoning", "structured_output"],
    translation: ["long_context"],
  });

const QUALITY_FIRST_TASKS = new Set<NovelAiTask>([
  "book_start_guidance",
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "outline_planning",
  "scene_breakdown",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
  "what_if_simulation",
  "image_generation",
  "vision_understanding",
]);

const LEGACY_ROLE_TASK: Readonly<Record<ModelRouteRole, NovelAiTask>> = Object.freeze({
  fast: "idea_discussion",
  high_quality: "prose_generation",
  long_context: "long_memory_compression",
  embedding: "embedding",
  validation: "contradiction_check",
  translation: "translation",
  local_private: "prose_generation",
});

const CAPABILITY_SOURCE_PRIORITY: Readonly<
  Record<ModelCapabilityEvidence["evidenceSource"], number>
> = Object.freeze({
  user_confirmed: 5,
  lightweight_probe: 4,
  provider_metadata: 3,
  official_preset: 2,
  legacy: 1,
});

const EVALUATION_SOURCE_PRIORITY: Readonly<
  Record<ModelEvaluationResult["evaluationSource"], number>
> = Object.freeze({
  user_feedback: 5,
  local_evaluation: 4,
  official_benchmark: 3,
  imported: 2,
  legacy: 1,
});

export function buildModelHubRoutingPlan(
  input: BuildModelHubRoutingPlanInput,
): ModelHubRoutingPlan {
  const now = normalizeTimestamp(input.now);
  const tasks = Object.freeze([...(input.tasks ?? NOVEL_AI_TASKS)]);
  const activeCandidates = input.candidates.filter(
    ({ connection, catalogEntry }) =>
      connection.enabled &&
      (connection.connectionStatus === "ready" || connection.connectionStatus === "degraded") &&
      catalogEntry.connectionId === connection.id &&
      catalogEntry.availability === "available" &&
      catalogEntry.lifecycle !== "deprecated" &&
      (catalogEntry.staleAfter === null || catalogEntry.staleAfter > now),
  );
  const routes: PlannedNovelTaskRoute[] = [];
  const unroutableTasks: NovelAiTask[] = [];

  for (const task of tasks) {
    const eligible = activeCandidates.filter(
      (candidate) =>
        requiredCapabilitiesForNovelTask(task).every(
          (capability) =>
            resolveModelCapabilityVerdict({
              catalogEntryId: candidate.catalogEntry.id,
              capability,
              evidence: candidate.capabilities,
              now,
            }) === "supported",
        ) &&
        (input.scheme !== "local_privacy" ||
          (candidate.costPrivacy?.dataDestination === "local" &&
            candidate.costPrivacy.evidenceSource !== "unknown" &&
            isLoopbackModelBaseUrl(candidate.connection.baseUrl))),
    );
    eligible.sort(candidateComparator(input.scheme, task, now));
    const primary = eligible[0];
    if (primary === undefined) {
      unroutableTasks.push(task);
      continue;
    }
    const fallback =
      eligible.find((candidate) => candidate.connection.id !== primary.connection.id) ??
      eligible[1];
    const privacyPolicy: ModelHubPrivacyPolicy =
      input.scheme === "local_privacy" ? "local_only" : "cloud_allowed";
    routes.push(
      Object.freeze({
        task,
        primaryCatalogEntryId: primary.catalogEntry.id,
        primaryConnectionId: primary.connection.id,
        fallbackCatalogEntryId: fallback?.catalogEntry.id ?? null,
        fallbackConnectionId: fallback?.connection.id ?? null,
        // Provider-specific defaults are applied at invocation time. In
        // particular, this never leaks the legacy 0.8 temperature to Claude.
        parameterPolicy: Object.freeze({}),
        maximumCostMicros: null,
        currency: null,
        privacyPolicy,
        failurePolicy:
          fallback === undefined
            ? input.scheme === "local_privacy"
              ? "stop"
              : "ask_user"
            : "use_fallback",
        routeOrigin: "automatic",
        enabled: true,
      }),
    );
  }

  return Object.freeze({
    scheme: input.scheme,
    routes: Object.freeze(routes),
    unroutableTasks: Object.freeze(unroutableTasks),
  });
}

export function buildLegacyCompatibilityPlan(
  plan: ModelHubRoutingPlan,
  candidates: readonly ModelHubRoutingCandidate[],
  now: string,
): LegacyCompatibilityPlan {
  const byTask = new Map(plan.routes.map((route) => [route.task, route]));
  const localPrivate = buildModelHubRoutingPlan({
    scheme: "local_privacy",
    candidates,
    now,
    tasks: ["prose_generation"],
  }).routes[0];
  const routes: PlannedLegacyRoleRoute[] = [];
  const rolesToClear: ModelRouteRole[] = [];
  const catalogById = new Map(
    candidates.map(({ catalogEntry }) => [catalogEntry.id, catalogEntry] as const),
  );

  for (const role of MODEL_ROUTE_ROLES) {
    const source = role === "local_private" ? localPrivate : byTask.get(LEGACY_ROLE_TASK[role]);
    if (source === undefined) {
      rolesToClear.push(role);
      continue;
    }
    const primaryCatalog = catalogById.get(source.primaryCatalogEntryId);
    const fallbackCatalog =
      source.fallbackCatalogEntryId === null
        ? null
        : catalogById.get(source.fallbackCatalogEntryId);
    if (
      primaryCatalog === undefined ||
      (source.fallbackCatalogEntryId !== null && fallbackCatalog === undefined)
    ) {
      rolesToClear.push(role);
      continue;
    }
    routes.push(
      Object.freeze({
        role,
        primaryConnectionId: source.primaryConnectionId,
        primaryModelId: primaryCatalog.providerModelId,
        fallbackConnectionId: source.fallbackConnectionId,
        fallbackModelId: fallbackCatalog?.providerModelId ?? null,
      }),
    );
  }

  return Object.freeze({
    routes: Object.freeze(routes),
    rolesToClear: Object.freeze(rolesToClear),
  });
}

function candidateComparator(
  scheme: AutomaticModelHubScheme,
  task: NovelAiTask,
  now: string,
): (left: ModelHubRoutingCandidate, right: ModelHubRoutingCandidate) => number {
  if (scheme === "economy" || (scheme === "smart" && !QUALITY_FIRST_TASKS.has(task))) {
    return (left, right) => compareEconomy(left, right, task, now);
  }
  return (left, right) => compareQuality(left, right, task, now);
}

function compareQuality(
  left: ModelHubRoutingCandidate,
  right: ModelHubRoutingCandidate,
  task: NovelAiTask,
  now: string,
): number {
  const leftEvaluation = resolveEvaluation(left, task, now);
  const rightEvaluation = resolveEvaluation(right, task, now);
  return (
    compareKnown(leftEvaluation, rightEvaluation) ||
    (rightEvaluation?.scoreBasisPoints ?? 0) - (leftEvaluation?.scoreBasisPoints ?? 0) ||
    (rightEvaluation?.sampleCount ?? 0) - (leftEvaluation?.sampleCount ?? 0) ||
    preferredCapabilityCount(right, task, now) - preferredCapabilityCount(left, task, now) ||
    compareKnownNumber(
      left.catalogEntry.inputTokenLimit,
      right.catalogEntry.inputTokenLimit,
      "descending",
    ) ||
    compareKnownNumber(
      leftEvaluation?.latencyP50Ms ?? null,
      rightEvaluation?.latencyP50Ms ?? null,
    ) ||
    left.catalogEntry.id.localeCompare(right.catalogEntry.id)
  );
}

function compareEconomy(
  left: ModelHubRoutingCandidate,
  right: ModelHubRoutingCandidate,
  task: NovelAiTask,
  now: string,
): number {
  const leftCost = totalTokenCost(left.costPrivacy);
  const rightCost = totalTokenCost(right.costPrivacy);
  const leftEvaluation = resolveEvaluation(left, task, now);
  const rightEvaluation = resolveEvaluation(right, task, now);
  return (
    compareKnown(leftCost, rightCost) ||
    compareBigInt(leftCost, rightCost) ||
    compareKnown(leftEvaluation, rightEvaluation) ||
    compareKnownNumber(
      leftEvaluation?.latencyP50Ms ?? null,
      rightEvaluation?.latencyP50Ms ?? null,
    ) ||
    (rightEvaluation?.scoreBasisPoints ?? 0) - (leftEvaluation?.scoreBasisPoints ?? 0) ||
    preferredCapabilityCount(right, task, now) - preferredCapabilityCount(left, task, now) ||
    left.catalogEntry.id.localeCompare(right.catalogEntry.id)
  );
}

export function requiredCapabilitiesForNovelTask(task: NovelAiTask): readonly ModelHubCapability[] {
  return TASK_REQUIRED_CAPABILITIES[task];
}

export function preferredCapabilitiesForNovelTask(
  task: NovelAiTask,
): readonly ModelHubCapability[] {
  return TASK_PREFERRED_CAPABILITIES[task];
}

export function resolveModelCapabilityVerdict(
  input: Readonly<{
    catalogEntryId: string;
    capability: ModelHubCapability;
    evidence: readonly ModelCapabilityEvidence[];
    now: string;
  }>,
): ModelCapabilityEvidence["verdict"] {
  const now = normalizeTimestamp(input.now);
  const selected = input.evidence
    .filter(
      (evidence) =>
        evidence.catalogEntryId === input.catalogEntryId &&
        evidence.capability === input.capability &&
        (evidence.expiresAt === null || evidence.expiresAt > now),
    )
    .sort(
      (left, right) =>
        CAPABILITY_SOURCE_PRIORITY[right.evidenceSource] -
          CAPABILITY_SOURCE_PRIORITY[left.evidenceSource] ||
        right.observedAt.localeCompare(left.observedAt) ||
        left.id.localeCompare(right.id),
    )[0];
  if (
    input.capability === "structured_output" &&
    selected?.verdict === "supported" &&
    selected.evidenceSource !== "lightweight_probe" &&
    selected.evidenceSource !== "user_confirmed"
  ) {
    return "unknown";
  }
  return selected?.verdict ?? "unknown";
}

function resolveCapability(
  candidate: ModelHubRoutingCandidate,
  capability: ModelHubCapability,
  now: string,
): ModelCapabilityEvidence["verdict"] {
  return resolveModelCapabilityVerdict({
    catalogEntryId: candidate.catalogEntry.id,
    capability,
    evidence: candidate.capabilities,
    now,
  });
}

function resolveEvaluation(
  candidate: ModelHubRoutingCandidate,
  task: NovelAiTask,
  now: string,
): ModelEvaluationResult | null {
  return (
    candidate.evaluations
      .filter(
        (evaluation) =>
          evaluation.catalogEntryId === candidate.catalogEntry.id &&
          evaluation.task === task &&
          (evaluation.expiresAt === null || evaluation.expiresAt > now),
      )
      .sort(
        (left, right) =>
          EVALUATION_SOURCE_PRIORITY[right.evaluationSource] -
            EVALUATION_SOURCE_PRIORITY[left.evaluationSource] ||
          right.sampleCount - left.sampleCount ||
          right.observedAt.localeCompare(left.observedAt) ||
          left.id.localeCompare(right.id),
      )[0] ?? null
  );
}

function preferredCapabilityCount(
  candidate: ModelHubRoutingCandidate,
  task: NovelAiTask,
  now: string,
): number {
  return TASK_PREFERRED_CAPABILITIES[task].filter(
    (capability) => resolveCapability(candidate, capability, now) === "supported",
  ).length;
}

function totalTokenCost(profile: ModelCostPrivacyProfile | null): bigint | null {
  if (
    profile?.inputMicrosPerMillionTokens === null ||
    profile?.inputMicrosPerMillionTokens === undefined ||
    profile.outputMicrosPerMillionTokens === null
  ) {
    return null;
  }
  return BigInt(profile.inputMicrosPerMillionTokens) + BigInt(profile.outputMicrosPerMillionTokens);
}

function compareKnown<T>(left: T | null, right: T | null): number {
  return Number(left === null) - Number(right === null);
}

function compareBigInt(left: bigint | null, right: bigint | null): number {
  if (left === null || right === null || left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareKnownNumber(
  left: number | null,
  right: number | null,
  direction: "ascending" | "descending" = "ascending",
): number {
  const known = compareKnown(left, right);
  if (known !== 0 || left === null || right === null) {
    return known;
  }
  return direction === "ascending" ? left - right : right - left;
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Model Hub routing requires a valid current timestamp.");
  }
  return new Date(milliseconds).toISOString();
}
