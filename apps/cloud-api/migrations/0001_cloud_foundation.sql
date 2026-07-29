-- InkShadow cloud identity, session, device, project-key and ciphertext-sync foundation.
-- Creative plaintext, private keys, recovery codes and bearer-token values are intentionally absent.

CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE cloud_accounts (
  account_id UUID PRIMARY KEY,
  email_canonical TEXT NOT NULL UNIQUE
    CHECK (
      email_canonical = lower(btrim(email_canonical))
      AND length(email_canonical) BETWEEN 3 AND 320
      AND email_canonical ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    ),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 32 AND 1024),
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
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count BETWEEN 0 AND 20),
  last_failed_login_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  deletion_scheduled_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK ((state = 'pending_verification') = (verified_at IS NULL)),
  CHECK ((state = 'deletion_scheduled') = (deletion_scheduled_for IS NOT NULL)),
  CHECK ((state = 'locked') = (locked_until IS NOT NULL)),
  CHECK (
    last_failed_login_at IS NULL
    OR last_failed_login_at >= created_at
  ),
  CHECK (locked_until IS NULL OR locked_until > created_at)
);

CREATE TABLE identity_challenges (
  challenge_id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'password_reset')),
  email_canonical TEXT NOT NULL
    CHECK (
      email_canonical = lower(btrim(email_canonical))
      AND length(email_canonical) BETWEEN 3 AND 320
    ),
  account_id UUID REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
  pending_password_hash TEXT CHECK (
    pending_password_hash IS NULL
    OR length(pending_password_hash) BETWEEN 32 AND 1024
  ),
  code_hash_sha256 CHAR(64) NOT NULL CHECK (code_hash_sha256 ~ '^[a-f0-9]{64}$'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  notification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (notification_attempts BETWEEN 0 AND 20),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (notified_at IS NULL OR notified_at >= created_at),
  CHECK (
    (kind = 'registration' AND pending_password_hash IS NOT NULL)
    OR (kind = 'password_reset' AND pending_password_hash IS NULL)
  )
);

CREATE INDEX identity_challenges_email_kind_idx
  ON identity_challenges (email_canonical, kind, created_at DESC);

