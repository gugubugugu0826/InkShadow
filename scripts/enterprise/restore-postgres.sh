#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${INKSHADOW_RESTORE_DATABASE_SERVICE:?Set the isolated PostgreSQL libpq service name.}"
: "${INKSHADOW_RESTORE_EXPECTED_DATABASE_NAME:?Set the exact isolated target database name.}"
: "${INKSHADOW_RESTORE_BACKUP_PATH:?Set the encrypted .dump.age backup path.}"
: "${INKSHADOW_RESTORE_AGE_IDENTITY_FILE:?Set the protected age identity file.}"
: "${INKSHADOW_RESTORE_SIGNING_PUBLIC_KEY_FILE:?Set the trusted Ed25519 backup signing public key.}"
: "${INKSHADOW_RESTORE_CONFIRM:?Set to RESTORE_TO_ISOLATED_TARGET after checking the exact target.}"

if [[ "${INKSHADOW_RESTORE_CONFIRM}" != "RESTORE_TO_ISOLATED_TARGET" ]]; then
  printf 'Restore refused: the isolated-target confirmation is missing.\n' >&2
  exit 1
fi
if ! [[ "${INKSHADOW_RESTORE_DATABASE_SERVICE}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
  printf 'Restore refused: the libpq service name is invalid.\n' >&2
  exit 1
fi
for command_name in age grep openssl pg_restore psql sha256sum stat; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    exit 1
  }
done

backup_path="${INKSHADOW_RESTORE_BACKUP_PATH}"
metadata_path="${backup_path}.metadata"
checksum_path="${backup_path}.sha256"
signature_path="${checksum_path}.sig"
for required_path in \
  "${backup_path}" \
  "${metadata_path}" \
  "${checksum_path}" \
  "${signature_path}" \
  "${INKSHADOW_RESTORE_AGE_IDENTITY_FILE}" \
  "${INKSHADOW_RESTORE_SIGNING_PUBLIC_KEY_FILE}"; do
  if [[ ! -f "${required_path}" ]]; then
    printf 'Required restore input is missing: %s\n' "${required_path}" >&2
    exit 1
  fi
done
identity_permissions="$(stat -c '%a' -- "${INKSHADOW_RESTORE_AGE_IDENTITY_FILE}")"
if (
  ! [[ "${identity_permissions}" =~ ^[0-7]{3,4}$ ]] ||
  (( (8#${identity_permissions} & 077) != 0 ))
); then
  printf 'Restore refused: the age identity must not be accessible to group or other users.\n' >&2
  exit 1
fi
if ! openssl pkey \
  -pubin \
  -in "${INKSHADOW_RESTORE_SIGNING_PUBLIC_KEY_FILE}" \
  -text_pub \
  -noout 2>/dev/null |
  grep --quiet --extended-regexp '^ED25519 Public-Key:'; then
  printf 'Restore refused: the trusted backup signing key must use Ed25519.\n' >&2
  exit 1
fi

if ! openssl pkeyutl \
  -verify \
  -rawin \
  -pubin \
  -inkey "${INKSHADOW_RESTORE_SIGNING_PUBLIC_KEY_FILE}" \
  -sigfile "${signature_path}" \
  -in "${checksum_path}" >/dev/null; then
  printf 'Restore refused: backup authenticity signature verification failed.\n' >&2
  exit 1
fi
checksum_directory="$(dirname -- "${checksum_path}")"
checksum_filename="$(basename -- "${checksum_path}")"
(
  cd -- "${checksum_directory}"
  sha256sum --check --strict "${checksum_filename}"
)

declare -A metadata=()
while IFS='=' read -r metadata_key metadata_value; do
  if ! [[ "${metadata_key}" =~ ^[a-z_]+$ ]] || [[ -z "${metadata_value}" ]]; then
    printf 'Backup metadata is malformed.\n' >&2
    exit 1
  fi
  case "${metadata_key}" in
    format | schema_version | migration_ledger_sha256 | forced_rls_table_count | source_database_fingerprint_sha256 | created_at)
      if [[ -n "${metadata[${metadata_key}]+present}" ]]; then
        printf 'Backup metadata contains duplicate fields.\n' >&2
        exit 1
      fi
      metadata["${metadata_key}"]="${metadata_value}"
      ;;
    *)
      printf 'Backup metadata contains an unsupported field.\n' >&2
      exit 1
      ;;
  esac
done <"${metadata_path}"
if (
  [[ "${#metadata[@]}" -ne 6 ]] ||
  [[ "${metadata[format]:-}" != "postgres-custom-age-v2" ]] ||
  ! [[ "${metadata[schema_version]:-}" =~ ^[1-9][0-9]*$ ]] ||
  ! [[ "${metadata[migration_ledger_sha256]:-}" =~ ^[a-f0-9]{64}$ ]] ||
  ! [[ "${metadata[forced_rls_table_count]:-}" =~ ^[1-9][0-9]*$ ]] ||
  ! [[ "${metadata[source_database_fingerprint_sha256]:-}" =~ ^[a-f0-9]{64}$ ]] ||
  ! [[ "${metadata[created_at]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
); then
  printf 'Backup metadata failed strict validation.\n' >&2
  exit 1
fi

restore_started_at="$(date -u +%s)"
export PGSERVICE="${INKSHADOW_RESTORE_DATABASE_SERVICE}"
unset PGDATABASE
actual_database_name="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT current_database()"
)"
if [[ "${actual_database_name}" != "${INKSHADOW_RESTORE_EXPECTED_DATABASE_NAME}" ]]; then
  printf 'Restore refused: the connected database name does not match the explicit target.\n' >&2
  exit 1
fi
target_role_posture="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT rolsuper::int::text || ':' || rolbypassrls::int::text FROM pg_roles WHERE rolname = current_user"
)"
if [[ "${target_role_posture}" != "0:0" ]]; then
  printf 'Restore refused: the target role must be NOSUPERUSER and NOBYPASSRLS.\n' >&2
  exit 1
fi
target_transport="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT CASE WHEN inet_server_addr() IS NULL OR inet_server_addr() <<= '127.0.0.0/8'::inet OR inet_server_addr() = '::1'::inet THEN 'local' WHEN EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) THEN 'tls' ELSE 'insecure' END"
)"
if [[ "${target_transport}" == "insecure" ]]; then
  printf 'Restore refused: a remote PostgreSQL target must use TLS.\n' >&2
  exit 1
fi
other_target_connections="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
)"
if [[ "${other_target_connections}" != "0" ]]; then
  printf 'Restore refused: the isolated target has other active database connections.\n' >&2
  exit 1
