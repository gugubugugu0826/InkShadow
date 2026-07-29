-- Local persistence for ciphertext-only sync state and non-authoritative
-- cloud/access metadata. Project keys, bearer credentials, passwords, chapter
-- plaintext, and private signing material intentionally have no columns here.

CREATE TABLE IF NOT EXISTS sync_ciphertext_chunks (
  chunk_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(chunk_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    ),
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  version_id TEXT NOT NULL
    CHECK (length(version_id) BETWEEN 1 AND 200),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  nonce TEXT NOT NULL
    CHECK (
      length(nonce) = 16
      AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext TEXT NOT NULL
    CHECK (
      length(ciphertext) BETWEEN 22 AND 8000000
      AND ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext_sha256 TEXT NOT NULL
    CHECK (
      length(ciphertext_sha256) = 64
      AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  plaintext_bytes INTEGER NOT NULL
    CHECK (plaintext_bytes BETWEEN 0 AND 4194304),
  created_at TEXT NOT NULL,
  UNIQUE (
    project_id,
    object_type,
    object_id,
    version_id,
    chunk_index,
    key_version
  )
);

CREATE INDEX IF NOT EXISTS sync_ciphertext_chunks_object_idx
  ON sync_ciphertext_chunks (
    project_id,
    object_type,
    object_id,
    version_id,
    chunk_index
  );

CREATE TABLE IF NOT EXISTS sync_outbox_operations (
  operation_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(operation_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL
    CHECK (length(device_id) BETWEEN 1 AND 200),
  device_sequence INTEGER NOT NULL CHECK (device_sequence >= 1),
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  object_generation INTEGER NOT NULL CHECK (object_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  vector_json TEXT NOT NULL
    CHECK (
      json_valid(vector_json)
      AND json_type(vector_json) = 'object'
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'in_flight',
        'acknowledged',
        'failed',
        'paused'
      )
    ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  next_attempt_at TEXT,
  lease_owner_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  failure_code TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, device_id, device_sequence),
  CHECK (
    (
      status = 'in_flight'
      AND lease_owner_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND next_attempt_at IS NULL
      AND acknowledged_at IS NULL
    )
    OR (
      status IN ('queued', 'failed')
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NOT NULL
      AND acknowledged_at IS NULL
    )
    OR (
      status = 'paused'
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND acknowledged_at IS NULL
    )
    OR (
      status = 'acknowledged'
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND failure_code IS NULL
      AND acknowledged_at IS NOT NULL
    )
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
    AND (
      acknowledged_at IS NULL
      OR julianday(acknowledged_at) >= julianday(created_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS sync_outbox_runnable_idx
  ON sync_outbox_operations (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS sync_outbox_expired_lease_idx
  ON sync_outbox_operations (status, lease_expires_at)
  WHERE status = 'in_flight';

CREATE TABLE IF NOT EXISTS sync_operation_chunks (
  operation_id TEXT NOT NULL
    REFERENCES sync_outbox_operations(operation_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL
    REFERENCES sync_ciphertext_chunks(chunk_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (operation_id, chunk_id),
  UNIQUE (operation_id, position)
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  object_generation INTEGER NOT NULL CHECK (object_generation >= 1),
  deleted_by_device_id TEXT NOT NULL
    CHECK (length(deleted_by_device_id) BETWEEN 1 AND 200),
  vector_json TEXT NOT NULL
    CHECK (
      json_valid(vector_json)
      AND json_type(vector_json) = 'object'
    ),
  deleted_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  acknowledged_device_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(acknowledged_device_ids_json)
      AND json_type(acknowledged_device_ids_json) = 'array'
    ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, object_id, object_generation),
  CHECK (
    julianday(deleted_at) IS NOT NULL
    AND julianday(retain_until) IS NOT NULL
    AND julianday(retain_until) - julianday(deleted_at) >= 365
  )
);

CREATE INDEX IF NOT EXISTS sync_tombstones_retention_idx
  ON sync_tombstones (retain_until, project_id);

CREATE TABLE IF NOT EXISTS sync_transfers (
  transfer_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(transfer_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  version_id TEXT NOT NULL
    CHECK (length(version_id) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'paused', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
  )
);

CREATE INDEX IF NOT EXISTS sync_transfers_status_idx
  ON sync_transfers (status, updated_at);

CREATE TABLE IF NOT EXISTS sync_transfer_chunks (
  transfer_id TEXT NOT NULL
    REFERENCES sync_transfers(transfer_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL
    REFERENCES sync_ciphertext_chunks(chunk_id) ON DELETE RESTRICT,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes >= 1),
  ciphertext_sha256 TEXT NOT NULL
    CHECK (
      length(ciphertext_sha256) = 64
      AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  remote_etag TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY (transfer_id, chunk_id),
  UNIQUE (transfer_id, chunk_index),
  CHECK (
    (remote_etag IS NULL AND acknowledged_at IS NULL)
    OR (remote_etag IS NOT NULL AND acknowledged_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS cloud_account_snapshots (
  account_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(account_id) BETWEEN 1 AND 200),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  state TEXT NOT NULL
    CHECK (
      state IN (
        'pending_verification',
        'active',
        'locked',
        'frozen',
        'deletion_scheduled',
        'deleted'
      )
    ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  verified_at TEXT,
  deletion_scheduled_for TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'pending_verification' AND verified_at IS NULL)
    OR (state <> 'pending_verification' AND verified_at IS NOT NULL)
  ),
  CHECK (
    (state = 'deletion_scheduled' AND deletion_scheduled_for IS NOT NULL)
    OR (state <> 'deletion_scheduled' AND deletion_scheduled_for IS NULL)
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
    AND (
      verified_at IS NULL
      OR julianday(verified_at) >= julianday(created_at)
    )
  )
);

CREATE TABLE IF NOT EXISTS registered_device_snapshots (
  device_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(device_id) BETWEEN 1 AND 200),
  account_id TEXT NOT NULL
    REFERENCES cloud_account_snapshots(account_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  state TEXT NOT NULL CHECK (state IN ('trusted', 'revoked')),
  public_key_fingerprint TEXT NOT NULL
    CHECK (
      length(public_key_fingerprint) = 64
      AND public_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state = 'trusted' AND revoked_at IS NULL)
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND (
      revoked_at IS NULL
      OR julianday(revoked_at) >= julianday(created_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS registered_devices_account_idx
  ON registered_device_snapshots (account_id, state);

CREATE TABLE IF NOT EXISTS cloud_session_snapshots (
  session_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(session_id) BETWEEN 1 AND 200),
  account_id TEXT NOT NULL
    REFERENCES cloud_account_snapshots(account_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL
    REFERENCES registered_device_snapshots(device_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  client_version TEXT NOT NULL CHECK (length(client_version) BETWEEN 5 AND 64),
  minimum_client_version TEXT NOT NULL
    CHECK (length(minimum_client_version) BETWEEN 5 AND 64),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    julianday(issued_at) IS NOT NULL
    AND julianday(expires_at) > julianday(issued_at)
    AND (
      revoked_at IS NULL
      OR julianday(revoked_at) >= julianday(issued_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS cloud_sessions_account_device_idx
  ON cloud_session_snapshots (account_id, device_id, expires_at);

-- This is deliberately a non-authoritative display/offline hint. Loading it
-- always evaluates with evidence='unverified', so SQLite tampering cannot
-- unlock a remote capability.
CREATE TABLE IF NOT EXISTS entitlement_cache (
  account_id TEXT PRIMARY KEY NOT NULL
    REFERENCES cloud_account_snapshots(account_id) ON DELETE CASCADE,
  tier TEXT NOT NULL
    CHECK (tier IN ('community', 'pro', 'studio', 'enterprise')),
  subscription_state TEXT NOT NULL
    CHECK (
      subscription_state IN (
        'none',
        'trialing',
        'active',
        'past_due',
        'grace',
        'expired',
        'canceled',
        'refunded',
        'offline_expired'
      )
    ),
  granted_capabilities_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(granted_capabilities_json)
      AND json_type(granted_capabilities_json) = 'array'
    ),
  enabled_flags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(enabled_flags_json)
      AND json_type(enabled_flags_json) = 'array'
    ),
  observed_at TEXT NOT NULL
);

-- Signed envelopes are public, device-bound authorization evidence. They must
-- be parsed and cryptographically verified again after every load.
CREATE TABLE IF NOT EXISTS offline_license_envelopes (
  license_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(license_id) BETWEEN 1 AND 200),
  account_id TEXT NOT NULL
    REFERENCES cloud_account_snapshots(account_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL
    REFERENCES registered_device_snapshots(device_id) ON DELETE CASCADE,
  envelope_json TEXT NOT NULL
    CHECK (
      json_valid(envelope_json)
      AND json_type(envelope_json) = 'object'
    ),
  saved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS offline_licenses_account_device_idx
  ON offline_license_envelopes (account_id, device_id);

-- Team membership snapshots support offline display only. Every remote action
-- still requires server-side authorization and current cryptographic access.
CREATE TABLE IF NOT EXISTS team_membership_snapshots (
  membership_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(membership_id) BETWEEN 1 AND 200),
  account_id TEXT NOT NULL
    REFERENCES cloud_account_snapshots(account_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL
    CHECK (length(tenant_id) BETWEEN 1 AND 200),
  team_id TEXT NOT NULL
    CHECK (length(team_id) BETWEEN 1 AND 200),
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'admin', 'author', 'reviewer', 'read_only', 'finance_admin')),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  project_ids_json TEXT
    CHECK (
      project_ids_json IS NULL
      OR (
        json_valid(project_ids_json)
        AND json_type(project_ids_json) = 'array'
      )
    ),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state = 'active' AND revoked_at IS NULL)
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND (
      revoked_at IS NULL
      OR julianday(revoked_at) >= julianday(created_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS team_memberships_scope_idx
  ON team_membership_snapshots (account_id, tenant_id, team_id, state);
