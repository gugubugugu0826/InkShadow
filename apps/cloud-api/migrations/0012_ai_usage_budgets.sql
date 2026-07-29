-- Authoritative team/project AI budgets and metadata-only usage accounting.
--
-- All monetary values are integer currency microunits and all counters are
-- capped at the JavaScript/PostgreSQL portable integer ceiling. Creative
-- content, prompts, project keys and ciphertext have no column in this model.
-- Budget and usage history is retained when a project is deleted so invoices
-- remain reconcilable; project identifiers are therefore intentionally not
-- foreign keys to cloud_projects.

CREATE TABLE cloud_ai_team_budgets (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  monthly_limit_microunits BIGINT NOT NULL
    CHECK (monthly_limit_microunits BETWEEN 1 AND 9007199254740991),
  warning_threshold_basis_points INTEGER NOT NULL DEFAULT 8000
    CHECK (warning_threshold_basis_points = 8000),
  hard_cap BOOLEAN NOT NULL DEFAULT TRUE CHECK (hard_cap),
  price_version TEXT NOT NULL
    CHECK (
      length(price_version) BETWEEN 1 AND 64
      AND price_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    ),
  input_microunits_per_million_tokens BIGINT NOT NULL
    CHECK (input_microunits_per_million_tokens BETWEEN 0 AND 9007199254740991),
  output_microunits_per_million_tokens BIGINT NOT NULL
    CHECK (output_microunits_per_million_tokens BETWEEN 0 AND 9007199254740991),
  maximum_concurrent_runs INTEGER NOT NULL
    CHECK (maximum_concurrent_runs BETWEEN 1 AND 10000),
  revision BIGINT NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_by_membership_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  CHECK (
    input_microunits_per_million_tokens > 0
    OR output_microunits_per_million_tokens > 0
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE cloud_ai_project_budgets (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  monthly_limit_microunits BIGINT
    CHECK (
      monthly_limit_microunits IS NULL
      OR monthly_limit_microunits BETWEEN 1 AND 9007199254740991
    ),
  maximum_concurrent_runs INTEGER
    CHECK (
      maximum_concurrent_runs IS NULL
      OR maximum_concurrent_runs BETWEEN 1 AND 10000
    ),
  revision BIGINT NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_by_membership_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, project_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE cloud_ai_team_usage_months (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  period_start DATE NOT NULL CHECK (EXTRACT(DAY FROM period_start) = 1),
  settled_microunits BIGINT NOT NULL DEFAULT 0
    CHECK (settled_microunits BETWEEN 0 AND 9007199254740991),
  reserved_microunits BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_microunits BETWEEN 0 AND 9007199254740991),
  settled_input_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (settled_input_tokens BETWEEN 0 AND 9007199254740991),
  settled_output_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (settled_output_tokens BETWEEN 0 AND 9007199254740991),
  reserved_input_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_input_tokens BETWEEN 0 AND 9007199254740991),
  reserved_output_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_output_tokens BETWEEN 0 AND 9007199254740991),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, period_start),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT
);

CREATE TABLE cloud_ai_project_usage_months (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  period_start DATE NOT NULL CHECK (EXTRACT(DAY FROM period_start) = 1),
  settled_microunits BIGINT NOT NULL DEFAULT 0
    CHECK (settled_microunits BETWEEN 0 AND 9007199254740991),
  reserved_microunits BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_microunits BETWEEN 0 AND 9007199254740991),
  settled_input_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (settled_input_tokens BETWEEN 0 AND 9007199254740991),
  settled_output_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (settled_output_tokens BETWEEN 0 AND 9007199254740991),
  reserved_input_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_input_tokens BETWEEN 0 AND 9007199254740991),
  reserved_output_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_output_tokens BETWEEN 0 AND 9007199254740991),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, project_id, period_start),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT
);

