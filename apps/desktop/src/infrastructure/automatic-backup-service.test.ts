import { beforeEach, describe, expect, it } from "vitest";

import {
  AutomaticBackupService,
  type AutomaticBackupFileInspection,
  type AutomaticBackupFilePresent,
  type AutomaticBackupIdGenerator,
  type AutomaticBackupLease,
  type AutomaticBackupManifest,
  type AutomaticBackupManifestCreatingEntry,
  type AutomaticBackupManifestEntry,
  type AutomaticBackupManifestReadyEntry,
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
      status: "ready",
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
    const expired = readyEntry({
      backupId: uuid(20),
      createdAt: "2026-07-01T03:00:00.000Z",
      scheduleSlot: "2026-07-01",
      sha256: SHA_A,
    });
    const retained = readyEntry({
      backupId: uuid(21),
      createdAt: "2026-08-01T03:00:00.000Z",
      scheduleSlot: "2026-08-01",
      sha256: SHA_B,
    });
    port.manifest = manifest({
      revision: 4,
      lastSuccessfulSlot: "2026-08-08",
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

    expect(result).toMatchObject({ status: "completed", createdBackup: null, prunedCount: 1 });
    expect(port.deleteRequests).toEqual([expired.backupId]);
    expect(port.files.has(expired.absolutePath)).toBe(false);
    expect(port.files.has(retained.absolutePath)).toBe(true);
    expect(port.files.has(manualPath)).toBe(true);
    expect(port.manifest.entries.map(({ backupId }) => backupId)).toEqual([retained.backupId]);
  });

  it("recovers a manifest-reserved backup after an interrupted manifest commit", async () => {
    const pending = creatingEntry({
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
    expect(port.manifest.entries[0]).toMatchObject({ status: "ready", sha256: SHA_A });
    expect(port.manifest.lastSuccessfulSlot).toBe("2026-08-08");
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
      ...readyEntry({
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
    const expired = readyEntry({
      backupId: uuid(24),
      createdAt: "2026-07-01T03:00:00.000Z",
      scheduleSlot: "2026-07-01",
      sha256: SHA_A,
    });
    port.manifest = manifest({
      revision: 1,
      lastSuccessfulSlot: "2026-08-08",
      entries: [expired],
      updatedAt: "2026-08-08T03:00:00.000Z",
    });
    port.files.set(expired.absolutePath, { ...presentFile(expired), sha256: SHA_B });
    const service = new AutomaticBackupService(port, ids);

    await expect(
      service.runIfDue({
        now: "2026-08-08T12:00:00.000Z",
        timezoneOffsetMinutes: 0,
      }),
    ).rejects.toMatchObject({
      code: "AUTOMATIC_BACKUP_FILE_SAFETY_CHECK_FAILED",
    });
    expect(port.deleteRequests).toHaveLength(0);
    expect(port.files.has(expired.absolutePath)).toBe(true);
    expect(port.manifest.entries).toHaveLength(1);
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
    request: Readonly<{ backupId: string; fileName: string; absolutePath: string }>,
  ): Promise<AutomaticBackupFilePresent> {
    this.createRequests.push(request.backupId);
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
    return Promise.resolve(structuredClone(file));
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
    entry: AutomaticBackupManifestReadyEntry,
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
    schemaVersion: 1,
    rootId: ROOT_ID,
    revision: input.revision,
    policy: { scheduleHourLocal: 3, retentionDays: 30 },
    lastSuccessfulSlot: input.lastSuccessfulSlot,
    entries: input.entries,
    updatedAt: input.updatedAt,
  };
}

function creatingEntry(
  input: Readonly<{
    backupId: string;
    createdAt: string;
    scheduleSlot: string;
  }>,
): AutomaticBackupManifestCreatingEntry {
  const fileName = fileNameFor(input.createdAt, input.backupId);
  return {
    backupId: input.backupId,
    createdBy: "inkshadow_automatic_backup_service",
    scheduleSlot: input.scheduleSlot,
    fileName,
    absolutePath: `${ROOT_PATH}/${fileName}`,
    createdAt: input.createdAt,
    retentionUntil: addDays(input.createdAt, 30),
    status: "creating",
    byteLength: null,
    sha256: null,
  };
}

function readyEntry(
  input: Readonly<{
    backupId: string;
    createdAt: string;
    scheduleSlot: string;
    sha256: string;
  }>,
): AutomaticBackupManifestReadyEntry {
  return {
    ...creatingEntry(input),
    status: "ready",
    byteLength: 4096,
    sha256: input.sha256,
  };
}

function presentFile(entry: AutomaticBackupManifestReadyEntry): AutomaticBackupFilePresent {
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
