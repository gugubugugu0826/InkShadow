import { beforeEach, describe, expect, it } from "vitest";

import {
  AutomaticBackupService,
  type AutomaticBackupFileInspection,
  type AutomaticBackupFilePresent,
  type AutomaticBackupIdGenerator,
  type AutomaticBackupLease,
  type AutomaticBackupFailureKind,
  type AutomaticBackupManifest,
  type AutomaticBackupManifestEntry,
  type AutomaticBackupManifestSucceededEntry,
  type AutomaticBackupManifestVerifyingEntry,
  type AutomaticBackupManifestWritingEntry,
  type AutomaticBackupPort,
  type AutomaticBackupRootInspection,
  type VerifiedAutomaticBackupRoot,
} from "./automatic-backup-service";

const ROOT_PATH = "D:/Users/test/AppData/InkShadow/automatic-backups/v1";
const ROOT_ID = "inkshadow-install-test-0001";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const UUIDS = Array.from({ length: 30 }, (_, index) => uuid(index + 1));

describe("AutomaticBackupService", () => {
  let port: MemoryAutomaticBackupPort;
  let ids: SequenceIds;

  beforeEach(() => {
    port = new MemoryAutomaticBackupPort();
    ids = new SequenceIds(UUIDS);
  });

  it("creates at most one backup for the latest 03:00 local slot", async () => {
    const service = new AutomaticBackupService(port, ids);

    const first = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });
    const second = await service.runIfDue({
      now: "2026-08-08T12:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(first).toMatchObject({
      status: "completed",
      dueSlot: "2026-08-08",
      nextDueAt: "2026-08-09T03:00:00.000Z",
      missedSlotCount: 1,
      prunedCount: 0,
    });
    expect(first.createdBackup).toMatchObject({
      status: "succeeded",
      scheduleSlot: "2026-08-08",
      createdAt: "2026-08-08T04:00:00.000Z",
      retentionUntil: "2026-09-07T04:00:00.000Z",
      sha256: SHA_A,
    });
    expect(second).toMatchObject({
      status: "not_due",
      dueSlot: "2026-08-08",
      missedSlotCount: 0,
      createdBackup: null,
    });
    expect(port.createRequests).toHaveLength(1);
    expect(port.manifest?.lastSuccessfulSlot).toBe("2026-08-08");
    expect(port.manifest?.entries).toHaveLength(1);
  });

  it("runs one catch-up backup after several missed days instead of creating a burst", async () => {
    port.manifest = manifest({
      revision: 1,
      lastSuccessfulSlot: "2026-08-05",
      entries: [],
      updatedAt: "2026-08-05T03:00:00.000Z",
    });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T10:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "completed",
      dueSlot: "2026-08-08",
      missedSlotCount: 3,
    });
    expect(port.createRequests).toHaveLength(1);
    expect(port.manifest.lastSuccessfulSlot).toBe("2026-08-08");
  });

  it("catches up the previous slot when the app opens before today's 03:00", async () => {
    port.manifest = manifest({
      revision: 1,
      lastSuccessfulSlot: "2026-08-06",
      entries: [],
      updatedAt: "2026-08-06T03:00:00.000Z",
    });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T02:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      dueSlot: "2026-08-07",
      nextDueAt: "2026-08-08T03:00:00.000Z",
      missedSlotCount: 1,
    });
    expect(result.createdBackup?.scheduleSlot).toBe("2026-08-07");
  });

  it("uses the JavaScript timezone offset when resolving the local schedule", async () => {
    port.manifest = manifest({
      revision: 1,
      lastSuccessfulSlot: "2026-08-07",
      entries: [],
      updatedAt: "2026-08-07T17:00:00.000Z",
    });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      // 04:30 on 8 August in UTC+10 (getTimezoneOffset = -600).
      now: "2026-08-07T18:30:00.000Z",
      timezoneOffsetMinutes: -600,
    });

    expect(result.dueSlot).toBe("2026-08-08");
    expect(result.nextDueAt).toBe("2026-08-08T17:00:00.000Z");
  });

  it("prunes only expired, manifest-owned files and never enumerates a manual backup", async () => {
    const expired = succeededEntry({
      backupId: uuid(20),
      createdAt: "2026-07-01T03:00:00.000Z",
      scheduleSlot: "2026-07-01",
      sha256: SHA_A,
    });
    const retained = succeededEntry({
      backupId: uuid(21),
      createdAt: "2026-08-01T03:00:00.000Z",
      scheduleSlot: "2026-08-01",
      sha256: SHA_B,
    });
    port.manifest = manifest({
      revision: 4,
      lastSuccessfulSlot: "2026-08-07",
      entries: [expired, retained],
      updatedAt: "2026-08-08T03:00:00.000Z",
    });
    port.files.set(expired.absolutePath, presentFile(expired));
    port.files.set(retained.absolutePath, presentFile(retained));
    const manualPath = `${ROOT_PATH}/my-manual-backup.sqlite3`;
    port.files.set(manualPath, {
      exists: true,
      fileName: "my-manual-backup.sqlite3",
      absolutePath: manualPath,
      canonicalAbsolutePath: manualPath,
      byteLength: 900,
      sha256: SHA_A,
      integrityVerified: true,
    });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T12:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({ status: "completed", prunedCount: 1 });
    expect(result.createdBackup).not.toBeNull();
    expect(port.deleteRequests).toEqual([expired.backupId]);
    expect(port.files.has(expired.absolutePath)).toBe(false);
    expect(port.files.has(retained.absolutePath)).toBe(true);
    expect(port.files.has(manualPath)).toBe(true);
    expect(port.manifest.entries.map(({ backupId }) => backupId)).toEqual([
      retained.backupId,
      result.createdBackup?.backupId,
    ]);
  });

  it("recovers a manifest-reserved backup after an interrupted manifest commit", async () => {
    const pending = writingEntry({
      backupId: uuid(22),
      createdAt: "2026-08-08T03:02:00.000Z",
      scheduleSlot: "2026-08-08",
    });
    port.manifest = manifest({
      revision: 2,
      lastSuccessfulSlot: null,
      entries: [pending],
      updatedAt: "2026-08-08T03:02:00.000Z",
    });
    port.files.set(pending.absolutePath, {
      exists: true,
      fileName: pending.fileName,
      absolutePath: pending.absolutePath,
      canonicalAbsolutePath: pending.absolutePath,
      byteLength: 2048,
      sha256: SHA_A,
      integrityVerified: true,
    });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "completed",
      createdBackup: null,
      recoveredPendingCount: 1,
      missedSlotCount: 0,
    });
    expect(port.createRequests).toHaveLength(0);
    expect(port.manifest.entries[0]).toMatchObject({ status: "succeeded", sha256: SHA_A });
    expect(port.manifest.lastSuccessfulSlot).toBe("2026-08-08");
  });

  it("converts a missing write interrupted by restart to unknown and never redispatches the slot", async () => {
    const pending = writingEntry({
      backupId: uuid(25),
      createdAt: "2026-08-08T03:02:00.000Z",
      scheduleSlot: "2026-08-08",
    });
    port.manifest = manifest({
      revision: 2,
      lastSuccessfulSlot: null,
      entries: [pending],
      updatedAt: "2026-08-08T03:02:00.000Z",
    });
    const service = new AutomaticBackupService(port, ids);

    const first = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });
    const second = await service.runIfDue({
      now: "2026-08-08T05:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(first).toMatchObject({
      status: "attention",
      recoveredPendingCount: 1,
      attention: { status: "unknown", failureKind: "result_unconfirmed" },
    });
    expect(second).toMatchObject({
      status: "attention",
      recoveredPendingCount: 0,
      attention: { status: "unknown", failureKind: "result_unconfirmed" },
    });
    expect(port.createRequests).toHaveLength(0);
    expect(port.manifest.entries[0]?.status).toBe("unknown");
  });

  it("preserves verifying evidence so a changed target can never be promoted later", async () => {
    const pending = verifyingEntry({
      backupId: uuid(29),
      createdAt: "2026-08-08T03:02:00.000Z",
      scheduleSlot: "2026-08-08",
      sha256: SHA_A,
    });
    port.manifest = manifest({
      revision: 2,
      lastSuccessfulSlot: null,
      entries: [pending],
      updatedAt: "2026-08-08T03:02:00.000Z",
    });
    port.files.set(pending.absolutePath, { ...presentFile(pending), sha256: SHA_B });
    const service = new AutomaticBackupService(port, ids);

    const first = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });
    const second = await service.runIfDue({
      now: "2026-08-08T05:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(first.status).toBe("attention");
    expect(second.status).toBe("attention");
    expect(port.createRequests).toHaveLength(0);
    expect(port.manifest.entries[0]).toMatchObject({
      status: "unknown",
      byteLength: 4096,
      sha256: SHA_A,
      failureKind: "result_unconfirmed",
    });
  });

  it("settles a missing legacy creating record and reschedules the same slot exactly once", async () => {
    const backupId = uuid(26);
    const createdAt = "2026-08-08T03:02:00.000Z";
    const fileName = fileNameFor(createdAt, backupId);
    port.manifest = {
      schemaVersion: 1,
      rootId: ROOT_ID,
      revision: 17,
      policy: { scheduleHourLocal: 3, retentionDays: 30 },
      lastSuccessfulSlot: null,
      entries: [
        {
          backupId,
          createdBy: "inkshadow_automatic_backup_service",
          scheduleSlot: "2026-08-08",
          fileName,
          absolutePath: `${ROOT_PATH}/${fileName}`,
          createdAt,
          retentionUntil: addDays(createdAt, 30),
          status: "creating",
          byteLength: null,
          sha256: null,
        },
      ],
      updatedAt: createdAt,
    } as unknown as AutomaticBackupManifest;
    const service = new AutomaticBackupService(port, ids);

    const first = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });
    const second = await service.runIfDue({
      now: "2026-08-08T05:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(first).toMatchObject({
      status: "completed",
      recoveredPendingCount: 1,
      attention: null,
      createdBackup: {
        status: "succeeded",
        scheduleSlot: "2026-08-08",
      },
    });
    expect(first.createdBackup?.backupId).not.toBe(backupId);
    expect(second).toMatchObject({
      status: "not_due",
      recoveredPendingCount: 0,
      attention: null,
      createdBackup: null,
    });
    expect(port.createRequests).toHaveLength(1);
    expect(port.deleteRequests).toHaveLength(0);
    expect(port.manifest).toMatchObject({
      schemaVersion: 2,
      revision: 23,
      lastSuccessfulSlot: "2026-08-08",
      entries: [
        { backupId, status: "not_started", failureKind: "write_failed" },
        { status: "succeeded", failureKind: null },
      ],
    });
  });

  it("promotes a legacy creating record only when its final file verifies completely", async () => {
    const backupId = uuid(28);
    const createdAt = "2026-08-08T03:02:00.000Z";
    const fileName = fileNameFor(createdAt, backupId);
    const absolutePath = `${ROOT_PATH}/${fileName}`;
    port.manifest = {
      schemaVersion: 1,
      rootId: ROOT_ID,
      revision: 17,
      policy: { scheduleHourLocal: 3, retentionDays: 30 },
      lastSuccessfulSlot: null,
      entries: [
        {
          backupId,
          createdBy: "inkshadow_automatic_backup_service",
          scheduleSlot: "2026-08-08",
          fileName,
          absolutePath,
          createdAt,
          retentionUntil: addDays(createdAt, 30),
          status: "creating",
          byteLength: null,
          sha256: null,
        },
      ],
      updatedAt: createdAt,
    } as unknown as AutomaticBackupManifest;
    port.files.set(absolutePath, {
      exists: true,
      fileName,
      absolutePath,
      canonicalAbsolutePath: absolutePath,
      byteLength: 4096,
      sha256: SHA_A,
      integrityVerified: true,
    });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "completed",
      recoveredPendingCount: 1,
      createdBackup: null,
      attention: null,
    });
    expect(port.createRequests).toHaveLength(0);
    expect(port.manifest).toMatchObject({
      schemaVersion: 2,
      revision: 19,
      lastSuccessfulSlot: "2026-08-08",
      entries: [{ status: "succeeded", sha256: SHA_A }],
    });
  });

  it("stops claiming success when the latest verified backup file disappears", async () => {
    const older = succeededEntry({
      backupId: uuid(18),
      createdAt: "2026-08-07T03:00:00.000Z",
      scheduleSlot: "2026-08-07",
      sha256: SHA_A,
    });
    const missing = succeededEntry({
      backupId: uuid(19),
      createdAt: "2026-08-08T03:00:00.000Z",
      scheduleSlot: "2026-08-08",
      sha256: SHA_B,
    });
    port.manifest = manifest({
      revision: 4,
      lastSuccessfulSlot: "2026-08-08",
      entries: [older, missing],
      updatedAt: "2026-08-08T03:00:00.000Z",
    });
    port.files.set(older.absolutePath, presentFile(older));
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "attention",
      createdBackup: null,
      attention: { status: "unknown", failureKind: "result_unconfirmed" },
      recoveredPendingCount: 1,
    });
    expect(port.createRequests).toHaveLength(0);
    expect(port.manifest).toMatchObject({
      lastSuccessfulSlot: "2026-08-07",
      entries: [
        { backupId: older.backupId, status: "succeeded" },
        {
          backupId: missing.backupId,
          status: "unknown",
          byteLength: 4096,
          sha256: SHA_B,
        },
      ],
    });
  });

  it("rechecks a legacy ready record and reports a missing file as unconfirmed", async () => {
    const backupId = uuid(17);
    const createdAt = "2026-08-08T03:02:00.000Z";
    const fileName = fileNameFor(createdAt, backupId);
    port.manifest = {
      schemaVersion: 1,
      rootId: ROOT_ID,
      revision: 7,
      policy: { scheduleHourLocal: 3, retentionDays: 30 },
      lastSuccessfulSlot: "2026-08-08",
      entries: [
        {
          backupId,
          createdBy: "inkshadow_automatic_backup_service",
          scheduleSlot: "2026-08-08",
          fileName,
          absolutePath: `${ROOT_PATH}/${fileName}`,
          createdAt,
          retentionUntil: addDays(createdAt, 30),
          status: "ready",
          byteLength: 4096,
          sha256: SHA_A,
        },
      ],
      updatedAt: createdAt,
    } as unknown as AutomaticBackupManifest;
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "attention",
      createdBackup: null,
      attention: { status: "unknown", failureKind: "result_unconfirmed" },
      recoveredPendingCount: 1,
    });
    expect(port.createRequests).toHaveLength(0);
    expect(port.manifest).toMatchObject({
      schemaVersion: 2,
      lastSuccessfulSlot: null,
      entries: [
        {
          backupId,
          status: "unknown",
          byteLength: 4096,
          sha256: SHA_A,
        },
      ],
    });
  });

  it("keeps the newest healthy backup when a new write fails and does not retry that slot", async () => {
    const healthy = succeededEntry({
      backupId: uuid(27),
      createdAt: "2026-07-01T03:00:00.000Z",
      scheduleSlot: "2026-07-01",
      sha256: SHA_A,
    });
    port.manifest = manifest({
      revision: 4,
      lastSuccessfulSlot: "2026-08-07",
      entries: [healthy],
      updatedAt: "2026-08-07T03:00:00.000Z",
    });
    port.files.set(healthy.absolutePath, presentFile(healthy));
    port.creationOutcome = { outcome: "failed", failureKind: "disk_full" };
    const service = new AutomaticBackupService(port, ids);

    const first = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });
    const second = await service.runIfDue({
      now: "2026-08-08T05:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(first).toMatchObject({
      status: "attention",
      prunedCount: 0,
      attention: { status: "failed", failureKind: "disk_full" },
    });
    expect(second.status).toBe("attention");
    expect(port.createRequests).toHaveLength(1);
    expect(port.deleteRequests).toHaveLength(0);
    expect(port.files.has(healthy.absolutePath)).toBe(true);
  });

  it("records a lost native response as unknown without claiming a backup exists", async () => {
    port.creationOutcome = "throw";
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "attention",
      createdBackup: null,
      attention: { status: "unknown", failureKind: "result_unconfirmed" },
    });
    expect(port.manifest?.entries).toEqual([
      expect.objectContaining({ status: "unknown", byteLength: null, sha256: null }),
    ]);
  });

  it("records a permission refusal as not started and does not retry the slot", async () => {
    port.creationOutcome = { outcome: "not_started", failureKind: "permission_denied" };
    const service = new AutomaticBackupService(port, ids);

    const first = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });
    const second = await service.runIfDue({
      now: "2026-08-08T05:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(first).toMatchObject({
      status: "attention",
      attention: { status: "not_started", failureKind: "permission_denied" },
    });
    expect(second.status).toBe("attention");
    expect(port.createRequests).toHaveLength(1);
    expect(port.manifest?.entries[0]).toMatchObject({
      status: "not_started",
      writeStartedAt: null,
      failureKind: "permission_denied",
    });
  });

  it("fails closed before locking when the root marker or canonical path is untrusted", async () => {
    port.rootInspection = {
      ...port.rootInspection,
      canonicalAbsolutePath: "D:/Users/test/AppData/Elsewhere/automatic-backups/v1",
    };
    const service = new AutomaticBackupService(port, ids);

    await expect(
      service.runIfDue({
        now: "2026-08-08T04:00:00.000Z",
        timezoneOffsetMinutes: 0,
      }),
    ).rejects.toMatchObject({
      code: "AUTOMATIC_BACKUP_ROOT_UNTRUSTED",
    });
    expect(port.acquireCount).toBe(0);
    expect(port.createRequests).toHaveLength(0);
    expect(port.deleteRequests).toHaveLength(0);
  });

  it("rejects a manual or traversal-shaped manifest entry before file inspection", async () => {
    const unsafe = {
      ...succeededEntry({
        backupId: uuid(23),
        createdAt: "2026-07-01T03:00:00.000Z",
        scheduleSlot: "2026-07-01",
        sha256: SHA_A,
      }),
      fileName: "../manual.sqlite3",
      absolutePath: `${ROOT_PATH}/../manual.sqlite3`,
    };
    port.manifest = manifest({
      revision: 1,
      lastSuccessfulSlot: "2026-08-08",
      entries: [unsafe],
      updatedAt: "2026-08-08T03:00:00.000Z",
    });
    const service = new AutomaticBackupService(port, ids);

    await expect(
      service.runIfDue({
        now: "2026-08-08T12:00:00.000Z",
        timezoneOffsetMinutes: 0,
      }),
    ).rejects.toMatchObject({
      code: "AUTOMATIC_BACKUP_MANIFEST_INVALID",
    });
    expect(port.inspectRequests).toHaveLength(0);
    expect(port.deleteRequests).toHaveLength(0);
  });

  it("refuses deletion when the current file checksum differs from the manifest", async () => {
    const expired = succeededEntry({
      backupId: uuid(24),
      createdAt: "2026-07-01T03:00:00.000Z",
      scheduleSlot: "2026-07-01",
      sha256: SHA_A,
    });
    port.manifest = manifest({
      revision: 1,
      lastSuccessfulSlot: "2026-08-07",
      entries: [expired],
      updatedAt: "2026-08-08T03:00:00.000Z",
    });
    port.files.set(expired.absolutePath, { ...presentFile(expired), sha256: SHA_B });
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T12:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result).toMatchObject({
      status: "completed",
      recoveredPendingCount: 1,
      createdBackup: { status: "succeeded", scheduleSlot: "2026-08-08" },
    });
    expect(port.deleteRequests).toHaveLength(0);
    expect(port.files.has(expired.absolutePath)).toBe(true);
    expect(port.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backupId: expired.backupId,
          status: "unknown",
          sha256: SHA_A,
        }),
        expect.objectContaining({ status: "succeeded", scheduleSlot: "2026-08-08" }),
      ]),
    );
  });

  it("returns busy without reading or mutating metadata when another process owns the lease", async () => {
    port.leaseAvailable = false;
    const service = new AutomaticBackupService(port, ids);

    const result = await service.runIfDue({
      now: "2026-08-08T04:00:00.000Z",
      timezoneOffsetMinutes: 0,
    });

    expect(result.status).toBe("busy");
    expect(port.readManifestCount).toBe(0);
    expect(port.createRequests).toHaveLength(0);
    expect(port.deleteRequests).toHaveLength(0);
  });
});

