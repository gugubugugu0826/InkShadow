PRAGMA foreign_keys = ON;

-- Append-only, content-free evidence for the Novel Skill A/B gate. Provider
-- prompts, chapter text, visible output, reasoning and credentials never enter
-- these tables. Every mutable workflow row has a constrained state machine;
-- every evidence or decision row is immutable, including DELETE.
CREATE TABLE IF NOT EXISTS novel_skill_evaluation_suites (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) = 36 AND id = lower(id) AND substr(id, 15, 1) = '7'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  evaluator_version TEXT NOT NULL CHECK (evaluator_version = 'novel-skill-ab@1'),
  compiler_version TEXT NOT NULL CHECK (compiler_version = 'novel-skill-compiler@1'),
  evaluation_project_id TEXT NOT NULL UNIQUE
    REFERENCES projects(id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)
    AND plan_hash NOT GLOB '*[^0-9a-f]*'),
  fixture_set_hash TEXT NOT NULL CHECK (length(fixture_set_hash) = 64 AND fixture_set_hash = lower(fixture_set_hash)
    AND fixture_set_hash NOT GLOB '*[^0-9a-f]*'),
  target_manifest_hash TEXT NOT NULL CHECK (length(target_manifest_hash) = 64
    AND target_manifest_hash = lower(target_manifest_hash)
    AND target_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  core_manifest_hash TEXT NOT NULL CHECK (length(core_manifest_hash) = 64
    AND core_manifest_hash = lower(core_manifest_hash)
    AND core_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  core_genre_manifest_hash TEXT NOT NULL CHECK (length(core_genre_manifest_hash) = 64
    AND core_genre_manifest_hash = lower(core_genre_manifest_hash)
    AND core_genre_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  core_genre_preferences_manifest_hash TEXT NOT NULL CHECK (
    length(core_genre_preferences_manifest_hash) = 64
    AND core_genre_preferences_manifest_hash = lower(core_genre_preferences_manifest_hash)
    AND core_genre_preferences_manifest_hash NOT GLOB '*[^0-9a-f]*'
  ),
  preference_configuration_hash TEXT NOT NULL CHECK (length(preference_configuration_hash) = 64
    AND preference_configuration_hash = lower(preference_configuration_hash)
    AND preference_configuration_hash NOT GLOB '*[^0-9a-f]*'),
  model_slots_json TEXT NOT NULL CHECK (
    json_valid(model_slots_json) = 1 AND json_type(model_slots_json) = 'array'
    AND json_array_length(model_slots_json) = 2 AND length(model_slots_json) BETWEEN 32 AND 1024
  ),
  minimum_repetitions INTEGER NOT NULL CHECK (minimum_repetitions = 2),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_suite_content_free_guard
BEFORE INSERT ON novel_skill_evaluation_suites
WHEN NOT EXISTS (
  SELECT 1 FROM projects AS project
  WHERE project.id = NEW.evaluation_project_id AND project.status = 'archived'
    AND project.archived_at IS NOT NULL AND project.trashed_at IS NULL
)
OR EXISTS (SELECT 1 FROM chapters WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM story_facts WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM project_seeds WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM story_planning_candidates WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM writing_preferences WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM story_settings_import_receipts WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM project_novel_skill_bindings WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM ai_candidates WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (SELECT 1 FROM context_compilation_runs WHERE project_id = NEW.evaluation_project_id)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.model_slots_json) AS slot
  WHERE slot.type <> 'object'
     OR (SELECT count(*) FROM json_each(slot.value)) <> 2
     OR EXISTS (
       SELECT 1 FROM json_each(slot.value) AS field
       WHERE field.key NOT IN ('slotId', 'modelTier') OR field.type <> 'text'
          OR length(CAST(field.value AS TEXT)) NOT BETWEEN 1 AND 64
          OR CAST(field.value AS TEXT) GLOB '*[^a-z0-9._-]*'
     )
     OR json_extract(slot.value, '$.slotId') NOT IN ('text_tier_a', 'text_tier_b')
     OR json_type(slot.value, '$.modelTier') <> 'text'
)
OR (SELECT count(DISTINCT json_extract(value, '$.slotId')) FROM json_each(NEW.model_slots_json)) <> 2
OR (SELECT count(DISTINCT json_extract(value, '$.modelTier')) FROM json_each(NEW.model_slots_json)) <> 2
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation model slots must be distinct content-free identifiers'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_suite_immutable
BEFORE UPDATE ON novel_skill_evaluation_suites
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation suite is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_suite_delete_guard
BEFORE DELETE ON novel_skill_evaluation_suites
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation suite cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_fixtures (
  suite_id TEXT NOT NULL REFERENCES novel_skill_evaluation_suites(id) ON DELETE RESTRICT,
  fixture_id TEXT NOT NULL CHECK (length(fixture_id) BETWEEN 3 AND 96
    AND fixture_id GLOB '[a-z]*' AND fixture_id NOT GLOB '*[^a-z0-9._-]*'),
  language TEXT NOT NULL CHECK (language = 'zh-CN'),
  origin TEXT NOT NULL CHECK (origin = 'inkshadow_original_short_contract'),
  task_type TEXT NOT NULL CHECK (task_type IN (
    'idea_discussion','book_start_guidance','prose_generation','continuation','rewrite','polish',
    'outline_planning','scene_breakdown','chapter_summary','long_memory_compression',
    'character_extraction','world_extraction','contradiction_check','pov_check',
    'character_voice_check','content_quality_check','what_if_simulation','embedding','rerank',
    'image_generation','vision_understanding','translation'
  )),
  invocation_mode TEXT NOT NULL CHECK (invocation_mode IN ('coach','collaborator','draft','critic','revision','explorer')),
  genre_tags_json TEXT NOT NULL CHECK (json_valid(genre_tags_json) = 1 AND json_type(genre_tags_json) = 'array'
    AND json_array_length(genre_tags_json) BETWEEN 1 AND 8 AND length(genre_tags_json) <= 512),
  coverage_dimensions_json TEXT NOT NULL CHECK (
    json_valid(coverage_dimensions_json) = 1
    AND json_type(coverage_dimensions_json) = 'array'
    AND json_array_length(coverage_dimensions_json) BETWEEN 1 AND 12
    AND length(coverage_dimensions_json) <= 512
  ),
  contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64 AND contract_hash = lower(contract_hash)
    AND contract_hash NOT GLOB '*[^0-9a-f]*'),
  input_content_hash TEXT NOT NULL CHECK (length(input_content_hash) = 64
    AND input_content_hash = lower(input_content_hash)
    AND input_content_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (suite_id, fixture_id)
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_fixture_metadata_guard
BEFORE INSERT ON novel_skill_evaluation_fixtures
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.genre_tags_json)
  WHERE type <> 'text' OR length(CAST(value AS TEXT)) NOT BETWEEN 1 AND 64
    OR CAST(value AS TEXT) GLOB '*[^a-z0-9._-]*'
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.coverage_dimensions_json)
  WHERE type <> 'text' OR value NOT IN (
    'youth_romance','suspense','fantasy','light_novel','web_novel','literary',
    'multi_character_dialogue','pov','timeline','rule_conflict','continuation','rewrite'
  )
)
OR (SELECT count(DISTINCT value) FROM json_each(NEW.coverage_dimensions_json))
   <> json_array_length(NEW.coverage_dimensions_json)
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation fixture metadata must be content-free'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_fixture_immutable
BEFORE UPDATE ON novel_skill_evaluation_fixtures
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation fixture is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_fixture_delete_guard
BEFORE DELETE ON novel_skill_evaluation_fixtures
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation fixture cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_project_status_guard
BEFORE UPDATE OF status, archived_at, trashed_at ON projects
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites AS suite
  WHERE suite.evaluation_project_id = OLD.id
)
AND (NEW.status <> 'archived' OR NEW.archived_at IS NULL OR NEW.trashed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation project must remain archived'); END;

-- Exact target/considered definition manifests for every Skill arm.  A
-- fixture may legitimately have no applicable Core or Genre method, but the
-- compiler must still have considered every immutable target definition and
-- recorded the deterministic reason why it was not selected.
CREATE TABLE IF NOT EXISTS novel_skill_evaluation_manifest_items (
  suite_id TEXT NOT NULL REFERENCES novel_skill_evaluation_suites(id) ON DELETE RESTRICT,
  arm TEXT NOT NULL CHECK (arm IN ('core','core_genre','core_genre_preferences')),
  item_order INTEGER NOT NULL CHECK (item_order BETWEEN 1 AND 64),
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64
    AND definition_hash = lower(definition_hash)
    AND definition_hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('core','genre')),
  PRIMARY KEY (suite_id, arm, item_order),
  UNIQUE (suite_id, arm, skill_id),
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES novel_skill_definitions(skill_id, version) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_manifest_item_guard
BEFORE INSERT ON novel_skill_evaluation_manifest_items
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_definitions AS definition
  WHERE definition.skill_id = NEW.skill_id
    AND definition.version = NEW.skill_version
    AND definition.definition_hash = NEW.definition_hash
    AND definition.kind = NEW.kind
    AND definition.owner_scope = 'builtin'
)
OR (NEW.arm = 'core' AND NEW.kind <> 'core')
OR EXISTS (SELECT 1 FROM novel_skill_evaluation_runs WHERE suite_id = NEW.suite_id)
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation manifest item is not an exact builtin target'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_manifest_item_immutable
BEFORE UPDATE ON novel_skill_evaluation_manifest_items
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation manifest item is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_manifest_item_delete_guard
BEFORE DELETE ON novel_skill_evaluation_manifest_items
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation manifest item cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id) AND substr(id, 15, 1) = '7'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  suite_id TEXT NOT NULL REFERENCES novel_skill_evaluation_suites(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('planned','running','completed','invalidated')),
  evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('NOT_EVALUATED','EVIDENCE_INCOMPLETE','FAILED','ELIGIBLE_FOR_REVIEW')),
  evaluation_result_hash TEXT CHECK (evaluation_result_hash IS NULL OR (
    length(evaluation_result_hash) = 64 AND evaluation_result_hash = lower(evaluation_result_hash)
    AND evaluation_result_hash NOT GLOB '*[^0-9a-f]*')),
  model_assignments_json TEXT NOT NULL CHECK (json_valid(model_assignments_json) = 1
    AND json_type(model_assignments_json) = 'array' AND json_array_length(model_assignments_json) = 2
    AND length(model_assignments_json) BETWEEN 160 AND 1024),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  started_at TEXT CHECK (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at),
  completed_at TEXT CHECK (completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  UNIQUE (id, suite_id),
  CHECK ((status = 'planned' AND evaluation_status = 'NOT_EVALUATED' AND evaluation_result_hash IS NULL
          AND started_at IS NULL AND completed_at IS NULL)
      OR (status = 'running' AND evaluation_status = 'NOT_EVALUATED' AND evaluation_result_hash IS NULL
          AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (status = 'completed' AND evaluation_status IN ('FAILED','ELIGIBLE_FOR_REVIEW')
          AND evaluation_result_hash IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL)
      OR (status = 'invalidated' AND evaluation_status = 'EVIDENCE_INCOMPLETE'
          AND evaluation_result_hash IS NULL AND completed_at IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_run_insert_guard
BEFORE INSERT ON novel_skill_evaluation_runs
WHEN NEW.status <> 'planned' OR NEW.evaluation_status <> 'NOT_EVALUATED'
  OR NEW.evaluation_result_hash IS NOT NULL OR NEW.revision <> 1
  OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.model_assignments_json) AS assignment
    WHERE assignment.type <> 'object' OR (SELECT count(*) FROM json_each(assignment.value)) <> 3
      OR json_extract(assignment.value, '$.slotId') NOT IN ('text_tier_a','text_tier_b')
      OR json_type(assignment.value, '$.modelIdentityHash') <> 'text'
      OR length(json_extract(assignment.value, '$.modelIdentityHash')) <> 64
      OR json_extract(assignment.value, '$.modelIdentityHash') GLOB '*[^0-9a-f]*'
      OR json_type(assignment.value, '$.modelArtifactHash') <> 'text'
      OR length(json_extract(assignment.value, '$.modelArtifactHash')) <> 64
      OR json_extract(assignment.value, '$.modelArtifactHash') GLOB '*[^0-9a-f]*'
  )
  OR (SELECT count(DISTINCT json_extract(value, '$.slotId')) FROM json_each(NEW.model_assignments_json)) <> 2
  OR (SELECT count(DISTINCT json_extract(value, '$.modelIdentityHash')) FROM json_each(NEW.model_assignments_json)) <> 2
  OR (SELECT count(DISTINCT json_extract(value, '$.modelArtifactHash')) FROM json_each(NEW.model_assignments_json)) <> 2
  OR (SELECT count(*) FROM novel_skill_evaluation_manifest_items
      WHERE suite_id = NEW.suite_id AND arm = 'core') = 0
  OR (SELECT count(*) FROM novel_skill_evaluation_manifest_items
      WHERE suite_id = NEW.suite_id AND arm = 'core_genre') = 0
  OR (SELECT count(*) FROM novel_skill_evaluation_manifest_items
      WHERE suite_id = NEW.suite_id AND arm = 'core_genre_preferences') = 0
  OR EXISTS (SELECT 1 FROM novel_skill_evaluation_manifest_items
      WHERE suite_id = NEW.suite_id AND arm = 'core' AND kind <> 'core')
  OR NOT EXISTS (SELECT 1 FROM novel_skill_evaluation_manifest_items
      WHERE suite_id = NEW.suite_id AND arm = 'core_genre' AND kind = 'genre')
  OR NOT EXISTS (SELECT 1 FROM novel_skill_evaluation_manifest_items
      WHERE suite_id = NEW.suite_id AND arm = 'core_genre_preferences' AND kind = 'genre')
  OR (SELECT count(DISTINCT dimension.value)
      FROM novel_skill_evaluation_fixtures AS fixture,
           json_each(fixture.coverage_dimensions_json) AS dimension
      WHERE fixture.suite_id = NEW.suite_id
        AND dimension.value IN (
          'youth_romance','suspense','fantasy','light_novel','web_novel','literary',
          'multi_character_dialogue','pov','timeline','rule_conflict','continuation','rewrite'
        )) <> 12
  OR NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
    WHERE suite.id = NEW.suite_id AND project.status = 'archived'
      AND project.archived_at IS NOT NULL AND project.trashed_at IS NULL
  )
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation run must begin as a distinct two-model planned run'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_run_revision_guard
BEFORE UPDATE ON novel_skill_evaluation_runs
WHEN NEW.id <> OLD.id OR NEW.suite_id <> OLD.suite_id OR NEW.created_at <> OLD.created_at
  OR NEW.model_assignments_json <> OLD.model_assignments_json OR NEW.revision <> OLD.revision + 1
  OR (NEW.status IN ('running','completed') AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
    WHERE suite.id = OLD.suite_id AND project.status = 'archived'
      AND project.archived_at IS NOT NULL AND project.trashed_at IS NULL
  ))
  OR NOT (
    (OLD.status = 'planned' AND NEW.status = 'running' AND NEW.evaluation_status = 'NOT_EVALUATED'
      AND NEW.evaluation_result_hash IS NULL AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
    OR (OLD.status IN ('planned','running') AND NEW.status = 'invalidated'
      AND NEW.evaluation_status = 'EVIDENCE_INCOMPLETE' AND NEW.evaluation_result_hash IS NULL
      AND NEW.completed_at IS NOT NULL)
    OR (OLD.status = 'running' AND NEW.status = 'completed'
      AND NEW.evaluation_status IN ('FAILED','ELIGIBLE_FOR_REVIEW')
      AND NEW.evaluation_result_hash IS NOT NULL AND NEW.completed_at IS NOT NULL
      AND (SELECT count(*) FROM novel_skill_evaluation_cells WHERE run_id = OLD.id) = 192
      AND (SELECT count(*) FROM novel_skill_evaluation_cells WHERE run_id = OLD.id AND state = 'observed') = 192
      AND (SELECT count(*) FROM novel_skill_evaluation_observations WHERE run_id = OLD.id) = 192
      AND (SELECT count(*) FROM novel_skill_evaluation_scores AS score
           INNER JOIN novel_skill_evaluation_observations AS observation
             ON observation.id = score.observation_id
           WHERE observation.run_id = OLD.id) = 2496
      AND NOT EXISTS (
        SELECT 1 FROM novel_skill_evaluation_scores AS score
        INNER JOIN novel_skill_evaluation_observations AS observation
          ON observation.id = score.observation_id
        WHERE observation.run_id = OLD.id
          AND score.score_basis_points IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM novel_skill_evaluation_manifest_items AS target
        WHERE target.suite_id = OLD.suite_id
          AND target.arm = 'core_genre_preferences'
          AND NOT EXISTS (
            SELECT 1
            FROM novel_skill_evaluation_observations AS observation
            INNER JOIN novel_skill_evaluation_cells AS cell
              ON cell.id = observation.cell_id AND cell.run_id = OLD.id
            INNER JOIN novel_skill_invocation_items AS item
              ON item.snapshot_id = observation.novel_skill_snapshot_id
             AND item.skill_id = target.skill_id
             AND item.skill_version = target.skill_version
             AND item.definition_hash = target.definition_hash
             AND item.included = 1
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM novel_skill_evaluation_suites AS suite
        WHERE suite.id = OLD.suite_id
          AND (
            EXISTS (SELECT 1 FROM chapters WHERE project_id = suite.evaluation_project_id)
            OR EXISTS (SELECT 1 FROM story_facts WHERE project_id = suite.evaluation_project_id)
            OR EXISTS (SELECT 1 FROM project_seeds WHERE project_id = suite.evaluation_project_id)
            OR EXISTS (SELECT 1 FROM story_planning_candidates WHERE project_id = suite.evaluation_project_id)
            OR EXISTS (SELECT 1 FROM writing_preferences WHERE project_id = suite.evaluation_project_id)
            OR EXISTS (SELECT 1 FROM story_settings_import_receipts WHERE project_id = suite.evaluation_project_id)
          )
      ))
  )
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation run transition is not evidence-complete'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_run_delete_guard
BEFORE DELETE ON novel_skill_evaluation_runs
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation run cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_cells (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id) AND substr(id, 15, 1) = '7'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('no_skill','core','core_genre','core_genre_preferences')),
  arm_configuration_hash TEXT CHECK (arm_configuration_hash IS NULL OR (length(arm_configuration_hash) = 64
    AND arm_configuration_hash = lower(arm_configuration_hash)
    AND arm_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  model_slot_id TEXT NOT NULL CHECK (model_slot_id IN ('text_tier_a','text_tier_b')),
  model_tier TEXT NOT NULL CHECK (length(model_tier) BETWEEN 1 AND 64
    AND model_tier NOT GLOB '*[^a-z0-9._-]*'),
  repetition INTEGER NOT NULL CHECK (repetition IN (1, 2)),
  state TEXT NOT NULL CHECK (state IN ('planned','observed','invalidated')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  UNIQUE (run_id, fixture_id, arm, model_slot_id, repetition),
  FOREIGN KEY (run_id, suite_id) REFERENCES novel_skill_evaluation_runs(id, suite_id) ON DELETE RESTRICT,
  FOREIGN KEY (suite_id, fixture_id) REFERENCES novel_skill_evaluation_fixtures(suite_id, fixture_id) ON DELETE RESTRICT,
  CHECK ((arm = 'no_skill' AND arm_configuration_hash IS NULL)
      OR (arm <> 'no_skill' AND arm_configuration_hash IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_cell_plan_guard
BEFORE INSERT ON novel_skill_evaluation_cells
WHEN NEW.state <> 'planned'
  OR NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite, json_each(suite.model_slots_json) AS slot
    WHERE suite.id = NEW.suite_id AND json_extract(slot.value, '$.slotId') = NEW.model_slot_id
      AND json_extract(slot.value, '$.modelTier') = NEW.model_tier
      AND NEW.arm_configuration_hash IS CASE NEW.arm
        WHEN 'no_skill' THEN NULL
        WHEN 'core' THEN suite.core_manifest_hash
        WHEN 'core_genre' THEN suite.core_genre_manifest_hash
        WHEN 'core_genre_preferences' THEN suite.core_genre_preferences_manifest_hash END
  )
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation cell is outside its exact suite matrix'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_cell_immutable
BEFORE UPDATE ON novel_skill_evaluation_cells
WHEN NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id OR NEW.suite_id <> OLD.suite_id
  OR NEW.fixture_id <> OLD.fixture_id OR NEW.arm <> OLD.arm
  OR NEW.arm_configuration_hash IS NOT OLD.arm_configuration_hash
  OR NEW.model_slot_id <> OLD.model_slot_id OR NEW.model_tier <> OLD.model_tier
  OR NEW.repetition <> OLD.repetition OR NEW.created_at <> OLD.created_at
  OR NOT (OLD.state = 'planned' AND NEW.state IN ('observed','invalidated'))
  OR (NEW.state = 'observed' AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_observations AS observation
    WHERE observation.cell_id = OLD.id AND observation.run_id = OLD.run_id
      AND (SELECT count(*) FROM novel_skill_evaluation_scores AS score
           WHERE score.observation_id = observation.id) = 13
  ))
  OR (NEW.state = 'invalidated' AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_runs AS run
    WHERE run.id = OLD.run_id AND run.status = 'invalidated'
  ))
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation cell is immutable except terminal observation'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_cell_delete_guard
BEFORE DELETE ON novel_skill_evaluation_cells
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation cell cannot be deleted'); END;

-- A cell may need more than one paid dispatch because the provider can fail or
-- the user can stop a run.  Attempts are a bounded, content-free audit trail;
-- they never contain fixture input, prompt text, visible output or reasoning.
CREATE TABLE IF NOT EXISTS novel_skill_evaluation_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id) AND substr(id, 15, 1) = '7'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  cell_id TEXT NOT NULL REFERENCES novel_skill_evaluation_cells(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','cancelled')),
  context_trace_id TEXT UNIQUE REFERENCES context_compilation_runs(id) ON DELETE RESTRICT,
  model_invocation_id TEXT UNIQUE REFERENCES model_invocation_facts(id) ON DELETE RESTRICT,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'RUN_INVALIDATED','USER_CANCELLED','PRE_DISPATCH_CANCELLED','PREFLIGHT_FAILED',
    'MODEL_TIMEOUT','MODEL_RATE_LIMITED','MODEL_AUTH_FAILED','MODEL_CONNECTION_FAILED',
    'MODEL_PROVIDER_ERROR','MODEL_OUTPUT_EMPTY','MODEL_OUTPUT_TRUNCATED','MODEL_POLICY_BLOCKED',
    'CONTEXT_COMPILATION_FAILED','CANDIDATE_PERSIST_FAILED','DISPATCH_INTERRUPTED',
    'UNKNOWN_PROVIDER_FAILURE'
  )),
  started_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at),
  completed_at TEXT CHECK (completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at),
  UNIQUE (cell_id, attempt_number),
  CHECK ((status = 'started'
          AND ((context_trace_id IS NULL AND model_invocation_id IS NULL)
            OR (context_trace_id IS NOT NULL AND model_invocation_id IS NOT NULL))
          AND error_code IS NULL AND completed_at IS NULL)
      OR (status = 'succeeded' AND context_trace_id IS NOT NULL AND model_invocation_id IS NOT NULL
          AND error_code IS NULL AND completed_at IS NOT NULL)
      OR (status IN ('failed','cancelled') AND completed_at IS NOT NULL
          AND error_code IS NOT NULL
          AND ((context_trace_id IS NULL AND model_invocation_id IS NULL)
            OR (context_trace_id IS NOT NULL AND model_invocation_id IS NOT NULL))))
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_attempt_insert_guard
BEFORE INSERT ON novel_skill_evaluation_attempts
WHEN NEW.status <> 'started' OR NEW.attempt_number <> 1 + COALESCE((
    SELECT max(attempt_number) FROM novel_skill_evaluation_attempts WHERE cell_id = NEW.cell_id
  ), 0)
  OR NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_cells AS cell
    INNER JOIN novel_skill_evaluation_runs AS run ON run.id = cell.run_id
    INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
    INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
    WHERE cell.id = NEW.cell_id AND cell.run_id = NEW.run_id AND cell.state = 'planned'
      AND run.status = 'running' AND project.status = 'archived'
      AND project.archived_at IS NOT NULL AND project.trashed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM novel_skill_evaluation_observations WHERE cell_id = cell.id)
  )
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation attempt is outside an active pending cell'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_attempt_revision_guard
BEFORE UPDATE ON novel_skill_evaluation_attempts
WHEN NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id OR NEW.cell_id <> OLD.cell_id
  OR NEW.attempt_number <> OLD.attempt_number OR NEW.started_at <> OLD.started_at
  OR OLD.status <> 'started'
  OR NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_cells AS cell
    INNER JOIN novel_skill_evaluation_runs AS run ON run.id = cell.run_id
    INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
    INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
    WHERE cell.id = OLD.cell_id AND cell.run_id = OLD.run_id AND cell.state = 'planned'
      AND run.status = 'running' AND project.status = 'archived'
      AND project.archived_at IS NOT NULL AND project.trashed_at IS NULL
  )
  OR NOT (
    (NEW.status = 'started'
      AND OLD.context_trace_id IS NULL AND OLD.model_invocation_id IS NULL
      AND NEW.context_trace_id IS NOT NULL AND NEW.model_invocation_id IS NOT NULL
      AND NEW.error_code IS NULL AND NEW.completed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM novel_skill_evaluation_cells AS cell
        INNER JOIN novel_skill_evaluation_runs AS run ON run.id = cell.run_id
        INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
        INNER JOIN novel_skill_evaluation_fixtures AS fixture
          ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
        INNER JOIN context_compilation_runs AS trace ON trace.id = NEW.context_trace_id
        INNER JOIN model_invocation_facts AS invocation ON invocation.id = NEW.model_invocation_id
        WHERE cell.id = OLD.cell_id AND trace.project_id = suite.evaluation_project_id
          AND trace.chapter_id IS NULL AND trace.task_type = fixture.task_type
          AND invocation.task = fixture.task_type
          AND EXISTS (
            SELECT 1 FROM context_compilation_entries AS entry
            INNER JOIN context_compilation_entry_sources AS source
              ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
            WHERE entry.run_id = trace.id AND entry.included = 1
              AND entry.layer = 'current_task'
              AND entry.candidate_id = 'evaluation-fixture:' || fixture.fixture_id
              AND source.source_type = 'user_input' AND source.source_id = fixture.fixture_id
              AND source.source_version_id IS NULL
              AND source.locator = 'novel_skill_evaluation_fixture'
              AND source.content_hash = fixture.input_content_hash
          )
          AND NOT EXISTS (
            SELECT 1 FROM context_compilation_entries AS entry
            LEFT JOIN context_compilation_entry_sources AS source
              ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
            WHERE entry.run_id = trace.id AND NOT (
              (entry.layer = 'current_task'
                AND entry.candidate_id = 'evaluation-fixture:' || fixture.fixture_id
                AND source.source_type = 'user_input' AND source.source_id = fixture.fixture_id
                AND source.source_version_id IS NULL
                AND source.locator = 'novel_skill_evaluation_fixture'
                AND source.content_hash = fixture.input_content_hash)
              OR (entry.layer <> 'current_task'
                AND entry.candidate_id =
                  'evaluation-fixture-layer:' || fixture.fixture_id || ':' || entry.layer
                AND source.source_type = 'user_input' AND source.source_id = fixture.fixture_id
                AND source.source_version_id IS NULL
                AND source.locator = 'novel_skill_evaluation_fixture_contract'
                AND source.content_hash = fixture.contract_hash)
              OR (cell.arm = 'core_genre_preferences'
                AND entry.candidate_id GLOB 'writing-preference:*'
                AND source.source_type = 'user_input'
                AND source.locator = 'writing_preference'
                AND source.content_hash IS NOT NULL)
            )
          )
      ))
    OR (NEW.status IN ('succeeded','failed','cancelled')
      AND NEW.context_trace_id IS OLD.context_trace_id
      AND NEW.model_invocation_id IS OLD.model_invocation_id
      AND NEW.completed_at IS NOT NULL
      AND ((NEW.status = 'succeeded' AND OLD.context_trace_id IS NOT NULL
            AND NEW.error_code IS NULL)
        OR (NEW.status IN ('failed','cancelled') AND NEW.error_code IS NOT NULL)))
  )
  OR (NEW.context_trace_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_compilation_model_invocation_links
    WHERE trace_id = NEW.context_trace_id AND model_invocation_id = NEW.model_invocation_id
  ))
  OR (NEW.status = 'succeeded' AND NOT EXISTS (
    SELECT 1 FROM model_invocation_facts AS invocation
    WHERE invocation.id = NEW.model_invocation_id AND invocation.status = 'succeeded'
      AND invocation.started_at IS NOT NULL AND invocation.completed_at IS NOT NULL
      AND invocation.error_code IS NULL AND invocation.visible_content_length > 0
      AND (invocation.finish_reason IS NULL OR invocation.finish_reason NOT IN ('length','max_tokens','max_output_tokens'))
  ))
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation attempt transition lacks exact terminal evidence'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_attempt_delete_guard
BEFORE DELETE ON novel_skill_evaluation_attempts
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation attempt cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_observations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id) AND substr(id, 15, 1) = '7'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  cell_id TEXT NOT NULL UNIQUE REFERENCES novel_skill_evaluation_cells(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES novel_skill_evaluation_attempts(id) ON DELETE RESTRICT,
  context_trace_id TEXT NOT NULL UNIQUE REFERENCES context_compilation_runs(id) ON DELETE RESTRICT,
  model_invocation_id TEXT NOT NULL UNIQUE REFERENCES model_invocation_facts(id) ON DELETE RESTRICT,
  output_candidate_id TEXT NOT NULL UNIQUE REFERENCES ai_candidates(id) ON DELETE RESTRICT,
  novel_skill_snapshot_id TEXT UNIQUE REFERENCES novel_skill_invocation_snapshots(id) ON DELETE RESTRICT,
  model_identity_hash TEXT NOT NULL CHECK (length(model_identity_hash) = 64
    AND model_identity_hash = lower(model_identity_hash) AND model_identity_hash NOT GLOB '*[^0-9a-f]*'),
  model_artifact_hash TEXT NOT NULL CHECK (length(model_artifact_hash) = 64
    AND model_artifact_hash = lower(model_artifact_hash) AND model_artifact_hash NOT GLOB '*[^0-9a-f]*'),
  arm_configuration_hash TEXT CHECK (arm_configuration_hash IS NULL OR (length(arm_configuration_hash) = 64
    AND arm_configuration_hash = lower(arm_configuration_hash)
    AND arm_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  preference_configuration_hash TEXT CHECK (preference_configuration_hash IS NULL OR (
    length(preference_configuration_hash) = 64 AND preference_configuration_hash = lower(preference_configuration_hash)
    AND preference_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  evaluator_version TEXT NOT NULL CHECK (evaluator_version = 'novel-skill-ab@1'),
  result_hash TEXT NOT NULL CHECK (length(result_hash) = 64 AND result_hash = lower(result_hash)
    AND result_hash NOT GLOB '*[^0-9a-f]*'),
  latency_milliseconds INTEGER NOT NULL CHECK (latency_milliseconds BETWEEN 0 AND 86400000),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 1000000000),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 1000000000),
  estimated_cost_micros INTEGER CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros BETWEEN 0 AND 2147483647),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
  ,FOREIGN KEY (context_trace_id, output_candidate_id)
    REFERENCES context_compilation_output_candidate_links(trace_id, ai_candidate_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS context_compilation_output_candidate_exact_idx
  ON context_compilation_output_candidate_links (trace_id, ai_candidate_id);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_observation_trace_guard
BEFORE INSERT ON novel_skill_evaluation_observations
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_cells AS cell
  INNER JOIN novel_skill_evaluation_runs AS run ON run.id = NEW.run_id AND run.id = cell.run_id
  INNER JOIN novel_skill_evaluation_attempts AS attempt
    ON attempt.id = NEW.attempt_id AND attempt.run_id = NEW.run_id AND attempt.cell_id = NEW.cell_id
  INNER JOIN novel_skill_evaluation_fixtures AS fixture
    ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
  INNER JOIN model_invocation_facts AS invocation ON invocation.id = NEW.model_invocation_id
  INNER JOIN context_compilation_model_invocation_links AS model_link
    ON model_link.model_invocation_id = invocation.id AND model_link.trace_id = NEW.context_trace_id
  INNER JOIN context_compilation_output_candidate_links AS output_link
    ON output_link.trace_id = NEW.context_trace_id
   AND output_link.ai_candidate_id = NEW.output_candidate_id
  INNER JOIN ai_candidates AS output_candidate ON output_candidate.id = output_link.ai_candidate_id
  INNER JOIN context_compilation_runs AS trace ON trace.id = NEW.context_trace_id
  INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = cell.suite_id
  INNER JOIN projects AS evaluation_project ON evaluation_project.id = suite.evaluation_project_id
  WHERE cell.id = NEW.cell_id AND cell.state = 'planned' AND run.status = 'running'
    AND attempt.status = 'succeeded' AND attempt.context_trace_id = NEW.context_trace_id
    AND attempt.model_invocation_id = NEW.model_invocation_id
    AND invocation.task = fixture.task_type AND invocation.status = 'succeeded'
    AND invocation.started_at IS NOT NULL AND invocation.completed_at IS NOT NULL
    AND invocation.error_code IS NULL AND invocation.visible_content_length > 0
    AND (invocation.finish_reason IS NULL OR invocation.finish_reason NOT IN ('length','max_tokens','max_output_tokens'))
    AND evaluation_project.status = 'archived' AND evaluation_project.archived_at IS NOT NULL
    AND evaluation_project.trashed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM chapters WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM story_facts WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM project_seeds WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM story_planning_candidates WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM writing_preferences WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM story_settings_import_receipts WHERE project_id = suite.evaluation_project_id)
    AND trace.project_id = suite.evaluation_project_id AND trace.chapter_id IS NULL
    AND trace.task_type = fixture.task_type
    AND output_candidate.project_id = suite.evaluation_project_id
    AND output_candidate.chapter_id IS NULL AND output_candidate.base_version_id IS NULL
    AND output_candidate.status = 'ready' AND output_candidate.incomplete = 0
    AND output_candidate.content <> ''
    AND output_candidate.content_checksum = NEW.result_hash
    AND length(output_candidate.content) = invocation.visible_content_length
    AND EXISTS (
      SELECT 1 FROM context_compilation_entries AS entry
      INNER JOIN context_compilation_entry_sources AS source
        ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
      WHERE entry.run_id = NEW.context_trace_id AND entry.included = 1
        AND entry.layer = 'current_task'
        AND entry.candidate_id = 'evaluation-fixture:' || fixture.fixture_id
        AND source.source_type = 'user_input'
        AND source.source_id = fixture.fixture_id
        AND source.locator = 'novel_skill_evaluation_fixture'
        AND source.content_hash = fixture.input_content_hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM context_compilation_entries AS entry
      LEFT JOIN context_compilation_entry_sources AS source
        ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
      WHERE entry.run_id = NEW.context_trace_id
        AND NOT (
          (entry.layer = 'current_task'
            AND entry.candidate_id = 'evaluation-fixture:' || fixture.fixture_id
            AND source.source_type = 'user_input'
            AND source.source_id = fixture.fixture_id
            AND source.locator = 'novel_skill_evaluation_fixture'
            AND source.content_hash = fixture.input_content_hash)
          OR (entry.layer <> 'current_task'
            AND entry.candidate_id = 'evaluation-fixture-layer:' || fixture.fixture_id || ':' || entry.layer
            AND source.source_type = 'user_input'
            AND source.source_id = fixture.fixture_id
            AND source.source_version_id IS NULL
            AND source.locator = 'novel_skill_evaluation_fixture_contract'
            AND source.content_hash = fixture.contract_hash)
          OR (cell.arm = 'core_genre_preferences'
            AND entry.candidate_id GLOB 'writing-preference:*'
            AND source.source_type = 'user_input'
            AND source.locator = 'writing_preference'
            AND source.content_hash IS NOT NULL)
        )
    )
    AND ((cell.arm = 'core_genre_preferences' AND EXISTS (
      SELECT 1 FROM context_compilation_entries AS entry
      INNER JOIN context_compilation_entry_sources AS source
        ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
      WHERE entry.run_id = NEW.context_trace_id AND entry.included = 1
        AND entry.candidate_id GLOB 'writing-preference:*'
        AND source.source_type = 'user_input' AND source.locator = 'writing_preference'
        AND source.content_hash IS NOT NULL
    )) OR (cell.arm <> 'core_genre_preferences' AND NOT EXISTS (
      SELECT 1 FROM context_compilation_entries AS entry
      INNER JOIN context_compilation_entry_sources AS source
        ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
      WHERE entry.run_id = NEW.context_trace_id AND entry.included = 1
        AND entry.candidate_id GLOB 'writing-preference:*'
        AND source.source_type = 'user_input' AND source.locator = 'writing_preference'
    )))
    AND NEW.model_identity_hash = (
      SELECT json_extract(value, '$.modelIdentityHash') FROM json_each(run.model_assignments_json)
      WHERE json_extract(value, '$.slotId') = cell.model_slot_id
    )
    AND NEW.model_artifact_hash = (
      SELECT json_extract(value, '$.modelArtifactHash') FROM json_each(run.model_assignments_json)
      WHERE json_extract(value, '$.slotId') = cell.model_slot_id
    )
)
OR EXISTS (SELECT 1 FROM novel_skill_evaluation_cells WHERE id = NEW.cell_id AND arm = 'no_skill')
  AND (
    NEW.novel_skill_snapshot_id IS NOT NULL OR NEW.arm_configuration_hash IS NOT NULL
    OR NEW.preference_configuration_hash IS NOT NULL
    OR EXISTS (SELECT 1 FROM novel_skill_invocation_snapshots
      WHERE model_invocation_id = NEW.model_invocation_id)
  )
OR EXISTS (SELECT 1 FROM novel_skill_evaluation_cells WHERE id = NEW.cell_id AND arm <> 'no_skill')
  AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_cells AS cell
    INNER JOIN novel_skill_invocation_snapshots AS snapshot
      ON snapshot.id = NEW.novel_skill_snapshot_id
     AND snapshot.model_invocation_id = NEW.model_invocation_id
     AND snapshot.context_trace_id = NEW.context_trace_id
    INNER JOIN novel_skill_evaluation_fixtures AS fixture
      ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
    WHERE cell.id = NEW.cell_id AND snapshot.task_type = (
      SELECT task_type FROM novel_skill_evaluation_fixtures
      WHERE suite_id = cell.suite_id AND fixture_id = cell.fixture_id
    )
      AND snapshot.compiler_version = (
        SELECT compiler_version FROM novel_skill_evaluation_suites WHERE id = cell.suite_id
      )
      AND json_extract(snapshot.configuration_snapshot_json, '$.compilerVersion') =
        snapshot.compiler_version
      AND json_extract(snapshot.configuration_snapshot_json, '$.taskType') = fixture.task_type
      AND json_extract(snapshot.configuration_snapshot_json, '$.invocationMode') = fixture.invocation_mode
      AND NOT EXISTS (
        SELECT 1 FROM json_each(snapshot.configuration_snapshot_json, '$.genreTags') AS configured
        WHERE NOT EXISTS (SELECT 1 FROM json_each(fixture.genre_tags_json) AS expected
                          WHERE expected.value = configured.value)
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(fixture.genre_tags_json) AS expected
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(snapshot.configuration_snapshot_json, '$.genreTags') AS configured
          WHERE configured.value = expected.value
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(snapshot.configuration_snapshot_json, '$.availableContextLayers') AS configured
        WHERE NOT EXISTS (
          SELECT 1 FROM context_compilation_entries AS entry
          WHERE entry.run_id = snapshot.context_trace_id AND entry.included = 1
            AND entry.layer = configured.value
        )
      )
      AND NOT EXISTS (
        SELECT DISTINCT entry.layer FROM context_compilation_entries AS entry
        WHERE entry.run_id = snapshot.context_trace_id AND entry.included = 1
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(snapshot.configuration_snapshot_json, '$.availableContextLayers') AS configured
            WHERE configured.value = entry.layer
          )
      )
      AND NEW.arm_configuration_hash = cell.arm_configuration_hash
      AND NOT EXISTS (
        SELECT 1 FROM novel_skill_evaluation_manifest_items AS manifest
        LEFT JOIN novel_skill_invocation_items AS item
          ON item.snapshot_id = snapshot.id
         AND item.skill_id = manifest.skill_id
         AND item.skill_version = manifest.skill_version
         AND item.definition_hash = manifest.definition_hash
        WHERE manifest.suite_id = cell.suite_id AND manifest.arm = cell.arm
          AND item.snapshot_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM novel_skill_invocation_items AS item
        LEFT JOIN novel_skill_evaluation_manifest_items AS manifest
          ON manifest.suite_id = cell.suite_id AND manifest.arm = cell.arm
         AND manifest.skill_id = item.skill_id
         AND manifest.skill_version = item.skill_version
         AND manifest.definition_hash = item.definition_hash
        WHERE item.snapshot_id = snapshot.id AND manifest.skill_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM novel_skill_invocation_items AS item
        INNER JOIN novel_skill_definitions AS definition
          ON definition.skill_id = item.skill_id AND definition.version = item.skill_version
        WHERE item.snapshot_id = snapshot.id
          AND (
            (item.included = 1 AND (
              NOT EXISTS (SELECT 1 FROM json_each(definition.task_types_json)
                WHERE value = fixture.task_type)
              OR NOT EXISTS (SELECT 1 FROM json_each(definition.activation_json, '$.allowedModes')
                WHERE value = fixture.invocation_mode)
              OR (json_array_length(definition.activation_json, '$.genreTags') > 0
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(definition.activation_json, '$.genreTags') AS target_tag
                  INNER JOIN json_each(fixture.genre_tags_json) AS fixture_tag
                    ON fixture_tag.value = target_tag.value
                ))
            ))
            OR (item.included = 0 AND NOT (
              (item.selection_reason = 'task_mismatch'
                AND NOT EXISTS (SELECT 1 FROM json_each(definition.task_types_json)
                  WHERE value = fixture.task_type))
              OR (item.selection_reason = 'mode_mismatch'
                AND EXISTS (SELECT 1 FROM json_each(definition.task_types_json)
                  WHERE value = fixture.task_type)
                AND NOT EXISTS (SELECT 1 FROM json_each(definition.activation_json, '$.allowedModes')
                  WHERE value = fixture.invocation_mode))
              OR (item.selection_reason = 'genre_mismatch'
                AND EXISTS (SELECT 1 FROM json_each(definition.task_types_json)
                  WHERE value = fixture.task_type)
                AND EXISTS (SELECT 1 FROM json_each(definition.activation_json, '$.allowedModes')
                  WHERE value = fixture.invocation_mode)
                AND json_array_length(definition.activation_json, '$.genreTags') > 0
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(definition.activation_json, '$.genreTags') AS target_tag
                  INNER JOIN json_each(fixture.genre_tags_json) AS fixture_tag
                    ON fixture_tag.value = target_tag.value
                ))
              OR (item.selection_reason = 'missing_context'
                AND EXISTS (SELECT 1 FROM json_each(definition.task_types_json)
                  WHERE value = fixture.task_type)
                AND EXISTS (SELECT 1 FROM json_each(definition.activation_json, '$.allowedModes')
                  WHERE value = fixture.invocation_mode)
                AND (json_array_length(definition.activation_json, '$.genreTags') = 0
                  OR EXISTS (
                    SELECT 1 FROM json_each(definition.activation_json, '$.genreTags') AS target_tag
                    INNER JOIN json_each(fixture.genre_tags_json) AS fixture_tag
                      ON fixture_tag.value = target_tag.value
                  ))
                AND EXISTS (
                  SELECT 1 FROM json_each(definition.context_requirements_json, '$.requiredLayers') AS required
                  WHERE NOT EXISTS (
                    SELECT 1 FROM json_each(
                      snapshot.configuration_snapshot_json, '$.availableContextLayers'
                    ) AS available
                    WHERE available.value = required.value
                  )
                ))
            ))
          )
      )
      AND ((cell.arm = 'core_genre_preferences' AND NEW.preference_configuration_hash = (
          SELECT preference_configuration_hash FROM novel_skill_evaluation_suites WHERE id = cell.suite_id
        )) OR (cell.arm <> 'core_genre_preferences' AND NEW.preference_configuration_hash IS NULL))
  )
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation observation lacks successful exact arm evidence'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_observation_immutable
BEFORE UPDATE ON novel_skill_evaluation_observations
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation observation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_observation_delete_guard
BEFORE DELETE ON novel_skill_evaluation_observations
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation observation cannot be deleted'); END;

