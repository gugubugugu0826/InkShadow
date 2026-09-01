import { describe, expect, it } from "vitest";

import {
  assertVisibleProseOutput,
  type VisibleProseOutputError,
  type VisibleProseOutputErrorCode,
} from "../src/index.js";

describe("visible prose output contract", () => {
  const invalidOutputs: readonly Readonly<
    [label: string, output: string, code: VisibleProseOutputErrorCode]
  >[] = [
    ["leading explanation", "下面是续写内容：\n雨声落在檐下。", "MODEL_VISIBLE_PROSE_OUTPUT_META"],
    [
      "leading writer decision",
      "我决定让主角先打开门。\n雨声落在檐下。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "leading creation approach",
      "我的创作思路是先让门后的声音出现。\n雨声落在檐下。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "reasoning tag",
      "<think>先安排冲突</think>\n雨声落在檐下。",
      "MODEL_VISIBLE_PROSE_OUTPUT_INTERNAL_TAG",
    ],
    ["markdown fence", "```text\n雨声落在檐下。\n```", "MODEL_VISIBLE_PROSE_OUTPUT_CODE_FENCE"],
    [
      "structured payload",
      '{"analysis":"先制造悬念","text":"雨声落在檐下。"}',
      "MODEL_VISIBLE_PROSE_OUTPUT_STRUCTURED",
    ],
    [
      "trailing creation note",
      "雨声落在檐下。\n\n创作说明：这里用雨声制造悬念。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "trailing creation analysis",
      "雨声落在檐下。\n\n创作分析：这一段建立了悬念。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "trailing plain analysis",
      "雨声落在檐下。\n\n分析：这一段建立了悬念。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "trailing plain explanation",
      "雨声落在檐下。\n\n说明：下一段可以切换视角。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "trailing note",
      "雨声落在檐下。\n\n备注：这里没有补充新的设定。",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
    [
      "trailing English analysis",
      "雨声落在檐下。\n\nAnalysis: This scene establishes suspense.",
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
    ],
  ];

  it.each(invalidOutputs)(
    "rejects %s instead of treating it as reviewable prose",
    (_label, output, code: VisibleProseOutputErrorCode) => {
      expect(() => assertVisibleProseOutput(output)).toThrow(
        expect.objectContaining<Partial<VisibleProseOutputError>>({ code }),
      );
    },
  );

  it("rejects an over-limit response without trimming or rewriting it", () => {
    const output = "雨".repeat(101);
    expect(() => assertVisibleProseOutput(output, { maximumVisibleCharacters: 100 })).toThrow(
      expect.objectContaining<Partial<VisibleProseOutputError>>({
        code: "MODEL_VISIBLE_PROSE_OUTPUT_TOO_LONG",
        visibleCharacters: 101,
      }),
    );
    expect(output).toBe("雨".repeat(101));
  });

  it("accepts ordinary fiction even when dialogue mentions analysis or code", () => {
    const prose = "“别再分析了。”林舟合上电脑，屏幕里的代码随即熄灭。";
    expect(assertVisibleProseOutput(prose)).toEqual({
      text: prose,
      visibleCharacters: Array.from(prose).length,
    });
  });

  it.each([
    "我决定先打开门。\n雨声从门缝里涌进来。",
    "“我决定让主角先打开门。”导演合上分镜本。",
    "雨声落在檐下，我的创作思路是她留给林舟的最后一句话。",
  ])("keeps first-person fiction reviewable: %s", (prose) => {
    expect(assertVisibleProseOutput(prose)).toEqual({
      text: prose,
      visibleCharacters: Array.from(prose).length,
    });
  });
});
