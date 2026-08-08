PRAGMA foreign_keys = ON;

-- A ready Candidate may be edited many times without changing status. Status
-- alone therefore cannot authorize a later edit, rejection, or acceptance.
-- Repositories compare this monotonic revision together with status so a
-- stale window cannot overwrite or accept an older suggestion.
ALTER TABLE ai_candidates
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision BETWEEN 1 AND 9007199254740991);
