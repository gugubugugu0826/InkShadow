import { createProjectSeed, updateProjectSeedField } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { selectProjectSeedContextCandidates } from "./project-seed-context-adapter";

const PROJECT_ID = "018f0f00-0000-7000-8000-000000000001";

describe("project seed context adapter", () => {
  it("uses only confirmed author inputs and preserves their reviewed context layers", () => {
    let seed = createProjectSeed({
      seedId: "018f0f00-0000-7000-8000-000000000002",
      journeyKind: "idea",
      premise: "在永夜港寻找失踪的姐姐。",
      now: "2026-08-08T00:00:00.000Z",
    });
    seed = updateProjectSeedField(seed, "boundaries", {
      values: ["禁止死者复生。"],
      source: "user_input",
      confirmation: "confirmed",
      origin: "author-boundaries",
      updatedAt: "2026-08-08T00:00:01.000Z",
    });
    seed = updateProjectSeedField(seed, "style", {
      values: ["短句，克制描写。"],
      source: "user_input",
      confirmation: "confirmed",
      origin: "style-answer",
      updatedAt: "2026-08-08T00:00:02.000Z",
    });
    seed = updateProjectSeedField(seed, "characters", {
      values: ["林遥可能是巡灯人。"],
      source: "ai_inference",
      confirmation: "unconfirmed",
      origin: "ai-opening",
      updatedAt: "2026-08-08T00:00:03.000Z",
    });

    const candidates = selectProjectSeedContextCandidates({
      projectId: PROJECT_ID,
      seed,
      revision: 4,
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt,
    });

    expect(candidates.map(({ layer }) => layer)).toEqual([
      "world_setting",
      "current_task",
      "locked_hard_rules",
    ]);
    expect(candidates.map(({ content }) => content).join("\n")).toContain("禁止死者复生。");
    expect(candidates.map(({ content }) => content).join("\n")).not.toContain("巡灯人");
    expect(candidates.find(({ layer }) => layer === "locked_hard_rules")).toMatchObject({
      priority: 1_000,
      evidence: [
        {
          sourceType: "user_input",
          sourceId: PROJECT_ID,
          sourceVersionId: "seed-r4",
          locator: "project-seed:boundaries",
        },
      ],
    });
  });
});
