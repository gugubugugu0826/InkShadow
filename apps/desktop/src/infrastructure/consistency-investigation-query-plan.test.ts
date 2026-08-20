import { describe, expect, it } from "vitest";

import type { StoryMemoryReadEntry } from "@inkshadow/ai-core";

import {
  CONSISTENCY_QUERY_CHARACTER_LIMIT,
  CONSISTENCY_QUERY_PLAN_LIMIT,
  CONSISTENCY_RECOVERY_QUERY_PLAN_LIMIT,
  planConsistencyLocalQueries,
  planConsistencyRecoveryQueries,
} from "./consistency-investigation-query-plan";

describe("consistency investigation local query plan", () => {
  it("expands aliases, time, and location locally with a strict global cap", () => {
    const plans = planConsistencyLocalQueries([
      entry("fact-1", "林晚又名阿晚，翌日清晨在北塔门口交出铜钥匙。"),
      entry("fact-2", "周野第三天到旧港附近等待。"),
    ]);

    expect(plans).toHaveLength(CONSISTENCY_QUERY_PLAN_LIMIT);
    expect(plans.map(({ queryType }) => queryType)).toEqual(["fact", "alias", "time", "location"]);
    expect(plans[1]?.query).toContain("林晚");
    expect(plans[1]?.query).toContain("阿晚");
    expect(plans[2]?.filters.timeTerms).toEqual(["翌日", "清晨"]);
    expect(plans[3]?.filters.locationTerms).toEqual(["北塔"]);
    expect(plans.map(({ retrievalMethod }) => retrievalMethod)).toEqual([
      "fts",
      "fts",
      "fts",
      "fts",
    ]);
    expect(plans.every(({ query }) => query.length <= CONSISTENCY_QUERY_CHARACTER_LIMIT)).toBe(
      true,
    );
    expect(Object.isFrozen(plans)).toBe(true);
    expect(Object.isFrozen(plans[0]?.filters)).toBe(true);
  });

  it("deduplicates rewrites and never creates SQL or model instructions", () => {
    const plans = planConsistencyLocalQueries([
      entry("same-1", "林晚又名阿晚。"),
      entry("same-2", "林晚又名阿晚。"),
    ]);

    expect(new Set(plans.map(({ query }) => query)).size).toBe(plans.length);
    expect(plans).toHaveLength(2);
    expect(plans.map(({ queryType }) => queryType)).toEqual(["fact", "alias"]);
    expect(plans.flatMap(({ filters }) => Object.keys(filters))).not.toContain("sql");
  });

  it("uses one bounded deterministic fallback when no confirmed fact is searchable", () => {
    const plans = planConsistencyLocalQueries([entry("empty", "   ")]);

    expect(plans).toEqual([
      expect.objectContaining({
        sourceEntryId: null,
        query: "人物 时间 地点 关系",
        queryType: "fallback",
        retrievalMethod: "fts",
        fusionWeight: 0.5,
      }),
    ]);
  });

  it("preserves author compatibility glyphs while normalizing canonical Unicode", () => {
    const plans = planConsistencyLocalQueries([entry("glyph", "林晚来到Ａ塔内。")]);

    expect(plans[0]?.query).toContain("Ａ塔");
    expect(plans[0]?.query).not.toContain("A塔");
  });

  it("bounds local alias/time/location, FTS rewrite and multi-query recovery without SQL", () => {
    const entries = [
      entry("recovery", "她是林晚又名阿晚。翌日清晨，她从旧港门口离开；铜钥匙仍在北塔。"),
    ];
    const initial = planConsistencyLocalQueries(entries);
    const recovery = planConsistencyRecoveryQueries(entries, initial);

    expect(recovery.length).toBeLessThanOrEqual(CONSISTENCY_RECOVERY_QUERY_PLAN_LIMIT);
    expect(new Set([...initial, ...recovery].map(({ query }) => query)).size).toBe(
      initial.length + recovery.length,
    );
    expect(recovery.every(({ query }) => query.length <= CONSISTENCY_QUERY_CHARACTER_LIMIT)).toBe(
      true,
    );
    expect(
      recovery.every(({ recoveryType }) =>
        [
          "local_alias_expansion",
          "local_time_location_scope",
          "fts_rewrite",
          "bounded_multi_query",
        ].includes(recoveryType),
      ),
    ).toBe(true);
    expect(JSON.stringify(recovery)).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/iu);
  });
});

function entry(id: string, content: string): StoryMemoryReadEntry {
  return {
    id,
    layer: "L1",
    kind: "confirmed_canon",
    content,
    evidence: [],
    rebuildable: false,
  };
}
