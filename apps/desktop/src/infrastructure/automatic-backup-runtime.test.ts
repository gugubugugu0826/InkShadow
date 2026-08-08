import { describe, expect, it, vi } from "vitest";

import type { DatabaseBackupReceipt, NativePathTicket } from "@inkshadow/data";
import { AppError, err, ok } from "@inkshadow/domain";

import type {
  AutomaticBackupFilePresent,
  AutomaticBackupRunResult,
  VerifiedAutomaticBackupRoot,
} from "./automatic-backup-service";
import {
  ScheduledAutomaticBackupRuntime,
  TauriAutomaticBackupPort,
  type AutomaticBackupNativeBridge,
  type AutomaticBackupRuntimeClock,
  type AutomaticBackupTimer,
} from "./automatic-backup-runtime";

const ROOT = {
  absolutePath: "D:/InkShadow/app-data/automatic-backups/v1",
  canonicalAbsolutePath: "D:/InkShadow/app-data/automatic-backups/v1",
  rootId: "inkshadow-test-root-0001",
  pathStyle: "windows",
} as VerifiedAutomaticBackupRoot;
const LEASE = { token: "a".repeat(64) };
const TICKET = "b".repeat(64) as NativePathTicket;
const BACKUP_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const FILE_NAME = `inkshadow-auto-v1-20260808T040000000Z-${BACKUP_ID}.sqlite3`;
const ABSOLUTE_PATH = `${ROOT.absolutePath}/${FILE_NAME}`;

describe("TauriAutomaticBackupPort", () => {
  it("uses a native managed ticket and the existing consistent-backup creator", async () => {
    const file = presentFile();
    const bridge = new StubNativeBridge({
      native_automatic_backup_prepare_destination: { ticket: TICKET },
      native_automatic_backup_inspect_file: file,
    });
    const createConsistentBackup = vi.fn().mockResolvedValue(
      ok<DatabaseBackupReceipt>({
        destinationKind: "user_selected_file",
        integrityVerified: true,
      }),
    );
    const port = new TauriAutomaticBackupPort({ createConsistentBackup }, bridge);

    await expect(
      port.createConsistentBackup(ROOT, LEASE, {
        backupId: BACKUP_ID,
        fileName: FILE_NAME,
        absolutePath: ABSOLUTE_PATH,
      }),
    ).resolves.toEqual(file);

    expect(createConsistentBackup).toHaveBeenCalledWith(TICKET);
    expect(bridge.calls.map(({ command }) => command)).toEqual([
      "native_automatic_backup_prepare_destination",
      "native_automatic_backup_inspect_file",
    ]);
    expect(JSON.stringify(bridge.calls)).not.toContain("inkshadow.db");
  });

  it("requests exact pending-file cleanup when consistent backup fails", async () => {
    const bridge = new StubNativeBridge({
      native_automatic_backup_prepare_destination: { ticket: TICKET },
      native_automatic_backup_cleanup_failed_creation: null,
    });
    const createConsistentBackup = vi.fn().mockResolvedValue(
      err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "safe test failure",
        }),
      ),
    );
    const port = new TauriAutomaticBackupPort({ createConsistentBackup }, bridge);

    await expect(
      port.createConsistentBackup(ROOT, LEASE, {
        backupId: BACKUP_ID,
        fileName: FILE_NAME,
        absolutePath: ABSOLUTE_PATH,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_ERROR" });
    expect(bridge.calls.map(({ command }) => command)).toEqual([
      "native_automatic_backup_prepare_destination",
      "native_automatic_backup_cleanup_failed_creation",
    ]);
  });

  it("never sends a raw destination to the native ticket command without manifest identity", async () => {
    const bridge = new StubNativeBridge({
      native_automatic_backup_prepare_destination: { ticket: "not-a-ticket" },
    });
    const createConsistentBackup = vi.fn();
    const port = new TauriAutomaticBackupPort({ createConsistentBackup }, bridge);

    await expect(
      port.createConsistentBackup(ROOT, LEASE, {
        backupId: BACKUP_ID,
        fileName: FILE_NAME,
        absolutePath: ABSOLUTE_PATH,
      }),
    ).rejects.toMatchObject({ code: "AUTOMATIC_BACKUP_TICKET_INVALID" });
    expect(createConsistentBackup).not.toHaveBeenCalled();
    expect(bridge.calls[0]?.arguments_).toMatchObject({
      rootId: ROOT.rootId,
      leaseToken: LEASE.token,
      request: { backupId: BACKUP_ID, fileName: FILE_NAME, absolutePath: ABSOLUTE_PATH },
    });
  });
});

