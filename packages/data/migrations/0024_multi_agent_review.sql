PRAGMA foreign_keys = ON;

-- Multi-agent review persists only user-authored input and public model
-- responses. System prompts and hidden reasoning are never stored.
CREATE TABLE IF NOT EXISTS multi_agent_review_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64),
  restart_of_session_id TEXT
    REFERENCES multi_agent_review_sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL
    CHECK (
      mode IN (
        'brainstorm',
        'outline_review',
        'character_review',
        'world_review',
        'commercial_review',
        'plot_planning'
      )
    ),
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('chapter', 'outline')),
  chapter_id TEXT
    REFERENCES chapters(id) ON DELETE CASCADE,
  base_version_id TEXT
    REFERENCES chapter_versions(id),
  base_outline_revision INTEGER
    CHECK (base_outline_revision IS NULL OR base_outline_revision >= 1),
  base_authority_checksum TEXT NOT NULL
    CHECK (length(base_authority_checksum) = 64),
  user_request TEXT NOT NULL
    CHECK (
      length(user_request) BETWEEN 1 AND 40000
      AND instr(user_request, char(0)) = 0
    ),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'idle',
        'running',
        'candidate_ready',
        'needs_input',
        'failed',
        'paused',
        'cancelled'
      )
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  attempt INTEGER NOT NULL
    CHECK (attempt BETWEEN 1 AND 1000),
  maximum_rounds INTEGER NOT NULL
    CHECK (maximum_rounds BETWEEN 1 AND 16),
  maximum_turns INTEGER NOT NULL
    CHECK (maximum_turns BETWEEN 1 AND 128),
  maximum_input_tokens INTEGER NOT NULL
    CHECK (maximum_input_tokens BETWEEN 1 AND 10000000),
  maximum_output_tokens INTEGER NOT NULL
    CHECK (maximum_output_tokens BETWEEN 1 AND 10000000),
  maximum_cost_micros INTEGER NOT NULL
    CHECK (maximum_cost_micros BETWEEN 0 AND 10000000000),
  maximum_duration_ms INTEGER NOT NULL
    CHECK (maximum_duration_ms BETWEEN 1000 AND 86400000),
  currency TEXT NOT NULL
    CHECK (
      length(currency) = 3
      AND currency = upper(currency)
      AND currency GLOB '[A-Z][A-Z][A-Z]'
    ),
  cancellation_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancellation_requested IN (0, 1)),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR (
        length(failure_code) BETWEEN 2 AND 128
        AND failure_code = upper(failure_code)
      )
    ),
  started_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
    ),
  deadline_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) = deadline_at
    ),
  completed_at TEXT
    CHECK (
      completed_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
      )
    ),
  created_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  updated_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    ),
  CHECK (
    (
      target_kind = 'chapter'
      AND chapter_id IS NOT NULL
      AND base_version_id IS NOT NULL
      AND base_outline_revision IS NULL
    )
    OR (
      target_kind = 'outline'
      AND chapter_id IS NULL
      AND base_version_id IS NULL
      AND base_outline_revision IS NOT NULL
    )
  ),
  CHECK (deadline_at > started_at),
  CHECK (updated_at >= created_at),
  CHECK (
    completed_at IS NULL
    OR (
      status IN ('candidate_ready', 'failed', 'cancelled')
      AND completed_at >= started_at
      AND completed_at <= updated_at
    )
  ),
  CHECK (
    (status = 'failed' AND failure_code IS NOT NULL)
    OR (status <> 'failed' AND failure_code IS NULL)
  ),
  CHECK (
    (status = 'cancelled' AND cancellation_requested = 1)
    OR status <> 'cancelled'
  ),
  CHECK (
    length(id) BETWEEN 1 AND 256
    AND id = trim(id)
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, -1, 1) GLOB '[A-Za-z0-9]'
  ),
  CHECK (
    length(project_id) BETWEEN 1 AND 256
    AND project_id = trim(project_id)
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(idempotency_key) BETWEEN 1 AND 256
    AND idempotency_key = trim(idempotency_key)
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]'
    AND substr(idempotency_key, -1, 1) GLOB '[A-Za-z0-9]'
  ),
  CHECK (
    restart_of_session_id IS NULL
    OR (
      length(restart_of_session_id) BETWEEN 1 AND 256
      AND restart_of_session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  CHECK (
    request_fingerprint = lower(request_fingerprint)
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    AND base_authority_checksum = lower(base_authority_checksum)
    AND base_authority_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    failure_code IS NULL
    OR (
      substr(failure_code, 1, 1) GLOB '[A-Z]'
      AND failure_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS multi_agent_sessions_project_history_idx
  ON multi_agent_review_sessions (project_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS multi_agent_sessions_recovery_idx
  ON multi_agent_review_sessions (status, updated_at, id)
  WHERE status IN ('running', 'paused', 'needs_input');

CREATE TABLE IF NOT EXISTS multi_agent_review_participants (
  session_id TEXT NOT NULL
    REFERENCES multi_agent_review_sessions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 15),
  role TEXT NOT NULL
    CHECK (
      role IN ('planner', 'drafter', 'critic', 'continuity_reviewer', 'editor')
    ),
  enabled INTEGER NOT NULL
    CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'idle',
        'working',
        'done',
        'needs_input',
        'error',
        'paused',
        'cancelled'
      )
    ),
  provider_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL
    CHECK (provider_kind IN ('open_ai_compatible', 'ollama')),
  endpoint_url TEXT NOT NULL,
  authentication TEXT NOT NULL
    CHECK (authentication IN ('none', 'bearer_keyring')),
  provider_profile_revision INTEGER NOT NULL
    CHECK (provider_profile_revision >= 1),
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  maximum_turns INTEGER NOT NULL
    CHECK (maximum_turns BETWEEN 1 AND 128),
  context_window_tokens INTEGER NOT NULL
    CHECK (context_window_tokens BETWEEN 1 AND 10000000),
  input_micros_per_million_tokens INTEGER NOT NULL
    CHECK (input_micros_per_million_tokens BETWEEN 0 AND 1000000000000),
  output_micros_per_million_tokens INTEGER NOT NULL
    CHECK (output_micros_per_million_tokens BETWEEN 0 AND 1000000000000),
  cached_input_micros_per_million_tokens INTEGER
    CHECK (
      cached_input_micros_per_million_tokens IS NULL
      OR cached_input_micros_per_million_tokens BETWEEN 0 AND 1000000000000
    ),
  pricing_version TEXT NOT NULL,
  price_updated_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', price_updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', price_updated_at) = price_updated_at
    ),
  error_code TEXT,
  created_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  updated_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    ),
  PRIMARY KEY (session_id, participant_id),
  UNIQUE (session_id, ordinal),
  CHECK (
    length(participant_id) BETWEEN 1 AND 256
    AND length(provider_id) BETWEEN 1 AND 256
    AND length(endpoint_url) BETWEEN 1 AND 2048
    AND length(model_id) BETWEEN 1 AND 512
    AND length(model_revision) BETWEEN 1 AND 256
    AND length(pricing_version) BETWEEN 1 AND 256
  ),
  CHECK (
    (status = 'error' AND error_code IS NOT NULL)
    OR (status <> 'error' AND error_code IS NULL)
  ),
  CHECK (
    length(session_id) BETWEEN 1 AND 256
    AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(participant_id) BETWEEN 1 AND 256
    AND participant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(provider_id) BETWEEN 1 AND 256
    AND provider_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    error_code IS NULL
    OR (
      length(error_code) BETWEEN 2 AND 128
      AND substr(error_code, 1, 1) GLOB '[A-Z]'
      AND error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  )
);

