-- Persist only bounded, content-free failure metadata on the existing Model Hub
-- capability and invocation ledgers. Prompts, messages, chapter text, provider
-- response bodies, credentials and error summaries are deliberately excluded.

ALTER TABLE model_capability_scans
  ADD COLUMN diagnostic_request_id TEXT
  CHECK (
    diagnostic_request_id IS NULL
    OR (
      length(diagnostic_request_id) BETWEEN 8 AND 128
      AND diagnostic_request_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    )
  );

ALTER TABLE model_capability_scans
  ADD COLUMN failure_stage TEXT
  CHECK (
    failure_stage IS NULL
    OR failure_stage IN (
      'request_preparation',
      'dispatch',
      'transport',
      'http_response',
      'stream_parse',
      'response_normalization',
      'capability_commit',
      'invocation_commit',
      'unknown'
    )
  );

ALTER TABLE model_capability_scans
  ADD COLUMN failure_retryable INTEGER
  CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1));

ALTER TABLE model_capability_scans
  ADD COLUMN http_status INTEGER
  CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599);

ALTER TABLE model_capability_scans
  ADD COLUMN finish_reason TEXT
  CHECK (
    finish_reason IS NULL
    OR (
      length(finish_reason) BETWEEN 1 AND 64
      AND substr(finish_reason, 1, 1) GLOB '[a-z]'
      AND finish_reason NOT GLOB '*[^a-z0-9_.-]*'
    )
  );

ALTER TABLE model_capability_scans
  ADD COLUMN visible_content_length INTEGER
  CHECK (
    visible_content_length IS NULL
    OR visible_content_length BETWEEN 0 AND 1000000000
  );

ALTER TABLE model_capability_scans
  ADD COLUMN reasoning_present INTEGER
  CHECK (reasoning_present IS NULL OR reasoning_present IN (0, 1));

ALTER TABLE model_capability_scans
  ADD COLUMN streamed INTEGER
  CHECK (streamed IS NULL OR streamed IN (0, 1));

ALTER TABLE model_capability_scans
  ADD COLUMN attempt INTEGER
  CHECK (attempt IS NULL OR attempt BETWEEN 1 AND 100);

ALTER TABLE model_capability_scans
  ADD COLUMN requested_max_output_tokens INTEGER
  CHECK (
    requested_max_output_tokens IS NULL
    OR requested_max_output_tokens BETWEEN 1 AND 1000000000
  );

ALTER TABLE model_invocation_facts
  ADD COLUMN diagnostic_request_id TEXT
  CHECK (
    diagnostic_request_id IS NULL
    OR (
      length(diagnostic_request_id) BETWEEN 8 AND 128
      AND diagnostic_request_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    )
  );

ALTER TABLE model_invocation_facts
  ADD COLUMN failure_stage TEXT
  CHECK (
    failure_stage IS NULL
    OR failure_stage IN (
      'request_preparation',
      'dispatch',
      'transport',
      'http_response',
      'stream_parse',
      'response_normalization',
      'capability_commit',
      'invocation_commit',
      'unknown'
    )
  );

ALTER TABLE model_invocation_facts
  ADD COLUMN failure_retryable INTEGER
  CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1));

ALTER TABLE model_invocation_facts
  ADD COLUMN http_status INTEGER
  CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599);

ALTER TABLE model_invocation_facts
  ADD COLUMN finish_reason TEXT
  CHECK (
    finish_reason IS NULL
    OR (
      length(finish_reason) BETWEEN 1 AND 64
      AND substr(finish_reason, 1, 1) GLOB '[a-z]'
      AND finish_reason NOT GLOB '*[^a-z0-9_.-]*'
    )
  );

ALTER TABLE model_invocation_facts
  ADD COLUMN visible_content_length INTEGER
  CHECK (
    visible_content_length IS NULL
    OR visible_content_length BETWEEN 0 AND 1000000000
  );

ALTER TABLE model_invocation_facts
  ADD COLUMN reasoning_present INTEGER
  CHECK (reasoning_present IS NULL OR reasoning_present IN (0, 1));

ALTER TABLE model_invocation_facts
  ADD COLUMN streamed INTEGER
  CHECK (streamed IS NULL OR streamed IN (0, 1));

ALTER TABLE model_invocation_facts
  ADD COLUMN requested_max_output_tokens INTEGER
  CHECK (
    requested_max_output_tokens IS NULL
    OR requested_max_output_tokens BETWEEN 1 AND 1000000000
  );

CREATE INDEX IF NOT EXISTS model_capability_scans_recent_failure_idx
  ON model_capability_scans (completed_at DESC, id ASC)
  WHERE status IN ('partial', 'failed') AND error_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS model_invocation_facts_recent_failure_idx
  ON model_invocation_facts (completed_at DESC, id ASC)
  WHERE status IN ('failed', 'timed_out') AND error_code IS NOT NULL;
