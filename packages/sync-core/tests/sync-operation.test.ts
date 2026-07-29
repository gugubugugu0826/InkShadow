import { describe, expect, it } from "vitest";

import { SyncOperation } from "../src/index.js";

const NOW = "2026-07-27T00:00:00.000Z";

describe("sync operations", () => {
  it("accepts ciphertext-only upserts and makes causal decisions", () => {
    const operation = SyncOperation.create({
      operationId: "operation-1",
      projectId: "project-1",
      deviceId: "device-a",
      deviceSequence: 2,
      objectType: "chapter_version",
      objectId: "chapter-1",
      objectGeneration: 1,
      kind: "upsert",
      vector: { "device-a": 2, "device-b": 1 },
      encryptedChunkIds: ["chunk-1", "chunk-2"],
      createdAt: NOW,
    });

    expect(operation.decideAgainst({ "device-a": 1, "device-b": 1 })).toBe("apply");
    expect(operation.decideAgainst({ "device-a": 2, "device-c": 1 })).toBe("conflict");
    expect(operation.toSnapshot()).toMatchObject({ objectType: "chapter_version" });
    expect(operation.toSnapshot()).not.toHaveProperty("content");
  });

  it("requires the device sequence to match its version vector", () => {
    expect(() =>
      SyncOperation.create({
        operationId: "operation-1",
        projectId: "project-1",
        deviceId: "device-a",
        deviceSequence: 3,
        objectType: "chapter_version",
        objectId: "chapter-1",
        objectGeneration: 1,
        kind: "upsert",
        vector: { "device-a": 2 },
        encryptedChunkIds: ["chunk-1"],
        createdAt: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "SYNC_SEQUENCE_MISMATCH" }));
  });

  it("requires upserts to carry ciphertext and deletes to carry none", () => {
    const common = {
      operationId: "operation-1",
      projectId: "project-1",
      deviceId: "device-a",
      deviceSequence: 1,
      objectType: "chapter_version",
      objectId: "chapter-1",
      objectGeneration: 1,
      vector: { "device-a": 1 },
      createdAt: NOW,
    } as const;

    expect(() =>
      SyncOperation.create({ ...common, kind: "upsert", encryptedChunkIds: [] }),
    ).toThrow();
    expect(() =>
      SyncOperation.create({ ...common, kind: "delete", encryptedChunkIds: ["chunk-1"] }),
    ).toThrow();
    expect(
      SyncOperation.create({ ...common, kind: "delete", encryptedChunkIds: [] }).toSnapshot().kind,
    ).toBe("delete");
  });

  it("rejects an unsupported object type at the domain boundary", () => {
    expect(() =>
      SyncOperation.create({
        operationId: "operation-1",
        projectId: "project-1",
        deviceId: "device-a",
        deviceSequence: 1,
        objectType: "unsupported" as "chapter_version",
        objectId: "chapter-1",
        objectGeneration: 1,
        kind: "upsert",
        vector: { "device-a": 1 },
        encryptedChunkIds: ["chunk-1"],
        createdAt: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "SYNC_VALIDATION_FAILED" }));
  });
});
