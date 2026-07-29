-- Project-key publication receipts remain immutable even after a later
-- rotation or recipient revocation mutates the historical key-set view.
ALTER TABLE project_key_versions
  ADD COLUMN publication_request_sha256 CHAR(64)
    CHECK (
      publication_request_sha256 IS NULL
      OR publication_request_sha256 ~ '^[a-f0-9]{64}$'
    ),
  ADD COLUMN publication_published_at TIMESTAMPTZ,
  ADD CONSTRAINT project_key_publication_receipt_pair_check
    CHECK (
      (publication_request_sha256 IS NULL)
      = (publication_published_at IS NULL)
    );

-- A monotonically increasing epoch detects maintenance changes that can
-- otherwise tear a stateless snapshot across pages without moving the
-- compaction floor.
ALTER TABLE cloud_projects
  ADD COLUMN sync_compaction_epoch BIGINT NOT NULL DEFAULT 0
    CHECK (sync_compaction_epoch >= 0);
