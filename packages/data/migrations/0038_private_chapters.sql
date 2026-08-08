-- Chapter-level privacy is independent from immutable正文 version sequencing.
-- Existing databases remain standard/cloud-eligible. A local-only transition
-- closes every unacknowledged chapter transport path in the same transaction.

ALTER TABLE chapters
  ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (privacy_mode IN ('standard', 'local_only'));

ALTER TABLE chapters
  ADD COLUMN privacy_revision INTEGER NOT NULL DEFAULT 1
    CHECK (privacy_revision BETWEEN 1 AND 9007199254740991);

CREATE INDEX IF NOT EXISTS chapters_project_privacy_idx
  ON chapters (project_id, privacy_mode, status, created_at, id);

-- Defense in depth: repository filtering is the normal path, while these
-- guards make a future direct queue writer fail before any private正文 enters
-- the projection/encryption/upload pipeline.
CREATE TRIGGER IF NOT EXISTS private_chapter_projection_insert_guard
BEFORE INSERT ON sync_projection_jobs
WHEN NEW.object_type = 'chapter_version'
  AND NEW.projection_kind = 'upsert'
  AND EXISTS (
    SELECT 1
    FROM chapters AS chapter
    WHERE chapter.id = NEW.object_id
      AND chapter.project_id = NEW.project_id
      AND chapter.privacy_mode = 'local_only'
  )
BEGIN
  SELECT RAISE(ABORT, 'local-only chapter cannot enter cloud projection');
END;

CREATE TRIGGER IF NOT EXISTS private_chapter_outbox_insert_guard
BEFORE INSERT ON sync_outbox_operations
WHEN NEW.object_type = 'chapter_version'
  AND NEW.kind = 'upsert'
  AND EXISTS (
    SELECT 1
    FROM chapters AS chapter
    WHERE chapter.id = NEW.object_id
      AND chapter.project_id = NEW.project_id
      AND chapter.privacy_mode = 'local_only'
  )
BEGIN
  SELECT RAISE(ABORT, 'local-only chapter cannot enter cloud outbox');
END;

CREATE TRIGGER IF NOT EXISTS private_chapter_ciphertext_insert_guard
BEFORE INSERT ON sync_ciphertext_chunks
WHEN NEW.object_type = 'chapter_version'
  AND EXISTS (
    SELECT 1
    FROM chapters AS chapter
    WHERE chapter.id = NEW.object_id
      AND chapter.project_id = NEW.project_id
      AND chapter.privacy_mode = 'local_only'
  )
BEGIN
  SELECT RAISE(ABORT, 'local-only chapter cannot be encrypted for cloud transport');
END;

CREATE TRIGGER IF NOT EXISTS private_chapter_transport_cleanup
AFTER UPDATE OF privacy_mode ON chapters
WHEN OLD.privacy_mode <> 'local_only' AND NEW.privacy_mode = 'local_only'
BEGIN
  UPDATE sync_projection_jobs
  SET
    status = 'failed',
    attempt = CASE WHEN attempt < 1 THEN 1 ELSE attempt END,
    revision = revision + 1,
    next_attempt_at = NULL,
    lease_owner_id = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    operation_id = NULL,
    failure_code = 'PRIVATE_CHAPTER_LOCAL_ONLY',
    superseded_by_job_id = NULL,
    updated_at = NEW.updated_at,
    terminal_at = NEW.updated_at
  WHERE project_id = NEW.project_id
    AND object_type = 'chapter_version'
    AND object_id = NEW.id
    AND projection_kind = 'upsert'
    AND status IN ('queued', 'leased', 'retry_wait');

  -- A completed projection only means ciphertext reached the local outbox.
  -- If it has not been acknowledged by the cloud, revoke that binding too.
  UPDATE sync_projection_jobs
  SET
    status = 'failed',
    revision = revision + 1,
    operation_id = NULL,
    failure_code = 'PRIVATE_CHAPTER_LOCAL_ONLY',
    updated_at = NEW.updated_at,
    terminal_at = NEW.updated_at
  WHERE project_id = NEW.project_id
    AND object_type = 'chapter_version'
    AND object_id = NEW.id
    AND projection_kind = 'upsert'
    AND status = 'completed'
    AND operation_id IN (
      SELECT operation_id
      FROM sync_outbox_operations
      WHERE project_id = NEW.project_id
        AND object_type = 'chapter_version'
        AND object_id = NEW.id
        AND kind = 'upsert'
        AND status <> 'acknowledged'
    );

  DELETE FROM sync_operation_chunks
  WHERE operation_id IN (
    SELECT operation_id
    FROM sync_outbox_operations
    WHERE project_id = NEW.project_id
      AND object_type = 'chapter_version'
      AND object_id = NEW.id
      AND kind = 'upsert'
      AND status <> 'acknowledged'
  );

  DELETE FROM sync_outbox_operations
  WHERE project_id = NEW.project_id
    AND object_type = 'chapter_version'
    AND object_id = NEW.id
    AND kind = 'upsert'
    AND status <> 'acknowledged';

  -- Stop local transfer bookkeeping that has not reached a completed state.
  -- Removing a transfer cascades its chunk links before unreferenced ciphertext
  -- is reclaimed below.
  DELETE FROM sync_transfers
  WHERE project_id = NEW.project_id
    AND object_id = NEW.id
    AND status <> 'completed';

  DELETE FROM sync_ciphertext_chunks
  WHERE project_id = NEW.project_id
    AND object_type = 'chapter_version'
    AND object_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM sync_operation_chunks AS link
      WHERE link.chunk_id = sync_ciphertext_chunks.chunk_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM sync_inbox_operation_chunks AS link
      WHERE link.chunk_id = sync_ciphertext_chunks.chunk_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM sync_transfer_chunks AS link
      WHERE link.chunk_id = sync_ciphertext_chunks.chunk_id
    );
END;
