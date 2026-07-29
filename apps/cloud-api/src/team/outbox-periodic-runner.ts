import { waitForAbortableDelay } from "../maintenance/periodic-runner.js";

export interface TeamInvitationOutboxRunnable {
  runOnce(): Promise<unknown>;
}

export interface PeriodicTeamInvitationOutboxOptions {
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly worker: TeamInvitationOutboxRunnable;
}

export async function runPeriodicTeamInvitationOutbox(
  options: PeriodicTeamInvitationOutboxOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) {
    throw new Error("The team-invitation outbox interval must be at least one second.");
  }
  const wait = options.wait ?? waitForAbortableDelay;
  while (!isAborted(options.signal)) {
    try {
      await options.worker.runOnce();
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