class SequenceIds implements AutomaticBackupIdGenerator {
  private index = 0;

  public constructor(private readonly values: readonly string[]) {}

  public next(): string {
    const value = this.values[this.index];
    if (value === undefined) throw new Error("test id sequence exhausted");
    this.index += 1;
    return value;
  }
}

class MemoryAutomaticBackupPort implements AutomaticBackupPort {
  public rootInspection: AutomaticBackupRootInspection = {
    absolutePath: ROOT_PATH,
    canonicalAbsolutePath: ROOT_PATH,
    ownershipMarker: {
      product: "InkShadow",
      purpose: "automatic_backups",
      schemaVersion: 1,
      rootId: ROOT_ID,
    },
  };
  public manifest: AutomaticBackupManifest | null = null;
  public readonly files = new Map<string, AutomaticBackupFilePresent>();
  public readonly createRequests: string[] = [];
  public readonly inspectRequests: string[] = [];
  public readonly deleteRequests: string[] = [];
  public leaseAvailable = true;
  public acquireCount = 0;
  public readManifestCount = 0;
  public creationOutcome:
    | Readonly<{
        outcome: "not_started" | "failed" | "unknown";
        failureKind: AutomaticBackupFailureKind;
      }>
    | "succeeded"
    | "throw" = "succeeded";

