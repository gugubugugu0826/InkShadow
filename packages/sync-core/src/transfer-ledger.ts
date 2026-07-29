import { SyncCoreError } from "./errors.js";
import {
  requireIdentifier,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSha256,
} from "./validation.js";

export interface CiphertextChunkManifestEntry {
  readonly chunkId: string;
  readonly index: number;
  readonly ciphertextBytes: number;
  readonly ciphertextSha256: string;
}

export interface ChunkTransferManifest {
  readonly transferId: string;
  readonly projectId: string;
  readonly objectId: string;
  readonly versionId: string;
  readonly chunks: readonly CiphertextChunkManifestEntry[];
}

export interface ChunkUploadReceipt {
  readonly ciphertextSha256: string;
  readonly remoteETag: string;
}

export interface ChunkAcknowledgement {
  readonly chunkId: string;
  readonly created: boolean;
}

export interface ChunkTransferProgress {
  readonly totalChunks: number;
  readonly acknowledgedChunks: number;
  readonly totalBytes: number;
  readonly acknowledgedBytes: number;
  readonly complete: boolean;
}

export class ChunkTransferLedger {
  private readonly manifest: ChunkTransferManifest;
  private readonly receipts = new Map<string, ChunkUploadReceipt>();

  public constructor(input: ChunkTransferManifest) {
    const chunks = input.chunks
      .map((chunk) => ({
        chunkId: requireIdentifier(chunk.chunkId, "chunkId"),
        index: requireNonNegativeInteger(chunk.index, "chunk.index"),
        ciphertextBytes: requirePositiveInteger(chunk.ciphertextBytes, "chunk.ciphertextBytes"),
        ciphertextSha256: requireSha256(chunk.ciphertextSha256, "chunk.ciphertextSha256"),
      }))
      .sort((left, right) => left.index - right.index);
    if (
      chunks.length === 0 ||
      chunks.length > 10_000 ||
      new Set(chunks.map(({ chunkId }) => chunkId)).size !== chunks.length ||
      chunks.some(({ index }, expectedIndex) => index !== expectedIndex)
    ) {
      throw new SyncCoreError(
        "SYNC_VALIDATION_FAILED",
        "Transfer chunks must be unique, bounded, and have contiguous indexes.",
      );
    }
    this.manifest = Object.freeze({
      transferId: requireIdentifier(input.transferId, "transferId"),
      projectId: requireIdentifier(input.projectId, "projectId"),
      objectId: requireIdentifier(input.objectId, "objectId"),
      versionId: requireIdentifier(input.versionId, "versionId"),
      chunks: Object.freeze(chunks),
    });
  }

  public plan(limit = 16): readonly CiphertextChunkManifestEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new SyncCoreError(
        "SYNC_VALIDATION_FAILED",
        "Transfer plan limit must be between 1 and 256.",
      );
    }
    return this.manifest.chunks
      .filter(({ chunkId }) => !this.receipts.has(chunkId))
      .slice(0, limit)
      .map((chunk) => ({ ...chunk }));
  }

  public acknowledge(chunkIdValue: string, receiptValue: ChunkUploadReceipt): ChunkAcknowledgement {
    const chunkId = requireIdentifier(chunkIdValue, "chunkId");
    const chunk = this.manifest.chunks.find((candidate) => candidate.chunkId === chunkId);
    if (chunk === undefined) {
      throw new SyncCoreError("SYNC_TRANSFER_MISMATCH", "Chunk is not part of this transfer.");
    }
    const receipt: ChunkUploadReceipt = {
      ciphertextSha256: requireSha256(receiptValue.ciphertextSha256, "receipt.ciphertextSha256"),
      remoteETag: requireIdentifier(receiptValue.remoteETag, "receipt.remoteETag"),
    };
    if (receipt.ciphertextSha256 !== chunk.ciphertextSha256) {
      throw new SyncCoreError(
        "SYNC_TRANSFER_MISMATCH",
        "Remote receipt does not match the ciphertext manifest.",
      );
    }
    const existing = this.receipts.get(chunkId);
    if (existing !== undefined) {
      if (
        existing.ciphertextSha256 !== receipt.ciphertextSha256 ||
        existing.remoteETag !== receipt.remoteETag
      ) {
        throw new SyncCoreError(
          "SYNC_TRANSFER_MISMATCH",
          "An acknowledged chunk cannot be replaced by a different receipt.",
        );
      }
      return { chunkId, created: false };
    }
    this.receipts.set(chunkId, Object.freeze(receipt));
    return { chunkId, created: true };
  }

  public progress(): ChunkTransferProgress {
    const acknowledged = this.manifest.chunks.filter(({ chunkId }) => this.receipts.has(chunkId));
    return {
      totalChunks: this.manifest.chunks.length,
      acknowledgedChunks: acknowledged.length,
      totalBytes: this.manifest.chunks.reduce((total, chunk) => total + chunk.ciphertextBytes, 0),
      acknowledgedBytes: acknowledged.reduce((total, chunk) => total + chunk.ciphertextBytes, 0),
      complete: acknowledged.length === this.manifest.chunks.length,
    };
  }
}
