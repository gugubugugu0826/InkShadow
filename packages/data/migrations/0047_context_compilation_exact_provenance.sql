PRAGMA foreign_keys = ON;

-- A context compilation run records why material was selected. These append-only
-- links record which real generation consumed that exact compilation. Prompt,
-- chapter and provider output text remain deliberately absent.
CREATE TABLE IF NOT EXISTS context_compilation_execution_links (
  trace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES context_compilation_runs(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL UNIQUE
    CHECK (
      length(generation_id) = 36
      AND generation_id = lower(generation_id)
      AND substr(generation_id, 9, 1) = '-'
      AND substr(generation_id, 14, 1) = '-'
      AND substr(generation_id, 15, 1) = '7'
      AND substr(generation_id, 19, 1) = '-'
      AND substr(generation_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(generation_id, 24, 1) = '-'
      AND replace(generation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  -- One governed run may be retried. generation_id identifies the exact
  -- attempt while generation_run_id groups those attempts.
  generation_run_id TEXT
    REFERENCES ai_generation_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX IF NOT EXISTS context_compilation_execution_run_idx
  ON context_compilation_execution_links (generation_run_id)
  WHERE generation_run_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS context_compilation_execution_binding_guard
BEFORE INSERT ON context_compilation_execution_links
WHEN NEW.generation_run_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM context_compilation_runs AS trace
  INNER JOIN ai_generation_runs AS generation_run
    ON generation_run.id = NEW.generation_run_id
  WHERE trace.id = NEW.trace_id
    AND generation_run.project_id = trace.project_id
    AND generation_run.chapter_id IS trace.chapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'context compilation generation run belongs to another target');
END;

CREATE TRIGGER IF NOT EXISTS context_compilation_execution_immutable
BEFORE UPDATE ON context_compilation_execution_links
BEGIN
  SELECT RAISE(ABORT, 'context compilation execution link is immutable');
END;

-- Model Hub creates its content-free invocation fact before the pre-dispatch
-- callback. Linking here therefore fails closed before any chapter text leaves
-- the device.
CREATE TABLE IF NOT EXISTS context_compilation_model_invocation_links (
  trace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES context_compilation_runs(id) ON DELETE CASCADE,
  model_invocation_id TEXT NOT NULL UNIQUE
    REFERENCES model_invocation_facts(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', linked_at) = linked_at)
);

CREATE TRIGGER IF NOT EXISTS context_compilation_model_invocation_execution_guard
BEFORE INSERT ON context_compilation_model_invocation_links
WHEN NOT EXISTS (
  SELECT 1
  FROM context_compilation_execution_links AS execution
  WHERE execution.trace_id = NEW.trace_id
)
BEGIN
  SELECT RAISE(ABORT, 'context compilation invocation has no exact generation');
END;

CREATE TRIGGER IF NOT EXISTS context_compilation_model_invocation_immutable
BEFORE UPDATE ON context_compilation_model_invocation_links
BEGIN
  SELECT RAISE(ABORT, 'context compilation model invocation link is immutable');
END;

-- Direct continuation and selection rewrite do not use ai_generation_runs.
-- Their isolated AI Candidate is linked explicitly after it is durably saved.
CREATE TABLE IF NOT EXISTS context_compilation_output_candidate_links (
  trace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES context_compilation_runs(id) ON DELETE CASCADE,
  ai_candidate_id TEXT NOT NULL UNIQUE
    REFERENCES ai_candidates(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', linked_at) = linked_at)
);

CREATE TRIGGER IF NOT EXISTS context_compilation_output_candidate_execution_guard
BEFORE INSERT ON context_compilation_output_candidate_links
WHEN NOT EXISTS (
  SELECT 1
  FROM context_compilation_execution_links AS execution
  WHERE execution.trace_id = NEW.trace_id
)
BEGIN
  SELECT RAISE(ABORT, 'context compilation output has no exact generation');
END;

CREATE TRIGGER IF NOT EXISTS context_compilation_output_candidate_binding_guard
BEFORE INSERT ON context_compilation_output_candidate_links
WHEN NOT EXISTS (
  SELECT 1
  FROM context_compilation_runs AS trace
  INNER JOIN ai_candidates AS output_candidate
    ON output_candidate.id = NEW.ai_candidate_id
  WHERE trace.id = NEW.trace_id
    AND output_candidate.project_id = trace.project_id
    AND output_candidate.chapter_id IS trace.chapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'context compilation output candidate belongs to another target');
END;

CREATE TRIGGER IF NOT EXISTS context_compilation_output_candidate_run_conflict_guard
BEFORE INSERT ON context_compilation_output_candidate_links
WHEN EXISTS (
  SELECT 1
  FROM context_compilation_execution_links AS execution
  INNER JOIN ai_generation_runs AS generation_run
    ON generation_run.id = execution.generation_run_id
  WHERE generation_run.candidate_id = NEW.ai_candidate_id
    AND execution.trace_id <> NEW.trace_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI candidate is already linked through another generation run');
END;

CREATE TRIGGER IF NOT EXISTS context_compilation_output_candidate_immutable
BEFORE UPDATE ON context_compilation_output_candidate_links
BEGIN
  SELECT RAISE(ABORT, 'context compilation output candidate link is immutable');
END;
