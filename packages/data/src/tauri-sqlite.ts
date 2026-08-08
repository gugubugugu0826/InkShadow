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

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  public async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
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
  private readonly mutex = new AsyncMutex();
  private transactionCallbackActive = false;
  private closed = false;

  private constructor(private readonly sessionToken: string) {}

  public static async open(path = FIXED_DATABASE_URL): Promise<TauriSqliteExecutor> {
    if (path !== FIXED_DATABASE_URL) {
      throw new Error("InkShadow only opens its fixed local database.");
    }
    if (executorLifecycle !== "closed") {
      throw new Error("The InkShadow local database is already open.");
    }
    executorLifecycle = "opening";

    try {
      // The native open boundary applies and validates SQLx migrations before
      // returning the only renderer-visible session token.
      const receipt = await invoke<NativeOpenReceipt>("native_sqlite_open");
      if (!TOKEN_PATTERN.test(receipt.sessionToken)) {
        throw new Error("The native SQLite bridge returned an invalid session.");
      }

      executorLifecycle = "open";
      return new TauriSqliteExecutor(receipt.sessionToken);
    } catch (error: unknown) {
      executorLifecycle = "closed";
      throw error;
    }
  }

  public async select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    this.assertCallableOutsideTransaction();
    return this.mutex.run(() => {
      this.assertOpen();
      return this.invokeSession<Row[]>("native_sqlite_select", {
        sessionToken: this.sessionToken,
        query,
        values: encodeBindValues(bindValues),
      });
    });
  }

  public async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<ExecuteResult> {
    this.assertCallableOutsideTransaction();
    return this.mutex.run(async () => {
      this.assertOpen();
      return normalizeExecuteResult(
        await this.invokeSession<NativeExecuteResult>("native_sqlite_execute", {
          sessionToken: this.sessionToken,
          query,
          values: encodeBindValues(bindValues),
        }),
      );
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
    this.assertCallableOutsideTransaction();

    await this.mutex.run(async () => {
      if (this.closed) {
        return;
      }
      try {
        // Reconciliation can remove only this process's durable leases whose
        // operation is absent from the native-only live-future registry.
        await invoke("reconcile_native_model_dispatch_leases");
        await invoke("native_sqlite_close", {
          sessionToken: this.sessionToken,
        });
        this.closed = true;
        executorLifecycle = "closed";
      } catch (error: unknown) {
        if (!isRemoteDispatchActiveError(error)) {
          // Preserve the established fail-closed behavior for uncertain native
          // close failures. An active dispatch is different: native explicitly
          // proves the connection is still valid and must remain open.
          this.closed = true;
          executorLifecycle = "closed";
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
    this.assertCallableOutsideTransaction();

    return this.mutex.run(async () => {
      this.assertOpen();
      this.transactionCallbackActive = true;
      let transactionToken: string | undefined;
      let acceptingTransactionCalls = true;
      let commitStarted = false;
      let queue: Promise<void> = Promise.resolve();
      const queueState: { failed: boolean; failure: unknown } = {
        failed: false,
        failure: undefined,
      };

      try {
        const receipt = await invoke<NativeTransactionReceipt>("native_sqlite_begin", {
          sessionToken: this.sessionToken,
          readOnly,
        });
        if (!TOKEN_PATTERN.test(receipt.transactionToken)) {
          throw new Error("The native SQLite bridge returned an invalid transaction.");
        }
        transactionToken = receipt.transactionToken;

        const enqueue = <Result>(request: () => Promise<Result>): Promise<Result> => {
          if (!acceptingTransactionCalls) {
            return Promise.reject(new Error("The SQLite transaction has already finished."));
          }

          const scheduled = queue.then(() => {
            if (queueState.failed) {
              throw queueState.failure;
            }
            return request();
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
          value = await operation(transaction);
        } catch (error: unknown) {
          callbackFailed = true;
          callbackFailure = error;
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
        await invoke("native_sqlite_commit", {
          sessionToken: this.sessionToken,
          transactionToken: receipt.transactionToken,
        });
        return value as Value;
      } catch (error: unknown) {
        acceptingTransactionCalls = false;
        if (commitStarted) {
          await this.failClosedSession();
          throw error;
        }
        if (transactionToken === undefined) {
          await this.failClosedSession();
          throw error;
        }
        try {
          await invoke("native_sqlite_rollback", {
            sessionToken: this.sessionToken,
            transactionToken,
          });
        } catch (rollbackError: unknown) {
          await this.failClosedSession();
          throw new AggregateError(
            [error, rollbackError],
            readOnly
              ? "SQLite read operation failed and the transaction could not be rolled back."
              : "SQLite operation failed and the transaction could not be rolled back.",
          );
        }
        throw error;
      } finally {
        acceptingTransactionCalls = false;
        this.transactionCallbackActive = false;
      }
    });
  }

  private async failClosedSession(): Promise<void> {
    try {
      await invoke("native_sqlite_close", {
        sessionToken: this.sessionToken,
      });
    } catch {
      // Native transaction finalization and close both invalidate uncertain
      // connection state. A second error must not keep this facade reusable.
    } finally {
      this.closed = true;
      executorLifecycle = "closed";
    }
  }

  private async chooseNativePath(command: string): Promise<NativePathTicketReceipt | null> {
    this.assertCallableOutsideTransaction();
    return this.mutex.run(async () => {
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
        this.closed = true;
        executorLifecycle = "closed";
      }
      throw error;
    }
  }

  private assertCallableOutsideTransaction(): void {
    this.assertOpen();
    if (this.transactionCallbackActive) {
      throw new TransactionNestingError();
    }
  }

  private assertOpen(): void {
    if (this.closed || executorLifecycle !== "open") {
      throw new Error("The InkShadow local database is closed.");
    }
  }
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
    code === "SQLITE_BRIDGE_UNAVAILABLE"
  );
}
