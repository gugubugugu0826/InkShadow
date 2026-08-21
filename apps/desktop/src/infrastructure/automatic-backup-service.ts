export const DEFAULT_AUTOMATIC_BACKUP_POLICY: AutomaticBackupPolicy = Object.freeze({
  scheduleHourLocal: 3,
  retentionDays: 30,
  leaseDurationMinutes: 120,
});

export interface AutomaticBackupPolicy {
  readonly scheduleHourLocal: number;
  readonly retentionDays: number;
  readonly leaseDurationMinutes: number;
}

export interface AutomaticBackupRunInput {
  readonly now: string;
  /** JavaScript Date#getTimezoneOffset semantics for `now`. */
  readonly timezoneOffsetMinutes: number;
}

export interface AutomaticBackupRootInspection {
  readonly absolutePath: string;
  readonly canonicalAbsolutePath: string;
  readonly ownershipMarker: Readonly<{
    readonly product: "InkShadow";
    readonly purpose: "automatic_backups";
    readonly schemaVersion: 1;
    readonly rootId: string;
  }> | null;
}

declare const verifiedAutomaticBackupRootBrand: unique symbol;

export interface VerifiedAutomaticBackupRoot {
  readonly absolutePath: string;
  readonly canonicalAbsolutePath: string;
  readonly rootId: string;
  readonly pathStyle: "windows" | "posix";
  readonly [verifiedAutomaticBackupRootBrand]: true;
}

export interface AutomaticBackupLease {
  readonly token: string;
}

export interface AutomaticBackupFileMissing {
  readonly exists: false;
}

export interface AutomaticBackupFilePresent {
  readonly exists: true;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly canonicalAbsolutePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly integrityVerified: true;
}

export type AutomaticBackupFileInspection = AutomaticBackupFileMissing | AutomaticBackupFilePresent;

export interface AutomaticBackupPort {
  /** Must resolve the native app-owned directory and its non-symlink canonical path. */
  inspectManagedRoot(): Promise<unknown>;
  /** Must be process-safe. Returning null means another scheduler owns the lease. */
  acquireLease(
    root: VerifiedAutomaticBackupRoot,
    input: Readonly<{ ownerId: string; acquiredAt: string; expiresAt: string }>,
  ): Promise<AutomaticBackupLease | null>;
  releaseLease(root: VerifiedAutomaticBackupRoot, lease: AutomaticBackupLease): Promise<void>;
  /** The manifest is untrusted until the service validates it. */
  readManifest(root: VerifiedAutomaticBackupRoot, lease: AutomaticBackupLease): Promise<unknown>;
  /** Must compare-and-swap expectedRevision and atomically replace the manifest. */
  writeManifest(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    expectedRevision: number,
    manifest: AutomaticBackupManifest,
  ): Promise<unknown>;
  /** Must create and integrity-check a new SQLite backup without overwriting. */
  createConsistentBackup(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestWritingEntry,
  ): Promise<unknown>;
  /** Must use no-follow/reparse-safe inspection for this exact direct child. */
  inspectBackupFile(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestEntry,
  ): Promise<unknown>;
  /** Must condition deletion on the exact path, size and checksum in `entry`. */
  deleteBackupFile(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestSucceededEntry,
  ): Promise<unknown>;
}

interface AutomaticBackupManifestEntryBase {
  readonly backupId: string;
  readonly createdBy: "inkshadow_automatic_backup_service";
  readonly scheduleSlot: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly createdAt: string;
  readonly retentionUntil: string;
  readonly writeStartedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureKind: AutomaticBackupFailureKind | null;
}

export type AutomaticBackupFailureKind =
  | "database_busy"
  | "database_unavailable"
  | "disk_full"
  | "permission_denied"
  | "result_unconfirmed"
  | "target_conflict"
  | "verification_failed"
  | "write_failed";

export interface AutomaticBackupManifestReservedEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "reserved";
  readonly byteLength: null;
  readonly sha256: null;
  readonly writeStartedAt: null;
  readonly finishedAt: null;
  readonly failureKind: null;
}

export interface AutomaticBackupManifestWritingEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "writing";
  readonly byteLength: null;
  readonly sha256: null;
  readonly writeStartedAt: string;
  readonly finishedAt: null;
  readonly failureKind: null;
}

export interface AutomaticBackupManifestVerifyingEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "verifying";
  readonly byteLength: number;
  readonly sha256: string;
  readonly writeStartedAt: string;
  readonly finishedAt: null;
  readonly failureKind: null;
}

export interface AutomaticBackupManifestNotStartedEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "not_started";
  readonly byteLength: null;
  readonly sha256: null;
  readonly writeStartedAt: null;
  readonly finishedAt: string;
  readonly failureKind: AutomaticBackupFailureKind;
}

export interface AutomaticBackupManifestFailedEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "failed";
  readonly byteLength: null;
  readonly sha256: null;
  readonly writeStartedAt: string;
  readonly finishedAt: string;
  readonly failureKind: AutomaticBackupFailureKind;
}

export interface AutomaticBackupManifestUnknownEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "unknown";
  /** Kept only when the verifying state had already committed exact evidence. */
  readonly byteLength: number | null;
  readonly sha256: string | null;
  readonly writeStartedAt: string | null;
  readonly finishedAt: string;
  readonly failureKind: "result_unconfirmed";
}

export interface AutomaticBackupManifestSucceededEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "succeeded";
  readonly byteLength: number;
  readonly sha256: string;
  readonly writeStartedAt: string;
  readonly finishedAt: string;
  readonly failureKind: null;
}

export type AutomaticBackupManifestEntry =
  | AutomaticBackupManifestReservedEntry
  | AutomaticBackupManifestWritingEntry
  | AutomaticBackupManifestVerifyingEntry
  | AutomaticBackupManifestNotStartedEntry
  | AutomaticBackupManifestFailedEntry
  | AutomaticBackupManifestUnknownEntry
  | AutomaticBackupManifestSucceededEntry;

export interface AutomaticBackupManifest {
  readonly schemaVersion: 2;
  readonly rootId: string;
  readonly revision: number;
  readonly policy: Readonly<{
    readonly scheduleHourLocal: number;
    readonly retentionDays: number;
  }>;
  readonly lastSuccessfulSlot: string | null;
  readonly entries: readonly AutomaticBackupManifestEntry[];
  readonly updatedAt: string;
}

