PRAGMA foreign_keys = ON;

-- Model-generated planning remains isolated from the authoritative outline.
-- The universal Model Hub ledger owns invocation metadata; this table stores
-- only the local, user-reviewable planning candidate and a provenance link.
CREATE TABLE IF NOT EXISTS story_planning_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  task TEXT NOT NULL
    CHECK (task IN ('outline_planning', 'scene_breakdown')),
  target_node_id TEXT NOT NULL,
  target_node_title TEXT NOT NULL
    CHECK (
      length(trim(target_node_title)) BETWEEN 1 AND 200
      AND instr(target_node_title, char(0)) = 0
    ),
  baseline_outline_revision INTEGER NOT NULL
    CHECK (baseline_outline_revision >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('review', 'accepted', 'rejected')),
  payload_json TEXT NOT NULL
    CHECK (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND length(payload_json) <= 100000
    ),
  editable_synopsis TEXT NOT NULL
    CHECK (
      length(trim(editable_synopsis)) BETWEEN 1 AND 20000
      AND instr(editable_synopsis, char(0)) = 0
    ),
  context_json TEXT NOT NULL
    CHECK (
      json_valid(context_json)
      AND json_type(context_json) = 'object'
      AND length(context_json) <= 100000
    ),
  invocation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL
    CHECK (
      provider_kind IN (
        'openai',
        'deepseek',
        'alibaba_qwen',
        'volcengine_doubao',
        'google_gemini',
        'anthropic_claude',
        'ollama',
        'custom_openai_compatible'
      )
    ),
  model_id TEXT NOT NULL
    CHECK (length(trim(model_id)) BETWEEN 1 AND 512),
  used_fallback INTEGER NOT NULL DEFAULT 0
    CHECK (used_fallback IN (0, 1)),
  accepted_outline_revision INTEGER
    CHECK (accepted_outline_revision IS NULL OR accepted_outline_revision >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  decided_at TEXT
    CHECK (
      decided_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at
    ),
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(target_node_id) BETWEEN 1 AND 128),
  CHECK (length(invocation_id) BETWEEN 1 AND 128),
  CHECK (length(connection_id) BETWEEN 1 AND 128),
  CHECK (length(catalog_entry_id) BETWEEN 1 AND 128),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'review') = (decided_at IS NULL)),
  CHECK ((status = 'accepted') = (accepted_outline_revision IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS story_planning_candidates_project_status_idx
  ON story_planning_candidates (project_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS story_planning_candidates_invocation_idx
  ON story_planning_candidates (invocation_id, id);
