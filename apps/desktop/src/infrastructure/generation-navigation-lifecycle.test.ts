import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentGenerationNavigationGuard,
  registerGenerationNavigationGuard,
} from "./generation-navigation-lifecycle";

describe("generation navigation lifecycle", () => {
  let releaseActive: (() => void) | null = null;

  afterEach(() => {
    releaseActive?.();
    releaseActive = null;
  });

  it("shares one stop settlement across repeated route, button and close requests", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopAndPreserve = vi.fn(() => stopGate);
    releaseActive = registerGenerationNavigationGuard({
      id: "generation-once",
      actionLabel: "续写",
      stopAndPreserve,
    });
    const guard = currentGenerationNavigationGuard();
    if (guard === null) throw new Error("Expected the registered navigation guard.");

    const first = guard.stopAndPreserve();
    const second = guard.stopAndPreserve();
    const third = guard.stopAndPreserve();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(stopAndPreserve).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(stopAndPreserve).toHaveBeenCalledOnce();
    releaseStop();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("allows an explicit retry only after the shared stop settlement fails", async () => {
    const stopAndPreserve = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first settlement failed"))
      .mockResolvedValueOnce();
    releaseActive = registerGenerationNavigationGuard({
      id: "generation-retry-after-failure",
      actionLabel: "改写",
      stopAndPreserve,
    });
    const guard = currentGenerationNavigationGuard();
    if (guard === null) throw new Error("Expected the registered navigation guard.");

    const first = guard.stopAndPreserve();
    const shared = guard.stopAndPreserve();
    expect(first).toBe(shared);
    await expect(first).rejects.toThrow("first settlement failed");
    await expect(guard.stopAndPreserve()).resolves.toBeUndefined();
    expect(stopAndPreserve).toHaveBeenCalledTimes(2);
  });
});
