import { describe, expect, it, vi } from "vitest";

import { createRetryableLazyRepairLoader } from "./consistency-investigation-tauri-factory";

describe("consistency repair action loader", () => {
  it("shares one initialization across concurrent and later repair actions", async () => {
    const service = Object.freeze({ kind: "repair" });
    const initialize = vi.fn(() => Promise.resolve(service));
    const load = createRetryableLazyRepairLoader(initialize);

    const [first, second, third] = await Promise.all([load(), load(), load()]);

    expect(first).toBe(service);
    expect(second).toBe(service);
    expect(third).toBe(service);
    await expect(load()).resolves.toBe(service);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("clears a failed dynamic load and initializes once on an explicit retry", async () => {
    const service = Object.freeze({ kind: "repair" });
    const initialize = vi
      .fn<() => Promise<typeof service>>()
      .mockRejectedValueOnce(new Error("temporary chunk load failure"))
      .mockResolvedValue(service);
    const load = createRetryableLazyRepairLoader(initialize);

    await expect(load()).rejects.toThrow("temporary chunk load failure");
    await expect(load()).resolves.toBe(service);
    await expect(load()).resolves.toBe(service);

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
