-- Crash-resumable permanent deletion lifecycle.
--
-- Deletion jobs, markers and holds contain identifiers, counters and
-- operational timestamps only. Creative plaintext, passwords, bearer tokens,
-- private keys and deletion-confirmation secrets are intentionally absent.

ALTER TABLE cloud_idempotency_records
  DROP CONSTRAINT cloud_idempotency_records_result_kind_check,
  ADD CONSTRAINT cloud_idempotency_records_result_kind_check
    CHECK (
      result_kind IN (
        'challenge',
        'session',
        'device',
        'project_key',
        'sync_batch',
        'accepted',
        'deletion_job'
      )
    ),
  DROP CONSTRAINT cloud_idempotency_response_snapshot_kind_check,
  ADD CONSTRAINT cloud_idempotency_response_snapshot_kind_check
    CHECK (
      response_snapshot IS NULL
      OR result_kind IN ('project_key', 'deletion_job')
    );

CREATE TABLE cloud_deletion_jobs (
  tenant_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  deletion_request_id UUID NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'account')),
  target_id UUID NOT NULL,
  requested_by_account_id UUID NOT NULL
    REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  confirmation_id UUID NOT NULL,
  state TEXT NOT NULL
    CHECK (
      state IN (
        'grace_period',
        'blocked',
        'purging',
        'backup_retention',
        'purged',
        'cancelled'
      )
    ),
  phase TEXT NOT NULL
    CHECK (
      phase IN (
        'freeze',
        'derived',
        'ciphertext',
        'keys',
        'access',
        'marker',
        'verify',
        'backup_wait',
        'complete'
      )
    ),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  requested_at TIMESTAMPTZ NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  cancellable_until TIMESTAMPTZ NOT NULL,
  commit_started_at TIMESTAMPTZ,
  live_data_purged_at TIMESTAMPTZ,
  backup_retained_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  blocked_reason TEXT
    CHECK (
      blocked_reason IS NULL
      OR blocked_reason IN (
        'legal_hold_active',
        'ownership_transfer_required',
        'external_purge_pending'
      )
    ),
  impact_project_count BIGINT NOT NULL
    CHECK (impact_project_count BETWEEN 0 AND 9007199254740991),
  impact_sync_operation_count BIGINT NOT NULL
    CHECK (impact_sync_operation_count BETWEEN 0 AND 9007199254740991),
  impact_encrypted_chunk_count BIGINT NOT NULL
    CHECK (impact_encrypted_chunk_count BETWEEN 0 AND 9007199254740991),
  impact_key_envelope_count BIGINT NOT NULL
    CHECK (impact_key_envelope_count BETWEEN 0 AND 9007199254740991),
  impact_device_count BIGINT NOT NULL
    CHECK (impact_device_count BETWEEN 0 AND 9007199254740991),
  impact_session_count BIGINT NOT NULL
    CHECK (impact_session_count BETWEEN 0 AND 9007199254740991),
  backup_retention_seconds BIGINT NOT NULL DEFAULT 0
    CHECK (backup_retention_seconds BETWEEN 0 AND 315576000),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 1000000),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_failure_code TEXT
    CHECK (
      last_failure_code IS NULL
      OR (
        length(last_failure_code) BETWEEN 1 AND 80
        AND last_failure_code ~ '^[A-Z0-9_]+$'
      )
    ),
  lease_owner TEXT
    CHECK (
      lease_owner IS NULL
      OR (
        length(lease_owner) BETWEEN 1 AND 100
        AND lease_owner ~ '^[A-Za-z0-9._:-]+$'
      )
    ),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, deletion_request_id),
  UNIQUE (deletion_request_id),
  UNIQUE (tenant_id, confirmation_id),
  CHECK (
    target_kind <> 'account'
    OR (
      target_id = tenant_id
      AND requested_by_account_id = tenant_id
    )
  ),
  CHECK (requested_at <= cancellable_until),
  CHECK (cancellable_until <= scheduled_for),
  CHECK (created_at <= updated_at),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    commit_started_at IS NULL
    OR commit_started_at >= scheduled_for
  ),
  CHECK (
    live_data_purged_at IS NULL
    OR (
      commit_started_at IS NOT NULL
      AND live_data_purged_at >= commit_started_at
    )
  ),
  CHECK (
    backup_retained_until IS NULL
    OR (
      live_data_purged_at IS NOT NULL
      AND backup_retained_until >= live_data_purged_at
    )
  ),
  CHECK (
    completed_at IS NULL
    OR completed_at >= requested_at
  ),
  CHECK (
    (state = 'blocked') = (blocked_reason IS NOT NULL)
  ),
  CHECK (
    (
      state = 'grace_period'
      AND phase = 'freeze'
      AND commit_started_at IS NULL
      AND live_data_purged_at IS NULL
      AND backup_retained_until IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'blocked'
      AND phase = 'freeze'
      AND commit_started_at IS NULL
      AND live_data_purged_at IS NULL
      AND backup_retained_until IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'purging'
      AND phase IN ('derived', 'ciphertext', 'keys', 'access', 'marker', 'verify')
      AND commit_started_at IS NOT NULL
      AND backup_retained_until IS NULL
      AND completed_at IS NULL
      AND (
        (
          phase IN ('derived', 'ciphertext', 'keys', 'access')
          AND live_data_purged_at IS NULL
        )
        OR (
          phase IN ('marker', 'verify')
          AND live_data_purged_at IS NOT NULL
        )
      )
    )
    OR (
      state = 'backup_retention'
      AND phase = 'backup_wait'
      AND commit_started_at IS NOT NULL
      AND live_data_purged_at IS NOT NULL
      AND backup_retained_until IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'purged'
      AND phase = 'complete'
      AND commit_started_at IS NOT NULL
      AND live_data_purged_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND (
        backup_retained_until IS NULL
        OR completed_at >= backup_retained_until
      )
    )
    OR (
      state = 'cancelled'
      AND phase = 'freeze'
      AND commit_started_at IS NULL
      AND live_data_purged_at IS NULL
      AND backup_retained_until IS NULL
      AND completed_at IS NOT NULL
      AND completed_at <= cancellable_until
    )
  ),
  CHECK (
    target_kind <> 'project'
    OR (
      impact_project_count = 1
      AND impact_device_count = 0
      AND impact_session_count = 0
    )
  )
);

