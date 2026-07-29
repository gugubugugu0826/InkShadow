-- Protocol counters cross JavaScript/JSON boundaries as numbers. PostgreSQL
-- BIGINT accepts values that JavaScript cannot represent exactly, so keep the
-- persisted device sequence inside the shared portable integer range.

ALTER TABLE sync_operations
  ADD CONSTRAINT sync_operations_device_sequence_portable_check
    CHECK (device_sequence <= 9007199254740991);
