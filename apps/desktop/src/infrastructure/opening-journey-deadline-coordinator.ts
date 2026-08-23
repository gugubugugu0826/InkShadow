import { parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/domain";

export interface OpeningJourneyDeadlineScope {
  readonly journeyId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly supportId: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
}

export interface OpeningJourneyDeadlineHandlers {
  readonly onDeadline: (scope: OpeningJourneyDeadlineScope) => void | Promise<void>;
  readonly onFailure: (scope: OpeningJourneyDeadlineScope, cause: unknown) => void | Promise<void>;
}

interface ArmedOpeningJourneyDeadline {
  readonly scope: OpeningJourneyDeadlineScope;
  readonly handlers: OpeningJourneyDeadlineHandlers;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const deadlinesByOwner = new WeakMap<object, Map<string, ArmedOpeningJourneyDeadline>>();
const settlementsByOwner = new WeakMap<object, Map<string, Promise<void>>>();

export function armOpeningJourneyDeadline(
  owner: object,
  input: OpeningJourneyDeadlineScope,
  handlers: OpeningJourneyDeadlineHandlers,
): void {
  const scope = normalizeScope(input);
  const deadlines = deadlinesFor(owner);
  const current = deadlines.get(scope.journeyId);
  if (current !== undefined) {
    if (compareRunOrder(scope, current.scope) < 0) {
      return;
    }
    globalThis.clearTimeout(current.timer);
  }
  const armed: ArmedOpeningJourneyDeadline = {
    scope,
    handlers,
    timer: undefined as unknown as ReturnType<typeof globalThis.setTimeout>,
  };
  deadlines.set(scope.journeyId, armed);
  scheduleDeadline(owner, armed);
}

export function disarmOpeningJourneyDeadline(
  owner: object,
  input: Readonly<{
    journeyId: string;
    batchId: string;
    supportId: string;
  }>,
): void {
  const deadlines = deadlinesByOwner.get(owner);
  const current = deadlines?.get(input.journeyId);
  if (current?.scope.batchId !== input.batchId || current.scope.supportId !== input.supportId) {
    return;
  }
  globalThis.clearTimeout(current.timer);
  deadlines?.delete(input.journeyId);
  if (deadlines?.size === 0) deadlinesByOwner.delete(owner);
}

export async function settleOpeningJourneyDeadlineOnce(
  owner: object,
  input: OpeningJourneyDeadlineScope,
  settlement: (scope: OpeningJourneyDeadlineScope) => void | Promise<void>,
): Promise<void> {
  const scope = normalizeScope(input);
  const settlements = settlementsFor(owner);
  const key = [
    scope.journeyId,
    scope.batchId,
    scope.taskId,
    scope.supportId,
    scope.deadlineAt,
  ].join(":");
  const existing = settlements.get(key);
  if (existing !== undefined) {
    await existing;
    return;
  }
  const pending = Promise.resolve().then(() => settlement(scope));
  settlements.set(key, pending);
  try {
    await pending;
  } catch (cause: unknown) {
    if (settlements.get(key) === pending) {
      settlements.delete(key);
      if (settlements.size === 0) settlementsByOwner.delete(owner);
    }
    throw cause;
  }
}

export function clearOpeningJourneyDeadlinesForTests(owner: object): void {
  const deadlines = deadlinesByOwner.get(owner);
  if (deadlines !== undefined) {
    for (const armed of deadlines.values()) {
      globalThis.clearTimeout(armed.timer);
    }
    deadlines.clear();
    deadlinesByOwner.delete(owner);
  }
  settlementsByOwner.delete(owner);
}

function scheduleDeadline(owner: object, armed: ArmedOpeningJourneyDeadline): void {
  const remaining = Date.parse(armed.scope.deadlineAt) - Date.now();
  const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS));
  armed.timer = globalThis.setTimeout(() => {
    void fireDeadline(owner, armed);
  }, delay);
}

async function fireDeadline(owner: object, armed: ArmedOpeningJourneyDeadline): Promise<void> {
  const deadlines = deadlinesByOwner.get(owner);
  if (deadlines?.get(armed.scope.journeyId) !== armed) return;
  if (Date.now() < Date.parse(armed.scope.deadlineAt)) {
    scheduleDeadline(owner, armed);
    return;
  }
  deadlines.delete(armed.scope.journeyId);
  if (deadlines.size === 0) deadlinesByOwner.delete(owner);
  try {
    await armed.handlers.onDeadline(armed.scope);
  } catch (cause: unknown) {
    try {
      await armed.handlers.onFailure(armed.scope, cause);
    } catch {
      globalThis.console.error("[OPENING_DEADLINE_FAILURE_REPORT_FAILED]");
    }
  }
}

function deadlinesFor(owner: object): Map<string, ArmedOpeningJourneyDeadline> {
  const current = deadlinesByOwner.get(owner);
  if (current !== undefined) return current;
  const created = new Map<string, ArmedOpeningJourneyDeadline>();
  deadlinesByOwner.set(owner, created);
  return created;
}

function settlementsFor(owner: object): Map<string, Promise<void>> {
  const current = settlementsByOwner.get(owner);
  if (current !== undefined) return current;
  const created = new Map<string, Promise<void>>();
  settlementsByOwner.set(owner, created);
  return created;
}

function normalizeScope(input: OpeningJourneyDeadlineScope): OpeningJourneyDeadlineScope {
  const startedAt = parseIsoUtcTimestamp(input.startedAt);
  const deadlineAt = parseIsoUtcTimestamp(input.deadlineAt);
  if (
    !parseUuidV7(input.journeyId).ok ||
    !parseUuidV7(input.batchId).ok ||
    !parseUuidV7(input.taskId).ok ||
    !parseUuidV7(input.supportId).ok ||
    input.supportId !== input.batchId ||
    !startedAt.ok ||
    !deadlineAt.ok ||
    Date.parse(deadlineAt.value) <= Date.parse(startedAt.value)
  ) {
    throw new Error("Opening journey deadline scope is invalid.");
  }
  return Object.freeze({
    journeyId: input.journeyId,
    batchId: input.batchId,
    taskId: input.taskId,
    supportId: input.supportId,
    startedAt: startedAt.value,
    deadlineAt: deadlineAt.value,
  });
}

function compareRunOrder(
  left: OpeningJourneyDeadlineScope,
  right: OpeningJourneyDeadlineScope,
): number {
  const timestamp = left.startedAt.localeCompare(right.startedAt);
  return timestamp === 0 ? left.batchId.localeCompare(right.batchId) : timestamp;
}
