-- Studio encrypted review control plane.
--
-- Creative review bodies remain end-to-end encrypted. PostgreSQL stores only
-- exact version/key metadata, bounded AES-GCM ciphertext envelopes and
-- lifecycle metadata. It never accepts plaintext, project DEKs, prompts or
-- recovery material.

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
        'deletion_job',
        'team',
        'team_invitation',
        'team_invitation_acceptance',
        'team_membership',
        'project_assignment',
        'team_project_key_envelope',
        'review'
      )
    ),
  DROP CONSTRAINT cloud_idempotency_response_snapshot_kind_check,
  ADD CONSTRAINT cloud_idempotency_response_snapshot_kind_check
    CHECK (
      response_snapshot IS NULL
      OR result_kind IN (
        'project_key',
        'deletion_job',
        'team',
        'team_invitation',
        'team_invitation_acceptance',
        'team_membership',
        'project_assignment',
        'team_project_key_envelope',
        'review'
      )
    );

ALTER TABLE cloud_team_audit_events
  DROP CONSTRAINT cloud_team_audit_events_resource_type_check,
  ADD CONSTRAINT cloud_team_audit_events_resource_type_check
    CHECK (
      resource_type IN (
        'team',
        'membership',
        'invitation',
        'project_assignment',
        'project_key_envelope',
        'review_submission',
        'review_thread',
        'review_thread_item'
      )
    );

CREATE TABLE cloud_review_submissions (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  review_id UUID NOT NULL,
  source_version_id UUID NOT NULL,
  source_version_revision BIGINT NOT NULL
    CHECK (source_version_revision BETWEEN 1 AND 9007199254740991),
  source_ciphertext_sha256 CHAR(64) NOT NULL
    CHECK (source_ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  project_key_version INTEGER NOT NULL CHECK (project_key_version > 0),
  payload_algorithm TEXT NOT NULL CHECK (payload_algorithm = 'AES-256-GCM'),
  payload_nonce CHAR(16) NOT NULL CHECK (payload_nonce ~ '^[A-Za-z0-9_-]{16}$'),
  payload_ciphertext TEXT NOT NULL
    CHECK (
      length(payload_ciphertext) BETWEEN 22 AND 349547
      AND payload_ciphertext ~ '^[A-Za-z0-9_-]+$'
    ),
  payload_ciphertext_sha256 CHAR(64) NOT NULL
    CHECK (payload_ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  submitted_by_membership_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  decision_by_membership_id UUID,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, project_id, review_id),
  UNIQUE (review_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id, project_key_version)
    REFERENCES project_key_versions(tenant_id, project_id, key_version)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, team_id, submitted_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, decision_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    (
      state = 'pending'
      AND decision_by_membership_id IS NULL
      AND decided_at IS NULL
    )
    OR (
      state IN ('approved', 'rejected')
      AND decision_by_membership_id IS NOT NULL
      AND decided_at BETWEEN created_at AND updated_at
    )
  )
);

CREATE INDEX cloud_review_submissions_project_page_idx
  ON cloud_review_submissions (
    tenant_id,
    team_id,
    project_id,
    created_at DESC,
    review_id DESC
  );

CREATE TABLE cloud_review_threads (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  review_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  root_item_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  item_count INTEGER NOT NULL DEFAULT 1 CHECK (item_count BETWEEN 1 AND 1000000),
  created_by_membership_id UUID NOT NULL,
  resolved_by_membership_id UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, project_id, review_id, thread_id),
  UNIQUE (thread_id),
  UNIQUE (
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    root_item_id
  ),
  FOREIGN KEY (tenant_id, team_id, project_id, review_id)
    REFERENCES cloud_review_submissions(tenant_id, team_id, project_id, review_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, team_id, created_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, resolved_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    (
      state = 'open'
      AND resolved_by_membership_id IS NULL
      AND resolved_at IS NULL
    )
    OR (
      state = 'resolved'
      AND resolved_by_membership_id IS NOT NULL
      AND resolved_at BETWEEN created_at AND updated_at
    )
  )
);