export interface AutomaticBackupRunResult {
  readonly status: "completed" | "not_due" | "busy" | "attention";
  readonly dueSlot: string;
  readonly nextDueAt: string;
  readonly createdBackup: AutomaticBackupManifestSucceededEntry | null;
  readonly attention: Readonly<{
    readonly status: "not_started" | "failed" | "unknown";
    readonly failureKind: AutomaticBackupFailureKind;
  }> | null;
  readonly recoveredPendingCount: number;
  readonly prunedCount: number;
  readonly missedSlotCount: number;
}

type AutomaticBackupCreationOutcome =
  | Readonly<{ outcome: "succeeded"; file: AutomaticBackupFilePresent }>
  | Readonly<{
      outcome: "not_started" | "failed" | "unknown";
      failureKind: AutomaticBackupFailureKind;
    }>;

export interface AutomaticBackupIdGenerator {
  next(): string;
}

const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,256}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DATE_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const AUTOMATIC_BACKUP_FILE_PATTERN =
  /^inkshadow-auto-v1-(\d{8}T\d{9}Z)-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.sqlite3$/u;
const MANIFEST_KEYS = [
  "schemaVersion",
  "rootId",
  "revision",
  "policy",
  "lastSuccessfulSlot",
  "entries",
  "updatedAt",
] as const;
const ENTRY_KEYS = [
  "backupId",
  "createdBy",
  "scheduleSlot",
  "fileName",
  "absolutePath",
  "createdAt",
  "retentionUntil",
  "status",
  "byteLength",
  "sha256",
  "writeStartedAt",
  "finishedAt",
  "failureKind",
] as const;
const LEGACY_ENTRY_KEYS = [
  "backupId",
  "createdBy",
  "scheduleSlot",
  "fileName",
  "absolutePath",
  "createdAt",
  "retentionUntil",
  "status",
  "byteLength",
  "sha256",
] as const;
const ROOT_INSPECTION_KEYS = ["absolutePath", "canonicalAbsolutePath", "ownershipMarker"] as const;
const ROOT_MARKER_KEYS = ["product", "purpose", "schemaVersion", "rootId"] as const;
const FILE_PRESENT_KEYS = [
  "exists",
  "fileName",
  "absolutePath",
  "canonicalAbsolutePath",
  "byteLength",
  "sha256",
  "integrityVerified",
] as const;
const CREATION_SUCCESS_KEYS = ["outcome", "file"] as const;
const CREATION_FAILURE_KEYS = ["outcome", "failureKind"] as const;
const FAILURE_KINDS = new Set<AutomaticBackupFailureKind>([
  "database_busy",
  "database_unavailable",
  "disk_full",
  "permission_denied",
  "result_unconfirmed",
  "target_conflict",
  "verification_failed",
  "write_failed",
]);

/**
 * Pure scheduling and safety coordinator for P39.
 *
 * This class deliberately does not start timers or touch the filesystem. A
 * native port must provide the owned app-data directory, a cross-process lease,
 * SQLite backup creation, atomic manifest CAS and checksum-conditional delete.
 * Browser development has no port and must not instantiate this service.
 */
export class AutomaticBackupService {
  private readonly policy: AutomaticBackupPolicy;

  public constructor(
    private readonly port: AutomaticBackupPort,
    private readonly ids: AutomaticBackupIdGenerator,
    policy: AutomaticBackupPolicy = DEFAULT_AUTOMATIC_BACKUP_POLICY,
  ) {
    this.policy = validatePolicy(policy);
  }

