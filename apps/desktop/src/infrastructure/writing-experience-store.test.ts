import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseIsoUtcTimestamp, type Clock, type IsoUtcTimestamp } from "@inkshadow/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  BrowserDevelopmentWritingExperienceStore,
  DEVELOPMENT_WRITING_EXPERIENCE_KEY,
  TauriWritingExperienceStore,
  type RecordWritingProviderDisclosureGrantInput,
} from "./writing-experience-store";

const NOW = requireTimestamp("2026-08-18T00:00:00.000Z");
const LATER = requireTimestamp("2026-08-18T00:01:00.000Z");
const migration = [
  `PRAGMA foreign_keys = ON;
   CREATE TABLE projects (id TEXT PRIMARY KEY);
   CREATE TABLE chapters (id TEXT PRIMARY KEY);
   CREATE TABLE creative_journeys (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
   CREATE TABLE project_seeds (project_id TEXT PRIMARY KEY, journey_kind TEXT NOT NULL);
   CREATE TABLE model_profiles (provider_id TEXT PRIMARY KEY);
   CREATE TABLE model_role_routes (role TEXT PRIMARY KEY);
   CREATE TABLE novel_task_routes (task TEXT PRIMARY KEY, route_origin TEXT NOT NULL);
   CREATE TABLE model_provider_connections (id TEXT PRIMARY KEY);
   CREATE TABLE local_audit_events (
     id TEXT PRIMARY KEY NOT NULL,
     project_id TEXT,
     entity_type TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     action TEXT NOT NULL,
     request_id TEXT NOT NULL,
     metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
     created_at TEXT NOT NULL
   );`,
  readMigration("0066_writing_experience_preferences.sql"),
  readMigration("0068_writing_disclosure_active_grant_limit.sql"),
].join("\n");

