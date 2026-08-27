PRAGMA foreign_keys = ON;

-- One governed fact can retain every immutable正文 citation that supports it.
-- Existing source columns remain the original/primary evidence and are never
-- rewritten; this forward-only relation adds later evidence without deleting
-- history or changing an author's decision.
CREATE TABLE IF NOT EXISTS story_fact_evidence (
  fact_id TEXT NOT NULL REFERENCES story_facts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  evidence_reference TEXT NOT NULL
    CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 1000 AND instr(evidence_reference, char(0)) = 0),
  source_chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE RESTRICT,
  source_version_id TEXT NOT NULL REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_start_offset INTEGER NOT NULL CHECK (source_start_offset >= 0),
  source_end_offset INTEGER NOT NULL,
  source_length INTEGER NOT NULL CHECK (source_length BETWEEN 1 AND 5000000),
  source_excerpt TEXT NOT NULL
    CHECK (length(source_excerpt) BETWEEN 1 AND 2000 AND instr(source_excerpt, char(0)) = 0),
  recorded_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at),
  PRIMARY KEY (fact_id, evidence_reference),
  CHECK (source_end_offset > source_start_offset AND source_end_offset <= source_length)
);

CREATE INDEX IF NOT EXISTS story_fact_evidence_project_source_idx
  ON story_fact_evidence (
    project_id, source_chapter_id, source_version_id, source_start_offset, fact_id
  );

INSERT OR IGNORE INTO story_fact_evidence (
  fact_id, project_id, evidence_reference, source_chapter_id, source_version_id,
  source_start_offset, source_end_offset, source_length, source_excerpt, recorded_at
)
SELECT
  id, project_id, evidence_reference, source_chapter_id, source_version_id,
  source_start_offset, source_end_offset, source_length, source_excerpt, created_at
FROM story_facts
WHERE source_kind = 'chapter_span';

CREATE TRIGGER IF NOT EXISTS story_fact_evidence_insert_guard
BEFORE INSERT ON story_fact_evidence
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM story_facts AS fact
    WHERE fact.id = NEW.fact_id AND fact.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'story fact evidence project mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM chapter_versions AS version
    WHERE version.id = NEW.source_version_id
      AND version.project_id = NEW.project_id
      AND version.chapter_id = NEW.source_chapter_id
      AND EXISTS (
        -- SQLite length/substr count Unicode code points, while persisted
        -- evidence offsets follow JavaScript UTF-16 code units. Convert every
        -- code-point boundary to its exact UTF-16 boundary before comparing.
        WITH RECURSIVE utf16_boundaries(byte_position, utf16_offset) AS (
          SELECT 1, 0
          UNION ALL
          SELECT
            byte_position + CASE
              WHEN hex(substr(CAST(version.content AS BLOB), byte_position, 1))
                   BETWEEN 'F0' AND 'F4' THEN 4
              WHEN hex(substr(CAST(version.content AS BLOB), byte_position, 1))
                   BETWEEN 'E0' AND 'EF' THEN 3
              WHEN hex(substr(CAST(version.content AS BLOB), byte_position, 1))
                   BETWEEN 'C2' AND 'DF' THEN 2
              ELSE 1
            END,
            utf16_offset + CASE
              WHEN hex(substr(CAST(version.content AS BLOB), byte_position, 1))
                   BETWEEN 'F0' AND 'F4' THEN 2
              ELSE 1
            END
          FROM utf16_boundaries
          WHERE byte_position <= length(CAST(version.content AS BLOB))
        ),
        evidence_span(start_position, end_position) AS (
          SELECT span_start.byte_position, span_end.byte_position
          FROM utf16_boundaries AS span_start
          INNER JOIN utf16_boundaries AS span_end
            ON span_end.utf16_offset = NEW.source_end_offset
          WHERE span_start.utf16_offset = NEW.source_start_offset
        )
        SELECT 1
        FROM evidence_span
        WHERE (SELECT max(utf16_offset) FROM utf16_boundaries) = NEW.source_length
          AND CAST(substr(
                CAST(version.content AS BLOB),
                evidence_span.start_position,
                evidence_span.end_position - evidence_span.start_position
              ) AS TEXT) = NEW.source_excerpt
      )
  ) THEN RAISE(ABORT, 'story fact evidence source mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS story_fact_evidence_immutable
BEFORE UPDATE ON story_fact_evidence
BEGIN
  SELECT RAISE(ABORT, 'story fact evidence is immutable');
END;
