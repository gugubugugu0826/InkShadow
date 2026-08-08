import { describe, expect, it, vi } from "vitest";

import type { AutomaticBackupRuntime } from "./automatic-backup-runtime";
import {
  attachAcceptedChapterPipelineWorker,
  attachAutomaticBackupRuntime,
  createDevelopmentRuntime,
  type DesktopRuntime,
} from "./runtime";

describe("automatic backup runtime wiring", () => {
  it("keeps browser development explicitly unavailable", () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect(runtime.mode).toBe("browser-development");
    expect(runtime.automaticBackup).toBeNull();
  });

  it("stops the timer-backed runtime before closing the SQLite runtime and is idempotent", async () => {
    const calls: string[] = [];
    const development = createDevelopmentRuntime(window.localStorage);
    const baseClose = vi.fn(() => {
      calls.push("database");
      return Promise.resolve();
    });
    const base: DesktopRuntime = { ...development, close: baseClose };
    const stopAutomatic = vi.fn(() => {
      calls.push("automatic-backup");
      return Promise.resolve();
    });
    const automatic = fakeAutomaticBackup(stopAutomatic);
    const runtime = attachAutomaticBackupRuntime(base, automatic);

    await Promise.all([runtime.close(), runtime.close()]);

    expect(calls).toEqual(["automatic-backup", "database"]);
    expect(stopAutomatic).toHaveBeenCalledOnce();
    expect(baseClose).toHaveBeenCalledOnce();
  });

  it("still closes the database when automatic-backup shutdown reports a failure", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const baseClose = vi.fn().mockResolvedValue(undefined);
    const base: DesktopRuntime = { ...development, close: baseClose };
    const automatic = fakeAutomaticBackup(() =>
      Promise.reject(new Error("automatic backup stop failed")),
    );
    const runtime = attachAutomaticBackupRuntime(base, automatic);

    await expect(runtime.close()).rejects.toThrow("automatic backup stop failed");
    expect(baseClose).toHaveBeenCalledOnce();
  });

  it("stops accepted正文 recovery before the wrapped runtime and remains idempotent", async () => {
    const calls: string[] = [];
    const development = createDevelopmentRuntime(window.localStorage);
    const baseClose = vi.fn(() => {
      calls.push("wrapped-runtime");
      return Promise.resolve();
    });
    const base: DesktopRuntime = { ...development, close: baseClose };
    const stopWorker = vi.fn(() => {
      calls.push("accepted-version-worker");
      return Promise.resolve();
    });
    const runtime = attachAcceptedChapterPipelineWorker(base, { stop: stopWorker });

    await Promise.all([runtime.close(), runtime.close()]);

    expect(calls).toEqual(["accepted-version-worker", "wrapped-runtime"]);
    expect(stopWorker).toHaveBeenCalledOnce();
    expect(baseClose).toHaveBeenCalledOnce();
  });
});

function fakeAutomaticBackup(stop: () => Promise<void>): AutomaticBackupRuntime & {
  readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    available: true,
    start: vi.fn(),
    checkNow: vi.fn().mockResolvedValue({ state: "ready", run: null, errorCode: null }),
    stop: vi.fn(stop),
  };
}
