-- Project-bound, end-to-end encrypted Studio team templates.
--
-- Template titles, prompts, rules, checklists and project settings exist only
-- inside the bounded client-created AES-256-GCM ciphertext. PostgreSQL stores
-- lifecycle metadata, public AEAD scope and append-only audit/application
-- receipts; no service-side decryption key or creative plaintext is accepted.

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
        'review',
        'team_template'
      )
    ),
  DROP CONSTRAINT cloud_idempotency_response_snapshot_kind_check,
  ADD CONSTRAINT cloud_idempotency_response_snapshot_kind_check
    CHECK (
      response_snapshot IS NULL
      OR result_kind IN (
        'accepted',
        'challenge',
        'device',
        'project_key',
        'deletion_job',
        'session',
        'sync_batch',
        'team',
        'team_invitation',
        'team_invitation_acceptance',
        'team_membership',
        'project_assignment',
        'team_project_key_envelope',
        'review',
        'team_template'
      )
    ),
  ADD CONSTRAINT cloud_idempotency_team_template_snapshot_plaintext_free_check
    CHECK (
      result_kind <> 'team_template'
      OR response_snapshot IS NULL
      OR (
        (jsonb_typeof(response_snapshot) = 'object') IS TRUE
        AND NOT jsonb_path_exists(response_snapshot, '$.**.title')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.body')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.content')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.prompt')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.rules')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.plaintext')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.projectKey')
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
        'review_thread_item',
        'team_template',
        'team_template_version',
        'team_template_application'
      )
    ),
  ADD CONSTRAINT cloud_team_audit_events_template_plaintext_free_check
    CHECK (
      NOT jsonb_path_exists(redacted_diff, '$.**.ciphertext')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.title')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.body')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.content')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.prompt')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.rules')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.plaintext')
      AND NOT jsonb_path_exists(redacted_diff, '$.**.projectKey')
    );

CREATE TABLE cloud_team_templates (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  template_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'archived')),
  revision BIGINT NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  latest_version_number BIGINT NOT NULL
    CHECK (latest_version_number BETWEEN 1 AND 9007199254740991),
  published_version_number BIGINT
    CHECK (
      published_version_number IS NULL
      OR published_version_number BETWEEN 1 AND 9007199254740991
    ),
  created_by_membership_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, team_id, project_id, template_id),
  UNIQUE (template_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, created_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    (
      state = 'draft'
      AND published_version_number IS NULL
      AND published_at IS NULL
      AND archived_at IS NULL
    )
    OR (
      state = 'published'
      AND published_version_number IS NOT NULL
      AND published_version_number <= latest_version_number
      AND published_at BETWEEN created_at AND updated_at
      AND archived_at IS NULL
    )
    OR (
      state = 'archived'
      AND archived_at BETWEEN created_at AND updated_at
      AND (
        (
          published_version_number IS NULL
          AND published_at IS NULL
        )
        OR (
          published_version_number IS NOT NULL
          AND published_version_number <= latest_version_number
          AND published_at BETWEEN created_at AND updated_at
        )
      )
    )
  )
);

CREATE INDEX cloud_team_templates_project_page_idx
  ON cloud_team_templates (
    tenant_id,
    team_id,
    project_id,
    created_at DESC,
    template_id DESC
  );

CREATE TABLE cloud_team_template_versions (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  template_id UUID NOT NULL,
  version_id UUID NOT NULL,
  version_number BIGINT NOT NULL
    CHECK (version_number BETWEEN 1 AND 9007199254740991),
  project_key_version INTEGER NOT NULL
    CHECK (project_key_version BETWEEN 1 AND 2147483647),
  payload_algorithm TEXT NOT NULL CHECK (payload_algorithm = 'AES-256-GCM'),
  payload_nonce CHAR(16) NOT NULL CHECK (payload_nonce ~ '^[A-Za-z0-9_-]{16}$'),
  payload_ciphertext TEXT NOT NULL
    CHECK (length(payload_ciphertext) BETWEEN 22 AND 349568)
    CHECK (payload_ciphertext ~ '^[A-Za-z0-9_-]+$'),
  payload_ciphertext_sha256 CHAR(64) NOT NULL
    CHECK (payload_ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  payload_aad JSONB NOT NULL CHECK (jsonb_typeof(payload_aad) = 'object'),
  author_membership_id UUID NOT NULL,
  author_account_id UUID NOT NULL,
  author_device_id UUID NOT NULL,
  cloned_from_template_id UUID,
  cloned_from_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, project_id, template_id, version_id),
  UNIQUE (version_id),
  UNIQUE (tenant_id, team_id, project_id, template_id, version_number),
  UNIQUE (tenant_id, team_id, project_id, template_id, version_id),
  FOREIGN KEY (tenant_id, team_id, project_id, template_id)
    REFERENCES cloud_team_templates(tenant_id, team_id, project_id, template_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, project_key_version)
    REFERENCES project_key_versions(tenant_id, project_id, key_version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, author_membership_id, author_account_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id, account_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (author_account_id, author_device_id)
    REFERENCES registered_devices(account_id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    team_id,
    project_id,
    cloned_from_template_id,
    cloned_from_version_id
  )
    REFERENCES cloud_team_template_versions(
      tenant_id,
      team_id,
      project_id,
      template_id,
      version_id
    )
    ON DELETE RESTRICT,
  CHECK ((cloned_from_template_id IS NULL) = (cloned_from_version_id IS NULL)),
  CHECK (
    payload_aad = jsonb_build_object(
      'schemaVersion', 1,
      'purpose', 'inkshadow.studio.team-template',
      'tenantId', tenant_id::text,
      'teamId', team_id::text,
      'projectId', project_id::text,
      'templateId', template_id::text,
      'versionId', version_id::text,
      'versionNumber', version_number,
      'projectKeyVersion', project_key_version
    )
  )
);

CREATE INDEX cloud_team_template_versions_page_idx
  ON cloud_team_template_versions (
    tenant_id,
    team_id,
    project_id,
    template_id,
    created_at DESC,
    version_id DESC
  );

CREATE TABLE cloud_team_template_applications (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  template_id UUID NOT NULL,
  version_id UUID NOT NULL,
  application_id UUID NOT NULL,
  applied_by_membership_id UUID NOT NULL,
  applied_by_account_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, project_id, application_id),
  UNIQUE (application_id),
  FOREIGN KEY (tenant_id, team_id, project_id, template_id, version_id)
    REFERENCES cloud_team_template_versions(
      tenant_id,
      team_id,
      project_id,
      template_id,
      version_id
    )
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, applied_by_membership_id, applied_by_account_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id, account_id)
    ON DELETE RESTRICT
);

