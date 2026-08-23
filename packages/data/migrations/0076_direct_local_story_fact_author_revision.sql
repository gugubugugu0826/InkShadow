PRAGMA foreign_keys = ON;

-- A direct-local organizer draft is rebuildable structured data, but its
-- chapter/version/span locator is durable evidence. An explicit author edit
-- may promote only that narrow pending shape to a formal user fact, preserving
-- the immutable locator while clearing the now-stale structured derivation.
-- All released alias-resolution and ordinary user-edit rules remain intact.
DROP TRIGGER IF EXISTS story_fact_entity_alias_resolution_guard;

CREATE TRIGGER story_fact_entity_alias_resolution_guard
BEFORE UPDATE OF value_json ON story_facts
WHEN NEW.value_json IS NOT OLD.value_json
AND NOT (
  (
    OLD.value_json IS NOT NULL
    AND NEW.value_json IS NOT NULL
    AND json_valid(OLD.value_json)
    AND json_valid(NEW.value_json)
    AND json_type(OLD.value_json) = 'object'
    AND json_type(NEW.value_json) = 'object'
    AND json_type(OLD.value_json, '$.subject') = 'object'
    AND json_type(NEW.value_json, '$.subject') = 'object'
    AND json_extract(OLD.value_json, '$.subject.mergeStatus') =
      'ambiguous_confirmed_alias'
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
    AND json_remove(OLD.value_json, '$.subject') =
      json_remove(NEW.value_json, '$.subject')
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
  OR
  (
    OLD.value_json IS NOT NULL
    AND NEW.value_json IS NULL
    AND json_valid(OLD.value_json)
    AND json_type(OLD.value_json) = 'object'
    AND json_extract(OLD.value_json, '$.schemaVersion') =
      'inkshadow.rebuildable-system-fact.v1'
    AND json_type(OLD.value_json, '$.payload') = 'object'
    AND json_extract(OLD.value_json, '$.payload.schemaVersion') =
      'inkshadow.direct-local-story-fact.v1'
    AND OLD.source_kind = 'chapter_span'
    AND substr(
          OLD.evidence_reference,
          1,
          length('direct-local:inkshadow.direct-local-story-fact.v1:')
        ) = 'direct-local:inkshadow.direct-local-story-fact.v1:'
    AND length(OLD.evidence_reference) >
      length('direct-local:inkshadow.direct-local-story-fact.v1:')
    AND OLD.source_chapter_id IS NOT NULL
    AND OLD.source_version_id IS NOT NULL
    AND OLD.source_start_offset IS NOT NULL
    AND OLD.source_end_offset IS NOT NULL
    AND OLD.source_length IS NOT NULL
    AND OLD.source_excerpt IS NOT NULL
    AND OLD.content_text IS NOT NULL
    AND OLD.status IN ('temporary', 'unconfirmed')
    AND OLD.origin = 'system'
    AND OLD.user_confirmed = 0
    AND OLD.locked = 0
    AND OLD.deprecated = 0
    AND OLD.needs_review = 1
    AND OLD.branch_id IS NULL
    AND OLD.confirmed_by_actor_id IS NULL
    AND OLD.confirmed_at IS NULL
    AND NEW.content_text IS NOT NULL
    AND NEW.status = 'formal'
    AND NEW.origin = 'user'
    AND NEW.confidence = 1.0
    AND NEW.user_confirmed = 1
    AND NEW.locked = 0
    AND NEW.deprecated = 0
    AND NEW.needs_review = 0
    AND NEW.branch_id IS NULL
    AND NEW.confirmed_by_actor_id IS NOT NULL
    AND NEW.confirmed_at = NEW.updated_at
    AND NEW.revision = OLD.revision + 1
    AND NEW.updated_at >= OLD.updated_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'story fact entity alias resolution is invalid');
END;

DROP TRIGGER IF EXISTS story_fact_user_content_revision_guard;

CREATE TRIGGER story_fact_user_content_revision_guard
BEFORE UPDATE OF content_text, confidence, origin
ON story_facts
WHEN
  (
    NEW.content_text IS NOT OLD.content_text
    OR NEW.confidence IS NOT OLD.confidence
    OR NEW.origin IS NOT OLD.origin
  )
  AND NOT (
    (
      OLD.status <> 'branch'
      AND OLD.locked = 0
      AND OLD.value_json IS NULL
      AND NEW.value_json IS NULL
      AND NEW.content_text IS NOT NULL
      AND NEW.status = 'formal'
      AND NEW.origin = 'user'
      AND NEW.confidence = 1.0
      AND NEW.user_confirmed = 1
      AND NEW.locked = 0
      AND NEW.deprecated = 0
      AND NEW.needs_review = 0
      AND NEW.branch_id IS NULL
      AND NEW.confirmed_by_actor_id IS NOT NULL
      AND NEW.confirmed_at = NEW.updated_at
      AND NEW.revision = OLD.revision + 1
      AND NEW.updated_at >= OLD.updated_at
    )
    OR
    (
      OLD.value_json IS NOT NULL
      AND NEW.value_json IS NULL
      AND json_valid(OLD.value_json)
      AND json_type(OLD.value_json) = 'object'
      AND json_extract(OLD.value_json, '$.schemaVersion') =
        'inkshadow.rebuildable-system-fact.v1'
      AND json_type(OLD.value_json, '$.payload') = 'object'
      AND json_extract(OLD.value_json, '$.payload.schemaVersion') =
        'inkshadow.direct-local-story-fact.v1'
      AND OLD.source_kind = 'chapter_span'
      AND substr(
            OLD.evidence_reference,
            1,
            length('direct-local:inkshadow.direct-local-story-fact.v1:')
          ) = 'direct-local:inkshadow.direct-local-story-fact.v1:'
      AND length(OLD.evidence_reference) >
        length('direct-local:inkshadow.direct-local-story-fact.v1:')
      AND OLD.source_chapter_id IS NOT NULL
      AND OLD.source_version_id IS NOT NULL
      AND OLD.source_start_offset IS NOT NULL
      AND OLD.source_end_offset IS NOT NULL
      AND OLD.source_length IS NOT NULL
      AND OLD.source_excerpt IS NOT NULL
      AND OLD.content_text IS NOT NULL
      AND OLD.status IN ('temporary', 'unconfirmed')
      AND OLD.origin = 'system'
      AND OLD.user_confirmed = 0
      AND OLD.locked = 0
      AND OLD.deprecated = 0
      AND OLD.needs_review = 1
      AND OLD.branch_id IS NULL
      AND OLD.confirmed_by_actor_id IS NULL
      AND OLD.confirmed_at IS NULL
      AND NEW.content_text IS NOT NULL
      AND NEW.status = 'formal'
      AND NEW.origin = 'user'
      AND NEW.confidence = 1.0
      AND NEW.user_confirmed = 1
      AND NEW.locked = 0
      AND NEW.deprecated = 0
      AND NEW.needs_review = 0
      AND NEW.branch_id IS NULL
      AND NEW.confirmed_by_actor_id IS NOT NULL
      AND NEW.confirmed_at = NEW.updated_at
      AND NEW.revision = OLD.revision + 1
      AND NEW.updated_at >= OLD.updated_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'story fact user content revision is invalid');
END;
