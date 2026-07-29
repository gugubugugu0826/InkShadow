import {
  RecoveryDraft,
  parseIsoUtcTimestamp,
  type AppError,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { type ExecuteResult, type SqlExecutor, type TransactionExecutor } from "../src/executor.js";
import { SqliteRecoveryDraftRepository } from "../src/sqlite-repositories.js";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000101" as UuidV7;
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000102" as UuidV7;
const DRAFT_ID = "019f9f4a-b3c7-7350-9226-000000000103" as UuidV7;

describe("SQLite persistence error normalization", () => {
  it.each([
    {
      nativeCode: "SQLITE_BUSY",
      retryable: true,
      expectedMessage: "The local database is busy and did not accept the write.",
    },
    {
      nativeCode: "SQLITE_DISK_FULL",
      retryable: false,
      expectedMessage: "The local disk is full and the write was not committed.",
    },
  ] as const)(
    "maps $nativeCode to a stable failed-save result",
    async ({ expectedMessage, nativeCode, retryable }) => {
      const repository = new SqliteRecoveryDraftRepository(
        new FailingExecutor({
          code: nativeCode,
          message: "engine-specific text must not cross the repository boundary",
          retryable,
        }),
      );

      const result = await repository.upsert(makeDraft());
      const error = expectError(result);
      expect(error).toMatchObject({
        code: "SAVE_FAILED",
        message: expectedMessage,
        retryable,
        details: {
          databaseCode: nativeCode,
          operation: "save recovery draft",
        },
      });
      expect(error.message).not.toContain("engine-specific");
    },
  );
});

class FailingExecutor implements SqlExecutor {
  public constructor(private readonly failure: unknown) {}

  public select<Row extends object>(): Promise<Row[]> {
    return Promise.reject(this.failure);
  }

  public execute(): Promise<ExecuteResult> {
    return Promise.reject(this.failure);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return operation(this);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeDraft(): RecoveryDraft {
  const now = parseIsoUtcTimestamp("2026-07-28T08:00:00.000Z");
  if (!now.ok) {
    throw now.error;
  }
  const draft = RecoveryDraft.create({
    id: DRAFT_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    baseRevision: 1,
    content: "磁盘故障时仍在编辑器内存中的恢复正文",
    cursorOffset: 8,
    now: now.value,
  });
  if (!draft.ok) {
    throw draft.error;
  }
  return draft.value;
}

function expectError<Value>(result: Result<Value, AppError>): AppError {
  if (result.ok) {
    throw new Error("Expected the SQLite operation to fail.");
  }
  return result.error;
}
