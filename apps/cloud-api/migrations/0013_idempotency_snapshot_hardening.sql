-- Exact first-response replay for mutable/deletable cloud resources.
--
-- Session snapshots deliberately omit bearer tokens. The identity service
-- stores only the public grant projection plus the deterministic token
-- generation needed to reconstruct the original (possibly now stale) token
-- pair. Passwords, challenge codes, bearer tokens and private keys remain
-- forbidden from this table.

ALTER TABLE cloud_idempotency_records
  DROP CONSTRAINT cloud_idempotency_response_snapshot_kind_check,
  ADD CONSTRAINT cloud_idempotency_response_snapshot_kind_check
    CHECK (
      response_snapshot IS NULL
      OR result_kind IN (
        'accepted',
        'challenge',
        'deletion_job',
        'device',
        'project_assignment',
        'project_key',
        'review',
        'session',
        'sync_batch',
        'team',
        'team_invitation',
        'team_invitation_acceptance',
        'team_membership',
        'team_project_key_envelope'
      )
    ),
  ADD CONSTRAINT cloud_idempotency_response_snapshot_secret_free_check
    CHECK (
      response_snapshot IS NULL
      OR (
        NOT jsonb_path_exists(response_snapshot, '$.**.accessToken')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.refreshToken')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.password')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.newPassword')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.challengeCode')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.privateKey')
      )
    ),
  ADD CONSTRAINT cloud_idempotency_deletion_snapshot_scope_check
    CHECK (
      result_kind <> 'deletion_job'
      OR response_snapshot IS NULL
      OR (
        (response_snapshot ->> 'snapshotKind' = 'deletion_job_v1') IS TRUE
        AND (jsonb_typeof(response_snapshot -> 'response') = 'object') IS TRUE
        AND (jsonb_typeof(response_snapshot -> 'tenantId') = 'string') IS TRUE
      )
    ),
  ADD CONSTRAINT cloud_idempotency_session_snapshot_secret_free_check
    CHECK (
      result_kind <> 'session'
      OR response_snapshot IS NULL
      OR (
        (response_snapshot ->> 'snapshotKind' = 'session_grant_v1') IS TRUE
        AND (jsonb_typeof(response_snapshot -> 'grant') = 'object') IS TRUE
        AND (jsonb_typeof(response_snapshot -> 'tokenGeneration') = 'number') IS TRUE
        AND NOT jsonb_path_exists(response_snapshot, '$.**.accessToken')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.refreshToken')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.password')
        AND NOT jsonb_path_exists(response_snapshot, '$.**.challengeCode')
      )
    );

-- RLS helpers run with definer rights only to inspect rows hidden by the
-- policy currently being evaluated. They validate the exact transaction-local
-- account/tenant/team scope, and are executable only by the migration/runtime
-- database role unless an explicitly provisioned application role is granted
-- the individual helper it needs.
REVOKE ALL ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_invitation_matches_current_account(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inkshadow_has_active_review_assignment(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_invitation_matches_current_account(TEXT)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION inkshadow_has_active_review_assignment(UUID, UUID, UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION
  inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)
  TO CURRENT_USER;
