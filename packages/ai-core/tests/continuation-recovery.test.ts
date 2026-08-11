import { describe, expect, it } from "vitest";

import { combineContinuationFragments, recoverVisiblePartialOutput } from "../src/index.js";

describe("continuation recovery", () => {
  it("preserves all visible prose while recording the last complete sentence", () => {
    const result = recoverVisiblePartialOutput(
      `${"这是已经生成的正文。".repeat(8)}最后一句还没有写完`,
      40,
    );
    expect(result.preserved).toBe(true);
    expect(result.boundary).toBe("complete_sentence");
    expect(result.text.endsWith("最后一句还没有写完")).toBe(true);
    expect(result.displayText.endsWith("正文。")).toBe(true);
    expect(result.droppedTrailingCharacters).toBe("最后一句还没有写完".length);
  });

  it("preserves a short visible fragment instead of discarding provider output", () => {
    expect(recoverVisiblePartialOutput("半句话", 20)).toMatchObject({
      text: "半句话",
      displayText: "半句话",
      preserved: true,
      boundary: "all_visible",
    });
  });

  it("removes a repeated overlap longer than the old preview window in linear time", () => {
    const overlap = `场景开始。${"雨落长街，灯影摇晃。".repeat(100)}`;
    expect(combineContinuationFragments(`前文。${overlap}`, `${overlap}她推门而入。`)).toBe(
      `前文。${overlap}\n\n她推门而入。`,
    );
  });

  it("removes repeated overlap when a partial candidate is resumed", () => {
    const overlap = "她推开门，看见雨落满长街。又听见脚步声逼近。";
    expect(combineContinuationFragments(`上一段。${overlap}`, `${overlap}她继续向前走。`)).toBe(
      `上一段。${overlap}\n\n她继续向前走。`,
    );
  });

  it("removes a short overlap only when it includes a sentence boundary", () => {
    expect(combineContinuationFragments("前文。雨停了。", "雨停了。她出门。")).toBe(
      "前文。雨停了。\n\n她出门。",
    );
  });

  it("does not erase an ordinary repeated phrase without a reliable boundary", () => {
    expect(combineContinuationFragments("他看着她", "他看着她没有说话")).toBe(
      "他看着她\n\n他看着她没有说话",
    );
    expect(combineContinuationFragments("上一段结束", "全新的下一段")).toBe(
      "上一段结束全新的下一段",
    );
  });

  it("continues an unfinished sentence without inserting a paragraph break", () => {
    expect(combineContinuationFragments("我推开门，看见", "她站在雨里。")).toBe(
      "我推开门，看见她站在雨里。",
    );
    expect(combineContinuationFragments("我已经说完。", "她没有回答。")).toBe(
      "我已经说完。\n\n她没有回答。",
    );
  });
});
