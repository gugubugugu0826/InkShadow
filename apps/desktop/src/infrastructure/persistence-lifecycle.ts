export const DEFAULT_PERSISTENCE_FLUSH_TIMEOUT_MS = 8_000;
export const MIN_PERSISTENCE_FLUSH_TIMEOUT_MS = 100;
export const MAX_PERSISTENCE_FLUSH_TIMEOUT_MS = 60_000;

const HANDLER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

export type PersistenceFlushReason = "background" | "manual" | "route-change" | "window-close";

export type PersistenceFlushHandlerResult =
  | Readonly<{
      status: "success";
      flushed: boolean;
    }>
  | Readonly<{
      status: "blocked";
      code: "COMPOSITION_ACTIVE";
      message: string;
    }>;

export interface PersistenceFlushContext {
  readonly reason: PersistenceFlushReason;
  readonly signal: AbortSignal;
}

export interface PersistenceLifecycleHandler {
  /**
   * This check is deliberately synchronous so browser `beforeunload` can
   * decide whether to show its native confirmation prompt. It must include
   * scheduled, queued, composing, and dirty state.
   */
  hasPendingWork(): boolean;
  flush(context: PersistenceFlushContext): Promise<PersistenceFlushHandlerResult>;
}

export interface PersistenceFlushFailure {
  readonly handlerId: string;
  readonly cause: unknown;
}

export type PersistenceFlushOutcome =
  | Readonly<{
      status: "success";
      flushedHandlerIds: readonly string[];
    }>
  | Readonly<{
      status: "blocked";
      blockers: readonly Readonly<{
        handlerId: string;
        code: "COMPOSITION_ACTIVE";
        message: string;
      }>[];
    }>
  | Readonly<{
      status: "failed";
      failures: readonly PersistenceFlushFailure[];
    }>
  | Readonly<{
      status: "timeout";
      timeoutMs: number;
      pendingHandlerIds: readonly string[];
    }>;

interface RegisteredHandler {
  readonly handler: PersistenceLifecycleHandler;
  readonly token: symbol;
}

interface SettledHandler {
  readonly handlerId: string;
  readonly result:
    | Readonly<{ status: "fulfilled"; value: PersistenceFlushHandlerResult }>
    | Readonly<{ status: "rejected"; reason: unknown }>;
}

export class PersistenceLifecycleCoordinator {
  private readonly handlers = new Map<string, RegisteredHandler>();
  private activeFlush: Promise<PersistenceFlushOutcome> | null = null;
  private activeSettlement: Promise<void> | null = null;

