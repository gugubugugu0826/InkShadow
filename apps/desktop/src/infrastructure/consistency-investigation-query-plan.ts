import type { StoryMemoryReadEntry } from "@inkshadow/ai-core";

import {
  BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT,
  BOUNDED_LOCAL_QUERY_PLAN_LIMIT,
  BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT,
  planBoundedLocalRecoveryQueries,
  planBoundedLocalRetrievalQueries,
  type BoundedLocalQueryRecoveryType,
  type BoundedLocalQueryType,
  type BoundedLocalRecoveryQueryPlan,
  type BoundedLocalRetrievalQueryPlan,
} from "./bounded-local-retrieval-query-plan";

export const CONSISTENCY_QUERY_PLAN_LIMIT = BOUNDED_LOCAL_QUERY_PLAN_LIMIT;
export const CONSISTENCY_QUERY_CHARACTER_LIMIT = BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT;
export const CONSISTENCY_RECOVERY_QUERY_PLAN_LIMIT = BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT;

export type ConsistencyQueryType = BoundedLocalQueryType;

export interface ConsistencyLocalQueryPlan extends Omit<
  BoundedLocalRetrievalQueryPlan,
  "sourceId" | "sourceType"
> {
  readonly sourceEntryId: string | null;
}

export type ConsistencyQueryRecoveryType = BoundedLocalQueryRecoveryType;

export interface ConsistencyLocalRecoveryQueryPlan
  extends
    ConsistencyLocalQueryPlan,
    Omit<BoundedLocalRecoveryQueryPlan, "sourceId" | "sourceType" | "sourceEntryId"> {}

/** Shared bounded planner adapter for the consistency StoryMemory projection. */
export function planConsistencyLocalQueries(
  entries: readonly StoryMemoryReadEntry[],
): readonly ConsistencyLocalQueryPlan[] {
  return Object.freeze(planBoundedLocalRetrievalQueries(toSources(entries)).map(toConsistencyPlan));
}

/** Shared bounded recovery adapter; no Agent-specific planning authority is duplicated here. */
export function planConsistencyRecoveryQueries(
  entries: readonly StoryMemoryReadEntry[],
  initial: readonly ConsistencyLocalQueryPlan[],
): readonly ConsistencyLocalRecoveryQueryPlan[] {
  return Object.freeze(
    planBoundedLocalRecoveryQueries(toSources(entries), initial).map(toConsistencyRecoveryPlan),
  );
}

function toSources(entries: readonly StoryMemoryReadEntry[]) {
  return entries.map((entry) =>
    Object.freeze({
      sourceId: entry.id,
      sourceType: "story_memory",
      content: entry.content,
    }),
  );
}

function toConsistencyPlan(plan: BoundedLocalRetrievalQueryPlan): ConsistencyLocalQueryPlan {
  return Object.freeze({
    sourceEntryId: plan.queryType === "fallback" ? null : plan.sourceId,
    sourceQuestion: plan.sourceQuestion,
    query: plan.query,
    queryType: plan.queryType,
    filters: plan.filters,
    retrievalMethod: plan.retrievalMethod,
    fusionWeight: plan.fusionWeight,
  });
}

function toConsistencyRecoveryPlan(
  plan: BoundedLocalRecoveryQueryPlan,
): ConsistencyLocalRecoveryQueryPlan {
  return Object.freeze({
    ...toConsistencyPlan(plan),
    recoveryType: plan.recoveryType,
  });
}
