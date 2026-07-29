PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS model_profiles (
  provider_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL
    CHECK (provider IN ('open_ai_compatible', 'ollama')),
  base_url TEXT NOT NULL,
  authentication TEXT NOT NULL
    CHECK (authentication IN ('none', 'bearer_keyring')),
  selected_model TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(provider_id) BETWEEN 1 AND 128),
  CHECK (length(base_url) BETWEEN 1 AND 2048),
  CHECK (selected_model IS NULL OR length(selected_model) BETWEEN 1 AND 512)
);

CREATE INDEX IF NOT EXISTS model_profiles_updated_idx
  ON model_profiles (updated_at DESC, provider_id ASC);
