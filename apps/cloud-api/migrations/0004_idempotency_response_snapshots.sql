ALTER TABLE cloud_idempotency_records
  ADD COLUMN response_snapshot JSONB;

ALTER TABLE cloud_idempotency_records
  ADD CONSTRAINT cloud_idempotency_response_snapshot_object_check
  CHECK (
    response_snapshot IS NULL
    OR jsonb_typeof(response_snapshot) = 'object'
  );

ALTER TABLE cloud_idempotency_records
  ADD CONSTRAINT cloud_idempotency_response_snapshot_kind_check
  CHECK (
    response_snapshot IS NULL
    OR result_kind = 'project_key'
  );
