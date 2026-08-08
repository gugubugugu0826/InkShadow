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
    request: Readonly<{
      backupId: string;
      fileName: string;
      absolutePath: string;
    }>,
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
    entry: AutomaticBackupManifestReadyEntry,
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
}

export interface AutomaticBackupManifestCreatingEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "creating";
  readonly byteLength: null;
  readonly sha256: null;
}

export interface AutomaticBackupManifestReadyEntry extends AutomaticBackupManifestEntryBase {
  readonly status: "ready";
  readonly byteLength: number;
  readonly sha256: string;
}

export type AutomaticBackupManifestEntry =
  AutomaticBackupManifestCreatingEntry | AutomaticBackupManifestReadyEntry;

export interface AutomaticBackupManifest {
  readonly schemaVersion: 1;
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
  readonly status: "completed" | "not_due" | "busy";
  readonly dueSlot: string;
  readonly nextDueAt: string;
  readonly createdBackup: AutomaticBackupManifestReadyEntry | null;
  readonly recoveredPendingCount: number;
  readonly prunedCount: number;
  readonly missedSlotCount: number;
}

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
        recoveredPendingCount: 0,
        prunedCount: 0,
        missedSlotCount: 0,
      });
    }
    validateLease(lease);

    try {
      let manifest = readManifest(
        await this.port.readManifest(root, lease),
        root,
        this.policy,
        now,
      );
      const recovered = await this.recoverPendingEntries(root, lease, manifest, now);
      manifest = recovered.manifest;

      const missedSlotCount = countMissedSlots(manifest.lastSuccessfulSlot, schedule.dueSlot);
      let createdBackup: AutomaticBackupManifestReadyEntry | null = null;
      if (missedSlotCount > 0) {
        const reserved = await this.reserveBackup(root, lease, manifest, schedule.dueSlot, now);
        manifest = reserved.manifest;
        const receipt = validatePresentFile(
          await this.port.createConsistentBackup(root, lease, {
            backupId: reserved.entry.backupId,
            fileName: reserved.entry.fileName,
            absolutePath: reserved.entry.absolutePath,
          }),
          root,
          reserved.entry,
          null,
        );
        createdBackup = Object.freeze({
          ...reserved.entry,
          status: "ready",
          byteLength: receipt.byteLength,
          sha256: receipt.sha256,
        });
        manifest = await this.replaceEntry(
          root,
          lease,
          manifest,
          createdBackup,
          maxDateKey(manifest.lastSuccessfulSlot, createdBackup.scheduleSlot),
          now,
        );
      }

      const pruned = await this.pruneExpiredEntries(root, lease, manifest, now);
      manifest = pruned.manifest;
      const changed =
        createdBackup !== null || recovered.recoveredCount > 0 || pruned.prunedCount > 0;
      return Object.freeze({
        status: changed ? "completed" : "not_due",
        dueSlot: schedule.dueSlot,
        nextDueAt: schedule.nextDueAt,
        createdBackup,
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
      if (entry.status !== "creating") continue;
      const inspection = validateFileInspection(
        await this.port.inspectBackupFile(root, lease, entry),
        root,
        entry,
        null,
      );
      if (!inspection.exists) {
        manifest = await this.removeEntry(root, lease, manifest, entry.backupId, now);
        continue;
      }
      const ready: AutomaticBackupManifestReadyEntry = Object.freeze({
        ...entry,
        status: "ready",
        byteLength: inspection.byteLength,
        sha256: inspection.sha256,
      });
      manifest = await this.replaceEntry(
        root,
        lease,
        manifest,
        ready,
        maxDateKey(manifest.lastSuccessfulSlot, ready.scheduleSlot),
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
    readonly entry: AutomaticBackupManifestCreatingEntry;
  }> {
    if (manifest.entries.some((entry) => entry.scheduleSlot === scheduleSlot)) {
      throw backupError(
        "AUTOMATIC_BACKUP_SLOT_CONFLICT",
        "当前计划日期已经存在自动备份清单记录，已停止以避免重复覆盖。",
      );
    }
    const backupId = validateUuid(this.ids.next(), "backup id");
    const fileName = automaticBackupFileName(now, backupId);
    const entry: AutomaticBackupManifestCreatingEntry = Object.freeze({
      backupId,
      createdBy: "inkshadow_automatic_backup_service",
      scheduleSlot,
      fileName,
      absolutePath: joinDirectChild(root, fileName),
      createdAt: now,
      retentionUntil: addDays(now, this.policy.retentionDays),
      status: "creating",
      byteLength: null,
      sha256: null,
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
    for (const entry of [...manifest.entries]) {
      if (entry.status !== "ready" || Date.parse(entry.retentionUntil) > Date.parse(now)) {
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
      schemaVersion: 1,
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
    const persisted = readManifest(
      await this.port.writeManifest(root, lease, current.revision, next),
      root,
      this.policy,
      now,
    );
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
): AutomaticBackupManifest {
  if (value === null) {
    return normalizeManifest({
      schemaVersion: 1,
      rootId: root.rootId,
      revision: 0,
      policy: {
        scheduleHourLocal: policy.scheduleHourLocal,
        retentionDays: policy.retentionDays,
      },
      lastSuccessfulSlot: null,
      entries: [],
      updatedAt: now,
    });
  }
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    throw manifestInvalid("自动备份清单结构无效。");
  }
  if (
    value.schemaVersion !== 1 ||
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
  const entries = value.entries.map((entry) => validateManifestEntry(entry, root, policy));
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
  const latestReadySlot = entries
    .filter((entry): entry is AutomaticBackupManifestReadyEntry => entry.status === "ready")
    .map((entry) => entry.scheduleSlot)
    .sort()
    .at(-1);
  if (
    latestReadySlot !== undefined &&
    (value.lastSuccessfulSlot === null || value.lastSuccessfulSlot < latestReadySlot)
  ) {
    throw manifestInvalid("自动备份清单的最近成功日期早于现有备份记录。");
  }
  return normalizeManifest({
    schemaVersion: 1,
    rootId: root.rootId,
    revision: value.revision as number,
    policy: {
      scheduleHourLocal: policy.scheduleHourLocal,
      retentionDays: policy.retentionDays,
    },
    lastSuccessfulSlot: value.lastSuccessfulSlot,
    entries,
    updatedAt: validateTimestamp(value.updatedAt, "manifest updatedAt"),
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
  if (
    typeof value.backupId !== "string" ||
    value.createdBy !== "inkshadow_automatic_backup_service" ||
    typeof value.scheduleSlot !== "string" ||
    typeof value.fileName !== "string" ||
    typeof value.absolutePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.retentionUntil !== "string" ||
    (value.status !== "creating" && value.status !== "ready")
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
  const fileTimestamp = match?.[1];
  const fileBackupId = match?.[2];
  if (
    fileTimestamp !== compactTimestamp(createdAt) ||
    fileBackupId !== backupId ||
    value.fileName !== automaticBackupFileName(createdAt, backupId) ||
    value.absolutePath !== joinDirectChild(root, value.fileName) ||
    retentionUntil !== addDays(createdAt, policy.retentionDays)
  ) {
    throw manifestInvalid("自动备份文件名、绝对路径或保留期限不符合受管策略。");
  }
  const base = {
    backupId,
    createdBy: "inkshadow_automatic_backup_service" as const,
    scheduleSlot: value.scheduleSlot,
    fileName: value.fileName,
    absolutePath: value.absolutePath,
    createdAt,
    retentionUntil,
  };
  if (value.status === "creating") {
    if (value.byteLength !== null || value.sha256 !== null) {
      throw manifestInvalid("创建中的自动备份不能提前声明大小或校验和。");
    }
    return Object.freeze({ ...base, status: "creating", byteLength: null, sha256: null });
  }
  if (
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw manifestInvalid("已完成自动备份缺少有效大小或 SHA-256 校验和。");
  }
  return Object.freeze({
    ...base,
    status: "ready",
    byteLength: value.byteLength as number,
    sha256: value.sha256,
  });
}

function validateFileInspection(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  expected: AutomaticBackupManifestEntry,
  ready: AutomaticBackupManifestReadyEntry | null,
): AutomaticBackupFileInspection {
  if (isRecord(value) && hasExactKeys(value, ["exists"]) && value.exists === false) {
    return Object.freeze({ exists: false });
  }
  return validatePresentFile(value, root, expected, ready);
}

function validatePresentFile(
  value: unknown,
  root: VerifiedAutomaticBackupRoot,
  expected: AutomaticBackupManifestEntry,
  ready: AutomaticBackupManifestReadyEntry | null,
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
    (ready !== null &&
      (inspection.byteLength !== ready.byteLength || inspection.sha256 !== ready.sha256))
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
    schemaVersion: 1,
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
