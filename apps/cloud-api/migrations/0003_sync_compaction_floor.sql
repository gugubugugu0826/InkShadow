-- Once acknowledged deleted-object ciphertext is physically removed, cursors
-- older than the corresponding delete operation must fail closed instead of
-- receiving an incomplete operation page.

ALTER TABLE cloud_projects
  ADD COLUMN minimum_available_remote_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (minimum_available_remote_sequence >= 0);
