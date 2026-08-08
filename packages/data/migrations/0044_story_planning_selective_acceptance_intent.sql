PRAGMA foreign_keys = ON;

-- A selective acceptance must reserve the review candidate before the authoritative
-- outline is changed. The intent is content-free: it binds the immutable payload item
-- identifiers and exact baseline/proposed synopsis digests, but never duplicates text.
-- schemaVersion 1 permanently selects the retained synopsis renderer v1.
ALTER TABLE story_planning_candidates
  ADD COLUMN selective_acceptance_intent_json TEXT
  CHECK (
    selective_acceptance_intent_json IS NULL
    OR COALESCE((
      status = 'review'
      AND decided_at IS NULL
      AND baseline_target_synopsis IS NOT NULL
      AND accepted_outline_revision IS NULL
      AND accepted_selection_json IS NULL
      AND json_valid(selective_acceptance_intent_json)
      AND json_type(selective_acceptance_intent_json) = 'object'
      AND json_extract(selective_acceptance_intent_json, '$.schemaVersion') = 1
      AND json_type(selective_acceptance_intent_json, '$.selectedItemIds') = 'array'
      AND json_array_length(selective_acceptance_intent_json, '$.selectedItemIds') BETWEEN 1 AND 64
      AND json_type(selective_acceptance_intent_json, '$.baselineOutlineRevision') = 'integer'
      AND json_extract(selective_acceptance_intent_json, '$.baselineOutlineRevision') = baseline_outline_revision
      AND json_type(selective_acceptance_intent_json, '$.selectionSha256') = 'text'
      AND length(json_extract(selective_acceptance_intent_json, '$.selectionSha256')) = 64
      AND json_extract(selective_acceptance_intent_json, '$.selectionSha256')
        NOT GLOB '*[^0-9a-f]*'
      AND json_type(selective_acceptance_intent_json, '$.baselineSynopsisSha256') = 'text'
      AND length(json_extract(selective_acceptance_intent_json, '$.baselineSynopsisSha256')) = 64
      AND json_extract(selective_acceptance_intent_json, '$.baselineSynopsisSha256')
        NOT GLOB '*[^0-9a-f]*'
      AND json_type(selective_acceptance_intent_json, '$.proposedSynopsisSha256') = 'text'
      AND length(json_extract(selective_acceptance_intent_json, '$.proposedSynopsisSha256')) = 64
      AND json_extract(selective_acceptance_intent_json, '$.proposedSynopsisSha256')
        NOT GLOB '*[^0-9a-f]*'
      AND json_type(selective_acceptance_intent_json, '$.startedAt') = 'text'
      AND strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        json_extract(selective_acceptance_intent_json, '$.startedAt')
      ) = json_extract(selective_acceptance_intent_json, '$.startedAt')
      AND length(selective_acceptance_intent_json) <= 12000
    ), 0)
  );
