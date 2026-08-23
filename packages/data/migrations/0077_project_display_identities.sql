PRAGMA foreign_keys = ON;

-- A project's display identity is intentionally independent from its name.
-- Missing rows belong to pre-migration author projects and are resolved by the
-- repository as author_work / legacy_unknown without mutating user data.
CREATE TABLE IF NOT EXISTS project_display_identities (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  display_kind TEXT NOT NULL
    CHECK (display_kind IN (
      'author_work', 'test_work', 'builtin_example', 'system_evaluation'
    )),
  provenance TEXT NOT NULL
    CHECK (provenance IN (
      'explicit_creation', 'explicit_test', 'builtin_example', 'evaluation_project_id'
    )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (
    (display_kind = 'author_work' AND provenance = 'explicit_creation')
    OR
    (display_kind = 'test_work' AND provenance = 'explicit_test')
    OR
    (display_kind = 'builtin_example' AND provenance = 'builtin_example')
    OR
    (display_kind = 'system_evaluation' AND provenance = 'evaluation_project_id')
  )
);

CREATE INDEX IF NOT EXISTS project_display_identities_kind_idx
  ON project_display_identities (display_kind, project_id);

-- Content-free append history makes every explicit author/test switch and
-- every system promotion inspectable without storing project names or content.
CREATE TABLE IF NOT EXISTS project_display_identity_revisions (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  previous_display_kind TEXT
    CHECK (
      previous_display_kind IS NULL
      OR previous_display_kind IN (
        'author_work', 'test_work', 'builtin_example', 'system_evaluation'
      )
    ),
  display_kind TEXT NOT NULL
    CHECK (display_kind IN (
      'author_work', 'test_work', 'builtin_example', 'system_evaluation'
    )),
  provenance TEXT NOT NULL
    CHECK (provenance IN (
      'explicit_creation', 'explicit_test', 'builtin_example', 'evaluation_project_id'
    )),
  recorded_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at),
  PRIMARY KEY (project_id, revision),
  CHECK (
    (display_kind = 'author_work' AND provenance = 'explicit_creation')
    OR
    (display_kind = 'test_work' AND provenance = 'explicit_test')
    OR
    (display_kind = 'builtin_example' AND provenance = 'builtin_example')
    OR
    (display_kind = 'system_evaluation' AND provenance = 'evaluation_project_id')
  )
);

CREATE INDEX IF NOT EXISTS project_display_identity_revisions_project_idx
  ON project_display_identity_revisions (project_id, revision);

CREATE TRIGGER IF NOT EXISTS project_display_identity_exact_evaluation_insert_guard
BEFORE INSERT ON project_display_identities
WHEN NEW.display_kind = 'system_evaluation'
  AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    WHERE suite.evaluation_project_id = NEW.project_id
  )
BEGIN SELECT RAISE(ABORT, 'project display identity requires an exact evaluation project reference'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_exact_evaluation_update_guard
BEFORE UPDATE OF display_kind, provenance, project_id ON project_display_identities
WHEN NEW.display_kind = 'system_evaluation'
  AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    WHERE suite.evaluation_project_id = NEW.project_id
  )
BEGIN SELECT RAISE(ABORT, 'project display identity requires an exact evaluation project reference'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_evaluation_scope_insert_guard
BEFORE INSERT ON project_display_identities
WHEN NEW.display_kind <> 'system_evaluation'
  AND EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    WHERE suite.evaluation_project_id = NEW.project_id
  )
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot use an ordinary display identity'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_evaluation_scope_update_guard
BEFORE UPDATE OF display_kind, provenance, project_id ON project_display_identities
WHEN NEW.display_kind <> 'system_evaluation'
  AND EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    WHERE suite.evaluation_project_id = NEW.project_id
  )