  public register(handlerId: string, handler: PersistenceLifecycleHandler): () => void {
    if (!HANDLER_ID_PATTERN.test(handlerId)) {
      throw new TypeError("Persistence lifecycle handler id is invalid.");
    }
    if (this.handlers.has(handlerId)) {
      throw new Error(`Persistence lifecycle handler "${handlerId}" is already registered.`);
    }

    const token = Symbol(handlerId);
    this.handlers.set(handlerId, { handler, token });
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (this.handlers.get(handlerId)?.token === token) {
        this.handlers.delete(handlerId);
      }
    };
  }

  public hasPendingWork(): boolean {
    for (const { handler } of this.handlers.values()) {
      try {
        if (handler.hasPendingWork()) {
          return true;
        }
      } catch {
        // A handler whose state cannot be inspected is unsafe to discard.
        return true;
      }
    }
    return false;
  }

  public whenIdle(): Promise<void> {
    return this.activeSettlement ?? Promise.resolve();
  }

  /**
   * Concurrent calls share one cycle. This keeps duplicate close requests
   * idempotent and prevents the same editor snapshot from being persisted
   * twice while the first bounded flush is still running.
   */
  public flush(
    reason: PersistenceFlushReason,
    timeoutMs = DEFAULT_PERSISTENCE_FLUSH_TIMEOUT_MS,
  ): Promise<PersistenceFlushOutcome> {
    requireTimeout(timeoutMs);
    if (this.activeFlush !== null) {
      return this.activeFlush;
    }

    const cycle = this.runFlush(reason, timeoutMs);
    this.activeFlush = cycle;
    void cycle.then((outcome) => {
      if (outcome.status !== "timeout" && this.activeFlush === cycle) {
        this.activeFlush = null;
      }
    });
    return cycle;
  }

  private async runFlush(
    reason: PersistenceFlushReason,
    timeoutMs: number,
  ): Promise<PersistenceFlushOutcome> {
    const pending = [...this.handlers.entries()].filter(([, { handler }]) => {
      try {
        return handler.hasPendingWork();
      } catch {
        return true;
      }
    });
    if (pending.length === 0) {
      return Object.freeze({ status: "success", flushedHandlerIds: Object.freeze([]) });
    }

    const controller = new AbortController();
    const pendingIds = Object.freeze(pending.map(([handlerId]) => handlerId));
    const settled = Promise.all(
      pending.map(async ([handlerId, { handler }]): Promise<SettledHandler> => {
        try {
          return Object.freeze({
            handlerId,
            result: Object.freeze({
              status: "fulfilled" as const,
              value: await handler.flush({ reason, signal: controller.signal }),
            }),
          });
        } catch (reason_: unknown) {
          return Object.freeze({
            handlerId,
            result: Object.freeze({ status: "rejected" as const, reason: reason_ }),
          });
        }
      }),
    );
    const settlement = settled.then(() => undefined);
    this.activeSettlement = settlement;
    void settlement.then(() => {
      if (this.activeSettlement === settlement) {
        this.activeSettlement = null;
      }
    });

    let resolveTimeout: ((value: "timeout") => void) | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      resolveTimeout = resolve;
    });
    const timeoutHandle = setTimeout(() => resolveTimeout?.("timeout"), timeoutMs);
    const race = await Promise.race([settled, timeout]);
    if (race === "timeout") {
      controller.abort(
        new Error(`Persistence flush exceeded the ${String(timeoutMs)}ms safety deadline.`),
      );
      const timedOutCycle = this.activeFlush;
      void settled.then(() => {
        // Keep returning the same timeout outcome until every original
        // handler actually settles. An immediate retry must not overlap the
        // still-running write that crossed the deadline.
        if (this.activeFlush === timedOutCycle) {
          this.activeFlush = null;
        }
      });
      return Object.freeze({
        status: "timeout",
        timeoutMs,
        pendingHandlerIds: pendingIds,
      });
    }
    clearTimeout(timeoutHandle);

    const failures = race
      .filter(
        (
          item,
        ): item is SettledHandler & {
          readonly result: Readonly<{ status: "rejected"; reason: unknown }>;
        } => item.result.status === "rejected",
      )
      .map((item) => Object.freeze({ handlerId: item.handlerId, cause: item.result.reason }));
    if (failures.length > 0) {
      return Object.freeze({ status: "failed", failures: Object.freeze(failures) });
    }

    const fulfilled = race.filter(
      (
        item,
      ): item is SettledHandler & {
        readonly result: Readonly<{
          status: "fulfilled";
          value: PersistenceFlushHandlerResult;
        }>;
      } => item.result.status === "fulfilled",
    );
    const blockers = fulfilled.flatMap((item) =>
      item.result.value.status === "blocked"
        ? [
            Object.freeze({
              handlerId: item.handlerId,
              code: item.result.value.code,
              message: item.result.value.message,
            }),
          ]
        : [],
    );
    if (blockers.length > 0) {
      return Object.freeze({ status: "blocked", blockers: Object.freeze(blockers) });
    }

    const flushedHandlerIds = fulfilled.flatMap((item) =>
      item.result.value.status === "success" && item.result.value.flushed ? [item.handlerId] : [],
    );
    return Object.freeze({
      status: "success",
      flushedHandlerIds: Object.freeze(flushedHandlerIds),
    });
  }
}

export class SerializedPersistenceQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  public hasPendingWork(): boolean {
    return this.pendingCount > 0;
  }

  public enqueue(operation: () => Promise<void>): Promise<void> {
    this.pendingCount += 1;
    const next = this.tail.catch(() => undefined).then(operation);
    this.tail = next;
    void next
      .finally(() => {
        this.pendingCount -= 1;
      })
      .catch(() => {
        // The returned promise and `drain` retain the failure. This branch
        // only prevents the bookkeeping promise from becoming unhandled.
      });
    return next;
  }

  public drain(): Promise<void> {
    return this.tail;
  }
}

export const desktopPersistenceLifecycle = new PersistenceLifecycleCoordinator();

function requireTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_PERSISTENCE_FLUSH_TIMEOUT_MS ||
    timeoutMs > MAX_PERSISTENCE_FLUSH_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Persistence flush timeout must be an integer from ${String(
        MIN_PERSISTENCE_FLUSH_TIMEOUT_MS,
      )} to ${String(MAX_PERSISTENCE_FLUSH_TIMEOUT_MS)} milliseconds.`,
    );
  }
}
