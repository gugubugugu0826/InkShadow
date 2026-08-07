PRAGMA foreign_keys = ON;

-- Unified story facts are authoritative user data. Existing formal records,
-- memory records, review candidates, and GraphRAG projections remain intact;
-- migration into this table is an explicit application operation.
CREATE TABLE IF NOT EXISTS story_facts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL
    CHECK (
      length(fact_type) BETWEEN 1 AND 96
      AND fact_type GLOB '[a-z]*'
      AND fact_type NOT GLOB '*[^a-z0-9_.-]*'
    ),
  content_text TEXT
    CHECK (
      content_text IS NULL
      OR (
        length(trim(content_text)) BETWEEN 1 AND 10000
        AND instr(content_text, char(0)) = 0
      )
    ),
  value_json TEXT
    CHECK (
      value_json IS NULL
      OR (
        json_valid(value_json)
        AND json_type(value_json) <> 'null'
        AND length(CAST(value_json AS BLOB)) <= 16384
      )
    ),
  source_kind TEXT NOT NULL
    CHECK (
      source_kind IN (
        'chapter_span',
        'legacy_record',
        'review_decision',
        'user_statement',
        'import_source',
        'system_derivation'
      )
    ),
  evidence_reference TEXT NOT NULL
    CHECK (
      length(trim(evidence_reference)) BETWEEN 1 AND 1000
      AND instr(evidence_reference, char(0)) = 0
    ),
  source_chapter_id TEXT
    REFERENCES chapters(id) ON DELETE RESTRICT,
  source_version_id TEXT
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_start_offset INTEGER,
  source_end_offset INTEGER,
  source_length INTEGER,
  source_excerpt TEXT
    CHECK (
      source_excerpt IS NULL
      OR (
        length(source_excerpt) BETWEEN 1 AND 2000
        AND instr(source_excerpt, char(0)) = 0
      )
    ),
  effective_at TEXT
    CHECK (
      effective_at IS NULL
      OR (
        length(trim(effective_at)) BETWEEN 1 AND 500
        AND instr(effective_at, char(0)) = 0
      )
    ),
  invalidated_at TEXT
    CHECK (
      invalidated_at IS NULL
      OR (
        length(trim(invalidated_at)) BETWEEN 1 AND 500
        AND instr(invalidated_at, char(0)) = 0
      )
    ),
  branch_id TEXT,
  confidence REAL NOT NULL
    CHECK (confidence BETWEEN 0.0 AND 1.0),
  status TEXT NOT NULL
    CHECK (status IN ('formal', 'temporary', 'unconfirmed', 'deprecated', 'branch')),
  origin TEXT NOT NULL
    CHECK (origin IN ('user', 'ai_extraction', 'import', 'legacy', 'system')),
  user_confirmed INTEGER NOT NULL
    CHECK (user_confirmed IN (0, 1)),
  locked INTEGER NOT NULL
    CHECK (locked IN (0, 1)),
  deprecated INTEGER NOT NULL
    CHECK (deprecated IN (0, 1)),
  needs_review INTEGER NOT NULL
    CHECK (needs_review IN (0, 1)),
  confirmed_by_actor_id TEXT,
  confirmed_at TEXT
    CHECK (
      confirmed_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) = confirmed_at
    ),
  revision INTEGER NOT NULL
    CHECK (revision >= 1),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (content_text IS NOT NULL OR value_json IS NOT NULL),
  CHECK (
    (
      source_kind = 'chapter_span'
      AND source_chapter_id IS NOT NULL
      AND source_version_id IS NOT NULL
      AND source_start_offset IS NOT NULL
      AND source_end_offset IS NOT NULL
      AND source_length IS NOT NULL
      AND source_excerpt IS NOT NULL
      AND source_start_offset >= 0
      AND source_end_offset > source_start_offset
      AND source_end_offset <= source_length
      AND source_length <= 5000000
    )
    OR (
      source_kind <> 'chapter_span'
      AND source_chapter_id IS NULL
      AND source_version_id IS NULL
      AND source_start_offset IS NULL
      AND source_end_offset IS NULL
      AND source_length IS NULL
      AND source_excerpt IS NULL
    )
  ),
  CHECK (
    (status = 'branch' AND branch_id IS NOT NULL)
    OR (status <> 'branch' AND branch_id IS NULL)
  ),
  CHECK (
    (status = 'deprecated' AND deprecated = 1 AND locked = 0 AND needs_review = 0)
    OR (status <> 'deprecated' AND deprecated = 0)
  ),
  CHECK (locked = 0 OR status = 'formal'),
  CHECK (
    (
      user_confirmed = 1
      AND confirmed_by_actor_id IS NOT NULL
      AND confirmed_at IS NOT NULL
    )
    OR (
      user_confirmed = 0
      AND confirmed_by_actor_id IS NULL
      AND confirmed_at IS NULL
    )
  ),
  CHECK (
    status <> 'formal'
    OR (
      user_confirmed = 1
      AND deprecated = 0
      AND needs_review = 0
      AND branch_id IS NULL
    )
  ),
  CHECK (
    status NOT IN ('temporary', 'unconfirmed', 'branch')
    OR (user_confirmed = 0 AND locked = 0)
  ),
  CHECK (
    origin <> 'ai_extraction'
    OR status IN ('formal', 'deprecated')
    OR (user_confirmed = 0 AND locked = 0 AND needs_review = 1)
  ),
  CHECK (
    origin <> 'legacy'
    OR status IN ('formal', 'deprecated')
    OR needs_review = 1
  ),
  CHECK (
    origin <> 'import'
    OR status IN ('formal', 'deprecated')
    OR needs_review = 1
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS story_facts_project_status_idx
  ON story_facts (project_id, status, fact_type, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS story_facts_review_queue_idx
  ON story_facts (project_id, needs_review, confidence, updated_at, id)
  WHERE needs_review = 1 AND deprecated = 0;

CREATE INDEX IF NOT EXISTS story_facts_source_idx
  ON story_facts (
    project_id,
    source_chapter_id,
    source_version_id,
    source_start_offset,
    id
  )
  WHERE source_chapter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS story_facts_branch_idx
  ON story_facts (project_id, branch_id, fact_type, updated_at DESC, id)
  WHERE branch_id IS NOT NULL;

-- Every validated governance change is retained as an immutable fact snapshot.
-- Version 1 is inserted by the store in the same transaction as the fact;
-- later revisions are captured by the update trigger below.
CREATE TABLE IF NOT EXISTS story_fact_revisions (
  fact_id TEXT NOT NULL
    REFERENCES story_facts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  change_kind TEXT NOT NULL
    CHECK (
      change_kind IN (
        'created',
        'legacy_backfill',
        'confirmed',
        'governance_updated',
        'deprecated'
      )
    ),
  recorded_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  PRIMARY KEY (fact_id, revision)
);

CREATE INDEX IF NOT EXISTS story_fact_revisions_project_idx
  ON story_fact_revisions (project_id, recorded_at DESC, fact_id, revision DESC);

-- This table is a compatibility ledger, never an instruction to delete or
-- rewrite a legacy row. Backfill links are accepted only while the new fact is
-- still unconfirmed and visibly queued for review.
CREATE TABLE IF NOT EXISTS story_fact_legacy_links (
  fact_id TEXT NOT NULL
    REFERENCES story_facts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  legacy_kind TEXT NOT NULL
    CHECK (legacy_kind IN ('formal_record', 'memory_record')),
  legacy_id TEXT NOT NULL,
  legacy_revision INTEGER NOT NULL CHECK (legacy_revision >= 1),
  link_mode TEXT NOT NULL CHECK (link_mode IN ('reference', 'backfill')),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (legacy_kind, legacy_id, legacy_revision),
  UNIQUE (fact_id)
);

CREATE INDEX IF NOT EXISTS story_fact_legacy_links_project_idx
  ON story_fact_legacy_links (project_id, legacy_kind, legacy_id);

-- SQLite text offsets do not share JavaScript's UTF-16 semantics. The trigger
-- validates ownership; the repository validates source length and exact quote.
CREATE TRIGGER IF NOT EXISTS story_fact_chapter_source_insert_guard
BEFORE INSERT ON story_facts
WHEN NEW.source_kind = 'chapter_span'
AND NOT EXISTS (
  SELECT 1
  FROM chapter_versions AS version
  INNER JOIN chapters AS chapter ON chapter.id = version.chapter_id
  WHERE version.id = NEW.source_version_id
    AND version.chapter_id = NEW.source_chapter_id
    AND version.project_id = NEW.project_id
    AND chapter.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'story fact chapter evidence binding is invalid');
END;

-- A new non-user source can become formal only through a later explicit
-- confirm transition. Re-inserting an already-versioned fact is permitted so
-- the verified backup/restore path can reproduce revision >= 2 state.
CREATE TRIGGER IF NOT EXISTS story_fact_non_user_formal_insert_guard
BEFORE INSERT ON story_facts
WHEN NEW.status = 'formal' AND NEW.origin <> 'user' AND NEW.revision = 1
BEGIN
  SELECT RAISE(ABORT, 'non-user story fact requires a separate confirmation transition');
END;

CREATE TRIGGER IF NOT EXISTS story_fact_identity_immutable
BEFORE UPDATE OF
  id,
  project_id,
  fact_type,
  content_text,
  value_json,
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

CREATE TRIGGER IF NOT EXISTS story_fact_governance_transition_guard
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
  OR OLD.status = 'deprecated'
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
BEGIN
  SELECT RAISE(ABORT, 'story fact governance transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS story_fact_revision_capture
AFTER UPDATE ON story_facts
BEGIN
  INSERT INTO story_fact_revisions (
    fact_id,
    project_id,
    revision,
    change_kind,
    recorded_at,
    snapshot_json
  ) VALUES (
    NEW.id,
    NEW.project_id,
    NEW.revision,
    CASE
      WHEN NEW.status = 'formal' AND OLD.status <> 'formal' THEN 'confirmed'
      WHEN NEW.status = 'deprecated' AND OLD.status <> 'deprecated' THEN 'deprecated'
      ELSE 'governance_updated'
    END,
    NEW.updated_at,
    json_object(
      'id', NEW.id,
      'projectId', NEW.project_id,
      'factType', NEW.fact_type,
      'contentText', NEW.content_text,
      'structuredValue', CASE
        WHEN NEW.value_json IS NULL THEN NULL
        ELSE json(NEW.value_json)
      END,
      'source', json_object(
        'kind', NEW.source_kind,
        'reference', NEW.evidence_reference,
        'chapterId', NEW.source_chapter_id,
        'versionId', NEW.source_version_id,
        'startOffset', NEW.source_start_offset,
        'endOffset', NEW.source_end_offset,
        'sourceLength', NEW.source_length,
        'excerpt', NEW.source_excerpt
      ),
      'effectiveAt', NEW.effective_at,
      'invalidatedAt', NEW.invalidated_at,
      'branchId', NEW.branch_id,
      'confidence', NEW.confidence,
      'status', NEW.status,
      'origin', NEW.origin,
      'userConfirmed', json(CASE NEW.user_confirmed WHEN 1 THEN 'true' ELSE 'false' END),
      'locked', json(CASE NEW.locked WHEN 1 THEN 'true' ELSE 'false' END),
      'deprecated', json(CASE NEW.deprecated WHEN 1 THEN 'true' ELSE 'false' END),
      'needsReview', json(CASE NEW.needs_review WHEN 1 THEN 'true' ELSE 'false' END),
      'confirmedByActorId', NEW.confirmed_by_actor_id,
      'confirmedAt', NEW.confirmed_at,
      'revision', NEW.revision,
      'createdAt', NEW.created_at,
      'updatedAt', NEW.updated_at
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS story_fact_revision_immutable
BEFORE UPDATE ON story_fact_revisions
BEGIN
  SELECT RAISE(ABORT, 'story fact revision history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS story_fact_legacy_link_immutable
BEFORE UPDATE ON story_fact_legacy_links
BEGIN
  SELECT RAISE(ABORT, 'story fact legacy link is immutable');
END;

CREATE TRIGGER IF NOT EXISTS story_fact_legacy_backfill_guard
BEFORE INSERT ON story_fact_legacy_links
WHEN NEW.link_mode = 'backfill'
AND NOT EXISTS (
  SELECT 1
  FROM story_facts AS fact
  WHERE fact.id = NEW.fact_id
    AND fact.project_id = NEW.project_id
    AND fact.origin = 'legacy'
    AND (
      (
        fact.status = 'unconfirmed'
        AND fact.user_confirmed = 0
        AND fact.locked = 0
        AND fact.deprecated = 0
        AND fact.needs_review = 1
      )
      OR (
        fact.status = 'formal'
        AND fact.revision >= 2
        AND fact.user_confirmed = 1
        AND fact.deprecated = 0
        AND fact.needs_review = 0
      )
      OR (
        fact.status = 'deprecated'
        AND fact.revision >= 2
        AND fact.locked = 0
        AND fact.deprecated = 1
        AND fact.needs_review = 0
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'legacy backfill must remain an unconfirmed review item');
END;
