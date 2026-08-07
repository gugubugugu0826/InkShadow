PRAGMA foreign_keys = ON;

-- One immutable source span may support an event, a state change, a
-- prerequisite, or a causal relation. Keeping the span normalized lets every
-- graph assertion require evidence without duplicating the original text.
CREATE TABLE IF NOT EXISTS causal_evidence_sources (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE RESTRICT,
  chapter_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL
    CHECK (
      length(content_hash) = 64
      AND content_hash = lower(content_hash)
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
  locator TEXT NOT NULL
    CHECK (
      length(trim(locator)) BETWEEN 1 AND 2000
      AND instr(locator, char(0)) = 0
    ),
  excerpt TEXT NOT NULL
    CHECK (
      length(excerpt) BETWEEN 1 AND 20000
      AND instr(excerpt, char(0)) = 0
    ),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  source_length INTEGER NOT NULL
    CHECK (source_length BETWEEN 1 AND 5000000),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (end_offset <= source_length),
  UNIQUE (id, project_id)
);

CREATE INDEX IF NOT EXISTS causal_evidence_source_version_idx
  ON causal_evidence_sources (
    project_id,
    chapter_id,
    chapter_version_id,
    start_offset,
    id
  );

-- SQLite and JavaScript count some Unicode offsets differently. This trigger
-- validates ownership; the domain/repository boundary validates the exact
-- UTF-16 range, excerpt, source length, and content hash.
CREATE TRIGGER IF NOT EXISTS causal_evidence_source_binding_guard
BEFORE INSERT ON causal_evidence_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM chapter_versions AS version
  INNER JOIN chapters AS chapter ON chapter.id = version.chapter_id
  WHERE version.id = NEW.chapter_version_id
    AND version.chapter_id = NEW.chapter_id
    AND version.project_id = NEW.project_id
    AND chapter.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'causal evidence chapter-version binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS causal_evidence_source_immutable
BEFORE UPDATE ON causal_evidence_sources
BEGIN
  SELECT RAISE(ABORT, 'causal evidence source is immutable');
END;

CREATE TABLE IF NOT EXISTS causal_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL
    CHECK (
      length(trim(branch_id)) BETWEEN 1 AND 512
      AND branch_id = trim(branch_id)
      AND instr(branch_id, ' ') = 0
      AND instr(branch_id, char(9)) = 0
      AND instr(branch_id, char(10)) = 0
      AND instr(branch_id, char(13)) = 0
    ),
  status TEXT NOT NULL CHECK (status = 'confirmed'),
  narrative_order INTEGER NOT NULL
    CHECK (narrative_order BETWEEN -1000000000000 AND 1000000000000),
  narrative_label TEXT NOT NULL
    CHECK (
      length(trim(narrative_label)) BETWEEN 1 AND 20000
      AND instr(narrative_label, char(0)) = 0
    ),
  location_id TEXT NOT NULL
    CHECK (length(trim(location_id)) BETWEEN 1 AND 512),
  location_label TEXT NOT NULL
    CHECK (
      length(trim(location_label)) BETWEEN 1 AND 20000
      AND instr(location_label, char(0)) = 0
    ),
  event_text TEXT NOT NULL
    CHECK (
      length(trim(event_text)) BETWEEN 1 AND 200000
      AND instr(event_text, char(0)) = 0
    ),
  result_text TEXT NOT NULL
    CHECK (
      length(trim(result_text)) BETWEEN 1 AND 200000
      AND instr(result_text, char(0)) = 0
    ),
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (updated_at >= created_at),
  UNIQUE (id, project_id, branch_id),
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_events_project_branch_order_idx
  ON causal_events (project_id, branch_id, narrative_order, id);

CREATE INDEX IF NOT EXISTS causal_events_location_idx
  ON causal_events (project_id, branch_id, location_id, narrative_order, id);

CREATE TABLE IF NOT EXISTS causal_event_participants (
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  character_id TEXT NOT NULL
    CHECK (length(trim(character_id)) BETWEEN 1 AND 512),
  PRIMARY KEY (event_id, character_id),
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS causal_event_participants_character_idx
  ON causal_event_participants (project_id, branch_id, character_id, event_id);

CREATE TABLE IF NOT EXISTS causal_event_prerequisites (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  prerequisite_kind TEXT NOT NULL
    CHECK (prerequisite_kind IN ('event', 'state', 'rule')),
  reference_id TEXT NOT NULL
    CHECK (length(trim(reference_id)) BETWEEN 1 AND 512),
  referenced_event_id TEXT,
  description TEXT NOT NULL
    CHECK (
      length(trim(description)) BETWEEN 1 AND 20000
      AND instr(description, char(0)) = 0
    ),
  evidence_id TEXT NOT NULL,
  CHECK (
    (
      prerequisite_kind = 'event'
      AND referenced_event_id IS NOT NULL
      AND referenced_event_id = reference_id
      AND referenced_event_id <> event_id
    )
    OR (
      prerequisite_kind IN ('state', 'rule')
      AND referenced_event_id IS NULL
    )
  ),
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (referenced_event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_event_prerequisites_event_idx
  ON causal_event_prerequisites (project_id, branch_id, event_id, prerequisite_kind, id);

CREATE TABLE IF NOT EXISTS causal_event_character_changes (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  character_id TEXT NOT NULL
    CHECK (length(trim(character_id)) BETWEEN 1 AND 512),
  attribute_key TEXT NOT NULL
    CHECK (length(trim(attribute_key)) BETWEEN 1 AND 512),
  before_value_json TEXT NOT NULL
    CHECK (
      json_valid(before_value_json)
      AND json_type(before_value_json) IN ('null', 'text', 'integer', 'real', 'true', 'false')
      AND length(CAST(before_value_json AS BLOB)) <= 16384
    ),
  after_value_json TEXT NOT NULL
    CHECK (
      json_valid(after_value_json)
      AND json_type(after_value_json) IN ('null', 'text', 'integer', 'real', 'true', 'false')
      AND length(CAST(after_value_json AS BLOB)) <= 16384
    ),
  evidence_id TEXT NOT NULL,
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_event_character_changes_subject_idx
  ON causal_event_character_changes (
    project_id,
    branch_id,
    character_id,
    attribute_key,
    event_id
  );

CREATE TABLE IF NOT EXISTS causal_event_relationship_changes (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  from_character_id TEXT NOT NULL
    CHECK (length(trim(from_character_id)) BETWEEN 1 AND 512),
  to_character_id TEXT NOT NULL
    CHECK (
      length(trim(to_character_id)) BETWEEN 1 AND 512
      AND to_character_id <> from_character_id
    ),
  relationship_key TEXT NOT NULL
    CHECK (length(trim(relationship_key)) BETWEEN 1 AND 512),
  before_value_json TEXT NOT NULL
    CHECK (
      json_valid(before_value_json)
      AND json_type(before_value_json) IN ('null', 'text', 'integer', 'real', 'true', 'false')
      AND length(CAST(before_value_json AS BLOB)) <= 16384
    ),
  after_value_json TEXT NOT NULL
    CHECK (
      json_valid(after_value_json)
      AND json_type(after_value_json) IN ('null', 'text', 'integer', 'real', 'true', 'false')
      AND length(CAST(after_value_json AS BLOB)) <= 16384
    ),
  evidence_id TEXT NOT NULL,
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_event_relationship_changes_pair_idx
  ON causal_event_relationship_changes (
    project_id,
    branch_id,
    from_character_id,
    to_character_id,
    relationship_key,
    event_id
  );

CREATE TABLE IF NOT EXISTS causal_event_item_changes (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  item_id TEXT NOT NULL
    CHECK (length(trim(item_id)) BETWEEN 1 AND 512),
  change_kind TEXT NOT NULL
    CHECK (change_kind IN ('acquired', 'lost', 'transferred', 'created', 'destroyed')),
  from_character_id TEXT,
  to_character_id TEXT,
  evidence_id TEXT NOT NULL,
  CHECK (from_character_id IS NULL OR length(trim(from_character_id)) BETWEEN 1 AND 512),
  CHECK (to_character_id IS NULL OR length(trim(to_character_id)) BETWEEN 1 AND 512),
  CHECK (
    (change_kind = 'acquired' AND from_character_id IS NULL AND to_character_id IS NOT NULL)
    OR (change_kind = 'lost' AND from_character_id IS NOT NULL AND to_character_id IS NULL)
    OR (
      change_kind = 'transferred'
      AND from_character_id IS NOT NULL
      AND to_character_id IS NOT NULL
      AND from_character_id <> to_character_id
    )
    OR (change_kind = 'created' AND from_character_id IS NULL)
    OR (change_kind = 'destroyed' AND to_character_id IS NULL)
  ),
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_event_item_changes_item_idx
  ON causal_event_item_changes (project_id, branch_id, item_id, event_id);

CREATE TABLE IF NOT EXISTS causal_event_informed_characters (
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  character_id TEXT NOT NULL
    CHECK (length(trim(character_id)) BETWEEN 1 AND 512),
  PRIMARY KEY (event_id, character_id),
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS causal_event_informed_characters_subject_idx
  ON causal_event_informed_characters (project_id, branch_id, character_id, event_id);

CREATE TABLE IF NOT EXISTS causal_event_foreshadow_progress (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  foreshadow_id TEXT NOT NULL
    CHECK (length(trim(foreshadow_id)) BETWEEN 1 AND 512),
  progress_kind TEXT NOT NULL
    CHECK (progress_kind IN ('planted', 'advanced', 'revealed', 'resolved', 'misdirected')),
  description TEXT NOT NULL
    CHECK (
      length(trim(description)) BETWEEN 1 AND 20000
      AND instr(description, char(0)) = 0
    ),
  evidence_id TEXT NOT NULL,
  FOREIGN KEY (event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_event_foreshadow_progress_subject_idx
  ON causal_event_foreshadow_progress (
    project_id,
    branch_id,
    foreshadow_id,
    event_id
  );

CREATE TABLE IF NOT EXISTS causal_event_relations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  from_event_id TEXT NOT NULL,
  to_event_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL
    CHECK (
      relation_kind IN (
        'causes',
        'depends_on',
        'prevents',
        'reveals',
        'misleads',
        'before',
        'changes_state',
        'gains_information',
        'loses_item'
      )
    ),
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (from_event_id <> to_event_id),
  UNIQUE (project_id, branch_id, from_event_id, to_event_id, relation_kind),
  FOREIGN KEY (from_event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (to_event_id, project_id, branch_id)
    REFERENCES causal_events(id, project_id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, project_id)
    REFERENCES causal_evidence_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS causal_event_relations_outgoing_idx
  ON causal_event_relations (
    project_id,
    branch_id,
    from_event_id,
    relation_kind,
    to_event_id,
    id
  );

CREATE INDEX IF NOT EXISTS causal_event_relations_incoming_idx
  ON causal_event_relations (
    project_id,
    branch_id,
    to_event_id,
    relation_kind,
    from_event_id,
    id
  );

CREATE TRIGGER IF NOT EXISTS causal_event_before_order_guard
BEFORE INSERT ON causal_event_relations
WHEN NEW.relation_kind = 'before'
AND NOT EXISTS (
  SELECT 1
  FROM causal_events AS source
  INNER JOIN causal_events AS target
    ON target.id = NEW.to_event_id
   AND target.project_id = NEW.project_id
   AND target.branch_id = NEW.branch_id
  WHERE source.id = NEW.from_event_id
    AND source.project_id = NEW.project_id
    AND source.branch_id = NEW.branch_id
    AND source.narrative_order < target.narrative_order
)
BEGIN
  SELECT RAISE(ABORT, 'causal before relation must follow narrative order');
END;

-- Downstream impacts are derived from evidence-backed relations. A bare
-- temporal `before` edge is not sufficient to claim What-if impact.
CREATE VIEW IF NOT EXISTS causal_event_downstream_impacts AS
SELECT
  project_id,
  branch_id,
  from_event_id AS source_event_id,
  to_event_id AS downstream_event_id,
  id AS relation_id,
  relation_kind,
  evidence_id
FROM causal_event_relations
WHERE relation_kind <> 'before';