CREATE INDEX cloud_team_template_applications_project_idx
  ON cloud_team_template_applications (
    tenant_id,
    team_id,
    project_id,
    applied_at DESC,
    application_id DESC
  );

CREATE FUNCTION enforce_cloud_team_template_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cloud team templates preserve lifecycle history'
      USING ERRCODE = '55000';
  END IF;

  IF
    NEW.tenant_id <> OLD.tenant_id
    OR NEW.team_id <> OLD.team_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.template_id <> OLD.template_id
    OR NEW.created_by_membership_id <> OLD.created_by_membership_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'invalid cloud team template identity or revision transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'draft' AND NEW.state = 'draft' THEN
    IF
      NEW.latest_version_number <> OLD.latest_version_number + 1
      OR NEW.published_version_number IS NOT NULL
      OR NEW.published_at IS NOT NULL
      OR NEW.archived_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid cloud team template draft version transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state = 'draft' AND NEW.state = 'published' THEN
    IF
      NEW.latest_version_number <> OLD.latest_version_number
      OR NEW.published_version_number <> OLD.latest_version_number
      OR NEW.published_at IS NULL
      OR NEW.archived_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid cloud team template publication transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state IN ('draft', 'published') AND NEW.state = 'archived' THEN
    IF
      NEW.latest_version_number <> OLD.latest_version_number
      OR NEW.published_version_number IS DISTINCT FROM OLD.published_version_number
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.archived_at IS NULL
    THEN
      RAISE EXCEPTION 'invalid cloud team template archival transition'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'cloud team template lifecycle transition is terminal or invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_team_templates_transition_guard
BEFORE UPDATE OR DELETE ON cloud_team_templates
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_team_template_transition();

CREATE FUNCTION reject_cloud_team_template_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud team template versions and applications are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_team_template_versions_immutable
BEFORE UPDATE OR DELETE ON cloud_team_template_versions
FOR EACH ROW EXECUTE FUNCTION reject_cloud_team_template_immutable_mutation();

CREATE TRIGGER cloud_team_template_applications_immutable
BEFORE UPDATE OR DELETE ON cloud_team_template_applications
FOR EACH ROW EXECUTE FUNCTION reject_cloud_team_template_immutable_mutation();

CREATE FUNCTION inkshadow_has_active_team_template_assignment(
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
        AND membership.role IN ('owner', 'admin', 'author', 'reviewer', 'read_only')
    )
$$;

REVOKE ALL ON FUNCTION
  inkshadow_has_active_team_template_assignment(UUID, UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inkshadow_has_active_team_template_assignment(UUID, UUID, UUID)
  TO CURRENT_USER;

REVOKE ALL ON FUNCTION enforce_cloud_team_template_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_cloud_team_template_immutable_mutation() FROM PUBLIC;

ALTER TABLE cloud_team_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_template_applications ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_team_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_template_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_team_templates_scope_isolation
  ON cloud_team_templates
  USING (
    inkshadow_has_active_team_template_assignment(tenant_id, team_id, project_id)
  )
  WITH CHECK (
    inkshadow_has_active_team_template_assignment(tenant_id, team_id, project_id)
  );

CREATE POLICY cloud_team_template_versions_scope_isolation
  ON cloud_team_template_versions
  USING (
    inkshadow_has_active_team_template_assignment(tenant_id, team_id, project_id)
  )
  WITH CHECK (
    inkshadow_has_active_team_template_assignment(tenant_id, team_id, project_id)
  );

CREATE POLICY cloud_team_template_applications_scope_isolation
  ON cloud_team_template_applications
  USING (
    inkshadow_has_active_team_template_assignment(tenant_id, team_id, project_id)
  )
  WITH CHECK (
    inkshadow_has_active_team_template_assignment(tenant_id, team_id, project_id)
  );
