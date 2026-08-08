import { describe, expect, it } from "vitest";

import {
  createProjectSeed,
  parseProjectSeed,
  updateProjectSeedField,
} from "../src/entities/project-seed.js";

describe("ProjectSeed author-text fidelity", () => {
  it("canonically composes author text without compatibility-folding punctuation", () => {
    const created = createProjectSeed({
      seedId: "idea:seed-fidelity",
      journeyKind: "idea",
      now: "2026-08-08T01:00:00.000Z",
      premise: "失忆少年收到留言，并追查“她”来自何处。",
    });
    const updated = updateProjectSeedField(created, "style", {
      values: ["保留全角标点；也保留ＡＩ作为作者刻意使用的字形。", "e\u0301lan，克制"],
      source: "user_input",
      confirmation: "confirmed",
      origin: "question:style",
      updatedAt: "2026-08-08T01:01:00.000Z",
    });

    expect(updated.premise.values).toEqual(["失忆少年收到留言，并追查“她”来自何处。"]);
    expect(updated.style.values).toEqual([
      "保留全角标点；也保留ＡＩ作为作者刻意使用的字形。",
      "élan，克制",
    ]);
    expect(parseProjectSeed(JSON.parse(JSON.stringify(updated)))).toEqual(updated);
  });
});
