PRAGMA foreign_keys = ON;

-- Local authoritative receipt for an encrypted team-template application.
-- Template plaintext is applied to the normalized project tables below; the
-- receipt retains only bounded identifiers, revisions and digests needed for
-- idempotency and crash-safe cloud metadata recovery.
CREATE TABLE IF NOT EXISTS team_template_application_receipts (
  application_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(application_id) = 36),
  tenant_id TEXT NOT NULL
    CHECK (length(tenant_id) = 36),
  team_id TEXT NOT NULL
    CHECK (length(team_id) = 36),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE
    CHECK (length(project_id) = 36),
  template_id TEXT NOT NULL
    CHECK (length(template_id) = 36),
  template_revision INTEGER NOT NULL
    CHECK (template_revision BETWEEN 1 AND 9007199254740991),
  version_id TEXT NOT NULL
    CHECK (length(version_id) = 36),
  version_number INTEGER NOT NULL
    CHECK (version_number BETWEEN 1 AND 9007199254740991),
  content_digest TEXT NOT NULL
    CHECK (
      length(content_digest) = 64
      AND content_digest = lower(content_digest)
      AND content_digest NOT GLOB '*[^0-9a-f]*'
    ),
  project_revision_before INTEGER NOT NULL
    CHECK (project_revision_before BETWEEN 1 AND 9007199254740990),
  project_revision_after INTEGER NOT NULL
    CHECK (project_revision_after = project_revision_before + 1),
  cloud_idempotency_key TEXT NOT NULL
    UNIQUE
    CHECK (
      length(cloud_idempotency_key) BETWEEN 16 AND 200
      AND cloud_idempotency_key = trim(cloud_idempotency_key)
      AND instr(cloud_idempotency_key, char(0)) = 0
    ),
  requested_by_membership_id TEXT NOT NULL
    CHECK (length(requested_by_membership_id) = 36),
  applied_at TEXT NOT NULL,
  cloud_recorded_at TEXT,
  UNIQUE (tenant_id, team_id, project_id, template_id, version_id),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) = applied_at
    AND (
      cloud_recorded_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', cloud_recorded_at) = cloud_recorded_at
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS team_template_application_pending_cloud_idx
  ON team_template_application_receipts (applied_at, application_id)
  WHERE cloud_recorded_at IS NULL;

-- All receipt authority fields are immutable. Only the one-way local
-- checkpoint from pending to cloud-recorded is permitted.
CREATE TRIGGER IF NOT EXISTS team_template_application_receipt_immutable
BEFORE UPDATE ON team_template_application_receipts
WHEN
  NEW.application_id <> OLD.application_id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.team_id <> OLD.team_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.template_id <> OLD.template_id
  OR NEW.template_revision <> OLD.template_revision
  OR NEW.version_id <> OLD.version_id
  OR NEW.version_number <> OLD.version_number
  OR NEW.content_digest <> OLD.content_digest
  OR NEW.project_revision_before <> OLD.project_revision_before
  OR NEW.project_revision_after <> OLD.project_revision_after
  OR NEW.cloud_idempotency_key <> OLD.cloud_idempotency_key
  OR NEW.requested_by_membership_id <> OLD.requested_by_membership_id
  OR NEW.applied_at <> OLD.applied_at
  OR OLD.cloud_recorded_at IS NOT NULL
  OR NEW.cloud_recorded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'team-template application receipt is immutable');
END;

CREATE TABLE IF NOT EXISTS project_team_template_settings (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL
    CHECK (
      length(setting_key) BETWEEN 1 AND 64
      AND setting_key GLOB '[A-Za-z]*'
      AND setting_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  value_json TEXT NOT NULL
    CHECK (
      json_valid(value_json)
      AND json_type(value_json) IN ('text', 'integer', 'real', 'true', 'false')
      -- A 16 KiB logical string can expand substantially through JSON
      -- escaping; keep the stored scalar under the template's 256 KiB
      -- canonical plaintext safety boundary.
      AND length(value_json) BETWEEN 1 AND 262144
      AND instr(value_json, char(0)) = 0
    ),
  source_application_id TEXT NOT NULL
    REFERENCES team_template_application_receipts(application_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, setting_key),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at)
);

CREATE TABLE IF NOT EXISTS project_team_template_prompt_refs (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  registry_id TEXT NOT NULL
    CHECK (length(registry_id) = 36),
  registry_revision INTEGER NOT NULL
    CHECK (registry_revision BETWEEN 1 AND 9007199254740991),
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 63),
  source_application_id TEXT NOT NULL
    REFERENCES team_template_application_receipts(application_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, registry_id),
  UNIQUE (project_id, ordinal),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at)
);

CREATE TABLE IF NOT EXISTS project_team_template_prompt_rules (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL
    CHECK (length(rule_id) = 36),
  label TEXT NOT NULL
    CHECK (
      length(trim(label)) BETWEEN 1 AND 160
      AND instr(label, char(0)) = 0
    ),
  instruction TEXT NOT NULL
    CHECK (
      length(trim(instruction)) BETWEEN 1 AND 16384
      AND instr(instruction, char(0)) = 0
    ),
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 63),
  source_application_id TEXT NOT NULL
    REFERENCES team_template_application_receipts(application_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, rule_id),
  UNIQUE (project_id, ordinal),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at)
);

CREATE TABLE IF NOT EXISTS project_team_template_checklist_items (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL
    CHECK (length(item_id) = 36),
  label TEXT NOT NULL
    CHECK (
      length(trim(label)) BETWEEN 1 AND 500
      AND instr(label, char(0)) = 0
    ),
  required INTEGER NOT NULL
    CHECK (required IN (0, 1)),
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 99),
  source_application_id TEXT NOT NULL
    REFERENCES team_template_application_receipts(application_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id),
  UNIQUE (project_id, ordinal),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at)
);