  public async runIfDue(input: AutomaticBackupRunInput): Promise<AutomaticBackupRunResult> {
    const now = validateTimestamp(input.now, "now");
    const timezoneOffsetMinutes = validateTimezoneOffset(input.timezoneOffsetMinutes);
    const schedule = resolveSchedule(now, timezoneOffsetMinutes, this.policy.scheduleHourLocal);
    const root = verifyManagedRoot(await this.port.inspectManagedRoot());
    const ownerId = validateUuid(this.ids.next(), "lease owner id");
    const lease = await this.port.acquireLease(root, {
      ownerId,
      acquiredAt: now,
      expiresAt: addMinutes(now, this.policy.leaseDurationMinutes),
    });
    if (lease === null) {
      return Object.freeze({
        status: "busy",
        dueSlot: schedule.dueSlot,
        nextDueAt: schedule.nextDueAt,
        createdBackup: null,
        attention: null,
        recoveredPendingCount: 0,
        prunedCount: 0,
        missedSlotCount: 0,
      });
    }
    validateLease(lease);

    try {
      const loaded = readManifest(
        await this.port.readManifest(root, lease),
        root,
        this.policy,
        now,
      );
      let manifest = loaded.manifest;
      let upgradedLegacyManifest = false;
      if (loaded.requiresUpgrade) {
        manifest = await this.saveManifest(
          root,
          lease,
          manifest,
          manifest.entries,
          manifest.lastSuccessfulSlot,
          now,
        );
        upgradedLegacyManifest = true;
      }
      const recovered = await this.recoverPendingEntries(root, lease, manifest, now);
      manifest = recovered.manifest;

      const missedSlotCount = countMissedSlots(manifest.lastSuccessfulSlot, schedule.dueSlot);
      let createdBackup: AutomaticBackupManifestSucceededEntry | null = null;
      let attention = attentionForSlot(manifest, schedule.dueSlot);
      if (missedSlotCount > 0 && attention === null) {
        const reserved = await this.reserveBackup(root, lease, manifest, schedule.dueSlot, now);
        manifest = reserved.manifest;

        const writing: AutomaticBackupManifestWritingEntry = Object.freeze({
          ...reserved.entry,
          status: "writing",
          writeStartedAt: now,
        });
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          writing,
          manifest.lastSuccessfulSlot,
          now,
        );

        let outcome: AutomaticBackupCreationOutcome | null;
        try {
          outcome = validateCreationOutcome(
            await this.port.createConsistentBackup(root, lease, writing),
            root,
            writing,
          );
        } catch {
          const unknown = unknownEntry(writing, now);
          manifest = await this.replaceEntry(
            root,
            lease,
            manifest,
            unknown,
            manifest.lastSuccessfulSlot,
            now,
          );
          attention = attentionFromEntry(unknown);
          outcome = null;
        }

        if (outcome?.outcome === "succeeded") {
          const verifying: AutomaticBackupManifestVerifyingEntry = Object.freeze({
            ...writing,
            status: "verifying",
            byteLength: outcome.file.byteLength,
            sha256: outcome.file.sha256,
          });
          manifest = await this.replaceEntry(
            root,
            lease,
            manifest,
            verifying,
            manifest.lastSuccessfulSlot,
            now,
          );
          createdBackup = Object.freeze({
            ...verifying,
            status: "succeeded",
            finishedAt: now,
          });
          manifest = await this.replaceEntry(
            root,
            lease,
            manifest,
            createdBackup,
            maxDateKey(manifest.lastSuccessfulSlot, createdBackup.scheduleSlot),
            now,
          );
        } else if (outcome?.outcome === "not_started") {
          const notStarted: AutomaticBackupManifestNotStartedEntry = Object.freeze({
            ...reserved.entry,
            status: "not_started",
            finishedAt: now,
            failureKind: outcome.failureKind,
          });
          manifest = await this.replaceEntry(
            root,
            lease,
            manifest,
            notStarted,
            manifest.lastSuccessfulSlot,
            now,
          );
          attention = attentionFromEntry(notStarted);
        } else if (outcome?.outcome === "failed") {
          const failed: AutomaticBackupManifestFailedEntry = Object.freeze({
            ...writing,
            status: "failed",
            finishedAt: now,
            failureKind: outcome.failureKind,
          });
          manifest = await this.replaceEntry(
            root,
            lease,
            manifest,
            failed,
            manifest.lastSuccessfulSlot,
            now,
          );
          attention = attentionFromEntry(failed);
        } else if (outcome?.outcome === "unknown") {
          const unknown = unknownEntry(writing, now);
          manifest = await this.replaceEntry(
            root,
            lease,
            manifest,
            unknown,
            manifest.lastSuccessfulSlot,
            now,
          );
          attention = attentionFromEntry(unknown);
        }
      }

      const pruned =
        createdBackup === null
          ? { manifest, prunedCount: 0 }
          : await this.pruneExpiredEntries(root, lease, manifest, now);
      const changed =
        upgradedLegacyManifest ||
        createdBackup !== null ||
        recovered.recoveredCount > 0 ||
        pruned.prunedCount > 0;
      return Object.freeze({
        status: attention === null ? (changed ? "completed" : "not_due") : "attention",
        dueSlot: schedule.dueSlot,
        nextDueAt: schedule.nextDueAt,
        createdBackup,
        attention,
        recoveredPendingCount: recovered.recoveredCount,
        prunedCount: pruned.prunedCount,
        missedSlotCount,
      });
    } finally {
      await this.port.releaseLease(root, lease).catch(() => undefined);
    }
  }

  private async recoverPendingEntries(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    initialManifest: AutomaticBackupManifest,
    now: string,
  ): Promise<{ readonly manifest: AutomaticBackupManifest; readonly recoveredCount: number }> {
    let manifest = initialManifest;
    let recoveredCount = 0;
    for (const entry of [...manifest.entries]) {
      if (!isPendingEntry(entry) && entry.status !== "unknown" && entry.status !== "succeeded") {
        continue;
      }

      let inspection: AutomaticBackupFileInspection;
      try {
        inspection = validateFileInspection(
          await this.port.inspectBackupFile(root, lease, entry),
          root,
          entry,
          recordedFileEvidence(entry),
        );
      } catch {
        if (entry.status === "unknown") continue;
        const unknown = unknownEntry(entry, now);
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          unknown,
          entry.status === "succeeded"
            ? latestSucceededSlotExcept(manifest, entry.backupId)
            : manifest.lastSuccessfulSlot,
          now,
        );
        recoveredCount += 1;
        continue;
      }

      if (entry.status === "succeeded") {
        if (inspection.exists) continue;
        const unknown = unknownEntry(entry, now);
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          unknown,
          latestSucceededSlotExcept(manifest, entry.backupId),
          now,
        );
        recoveredCount += 1;
        continue;
      }

      if (entry.status === "unknown") {
        if (!inspection.exists) continue;
        const succeeded: AutomaticBackupManifestSucceededEntry = Object.freeze({
          ...entry,
          status: "succeeded",
          byteLength: inspection.byteLength,
          sha256: inspection.sha256,
          writeStartedAt: entry.writeStartedAt ?? entry.createdAt,
          finishedAt: now,
          failureKind: null,
        });
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          succeeded,
          maxDateKey(manifest.lastSuccessfulSlot, succeeded.scheduleSlot),
          now,
        );
        recoveredCount += 1;
        continue;
      }

      if (entry.status === "reserved") {
        const terminal = inspection.exists
          ? unknownEntry(entry, now)
          : notStartedEntry(entry, now, "write_failed");
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          terminal,
          manifest.lastSuccessfulSlot,
          now,
        );
        recoveredCount += 1;
        continue;
      }
      if (!inspection.exists) {
        const unknown = unknownEntry(entry, now);
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          unknown,
          manifest.lastSuccessfulSlot,
          now,
        );
        recoveredCount += 1;
        continue;
      }
      const succeeded: AutomaticBackupManifestSucceededEntry = Object.freeze({
        ...entry,
        status: "succeeded",
        byteLength: inspection.byteLength,
        sha256: inspection.sha256,
        finishedAt: now,
        failureKind: null,
      });
      manifest = await this.replaceEntry(
        root,
        lease,
        manifest,
        succeeded,
        maxDateKey(manifest.lastSuccessfulSlot, succeeded.scheduleSlot),
        now,
      );
      recoveredCount += 1;
    }
    return { manifest, recoveredCount };
  }

  private async reserveBackup(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    manifest: AutomaticBackupManifest,
    scheduleSlot: string,
    now: string,
  ): Promise<{
    readonly manifest: AutomaticBackupManifest;
    readonly entry: AutomaticBackupManifestReservedEntry;
  }> {
    if (manifest.entries.some((entry) => entry.scheduleSlot === scheduleSlot)) {
      throw backupError(
        "AUTOMATIC_BACKUP_SLOT_CONFLICT",
        "当前计划日期已经存在自动备份清单记录，已停止以避免重复覆盖。",
      );
    }
    const backupId = validateUuid(this.ids.next(), "backup id");
    const fileName = automaticBackupFileName(now, backupId);
    const entry: AutomaticBackupManifestReservedEntry = Object.freeze({
      backupId,
      createdBy: "inkshadow_automatic_backup_service",
      scheduleSlot,
      fileName,
      absolutePath: joinDirectChild(root, fileName),
      createdAt: now,
      retentionUntil: addDays(now, this.policy.retentionDays),
      status: "reserved",
      byteLength: null,
      sha256: null,
      writeStartedAt: null,
      finishedAt: null,
      failureKind: null,
    });
    const next = await this.saveManifest(
      root,
      lease,
      manifest,
      [...manifest.entries, entry],
      manifest.lastSuccessfulSlot,
      now,
    );
    return { manifest: next, entry };
  }

  private replaceEntry(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    manifest: AutomaticBackupManifest,
    replacement: AutomaticBackupManifestEntry,
    lastSuccessfulSlot: string | null,
    now: string,
  ): Promise<AutomaticBackupManifest> {
    const found = manifest.entries.some((entry) => entry.backupId === replacement.backupId);
    if (!found) {
      throw backupError("AUTOMATIC_BACKUP_MANIFEST_CONFLICT", "自动备份清单在更新期间发生变化。");
    }
    return this.saveManifest(
      root,
      lease,
      manifest,
      manifest.entries.map((entry) =>
        entry.backupId === replacement.backupId ? replacement : entry,
      ),
      lastSuccessfulSlot,
      now,
    );
  }

  private removeEntry(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    manifest: AutomaticBackupManifest,
    backupId: string,
    now: string,
  ): Promise<AutomaticBackupManifest> {
    return this.saveManifest(
      root,
      lease,
      manifest,
      manifest.entries.filter((entry) => entry.backupId !== backupId),
      manifest.lastSuccessfulSlot,
      now,
    );
  }

  private async pruneExpiredEntries(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    initialManifest: AutomaticBackupManifest,
    now: string,
  ): Promise<{ readonly manifest: AutomaticBackupManifest; readonly prunedCount: number }> {
    let manifest = initialManifest;
    let prunedCount = 0;
    const newestSucceededId = [...manifest.entries]
      .filter(
        (entry): entry is AutomaticBackupManifestSucceededEntry => entry.status === "succeeded",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1)?.backupId;
    for (const entry of [...manifest.entries]) {
      if (
        entry.status !== "succeeded" ||
        entry.backupId === newestSucceededId ||
        Date.parse(entry.retentionUntil) > Date.parse(now)
      ) {
        continue;
      }
      // Revalidate the manifest entry before every destructive call. The port
      // must additionally use no-follow and checksum-conditional deletion.
      validateManifestEntry(entry, root, this.policy);
      const inspection = validateFileInspection(
        await this.port.inspectBackupFile(root, lease, entry),
        root,
        entry,
        entry,
      );
      if (inspection.exists) {
        const deletion = await this.port.deleteBackupFile(root, lease, entry);
        if (deletion !== "deleted" && deletion !== "already_missing") {
          throw backupError(
            "AUTOMATIC_BACKUP_DELETE_CONFIRMATION_INVALID",
            "自动备份文件删除结果无法确认；清单记录将保留。",
          );
        }
      }
      manifest = await this.removeEntry(root, lease, manifest, entry.backupId, now);
      prunedCount += 1;
    }
    return { manifest, prunedCount };
  }

  private async saveManifest(
    root: VerifiedAutomaticBackupRoot,
    lease: AutomaticBackupLease,
    current: AutomaticBackupManifest,
    entries: readonly AutomaticBackupManifestEntry[],
    lastSuccessfulSlot: string | null,
    now: string,
  ): Promise<AutomaticBackupManifest> {
    const next = normalizeManifest({
      schemaVersion: 2,
      rootId: root.rootId,
      revision: current.revision + 1,
      policy: {
        scheduleHourLocal: this.policy.scheduleHourLocal,
        retentionDays: this.policy.retentionDays,
      },
      lastSuccessfulSlot,
      entries,
      updatedAt: now,
    });
    const loaded = readManifest(
      await this.port.writeManifest(root, lease, current.revision, next),
      root,
      this.policy,
      now,
    );
    const persisted = loaded.manifest;
    if (JSON.stringify(persisted) !== JSON.stringify(next)) {
      throw backupError(
        "AUTOMATIC_BACKUP_MANIFEST_COMMIT_FAILED",
        "自动备份清单写入后校验失败。不会继续创建或删除文件。",
      );
    }
    return persisted;
  }
}

