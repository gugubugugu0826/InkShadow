import { resolveContinuationOutputContract } from "@inkshadow/ai-core";

import {
  inspectModelHubTextTask,
  ModelHubExecutionError,
  type ModelHubTextInspectionDependencies,
  type ModelHubTextTask,
} from "./model-hub-execution-service";
import { projectModelHubReadiness, type ModelHubReadinessProjection } from "./model-hub-readiness";
import type { NovelAiTask } from "./model-hub-provider-registry";
import type { NovelTaskRoute } from "./model-hub-store";

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
  const [catalog, routes] = await Promise.all([
    Promise.all(connections.map(({ id }) => dependencies.modelHub.listCatalog(id))).then((rows) =>
      rows.flat(),
    ),
    Promise.all(
      COMPLETE_WRITING_TASKS.map((task) => dependencies.modelHub.findTaskRoute(task)),
    ).then((rows) => rows.filter((route): route is NovelTaskRoute => route !== null)),
  ]);
  const shallow = projectModelHubReadiness({ connections, catalog, routes, now: checkedAt });
  if (shallow.state !== "basic_ready" && shallow.state !== "fully_ready") {
    return shallow;
  }

  const exactResults = await Promise.allSettled(
    EXACT_READINESS_CONTRACTS.map(({ task, maximumOutputTokens }) =>
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
    const contract = EXACT_READINESS_CONTRACTS[index];
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
  return projectModelHubReadiness({ connections, catalog, routes, exactBlockers });
}
