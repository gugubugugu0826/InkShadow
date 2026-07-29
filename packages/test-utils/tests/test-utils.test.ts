import { describe, expect, it } from "vitest";

import {
  UnsafeTestUtilityUsageError,
  createDeterministicClock,
  createDeterministicUuidFactory,
  createTestBuilder,
  createTestOnlyContext,
} from "../src/index.js";

describe("test-only runtime guard", () => {
  it("refuses production and development runtime labels", () => {
    expect(() => createTestOnlyContext("production")).toThrow(UnsafeTestUtilityUsageError);
    expect(() => createTestOnlyContext("development")).toThrow(UnsafeTestUtilityUsageError);
  });
});

describe("deterministic clock", () => {
  it("advances only by explicit or configured deterministic amounts", () => {
    const context = createTestOnlyContext("test");
    const clock = createDeterministicClock(context, "2026-07-27T00:00:00.000Z", 10);

    expect(clock.nowIso()).toBe("2026-07-27T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-07-27T00:00:00.010Z");
    clock.advance(990);
    expect(clock.nowIso()).toBe("2026-07-27T00:00:01.010Z");
  });
});

describe("deterministic UUIDv7", () => {
  it("produces repeatable, unique, valid-looking UUIDv7 values", () => {
    const context = createTestOnlyContext("test");
    const firstFactory = createDeterministicUuidFactory(context, {
      timestamp: "2026-07-27T00:00:00.000Z",
    });
    const secondFactory = createDeterministicUuidFactory(context, {
      timestamp: "2026-07-27T00:00:00.000Z",
    });

    const first = firstFactory();
    const second = firstFactory();

    expect(first).toBe(secondFactory());
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("deterministic builders", () => {
  it("creates frozen values with explicit shallow overrides", () => {
    const context = createTestOnlyContext("test");
    const builder = createTestBuilder(context, (sequence) => ({
      id: `entity-${String(sequence)}`,
      state: "ready",
    }));

    const first = builder.build();
    const second = builder.build({
      state: "failed",
    });

    expect(first).toEqual({
      id: "entity-0",
      state: "ready",
    });
    expect(second).toEqual({
      id: "entity-1",
      state: "failed",
    });
    expect(Object.isFrozen(first)).toBe(true);
  });
});
