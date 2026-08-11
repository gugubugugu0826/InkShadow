PRAGMA foreign_keys = ON;

-- Novel Skills are versioned writing methods. They are deliberately separate
-- from StoryFact, WritingPreference, prompt text, model output and credentials.
CREATE TABLE IF NOT EXISTS novel_skill_definitions (
  skill_id TEXT NOT NULL
    CHECK (
      length(skill_id) BETWEEN 3 AND 96
      AND skill_id = lower(trim(skill_id))
      AND skill_id GLOB '[a-z]*'
      AND skill_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  version TEXT NOT NULL
    CHECK (
      length(version) BETWEEN 5 AND 32
      AND version GLOB '[0-9]*.[0-9]*.[0-9]*'
      AND version NOT GLOB '*[^0-9.]*'
    ),
  display_name TEXT NOT NULL
    CHECK (
      length(trim(display_name)) BETWEEN 1 AND 120
      AND instr(display_name, char(0)) = 0
    ),
  summary TEXT NOT NULL
    CHECK (
      length(trim(summary)) BETWEEN 1 AND 500
      AND instr(summary, char(0)) = 0
    ),
  kind TEXT NOT NULL CHECK (kind IN ('core', 'genre', 'custom')),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('builtin', 'user')),
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'active', 'disabled', 'deprecated', 'experimental')),
  default_enabled INTEGER NOT NULL CHECK (default_enabled IN (0, 1)),
  precedence INTEGER NOT NULL CHECK (precedence BETWEEN 100 AND 699),
  task_types_json TEXT NOT NULL
    CHECK (
      json_valid(task_types_json) = 1
      AND json_type(task_types_json) = 'array'
      AND json_array_length(task_types_json) BETWEEN 1 AND 22
      AND length(task_types_json) BETWEEN 3 AND 2048
    ),
  activation_json TEXT NOT NULL
    CHECK (
      json_valid(activation_json) = 1
      AND json_type(activation_json) = 'object'
      AND length(activation_json) BETWEEN 2 AND 8192
    ),
  context_requirements_json TEXT NOT NULL
    CHECK (
      json_valid(context_requirements_json) = 1
      AND json_type(context_requirements_json) = 'object'
      AND length(context_requirements_json) BETWEEN 2 AND 8192
    ),
  instructions_json TEXT NOT NULL
    CHECK (
      json_valid(instructions_json) = 1
      AND json_type(instructions_json) = 'object'
      AND length(instructions_json) BETWEEN 2 AND 32768
    ),
  output_contract_json TEXT NOT NULL
    CHECK (
      json_valid(output_contract_json) = 1
      AND json_type(output_contract_json) = 'object'
      AND length(output_contract_json) BETWEEN 2 AND 16384
    ),
  validation_json TEXT NOT NULL
    CHECK (
      json_valid(validation_json) = 1
      AND json_type(validation_json) = 'object'
      AND length(validation_json) BETWEEN 2 AND 16384
    ),
  definition_hash TEXT NOT NULL
    CHECK (
      length(definition_hash) = 64
      AND definition_hash = lower(definition_hash)
      AND definition_hash NOT GLOB '*[^0-9a-f]*'
    ),
  provenance_url TEXT
    CHECK (
      provenance_url IS NULL
      OR (
        length(provenance_url) BETWEEN 8 AND 1000
        AND provenance_url = trim(provenance_url)
        AND instr(provenance_url, char(0)) = 0
      )
    ),
  provenance_commit TEXT
    CHECK (
      provenance_commit IS NULL
      OR (
        length(provenance_commit) BETWEEN 7 AND 64
        AND provenance_commit = lower(provenance_commit)
        AND provenance_commit NOT GLOB '*[^0-9a-f]*'
      )
    ),
  provenance_license TEXT
    CHECK (
      provenance_license IS NULL
      OR (
        length(provenance_license) BETWEEN 1 AND 64
        AND provenance_license = trim(provenance_license)
        AND instr(provenance_license, char(0)) = 0
      )
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (skill_id, version),
  CHECK (default_enabled = 0 OR status = 'active'),
  CHECK (
    (owner_scope = 'builtin' AND kind IN ('core', 'genre'))
    OR (owner_scope = 'user' AND kind = 'custom')
  )
);

