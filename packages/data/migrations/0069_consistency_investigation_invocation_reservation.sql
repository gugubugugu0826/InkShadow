PRAGMA foreign_keys = ON;

-- Reserve the exact content-free Model Hub invocation id before the ledger row
-- is started.  The reservation closes the crash window between
-- model_invocation_facts INSERT and the renderer's pre-dispatch callback.
ALTER TABLE consistency_investigation_steps
  ADD COLUMN planned_invocation_id TEXT;

-- Existing active rows may already have crossed the old callback. Keep their
-- established binding as the reservation. Terminal rows are immutable under
-- migration 0067 and continue to recover through invocation_id, so deliberately
-- leave their new column NULL. Released migrations remain untouched.
UPDATE consistency_investigation_steps
SET planned_invocation_id = invocation_id
WHERE step_kind = 'model'
  AND status IN ('reserved', 'bound', 'dispatched')
  AND invocation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS consistency_investigation_steps_planned_invocation_idx
  ON consistency_investigation_steps (planned_invocation_id)
  WHERE planned_invocation_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_step_plan_guard
BEFORE UPDATE OF planned_invocation_id ON consistency_investigation_steps
WHEN OLD.planned_invocation_id IS NOT NEW.planned_invocation_id
AND (
  OLD.planned_invocation_id IS NOT NULL
  OR NEW.planned_invocation_id IS NULL
  OR OLD.status <> 'reserved'
  OR NEW.status <> 'bound'
  OR NEW.step_kind <> 'model'
  OR length(NEW.planned_invocation_id) <> 36
  OR NEW.planned_invocation_id <> lower(NEW.planned_invocation_id)
  OR substr(NEW.planned_invocation_id, 9, 1) <> '-'
  OR substr(NEW.planned_invocation_id, 14, 1) <> '-'
  OR substr(NEW.planned_invocation_id, 15, 1) <> '7'
  OR substr(NEW.planned_invocation_id, 19, 1) <> '-'
  OR substr(NEW.planned_invocation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
  OR substr(NEW.planned_invocation_id, 24, 1) <> '-'
  OR replace(NEW.planned_invocation_id, '-', '') GLOB '*[^0-9a-f]*'
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation invocation reservation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_step_reserved_binding_guard
BEFORE UPDATE OF invocation_id ON consistency_investigation_steps
WHEN NEW.invocation_id IS NOT NULL
AND (
  NEW.planned_invocation_id IS NULL
  OR NEW.invocation_id <> NEW.planned_invocation_id
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation invocation differs from its reservation');
END;

-- A late continuation after recovery cannot create a fresh running ledger row.
-- Normal Model Hub invocations without a consistency reservation are untouched.
CREATE TRIGGER IF NOT EXISTS consistency_investigation_invocation_start_guard
BEFORE INSERT ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM consistency_investigation_steps
  WHERE planned_invocation_id = NEW.id
)
AND NOT EXISTS (
  SELECT 1
  FROM consistency_investigation_steps AS step
  INNER JOIN consistency_investigation_runs AS run ON run.id = step.run_id
  WHERE step.planned_invocation_id = NEW.id
    AND step.step_kind = 'model'
    AND step.status = 'bound'
    AND run.status = 'planned'
    AND NEW.task = 'contradiction_check'
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation invocation reservation is no longer active');
END;

-- The ledger insert, exact step binding, and trace link commit as one SQLite
-- statement. A process loss before onBeforeDispatch therefore remains fully
-- discoverable without issuing another Provider request.
CREATE TRIGGER IF NOT EXISTS consistency_investigation_invocation_bind_after_start
AFTER INSERT ON model_invocation_facts
WHEN NEW.task = 'contradiction_check'
AND EXISTS (
  SELECT 1 FROM consistency_investigation_steps
  WHERE planned_invocation_id = NEW.id AND status = 'bound'
)
BEGIN
  UPDATE consistency_investigation_steps
  SET invocation_id = NEW.id
  WHERE planned_invocation_id = NEW.id
    AND step_kind = 'model'
    AND status = 'bound'
    AND invocation_id IS NULL;

  INSERT INTO context_compilation_model_invocation_links (
    trace_id, model_invocation_id, linked_at
  )
  SELECT run.context_trace_id, NEW.id, run.updated_at
  FROM consistency_investigation_steps AS step
  INNER JOIN consistency_investigation_runs AS run ON run.id = step.run_id
  WHERE step.planned_invocation_id = NEW.id
    AND run.context_trace_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM context_compilation_model_invocation_links AS link
      WHERE link.trace_id = run.context_trace_id
         OR link.model_invocation_id = NEW.id
    );
END;
