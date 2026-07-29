import { describe, expect, it } from "vitest";

import { ChunkTransferLedger } from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function ledger() {
  return new ChunkTransferLedger({
    transferId: "transfer-1",
    projectId: "project-1",
    objectId: "chapter-1",
    versionId: "version-1",
    chunks: [
      { chunkId: "chunk-1", index: 0, ciphertextBytes: 100, ciphertextSha256: HASH_A },
      { chunkId: "chunk-2", index: 1, ciphertextBytes: 80, ciphertextSha256: HASH_B },
    ],
  });
}

describe("resumable ciphertext transfer ledger", () => {
  it("plans only missing chunks and reports byte progress", () => {
    const transfer = ledger();
    expect(transfer.plan().map(({ chunkId }) => chunkId)).toEqual(["chunk-1", "chunk-2"]);

    transfer.acknowledge("chunk-1", {
      ciphertextSha256: HASH_A,
      remoteETag: "etag-1",
    });

    expect(transfer.plan().map(({ chunkId }) => chunkId)).toEqual(["chunk-2"]);
    expect(transfer.progress()).toEqual({
      totalChunks: 2,
      acknowledgedChunks: 1,
      totalBytes: 180,
      acknowledgedBytes: 100,
      complete: false,
    });
  });

  it("makes matching retries idempotent and rejects changed receipts", () => {
    const transfer = ledger();
    const receipt = { ciphertextSha256: HASH_A, remoteETag: "etag-1" };

    expect(transfer.acknowledge("chunk-1", receipt).created).toBe(true);
    expect(transfer.acknowledge("chunk-1", receipt).created).toBe(false);
    expect(() =>
      transfer.acknowledge("chunk-1", {
        ciphertextSha256: HASH_A,
        remoteETag: "etag-changed",
      }),
    ).toThrowError(expect.objectContaining({ code: "SYNC_TRANSFER_MISMATCH" }));
  });

  it("rejects wrong hashes, unknown chunks, gaps, and duplicate indexes", () => {
    const transfer = ledger();
    expect(() =>
      transfer.acknowledge("chunk-1", {
        ciphertextSha256: HASH_B,
        remoteETag: "etag-1",
      }),
    ).toThrow();
    expect(() =>
      transfer.acknowledge("chunk-unknown", {
        ciphertextSha256: HASH_A,
        remoteETag: "etag-1",
      }),
    ).toThrow();
    expect(
      () =>
        new ChunkTransferLedger({
          transferId: "transfer-2",
          projectId: "project-1",
          objectId: "chapter-1",
          versionId: "version-1",
          chunks: [
            { chunkId: "chunk-1", index: 0, ciphertextBytes: 1, ciphertextSha256: HASH_A },
            { chunkId: "chunk-2", index: 2, ciphertextBytes: 1, ciphertextSha256: HASH_B },
          ],
        }),
    ).toThrow();
  });
});