CREATE TABLE cloud_ai_usage_reservations (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  reservation_id UUID NOT NULL UNIQUE,
  membership_id UUID NOT NULL,
  model_identifier TEXT NOT NULL
    CHECK (
      length(model_identifier) BETWEEN 1 AND 128
      AND model_identifier ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    ),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('content_generation', 'read_only_review')),
  price_version TEXT NOT NULL
    CHECK (
      length(price_version) BETWEEN 1 AND 64
      AND price_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    ),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'cancelled', 'expired')),
  reserved_input_tokens BIGINT NOT NULL
    CHECK (reserved_input_tokens BETWEEN 0 AND 9007199254740991),
  reserved_output_tokens BIGINT NOT NULL
    CHECK (reserved_output_tokens BETWEEN 0 AND 9007199254740991),
  reserved_microunits BIGINT NOT NULL
    CHECK (reserved_microunits BETWEEN 0 AND 9007199254740991),
  input_microunits_per_million_tokens BIGINT NOT NULL
    CHECK (input_microunits_per_million_tokens BETWEEN 0 AND 9007199254740991),
  output_microunits_per_million_tokens BIGINT NOT NULL
    CHECK (output_microunits_per_million_tokens BETWEEN 0 AND 9007199254740991),
  settled_input_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (settled_input_tokens BETWEEN 0 AND 9007199254740991),
  settled_output_tokens BIGINT NOT NULL DEFAULT 0
    CHECK (settled_output_tokens BETWEEN 0 AND 9007199254740991),
  settled_microunits BIGINT NOT NULL DEFAULT 0
    CHECK (settled_microunits BETWEEN 0 AND 9007199254740991),
  revision BIGINT NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  request_hash_sha256 CHAR(64) NOT NULL
    CHECK (request_hash_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, team_id, project_id, reservation_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK (settled_input_tokens <= reserved_input_tokens),
  CHECK (settled_output_tokens <= reserved_output_tokens),
  CHECK (settled_microunits <= reserved_microunits),
  CHECK (
    input_microunits_per_million_tokens > 0
    OR output_microunits_per_million_tokens > 0
  ),
  CHECK (
    (
      state = 'active'
      AND settled_at IS NULL
      AND cancelled_at IS NULL
      AND expired_at IS NULL
    )
    OR (
      state = 'settled'
      AND settled_at BETWEEN created_at AND updated_at
      AND cancelled_at IS NULL
      AND expired_at IS NULL
    )
    OR (
      state = 'cancelled'
      AND cancelled_at BETWEEN created_at AND updated_at
      AND settled_at IS NULL
      AND expired_at IS NULL
    )
    OR (
      state = 'expired'
      AND expired_at BETWEEN expires_at AND updated_at
      AND settled_at IS NULL
      AND cancelled_at IS NULL
    )
  )
);

CREATE INDEX cloud_ai_usage_reservations_expiry_idx
  ON cloud_ai_usage_reservations (tenant_id, team_id, expires_at, reservation_id)
  WHERE state = 'active';

CREATE INDEX cloud_ai_usage_reservations_project_idx
  ON cloud_ai_usage_reservations (
    tenant_id,
    team_id,
    project_id,
    created_at DESC,
    reservation_id DESC
  );

