PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS creative_journeys (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('idea', 'import', 'professional')),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  current_state TEXT NOT NULL CHECK (length(current_state) BETWEEN 1 AND 64),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  candidate_id TEXT REFERENCES ai_candidates(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS creative_journeys_active_updated_idx
  ON creative_journeys (kind, updated_at DESC, id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS creative_journeys_project_idx
  ON creative_journeys (project_id, updated_at DESC, id)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creative_journey_turns (
  id TEXT PRIMARY KEY NOT NULL,
  journey_id TEXT NOT NULL REFERENCES creative_journeys(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  turn_kind TEXT NOT NULL
    CHECK (turn_kind IN ('idea', 'question', 'answer', 'skip', 'back', 'regenerate', 'keep')),
  question_key TEXT CHECK (question_key IS NULL OR length(question_key) BETWEEN 1 AND 64),
  generation_source TEXT
    CHECK (generation_source IS NULL OR generation_source IN ('provider', 'local_fallback')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 128),
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 512),
  task_key TEXT CHECK (task_key IS NULL OR length(task_key) BETWEEN 1 AND 96),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (journey_id, sequence)
);

CREATE INDEX IF NOT EXISTS creative_journey_turns_journey_idx
  ON creative_journey_turns (journey_id, sequence);
