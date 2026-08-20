import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = readFileSync(
  new URL("../migrations/0066_writing_experience_preferences.sql", import.meta.url),
  "utf8",
);
const activeGrantLimitMigration = readFileSync(
  new URL("../migrations/0068_writing_disclosure_active_grant_limit.sql", import.meta.url),
  "utf8",
);

const NOW = "2026-08-18T00:00:00.000Z";

describe("writing experience preference migration", () => {
  it("creates restart-safe content-free authorities without choosing a mode during migration", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await executor.execute(migration);

    await expect(executor.select("SELECT * FROM writing_experience_preferences")).resolves.toEqual(
      [],
    );
    const preferenceColumns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('writing_experience_preferences') ORDER BY cid",
    );
    expect(preferenceColumns.map(({ name }) => name)).toContain(
      "direct_local_organization_authorized_at",
    );
    const columns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('writing_provider_disclosure_grants') ORDER BY cid",
    );
    expect(columns.map(({ name }) => name)).toEqual([
      "fingerprint",
      "task",
      "provider_id",
      "model_id",
      "sent_scope",
      "sent_scope_hash",
      "call_count",
      "retry_limit",
      "cost_status",
      "estimated_cost_micros",
      "currency",
      "privacy_policy",
      "state",
      "revision",
      "created_at",
      "updated_at",
      "consumed_at",
      "revoked_at",
    ]);
    expect(
      columns.some(({ name }) =>
        /(?:body|content|prompt|credential|secret|endpoint|api_key)/iu.test(name),
      ),
    ).toBe(false);
    await executor.close();
  });

  it("enforces CAS transitions, immutable disclosure metadata, privacy and the hard row bound", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await executor.execute(
      `INSERT INTO writing_experience_preferences (
         scope, mode, initialization_source, revision, created_at, updated_at
       ) VALUES ('global', 'direct', 'new_install', 1, ?, ?)`,
      [NOW, NOW],
    );
    await expect(
      executor.execute(
        `UPDATE writing_experience_preferences
         SET mode = 'professional', revision = 3, updated_at = ?
         WHERE scope = 'global'`,
        [NOW],
      ),
    ).rejects.toThrow(/WRITING_EXPERIENCE_REVISION_CONFLICT/u);

    await insertGrant(executor, "a".repeat(64));
    await expect(
      executor.execute(
        `UPDATE writing_provider_disclosure_grants
         SET model_id = 'retargeted', state = 'consumed', revision = 2,
             consumed_at = ?, updated_at = ?
         WHERE fingerprint = ?`,
        [NOW, NOW, "a".repeat(64)],
      ),
    ).rejects.toThrow(/WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT/u);
    await expect(
      executor.execute(
        `INSERT INTO writing_provider_disclosure_grants (
           fingerprint, task, provider_id, model_id, sent_scope, sent_scope_hash,
           call_count, retry_limit, cost_status, privacy_policy,
           state, revision, created_at, updated_at
         ) VALUES (?, 'continuation', 'provider', 'model', 'chapter_text', ?,
           1, 0, 'unknown', 'local_only', 'active', 1, ?, ?)`,
        ["b".repeat(64), "c".repeat(64), NOW, NOW],
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);

    for (let index = 1; index < 128; index += 1) {
      await insertGrant(executor, index.toString(16).padStart(64, "0"));
    }
    await expect(insertGrant(executor, "f".repeat(64))).rejects.toThrow(
      /WRITING_DISCLOSURE_GRANT_LIMIT_REACHED/u,
    );
    await executor.close();
  });
});

describe("writing disclosure active grant limit migration", () => {
  it("retains terminal audit rows while preserving the 128-active hard ceiling", async () => {
    const executor = new NodeSqliteExecutor(`${migration}\n${activeGrantLimitMigration}`);
    await insertGrant(executor, "0".repeat(64));
    await executor.execute(
      `UPDATE writing_provider_disclosure_grants
       SET state = 'revoked', revision = 2, revoked_at = ?, updated_at = ?
       WHERE fingerprint = ?`,
      [NOW, NOW, "0".repeat(64)],
    );
    for (let index = 1; index <= 128; index += 1) {
      await insertGrant(executor, index.toString(16).padStart(64, "0"));
    }

    await expect(
      executor.select<{ total: number; active: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active
         FROM writing_provider_disclosure_grants`,
      ),
    ).resolves.toEqual([{ total: 129, active: 128 }]);
    await expect(insertGrant(executor, "f".repeat(64))).rejects.toThrow(
      /WRITING_DISCLOSURE_GRANT_LIMIT_REACHED/u,
    );
    await executor.close();
  });
});

function insertGrant(executor: NodeSqliteExecutor, fingerprint: string): Promise<unknown> {
  return executor.execute(
    `INSERT INTO writing_provider_disclosure_grants (
       fingerprint, task, provider_id, model_id, sent_scope, sent_scope_hash,
       call_count, retry_limit, cost_status, estimated_cost_micros, currency,
       privacy_policy, state, revision, created_at, updated_at
     ) VALUES (?, 'continuation', 'provider', 'model', 'chapter_text', ?,
       1, 0, 'unknown', NULL, NULL, 'cloud_allowed', 'active', 1, ?, ?)`,
    [fingerprint, "d".repeat(64), NOW, NOW],
  );
}
