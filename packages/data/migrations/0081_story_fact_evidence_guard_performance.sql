PRAGMA foreign_keys = ON;

-- 0079 validates JavaScript UTF-16 evidence offsets inside SQLite. Its first
-- implementation recalculated the leading UTF-8 byte twice at every character
-- boundary, which made each evidence insert scale poorly on long chapters.
-- Keep the same exact ownership, total-length, boundary and excerpt checks,
-- but carry the already-read leading byte through the recursive scan.
DROP TRIGGER IF EXISTS story_fact_evidence_insert_guard;

CREATE TRIGGER story_fact_evidence_insert_guard
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
        WITH RECURSIVE utf16_boundaries(byte_position, utf16_offset, leading_byte) AS (
          SELECT
            1,
            0,
            hex(substr(CAST(version.content AS BLOB), 1, 1))
          UNION ALL
          SELECT
            byte_position + CASE
              WHEN leading_byte BETWEEN 'F0' AND 'F4' THEN 4
              WHEN leading_byte BETWEEN 'E0' AND 'EF' THEN 3
              WHEN leading_byte BETWEEN 'C2' AND 'DF' THEN 2
              ELSE 1
            END,
            utf16_offset + CASE
              WHEN leading_byte BETWEEN 'F0' AND 'F4' THEN 2
              ELSE 1
            END,
            hex(substr(
              CAST(version.content AS BLOB),
              byte_position + CASE
                WHEN leading_byte BETWEEN 'F0' AND 'F4' THEN 4
                WHEN leading_byte BETWEEN 'E0' AND 'EF' THEN 3
                WHEN leading_byte BETWEEN 'C2' AND 'DF' THEN 2
                ELSE 1
              END,
              1
            ))
          FROM utf16_boundaries
          WHERE byte_position <= length(CAST(version.content AS BLOB))
            AND utf16_offset < NEW.source_end_offset
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
        WHERE length(version.content) + (
                length(CAST(version.content AS BLOB))
                - length(CAST(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(CAST(version.content AS BLOB), X'F0', X''),
                            X'F1', X''
                          ),
                          X'F2', X''
                        ),
                        X'F3', X''
                      ),
                      X'F4', X''
                    ) AS BLOB
                  ))
              ) = NEW.source_length
          AND CAST(substr(
                CAST(version.content AS BLOB),
                evidence_span.start_position,
                evidence_span.end_position - evidence_span.start_position
              ) AS TEXT) = NEW.source_excerpt
      )
  ) THEN RAISE(ABORT, 'story fact evidence source mismatch') END;
END;
