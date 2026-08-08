import { MODEL_ROUTE_ROLES, type ModelRouteRole } from "@inkshadow/ai-core";

import { NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import {
  buildLegacyCompatibilityPlan,
  buildModelHubRoutingPlan,
  type AutomaticModelHubScheme,
  type LegacyCompatibilityPlan,
  type ModelHubRoutingCandidate,
  type ModelHubRoutingPlan,
} from "./model-hub-router";
import type { ModelHubStore, NovelTaskRoute } from "./model-hub-store";
import type { ModelRoleRoute, ModelRoutingStore } from "./model-routing-store";

export interface ApplyAutomaticModelHubRoutingInput {
  readonly modelHub: ModelHubStore;
  readonly legacyRouting: ModelRoutingStore;
  readonly legacyReadyModels: readonly {
    readonly connectionId: string;
    readonly modelId: string;
  }[];
  readonly scheme: AutomaticModelHubScheme;
  readonly now: string;
}

export interface AppliedModelHubRouting {
  readonly plan: ModelHubRoutingPlan;
  readonly legacy: LegacyCompatibilityPlan;
  readonly savedNovelTaskCount: number;
  readonly savedLegacyRoleCount: number;
}

export async function loadModelHubRoutingCandidates(
  modelHub: ModelHubStore,
): Promise<readonly ModelHubRoutingCandidate[]> {
  const connections = await modelHub.listConnections();
  const candidates = await Promise.all(
    connections
      .filter(
        (connection) =>
          connection.enabled &&
          (connection.connectionStatus === "ready" || connection.connectionStatus === "degraded"),
      )
      .map(async (connection) => {
        const catalog = await modelHub.listCatalog(connection.id);
        return Promise.all(
          catalog.map(async (catalogEntry) => {
            const [capabilities, costPrivacy, evaluations] = await Promise.all([
              modelHub.listCapabilityEvidence(catalogEntry.id),
              modelHub.findCostPrivacyProfile(catalogEntry.id),
              modelHub.listEvaluationResults(catalogEntry.id),
            ]);
            return Object.freeze({
              connection,
              catalogEntry,
              capabilities,
              costPrivacy,
              evaluations,
            });
          }),
        );
      }),
  );
  return Object.freeze(candidates.flat());
}

export async function applyAutomaticModelHubRouting(
  input: ApplyAutomaticModelHubRoutingInput,
): Promise<AppliedModelHubRouting> {
  const candidates = await loadModelHubRoutingCandidates(input.modelHub);
  const plan = buildModelHubRoutingPlan({
    scheme: input.scheme,
    candidates,
    now: input.now,
  });
  const legacy = buildLegacyCompatibilityPlan(plan, candidates, input.now);
  const existingNovelRoutes = await loadExistingNovelRoutes(input.modelHub);
  const existingLegacyRoutes = await input.legacyRouting.listRoutes();

  // Switching to local-only is fail-closed. Clear every previous route before
  // writing local replacements so a partial write can never retain cloud use.
  if (input.scheme === "local_privacy") {
    await clearNovelRoutes(input.modelHub, existingNovelRoutes);
    await clearLegacyRoutes(input.legacyRouting, existingLegacyRoutes);
  }

  const presetId = `automatic-${input.scheme}`;
  const preset = (await input.modelHub.listPresets()).find(({ id }) => id === presetId);
  await input.modelHub.savePreset({
    id: presetId,
    scheme: input.scheme,
    displayName: schemeLabel(input.scheme),
    status: "active",
    privacyPolicy: input.scheme === "local_privacy" ? "local_only" : "cloud_allowed",
    costPriority:
      input.scheme === "quality"
        ? "quality_first"
        : input.scheme === "economy"
          ? "cost_first"
          : "balanced",
    routeGenerationVersion: "model-hub-evidence-router-v1",
    expectedRevision: preset?.revision ?? null,
  });

  const existingNovelByTask = new Map(
    input.scheme === "local_privacy"
      ? []
      : existingNovelRoutes.map((route) => [route.task, route] as const),
  );
  for (const route of plan.routes) {
    await input.modelHub.saveTaskRoute({
      task: route.task,
      primaryCatalogEntryId: route.primaryCatalogEntryId,
      fallbackCatalogEntryId: route.fallbackCatalogEntryId,
      presetId,
      parameterPolicy: route.parameterPolicy,
      maximumCostMicros: route.maximumCostMicros,
      currency: route.currency,
      privacyPolicy: route.privacyPolicy,
      failurePolicy: route.failurePolicy,
      routeOrigin: route.routeOrigin,
      enabled: route.enabled,
      expectedRevision: existingNovelByTask.get(route.task)?.revision ?? null,
    });
    existingNovelByTask.delete(route.task);
  }
  await clearNovelRoutes(input.modelHub, [...existingNovelByTask.values()]);

  const legacyReady = new Set(
    input.legacyReadyModels.map(({ connectionId, modelId }) => `${connectionId}\u0000${modelId}`),
  );
  const applicableLegacyRoutes = legacy.routes.filter(
    ({ primaryConnectionId, primaryModelId, fallbackConnectionId, fallbackModelId }) =>
      legacyReady.has(`${primaryConnectionId}\u0000${primaryModelId}`) &&
      (fallbackConnectionId === null ||
        (fallbackModelId !== null &&
          legacyReady.has(`${fallbackConnectionId}\u0000${fallbackModelId}`))),
  );
  const applicableRoles = new Set(applicableLegacyRoutes.map(({ role }) => role));
  const existingLegacyByRole = new Map<ModelRouteRole, ModelRoleRoute>(
    input.scheme === "local_privacy"
      ? []
      : existingLegacyRoutes.map((route) => [route.role, route] as const),
  );
  for (const route of applicableLegacyRoutes) {
    await input.legacyRouting.saveRoute({
      role: route.role,
      primaryProviderId: route.primaryConnectionId,
      fallbackProviderId: route.fallbackConnectionId,
      expectedRevision: existingLegacyByRole.get(route.role)?.revision ?? null,
    });
    existingLegacyByRole.delete(route.role);
  }
  const rolesToClear = new Set<ModelRouteRole>([
    ...legacy.rolesToClear,
    ...MODEL_ROUTE_ROLES.filter((role) => !applicableRoles.has(role)),
  ]);
  await clearLegacyRoutes(
    input.legacyRouting,
    [...existingLegacyByRole.values()].filter(({ role }) => rolesToClear.has(role)),
  );

  return Object.freeze({
    plan,
    legacy,
    savedNovelTaskCount: plan.routes.length,
    savedLegacyRoleCount: applicableLegacyRoutes.length,
  });
}

async function loadExistingNovelRoutes(
  modelHub: ModelHubStore,
): Promise<readonly NovelTaskRoute[]> {
  const routes = await Promise.all(NOVEL_AI_TASKS.map((task) => modelHub.findTaskRoute(task)));
  return Object.freeze(routes.filter((route): route is NovelTaskRoute => route !== null));
}

async function clearNovelRoutes(
  modelHub: ModelHubStore,
  routes: readonly NovelTaskRoute[],
): Promise<void> {
  for (const route of routes) {
    await modelHub.deleteTaskRoute(route.task, route.revision);
  }
}

async function clearLegacyRoutes(
  legacyRouting: ModelRoutingStore,
  routes: readonly ModelRoleRoute[],
): Promise<void> {
  for (const route of routes) {
    await legacyRouting.deleteRoute(route.role, route.revision);
  }
}

function schemeLabel(scheme: AutomaticModelHubScheme): string {
  const labels: Record<AutomaticModelHubScheme, string> = {
    smart: "智能推荐",
    quality: "高质量",
    economy: "经济模式",
    local_privacy: "本地隐私",
  };
  return labels[scheme];
}
