PRAGMA foreign_keys = ON;

-- Historical events created before this migration cannot prove whether
-- learning was enabled at the moment they happened. Default them to disabled
-- so restoring a policy never retroactively learns from an ambiguous period.
ALTER TABLE writing_feedback_events
  ADD COLUMN learning_enabled_at_event INTEGER NOT NULL DEFAULT 0
    CHECK (learning_enabled_at_event IN (0, 1));

-- Store only a one-way identity for normalized custom feedback clusters. The
-- event may retain the user's explicit instruction, but never chapter/candidate
-- body text, prompts, or provider output.
ALTER TABLE writing_feedback_events
  ADD COLUMN custom_feedback_normalized_hash TEXT
    CHECK (
      custom_feedback_normalized_hash IS NULL
      OR (
        length(custom_feedback_normalized_hash) = 64
        AND custom_feedback_normalized_hash NOT GLOB '*[^0-9a-f]*'
      )
    );

-- A learned custom instruction remains a normal visible/editable preference.
-- The hash links it to its evidence cluster without copying normalized text.
ALTER TABLE writing_preferences
  ADD COLUMN source_feedback_hash TEXT
    CHECK (
      source_feedback_hash IS NULL
      OR (
        length(source_feedback_hash) = 64
        AND source_feedback_hash NOT GLOB '*[^0-9a-f]*'
      )
    );

CREATE INDEX IF NOT EXISTS writing_feedback_events_project_learning_code_idx
  ON writing_feedback_events (
    project_id,
    learning_enabled_at_event,
    feedback_code,
    created_at DESC
  )
  WHERE action = 'explicit_feedback' AND feedback_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS writing_feedback_events_project_learning_custom_idx
  ON writing_feedback_events (
    project_id,
    learning_enabled_at_event,
    custom_feedback_normalized_hash,
    created_at DESC
  )
  WHERE action = 'explicit_feedback' AND custom_feedback_normalized_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS writing_preferences_active_feedback_hash_idx
  ON writing_preferences (project_id, source_feedback_hash)
  WHERE source_feedback_hash IS NOT NULL AND deleted_at IS NULL;