describe("TauriWritingExperienceStore", () => {
  it("initializes an empty author database in direct mode exactly once", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriWritingExperienceStore(executor, fixedClock(NOW));

    await expect(store.getOrInitialize()).resolves.toEqual({
      mode: "direct",
      initializationSource: "new_install",
      directLocalOrganizationAuthorizedAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      new TauriWritingExperienceStore(executor, fixedClock(LATER)).getOrInitialize(),
    ).resolves.toEqual({
      mode: "direct",
      initializationSource: "new_install",
      directLocalOrganizationAuthorizedAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await executor.close();
  });

  it.each([
    ["project", "INSERT INTO projects (id) VALUES ('project')"],
    ["chapter", "INSERT INTO chapters (id) VALUES ('chapter')"],
    [
      "professional journey",
      "INSERT INTO creative_journeys (id, kind) VALUES ('journey', 'professional')",
    ],
    [
      "professional seed",
      "INSERT INTO project_seeds (project_id, journey_kind) VALUES ('project', 'professional')",
    ],
    ["legacy role route", "INSERT INTO model_role_routes (role) VALUES ('fast')"],
    [
      "user Model Hub route",
      "INSERT INTO novel_task_routes (task, route_origin) VALUES ('continuation', 'user')",
    ],
    ["model profile", "INSERT INTO model_profiles (provider_id) VALUES ('provider')"],
    ["provider connection", "INSERT INTO model_provider_connections (id) VALUES ('connection')"],
  ])("preserves %s upgrades in professional mode", async (_label, seedSql) => {
    const executor = new NodeSqliteExecutor(migration);
    await executor.execute(seedSql);
    const store = new TauriWritingExperienceStore(executor, fixedClock(NOW));

    await expect(store.getOrInitialize()).resolves.toMatchObject({
      mode: "professional",
      initializationSource: "upgrade_existing",
      revision: 1,
    });
    await executor.close();
  });

  it("treats switching to direct mode as the authority and preserves it with CAS", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await executor.execute("INSERT INTO projects (id) VALUES ('existing')");
    const store = new TauriWritingExperienceStore(executor, sequenceClock(NOW, LATER));
    await expect(store.getOrInitialize()).resolves.toMatchObject({
      mode: "professional",
      directLocalOrganizationAuthorizedAt: null,
      revision: 1,
    });
    await expect(store.switchMode("direct", 1)).resolves.toEqual({
      mode: "direct",
      initializationSource: "user",
      directLocalOrganizationAuthorizedAt: LATER,
      revision: 2,
      createdAt: NOW,
      updatedAt: LATER,
    });
    await expect(store.switchMode("direct", 1)).rejects.toMatchObject({
      code: "WRITING_EXPERIENCE_REVISION_CONFLICT",
      retryable: true,
    });
    await expect(store.getOrInitialize()).resolves.toMatchObject({
      mode: "direct",
      revision: 2,
      directLocalOrganizationAuthorizedAt: LATER,
    });
    await expect(store.revokeDirectModeAuthorization(2)).resolves.toMatchObject({
      mode: "professional",
      revision: 3,
      directLocalOrganizationAuthorizedAt: null,
    });
    await expect(
      new TauriWritingExperienceStore(executor, fixedClock(LATER)).getOrInitialize(),
    ).resolves.toMatchObject({
      mode: "professional",
      revision: 3,
      directLocalOrganizationAuthorizedAt: null,
    });
    await expect(store.switchMode("direct", 3)).resolves.toMatchObject({
      mode: "direct",
      revision: 4,
      directLocalOrganizationAuthorizedAt: LATER,
    });
    await executor.close();
  });

  it("records one content-free disclosure, consumes it once, and rejects retargeting", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriWritingExperienceStore(executor, sequenceClock(NOW, LATER));
    const input = disclosureInput();

    await expect(store.recordDisclosureGrant(input)).resolves.toMatchObject({
      created: true,
      grant: { state: "active", revision: 1 },
    });
    await expect(store.recordDisclosureGrant(input)).resolves.toMatchObject({ created: false });
    await expect(
      store.recordDisclosureGrant({ ...input, modelId: "another-model" }),
    ).rejects.toMatchObject({ code: "WRITING_DISCLOSURE_FINGERPRINT_CONFLICT" });
    await expect(
      store.recordDisclosureGrant({
        ...input,
        costStatus: "estimated",
        estimatedCostMicros: "250000",
        currency: "CNY",
      }),
    ).rejects.toMatchObject({ code: "WRITING_DISCLOSURE_FINGERPRINT_CONFLICT" });
    await expect(store.consumeDisclosureGrant(input.fingerprint, 1)).resolves.toMatchObject({
      state: "consumed",
      revision: 2,
      consumedAt: LATER,
    });
    await expect(store.consumeDisclosureGrant(input.fingerprint, 1)).rejects.toMatchObject({
      code: "WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT",
    });
    await expect(store.listActiveDisclosureGrants()).resolves.toEqual([]);

    const serialized = JSON.stringify(await store.findDisclosureGrant(input.fingerprint));
    expect(serialized).not.toMatch(/(?:chapter body|prompt|secret|api[_ ]?key|endpoint)/iu);
    await executor.close();
  });

  it("fails closed before persisting a local-only disclosure", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriWritingExperienceStore(executor, fixedClock(NOW));

    await expect(
      store.recordDisclosureGrant({
        ...disclosureInput(),
        privacyPolicy: "local_only" as "cloud_allowed",
      }),
    ).rejects.toMatchObject({ code: "WRITING_DISCLOSURE_PRIVACY_BLOCKED" });
    await expect(
      executor.select("SELECT * FROM writing_provider_disclosure_grants"),
    ).resolves.toEqual([]);
    await executor.close();
  });

  it("rotates more than 128 estimates in one authority family and preserves restart audit", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriWritingExperienceStore(executor, fixedClock(NOW));

    for (let index = 1; index <= 130; index += 1) {
      await store.recordDisclosureGrant(
        disclosureInput({
          fingerprint: index.toString(16).padStart(64, "0"),
          costStatus: "estimated",
          estimatedCostMicros: String(index),
          currency: "CNY",
        }),
      );
    }

    await expect(store.listActiveDisclosureGrants()).resolves.toMatchObject([
      { fingerprint: (130).toString(16).padStart(64, "0"), estimatedCostMicros: "130" },
    ]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM writing_provider_disclosure_grants",
      ),
    ).resolves.toEqual([{ count: 130 }]);
    await expect(
      new TauriWritingExperienceStore(executor, fixedClock(LATER)).listActiveDisclosureGrants(),
    ).resolves.toHaveLength(1);
    await expect(store.findDisclosureGrant("1".padStart(64, "0"))).resolves.toMatchObject({
      state: "revoked",
      estimatedCostMicros: "1",
    });
    await executor.close();
  });

  it("rotates unknown, estimated and currency changes within one authority family", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriWritingExperienceStore(executor, fixedClock(NOW));
    const unknown = disclosureInput({ fingerprint: "1".repeat(64) });
    const cny = disclosureInput({
      fingerprint: "2".repeat(64),
      costStatus: "estimated",
      estimatedCostMicros: "100",
      currency: "CNY",
    });
    const usd = disclosureInput({
      fingerprint: "3".repeat(64),
      costStatus: "estimated",
      estimatedCostMicros: "20",
      currency: "USD",
    });

    await store.recordDisclosureGrant(unknown);
    await store.recordDisclosureGrant(cny);
    await store.recordDisclosureGrant(usd);

    await expect(store.listActiveDisclosureGrants()).resolves.toMatchObject([
      { fingerprint: usd.fingerprint, state: "active" },
    ]);
    await expect(store.findDisclosureGrant(unknown.fingerprint)).resolves.toMatchObject({
      state: "revoked",
    });
    await expect(store.findDisclosureGrant(cny.fingerprint)).resolves.toMatchObject({
      state: "revoked",
    });
    await executor.close();
  });

  it("rotates only the matching authority family and archives an exact retired fingerprint", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriWritingExperienceStore(executor, sequenceClock(NOW, LATER));
    const first = disclosureInput({
      fingerprint: "1".repeat(64),
      costStatus: "estimated",
      estimatedCostMicros: "100",
      currency: "CNY",
    });
    const otherModel = disclosureInput({ fingerprint: "2".repeat(64), modelId: "other-model" });
    await store.recordDisclosureGrant(first);
    await store.recordDisclosureGrant(otherModel);
    await store.recordDisclosureGrant({
      ...first,
      fingerprint: "3".repeat(64),
      estimatedCostMicros: "200",
    });

    await expect(store.listActiveDisclosureGrants()).resolves.toMatchObject([
      { fingerprint: "2".repeat(64), state: "active" },
      { fingerprint: "3".repeat(64), state: "active" },
    ]);
    await store.recordDisclosureGrant(first);
    await expect(store.findDisclosureGrant(first.fingerprint)).resolves.toMatchObject({
      state: "active",
      estimatedCostMicros: "100",
    });
    const auditRows = await executor.select<{ action: string; metadata_json: string }>(
      `SELECT action, metadata_json FROM local_audit_events
       WHERE entity_type = 'writing_provider_disclosure_grant'`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("archive_revoked");
    expect(auditRows[0]?.metadata_json).toContain('"estimatedCostMicros":"100"');
    await expect(store.findDisclosureGrant("3".repeat(64))).resolves.toMatchObject({
      state: "revoked",
    });
    await executor.close();
  });
});

