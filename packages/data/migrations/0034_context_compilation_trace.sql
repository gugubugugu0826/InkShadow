PRAGMA foreign_keys = ON;

-- Context compilation audit intentionally stores decisions and source
-- locators only. There are no columns for prompt text, candidate content,
-- evidence excerpts, embeddings, or vectors.
CREATE TABLE IF NOT EXISTS context_compilation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT
    REFERENCES chapters(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL
    CHECK (
      length(task_type) BETWEEN 1 AND 96
      AND task_type = lower(task_type)
      AND task_type GLOB '[a-z]*'
      AND task_type NOT GLOB '*[^a-z0-9_.-]*'
    ),
  maximum_context_tokens INTEGER NOT NULL
    CHECK (maximum_context_tokens BETWEEN 1 AND 10000000),
  required_tokens INTEGER NOT NULL CHECK (required_tokens >= 0),
  used_tokens INTEGER NOT NULL CHECK (used_tokens >= 0),
  remaining_tokens INTEGER NOT NULL CHECK (remaining_tokens >= 0),
  discarded_tokens INTEGER NOT NULL CHECK (discarded_tokens >= 0),
  token_estimate_source TEXT NOT NULL
    CHECK (
      token_estimate_source IN (
        'utf8_conservative',
        'provider_tokenizer',
        'custom'
      )
    ),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 4096),
  included_count INTEGER NOT NULL CHECK (included_count >= 1),
  discarded_count INTEGER NOT NULL CHECK (discarded_count >= 0),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (required_tokens <= used_tokens),
  CHECK (used_tokens <= maximum_context_tokens),
  CHECK (remaining_tokens = maximum_context_tokens - used_tokens),
  CHECK (included_count + discarded_count = candidate_count)
);

CREATE INDEX IF NOT EXISTS context_compilation_runs_project_created_idx
  ON context_compilation_runs (project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS context_compilation_runs_chapter_created_idx
  ON context_compilation_runs (chapter_id, created_at DESC, id DESC)
  WHERE chapter_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS context_compilation_run_chapter_binding_guard
BEFORE INSERT ON context_compilation_runs
WHEN NEW.chapter_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM chapters AS chapter
  WHERE chapter.id = NEW.chapter_id
    AND chapter.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'context compilation chapter belongs to another project');
END;

CREATE TRIGGER IF NOT EXISTS context_compilation_run_immutable
BEFORE UPDATE ON context_compilation_runs
BEGIN
  SELECT RAISE(ABORT, 'context compilation run is immutable');
END;

CREATE TABLE IF NOT EXISTS context_compilation_entries (
  run_id TEXT NOT NULL
    REFERENCES context_compilation_runs(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL
    CHECK (
      length(candidate_id) BETWEEN 1 AND 512
      AND candidate_id = trim(candidate_id)
      AND instr(candidate_id, char(0)) = 0
      AND instr(candidate_id, char(9)) = 0
      AND instr(candidate_id, char(10)) = 0
      AND instr(candidate_id, char(13)) = 0
      AND instr(candidate_id, ' ') = 0
    ),
  layer TEXT NOT NULL
    CHECK (
      layer IN (
        'locked_hard_rules',
        'current_task',
        'scene_goal',
        'pov_known_information',
        'character_current_state',
        'recent_events',
        'related_causal_chain',
        'unresolved_foreshadowing',
        'world_setting',
        'character_voice_samples',
        'semantic_retrieval',
        'rerank_supplement'
      )
    ),
  selection_reason TEXT NOT NULL
    CHECK (
      length(trim(selection_reason)) BETWEEN 1 AND 2000
      AND instr(selection_reason, char(0)) = 0
    ),
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  discarded_reason TEXT
    CHECK (
      discarded_reason IS NULL
      OR (
        length(discarded_reason) BETWEEN 1 AND 96
        AND discarded_reason = lower(discarded_reason)
        AND discarded_reason GLOB '[a-z]*'
        AND discarded_reason NOT GLOB '*[^a-z0-9_.-]*'
      )
    ),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens BETWEEN 1 AND 10000000),
  evaluation_order INTEGER NOT NULL CHECK (evaluation_order BETWEEN 1 AND 4096),
  layer_order INTEGER NOT NULL CHECK (layer_order BETWEEN 1 AND 12),
  priority INTEGER NOT NULL CHECK (priority BETWEEN -1000 AND 1000),
  relevance_score REAL CHECK (relevance_score BETWEEN 0 AND 1),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  budget_remaining_before INTEGER NOT NULL CHECK (budget_remaining_before >= 0),
  budget_remaining_after INTEGER NOT NULL CHECK (budget_remaining_after >= 0),
  PRIMARY KEY (run_id, candidate_id),
  UNIQUE (run_id, evaluation_order),
  CHECK (
    (
      included = 1
      AND discarded_reason IS NULL
      AND budget_remaining_after = budget_remaining_before - estimated_tokens
    )
    OR (
      included = 0
      AND discarded_reason IS NOT NULL
      AND budget_remaining_after = budget_remaining_before
    )
  ),
  CHECK (required = 0 OR included = 1)
);

