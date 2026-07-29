import { StoryCoreError } from "../errors.js";
import { err, ok, type Result } from "../result.js";
import type { StorySqlTransaction } from "./executor.js";

export class StoryPersistenceAbort extends Error {
  public constructor(public readonly storyError: StoryCoreError) {
    super(storyError.message);
    this.name = "StoryPersistenceAbort";
  }
}

export function abortPersistence(error: StoryCoreError): never {
  throw new StoryPersistenceAbort(error);
}

export async function runPersistence<Value>(
  operation: () => Promise<Value>,
): Promise<Result<Value, StoryCoreError>> {
  try {
    return ok(await operation());
  } catch (cause: unknown) {
    return err(
      cause instanceof StoryPersistenceAbort ? cause.storyError : repositoryFailure(cause),
    );
  }
}

export function serializeSnapshot(snapshot: unknown): string {
  // Every caller passes a validated aggregate snapshot. JSON failures still
  // throw and are converted to a repository error by runPersistence.
  return JSON.stringify(snapshot);
}

export function parseSnapshot(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (cause: unknown) {
    abortPersistence(repositoryFailure(cause, "Stored story snapshot is not valid JSON."));
  }
}

export function abortCorruptSnapshot(causeCode: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message: "Stored story data failed integrity validation.",
      actions: ["CONTACT_SUPPORT"],
      details: { causeCode },
    }),
  );
}

export function assertNextRevision(
  entity: string,
  newRevision: number,
  expectedRevision: number,
): void {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    newRevision !== expectedRevision + 1
  ) {
    abortPersistence(
      new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: `${entity} persistence requires exactly one validated revision step.`,
        actions: ["RETRY", "CONTACT_SUPPORT"],
      }),
    );
  }
}

export async function abortRevisionConflict(
  transaction: StorySqlTransaction,
  input: {
    readonly table: string;
    readonly idColumn: string;
    readonly id: string;
    readonly entity: string;
    readonly expectedRevision: number;
  },
): Promise<never> {
  const rows = await transaction.select<{ revision: number }>(
    `SELECT revision FROM ${input.table} WHERE ${input.idColumn} = ?`,
    [input.id],
  );
  abortPersistence(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: `${input.entity} changed before it could be persisted.`,
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: {
        expectedRevision: input.expectedRevision,
        actualRevision: rows[0]?.revision ?? null,
      },
    }),
  );
}

export function repositoryFailure(
  cause: unknown,
  message = "Story persistence operation failed.",
): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message,
    retryable: true,
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: {
      causeName: cause instanceof Error ? cause.name : "UnknownError",
    },
  });
}
