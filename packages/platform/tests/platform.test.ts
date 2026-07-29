import { describe, expect, it } from "vitest";

import { CryptoContentHasher, CryptoUuidV7Generator, SystemClock } from "../src/index.js";

describe("SystemClock", () => {
  it("returns a branded UTC timestamp from the host clock", () => {
    const clock = new SystemClock(() => new Date("2026-07-27T01:02:03.004Z"));

    expect(clock.now()).toBe("2026-07-27T01:02:03.004Z");
  });
});

describe("CryptoContentHasher", () => {
  it("calculates a stable SHA-256 checksum without retaining the content", async () => {
    const result = await new CryptoContentHasher().sha256("墨影");

    expect(result).toEqual({
      ok: true,
      value: "14eab5e43d46ff4d6637c1838dfae472ac83bef095355f506d890e4dfa381837",
    });
  });

  it("returns a recoverable error when the crypto provider fails", async () => {
    const hasher = new CryptoContentHasher({
      digest: () => Promise.reject(new Error("unavailable")),
    });

    const result = await hasher.sha256("private chapter");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SAVE_FAILED");
      expect(result.error.details).not.toHaveProperty("content");
    }
  });
});

describe("CryptoUuidV7Generator", () => {
  it("sets the version and variant bits", () => {
    const generator = new CryptoUuidV7Generator(
      () => 1_785_087_723_004,
      (buffer) => buffer.fill(0xa5),
    );

    const value = generator.next();

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is lexically monotonic when several identifiers share a millisecond", () => {
    const generator = new CryptoUuidV7Generator(
      () => 1_785_087_723_004,
      (buffer) => buffer.fill(0),
    );

    const values = [generator.next(), generator.next(), generator.next()];

    expect([...values].sort()).toEqual(values);
    expect(new Set(values)).toHaveLength(3);
  });
});
