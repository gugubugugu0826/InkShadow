import { invoke } from "@tauri-apps/api/core";

import {
  type ExecuteResult,
  type SqlExecutor,
  type SqlPrimitive,
  type TransactionExecutor,
  TransactionNestingError,
} from "./executor.js";

const FIXED_DATABASE_URL = "sqlite:inkshadow.db";
const TOKEN_PATTERN = /^[\da-f]{64}$/u;

export const TAURI_SQLITE_QUEUE_WAIT_TIMEOUT_MS = 30_000;
export const TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS = 30_000;
export const TAURI_SQLITE_TRANSACTION_IDLE_TIMEOUT_MS = 30_000;
const TAURI_SQLITE_MAINTENANCE_OPERATION_TIMEOUT_MS = 10 * 60_000;
const TAURI_SQLITE_CLOSE_TIMEOUT_MS = 10_000;

export type TauriSqliteOperationStage =
  | "open"
  | "queue_wait"
  | "select"
  | "execute"
  | "transaction_begin"
  | "transaction_callback"
  | "transaction_statement"
  | "transaction_commit"
  | "transaction_rollback"
  | "close";

export type TauriSqliteTimeoutOutcome = "not_started" | "not_confirmed" | "unknown";

/**
 * Sanitized renderer/native timeout receipt. It deliberately records only the
 * bounded lifecycle stage and outcome class: never SQL, bind values, paths or
 * entity identifiers.
 */
export class TauriSqliteOperationTimeoutError extends Error {
  public readonly code:
    "SQLITE_OPERATION_TIMEOUT" | "SQLITE_WRITE_OUTCOME_UNKNOWN" | "SQLITE_COMMIT_OUTCOME_UNKNOWN";

  public constructor(
    public readonly stage: TauriSqliteOperationStage,
    public readonly outcome: TauriSqliteTimeoutOutcome,
    mutationOutcomeMayBeUnknown = false,
  ) {
    super("The local database operation exceeded its bounded execution window.");
    Object.defineProperty(this, "name", {
      value: "TauriSqliteOperationTimeoutError",
      configurable: true,
    });
    this.code =
      stage === "transaction_commit"
        ? "SQLITE_COMMIT_OUTCOME_UNKNOWN"
        : mutationOutcomeMayBeUnknown
          ? "SQLITE_WRITE_OUTCOME_UNKNOWN"
          : "SQLITE_OPERATION_TIMEOUT";
  }
}

declare const nativePathTicketBrand: unique symbol;

/**
 * Opaque, session-bound native file authorization. It is deliberately not a
 * filesystem path and is accepted only by the matching maintenance command.
 */
export type NativePathTicket = string & {
  readonly [nativePathTicketBrand]: true;
};

export interface NativePathTicketReceipt {
  readonly ticket: NativePathTicket;
}

type ExecutorLifecycle = "closed" | "opening" | "open";

let executorLifecycle: ExecutorLifecycle = "closed";
let activeExecutor: TauriSqliteExecutor | null = null;
let openingExecutor: Promise<TauriSqliteExecutor> | null = null;

interface QueuedOperation<Value> {
  readonly operation: () => Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
  timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null;
  cancelled: boolean;
  started: boolean;
}

/** A FIFO actor queue whose timed-out waiters are skipped, never run late. */
class FairOperationQueue {
  private readonly pending: QueuedOperation<unknown>[] = [];
  private running = false;

  public run<Value>(
    operation: () => Promise<Value>,
    waitTimeoutMilliseconds = TAURI_SQLITE_QUEUE_WAIT_TIMEOUT_MS,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const queued: QueuedOperation<Value> = {
        operation,
        resolve,
        reject,
        timeoutHandle: null,
        cancelled: false,
        started: false,
      };
      queued.timeoutHandle = globalThis.setTimeout(() => {
        if (queued.started || queued.cancelled) return;
        queued.cancelled = true;
        queued.reject(new TauriSqliteOperationTimeoutError("queue_wait", "not_started"));
      }, waitTimeoutMilliseconds);
      this.pending.push(queued as QueuedOperation<unknown>);
      this.drain();
    });
  }

  public cancelPending(reason: unknown): void {
    for (const queued of this.pending) {
      if (queued.started || queued.cancelled) continue;
      queued.cancelled = true;
      if (queued.timeoutHandle !== null) globalThis.clearTimeout(queued.timeoutHandle);
      queued.reject(reason);
    }
  }

  private drain(): void {
    if (this.running) return;
    const queued = this.pending.shift();
    if (queued === undefined) return;
    if (queued.cancelled) {
      if (queued.timeoutHandle !== null) globalThis.clearTimeout(queued.timeoutHandle);
      this.drain();
      return;
    }

    this.running = true;
    queued.started = true;
    if (queued.timeoutHandle !== null) globalThis.clearTimeout(queued.timeoutHandle);
    void Promise.resolve()
      .then(queued.operation)
      .then(queued.resolve, queued.reject)
      .finally(() => {
        this.running = false;
        this.drain();
      });
  }
}

