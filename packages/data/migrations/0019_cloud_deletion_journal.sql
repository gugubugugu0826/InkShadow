CREATE TABLE IF NOT EXISTS cloud_deletion_journals (
  journal_id TEXT PRIMARY KEY
    CHECK (
      length(journal_id) = 36
      AND substr(journal_id, 15, 1) = '7'
      AND lower(journal_id) = journal_id
    ),
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('project', 'account')),
  target_id TEXT NOT NULL
    CHECK (
      length(target_id) = 36
      AND substr(target_id, 15, 1) = '7'
      AND lower(target_id) = target_id
    ),
  account_email TEXT,
  active_mutation_id TEXT
    CHECK (
      active_mutation_id IS NULL
      OR (
        length(active_mutation_id) = 36
        AND substr(active_mutation_id, 15, 1) = '7'
        AND lower(active_mutation_id) = active_mutation_id
      )
    ),
  deletion_request_id TEXT
    CHECK (
      deletion_request_id IS NULL
      OR (
        length(deletion_request_id) = 36
        AND substr(deletion_request_id, 15, 1) = '7'
        AND lower(deletion_request_id) = deletion_request_id
      )
    ),
  latest_request_id TEXT
    CHECK (
      latest_request_id IS NULL
      OR (
        length(latest_request_id) = 36
        AND substr(latest_request_id, 15, 1) = '7'
        AND lower(latest_request_id) = latest_request_id
      )
    ),
  latest_revision INTEGER
    CHECK (latest_revision IS NULL OR latest_revision >= 1),
  latest_receipt_json TEXT,
  recovery_action TEXT NOT NULL
    CHECK (
      recovery_action IN (
        'submit',
        'lookup',
        'refresh',
        'cancel',
        'none'
      )
    ),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 3 AND 80
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  UNIQUE (target_kind, target_id),
  CHECK (
    (target_kind = 'project' AND account_email IS NULL)
    OR (
      target_kind = 'account'
      AND account_email IS NOT NULL
      AND length(account_email) BETWEEN 3 AND 320
      AND lower(account_email) = account_email
    )
  ),
  CHECK (
    (latest_receipt_json IS NULL AND latest_request_id IS NULL AND latest_revision IS NULL)
    OR (
      latest_receipt_json IS NOT NULL
      AND latest_request_id IS NOT NULL
      AND latest_revision IS NOT NULL
      AND deletion_request_id IS NOT NULL
    )
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS cloud_deletion_mutations (
  mutation_id TEXT PRIMARY KEY
    CHECK (
      length(mutation_id) = 36
      AND substr(mutation_id, 15, 1) = '7'
      AND lower(mutation_id) = mutation_id
    ),
  journal_id TEXT NOT NULL,
  request_type TEXT NOT NULL
    CHECK (request_type IN ('submission', 'cancellation')),
  confirmation_id TEXT
    CHECK (
      confirmation_id IS NULL
      OR (
        length(confirmation_id) = 36
        AND substr(confirmation_id, 15, 1) = '7'
        AND lower(confirmation_id) = confirmation_id
      )
    ),
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^-A-Za-z0-9._~]*'
    ),
  expected_revision INTEGER NOT NULL
    CHECK (expected_revision >= 1),
  request_body_sha256 TEXT NOT NULL
    CHECK (
      length(request_body_sha256) = 64
      AND lower(request_body_sha256) = request_body_sha256
      AND request_body_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL
    CHECK (state IN ('prepared', 'accepted', 'retryable_error', 'terminal_error')),
  response_request_id TEXT
    CHECK (
      response_request_id IS NULL
      OR (
        length(response_request_id) = 36
        AND substr(response_request_id, 15, 1) = '7'
        AND lower(response_request_id) = response_request_id
      )
    ),
  response_revision INTEGER
    CHECK (response_revision IS NULL OR response_revision >= 1),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 3 AND 80
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  FOREIGN KEY (journal_id)
    REFERENCES cloud_deletion_journals(journal_id)
    ON DELETE RESTRICT,
  UNIQUE (journal_id, idempotency_key),
  CHECK (
    (request_type = 'submission' AND confirmation_id IS NOT NULL)
    OR (request_type = 'cancellation' AND confirmation_id IS NULL)
  ),
  CHECK (
    (state = 'accepted' AND response_request_id IS NOT NULL AND response_revision IS NOT NULL)
    OR (
      state <> 'accepted'
      AND response_request_id IS NULL
      AND response_revision IS NULL
    )
  ),
  CHECK (
    (state IN ('retryable_error', 'terminal_error') AND last_error_code IS NOT NULL)
    OR (state IN ('prepared', 'accepted') AND last_error_code IS NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS cloud_deletion_journals_recovery_idx
  ON cloud_deletion_journals(recovery_action, updated_at, journal_id);

CREATE INDEX IF NOT EXISTS cloud_deletion_mutations_journal_idx
  ON cloud_deletion_mutations(journal_id, created_at, mutation_id);
