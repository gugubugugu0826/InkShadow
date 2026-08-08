PRAGMA foreign_keys = ON;

-- A remote project-context request holds one row for its complete native
-- network lifetime. This table deliberately has no project foreign key: a
-- cascading project delete must not remove the privacy barrier while bytes may
-- still be in flight.
CREATE TABLE project_remote_dispatch_leases (
  lease_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(lease_id) = 36),
  project_id TEXT NOT NULL
    CHECK (length(project_id) = 36),
  operation_kind TEXT NOT NULL
    CHECK (operation_kind IN ('generation', 'embedding', 'rerank')),
  operation_id TEXT NOT NULL UNIQUE
    CHECK (length(operation_id) BETWEEN 1 AND 200),
  owner_runtime_id TEXT NOT NULL
    CHECK (length(owner_runtime_id) BETWEEN 16 AND 200),
  authority_fingerprint TEXT NOT NULL
    CHECK (
      length(authority_fingerprint) = 64
      AND authority_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  acquired_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', acquired_at) = acquired_at),
  network_deadline_at TEXT NOT NULL
    CHECK (
      strftime('%Y-%m-%dT%H:%M:%fZ', network_deadline_at) = network_deadline_at
      AND network_deadline_at >= acquired_at
    )
) STRICT;

CREATE INDEX project_remote_dispatch_leases_project_idx
  ON project_remote_dispatch_leases (project_id, acquired_at, lease_id);

-- Lease identity is immutable. Only the native gateway may insert the exact
-- pre-dispatch binding and remove it after its request future has terminated.
CREATE TRIGGER project_remote_dispatch_leases_immutable
BEFORE UPDATE ON project_remote_dispatch_leases
BEGIN
  SELECT RAISE(ABORT, 'INKSHADOW_REMOTE_DISPATCH_LEASE_IMMUTABLE');
END;

-- Narrow guards: ordinary chapter edits, autosave and accepted-version writes
-- remain available during a long generation. Only a transition that would
-- newly taint the project as local-only is delayed.
CREATE TRIGGER project_remote_dispatch_private_chapter_insert_guard
BEFORE INSERT ON chapters
WHEN NEW.privacy_mode = 'local_only'
  AND EXISTS (
    SELECT 1
    FROM project_remote_dispatch_leases AS lease
    WHERE lease.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'INKSHADOW_REMOTE_DISPATCH_ACTIVE');
END;

CREATE TRIGGER project_remote_dispatch_private_chapter_update_guard
BEFORE UPDATE OF privacy_mode, project_id ON chapters
WHEN NEW.privacy_mode = 'local_only'
  AND (
    OLD.privacy_mode <> 'local_only'
    OR OLD.project_id <> NEW.project_id
  )
  AND EXISTS (
    SELECT 1
    FROM project_remote_dispatch_leases AS lease
    WHERE lease.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'INKSHADOW_REMOTE_DISPATCH_ACTIVE');
END;

CREATE TRIGGER project_remote_dispatch_project_delete_guard
BEFORE DELETE ON projects
WHEN EXISTS (
  SELECT 1
  FROM project_remote_dispatch_leases AS lease
  WHERE lease.project_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'INKSHADOW_REMOTE_DISPATCH_ACTIVE');
END;
