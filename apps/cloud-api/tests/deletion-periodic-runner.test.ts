import { describe, expect, it, vi } from "vitest";

import { runPeriodicCloudDeletion } from "../src/deletion/periodic-runner.js";

describe("periodic cloud deletion runner", () => {
  it("runs immediately, contains an iteration failure and stops on abort", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    const worker = {
      runOnce: vi
        .fn()
        .mockRejectedValueOnce(new Error("sensitive provider detail"))
        .mockImplementationOnce(() => {
          controller.abort();
          return Promise.resolve({});
        }),
    };
    const wait = vi.fn(() => Promise.resolve());

    await runPeriodicCloudDeletion({
      intervalMs: 1,
      onError,
      signal: controller.signal,
      wait,
      worker,
    });

    expect(worker.runOnce).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid interval before invoking the worker", async () => {
    const worker = { runOnce: vi.fn(() => Promise.resolve({})) };
    await expect(
      runPeriodicCloudDeletion({
        intervalMs: 0,
        signal: new AbortController().signal,
        worker,
      }),
    ).rejects.toThrow("positive");
    expect(worker.runOnce).not.toHaveBeenCalled();
  });
});