  public inspectManagedRoot(): Promise<AutomaticBackupRootInspection> {
    return Promise.resolve(structuredClone(this.rootInspection));
  }

  public acquireLease(): Promise<AutomaticBackupLease | null> {
    this.acquireCount += 1;
    return Promise.resolve(this.leaseAvailable ? { token: "lease-token-0000000000000001" } : null);
  }

  public releaseLease(): Promise<void> {
    return Promise.resolve();
  }

  public readManifest(): Promise<unknown> {
    this.readManifestCount += 1;
    return Promise.resolve(this.manifest === null ? null : structuredClone(this.manifest));
  }

  public writeManifest(
    _root: VerifiedAutomaticBackupRoot,
    _lease: AutomaticBackupLease,
    expectedRevision: number,
    next: AutomaticBackupManifest,
  ): Promise<unknown> {
    const actualRevision = this.manifest?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      return Promise.reject(new Error("manifest revision conflict"));
    }
    this.manifest = structuredClone(next);
    return Promise.resolve(structuredClone(next));
  }

  public createConsistentBackup(
    _root: VerifiedAutomaticBackupRoot,
    _lease: AutomaticBackupLease,
    request: AutomaticBackupManifestWritingEntry,
  ): Promise<unknown> {
    this.createRequests.push(request.backupId);
    if (this.creationOutcome === "throw") {
      return Promise.reject(new Error("native result lost"));
    }
    if (this.creationOutcome !== "succeeded") {
      return Promise.resolve(structuredClone(this.creationOutcome));
    }
    const file: AutomaticBackupFilePresent = {
      exists: true,
      fileName: request.fileName,
      absolutePath: request.absolutePath,
      canonicalAbsolutePath: request.absolutePath,
      byteLength: 4096,
      sha256: SHA_A,
      integrityVerified: true,
    };
    this.files.set(request.absolutePath, file);
    return Promise.resolve({ outcome: "succeeded", file: structuredClone(file) });
  }

  public inspectBackupFile(
    _root: VerifiedAutomaticBackupRoot,
    _lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestEntry,
  ): Promise<AutomaticBackupFileInspection> {
    this.inspectRequests.push(entry.backupId);
    const file = this.files.get(entry.absolutePath);
    return Promise.resolve(file === undefined ? { exists: false } : structuredClone(file));
  }

  public deleteBackupFile(
    _root: VerifiedAutomaticBackupRoot,
    _lease: AutomaticBackupLease,
    entry: AutomaticBackupManifestSucceededEntry,
  ): Promise<"deleted" | "already_missing"> {
    this.deleteRequests.push(entry.backupId);
    const existing = this.files.get(entry.absolutePath);
    if (existing === undefined) return Promise.resolve("already_missing");
    if (existing.sha256 !== entry.sha256 || existing.byteLength !== entry.byteLength) {
      return Promise.reject(new Error("conditional delete mismatch"));
    }
    this.files.delete(entry.absolutePath);
    return Promise.resolve("deleted");
  }
}

