import { describe, expect, it } from "vitest";

import { IdeationDraft, buildLocalIdeationSuggestion } from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";

describe("local ideation suggestions", () => {
  it("is deterministic, bounded, and explicitly marked as a local template", () => {
    const draft = unwrap(
      IdeationDraft.create({
        id: uuid(900),
        mode: "quick",
        projectName: "本地构思",
        now: "2026-07-27T00:00:00.000Z",
        quickSeed: {
          idea: "每当潮水退去，城市就会忘记一个居民。",
          genre: "悬疑幻想",
          targetWords: 240_000,
          protagonistType: "寻找失踪姐姐的档案员",
        },
      }),
    );

    const first = buildLocalIdeationSuggestion(draft, "world_skeleton", 1);
    const repeated = buildLocalIdeationSuggestion(draft, "world_skeleton", 4);
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      provenance: "local_template",
      variant: 1,
    });
    expect(first.content).toContain("每当潮水退去");
    expect(first.content.length).toBeLessThanOrEqual(4_000);
  });

  it("cycles regeneration variants without mutating the draft", () => {
    const draft = unwrap(
      IdeationDraft.create({
        id: uuid(910),
        mode: "guided",
        projectName: "循环建议",
        now: "2026-07-27T00:00:00.000Z",
      }),
    );
    const before = draft.toSnapshot();
    const suggestions = [0, 1, 2].map((variant) =>
      buildLocalIdeationSuggestion(draft, "opening_hook", variant),
    );
    expect(new Set(suggestions.map(({ content }) => content)).size).toBe(3);
    expect(draft.toSnapshot()).toEqual(before);
  });
});
