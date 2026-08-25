import { resolveContinuationOutputContract } from "@inkshadow/ai-core";

import {
  inspectModelHubTextTask,
  ModelHubExecutionError,
  type ModelHubTextInspectionDependencies,
  type ModelHubTextTask,
} from "./model-hub-execution-service";
import {
  projectModelHubReadiness,
  type ModelHubCredentialStatus,
  type ModelHubReadinessProjection,
  type ModelHubRouteLoadStatus,
} from "./model-hub-readiness";
import {
  ModelHubCredentialReferenceError,
  modelHubCredentialProviderId,
} from "./model-hub-native-config";
import type { NovelAiTask } from "./model-hub-provider-registry";
import type { ModelProviderConnection, NovelTaskRoute } from "./model-hub-store";

const COMPLETE_WRITING_TASKS: readonly NovelAiTask[] = Object.freeze([
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "chapter_summary",
  "long_memory_compression",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
]);

const EXACT_READINESS_CONTRACTS: readonly Readonly<{
  task: ModelHubTextTask;
  maximumOutputTokens: number;
}>[] = Object.freeze([
  Object.freeze({ task: "prose_generation", maximumOutputTokens: 4_096 }),
  Object.freeze({
    task: "continuation",
    maximumOutputTokens: resolveContinuationOutputContract().requestedMaxOutputTokens,
  }),
  Object.freeze({ task: "rewrite", maximumOutputTokens: 4_096 }),
  Object.freeze({ task: "polish", maximumOutputTokens: 4_096 }),
  Object.freeze({ task: "chapter_summary", maximumOutputTokens: 2_048 }),
  Object.freeze({ task: "long_memory_compression", maximumOutputTokens: 4_096 }),
  Object.freeze({ task: "contradiction_check", maximumOutputTokens: 4_096 }),
  Object.freeze({ task: "pov_check", maximumOutputTokens: 4_096 }),
  Object.freeze({ task: "character_voice_check", maximumOutputTokens: 4_096 }),
  Object.freeze({ task: "content_quality_check", maximumOutputTokens: 4_096 }),
]);

/**
 * Uses the same exact route, catalog, capability, credential and cost resolver
 * as provider dispatch, but deliberately supplies no project or chapter
 * content. The result is therefore a base-configuration projection, never a
 * claim that a particular request passed its privacy/context/profile preflight.
 * The module stays behind dynamic import so Model Hub stores and execution code
 * do not enter the ordinary shell startup graph.
 */
export async function loadAuthoritativeModelHubReadiness(
  dependencies: ModelHubTextInspectionDependencies,
): Promise<ModelHubReadinessProjection> {
  const checkedAt = dependencies.clock.now();
  const consistentDependencies: ModelHubTextInspectionDependencies = Object.freeze({
    ...dependencies,
    clock: Object.freeze({ now: () => checkedAt }),
  });
  const connections = await dependencies.modelHub.listConnections();
  const [catalogResults, routeResults, credentialStatus] = await Promise.all([
    Promise.allSettled(connections.map(({ id }) => dependencies.modelHub.listCatalog(id))),
    Promise.allSettled(
      COMPLETE_WRITING_TASKS.map((task) => dependencies.modelHub.findTaskRoute(task)),
    ),
    inspectCredentialStatus(dependencies, connections),
  ]);
  const catalog = Object.freeze(
    catalogResults.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  );
  const routes = Object.freeze(
    routeResults.flatMap((result) =>
      result.status === "fulfilled" && result.value !== null ? [result.value] : [],
    ),
  ) satisfies readonly NovelTaskRoute[];
  const catalogLoadStatus =
    connections.length === 0 ? "not_loaded" : settledLoadStatus(catalogResults);
  const routeLoadStatus = settledLoadStatus(routeResults);
  const projectionInput = Object.freeze({
    connections,
    catalog,
    routes,
    catalogLoadStatus,
    routeLoadStatus,
    credentialStatus,
    now: checkedAt,
  });
  const shallow = projectModelHubReadiness(projectionInput);
  const potentiallySendableContracts = EXACT_READINESS_CONTRACTS.filter(
    ({ task }) => !shallow.missingCoreTasks.includes(task),
  );
  if (potentiallySendableContracts.length === 0) {
    return shallow;
  }

  const exactResults = await Promise.allSettled(
    potentiallySendableContracts.map(({ task, maximumOutputTokens }) =>
      inspectModelHubTextTask(consistentDependencies, {
        task,
        messages: Object.freeze([
          Object.freeze({
            role: "system" as const,
            content: "Inspect this InkShadow task route without project or chapter content.",
          }),
        ]),
        maximumOutputTokens,
      }),
    ),
  );
  const exactBlockers = exactResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const contract = potentiallySendableContracts[index];
    if (contract === undefined) return [];
    return [
      Object.freeze({
        task: contract.task,
        code:
          result.reason instanceof ModelHubExecutionError
            ? result.reason.code
            : "MODEL_HUB_PREFLIGHT_FAILED",
      }),
    ];
  });
  return projectModelHubReadiness({ ...projectionInput, exactBlockers });
}

function settledLoadStatus(
  results: readonly PromiseSettledResult<unknown>[],
): ModelHubRouteLoadStatus {
  if (results.length === 0) return "loaded";
  const fulfilledCount = results.filter(({ status }) => status === "fulfilled").length;
  if (fulfilledCount === results.length) return "loaded";
  return fulfilledCount === 0 ? "temporarily_unavailable" : "partially_loaded";
}

async function inspectCredentialStatus(
  dependencies: ModelHubTextInspectionDependencies,
  connections: readonly ModelProviderConnection[],
): Promise<ModelHubCredentialStatus> {
  const protectedConnections = connections.filter(
    ({ authenticationMode, enabled }) => enabled && authenticationMode !== "none",
  );
  if (protectedConnections.length === 0) return "not_required";
  const credentialStates = await Promise.all(
    protectedConnections.map(async (connection): Promise<ModelHubCredentialStatus> => {
      let providerId: string;
      try {
        providerId = modelHubCredentialProviderId(connection);
      } catch (cause: unknown) {
        return cause instanceof ModelHubCredentialReferenceError ? "untrusted" : "unavailable";
      }
      try {
        const summary = await dependencies.credentials.getSummary(providerId);
        return summary.configured ? "trusted" : "missing";
      } catch {
        return "unavailable";
      }
    }),
  );
  const states = new Set<ModelHubCredentialStatus>(credentialStates);
  if (states.size > 1) return "mixed";
  return states.values().next().value ?? "unavailable";
}
