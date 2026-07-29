CREATE FUNCTION inkshadow_marketplace_role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('inkshadow.marketplace_role', true), ''), 'member')
$$;

CREATE FUNCTION inkshadow_marketplace_text_is_safe(value_to_check TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT value_to_check !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    AND value_to_check !~* '(<[[:space:]]*/?[[:space:]]*(script|iframe|object|embed|link|meta)([[:space:]>])|(^|[^[:alnum:]_])(javascript|data|file|vbscript|https?|ftp|mailto|tel):|\\\\|on(abort|blur|change|click|error|focus|input|key|load|mouse|pointer|submit|touch|wheel)[[:space:]]*=)'
$$;

CREATE FUNCTION inkshadow_marketplace_json_is_data_only(value_to_check JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  entry RECORD;
BEGIN
  CASE jsonb_typeof(value_to_check)
    WHEN 'null', 'boolean', 'number' THEN
      RETURN TRUE;
    WHEN 'string' THEN
      RETURN inkshadow_marketplace_text_is_safe(value_to_check #>> '{}');
    WHEN 'array' THEN
      FOR entry IN SELECT value FROM jsonb_array_elements(value_to_check) AS item(value)
      LOOP
        IF NOT inkshadow_marketplace_json_is_data_only(entry.value) THEN
          RETURN FALSE;
        END IF;
      END LOOP;
      RETURN TRUE;
    WHEN 'object' THEN
      FOR entry IN SELECT key, value FROM jsonb_each(value_to_check)
      LOOP
        IF lower(entry.key) IN (
          '__proto__',
          'attachment',
          'command',
          'constructor',
          'externalurl',
          'href',
          'html',
          'import',
          'macro',
          'plugin',
          'prototype',
          'script',
          'src',
          'url'
        ) OR NOT inkshadow_marketplace_json_is_data_only(entry.value) THEN
          RETURN FALSE;
        END IF;
      END LOOP;
      RETURN TRUE;
    ELSE
      RETURN FALSE;
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION inkshadow_marketplace_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_marketplace_text_is_safe(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_marketplace_json_is_data_only(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_marketplace_role() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_marketplace_text_is_safe(TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_marketplace_json_is_data_only(JSONB) TO CURRENT_USER;

CREATE TABLE cloud_marketplace_artifacts (
  artifact_id UUID PRIMARY KEY,
  author_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  author_display_name TEXT NOT NULL
    CHECK (
      length(author_display_name) BETWEEN 1 AND 200
      AND inkshadow_marketplace_text_is_safe(author_display_name)
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('story_template', 'style_template', 'world_template')),
  title TEXT NOT NULL
    CHECK (length(title) BETWEEN 1 AND 200 AND inkshadow_marketplace_text_is_safe(title)),
  summary TEXT NOT NULL
    CHECK (length(summary) BETWEEN 1 AND 1000 AND inkshadow_marketplace_text_is_safe(summary)),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    CHECK (
      inkshadow_is_sorted_unique_text_array(tags, 16)
      AND inkshadow_all_text_array_values_match(
        tags,
        '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$',
        32,
        FALSE
      )
    ),
  license TEXT NOT NULL
    CHECK (
      license IN (
        'cc0-1.0',
        'cc-by-4.0',
        'cc-by-sa-4.0',
        'inkshadow-community-free-1.0'
      )
    ),
  state TEXT NOT NULL
    CHECK (
      state IN (
        'pending_review',
        'published',
        'quarantined',
        'author_withdrawn',
        'rejected',
        'appeal_pending'
      )
    ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  latest_version_number INTEGER NOT NULL CHECK (latest_version_number > 0),
  pending_version_id UUID,
  published_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  CHECK (updated_at >= created_at),
  CHECK (published_at IS NULL OR published_at >= created_at),
  CHECK ((state = 'quarantined') = (quarantined_at IS NOT NULL)),
  CHECK ((state = 'author_withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK (
    state NOT IN ('quarantined', 'author_withdrawn', 'rejected', 'appeal_pending')
    OR retention_until IS NOT NULL
  ),
  CHECK (retention_until IS NULL OR retention_until >= updated_at),
  CHECK (state <> 'published' OR published_version_id IS NOT NULL),
  CHECK (
    state <> 'pending_review'
    OR pending_version_id IS NOT NULL
    OR published_version_id IS NOT NULL
  )
);

CREATE TABLE cloud_marketplace_versions (
  artifact_id UUID NOT NULL REFERENCES cloud_marketplace_artifacts(artifact_id) ON DELETE RESTRICT,
  version_id UUID NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  semantic_version TEXT NOT NULL
    CHECK (
      semantic_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
    ),
  author_display_name TEXT NOT NULL
    CHECK (
      length(author_display_name) BETWEEN 1 AND 200
      AND inkshadow_marketplace_text_is_safe(author_display_name)
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('story_template', 'style_template', 'world_template')),
  title TEXT NOT NULL
    CHECK (length(title) BETWEEN 1 AND 200 AND inkshadow_marketplace_text_is_safe(title)),
  summary TEXT NOT NULL
    CHECK (length(summary) BETWEEN 1 AND 1000 AND inkshadow_marketplace_text_is_safe(summary)),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    CHECK (
      inkshadow_is_sorted_unique_text_array(tags, 16)
      AND inkshadow_all_text_array_values_match(
        tags,
        '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$',
        32,
        FALSE
      )
    ),
  license TEXT NOT NULL
    CHECK (
      license IN (
        'cc0-1.0',
        'cc-by-4.0',
        'cc-by-sa-4.0',
        'inkshadow-community-free-1.0'
      )
    ),
  state TEXT NOT NULL
    CHECK (
      state IN (
        'pending_review',
        'published',
        'superseded',
        'quarantined',
        'author_withdrawn',
        'rejected',
        'appeal_pending'
      )
    ),
  content_digest_sha256 CHAR(64) NOT NULL
    CHECK (content_digest_sha256 ~ '^[a-f0-9]{64}$'),
  author_signing_key_fingerprint_sha256 CHAR(64) NOT NULL
    CHECK (author_signing_key_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 262144),
  created_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  PRIMARY KEY (artifact_id, version_id),
  UNIQUE (version_id),
  UNIQUE (artifact_id, version_number),
  UNIQUE (artifact_id, semantic_version),
  CHECK (submitted_at >= created_at),
  CHECK (reviewed_at IS NULL OR reviewed_at >= submitted_at),
  CHECK (published_at IS NULL OR published_at >= submitted_at),
  CHECK ((state = 'quarantined') = (quarantined_at IS NOT NULL)),
  CHECK ((state = 'author_withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK (state NOT IN ('published', 'superseded') OR published_at IS NOT NULL),
  CHECK (state NOT IN ('pending_review', 'rejected') OR published_at IS NULL),
  CHECK (
    state NOT IN ('quarantined', 'author_withdrawn', 'rejected', 'appeal_pending')
    OR retention_until IS NOT NULL
  ),
  CHECK (retention_until IS NULL OR retention_until >= submitted_at)
);

ALTER TABLE cloud_marketplace_artifacts
  ADD CONSTRAINT cloud_marketplace_artifacts_pending_version_fk
    FOREIGN KEY (artifact_id, pending_version_id)
    REFERENCES cloud_marketplace_versions(artifact_id, version_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT cloud_marketplace_artifacts_published_version_fk
    FOREIGN KEY (artifact_id, published_version_id)
    REFERENCES cloud_marketplace_versions(artifact_id, version_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cloud_marketplace_version_bodies (
  artifact_id UUID NOT NULL,
  version_id UUID NOT NULL,
  content JSONB NOT NULL
    CHECK (
      jsonb_typeof(content) = 'object'
      AND content ->> 'format' = 'inkshadow.marketplace.structured-artifact.v1'
      AND inkshadow_marketplace_json_is_data_only(content)
      AND octet_length(content::TEXT) <= 262144
    ),
  author_public_key_spki TEXT NOT NULL
    CHECK (length(author_public_key_spki) BETWEEN 40 AND 256)
    CHECK (author_public_key_spki ~ '^[A-Za-z0-9_-]+$'),
  author_signature TEXT NOT NULL
    CHECK (length(author_signature) BETWEEN 80 AND 128)
    CHECK (author_signature ~ '^[A-Za-z0-9_-]+$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (artifact_id, version_id),
  FOREIGN KEY (artifact_id, version_id)
    REFERENCES cloud_marketplace_versions(artifact_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE cloud_marketplace_reports (
  report_id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL,
  version_id UUID NOT NULL,
  reporter_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  category TEXT NOT NULL
    CHECK (
      category IN (
        'copyright',
        'malware_or_executable_content',
        'misleading_metadata',
        'privacy',
        'prohibited_content',
        'other'
      )
    ),
  reason TEXT NOT NULL
    CHECK (
      length(reason) BETWEEN 12 AND 2000
      AND inkshadow_marketplace_text_is_safe(reason)
    ),
  state TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'upheld')),
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (artifact_id, version_id)
    REFERENCES cloud_marketplace_versions(artifact_id, version_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'open' AND resolved_at IS NULL)
    OR (state <> 'open' AND resolved_at IS NOT NULL)
  ),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CHECK (retention_until >= created_at + INTERVAL '90 days')
);

CREATE UNIQUE INDEX cloud_marketplace_reports_open_reporter_idx
  ON cloud_marketplace_reports (artifact_id, version_id, reporter_account_id)
  WHERE state = 'open';

CREATE INDEX cloud_marketplace_reports_open_queue_idx
  ON cloud_marketplace_reports (created_at DESC, report_id DESC)
  WHERE state = 'open';

CREATE TABLE cloud_marketplace_appeals (
  appeal_id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL,
  version_id UUID NOT NULL,
  author_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  source_state TEXT NOT NULL CHECK (source_state IN ('quarantined', 'rejected')),
  reason TEXT NOT NULL
    CHECK (
      length(reason) BETWEEN 12 AND 2000
      AND inkshadow_marketplace_text_is_safe(reason)
    ),
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'denied')),
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (artifact_id, version_id)
    REFERENCES cloud_marketplace_versions(artifact_id, version_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'open' AND resolved_at IS NULL)
    OR (state <> 'open' AND resolved_at IS NOT NULL)
  ),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CHECK (retention_until >= created_at + INTERVAL '90 days')
);

CREATE UNIQUE INDEX cloud_marketplace_appeals_open_version_idx
  ON cloud_marketplace_appeals (artifact_id, version_id)
  WHERE state = 'open';

CREATE TABLE cloud_marketplace_idempotency (
  scope_hash_sha256 CHAR(64) PRIMARY KEY CHECK (scope_hash_sha256 ~ '^[a-f0-9]{64}$'),
  actor_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 100),
  request_hash_sha256 CHAR(64) NOT NULL CHECK (request_hash_sha256 ~ '^[a-f0-9]{64}$'),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_snapshot JSONB NOT NULL,
  result_digest_sha256 CHAR(64) NOT NULL CHECK (result_digest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX cloud_marketplace_idempotency_expiry_idx
  ON cloud_marketplace_idempotency (expires_at);

CREATE TABLE cloud_marketplace_moderation_events (
  event_id UUID PRIMARY KEY,
  actor_account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL,
  version_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  reason TEXT NOT NULL
    CHECK (
      length(reason) BETWEEN 12 AND 2000
      AND inkshadow_marketplace_text_is_safe(reason)
    ),
  confirmation_sha256 CHAR(64) NOT NULL CHECK (confirmation_sha256 ~ '^[a-f0-9]{64}$'),
  result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'failed')),
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  CHECK (retention_until >= created_at + INTERVAL '365 days')
);

CREATE INDEX cloud_marketplace_moderation_events_page_idx
  ON cloud_marketplace_moderation_events (created_at DESC, event_id DESC);

CREATE TABLE cloud_marketplace_download_audits (
  download_audit_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL,
  version_id UUID NOT NULL,
  content_digest_sha256 CHAR(64) NOT NULL
    CHECK (content_digest_sha256 ~ '^[a-f0-9]{64}$'),
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (artifact_id, version_id)
    REFERENCES cloud_marketplace_versions(artifact_id, version_id) ON DELETE RESTRICT,
  CHECK (retention_until >= created_at + INTERVAL '90 days')
);

CREATE INDEX cloud_marketplace_download_audits_retention_idx
  ON cloud_marketplace_download_audits (retention_until, download_audit_id);

CREATE INDEX cloud_marketplace_catalog_idx
  ON cloud_marketplace_artifacts (updated_at DESC, artifact_id DESC)
  WHERE state = 'published';

CREATE INDEX cloud_marketplace_versions_queue_idx
  ON cloud_marketplace_versions (submitted_at DESC, version_id DESC)
  WHERE state IN ('pending_review', 'quarantined', 'appeal_pending');

CREATE FUNCTION reject_cloud_marketplace_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'marketplace audit records are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_marketplace_moderation_events_append_only
BEFORE UPDATE OR DELETE ON cloud_marketplace_moderation_events
FOR EACH ROW EXECUTE FUNCTION reject_cloud_marketplace_append_only_mutation();

CREATE TRIGGER cloud_marketplace_download_audits_append_only
BEFORE UPDATE OR DELETE ON cloud_marketplace_download_audits
FOR EACH ROW EXECUTE FUNCTION reject_cloud_marketplace_append_only_mutation();

CREATE FUNCTION inkshadow_marketplace_is_author(requested_artifact_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.cloud_marketplace_artifacts
    WHERE artifact_id = requested_artifact_id
      AND author_account_id = public.inkshadow_current_account()
  )
$$;

CREATE FUNCTION inkshadow_marketplace_is_public_version(
  requested_artifact_id UUID,
  requested_version_id UUID
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
    FROM public.cloud_marketplace_artifacts AS artifact
    JOIN public.cloud_marketplace_versions AS version
      ON version.artifact_id = artifact.artifact_id
     AND version.version_id = requested_version_id
    WHERE artifact.artifact_id = requested_artifact_id
      AND artifact.state = 'published'
      AND artifact.published_version_id = requested_version_id
      AND version.state = 'published'
  )
$$;

REVOKE ALL ON FUNCTION inkshadow_marketplace_is_author(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_marketplace_is_public_version(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inkshadow_marketplace_is_author(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_marketplace_is_public_version(UUID, UUID) TO CURRENT_USER;

ALTER TABLE cloud_marketplace_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_version_bodies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_moderation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_download_audits ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_marketplace_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_version_bodies FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_appeals FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_idempotency FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_moderation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_marketplace_download_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_marketplace_artifacts_read
  ON cloud_marketplace_artifacts
  FOR SELECT
  USING (
    inkshadow_current_account() IS NOT NULL
    AND (
      author_account_id = inkshadow_current_account()
      OR state = 'published'
      OR inkshadow_marketplace_role() = 'platform_ops'
    )
  );

CREATE POLICY cloud_marketplace_artifacts_insert
  ON cloud_marketplace_artifacts
  FOR INSERT
  WITH CHECK (author_account_id = inkshadow_current_account());

CREATE POLICY cloud_marketplace_artifacts_update
  ON cloud_marketplace_artifacts
  FOR UPDATE
  USING (
    author_account_id = inkshadow_current_account()
    OR inkshadow_marketplace_role() = 'platform_ops'
  )
  WITH CHECK (
    author_account_id = inkshadow_current_account()
    OR inkshadow_marketplace_role() = 'platform_ops'
  );

CREATE POLICY cloud_marketplace_versions_read
  ON cloud_marketplace_versions
  FOR SELECT
  USING (
    inkshadow_marketplace_is_author(artifact_id)
    OR inkshadow_marketplace_is_public_version(artifact_id, version_id)
    OR inkshadow_marketplace_role() = 'platform_ops'
  );

CREATE POLICY cloud_marketplace_versions_insert
  ON cloud_marketplace_versions
  FOR INSERT
  WITH CHECK (inkshadow_marketplace_is_author(artifact_id));

CREATE POLICY cloud_marketplace_versions_update
  ON cloud_marketplace_versions
  FOR UPDATE
  USING (
    inkshadow_marketplace_is_author(artifact_id)
    OR inkshadow_marketplace_role() = 'platform_ops'
  )
  WITH CHECK (
    inkshadow_marketplace_is_author(artifact_id)
    OR inkshadow_marketplace_role() = 'platform_ops'
  );

CREATE POLICY cloud_marketplace_version_bodies_read
  ON cloud_marketplace_version_bodies
  FOR SELECT
  USING (
    inkshadow_marketplace_role() <> 'platform_ops'
    AND (
      inkshadow_marketplace_is_author(artifact_id)
      OR inkshadow_marketplace_is_public_version(artifact_id, version_id)
    )
  );

CREATE POLICY cloud_marketplace_version_bodies_insert
  ON cloud_marketplace_version_bodies
  FOR INSERT
  WITH CHECK (
    inkshadow_marketplace_role() <> 'platform_ops'
    AND inkshadow_marketplace_is_author(artifact_id)
  );

CREATE POLICY cloud_marketplace_reports_read
  ON cloud_marketplace_reports
  FOR SELECT
  USING (
    reporter_account_id = inkshadow_current_account()
    OR inkshadow_marketplace_is_author(artifact_id)
    OR inkshadow_marketplace_role() = 'platform_ops'
  );

CREATE POLICY cloud_marketplace_reports_insert
  ON cloud_marketplace_reports
  FOR INSERT
  WITH CHECK (reporter_account_id = inkshadow_current_account());

CREATE POLICY cloud_marketplace_reports_update
  ON cloud_marketplace_reports
  FOR UPDATE
  USING (inkshadow_marketplace_role() = 'platform_ops')
  WITH CHECK (inkshadow_marketplace_role() = 'platform_ops');

CREATE POLICY cloud_marketplace_appeals_read
  ON cloud_marketplace_appeals
  FOR SELECT
  USING (
    author_account_id = inkshadow_current_account()
    OR inkshadow_marketplace_role() = 'platform_ops'
  );

CREATE POLICY cloud_marketplace_appeals_insert
  ON cloud_marketplace_appeals
  FOR INSERT
  WITH CHECK (author_account_id = inkshadow_current_account());

CREATE POLICY cloud_marketplace_appeals_update
  ON cloud_marketplace_appeals
  FOR UPDATE
  USING (inkshadow_marketplace_role() = 'platform_ops')
  WITH CHECK (inkshadow_marketplace_role() = 'platform_ops');

CREATE POLICY cloud_marketplace_idempotency_scope
  ON cloud_marketplace_idempotency
  USING (actor_account_id = inkshadow_current_account())
  WITH CHECK (actor_account_id = inkshadow_current_account());

CREATE POLICY cloud_marketplace_moderation_events_read
  ON cloud_marketplace_moderation_events
  FOR SELECT
  USING (inkshadow_marketplace_role() = 'platform_ops');

CREATE POLICY cloud_marketplace_moderation_events_insert
  ON cloud_marketplace_moderation_events
  FOR INSERT
  WITH CHECK (actor_account_id = inkshadow_current_account());

CREATE POLICY cloud_marketplace_download_audits_read
  ON cloud_marketplace_download_audits
  FOR SELECT
  USING (
    account_id = inkshadow_current_account()
    OR inkshadow_marketplace_role() = 'platform_ops'
  );

CREATE POLICY cloud_marketplace_download_audits_insert
  ON cloud_marketplace_download_audits
  FOR INSERT
  WITH CHECK (
    account_id = inkshadow_current_account()
    AND inkshadow_marketplace_role() <> 'platform_ops'
  );