fi
target_database_identity="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --field-separator '|' \
    --command "SELECT current_database(), COALESCE(inet_server_addr()::text, 'local'), inet_server_port()"
)"
if [[ -z "${target_database_identity}" || "${target_database_identity}" == *$'\n'* ]]; then
  printf 'Restore refused: the target database identity is invalid.\n' >&2
  exit 1
fi
target_fingerprint_output="$(printf '%s\n' "${target_database_identity}" | sha256sum)"
target_database_fingerprint="${target_fingerprint_output%% *}"
if [[ "${target_database_fingerprint}" == "${metadata[source_database_fingerprint_sha256]}" ]]; then
  printf 'Restore refused: the target matches the signed source database identity.\n' >&2
  exit 1
fi

age --decrypt --identity "${INKSHADOW_RESTORE_AGE_IDENTITY_FILE}" "${backup_path}" |
  pg_restore \
    --clean \
    --if-exists \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges \
    --dbname="service=${INKSHADOW_RESTORE_DATABASE_SERVICE}"

actual_schema_version="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT COALESCE(MAX(version), 0) FROM cloud_schema_migrations"
)"
actual_migration_ledger="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT version::text || ':' || checksum_sha256 FROM cloud_schema_migrations ORDER BY version"
)"
actual_ledger_hash_output="$(printf '%s\n' "${actual_migration_ledger}" | sha256sum)"
actual_ledger_sha256="${actual_ledger_hash_output%% *}"
forced_rls_tables="$(
  psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT COUNT(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'cloud_%' AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity"
)"
if [[ "${actual_schema_version}" != "${metadata[schema_version]}" ]]; then
  printf 'Restore verification failed: migration ledger mismatch.\n' >&2
  exit 1
fi
if [[ "${actual_ledger_sha256}" != "${metadata[migration_ledger_sha256]}" ]]; then
  printf 'Restore verification failed: migration ledger integrity mismatch.\n' >&2
  exit 1
fi
if [[ "${forced_rls_tables}" != "${metadata[forced_rls_table_count]}" ]]; then
  printf 'Restore verification failed: FORCE RLS coverage differs from the signed source.\n' >&2
  exit 1
fi

restore_finished_at="$(date -u +%s)"
restore_duration_seconds="$((restore_finished_at - restore_started_at))"
if [[ -n "${INKSHADOW_RESTORE_PROMETHEUS_TEXTFILE:-}" ]]; then
  metric_path="${INKSHADOW_RESTORE_PROMETHEUS_TEXTFILE}"
  metric_directory="$(dirname -- "${metric_path}")"
  install -d -m 0750 -- "${metric_directory}"
  temporary_metric="$(mktemp "${metric_directory}/.inkshadow-restore-metric.XXXXXX")"
  printf '# TYPE inkshadow_restore_drill_last_success_timestamp_seconds gauge\ninkshadow_restore_drill_last_success_timestamp_seconds %s\n# TYPE inkshadow_restore_drill_duration_seconds gauge\ninkshadow_restore_drill_duration_seconds %s\n' \
    "${restore_finished_at}" "${restore_duration_seconds}" >"${temporary_metric}"
  chmod 0640 "${temporary_metric}"
  mv -- "${temporary_metric}" "${metric_path}"
fi

printf 'Restore verified in %s seconds at schema version %s with %s FORCE RLS tables.\n' \
  "${restore_duration_seconds}" "${actual_schema_version}" "${forced_rls_tables}"
