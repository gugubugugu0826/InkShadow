-- Human-readable local device names for the E2EE setup flow.
--
-- This value is non-secret metadata. Private keys remain in the OS credential
-- store and recovery codes are never persisted.

PRAGMA foreign_keys = ON;

ALTER TABLE device_public_key_records
  ADD COLUMN display_name TEXT NOT NULL DEFAULT '此设备'
    CHECK (
      length(trim(display_name)) BETWEEN 1 AND 80
      AND display_name = trim(display_name)
    );