class RefreshableDeadline {
  private timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
  private reject: ((reason: unknown) => void) | null = null;
  private readonly timeout: Promise<never>;

  public constructor(
    private readonly timeoutMilliseconds: number,
    private readonly createError: () => Error,
  ) {
    this.timeout = new Promise<never>((_resolve, reject) => {
      this.reject = reject;
    });
  }

  public touch(): void {
    if (this.reject === null) return;
    if (this.timeoutHandle !== null) globalThis.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = globalThis.setTimeout(() => {
      this.timeoutHandle = null;
      this.reject?.(this.createError());
      this.reject = null;
    }, this.timeoutMilliseconds);
  }

  public race<Value>(operation: Promise<Value>): Promise<Value> {
    return Promise.race([operation, this.timeout]);
  }

  public stop(): void {
    if (this.timeoutHandle !== null) globalThis.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
    this.reject = null;
  }
}

type NativeSqlValue =
  | { readonly kind: "null" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "real"; readonly value: number }
  | { readonly kind: "blob"; readonly value: number[] };

interface NativeOpenReceipt {
  readonly sessionToken: string;
}

interface NativeTransactionReceipt {
  readonly transactionToken: string;
}

interface NativeExecuteResult {
  readonly rowsAffected: number;
  readonly lastInsertId?: number;
}

export class TauriSqliteExecutor implements SqlExecutor {
  private readonly operations = new FairOperationQueue();
  private invokingTransactionCallbackSynchronously = false;
  private closed = false;

  private constructor(private readonly sessionToken: string) {}

  public static async open(path = FIXED_DATABASE_URL): Promise<TauriSqliteExecutor> {
    if (path !== FIXED_DATABASE_URL) {
      throw new Error("InkShadow only opens its fixed local database.");
    }
    if (activeExecutor !== null && !activeExecutor.closed) {
      return activeExecutor;
    }
    if (openingExecutor !== null) {
      return openingExecutor;
    }
    executorLifecycle = "opening";

    const opening = (async () => {
      // The native open boundary applies and validates SQLx migrations before
      // returning the only renderer-visible session token. Native may adopt an
      // existing connection after a WebView reload, but always rotates the
      // renderer session token before this facade becomes callable.
      const receipt = await withDeadline<NativeOpenReceipt>(
        invoke<NativeOpenReceipt>("native_sqlite_open"),
        TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
        () => new TauriSqliteOperationTimeoutError("open", "not_confirmed"),
      );
      if (!TOKEN_PATTERN.test(receipt.sessionToken)) {
        throw new Error("The native SQLite bridge returned an invalid session.");
      }

      const executor = new TauriSqliteExecutor(receipt.sessionToken);
      activeExecutor = executor;
      executorLifecycle = "open";
      return executor;
    })();
    openingExecutor = opening;

    try {
      return await opening;
    } catch (error: unknown) {
      executorLifecycle = "closed";
      throw error;
    } finally {
      if (openingExecutor === opening) {
        openingExecutor = null;
      }
    }
  }

