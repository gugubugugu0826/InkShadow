import { describe, expect, it } from "vitest";

import {
  createProjectSeed,
  deriveIdeaProjectSeed,
  deriveImportProjectSeed,
  deriveProfessionalProjectSeed,
  parseProjectSeed,
  updateProjectSeedField,
} from "./project-seed";

const NOW = "2026-08-08T01:00:00.000Z";
const LATER = "2026-08-08T01:01:00.000Z";

describe("ProjectSeed", () => {
  it("keeps every required story input with provenance and confirmation", () => {
    const seed = deriveProfessionalProjectSeed({
      seedId: "professional:019fa501-0000-7000-8000-000000000001",
      projectName: "雨夜列车",
      storyDirection: "主角追查一封来自未来的信",
      outlineSynopsis: "在三次错误选择后发现寄信人就是未来的自己",
      protagonist: "林遥，谨慎但好奇",
      relationship: "林遥与周岚从互不信任到合作",
      worldBackground: "近未来的沿海城市",
      pov: "第三人称限知",
      style: "短句，对话自然",
      boundaries: "不新增超自然设定",
      now: NOW,
    });

    expect(seed).toMatchObject({ version: 1, journeyKind: "professional" });
    expect(seed.characters).toMatchObject({
      values: ["林遥，谨慎但好奇"],
      source: "professional_setup",
      confirmation: "confirmed",
    });
    expect(seed.world.values).toEqual(["近未来的沿海城市"]);
    expect(seed.currentDirection.values).toEqual(["主角追查一封来自未来的信"]);
    expect(seed.initialOutline.values).toEqual(["在三次错误选择后发现寄信人就是未来的自己"]);
    expect(parseProjectSeed(JSON.parse(JSON.stringify(seed)))).toEqual(seed);
  });

  it("distinguishes a skipped question from an unanswered field", () => {
    const seed = deriveIdeaProjectSeed({
      seedId: "idea:019fa501-0000-7000-8000-000000000001",
      idea: "我想写一个青春恋爱轻小说。",
      answers: { tone: "温暖心动", protagonist: "不善表达的转学生" },
      skippedQuestionKeys: ["pov"],
      now: NOW,
    });

    expect(seed.genre).toMatchObject({
      values: ["青春恋爱轻小说"],
      source: "user_input",
      confirmation: "unconfirmed",
      origin: "premise_keyword",
    });
    expect(seed.tone).toMatchObject({ values: ["温暖心动"], confirmation: "confirmed" });
    expect(seed.pov).toMatchObject({ values: [], confirmation: "skipped" });
    expect(seed.world).toMatchObject({ values: [], confirmation: "unconfirmed", source: null });
  });

  it("keeps import goals and editable rules without copying imported正文", () => {
    const seed = deriveImportProjectSeed({
      seedId: "import:019fa501-0000-7000-8000-000000000001",
      projectName: "导入作品",
      goal: "保留剧情，让对话更自然",
      presetLabels: ["增加人物对话"],
      rewriteRules: ["不修改人物姓名"],
      now: NOW,
    });

    expect(seed.premise).toMatchObject({ source: "imported_text", values: ["导入作品"] });
    expect(seed.currentDirection.values).toEqual(["保留剧情，让对话更自然", "增加人物对话"]);
    expect(seed.rewriteRules.values).toEqual(["不修改人物姓名"]);
    expect(JSON.stringify(seed)).not.toContain("原文正文");
  });

  it("rejects populated fields without a source and malformed persisted data", () => {
    const seed = createProjectSeed({ seedId: "idea:seed", journeyKind: "idea", now: NOW });
    expect(() =>
      updateProjectSeedField(seed, "conflict", {
        values: "失踪事件",
        source: null,
        confirmation: "confirmed",
        origin: "question:conflict",
        updatedAt: LATER,
      }),
    ).toThrow(/requires provenance/u);
    expect(parseProjectSeed({ ...seed, seedId: "" })).toBeNull();
  });
});
