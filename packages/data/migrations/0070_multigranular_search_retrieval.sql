PRAGMA foreign_keys = ON;

-- Search rows remain a disposable local projection. Columns added here make
-- retrieval scope inspectable before FTS ranking without promoting any legacy
-- row to accepted/current authority.
ALTER TABLE search_index_documents
  ADD COLUMN chunk_kind TEXT NOT NULL DEFAULT 'chapter'
    CHECK (
      chunk_kind IN (
        'chapter',
        'scene',
        'event',
        'paragraph',
        'dialogue',
        'story_fact_evidence'
      )
    );

ALTER TABLE search_index_documents
  ADD COLUMN parent_document_id TEXT
    CHECK (
      parent_document_id IS NULL
      OR length(parent_document_id) BETWEEN 1 AND 256
    );

ALTER TABLE search_index_documents
  ADD COLUMN utf16_start INTEGER NOT NULL DEFAULT 0
    CHECK (utf16_start >= 0);

ALTER TABLE search_index_documents
  ADD COLUMN utf16_end INTEGER NOT NULL DEFAULT 0
    CHECK (utf16_end >= utf16_start);

ALTER TABLE search_index_documents
  ADD COLUMN source_length INTEGER NOT NULL DEFAULT 0
    CHECK (source_length >= utf16_end);

ALTER TABLE search_index_documents
  ADD COLUMN scene_id TEXT
    CHECK (scene_id IS NULL OR length(scene_id) BETWEEN 1 AND 256);

ALTER TABLE search_index_documents
  ADD COLUMN event_id TEXT
    CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 256);

ALTER TABLE search_index_documents
  ADD COLUMN character_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(character_ids_json) BETWEEN 2 AND 65536);

ALTER TABLE search_index_documents
  ADD COLUMN location_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(location_ids_json) BETWEEN 2 AND 65536);

ALTER TABLE search_index_documents
  ADD COLUMN story_time TEXT
    CHECK (story_time IS NULL OR length(story_time) BETWEEN 1 AND 500);

ALTER TABLE search_index_documents
  ADD COLUMN branch_id TEXT
    CHECK (branch_id IS NULL OR length(branch_id) BETWEEN 1 AND 256);

ALTER TABLE search_index_documents
  ADD COLUMN pov_character_id TEXT
    CHECK (pov_character_id IS NULL OR length(pov_character_id) BETWEEN 1 AND 256);

ALTER TABLE search_index_documents
  ADD COLUMN story_order INTEGER
    CHECK (story_order IS NULL OR story_order >= 0);

ALTER TABLE search_index_documents
  ADD COLUMN authority TEXT NOT NULL DEFAULT 'rebuildable'
    CHECK (authority IN ('accepted_text', 'confirmed_fact', 'rebuildable'));

ALTER TABLE search_index_documents
  ADD COLUMN privacy TEXT NOT NULL DEFAULT 'standard'
    CHECK (privacy IN ('standard', 'local_only'));

ALTER TABLE search_index_documents
  ADD COLUMN currentness TEXT NOT NULL DEFAULT 'legacy_unknown'
    CHECK (currentness IN ('current', 'stale', 'legacy_unknown'));

ALTER TABLE search_index_documents
  ADD COLUMN omitted_scope_fields_json TEXT NOT NULL
    DEFAULT '["current_version","branch","pov","story_order","scene","event","characters","locations","story_time"]'
    CHECK (length(omitted_scope_fields_json) BETWEEN 2 AND 1024);

-- The explicit assignment documents the upgrade contract: a pre-0070 row is
-- usable only after its authoritative source is projected again.
UPDATE search_index_documents
SET chunk_kind = 'chapter',
    source_length = length(search_text),
    scene_id = NULL,
    event_id = NULL,
    character_ids_json = '[]',
    location_ids_json = '[]',
    story_time = NULL,
    authority = 'rebuildable',
    currentness = 'legacy_unknown',
    omitted_scope_fields_json = '["current_version","branch","pov","story_order","scene","event","characters","locations","story_time"]';

CREATE INDEX IF NOT EXISTS search_index_documents_scope_idx
  ON search_index_documents (
    project_id,
    currentness,
    privacy,
    authority,
    branch_id,
    source_version_id,
    story_order,
    pov_character_id,
    chunk_kind,
    scene_id,
    event_id,
    document_id
  );

CREATE INDEX IF NOT EXISTS search_index_documents_parent_idx
  ON search_index_documents (
    project_id,
    parent_document_id,
    utf16_start,
    utf16_end,
    document_id
  );
