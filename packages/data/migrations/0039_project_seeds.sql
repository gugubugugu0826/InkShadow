PRAGMA foreign_keys = ON;

-- A ProjectSeed is creation input owned by a real local project. Before a project exists the
-- resumable journey snapshot remains authoritative; after creation this table is the queryable,
-- backup-covered copy. It never represents accepted正文 or a confirmed StoryFact.
CREATE TABLE IF NOT EXISTS project_seeds (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  seed_id TEXT NOT NULL
    CHECK (length(seed_id) BETWEEN 1 AND 256),
  journey_kind TEXT NOT NULL
    CHECK (journey_kind IN ('idea', 'import', 'professional')),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  payload_json TEXT NOT NULL
    CHECK (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND json_extract(payload_json, '$.seedId') = seed_id
      AND json_extract(payload_json, '$.journeyKind') = journey_kind
      AND json_extract(payload_json, '$.version') = schema_version
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_seeds_updated_idx
  ON project_seeds (updated_at DESC, project_id);

-- Upgrade the valid ProjectSeed already embedded in older creative-journey snapshots. If several
-- completed/retried journeys point at the same project, only the newest valid seed is selected.
-- Invalid or partial legacy JSON is left untouched in its original recovery snapshot so startup
-- remains fail-safe and the typed store never mistakes it for authoritative project input.
WITH valid_legacy AS (
  SELECT
    journey.project_id,
    journey.id AS journey_id,
    journey.updated_at AS journey_updated_at,
    json_extract(journey.snapshot_json, '$.projectSeed') AS payload_json,
    json_extract(journey.snapshot_json, '$.projectSeed.seedId') AS seed_id,
    json_extract(journey.snapshot_json, '$.projectSeed.journeyKind') AS journey_kind,
    json_extract(journey.snapshot_json, '$.projectSeed.version') AS schema_version,
    json_extract(journey.snapshot_json, '$.projectSeed.createdAt') AS seed_created_at,
    json_extract(journey.snapshot_json, '$.projectSeed.updatedAt') AS seed_updated_at
  FROM creative_journeys AS journey
  WHERE journey.project_id IS NOT NULL
    AND json_type(journey.snapshot_json, '$.projectSeed') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.seedId') = 'text'
    AND length(json_extract(journey.snapshot_json, '$.projectSeed.seedId')) BETWEEN 1 AND 256
    AND json_extract(journey.snapshot_json, '$.projectSeed.journeyKind')
      IN ('idea', 'import', 'professional')
    AND json_extract(journey.snapshot_json, '$.projectSeed.version') = 1
    AND json_type(journey.snapshot_json, '$.projectSeed.createdAt') = 'text'
    AND json_type(journey.snapshot_json, '$.projectSeed.updatedAt') = 'text'
    AND json_type(journey.snapshot_json, '$.projectSeed.premise') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.genre') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.tone') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.characters') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.relationships') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.world') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.conflict') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.style') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.pov') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.boundaries') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.currentDirection') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.initialOutline') = 'object'
    AND json_type(journey.snapshot_json, '$.projectSeed.rewriteRules') = 'object'
), ranked_legacy AS (
  SELECT
    valid_legacy.*,
    ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY seed_updated_at DESC, journey_updated_at DESC, journey_id DESC
    ) AS seed_rank
  FROM valid_legacy
)
INSERT OR IGNORE INTO project_seeds (
  project_id,
  seed_id,
  journey_kind,
  schema_version,
  payload_json,
  revision,
  created_at,
  updated_at
)
SELECT
  project_id,
  seed_id,
  journey_kind,
  schema_version,
  payload_json,
  1,
  seed_created_at,
  seed_updated_at
FROM ranked_legacy
WHERE seed_rank = 1;
