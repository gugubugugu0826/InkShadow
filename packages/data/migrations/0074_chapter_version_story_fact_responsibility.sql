ALTER TABLE chapter_versions
ADD COLUMN organize_local_story_facts INTEGER NOT NULL DEFAULT 0
CHECK (organize_local_story_facts IN (0, 1));

CREATE TRIGGER chapter_version_story_fact_responsibility_immutable
BEFORE UPDATE OF organize_local_story_facts ON chapter_versions
FOR EACH ROW
WHEN NEW.organize_local_story_facts <> OLD.organize_local_story_facts
BEGIN
  SELECT RAISE(
    ABORT,
    'CHAPTER_VERSION_STORY_FACT_RESPONSIBILITY_IMMUTABLE'
  );
END;
