PRAGMA foreign_keys = ON;

-- GraphRAG is a local, derived projection. These tables never own formal
-- chapter/story content and may be atomically rebuilt from authoritative
-- sources after corruption or a schema change.
CREATE TABLE IF NOT EXISTS graph_rag_projection_state (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version = 1),
  revision INTEGER NOT NULL
    CHECK (revision >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'paused', 'corrupt')),
  source_version_count INTEGER NOT NULL
    CHECK (source_version_count BETWEEN 0 AND 1000000),
  entity_count INTEGER NOT NULL
    CHECK (entity_count BETWEEN 0 AND 1000000),
  relation_count INTEGER NOT NULL
    CHECK (relation_count BETWEEN 0 AND 5000000),
  evidence_count INTEGER NOT NULL
    CHECK (evidence_count BETWEEN 0 AND 50000000),
  last_rebuilt_at TEXT
    CHECK (
      last_rebuilt_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', last_rebuilt_at) = last_rebuilt_at
    ),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (length(project_id) BETWEEN 1 AND 256 AND project_id = trim(project_id)),
  CHECK (last_rebuilt_at IS NULL OR last_rebuilt_at <= updated_at)
);

CREATE INDEX IF NOT EXISTS graph_rag_projection_state_status_idx
  ON graph_rag_projection_state (status, updated_at, project_id);

CREATE TABLE IF NOT EXISTS graph_rag_source_versions (
  project_id TEXT NOT NULL
    REFERENCES graph_rag_projection_state(project_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('current', 'superseded', 'deleted')),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  invalidated_at TEXT
    CHECK (
      invalidated_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at
    ),
  PRIMARY KEY (project_id, source_id, source_version_id),
  UNIQUE (project_id, source_id, source_version_id, content_hash),
  CHECK (length(source_id) BETWEEN 1 AND 256 AND source_id = trim(source_id)),
  CHECK (
    length(source_version_id) BETWEEN 1 AND 256
    AND source_version_id = trim(source_version_id)
  ),
  CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(content) BETWEEN 1 AND 2000000),
  CHECK (
    (state = 'current' AND invalidated_at IS NULL)
    OR (
      state IN ('superseded', 'deleted')
      AND invalidated_at IS NOT NULL
      AND invalidated_at >= created_at
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS graph_rag_source_current_unique
  ON graph_rag_source_versions (project_id, source_id)
  WHERE state = 'current';

CREATE INDEX IF NOT EXISTS graph_rag_source_versions_created_idx
  ON graph_rag_source_versions (
    project_id,
    source_id,
    created_at,
    source_version_id
  );

CREATE INDEX IF NOT EXISTS graph_rag_source_versions_state_idx
  ON graph_rag_source_versions (
    project_id,
    state,
    invalidated_at,
    source_id,
    source_version_id
  );

CREATE TABLE IF NOT EXISTS graph_rag_entities (
  project_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  document_id TEXT,
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  deleted_at TEXT
    CHECK (
      deleted_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at
    ),
  PRIMARY KEY (project_id, entity_id),
  FOREIGN KEY (
    project_id,
    source_id,
    source_version_id,
    source_content_hash
  ) REFERENCES graph_rag_source_versions (
    project_id,
    source_id,
    source_version_id,
    content_hash
  ) ON DELETE CASCADE,
  CHECK (length(entity_id) BETWEEN 1 AND 256 AND entity_id = trim(entity_id)),
  CHECK (length(kind) BETWEEN 1 AND 256 AND kind = trim(kind)),
  CHECK (length(trim(label)) BETWEEN 1 AND 500),
  CHECK (
    document_id IS NULL
    OR (length(document_id) BETWEEN 1 AND 256 AND document_id = trim(document_id))
  ),
  CHECK (deleted_at IS NULL OR deleted_at >= updated_at)
);

CREATE INDEX IF NOT EXISTS graph_rag_entities_source_idx
  ON graph_rag_entities (
    project_id,
    source_id,
    source_version_id,
    entity_id
  );

CREATE INDEX IF NOT EXISTS graph_rag_entities_active_idx
  ON graph_rag_entities (project_id, kind, label, entity_id)
  WHERE deleted_at IS NULL;

-- Relation identifiers retain their semantic binding across full projection
-- rebuilds. This small derived ledger prevents an old identifier from being
-- silently rebound after its relation row has disappeared from a rebuild.
CREATE TABLE IF NOT EXISTS graph_rag_relation_identities (
  project_id TEXT NOT NULL
    REFERENCES graph_rag_projection_state(project_id) ON DELETE CASCADE,
  relation_id TEXT NOT NULL,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  polarity TEXT NOT NULL
    CHECK (polarity IN ('affirmed', 'negated')),
  first_seen_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_at) = first_seen_at),
  PRIMARY KEY (project_id, relation_id),
  UNIQUE (
    project_id,
    relation_id,
    from_entity_id,
    to_entity_id,
    kind,
    polarity
  ),
  CHECK (length(relation_id) BETWEEN 1 AND 256 AND relation_id = trim(relation_id)),
  CHECK (from_entity_id <> to_entity_id),
  CHECK (length(kind) BETWEEN 1 AND 256 AND kind = trim(kind))
);