export class AutomaticBackupError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomaticBackupError";
  }
}

function validatePolicy(policy: AutomaticBackupPolicy): AutomaticBackupPolicy {
  if (
    !Number.isInteger(policy.scheduleHourLocal) ||
    policy.scheduleHourLocal < 0 ||
    policy.scheduleHourLocal > 23 ||
    !Number.isInteger(policy.retentionDays) ||
    policy.retentionDays < 1 ||
    policy.retentionDays > 3650 ||
    !Number.isInteger(policy.leaseDurationMinutes) ||
    policy.leaseDurationMinutes < 5 ||
    policy.leaseDurationMinutes > 1440
  ) {
    throw backupError("AUTOMATIC_BACKUP_POLICY_INVALID", "自动备份计划参数无效。");
  }
  return Object.freeze({ ...policy });
}

function verifyManagedRoot(value: unknown): VerifiedAutomaticBackupRoot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_INSPECTION_KEYS) ||
    typeof value.absolutePath !== "string" ||
    typeof value.canonicalAbsolutePath !== "string" ||
    !isRecord(value.ownershipMarker) ||
    !hasExactKeys(value.ownershipMarker, ROOT_MARKER_KEYS)
  ) {
    throw backupError("AUTOMATIC_BACKUP_ROOT_UNTRUSTED", "自动备份目录检查结果结构无效。");
  }
  const marker = value.ownershipMarker;
  if (
    marker.product !== "InkShadow" ||
    marker.purpose !== "automatic_backups" ||
    marker.schemaVersion !== 1 ||
    typeof marker.rootId !== "string" ||
    !ROOT_ID_PATTERN.test(marker.rootId)
  ) {
    throw backupError(
      "AUTOMATIC_BACKUP_ROOT_UNTRUSTED",
      "自动备份目录缺少有效的 InkShadow 所有权标记。",
    );
  }
  const absolute = normalizeAbsolutePath(value.absolutePath);
  const canonical = normalizeAbsolutePath(value.canonicalAbsolutePath);
  if (
    absolute.style !== canonical.style ||
    !sameNormalizedPath(absolute, canonical) ||
    absolute.segments.length < 3 ||
    absolute.segments.at(-2)?.toLowerCase() !== "automatic-backups" ||
    absolute.segments.at(-1)?.toLowerCase() !== "v1"
  ) {
    throw backupError(
      "AUTOMATIC_BACKUP_ROOT_UNTRUSTED",
      "自动备份目录不是受管的绝对目录，或目录经过了符号链接/重解析。",
    );
  }
  return Object.freeze({
    absolutePath: absolute.normalized,
    canonicalAbsolutePath: canonical.normalized,
    rootId: marker.rootId,
    pathStyle: absolute.style,
  }) as VerifiedAutomaticBackupRoot;
}