describe("ScheduledAutomaticBackupRuntime", () => {
  it("checks immediately, reports startup failure safely, and continues scheduling", async () => {
    const runIfDue = vi.fn().mockRejectedValue(
      Object.assign(new Error("must not be logged"), {
        code: "AUTOMATIC_BACKUP_ROOT_UNAVAILABLE",
        secretPath: "C:/private/novel.sqlite3",
      }),
    );
    const timer = new ManualTimer();
    const failure = vi.fn();
    const runtime = new ScheduledAutomaticBackupRuntime(
      { runIfDue },
      fixedClock(),
      timer,
      { failure },
      60_000,
    );

    expect(() => runtime.start()).not.toThrow();
    await vi.waitFor(() => expect(runIfDue).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(failure).toHaveBeenCalledWith("AUTOMATIC_BACKUP_ROOT_UNAVAILABLE"),
    );
    expect(timer.pendingCount).toBe(1);
    expect(failure).toHaveBeenCalledWith("AUTOMATIC_BACKUP_ROOT_UNAVAILABLE");
    expect(JSON.stringify(failure.mock.calls)).not.toContain("private/novel");

    timer.fireNext();
    await vi.waitFor(() => expect(runIfDue).toHaveBeenCalledTimes(2));
    await runtime.stop();
  });

  it("coalesces overlapping checks and clears the recheck timer on shutdown", async () => {
    let resolveRun: ((value: AutomaticBackupRunResult) => void) | undefined;
    const pending = new Promise<AutomaticBackupRunResult>((resolve) => {
      resolveRun = resolve;
    });
    const runIfDue = vi.fn().mockReturnValue(pending);
    const timer = new ManualTimer();
    const runtime = new ScheduledAutomaticBackupRuntime(
      { runIfDue },
      fixedClock(),
      timer,
      { failure: vi.fn() },
      60_000,
    );

    runtime.start();
    const duplicate = runtime.checkNow();
    await vi.waitFor(() => expect(runIfDue).toHaveBeenCalledOnce());
    resolveRun?.(notDueRun());
    await expect(duplicate).resolves.toMatchObject({ state: "ready" });
    await vi.waitFor(() => expect(timer.pendingCount).toBe(1));

    await runtime.stop();
    expect(timer.pendingCount).toBe(0);
    expect(timer.clearCount).toBe(1);
  });
});

class StubNativeBridge implements AutomaticBackupNativeBridge {
  public readonly calls: {
    readonly command: string;
    readonly arguments_: Record<string, unknown>;
  }[] = [];

  public constructor(private readonly responses: Readonly<Record<string, unknown>>) {}

  public invoke<Output>(command: string, arguments_: Record<string, unknown>): Promise<Output> {
    this.calls.push({ command, arguments_ });
    if (!(command in this.responses)) {
      return Promise.reject(new Error(`unexpected command ${command}`));
    }
    return Promise.resolve(structuredClone(this.responses[command]) as Output);
  }
}

class ManualTimer implements AutomaticBackupTimer {
  private readonly callbacks: (() => void)[] = [];
  public clearCount = 0;

  public get pendingCount(): number {
    return this.callbacks.length;
  }

  public set(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }

  public clear(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
    this.clearCount += 1;
  }

  public fireNext(): void {
    const callback = this.callbacks.shift();
    if (callback === undefined) throw new Error("no timer is pending");
    callback();
  }
}

function fixedClock(): AutomaticBackupRuntimeClock {
  return {
    now: () => ({
      timestamp: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    }),
  };
}

function notDueRun(): AutomaticBackupRunResult {
  return {
    status: "not_due",
    dueSlot: "2026-08-08",
    nextDueAt: "2026-08-09T03:00:00.000Z",
    createdBackup: null,
    recoveredPendingCount: 0,
    prunedCount: 0,
    missedSlotCount: 0,
  };
}

function presentFile(): AutomaticBackupFilePresent {
  return {
    exists: true,
    fileName: FILE_NAME,
    absolutePath: ABSOLUTE_PATH,
    canonicalAbsolutePath: ABSOLUTE_PATH,
    byteLength: 4096,
    sha256: "a".repeat(64),
    integrityVerified: true,
  };
}
