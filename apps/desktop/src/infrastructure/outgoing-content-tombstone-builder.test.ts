import { describe, expect, it } from "vitest";

import { OutgoingContentTombstoneBuilder } from "./outgoing-content-tombstone-builder";

const PROJECT_ID = "019fa301-0000-7000-8000-000000000001";
const OBJECT_ID = "019fa301-0000-7000-8000-000000000002";
const DEVICE_ID = "019fa301-0000-7000-8000-000000000003";
const OPERATION_ID = "019fa301-0000-7000-8000-000000000004";
const DELETED_AT = "2026-07-29T00:00:00.000Z";
const RETAIN_UNTIL = "2027-07-29T00:00:00.000Z";

describe("OutgoingContentTombstoneBuilder", () => {
  it("builds an exact ciphertext-free protocol-v2 delete pair", () => {
    const built = new OutgoingContentTombstoneBuilder().build(validInput());

    expect(built.operation).toEqual({
      schemaVersion: 2,
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 2,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 2,
      kind: "delete",
      vector: { [DEVICE_ID]: 2 },
      encryptedChunkIds: [],
      createdAt: DELETED_AT,
    });
    expect(built.tombstone).toEqual({
      schemaVersion: 2,
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 2,
      deletedByDeviceId: DEVICE_ID,
      vector: { [DEVICE_ID]: 2 },
      deletedAt: DELETED_AT,
      retainUntil: RETAIN_UNTIL,
      acknowledgedDeviceIds: [],
    });
  });

  it.each([
    ["odd generation", { objectGeneration: 1 }],
    ["unsafe generation", { objectGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe sequence", { deviceSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["vector mismatch", { vector: { [DEVICE_ID]: 1 } }],
    ["short retention", { retainUntil: "2027-07-28T23:59:59.999Z" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      new OutgoingContentTombstoneBuilder().build({ ...validInput(), ...override }),
    ).toThrow();
  });
});

function validInput() {
  return {
    projectId: PROJECT_ID,
    objectType: "chapter_version" as const,
    objectId: OBJECT_ID,
    objectGeneration: 2,
    deviceId: DEVICE_ID,
    deviceSequence: 2,
    operationId: OPERATION_ID,
    vector: { [DEVICE_ID]: 2 },
    deletedAt: DELETED_AT,
    retainUntil: RETAIN_UNTIL,
  };
}
