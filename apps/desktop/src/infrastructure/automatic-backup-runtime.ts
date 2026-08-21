import type { Clock, UuidV7Generator } from "@inkshadow/domain";
import { invoke } from "@tauri-apps/api/core";

import {
  AutomaticBackupService,
  type AutomaticBackupFileInspection,
  type AutomaticBackupIdGenerator,
  type AutomaticBackupLease,
  type AutomaticBackupManifest,
  type AutomaticBackupManifestEntry,
  type AutomaticBackupManifestSucceededEntry,
  type AutomaticBackupManifestWritingEntry,
  type AutomaticBackupPort,
  type AutomaticBackupRunResult,
  type VerifiedAutomaticBackupRoot,
} from "./automatic-backup-service";

const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
export const AUTOMATIC_BACKUP_RECHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const AUTOMATIC_BACKUP_SHUTDOWN_WAIT_MS = 1_500;

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
  public constructor(private readonly bridge: AutomaticBackupNativeBridge = tauriBridge) {}

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

  public createConsistentBackup(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestWritingEntry,
  ): Promise<unknown> {
    return this.bridge.invoke("native_automatic_backup_create_verified", {
      rootId: root.rootId,
      leaseToken: lease.token,
      request: nativeFileRequest(entry),
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
    entry: AutomaticBackupManifestSucceededEntry,
  ): Promise<unknown> {
    return this.bridge.invoke("native_automatic_backup_delete_file", {
      rootId: root.rootId,
      leaseToken: lease.token,
      request: nativeFileRequest(entry),
    });
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
    private readonly shutdownWaitMilliseconds = AUTOMATIC_BACKUP_SHUTDOWN_WAIT_MS,
  ) {
    if (
      !Number.isSafeInteger(recheckIntervalMilliseconds) ||
      recheckIntervalMilliseconds < 60_000 ||
      recheckIntervalMilliseconds > 24 * 60 * 60 * 1_000
    ) {
      throw new Error("AUTOMATIC_BACKUP_RECHECK_INTERVAL_INVALID");
    }
    if (
      !Number.isSafeInteger(shutdownWaitMilliseconds) ||
      shutdownWaitMilliseconds < 0 ||
      shutdownWaitMilliseconds > 10_000
    ) {
      throw new Error("AUTOMATIC_BACKUP_SHUTDOWN_WAIT_INVALID");
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
    const activeCheck = this.activeCheck;
    if (activeCheck === null || this.shutdownWaitMilliseconds === 0) return;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      activeCheck,
      new Promise<void>((resolve) => {
        timeoutHandle = globalThis.setTimeout(resolve, this.shutdownWaitMilliseconds);
      }),
    ]);
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
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
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
}): AutomaticBackupRuntime {
  const port = new TauriAutomaticBackupPort();
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

function nativeFileRequest(entry: AutomaticBackupManifestEntry): Readonly<{
  backupId: string;
  fileName: string;
  absolutePath: string;
  status: AutomaticBackupManifestEntry["status"];
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