CREATE INDEX IF NOT EXISTS multi_agent_participants_session_status_idx
  ON multi_agent_review_participants (session_id, enabled, status, ordinal);

CREATE TABLE IF NOT EXISTS multi_agent_review_turns (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL
    REFERENCES multi_agent_review_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL
    CHECK (sequence BETWEEN 1 AND 128),
  attempt INTEGER NOT NULL
    CHECK (attempt BETWEEN 1 AND 1000),
  participant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_fingerprint TEXT
    CHECK (result_fingerprint IS NULL OR length(result_fingerprint) = 64),
  generation_id TEXT NOT NULL,
  run_revision_before INTEGER NOT NULL
    CHECK (run_revision_before BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL
    CHECK (
      status IN ('working', 'completed', 'needs_input', 'failed', 'cancelled')
    ),
  reservation_input_tokens INTEGER NOT NULL
    CHECK (reservation_input_tokens BETWEEN 1 AND 10000000),
  reservation_output_tokens INTEGER NOT NULL
    CHECK (reservation_output_tokens BETWEEN 1 AND 10000000),
  reservation_cost_micros INTEGER NOT NULL
    CHECK (reservation_cost_micros BETWEEN 0 AND 10000000000),
  public_message TEXT
    CHECK (
      public_message IS NULL
      OR (
        length(public_message) BETWEEN 1 AND 40000
        AND instr(public_message, char(0)) = 0
      )
    ),
  response_json TEXT
    CHECK (
      response_json IS NULL
      OR (
        length(response_json) BETWEEN 1 AND 1000000
        AND json_valid(response_json)
        AND json_type(response_json) = 'object'
      )
    ),
  usage_source TEXT
    CHECK (usage_source IN ('provider_reported', 'provider_unavailable')),
  input_tokens INTEGER
    CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 10000000),
  output_tokens INTEGER
    CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 10000000),
  cached_input_tokens INTEGER
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 10000000),
  cost_micros INTEGER
    CHECK (cost_micros IS NULL OR cost_micros BETWEEN 0 AND 9007199254740991),
  error_code TEXT,
  started_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
    ),
  completed_at TEXT
    CHECK (
      completed_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
      )
    ),
  created_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  updated_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    ),
  FOREIGN KEY (session_id, participant_id)
    REFERENCES multi_agent_review_participants(session_id, participant_id)
    ON DELETE CASCADE,
  UNIQUE (session_id, id),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key),
  UNIQUE (session_id, generation_id),
  CHECK (
    (
      status = 'working'
      AND result_fingerprint IS NULL
      AND public_message IS NULL
      AND response_json IS NULL
      AND usage_source IS NULL
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND cached_input_tokens IS NULL
      AND cost_micros IS NULL
      AND error_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'completed'
      AND result_fingerprint IS NOT NULL
      AND public_message IS NOT NULL
      AND response_json IS NOT NULL
      AND usage_source = 'provider_reported'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND cost_micros IS NOT NULL
      AND error_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'needs_input'
      AND result_fingerprint IS NOT NULL
      AND public_message IS NOT NULL
      AND response_json IS NOT NULL
      AND usage_source = 'provider_reported'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND cost_micros IS NOT NULL
      AND error_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      status IN ('failed', 'cancelled')
      AND public_message IS NULL
      AND response_json IS NULL
      AND error_code IS NOT NULL
      AND completed_at IS NOT NULL
      AND (
        (
          usage_source = 'provider_reported'
          AND input_tokens IS NOT NULL
          AND output_tokens IS NOT NULL
          AND cost_micros IS NOT NULL
        )
        OR (
          usage_source = 'provider_unavailable'
          AND input_tokens IS NULL
          AND output_tokens IS NULL
          AND cached_input_tokens IS NULL
          AND cost_micros IS NULL
        )
      )
    )
  ),
  CHECK (cached_input_tokens IS NULL OR cached_input_tokens <= input_tokens),
  CHECK (
    input_tokens IS NULL
    OR status IN ('failed', 'cancelled')
    OR input_tokens <= reservation_input_tokens
  ),
  CHECK (
    output_tokens IS NULL
    OR status IN ('failed', 'cancelled')
    OR output_tokens <= reservation_output_tokens
  ),
  CHECK (
    cost_micros IS NULL
    OR status IN ('failed', 'cancelled')
    OR cost_micros <= reservation_cost_micros
  ),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (updated_at >= created_at),
  CHECK (
    length(id) BETWEEN 1 AND 256
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(session_id) BETWEEN 1 AND 256
    AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(participant_id) BETWEEN 1 AND 256
    AND participant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(idempotency_key) BETWEEN 1 AND 256
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(generation_id) BETWEEN 1 AND 256
    AND generation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    result_fingerprint IS NULL
    OR (
      result_fingerprint = lower(result_fingerprint)
      AND result_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    error_code IS NULL
    OR (
      length(error_code) BETWEEN 2 AND 128
      AND substr(error_code, 1, 1) GLOB '[A-Z]'
      AND error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS multi_agent_single_working_turn_idx
  ON multi_agent_review_turns (session_id)
  WHERE status = 'working';

CREATE INDEX IF NOT EXISTS multi_agent_turns_session_history_idx
  ON multi_agent_review_turns (session_id, sequence, id);

CREATE TABLE IF NOT EXISTS multi_agent_review_conclusions (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL
    REFERENCES multi_agent_review_turns(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 63),
  category TEXT NOT NULL
    CHECK (
      category IN (
        'must_change',
        'suggested_change',
        'optional_enhancement',
        'disputed_opinion',
        'convertible_task'
      )
    ),
  title TEXT NOT NULL
    CHECK (length(title) BETWEEN 1 AND 240 AND instr(title, char(0)) = 0),
  explanation TEXT NOT NULL
    CHECK (
      length(explanation) BETWEEN 1 AND 12000
      AND instr(explanation, char(0)) = 0
    ),
  evidence_json TEXT NOT NULL
    CHECK (
      length(evidence_json) BETWEEN 2 AND 100000
      AND json_valid(evidence_json)
      AND json_type(evidence_json) = 'array'
      AND json_array_length(evidence_json) BETWEEN 0 AND 16
    ),
  task_proposal_json TEXT
    CHECK (
      task_proposal_json IS NULL
      OR (
        length(task_proposal_json) BETWEEN 2 AND 20000
        AND json_valid(task_proposal_json)
        AND json_type(task_proposal_json) = 'object'
      )
    ),
  created_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  UNIQUE (session_id, turn_id, ordinal),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES multi_agent_review_turns(session_id, id)
    ON DELETE CASCADE,
  CHECK (
    (category = 'convertible_task' AND task_proposal_json IS NOT NULL)
    OR (category <> 'convertible_task' AND task_proposal_json IS NULL)
  ),
  CHECK (
    length(id) BETWEEN 1 AND 256
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(session_id) BETWEEN 1 AND 256
    AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(turn_id) BETWEEN 1 AND 256
    AND turn_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )
);

CREATE INDEX IF NOT EXISTS multi_agent_conclusions_session_category_idx
  ON multi_agent_review_conclusions (session_id, category, turn_id, ordinal);

CREATE TABLE IF NOT EXISTS multi_agent_review_source_references (
  conclusion_id TEXT NOT NULL
    REFERENCES multi_agent_review_conclusions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 31),
  kind TEXT NOT NULL
    CHECK (kind IN ('chapter', 'outline_node', 'material', 'project_rule', 'turn')),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL
    CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  source_version_id TEXT,
  source_checksum TEXT NOT NULL
    CHECK (
      length(source_checksum) = 64
      AND source_checksum = lower(source_checksum)
      AND source_checksum NOT GLOB '*[^0-9a-f]*'
    ),
  model_label TEXT NOT NULL
    CHECK (
      length(model_label) BETWEEN 1 AND 240
      AND instr(model_label, char(0)) = 0
    ),
  authoritative_label TEXT NOT NULL
    CHECK (
      length(authoritative_label) BETWEEN 1 AND 240
      AND instr(authoritative_label, char(0)) = 0
    ),
  excerpt TEXT
    CHECK (
      excerpt IS NULL
      OR (
        length(excerpt) BETWEEN 1 AND 2000
        AND instr(excerpt, char(0)) = 0
      )
    ),
  PRIMARY KEY (conclusion_id, ordinal),
  CHECK (length(source_id) BETWEEN 1 AND 256),
  CHECK (
    source_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND (
      source_version_id IS NULL
      OR (
        length(source_version_id) BETWEEN 1 AND 256
        AND source_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    )
  ),
  CHECK (
    (kind = 'chapter' AND source_version_id IS NOT NULL)
    OR (kind <> 'chapter' AND source_version_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS multi_agent_source_refs_source_idx
  ON multi_agent_review_source_references (kind, source_id, conclusion_id, ordinal);

CREATE TABLE IF NOT EXISTS multi_agent_review_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL UNIQUE
    REFERENCES multi_agent_review_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('chapter', 'outline')),
  chapter_candidate_id TEXT UNIQUE
    REFERENCES ai_candidates(id) ON DELETE NO ACTION,
  base_version_id TEXT
    REFERENCES chapter_versions(id),
  base_outline_revision INTEGER
    CHECK (base_outline_revision IS NULL OR base_outline_revision >= 1),
  payload_json TEXT NOT NULL
    CHECK (
      length(payload_json) BETWEEN 1 AND 1000000
      AND json_valid(payload_json)
      AND json_type(payload_json) = 'object'
    ),
  payload_checksum TEXT NOT NULL
    CHECK (length(payload_checksum) = 64),
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'accepted', 'rejected', 'expired')),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  updated_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    ),
  decided_at TEXT
    CHECK (
      decided_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at
      )
    ),
  accepted_outline_snapshot_json TEXT
    CHECK (
      accepted_outline_snapshot_json IS NULL
      OR (
        length(accepted_outline_snapshot_json) BETWEEN 1 AND 5000000
        AND json_valid(accepted_outline_snapshot_json)
        AND json_type(accepted_outline_snapshot_json) = 'object'
      )
    ),
  accepted_outline_revision INTEGER
    CHECK (
      accepted_outline_revision IS NULL
      OR accepted_outline_revision >= 1
    ),
  CHECK (
    (
      target_kind = 'chapter'
      AND chapter_candidate_id IS NOT NULL
      AND base_version_id IS NOT NULL
      AND base_outline_revision IS NULL
      AND json_extract(payload_json, '$.kind') = 'chapter_content'
    )
    OR (
      target_kind = 'outline'
      AND chapter_candidate_id IS NULL
      AND base_version_id IS NULL
      AND base_outline_revision IS NOT NULL
      AND json_extract(payload_json, '$.kind') = 'outline_patch'
    )
  ),
  CHECK (
    (status = 'ready' AND decided_at IS NULL)
    OR (status <> 'ready' AND decided_at IS NOT NULL)
  ),
  CHECK (
    (
      target_kind = 'outline'
      AND status = 'accepted'
      AND accepted_outline_snapshot_json IS NOT NULL
      AND accepted_outline_revision IS NOT NULL
    )
    OR (
      NOT (target_kind = 'outline' AND status = 'accepted')
      AND accepted_outline_snapshot_json IS NULL
      AND accepted_outline_revision IS NULL
    )
  ),
  CHECK (updated_at >= created_at),
  CHECK (
    length(id) BETWEEN 1 AND 256
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(session_id) BETWEEN 1 AND 256
    AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(project_id) BETWEEN 1 AND 256
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    payload_checksum = lower(payload_checksum)
    AND payload_checksum NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX IF NOT EXISTS multi_agent_candidates_project_status_idx
  ON multi_agent_review_candidates (project_id, status, updated_at DESC, id);

-- Fail closed if a target or baseline belongs to another project. Core tables
-- predate composite ownership FKs, so ownership is enforced by immutable
-- triggers at this new boundary.
CREATE TRIGGER IF NOT EXISTS multi_agent_session_target_ownership_insert
BEFORE INSERT ON multi_agent_review_sessions
BEGIN
  SELECT CASE
    WHEN NEW.target_kind = 'chapter'
      AND NOT EXISTS (
        SELECT 1
        FROM chapters AS chapter
        JOIN chapter_versions AS version
          ON version.id = NEW.base_version_id
         AND version.chapter_id = chapter.id
         AND version.project_id = chapter.project_id
        WHERE chapter.id = NEW.chapter_id
          AND chapter.project_id = NEW.project_id
      )
    THEN RAISE(ABORT, 'multi-agent chapter target ownership mismatch')
    WHEN NEW.target_kind = 'outline'
      AND NOT EXISTS (
        SELECT 1
        FROM story_outlines
        WHERE project_id = NEW.project_id
          AND revision = NEW.base_outline_revision
      )
    THEN RAISE(ABORT, 'multi-agent outline target ownership mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_session_authority_immutable
BEFORE UPDATE OF
  project_id,
  restart_of_session_id,
  mode,
  target_kind,
  chapter_id,
  base_version_id,
  base_outline_revision,
  base_authority_checksum,
  request_fingerprint,
  idempotency_key,
  user_request,
  attempt,
  maximum_rounds,
  maximum_turns,
  maximum_input_tokens,
  maximum_output_tokens,
  maximum_cost_micros,
  maximum_duration_ms,
  currency,
  started_at,
  deadline_at,
  created_at
ON multi_agent_review_sessions
BEGIN
  SELECT RAISE(ABORT, 'multi-agent session authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_session_terminal_immutable
BEFORE UPDATE ON multi_agent_review_sessions
WHEN OLD.status <> 'running'
BEGIN
  SELECT RAISE(ABORT, 'multi-agent terminal session history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_participant_authority_immutable
BEFORE UPDATE OF
  session_id,
  participant_id,
  ordinal,
  role,
  enabled,
  provider_id,
  provider_kind,
  endpoint_url,
  authentication,
  provider_profile_revision,
  model_id,
  model_revision,
  maximum_turns,
  context_window_tokens,
  input_micros_per_million_tokens,
  output_micros_per_million_tokens,
  cached_input_micros_per_million_tokens,
  pricing_version,
  price_updated_at,
  created_at
ON multi_agent_review_participants
BEGIN
  SELECT RAISE(ABORT, 'multi-agent participant authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_turn_authority_immutable
BEFORE UPDATE OF
  session_id,
  sequence,
  attempt,
  participant_id,
  idempotency_key,
  generation_id,
  run_revision_before,
  reservation_input_tokens,
  reservation_output_tokens,
  reservation_cost_micros,
  started_at,
  created_at
ON multi_agent_review_turns
BEGIN
  SELECT RAISE(ABORT, 'multi-agent turn authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_turn_terminal_immutable
BEFORE UPDATE ON multi_agent_review_turns
WHEN OLD.status <> 'working'
BEGIN
  SELECT RAISE(ABORT, 'multi-agent terminal turn history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_conclusion_immutable
BEFORE UPDATE ON multi_agent_review_conclusions
BEGIN
  SELECT RAISE(ABORT, 'multi-agent conclusion history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_source_reference_immutable
BEFORE UPDATE ON multi_agent_review_source_references
BEGIN
  SELECT RAISE(ABORT, 'multi-agent source reference history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_candidate_ownership_insert
BEFORE INSERT ON multi_agent_review_candidates
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM multi_agent_review_sessions AS session
      WHERE session.id = NEW.session_id
        AND session.project_id = NEW.project_id
        AND session.target_kind = NEW.target_kind
        AND (
          (
            NEW.target_kind = 'chapter'
            AND session.base_version_id = NEW.base_version_id
          )
          OR (
            NEW.target_kind = 'outline'
            AND session.base_outline_revision = NEW.base_outline_revision
          )
        )
    )
    THEN RAISE(ABORT, 'multi-agent candidate session authority mismatch')
    WHEN NEW.target_kind = 'chapter'
      AND NOT EXISTS (
        SELECT 1
        FROM ai_candidates AS candidate
        JOIN multi_agent_review_sessions AS session
          ON session.id = NEW.session_id
        WHERE candidate.id = NEW.chapter_candidate_id
          AND candidate.project_id = NEW.project_id
          AND candidate.chapter_id = session.chapter_id
          AND candidate.base_version_id = NEW.base_version_id
          AND candidate.source = 'agent'
          AND candidate.status = NEW.status
      )
    THEN RAISE(ABORT, 'multi-agent chapter candidate ownership mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_candidate_authority_immutable
BEFORE UPDATE OF
  session_id,
  project_id,
  target_kind,
  chapter_candidate_id,
  base_version_id,
  base_outline_revision,
  payload_json,
  payload_checksum,
  created_at
ON multi_agent_review_candidates
BEGIN
  SELECT RAISE(ABORT, 'multi-agent candidate authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS multi_agent_candidate_terminal_immutable
BEFORE UPDATE ON multi_agent_review_candidates
WHEN OLD.status <> 'ready'
BEGIN
  SELECT RAISE(ABORT, 'multi-agent terminal candidate history is immutable');
END;

-- Existing chapter candidate acceptance/rejection is authoritative. Mirror its
-- terminal state into the review receipt without granting the review pipeline
-- any direct formal-write path.
CREATE TRIGGER IF NOT EXISTS multi_agent_chapter_candidate_status_projection
AFTER UPDATE OF status ON ai_candidates
WHEN NEW.status IN ('accepted', 'rejected', 'expired')
BEGIN
  UPDATE multi_agent_review_candidates
  SET
    status = NEW.status,
    revision = revision + 1,
    updated_at = NEW.updated_at,
    decided_at = NEW.decided_at
  WHERE chapter_candidate_id = NEW.id
    AND status = 'ready';
END;
