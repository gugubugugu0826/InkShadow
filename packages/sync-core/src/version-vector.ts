import { SyncCoreError } from "./errors.js";
import { requireIdentifier, requirePositiveInteger } from "./validation.js";

const MAX_VECTOR_DEVICES = 1_024;

export type VersionVector = Readonly<Record<string, number>>;
export type CausalRelation = "equal" | "before" | "after" | "concurrent";
export type IncomingMutationDecision = "duplicate" | "apply" | "ignore" | "conflict";

export function normalizeVersionVector(input: VersionVector): VersionVector {
  const entries = Object.entries(input);
  if (entries.length > MAX_VECTOR_DEVICES) {
    throw new SyncCoreError(
      "SYNC_VECTOR_INVALID",
      `A version vector may contain at most ${String(MAX_VECTOR_DEVICES)} devices.`,
    );
  }

  const normalized: Record<string, number> = {};
  for (const [deviceIdValue, counterValue] of entries) {
    const deviceId = requireIdentifier(deviceIdValue, "deviceId");
    const counter = requirePositiveInteger(counterValue, `counter:${deviceId}`);
    if (Object.hasOwn(normalized, deviceId)) {
      throw new SyncCoreError("SYNC_VECTOR_INVALID", "Device identifiers must be unique.");
    }
    normalized[deviceId] = counter;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function incrementVersionVector(
  vector: VersionVector,
  deviceIdValue: string,
): VersionVector {
  const current = normalizeVersionVector(vector);
  const deviceId = requireIdentifier(deviceIdValue, "deviceId");
  const previous = current[deviceId] ?? 0;
  if (previous === Number.MAX_SAFE_INTEGER) {
    throw new SyncCoreError("SYNC_VECTOR_INVALID", "The device counter is exhausted.");
  }
  return normalizeVersionVector({ ...current, [deviceId]: previous + 1 });
}

export function mergeVersionVectors(
  leftValue: VersionVector,
  rightValue: VersionVector,
): VersionVector {
  const left = normalizeVersionVector(leftValue);
  const right = normalizeVersionVector(rightValue);
  const merged: Record<string, number> = { ...left };
  for (const [deviceId, counter] of Object.entries(right)) {
    merged[deviceId] = Math.max(merged[deviceId] ?? 0, counter);
  }
  return normalizeVersionVector(merged);
}

export function compareVersionVectors(
  leftValue: VersionVector,
  rightValue: VersionVector,
): CausalRelation {
  const left = normalizeVersionVector(leftValue);
  const right = normalizeVersionVector(rightValue);
  const devices = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftAhead = false;
  let rightAhead = false;
  for (const deviceId of devices) {
    const leftCounter = left[deviceId] ?? 0;
    const rightCounter = right[deviceId] ?? 0;
    if (leftCounter > rightCounter) {
      leftAhead = true;
    } else if (rightCounter > leftCounter) {
      rightAhead = true;
    }
  }

  if (!leftAhead && !rightAhead) {
    return "equal";
  }
  if (leftAhead && rightAhead) {
    return "concurrent";
  }
  return leftAhead ? "after" : "before";
}

export function decideIncomingMutation(
  local: VersionVector,
  incoming: VersionVector,
): IncomingMutationDecision {
  const relation = compareVersionVectors(local, incoming);
  const decisions: Record<CausalRelation, IncomingMutationDecision> = {
    equal: "duplicate",
    before: "apply",
    after: "ignore",
    concurrent: "conflict",
  };
  return decisions[relation];
}

export function vectorObserves(observer: VersionVector, observed: VersionVector): boolean {
  const relation = compareVersionVectors(observer, observed);
  return relation === "equal" || relation === "after";
}
