import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  IdeationDraft,
  STORY_CORE_SQLITE_MIGRATION_0003,
  SqliteIdeationDraftRepository,
} from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const T0 = "2026-07-27T00:00:00.000Z";
const T1 = "2026-07-27T00:01:00.000Z";
const executors: NodeStorySqliteExecutor[] = [];

afterEach(() => {
  for (const executor of executors.splice(0)) {
    executor.close();
  }
});

describe("ideation SQLite persistence", () => {
  it("matches the native migration and persists active drafts with CAS ordering", async () => {
    const nativeSql = readFileSync(
      new URL("../migrations/0003_ideation.sql", import.meta.url),
      "utf8",
    ).trim();
    expect(nativeSql).toBe(STORY_CORE_SQLITE_MIGRATION_0003);
    const executor = createExecutor();
    const repository = new SqliteIdeationDraftRepository(executor);
    const first = makeDraft(1, "第一份");
    const second = makeDraft(2, "第二份");
    expect((await repository.create(first)).ok).toBe(true);
    expect((await repository.create(second)).ok).toBe(true);

    const changed = unwrap(
      first.updateStep({
        step: "premise",
        value: "人工保存的灵感",
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await repository.save(changed, 1)).ok).toBe(true);
    const stale = await repository.save(
      unwrap(
        first.skipStep({
          step: "premise",
          expectedRevision: 1,
          now: T1,
        }),
      ),
      1,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("STORY_REVISION_CONFLICT");
    }

    expect(unwrap(await repository.findById(first.id))?.toSnapshot()).toEqual(changed.toSnapshot());
    expect(unwrap(await repository.listActive()).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("rejects a snapshot whose indexed projection has been tampered with", async () => {
    const executor = createExecutor();
    const repository = new SqliteIdeationDraftRepository(executor);
    const draft = makeDraft(20, "投影校验");
    expect((await repository.create(draft)).ok).toBe(true);
    executor.database
      .prepare(`UPDATE story_ideation_drafts SET mode = 'quick' WHERE id = ?`)
      .run(draft.id);

    const loaded = await repository.findById(draft.id);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("STORY_REPOSITORY_ERROR");
      expect(loaded.error.details).toMatchObject({
        causeCode: "IDEATION_PROJECTION_MISMATCH",
      });
    }
  });
});

function createExecutor(): NodeStorySqliteExecutor {
  const executor = new NodeStorySqliteExecutor(STORY_CORE_SQLITE_MIGRATION_0003);
  executors.push(executor);
  return executor;
}

function makeDraft(sequence: number, projectName: string): IdeationDraft {
  return unwrap(
    IdeationDraft.create({
      id: uuid(sequence),
      mode: "guided",
      projectName,
      now: T0,
    }),
  );
}
