import type { NativePathTicket } from "../src/tauri-sqlite.js";
import type { ExecuteResult, SqlExecutor, SqlPrimitive } from "../src/executor.js";
import { DatabaseMaintenanceService } from "../src/maintenance.js";
import { describe, expect, it } from "vitest";

class NativeTicketBackupExecutor implements SqlExecutor {
  public readonly maintenanceBindings: SqlPrimitive[][] = [];

  public select<Row extends object>(query: string): Promise<Row[]> {
    if (query === "PRAGMA integrity_check(100)") {
      return rows<Row>([{ integrity_check: "ok" }]);
    }
    if (
      query === "PRAGMA foreign_key_check" ||
      query === "PRAGMA restore_source.foreign_key_check" ||
      query.includes("sqlite_schema")
    ) {
      return Promise.resolve([]);
    }
    if (query === "PRAGMA restore_source.integrity_check(100)") {
      return rows<Row>([{ integrity_check: "ok" }]);
    }
    if (query === "PRAGMA database_list") {
      return rows<Row>([
        { seq: 0, name: "main", file: "native://main" },
        { seq: 2, name: "restore_source", file: "native://restore-source" },
      ]);
    }
    return Promise.reject(new Error(`Unexpected maintenance query: ${query}`));
  }

  public execute(query: string, bindValues: readonly SqlPrimitive[] = []): Promise<ExecuteResult> {
    if (query === "VACUUM INTO ?" || query === "ATTACH DATABASE ? AS restore_source") {
      this.maintenanceBindings.push([...bindValues]);
    } else if (query !== "DETACH DATABASE restore_source") {
      return Promise.reject(new Error(`Unexpected maintenance statement: ${query}`));
    }
    return Promise.resolve({ rowsAffected: 0 });
  }

  public transaction<Value>(): Promise<Value> {
    return Promise.reject(new Error("A backup verification must not start a write transaction."));
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("DatabaseMaintenanceService native path authorization", () => {
  it("binds the opaque ticket without returning or rendering it in the receipt", async () => {
    const ticket = "d".repeat(64) as NativePathTicket;
    const executor = new NativeTicketBackupExecutor();
    const service = new DatabaseMaintenanceService(executor);

    const result = await service.createConsistentBackup(ticket);

    expect(result).toEqual({
      ok: true,
      value: {
        destinationKind: "user_selected_file",
        integrityVerified: true,
      },
    });
    expect(executor.maintenanceBindings).toEqual([[ticket], [ticket]]);
    expect(JSON.stringify(result)).not.toContain(ticket);
  });
});

function rows<Row extends object>(values: readonly object[]): Promise<Row[]> {
  return Promise.resolve(values as Row[]);
}
