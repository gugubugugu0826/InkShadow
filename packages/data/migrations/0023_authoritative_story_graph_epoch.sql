PRAGMA foreign_keys = ON;

-- Lightweight invalidation authority for the rebuildable Story -> GraphRAG
-- projection. Every authoritative Story/chapter mutation advances the epoch.
-- Queries compare this value with the epoch published by the last successful
-- graph rebuild; they never need to rehydrate and hash all Story history.
CREATE TABLE IF NOT EXISTS authoritative_story_graph_state (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version = 1),
  authority_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (authority_epoch BETWEEN 0 AND 9007199254740991),
  projected_epoch INTEGER
    CHECK (
      projected_epoch IS NULL
      OR projected_epoch BETWEEN 0 AND 9007199254740991
    ),
  projected_graph_revision INTEGER
    CHECK (projected_graph_revision IS NULL OR projected_graph_revision >= 1),
  projection_complete INTEGER
    CHECK (projection_complete IS NULL OR projection_complete IN (0, 1)),
  diagnostics_json TEXT
    CHECK (
      diagnostics_json IS NULL
      OR (json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'object')
    ),
  CHECK (
    (
      projected_epoch IS NULL
      AND projected_graph_revision IS NULL
      AND projection_complete IS NULL
      AND diagnostics_json IS NULL
    )
    OR (
      projected_epoch IS NOT NULL
      AND projected_graph_revision IS NOT NULL
      AND projection_complete IS NOT NULL
      AND diagnostics_json IS NOT NULL
      AND projected_epoch <= authority_epoch
    )
  )
);

CREATE INDEX IF NOT EXISTS authoritative_story_graph_freshness_idx
  ON authoritative_story_graph_state (
    project_id,
    authority_epoch,
    projected_epoch,
    projected_graph_revision
  );

-- Projection ownership is project-scoped. Moving an authoritative row between
-- projects would make one side appear falsely fresh, so project identity is
-- immutable even for raw SQL callers.
CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_formal_project_immutable
BEFORE UPDATE OF project_id ON story_formal_records
WHEN OLD.project_id <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'story formal record project_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_review_project_immutable
BEFORE UPDATE OF project_id ON story_review_items
WHEN OLD.project_id <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'story review item project_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_chapter_project_immutable
BEFORE UPDATE OF project_id ON chapters
WHEN OLD.project_id <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'chapter project_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_version_project_immutable
BEFORE UPDATE OF project_id ON chapter_versions
WHEN OLD.project_id <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'chapter version project_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_formal_insert
AFTER INSERT ON story_formal_records
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_formal_update
AFTER UPDATE ON story_formal_records
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_formal_delete
AFTER DELETE ON story_formal_records
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  SELECT OLD.project_id, 1
  WHERE EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_review_insert
AFTER INSERT ON story_review_items
WHEN NEW.status IN ('accepted', 'modified')
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_review_update
AFTER UPDATE ON story_review_items
WHEN OLD.status IN ('accepted', 'modified')
  OR NEW.status IN ('accepted', 'modified')
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_review_delete
AFTER DELETE ON story_review_items
WHEN OLD.status IN ('accepted', 'modified')
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  SELECT OLD.project_id, 1
  WHERE EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_chapter_insert
AFTER INSERT ON chapters
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_chapter_update
AFTER UPDATE ON chapters
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_chapter_delete
AFTER DELETE ON chapters
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  SELECT OLD.project_id, 1
  WHERE EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_version_insert
AFTER INSERT ON chapter_versions
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_version_update
AFTER UPDATE ON chapter_versions
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;

CREATE TRIGGER IF NOT EXISTS authoritative_story_graph_version_delete
AFTER DELETE ON chapter_versions
BEGIN
  INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
  SELECT OLD.project_id, 1
  WHERE EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
  ON CONFLICT(project_id) DO UPDATE SET
    authority_epoch = authority_epoch + 1;
END;
