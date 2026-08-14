-- Forward-only, content-free network-boundary receipt for model invocations.
--
-- The timestamp is written immediately before the native gateway call.  It
-- contains no prompt, output, credential, project text, or provider response.
-- A running row without this value is safe to recover as not dispatched; a
-- running row with it is conservatively recovered as ambiguous and is never
-- sent again automatically.

ALTER TABLE model_invocation_facts
  ADD COLUMN provider_dispatch_started_at TEXT;
