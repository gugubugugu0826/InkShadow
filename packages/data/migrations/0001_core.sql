PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'trashed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deletion_generation INTEGER NOT NULL DEFAULT 0
    CHECK (deletion_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  trashed_at TEXT,
  retention_until TEXT,
  status_before_trash TEXT
    CHECK (status_before_trash IS NULL OR status_before_trash IN ('active', 'archived')),
  CHECK (
    (
      status = 'active'
      AND archived_at IS NULL
      AND trashed_at IS NULL
      AND retention_until IS NULL
      AND status_before_trash IS NULL
    )
    OR (
      status = 'archived'
      AND archived_at IS NOT NULL
      AND trashed_at IS NULL
      AND retention_until IS NULL
      AND status_before_trash IS NULL
    )
    OR (
      status = 'trashed'
      AND trashed_at IS NOT NULL
      AND retention_until IS NOT NULL
      AND status_before_trash IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS projects_status_updated_idx
  ON projects (status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS projects_visible_name_unique
  ON projects (lower(name))
  WHERE status <> 'trashed';

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  content TEXT NOT NULL DEFAULT ''
    CHECK (length(content) <= 5000000 AND instr(content, char(0)) = 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trashed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  current_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id)
    DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  CHECK (
    (status = 'active' AND trashed_at IS NULL)
    OR (status = 'trashed' AND trashed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS chapters_project_updated_idx
  ON chapters (project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chapter_versions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  parent_version_id TEXT
    REFERENCES chapter_versions(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  content TEXT NOT NULL
    CHECK (length(content) <= 5000000 AND instr(content, char(0)) = 0),
  content_checksum TEXT NOT NULL
    CHECK (length(content_checksum) = 64),
  reason TEXT NOT NULL
    CHECK (
      reason IN (
        'created',
        'autosave',
        'manual',
        'candidate_accept',
        'recovery',
        'import'
      )
    ),
  source_candidate_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (sequence = 1 AND parent_version_id IS NULL)
    OR (sequence > 1 AND parent_version_id IS NOT NULL)
  ),
  CHECK (
    (reason = 'candidate_accept' AND source_candidate_id IS NOT NULL)
    OR (reason <> 'candidate_accept' AND source_candidate_id IS NULL)
  ),
  UNIQUE (chapter_id, sequence)
);

CREATE INDEX IF NOT EXISTS chapter_versions_chapter_idx
  ON chapter_versions (chapter_id, sequence DESC);

CREATE TABLE IF NOT EXISTS recovery_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
  content TEXT NOT NULL
    CHECK (length(content) <= 5000000 AND instr(content, char(0)) = 0),
  cursor_offset INTEGER NOT NULL
    CHECK (
      cursor_offset >= 0
      AND cursor_offset <= length(CAST(content AS BLOB))
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chapter_id)
);

CREATE TABLE IF NOT EXISTS ai_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT
    REFERENCES chapters(id) ON DELETE CASCADE,
  source TEXT NOT NULL
    CHECK (source IN ('generate', 'polish', 'extract', 'whatif', 'agent')),
  base_version_id TEXT
    REFERENCES chapter_versions(id),
  content TEXT NOT NULL
    CHECK (length(content) <= 5000000 AND instr(content, char(0)) = 0),
  content_checksum TEXT
    CHECK (content_checksum IS NULL OR length(content_checksum) = 64),
  status TEXT NOT NULL
    CHECK (status IN ('streaming', 'ready', 'accepted', 'rejected', 'expired')),
  incomplete INTEGER NOT NULL DEFAULT 0
    CHECK (incomplete IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK (chapter_id IS NULL OR base_version_id IS NOT NULL),
  CHECK (
    status = 'streaming'
    OR (length(content) > 0 AND content_checksum IS NOT NULL)
  ),
  CHECK (
    (status IN ('streaming', 'ready') AND decided_at IS NULL)
    OR (status IN ('accepted', 'rejected', 'expired') AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_candidates_chapter_status_idx
  ON ai_candidates (chapter_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS local_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT
    REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS local_audit_events_entity_idx
  ON local_audit_events (entity_type, entity_id, created_at DESC);
