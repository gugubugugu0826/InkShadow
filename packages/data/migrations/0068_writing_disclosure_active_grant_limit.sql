PRAGMA foreign_keys = ON;

-- Migration 0066 bounded every retained disclosure row. Rotated grants are an
-- audit trail, so terminal rows must not consume the live-authority budget.
-- Keep the same conservative ceiling while applying it only to active grants.
DROP TRIGGER IF EXISTS writing_provider_disclosure_grants_limit;

CREATE TRIGGER writing_provider_disclosure_grants_limit
BEFORE INSERT ON writing_provider_disclosure_grants
WHEN NEW.state = 'active'
  AND (
    SELECT COUNT(*) FROM writing_provider_disclosure_grants WHERE state = 'active'
  ) >= 128
BEGIN
  SELECT RAISE(ABORT, 'WRITING_DISCLOSURE_GRANT_LIMIT_REACHED');
END;