function readManifest(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  policy: AutomaticBackupPolicy,
  now: string,
): Readonly<{ manifest: AutomaticBackupManifest; requiresUpgrade: boolean }> {
  if (value === null) {
    return Object.freeze({
      manifest: normalizeManifest({
        schemaVersion: 2,
        rootId: root.rootId,
        revision: 0,
        policy: {
          scheduleHourLocal: policy.scheduleHourLocal,
          retentionDays: policy.retentionDays,
        },
        lastSuccessfulSlot: null,
        entries: [],
        updatedAt: now,
      }),
      requiresUpgrade: false,
    });
  }
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    throw manifestInvalid("自动备份清单结构无效。");
  }
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.rootId !== root.rootId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isRecord(value.policy) ||
    !hasExactKeys(value.policy, ["scheduleHourLocal", "retentionDays"] as const) ||
    value.policy.scheduleHourLocal !== policy.scheduleHourLocal ||
    value.policy.retentionDays !== policy.retentionDays ||
    (value.lastSuccessfulSlot !== null && !validDateKey(value.lastSuccessfulSlot)) ||
    !Array.isArray(value.entries) ||
    typeof value.updatedAt !== "string"
  ) {
    throw manifestInvalid("自动备份清单元数据无效或与当前策略不一致。");
  }
  const updatedAt = validateTimestamp(value.updatedAt, "manifest updatedAt");
  const entries =
    value.schemaVersion === 1
      ? value.entries.map((entry) => validateLegacyManifestEntry(entry, root, policy, updatedAt))
      : value.entries.map((entry) => validateManifestEntry(entry, root, policy));
  const ids = new Set(entries.map((entry) => entry.backupId));
  const fileNames = new Set(entries.map((entry) => entry.fileName));
  const slots = new Set(entries.map((entry) => entry.scheduleSlot));
  if (
    ids.size !== entries.length ||
    fileNames.size !== entries.length ||
    slots.size !== entries.length
  ) {
    throw manifestInvalid("自动备份清单包含重复标识、文件名或计划日期。");
  }
  const latestSucceededSlot = entries
    .filter((entry): entry is AutomaticBackupManifestSucceededEntry => entry.status === "succeeded")
    .map((entry) => entry.scheduleSlot)
    .sort()
    .at(-1);
  if (
    latestSucceededSlot !== undefined &&
    (value.lastSuccessfulSlot === null || value.lastSuccessfulSlot < latestSucceededSlot)
  ) {
    throw manifestInvalid("自动备份清单的最近成功日期早于现有备份记录。");
  }
  return Object.freeze({
    manifest: normalizeManifest({
      schemaVersion: 2,
      rootId: root.rootId,
      revision: value.revision as number,
      policy: {
        scheduleHourLocal: policy.scheduleHourLocal,
        retentionDays: policy.retentionDays,
      },
      lastSuccessfulSlot: value.lastSuccessfulSlot,
      entries,
      updatedAt,
    }),
    requiresUpgrade: value.schemaVersion === 1,
  });
}

function validateLegacyManifestEntry(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  policy: AutomaticBackupPolicy,
  manifestUpdatedAt: string,
): AutomaticBackupManifestEntry {
  if (!isRecord(value) || !hasExactKeys(value, LEGACY_ENTRY_KEYS)) {
    throw manifestInvalid("旧版自动备份清单条目结构无效。");
  }
  if (value.status !== "creating" && value.status !== "ready") {
    throw manifestInvalid("旧版自动备份清单条目状态无效。");
  }
  const base = validateManifestEntryBase(value, root, policy);
  ensureTimestampOrder(base.createdAt, null, manifestUpdatedAt);
  if (value.status === "creating") {
    if (value.byteLength !== null || value.sha256 !== null) {
      throw manifestInvalid("旧版创建中备份不能提前声明大小或校验和。");
    }
    return Object.freeze({
      ...base,
      status: "unknown",
      byteLength: null,
      sha256: null,
      writeStartedAt: null,
      finishedAt: manifestUpdatedAt,
      failureKind: "result_unconfirmed",
    });
  }
  const completed = validateCompletedFileFields(value);
  return Object.freeze({
    ...base,
    status: "succeeded",
    ...completed,
    writeStartedAt: base.createdAt,
    finishedAt: manifestUpdatedAt,
    failureKind: null,
  });
}