CREATE TABLE IF NOT EXISTS graph_rag_relations (
  project_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  polarity TEXT NOT NULL
    CHECK (polarity IN ('affirmed', 'negated')),
  confidence REAL NOT NULL
    CHECK (confidence > 0 AND confidence <= 1),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  deleted_at TEXT
    CHECK (
      deleted_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at
    ),
  PRIMARY KEY (project_id, relation_id),
  FOREIGN KEY (project_id, from_entity_id)
    REFERENCES graph_rag_entities(project_id, entity_id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_entity_id)
    REFERENCES graph_rag_entities(project_id, entity_id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    project_id,
    relation_id,
    from_entity_id,
    to_entity_id,
    kind,
    polarity
  ) REFERENCES graph_rag_relation_identities (
    project_id,
    relation_id,
    from_entity_id,
    to_entity_id,
    kind,
    polarity
  ) ON DELETE CASCADE,
  CHECK (length(relation_id) BETWEEN 1 AND 256 AND relation_id = trim(relation_id)),
  CHECK (from_entity_id <> to_entity_id),
  CHECK (length(kind) BETWEEN 1 AND 256 AND kind = trim(kind)),
  CHECK (deleted_at IS NULL OR deleted_at >= updated_at)
);

CREATE INDEX IF NOT EXISTS graph_rag_relations_outgoing_idx
  ON graph_rag_relations (
    project_id,
    from_entity_id,
    kind,
    confidence DESC,
    relation_id
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS graph_rag_relations_incoming_idx
  ON graph_rag_relations (
    project_id,
    to_entity_id,
    kind,
    confidence DESC,
    relation_id
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS graph_rag_relations_semantic_idx
  ON graph_rag_relations (
    project_id,
    from_entity_id,
    kind,
    to_entity_id,
    polarity,
    relation_id
  );

CREATE TABLE IF NOT EXISTS graph_rag_relation_evidence (
  project_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 99),
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  span_start_offset INTEGER NOT NULL
    CHECK (span_start_offset >= 0),
  span_end_offset INTEGER NOT NULL
    CHECK (
      span_end_offset > span_start_offset
      AND span_end_offset - span_start_offset <= 20000
    ),
  span_encoding TEXT NOT NULL
    CHECK (span_encoding = 'utf16'),
  quote TEXT NOT NULL,
  span_hash TEXT NOT NULL,
  citation_label TEXT NOT NULL,
  citation_locator TEXT NOT NULL,
  PRIMARY KEY (project_id, evidence_id),
  UNIQUE (project_id, relation_id, ordinal),
  FOREIGN KEY (project_id, relation_id)
    REFERENCES graph_rag_relations(project_id, relation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    project_id,
    source_id,
    source_version_id,
    source_content_hash
  ) REFERENCES graph_rag_source_versions (
    project_id,
    source_id,
    source_version_id,
    content_hash
  ) ON DELETE CASCADE,
  CHECK (length(evidence_id) BETWEEN 1 AND 256 AND evidence_id = trim(evidence_id)),
  CHECK (length(quote) BETWEEN 1 AND 20000),
  CHECK (
    length(span_hash) = 24
    AND substr(span_hash, 1, 8) = 'fnv1a64:'
    AND substr(span_hash, 9) = lower(substr(span_hash, 9))
    AND substr(span_hash, 9) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(trim(citation_label)) BETWEEN 1 AND 500),
  CHECK (length(trim(citation_locator)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS graph_rag_evidence_relation_idx
  ON graph_rag_relation_evidence (
    project_id,
    relation_id,
    ordinal,
    evidence_id
  );

CREATE INDEX IF NOT EXISTS graph_rag_evidence_source_idx
  ON graph_rag_relation_evidence (
    project_id,
    source_id,
    source_version_id,
    span_start_offset,
    evidence_id
  );

-- SQLite text functions use Unicode code points, while persisted evidence
-- offsets are JavaScript UTF-16 code-unit offsets. Exact quote/span matching
-- is therefore deliberately enforced by the TypeScript repository, never by
-- substr()/length() SQL comparisons.

CREATE TRIGGER IF NOT EXISTS graph_rag_source_identity_immutable
BEFORE UPDATE OF
  project_id,
  source_id,
  source_version_id,
  content_hash,
  content,
  created_at
ON graph_rag_source_versions
BEGIN
  SELECT RAISE(ABORT, 'graph source versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS graph_rag_source_state_monotonic
BEFORE UPDATE OF state, invalidated_at
ON graph_rag_source_versions
WHEN
  (old.state = 'deleted' AND (
    new.state <> old.state OR new.invalidated_at <> old.invalidated_at
  ))
  OR (old.state = 'superseded' AND new.state = 'current')
  OR (
    old.invalidated_at IS NOT NULL
    AND new.invalidated_at IS NOT NULL
    AND new.invalidated_at < old.invalidated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'graph source state cannot move backwards');
END;

CREATE TRIGGER IF NOT EXISTS graph_rag_relation_identity_immutable
BEFORE UPDATE OF
  project_id,
  relation_id,
  from_entity_id,
  to_entity_id,
  kind,
  polarity
ON graph_rag_relations
BEGIN
  SELECT RAISE(ABORT, 'graph relation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS graph_rag_relation_ledger_immutable
BEFORE UPDATE ON graph_rag_relation_identities
BEGIN
  SELECT RAISE(ABORT, 'graph relation identity ledger is immutable');
END;
