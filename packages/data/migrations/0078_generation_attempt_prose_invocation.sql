PRAGMA foreign_keys = ON;

-- Migration 0075 intentionally froze privacy snapshots but limited its direct
-- invocation guard to continuation. Rebuild only that guard so a governed
-- opening can retain the same exact Model Hub invocation identifier.
DROP TRIGGER IF EXISTS ai_generation_attempt_usage_privacy_insert_guard;

CREATE TRIGGER ai_generation_attempt_usage_privacy_insert_guard
BEFORE INSERT ON ai_generation_attempt_usage
WHEN NEW.privacy_snapshot_version IS NOT 1
  OR NEW.privacy_policy IS NULL
  OR NEW.data_destination IS NULL
  OR (NEW.privacy_policy = 'local_only' AND NEW.data_destination <> 'local')
  OR (
    NEW.model_invocation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM model_invocation_facts AS invocation
      WHERE invocation.id = NEW.model_invocation_id
        AND invocation.task IN ('continuation', 'prose_generation')
        AND invocation.privacy_policy = NEW.privacy_policy
        AND invocation.data_destination = NEW.data_destination
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'generation attempt privacy snapshot is missing or inconsistent');
END;
