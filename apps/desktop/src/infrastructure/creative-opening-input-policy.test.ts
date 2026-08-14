import { describe, expect, it } from "vitest";

import {
  validateCreativeOpeningDirection,
  validateCreativeOpeningIdea,
  validateCreativeOpeningProse,
} from "./creative-opening-input-policy";
import type { CreativeOpeningInputValidationError } from "./creative-opening-input-policy";

describe("creative opening input policy", () => {
  it("normalizes natural language with NFC without compatibility folding", () => {
    expect(validateCreativeOpeningIdea("  Ａe\u0301  ")).toBe("Ａé");
  });

  it.each([
    ["", "CREATIVE_INPUT_INVALID_EMPTY"],
    ["   ", "CREATIVE_INPUT_INVALID_WHITESPACE_ONLY"],
    ["a", "CREATIVE_INPUT_INVALID_TOO_SHORT"],
    ["有效\u0000文本", "CREATIVE_INPUT_INVALID_CONTROL_CHARACTER"],
  ])("returns an exact safe reason for invalid idea input", (value, code) => {
    expect(() => validateCreativeOpeningIdea(value)).toThrow(
      expect.objectContaining<Partial<CreativeOpeningInputValidationError>>({
        code: code as CreativeOpeningInputValidationError["code"],
      }),
    );
  });

  it("accepts a one-character direction and preserves prose line endings safely", () => {
    expect(validateCreativeOpeningDirection("甜")).toBe("甜");
    expect(validateCreativeOpeningProse("第一行\r\n第二行")).toBe("第一行\n第二行");
  });
});
