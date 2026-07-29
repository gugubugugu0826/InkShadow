PRAGMA foreign_keys = ON;

-- Search data is a local, derived projection. It is never the authoritative
-- copy of chapter or outline content and may be deleted and rebuilt at any
-- time without affecting source records.
CREATE TABLE IF NOT EXISTS search_index_state (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version = 1),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  document_count INTEGER NOT NULL DEFAULT 0
    CHECK (document_count BETWEEN 0 AND 100000),
  content_characters INTEGER NOT NULL DEFAULT 0
    CHECK (content_characters BETWEEN 0 AND 64000000),
  indexed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(project_id) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS search_index_state_updated_idx
  ON search_index_state (updated_at DESC, project_id ASC);

CREATE TABLE IF NOT EXISTS search_index_documents (
  project_id TEXT NOT NULL
    REFERENCES search_index_state(project_id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  source_type TEXT NOT NULL
    CHECK (
      source_type IN (
        'chapter',
        'outline',
        'character',
        'world',
        'foreshadow',
        'material',
        'memory'
      )
    ),
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  search_text TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  normalized_search_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0
    CHECK (importance BETWEEN 0 AND 1),
  pinned INTEGER NOT NULL DEFAULT 0
    CHECK (pinned IN (0, 1)),
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, document_id),
  CHECK (length(document_id) BETWEEN 1 AND 256),
  CHECK (length(source_id) BETWEEN 1 AND 256),
  CHECK (length(source_version_id) BETWEEN 1 AND 256),
  CHECK (length(trim(title)) BETWEEN 1 AND 500),
  CHECK (length(search_text) <= 2000000),
  CHECK (length(normalized_title) BETWEEN 1 AND 2000),
  CHECK (length(normalized_search_text) <= 4000000),
  CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX IF NOT EXISTS search_index_documents_source_idx
  ON search_index_documents (
    project_id,
    source_type,
    source_id,
    document_id
  );

CREATE INDEX IF NOT EXISTS search_index_documents_version_idx
  ON search_index_documents (
    project_id,
    source_version_id,
    content_hash
  );

CREATE INDEX IF NOT EXISTS search_index_documents_updated_idx
  ON search_index_documents (
    project_id,
    source_updated_at DESC,
    document_id ASC
  );

-- External-content FTS keeps the source rows inspectable and lets a damaged
-- FTS projection be rebuilt from search_index_documents without touching
-- chapters or outlines.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
  normalized_title,
  normalized_search_text,
  content = 'search_index_documents',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS search_index_documents_fts_insert
AFTER INSERT ON search_index_documents
BEGIN
  INSERT INTO search_index_fts (
    rowid,
    normalized_title,
    normalized_search_text
  ) VALUES (
    new.rowid,
    new.normalized_title,
    new.normalized_search_text
  );
END;

CREATE TRIGGER IF NOT EXISTS search_index_documents_fts_delete
AFTER DELETE ON search_index_documents
BEGIN
  INSERT INTO search_index_fts (
    search_index_fts,
    rowid,
    normalized_title,
    normalized_search_text
  ) VALUES (
    'delete',
    old.rowid,
    old.normalized_title,
    old.normalized_search_text
  );
END;

CREATE TRIGGER IF NOT EXISTS search_index_documents_fts_update
AFTER UPDATE OF normalized_title, normalized_search_text ON search_index_documents
BEGIN
  INSERT INTO search_index_fts (
    search_index_fts,
    rowid,
    normalized_title,
    normalized_search_text
  ) VALUES (
    'delete',
    old.rowid,
    old.normalized_title,
    old.normalized_search_text
  );
  INSERT INTO search_index_fts (
    rowid,
    normalized_title,
    normalized_search_text
  ) VALUES (
    new.rowid,
    new.normalized_title,
    new.normalized_search_text
  );
END;
