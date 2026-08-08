PRAGMA foreign_keys = ON;

-- Candidate payload shape and its author-visible application behavior are
-- explicit task semantics. Existing rows keep their historic full-document
-- behavior; new continuation and selection-rewrite rows opt into fragment
-- application at an exact UTF-16 anchor.
ALTER TABLE ai_candidates
  ADD COLUMN task_intent TEXT NOT NULL DEFAULT 'legacy_full_document'
  CHECK (
    task_intent IN (
      'legacy_full_document',
      'continuation',
      'selection_rewrite',
      'whole_chapter_rewrite'
    )
  );

ALTER TABLE ai_candidates
  ADD COLUMN application_mode TEXT NOT NULL DEFAULT 'replace_document'
  CHECK (application_mode IN ('replace_document', 'insert_at_cursor', 'replace_selection'));

ALTER TABLE ai_candidates
  ADD COLUMN payload_kind TEXT NOT NULL DEFAULT 'full_document'
  CHECK (payload_kind IN ('full_document', 'fragment'));

ALTER TABLE ai_candidates
  ADD COLUMN anchor_start_utf16 INTEGER
  CHECK (anchor_start_utf16 IS NULL OR anchor_start_utf16 BETWEEN 0 AND 5000000);

ALTER TABLE ai_candidates
  ADD COLUMN anchor_end_utf16 INTEGER
  CHECK (anchor_end_utf16 IS NULL OR anchor_end_utf16 BETWEEN 0 AND 5000000);

CREATE TRIGGER IF NOT EXISTS ai_candidate_application_intent_insert_guard
BEFORE INSERT ON ai_candidates
WHEN NOT (
  (
    NEW.task_intent IN ('legacy_full_document', 'whole_chapter_rewrite')
    AND NEW.application_mode = 'replace_document'
    AND NEW.payload_kind = 'full_document'
    AND NEW.anchor_start_utf16 IS NULL
    AND NEW.anchor_end_utf16 IS NULL
  )
  OR (
    NEW.task_intent = 'continuation'
    AND NEW.source = 'generate'
    AND NEW.application_mode = 'insert_at_cursor'
    AND NEW.payload_kind = 'fragment'
    AND NEW.anchor_start_utf16 IS NOT NULL
    AND NEW.anchor_end_utf16 = NEW.anchor_start_utf16
  )
  OR (
    NEW.task_intent = 'selection_rewrite'
    AND NEW.source = 'polish'
    AND NEW.application_mode = 'replace_selection'
    AND NEW.payload_kind = 'fragment'
    AND NEW.anchor_start_utf16 IS NOT NULL
    AND NEW.anchor_end_utf16 > NEW.anchor_start_utf16
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI candidate application intent');
END;

CREATE TRIGGER IF NOT EXISTS ai_candidate_application_intent_update_guard
BEFORE UPDATE OF
  task_intent,
  application_mode,
  payload_kind,
  anchor_start_utf16,
  anchor_end_utf16
ON ai_candidates
WHEN
  NEW.task_intent IS NOT OLD.task_intent
  OR NEW.application_mode IS NOT OLD.application_mode
  OR NEW.payload_kind IS NOT OLD.payload_kind
  OR NEW.anchor_start_utf16 IS NOT OLD.anchor_start_utf16
  OR NEW.anchor_end_utf16 IS NOT OLD.anchor_end_utf16
BEGIN
  SELECT RAISE(ABORT, 'AI candidate application intent is immutable');
END;
