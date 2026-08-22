import { describe, expect, it } from "vitest";

import {
  CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION,
  parseContinuationDirectionOptions,
} from "./continuation-direction-options";

describe("continuation direction options", () => {
  it("parses exactly three ordered, unique Chinese directions into friendly options", () => {
    const parsed = parseContinuationDirectionOptions(
      [
        "方向一：让主角循着潮湿脚印进入封闭钟楼",
        "方向二：让失踪姐姐通过旧收音机留下警告",
        "方向三：让港口停电迫使两名对手暂时合作",
      ].join("\r\n"),
    );

    expect(parsed).toEqual({
      ok: true,
      options: [
        {
          id: "continuation-direction-1",
          ordinal: 1,
          label: "方向一",
          text: "让主角循着潮湿脚印进入封闭钟楼",
          displayText: "让主角循着潮湿脚印进入封闭钟楼",
          accessibleLabel: "方向一：让主角循着潮湿脚印进入封闭钟楼",
        },
        {
          id: "continuation-direction-2",
          ordinal: 2,
          label: "方向二",
          text: "让失踪姐姐通过旧收音机留下警告",
          displayText: "让失踪姐姐通过旧收音机留下警告",
          accessibleLabel: "方向二：让失踪姐姐通过旧收音机留下警告",
        },
        {
          id: "continuation-direction-3",
          ordinal: 3,
          label: "方向三",
          text: "让港口停电迫使两名对手暂时合作",
          displayText: "让港口停电迫使两名对手暂时合作",
          accessibleLabel: "方向三：让港口停电迫使两名对手暂时合作",
        },
      ],
    });
  });

  it.each([
    {
      name: "额外解释",
      value: "以下是建议：\n方向一：进入钟楼调查\n方向二：收到姐姐警告\n方向三：与对手合作",
      reason: "wrong_line_count",
    },
    {
      name: "顺序错误",
      value: "方向二：进入钟楼调查\n方向一：收到姐姐警告\n方向三：与对手合作",
      reason: "invalid_line_format",
    },
    {
      name: "项目符号",
      value: "- 方向一：进入钟楼调查\n- 方向二：收到姐姐警告\n- 方向三：与对手合作",
      reason: "invalid_line_format",
    },
    {
      name: "重复方向",
      value: "方向一：进入钟楼调查\n方向二：进入钟楼调查\n方向三：与对手合作",
      reason: "duplicate",
    },
    {
      name: "不可见字符",
      value: "方向一：进入钟楼调查\n方向二：收到\u200b姐姐警告\n方向三：与对手合作",
      reason: "unsafe_character",
    },
    {
      name: "内容过短",
      value: "方向一：走\n方向二：收到姐姐警告\n方向三：与对手合作",
      reason: "invalid_length",
    },
  ])("rejects $name without producing partial options", ({ value, reason }) => {
    const parsed = parseContinuationDirectionOptions(value);

    expect(parsed).toMatchObject({ ok: false, reason });
    if (!parsed.ok) {
      expect(parsed.message).toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it("bounds compact display text without changing the complete continuation instruction", () => {
    const longDirection =
      "让主角在暴雨封港之前沿着废弃电车线追踪一封没有署名的旧信，并在终点发现姐姐留下的第二层暗号与一名不应出现的守夜人正面相遇，从而迫使他重新判断此前的盟友";
    const parsed = parseContinuationDirectionOptions(
      `方向一：${longDirection}\n方向二：让主角先回旅店核对账簿中的日期矛盾\n方向三：让港务长主动登门并提出危险交易`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options[0]?.text).toBe(longDirection.normalize("NFKC"));
    expect(parsed.options[0]?.displayText.endsWith("…")).toBe(true);
    expect(Array.from(parsed.options[0]?.displayText ?? "")).toHaveLength(72);
  });

  it("publishes the exact three-line contract used by the generation prompt", () => {
    expect(CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION).toContain("只返回三行");
    expect(CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION).toContain("方向一：");
    expect(CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION).toContain("方向二：");
    expect(CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION).toContain("方向三：");
    expect(CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION).toContain("彼此明显不同");
  });
});