CREATE INDEX IF NOT EXISTS novel_skill_definitions_status_idx
  ON novel_skill_definitions (status, kind, skill_id, version);

CREATE TRIGGER IF NOT EXISTS novel_skill_definition_shape_guard
BEFORE INSERT ON novel_skill_definitions
WHEN (length(NEW.version) - length(replace(NEW.version, '.', ''))) <> 2
  OR NEW.version GLOB '*..*'
  OR NEW.version GLOB '.*'
  OR NEW.version GLOB '*.'
  OR (
    length(substr(NEW.version, 1, instr(NEW.version, '.') - 1)) > 1
    AND substr(NEW.version, 1, 1) = '0'
  )
  OR (
    length(
      substr(
        substr(NEW.version, instr(NEW.version, '.') + 1),
        1,
        instr(substr(NEW.version, instr(NEW.version, '.') + 1), '.') - 1
      )
    ) > 1
    AND substr(substr(NEW.version, instr(NEW.version, '.') + 1), 1, 1) = '0'
  )
  OR (
    length(
      substr(
        substr(NEW.version, instr(NEW.version, '.') + 1),
        instr(substr(NEW.version, instr(NEW.version, '.') + 1), '.') + 1
      )
    ) > 1
    AND substr(
      substr(
        substr(NEW.version, instr(NEW.version, '.') + 1),
        instr(substr(NEW.version, instr(NEW.version, '.') + 1), '.') + 1
      ),
      1,
      1
    ) = '0'
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.task_types_json) AS task
    WHERE task.type <> 'text'
      OR task.value NOT IN (
        'idea_discussion',
        'book_start_guidance',
        'prose_generation',
        'continuation',
        'rewrite',
        'polish',
        'outline_planning',
        'scene_breakdown',
        'chapter_summary',
        'long_memory_compression',
        'character_extraction',
        'world_extraction',
        'contradiction_check',
        'pov_check',
        'character_voice_check',
        'content_quality_check',
        'what_if_simulation',
        'embedding',
        'rerank',
        'image_generation',
        'vision_understanding',
        'translation'
      )
  )
  OR (
    SELECT count(*)
    FROM json_each(NEW.task_types_json)
  ) <> (
    SELECT count(DISTINCT task.value)
    FROM json_each(NEW.task_types_json) AS task
  )
BEGIN
  SELECT RAISE(ABORT, 'novel skill definition version or task coverage is invalid');
END;

CREATE TRIGGER IF NOT EXISTS novel_skill_definition_immutable
BEFORE UPDATE ON novel_skill_definitions
BEGIN
  SELECT RAISE(ABORT, 'novel skill definition is immutable');
END;

