import { describe, expect, it } from "vitest";
import {
  contextEntryExcerpt,
  formatRequirementConfirmationSummary,
} from "./story-context-presentation";

describe("ordinary story material excerpts", () => {
  it("shows the actual current requirement with a bounded preview instead of a placeholder", () => {
    expect(formatRequirementConfirmationSummary("  保留克制语气，不增加新人物。  ")).toBe(
      "保留克制语气，不增加新人物。",
    );
    const long = "保留作者原句。".repeat(20);
    expect(formatRequirementConfirmationSummary(long)).toBe(
      Array.from(long).slice(0, 60).join("") + "…（展开详情查看完整要求）",
    );
    expect(formatRequirementConfirmationSummary(null)).toBe("未填写额外要求");
  });
  it("shows confirmed status and Chinese type without exposing structured metadata", () => {
    const entry = {
      id: "story-fact:example:r1",
      content:
        '[用户已确认的正式事实]\n类型：character_state\n内容：陈九目前受了重伤。\n结构化值：{"privateExtension":"unchanged"}',
    };
    const before = JSON.stringify(entry);
    expect(contextEntryExcerpt(entry)).toBe("正式设定／已确认 · 人物状态：陈九目前受了重伤。");
    expect(JSON.stringify(entry)).toBe(before);
  });
  it("keeps unknown fields out of ordinary text without guessing their meaning", () => {
    expect(
      contextEntryExcerpt({
        id: "story-fact:example:r2",
        content:
          '[用户已确认的正式事实]\n类型：future_extension\n结构化值：{"character.statement.from":"unresolved"}',
      }),
    ).toBe("正式设定／已确认 · 其他设定：结构化资料已保留，请到设定页核对。");
  });
  it("does not strip author-authored text that merely resembles internal metadata", () => {
    expect(
      contextEntryExcerpt({
        id: "current-task",
        content: "类型：character_state 是故事中出现的一行文字。",
      }),
    ).toBe("类型：character_state 是故事中出现的一行文字。");
  });
});
