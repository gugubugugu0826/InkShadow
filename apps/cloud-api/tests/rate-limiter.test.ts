import { describe, expect, it } from "vitest";

import { InMemoryFixedWindowRateLimiter } from "../src/http/rate-limiter.js";

describe("cloud API rate limiter", () => {
  it("rejects requests beyond a fixed bound and opens a fresh window", async () => {
    const limiter = new InMemoryFixedWindowRateLimiter();
    const firstWindow = new Date("2026-07-27T12:00:00.000Z");

    await expect(
      limiter.consume({ key: "login:ip", limit: 2, now: firstWindow, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ key: "login:ip", limit: 2, now: firstWindow, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ key: "login:ip", limit: 2, now: firstWindow, windowMs: 60_000 }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    await expect(
      limiter.consume({
        key: "login:ip",
        limit: 2,
        now: new Date(firstWindow.getTime() + 60_000),
        windowMs: 60_000,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("fails closed when the bounded key map is exhausted", async () => {
    const limiter = new InMemoryFixedWindowRateLimiter(1);
    const now = new Date("2026-07-27T12:00:00.000Z");

    await expect(
      limiter.consume({ key: "first", limit: 1, now, windowMs: 60_000 }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ key: "second", limit: 1, now, windowMs: 60_000 }),
    ).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });
});
