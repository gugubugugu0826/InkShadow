-- Project-key lifecycle metadata and ciphertext envelopes.
--
-- Device private keys remain in the operating-system credential store.
-- Project DEKs and one-time recovery codes must never be persisted here.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS device_public_key_records (
  device_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(device_id) BETWEEN 1 AND 200),
  account_id TEXT
    REFERENCES cloud_account_snapshots(account_id) ON DELETE SET NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'DHKEM-P256-HKDF-SHA256'),
  public_key TEXT NOT NULL
    CHECK (
      length(public_key) = 87
      AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  public_key_fingerprint TEXT NOT NULL
    CHECK (
      length(public_key_fingerprint) = 64
      AND public_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  key_origin TEXT NOT NULL
    CHECK (key_origin IN ('local_os_credential', 'remote_registered')),
  state TEXT NOT NULL
    CHECK (state IN ('trusted', 'revoked', 'credential_missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (public_key_fingerprint),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state <> 'revoked' AND revoked_at IS NULL)
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
    AND (
      revoked_at IS NULL
      OR julianday(revoked_at) >= julianday(created_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS device_public_keys_account_state_idx
  ON device_public_key_records (account_id, state);

CREATE TABLE IF NOT EXISTS project_key_versions (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL
    CHECK (key_version BETWEEN 1 AND 2147483647),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  state TEXT NOT NULL
    CHECK (state IN ('pending_confirmation', 'active', 'retiring', 'retired')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (project_id, key_version),
  CHECK (
    (state = 'retired' AND retired_at IS NOT NULL)
    OR (state <> 'retired' AND retired_at IS NULL)
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND (
      retired_at IS NULL
      OR julianday(retired_at) >= julianday(created_at)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_key_versions_one_active_idx
  ON project_key_versions (project_id)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS project_device_key_envelopes (
  envelope_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(envelope_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  algorithm TEXT NOT NULL
    CHECK (algorithm = 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM'),
  sender_device_id TEXT NOT NULL
    REFERENCES device_public_key_records(device_id) ON DELETE RESTRICT,
  sender_public_key TEXT NOT NULL
    CHECK (
      length(sender_public_key) = 87
      AND sender_public_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  sender_public_key_fingerprint TEXT NOT NULL
    CHECK (
      length(sender_public_key_fingerprint) = 64
      AND sender_public_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  recipient_device_id TEXT NOT NULL
    REFERENCES device_public_key_records(device_id) ON DELETE RESTRICT,
  recipient_public_key TEXT NOT NULL
    CHECK (
      length(recipient_public_key) = 87
      AND recipient_public_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  recipient_public_key_fingerprint TEXT NOT NULL
    CHECK (
      length(recipient_public_key_fingerprint) = 64
      AND recipient_public_key_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  encapsulated_key TEXT NOT NULL
    CHECK (
      length(encapsulated_key) = 87
      AND encapsulated_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext TEXT NOT NULL
    CHECK (
      length(ciphertext) = 64
      AND ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (project_id, key_version)
    REFERENCES project_key_versions(project_id, key_version) ON DELETE CASCADE,
  CHECK (
    julianday(created_at) IS NOT NULL
    AND (
      revoked_at IS NULL
      OR julianday(revoked_at) >= julianday(created_at)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_device_envelopes_one_current_idx
  ON project_device_key_envelopes (project_id, key_version, recipient_device_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS project_device_envelopes_sender_idx
  ON project_device_key_envelopes (sender_device_id, created_at);

CREATE TABLE IF NOT EXISTS project_recovery_key_envelopes (
  recovery_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(recovery_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'ARGON2ID-AES256GCM'),
  kdf_algorithm TEXT NOT NULL CHECK (kdf_algorithm = 'ARGON2ID'),
  kdf_version INTEGER NOT NULL CHECK (kdf_version = 19),
  memory_kib INTEGER NOT NULL CHECK (memory_kib = 65536),
  time_cost INTEGER NOT NULL CHECK (time_cost = 3),
  parallelism INTEGER NOT NULL CHECK (parallelism = 4),
  output_bytes INTEGER NOT NULL CHECK (output_bytes = 64),
  salt TEXT NOT NULL
    CHECK (
      length(salt) = 22
      AND salt NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  nonce TEXT NOT NULL
    CHECK (
      length(nonce) = 16
      AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext TEXT NOT NULL
    CHECK (
      length(ciphertext) = 64
      AND ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  verifier TEXT NOT NULL
    CHECK (
      length(verifier) = 43
      AND verifier NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'confirmed', 'revoked')),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (project_id, key_version)
    REFERENCES project_key_versions(project_id, key_version) ON DELETE CASCADE,
  CHECK (
    (status = 'pending_confirmation' AND confirmed_at IS NULL AND revoked_at IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND (
      confirmed_at IS NULL
      OR julianday(confirmed_at) >= julianday(created_at)
    )
    AND (
      revoked_at IS NULL
      OR julianday(revoked_at) >= julianday(created_at)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_recovery_envelopes_one_current_idx
  ON project_recovery_key_envelopes (project_id, key_version)
  WHERE status <> 'revoked';