  public async select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    this.assertRootCallAllowed();
    return this.operations.run(async () => {
      this.assertOpen();
      const timeout = new TauriSqliteOperationTimeoutError("select", "not_confirmed");
      try {
        return await withDeadline(
          this.invokeSession<Row[]>("native_sqlite_select", {
            sessionToken: this.sessionToken,
            query,
            values: encodeBindValues(bindValues),
          }),
          operationTimeoutForQuery(query),
          () => timeout,
        );
      } catch (error: unknown) {
        if (error === timeout) await this.failClosedSession();
        throw error;
      }
    });
  }

  public async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<ExecuteResult> {
    this.assertRootCallAllowed();
    return this.operations.run(async () => {
      this.assertOpen();
      const timeout = new TauriSqliteOperationTimeoutError("execute", "unknown", true);
      try {
        return normalizeExecuteResult(
          await withDeadline(
            this.invokeSession<NativeExecuteResult>("native_sqlite_execute", {
              sessionToken: this.sessionToken,
              query,
              values: encodeBindValues(bindValues),
            }),
            operationTimeoutForQuery(query),
            () => timeout,
          ),
        );
      } catch (error: unknown) {
        if (error === timeout) await this.failClosedSession();
        throw error;
      }
    });
  }

  public async transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.runTransaction(false, operation);
  }

  public async readTransaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.runTransaction(true, operation);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.assertRootCallAllowed();

    await this.operations.run(async () => {
      if (this.closed) {
        return;
      }
      try {
        // Reconciliation can remove only this process's durable leases whose
        // operation is absent from the native-only live-future registry.
        await withDeadline(
          invoke("reconcile_native_model_dispatch_leases"),
          TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
          () => new TauriSqliteOperationTimeoutError("close", "not_confirmed"),
        );
        await withDeadline(
          invoke("native_sqlite_close", {
            sessionToken: this.sessionToken,
          }),
          TAURI_SQLITE_CLOSE_TIMEOUT_MS,
          () => new TauriSqliteOperationTimeoutError("close", "not_confirmed"),
        );
        this.markClosed();
      } catch (error: unknown) {
        if (!isRemoteDispatchActiveError(error)) {
          // Preserve the established fail-closed behavior for uncertain native
          // close failures. An active dispatch is different: native explicitly
          // proves the connection is still valid and must remain open.
          this.markClosed();
        }
        throw error;
      }
    });
  }

  public async integrityCheck(): Promise<boolean> {
    const rows = await this.select<{ integrity_check: string }>("PRAGMA integrity_check");
    return rows.length === 1 && rows[0]?.integrity_check === "ok";
  }

  public async chooseBackupDestination(): Promise<NativePathTicketReceipt | null> {
    return this.chooseNativePath("native_choose_backup_destination");
  }

  public async choosePreRestoreBackupDestination(): Promise<NativePathTicketReceipt | null> {
    return this.chooseNativePath("native_choose_pre_restore_backup_destination");
  }

  public async chooseRestoreSource(): Promise<NativePathTicketReceipt | null> {
    return this.chooseNativePath("native_choose_restore_source");
  }

  private async runTransaction<Value>(
    readOnly: boolean,
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    this.assertRootCallAllowed();

    return this.operations.run(async () => {
      this.assertOpen();
      let transactionToken: string | undefined;
      let acceptingTransactionCalls = true;
      let commitStarted = false;
      let queue: Promise<void> = Promise.resolve();
      const queueState: { failed: boolean; failure: unknown } = {
        failed: false,
        failure: undefined,
      };

      try {
        const receipt = await withDeadline<NativeTransactionReceipt>(
          invoke<NativeTransactionReceipt>("native_sqlite_begin", {
            sessionToken: this.sessionToken,
            readOnly,
          }),
          TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
          () => new TauriSqliteOperationTimeoutError("transaction_begin", "not_confirmed"),
        );
        if (!TOKEN_PATTERN.test(receipt.transactionToken)) {
          throw new Error("The native SQLite bridge returned an invalid transaction.");
        }
        transactionToken = receipt.transactionToken;

        const callbackDeadline = new RefreshableDeadline(
          TAURI_SQLITE_TRANSACTION_IDLE_TIMEOUT_MS,
          () => new TauriSqliteOperationTimeoutError("transaction_callback", "not_confirmed"),
        );
        callbackDeadline.touch();

        const enqueue = <Result>(request: () => Promise<Result>): Promise<Result> => {
          if (!acceptingTransactionCalls) {
            return Promise.reject(new Error("The SQLite transaction has already finished."));
          }

          callbackDeadline.touch();
          const scheduled = queue.then(async () => {
            if (queueState.failed) {
              throw queueState.failure;
            }
            const statementTimeout = new TauriSqliteOperationTimeoutError(
              "transaction_statement",
              "not_confirmed",
            );
            try {
              return await withDeadline(
                request(),
                TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
                () => statementTimeout,
              );
            } finally {
              callbackDeadline.touch();
            }
          });
          queue = scheduled.then(
            () => undefined,
            (error: unknown) => {
              if (!queueState.failed) {
                queueState.failed = true;
                queueState.failure = error;
              }
            },
          );
          return scheduled;
        };

        const transaction: TransactionExecutor = {
          select: <Row extends object>(query: string, bindValues: readonly SqlPrimitive[] = []) =>
            enqueue(() =>
              invoke<Row[]>("native_sqlite_transaction_select", {
                sessionToken: this.sessionToken,
                transactionToken: receipt.transactionToken,
                query,
                values: encodeBindValues(bindValues),
              }),
            ),
          execute: (query: string, bindValues: readonly SqlPrimitive[] = []) =>
            enqueue(async () => {
              if (readOnly) {
                throw new Error("A read-only SQLite transaction cannot execute mutations.");
              }
              return normalizeExecuteResult(
                await invoke<NativeExecuteResult>("native_sqlite_transaction_execute", {
                  sessionToken: this.sessionToken,
                  transactionToken: receipt.transactionToken,
                  query,
                  values: encodeBindValues(bindValues),
                }),
              );
            }),
        };

        let value: Value | undefined;
        let callbackFailed = false;
        let callbackFailure: unknown;
        try {
          let callback: Promise<Value>;
          this.invokingTransactionCallbackSynchronously = true;
          try {
            callback = Promise.resolve(operation(transaction));
          } finally {
            this.invokingTransactionCallbackSynchronously = false;
          }
          value = await callbackDeadline.race(callback);
        } catch (error: unknown) {
          callbackFailed = true;
          callbackFailure = error;
        } finally {
          callbackDeadline.stop();
        }
        acceptingTransactionCalls = false;
        await queue;
        if (callbackFailed) {
          throw callbackFailure;
        }
        if (queueState.failed) {
          throw queueState.failure;
        }

        commitStarted = true;
        await withDeadline(
          invoke("native_sqlite_commit", {
            sessionToken: this.sessionToken,
            transactionToken: receipt.transactionToken,
          }),
          TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
          () => new TauriSqliteOperationTimeoutError("transaction_commit", "unknown", true),
        );
        return value as Value;
      } catch (error: unknown) {
        acceptingTransactionCalls = false;
        if (
          error instanceof TauriSqliteOperationTimeoutError ||
          isBoundedNativeOutcomeError(error)
        ) {
          // A root call made asynchronously from this callback is
          // indistinguishable from an unrelated concurrent caller in a WebView.
          // On timeout, cancel every waiter that has not started so no queued
          // mutation can escape after rollback. Callers can read authority and
          // explicitly retry in the next healthy session.
          this.operations.cancelPending(
            new TauriSqliteOperationTimeoutError("queue_wait", "not_started"),
          );
        }
        if (commitStarted) {
          await this.failClosedSession();
          throw error;
        }
        if (transactionToken === undefined) {
          await this.failClosedSession();
          throw error;
        }
        try {
          await withDeadline(
            invoke("native_sqlite_rollback", {
              sessionToken: this.sessionToken,
              transactionToken,
            }),
            TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
            () => new TauriSqliteOperationTimeoutError("transaction_rollback", "not_confirmed"),
          );
        } catch (rollbackError: unknown) {
          await this.failClosedSession();
          const rollbackOutcome = new TauriSqliteOperationTimeoutError(
            "transaction_rollback",
            "unknown",
            !readOnly,
          );
          Object.defineProperty(rollbackOutcome, "cause", {
            value: new AggregateError([error, rollbackError]),
            enumerable: false,
          });
          throw rollbackOutcome;
        }
        throw error;
      } finally {
        acceptingTransactionCalls = false;
        this.invokingTransactionCallbackSynchronously = false;
      }
    });
  }

  private async failClosedSession(): Promise<void> {
    this.markClosed();
    try {
      await withDeadline(
        invoke("native_sqlite_close", {
          sessionToken: this.sessionToken,
        }),
        TAURI_SQLITE_CLOSE_TIMEOUT_MS,
        () => new TauriSqliteOperationTimeoutError("close", "not_confirmed"),
      );
    } catch {
      // Native transaction finalization and close both invalidate uncertain
      // connection state. A second error must not keep this facade reusable.
    }
  }

  private async chooseNativePath(command: string): Promise<NativePathTicketReceipt | null> {
    this.assertRootCallAllowed();
    return this.operations.run(async () => {
      this.assertOpen();
      const receipt = await this.invokeSession<unknown>(command, {});
      if (receipt === null) {
        return null;
      }
      if (
        typeof receipt !== "object" ||
        !("ticket" in receipt) ||
        typeof receipt.ticket !== "string" ||
        !TOKEN_PATTERN.test(receipt.ticket) ||
        Object.keys(receipt).length !== 1
      ) {
        throw new Error("The native file dialog returned an invalid path authorization.");
      }
      return Object.freeze({
        ticket: receipt.ticket as NativePathTicket,
      });
    });
  }

  private async invokeSession<Output>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<Output> {
    try {
      return await invoke<Output>(command, arguments_);
    } catch (error: unknown) {
      if (isInvalidatedNativeSession(error)) {
        this.markClosed();
      }
      throw error;
    }
  }

  private assertRootCallAllowed(): void {
    this.assertOpen();
    if (this.invokingTransactionCallbackSynchronously) {
      throw new TransactionNestingError();
    }
  }

  private markClosed(): void {
    this.closed = true;
    executorLifecycle = "closed";
    if (activeExecutor === this) {
      activeExecutor = null;
    }
  }

  private assertOpen(): void {
    if (this.closed || executorLifecycle !== "open") {
      throw new Error("The InkShadow local database is closed.");
    }
  }
}