CREATE TABLE cloud_ai_usage_idempotency (
  idempotency_key_hash_sha256 CHAR(64) PRIMARY KEY
    CHECK (idempotency_key_hash_sha256 ~ '^[a-f0-9]{64}$'),
  actor_account_id UUID NOT NULL,
  operation_id TEXT NOT NULL
    CHECK (
      operation_id IN (
        'aiBudgets.updateTeam',
        'aiBudgets.updateProject',
        'aiUsage.reserve',
        'aiUsage.settle',
        'aiUsage.cancel'
      )
    ),
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID,
  resource_id UUID NOT NULL,
  request_hash_sha256 CHAR(64) NOT NULL
    CHECK (request_hash_sha256 ~ '^[a-f0-9]{64}$'),
  result_revision BIGINT NOT NULL
    CHECK (result_revision BETWEEN 1 AND 9007199254740991),
  response_digest_sha256 CHAR(64) NOT NULL
    CHECK (response_digest_sha256 ~ '^[a-f0-9]{64}$'),
  response_snapshot JSONB NOT NULL
    CHECK (jsonb_typeof(response_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE INDEX cloud_ai_usage_idempotency_expiry_idx
  ON cloud_ai_usage_idempotency (expires_at, idempotency_key_hash_sha256);

CREATE TABLE cloud_ai_usage_events (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  project_id UUID NOT NULL,
  event_id UUID NOT NULL UNIQUE,
  membership_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  request_id UUID NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('reserved', 'settled', 'cancelled', 'lease_expired')),
  input_tokens BIGINT NOT NULL CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens BIGINT NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  cost_microunits BIGINT NOT NULL
    CHECK (cost_microunits BETWEEN 0 AND 9007199254740991),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_version TEXT NOT NULL
    CHECK (
      length(price_version) BETWEEN 1 AND 64
      AND price_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    ),
  model_identifier TEXT NOT NULL
    CHECK (
      length(model_identifier) BETWEEN 1 AND 128
      AND model_identifier ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    ),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('content_generation', 'read_only_review')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, event_id),
  FOREIGN KEY (tenant_id, team_id)
    REFERENCES cloud_teams(tenant_id, team_id) ON DELETE RESTRICT
);

CREATE INDEX cloud_ai_usage_events_page_idx
  ON cloud_ai_usage_events (
    tenant_id,
    team_id,
    created_at DESC,
    event_id DESC
  );

CREATE INDEX cloud_ai_usage_events_project_page_idx
  ON cloud_ai_usage_events (
    tenant_id,
    team_id,
    project_id,
    created_at DESC,
    event_id DESC
  );

CREATE FUNCTION reject_cloud_ai_usage_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud AI usage history is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_ai_usage_events_append_only
BEFORE UPDATE OR DELETE ON cloud_ai_usage_events
FOR EACH ROW EXECUTE FUNCTION reject_cloud_ai_usage_history_mutation();

REVOKE ALL ON FUNCTION reject_cloud_ai_usage_history_mutation() FROM PUBLIC;

-- Establishes only the team-to-project relationship: any active assignment
-- owned by an active team member attaches the active project to the team.
-- Owner/Admin/Finance actor eligibility and Author/Reviewer own-assignment
-- checks remain authoritative service RBAC. The explicit current scope and
-- membership guard prevents this PUBLIC helper from becoming a cross-scope
-- UUID relationship oracle.
CREATE FUNCTION inkshadow_team_has_active_project_assignment(
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
  SELECT COALESCE(
    requested_tenant_id = public.inkshadow_current_tenant()
    AND requested_team_id = public.inkshadow_current_team()
    AND public.inkshadow_has_active_team_membership(
      requested_tenant_id,
      requested_team_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.cloud_project_assignments AS assignment
      INNER JOIN public.cloud_projects AS project
        ON project.tenant_id = assignment.tenant_id
       AND project.project_id = assignment.project_id
      INNER JOIN public.cloud_team_memberships AS membership
        ON membership.tenant_id = assignment.tenant_id
       AND membership.team_id = assignment.team_id
       AND membership.membership_id = assignment.membership_id
      WHERE assignment.tenant_id = requested_tenant_id
        AND assignment.team_id = requested_team_id
        AND assignment.project_id = requested_project_id
        AND assignment.state = 'active'
        AND membership.state = 'active'
        AND project.state = 'active'
    ),
    FALSE
  )
$$;

REVOKE ALL ON FUNCTION inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)
  TO PUBLIC;

ALTER TABLE cloud_ai_team_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_project_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_team_usage_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_project_usage_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_usage_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_usage_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_ai_team_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_project_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_team_usage_months FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_project_usage_months FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_usage_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_usage_idempotency FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_ai_usage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_ai_team_budgets_scope_isolation
  ON cloud_ai_team_budgets
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

CREATE POLICY cloud_ai_project_budgets_scope_isolation
  ON cloud_ai_project_budgets
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
  );

CREATE POLICY cloud_ai_team_usage_months_scope_isolation
  ON cloud_ai_team_usage_months
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

CREATE POLICY cloud_ai_project_usage_months_scope_isolation
  ON cloud_ai_project_usage_months
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
  );

CREATE POLICY cloud_ai_usage_reservations_scope_isolation
  ON cloud_ai_usage_reservations
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
  );

-- An account may see only its own scoped idempotency metadata. The stored key
-- hash includes operation and team/project scope. The immutable response
-- snapshot contains only the strictly contracted AI budget/usage metadata
-- required to replay a committed response; creative content is never stored.
CREATE POLICY cloud_ai_usage_idempotency_select_own
  ON cloud_ai_usage_idempotency
  FOR SELECT
  USING (
    actor_account_id = inkshadow_current_account()
    AND tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND (
      project_id IS NULL
      OR inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
    )
  )
  ;

CREATE POLICY cloud_ai_usage_idempotency_insert_scope
  ON cloud_ai_usage_idempotency
  FOR INSERT
  WITH CHECK (
    actor_account_id = inkshadow_current_account()
    AND tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND (
      project_id IS NULL
      OR inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
    )
  );

CREATE POLICY cloud_ai_usage_idempotency_delete_expired_own
  ON cloud_ai_usage_idempotency
  FOR DELETE
  USING (
    actor_account_id = inkshadow_current_account()
    AND tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND (
      project_id IS NULL
      OR inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
    )
    AND expires_at <= clock_timestamp()
  );

CREATE POLICY cloud_ai_usage_events_scope_isolation
  ON cloud_ai_usage_events
  USING (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
  )
  WITH CHECK (
    tenant_id = inkshadow_current_tenant()
    AND team_id = inkshadow_current_team()
    AND inkshadow_has_active_team_membership(tenant_id, team_id)
    AND inkshadow_team_has_active_project_assignment(tenant_id, team_id, project_id)
  );
