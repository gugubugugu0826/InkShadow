PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS story_memory_governance_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('forget_project', 'merge')),
  target_record_id TEXT REFERENCES story_memory_records(id) ON DELETE RESTRICT,
  affected_record_count INTEGER NOT NULL CHECK (affected_record_count >= 0),
  resulting_policy_revision INTEGER CHECK (
    resulting_policy_revision IS NULL OR resulting_policy_revision >= 1
  ),
  request_json TEXT NOT NULL
    CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  before_snapshot_json TEXT NOT NULL
    CHECK (json_valid(before_snapshot_json) AND json_type(before_snapshot_json) = 'object'),
  after_snapshot_json TEXT NOT NULL
    CHECK (json_valid(after_snapshot_json) AND json_type(after_snapshot_json) = 'object'),
  created_at TEXT NOT NULL,
  CHECK (
    (operation = 'forget_project' AND target_record_id IS NULL)
    OR (operation = 'merge' AND target_record_id IS NOT NULL AND affected_record_count = 2)
  )
);

CREATE INDEX IF NOT EXISTS story_memory_governance_events_project_created_idx
  ON story_memory_governance_events (project_id, created_at DESC, id);

CREATE TRIGGER IF NOT EXISTS story_memory_governance_events_immutable_update
BEFORE UPDATE ON story_memory_governance_events
BEGIN
  SELECT RAISE(ABORT, 'story memory governance audit events are immutable');
END;