function validateManifestEntry(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  policy: AutomaticBackupPolicy,
): AutomaticBackupManifestEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) {
    throw manifestInvalid("自动备份清单条目结构无效。");
  }
  const base = validateManifestEntryBase(value, root, policy);
  switch (value.status) {
    case "reserved": {
      requireEmptyFileFields(value);
      if (
        value.writeStartedAt !== null ||
        value.finishedAt !== null ||
        value.failureKind !== null
      ) {
        throw manifestInvalid("已预留备份条目包含不应出现的写入或终结信息。");
      }
      return Object.freeze({
        ...base,
        status: "reserved",
        byteLength: null,
        sha256: null,
        writeStartedAt: null,
        finishedAt: null,
        failureKind: null,
      });
    }
    case "writing": {
      requireEmptyFileFields(value);
      const writeStartedAt = requireEntryTimestamp(value.writeStartedAt, "backup writeStartedAt");
      if (value.finishedAt !== null || value.failureKind !== null) {
        throw manifestInvalid("写入中的备份条目不能提前终结或声明失败。");
      }
      ensureTimestampOrder(base.createdAt, writeStartedAt, null);
      return Object.freeze({
        ...base,
        status: "writing",
        byteLength: null,
        sha256: null,
        writeStartedAt,
        finishedAt: null,
        failureKind: null,
      });
    }
    case "verifying": {
      const completed = validateCompletedFileFields(value);
      const writeStartedAt = requireEntryTimestamp(value.writeStartedAt, "backup writeStartedAt");
      if (value.finishedAt !== null || value.failureKind !== null) {
        throw manifestInvalid("校验中的备份条目不能提前终结或声明失败。");
      }
      ensureTimestampOrder(base.createdAt, writeStartedAt, null);
      return Object.freeze({
        ...base,
        status: "verifying",
        ...completed,
        writeStartedAt,
        finishedAt: null,
        failureKind: null,
      });
    }
    case "not_started": {
      requireEmptyFileFields(value);
      const finishedAt = requireEntryTimestamp(value.finishedAt, "backup finishedAt");
      const failureKind = validateFailureKind(value.failureKind);
      if (value.writeStartedAt !== null) {
        throw manifestInvalid("未开始的备份不能声明写入开始时间。");
      }
      ensureTimestampOrder(base.createdAt, null, finishedAt);
      return Object.freeze({
        ...base,
        status: "not_started",
        byteLength: null,
        sha256: null,
        writeStartedAt: null,
        finishedAt,
        failureKind,
      });
    }
    case "failed": {
      requireEmptyFileFields(value);
      const writeStartedAt = requireEntryTimestamp(value.writeStartedAt, "backup writeStartedAt");
      const finishedAt = requireEntryTimestamp(value.finishedAt, "backup finishedAt");
      const failureKind = validateFailureKind(value.failureKind);
      ensureTimestampOrder(base.createdAt, writeStartedAt, finishedAt);
      return Object.freeze({
        ...base,
        status: "failed",
        byteLength: null,
        sha256: null,
        writeStartedAt,
        finishedAt,
        failureKind,
      });
    }
    case "unknown": {
      const recorded = validateOptionalCompletedFileFields(value);
      const writeStartedAt =
        value.writeStartedAt === null
          ? null
          : requireEntryTimestamp(value.writeStartedAt, "backup writeStartedAt");
      const finishedAt = requireEntryTimestamp(value.finishedAt, "backup finishedAt");
      if (value.failureKind !== "result_unconfirmed") {
        throw manifestInvalid("结果待确认的备份必须使用保守的未确认原因。");
      }
      ensureTimestampOrder(base.createdAt, writeStartedAt, finishedAt);
      return Object.freeze({
        ...base,
        status: "unknown",
        byteLength: recorded?.byteLength ?? null,
        sha256: recorded?.sha256 ?? null,
        writeStartedAt,
        finishedAt,
        failureKind: "result_unconfirmed",
      });
    }
    case "succeeded": {
      const completed = validateCompletedFileFields(value);
      const writeStartedAt = requireEntryTimestamp(value.writeStartedAt, "backup writeStartedAt");
      const finishedAt = requireEntryTimestamp(value.finishedAt, "backup finishedAt");
      if (value.failureKind !== null) {
        throw manifestInvalid("成功的备份不能声明失败原因。");
      }
      ensureTimestampOrder(base.createdAt, writeStartedAt, finishedAt);
      return Object.freeze({
        ...base,
        status: "succeeded",
        ...completed,
        writeStartedAt,
        finishedAt,
        failureKind: null,
      });
    }
    default:
      throw manifestInvalid("自动备份清单条目状态无效。");
  }
}

function validateManifestEntryBase(
  value: Readonly<Record<string, unknown>>,
  root: VerifiedAutomaticBackupRoot,
  policy: AutomaticBackupPolicy,
): Omit<AutomaticBackupManifestEntryBase, "writeStartedAt" | "finishedAt" | "failureKind"> {
  if (
    typeof value.backupId !== "string" ||
    value.createdBy !== "inkshadow_automatic_backup_service" ||
    typeof value.scheduleSlot !== "string" ||
    typeof value.fileName !== "string" ||
    typeof value.absolutePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.retentionUntil !== "string"
  ) {
    throw manifestInvalid("自动备份清单条目元数据无效。");
  }
  const backupId = validateUuid(value.backupId, "manifest backup id");
  if (!validDateKey(value.scheduleSlot)) {
    throw manifestInvalid("自动备份计划日期无效。");
  }
  const createdAt = validateTimestamp(value.createdAt, "backup createdAt");
  const retentionUntil = validateTimestamp(value.retentionUntil, "backup retentionUntil");
  const match = AUTOMATIC_BACKUP_FILE_PATTERN.exec(value.fileName);
  if (
    match?.[1] !== compactTimestamp(createdAt) ||
    match[2] !== backupId ||
    value.fileName !== automaticBackupFileName(createdAt, backupId) ||
    value.absolutePath !== joinDirectChild(root, value.fileName) ||
    retentionUntil !== addDays(createdAt, policy.retentionDays)
  ) {
    throw manifestInvalid("自动备份文件名、绝对路径或保留期限不符合受管策略。");
  }
  return Object.freeze({
    backupId,
    createdBy: "inkshadow_automatic_backup_service" as const,
    scheduleSlot: value.scheduleSlot,
    fileName: value.fileName,
    absolutePath: value.absolutePath,
    createdAt,
    retentionUntil,
  });
}

function requireEmptyFileFields(value: Readonly<Record<string, unknown>>): void {
  if (value.byteLength !== null || value.sha256 !== null) {
    throw manifestInvalid("未完成的自动备份不能声明大小或校验和。");
  }
}

function validateCompletedFileFields(
  value: Readonly<Record<string, unknown>>,
): Readonly<{ byteLength: number; sha256: string }> {
  if (
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw manifestInvalid("已完成自动备份缺少有效大小或 SHA-256 校验和。");
  }
  return Object.freeze({ byteLength: value.byteLength as number, sha256: value.sha256 });
}

function validateOptionalCompletedFileFields(
  value: Readonly<Record<string, unknown>>,
): Readonly<{ byteLength: number; sha256: string }> | null {
  if (value.byteLength === null && value.sha256 === null) return null;
  return validateCompletedFileFields(value);
}

function requireEntryTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw manifestInvalid("自动备份清单缺少有效时间信息。");
  }
  return validateTimestamp(value, field);
}

function validateFailureKind(value: unknown): AutomaticBackupFailureKind {
  if (typeof value !== "string" || !FAILURE_KINDS.has(value as AutomaticBackupFailureKind)) {
    throw manifestInvalid("自动备份清单包含未知失败分类。");
  }
  return value as AutomaticBackupFailureKind;
}

function ensureTimestampOrder(
  createdAt: string,
  writeStartedAt: string | null,
  finishedAt: string | null,
): void {
  if (
    (writeStartedAt !== null && Date.parse(writeStartedAt) < Date.parse(createdAt)) ||
    (finishedAt !== null && Date.parse(finishedAt) < Date.parse(writeStartedAt ?? createdAt))
  ) {
    throw manifestInvalid("自动备份清单中的状态时间顺序无效。");
  }
}

