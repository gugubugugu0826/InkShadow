PRAGMA foreign_keys = ON;

-- New planning candidates capture the exact target synopsis used for their diff. Legacy
-- candidates remain readable with NULL here and retain whole-synopsis acceptance only.
ALTER TABLE story_planning_candidates
  ADD COLUMN baseline_target_synopsis TEXT
  CHECK (
    baseline_target_synopsis IS NULL
    OR (
      length(baseline_target_synopsis) <= 4000
      AND instr(baseline_target_synopsis, char(0)) = 0
    )
  );

-- A non-NULL array records the immutable structured item identifiers chosen during partial
-- acceptance. Whole and legacy acceptance keep this NULL.
ALTER TABLE story_planning_candidates
  ADD COLUMN accepted_selection_json TEXT
  CHECK (
    accepted_selection_json IS NULL
    OR (
      status = 'accepted'
      AND baseline_target_synopsis IS NOT NULL
      AND json_valid(accepted_selection_json)
      AND json_type(accepted_selection_json) = 'array'
      AND json_array_length(accepted_selection_json) BETWEEN 1 AND 64
      AND length(accepted_selection_json) <= 10000
    )
  );
