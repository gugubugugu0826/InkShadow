PRAGMA foreign_keys = ON;

-- One global, user-controlled writing experience. The row is deliberately
-- created on first authoritative read rather than by this migration so an
-- upgraded database can be conservatively inferred as professional mode.
CREATE TABLE IF NOT EXISTS writing_experience_preferences (
  scope TEXT PRIMARY KEY NOT NULL CHECK (scope = 'global'),
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'professional')),
  initialization_source TEXT NOT NULL
    CHECK (initialization_source IN ('new_install', 'upgrade_existing', 'user')),
  direct_local_organization_authorized_at TEXT,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  CHECK (updated_at >= created_at),
  CHECK (
    direct_local_organization_authorized_at IS NULL
    OR length(direct_local_organization_authorized_at) BETWEEN 1 AND 64
  )
);

-- A disclosure grant is content-free dispatch authority for one bounded
-- continuation contract. The caller-owned SHA-256 fingerprint binds all of the
-- safe metadata below; no prompt, chapter body, credential or endpoint can be
-- represented by this schema.
CREATE TABLE IF NOT EXISTS writing_provider_disclosure_grants (
  fingerprint TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(fingerprint) = 64
      AND fingerprint = lower(fingerprint)
      AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  task TEXT NOT NULL CHECK (task = 'continuation'),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 512),
  sent_scope TEXT NOT NULL
    CHECK (
      sent_scope IN (
        'chapter_text',
        'selected_context_only',
        'chapter_and_selected_context'
      )
    ),
  sent_scope_hash TEXT NOT NULL
    CHECK (
      length(sent_scope_hash) = 64
      AND sent_scope_hash = lower(sent_scope_hash)
      AND sent_scope_hash NOT GLOB '*[^0-9a-f]*'
    ),
  call_count INTEGER NOT NULL CHECK (call_count BETWEEN 1 AND 3),
  retry_limit INTEGER NOT NULL CHECK (retry_limit BETWEEN 0 AND 3),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('estimated', 'unknown')),
  estimated_cost_micros TEXT,
  currency TEXT,
  privacy_policy TEXT NOT NULL CHECK (privacy_policy = 'cloud_allowed'),
  state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  consumed_at TEXT,
  revoked_at TEXT,
  CHECK (updated_at >= created_at),
  CHECK (
    (cost_status = 'unknown' AND estimated_cost_micros IS NULL AND currency IS NULL)
    OR (
      cost_status = 'estimated'
      AND estimated_cost_micros IS NOT NULL
      AND length(estimated_cost_micros) BETWEEN 1 AND 19
      AND estimated_cost_micros NOT GLOB '*[^0-9]*'
      AND currency IS NOT NULL
      AND length(currency) = 3
      AND currency = upper(currency)
    )
  ),
  CHECK (
    (state = 'active' AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND consumed_at IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS writing_provider_disclosure_grants_state_updated_idx
  ON writing_provider_disclosure_grants (state, updated_at, fingerprint);

CREATE TRIGGER IF NOT EXISTS writing_experience_preferences_update_guard
BEFORE UPDATE ON writing_experience_preferences
WHEN NEW.scope <> OLD.scope
  OR NEW.created_at <> OLD.created_at
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'WRITING_EXPERIENCE_REVISION_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS writing_provider_disclosure_grants_limit
BEFORE INSERT ON writing_provider_disclosure_grants
WHEN (SELECT COUNT(*) FROM writing_provider_disclosure_grants) >= 128
BEGIN
  SELECT RAISE(ABORT, 'WRITING_DISCLOSURE_GRANT_LIMIT_REACHED');
END;

CREATE TRIGGER IF NOT EXISTS writing_provider_disclosure_grants_update_guard
BEFORE UPDATE ON writing_provider_disclosure_grants
WHEN NEW.fingerprint <> OLD.fingerprint
  OR NEW.task <> OLD.task
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.model_id <> OLD.model_id
  OR NEW.sent_scope <> OLD.sent_scope
  OR NEW.sent_scope_hash <> OLD.sent_scope_hash
  OR NEW.call_count <> OLD.call_count
  OR NEW.retry_limit <> OLD.retry_limit
  OR NEW.cost_status <> OLD.cost_status
  OR NEW.estimated_cost_micros IS NOT OLD.estimated_cost_micros
  OR NEW.currency IS NOT OLD.currency
  OR NEW.privacy_policy <> OLD.privacy_policy
  OR OLD.state <> 'active'
  OR NEW.state NOT IN ('consumed', 'revoked')
  OR NEW.revision <> OLD.revision + 1
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT');
END;