CREATE TABLE IF NOT EXISTS project_novel_skill_bindings (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  pinned_version TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  activation_mode TEXT NOT NULL CHECK (activation_mode IN ('smart', 'manual')),
  task_overrides_json TEXT NOT NULL
    CHECK (
      json_valid(task_overrides_json) = 1
      AND json_type(task_overrides_json) = 'object'
      AND length(task_overrides_json) BETWEEN 2 AND 16384
    ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  PRIMARY KEY (project_id, skill_id),
  FOREIGN KEY (skill_id, pinned_version)
    REFERENCES novel_skill_definitions(skill_id, version) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS project_novel_skill_bindings_skill_idx
  ON project_novel_skill_bindings (skill_id, pinned_version, enabled);

CREATE TRIGGER IF NOT EXISTS project_novel_skill_binding_active_project_guard
BEFORE INSERT ON project_novel_skill_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM projects AS project
  WHERE project.id = NEW.project_id AND project.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill binding requires an active project');
END;

CREATE TRIGGER IF NOT EXISTS project_novel_skill_binding_active_project_update_guard
BEFORE UPDATE ON project_novel_skill_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM projects AS project
  WHERE project.id = NEW.project_id AND project.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill binding requires an active project');
END;

CREATE TRIGGER IF NOT EXISTS project_novel_skill_binding_task_overrides_guard
BEFORE INSERT ON project_novel_skill_bindings
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.task_overrides_json) AS task_override
  WHERE task_override.key NOT IN (
    'idea_discussion',
    'book_start_guidance',
    'prose_generation',
    'continuation',
    'rewrite',
    'polish',
    'outline_planning',
    'scene_breakdown',
    'chapter_summary',
    'long_memory_compression',
    'character_extraction',
    'world_extraction',
    'contradiction_check',
    'pov_check',
    'character_voice_check',
    'content_quality_check',
    'what_if_simulation',
    'embedding',
    'rerank',
    'image_generation',
    'vision_understanding',
    'translation'
  )
  OR task_override.type <> 'object'
  OR (SELECT count(*) FROM json_each(task_override.value)) <> 2
  OR (SELECT count(DISTINCT field.key) FROM json_each(task_override.value) AS field) <> 2
  OR EXISTS (
    SELECT 1
    FROM json_each(task_override.value) AS field
    WHERE field.key NOT IN ('enabled', 'invocationMode')
  )
  OR COALESCE(json_type(task_override.value, '$.enabled'), 'missing')
       NOT IN ('true', 'false', 'null')
  OR COALESCE(json_type(task_override.value, '$.invocationMode'), 'missing')
       NOT IN ('text', 'null')
  OR (
    json_type(task_override.value, '$.enabled') = 'null'
    AND json_type(task_override.value, '$.invocationMode') = 'null'
  )
  OR (
    json_type(task_override.value, '$.invocationMode') = 'text'
    AND json_extract(task_override.value, '$.invocationMode') NOT IN (
      'coach', 'collaborator', 'draft', 'critic', 'revision', 'explorer'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill task overrides must use known tasks and bounded scalar fields');
END;

CREATE TRIGGER IF NOT EXISTS project_novel_skill_binding_task_overrides_update_guard
BEFORE UPDATE OF task_overrides_json ON project_novel_skill_bindings
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.task_overrides_json) AS task_override
  WHERE task_override.key NOT IN (
    'idea_discussion',
    'book_start_guidance',
    'prose_generation',
    'continuation',
    'rewrite',
    'polish',
    'outline_planning',
    'scene_breakdown',
    'chapter_summary',
    'long_memory_compression',
    'character_extraction',
    'world_extraction',
    'contradiction_check',
    'pov_check',
    'character_voice_check',
    'content_quality_check',
    'what_if_simulation',
    'embedding',
    'rerank',
    'image_generation',
    'vision_understanding',
    'translation'
  )
  OR task_override.type <> 'object'
  OR (SELECT count(*) FROM json_each(task_override.value)) <> 2
  OR (SELECT count(DISTINCT field.key) FROM json_each(task_override.value) AS field) <> 2
  OR EXISTS (
    SELECT 1
    FROM json_each(task_override.value) AS field
    WHERE field.key NOT IN ('enabled', 'invocationMode')
  )
  OR COALESCE(json_type(task_override.value, '$.enabled'), 'missing')
       NOT IN ('true', 'false', 'null')
  OR COALESCE(json_type(task_override.value, '$.invocationMode'), 'missing')
       NOT IN ('text', 'null')
  OR (
    json_type(task_override.value, '$.enabled') = 'null'
    AND json_type(task_override.value, '$.invocationMode') = 'null'
  )
  OR (
    json_type(task_override.value, '$.invocationMode') = 'text'
    AND json_extract(task_override.value, '$.invocationMode') NOT IN (
      'coach', 'collaborator', 'draft', 'critic', 'revision', 'explorer'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill task overrides must use known tasks and bounded scalar fields');
END;

CREATE TRIGGER IF NOT EXISTS project_novel_skill_binding_revision_guard
BEFORE UPDATE ON project_novel_skill_bindings
WHEN NEW.project_id <> OLD.project_id
  OR NEW.skill_id <> OLD.skill_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.created_at <> OLD.created_at
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'novel skill binding update is not revision-safe');
END;

-- This snapshot is intentionally content-free. The immutable definition rows
-- carry method instructions; this row only records identifiers and replayable
-- selection configuration for the exact invocation.
CREATE TABLE IF NOT EXISTS novel_skill_invocation_snapshots (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND substr(id, 9, 1) = '-'
      AND substr(id, 14, 1) = '-'
      AND substr(id, 15, 1) = '7'
      AND substr(id, 19, 1) = '-'
      AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(id, 24, 1) = '-'
      AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  context_trace_id TEXT NOT NULL UNIQUE
    REFERENCES context_compilation_runs(id) ON DELETE CASCADE,
  model_invocation_id TEXT NOT NULL UNIQUE
    REFERENCES model_invocation_facts(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL
    CHECK (
      task_type IN (
        'idea_discussion',
        'book_start_guidance',
        'prose_generation',
        'continuation',
        'rewrite',
        'polish',
        'outline_planning',
        'scene_breakdown',
        'chapter_summary',
        'long_memory_compression',
        'character_extraction',
        'world_extraction',
        'contradiction_check',
        'pov_check',
        'character_voice_check',
        'content_quality_check',
        'what_if_simulation',
        'embedding',
        'rerank',
        'image_generation',
        'vision_understanding',
        'translation'
      )
    ),
  invocation_mode TEXT NOT NULL
    CHECK (invocation_mode IN ('coach', 'collaborator', 'draft', 'critic', 'revision', 'explorer')),
  compiler_version TEXT NOT NULL
    CHECK (
      length(compiler_version) BETWEEN 3 AND 96
      AND compiler_version = trim(compiler_version)
      AND compiler_version NOT GLOB '*[^A-Za-z0-9._:@/-]*'
    ),
  maximum_skill_tokens INTEGER NOT NULL
    CHECK (maximum_skill_tokens BETWEEN 0 AND 100000),
  used_skill_tokens INTEGER NOT NULL
    CHECK (used_skill_tokens BETWEEN 0 AND 100000),
  discarded_skill_tokens INTEGER NOT NULL
    CHECK (discarded_skill_tokens BETWEEN 0 AND 6400000),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 0 AND 64),
  included_count INTEGER NOT NULL CHECK (included_count BETWEEN 0 AND 64),
  discarded_count INTEGER NOT NULL CHECK (discarded_count BETWEEN 0 AND 64),
  selection_hash TEXT NOT NULL
    CHECK (
      length(selection_hash) = 64
      AND selection_hash = lower(selection_hash)
      AND selection_hash NOT GLOB '*[^0-9a-f]*'
    ),
  configuration_snapshot_json TEXT NOT NULL
    CHECK (
      json_valid(configuration_snapshot_json) = 1
      AND json_type(configuration_snapshot_json) = 'object'
      AND length(configuration_snapshot_json) BETWEEN 2 AND 32768
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (used_skill_tokens <= maximum_skill_tokens),
  CHECK (candidate_count = included_count + discarded_count)
);

CREATE INDEX IF NOT EXISTS novel_skill_invocation_project_created_idx
  ON novel_skill_invocation_snapshots (project_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS novel_skill_invocation_exact_trace_guard
BEFORE INSERT ON novel_skill_invocation_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM context_compilation_runs AS trace
  INNER JOIN context_compilation_execution_links AS execution
    ON execution.trace_id = trace.id
  INNER JOIN context_compilation_model_invocation_links AS model_link
    ON model_link.trace_id = trace.id
  INNER JOIN model_invocation_facts AS invocation
    ON invocation.id = model_link.model_invocation_id
  WHERE trace.id = NEW.context_trace_id
    AND trace.project_id = NEW.project_id
    AND trace.task_type = NEW.task_type
    AND invocation.id = NEW.model_invocation_id
    AND invocation.task = NEW.task_type
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill snapshot lacks the exact context and model invocation chain');
END;

-- Configuration values are identifiers only. This guard blocks both known
-- sensitive key names and prose-like/free-text values even for direct SQL.
CREATE TRIGGER IF NOT EXISTS novel_skill_invocation_configuration_guard
BEFORE INSERT ON novel_skill_invocation_snapshots
WHEN EXISTS (
  SELECT 1
  FROM json_tree(NEW.configuration_snapshot_json)
  WHERE (
    key IS NOT NULL
    AND (
      lower(CAST(key AS TEXT)) GLOB '*credential*'
      OR lower(CAST(key AS TEXT)) GLOB '*secret*'
      OR lower(CAST(key AS TEXT)) GLOB '*api*key*'
      OR lower(CAST(key AS TEXT)) GLOB '*chapter*'
      OR lower(CAST(key AS TEXT)) GLOB '*story*fact*'
      OR lower(CAST(key AS TEXT)) GLOB '*prompt*'
      OR lower(CAST(key AS TEXT)) GLOB '*message*'
      OR lower(CAST(key AS TEXT)) GLOB '*response*'
      OR lower(CAST(key AS TEXT)) GLOB '*reasoning*'
      OR lower(CAST(key AS TEXT)) GLOB '*instruction*'
      OR lower(CAST(key AS TEXT)) GLOB '*excerpt*'
      OR lower(CAST(key AS TEXT)) IN ('text', 'body', 'content')
    )
  )
  OR (
    type = 'text'
    AND (
      length(CAST(atom AS TEXT)) NOT BETWEEN 1 AND 128
      OR CAST(atom AS TEXT) <> trim(CAST(atom AS TEXT))
      OR CAST(atom AS TEXT) GLOB '*[^A-Za-z0-9._:@/-]*'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill invocation configuration must be content-free');
END;

CREATE TRIGGER IF NOT EXISTS novel_skill_invocation_configuration_column_guard
BEFORE INSERT ON novel_skill_invocation_snapshots
WHEN json_type(NEW.configuration_snapshot_json, '$.schemaVersion') IS NOT 'integer'
  OR json_extract(NEW.configuration_snapshot_json, '$.schemaVersion') IS NOT 1
  OR json_type(NEW.configuration_snapshot_json, '$.compilerVersion') IS NOT 'text'
  OR json_extract(NEW.configuration_snapshot_json, '$.compilerVersion') IS NOT NEW.compiler_version
  OR json_type(NEW.configuration_snapshot_json, '$.taskType') IS NOT 'text'
  OR json_extract(NEW.configuration_snapshot_json, '$.taskType') IS NOT NEW.task_type
  OR json_type(NEW.configuration_snapshot_json, '$.invocationMode') IS NOT 'text'
  OR json_extract(NEW.configuration_snapshot_json, '$.invocationMode') IS NOT NEW.invocation_mode
  OR json_type(NEW.configuration_snapshot_json, '$.maximumSkillTokens') IS NOT 'integer'
  OR json_extract(NEW.configuration_snapshot_json, '$.maximumSkillTokens') IS NOT NEW.maximum_skill_tokens
  OR json_type(NEW.configuration_snapshot_json, '$.experimentalAllowed') NOT IN ('true', 'false')
  OR json_type(NEW.configuration_snapshot_json, '$.genreTags') IS NOT 'array'
  OR json_type(NEW.configuration_snapshot_json, '$.explicitSkillIds') IS NOT 'array'
  OR json_type(NEW.configuration_snapshot_json, '$.availableContextLayers') IS NOT 'array'
  OR json_type(NEW.configuration_snapshot_json, '$.consideredDefinitions') IS NOT 'array'
  OR json_type(NEW.configuration_snapshot_json, '$.bindings') IS NOT 'array'
  OR (SELECT count(*) FROM json_each(NEW.configuration_snapshot_json)) <> 11
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.configuration_snapshot_json) AS field
    WHERE field.key NOT IN (
      'schemaVersion',
      'compilerVersion',
      'taskType',
      'invocationMode',
      'maximumSkillTokens',
      'experimentalAllowed',
      'genreTags',
      'explicitSkillIds',
      'availableContextLayers',
      'consideredDefinitions',
      'bindings'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'novel skill invocation configuration does not match its columns');
END;

CREATE TRIGGER IF NOT EXISTS novel_skill_invocation_immutable
BEFORE UPDATE ON novel_skill_invocation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'novel skill invocation snapshot is immutable');
END;

CREATE TABLE IF NOT EXISTS novel_skill_invocation_items (
  snapshot_id TEXT NOT NULL
    REFERENCES novel_skill_invocation_snapshots(id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL CHECK (item_order BETWEEN 1 AND 64),
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  definition_hash TEXT NOT NULL
    CHECK (
      length(definition_hash) = 64
      AND definition_hash = lower(definition_hash)
      AND definition_hash NOT GLOB '*[^0-9a-f]*'
    ),
  activation_source TEXT NOT NULL
    CHECK (activation_source IN ('explicit', 'project_binding', 'smart_core', 'smart_genre', 'default', 'registry')),
  selection_reason TEXT NOT NULL
    CHECK (
      selection_reason IN (
        'selected',
        'not_enabled',
        'manual_not_requested',
        'task_mismatch',
        'mode_mismatch',
        'genre_mismatch',
        'status_blocked',
        'missing_context',
        'conflict',
        'token_budget_exhausted'
      )
    ),
  precedence INTEGER NOT NULL CHECK (precedence BETWEEN 100 AND 699),
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  discarded_reason TEXT
    CHECK (
      discarded_reason IS NULL
      OR discarded_reason IN (
        'not_enabled',
        'manual_not_requested',
        'task_mismatch',
        'mode_mismatch',
        'genre_mismatch',
        'status_blocked',
        'missing_context',
        'conflict',
        'token_budget_exhausted'
      )
    ),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens BETWEEN 1 AND 100000),
  PRIMARY KEY (snapshot_id, item_order),
  UNIQUE (snapshot_id, skill_id),
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES novel_skill_definitions(skill_id, version) ON DELETE RESTRICT,
  CHECK (
    (included = 1 AND selection_reason = 'selected' AND discarded_reason IS NULL)
    OR
    (included = 0 AND selection_reason <> 'selected' AND discarded_reason = selection_reason)
  )
);

CREATE INDEX IF NOT EXISTS novel_skill_invocation_items_definition_idx
  ON novel_skill_invocation_items (skill_id, skill_version, snapshot_id);

CREATE TRIGGER IF NOT EXISTS novel_skill_invocation_item_hash_guard
BEFORE INSERT ON novel_skill_invocation_items
WHEN NOT EXISTS (
  SELECT 1
  FROM novel_skill_definitions AS definition
  WHERE definition.skill_id = NEW.skill_id
    AND definition.version = NEW.skill_version
    AND definition.definition_hash = NEW.definition_hash
)
BEGIN
  SELECT RAISE(ABORT, 'novel skill invocation item hash does not match its definition');
END;

CREATE TRIGGER IF NOT EXISTS novel_skill_invocation_item_immutable
BEFORE UPDATE ON novel_skill_invocation_items
BEGIN
  SELECT RAISE(ABORT, 'novel skill invocation item is immutable');
END;
