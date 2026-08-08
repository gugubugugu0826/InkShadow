import {
  DatabaseMaintenanceService,
  type DatabaseBackupReceipt,
  type NativePathTicket,
  type SqlExecutor,
} from "@inkshadow/data";
import type { AppError, Clock, Result, UuidV7Generator } from "@inkshadow/domain";
import { invoke } from "@tauri-apps/api/core";

import {
  AutomaticBackupService,
  type AutomaticBackupFileInspection,
  type AutomaticBackupIdGenerator,
  type AutomaticBackupLease,
  type AutomaticBackupManifest,
  type AutomaticBackupManifestEntry,
  type AutomaticBackupManifestReadyEntry,
  type AutomaticBackupPort,
  type AutomaticBackupRunResult,
  type VerifiedAutomaticBackupRoot,
} from "./automatic-backup-service";

const NATIVE_TICKET_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
export const AUTOMATIC_BACKUP_RECHECK_INTERVAL_MS = 60 * 60 * 1_000;

interface ConsistentBackupCreator {
  createConsistentBackup(
    destinationTicket: NativePathTicket,
  ): Promise<Result<DatabaseBackupReceipt, AppError>>;
}

export interface AutomaticBackupNativeBridge {
  invoke<Output>(command: string, arguments_: Record<string, unknown>): Promise<Output>;
}