function validateCreationOutcome(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  entry: AutomaticBackupManifestWritingEntry,
): AutomaticBackupCreationOutcome {
  if (!isRecord(value)) {
    throw backupError("AUTOMATIC_BACKUP_RESULT_INVALID", "自动备份创建结果无法确认。");
  }
  if (value.outcome === "succeeded" && hasExactKeys(value, CREATION_SUCCESS_KEYS)) {
    return Object.freeze({
      outcome: "succeeded",
      file: validatePresentFile(value.file, root, entry, null),
    });
  }
  if (
    (value.outcome === "not_started" ||
      value.outcome === "failed" ||
      value.outcome === "unknown") &&
    hasExactKeys(value, CREATION_FAILURE_KEYS)
  ) {
    const failureKind = validateFailureKind(value.failureKind);
    if (value.outcome === "unknown" && failureKind !== "result_unconfirmed") {
      throw backupError("AUTOMATIC_BACKUP_RESULT_INVALID", "自动备份待确认结果分类无效。");
    }
    return Object.freeze({ outcome: value.outcome, failureKind });
  }
  throw backupError("AUTOMATIC_BACKUP_RESULT_INVALID", "自动备份创建结果无法确认。");
}

type AutomaticBackupManifestPendingEntry =
  | AutomaticBackupManifestReservedEntry
  | AutomaticBackupManifestWritingEntry
  | AutomaticBackupManifestVerifyingEntry;
type AutomaticBackupManifestAttentionEntry =
  | AutomaticBackupManifestNotStartedEntry
  | AutomaticBackupManifestFailedEntry
  | AutomaticBackupManifestUnknownEntry;

function isPendingEntry(
  entry: AutomaticBackupManifestEntry,
): entry is AutomaticBackupManifestPendingEntry {
  return entry.status === "reserved" || entry.status === "writing" || entry.status === "verifying";
}

function unknownEntry(
  entry: AutomaticBackupManifestPendingEntry | AutomaticBackupManifestSucceededEntry,
  now: string,
): AutomaticBackupManifestUnknownEntry {
  return Object.freeze({
    ...entry,
    status: "unknown",
    byteLength:
      entry.status === "verifying" || entry.status === "succeeded" ? entry.byteLength : null,
    sha256: entry.status === "verifying" || entry.status === "succeeded" ? entry.sha256 : null,
    writeStartedAt: entry.writeStartedAt,
    finishedAt: now,
    failureKind: "result_unconfirmed",
  });
}

interface AutomaticBackupRecordedFileEvidence {
  readonly byteLength: number;
  readonly sha256: string;
}

function recordedFileEvidence(
  entry: AutomaticBackupManifestEntry,
): AutomaticBackupRecordedFileEvidence | null {
  if (entry.status === "verifying" || entry.status === "succeeded") return entry;
  if (entry.status === "unknown" && entry.byteLength !== null && entry.sha256 !== null) {
    return Object.freeze({ byteLength: entry.byteLength, sha256: entry.sha256 });
  }
  return null;
}

function notStartedEntry(
  entry: AutomaticBackupManifestReservedEntry,
  now: string,
  failureKind: AutomaticBackupFailureKind,
): AutomaticBackupManifestNotStartedEntry {
  return Object.freeze({
    ...entry,
    status: "not_started",
    byteLength: null,
    sha256: null,
    writeStartedAt: null,
    finishedAt: now,
    failureKind,
  });
}

function attentionForSlot(
  manifest: AutomaticBackupManifest,
  scheduleSlot: string,
): AutomaticBackupRunResult["attention"] {
  const entry = manifest.entries.find(
    (candidate): candidate is AutomaticBackupManifestAttentionEntry =>
      candidate.scheduleSlot === scheduleSlot &&
      (candidate.status === "not_started" ||
        candidate.status === "failed" ||
        candidate.status === "unknown"),
  );
  return entry === undefined ? null : attentionFromEntry(entry);
}

function attentionFromEntry(
  entry: AutomaticBackupManifestAttentionEntry,
): NonNullable<AutomaticBackupRunResult["attention"]> {
  return Object.freeze({ status: entry.status, failureKind: entry.failureKind });
}

function validateFileInspection(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  expected: AutomaticBackupManifestEntry,
  recorded: AutomaticBackupRecordedFileEvidence | null,
): AutomaticBackupFileInspection {
  if (isRecord(value) && hasExactKeys(value, ["exists"]) && value.exists === false) {
    return Object.freeze({ exists: false });
  }
  return validatePresentFile(value, root, expected, recorded);
}

function validatePresentFile(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  expected: AutomaticBackupManifestEntry,
  recorded: AutomaticBackupRecordedFileEvidence | null,
): AutomaticBackupFilePresent {
  if (!isRecord(value) || !hasExactKeys(value, FILE_PRESENT_KEYS)) {
    throw backupError(
      "AUTOMATIC_BACKUP_FILE_SAFETY_CHECK_FAILED",
      "自动备份文件检查结果结构无效；未执行删除。",
    );
  }
  if (
    value.exists !== true ||
    value.integrityVerified !== true ||
    typeof value.fileName !== "string" ||
    typeof value.absolutePath !== "string" ||
    typeof value.canonicalAbsolutePath !== "string" ||
    typeof value.byteLength !== "number" ||
    typeof value.sha256 !== "string"
  ) {
    throw backupError(
      "AUTOMATIC_BACKUP_FILE_SAFETY_CHECK_FAILED",
      "自动备份文件检查结果结构无效；未执行删除。",
    );
  }
  const inspection: AutomaticBackupFilePresent = {
    exists: true,
    fileName: value.fileName,
    absolutePath: value.absolutePath,
    canonicalAbsolutePath: value.canonicalAbsolutePath,
    byteLength: value.byteLength,
    sha256: value.sha256,
    integrityVerified: true,
  };
  const absolute = normalizeAbsolutePath(inspection.absolutePath);
  const canonical = normalizeAbsolutePath(inspection.canonicalAbsolutePath);
  const expectedAbsolute = normalizeAbsolutePath(expected.absolutePath);
  const expectedDirectChild = normalizeAbsolutePath(joinDirectChild(root, inspection.fileName));
  if (
    inspection.fileName !== expected.fileName ||
    absolute.style !== root.pathStyle ||
    canonical.style !== root.pathStyle ||
    expectedAbsolute.style !== root.pathStyle ||
    expectedDirectChild.style !== root.pathStyle ||
    !sameNormalizedPath(absolute, canonical) ||
    !sameNormalizedPath(absolute, expectedAbsolute) ||
    !sameNormalizedPath(absolute, expectedDirectChild) ||
    !Number.isSafeInteger(inspection.byteLength) ||
    inspection.byteLength <= 0 ||
    !SHA256_PATTERN.test(inspection.sha256) ||
    (recorded !== null &&
      (inspection.byteLength !== recorded.byteLength || inspection.sha256 !== recorded.sha256))
  ) {
    throw backupError(
      "AUTOMATIC_BACKUP_FILE_SAFETY_CHECK_FAILED",
      "自动备份文件的路径、完整性、大小或校验和与清单不一致；未执行删除。",
    );
  }
  return Object.freeze({
    exists: true,
    fileName: inspection.fileName,
    absolutePath: absolute.normalized,
    canonicalAbsolutePath: canonical.normalized,
    byteLength: inspection.byteLength,
    sha256: inspection.sha256,
    integrityVerified: true,
  });
}

