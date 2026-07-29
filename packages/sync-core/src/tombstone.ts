import { SyncCoreError } from "./errors.js";
import { SYNC_OBJECT_TYPES, type SyncObjectType } from "./chunk-crypto.js";
import { normalizeVersionVector, vectorObserves, type VersionVector } from "./version-vector.js";
import { requireIdentifier, requireIsoTimestamp, requirePositiveInteger } from "./validation.js";

const MINIMUM_TOMBSTONE_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

export interface SyncTombstoneSnapshot {
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly deletedByDeviceId: string;
  readonly vector: VersionVector;
  readonly deletedAt: string;
  readonly retainUntil: string;
  readonly acknowledgedDeviceIds: readonly string[];
}

export interface TombstonePurgeDecision {
  readonly allowed: boolean;
  readonly reason: "retention_active" | "trusted_devices_pending" | "ready";
  readonly pendingDeviceIds: readonly string[];
}

export class SyncTombstone {
  private constructor(private readonly snapshot: SyncTombstoneSnapshot) {
    Object.freeze(snapshot.acknowledgedDeviceIds);
    Object.freeze(snapshot);
    Object.freeze(this);
  }

  public static create(
    input: Omit<SyncTombstoneSnapshot, "acknowledgedDeviceIds"> & {
      readonly acknowledgedDeviceIds?: readonly string[];
    },
  ): SyncTombstone {
    if (!SYNC_OBJECT_TYPES.includes(input.objectType)) {
      throw new SyncCoreError("SYNC_VALIDATION_FAILED", "Sync object type is unsupported.");
    }
    const deletedAt = requireIsoTimestamp(input.deletedAt, "deletedAt");
    const retainUntil = requireIsoTimestamp(input.retainUntil, "retainUntil");
    if (Date.parse(retainUntil) - Date.parse(deletedAt) < MINIMUM_TOMBSTONE_RETENTION_MS) {
      throw new SyncCoreError(
        "SYNC_VALIDATION_FAILED",
        "Tombstones must be retained for at least 365 days.",
      );
    }
    const acknowledgedDeviceIds = normalizeDeviceIds(input.acknowledgedDeviceIds ?? []);
    return new SyncTombstone({
      projectId: requireIdentifier(input.projectId, "projectId"),
      objectType: input.objectType,
      objectId: requireIdentifier(input.objectId, "objectId"),
      objectGeneration: requirePositiveInteger(input.objectGeneration, "objectGeneration"),
      deletedByDeviceId: requireIdentifier(input.deletedByDeviceId, "deletedByDeviceId"),
      vector: normalizeVersionVector(input.vector),
      deletedAt,
      retainUntil,
      acknowledgedDeviceIds,
    });
  }

  public toSnapshot(): SyncTombstoneSnapshot {
    return {
      ...this.snapshot,
      vector: { ...this.snapshot.vector },
      acknowledgedDeviceIds: [...this.snapshot.acknowledgedDeviceIds],
    };
  }

  public acknowledge(deviceIdValue: string, observedVector: VersionVector): SyncTombstone {
    const deviceId = requireIdentifier(deviceIdValue, "deviceId");
    if (!vectorObserves(observedVector, this.snapshot.vector)) {
      throw new SyncCoreError(
        "SYNC_TOMBSTONE_NOT_OBSERVED",
        "A device may acknowledge only after observing the tombstone vector.",
      );
    }
    if (this.snapshot.acknowledgedDeviceIds.includes(deviceId)) {
      return this;
    }
    return SyncTombstone.create({
      ...this.snapshot,
      acknowledgedDeviceIds: [...this.snapshot.acknowledgedDeviceIds, deviceId],
    });
  }

  public rejectsObjectGeneration(generation: number): boolean {
    return requirePositiveInteger(generation, "objectGeneration") <= this.snapshot.objectGeneration;
  }

  public decidePurge(
    trustedDeviceIdsValue: readonly string[],
    nowValue: string,
  ): TombstonePurgeDecision {
    const now = requireIsoTimestamp(nowValue, "now");
    if (Date.parse(now) < Date.parse(this.snapshot.retainUntil)) {
      return { allowed: false, reason: "retention_active", pendingDeviceIds: [] };
    }
    const trustedDeviceIds = normalizeDeviceIds(trustedDeviceIdsValue);
    const acknowledged = new Set(this.snapshot.acknowledgedDeviceIds);
    const pendingDeviceIds = trustedDeviceIds.filter((deviceId) => !acknowledged.has(deviceId));
    return pendingDeviceIds.length === 0
      ? { allowed: true, reason: "ready", pendingDeviceIds: [] }
      : {
          allowed: false,
          reason: "trusted_devices_pending",
          pendingDeviceIds,
        };
  }
}

function normalizeDeviceIds(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => requireIdentifier(value, "deviceId")).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new SyncCoreError("SYNC_VALIDATION_FAILED", "Device identifiers must be unique.");
  }
  return Object.freeze(normalized);
}
