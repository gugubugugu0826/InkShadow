PRAGMA foreign_keys = ON;

-- StoryFact text, source evidence, identity and confidence remain immutable.
-- Entity alias disambiguation is the single structured-value governance
-- transition: an author may resolve an explicitly ambiguous subject to one of
-- its captured confirmed matches, or keep the captured distinct entity. The
-- same UPDATE must advance the CAS revision so the existing revision trigger
-- records both the pre-resolution and post-resolution snapshots.
DROP TRIGGER IF EXISTS story_fact_identity_immutable;

CREATE TRIGGER story_fact_identity_immutable
BEFORE UPDATE OF
  id,
  project_id,
  fact_type,
  content_text,
  source_kind,
  evidence_reference,
  source_chapter_id,
  source_version_id,
  source_start_offset,
  source_end_offset,
  source_length,
  source_excerpt,
  effective_at,
  invalidated_at,
  branch_id,
  confidence,
  origin,
  created_at
ON story_facts
BEGIN
  SELECT RAISE(ABORT, 'story fact identity and evidence are immutable');
END;

CREATE TRIGGER story_fact_entity_alias_resolution_guard
BEFORE UPDATE OF value_json ON story_facts
WHEN NEW.value_json IS NOT OLD.value_json
AND NOT (
  OLD.value_json IS NOT NULL
  AND NEW.value_json IS NOT NULL
  AND json_valid(OLD.value_json)
  AND json_valid(NEW.value_json)
  AND json_type(OLD.value_json) = 'object'
  AND json_type(NEW.value_json) = 'object'
  AND json_type(OLD.value_json, '$.subject') = 'object'
  AND json_type(NEW.value_json, '$.subject') = 'object'
  AND json_extract(OLD.value_json, '$.subject.mergeStatus') = 'ambiguous_confirmed_alias'
  AND json_type(OLD.value_json, '$.subject.entityKey') = 'text'
  AND length(json_extract(OLD.value_json, '$.subject.entityKey')) BETWEEN 1 AND 200
  AND json_type(OLD.value_json, '$.subject.matchedEntityKeys') = 'array'
  AND json_array_length(OLD.value_json, '$.subject.matchedEntityKeys') BETWEEN 1 AND 64
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(OLD.value_json, '$.subject.matchedEntityKeys') AS matched
    WHERE matched.type <> 'text'
      OR length(matched.value) NOT BETWEEN 1 AND 200
  )
  AND (
    SELECT count(*) = count(DISTINCT CAST(matched.value AS TEXT))
    FROM json_each(OLD.value_json, '$.subject.matchedEntityKeys') AS matched
  )
  AND json_remove(OLD.value_json, '$.subject') = json_remove(NEW.value_json, '$.subject')
  AND json_remove(
        json_extract(OLD.value_json, '$.subject'),
        '$.entityKey',
        '$.mergeStatus',
        '$.matchedEntityKeys'
      ) = json_remove(
        json_extract(NEW.value_json, '$.subject'),
        '$.entityKey',
        '$.mergeStatus',
        '$.matchedEntityKeys'
      )
  AND NEW.status = OLD.status
  AND NEW.status IN ('temporary', 'unconfirmed')
  AND NEW.user_confirmed = OLD.user_confirmed
  AND NEW.user_confirmed = 0
  AND NEW.locked = OLD.locked
  AND NEW.locked = 0
  AND NEW.deprecated = OLD.deprecated
  AND NEW.deprecated = 0
  AND NEW.needs_review = OLD.needs_review
  AND NEW.confirmed_by_actor_id IS OLD.confirmed_by_actor_id
  AND NEW.confirmed_at IS OLD.confirmed_at
  AND NEW.revision = OLD.revision + 1
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (
      json_extract(NEW.value_json, '$.subject.mergeStatus') =
        'human_resolved_existing_entity'
      AND json_type(NEW.value_json, '$.subject.entityKey') = 'text'
      AND EXISTS (
        SELECT 1
        FROM json_each(OLD.value_json, '$.subject.matchedEntityKeys') AS matched
        WHERE matched.type = 'text'
          AND matched.value = json_extract(NEW.value_json, '$.subject.entityKey')
      )
      AND json_type(NEW.value_json, '$.subject.matchedEntityKeys') = 'array'
      AND json_array_length(NEW.value_json, '$.subject.matchedEntityKeys') = 1
      AND json_type(NEW.value_json, '$.subject.matchedEntityKeys[0]') = 'text'
      AND json_extract(NEW.value_json, '$.subject.matchedEntityKeys[0]') =
        json_extract(NEW.value_json, '$.subject.entityKey')
    )
    OR
    (
      json_extract(NEW.value_json, '$.subject.mergeStatus') =
        'human_resolved_separate_entity'
      AND json_extract(NEW.value_json, '$.subject.entityKey') =
        json_extract(OLD.value_json, '$.subject.entityKey')
      AND json_extract(NEW.value_json, '$.subject.matchedEntityKeys') =
        json_extract(OLD.value_json, '$.subject.matchedEntityKeys')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'story fact entity alias resolution is invalid');
END;