CREATE INDEX IF NOT EXISTS context_compilation_entries_layer_idx
  ON context_compilation_entries (run_id, layer_order, evaluation_order);

CREATE TRIGGER IF NOT EXISTS context_compilation_entry_immutable
BEFORE UPDATE ON context_compilation_entries
BEGIN
  SELECT RAISE(ABORT, 'context compilation entry is immutable');
END;

CREATE TABLE IF NOT EXISTS context_compilation_entry_sources (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_order INTEGER NOT NULL CHECK (source_order BETWEEN 1 AND 32),
  source_type TEXT NOT NULL
    CHECK (
      source_type IN (
        'user_input',
        'generation_task',
        'scene_plan',
        'chapter',
        'outline',
        'character',
        'relationship',
        'world',
        'timeline_event',
        'causal_event',
        'foreshadow',
        'story_rule',
        'memory',
        'search_document',
        'rerank_result',
        'import',
        'other'
      )
    ),
  source_id TEXT NOT NULL
    CHECK (
      length(source_id) BETWEEN 1 AND 512
      AND source_id = trim(source_id)
      AND instr(source_id, char(0)) = 0
      AND instr(source_id, char(9)) = 0
      AND instr(source_id, char(10)) = 0
      AND instr(source_id, char(13)) = 0
      AND instr(source_id, ' ') = 0
    ),
  source_version_id TEXT
    CHECK (
      source_version_id IS NULL
      OR (
        length(source_version_id) BETWEEN 1 AND 512
        AND source_version_id = trim(source_version_id)
        AND instr(source_version_id, char(0)) = 0
        AND instr(source_version_id, char(9)) = 0
        AND instr(source_version_id, char(10)) = 0
        AND instr(source_version_id, char(13)) = 0
        AND instr(source_version_id, ' ') = 0
      )
    ),
  locator TEXT
    CHECK (
      locator IS NULL
      OR (
        length(trim(locator)) BETWEEN 1 AND 2000
        AND instr(locator, char(0)) = 0
      )
    ),
  content_hash TEXT
    CHECK (
      content_hash IS NULL
      OR (
        length(content_hash) BETWEEN 1 AND 512
        AND content_hash = trim(content_hash)
        AND instr(content_hash, char(0)) = 0
        AND instr(content_hash, char(9)) = 0
        AND instr(content_hash, char(10)) = 0
        AND instr(content_hash, char(13)) = 0
        AND instr(content_hash, ' ') = 0
      )
    ),
  PRIMARY KEY (run_id, candidate_id, source_order),
  FOREIGN KEY (run_id, candidate_id)
    REFERENCES context_compilation_entries(run_id, candidate_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS context_compilation_sources_lookup_idx
  ON context_compilation_entry_sources (
    source_type,
    source_id,
    source_version_id,
    run_id
  );

CREATE TRIGGER IF NOT EXISTS context_compilation_source_immutable
BEFORE UPDATE ON context_compilation_entry_sources
BEGIN
  SELECT RAISE(ABORT, 'context compilation source is immutable');
END;
