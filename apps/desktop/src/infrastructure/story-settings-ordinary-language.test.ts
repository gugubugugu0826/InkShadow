import { describe, expect, it } from "vitest";

import {
  ordinaryStorySettingsIssueAction,
  ordinaryStorySettingsIssueLocation,
  ordinaryStorySettingsIssueMessage,
} from "./story-settings-ordinary-language";

describe("story settings ordinary language", () => {
  it("projects an unknown internal path without exposing its field name", () => {
    const issue = {
      severity: "blocking" as const,
      code: "UNKNOWN_FIELD" as const,
      path: "$.characters[0].hidden_internal_field",
      message: "字段“hidden_internal_field”无法识别。",
      suggestedAction: "删除该字段。",
    };

    expect(ordinaryStorySettingsIssueLocation(issue)).toBe("人物第 1 项 → 未识别内容");
    expect(ordinaryStorySettingsIssueMessage(issue)).toBe(
      "发现当前版本不认识的内容；为避免遗漏，本次导入已停止。",
    );
    expect(ordinaryStorySettingsIssueAction(issue)).not.toMatch(
      /hidden_internal_field|UNKNOWN_FIELD/u,
    );
  });

  it("names a missing relationship endpoint in natural Chinese", () => {
    const issue = {
      severity: "blocking" as const,
      code: "RELATIONSHIP_ENDPOINT_MISSING" as const,
      path: "$.relationships[1].fromCharacterRef",
      message: "关系端点不在 characters 中。",
      suggestedAction: "改为有效的人物 id。",
    };

    expect(ordinaryStorySettingsIssueLocation(issue)).toBe("人物关系第 2 项 → 起点人物");
    expect(ordinaryStorySettingsIssueMessage(issue)).toBe("人物关系的一端没有对应的人物。");
    expect(ordinaryStorySettingsIssueAction(issue)).toBe(
      "补充对应人物，或重新选择关系两端的人物。",
    );
  });

  it("projects a yes-or-no field without exposing boolean literals", () => {
    const issue = {
      severity: "blocking" as const,
      code: "FIELD_INVALID" as const,
      path: "$.characters[0].locked",
      message: "该字段必须是 true 或 false。",
      suggestedAction: "删除字段以使用默认值，或填写布尔值。",
    };

    expect(ordinaryStorySettingsIssueLocation(issue)).toBe("人物第 1 项 → 是否固定");
    expect(ordinaryStorySettingsIssueMessage(issue)).toBe("“是否固定”只能填写“是”或“否”。");
    expect(ordinaryStorySettingsIssueAction(issue)).toBe(
      "删除这项以使用默认选择，或明确选择“是”或“否”。",
    );
    expect(
      [ordinaryStorySettingsIssueMessage(issue), ordinaryStorySettingsIssueAction(issue)].join(" "),
    ).not.toMatch(/true|false|boolean|布尔值/u);
  });
  it("projects old guided-opening references as ordinary Chinese", () => {
    const issue = {
      severity: "blocking" as const,
      code: "FIELD_INVALID" as const,
      path: "$.characters[0].role",
      message: "guided_opening.characters 的 id 不能是 true 或 false。",
      suggestedAction: "修正 guided_opening.characters 后重试。",
    };
    const projected = [
      ordinaryStorySettingsIssueMessage(issue),
      ordinaryStorySettingsIssueAction(issue),
    ].join(" ");

    expect(projected).toContain("旧版开书资料");
    expect(projected).not.toMatch(/guided_opening|\bid\b|true|false/u);
  });
});