CREATE TABLE cloud_review_thread_items (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  review_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  item_id UUID NOT NULL,
  item_type TEXT NOT NULL
    CHECK (
      item_type IN (
        'comment',
        'suggestion',
        'question',
        'rewrite_request',
        'reply'
      )
    ),
  parent_item_id UUID,
  payload_algorithm TEXT NOT NULL CHECK (payload_algorithm = 'AES-256-GCM'),
  payload_nonce CHAR(16) NOT NULL CHECK (payload_nonce ~ '^[A-Za-z0-9_-]{16}$'),
  payload_ciphertext TEXT NOT NULL
    CHECK (
      length(payload_ciphertext) BETWEEN 22 AND 349547
      AND payload_ciphertext ~ '^[A-Za-z0-9_-]+$'
    ),
  payload_ciphertext_sha256 CHAR(64) NOT NULL
    CHECK (payload_ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_membership_id UUID NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  suggestion_decision TEXT
    CHECK (suggestion_decision IN ('pending', 'accepted', 'rejected')),
  suggestion_decided_by_membership_id UUID,
  suggestion_decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    item_id
  ),
  UNIQUE (item_id),
  FOREIGN KEY (tenant_id, team_id, project_id, review_id, thread_id)
    REFERENCES cloud_review_threads(
      tenant_id,
      team_id,
      project_id,
      review_id,
      thread_id
    ) ON DELETE CASCADE,
  FOREIGN KEY (
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    parent_item_id
  ) REFERENCES cloud_review_thread_items(
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    item_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, created_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, suggestion_decided_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK ((item_type = 'reply') = (parent_item_id IS NOT NULL)),
  CHECK (
    (
      item_type = 'suggestion'
      AND suggestion_decision IS NOT NULL
      AND (
        (
          suggestion_decision = 'pending'
          AND suggestion_decided_by_membership_id IS NULL
          AND suggestion_decided_at IS NULL
        )
        OR (
          suggestion_decision IN ('accepted', 'rejected')
          AND suggestion_decided_by_membership_id IS NOT NULL
          AND suggestion_decided_at BETWEEN created_at AND updated_at
        )
      )
    )
    OR (
      item_type <> 'suggestion'
      AND suggestion_decision IS NULL
      AND suggestion_decided_by_membership_id IS NULL
      AND suggestion_decided_at IS NULL
    )
  )
);

CREATE INDEX cloud_review_threads_review_page_idx
  ON cloud_review_threads (
    tenant_id,
    team_id,
    project_id,
    review_id,
    created_at DESC,
    thread_id DESC
  );

ALTER TABLE cloud_review_threads
  ADD CONSTRAINT cloud_review_threads_root_item_fk
  FOREIGN KEY (
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    root_item_id
  ) REFERENCES cloud_review_thread_items(
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    item_id
  )
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX cloud_review_thread_items_page_idx
  ON cloud_review_thread_items (
    tenant_id,
    team_id,
    project_id,
    review_id,
    thread_id,
    created_at,
    item_id
  );

CREATE FUNCTION enforce_cloud_review_submission_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    to_jsonb(NEW)
      - 'state'
      - 'revision'
      - 'decision_by_membership_id'
      - 'decided_at'
      - 'updated_at'
  ) IS DISTINCT FROM (
    to_jsonb(OLD)
      - 'state'
      - 'revision'
      - 'decision_by_membership_id'
      - 'decided_at'
      - 'updated_at'
  )
    OR OLD.state <> 'pending'
    OR NEW.state NOT IN ('approved', 'rejected')
    OR NEW.revision <> OLD.revision + 1
    OR NEW.decision_by_membership_id IS NULL
    OR NEW.decided_at IS NULL
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'encrypted review submissions are immutable after submission'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_review_submissions_immutable
BEFORE UPDATE ON cloud_review_submissions
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_review_submission_immutability();

