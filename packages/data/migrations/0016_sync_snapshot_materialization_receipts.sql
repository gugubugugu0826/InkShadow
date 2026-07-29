-- Durable, plaintext-free evidence that a committed bootstrap snapshot
-- operation has been materialized into the local business database.
--
-- The receipt intentionally binds only immutable transport identity.  It must
-- never contain decrypted titles, chapter content, prompts, model output, or
-- project keys.  Deleting the staging session removes its ciphertext and every
-- receipt through the composite operation foreign key.

CREATE TABLE IF NOT EXISTS sync_snapshot_materialization_receipts (
  snapshot_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL
    CHECK (
      length(operation_fingerprint) = 64
      AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('applied', 'skipped', 'conflict')),
  conflict_code TEXT
    CHECK (
      conflict_code IS NULL
      OR (
        length(conflict_code) BETWEEN 1 AND 120
        AND trim(conflict_code) = conflict_code
        AND conflict_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
      )
    ),
  resolved_at TEXT NOT NULL
    CHECK (julianday(resolved_at) IS NOT NULL),
  PRIMARY KEY (snapshot_id, operation_id),
  FOREIGN KEY (snapshot_id, operation_id)
    REFERENCES sync_snapshot_staging_operations(snapshot_id, operation_id)
    ON DELETE CASCADE,
  CHECK (
    (outcome = 'conflict' AND conflict_code IS NOT NULL)
    OR (outcome IN ('applied', 'skipped') AND conflict_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sync_snapshot_materialization_receipts_progress_idx
  ON sync_snapshot_materialization_receipts (snapshot_id, outcome, operation_id);
