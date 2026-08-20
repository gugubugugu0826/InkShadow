import { describe, expect, it } from "vitest";

import {
  BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT,
  BOUNDED_LOCAL_QUERY_PLAN_LIMIT,
  BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT,
  planBoundedLocalRecoveryQueries,
  planBoundedLocalRetrievalQueries,
} from "./bounded-local-retrieval-query-plan";

describe("shared bounded local retrieval query plan", () => {
  it("covers fact, alias, time and location with deterministic local-only queries", () => {
    const plans = planBoundedLocalRetrievalQueries([
      source("task-1", "current_task", "林晚又名阿晚，翌日清晨在北塔门口交出铜钥匙。"),
    ]);

    expect(plans).toHaveLength(BOUNDED_LOCAL_QUERY_PLAN_LIMIT);
    expect(plans.map(({ queryType }) => queryType)).toEqual(["fact", "alias", "time", "location"]);
    expect(plans.every(({ query }) => query.length <= BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT)).toBe(
      true,
    );
    expect(plans.every(({ sourceId }) => sourceId === "task-1")).toBe(true);
    expect(plans.every(({ sourceType }) => sourceType === "current_task")).toBe(true);
    expect(Object.isFrozen(plans)).toBe(true);
    const recovery = planBoundedLocalRecoveryQueries(
      [source("task-1", "current_task", "林晚又名阿晚，翌日清晨在北塔门口交出铜钥匙。")],
      plans,
    );
    expect(recovery).toEqual([]);
    expect(new Set([...plans, ...recovery].map(({ query }) => query)).size).toBeLessThanOrEqual(
      BOUNDED_LOCAL_QUERY_PLAN_LIMIT,
    );
  });

  it("uses one content-bounded fallback for an empty or punctuation-only source", () => {
    const plans = planBoundedLocalRetrievalQueries([source("chapter-1", "accepted_chapter", "……")]);

    expect(plans).toEqual([
      expect.objectContaining({
        sourceId: "chapter-1",
        sourceType: "accepted_chapter",
        query: "人物 时间 地点 关系",
        queryType: "fallback",
        fusionWeight: 0.5,
      }),
    ]);
  });

  it("shares one four-query budget across initial, FTS rewrite and multi-query recovery", () => {
    const sources = [
      source(
        "task-2",
        "current_task",
        "林晚追查那枚消失已久的青铜钥匙背后的隐秘线索；周野核对旧港仓库遗留多年的航行记录与签章",
      ),
    ];
    const initial = planBoundedLocalRetrievalQueries(sources);
    const recovery = planBoundedLocalRecoveryQueries(sources, initial);

    expect(recovery.length).toBeLessThanOrEqual(BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT);
    expect(new Set([...initial, ...recovery].map(({ query }) => query)).size).toBe(
      initial.length + recovery.length,
    );
    expect(initial.length + recovery.length).toBeLessThanOrEqual(BOUNDED_LOCAL_QUERY_PLAN_LIMIT);
    expect(recovery.every(({ query }) => query.length <= BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT)).toBe(
      true,
    );
    expect(recovery.map(({ recoveryType }) => recoveryType)).toEqual([
      "fts_rewrite",
      "bounded_multi_query",
      "bounded_multi_query",
    ]);
    expect(JSON.stringify(recovery)).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/iu);
    expect(JSON.stringify(recovery)).not.toMatch(/branchId|povCharacterId|maximumStoryOrder/u);
  });
});

function source(sourceId: string, sourceType: string, content: string) {
  return { sourceId, sourceType, content } as const;
}