describe("BrowserDevelopmentWritingExperienceStore", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses durable direct defaults for an empty browser-development database", async () => {
    const store = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(NOW),
    );
    await expect(store.getOrInitialize()).resolves.toMatchObject({
      mode: "direct",
      initializationSource: "new_install",
      directLocalOrganizationAuthorizedAt: NOW,
    });

    const reopened = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(LATER),
    );
    await expect(reopened.getOrInitialize()).resolves.toMatchObject({
      mode: "direct",
      createdAt: NOW,
    });
  });

  it("conservatively preserves existing and malformed legacy data in professional mode", async () => {
    window.localStorage.setItem(
      "inkshadow.development.database.v1",
      JSON.stringify({ schemaVersion: 2, projects: [{ id: "existing" }], chapters: [] }),
    );
    const existing = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(NOW),
    );
    await expect(existing.getOrInitialize()).resolves.toMatchObject({
      mode: "professional",
      initializationSource: "upgrade_existing",
    });

    window.localStorage.clear();
    window.localStorage.setItem("inkshadow.development.model-routing.v1", "{broken");
    const malformed = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(NOW),
    );
    await expect(malformed.getOrInitialize()).resolves.toMatchObject({ mode: "professional" });
  });

  it("persists CAS mode and revocable disclosure authority without body-shaped fields", async () => {
    const store = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      sequenceClock(NOW, LATER),
    );
    await store.getOrInitialize();
    await store.switchMode("professional", 1);
    await store.revokeDirectModeAuthorization(2);
    const recorded = await store.recordDisclosureGrant(disclosureInput());
    await store.revokeDisclosureGrant(recorded.grant.fingerprint, recorded.grant.revision);

    const serialized = window.localStorage.getItem(DEVELOPMENT_WRITING_EXPERIENCE_KEY) ?? "";
    expect(serialized).toContain('"mode":"professional"');
    expect(serialized).toContain('"directLocalOrganizationAuthorizedAt":null');
    expect(serialized).toContain('"state":"revoked"');
    expect(serialized).not.toMatch(/(?:prompt|body|content|credential|secret|endpoint|apiKey)/u);
  });

  it("serializes concurrent estimate authorization and keeps one active family after restart", async () => {
    const firstStore = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(NOW),
    );
    const base = disclosureInput({
      fingerprint: "4".repeat(64),
      costStatus: "estimated",
      estimatedCostMicros: "400",
      currency: "CNY",
    });
    const results = await Promise.all([
      firstStore.recordDisclosureGrant(base),
      firstStore.recordDisclosureGrant({
        ...base,
        fingerprint: "5".repeat(64),
        estimatedCostMicros: "500",
      }),
    ]);

    expect(results).toHaveLength(2);
    const reopened = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(LATER),
    );
    await expect(reopened.listActiveDisclosureGrants()).resolves.toMatchObject([
      { fingerprint: "5".repeat(64), estimatedCostMicros: "500" },
    ]);
    await expect(reopened.findDisclosureGrant("4".repeat(64))).resolves.toMatchObject({
      state: "revoked",
    });
  });

  it("rotates browser grants when cost status or currency changes", async () => {
    const store = new BrowserDevelopmentWritingExperienceStore(
      window.localStorage,
      fixedClock(NOW),
    );
    const unknown = disclosureInput({ fingerprint: "6".repeat(64) });
    const usd = disclosureInput({
      fingerprint: "7".repeat(64),
      costStatus: "estimated",
      estimatedCostMicros: "25",
      currency: "USD",
    });

    await store.recordDisclosureGrant(unknown);
    await store.recordDisclosureGrant(usd);

    await expect(store.listActiveDisclosureGrants()).resolves.toMatchObject([
      { fingerprint: usd.fingerprint, state: "active" },
    ]);
    await expect(store.findDisclosureGrant(unknown.fingerprint)).resolves.toMatchObject({
      state: "revoked",
    });
  });
});

function disclosureInput(
  overrides: Partial<RecordWritingProviderDisclosureGrantInput> = {},
): RecordWritingProviderDisclosureGrantInput {
  return {
    fingerprint: "a".repeat(64),
    task: "continuation",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    sentScope: "chapter_and_selected_context",
    sentScopeHash: "b".repeat(64),
    callCount: 1,
    retryLimit: 0,
    costStatus: "unknown",
    estimatedCostMicros: null,
    currency: null,
    privacyPolicy: "cloud_allowed",
    ...overrides,
  };
}

function fixedClock(now: IsoUtcTimestamp): Clock {
  return { now: () => now };
}

function sequenceClock(...timestamps: readonly IsoUtcTimestamp[]): Clock {
  let index = 0;
  return {
    now: () => timestamps[Math.min(index++, timestamps.length - 1)] ?? NOW,
  };
}

function requireTimestamp(value: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) throw new Error("InkShadow workspace root could not be located.");
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
