import { describe, expect, it } from "vitest";

import { SyncTombstone } from "../src/index.js";

const DELETED_AT = "2026-01-01T00:00:00.000Z";
const RETAIN_UNTIL = "2027-01-01T00:00:00.000Z";

function tombstone() {
  return SyncTombstone.create({
    projectId: "project-1",
    objectType: "chapter_version",
    objectId: "chapter-1",
    objectGeneration: 4,
    deletedByDeviceId: "device-a",
    vector: { "device-a": 3, "device-b": 2 },
    deletedAt: DELETED_AT,
    retainUntil: RETAIN_UNTIL,
  });
}

describe("sync tombstones", () => {
  it("prevents older offline data from reviving a deleted generation", () => {
    const deleted = tombstone();

    expect(deleted.rejectsObjectGeneration(3)).toBe(true);
    expect(deleted.rejectsObjectGeneration(4)).toBe(true);
    expect(deleted.rejectsObjectGeneration(5)).toBe(false);
    expect(deleted.toSnapshot()).toMatchObject({ objectType: "chapter_version" });
  });

  it("accepts an acknowledgement only after the device observes the delete vector", () => {
    const deleted = tombstone();
    expect(() => deleted.acknowledge("device-b", { "device-a": 2, "device-b": 2 })).toThrowError(
      expect.objectContaining({ code: "SYNC_TOMBSTONE_NOT_OBSERVED" }),
    );

    const acknowledged = deleted.acknowledge("device-b", {
      "device-a": 3,
      "device-b": 3,
    });
    expect(acknowledged.toSnapshot().acknowledgedDeviceIds).toEqual(["device-b"]);
    expect(acknowledged.acknowledge("device-b", { "device-a": 3, "device-b": 3 })).toBe(
      acknowledged,
    );
  });

  it("requires both retention expiry and every trusted device acknowledgement before purge", () => {
    const observed = tombstone()
      .acknowledge("device-a", { "device-a": 3, "device-b": 2 })
      .acknowledge("device-b", { "device-a": 3, "device-b": 2 });

    expect(observed.decidePurge(["device-a", "device-b"], "2026-12-31T23:59:59.999Z")).toEqual({
      allowed: false,
      reason: "retention_active",
      pendingDeviceIds: [],
    });
    expect(observed.decidePurge(["device-a", "device-b", "device-c"], RETAIN_UNTIL)).toEqual({
      allowed: false,
      reason: "trusted_devices_pending",
      pendingDeviceIds: ["device-c"],
    });
    expect(observed.decidePurge(["device-a", "device-b"], RETAIN_UNTIL)).toEqual({
      allowed: true,
      reason: "ready",
      pendingDeviceIds: [],
    });
  });

  it("rejects retention shorter than 365 days", () => {
    expect(() =>
      SyncTombstone.create({
        projectId: "project-1",
        objectType: "chapter_version",
        objectId: "chapter-1",
        objectGeneration: 1,
        deletedByDeviceId: "device-a",
        vector: { "device-a": 1 },
        deletedAt: DELETED_AT,
        retainUntil: "2026-12-31T23:59:59.999Z",
      }),
    ).toThrow();
  });

  it("rejects an unsupported object type at the domain boundary", () => {
    expect(() =>
      SyncTombstone.create({
        projectId: "project-1",
        objectType: "unsupported" as "chapter_version",
        objectId: "chapter-1",
        objectGeneration: 1,
        deletedByDeviceId: "device-a",
        vector: { "device-a": 1 },
        deletedAt: DELETED_AT,
        retainUntil: RETAIN_UNTIL,
      }),
    ).toThrowError(expect.objectContaining({ code: "SYNC_VALIDATION_FAILED" }));
  });
});
