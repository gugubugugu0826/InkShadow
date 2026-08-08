import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  StorySqlExecuteResult,
  StorySqlExecutor,
  StorySqlPrimitive,
  StorySqlTransaction,
} from "../src/index.js";

export class NodeStorySqliteExecutor implements StorySqlExecutor {
  public readonly database: DatabaseSync;

  public constructor(migration: string, path = ":memory:") {
    this.database = new DatabaseSync(path);
    this.database.exec(migration);
  }

  public select<Row extends object>(
    query: string,
    bindValues: readonly StorySqlPrimitive[] = [],
  ): Promise<Row[]> {
    const rows = this.database.prepare(query).all(...toSqlValues(bindValues));
    return Promise.resolve(rows as Row[]);
  }

  public execute(
    query: string,
    bindValues: readonly StorySqlPrimitive[] = [],
  ): Promise<StorySqlExecuteResult> {
    const result = this.database.prepare(query).run(...toSqlValues(bindValues));
    return Promise.resolve({
      rowsAffected: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid),
    });
  }

  public async transaction<Value>(
    operation: (transaction: StorySqlTransaction) => Promise<Value>,
  ): Promise<Value> {
    if (this.database.isTransaction) {
      throw new Error("Nested story persistence transactions are not supported.");
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

  public close(): void {
    if (this.database.isTransaction) {
      this.database.exec("ROLLBACK");
    }
    this.database.close();
  }
}

function toSqlValues(values: readonly StorySqlPrimitive[]): SQLInputValue[] {
  return [...values];
}
