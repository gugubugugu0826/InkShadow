import { waitForAbortableDelay } from "../maintenance/periodic-runner.js";

export interface CloudDeletionRunnable {
  runOnce(signal?: AbortSignal): Promise<unknown>;
}

export interface PeriodicCloudDeletionOptions {
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly worker: CloudDeletionRunnable;
}

export async function runPeriodicCloudDeletion(
  options: PeriodicCloudDeletionOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Cloud deletion interval must be a positive safe integer.");
  }
  const wait = options.wait ?? waitForAbortableDelay;
  while (!options.signal.aborted) {
    try {
      await options.worker.runOnce(options.signal);
    } catch (error: unknown) {
      options.onError?.(error);
    }
    if (isAborted(options.signal)) {
      return;
    }
    await wait(options.intervalMs, options.signal);
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
