PRAGMA foreign_keys = ON;

-- Rows written before this migration deliberately retain NULL in these four
-- columns. Every new attempt must carry the exact privacy snapshot disclosed
-- before dispatch; Model Hub attempts additionally retain their invocation id.
ALTER TABLE ai_generation_attempt_usage
  ADD COLUMN privacy_snapshot_version INTEGER
    CHECK (privacy_snapshot_version IS NULL OR privacy_snapshot_version = 1);

ALTER TABLE ai_generation_attempt_usage
  ADD COLUMN privacy_policy TEXT
    CHECK (privacy_policy IS NULL OR privacy_policy IN ('local_only', 'local_preferred', 'cloud_allowed'));

ALTER TABLE ai_generation_attempt_usage
  ADD COLUMN data_destination TEXT
    CHECK (data_destination IS NULL OR data_destination IN ('local', 'remote'));

ALTER TABLE ai_generation_attempt_usage
  ADD COLUMN model_invocation_id TEXT
    REFERENCES model_invocation_facts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX ai_generation_attempt_usage_invocation_idx
  ON ai_generation_attempt_usage (model_invocation_id)
  WHERE model_invocation_id IS NOT NULL;

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
        AND invocation.task = 'continuation'
        AND invocation.privacy_policy = NEW.privacy_policy
        AND invocation.data_destination = NEW.data_destination
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'generation attempt privacy snapshot is missing or inconsistent');
END;

CREATE TRIGGER ai_generation_attempt_usage_privacy_immutable
BEFORE UPDATE OF privacy_snapshot_version, privacy_policy, data_destination, model_invocation_id
ON ai_generation_attempt_usage
BEGIN
  SELECT RAISE(ABORT, 'generation attempt privacy snapshot is immutable');
END;
