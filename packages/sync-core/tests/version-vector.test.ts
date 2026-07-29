import { describe, expect, it } from "vitest";

import {
  compareVersionVectors,
  decideIncomingMutation,
  incrementVersionVector,
  mergeVersionVectors,
  normalizeVersionVector,
} from "../src/index.js";

describe("version vectors", () => {
  it("increments only the active device and preserves a normalized order", () => {
    expect(incrementVersionVector({ "device-b": 2 }, "device-a")).toEqual({
      "device-a": 1,
      "device-b": 2,
    });
  });

  it("distinguishes equal, causal, and concurrent histories without timestamps", () => {
    expect(compareVersionVectors({ a: 1 }, { a: 1 })).toBe("equal");
    expect(compareVersionVectors({ a: 1 }, { a: 2 })).toBe("before");
    expect(compareVersionVectors({ a: 3, b: 2 }, { a: 2, b: 2 })).toBe("after");
    expect(compareVersionVectors({ a: 2 }, { b: 2 })).toBe("concurrent");
  });

  it("maps causal relations to explicit incoming mutation decisions", () => {
    expect(decideIncomingMutation({ a: 1 }, { a: 1 })).toBe("duplicate");
    expect(decideIncomingMutation({ a: 1 }, { a: 2 })).toBe("apply");
    expect(decideIncomingMutation({ a: 2 }, { a: 1 })).toBe("ignore");
    expect(decideIncomingMutation({ a: 2 }, { b: 1 })).toBe("conflict");
  });

  it("merges by per-device maximum", () => {
    expect(mergeVersionVectors({ a: 4, b: 1 }, { a: 2, b: 3, c: 1 })).toEqual({
      a: 4,
      b: 3,
      c: 1,
    });
  });

  it("rejects unsafe keys, zero counters, and unbounded vectors", () => {
    expect(() => normalizeVersionVector(Object.fromEntries([["__proto__", 1]]))).toThrow();
    expect(() => normalizeVersionVector({ a: 0 })).toThrow();
    expect(() =>
      normalizeVersionVector(
        Object.fromEntries(
          Array.from({ length: 1_025 }, (_, index) => [`device-${String(index)}`, 1]),
        ),
      ),
    ).toThrow();
  });
});
