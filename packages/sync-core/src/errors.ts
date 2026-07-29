export const SYNC_CORE_ERROR_CODES = [
  "SYNC_VALIDATION_FAILED",
  "SYNC_VECTOR_INVALID",
  "SYNC_SEQUENCE_MISMATCH",
  "SYNC_CAUSAL_CONFLICT",
  "SYNC_CHUNK_TOO_LARGE",
  "SYNC_CHUNK_METADATA_MISMATCH",
  "SYNC_CHUNK_INTEGRITY_FAILED",
  "SYNC_KEY_INVALID",
  "SYNC_TOMBSTONE_NOT_OBSERVED",
  "SYNC_TRANSFER_MISMATCH",
] as const;

export type SyncCoreErrorCode = (typeof SYNC_CORE_ERROR_CODES)[number];

export class SyncCoreError extends Error {
  public override readonly name = "SyncCoreError";

  public constructor(
    public readonly code: SyncCoreErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
