#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${INKSHADOW_BACKUP_DATABASE_URL:?Set the least-privilege PostgreSQL backup URL.}"
: "${INKSHADOW_BACKUP_OUTPUT_DIR:?Set the protected backup output directory.}"
: "${INKSHADOW_BACKUP_AGE_RECIPIENT:?Set the approved age encryption recipient.}"
: "${INKSHADOW_BACKUP_SIGNING_PRIVATE_KEY_FILE:?Set the protected Ed25519 signing private key file.}"

for command_name in age grep openssl pg_dump psql sha256sum stat; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    exit 1
  }
done
if ! [[ "${INKSHADOW_BACKUP_AGE_RECIPIENT}" =~ ^age1[0-9a-z]{58}$ ]]; then
  printf 'The age recipient must be one canonical X25519 recipient.\n' >&2
  exit 1
fi
if [[ ! -f "${INKSHADOW_BACKUP_SIGNING_PRIVATE_KEY_FILE}" ]]; then
  printf 'The backup signing private key is missing.\n' >&2
  exit 1
fi
signing_key_permissions="$(stat -c '%a' -- "${INKSHADOW_BACKUP_SIGNING_PRIVATE_KEY_FILE}")"
if (
  ! [[ "${signing_key_permissions}" =~ ^[0-7]{3,4}$ ]] ||
  (( (8#${signing_key_permissions} & 077) != 0 ))
); then
  printf 'The backup signing private key must not be accessible to group or other users.\n' >&2
  exit 1
fi
if ! openssl pkey \
  -in "${INKSHADOW_BACKUP_SIGNING_PRIVATE_KEY_FILE}" \
  -text_pub \
  -noout 2>/dev/null |
  grep --quiet --extended-regexp '^ED25519 (Private|Public)-Key:'; then
  printf 'The backup signing private key must use Ed25519.\n' >&2
  exit 1
fi

install -d -m 0700 -- "${INKSHADOW_BACKUP_OUTPUT_DIR}"
backup_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="${INKSHADOW_BACKUP_OUTPUT_DIR}/inkshadow-cloud-${backup_timestamp}.dump.age"
metadata_path="${backup_path}.metadata"
checksum_path="${backup_path}.sha256"
signature_path="${checksum_path}.sig"
for published_path in "${backup_path}" "${metadata_path}" "${checksum_path}" "${signature_path}"; do
  if [[ -e "${published_path}" ]]; then
    printf 'Backup output already exists: %s\n' "${published_path}" >&2
    exit 1
  fi
done
temporary_backup="$(mktemp "${INKSHADOW_BACKUP_OUTPUT_DIR}/.inkshadow-backup.XXXXXX")"
temporary_metadata="$(mktemp "${INKSHADOW_BACKUP_OUTPUT_DIR}/.inkshadow-metadata.XXXXXX")"
temporary_checksum="$(mktemp "${INKSHADOW_BACKUP_OUTPUT_DIR}/.inkshadow-checksum.XXXXXX")"
temporary_signature="$(mktemp "${INKSHADOW_BACKUP_OUTPUT_DIR}/.inkshadow-signature.XXXXXX")"
completed=false
cleanup() {
  rm -f -- \
    "${temporary_backup}" \
    "${temporary_metadata}" \
    "${temporary_checksum}" \
    "${temporary_signature}"
  if [[ "${completed}" != true ]]; then
    rm -f -- "${backup_path}" "${metadata_path}" "${checksum_path}" "${signature_path}"
  fi
}
trap cleanup EXIT

export PGDATABASE="${INKSHADOW_BACKUP_DATABASE_URL}"
backup_role_posture="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT rolsuper::int::text || ':' || rolbypassrls::int::text FROM pg_roles WHERE rolname = current_user"
)"
if [[ "${backup_role_posture}" != "0:1" ]]; then
  printf 'Backup refused: use a dedicated NOSUPERUSER, BYPASSRLS logical-backup role.\n' >&2
  exit 1
fi
backup_write_privileges="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT COUNT(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND (has_table_privilege(oid, 'INSERT') OR has_table_privilege(oid, 'UPDATE') OR has_table_privilege(oid, 'DELETE') OR has_table_privilege(oid, 'TRUNCATE') OR has_table_privilege(oid, 'TRIGGER'))"
)"
if [[ "${backup_write_privileges}" != "0" ]]; then
  printf 'Backup refused: the logical-backup role has write privileges.\n' >&2
  exit 1
fi
backup_transport="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT CASE WHEN inet_server_addr() IS NULL OR inet_server_addr() <<= '127.0.0.0/8'::inet OR inet_server_addr() = '::1'::inet THEN 'local' WHEN EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) THEN 'tls' ELSE 'insecure' END"
)"
if [[ "${backup_transport}" == "insecure" ]]; then
  printf 'Backup refused: a remote PostgreSQL source must use TLS.\n' >&2
  exit 1
