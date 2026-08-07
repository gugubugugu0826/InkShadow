PRAGMA foreign_keys = ON;

-- User actions are local evidence for visible writing preferences. Events are
-- immutable and deliberately keep no chapter or candidate body text.
CREATE TABLE IF NOT EXISTS writing_feedback_policies (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  learning_enabled INTEGER NOT NULL DEFAULT 1 CHECK (learning_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS writing_feedback_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT
    REFERENCES chapters(id) ON DELETE SET NULL,
  candidate_id TEXT
    REFERENCES ai_candidates(id) ON DELETE SET NULL,
  action TEXT NOT NULL
    CHECK (
      action IN (
        'accepted',
        'rejected',
        'regenerated',
        'partially_accepted',
        'deleted',
        'restored_original',
        'explicit_feedback'
      )
    ),
  feedback_code TEXT
    CHECK (
      feedback_code IS NULL
      OR feedback_code IN (
        'shorter_sentences',
        'more_dialogue',
        'less_environment_description',
        'avoid_summary_ending',
        'less_introspection',
        'faster_pacing',
        'avoid_term',
        'preserve_style',
        'smaller_changes',
        'larger_changes',
        'natural_dialogue'
      )
    ),
  custom_feedback TEXT
    CHECK (
      custom_feedback IS NULL
      OR (
        length(trim(custom_feedback)) BETWEEN 1 AND 1000
        AND instr(custom_feedback, char(0)) = 0
      )
    ),
  application_strategy TEXT
    CHECK (
      application_strategy IS NULL
      OR application_strategy IN (
        'accept_all',
        'apply_changes',
        'insert_at_cursor',
        'replace_selection',
        'overwrite_document'
      )
    ),
  accepted_change_count INTEGER
    CHECK (accepted_change_count IS NULL OR accepted_change_count >= 0),
  rejected_change_count INTEGER
    CHECK (rejected_change_count IS NULL OR rejected_change_count >= 0),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (
    (action = 'explicit_feedback' AND (feedback_code IS NOT NULL OR custom_feedback IS NOT NULL))
    OR action <> 'explicit_feedback'
  )
);

CREATE INDEX IF NOT EXISTS writing_feedback_events_project_created_idx
  ON writing_feedback_events (project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS writing_feedback_events_project_code_idx
  ON writing_feedback_events (project_id, feedback_code, created_at DESC)
  WHERE feedback_code IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS writing_feedback_event_chapter_binding_guard
BEFORE INSERT ON writing_feedback_events
WHEN NEW.chapter_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM chapters AS chapter
  WHERE chapter.id = NEW.chapter_id
    AND chapter.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'writing feedback chapter belongs to another project');
END;

CREATE TRIGGER IF NOT EXISTS writing_feedback_event_candidate_binding_guard
BEFORE INSERT ON writing_feedback_events
WHEN NEW.candidate_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM ai_candidates AS candidate
  WHERE candidate.id = NEW.candidate_id
    AND candidate.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'writing feedback candidate belongs to another project');
END;

CREATE TRIGGER IF NOT EXISTS writing_feedback_event_immutable
BEFORE UPDATE ON writing_feedback_events
BEGIN
  SELECT RAISE(ABORT, 'writing feedback event is immutable');
END;

CREATE TABLE IF NOT EXISTS writing_preferences (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  preference_text TEXT NOT NULL
    CHECK (
      length(trim(preference_text)) BETWEEN 1 AND 500
      AND instr(preference_text, char(0)) = 0
    ),
  source TEXT NOT NULL CHECK (source IN ('manual', 'feedback_pattern')),
  source_feedback_code TEXT
    CHECK (
      source_feedback_code IS NULL
      OR source_feedback_code IN (
        'shorter_sentences',
        'more_dialogue',
        'less_environment_description',
        'avoid_summary_ending',
        'less_introspection',
        'faster_pacing',
        'avoid_term',
        'preserve_style',
        'smaller_changes',
        'larger_changes',
        'natural_dialogue'
      )
    ),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  deleted_at TEXT
    CHECK (
      deleted_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at
    ),
  CHECK (updated_at >= created_at),
  CHECK (
    (source = 'manual' AND source_feedback_code IS NULL)
    OR (source = 'feedback_pattern' AND source_feedback_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS writing_preferences_project_updated_idx
  ON writing_preferences (project_id, deleted_at, updated_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS writing_preferences_active_feedback_code_idx
  ON writing_preferences (project_id, source_feedback_code)
  WHERE source = 'feedback_pattern' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS writing_preference_revisions (
  preference_id TEXT NOT NULL
    REFERENCES writing_preferences(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  preference_text TEXT NOT NULL
    CHECK (
      length(trim(preference_text)) BETWEEN 1 AND 500
      AND instr(preference_text, char(0)) = 0
    ),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  deleted_at TEXT,
  change_kind TEXT NOT NULL
    CHECK (change_kind IN ('created', 'edited', 'enabled', 'disabled', 'deleted', 'evidence_updated')),
  recorded_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at),
  PRIMARY KEY (preference_id, revision)
);

CREATE TRIGGER IF NOT EXISTS writing_preference_revision_insert
AFTER INSERT ON writing_preferences
BEGIN
  INSERT INTO writing_preference_revisions (
    preference_id, revision, preference_text, enabled, evidence_count,
    deleted_at, change_kind, recorded_at
  ) VALUES (
    NEW.id, NEW.revision, NEW.preference_text, NEW.enabled, NEW.evidence_count,
    NEW.deleted_at, 'created', NEW.updated_at
  );
END;