function manifest(
  input: Readonly<{
    revision: number;
    lastSuccessfulSlot: string | null;
    entries: readonly AutomaticBackupManifestEntry[];
    updatedAt: string;
  }>,
): AutomaticBackupManifest {
  return {
    schemaVersion: 2,
    rootId: ROOT_ID,
    revision: input.revision,
    policy: { scheduleHourLocal: 3, retentionDays: 30 },
    lastSuccessfulSlot: input.lastSuccessfulSlot,
    entries: input.entries,
    updatedAt: input.updatedAt,
  };
}

function writingEntry(
  input: Readonly<{
    backupId: string;
    createdAt: string;
    scheduleSlot: string;
  }>,
): AutomaticBackupManifestWritingEntry {
  const fileName = fileNameFor(input.createdAt, input.backupId);
  return {
    backupId: input.backupId,
    createdBy: "inkshadow_automatic_backup_service",
    scheduleSlot: input.scheduleSlot,
    fileName,
    absolutePath: `${ROOT_PATH}/${fileName}`,
    createdAt: input.createdAt,
    retentionUntil: addDays(input.createdAt, 30),
    status: "writing",
    byteLength: null,
    sha256: null,
    writeStartedAt: input.createdAt,
    finishedAt: null,
    failureKind: null,
  };
}