CREATE UNIQUE INDEX cloud_deletion_jobs_one_active_target_idx
  ON cloud_deletion_jobs (tenant_id, target_kind, target_id)
  WHERE state NOT IN ('purged', 'cancelled');

CREATE INDEX cloud_deletion_jobs_runnable_idx
  ON cloud_deletion_jobs (
    tenant_id,
    next_attempt_at,
    scheduled_for,
    deletion_request_id
  )
  WHERE state NOT IN ('purged', 'cancelled');

CREATE INDEX cloud_deletion_jobs_lease_idx
  ON cloud_deletion_jobs (tenant_id, lease_expires_at, deletion_request_id)
  WHERE lease_owner IS NOT NULL;

CREATE TABLE cloud_deletion_job_projects (
  tenant_id UUID NOT NULL,
  deletion_request_id UUID NOT NULL,
  project_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  original_state TEXT NOT NULL
    CHECK (original_state IN ('active', 'deletion_scheduled')),
  original_deletion_scheduled_for TIMESTAMPTZ,
  project_revision_at_freeze BIGINT NOT NULL
    CHECK (project_revision_at_freeze BETWEEN 1 AND 9007199254740991),
  phase TEXT NOT NULL
    CHECK (
      phase IN (
        'derived',
        'ciphertext',
        'keys',
        'access',
        'marker',
        'verify',
        'complete'
      )
    ),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, deletion_request_id, project_id),
  UNIQUE (tenant_id, deletion_request_id, ordinal),
  FOREIGN KEY (tenant_id, deletion_request_id)
    REFERENCES cloud_deletion_jobs(tenant_id, deletion_request_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id)
    ON DELETE RESTRICT,
  CHECK (
    (original_state = 'deletion_scheduled')
    = (original_deletion_scheduled_for IS NOT NULL)
  ),
  CHECK ((phase = 'complete') = (completed_at IS NOT NULL))
);

CREATE INDEX cloud_deletion_job_projects_phase_idx
  ON cloud_deletion_job_projects (
    tenant_id,
    deletion_request_id,
    phase,
    ordinal
  );

CREATE TABLE cloud_deletion_markers (
  tenant_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'account')),
  target_id UUID NOT NULL,
  deletion_request_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, target_kind, target_id),
  FOREIGN KEY (tenant_id, deletion_request_id)
    REFERENCES cloud_deletion_jobs(tenant_id, deletion_request_id)
    ON DELETE RESTRICT,
  CHECK (target_kind <> 'account' OR target_id = tenant_id)
);

CREATE TABLE cloud_retention_holds (
  tenant_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  hold_id UUID NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'account')),
  target_id UUID NOT NULL,
  reason TEXT NOT NULL
    CHECK (
      reason IN (
        'legal_hold_active',
        'ownership_transfer_required',
        'external_purge_pending'
      )
    ),
  placed_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE (hold_id),
  CHECK (target_kind <> 'account' OR target_id = tenant_id),
  CHECK (released_at IS NULL OR released_at >= placed_at)
);

CREATE UNIQUE INDEX cloud_retention_holds_one_active_reason_idx
  ON cloud_retention_holds (tenant_id, target_kind, target_id, reason)
  WHERE released_at IS NULL;

CREATE INDEX cloud_retention_holds_target_idx
  ON cloud_retention_holds (
    tenant_id,
    target_kind,
    target_id,
    placed_at,
    hold_id
  )
  WHERE released_at IS NULL;

ALTER TABLE cloud_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_deletion_job_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_deletion_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_retention_holds ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_deletion_job_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_deletion_markers FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_retention_holds FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_deletion_jobs_tenant_isolation ON cloud_deletion_jobs
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY cloud_deletion_job_projects_tenant_isolation
  ON cloud_deletion_job_projects
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY cloud_deletion_markers_tenant_isolation ON cloud_deletion_markers
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());
CREATE POLICY cloud_retention_holds_tenant_isolation ON cloud_retention_holds
  USING (tenant_id = inkshadow_current_tenant())
  WITH CHECK (tenant_id = inkshadow_current_tenant());

CREATE FUNCTION reject_cloud_project_resurrection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1
    FROM cloud_deletion_markers
    WHERE tenant_id = NEW.tenant_id
      AND target_kind = 'project'
      AND target_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'a permanently deleted cloud project cannot be recreated'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.state = 'deleted'
    AND (
      NEW.state <> 'deleted'
      OR NEW.current_key_version IS NOT NULL
      OR NEW.deletion_scheduled_for IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'a permanently deleted cloud project cannot be reactivated'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_projects_reject_resurrection
BEFORE INSERT OR UPDATE ON cloud_projects
FOR EACH ROW EXECUTE FUNCTION reject_cloud_project_resurrection();

CREATE FUNCTION reject_cloud_account_resurrection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'deleted' AND NEW.state <> 'deleted' THEN
    RAISE EXCEPTION 'a permanently deleted cloud account cannot be reactivated'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_accounts_reject_resurrection
BEFORE UPDATE ON cloud_accounts
FOR EACH ROW EXECUTE FUNCTION reject_cloud_account_resurrection();