function withDeadline<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
  createError: () => Error,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let finished = false;
    const timeoutHandle = globalThis.setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(createError());
    }, timeoutMilliseconds);
    operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        globalThis.clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        globalThis.clearTimeout(timeoutHandle);
        reject(toStructuredError(error));
      },
    );
  });
}

function toStructuredError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : "The SQLite operation was rejected by the native bridge.";
    return Object.assign(new Error(message), error);
  }
  return new Error("The SQLite operation was rejected by the native bridge.");
}

function operationTimeoutForQuery(query: string): number {
  return /^\s*(?:VACUUM|ATTACH|DETACH|PRAGMA\s+(?:integrity_check|foreign_key_check))/iu.test(query)
    ? TAURI_SQLITE_MAINTENANCE_OPERATION_TIMEOUT_MS
    : TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS;
}

function isRemoteDispatchActiveError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PROJECT_REMOTE_DISPATCH_ACTIVE"
  );
}

function encodeBindValues(values: readonly SqlPrimitive[]): NativeSqlValue[] {
  return values.map((value): NativeSqlValue => {
    if (value === null) {
      return { kind: "null" };
    }
    if (typeof value === "string") {
      return { kind: "text", value };
    }
    if (value instanceof Uint8Array) {
      return { kind: "blob", value: Array.from(value) };
    }
    if (!Number.isFinite(value)) {
      throw new TypeError("SQLite numeric bind values must be finite.");
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new RangeError("SQLite integer bind values must be safe JavaScript integers.");
      }
      return { kind: "integer", value };
    }
    return { kind: "real", value };
  });
}

