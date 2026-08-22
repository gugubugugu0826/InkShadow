PRAGMA foreign_keys = ON;

-- Author-facing content may now be revised only through an explicit,
-- user-confirmed CAS transition. Fact identity, source evidence, structured
-- evidence, narrative-time bindings and creation identity remain immutable.
DROP TRIGGER IF EXISTS story_fact_identity_immutable;

CREATE TRIGGER story_fact_identity_immutable
BEFORE UPDATE OF
  id,
  project_id,
  fact_type,
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
  created_at
ON story_facts
BEGIN
  SELECT RAISE(ABORT, 'story fact identity and evidence are immutable');
END;

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
BEGIN
  SELECT RAISE(ABORT, 'story fact user content revision is invalid');
END;

DROP TRIGGER IF EXISTS story_fact_governance_transition_guard;

CREATE TRIGGER story_fact_governance_transition_guard
BEFORE UPDATE OF
  status,
  user_confirmed,
  locked,
  deprecated,
  needs_review,
  confirmed_by_actor_id,
  confirmed_at,
  revision,
  updated_at
ON story_facts
WHEN
  NEW.revision <> OLD.revision + 1
  OR NEW.updated_at < OLD.updated_at
  OR (
    NOT (
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
    AND NOT (
      OLD.status = 'deprecated'
      AND OLD.deprecated = 1
      AND OLD.user_confirmed = 1
      AND NEW.content_text IS OLD.content_text
      AND NEW.value_json IS OLD.value_json
      AND NEW.confidence IS OLD.confidence
      AND NEW.origin IS OLD.origin
      AND NEW.status = 'formal'
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
    AND (
      OLD.status = 'deprecated'
      OR (OLD.user_confirmed = 1 AND NEW.user_confirmed <> 1)
      OR (
        OLD.user_confirmed = 1
        AND (
          NEW.confirmed_by_actor_id <> OLD.confirmed_by_actor_id
          OR NEW.confirmed_at <> OLD.confirmed_at
        )
      )
      OR (
        NEW.status = 'formal'
        AND OLD.status NOT IN ('temporary', 'unconfirmed', 'formal')
      )
      OR (
        OLD.status = 'formal'
        AND NEW.status NOT IN ('formal', 'deprecated')
      )
      OR (OLD.status = 'branch' AND NEW.status <> 'branch')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'story fact governance transition is invalid');
END;
