/**
 * Minimal SQL execution contract for story persistence.
 *
 * The interface is intentionally structural: `@inkshadow/data` executors can be
 * injected without making the domain package depend on the data package.
 * Implementations must roll a transaction back when `operation` throws.
 */
export type StorySqlPrimitive = string | number | null | Uint8Array;

export interface StorySqlExecuteResult {
  readonly rowsAffected: number;
  readonly lastInsertId?: number;
}

export interface StorySqlTransaction {
  select<Row extends object>(
    query: string,
    bindValues?: readonly StorySqlPrimitive[],
  ): Promise<Row[]>;

  execute(query: string, bindValues?: readonly StorySqlPrimitive[]): Promise<StorySqlExecuteResult>;
}

export interface StorySqlExecutor extends StorySqlTransaction {
  transaction<Value>(
    operation: (transaction: StorySqlTransaction) => Promise<Value>,
  ): Promise<Value>;
}
