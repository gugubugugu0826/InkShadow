-- zhipu_glm was added to the TypeScript Provider Registry after the original
-- Model Hub table was released. SQLite cannot ALTER an existing CHECK
-- constraint, so rebuild only the connection parent table while preserving
-- every published column and all child-table foreign-key references.
--
-- The native migration runner disables foreign_keys immediately before SQLx
-- starts this migration's transaction, then reenables and checks them before
-- later migrations run. The PRAGMAs below preserve the same behavior for the
-- standalone Node SQLite migration harness.

PRAGMA foreign_keys = OFF;

CREATE TEMP TABLE _inkshadow_0046_connection_count (
  before_count INTEGER NOT NULL
);

INSERT INTO _inkshadow_0046_connection_count (before_count)
SELECT COUNT(*)
FROM model_provider_connections;

CREATE TABLE model_provider_connections_0046_new (
  id TEXT PRIMARY KEY NOT NULL,
  provider_kind TEXT NOT NULL
    CHECK (
      provider_kind IN (
        'openai',
        'deepseek',
        'alibaba_qwen',
        'volcengine_doubao',
        'google_gemini',
        'anthropic_claude',
        'zhipu_glm',
        'ollama',
        'custom_openai_compatible'
      )
    ),
  display_name TEXT NOT NULL,
  protocol TEXT NOT NULL
    CHECK (protocol IN ('openai_compatible', 'anthropic', 'gemini', 'ollama')),
  region TEXT,
  workspace_id TEXT,
  endpoint_id TEXT,
  base_url TEXT NOT NULL,
  credential_ref TEXT,
  credential_state TEXT NOT NULL DEFAULT 'missing'
    CHECK (credential_state IN ('missing', 'present', 'unavailable')),
  connection_status TEXT NOT NULL DEFAULT 'not_tested'
    CHECK (
      connection_status IN (
        'not_tested',
        'checking',
        'ready',
        'degraded',
        'error',
        'disabled'
      )
    ),
  catalog_sync_status TEXT NOT NULL DEFAULT 'never'
    CHECK (
      catalog_sync_status IN (
        'never',
        'syncing',
        'succeeded',
        'partial',
        'failed'
      )
    ),
  last_tested_at TEXT,
  last_catalog_synced_at TEXT,
  last_error_code TEXT,
  last_error_summary TEXT,
  legacy_provider_id TEXT UNIQUE
    REFERENCES model_profiles(provider_id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  authentication_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (authentication_mode IN ('none', 'bearer_keyring', 'custom_header_keyring')),
  credential_header_name TEXT
    CHECK (credential_header_name IS NULL OR length(credential_header_name) BETWEEN 1 AND 128),
  model_discovery_path TEXT
    CHECK (model_discovery_path IS NULL OR length(model_discovery_path) BETWEEN 1 AND 1024),
  text_generation_path TEXT
    CHECK (text_generation_path IS NULL OR length(text_generation_path) BETWEEN 1 AND 1024),
  embedding_path TEXT
    CHECK (embedding_path IS NULL OR length(embedding_path) BETWEEN 1 AND 1024),
  request_timeout_ms INTEGER NOT NULL DEFAULT 30000
    CHECK (request_timeout_ms BETWEEN 1000 AND 600000),
  retry_limit INTEGER NOT NULL DEFAULT 0
    CHECK (retry_limit BETWEEN 0 AND 3),
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(display_name) BETWEEN 1 AND 160),
  CHECK (length(base_url) BETWEEN 1 AND 2048),
  CHECK (region IS NULL OR length(region) BETWEEN 1 AND 128),
  CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 256),
  CHECK (endpoint_id IS NULL OR length(endpoint_id) BETWEEN 1 AND 512),
  CHECK (credential_ref IS NULL OR length(credential_ref) BETWEEN 1 AND 256),
  CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
  CHECK (last_error_summary IS NULL OR length(last_error_summary) BETWEEN 1 AND 1000),
  CHECK (credential_ref IS NOT NULL OR credential_state <> 'present')
);

INSERT INTO model_provider_connections_0046_new (
  id,
  provider_kind,
  display_name,
  protocol,
  region,
  workspace_id,
  endpoint_id,
  base_url,
  credential_ref,
  credential_state,
  connection_status,
  catalog_sync_status,
  last_tested_at,
  last_catalog_synced_at,
  last_error_code,
  last_error_summary,
  legacy_provider_id,
  enabled,
  revision,
  created_at,
  updated_at,
  authentication_mode,
  credential_header_name,
  model_discovery_path,
  text_generation_path,
  embedding_path,
  request_timeout_ms,
  retry_limit
)
SELECT
  id,
  provider_kind,
  display_name,
  protocol,
  region,
  workspace_id,
  endpoint_id,
  base_url,
  credential_ref,
  credential_state,
  connection_status,
  catalog_sync_status,
  last_tested_at,
  last_catalog_synced_at,
  last_error_code,
  last_error_summary,
  legacy_provider_id,
  enabled,
  revision,
  created_at,
  updated_at,
  authentication_mode,
  credential_header_name,
  model_discovery_path,
  text_generation_path,
  embedding_path,
  request_timeout_ms,
  retry_limit
FROM model_provider_connections;

CREATE TEMP TABLE _inkshadow_0046_connection_count_guard (
  before_count INTEGER NOT NULL,
  after_count INTEGER NOT NULL,
  CHECK (before_count = after_count)
);

INSERT INTO _inkshadow_0046_connection_count_guard (before_count, after_count)
SELECT before_count, (SELECT COUNT(*) FROM model_provider_connections_0046_new)
FROM _inkshadow_0046_connection_count;

-- Exercise the new constraint before replacing the published table name.
INSERT INTO model_provider_connections_0046_new (
  id,
  provider_kind,
  display_name,
  protocol,
  base_url,
  created_at,
  updated_at
) VALUES (
  '__inkshadow_migration_0046_zhipu_glm_probe__',
  'zhipu_glm',
  'Migration constraint probe',
  'openai_compatible',
  'https://open.bigmodel.cn/api/paas/v4',
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z'
);

DELETE FROM model_provider_connections_0046_new
WHERE id = '__inkshadow_migration_0046_zhipu_glm_probe__';

DROP TABLE model_provider_connections;
ALTER TABLE model_provider_connections_0046_new
  RENAME TO model_provider_connections;

CREATE INDEX model_provider_connections_status_idx
  ON model_provider_connections (enabled DESC, connection_status, updated_at DESC, id ASC);

CREATE INDEX model_provider_connections_provider_idx
  ON model_provider_connections (provider_kind, updated_at DESC, id ASC);

DROP TABLE _inkshadow_0046_connection_count_guard;
DROP TABLE _inkshadow_0046_connection_count;

PRAGMA foreign_keys = ON;
