PRAGMA foreign_keys = ON;

-- Preserve the exact author-facing selection skill across application restarts.
-- Historical selection Candidates keep NULL and safely fall back to the
-- original “改写” behavior; every new selection Candidate must name its action.
ALTER TABLE ai_candidates
  ADD COLUMN selection_action TEXT
  CHECK (
    selection_action IS NULL
    OR selection_action IN ('selection_rewrite', 'polish', 'expand', 'shorten')
  );

CREATE TRIGGER IF NOT EXISTS ai_candidate_selection_action_insert_guard
BEFORE INSERT ON ai_candidates
WHEN NOT (
  (NEW.task_intent = 'selection_rewrite' AND NEW.selection_action IS NOT NULL)
  OR (NEW.task_intent <> 'selection_rewrite' AND NEW.selection_action IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI candidate selection action');
END;

CREATE TRIGGER IF NOT EXISTS ai_candidate_selection_action_update_guard
BEFORE UPDATE OF selection_action ON ai_candidates
WHEN NEW.selection_action IS NOT OLD.selection_action
BEGIN
  SELECT RAISE(ABORT, 'AI candidate selection action is immutable');
END;
