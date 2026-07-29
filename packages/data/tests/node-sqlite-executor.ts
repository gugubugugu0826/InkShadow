import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  TransactionNestingError,
  type ExecuteResult,
  type SqlExecutor,
  type SqlPrimitive,
  type TransactionExecutor,
} from "../src/executor.js";

export class NodeSqliteExecutor implements SqlExecutor {
  public readonly database: DatabaseSync;

  public constructor(migration: string, path = ":memory:") {
    this.database = new DatabaseSync(path);
    this.database.exec(migration);
  }

  public async select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    const rows = this.database.prepare(query).all(...toSqliteValues(bindValues));
    return rows as Row[];
  }

  public async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<ExecuteResult> {
    const result = this.database.prepare(query).run(...toSqliteValues(bindValues));
    return {
      rowsAffected: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid),
    };
  }

  public async transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    if (this.database.isTransaction) {
      throw new TransactionNestingError();
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = await operation(this);
      this.database.exec("COMMIT");
      return value;
    } catch (error: unknown) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.database.isTransaction) {
      this.database.exec("ROLLBACK");
    }
    this.database.close();
  }
}

function toSqliteValues(values: readonly SqlPrimitive[]): SQLInputValue[] {
  return [...values];
}
