-- Studio team project-key envelope distribution.
--
-- This table is deliberately separate from the owner's personal-device
-- envelopes and the recovery envelope stored in project_key_versions. Only
-- client-produced HPKE ciphertext is persisted here; project DEKs, private
-- keys and recovery material are never accepted by this control plane.

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
        'team_project_key_envelope'
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
        'team_project_key_envelope'
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
        'project_key_envelope'
      )
    );

ALTER TABLE registered_devices
  ADD CONSTRAINT registered_devices_account_device_scope_key
    UNIQUE (account_id, device_id);

ALTER TABLE cloud_team_memberships
  ADD CONSTRAINT cloud_team_memberships_account_scope_key
    UNIQUE (tenant_id, team_id, membership_id, account_id);

ALTER TABLE cloud_project_assignments
  ADD CONSTRAINT cloud_project_assignments_envelope_scope_key
    UNIQUE (
      tenant_id,
      team_id,
      project_id,
      membership_id,
      assignment_id
    );

CREATE TABLE cloud_team_project_key_envelopes (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  envelope_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  membership_revision BIGINT NOT NULL
    CHECK (membership_revision BETWEEN 1 AND 9007199254740991),
  assignment_id UUID NOT NULL,
  assignment_revision BIGINT NOT NULL
    CHECK (assignment_revision BETWEEN 1 AND 9007199254740991),
  sender_account_id UUID NOT NULL
    REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  sender_membership_id UUID NOT NULL,
  sender_membership_revision BIGINT NOT NULL
    CHECK (sender_membership_revision BETWEEN 1 AND 9007199254740991),
  sender_device_id UUID NOT NULL
    REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  sender_device_revision BIGINT NOT NULL
    CHECK (sender_device_revision BETWEEN 1 AND 9007199254740991),
  sender_public_key CHAR(87) NOT NULL
    CHECK (sender_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  sender_public_key_fingerprint CHAR(64) NOT NULL
    CHECK (sender_public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  recipient_account_id UUID NOT NULL
    REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  recipient_device_id UUID NOT NULL
    REFERENCES registered_devices(device_id) ON DELETE RESTRICT,
  recipient_device_revision BIGINT NOT NULL
    CHECK (recipient_device_revision BETWEEN 1 AND 9007199254740991),
  recipient_public_key CHAR(87) NOT NULL
    CHECK (recipient_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  recipient_public_key_fingerprint CHAR(64) NOT NULL
    CHECK (recipient_public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  algorithm TEXT NOT NULL
    CHECK (algorithm = 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM'),
  encapsulated_key CHAR(87) NOT NULL
    CHECK (encapsulated_key ~ '^[A-Za-z0-9_-]{87}$'),
  ciphertext CHAR(64) NOT NULL
    CHECK (ciphertext ~ '^[A-Za-z0-9_-]{64}$'),
  server_revision BIGINT NOT NULL DEFAULT 1
    CHECK (server_revision BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason TEXT
    CHECK (
      invalidation_reason IS NULL
      OR invalidation_reason IN (
        'team_changed',
        'membership_changed',
        'assignment_changed',
        'recipient_device_changed',
        'project_changed',
        'project_key_changed'
      )
    ),
  PRIMARY KEY (tenant_id, team_id, project_id, key_version, envelope_id),
  UNIQUE (envelope_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    team_id,
    membership_id,
    recipient_account_id
  ) REFERENCES cloud_team_memberships(
    tenant_id,
    team_id,
    membership_id,
    account_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, sender_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    team_id,
    sender_membership_id,
    sender_account_id
  ) REFERENCES cloud_team_memberships(
    tenant_id,
    team_id,
    membership_id,
    account_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    team_id,
    project_id,
    membership_id,
    assignment_id
  )
    REFERENCES cloud_project_assignments(
      tenant_id,
      team_id,
      project_id,
      membership_id,
      assignment_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (sender_account_id, sender_device_id)
    REFERENCES registered_devices(account_id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (recipient_account_id, recipient_device_id)
    REFERENCES registered_devices(account_id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, key_version)
    REFERENCES project_key_versions(tenant_id, project_id, key_version)
    ON DELETE CASCADE,
  CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (
      invalidated_at IS NOT NULL
      AND invalidation_reason IS NOT NULL
      AND invalidated_at >= created_at
    )
  )
);

CREATE UNIQUE INDEX cloud_team_project_key_envelopes_active_recipient_idx
  ON cloud_team_project_key_envelopes (
    tenant_id,
    team_id,
    project_id,
    key_version,
    recipient_device_id
  )
  WHERE invalidated_at IS NULL;

CREATE INDEX cloud_team_project_key_envelopes_current_device_idx
  ON cloud_team_project_key_envelopes (
    recipient_account_id,
    recipient_device_id,
    tenant_id,
    team_id,
    project_id,
    key_version
  )
  WHERE invalidated_at IS NULL;

CREATE FUNCTION enforce_cloud_team_project_key_envelope_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    to_jsonb(NEW)
      - 'invalidated_at'
      - 'invalidation_reason'
      - 'server_revision'
  ) IS DISTINCT FROM (
    to_jsonb(OLD)
      - 'invalidated_at'
      - 'invalidation_reason'
      - 'server_revision'
  )
    OR OLD.invalidated_at IS NOT NULL
    OR NEW.invalidated_at IS NULL
    OR NEW.invalidation_reason IS NULL
    OR NEW.server_revision <> OLD.server_revision + 1
  THEN
    RAISE EXCEPTION 'team project-key envelopes are immutable after issuance'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_team_project_key_envelopes_immutable
BEFORE UPDATE ON cloud_team_project_key_envelopes
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_team_project_key_envelope_immutability();

CREATE FUNCTION invalidate_cloud_team_project_key_envelopes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF TG_TABLE_NAME = 'cloud_teams' THEN
    UPDATE public.cloud_team_project_key_envelopes
    SET invalidated_at = GREATEST(created_at, NEW.updated_at),
        invalidation_reason = 'team_changed',
        server_revision = server_revision + 1
    WHERE tenant_id = NEW.tenant_id
      AND team_id = NEW.team_id
      AND invalidated_at IS NULL
      AND (NEW.revision <> OLD.revision OR NEW.state <> OLD.state);
  ELSIF TG_TABLE_NAME = 'cloud_team_memberships' THEN
    UPDATE public.cloud_team_project_key_envelopes
    SET invalidated_at = GREATEST(created_at, NEW.updated_at),
        invalidation_reason = 'membership_changed',
        server_revision = server_revision + 1
    WHERE tenant_id = NEW.tenant_id
      AND team_id = NEW.team_id
      AND membership_id = NEW.membership_id
      AND invalidated_at IS NULL
      AND (NEW.revision <> OLD.revision OR NEW.state <> OLD.state OR NEW.role <> OLD.role);
  ELSIF TG_TABLE_NAME = 'cloud_project_assignments' THEN
    UPDATE public.cloud_team_project_key_envelopes
    SET invalidated_at = GREATEST(created_at, NEW.updated_at),
        invalidation_reason = 'assignment_changed',
        server_revision = server_revision + 1
    WHERE tenant_id = NEW.tenant_id
      AND team_id = NEW.team_id
      AND project_id = NEW.project_id
      AND membership_id = NEW.membership_id
      AND invalidated_at IS NULL
      AND (NEW.revision <> OLD.revision OR NEW.state <> OLD.state);
  ELSIF TG_TABLE_NAME = 'registered_devices' THEN
    UPDATE public.cloud_team_project_key_envelopes
    SET invalidated_at = GREATEST(created_at, NEW.updated_at),
        invalidation_reason = 'recipient_device_changed',
        server_revision = server_revision + 1
    WHERE recipient_device_id = NEW.device_id
      AND invalidated_at IS NULL
      AND (
        NEW.revision <> OLD.revision
        OR NEW.state <> OLD.state
        OR NEW.public_key_fingerprint <> OLD.public_key_fingerprint
      );
  ELSIF TG_TABLE_NAME = 'cloud_projects' THEN
    UPDATE public.cloud_team_project_key_envelopes
    SET invalidated_at = GREATEST(created_at, NEW.updated_at),
        invalidation_reason = 'project_changed',
        server_revision = server_revision + 1
    WHERE tenant_id = NEW.tenant_id
      AND project_id = NEW.project_id
      AND invalidated_at IS NULL
      AND (
        NEW.revision <> OLD.revision
        OR NEW.state <> OLD.state
        OR NEW.current_key_version IS DISTINCT FROM OLD.current_key_version
      );
  ELSIF TG_TABLE_NAME = 'project_key_versions' THEN
    UPDATE public.cloud_team_project_key_envelopes
    SET invalidated_at = GREATEST(created_at, NEW.updated_at),
        invalidation_reason = 'project_key_changed',
        server_revision = server_revision + 1
    WHERE tenant_id = NEW.tenant_id
      AND project_id = NEW.project_id
      AND key_version = NEW.key_version
      AND invalidated_at IS NULL
      AND (
        NEW.server_revision <> OLD.server_revision
        OR NEW.state <> OLD.state
      );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cloud_team_project_key_envelopes_team_invalidation
AFTER UPDATE ON cloud_teams
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_team_project_key_envelopes();

CREATE TRIGGER cloud_team_project_key_envelopes_membership_invalidation
AFTER UPDATE ON cloud_team_memberships
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_team_project_key_envelopes();

CREATE TRIGGER cloud_team_project_key_envelopes_assignment_invalidation
AFTER UPDATE ON cloud_project_assignments
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_team_project_key_envelopes();

CREATE TRIGGER cloud_team_project_key_envelopes_device_invalidation
AFTER UPDATE ON registered_devices
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_team_project_key_envelopes();

CREATE TRIGGER cloud_team_project_key_envelopes_project_invalidation
AFTER UPDATE ON cloud_projects
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_team_project_key_envelopes();

CREATE TRIGGER cloud_team_project_key_envelopes_key_invalidation
AFTER UPDATE ON project_key_versions
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_team_project_key_envelopes();

REVOKE ALL ON FUNCTION invalidate_cloud_team_project_key_envelopes() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_cloud_team_project_key_envelope_immutability() FROM PUBLIC;

CREATE FUNCTION inkshadow_current_device()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('inkshadow.device_id', true), '')::uuid
$$;

CREATE FUNCTION inkshadow_active_team_project_key_envelope_exists(
  requested_tenant_id UUID,
  requested_team_id UUID,
  requested_project_id UUID,
  requested_key_version INTEGER,
  requested_recipient_device_id UUID
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
    AND public.inkshadow_has_active_team_membership(
      requested_tenant_id,
      requested_team_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.cloud_team_project_key_envelopes AS envelope
      WHERE envelope.tenant_id = requested_tenant_id
        AND envelope.team_id = requested_team_id
        AND envelope.project_id = requested_project_id
        AND envelope.key_version = requested_key_version
        AND envelope.recipient_device_id = requested_recipient_device_id
        AND envelope.invalidated_at IS NULL
    )
$$;

CREATE FUNCTION inkshadow_count_team_project_key_envelopes(
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
  SELECT COUNT(*)
  FROM public.cloud_team_project_key_envelopes
  WHERE tenant_id = requested_tenant_id
    AND project_id = requested_project_id
$$;

CREATE FUNCTION inkshadow_team_project_key_envelope_belongs_to_project(
  requested_tenant_id UUID,
  requested_project_id UUID,
  requested_envelope_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.cloud_team_project_key_envelopes
    WHERE tenant_id = requested_tenant_id
      AND project_id = requested_project_id
      AND envelope_id = requested_envelope_id
  )
$$;

CREATE FUNCTION inkshadow_purge_team_project_key_envelopes_batch(
  requested_tenant_id UUID,
  requested_project_id UUID,
  requested_limit INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  IF requested_tenant_id IS NULL
    OR requested_project_id IS NULL
    OR requested_limit IS NULL
    OR requested_limit < 1
    OR requested_limit > 10000
  THEN
    RAISE EXCEPTION 'invalid team project-key envelope purge arguments'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT envelope_id
    FROM public.cloud_team_project_key_envelopes
    WHERE tenant_id = requested_tenant_id
      AND project_id = requested_project_id
    ORDER BY key_version, envelope_id
    LIMIT requested_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.cloud_team_project_key_envelopes AS envelope
  USING candidates
  WHERE envelope.envelope_id = candidates.envelope_id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION
  inkshadow_active_team_project_key_envelope_exists(UUID, UUID, UUID, INTEGER, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_count_team_project_key_envelopes(UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_team_project_key_envelope_belongs_to_project(UUID, UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_purge_team_project_key_envelopes_batch(UUID, UUID, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inkshadow_active_team_project_key_envelope_exists(UUID, UUID, UUID, INTEGER, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_count_team_project_key_envelopes(UUID, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_team_project_key_envelope_belongs_to_project(UUID, UUID, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_purge_team_project_key_envelopes_batch(UUID, UUID, INTEGER)
  TO CURRENT_USER;

ALTER TABLE cloud_team_project_key_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_project_key_envelopes FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_team_project_key_envelopes_scope_isolation
  ON cloud_team_project_key_envelopes
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND (
      sender_account_id = inkshadow_current_account()
      OR (
        recipient_account_id = inkshadow_current_account()
        AND recipient_device_id = inkshadow_current_device()
      )
    )
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND sender_account_id = inkshadow_current_account()
    AND sender_device_id = inkshadow_current_device()
  );
