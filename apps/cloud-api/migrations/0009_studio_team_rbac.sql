-- Studio team membership, invitation and project-assignment control plane.
--
-- Invitation bearer values are never persisted as plaintext. Invitations keep
-- only SHA-256 digests; the delivery outbox keeps short-lived AES-GCM
-- ciphertext whose key remains outside PostgreSQL and cryptographically
-- destroys it on every terminal state. Project assignments are business
-- authorization metadata and never grant project-key envelopes or
-- ciphertext-sync access.

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
        'project_assignment'
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
        'project_assignment'
      )
    );

CREATE TABLE cloud_teams (
  tenant_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  team_id UUID NOT NULL,
  display_name TEXT NOT NULL
    CHECK (
      length(btrim(display_name)) BETWEEN 1 AND 120
      AND display_name !~ '[[:cntrl:]]'
    ),
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, team_id),
  UNIQUE (team_id),
  CHECK (updated_at >= created_at),
  CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
  CHECK (archived_at IS NULL OR archived_at BETWEEN created_at AND updated_at)
);

CREATE TABLE cloud_team_memberships (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  role TEXT NOT NULL
    CHECK (
      role IN (
        'owner',
        'admin',
        'author',
        'reviewer',
        'read_only',
        'finance_admin'
      )
    ),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, team_id, membership_id),
  UNIQUE (membership_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at BETWEEN created_at AND updated_at)
);

CREATE UNIQUE INDEX cloud_team_memberships_one_active_account_idx
  ON cloud_team_memberships (tenant_id, team_id, account_id)
  WHERE state = 'active';

CREATE INDEX cloud_team_memberships_account_page_idx
  ON cloud_team_memberships (account_id, created_at DESC, membership_id DESC)
  WHERE state = 'active';

CREATE INDEX cloud_team_memberships_team_page_idx
  ON cloud_team_memberships (
    tenant_id,
    team_id,
    created_at DESC,
    membership_id DESC
  );

CREATE TABLE cloud_team_invitations (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  invitation_id UUID NOT NULL,
  invitee_email TEXT NOT NULL
    CHECK (
      invitee_email = lower(btrim(invitee_email))
      AND length(invitee_email) BETWEEN 3 AND 320
      AND invitee_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    ),
  role TEXT NOT NULL
    CHECK (role IN ('admin', 'author', 'reviewer', 'read_only', 'finance_admin')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  token_hash_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (token_hash_sha256 ~ '^[a-f0-9]{64}$'),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  invited_by_membership_id UUID NOT NULL,
  accepted_membership_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, team_id, invitation_id),
  UNIQUE (invitation_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, invited_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, accepted_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK (
    (
      state = 'accepted'
      AND accepted_at IS NOT NULL
      AND accepted_membership_id IS NOT NULL
      AND accepted_at BETWEEN created_at AND updated_at
      AND accepted_at <= expires_at
      AND revoked_at IS NULL
    )
    OR (
      state = 'revoked'
      AND accepted_at IS NULL
      AND accepted_membership_id IS NULL
      AND revoked_at IS NOT NULL
      AND revoked_at BETWEEN created_at AND updated_at
      AND revoked_at <= expires_at
    )
    OR (
      state = 'pending'
      AND accepted_at IS NULL
      AND accepted_membership_id IS NULL
      AND revoked_at IS NULL
      AND updated_at < expires_at
    )
    OR (
      state = 'expired'
      AND accepted_at IS NULL
      AND accepted_membership_id IS NULL
      AND revoked_at IS NULL
      AND updated_at >= expires_at
    )
  )
);

CREATE UNIQUE INDEX cloud_team_invitations_one_pending_email_idx
  ON cloud_team_invitations (tenant_id, team_id, invitee_email)
  WHERE state = 'pending';

CREATE INDEX cloud_team_invitations_invitee_idx
  ON cloud_team_invitations (invitee_email, created_at DESC, invitation_id DESC);

CREATE TABLE cloud_team_invitation_outbox (
  delivery_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  invitation_id UUID NOT NULL UNIQUE,
  token_ciphertext BYTEA
    CHECK (octet_length(token_ciphertext) BETWEEN 1 AND 512),
  token_nonce BYTEA CHECK (octet_length(token_nonce) = 12),
  token_auth_tag BYTEA CHECK (octet_length(token_auth_tag) = 16),
  encryption_key_id TEXT
    CHECK (
      length(encryption_key_id) BETWEEN 1 AND 100
      AND encryption_key_id ~ '^[A-Za-z0-9._:-]+$'
    ),
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'leased', 'delivered', 'cancelled', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 1000000),
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 1 AND 100
        AND last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
      )
    ),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, team_id, invitation_id)
    REFERENCES cloud_team_invitations(tenant_id, team_id, invitation_id)
    ON DELETE RESTRICT,
  CHECK (available_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (
      state IN ('pending', 'leased')
      AND token_ciphertext IS NOT NULL
      AND token_nonce IS NOT NULL
      AND token_auth_tag IS NOT NULL
      AND encryption_key_id IS NOT NULL
    )
    OR (
      state IN ('delivered', 'cancelled', 'dead_letter')
      AND token_ciphertext IS NULL
      AND token_nonce IS NULL
      AND token_auth_tag IS NULL
      AND encryption_key_id IS NULL
    )
  ),
  CHECK (
    (
      state = 'leased'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > updated_at
      AND delivered_at IS NULL
    )
    OR (
      state = 'delivered'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NOT NULL
      AND delivered_at BETWEEN created_at AND updated_at
    )
    OR (
      state IN ('pending', 'cancelled', 'dead_letter')
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NULL
    )
  )
);