CREATE TABLE registered_devices (
  device_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  algorithm TEXT NOT NULL CHECK (algorithm = 'DHKEM-P256-HKDF-SHA256'),
  public_key CHAR(87) NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  public_key_fingerprint CHAR(64) NOT NULL
    CHECK (public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  client_version TEXT NOT NULL
    CHECK (client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  state TEXT NOT NULL CHECK (state IN ('trusted', 'revoked')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (account_id, public_key_fingerprint),
  CHECK (updated_at >= created_at),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX registered_devices_account_state_idx
  ON registered_devices (account_id, state, created_at DESC);

CREATE TABLE cloud_sessions (
  session_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES registered_devices(device_id) ON DELETE CASCADE,
  client_version TEXT NOT NULL
    CHECK (client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  minimum_client_version TEXT NOT NULL
    CHECK (minimum_client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  access_token_hash_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (access_token_hash_sha256 ~ '^[a-f0-9]{64}$'),
  refresh_token_hash_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (refresh_token_hash_sha256 ~ '^[a-f0-9]{64}$'),
  refresh_generation INTEGER NOT NULL DEFAULT 1 CHECK (refresh_generation > 0),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_session_id UUID REFERENCES cloud_sessions(session_id) ON DELETE SET NULL,
  CHECK (expires_at > issued_at),
  CHECK (refresh_expires_at > expires_at),
  CHECK (last_seen_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (replaced_by_session_id IS NULL OR revoked_at IS NOT NULL)
);

CREATE INDEX cloud_sessions_account_device_idx
  ON cloud_sessions (account_id, device_id, issued_at DESC);

CREATE INDEX cloud_sessions_active_expiry_idx
  ON cloud_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE cloud_projects (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  owner_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('active', 'deletion_scheduled', 'deleted')),
  current_key_version INTEGER CHECK (current_key_version IS NULL OR current_key_version > 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deletion_scheduled_for TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, project_id),
  UNIQUE (project_id),
  CHECK (updated_at >= created_at),
  CHECK ((state = 'deletion_scheduled') = (deletion_scheduled_for IS NOT NULL))
);

CREATE TABLE cloud_project_access (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'author', 'reviewer', 'read_only')),
  can_manage_keys BOOLEAN NOT NULL,
  can_sync BOOLEAN NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, project_id, account_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE project_key_versions (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  server_revision BIGINT NOT NULL CHECK (server_revision > 0),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  client_revision BIGINT NOT NULL CHECK (client_revision > 0),
  recovery_id UUID NOT NULL UNIQUE,
  recovery_algorithm TEXT NOT NULL CHECK (recovery_algorithm = 'ARGON2ID-AES256GCM'),
  recovery_salt CHAR(22) NOT NULL CHECK (recovery_salt ~ '^[A-Za-z0-9_-]{22}$'),
  recovery_nonce CHAR(16) NOT NULL CHECK (recovery_nonce ~ '^[A-Za-z0-9_-]{16}$'),
  recovery_ciphertext CHAR(64) NOT NULL CHECK (
    recovery_ciphertext ~ '^[A-Za-z0-9_-]{64}$'
  ),
  recovery_verifier CHAR(43) NOT NULL CHECK (recovery_verifier ~ '^[A-Za-z0-9_-]{43}$'),
  recovery_created_at TIMESTAMPTZ NOT NULL,
  recovery_confirmed_at TIMESTAMPTZ NOT NULL,
  recovery_revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, project_id, key_version),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at),
  CHECK (recovery_confirmed_at >= recovery_created_at),
  CHECK (
    recovery_revoked_at IS NULL
    OR recovery_revoked_at >= recovery_created_at
  ),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX project_key_versions_one_active_idx
  ON project_key_versions (tenant_id, project_id)
  WHERE state = 'active';

CREATE TABLE device_project_key_envelopes (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  key_version INTEGER NOT NULL,
  envelope_id UUID NOT NULL UNIQUE,
  algorithm TEXT NOT NULL
    CHECK (algorithm = 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM'),
  sender_device_id UUID NOT NULL REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  sender_public_key CHAR(87) NOT NULL CHECK (sender_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  sender_public_key_fingerprint CHAR(64) NOT NULL
    CHECK (sender_public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  recipient_device_id UUID NOT NULL REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  recipient_public_key CHAR(87) NOT NULL CHECK (recipient_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  recipient_public_key_fingerprint CHAR(64) NOT NULL
    CHECK (recipient_public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  encapsulated_key CHAR(87) NOT NULL CHECK (encapsulated_key ~ '^[A-Za-z0-9_-]{87}$'),
  ciphertext CHAR(64) NOT NULL CHECK (ciphertext ~ '^[A-Za-z0-9_-]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, project_id, key_version, recipient_device_id),
  FOREIGN KEY (tenant_id, project_id, key_version)
    REFERENCES project_key_versions(tenant_id, project_id, key_version) ON DELETE CASCADE,
  CHECK (sender_device_id <> recipient_device_id OR sender_public_key = recipient_public_key),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE sync_operations (
  remote_sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  operation_id UUID NOT NULL UNIQUE,
  device_id UUID NOT NULL REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  device_sequence BIGINT NOT NULL CHECK (device_sequence > 0),
  object_id UUID NOT NULL,
  object_generation INTEGER NOT NULL CHECK (object_generation > 0),
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  version_vector JSONB NOT NULL CHECK (jsonb_typeof(version_vector) = 'object'),
  encrypted_chunk_ids UUID[] NOT NULL CHECK (cardinality(encrypted_chunk_ids) <= 10000),
  created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, project_id, device_id, device_sequence),
  CHECK (
    (kind = 'upsert' AND cardinality(encrypted_chunk_ids) > 0)
    OR (kind = 'delete' AND cardinality(encrypted_chunk_ids) = 0)
  )
);

CREATE INDEX sync_operations_project_cursor_idx
  ON sync_operations (tenant_id, project_id, remote_sequence);

CREATE TABLE sync_ciphertext_chunks (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  chunk_id UUID NOT NULL,
  operation_id UUID NOT NULL REFERENCES sync_operations(operation_id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  nonce CHAR(16) NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext TEXT NOT NULL
    CHECK (length(ciphertext) BETWEEN 1 AND 8000000)
    CHECK (ciphertext ~ '^[A-Za-z0-9_-]+$'),
  ciphertext_sha256 CHAR(64) NOT NULL CHECK (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes BETWEEN 0 AND 4194304),
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
  object_id UUID NOT NULL,
  version_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, chunk_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id, key_version)
    REFERENCES project_key_versions(tenant_id, project_id, key_version) ON DELETE RESTRICT,
  UNIQUE (tenant_id, project_id, operation_id, chunk_index)
);

CREATE TABLE sync_tombstones (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  object_id UUID NOT NULL,
  object_generation INTEGER NOT NULL CHECK (object_generation > 0),
  operation_id UUID NOT NULL UNIQUE REFERENCES sync_operations(operation_id) ON DELETE CASCADE,
  deleted_by_device_id UUID NOT NULL
    REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  version_vector JSONB NOT NULL CHECK (jsonb_typeof(version_vector) = 'object'),
  deleted_at TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, object_id, object_generation),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE,
  CHECK (retain_until >= deleted_at + INTERVAL '365 days')
);

CREATE TABLE sync_tombstone_acknowledgements (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  object_id UUID NOT NULL,
  object_generation INTEGER NOT NULL,
  device_id UUID NOT NULL REFERENCES registered_devices(device_id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (
    tenant_id,
    project_id,
    object_id,
    object_generation,
    device_id
  ),
  FOREIGN KEY (tenant_id, project_id, object_id, object_generation)
    REFERENCES sync_tombstones(
      tenant_id,
      project_id,
      object_id,
      object_generation
    ) ON DELETE CASCADE
);

CREATE TABLE cloud_sync_batches (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  accepted_operations JSONB NOT NULL
    CHECK (jsonb_typeof(accepted_operations) = 'array')
    CHECK (jsonb_array_length(accepted_operations) BETWEEN 1 AND 256),
  remote_sequence BIGINT NOT NULL CHECK (remote_sequence >= 0),
  server_time TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, project_id, batch_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE
);

CREATE INDEX cloud_sync_batches_project_time_idx
  ON cloud_sync_batches (tenant_id, project_id, server_time DESC);

CREATE TABLE cloud_rate_limit_windows (
  key_hash_sha256 CHAR(64) PRIMARY KEY
    CHECK (key_hash_sha256 ~ '^[a-f0-9]{64}$'),
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 1000001),
  window_started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > window_started_at)
);

CREATE INDEX cloud_rate_limit_windows_expiry_idx
  ON cloud_rate_limit_windows (expires_at);

CREATE TABLE cloud_idempotency_records (
  scope_hash_sha256 CHAR(64) PRIMARY KEY CHECK (scope_hash_sha256 ~ '^[a-f0-9]{64}$'),
  actor_account_id UUID REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 100),
  idempotency_key_hash_sha256 CHAR(64) NOT NULL
    CHECK (idempotency_key_hash_sha256 ~ '^[a-f0-9]{64}$'),
  request_hash_sha256 CHAR(64) NOT NULL CHECK (request_hash_sha256 ~ '^[a-f0-9]{64}$'),
  result_kind TEXT NOT NULL CHECK (
    result_kind IN ('challenge', 'session', 'device', 'project_key', 'sync_batch', 'accepted')
  ),
  result_resource_id UUID,
  result_digest_sha256 CHAR(64) NOT NULL CHECK (result_digest_sha256 ~ '^[a-f0-9]{64}$'),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  UNIQUE (actor_account_id, operation_id, idempotency_key_hash_sha256)
);

CREATE TABLE cloud_audit_events (
  event_id UUID PRIMARY KEY,
  request_id UUID NOT NULL,
  actor_account_id UUID REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
  actor_device_id UUID REFERENCES registered_devices(device_id) ON DELETE SET NULL,
  tenant_id UUID,
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 100),
  resource_id UUID,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'failed')),
  redacted_diff JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(redacted_diff) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX cloud_audit_tenant_created_idx
  ON cloud_audit_events (tenant_id, created_at DESC);

CREATE FUNCTION reject_cloud_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_audit_events_append_only
BEFORE UPDATE OR DELETE ON cloud_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_cloud_audit_mutation();

CREATE FUNCTION inkshadow_current_tenant()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('inkshadow.tenant_id', true), '')::uuid
$$;

ALTER TABLE cloud_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_project_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_key_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_project_key_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_ciphertext_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_tombstone_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_sync_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_project_access FORCE ROW LEVEL SECURITY;
ALTER TABLE project_key_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE device_project_key_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_ciphertext_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_tombstone_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_sync_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_projects_tenant_isolation ON cloud_projects
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY cloud_project_access_tenant_isolation ON cloud_project_access
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY project_key_versions_tenant_isolation ON project_key_versions
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY device_project_key_envelopes_tenant_isolation ON device_project_key_envelopes
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY sync_operations_tenant_isolation ON sync_operations
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY sync_ciphertext_chunks_tenant_isolation ON sync_ciphertext_chunks
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY sync_tombstones_tenant_isolation ON sync_tombstones
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY sync_tombstone_ack_tenant_isolation ON sync_tombstone_acknowledgements
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY cloud_sync_batches_tenant_isolation ON cloud_sync_batches
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
