CREATE FUNCTION inkshadow_is_sorted_unique_text_array(
  values_to_check TEXT[],
  maximum_items INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(values_to_check) <= maximum_items
    AND array_position(values_to_check, NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(values_to_check) WITH ORDINALITY AS current_value(value, position)
      JOIN unnest(values_to_check) WITH ORDINALITY AS previous_value(value, position)
        ON previous_value.position + 1 = current_value.position
      WHERE previous_value.value >= current_value.value
    )
$$;

CREATE FUNCTION inkshadow_all_text_array_values_match(
  values_to_check TEXT[],
  required_pattern TEXT,
  maximum_length INTEGER,
  require_dot BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM unnest(values_to_check) AS candidate(value)
    WHERE length(candidate.value) > maximum_length
      OR candidate.value !~ required_pattern
      OR (require_dot AND candidate.value NOT LIKE '%.%')
  )
$$;

REVOKE ALL ON FUNCTION inkshadow_is_sorted_unique_text_array(TEXT[], INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_all_text_array_values_match(TEXT[], TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_is_sorted_unique_text_array(TEXT[], INTEGER)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_all_text_array_values_match(TEXT[], TEXT, INTEGER, BOOLEAN)
  TO CURRENT_USER;

ALTER TABLE cloud_team_memberships
  ADD CONSTRAINT cloud_team_memberships_enterprise_identity_key
    UNIQUE (tenant_id, team_id, membership_id, account_id);

ALTER TABLE cloud_sessions
  ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'password'
    CHECK (authentication_method IN ('password', 'oidc')),
  ADD COLUMN absolute_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT cloud_sessions_enterprise_absolute_expiry_check
    CHECK (
      (authentication_method = 'password' AND absolute_expires_at IS NULL)
      OR
      (
        authentication_method = 'oidc'
        AND absolute_expires_at IS NOT NULL
        AND absolute_expires_at > issued_at
        AND refresh_expires_at <= absolute_expires_at
      )
    );

CREATE TABLE cloud_enterprise_policies (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  sso_mode TEXT NOT NULL CHECK (sso_mode IN ('optional', 'required')),
  allowed_email_domains TEXT[] NOT NULL,
  session_maximum_minutes INTEGER NOT NULL
    CHECK (session_maximum_minutes BETWEEN 15 AND 43200),
  maximum_trusted_devices INTEGER NOT NULL
    CHECK (maximum_trusted_devices BETWEEN 1 AND 100),
  device_approval_mode TEXT NOT NULL
    CHECK (device_approval_mode IN ('trusted_device', 'approved_fingerprint')),
  approved_device_fingerprints TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  export_mode TEXT NOT NULL
    CHECK (export_mode IN ('allowed', 'owners_and_admins', 'blocked')),
  external_egress_mode TEXT NOT NULL
    CHECK (external_egress_mode IN ('allowlisted', 'blocked')),
  allowed_external_hosts TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  support_bundle_mode TEXT NOT NULL
    CHECK (support_bundle_mode IN ('owners_and_admins', 'all_members')),
  created_by_membership_id UUID NOT NULL,
  updated_by_membership_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, created_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, updated_by_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    inkshadow_is_sorted_unique_text_array(allowed_email_domains, 64)
    AND cardinality(allowed_email_domains) >= 1
    AND inkshadow_all_text_array_values_match(
      allowed_email_domains,
      '^[a-z0-9]([a-z0-9.-]*[a-z0-9])$',
      253,
      TRUE
    )
  ),
  CHECK (
    inkshadow_is_sorted_unique_text_array(approved_device_fingerprints, 1024)
    AND inkshadow_all_text_array_values_match(
      approved_device_fingerprints,
      '^[a-f0-9]{64}$',
      64,
      FALSE
    )
  ),
  CHECK (
    inkshadow_is_sorted_unique_text_array(allowed_external_hosts, 128)
    AND inkshadow_all_text_array_values_match(
      allowed_external_hosts,
      '^[a-z0-9]([a-z0-9.-]*[a-z0-9])$',
      253,
      TRUE
    )
  ),
  CHECK (
    (device_approval_mode = 'approved_fingerprint'
      AND cardinality(approved_device_fingerprints) >= 1)
    OR
    (device_approval_mode = 'trusted_device'
      AND cardinality(approved_device_fingerprints) = 0)
  ),
  CHECK (
    (external_egress_mode = 'allowlisted'
      AND cardinality(allowed_external_hosts) >= 1)
    OR
    (external_egress_mode = 'blocked'
      AND cardinality(allowed_external_hosts) = 0)
  )
);

CREATE TABLE cloud_enterprise_oidc_flows (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  flow_id UUID NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  session_maximum_minutes INTEGER NOT NULL
    CHECK (session_maximum_minutes BETWEEN 15 AND 43200),
  maximum_trusted_devices INTEGER NOT NULL
    CHECK (maximum_trusted_devices BETWEEN 1 AND 100),
  flow_secret_hash_sha256 TEXT NOT NULL CHECK (flow_secret_hash_sha256 ~ '^[a-f0-9]{64}$'),
  state_hash_sha256 TEXT NOT NULL CHECK (state_hash_sha256 ~ '^[a-f0-9]{64}$'),
  redirect_uri TEXT NOT NULL CHECK (
    length(redirect_uri) BETWEEN 1 AND 2048
    AND redirect_uri ~ '^(https://|inkshadow:)'
    AND redirect_uri !~ '[[:cntrl:]#]'
    AND redirect_uri !~ '^https://[^/]*@'
  ),
  device_binding_hash_sha256 TEXT NOT NULL
    CHECK (device_binding_hash_sha256 ~ '^[a-f0-9]{64}$'),
  exchange_claim_id UUID,
  exchange_started_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  verified_account_id UUID REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  verified_membership_id UUID,
  subject_hash_sha256 TEXT CHECK (
    subject_hash_sha256 IS NULL OR subject_hash_sha256 ~ '^[a-f0-9]{64}$'
  ),
  completion_idempotency_key_hash_sha256 TEXT CHECK (
    completion_idempotency_key_hash_sha256 IS NULL
    OR completion_idempotency_key_hash_sha256 ~ '^[a-f0-9]{64}$'
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, flow_id),
  UNIQUE (flow_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_enterprise_policies(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, verified_membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, verified_membership_id, verified_account_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id, account_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((exchange_claim_id IS NULL) = (exchange_started_at IS NULL)),
  CHECK (consumed_at IS NULL OR exchange_claim_id IS NULL),
  CHECK (
    (consumed_at IS NULL
      AND verified_account_id IS NULL
      AND verified_membership_id IS NULL
      AND subject_hash_sha256 IS NULL
      AND completion_idempotency_key_hash_sha256 IS NULL)
    OR
    (consumed_at IS NOT NULL
      AND verified_account_id IS NOT NULL
      AND verified_membership_id IS NOT NULL
      AND subject_hash_sha256 IS NOT NULL
      AND completion_idempotency_key_hash_sha256 IS NOT NULL)
  ),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX cloud_enterprise_oidc_flows_expiry_idx
  ON cloud_enterprise_oidc_flows (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE cloud_enterprise_oidc_bindings (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  issuer_hash_sha256 TEXT NOT NULL CHECK (issuer_hash_sha256 ~ '^[a-f0-9]{64}$'),
  subject_hash_sha256 TEXT NOT NULL CHECK (subject_hash_sha256 ~ '^[a-f0-9]{64}$'),
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_authenticated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, issuer_hash_sha256, subject_hash_sha256),
  UNIQUE (tenant_id, team_id, account_id, issuer_hash_sha256),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_enterprise_policies(tenant_id, team_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, membership_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, team_id, membership_id, account_id)
    REFERENCES cloud_team_memberships(tenant_id, team_id, membership_id, account_id)
    ON DELETE RESTRICT,
  CHECK (last_authenticated_at >= created_at)
);

ALTER TABLE cloud_enterprise_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_enterprise_oidc_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_enterprise_oidc_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_enterprise_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_enterprise_oidc_flows FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_enterprise_oidc_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_enterprise_policies_scope_isolation
  ON cloud_enterprise_policies
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

CREATE POLICY cloud_enterprise_oidc_flows_scope_isolation
  ON cloud_enterprise_oidc_flows
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
  );

CREATE POLICY cloud_enterprise_oidc_bindings_scope_isolation
  ON cloud_enterprise_oidc_bindings
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
  );

CREATE FUNCTION inkshadow_enterprise_public_sso_policy(
  requested_team_id UUID
)
RETURNS TABLE (
  tenant_id UUID,
  team_id UUID,
  revision INTEGER,
  sso_mode TEXT,
  allowed_email_domains TEXT[],
  session_maximum_minutes INTEGER,
  maximum_trusted_devices INTEGER,
  device_approval_mode TEXT,
  approved_device_fingerprints TEXT[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT
    policy.tenant_id,
    policy.team_id,
    policy.revision,
    policy.sso_mode,
    policy.allowed_email_domains,
    policy.session_maximum_minutes,
    policy.maximum_trusted_devices,
    policy.device_approval_mode,
    policy.approved_device_fingerprints
  FROM public.cloud_enterprise_policies AS policy
  JOIN public.cloud_teams AS team_record
    ON team_record.tenant_id = policy.tenant_id
   AND team_record.team_id = policy.team_id
  WHERE policy.team_id = requested_team_id
    AND team_record.state = 'active'
$$;

CREATE FUNCTION inkshadow_enterprise_resolve_flow(
  requested_flow_id UUID
)
RETURNS TABLE (
  tenant_id UUID,
  team_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT flow.tenant_id, flow.team_id
  FROM public.cloud_enterprise_oidc_flows AS flow
  WHERE flow.flow_id = requested_flow_id
$$;

CREATE FUNCTION inkshadow_enterprise_resolve_member(
  requested_team_id UUID,
  requested_email TEXT
)
RETURNS TABLE (
  tenant_id UUID,
  team_id UUID,
  account_id UUID,
  membership_id UUID,
  role TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT
    membership.tenant_id,
    membership.team_id,
    membership.account_id,
    membership.membership_id,
    membership.role
  FROM public.cloud_team_memberships AS membership
  JOIN public.cloud_accounts AS account
    ON account.account_id = membership.account_id
  JOIN public.cloud_teams AS team_record
    ON team_record.tenant_id = membership.tenant_id
   AND team_record.team_id = membership.team_id
  WHERE membership.team_id = requested_team_id
    AND membership.state = 'active'
    AND account.state = 'active'
    AND account.verified_at IS NOT NULL
    AND account.email_canonical = requested_email
    AND team_record.state = 'active'
$$;

CREATE FUNCTION inkshadow_enterprise_required_sso_teams(
  requested_account_id UUID
)
RETURNS TABLE (
  tenant_id UUID,
  team_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT policy.tenant_id, policy.team_id
  FROM public.cloud_enterprise_policies AS policy
  JOIN public.cloud_team_memberships AS membership
    ON membership.tenant_id = policy.tenant_id
   AND membership.team_id = policy.team_id
  JOIN public.cloud_teams AS team_record
    ON team_record.tenant_id = policy.tenant_id
   AND team_record.team_id = policy.team_id
  WHERE membership.account_id = requested_account_id
    AND membership.state = 'active'
    AND team_record.state = 'active'
    AND policy.sso_mode = 'required'
  ORDER BY policy.team_id
$$;

REVOKE ALL ON FUNCTION inkshadow_enterprise_public_sso_policy(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_enterprise_resolve_flow(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_enterprise_resolve_member(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_enterprise_required_sso_teams(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION inkshadow_enterprise_public_sso_policy(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_enterprise_resolve_flow(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_enterprise_resolve_member(UUID, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_enterprise_required_sso_teams(UUID) TO CURRENT_USER;
