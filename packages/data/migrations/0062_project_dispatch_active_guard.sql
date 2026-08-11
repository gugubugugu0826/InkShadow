PRAGMA foreign_keys = ON;

-- Project-context model dispatches, including verified loopback providers, hold
-- the existing native lifecycle lease. A project cannot leave the writable
-- state while that exact native request future is still alive.
CREATE TRIGGER project_remote_dispatch_project_status_guard
BEFORE UPDATE OF status ON projects
WHEN OLD.status = 'active'
  AND NEW.status <> 'active'
  AND EXISTS (
    SELECT 1
    FROM project_remote_dispatch_leases AS lease
    WHERE lease.project_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'INKSHADOW_REMOTE_DISPATCH_ACTIVE');
END;
