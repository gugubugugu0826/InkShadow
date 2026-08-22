PRAGMA foreign_keys = ON;

-- Direction suggestions are isolated model output, but they are not prose and
-- must never become accepted chapter content. Existing Candidates retain their
-- published prose behavior through the default.
ALTER TABLE ai_candidates
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'prose'
  CHECK (purpose IN ('prose', 'continuation_directions'));

CREATE TRIGGER IF NOT EXISTS ai_candidate_purpose_insert_guard
BEFORE INSERT ON ai_candidates
WHEN NEW.purpose = 'continuation_directions' AND NEW.status = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'continuation directions cannot be accepted');
END;

CREATE TRIGGER IF NOT EXISTS ai_candidate_purpose_update_guard
BEFORE UPDATE OF purpose ON ai_candidates
WHEN NEW.purpose IS NOT OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'AI candidate purpose is immutable');
END;

CREATE TRIGGER IF NOT EXISTS ai_candidate_direction_accept_guard
BEFORE UPDATE OF status ON ai_candidates
WHEN NEW.purpose = 'continuation_directions' AND NEW.status = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'continuation directions cannot be accepted');
END;

-- Verify that every historic row received the safe default before migration
-- completion. A failed guard aborts the forward-only migration atomically.
CREATE TEMP TABLE _inkshadow_0072_candidate_purpose_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO _inkshadow_0072_candidate_purpose_guard (invalid_count)
SELECT COUNT(*)
FROM ai_candidates
WHERE purpose <> 'prose';

DROP TABLE _inkshadow_0072_candidate_purpose_guard;
