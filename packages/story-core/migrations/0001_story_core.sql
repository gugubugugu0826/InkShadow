PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS story_outlines (
  project_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
);

CREATE TABLE IF NOT EXISTS story_formal_records (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('character', 'world_rule', 'foreshadow', 'timeline_event')),
  record_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  CHECK (revision = current_version),
  UNIQUE (project_id, kind, record_key)
);

CREATE INDEX IF NOT EXISTS story_formal_records_project_kind_idx
  ON story_formal_records (project_id, kind, updated_at, id);

CREATE TABLE IF NOT EXISTS story_timeline_state (
  project_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 2)
);

CREATE TABLE IF NOT EXISTS story_review_items (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('extraction', 'consistency')),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'modified', 'rejected', 'deferred')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  target_record_id TEXT NOT NULL,
  source_chapter_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  deferred_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  CHECK (
    (status = 'deferred' AND deferred_until IS NOT NULL)
    OR (status <> 'deferred' AND deferred_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS story_review_items_project_status_idx
  ON story_review_items (project_id, item_type, status, updated_at, id);

CREATE INDEX IF NOT EXISTS story_review_items_due_idx
  ON story_review_items (deferred_until, item_type, id)
  WHERE status = 'deferred';

CREATE TABLE IF NOT EXISTS story_memory_policies (
  project_id TEXT PRIMARY KEY NOT NULL,
  automatic_learning_enabled INTEGER NOT NULL
    CHECK (automatic_learning_enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
);

CREATE TABLE IF NOT EXISTS story_memory_records (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('L1', 'L2', 'L3', 'L4')),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'automatic')),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('chapter', 'timeline_event', 'session', 'user_rule', 'import')),
  source_id TEXT NOT NULL,
  source_version_id TEXT,
  automatic_learning_policy_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  CHECK (
    (origin = 'automatic' AND automatic_learning_policy_revision IS NOT NULL)
    OR (origin = 'user' AND automatic_learning_policy_revision IS NULL)
  ),
  CHECK (
    (source_kind = 'chapter' AND source_version_id IS NOT NULL)
    OR source_kind <> 'chapter'
  )
);

CREATE INDEX IF NOT EXISTS story_memory_records_project_level_idx
  ON story_memory_records (project_id, status, level, updated_at, id);

CREATE TABLE IF NOT EXISTS story_what_if_branches (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  base_timeline_revision INTEGER NOT NULL CHECK (base_timeline_revision >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'simulated', 'promoted_to_outline_draft', 'discarded')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
);

CREATE INDEX IF NOT EXISTS story_what_if_project_status_idx
  ON story_what_if_branches (project_id, status, updated_at, id);

CREATE TABLE IF NOT EXISTS story_outline_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  source_branch_id TEXT NOT NULL UNIQUE
    REFERENCES story_what_if_branches(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
);

CREATE INDEX IF NOT EXISTS story_outline_drafts_project_idx
  ON story_outline_drafts (project_id, created_at, id);
