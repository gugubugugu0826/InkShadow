import { SyncCoreError } from "./errors.js";
import { SYNC_OBJECT_TYPES, type SyncObjectType } from "./chunk-crypto.js";
import {
  decideIncomingMutation,
  normalizeVersionVector,
  type IncomingMutationDecision,
  type VersionVector,
} from "./version-vector.js";
import { requireIdentifier, requireIsoTimestamp, requirePositiveInteger } from "./validation.js";

export const SYNC_OPERATION_KINDS = ["upsert", "delete"] as const;
export type SyncOperationKind = (typeof SYNC_OPERATION_KINDS)[number];

export interface SyncOperationSnapshot {
  readonly operationId: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly kind: SyncOperationKind;
  readonly vector: VersionVector;
  readonly encryptedChunkIds: readonly string[];
  readonly createdAt: string;
}

export class SyncOperation {
  private constructor(private readonly snapshot: SyncOperationSnapshot) {
    Object.freeze(snapshot.encryptedChunkIds);
    Object.freeze(snapshot);
    Object.freeze(this);
  }

  public static create(input: SyncOperationSnapshot): SyncOperation {
    if (!SYNC_OPERATION_KINDS.includes(input.kind)) {
      throw new SyncCoreError("SYNC_VALIDATION_FAILED", "Sync operation kind is unsupported.");
    }
    if (!SYNC_OBJECT_TYPES.includes(input.objectType)) {
      throw new SyncCoreError("SYNC_VALIDATION_FAILED", "Sync object type is unsupported.");
    }
    const vector = normalizeVersionVector(input.vector);
    const deviceId = requireIdentifier(input.deviceId, "deviceId");
    const deviceSequence = requirePositiveInteger(input.deviceSequence, "deviceSequence");
    if (vector[deviceId] !== deviceSequence) {
      throw new SyncCoreError(
        "SYNC_SEQUENCE_MISMATCH",
        "The operation sequence must equal its device vector counter.",
      );
    }
    const chunks = input.encryptedChunkIds.map((chunkId) =>
      requireIdentifier(chunkId, "encryptedChunkId"),
    );
    if (new Set(chunks).size !== chunks.length || chunks.length > 10_000) {
      throw new SyncCoreError(
        "SYNC_VALIDATION_FAILED",
        "Encrypted chunk identifiers must be unique and bounded.",
      );
    }
    if (
      (input.kind === "upsert" && chunks.length === 0) ||
      (input.kind === "delete" && chunks.length !== 0)
    ) {
      throw new SyncCoreError(
        "SYNC_VALIDATION_FAILED",
        "Upserts require ciphertext chunks and deletes must not carry content.",
      );
    }

    return new SyncOperation({
      operationId: requireIdentifier(input.operationId, "operationId"),
      projectId: requireIdentifier(input.projectId, "projectId"),
      deviceId,
      deviceSequence,
      objectType: input.objectType,
      objectId: requireIdentifier(input.objectId, "objectId"),
      objectGeneration: requirePositiveInteger(input.objectGeneration, "objectGeneration"),
      kind: input.kind,
      vector,
      encryptedChunkIds: Object.freeze([...chunks]),
      createdAt: requireIsoTimestamp(input.createdAt, "createdAt"),
    });
  }

  public toSnapshot(): SyncOperationSnapshot {
    return {
      ...this.snapshot,
      vector: { ...this.snapshot.vector },
      encryptedChunkIds: [...this.snapshot.encryptedChunkIds],
    };
  }

  public decideAgainst(localVector: VersionVector): IncomingMutationDecision {
    return decideIncomingMutation(localVector, this.snapshot.vector);
  }
}
