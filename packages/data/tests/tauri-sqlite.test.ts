import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionNestingError } from "../src/executor.js";
import {
  TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS,
  TAURI_SQLITE_TRANSACTION_IDLE_TIMEOUT_MS,
  TauriSqliteExecutor,
  TauriSqliteOperationTimeoutError,
} from "../src/tauri-sqlite.js";

const nativeSessionToken = "a".repeat(64);
const nativeTransactionToken = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

describe("TauriSqliteExecutor native bridge", () => {
  let executor: TauriSqliteExecutor | undefined;
  let events: string[];

  beforeEach(() => {
    events = [];
    mocks.invoke.mockReset();

    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_open":
          return { sessionToken: nativeSessionToken };
        case "native_sqlite_begin":
          return { transactionToken: nativeTransactionToken };
        case "native_sqlite_select":
        case "native_sqlite_transaction_select":
          return [];
        case "native_sqlite_execute":
        case "native_sqlite_transaction_execute":
          return { rowsAffected: 1, lastInsertId: 1 };
        default:
          return undefined;
      }
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (executor !== undefined) {
      await executor.close();
      executor = undefined;
    }
  });

  it("opens migrations and the single pinned connection at one native boundary", async () => {
    executor = await TauriSqliteExecutor.open();

    expect(events).toEqual(["native_sqlite_open"]);

    await executor.execute("CREATE TABLE example (id INTEGER PRIMARY KEY)");
    await executor.select("SELECT id FROM example");

    expect(events.filter((event) => event === "native_sqlite_open")).toHaveLength(1);
  });

  it("coalesces concurrent renderer bootstrap onto one executor and native open", async () => {
    const openCall = deferred<{ sessionToken: string }>();
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      if (command === "native_sqlite_open") {
        return openCall.promise;
      }
      return undefined;
    });

    const first = TauriSqliteExecutor.open();
    const second = TauriSqliteExecutor.open();
    expect(events.filter((event) => event === "native_sqlite_open")).toHaveLength(1);

    openCall.resolve({ sessionToken: nativeSessionToken });
    const [firstExecutor, secondExecutor] = await Promise.all([first, second]);
    executor = firstExecutor;
    expect(secondExecutor).toBe(firstExecutor);
    expect(events.filter((event) => event === "native_sqlite_open")).toHaveLength(1);
  });

  it("rejects every database URL except the fixed migration URL", async () => {
    await expect(TauriSqliteExecutor.open("sqlite:other.db")).rejects.toThrow(
      "fixed local database",
    );
    expect(events).not.toContain("native_sqlite_open");
  });

  it("serializes primitive bind values without losing integer or blob kinds", async () => {
    executor = await TauriSqliteExecutor.open();

    await executor.execute("INSERT INTO example VALUES (?, ?, ?, ?, ?)", [
      null,
      "墨影",
      42,
      1.25,
      Uint8Array.from([0, 127, 255]),
    ]);

    expect(mocks.invoke).toHaveBeenCalledWith("native_sqlite_execute", {
      sessionToken: nativeSessionToken,
      query: "INSERT INTO example VALUES (?, ?, ?, ?, ?)",
      values: [
        { kind: "null" },
        { kind: "text", value: "墨影" },
        { kind: "integer", value: 42 },
        { kind: "real", value: 1.25 },
        { kind: "blob", value: [0, 127, 255] },
      ],
    });
  });

  it("rolls back callback failures using the exact native transaction token", async () => {
    executor = await TauriSqliteExecutor.open();
    const failure = new Error("callback failed");

    await expect(
      executor.transaction(async (transaction) => {
        await transaction.execute("INSERT INTO example VALUES (?)", [1]);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(events).toContain("native_sqlite_begin");
    expect(events).toContain("native_sqlite_transaction_execute");
    expect(events).toContain("native_sqlite_rollback");
    expect(events).not.toContain("native_sqlite_commit");
    expect(mocks.invoke).toHaveBeenCalledWith("native_sqlite_rollback", {
      sessionToken: nativeSessionToken,
      transactionToken: nativeTransactionToken,
    });
  });

  it("serializes and drains fire-and-forget transaction calls before commit", async () => {
    executor = await TauriSqliteExecutor.open();
    const firstCall = deferred<{ rowsAffected: number }>();
    let transactionExecuteCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_open":
          return { sessionToken: nativeSessionToken };
        case "native_sqlite_begin":
          return { transactionToken: nativeTransactionToken };
        case "native_sqlite_transaction_execute":
          transactionExecuteCount += 1;
          if (transactionExecuteCount === 1) {
            return firstCall.promise;
          }
          return { rowsAffected: 1 };
        default:
          return undefined;
      }
    });

    const result = executor.transaction(async (transaction) => {
      void transaction.execute("INSERT INTO example VALUES (1)");
      void transaction.execute("INSERT INTO example VALUES (2)");
      return "queued";
    });

    await vi.waitFor(() => {
      expect(transactionExecuteCount).toBe(1);
    });
    expect(events).not.toContain("native_sqlite_commit");

    firstCall.resolve({ rowsAffected: 1 });
    await expect(result).resolves.toBe("queued");

    expect(transactionExecuteCount).toBe(2);
    expect(events.slice(-3)).toEqual([
      "native_sqlite_transaction_execute",
      "native_sqlite_transaction_execute",
      "native_sqlite_commit",
    ]);
  });

  it("rolls back when an un-awaited queued statement fails", async () => {
    executor = await TauriSqliteExecutor.open();
    const statementFailure = new Error("statement failed");
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_open":
          return { sessionToken: nativeSessionToken };
        case "native_sqlite_begin":
          return { transactionToken: nativeTransactionToken };
        case "native_sqlite_transaction_execute":
          throw statementFailure;
        default:
          return undefined;
      }
    });

    await expect(
      executor.transaction(async (transaction) => {
        void transaction.execute("INSERT INTO example VALUES (1)");
      }),
    ).rejects.toBe(statementFailure);

    expect(events).toContain("native_sqlite_rollback");
    expect(events).not.toContain("native_sqlite_commit");
  });

  it("does not issue a misleading rollback after native commit has failed", async () => {
    executor = await TauriSqliteExecutor.open();
    const commitFailure = new Error("native commit failed");
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_open":
          return { sessionToken: nativeSessionToken };
        case "native_sqlite_begin":
          return { transactionToken: nativeTransactionToken };
        case "native_sqlite_commit":
          throw commitFailure;
        default:
          return undefined;
      }
    });

    await expect(executor.transaction(async () => "value")).rejects.toBe(commitFailure);
    expect(events).not.toContain("native_sqlite_rollback");
    expect(events).toContain("native_sqlite_close");
    await expect(executor.select("SELECT 1 AS value")).rejects.toThrow("database is closed");
  });

  it("fails closed when rollback itself cannot be confirmed", async () => {
    executor = await TauriSqliteExecutor.open();
    const callbackFailure = new Error("callback failed");
    const rollbackFailure = new Error("rollback failed");
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_open":
          return { sessionToken: nativeSessionToken };
        case "native_sqlite_begin":
          return { transactionToken: nativeTransactionToken };
        case "native_sqlite_rollback":
          throw rollbackFailure;
        default:
          return undefined;
      }
    });

    const failure = await executor
      .transaction(async () => {
        throw callbackFailure;
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TauriSqliteOperationTimeoutError);
    expect(failure).toMatchObject({
      code: "SQLITE_WRITE_OUTCOME_UNKNOWN",
      stage: "transaction_rollback",
      outcome: "unknown",
    });
    expect(events).toContain("native_sqlite_close");
    await expect(executor.select("SELECT 1 AS value")).rejects.toThrow("database is closed");
  });

  it("re-checks lifecycle after a queued close before invoking a query", async () => {
    executor = await TauriSqliteExecutor.open();
    const closeCall = deferred<undefined>();
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_close":
          return closeCall.promise;
        case "native_sqlite_select":
          return [];
        default:
          return undefined;
      }
    });

    const closing = executor.close();
    await vi.waitFor(() => {
      expect(events).toContain("native_sqlite_close");
    });
    const queuedQuery = executor.select("SELECT 1 AS value");

    closeCall.resolve(undefined);
    await closing;
    await expect(queuedQuery).rejects.toThrow("database is closed");
    expect(events).not.toContain("native_sqlite_select");
  });

  it("becomes fail-closed and reopenable when native close reports an error", async () => {
    executor = await TauriSqliteExecutor.open();
    const closeFailure = new Error("native close failed");
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      if (command === "native_sqlite_close") {
        throw closeFailure;
      }
      if (command === "native_sqlite_select") {
        return [];
      }
      return command === "native_sqlite_open" ? { sessionToken: nativeSessionToken } : undefined;
    });

    await expect(executor.close()).rejects.toBe(closeFailure);
    await expect(executor.select("SELECT 1 AS value")).rejects.toThrow("database is closed");

    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      if (command === "native_sqlite_open") {
        return { sessionToken: nativeSessionToken };
      }
      if (command === "native_sqlite_select") {
        return [];
      }
      return undefined;
    });
    executor = await TauriSqliteExecutor.open();
    await expect(executor.select("SELECT 1 AS value")).resolves.toEqual([]);
  });

  it("keeps the valid database session open while a native model request is active", async () => {
    executor = await TauriSqliteExecutor.open();
    const active = {
      code: "PROJECT_REMOTE_DISPATCH_ACTIVE",
      message: "A remote project request is still active.",
      retryable: true,
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      if (command === "native_sqlite_close") {
        throw active;
      }
      if (command === "native_sqlite_select") {
        return [];
      }
      return undefined;
    });

    await expect(executor.close()).rejects.toMatchObject(active);
    await expect(executor.select("SELECT 1 AS value")).resolves.toEqual([]);
    mocks.invoke.mockResolvedValue(undefined);
    await executor.close();
    executor = undefined;
  });

  it("becomes immediately reopenable when the native connection is invalidated", async () => {
    executor = await TauriSqliteExecutor.open();
    const invalidated = {
      code: "SQLITE_CONNECTION_INVALIDATED",
      message: "connection invalidated",
      retryable: true,
    };
    mocks.invoke.mockRejectedValueOnce(invalidated);

    await expect(executor.execute("DETACH DATABASE restore_source")).rejects.toMatchObject(
      invalidated,
    );
    await expect(executor.select("SELECT 1 AS value")).rejects.toThrow("database is closed");

    executor = await TauriSqliteExecutor.open();
    await expect(executor.select("SELECT 1 AS value")).resolves.toEqual([]);
  });

  it("rejects nested executor transactions instead of deadlocking", async () => {
    executor = await TauriSqliteExecutor.open();
    const openExecutor = executor;

    await expect(
      openExecutor.transaction(async () => openExecutor.transaction(async () => undefined)),
    ).rejects.toBeInstanceOf(TransactionNestingError);
    expect(events).toContain("native_sqlite_rollback");
  });

  it("queues an unrelated root read while a transaction callback is active", async () => {
    executor = await TauriSqliteExecutor.open();
    const transactionStarted = deferred<undefined>();
    const releaseTransaction = deferred<undefined>();

    const transaction = executor.transaction(async () => {
      transactionStarted.resolve(undefined);
      await releaseTransaction.promise;
    });
    await transactionStarted.promise;

    const read = executor.select("SELECT 1 AS value");
    await Promise.resolve();
    expect(events).not.toContain("native_sqlite_select");

    releaseTransaction.resolve(undefined);
    await expect(transaction).resolves.toBeUndefined();
    await expect(read).resolves.toEqual([]);
    expect(events.indexOf("native_sqlite_select")).toBeGreaterThan(
      events.indexOf("native_sqlite_commit"),
    );
  });

  it("fairly queues unrelated root writes and transactions behind the active owner", async () => {
    executor = await TauriSqliteExecutor.open();
    const transactionStarted = deferred<undefined>();
    const releaseTransaction = deferred<undefined>();

    const first = executor.transaction(async () => {
      transactionStarted.resolve(undefined);
      await releaseTransaction.promise;
      return "first";
    });
    await transactionStarted.promise;

    const read = executor.select("SELECT 1 AS value");
    const write = executor.execute("UPDATE example SET value = 1");
    const second = executor.transaction(async (transaction) => {
      await transaction.execute("UPDATE example SET value = 2");
      return "second";
    });
    await Promise.resolve();
    expect(events.filter((event) => event === "native_sqlite_begin")).toHaveLength(1);
    expect(events).not.toContain("native_sqlite_select");
    expect(events).not.toContain("native_sqlite_execute");

    releaseTransaction.resolve(undefined);
    await expect(Promise.all([first, read, write, second])).resolves.toEqual([
      "first",
      [],
      { rowsAffected: 1, lastInsertId: 1 },
      "second",
    ]);

    expect(events).toEqual([
      "native_sqlite_open",
      "native_sqlite_begin",
      "native_sqlite_commit",
      "native_sqlite_select",
      "native_sqlite_execute",
      "native_sqlite_begin",
      "native_sqlite_transaction_execute",
      "native_sqlite_commit",
    ]);
  });

  it("cancels an awaited asynchronous nested root write instead of running it after rollback", async () => {
    vi.useFakeTimers();
    executor = await TauriSqliteExecutor.open();

    const transaction = executor.transaction(async () => {
      await Promise.resolve();
      await executor?.execute("UPDATE example SET value = 99");
    });
    const transactionFailure = transaction.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(TAURI_SQLITE_TRANSACTION_IDLE_TIMEOUT_MS);

    await expect(transactionFailure).resolves.toBeInstanceOf(TauriSqliteOperationTimeoutError);
    expect(events).toContain("native_sqlite_rollback");
    expect(events).not.toContain("native_sqlite_execute");

    await expect(executor.select("SELECT 1 AS value")).resolves.toEqual([]);
    expect(events.filter((event) => event === "native_sqlite_select")).toHaveLength(1);
  });

  it("never runs a root write after its FIFO queue wait has timed out", async () => {
    vi.useFakeTimers();
    executor = await TauriSqliteExecutor.open();
    const transactionStarted = deferred<undefined>();
    const refreshTransactionDeadline = deferred<undefined>();
    const releaseTransaction = deferred<undefined>();

    const transaction = executor.transaction(async (owner) => {
      transactionStarted.resolve(undefined);
      await refreshTransactionDeadline.promise;
      await owner.select("SELECT 1 AS value");
      await releaseTransaction.promise;
    });
    await transactionStarted.promise;

    const queuedWrite = executor.execute("UPDATE example SET value = 7");
    const queuedFailure = queuedWrite.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    refreshTransactionDeadline.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain("native_sqlite_transaction_select");

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(queuedFailure).resolves.toMatchObject({
      code: "SQLITE_OPERATION_TIMEOUT",
      stage: "queue_wait",
      outcome: "not_started",
    });
    expect(events).not.toContain("native_sqlite_execute");

    releaseTransaction.resolve(undefined);
    await expect(transaction).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).not.toContain("native_sqlite_execute");
  });

  it("fails closed with a sanitized unknown outcome when commit confirmation times out", async () => {
    vi.useFakeTimers();
    executor = await TauriSqliteExecutor.open();
    const commitCall = deferred<undefined>();
    let authoritativeVersionCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_sqlite_open":
          return { sessionToken: nativeSessionToken };
        case "native_sqlite_begin":
          return { transactionToken: nativeTransactionToken };
        case "native_sqlite_commit":
          return commitCall.promise;
        case "native_sqlite_select":
          return [{ version_count: authoritativeVersionCount }];
        default:
          return undefined;
      }
    });

    const transaction = executor.transaction(async () => "pending-commit");
    const transactionFailure = transaction.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain("native_sqlite_commit");
    const queuedWrite = executor.execute("UPDATE example SET value = 3");
    const queuedWriteFailure = queuedWrite.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(TAURI_SQLITE_NATIVE_OPERATION_TIMEOUT_MS);
    const failure = await transactionFailure;
    expect(failure).toBeInstanceOf(TauriSqliteOperationTimeoutError);
    expect(failure).toMatchObject({
      code: "SQLITE_COMMIT_OUTCOME_UNKNOWN",
      stage: "transaction_commit",
      outcome: "unknown",
    });
    expect(Object.keys(failure as object).sort()).toEqual(["code", "outcome", "stage"]);
    await expect(queuedWriteFailure).resolves.toBeInstanceOf(Error);
    expect(events).not.toContain("native_sqlite_execute");

    authoritativeVersionCount = 1;
    commitCall.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    executor = await TauriSqliteExecutor.open();
    await expect(
      executor.select<{ version_count: number }>(
        "SELECT COUNT(*) AS version_count FROM chapter_versions WHERE source_type = 'candidate_accept'",
      ),
    ).resolves.toEqual([{ version_count: 1 }]);
    expect(events.filter((event) => event === "native_sqlite_open")).toHaveLength(2);
    expect(events.filter((event) => event === "native_sqlite_commit")).toHaveLength(1);
  });

  it.each([
    "SQLITE_OPERATION_TIMEOUT",
    "SQLITE_WRITE_OUTCOME_UNKNOWN",
    "SQLITE_COMMIT_OUTCOME_UNKNOWN",
  ])("invalidates the renderer facade when native reports %s", async (code) => {
    executor = await TauriSqliteExecutor.open();
    mocks.invoke.mockRejectedValueOnce({ code, stage: "select", outcome: "not_confirmed" });

    await expect(executor.select("SELECT 1 AS value")).rejects.toMatchObject({ code });
    await expect(executor.select("SELECT 1 AS value")).rejects.toThrow("database is closed");

    executor = await TauriSqliteExecutor.open();
    expect(events.filter((event) => event === "native_sqlite_open")).toHaveLength(2);
  });

  it("enforces read-only mutation rejection and safe JavaScript integer binds", async () => {
    executor = await TauriSqliteExecutor.open();

    await expect(
      executor.readTransaction((transaction) =>
        transaction.execute("INSERT INTO example VALUES (1)"),
      ),
    ).rejects.toThrow("read-only");
    expect(events).not.toContain("native_sqlite_transaction_execute");
    expect(events).toContain("native_sqlite_rollback");

    await expect(
      executor.select("SELECT ? AS value", [Number.MAX_SAFE_INTEGER + 1]),
    ).rejects.toThrow("safe JavaScript integers");
  });

  it("returns only opaque native file tickets for every maintenance dialog", async () => {
    executor = await TauriSqliteExecutor.open();
    const backupTicket = "c".repeat(64);
    const rollbackTicket = "d".repeat(64);
    mocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      switch (command) {
        case "native_choose_backup_destination":
          return { ticket: backupTicket };
        case "native_choose_pre_restore_backup_destination":
          return { ticket: rollbackTicket };
        case "native_choose_restore_source":
          return null;
        default:
          return undefined;
      }
    });

    await expect(executor.chooseBackupDestination()).resolves.toEqual({
      ticket: backupTicket,
    });
    await expect(executor.choosePreRestoreBackupDestination()).resolves.toEqual({
      ticket: rollbackTicket,
    });
    await expect(executor.chooseRestoreSource()).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("native_choose_backup_destination", {});
    expect(mocks.invoke).toHaveBeenCalledWith("native_choose_pre_restore_backup_destination", {});
    expect(mocks.invoke).toHaveBeenCalledWith("native_choose_restore_source", {});
  });

  it("rejects a native dialog receipt that contains a raw path or extra metadata", async () => {
    executor = await TauriSqliteExecutor.open();
    mocks.invoke.mockResolvedValueOnce({
      ticket: "C:\\Users\\writer\\backup.db",
    });
    await expect(executor.chooseBackupDestination()).rejects.toThrow("invalid path authorization");

    mocks.invoke.mockResolvedValueOnce({
      ticket: "e".repeat(64),
      path: "C:\\Users\\writer\\backup.db",
    });
    await expect(executor.chooseBackupDestination()).rejects.toThrow("invalid path authorization");
  });
});

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return {
    promise,
    resolve: (value) => {
      resolve?.(value);
    },
  };
}
