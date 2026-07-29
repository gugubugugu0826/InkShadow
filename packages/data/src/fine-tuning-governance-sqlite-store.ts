import type { ExecuteResult, SqlExecutor, SqlPrimitive, TransactionExecutor } from "./executor.js";

/**
 * Data-layer executor boundary for fine-tuning governance. Domain validation
 * and repository orchestration remain in story-core; Desktop composes that
 * repository with this adapter so @inkshadow/data never depends back on the
 * story package.
 */
export class FineTuningGovernanceSqliteStore implements SqlExecutor {
  public constructor(private readonly executor: SqlExecutor) {}

  public select<Row extends object>(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    return this.executor.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.executor.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.executor.transaction(operation);
  }

  public close(): Promise<void> {
    return this.executor.close();
  }
}

export function createFineTuningGovernanceSqliteStore(
  executor: SqlExecutor,
): FineTuningGovernanceSqliteStore {
  return new FineTuningGovernanceSqliteStore(executor);
}
