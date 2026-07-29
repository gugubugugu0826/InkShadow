export type SqlPrimitive = string | number | null | Uint8Array;

export interface ExecuteResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export interface TransactionExecutor {
  select<Row extends object>(query: string, bindValues?: readonly SqlPrimitive[]): Promise<Row[]>;

  execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult>;
}

export interface SqlExecutor extends TransactionExecutor {
  transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value>;

  close(): Promise<void>;
}

export class TransactionNestingError extends Error {
  public constructor() {
    super("Nested SQLite transactions are not supported.");
    this.name = "TransactionNestingError";
  }
}