function normalizeManifest(manifest: AutomaticBackupManifest): AutomaticBackupManifest {
  return Object.freeze({
    schemaVersion: 2,
    rootId: manifest.rootId,
    revision: manifest.revision,
    policy: Object.freeze({ ...manifest.policy }),
    lastSuccessfulSlot: manifest.lastSuccessfulSlot,
    entries: Object.freeze(
      [...manifest.entries].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.backupId.localeCompare(right.backupId),
      ),
    ),
    updatedAt: manifest.updatedAt,
  });
}

function validateLease(lease: AutomaticBackupLease): void {
  if (!LEASE_TOKEN_PATTERN.test(lease.token)) {
    throw backupError("AUTOMATIC_BACKUP_LEASE_INVALID", "自动备份目录锁无效。");
  }
}

function resolveSchedule(
  now: string,
  timezoneOffsetMinutes: number,
  scheduleHourLocal: number,
): { readonly dueSlot: string; readonly nextDueAt: string } {
  const local = Date.parse(now) - timezoneOffsetMinutes * 60_000;
  const localDate = new Date(local);
  const beforeSchedule = localDate.getUTCHours() < scheduleHourLocal;
  const dueLocalDate = beforeSchedule ? local - 86_400_000 : local;
  const dueSlot = dateKeyFromMilliseconds(dueLocalDate);
  const nextSlot = addDateKeyDays(dueSlot, 1);
  return {
    dueSlot,
    nextDueAt: localScheduleToUtc(nextSlot, scheduleHourLocal, timezoneOffsetMinutes),
  };
}

function countMissedSlots(lastSuccessfulSlot: string | null, dueSlot: string): number {
  if (lastSuccessfulSlot === null) return 1;
  if (lastSuccessfulSlot >= dueSlot) return 0;
  return Math.max(
    1,
    Math.round(
      (dateKeyMilliseconds(dueSlot) - dateKeyMilliseconds(lastSuccessfulSlot)) / 86_400_000,
    ),
  );
}

function localScheduleToUtc(dateKey: string, hour: number, timezoneOffsetMinutes: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour) + timezoneOffsetMinutes * 60_000,
  ).toISOString();
}

function addDateKeyDays(dateKey: string, days: number): string {
  return dateKeyFromMilliseconds(dateKeyMilliseconds(dateKey) + days * 86_400_000);
}

function dateKeyMilliseconds(dateKey: string): number {
  if (!validDateKey(dateKey)) throw manifestInvalid("自动备份日期无效。");
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function dateKeyFromMilliseconds(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function validDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;
  return dateKeyFromMilliseconds(Date.parse(`${value}T00:00:00.000Z`)) === value;
}

function maxDateKey(left: string | null, right: string): string {
  return left === null || left < right ? right : left;
}

function latestSucceededSlotExcept(
  manifest: AutomaticBackupManifest,
  excludedBackupId: string,
): string | null {
  return manifest.entries.reduce<string | null>(
    (latest, entry) =>
      entry.status === "succeeded" && entry.backupId !== excludedBackupId
        ? maxDateKey(latest, entry.scheduleSlot)
        : latest,
    null,
  );
}

function automaticBackupFileName(timestamp: string, backupId: string): string {
  return `inkshadow-auto-v1-${compactTimestamp(timestamp)}-${backupId}.sqlite3`;
}

function compactTimestamp(timestamp: string): string {
  return timestamp.replaceAll(/[-:.]/gu, "");
}

function joinDirectChild(root: VerifiedAutomaticBackupRoot, fileName: string): string {
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw backupError("AUTOMATIC_BACKUP_FILE_NAME_INVALID", "自动备份文件名无效。");
  }
  return `${root.absolutePath}/${fileName}`;
}

interface NormalizedAbsolutePath {
  readonly normalized: string;
  readonly style: "windows" | "posix";
  readonly segments: readonly string[];
}

function normalizeAbsolutePath(value: string): NormalizedAbsolutePath {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw backupError("AUTOMATIC_BACKUP_PATH_INVALID", "自动备份路径无效。");
  }
  const slash = value.replaceAll("\\", "/");
  const windows = /^[A-Za-z]:\//u.test(slash);
  const posix = slash.startsWith("/") && !slash.startsWith("//");
  if (!windows && !posix) {
    throw backupError("AUTOMATIC_BACKUP_PATH_INVALID", "自动备份目标必须是绝对路径。");
  }
  if (slash.includes("//") || slash.endsWith("/")) {
    throw backupError("AUTOMATIC_BACKUP_PATH_INVALID", "自动备份路径不能包含空目录段。");
  }
  const prefix = windows ? `${slash.slice(0, 1).toUpperCase()}:` : "";
  const body = windows ? slash.slice(3) : slash.slice(1);
  const segments = body.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.trim() !== segment,
    )
  ) {
    throw backupError("AUTOMATIC_BACKUP_PATH_INVALID", "自动备份路径包含不安全目录段。");
  }
  return Object.freeze({
    normalized: windows ? `${prefix}/${segments.join("/")}` : `/${segments.join("/")}`,
    style: windows ? "windows" : "posix",
    segments: Object.freeze(segments),
  });
}

function sameNormalizedPath(left: NormalizedAbsolutePath, right: NormalizedAbsolutePath): boolean {
  return left.style === "windows"
    ? left.normalized.toLowerCase() === right.normalized.toLowerCase()
    : left.normalized === right.normalized;
}

function validateTimestamp(value: string, field: string): string {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw backupError("AUTOMATIC_BACKUP_TIME_INVALID", `${field} 不是有效的 UTC 时间。`);
  }
  return value;
}

function validateTimezoneOffset(value: number): number {
  if (!Number.isInteger(value) || value < -840 || value > 840) {
    throw backupError("AUTOMATIC_BACKUP_TIME_INVALID", "本地时区偏移无效。");
  }
  return value;
}

function validateUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw backupError("AUTOMATIC_BACKUP_ID_INVALID", `${field} 无效。`);
  }
  return value;
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function manifestInvalid(message: string): AutomaticBackupError {
  return backupError("AUTOMATIC_BACKUP_MANIFEST_INVALID", message);
}

function backupError(code: string, message: string): AutomaticBackupError {
  return new AutomaticBackupError(code, message);
}
