import {
  IsoUtcTimestampSchema,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  SyncOperationContractSchema,
  SyncTombstoneContractSchema,
  UuidV7Schema,
  VersionVectorSchema,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { SyncCoreError, type VersionVector } from "@inkshadow/sync-core";

const MINIMUM_TOMBSTONE_RETENTION_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;

export type ContentTombstoneObjectType = "project_manifest" | "chapter_version";

export interface BuildOutgoingContentTombstoneInput {
  readonly projectId: string;
  readonly objectType: ContentTombstoneObjectType;
  readonly objectId: string;
  /**
   * Present content uses odd generations; its following tombstone uses the
   * immediately adjacent even generation.
   */
  readonly objectGeneration: number;
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly operationId: string;
  readonly vector: VersionVector;
  readonly deletedAt: string;
  readonly retainUntil: string;
}

export interface BuiltOutgoingContentTombstone {
  readonly operation: SyncOperationContract;
  readonly tombstone: SyncTombstoneContract;
}

/**
 * Builds the plaintext-free protocol-v2 delete pair persisted beside an
 * outgoing projection job. The operation and tombstone are validated together
 * so no caller can enqueue an unbound or shorter-lived deletion marker.
 */
export class OutgoingContentTombstoneBuilder {
  public build(input: BuildOutgoingContentTombstoneInput): BuiltOutgoingContentTombstone {
    const projectId = requireUuidV7(input.projectId, "projectId");
    const objectId = requireUuidV7(input.objectId, "objectId");
    const deviceId = requireUuidV7(input.deviceId, "deviceId");
    const operationId = requireUuidV7(input.operationId, "operationId");
    const objectGeneration = requirePositiveSafeInteger(input.objectGeneration, "objectGeneration");
    if (objectGeneration % 2 !== 0) {
      throw validationError("Content tombstones must use a positive even object generation.");
    }
    const deviceSequence = requirePositiveSafeInteger(input.deviceSequence, "deviceSequence");
    const vector = normalizeUuidVersionVector(input.vector);
    if (vector[deviceId] !== deviceSequence) {
      throw validationError("vector[deviceId] must equal deviceSequence.");
    }
    const deletedAt = requireCanonicalTimestamp(input.deletedAt, "deletedAt");
    const retainUntil = requireCanonicalTimestamp(input.retainUntil, "retainUntil");
    if (
      Date.parse(retainUntil) - Date.parse(deletedAt) <
      MINIMUM_TOMBSTONE_RETENTION_MILLISECONDS
    ) {
      throw validationError("Content tombstones must be retained for at least 365 days.");
    }

    const operation = parseOperation({
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      operationId,
      projectId,
      deviceId,
      deviceSequence,
      objectType: input.objectType,
      objectId,
      objectGeneration,
      kind: "delete",
      vector,
      encryptedChunkIds: [],
      createdAt: deletedAt,
    });
    const tombstone = parseTombstone({
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId,
      objectType: input.objectType,
      objectId,
      objectGeneration,
      deletedByDeviceId: deviceId,
      vector,
      deletedAt,
      retainUntil,
      acknowledgedDeviceIds: [],
    });

    return Object.freeze({
      operation: Object.freeze({ ...operation, vector: Object.freeze({ ...operation.vector }) }),
      tombstone: Object.freeze({
        ...tombstone,
        vector: Object.freeze({ ...tombstone.vector }),
        acknowledgedDeviceIds: [...tombstone.acknowledgedDeviceIds],
      }),
    });
  }
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireUuidV7(value: unknown, field: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be a bounded UUIDv7 identifier.`);
  }
  return parsed.data.toLowerCase();
}

function requireCanonicalTimestamp(value: unknown, field: string): string {
  const parsed = IsoUtcTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be an ISO UTC timestamp.`);
  }
  const milliseconds = Date.parse(parsed.data);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed.data) {
    throw validationError(`${field} must use the canonical ISO UTC representation.`);
  }
  return parsed.data;
}

function normalizeUuidVersionVector(value: VersionVector): VersionVector {
  const parsed = VersionVectorSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("vector must contain bounded UUIDv7 device counters.");
  }
  const normalized: Record<string, number> = {};
  for (const [deviceIdValue, counterValue] of Object.entries(parsed.data)) {
    const deviceId = requireUuidV7(deviceIdValue, "vector deviceId");
    if (Object.hasOwn(normalized, deviceId)) {
      throw validationError("vector must not contain case-aliased device identifiers.");
    }
    normalized[deviceId] = requirePositiveSafeInteger(counterValue, `vector[${deviceId}]`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function parseOperation(value: unknown): SyncOperationContract {
  const parsed = SyncOperationContractSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The outgoing content delete operation is invalid.");
  }
  return parsed.data;
}

function parseTombstone(value: unknown): SyncTombstoneContract {
  const parsed = SyncTombstoneContractSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The outgoing content tombstone is invalid.");
  }
  return parsed.data;
}

function validationError(message: string): SyncCoreError {
  return new SyncCoreError("SYNC_VALIDATION_FAILED", message);
}
