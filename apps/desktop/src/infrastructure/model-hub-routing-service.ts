import {
  buildLegacyCompatibilityPlan,
  buildModelHubRoutingPlan,
  type AutomaticModelHubScheme,
  type LegacyCompatibilityPlan,
  type ModelHubRoutingCandidate,
  type ModelHubRoutingPlan,
} from "./model-hub-router";
import type { ModelHubPreset, ModelHubStore, NovelTaskRoute } from "./model-hub-store";
import {
  ModelRoutingStoreError,
  type ModelRoleRoute,
  type ModelRoutingStore,
} from "./model-routing-store";

export const MODEL_HUB_AUTOMATIC_ROUTE_GENERATION_VERSION = "model-hub-evidence-router-v2";
const RECALCULABLE_AUTOMATIC_ROUTE_GENERATION_VERSIONS = Object.freeze([
  "model-hub-evidence-router-v1",
  MODEL_HUB_AUTOMATIC_ROUTE_GENERATION_VERSION,
]);

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
  readonly routes: readonly NovelTaskRoute[];
  readonly savedNovelTaskCount: number;
  readonly savedLegacyRoleCount: number;
  readonly preservedUserRouteCount: number;
  readonly changed: boolean;
  readonly legacySyncStatus: "succeeded" | "failed";
  readonly legacySyncErrorCode: string | null;
}

export function canSafelyRecalculateAutomaticModelHubRouting(
  input: Readonly<{
    scheme: AutomaticModelHubScheme;
    preset: ModelHubPreset | null;
    routes: readonly NovelTaskRoute[];
  }>,
): boolean {
  const presetId = "automatic-" + input.scheme;
  return (
    input.preset?.id === presetId &&
    input.preset.scheme === input.scheme &&
    RECALCULABLE_AUTOMATIC_ROUTE_GENERATION_VERSIONS.includes(
      input.preset.routeGenerationVersion,
    ) &&
    input.routes.every(
      ({ enabled, presetId: routePresetId, routeOrigin }) =>
        routeOrigin === "user" ||
        (enabled && routeOrigin === "automatic" && routePresetId === presetId),
    )
  );
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
              // Pricing/privacy metadata and evaluations improve ranking, but
              // are not required for ordinary cloud routing. A missing or
              // temporarily unreadable optional projection must not disable
              // otherwise proven text generation.
              modelHub.findCostPrivacyProfile(catalogEntry.id).catch(() => null),
              modelHub.listEvaluationResults(catalogEntry.id).catch(() => Object.freeze([])),
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
  let existingLegacyRoutes: readonly ModelRoleRoute[] = Object.freeze([]);
  let legacyReadErrorCode: string | null = null;
  try {
    existingLegacyRoutes = await input.legacyRouting.listRoutes();
  } catch (cause: unknown) {
    if (input.scheme === "local_privacy") {
      throw cause;
    }
    legacyReadErrorCode = legacySyncErrorCode(cause);
  }

  // Legacy role routes are a rebuildable compatibility projection. Switching
  // to local-only clears that projection first so a legacy cloud path cannot
  // survive if later reconciliation is interrupted.
  if (input.scheme === "local_privacy") {
    await clearLegacyRoutes(input.legacyRouting, existingLegacyRoutes);
    existingLegacyRoutes = Object.freeze([]);
  }

  const presetId = `automatic-${input.scheme}`;
  const appliedPlan = await input.modelHub.applyAutomaticRoutingPlan({
    preset: {
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
      routeGenerationVersion: MODEL_HUB_AUTOMATIC_ROUTE_GENERATION_VERSION,
    },
    routes: plan.routes,
  });

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
  let legacySyncStatus: AppliedModelHubRouting["legacySyncStatus"] =
    legacyReadErrorCode === null ? "succeeded" : "failed";
  let legacyFailureCode = legacyReadErrorCode;
  if (legacyReadErrorCode === null) {
    try {
      await reconcileLegacyRoutes(
        input.legacyRouting,
        existingLegacyRoutes,
        applicableLegacyRoutes,
      );
    } catch (cause: unknown) {
      legacySyncStatus = "failed";
      legacyFailureCode = legacySyncErrorCode(cause);
    }
  }

  return Object.freeze({
    plan,
    legacy,
    routes: appliedPlan.routes,
    savedNovelTaskCount: appliedPlan.routes.filter(({ enabled }) => enabled).length,
    savedLegacyRoleCount: legacySyncStatus === "succeeded" ? applicableLegacyRoutes.length : 0,
    preservedUserRouteCount: appliedPlan.preservedUserRouteCount,
    changed: appliedPlan.changed,
    legacySyncStatus,
    legacySyncErrorCode: legacyFailureCode,
  });
}

async function reconcileLegacyRoutes(
  legacyRouting: ModelRoutingStore,
  existingRoutes: readonly ModelRoleRoute[],
  desiredRoutes: LegacyCompatibilityPlan["routes"],
): Promise<void> {
  const desiredRoles = new Set(desiredRoutes.map(({ role }) => role));
  const existingByRole = new Map(existingRoutes.map((route) => [route.role, route] as const));
  for (const desired of desiredRoutes) {
    const existing = existingByRole.get(desired.role);
    if (
      existing?.primaryProviderId !== desired.primaryConnectionId ||
      existing.fallbackProviderId !== desired.fallbackConnectionId
    ) {
      await legacyRouting.saveRoute({
        role: desired.role,
        primaryProviderId: desired.primaryConnectionId,
        fallbackProviderId: desired.fallbackConnectionId,
        expectedRevision: existing?.revision ?? null,
      });
    }
    existingByRole.delete(desired.role);
  }
  await clearLegacyRoutes(
    legacyRouting,
    [...existingByRole.values()].filter(({ role }) => !desiredRoles.has(role)),
  );
}

async function clearLegacyRoutes(
  legacyRouting: ModelRoutingStore,
  routes: readonly ModelRoleRoute[],
): Promise<void> {
  for (const route of routes) {
    await legacyRouting.deleteRoute(route.role, route.revision);
  }
}

function legacySyncErrorCode(cause: unknown): string {
  return cause instanceof ModelRoutingStoreError ? cause.code : "MODEL_HUB_LEGACY_SYNC_FAILED";
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