BEGIN SELECT RAISE(ABORT, 'evaluation project cannot use an ordinary display identity'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_system_immutable
BEFORE UPDATE OF display_kind, provenance ON project_display_identities
WHEN OLD.display_kind = 'system_evaluation'
  AND (
    NEW.display_kind <> OLD.display_kind
    OR NEW.provenance <> OLD.provenance
  )
BEGIN SELECT RAISE(ABORT, 'system evaluation display identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_builtin_creation_only
BEFORE UPDATE OF display_kind, provenance ON project_display_identities
WHEN NEW.display_kind = 'builtin_example'
  AND OLD.display_kind <> 'builtin_example'
BEGIN SELECT RAISE(ABORT, 'built-in example identity can only be recorded at creation'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_builtin_protected
BEFORE UPDATE OF display_kind, provenance ON project_display_identities
WHEN OLD.display_kind = 'builtin_example'
  AND NEW.display_kind NOT IN ('builtin_example', 'system_evaluation')
BEGIN SELECT RAISE(ABORT, 'built-in example identity cannot be reclassified by the author'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_revision_guard
BEFORE UPDATE ON project_display_identities
WHEN NEW.project_id <> OLD.project_id
  OR NEW.created_at <> OLD.created_at
  OR (
    (NEW.display_kind <> OLD.display_kind OR NEW.provenance <> OLD.provenance)
    AND NEW.revision <> OLD.revision + 1
  )
  OR (
    NEW.display_kind = OLD.display_kind
    AND NEW.provenance = OLD.provenance
    AND (
      NEW.revision <> OLD.revision
      OR NEW.updated_at <> OLD.updated_at
    )
  )
BEGIN SELECT RAISE(ABORT, 'project display identity revision is invalid'); END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_revision_insert
AFTER INSERT ON project_display_identities
BEGIN
  INSERT INTO project_display_identity_revisions (
    project_id, revision, previous_display_kind,
    display_kind, provenance, recorded_at
  ) VALUES (
    NEW.project_id, NEW.revision, NULL,
    NEW.display_kind, NEW.provenance, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS project_display_identity_revision_update
AFTER UPDATE OF display_kind, provenance ON project_display_identities
WHEN NEW.display_kind <> OLD.display_kind OR NEW.provenance <> OLD.provenance
BEGIN
  INSERT INTO project_display_identity_revisions (
    project_id, revision, previous_display_kind,
    display_kind, provenance, recorded_at
  ) VALUES (
    NEW.project_id, NEW.revision, OLD.display_kind,
    NEW.display_kind, NEW.provenance, NEW.updated_at
  );
END;

-- Only the exact ledger foreign key is authoritative. Project names, archive
-- state, chapter count, and other heuristics are deliberately excluded.
INSERT INTO project_display_identities (
  project_id, display_kind, provenance, revision, created_at, updated_at
)
SELECT
  suite.evaluation_project_id,
  'system_evaluation',
  'evaluation_project_id',
  1,
  suite.created_at,
  suite.created_at
FROM novel_skill_evaluation_suites AS suite
WHERE 1 = 1
ON CONFLICT(project_id) DO UPDATE SET
  display_kind = 'system_evaluation',
  provenance = 'evaluation_project_id',
  revision = project_display_identities.revision + 1,
  updated_at = excluded.updated_at
WHERE project_display_identities.display_kind <> 'system_evaluation'
   OR project_display_identities.provenance <> 'evaluation_project_id';

-- Future evaluation suites keep the same exact identity chain. An explicit
-- author/test row may exist briefly while the evaluation project is provisioned;
-- the immutable suite reference promotes it to the system-only identity.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_suite_display_identity_insert
AFTER INSERT ON novel_skill_evaluation_suites
BEGIN
  INSERT INTO project_display_identities (
    project_id, display_kind, provenance, revision, created_at, updated_at
  ) VALUES (
    NEW.evaluation_project_id,
    'system_evaluation',
    'evaluation_project_id',
    1,
    NEW.created_at,
    NEW.created_at
  )
  ON CONFLICT(project_id) DO UPDATE SET
    display_kind = 'system_evaluation',
    provenance = 'evaluation_project_id',
    revision = project_display_identities.revision + 1,
    updated_at = excluded.updated_at
  WHERE project_display_identities.display_kind <> 'system_evaluation'
     OR project_display_identities.provenance <> 'evaluation_project_id';
END;
