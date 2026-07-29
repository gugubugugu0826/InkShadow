import { readFileSync } from "node:fs";

import type { Clock, IsoUtcTimestamp } from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TeamTemplateApplicationSqliteStore,
  type ApplyTeamTemplateAtomicallyInput,
} from "../src/team-template-application-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0026_team_template_applications.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

describe("0026 team-template local application authority", () => {
  let executor: NodeSqliteExecutor;
  let store: TeamTemplateApplicationSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new TeamTemplateApplicationSqliteStore(executor, clock(NOW));
    await insertProject(executor, PROJECT_ID, 7);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("applies all four project domains and writes the receipt under one revision CAS", async () => {
    const result = await store.applyAtomically(application());

    expect(result).toMatchObject({
      applicationId: APPLICATION_ID,
      projectRevisionBefore: 7,
      projectRevisionAfter: 8,
      cloudRecordedAt: null,
      result: "applied",
    });
    expect(await projectRevision(executor)).toBe(8);
    expect(
      await executor.select(
        `SELECT setting_key, value_json, source_application_id
         FROM project_team_template_settings
         ORDER BY setting_key`,
      ),
    ).toEqual([
      {
        setting_key: "genre",
        value_json: '"mystery"',
        source_application_id: APPLICATION_ID,
      },
      {
        setting_key: "review.required",
        value_json: "true",
        source_application_id: APPLICATION_ID,
      },
    ]);
    expect(
      await executor.select(
        `SELECT registry_id, registry_revision, ordinal
         FROM project_team_template_prompt_refs`,
      ),
    ).toEqual([{ registry_id: REGISTRY_ID, registry_revision: 3, ordinal: 0 }]);
    expect(
      await executor.select(
        `SELECT rule_id, label, instruction, ordinal
         FROM project_team_template_prompt_rules`,
      ),
    ).toEqual([
      {
        rule_id: RULE_ID,
        label: "Voice",
        instruction: "Keep the narrator restrained.",
        ordinal: 0,
      },
    ]);
    expect(
      await executor.select(
        `SELECT item_id, label, required, ordinal
         FROM project_team_template_checklist_items`,
      ),
    ).toEqual([{ item_id: ITEM_ID, label: "Continuity checked", required: 1, ordinal: 0 }]);
  });

  it("replays an application ID and a newly generated ID for the same version without reapplying", async () => {
    const first = await store.applyAtomically(application());
    const exactReplay = await store.applyAtomically(application());
    const newApplicationReplay = await store.applyAtomically(
      application({
        applicationId: uuid(20),
        expectedProjectRevision: 8,
        cloudIdempotencyKey: "team-template.apply.second.0001",
      }),
    );

    expect(first.result).toBe("applied");
    expect(exactReplay).toMatchObject({
      applicationId: APPLICATION_ID,
      result: "already_applied",
    });
    expect(newApplicationReplay).toMatchObject({
      applicationId: APPLICATION_ID,
      cloudIdempotencyKey: "team-template.apply.first.0001",
      result: "already_applied",
    });
    expect(await projectRevision(executor)).toBe(8);
    expect(
      await executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_template_application_receipts",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("rolls back every project mutation and receipt when the project CAS fails", async () => {
    await expect(
      store.applyAtomically(application({ expectedProjectRevision: 6 })),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_APPLICATION_REVISION_CONFLICT" });

    expect(await projectRevision(executor)).toBe(7);
    expect(
      await executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_template_application_receipts",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_team_template_settings",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("restores prior settings and revision when a later statement aborts the transaction", async () => {
    await store.applyAtomically(application());
    await executor.execute(`
      CREATE TRIGGER fail_team_template_rule_insert
      BEFORE INSERT ON project_team_template_prompt_rules
      BEGIN
        SELECT RAISE(ABORT, 'injected team-template failure');
      END
    `);

    await expect(
      store.applyAtomically(
        application({
          applicationId: uuid(21),
          versionId: uuid(22),
          versionNumber: 2,
          templateRevision: 3,
          expectedProjectRevision: 8,
          contentDigest: "b".repeat(64),
          cloudIdempotencyKey: "team-template.apply.failure.0001",
          payload: {
            ...application().payload,
            projectSettings: [{ key: "genre", value: "romance" }],
          },
        }),
      ),
    ).rejects.toThrow(/injected team-template failure/u);

    expect(await projectRevision(executor)).toBe(8);
    expect(
      await executor.select(
        "SELECT setting_key, value_json FROM project_team_template_settings ORDER BY setting_key",
      ),
    ).toEqual([
      { setting_key: "genre", value_json: '"mystery"' },
      { setting_key: "review.required", value_json: "true" },
    ]);
    expect(
      await executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_template_application_receipts",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("fails closed and rolls back before mutation when a cloud idempotency key is reused", async () => {
    await store.applyAtomically(application());

    await expect(
      store.applyAtomically(
        application({
          applicationId: uuid(23),
          versionId: uuid(24),
          versionNumber: 2,
          templateRevision: 3,
          expectedProjectRevision: 8,
          contentDigest: "c".repeat(64),
        }),
      ),
    ).rejects.toThrow();

    expect(await projectRevision(executor)).toBe(8);
    expect(
      await executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_template_application_receipts",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("supports bounded scoped startup recovery and a one-way cloud checkpoint", async () => {
    const applied = await store.applyAtomically(application());
    expect(await store.listPendingCloudRecords({ ...SCOPE, limit: 1 })).toEqual([applied]);
    expect(
      await store.listPendingCloudRecords({
        tenantId: uuid(30),
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        limit: 1,
      }),
    ).toEqual([]);
    await expect(store.listPendingCloudRecords({ ...SCOPE, limit: 101 })).rejects.toMatchObject({
      code: "TEAM_TEMPLATE_APPLICATION_INVALID",
    });

    const checkpointed = await store.markCloudRecorded({
      applicationId: APPLICATION_ID,
      cloudRecordedAt: LATER,
    });
    expect(checkpointed.cloudRecordedAt).toBe(LATER);
    expect(await store.listPendingCloudRecords({ ...SCOPE, limit: 10 })).toEqual([]);
    await expect(
      store.markCloudRecorded({
        applicationId: APPLICATION_ID,
        cloudRecordedAt: LATEST,
      }),
    ).rejects.toMatchObject({
      code: "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT",
    });
    await expect(
      executor.execute(
        `UPDATE team_template_application_receipts
         SET content_digest = ?
         WHERE application_id = ?`,
        ["f".repeat(64), APPLICATION_ID],
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("accepts a valid 16 KiB setting whose JSON escaping expands beyond 16 KiB", async () => {
    const escaped = '"\\\n'.repeat(5_461) + '"';
    expect(escaped.length).toBe(16_384);
    expect(JSON.stringify(escaped).length).toBeGreaterThan(16_386);

    await expect(
      store.applyAtomically(
        application({
          payload: {
            ...application().payload,
            projectSettings: [{ key: "escaped", value: escaped }],
          },
        }),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    const rows = await executor.select<{ value_json: string }>(
      "SELECT value_json FROM project_team_template_settings WHERE setting_key = 'escaped'",
    );
    expect(JSON.parse(rows[0]?.value_json ?? "")).toBe(escaped);
  });

  it("cascades the immutable receipt and projections when its project is deleted", async () => {
    await store.applyAtomically(application());

    await executor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);

    for (const table of [
      "team_template_application_receipts",
      "project_team_template_settings",
      "project_team_template_prompt_refs",
      "project_team_template_prompt_rules",
      "project_team_template_checklist_items",
    ]) {
      expect(
        await executor.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`),
      ).toEqual([{ count: 0 }]);
    }
  });
});

const TENANT_ID = uuid(1);
const TEAM_ID = uuid(2);
const PROJECT_ID = uuid(3);
const TEMPLATE_ID = uuid(4);
const VERSION_ID = uuid(5);
const APPLICATION_ID = uuid(6);
const MEMBERSHIP_ID = uuid(7);
const REGISTRY_ID = uuid(8);
const RULE_ID = uuid(9);
const ITEM_ID = uuid(10);
const NOW = "2026-07-28T10:00:00.000Z";
const LATER = "2026-07-28T10:01:00.000Z";
const LATEST = "2026-07-28T10:02:00.000Z";
const SCOPE = { tenantId: TENANT_ID, teamId: TEAM_ID, projectId: PROJECT_ID };

function application(
  override: Partial<ApplyTeamTemplateAtomicallyInput> = {},
): ApplyTeamTemplateAtomicallyInput {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: TEMPLATE_ID,
    templateRevision: 2,
    versionId: VERSION_ID,
    versionNumber: 1,
    contentDigest: "a".repeat(64),
    expectedProjectRevision: 7,
    cloudIdempotencyKey: "team-template.apply.first.0001",
    requestedByMembershipId: MEMBERSHIP_ID,
    payload: {
      projectSettings: [
        { key: "genre", value: "mystery" },
        { key: "review.required", value: true },
      ],
      promptRegistryRefs: [{ registryId: REGISTRY_ID, revision: 3 }],
      promptRules: [
        {
          ruleId: RULE_ID,
          label: "Voice",
          instruction: "Keep the narrator restrained.",
        },
      ],
      reviewChecklist: [{ itemId: ITEM_ID, label: "Continuity checked", required: true }],
    },
    ...override,
  };
}

async function insertProject(
  executor: NodeSqliteExecutor,
  projectId: string,
  revision: number,
): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation,
       created_at, updated_at, archived_at, trashed_at,
       retention_until, status_before_trash
     ) VALUES (?, 'Team template target', 'active', ?, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [projectId, revision, NOW, NOW],
  );
}

async function projectRevision(executor: NodeSqliteExecutor): Promise<number> {
  const rows = await executor.select<{ revision: number }>(
    "SELECT revision FROM projects WHERE id = ?",
    [PROJECT_ID],
  );
  return rows[0]?.revision ?? 0;
}

function clock(value: string): Clock {
  return { now: () => value as IsoUtcTimestamp };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
