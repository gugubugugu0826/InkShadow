import { deriveIdeaProjectSeed, deriveProfessionalProjectSeed } from "@inkshadow/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { DEVELOPMENT_CREATIVE_JOURNEY_KEY } from "./creative-journey-store";
import { BrowserProjectSeedStore, DEVELOPMENT_PROJECT_SEED_KEY } from "./project-seed-local-store";

const PROJECT_ID = "019fa602-0000-7000-8000-000000000001";

describe("BrowserProjectSeedStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("upgrades legacy journey/page snapshots into a durable project-keyed local store", async () => {
    const journeySeed = deriveIdeaProjectSeed({
      seedId: "idea:browser-legacy",
      idea: "一位失忆的地图师发现城市每天都会改变。",
      answers: { tone: "悬疑" },
      skippedQuestionKeys: [],
      now: "2026-08-08T02:00:00.000Z",
    });
    const recoverySeed = deriveProfessionalProjectSeed({
      seedId: "professional:browser-legacy",
      projectName: "移动之城",
      storyDirection: "地图师追踪城市变动的规律。",
      outlineSynopsis: "从错误地图找到被抹去的街区。",
      protagonist: "地图师宁川",
      relationship: "与旧搭档互不信任",
      worldBackground: "街区会在午夜重新排列",
      pov: "第一人称",
      style: "冷静",
      boundaries: "不把猜测写成正式事实",
      now: "2026-08-08T02:05:00.000Z",
    });
    window.localStorage.setItem(
      DEVELOPMENT_CREATIVE_JOURNEY_KEY,
      JSON.stringify({
        schemaVersion: 1,
        journeys: {
          legacy: { projectId: PROJECT_ID, snapshot: { projectSeed: journeySeed } },
        },
        turns: {},
      }),
    );
    window.localStorage.setItem(
      "inkshadow.professional-create-recovery.v1",
      JSON.stringify({ projectId: PROJECT_ID, projectSeed: recoverySeed }),
    );

    const store = new BrowserProjectSeedStore(window.localStorage);
    const upgraded = await store.findByProjectId(PROJECT_ID);

    expect(upgraded).toEqual({
      projectId: PROJECT_ID,
      seed: recoverySeed,
      revision: 1,
      createdAt: recoverySeed.createdAt,
      updatedAt: recoverySeed.updatedAt,
    });
    expect(window.localStorage.getItem(DEVELOPMENT_PROJECT_SEED_KEY)).not.toBeNull();

    window.localStorage.removeItem(DEVELOPMENT_CREATIVE_JOURNEY_KEY);
    window.localStorage.removeItem("inkshadow.professional-create-recovery.v1");
    expect(
      await new BrowserProjectSeedStore(window.localStorage).findByProjectId(PROJECT_ID),
    ).toEqual(upgraded);
  });
});
