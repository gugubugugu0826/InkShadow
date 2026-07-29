-- Non-secret authority metadata for team-managed project-key receipts.
--
-- The canonical encrypted team envelope is stored only in the operating-system
-- credential store. This table must never contain envelope ciphertext,
-- encapsulated keys, project DEKs, private keys, recovery codes, or recovery
-- envelopes.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_project_key_receipts (
  native_storage_ref TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(native_storage_ref) = 92
      AND native_storage_ref GLOB 'team_project_key_receipt_v1_[0-9a-f]*'
      AND substr(native_storage_ref, 29) NOT GLOB '*[^0-9a-f]*'
    ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  receipt_kind TEXT NOT NULL CHECK (receipt_kind = 'team_managed_device_envelope'),
  team_id TEXT NOT NULL CHECK (length(team_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 2147483647),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  device_id TEXT NOT NULL CHECK (length(device_id) = 36),
  envelope_id TEXT NOT NULL CHECK (length(envelope_id) = 36),
  membership_id TEXT NOT NULL CHECK (length(membership_id) = 36),
  membership_revision INTEGER NOT NULL
    CHECK (membership_revision BETWEEN 1 AND 9007199254740991),
  assignment_id TEXT NOT NULL CHECK (length(assignment_id) = 36),
  assignment_revision INTEGER NOT NULL
    CHECK (assignment_revision BETWEEN 1 AND 9007199254740991),
  sender_device_id TEXT NOT NULL CHECK (length(sender_device_id) = 36),
  sender_public_key_fingerprint TEXT NOT NULL
    CHECK (
      length(sender_public_key_fingerprint) = 64
      AND sender_public_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  recipient_public_key_fingerprint TEXT NOT NULL
    CHECK (
      length(recipient_public_key_fingerprint) = 64
      AND recipient_public_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  project_key_fingerprint TEXT NOT NULL
    CHECK (
      length(project_key_fingerprint) = 64
      AND project_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  native_receipt_fingerprint TEXT NOT NULL
    CHECK (
      length(native_receipt_fingerprint) = 64
      AND native_receipt_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  current_server_revision INTEGER NOT NULL
    CHECK (current_server_revision BETWEEN 1 AND 9007199254740991),
  current_key_updated_at TEXT NOT NULL,
  envelope_created_at TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('active', 'superseded', 'authority_unavailable', 'credential_missing')),
  received_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  state_updated_at TEXT NOT NULL,
  UNIQUE (team_id, project_id, key_version, account_id, device_id),
  CHECK (
    julianday(current_key_updated_at) IS NOT NULL
    AND julianday(envelope_created_at) IS NOT NULL
    AND julianday(received_at) IS NOT NULL
    AND julianday(last_verified_at) >= julianday(received_at)
    AND julianday(state_updated_at) >= julianday(received_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS team_project_key_receipts_one_active_idx
  ON team_project_key_receipts (team_id, project_id, account_id, device_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS team_project_key_receipts_lookup_idx
  ON team_project_key_receipts (
    project_id,
    account_id,
    device_id,
    key_version DESC
  );
