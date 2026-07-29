PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS story_materials (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'deleted', 'merged')),
  license TEXT NOT NULL
    CHECK (license IN ('owned', 'licensed', 'public_domain', 'permission_unknown')),
  rights_confirmed INTEGER NOT NULL
    CHECK (rights_confirmed IN (0, 1)),
  allow_generation INTEGER NOT NULL
    CHECK (allow_generation IN (0, 1)),
  allow_training INTEGER NOT NULL
    CHECK (allow_training IN (0, 1)),
  content_fingerprint TEXT NOT NULL
    CHECK (
      length(content_fingerprint) = 64
      AND content_fingerprint = lower(content_fingerprint)
    ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  merged_into_id TEXT
    REFERENCES story_materials(id) ON DELETE RESTRICT,
  deleted_at TEXT,
  retention_until TEXT,
  disposition_reference_count INTEGER
    CHECK (disposition_reference_count IS NULL OR disposition_reference_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  CHECK (
    (
      status = 'active'
      AND merged_into_id IS NULL
      AND deleted_at IS NULL
      AND retention_until IS NULL
      AND disposition_reference_count IS NULL
    )
    OR (
      status = 'deleted'
      AND merged_into_id IS NULL
      AND deleted_at IS NOT NULL
      AND retention_until IS NOT NULL
      AND disposition_reference_count IS NOT NULL
    )
    OR (
      status = 'merged'
      AND merged_into_id IS NOT NULL
      AND merged_into_id <> id
      AND deleted_at IS NOT NULL
      AND retention_until IS NOT NULL
      AND disposition_reference_count IS NOT NULL
    )
  ),
  CHECK (
    rights_confirmed = 1
    OR (allow_generation = 0 AND allow_training = 0)
  ),
  CHECK (
    license <> 'permission_unknown'
    OR (
      rights_confirmed = 0
      AND allow_generation = 0
      AND allow_training = 0
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS story_materials_active_fingerprint_unique
  ON story_materials (project_id, content_fingerprint)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS story_materials_project_status_idx
  ON story_materials (project_id, status, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS story_material_references (
  id TEXT PRIMARY KEY NOT NULL,
  material_id TEXT NOT NULL
    REFERENCES story_materials(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  target_chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE RESTRICT,
  target_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
);

CREATE INDEX IF NOT EXISTS story_material_references_material_idx
  ON story_material_references (material_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS story_material_references_target_idx
  ON story_material_references (project_id, target_chapter_id, target_version_id, created_at DESC);
