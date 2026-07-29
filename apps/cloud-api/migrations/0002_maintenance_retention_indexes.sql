-- Bounded retention workers need selective expiry and deleted-object lookups.
-- These indexes contain identifiers and timestamps only; no plaintext is added.

CREATE INDEX cloud_idempotency_records_expiry_idx
  ON cloud_idempotency_records (expires_at, scope_hash_sha256);

CREATE INDEX identity_challenges_retention_idx
  ON identity_challenges (expires_at, consumed_at, challenge_id);

CREATE INDEX cloud_sessions_refresh_retention_idx
  ON cloud_sessions (refresh_expires_at, session_id);

CREATE INDEX sync_tombstones_retention_idx
  ON sync_tombstones (
    tenant_id,
    retain_until,
    project_id,
    object_id,
    object_generation
  );

CREATE INDEX sync_operations_object_generation_idx
  ON sync_operations (
    tenant_id,
    project_id,
    object_id,
    object_generation,
    operation_id
  );

CREATE INDEX sync_ciphertext_chunks_object_idx
  ON sync_ciphertext_chunks (
    tenant_id,
    project_id,
    object_id,
    created_at,
    chunk_id
  );