function normalizeExecuteResult(result: NativeExecuteResult): ExecuteResult {
  if (
    !Number.isSafeInteger(result.rowsAffected) ||
    result.rowsAffected < 0 ||
    (result.lastInsertId !== undefined && !Number.isSafeInteger(result.lastInsertId))
  ) {
    throw new Error("The native SQLite bridge returned an invalid execution receipt.");
  }
  return {
    rowsAffected: result.rowsAffected,
    ...(result.lastInsertId === undefined ? {} : { lastInsertId: result.lastInsertId }),
  };
}

function isInvalidatedNativeSession(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return (
    code === "SQLITE_CONNECTION_INVALIDATED" ||
    code === "SQLITE_SESSION_INVALID" ||
    code === "SQLITE_BRIDGE_UNAVAILABLE" ||
    code === "SQLITE_OPERATION_TIMEOUT" ||
    code === "SQLITE_WRITE_OUTCOME_UNKNOWN" ||
    code === "SQLITE_COMMIT_OUTCOME_UNKNOWN"
  );
}

function isBoundedNativeOutcomeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return (
    code === "SQLITE_OPERATION_TIMEOUT" ||
    code === "SQLITE_WRITE_OUTCOME_UNKNOWN" ||
    code === "SQLITE_COMMIT_OUTCOME_UNKNOWN"
  );
}
