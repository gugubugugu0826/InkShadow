import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type ExecuteResult,
  type SqlExecutor,
  type SqlPrimitive,
  type TransactionExecutor,
} from "@inkshadow/data";
import {
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7 as parseDomainUuid,
  type UuidV7 as DomainUuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import {
  IDEATION_STEP_KEYS,
  IdeationDraft,
  SqliteIdeationDraftRepository,
  parseUuidV7 as parseStoryUuid,
  type ProjectSeed,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { SqliteIdeationProjectCommitUnitOfWork } from "./ideation-project-commit";

const projectDisplayIdentityTestSchema = `
CREATE TABLE project_display_identities (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  display_kind TEXT NOT NULL,
  provenance TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_display_identity_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  previous_display_kind TEXT,
  display_kind TEXT NOT NULL,
  provenance TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
CREATE TRIGGER project_display_identity_revision_insert
AFTER INSERT ON project_display_identities
BEGIN
  INSERT INTO project_display_identity_revisions (
    project_id, revision, previous_display_kind, display_kind, provenance, recorded_at
  ) VALUES (
    NEW.project_id, NEW.revision, NULL, NEW.display_kind, NEW.provenance, NEW.updated_at
  );
END;`;

const legacyMigration = [
  readWorkspaceFile("packages", "data", "migrations", "0001_core.sql"),
  readWorkspaceFile("packages", "story-core", "migrations", "0001_story_core.sql"),
  readWorkspaceFile("packages", "story-core", "migrations", "0003_ideation.sql"),
].join("\n");
const migration = [legacyMigration, projectDisplayIdentityTestSchema].join("\n");

const NOW = (() => {
  const parsed = parseIsoUtcTimestamp("2026-07-27T00:00:00.000Z");
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
})();
const EMPTY_SHA256 = (() => {
  const parsed = parseContentChecksum(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
})();

const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  for (const executor of executors.splice(0)) {
    await executor.close();
  }
});

describe("SqliteIdeationProjectCommitUnitOfWork", () => {
  it("creates the project, first chapter, outline, formal records, audit, and finalized draft once", async () => {
    const executor = createExecutor();
    const prepared = await prepareDraft(executor, 10, 100);
    const committer = createCommitter(executor, 200);

    const result = await committer.commit(prepared.input);
    expect(result).toEqual({ ok: true, value: undefined });
    await expect(executor.select<{ name: string }>("SELECT name FROM projects")).resolves.toEqual([
      { name: "雾港来信" },
    ]);
    await expect(
      executor.select<{
        projectId: string;
        displayKind: string;
        provenance: string;
        revision: number;
      }>(
        `SELECT project_id AS projectId, display_kind AS displayKind,
                provenance, revision
         FROM project_display_identities`,
      ),
    ).resolves.toEqual([
      {
        projectId: prepared.input.projectId,
        displayKind: "author_work",
        provenance: "explicit_creation",
        revision: 1,
      },
    ]);
    await expect(
      executor.select<{
        projectId: string;
        previousDisplayKind: string | null;
        displayKind: string;
        revision: number;
      }>(
        `SELECT project_id AS projectId, previous_display_kind AS previousDisplayKind,
                display_kind AS displayKind, revision
         FROM project_display_identity_revisions`,
      ),
    ).resolves.toEqual([
      {
        projectId: prepared.input.projectId,
        previousDisplayKind: null,
        displayKind: "author_work",
        revision: 1,
      },
    ]);
    await expect(
      executor.select<{ title: string; content: string }>("SELECT title, content FROM chapters"),
    ).resolves.toEqual([{ title: "第一章", content: "" }]);
    await expect(
      executor.select<{ reason: string; checksum: string }>(
        `SELECT reason, content_checksum AS checksum
         FROM chapter_versions`,
      ),
    ).resolves.toEqual([{ reason: "created", checksum: EMPTY_SHA256 }]);

    const outlineRows = await executor.select<{ snapshot: string }>(
      "SELECT snapshot_json AS snapshot FROM story_outlines",
    );
    expect(
      (JSON.parse(outlineRows[0]?.snapshot ?? "{}") as { nodes?: unknown[] }).nodes,
    ).toHaveLength(3);
    await expect(
      executor.select<{ kind: string; key: string }>(
        `SELECT kind, record_key AS key
         FROM story_formal_records
         ORDER BY kind`,
      ),
    ).resolves.toEqual([
      { kind: "character", key: "ideation.key_characters" },
      { kind: "world_rule", key: "ideation.world_skeleton" },
    ]);
    await expect(
      executor.select<{ action: string; metadata: string }>(
        `SELECT action, metadata_json AS metadata
         FROM local_audit_events`,
      ),
    ).resolves.toEqual([
      {
        action: "create_from_ideation",
        metadata: JSON.stringify({ source: "ideation", mode: "guided" }),
      },
    ]);
    await expect(
      executor.select<{ status: string; projectId: string; revision: number }>(
        `SELECT status, project_id AS projectId, revision
         FROM story_ideation_drafts`,
      ),
    ).resolves.toEqual([
      {
        status: "finalized",
        projectId: prepared.input.projectId,
        revision: prepared.active.revision + 1,
      },
    ]);
  });

  it("rolls every artifact back and preserves the active draft when a middle write fails", async () => {
    const executor = createExecutor();
    const prepared = await prepareDraft(executor, 20, 300);
    const failing = new FailingSqlExecutor(executor, "INSERT INTO story_outlines");
    const committer = createCommitter(failing, 400);

    const result = await committer.commit(prepared.input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM projects"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM chapters"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ status: string; revision: number }>(
        "SELECT status, revision FROM story_ideation_drafts",
      ),
    ).resolves.toEqual([{ status: "active", revision: prepared.active.revision }]);
  });

  it("rejects a stale draft CAS before creating any project rows", async () => {
    const executor = createExecutor();
    const prepared = await prepareDraft(executor, 30, 500);
    const repository = new SqliteIdeationDraftRepository(executor);
    const changed = prepared.active.goToStep({
      step: "genre",
      expectedRevision: prepared.active.revision,
      now: NOW,
    });
    if (!changed.ok) {
      throw changed.error;
    }
    expect((await repository.save(changed.value, prepared.active.revision)).ok).toBe(true);
    const committer = createCommitter(executor, 600);

    const result = await committer.commit(prepared.input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORY_REVISION_CONFLICT" },
    });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM projects"),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("fails closed and rolls the project back when only part of the identity schema exists", async () => {
    const executor = createExecutor();
    await executor.execute("DROP TRIGGER project_display_identity_revision_insert");
    await executor.execute("DROP TABLE project_display_identity_revisions");
    const prepared = await prepareDraft(executor, 40, 700);

    await expect(createCommitter(executor, 800).commit(prepared.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM projects"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM project_display_identities",
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("keeps pre-identity simplified schemas usable when both identity tables are absent", async () => {
    const executor = createExecutor(legacyMigration);
    const prepared = await prepareDraft(executor, 50, 900);

    await expect(createCommitter(executor, 1_000).commit(prepared.input)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM projects"),
    ).resolves.toEqual([{ count: 1 }]);
  });
});

function createExecutor(schema = migration): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(schema);
  executors.push(executor);
  return executor;
}

function createCommitter(
  executor: SqlExecutor,
  idStart: number,
): SqliteIdeationProjectCommitUnitOfWork {
  return new SqliteIdeationProjectCommitUnitOfWork(
    executor,
    new SequenceIds(idStart),
    { now: () => NOW },
    { sha256: () => Promise.resolve({ ok: true, value: EMPTY_SHA256 }) },
  );
}

async function prepareDraft(
  executor: NodeSqliteExecutor,
  draftSequence: number,
  projectSequence: number,
): Promise<
  Readonly<{
    active: IdeationDraft;
    input: Readonly<{
      draft: IdeationDraft;
      expectedDraftRevision: number;
      projectId: ReturnType<typeof storyUuid>;
      seed: ProjectSeed;
    }>;
  }>
> {
  let active = requireDraft(
    IdeationDraft.create({
      id: storyUuid(draftSequence),
      mode: "guided",
      projectName: "雾港来信",
      now: NOW,
    }),
  );
  for (const step of IDEATION_STEP_KEYS) {
    const value = {
      genre: "悬疑幻想",
      target_audience: "偏好成长与谜题的成年读者",
      premise: "失忆邮差每天收到未来寄来的信。",
      protagonist_drive: "找回被自己主动删去的七年记忆",
      world_skeleton: "潮汐决定城市哪些街区能够被看见。",
      key_characters: "邮差林舟、钟表匠阿遥、未来的寄信人",
      plot_route: "追查来信—发现删忆交易—决定是否恢复真相",
      opening_hook: "第一封信准确预告了一个尚未发生的失踪案。",
      output_spec: "目标 320,000 字；克制、带黑色幽默",
    }[step];
    active = requireDraft(
      active.updateStep({
        step,
        value,
        expectedRevision: active.revision,
        now: NOW,
      }),
    );
  }
  const seed = active.buildProjectSeed();
  if (!seed.ok) {
    throw seed.error;
  }
  const projectId = storyUuid(projectSequence);
  const finalized = active.finalize(projectId, active.revision, NOW);
  if (!finalized.ok) {
    throw finalized.error;
  }
  const repository = new SqliteIdeationDraftRepository(executor);
  const created = await repository.create(active);
  if (!created.ok) {
    throw created.error;
  }
  return {
    active,
    input: {
      draft: finalized.value,
      expectedDraftRevision: active.revision,
      projectId,
      seed: seed.value,
    },
  };
}

function requireDraft(result: ReturnType<typeof IdeationDraft.create>): IdeationDraft {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function storyUuid(sequence: number): StoryUuidV7 {
  const parsed = parseStoryUuid(
    `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`,
  );
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

class SequenceIds implements UuidV7Generator {
  private sequence: number;

  public constructor(start: number) {
    this.sequence = start;
  }

  public next(): DomainUuidV7 {
    const parsed = parseDomainUuid(storyUuid(this.sequence));
    this.sequence += 1;
    if (!parsed.ok) {
      throw parsed.error;
    }
    return parsed.value;
  }
}

class FailingSqlExecutor implements SqlExecutor {
  public constructor(
    private readonly delegate: SqlExecutor,
    private readonly failPattern: string,
  ) {}

  public select<Row extends object>(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, bindValues?: readonly SqlPrimitive[]) =>
          transaction.select<Row>(query, bindValues),
        execute: (query: string, bindValues?: readonly SqlPrimitive[]) => {
          if (query.includes(this.failPattern)) {
            throw new Error("Injected ideation write failure.");
          }
          return transaction.execute(query, bindValues);
        },
      }),
    );
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function readWorkspaceFile(...segments: string[]): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, ...segments), "utf8");
}
