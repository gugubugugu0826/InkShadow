PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS community_marketplace_installs (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  version_id TEXT NOT NULL,
  content_digest_sha256 TEXT NOT NULL
    CHECK (
      length(content_digest_sha256) = 64
      AND content_digest_sha256 = lower(content_digest_sha256)
      AND content_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  installed_at TEXT NOT NULL
    CHECK (
      length(installed_at) = 24
      AND installed_at GLOB '????-??-??T??:??:??.???Z'
    ),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json))
    CHECK (length(payload_json) BETWEEN 2 AND 524288)
    CHECK (json_extract(payload_json, '$.artifact.artifactId') = artifact_id)
    CHECK (json_extract(payload_json, '$.version.versionId') = version_id)
    CHECK (
      json_extract(payload_json, '$.version.contentDigestSha256') =
      content_digest_sha256
    )
    CHECK (json_extract(payload_json, '$.installedAt') = installed_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS community_marketplace_installs_installed_at_idx
  ON community_marketplace_installs (installed_at DESC, artifact_id);
