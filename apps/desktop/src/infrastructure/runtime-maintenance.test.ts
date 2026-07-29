import type { ExecuteResult, NativePathTicket, NativePathTicketReceipt } from "@inkshadow/data";
import { describe, expect, it } from "vitest";

import { createTauriRuntimeMaintenance, type NativeMaintenanceExecutor } from "./runtime";

class StubNativeMaintenanceExecutor implements NativeMaintenanceExecutor {
  public readonly calls: string[] = [];

  public constructor(
    private readonly backupTicket: NativePathTicket,
    private readonly rollbackTicket: NativePathTicket,
    private readonly restoreTicket: NativePathTicket | null,
  ) {}

  public select<Row extends object>(): Promise<Row[]> {
    return Promise.reject(new Error("SQL should not run while choosing a file."));
  }

  public execute(): Promise<ExecuteResult> {
    return Promise.reject(new Error("SQL should not run while choosing a file."));
  }

  public transaction<Value>(): Promise<Value> {
    return Promise.reject(new Error("A transaction should not run while choosing a file."));
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  public chooseBackupDestination(): Promise<NativePathTicketReceipt> {
    this.calls.push("backup");
    return Promise.resolve({ ticket: this.backupTicket });
  }

  public choosePreRestoreBackupDestination(): Promise<NativePathTicketReceipt> {
    this.calls.push("rollback");
    return Promise.resolve({ ticket: this.rollbackTicket });
  }

  public chooseRestoreSource(): Promise<NativePathTicketReceipt | null> {
    this.calls.push("restore");
    return Promise.resolve(this.restoreTicket === null ? null : { ticket: this.restoreTicket });
  }
}

describe("Tauri runtime maintenance path authorization", () => {
  it("unwraps only opaque tickets from the native executor and preserves cancellation", async () => {
    const backupTicket = "a".repeat(64) as NativePathTicket;
    const rollbackTicket = "b".repeat(64) as NativePathTicket;
    const executor = new StubNativeMaintenanceExecutor(backupTicket, rollbackTicket, null);
    const maintenance = createTauriRuntimeMaintenance(executor);

    await expect(maintenance.chooseBackupDestination()).resolves.toBe(backupTicket);
    await expect(maintenance.choosePreRestoreBackupDestination()).resolves.toBe(rollbackTicket);
    await expect(maintenance.chooseRestoreSource()).resolves.toBeNull();
    expect(executor.calls).toEqual(["backup", "rollback", "restore"]);
  });
});