-- Evidence membership cannot be changed after an observation has sealed it.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_no_skill_late_snapshot_guard
BEFORE INSERT ON novel_skill_invocation_snapshots
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations AS observation
  INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id
  WHERE observation.model_invocation_id = NEW.model_invocation_id AND cell.arm = 'no_skill'
)
BEGIN SELECT RAISE(ABORT, 'no-skill evaluation evidence cannot gain a late snapshot'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_observed_item_insert_guard
BEFORE INSERT ON novel_skill_invocation_items
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE novel_skill_snapshot_id = NEW.snapshot_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation Skill membership is frozen'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_observed_item_delete_guard
BEFORE DELETE ON novel_skill_invocation_items
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE novel_skill_snapshot_id = OLD.snapshot_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation Skill membership is frozen'); END;

-- Once an observation exists, every external receipt it sealed is immutable
-- for evaluation purposes.  These conditional guards leave normal creative
-- records mutable while preventing equal-score evidence substitution.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_candidate_update_guard
BEFORE UPDATE ON ai_candidates
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE output_candidate_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation Candidate is frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_candidate_delete_guard
BEFORE DELETE ON ai_candidates
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE output_candidate_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation Candidate cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_trace_update_guard
BEFORE UPDATE ON context_compilation_runs
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation trace is frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_entry_insert_guard
BEFORE INSERT ON context_compilation_entries
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation trace cannot gain entries'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_entry_delete_guard
BEFORE DELETE ON context_compilation_entries
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation trace cannot lose entries'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_source_insert_guard
BEFORE INSERT ON context_compilation_entry_sources
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation trace cannot gain sources'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_source_update_guard
BEFORE UPDATE ON context_compilation_entry_sources
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation source is frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_source_delete_guard
BEFORE DELETE ON context_compilation_entry_sources
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation trace cannot lose sources'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_execution_link_delete_guard
BEFORE DELETE ON context_compilation_execution_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = OLD.trace_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation execution link cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_model_link_delete_guard
BEFORE DELETE ON context_compilation_model_invocation_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE context_trace_id = OLD.trace_id AND model_invocation_id = OLD.model_invocation_id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation model link cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_invocation_update_guard
BEFORE UPDATE ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE model_invocation_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation invocation is frozen'); END;

-- A dedicated evaluation workspace may contain only its isolated evaluation
-- Candidate and trace chain. User-authored project state cannot be inserted or
-- moved into it after the suite has been created.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_chapter_insert_guard
BEFORE INSERT ON chapters
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain chapters'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_chapter_project_update_guard
BEFORE UPDATE OF project_id ON chapters
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'chapter cannot move into an evaluation project'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_story_fact_insert_guard
BEFORE INSERT ON story_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain story facts'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_story_fact_project_update_guard
BEFORE UPDATE OF project_id ON story_facts
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'story fact cannot move into an evaluation project'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_project_seed_insert_guard
BEFORE INSERT ON project_seeds
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain project seeds'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_project_seed_project_update_guard
BEFORE UPDATE OF project_id ON project_seeds
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'project seed cannot move into an evaluation project'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_planning_candidate_insert_guard
BEFORE INSERT ON story_planning_candidates
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain planning candidates'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_planning_candidate_project_update_guard
BEFORE UPDATE OF project_id ON story_planning_candidates
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'planning candidate cannot move into an evaluation project'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_writing_preference_insert_guard
BEFORE INSERT ON writing_preferences
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain writing preferences'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_writing_preference_project_update_guard
BEFORE UPDATE OF project_id ON writing_preferences
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'writing preference cannot move into an evaluation project'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_settings_receipt_insert_guard
BEFORE INSERT ON story_settings_import_receipts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain settings import receipts'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_settings_receipt_project_update_guard
BEFORE UPDATE OF project_id ON story_settings_import_receipts
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'settings receipt cannot move into an evaluation project'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_skill_binding_insert_guard
BEFORE INSERT ON project_novel_skill_bindings
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot contain Novel Skill bindings'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_skill_binding_project_update_guard
BEFORE UPDATE OF project_id ON project_novel_skill_bindings
WHEN NEW.project_id IS NOT OLD.project_id AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites WHERE evaluation_project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'Novel Skill binding cannot move into an evaluation project'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_scores (
  observation_id TEXT NOT NULL REFERENCES novel_skill_evaluation_observations(id) ON DELETE RESTRICT,
  metric TEXT NOT NULL CHECK (metric IN (
    'instruction_following','canon_preservation','character_consistency','pov_preservation',
    'causal_progression','scene_function','dialogue_distinction','specificity',
    'repetition_cliche_control','pacing','user_preference',
    'unnecessary_rewrite_avoidance','evidence_completeness'
  )),
  score_basis_points INTEGER NOT NULL CHECK (score_basis_points BETWEEN 0 AND 10000),
  reviewer_id TEXT NOT NULL CHECK (length(reviewer_id) BETWEEN 3 AND 128
    AND reviewer_id GLOB '[a-z0-9]*' AND reviewer_id NOT GLOB '*[^a-z0-9._:-]*'),
  rubric_version TEXT NOT NULL CHECK (rubric_version = 'novel-skill-human-rubric@1'),
  scored_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', scored_at) = scored_at),
  PRIMARY KEY (observation_id, metric)
);
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_score_immutable
BEFORE UPDATE ON novel_skill_evaluation_scores
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation score is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_score_delete_guard
BEFORE DELETE ON novel_skill_evaluation_scores
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation score cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_manual_decisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id) AND substr(id, 15, 1) = '7'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  target_manifest_hash TEXT NOT NULL CHECK (length(target_manifest_hash) = 64
    AND target_manifest_hash = lower(target_manifest_hash)
    AND target_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  decision TEXT NOT NULL CHECK (decision IN ('KEEP_DISABLED','APPROVE_EXPERIMENTAL_BINDING','REJECT_ENABLEMENT')),
  rationale_hash TEXT NOT NULL CHECK (length(rationale_hash) = 64 AND rationale_hash = lower(rationale_hash)
    AND rationale_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_manual_decision_gate
BEFORE INSERT ON novel_skill_evaluation_manual_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
  INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
  WHERE run.id = NEW.run_id AND run.status IN ('completed','invalidated')
    AND project.status = 'archived' AND project.archived_at IS NOT NULL
    AND project.trashed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM chapters WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM story_facts WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM project_seeds WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM story_planning_candidates WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM writing_preferences WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM story_settings_import_receipts WHERE project_id = suite.evaluation_project_id)
    AND NOT EXISTS (SELECT 1 FROM project_novel_skill_bindings WHERE project_id = suite.evaluation_project_id)
    AND suite.target_manifest_hash = NEW.target_manifest_hash
    AND (NEW.decision <> 'APPROVE_EXPERIMENTAL_BINDING'
      OR (run.evaluation_status = 'ELIGIBLE_FOR_REVIEW' AND run.evaluation_result_hash IS NOT NULL))
)
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation decision lacks terminal exact-manifest evidence'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_manual_decision_immutable
BEFORE UPDATE ON novel_skill_evaluation_manual_decisions
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation manual decision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_manual_decision_delete_guard
BEFORE DELETE ON novel_skill_evaluation_manual_decisions
BEGIN SELECT RAISE(ABORT, 'novel skill evaluation manual decision cannot be deleted'); END;

CREATE INDEX IF NOT EXISTS novel_skill_evaluation_runs_suite_idx ON novel_skill_evaluation_runs (suite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS novel_skill_evaluation_cells_run_idx ON novel_skill_evaluation_cells (run_id, state, fixture_id);
CREATE INDEX IF NOT EXISTS novel_skill_evaluation_attempts_cell_idx ON novel_skill_evaluation_attempts (cell_id, attempt_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS novel_skill_evaluation_one_started_attempt_idx
  ON novel_skill_evaluation_attempts (cell_id) WHERE status = 'started';
CREATE INDEX IF NOT EXISTS novel_skill_evaluation_observations_run_idx ON novel_skill_evaluation_observations (run_id, created_at DESC);
