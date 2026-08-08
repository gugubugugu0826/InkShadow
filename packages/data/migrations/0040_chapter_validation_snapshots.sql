PRAGMA foreign_keys = ON;

-- Deterministic chapter checks are immutable evidence snapshots. They are tied to the exact
-- accepted chapter version that was checked and never mutate chapter text or formal StoryFacts.
CREATE TABLE IF NOT EXISTS chapter_validation_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  chapter_version_id TEXT
    REFERENCES chapter_versions(id) ON DELETE CASCADE,
  chapter_revision INTEGER
    CHECK (chapter_revision IS NULL OR chapter_revision >= 1),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  rule_set_version TEXT NOT NULL
    CHECK (length(rule_set_version) BETWEEN 1 AND 128),
  run_sequence INTEGER NOT NULL
    CHECK (run_sequence >= 1),
  run_kind TEXT NOT NULL
    CHECK (run_kind IN ('initial', 'rerun')),
  supersedes_snapshot_id TEXT
    REFERENCES chapter_validation_snapshots(id) ON DELETE SET NULL,
  result_status TEXT NOT NULL
    CHECK (result_status IN ('checked', 'skipped')),
  issue_count INTEGER NOT NULL
    CHECK (issue_count >= 0),
  result_checksum_sha256 TEXT NOT NULL
    CHECK (length(result_checksum_sha256) = 64),
  result_json TEXT NOT NULL
    CHECK (
      json_valid(result_json)
      AND json_type(result_json) = 'object'
      AND json_extract(result_json, '$.projectId') = project_id
      AND json_extract(result_json, '$.chapterId') = chapter_id
      AND json_extract(result_json, '$.chapterVersionId') IS chapter_version_id
      AND json_extract(result_json, '$.chapterRevision') IS chapter_revision
      AND json_extract(result_json, '$.status') = result_status
      AND json_type(result_json, '$.issues') = 'array'
      AND json_array_length(result_json, '$.issues') = issue_count
    ),
  generated_at TEXT NOT NULL,
  CHECK (
    (run_kind = 'initial' AND run_sequence = 1 AND supersedes_snapshot_id IS NULL)
    OR
    (run_kind = 'rerun' AND run_sequence > 1 AND supersedes_snapshot_id IS NOT NULL)
  ),
  UNIQUE (chapter_id, run_sequence)
);

CREATE INDEX IF NOT EXISTS chapter_validation_snapshots_latest_idx
  ON chapter_validation_snapshots (project_id, chapter_id, run_sequence DESC);

CREATE INDEX IF NOT EXISTS chapter_validation_snapshots_version_idx
  ON chapter_validation_snapshots (
    chapter_id,
    chapter_version_id,
    rule_set_version,
    generated_at DESC
  );

CREATE TRIGGER IF NOT EXISTS chapter_validation_snapshot_binding_guard
BEFORE INSERT ON chapter_validation_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM chapters AS chapter
  WHERE chapter.id = NEW.chapter_id
    AND chapter.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'chapter validation snapshot chapter belongs to another project');
END;

CREATE TRIGGER IF NOT EXISTS chapter_validation_snapshot_version_guard
BEFORE INSERT ON chapter_validation_snapshots
WHEN NEW.chapter_version_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM chapter_versions AS version
  WHERE version.id = NEW.chapter_version_id
    AND version.project_id = NEW.project_id
    AND version.chapter_id = NEW.chapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'chapter validation snapshot version binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS chapter_validation_snapshot_rerun_guard
BEFORE INSERT ON chapter_validation_snapshots
WHEN NEW.run_kind = 'rerun'
AND NOT EXISTS (
  SELECT 1
  FROM chapter_validation_snapshots AS previous
  WHERE previous.id = NEW.supersedes_snapshot_id
    AND previous.project_id = NEW.project_id
    AND previous.chapter_id = NEW.chapter_id
    AND previous.run_sequence = NEW.run_sequence - 1
)
BEGIN
  SELECT RAISE(ABORT, 'chapter validation snapshot rerun chain is invalid');
END;

CREATE TRIGGER IF NOT EXISTS chapter_validation_snapshot_immutable
BEFORE UPDATE ON chapter_validation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chapter validation snapshot is immutable');
END;