fi
database_identity="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --field-separator '|' \
    --command "SELECT current_database(), COALESCE(inet_server_addr()::text, 'local'), inet_server_port()"
)"
if [[ -z "${database_identity}" || "${database_identity}" == *$'\n'* ]]; then
  printf 'The source database identity is invalid.\n' >&2
  exit 1
fi
source_database_fingerprint_output="$(printf '%s\n' "${database_identity}" | sha256sum)"
source_database_fingerprint="${source_database_fingerprint_output%% *}"

migration_ledger="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT version::text || ':' || checksum_sha256 FROM cloud_schema_migrations ORDER BY version"
)"
if [[ -z "${migration_ledger}" ]]; then
  printf 'The migration ledger is empty.\n' >&2
  exit 1
fi
schema_version="${migration_ledger##*$'\n'}"
schema_version="${schema_version%%:*}"
if ! [[ "${schema_version}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'The migration ledger returned an invalid schema version.\n' >&2
  exit 1
fi
migration_ledger_hash_output="$(printf '%s\n' "${migration_ledger}" | sha256sum)"
migration_ledger_sha256="${migration_ledger_hash_output%% *}"
forced_rls_table_count="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT COUNT(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'cloud_%' AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity"
)"
if ! [[ "${forced_rls_table_count}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'The source database has no FORCE RLS cloud tables.\n' >&2
  exit 1
fi

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --serializable-deferrable \
  --file=- |
  age --recipient "${INKSHADOW_BACKUP_AGE_RECIPIENT}" --output "${temporary_backup}"

if [[ ! -s "${temporary_backup}" ]]; then
  printf 'The encrypted PostgreSQL backup is empty.\n' >&2
  exit 1
fi
printf 'format=postgres-custom-age-v2\nschema_version=%s\nmigration_ledger_sha256=%s\nforced_rls_table_count=%s\nsource_database_fingerprint_sha256=%s\ncreated_at=%s\n' \
  "${schema_version}" \
  "${migration_ledger_sha256}" \
  "${forced_rls_table_count}" \
  "${source_database_fingerprint}" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${temporary_metadata}"
chmod 0600 \
  "${temporary_backup}" \
  "${temporary_metadata}" \
  "${temporary_checksum}" \
  "${temporary_signature}"

backup_hash_output="$(sha256sum -- "${temporary_backup}")"
metadata_hash_output="$(sha256sum -- "${temporary_metadata}")"
printf '%s  %s\n%s  %s\n' \
  "${backup_hash_output%% *}" \
  "$(basename -- "${backup_path}")" \
  "${metadata_hash_output%% *}" \
  "$(basename -- "${metadata_path}")" >"${temporary_checksum}"
openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "${INKSHADOW_BACKUP_SIGNING_PRIVATE_KEY_FILE}" \
  -in "${temporary_checksum}" \
  -out "${temporary_signature}"
if [[ ! -s "${temporary_signature}" ]]; then
  printf 'The backup authenticity signature is empty.\n' >&2
  exit 1
fi

ln -- "${temporary_backup}" "${backup_path}"
ln -- "${temporary_metadata}" "${metadata_path}"
ln -- "${temporary_checksum}" "${checksum_path}"
ln -- "${temporary_signature}" "${signature_path}"
completed=true

if [[ -n "${INKSHADOW_BACKUP_PROMETHEUS_TEXTFILE:-}" ]]; then
  metric_path="${INKSHADOW_BACKUP_PROMETHEUS_TEXTFILE}"
  metric_directory="$(dirname -- "${metric_path}")"
  install -d -m 0750 -- "${metric_directory}"
  temporary_metric="$(mktemp "${metric_directory}/.inkshadow-backup-metric.XXXXXX")"
  printf '# TYPE inkshadow_backup_last_success_timestamp_seconds gauge\ninkshadow_backup_last_success_timestamp_seconds %s\n' \
    "$(date -u +%s)" >"${temporary_metric}"
  chmod 0640 "${temporary_metric}"
  mv -- "${temporary_metric}" "${metric_path}"
fi

printf 'Encrypted backup created: %s\n' "${backup_path}"