CREATE INDEX cloud_team_invitation_outbox_available_idx
  ON cloud_team_invitation_outbox (available_at, created_at, delivery_id)
  WHERE state IN ('pending', 'leased');

CREATE TABLE cloud_project_assignments (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  granted_by_membership_id UUID NOT NULL,
  revoked_by_membership_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, team_id, project_id, membership_id),
  UNIQUE (assignment_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES cloud_projects(tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, granted_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, revoked_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    (
      state = 'active'
      AND revoked_at IS NULL
      AND revoked_by_membership_id IS NULL
    )
    OR (
      state = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoked_by_membership_id IS NOT NULL
      AND revoked_at BETWEEN created_at AND updated_at
    )
  )
);

CREATE INDEX cloud_project_assignments_project_page_idx
  ON cloud_project_assignments (
    tenant_id,
    team_id,
    project_id,
    created_at DESC,
    assignment_id DESC
  );

CREATE INDEX cloud_project_assignments_member_active_idx
  ON cloud_project_assignments (tenant_id, team_id, membership_id, project_id)
  WHERE state = 'active';

CREATE TABLE cloud_team_audit_events (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  event_id UUID NOT NULL,
  request_id UUID NOT NULL,
  actor_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  actor_membership_id UUID,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('team', 'membership', 'invitation', 'project_assignment')),
  resource_id UUID,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'failed')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 100),
  redacted_diff JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(redacted_diff) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, event_id),
  UNIQUE (event_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, actor_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT
);

CREATE INDEX cloud_team_audit_events_page_idx
  ON cloud_team_audit_events (
    tenant_id,
    team_id,
    created_at DESC,
    event_id DESC
  );

CREATE FUNCTION reject_cloud_team_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud team audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_team_audit_events_append_only
BEFORE UPDATE OR DELETE ON cloud_team_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_cloud_team_audit_mutation();

CREATE FUNCTION inkshadow_current_account()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('inkshadow.account_id', true), '')::uuid
$$;

CREATE FUNCTION inkshadow_current_team()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('inkshadow.team_id', true), '')::uuid
$$;

CREATE FUNCTION inkshadow_has_active_team_membership(
  requested_tenant_id UUID,
  requested_team_id UUID
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
    FROM public.cloud_team_memberships
    WHERE tenant_id = requested_tenant_id
      AND team_id = requested_team_id
      AND account_id = public.inkshadow_current_account()
      AND state = 'active'
  )
$$;

CREATE FUNCTION inkshadow_invitation_matches_current_account(
  requested_email TEXT
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
    FROM public.cloud_accounts
    WHERE account_id = public.inkshadow_current_account()
      AND email_canonical = requested_email
      AND state = 'active'
  )
$$;