export interface AutomaticBackupTimer {
  set(callback: () => void, delayMilliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface AutomaticBackupRuntimeClock {
  now(): Readonly<{ timestamp: string; timezoneOffsetMinutes: number }>;
}

export interface AutomaticBackupRuntimeLogger {
  failure(code: string): void;
}

export interface AutomaticBackupRuntimeCheckResult {
  readonly state: "ready" | "degraded";
  readonly run: AutomaticBackupRunResult | null;
  readonly errorCode: string | null;
}

export interface AutomaticBackupRuntime {
  readonly available: true;
  start(): void;
  checkNow(): Promise<AutomaticBackupRuntimeCheckResult>;
  stop(): Promise<void>;
}

const tauriBridge: AutomaticBackupNativeBridge = {
  invoke: <Output>(command: string, arguments_: Record<string, unknown>) =>
    invoke<Output>(command, arguments_),
};

const browserTimer: AutomaticBackupTimer = {
  set: (callback, delayMilliseconds) => globalThis.setTimeout(callback, delayMilliseconds),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const safeLogger: AutomaticBackupRuntimeLogger = {
  failure: (code) => {
    globalThis.console.error(`[${code}] Automatic backup check was degraded.`);
  },
};

/**
 * Tauri-only adapter. Every filesystem value returned by native code remains
 * untrusted until AutomaticBackupService validates it. No browser fallback is
 * provided because a browser cannot create a verified local SQLite backup.
 */
export class TauriAutomaticBackupPort implements AutomaticBackupPort {
  public constructor(
    private readonly backupCreator: ConsistentBackupCreator,
    private readonly bridge: AutomaticBackupNativeBridge = tauriBridge,
  ) {}

  public inspectManagedRoot(): Promise<unknown> {
    return this.bridge.invoke("native_automatic_backup_inspect_root", {});
  }

  public acquireLease(
    root: VerifiedAutomaticBackupRoot,
    input: Readonly<{ ownerId: string; acquiredAt: string; expiresAt: string }>,
  ): Promise<AutomaticBackupLease | null> {
    const durationMilliseconds = Date.parse(input.expiresAt) - Date.parse(input.acquiredAt);
    const leaseDurationMinutes = durationMilliseconds / 60_000;
    if (!Number.isInteger(leaseDurationMinutes)) {
      return Promise.reject(new Error("AUTOMATIC_BACKUP_LEASE_DURATION_INVALID"));
    }
    return this.bridge.invoke("native_automatic_backup_acquire_lease", {
      rootId: root.rootId,
      ownerId: input.ownerId,
      leaseDurationMinutes,
    });
  }

  public releaseLease(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
  ): Promise<void> {
    return this.bridge.invoke("native_automatic_backup_release_lease", {
      rootId: root.rootId,
      leaseToken: lease.token,
    });
  }

  public readManifest(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
  ): Promise<unknown> {
    return this.bridge.invoke("native_automatic_backup_read_manifest", {
      rootId: root.rootId,
      leaseToken: lease.token,
    });
  }

  public writeManifest(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    expectedRevision: number,
    manifest: AutomaticBackupManifest,
  ): Promise<unknown> {
    return this.bridge.invoke("native_automatic_backup_write_manifest", {
      rootId: root.rootId,
      leaseToken: lease.token,
      expectedRevision,
      manifest,
    });
  }

  public async createConsistentBackup(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    request: Readonly<{ backupId: string; fileName: string; absolutePath: string }>,
  ): Promise<unknown> {
    const receipt = await this.bridge.invoke<unknown>(
      "native_automatic_backup_prepare_destination",
      {
        rootId: root.rootId,
        leaseToken: lease.token,
        request,
      },
    );
    const destinationTicket = readNativeTicket(receipt);
    const backup = await this.backupCreator.createConsistentBackup(destinationTicket);
    if (!backup.ok) {
      await this.cleanupFailedCreation(root, lease, request);
      throw new AutomaticBackupRuntimeError(backup.error.code);
    }
    return this.bridge.invoke("native_automatic_backup_inspect_file", {
      rootId: root.rootId,
      leaseToken: lease.token,
      request,
    });
  }

  public inspectBackupFile(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestEntry,
  ): Promise<AutomaticBackupFileInspection> {
    return this.bridge.invoke("native_automatic_backup_inspect_file", {
      rootId: root.rootId,
      leaseToken: lease.token,
      request: nativeFileRequest(entry),
    });
  }

  public deleteBackupFile(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestReadyEntry,
  ): Promise<unknown> {
    return this.bridge.invoke("native_automatic_backup_delete_file", {
      rootId: root.rootId,
      leaseToken: lease.token,
      request: nativeFileRequest(entry),
    });
  }

  private async cleanupFailedCreation(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    request: Readonly<{ backupId: string; fileName: string; absolutePath: string }>,
  ): Promise<void> {
    await this.bridge
      .invoke("native_automatic_backup_cleanup_failed_creation", {
        rootId: root.rootId,
        leaseToken: lease.token,
        request,
      })
      .catch(() => undefined);
  }
}

export class AutomaticBackupRuntimeError extends Error {
  public constructor(public readonly code: string) {
    super("Automatic backup runtime operation failed.");
    this.name = "AutomaticBackupRuntimeError";
  }
}

export class ScheduledAutomaticBackupRuntime implements AutomaticBackupRuntime {
  public readonly available = true as const;
  private started = false;
  private stopped = false;
  private timerHandle: unknown;
  private activeCheck: Promise<AutomaticBackupRuntimeCheckResult> | null = null;

  public constructor(
    private readonly service: Pick<AutomaticBackupService, "runIfDue">,
    private readonly clock: AutomaticBackupRuntimeClock,
    private readonly timer: AutomaticBackupTimer = browserTimer,
    private readonly logger: AutomaticBackupRuntimeLogger = safeLogger,
    private readonly recheckIntervalMilliseconds = AUTOMATIC_BACKUP_RECHECK_INTERVAL_MS,
  ) {
    if (
      !Number.isSafeInteger(recheckIntervalMilliseconds) ||
      recheckIntervalMilliseconds < 60_000 ||
      recheckIntervalMilliseconds > 24 * 60 * 60 * 1_000
    ) {
      throw new Error("AUTOMATIC_BACKUP_RECHECK_INTERVAL_INVALID");
    }
  }

  public start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.checkNow().finally(() => this.scheduleNext());
  }

  public checkNow(): Promise<AutomaticBackupRuntimeCheckResult> {
    if (this.stopped) {
      return Promise.resolve({
        state: "degraded",
        run: null,
        errorCode: "AUTOMATIC_BACKUP_RUNTIME_STOPPED",
      });
    }
    if (this.activeCheck !== null) return this.activeCheck;
    const check = Promise.resolve()
      .then(() => {
        const current = this.clock.now();
        return this.service.runIfDue({
          now: current.timestamp,
          timezoneOffsetMinutes: current.timezoneOffsetMinutes,
        });
      })
      .then(
        (run): AutomaticBackupRuntimeCheckResult => ({
          state: "ready",
          run,
          errorCode: null,
        }),
        (error: unknown): AutomaticBackupRuntimeCheckResult => {
          const errorCode = safeErrorCode(error);
          this.logger.failure(errorCode);
          return { state: "degraded", run: null, errorCode };
        },
      )
      .finally(() => {
        if (this.activeCheck === check) this.activeCheck = null;
      });
    this.activeCheck = check;
    return check;
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    if (this.timerHandle !== undefined) {
      this.timer.clear(this.timerHandle);
      this.timerHandle = undefined;
    }
    await this.activeCheck;
  }

  private scheduleNext(): void {
    if (!this.started || this.stopped || this.timerHandle !== undefined) return;
    this.timerHandle = this.timer.set(() => {
      this.timerHandle = undefined;
      void this.checkNow().finally(() => this.scheduleNext());
    }, this.recheckIntervalMilliseconds);
  }
}

export function createTauriAutomaticBackupRuntime(options: {
  readonly executor: SqlExecutor;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
}): AutomaticBackupRuntime {
  const maintenance = new DatabaseMaintenanceService(options.executor);
  const port = new TauriAutomaticBackupPort(maintenance);
  const ids: AutomaticBackupIdGenerator = { next: () => options.ids.next() };
  const service = new AutomaticBackupService(port, ids);
  const runtimeClock: AutomaticBackupRuntimeClock = {
    now: () => {
      const timestamp = options.clock.now();
      return {
        timestamp,
        timezoneOffsetMinutes: new Date(timestamp).getTimezoneOffset(),
      };
    },
  };
  return new ScheduledAutomaticBackupRuntime(service, runtimeClock);
}

function readNativeTicket(value: unknown): NativePathTicket {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    !("ticket" in value) ||
    typeof value.ticket !== "string" ||
    !NATIVE_TICKET_PATTERN.test(value.ticket)
  ) {
    throw new AutomaticBackupRuntimeError("AUTOMATIC_BACKUP_TICKET_INVALID");
  }
  return value.ticket as NativePathTicket;
}

function nativeFileRequest(entry: AutomaticBackupManifestEntry): Readonly<{
  backupId: string;
  fileName: string;
  absolutePath: string;
  status: "creating" | "ready";
  byteLength: number | null;
  sha256: string | null;
  retentionUntil: string;
}> {
  return Object.freeze({
    backupId: entry.backupId,
    fileName: entry.fileName,
    absolutePath: entry.absolutePath,
    status: entry.status,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    retentionUntil: entry.retentionUntil,
  });
}

function safeErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_ERROR_CODE_PATTERN.test(error.code)
  ) {
    return error.code;
  }
  return "AUTOMATIC_BACKUP_CHECK_FAILED";
}