function succeededEntry(
  input: Readonly<{
    backupId: string;
    createdAt: string;
    scheduleSlot: string;
    sha256: string;
  }>,
): AutomaticBackupManifestSucceededEntry {
  return {
    ...writingEntry(input),
    status: "succeeded",
    byteLength: 4096,
    sha256: input.sha256,
    finishedAt: input.createdAt,
  };
}

function verifyingEntry(
  input: Readonly<{
    backupId: string;
    createdAt: string;
    scheduleSlot: string;
    sha256: string;
  }>,
): AutomaticBackupManifestVerifyingEntry {
  return {
    ...writingEntry(input),
    status: "verifying" as const,
    byteLength: 4096,
    sha256: input.sha256,
  };
}

function presentFile(
  entry: AutomaticBackupManifestSucceededEntry | AutomaticBackupManifestVerifyingEntry,
): AutomaticBackupFilePresent {
  return {
    exists: true,
    fileName: entry.fileName,
    absolutePath: entry.absolutePath,
    canonicalAbsolutePath: entry.absolutePath,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    integrityVerified: true,
  };
}

function fileNameFor(timestamp: string, backupId: string): string {
  return `inkshadow-auto-v1-${timestamp.replaceAll(/[-:.]/gu, "")}-${backupId}.sqlite3`;
}

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