REVOKE ALL ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_invitation_matches_current_account(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_invitation_matches_current_account(TEXT) TO PUBLIC;

CREATE FUNCTION inkshadow_account_requires_ownership_transfer(
  requested_account_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  transfer_required BOOLEAN;
BEGIN
  IF requested_account_id IS NULL THEN
    RAISE EXCEPTION 'an account identifier is required'
      USING ERRCODE = '22023';
  END IF;

  -- Match the service mutation lock order: team row first, then all active
  -- owner rows. Global ordering prevents multi-team owners from deadlocking.
  PERFORM 1
  FROM public.cloud_teams AS team_record
  WHERE team_record.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.cloud_team_memberships AS target_membership
      WHERE target_membership.tenant_id = team_record.tenant_id
        AND target_membership.team_id = team_record.team_id
        AND target_membership.account_id = requested_account_id
        AND target_membership.state = 'active'
        AND target_membership.role = 'owner'
    )
  ORDER BY team_record.tenant_id, team_record.team_id
  FOR UPDATE OF team_record;

  PERFORM 1
  FROM public.cloud_team_memberships AS owner_membership
  WHERE owner_membership.state = 'active'
    AND owner_membership.role = 'owner'
    AND EXISTS (
      SELECT 1
      FROM public.cloud_team_memberships AS target_membership
      WHERE target_membership.tenant_id = owner_membership.tenant_id
        AND target_membership.team_id = owner_membership.team_id
        AND target_membership.account_id = requested_account_id
        AND target_membership.state = 'active'
        AND target_membership.role = 'owner'
    )
  ORDER BY
    owner_membership.tenant_id,
    owner_membership.team_id,
    owner_membership.membership_id
  FOR UPDATE OF owner_membership;

  -- A project that is still assigned to another active team member is shared
  -- business state even though an assignment never grants a key envelope.
  -- Lock both the owned project and its assignment rows so deletion cannot
  -- race a new or reactivated assignment.
  PERFORM 1
  FROM public.cloud_projects AS owned_project
  WHERE owned_project.owner_account_id = requested_account_id
    AND owned_project.state <> 'deleted'
  ORDER BY owned_project.tenant_id, owned_project.project_id
  FOR UPDATE OF owned_project;

  PERFORM 1
  FROM public.cloud_project_assignments AS assignment
  JOIN public.cloud_projects AS owned_project
    ON owned_project.tenant_id = assignment.tenant_id
    AND owned_project.project_id = assignment.project_id
  WHERE owned_project.owner_account_id = requested_account_id
    AND owned_project.state <> 'deleted'
    AND assignment.state = 'active'
  ORDER BY
    assignment.tenant_id,
    assignment.team_id,
    assignment.project_id,
    assignment.membership_id
  FOR UPDATE OF assignment;

  SELECT EXISTS (
    SELECT 1
    FROM public.cloud_team_memberships AS target_membership
    JOIN public.cloud_teams AS team_record
      ON team_record.tenant_id = target_membership.tenant_id
      AND team_record.team_id = target_membership.team_id
      AND team_record.state = 'active'
    WHERE target_membership.account_id = requested_account_id
      AND target_membership.state = 'active'
      AND target_membership.role = 'owner'
      AND NOT EXISTS (
        SELECT 1
        FROM public.cloud_team_memberships AS alternate_membership
        JOIN public.cloud_accounts AS alternate_account
          ON alternate_account.account_id = alternate_membership.account_id
        WHERE alternate_membership.tenant_id = target_membership.tenant_id
          AND alternate_membership.team_id = target_membership.team_id
          AND alternate_membership.membership_id <> target_membership.membership_id
          AND alternate_membership.state = 'active'
          AND alternate_membership.role = 'owner'
          AND alternate_account.state NOT IN ('deletion_scheduled', 'deleted')
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.cloud_projects AS owned_project
    JOIN public.cloud_project_assignments AS assignment
      ON assignment.tenant_id = owned_project.tenant_id
      AND assignment.project_id = owned_project.project_id
      AND assignment.state = 'active'
    JOIN public.cloud_teams AS team_record
      ON team_record.tenant_id = assignment.tenant_id
      AND team_record.team_id = assignment.team_id
      AND team_record.state = 'active'
    JOIN public.cloud_team_memberships AS assigned_membership
      ON assigned_membership.tenant_id = assignment.tenant_id
      AND assigned_membership.team_id = assignment.team_id
      AND assigned_membership.membership_id = assignment.membership_id
      AND assigned_membership.state = 'active'
    JOIN public.cloud_accounts AS assigned_account
      ON assigned_account.account_id = assigned_membership.account_id
    WHERE owned_project.owner_account_id = requested_account_id
      AND owned_project.state <> 'deleted'
      AND assigned_membership.account_id <> requested_account_id
      AND assigned_account.state NOT IN ('deletion_scheduled', 'deleted')
  ) INTO transfer_required;

  RETURN transfer_required;
END;
$$;

CREATE FUNCTION inkshadow_revoke_account_team_access(
  requested_account_id UUID,
  revoked_at TIMESTAMPTZ,
  deletion_request_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  account_email TEXT;
  revoked_membership_count INTEGER;
BEGIN
  IF requested_account_id IS NULL
    OR revoked_at IS NULL
    OR deletion_request_id IS NULL
  THEN
    RAISE EXCEPTION 'account team-access revocation arguments are required'
      USING ERRCODE = '22023';
  END IF;

  IF public.inkshadow_account_requires_ownership_transfer(requested_account_id) THEN
    RAISE EXCEPTION 'team ownership must be transferred before account deletion'
      USING ERRCODE = '23514';
  END IF;

  SELECT email_canonical
  INTO account_email
  FROM public.cloud_accounts
  WHERE account_id = requested_account_id
  FOR UPDATE;

  IF account_email IS NULL THEN
    RAISE EXCEPTION 'the cloud account was not found'
      USING ERRCODE = '02000';
  END IF;

  INSERT INTO public.cloud_team_audit_events (
    tenant_id,
    team_id,
    event_id,
    request_id,
    actor_account_id,
    actor_membership_id,
    resource_type,
    resource_id,
    action,
    result,
    reason,
    redacted_diff,
    created_at
  )
  SELECT
    assignment.tenant_id,
    assignment.team_id,
    assignment.assignment_id,
    deletion_request_id,
    requested_account_id,
    membership.membership_id,
    'project_assignment',
    assignment.assignment_id,
    'account_deletion.project_assignment_revoked',
    'allowed',
    'account_deletion',
    jsonb_build_object(
      'stateFrom',
      assignment.state,
      'stateTo',
      'revoked'
    ),
    inkshadow_revoke_account_team_access.revoked_at
  FROM public.cloud_project_assignments AS assignment
  JOIN public.cloud_team_memberships AS membership
    ON membership.tenant_id = assignment.tenant_id
    AND membership.team_id = assignment.team_id
    AND membership.membership_id = assignment.membership_id
  WHERE membership.account_id = requested_account_id
    AND assignment.state = 'active'
  ON CONFLICT (event_id) DO NOTHING;

  UPDATE public.cloud_project_assignments AS assignment
  SET state = 'revoked',
      revision = assignment.revision + 1,
      revoked_by_membership_id = assignment.membership_id,
      revoked_at = inkshadow_revoke_account_team_access.revoked_at,
      updated_at = inkshadow_revoke_account_team_access.revoked_at
  FROM public.cloud_team_memberships AS membership
  WHERE membership.account_id = requested_account_id
    AND assignment.tenant_id = membership.tenant_id
    AND assignment.team_id = membership.team_id
    AND assignment.membership_id = membership.membership_id
    AND assignment.state = 'active';

  INSERT INTO public.cloud_team_audit_events (
    tenant_id,
    team_id,
    event_id,
    request_id,
    actor_account_id,
    actor_membership_id,
    resource_type,
    resource_id,
    action,
    result,
    reason,
    redacted_diff,
    created_at
  )
  SELECT
    membership.tenant_id,
    membership.team_id,
    membership.membership_id,
    deletion_request_id,
    requested_account_id,
    membership.membership_id,
    'membership',
    membership.membership_id,
    'account_deletion.team_access_revoked',
    'allowed',
    'account_deletion',
    jsonb_build_object(
      'roleFrom',
      membership.role,
      'stateFrom',
      membership.state,
      'stateTo',
      'revoked'
    ),
    inkshadow_revoke_account_team_access.revoked_at
  FROM public.cloud_team_memberships AS membership
  WHERE membership.account_id = requested_account_id
    AND membership.state = 'active'
  ON CONFLICT (event_id) DO NOTHING;

  INSERT INTO public.cloud_team_audit_events (
    tenant_id,
    team_id,
    event_id,
    request_id,
    actor_account_id,
    actor_membership_id,
    resource_type,
    resource_id,
    action,
    result,
    reason,
    redacted_diff,
    created_at
  )
  SELECT
    invitation.tenant_id,
    invitation.team_id,
    invitation.invitation_id,
    deletion_request_id,
    requested_account_id,
    NULL,
    'invitation',
    invitation.invitation_id,
    'account_deletion.invitation_deidentified',
    'allowed',
    'account_deletion',
    jsonb_build_object(
      'stateFrom',
      invitation.state,
      'stateTo',
      CASE
        WHEN invitation.state = 'pending'
          AND invitation.expires_at <= inkshadow_revoke_account_team_access.revoked_at
          THEN 'expired'
        WHEN invitation.state = 'pending' THEN 'revoked'
        ELSE invitation.state
      END
    ),
    inkshadow_revoke_account_team_access.revoked_at
  FROM public.cloud_team_invitations AS invitation
  WHERE invitation.invitee_email = account_email
  ON CONFLICT (event_id) DO NOTHING;

  UPDATE public.cloud_team_invitation_outbox AS delivery
  SET state = CASE
        WHEN delivery.state IN ('pending', 'leased') THEN 'cancelled'
        ELSE delivery.state
      END,
      token_ciphertext = NULL,
      token_nonce = NULL,
      token_auth_tag = NULL,
      encryption_key_id = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = 'ACCOUNT_DELETED',
      revision = delivery.revision + 1,
      updated_at = GREATEST(
        delivery.updated_at,
        inkshadow_revoke_account_team_access.revoked_at
      )
  FROM public.cloud_team_invitations AS invitation
  WHERE invitation.tenant_id = delivery.tenant_id
    AND invitation.team_id = delivery.team_id
    AND invitation.invitation_id = delivery.invitation_id
    AND invitation.invitee_email = account_email;

  UPDATE public.cloud_team_invitations AS invitation
  SET invitee_email =
        'deleted-' || deletion_request_id::text || '@deleted.invalid',
      state = CASE
        WHEN invitation.state = 'pending'
          AND invitation.expires_at <= inkshadow_revoke_account_team_access.revoked_at
          THEN 'expired'
        WHEN invitation.state = 'pending' THEN 'revoked'
        ELSE invitation.state
      END,
      revision = invitation.revision + 1,
      updated_at = GREATEST(
        invitation.updated_at,
        inkshadow_revoke_account_team_access.revoked_at
      ),
      revoked_at = CASE
        WHEN invitation.state = 'pending'
          AND invitation.expires_at > inkshadow_revoke_account_team_access.revoked_at
          THEN inkshadow_revoke_account_team_access.revoked_at
        ELSE invitation.revoked_at
      END
  WHERE invitation.invitee_email = account_email;

  UPDATE public.cloud_team_memberships AS membership
  SET state = 'revoked',
      revision = membership.revision + 1,
      revoked_at = inkshadow_revoke_account_team_access.revoked_at,
      updated_at = inkshadow_revoke_account_team_access.revoked_at
  WHERE membership.account_id = requested_account_id
    AND membership.state = 'active';

  GET DIAGNOSTICS revoked_membership_count = ROW_COUNT;
  RETURN revoked_membership_count;
END;
$$;

CREATE FUNCTION inkshadow_account_has_active_team_access(
  requested_account_id UUID
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
    FROM public.cloud_team_memberships AS membership
    WHERE membership.account_id = requested_account_id
      AND membership.state = 'active'
  ) OR EXISTS (
    SELECT 1
    FROM public.cloud_project_assignments AS assignment
    JOIN public.cloud_team_memberships AS membership
      ON membership.tenant_id = assignment.tenant_id
      AND membership.team_id = assignment.team_id
      AND membership.membership_id = assignment.membership_id
    WHERE membership.account_id = requested_account_id
      AND assignment.state = 'active'
  )
$$;

REVOKE ALL ON FUNCTION inkshadow_account_requires_ownership_transfer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_revoke_account_team_access(UUID, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_account_has_active_team_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_account_requires_ownership_transfer(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_revoke_account_team_access(UUID, TIMESTAMPTZ, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_account_has_active_team_access(UUID) TO CURRENT_USER;

CREATE FUNCTION inkshadow_claim_team_invitation_outbox(
  p_worker_id UUID,
  p_now TIMESTAMPTZ,
  p_lease_expires_at TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (
  delivery_id UUID,
  tenant_id UUID,
  team_id UUID,
  invitation_id UUID,
  token_ciphertext BYTEA,
  token_nonce BYTEA,
  token_auth_tag BYTEA,
  encryption_key_id TEXT,
  state TEXT,
  attempt_count INTEGER,
  available_at TIMESTAMPTZ,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  revision BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  invitee_email TEXT,
  invitation_role TEXT,
  invitation_state TEXT,
  invitation_expires_at TIMESTAMPTZ,
  team_display_name TEXT,
  team_state TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF p_worker_id IS NULL
    OR p_now IS NULL
    OR p_lease_expires_at IS NULL
    OR p_lease_expires_at <= p_now
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 256
  THEN
    RAISE EXCEPTION 'invalid team invitation outbox claim arguments'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT candidate.delivery_id
    FROM public.cloud_team_invitation_outbox AS candidate
    WHERE (
        (
          candidate.state = 'pending'
          AND candidate.available_at <= p_now
        )
        OR (
          candidate.state = 'leased'
          AND candidate.lease_expires_at <= p_now
        )
      )
      AND candidate.attempt_count < 1000000
      AND candidate.revision < 9007199254740991
    ORDER BY candidate.available_at, candidate.created_at, candidate.delivery_id
    FOR UPDATE OF candidate SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.cloud_team_invitation_outbox AS delivery
    SET state = 'leased',
        attempt_count = delivery.attempt_count + 1,
        lease_owner = p_worker_id,
        lease_expires_at = p_lease_expires_at,
        revision = delivery.revision + 1,
        updated_at = p_now
    FROM candidates
    WHERE delivery.delivery_id = candidates.delivery_id
    RETURNING delivery.*
  )
  SELECT
    claimed.delivery_id,
    claimed.tenant_id,
    claimed.team_id,
    claimed.invitation_id,
    claimed.token_ciphertext,
    claimed.token_nonce,
    claimed.token_auth_tag,
    claimed.encryption_key_id,
    claimed.state,
    claimed.attempt_count,
    claimed.available_at,
    claimed.lease_owner,
    claimed.lease_expires_at,
    claimed.last_error_code,
    claimed.revision,
    claimed.created_at,
    claimed.updated_at,
    claimed.delivered_at,
    invitation.invitee_email,
    invitation.role,
    invitation.state,
    invitation.expires_at,
    team_record.display_name,
    team_record.state
  FROM claimed
  JOIN public.cloud_team_invitations AS invitation
    ON invitation.tenant_id = claimed.tenant_id
    AND invitation.team_id = claimed.team_id
    AND invitation.invitation_id = claimed.invitation_id
  JOIN public.cloud_teams AS team_record
    ON team_record.tenant_id = claimed.tenant_id
    AND team_record.team_id = claimed.team_id
  ORDER BY claimed.available_at, claimed.created_at, claimed.delivery_id;
END;
$$;

CREATE FUNCTION inkshadow_lock_team_invitation_outbox_delivery(
  p_delivery_id UUID,
  p_worker_id UUID,
  p_expected_revision BIGINT,
  p_now TIMESTAMPTZ
)
RETURNS TABLE (
  delivery_id UUID,
  tenant_id UUID,
  team_id UUID,
  invitation_id UUID,
  token_ciphertext BYTEA,
  token_nonce BYTEA,
  token_auth_tag BYTEA,
  encryption_key_id TEXT,
  state TEXT,
  attempt_count INTEGER,
  available_at TIMESTAMPTZ,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  revision BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  invitee_email TEXT,
  invitation_role TEXT,
  invitation_state TEXT,
  invitation_expires_at TIMESTAMPTZ,
  team_display_name TEXT,
  team_state TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF p_delivery_id IS NULL
    OR p_worker_id IS NULL
    OR p_expected_revision IS NULL
    OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'invalid team invitation delivery fence arguments'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    delivery.delivery_id,
    delivery.tenant_id,
    delivery.team_id,
    delivery.invitation_id,
    delivery.token_ciphertext,
    delivery.token_nonce,
    delivery.token_auth_tag,
    delivery.encryption_key_id,
    delivery.state,
    delivery.attempt_count,
    delivery.available_at,
    delivery.lease_owner,
    delivery.lease_expires_at,
    delivery.last_error_code,
    delivery.revision,
    delivery.created_at,
    delivery.updated_at,
    delivery.delivered_at,
    invitation.invitee_email,
    invitation.role,
    invitation.state,
    invitation.expires_at,
    team_record.display_name,
    team_record.state
  FROM public.cloud_team_invitation_outbox AS delivery
  JOIN public.cloud_team_invitations AS invitation
    ON invitation.tenant_id = delivery.tenant_id
    AND invitation.team_id = delivery.team_id
    AND invitation.invitation_id = delivery.invitation_id
  JOIN public.cloud_teams AS team_record
    ON team_record.tenant_id = delivery.tenant_id
    AND team_record.team_id = delivery.team_id
  WHERE delivery.delivery_id = p_delivery_id
    AND delivery.state = 'leased'
    AND delivery.lease_owner = p_worker_id
    AND delivery.lease_expires_at > p_now
    AND delivery.revision = p_expected_revision
  FOR UPDATE OF delivery;
END;
$$;

CREATE FUNCTION inkshadow_mark_team_invitation_outbox_delivered(
  p_delivery_id UUID,
  p_worker_id UUID,
  p_expected_revision BIGINT,
  p_delivered_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF p_delivery_id IS NULL
    OR p_worker_id IS NULL
    OR p_expected_revision IS NULL
    OR p_delivered_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid team invitation delivery completion arguments'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.cloud_team_invitation_outbox AS delivery
  SET state = 'delivered',
      token_ciphertext = NULL,
      token_nonce = NULL,
      token_auth_tag = NULL,
      encryption_key_id = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL,
      revision = delivery.revision + 1,
      updated_at = p_delivered_at,
      delivered_at = p_delivered_at
  WHERE delivery.delivery_id = p_delivery_id
    AND delivery.state = 'leased'
    AND delivery.lease_owner = p_worker_id
    AND delivery.lease_expires_at > p_delivered_at
    AND delivery.revision = p_expected_revision;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION inkshadow_retry_team_invitation_outbox(
  p_delivery_id UUID,
  p_worker_id UUID,
  p_expected_revision BIGINT,
  p_now TIMESTAMPTZ,
  p_available_at TIMESTAMPTZ,
  p_error_code TEXT,
  p_dead_letter BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF p_delivery_id IS NULL
    OR p_worker_id IS NULL
    OR p_expected_revision IS NULL
    OR p_now IS NULL
    OR p_available_at IS NULL
    OR p_available_at < p_now
    OR p_error_code IS NULL
    OR p_dead_letter IS NULL
  THEN
    RAISE EXCEPTION 'invalid team invitation retry arguments'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.cloud_team_invitation_outbox AS delivery
  SET state = CASE WHEN p_dead_letter THEN 'dead_letter' ELSE 'pending' END,
      token_ciphertext = CASE
        WHEN p_dead_letter THEN NULL
        ELSE delivery.token_ciphertext
      END,
      token_nonce = CASE
        WHEN p_dead_letter THEN NULL
        ELSE delivery.token_nonce
      END,
      token_auth_tag = CASE
        WHEN p_dead_letter THEN NULL
        ELSE delivery.token_auth_tag
      END,
      encryption_key_id = CASE
        WHEN p_dead_letter THEN NULL
        ELSE delivery.encryption_key_id
      END,
      available_at = p_available_at,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = p_error_code,
      revision = delivery.revision + 1,
      updated_at = p_now
  WHERE delivery.delivery_id = p_delivery_id
    AND delivery.state = 'leased'
    AND delivery.lease_owner = p_worker_id
    AND delivery.lease_expires_at > p_now
    AND delivery.revision = p_expected_revision;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION inkshadow_cancel_team_invitation_outbox(
  p_delivery_id UUID,
  p_worker_id UUID,
  p_expected_revision BIGINT,
  p_now TIMESTAMPTZ,
  p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF p_delivery_id IS NULL
    OR p_worker_id IS NULL
    OR p_expected_revision IS NULL
    OR p_now IS NULL
    OR p_error_code IS NULL
  THEN
    RAISE EXCEPTION 'invalid team invitation cancellation arguments'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.cloud_team_invitation_outbox AS delivery
  SET state = 'cancelled',
      token_ciphertext = NULL,
      token_nonce = NULL,
      token_auth_tag = NULL,
      encryption_key_id = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = p_error_code,
      revision = delivery.revision + 1,
      updated_at = p_now
  WHERE delivery.delivery_id = p_delivery_id
    AND delivery.state = 'leased'
    AND delivery.lease_owner = p_worker_id
    AND delivery.lease_expires_at > p_now
    AND delivery.revision = p_expected_revision;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION inkshadow_terminalize_team_invitation_outbox(
  p_tenant_id UUID,
  p_team_id UUID,
  p_invitation_id UUID,
  p_now TIMESTAMPTZ,
  p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF p_tenant_id IS NULL
    OR p_team_id IS NULL
    OR p_invitation_id IS NULL
    OR p_now IS NULL
    OR p_error_code IS NULL
  THEN
    RAISE EXCEPTION 'invalid team invitation terminalization arguments'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.cloud_team_invitation_outbox AS delivery
  SET state = 'cancelled',
      token_ciphertext = NULL,
      token_nonce = NULL,
      token_auth_tag = NULL,
      encryption_key_id = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = p_error_code,
      revision = delivery.revision + 1,
      updated_at = p_now
  WHERE delivery.tenant_id = p_tenant_id
    AND delivery.team_id = p_team_id
    AND delivery.invitation_id = p_invitation_id
    AND delivery.state IN ('pending', 'leased');

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION
  inkshadow_claim_team_invitation_outbox(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_lock_team_invitation_outbox_delivery(UUID, UUID, BIGINT, TIMESTAMPTZ)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_mark_team_invitation_outbox_delivered(UUID, UUID, BIGINT, TIMESTAMPTZ)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_retry_team_invitation_outbox(
    UUID,
    UUID,
    BIGINT,
    TIMESTAMPTZ,
    TIMESTAMPTZ,
    TEXT,
    BOOLEAN
  )
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_cancel_team_invitation_outbox(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_terminalize_team_invitation_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inkshadow_claim_team_invitation_outbox(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_lock_team_invitation_outbox_delivery(UUID, UUID, BIGINT, TIMESTAMPTZ)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_mark_team_invitation_outbox_delivered(UUID, UUID, BIGINT, TIMESTAMPTZ)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_retry_team_invitation_outbox(
    UUID,
    UUID,
    BIGINT,
    TIMESTAMPTZ,
    TIMESTAMPTZ,
    TEXT,
    BOOLEAN
  )
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_cancel_team_invitation_outbox(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_terminalize_team_invitation_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT)
  TO CURRENT_USER;

ALTER TABLE cloud_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_invitation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_project_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_audit_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_teams FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_invitation_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_project_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_team_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_teams_scope_isolation ON cloud_teams
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND (
      inkshadow_has_active_team_membership(tenant_id, team_id)
      OR tenant_id = inkshadow_current_account()
    )
  );

CREATE POLICY cloud_team_memberships_scope_isolation ON cloud_team_memberships
  USING (
    account_id = inkshadow_current_account()
    OR (
      tenant_id = inkshadow_current_tenant()
      AND team_id = inkshadow_current_team()
      AND inkshadow_has_active_team_membership(tenant_id, team_id)
    )
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND (
      account_id = inkshadow_current_account()
      OR inkshadow_has_active_team_membership(tenant_id, team_id)
    )
  );

CREATE POLICY cloud_team_invitations_scope_isolation ON cloud_team_invitations
  USING (
    inkshadow_invitation_matches_current_account(invitee_email)
    OR (
      tenant_id = inkshadow_current_tenant()
      AND team_id = inkshadow_current_team()
      AND inkshadow_has_active_team_membership(tenant_id, team_id)
    )
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  );

CREATE POLICY cloud_team_invitation_outbox_insert_scope
  ON cloud_team_invitation_outbox
  FOR INSERT
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  );

CREATE POLICY cloud_project_assignments_scope_isolation ON cloud_project_assignments
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  );

CREATE POLICY cloud_team_audit_events_scope_isolation ON cloud_team_audit_events
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  );

CREATE FUNCTION enforce_cloud_team_active_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  affected_tenant_id UUID;
  affected_team_id UUID;
BEGIN
  affected_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  affected_team_id := COALESCE(NEW.team_id, OLD.team_id);

  -- Serialize every ownership-affecting transaction on the team row. Without
  -- this lock, concurrent changes to different owner memberships can both
  -- observe the other owner and commit a write-skew violation.
  PERFORM 1
  FROM public.cloud_teams
  WHERE tenant_id = affected_tenant_id
    AND team_id = affected_team_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.cloud_teams
    WHERE tenant_id = affected_tenant_id
      AND team_id = affected_team_id
      AND state = 'active'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.cloud_team_memberships AS owner_membership
    JOIN public.cloud_accounts AS owner_account
      ON owner_account.account_id = owner_membership.account_id
    WHERE owner_membership.tenant_id = affected_tenant_id
      AND owner_membership.team_id = affected_team_id
      AND owner_membership.state = 'active'
      AND owner_membership.role = 'owner'
      AND owner_account.state NOT IN ('deletion_scheduled', 'deleted')
  ) THEN
    RAISE EXCEPTION 'an active cloud team must retain an active owner'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cloud_teams_require_owner
AFTER INSERT OR UPDATE ON cloud_teams
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_team_active_owner();

CREATE CONSTRAINT TRIGGER cloud_team_memberships_require_owner
AFTER INSERT OR UPDATE OR DELETE ON cloud_team_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_team_active_owner();

CREATE FUNCTION enforce_cloud_account_team_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  -- Deferred triggers retain the row image from their event. Re-read the
  -- account so a later change in the same transaction is evaluated by its
  -- final state.
  IF NOT EXISTS (
    SELECT 1
    FROM public.cloud_accounts
    WHERE account_id = NEW.account_id
      AND state IN ('deletion_scheduled', 'deleted')
  ) THEN
    RETURN NULL;
  END IF;

  -- An account may own multiple teams. Lock them in a global order so both
  -- account-state changes and membership mutations share one serialization
  -- point per team.
  PERFORM 1
  FROM public.cloud_teams AS team_record
  WHERE team_record.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.cloud_team_memberships AS target_membership
      WHERE target_membership.tenant_id = team_record.tenant_id
        AND target_membership.team_id = team_record.team_id
        AND target_membership.account_id = NEW.account_id
        AND target_membership.state = 'active'
        AND target_membership.role = 'owner'
    )
  ORDER BY team_record.tenant_id, team_record.team_id
  FOR UPDATE OF team_record;

  IF EXISTS (
    SELECT 1
    FROM public.cloud_team_memberships AS target_membership
    JOIN public.cloud_teams AS team_record
      ON team_record.tenant_id = target_membership.tenant_id
      AND team_record.team_id = target_membership.team_id
      AND team_record.state = 'active'
    WHERE target_membership.account_id = NEW.account_id
      AND target_membership.state = 'active'
      AND target_membership.role = 'owner'
      AND NOT EXISTS (
        SELECT 1
        FROM public.cloud_team_memberships AS alternate_membership
        JOIN public.cloud_accounts AS alternate_account
          ON alternate_account.account_id = alternate_membership.account_id
        WHERE alternate_membership.tenant_id = target_membership.tenant_id
          AND alternate_membership.team_id = target_membership.team_id
          AND alternate_membership.membership_id <> target_membership.membership_id
          AND alternate_membership.state = 'active'
          AND alternate_membership.role = 'owner'
          AND alternate_account.state NOT IN ('deletion_scheduled', 'deleted')
      )
  ) THEN
    RAISE EXCEPTION 'an active cloud team must retain an active owner'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cloud_accounts_require_team_owner
AFTER UPDATE ON cloud_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_account_team_ownership();

REVOKE ALL ON FUNCTION enforce_cloud_team_active_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_cloud_account_team_ownership() FROM PUBLIC;
