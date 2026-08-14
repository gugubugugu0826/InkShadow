export type GuidedOpeningInputValidation = "not_checked" | "valid" | "invalid";

export interface SafeGuidedOpeningStatus {
  readonly inputValidation: GuidedOpeningInputValidation;
  readonly batchId: string | null;
  readonly batchState: "idle" | "pending" | "settled";
  readonly slotStates: readonly ("pending" | "ready" | "partial" | "failed")[];
  readonly selectedSlot: string | null;
  readonly plannerMode: "not_started" | "planning" | "ai" | "deterministic_fallback";
  readonly questionCount: number;
  readonly currentQuestion: string | null;
  readonly lastError: string | null;
}

const statusByRuntime = new WeakMap<object, SafeGuidedOpeningStatus>();

export function recordSafeGuidedOpeningStatus(
  runtime: object,
  status: SafeGuidedOpeningStatus,
): void {
  statusByRuntime.set(runtime, freezeStatus(status));
}

export function readSafeGuidedOpeningStatus(runtime: object): SafeGuidedOpeningStatus | null {
  return statusByRuntime.get(runtime) ?? null;
}

function freezeStatus(status: SafeGuidedOpeningStatus): SafeGuidedOpeningStatus {
  return Object.freeze({
    ...status,
    slotStates: Object.freeze([...status.slotStates]),
    lastError:
      status.lastError !== null && /^[A-Z][A-Z0-9_]{2,80}$/u.test(status.lastError)
        ? status.lastError
        : null,
  });
}
