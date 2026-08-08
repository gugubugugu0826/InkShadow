import { readFileSync } from "node:fs";

import { deriveProfessionalProjectSeed } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { ProjectSeedSqliteStore } from "../src/project-seed-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = ["0001_core.sql", "0030_creative_journeys.sql", "0039_project_seeds.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");

const PROJECT_ID = "019fa601-0000-7000-8000-000000000001";
const OTHER_PROJECT_ID = "019fa601-0000-7000-8000-000000000002";

describe("ProjectSeedSqliteStore", () => {
  it("round-trips one seed per project and rejects stale async overwrites", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await insertProject(executor, PROJECT_ID, "主项目");
    await insertProject(executor, OTHER_PROJECT_ID, "其他项目");
    const store = new ProjectSeedSqliteStore(executor);
    const first = deriveProfessionalProjectSeed({
      seedId: "professional:sqlite-roundtrip",
      projectName: "主项目",
      storyDirection: "旧城的钟只为失踪者敲响。",
      outlineSynopsis: "调查钟声来源。",
      protagonist: "守钟人林遥",
      relationship: "与失踪的姐姐关系紧张",
      worldBackground: "潮湿的海港旧城",
      pov: "第三人称限知",
      style: "克制，保留“作者原句”；不要改成半角标点。",
      boundaries: "不复活已死亡角色",
      now: "2026-08-08T01:00:00.000Z",
    });
    const savedFirst = await store.saveForProject(PROJECT_ID, first);
    expect(savedFirst).toEqual({
      projectId: PROJECT_ID,
      seed: first,
      revision: 1,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
    });
    expect(savedFirst.seed.style.values).toEqual(["克制，保留“作者原句”；不要改成半角标点。"]);
    expect((await store.findByProjectId(PROJECT_ID))?.seed.style.values).toEqual([
      "克制，保留“作者原句”；不要改成半角标点。",
    ]);
    expect(await store.findByProjectId(OTHER_PROJECT_ID)).toBeNull();

    const latest = deriveProfessionalProjectSeed({
      seedId: first.seedId,
      projectName: "主项目",
      storyDirection: "旧城的钟只为失踪者敲响。",
      outlineSynopsis: "调查钟声并找回姐姐留下的证据。",
      protagonist: "守钟人林遥",
      relationship: "姐姐可能主动离开",
      worldBackground: "潮湿的海港旧城",
      pov: "第三人称限知",
      style: "克制短句",
      boundaries: "不复活已死亡角色",
      now: "2026-08-08T01:05:00.000Z",
      existing: first,
    });
    const savedLatest = await store.saveForProject(PROJECT_ID, latest);
    expect(savedLatest.revision).toBe(2);
    expect(savedLatest.seed).toEqual(latest);

    const staleResult = await store.saveForProject(PROJECT_ID, first);
    expect(staleResult).toEqual(savedLatest);

    await executor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);
    expect(await store.findByProjectId(PROJECT_ID)).toBeNull();
    await executor.close();
  });
});

async function insertProject(
  executor: NodeSqliteExecutor,
  projectId: string,
  name: string,
): Promise<void> {
  const now = "2026-08-08T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [projectId, name, now, now],
  );
}
