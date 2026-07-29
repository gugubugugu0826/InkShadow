import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_EXCERPT_LENGTH, createEvidence, createStoryValue } from "../src/index.js";

describe("bounded story evidence", () => {
  it("rejects overlong excerpts instead of storing source text", () => {
    const excerpt = "x".repeat(MAX_EVIDENCE_EXCERPT_LENGTH + 1);
    const result = createEvidence({
      excerpt,
      start: 0,
      end: excerpt.length,
      sourceLength: excerpt.length + 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_EVIDENCE_TOO_LONG");
    }
  });

  it("rejects a whole source disguised as evidence", () => {
    const result = createEvidence({
      excerpt: "entire source",
      start: 0,
      end: 13,
      sourceLength: 13,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_EVIDENCE_RANGE_INVALID");
    }
  });

  it("requires an exact evidence range", () => {
    const result = createEvidence({
      excerpt: "six!!!",
      start: 10,
      end: 15,
      sourceLength: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_EVIDENCE_RANGE_INVALID");
    }
  });

  it("rejects credential-like evidence and formal values", () => {
    const evidence = createEvidence({
      excerpt: "Bearer abcdefghijklmnop",
      start: 4,
      end: 27,
      sourceLength: 100,
    });
    expect(evidence.ok).toBe(false);
    if (!evidence.ok) {
      expect(evidence.error.code).toBe("STORY_SENSITIVE_DATA_REJECTED");
    }

    const sensitiveKey = ["access", "Token"].join("");
    const value = createStoryValue({
      [sensitiveKey]: "placeholder",
      character: "Lin",
    });
    expect(value.ok).toBe(false);
    if (!value.ok) {
      expect(value.error.code).toBe("STORY_SENSITIVE_DATA_REJECTED");
    }
  });
});
