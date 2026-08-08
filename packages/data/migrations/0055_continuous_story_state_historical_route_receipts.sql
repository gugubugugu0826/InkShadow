PRAGMA foreign_keys = ON;

-- Route receipts remain valid audit evidence after a chapter advances to a
-- newer immutable version. Current-version authority is enforced by the
-- runtime transaction before a new route is committed; this restore/import
-- guard only proves that the historical version belongs to the same scope and
-- that its immutable checksum still matches the receipt.
DROP TRIGGER IF EXISTS continuous_story_state_route_receipts_scope_guard;

CREATE TRIGGER continuous_story_state_route_receipts_scope_guard
BEFORE INSERT ON continuous_story_state_route_receipts
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM chapters AS chapter
  JOIN chapter_versions AS version
    ON version.id = NEW.version_id
   AND version.project_id = NEW.project_id
   AND version.chapter_id = NEW.chapter_id
  WHERE chapter.id = NEW.chapter_id
    AND chapter.project_id = NEW.project_id
    AND version.content_checksum = NEW.source_content_hash
)
BEGIN
  SELECT RAISE(ABORT, 'CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED');
END;
