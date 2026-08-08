PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS continuous_story_state_route_receipts (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE CASCADE,
  task TEXT NOT NULL
    CHECK (task IN ('character_extraction', 'world_extraction')),
  source_content_hash TEXT NOT NULL
    CHECK (
      length(source_content_hash) = 64
      AND source_content_hash = lower(source_content_hash)
      AND source_content_hash NOT GLOB '*[^0-9a-f]*'
    ),
  provider_kind TEXT NOT NULL
    CHECK (length(trim(provider_kind)) BETWEEN 1 AND 100),
  model_id TEXT NOT NULL
    CHECK (length(trim(model_id)) BETWEEN 1 AND 500),
  invocation_id TEXT NOT NULL
    CHECK (length(trim(invocation_id)) BETWEEN 1 AND 500),
  candidate_count INTEGER NOT NULL
    CHECK (candidate_count BETWEEN 0 AND 128),
  created_fact_count INTEGER NOT NULL
    CHECK (created_fact_count BETWEEN 0 AND candidate_count),
  retired_fact_count INTEGER NOT NULL
    CHECK (retired_fact_count >= 0),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, chapter_id, version_id, task)
);

CREATE INDEX IF NOT EXISTS continuous_story_state_route_receipts_project_completed_idx
  ON continuous_story_state_route_receipts (project_id, completed_at DESC, chapter_id, version_id);

CREATE TRIGGER IF NOT EXISTS continuous_story_state_route_receipts_scope_guard
BEFORE INSERT ON continuous_story_state_route_receipts
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM chapters AS chapter
  JOIN chapter_versions AS version
    ON version.id = NEW.version_id
   AND version.project_id = NEW.project_id
   AND version.chapter_id = NEW.chapter_id
  WHERE chapter.id = NEW.chapter_id
    AND chapter.project_id = NEW.project_id
    AND chapter.status = 'active'
    AND chapter.current_version_id = NEW.version_id
    AND version.content_checksum = NEW.source_content_hash
)
BEGIN
  SELECT RAISE(ABORT, 'CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED');
END;

CREATE TRIGGER IF NOT EXISTS continuous_story_state_route_receipts_immutable_update
BEFORE UPDATE ON continuous_story_state_route_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'CONTINUOUS_STORY_STATE_ROUTE_RECEIPT_IMMUTABLE');
END;
