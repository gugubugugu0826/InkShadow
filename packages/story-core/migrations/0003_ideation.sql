PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS story_ideation_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('quick', 'guided')),
  status TEXT NOT NULL CHECK (status IN ('active', 'finalized')),
  project_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  CHECK (
    (status = 'active' AND project_id IS NULL)
    OR (status = 'finalized' AND project_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS story_ideation_drafts_project_idx
  ON story_ideation_drafts (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS story_ideation_drafts_active_updated_idx
  ON story_ideation_drafts (updated_at DESC, id)
  WHERE status = 'active';
