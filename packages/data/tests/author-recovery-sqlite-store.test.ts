import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AuthorRecoveryConflictError,
  AuthorRecoverySqliteStore,
} from "../src/author-recovery-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = ["0001_core.sql", "0082_author_recovery_records.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");

const PROJECT_ID = "019fa601-0000-7000-8000-000000000011";
const OTHER_PROJECT_ID = "019fa601-0000-7000-8000-000000000012";
const KIND = "bulk_story_settings";

describe("AuthorRecoverySqliteStore", () => {
  it("round-trips raw recovery JSON and enforces revision compare-and-swap", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await insertProject(executor, PROJECT_ID);
    await insertProject(executor, OTHER_PROJECT_ID);
    const store = new AuthorRecoverySqliteStore(executor);
    const firstPayload = JSON.stringify({ schemaVersion: "future.v9", source: "作者原文" });

    const created = await store.save({
      projectId: PROJECT_ID,
      kind: KIND,
      schemaVersion: "future.v9",
      payloadJson: firstPayload,
      expectedRevision: null,
      now: "2026-08-28T00:00:00.000Z",
    });
    expect(created).toEqual({
      projectId: PROJECT_ID,
      kind: KIND,
      schemaVersion: "future.v9",
      payloadJson: firstPayload,
      revision: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(await store.find(PROJECT_ID, KIND)).toEqual(created);
    expect(await store.find(OTHER_PROJECT_ID, KIND)).toBeNull();

    await expect(
      store.save({
        projectId: PROJECT_ID,
        kind: KIND,
        schemaVersion: "inkshadow.local-bulk-setting-recovery.v1",
        payloadJson: JSON.stringify({ source: "不应覆盖" }),
        expectedRevision: null,
        now: "2026-08-28T00:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(AuthorRecoveryConflictError);
    expect(await store.find(PROJECT_ID, KIND)).toEqual(created);

    const secondPayload = JSON.stringify({ schemaVersion: "known.v1", source: "逐条修改" });
    const updated = await store.save({
      projectId: PROJECT_ID,
      kind: KIND,
      schemaVersion: "known.v1",
      payloadJson: secondPayload,
      expectedRevision: created.revision,
      now: "2026-08-28T00:02:00.000Z",
    });
    expect(updated).toMatchObject({ payloadJson: secondPayload, revision: 2 });
    await expect(
      store.save({
        projectId: PROJECT_ID,
        kind: KIND,
        schemaVersion: "known.v1",
        payloadJson: JSON.stringify({ source: "过期写入" }),
        expectedRevision: created.revision,
        now: "2026-08-28T00:03:00.000Z",
      }),
    ).rejects.toBeInstanceOf(AuthorRecoveryConflictError);
    expect((await store.find(PROJECT_ID, KIND))?.payloadJson).toBe(secondPayload);

    await expect(store.delete(PROJECT_ID, KIND, created.revision)).rejects.toBeInstanceOf(
      AuthorRecoveryConflictError,
    );
    expect(await store.delete(PROJECT_ID, KIND, updated.revision)).toBe(true);
    expect(await store.delete(PROJECT_ID, KIND, updated.revision)).toBe(false);
    await executor.close();
  });

  it("lets only one concurrent writer advance a revision", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await insertProject(executor, PROJECT_ID);
    const store = new AuthorRecoverySqliteStore(executor);
    const created = await store.save({
      projectId: PROJECT_ID,
      kind: KIND,
      schemaVersion: "known.v1",
      payloadJson: JSON.stringify({ source: "起点" }),
      expectedRevision: null,
      now: "2026-08-28T00:00:00.000Z",
    });

    const settled = await Promise.allSettled(
      ["甲", "乙"].map((source) =>
        store.save({
          projectId: PROJECT_ID,
          kind: KIND,
          schemaVersion: "known.v1",
          payloadJson: JSON.stringify({ source }),
          expectedRevision: created.revision,
          now: "2026-08-28T00:01:00.000Z",
        }),
      ),
    );
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await store.find(PROJECT_ID, KIND))?.revision).toBe(2);
    await executor.close();
  });
});

async function insertProject(executor: NodeSqliteExecutor, projectId: string): Promise<void> {
  const now = "2026-08-28T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [projectId, `恢复测试-${projectId.slice(-4)}`, now, now],
  );
}
