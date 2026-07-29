import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("logical backup is encrypted in-flight and signed with a dedicated read-only role", async () => {
  const source = await readFile(path.join(directory, "backup-postgres.sh"), "utf8");
  assert.match(source, /pg_dump[\s\S]*--file=-[\s\S]*\|\s*\n\s*age --recipient/u);
  assert.match(source, /backup_role_posture[\s\S]*NOSUPERUSER, BYPASSRLS/u);
  assert.match(source, /backup_write_privileges/u);
  assert.match(source, /postgres-custom-age-v2/u);
  assert.match(source, /migration_ledger_sha256/u);
  assert.match(source, /source_database_fingerprint_sha256/u);
  assert.match(source, /openssl pkeyutl[\s\S]*-sign[\s\S]*-rawin/u);
  assert.doesNotMatch(source, /pg_dump[\s\S]{0,300}--file="\$\{temporary_backup\}"/u);
  assert.doesNotMatch(source, /printf[^\n]*INKSHADOW_BACKUP_DATABASE_URL/u);
});

test("restore authenticates before decryption and refuses source, privileged or active targets", async () => {
  const source = await readFile(path.join(directory, "restore-postgres.sh"), "utf8");
  const verifyOffset = source.indexOf("openssl pkeyutl");
  const decryptOffset = source.indexOf("age --decrypt");
  assert.ok(verifyOffset >= 0 && decryptOffset > verifyOffset);
  assert.match(source, /INKSHADOW_RESTORE_DATABASE_SERVICE/u);
  assert.match(source, /INKSHADOW_RESTORE_EXPECTED_DATABASE_NAME/u);
  assert.match(source, /target_role_posture[\s\S]*NOSUPERUSER and NOBYPASSRLS/u);
  assert.match(source, /other_target_connections/u);
  assert.match(source, /target_database_fingerprint[\s\S]*signed source database identity/u);
  assert.match(source, /migration ledger integrity mismatch/u);
  assert.match(source, /FORCE RLS coverage differs from the signed source/u);
  assert.match(source, /--dbname="service=\$\{INKSHADOW_RESTORE_DATABASE_SERVICE\}"/u);
  assert.doesNotMatch(source, /INKSHADOW_RESTORE_DATABASE_URL/u);
  assert.doesNotMatch(source, /--dbname="\$\{[^}]*URL/u);
});
