import type { CloudMaintenanceRunResult } from "../postgres/maintenance-worker.js";

export interface CloudMaintenanceRunnable {
  runOnce(signal?: AbortSignal): Promise<CloudMaintenanceRunResult>;
}

export interface PeriodicCloudMaintenanceOptions {
  readonly clock?: () => Date;
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly worker: CloudMaintenanceRunnable;
}

export async function runPeriodicCloudMaintenance(
  options: PeriodicCloudMaintenanceOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Cloud maintenance interval must be a positive safe integer.");
  }
  const clock = options.clock ?? (() => new Date());
  const wait = options.wait ?? waitForAbortableDelay;
  while (!isAbortRequested(options.signal)) {
    try {
      await options.worker.runOnce(options.signal);
    } catch (error: unknown) {
      options.onError?.(error);
    }
    if (isAbortRequested(options.signal)) {
      return;
    }
    const startedWaitingAt = clock();
    if (!Number.isFinite(startedWaitingAt.getTime())) {
      throw new Error("Cloud maintenance runner clock returned an invalid date.");
    }
    await wait(options.intervalMs, options.signal);
  }
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return Promise.reject(new Error("Cloud maintenance delay must be a positive safe integer."));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
