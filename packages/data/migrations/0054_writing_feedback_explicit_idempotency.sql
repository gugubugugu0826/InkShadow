ALTER TABLE writing_feedback_events
  ADD COLUMN idempotency_key TEXT
    CHECK (
      idempotency_key IS NULL
      OR (
        length(idempotency_key) = 64
        AND idempotency_key NOT GLOB '*[^0-9a-f]*'
      )
    );

CREATE UNIQUE INDEX writing_feedback_events_explicit_idempotency_unique
  ON writing_feedback_events (project_id, idempotency_key)
  WHERE action = 'explicit_feedback' AND idempotency_key IS NOT NULL;
