-- Sync protocol v1 delete operations did not identify the deleted object
-- namespace.  Inferring that namespace from an object UUID would make an old
-- tombstone capable of deleting the wrong kind of local record.
--
-- InkShadow has not shipped cloud sync yet, so this is an intentional
-- greenfield cutover: refuse to migrate any non-empty transport ledger.  The
-- operator must quarantine/reset that ciphertext-only ledger and bootstrap a
-- fresh protocol-v2 baseline instead of guessing object types.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sync_operations LIMIT 1)
    OR EXISTS (SELECT 1 FROM sync_ciphertext_chunks LIMIT 1)
    OR EXISTS (SELECT 1 FROM sync_tombstones LIMIT 1)
    OR EXISTS (SELECT 1 FROM sync_tombstone_acknowledgements LIMIT 1)
    OR EXISTS (SELECT 1 FROM cloud_sync_batches LIMIT 1)
  THEN
    RAISE EXCEPTION
      'sync protocol v2 requires an empty ciphertext transport ledger; refusing to infer object types'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE sync_operations
  ADD COLUMN object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

ALTER TABLE sync_tombstones
  ADD COLUMN object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

-- Acknowledgements are object-type specific as well.  Replace the v1 keys
-- only after the empty-ledger guard above has succeeded, so no existing
-- acknowledgement can be ambiguously assigned to a namespace.
ALTER TABLE sync_tombstone_acknowledgements
  DROP CONSTRAINT
    sync_tombstone_acknowledgemen_tenant_id_project_id_object__fkey,
  DROP CONSTRAINT sync_tombstone_acknowledgements_pkey,
  ADD COLUMN object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

ALTER TABLE sync_tombstones
  DROP CONSTRAINT sync_tombstones_pkey,
  ADD CONSTRAINT sync_tombstones_pkey
    PRIMARY KEY (
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation
    );

ALTER TABLE sync_tombstone_acknowledgements
  ADD CONSTRAINT sync_tombstone_acknowledgements_pkey
    PRIMARY KEY (
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation,
      device_id
    ),
  ADD CONSTRAINT sync_tombstone_acknowledgements_typed_tombstone_fk
    FOREIGN KEY (
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation
    )
    REFERENCES sync_tombstones (
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation
    )
    ON DELETE CASCADE;

-- The same protocol-v2 object namespace is used by encrypted chunk AAD.  The
-- foundation migration predates project manifests, so widen that existing
-- constraint without rewriting migration history.
ALTER TABLE sync_ciphertext_chunks
  DROP CONSTRAINT sync_ciphertext_chunks_object_type_check,
  ADD CONSTRAINT sync_ciphertext_chunks_object_type_check
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

-- Keep ciphertext ownership type-safe even if a future caller bypasses the
-- service layer.  The existing operation_id foreign keys remain as the
-- minimal cascade anchors; these additional typed identities bind tenant,
-- project, object namespace and object UUID to the same operation.
ALTER TABLE sync_operations
  ADD CONSTRAINT sync_operations_typed_chunk_identity_unique
    UNIQUE (
      operation_id,
      tenant_id,
      project_id,
      object_type,
      object_id
    ),
  ADD CONSTRAINT sync_operations_typed_tombstone_identity_unique
    UNIQUE (
      operation_id,
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation
    );

ALTER TABLE sync_ciphertext_chunks
  ADD CONSTRAINT sync_chunks_typed_operation_identity_fk
    FOREIGN KEY (
      operation_id,
      tenant_id,
      project_id,
      object_type,
      object_id
    )
    REFERENCES sync_operations (
      operation_id,
      tenant_id,
      project_id,
      object_type,
      object_id
    )
    ON DELETE CASCADE;

ALTER TABLE sync_tombstones
  ADD CONSTRAINT sync_tombstones_typed_operation_identity_fk
    FOREIGN KEY (
      operation_id,
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation
    )
    REFERENCES sync_operations (
      operation_id,
      tenant_id,
      project_id,
      object_type,
      object_id,
      object_generation
    )
    ON DELETE CASCADE;