CREATE FUNCTION enforce_cloud_review_thread_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    to_jsonb(NEW)
      - 'state'
      - 'revision'
      - 'item_count'
      - 'resolved_by_membership_id'
      - 'resolved_at'
      - 'updated_at'
  ) IS DISTINCT FROM (
    to_jsonb(OLD)
      - 'state'
      - 'revision'
      - 'item_count'
      - 'resolved_by_membership_id'
      - 'resolved_at'
      - 'updated_at'
  )
    OR OLD.state <> 'open'
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at
    OR NOT (
      (
        NEW.state = 'open'
        AND NEW.item_count = OLD.item_count + 1
        AND NEW.resolved_by_membership_id IS NULL
        AND NEW.resolved_at IS NULL
      )
      OR (
        NEW.state = 'resolved'
        AND NEW.item_count = OLD.item_count
        AND NEW.resolved_by_membership_id IS NOT NULL
        AND NEW.resolved_at IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'review-thread transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_review_threads_transition_guard
BEFORE UPDATE ON cloud_review_threads
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_review_thread_transition();

CREATE FUNCTION enforce_cloud_review_thread_item_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    to_jsonb(NEW)
      - 'revision'
      - 'suggestion_decision'
      - 'suggestion_decided_by_membership_id'
      - 'suggestion_decided_at'
      - 'updated_at'
  ) IS DISTINCT FROM (
    to_jsonb(OLD)
      - 'revision'
      - 'suggestion_decision'
      - 'suggestion_decided_by_membership_id'
      - 'suggestion_decided_at'
      - 'updated_at'
  )
    OR OLD.item_type <> 'suggestion'
    OR OLD.suggestion_decision <> 'pending'
    OR NEW.suggestion_decision NOT IN ('accepted', 'rejected')
    OR NEW.revision <> OLD.revision + 1
    OR NEW.suggestion_decided_by_membership_id IS NULL
    OR NEW.suggestion_decided_at IS NULL
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'encrypted review-thread items are append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_review_thread_items_immutable
BEFORE UPDATE ON cloud_review_thread_items
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_review_thread_item_immutability();

CREATE FUNCTION inkshadow_has_active_review_assignment(
  requested_tenant_id UUID,
  requested_team_id UUID,
  requested_project_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT
    requested_tenant_id = public.inkshadow_current_tenant()
    AND requested_team_id = public.inkshadow_current_team()
    AND EXISTS (
      SELECT 1
      FROM public.cloud_team_memberships AS membership
      JOIN public.cloud_project_assignments AS assignment
        ON assignment.tenant_id = membership.tenant_id
        AND assignment.team_id = membership.team_id
        AND assignment.membership_id = membership.membership_id
        AND assignment.project_id = requested_project_id
        AND assignment.state = 'active'
      JOIN public.cloud_teams AS team_record
        ON team_record.tenant_id = membership.tenant_id
        AND team_record.team_id = membership.team_id
        AND team_record.state = 'active'
      JOIN public.cloud_projects AS project
        ON project.tenant_id = assignment.tenant_id
        AND project.project_id = assignment.project_id
        AND project.state = 'active'
      WHERE membership.tenant_id = requested_tenant_id
        AND membership.team_id = requested_team_id
        AND membership.account_id = public.inkshadow_current_account()
        AND membership.state = 'active'
        AND membership.role IN ('owner', 'admin', 'author', 'reviewer')
    )
$$;

REVOKE ALL ON FUNCTION inkshadow_has_active_review_assignment(UUID, UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_has_active_review_assignment(UUID, UUID, UUID)
  TO PUBLIC;

ALTER TABLE cloud_review_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_review_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_review_thread_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_review_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_review_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_review_thread_items FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_review_submissions_scope_isolation
  ON cloud_review_submissions
  USING (
    inkshadow_has_active_review_assignment(tenant_id, team_id, project_id)
  )
  WITH CHECK (
    inkshadow_has_active_review_assignment(tenant_id, team_id, project_id)
  );

CREATE POLICY cloud_review_threads_scope_isolation
  ON cloud_review_threads
  USING (
    inkshadow_has_active_review_assignment(tenant_id, team_id, project_id)
  )
  WITH CHECK (
    inkshadow_has_active_review_assignment(tenant_id, team_id, project_id)
  );

CREATE POLICY cloud_review_thread_items_scope_isolation
  ON cloud_review_thread_items
  USING (
    inkshadow_has_active_review_assignment(tenant_id, team_id, project_id)
  )
  WITH CHECK (
    inkshadow_has_active_review_assignment(tenant_id, team_id, project_id)
  );

CREATE FUNCTION inkshadow_review_resource_belongs_to_project(
  requested_tenant_id UUID,
  requested_project_id UUID,
  requested_resource_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.cloud_review_submissions
      WHERE tenant_id = requested_tenant_id
        AND project_id = requested_project_id
        AND review_id = requested_resource_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.cloud_review_threads
      WHERE tenant_id = requested_tenant_id
        AND project_id = requested_project_id
        AND thread_id = requested_resource_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.cloud_review_thread_items
      WHERE tenant_id = requested_tenant_id
        AND project_id = requested_project_id
        AND item_id = requested_resource_id
    )
$$;

CREATE FUNCTION inkshadow_count_review_ciphertexts(
  requested_tenant_id UUID,
  requested_project_id UUID
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT
    (
      SELECT COUNT(*)
      FROM public.cloud_review_submissions
      WHERE tenant_id = requested_tenant_id
        AND project_id = requested_project_id
    )
    + (
      SELECT COUNT(*)
      FROM public.cloud_review_thread_items
      WHERE tenant_id = requested_tenant_id
        AND project_id = requested_project_id
    )
$$;

CREATE FUNCTION inkshadow_count_review_records(
  requested_tenant_id UUID,
  requested_project_id UUID
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT
    public.inkshadow_count_review_ciphertexts(
      requested_tenant_id,
      requested_project_id
    )
    + (
      SELECT COUNT(*)
      FROM public.cloud_review_threads
      WHERE tenant_id = requested_tenant_id
        AND project_id = requested_project_id
    )
$$;

REVOKE ALL ON FUNCTION
  inkshadow_review_resource_belongs_to_project(UUID, UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_count_review_ciphertexts(UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_count_review_records(UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inkshadow_review_resource_belongs_to_project(UUID, UUID, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_count_review_ciphertexts(UUID, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_count_review_records(UUID, UUID)
  TO CURRENT_USER;

REVOKE ALL ON FUNCTION enforce_cloud_review_submission_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_cloud_review_thread_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_cloud_review_thread_item_immutability() FROM PUBLIC;
