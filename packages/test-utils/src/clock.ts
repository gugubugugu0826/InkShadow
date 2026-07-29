import type { TestOnlyContext } from "./runtime.js";

export interface DeterministicClock {
  now(): Date;
  nowIso(): string;
  advance(milliseconds: number): void;
  set(instant: Date | string | number): void;
}

function toTimestamp(instant: Date | string | number): number {
  const timestamp = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Deterministic clock requires a valid instant.");
  }
  return timestamp;
}

export function createDeterministicClock(
  context: TestOnlyContext,
  start: Date | string | number = "2026-01-01T00:00:00.000Z",
  tickMilliseconds = 0,
): DeterministicClock {
  void context;
  if (!Number.isSafeInteger(tickMilliseconds) || tickMilliseconds < 0) {
    throw new Error("tickMilliseconds must be a non-negative safe integer.");
  }

  let currentTimestamp = toTimestamp(start);

  const read = (): Date => {
    const current = new Date(currentTimestamp);
    currentTimestamp += tickMilliseconds;
    return current;
  };

  return {
    now: read,
    nowIso: () => read().toISOString(),
    advance(milliseconds) {
      if (!Number.isSafeInteger(milliseconds)) {
        throw new Error("Clock advances must use safe integer milliseconds.");
      }
      currentTimestamp += milliseconds;
    },
    set(instant) {
      currentTimestamp = toTimestamp(instant);
    },
  };
}
