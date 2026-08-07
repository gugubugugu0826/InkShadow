PRAGMA foreign_keys = ON;

-- Expert connection metadata is deliberately separated from credentials.
-- Only the authentication mode and a single non-secret Header name live in
-- SQLite; the corresponding Header value remains in the operating-system
-- credential vault referenced by credential_ref.
ALTER TABLE model_provider_connections
  ADD COLUMN authentication_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (authentication_mode IN ('none', 'bearer_keyring', 'custom_header_keyring'));

ALTER TABLE model_provider_connections
  ADD COLUMN credential_header_name TEXT
    CHECK (credential_header_name IS NULL OR length(credential_header_name) BETWEEN 1 AND 128);

ALTER TABLE model_provider_connections
  ADD COLUMN model_discovery_path TEXT
    CHECK (model_discovery_path IS NULL OR length(model_discovery_path) BETWEEN 1 AND 1024);

ALTER TABLE model_provider_connections
  ADD COLUMN text_generation_path TEXT
    CHECK (text_generation_path IS NULL OR length(text_generation_path) BETWEEN 1 AND 1024);

ALTER TABLE model_provider_connections
  ADD COLUMN embedding_path TEXT
    CHECK (embedding_path IS NULL OR length(embedding_path) BETWEEN 1 AND 1024);

ALTER TABLE model_provider_connections
  ADD COLUMN request_timeout_ms INTEGER NOT NULL DEFAULT 30000
    CHECK (request_timeout_ms BETWEEN 1000 AND 600000);

ALTER TABLE model_provider_connections
  ADD COLUMN retry_limit INTEGER NOT NULL DEFAULT 0
    CHECK (retry_limit BETWEEN 0 AND 3);

-- Preserve the effective authentication behavior of all pre-migration rows.
UPDATE model_provider_connections
SET authentication_mode = CASE
  WHEN provider_kind IN (
    'openai',
    'deepseek',
    'alibaba_qwen',
    'volcengine_doubao',
    'google_gemini',
    'anthropic_claude'
  ) THEN 'bearer_keyring'
  WHEN credential_state = 'present' THEN 'bearer_keyring'
  ELSE 'none'
END;

-- An old cloud declaration without a verifiable vault credential remains
-- visible for repair, but is disabled so routing cannot dispatch through it.
UPDATE model_provider_connections
SET enabled = 0
WHERE provider_kind IN (
  'openai',
  'deepseek',
  'alibaba_qwen',
  'volcengine_doubao',
  'google_gemini',
  'anthropic_claude'
)
AND credential_state <> 'present';
