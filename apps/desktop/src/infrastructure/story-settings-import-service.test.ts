import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import { parseContentChecksum } from "@inkshadow/domain";
import { createStorySettingsTemplate } from "@inkshadow/import-export";
import {
  FormalStoryRecord,
  StoryFact,
  insertFormalRecord,
  insertNewStoryFact,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { StorySettingsImportService } from "./story-settings-import-service";

const NOW = "2026-08-09T10:00:00.000Z";
const LATER = "2026-08-09T10:01:00.000Z";
const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const migration = [
  readMigration("0001_core.sql"),
  readWorkspaceFile("packages", "story-core", "migrations", "0001_story_core.sql"),
  readMigration("0032_unified_story_facts.sql"),
  readMigration("0058_story_settings_import_receipts.sql"),
].join("\n");

describe("StorySettingsImportService", () => {
  it.each(["archived", "trashed", "missing"] as const)(
    "fails closed before writing when the authoritative project is %s",
    async (status) => {
      const executor = await createExecutor();
      await makeProjectUnavailable(executor, status);

      await expect(createService(executor).import(importCommand())).rejects.toMatchObject({
        code: "STORY_SETTINGS_PROJECT_NOT_ACTIVE",
      });
      await expect(countRows(executor, "story_formal_records")).resolves.toBe(0);
      await expect(countRows(executor, "story_facts")).resolves.toBe(0);
      await expect(countRows(executor, "story_settings_import_receipts")).resolves.toBe(0);
      await executor.close();
    },
  );

  it.each(["archived", "trashed", "missing"] as const)(
    "fails closed before undo when the authoritative project is %s",
    async (status) => {
      const executor = await createExecutor();
      const service = createService(executor);
      const receipt = await service.import(importCommand());
      if (status !== "missing") await makeProjectUnavailable(executor, status);
      const requestedProjectId = status === "missing" ? uuid(9_999) : PROJECT_ID;

      await expect(
        service.undo({
          receiptId: receipt.id,
          projectId: requestedProjectId,
          actorId: ACTOR_ID,
          humanConfirmed: true,
        }),
      ).rejects.toMatchObject({ code: "STORY_SETTINGS_PROJECT_NOT_ACTIVE" });
      await expect(countRows(executor, "story_formal_records")).resolves.toBe(3);
      await expect(countRows(executor, "story_facts")).resolves.toBe(2);
      const rows = await executor.select<{ status: string }>(
        "SELECT status FROM story_settings_import_receipts WHERE id = ?",
        [receipt.id],
      );
      expect(rows[0]?.status).toBe("committed");
      await executor.close();
    },
  );

  it("lists a bounded set of strict receipts in newest-first order", async () => {
    const executor = await createExecutor();
    const template = createStorySettingsTemplate();
    const first = await createService(executor).import({
      ...importCommand(),
      operationId: uuid(71),
      bundle: {
        ...template,
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
    });
    const second = await createService(executor, 700, LATER).import({
      ...importCommand(),
      operationId: uuid(72),
      bundle: {
        ...template,
        characters: [],
        relationships: [],
        worldRules: [],
        writingPreferences: [{ id: "preference.second", content: "保持场景推进。" }],
      },
    });

    const recent = await createService(executor, 800).listRecentReceipts(PROJECT_ID, 1);
    expect(recent).toEqual([expect.objectContaining({ id: second.id, idempotentReplay: false })]);
    expect(recent[0]?.createdAt).toBe(LATER);
    expect(recent[0]?.id).not.toBe(first.id);
    await expect(createService(executor).listRecentReceipts(PROJECT_ID, 51)).rejects.toMatchObject({
      code: "STORY_SETTINGS_INVALID",
    });
    await executor.close();
  });

  it("atomically imports the strict bundle and replays the same source without duplicates", async () => {
    const executor = await createExecutor();
    const service = createService(executor);
    const command = importCommand();

    const receipt = await service.import(command);
    const replay = await service.import(command);

    expect(receipt).toMatchObject({
      status: "committed",
      importedCount: 5,
      skippedCount: 0,
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({ id: command.operationId, idempotentReplay: true });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(3);
    await expect(countRows(executor, "story_facts")).resolves.toBe(2);
    await expect(countRows(executor, "story_fact_revisions")).resolves.toBe(2);
    await expect(countRows(executor, "story_settings_import_receipts")).resolves.toBe(1);
    await executor.close();
  });

  it("rolls every entity back when a later relationship insert fails", async () => {
    const base = await createExecutor();
    const executor = new FailMatchingExecutor(base, "INSERT INTO story_facts");
    const service = createService(executor);

    await expect(service.import(importCommand())).rejects.toMatchObject({
      code: "STORY_SETTINGS_IMPORT_FAILED",
      retryable: true,
    });
    await expect(countRows(base, "story_formal_records")).resolves.toBe(0);
    await expect(countRows(base, "story_facts")).resolves.toBe(0);
    await expect(countRows(base, "story_settings_import_receipts")).resolves.toBe(0);
    await base.close();
  });

  it("requires an explicit per-item choice for an existing character name", async () => {
    const executor = await createExecutor();
    const first = createService(executor);
    const template = createStorySettingsTemplate();
    const firstCharacter = requireAt(template.characters, 0, "template character");
    await first.import({
      ...importCommand(),
      operationId: uuid(300),
      bundle: {
        ...template,
        characters: [firstCharacter],
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
    });

    const second = createService(executor, 500);
    await expect(
      second.import({
        ...importCommand(),
        operationId: uuid(700),
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_CONFLICT_UNRESOLVED" });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(1);
    await expect(countRows(executor, "story_settings_import_receipts")).resolves.toBe(1);
    await executor.close();
  });

  it("can merge a confirmed conflict and later undo the complete import safely", async () => {
    const executor = await createExecutor();
    const template = createStorySettingsTemplate();
    const firstCharacter = requireAt(template.characters, 0, "template character");
    const seed = createService(executor);
    const seeded = await seed.import({
      ...importCommand(),
      operationId: uuid(301),
      bundle: {
        ...template,
        characters: [firstCharacter],
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
    });
    const existingId = seeded.createdRecordIds[0];
    if (existingId === undefined) throw new Error("Expected seeded character.");

    const service = createService(executor, 600, LATER);
    const enrichedTemplate = {
      ...template,
      characters: template.characters.map((character) =>
        character.id === "character.gugu"
          ? { ...character, currentGoal: "先保护丹丹，再查明秘密" }
          : character,
      ),
    };
    const receipt = await service.import({
      ...importCommand(),
      operationId: uuid(800),
      bundle: enrichedTemplate,
      resolutions: {
        characters: {
          "character.gugu": {
            action: "merge",
            existingRecordId: existingId,
            expectedRevision: 1,
            expectedCurrentVersion: 1,
          },
        },
      },
    });
    expect(receipt.updatedRecordFences).toHaveLength(1);
    expect(receipt.createdRecordIds).toHaveLength(2);

    const undone = await service.undo({
      receiptId: receipt.id,
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      humanConfirmed: true,
    });
    expect(undone.status).toBe("undone");
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(1);
    await expect(countRows(executor, "story_facts")).resolves.toBe(0);
    const rows = await executor.select<{ revision: number; current_version: number }>(
      "SELECT revision, current_version FROM story_formal_records WHERE id = ?",
      [existingId],
    );
    expect(rows[0]).toEqual({ revision: 3, current_version: 3 });
    await executor.close();
  });

  it("refuses to erase imported entities after they were edited", async () => {
    const executor = await createExecutor();
    const service = createService(executor);
    const receipt = await service.import(importCommand());
    const recordId = receipt.createdRecordIds[0];
    if (recordId === undefined) throw new Error("Expected imported record.");
    await executor.execute(
      "UPDATE story_formal_records SET revision = 2, current_version = 2 WHERE id = ?",
      [recordId],
    );

    await expect(
      service.undo({
        receiptId: receipt.id,
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_UNDO_CONFLICT" });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(3);
    await executor.close();
  });

  it("binds idempotency to the exact operation request and rejects stale conflict fences", async () => {
    const executor = await createExecutor();
    const template = createStorySettingsTemplate();
    const firstCharacter = requireAt(template.characters, 0, "template character");
    const seed = createService(executor);
    const baseBundle = {
      ...template,
      characters: [firstCharacter],
      relationships: [],
      worldRules: [],
      writingPreferences: [],
    };
    const seeded = await seed.import({
      ...importCommand(),
      operationId: uuid(310),
      bundle: baseBundle,
    });
    const existingId = seeded.createdRecordIds[0];
    if (existingId === undefined) throw new Error("Expected seeded record.");

    await expect(
      seed.import({
        ...importCommand(),
        operationId: uuid(310),
        bundle: { ...baseBundle, worldRules: template.worldRules },
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_CONFLICT_CHANGED" });

    const enrichedBundle = {
      ...baseBundle,
      characters: [{ ...firstCharacter, currentGoal: "第一次更新" }],
    };
    await createService(executor, 900, LATER).import({
      ...importCommand(),
      operationId: uuid(311),
      bundle: enrichedBundle,
      resolutions: {
        characters: {
          "character.gugu": {
            action: "use_import",
            existingRecordId: existingId,
            expectedRevision: 1,
            expectedCurrentVersion: 1,
          },
        },
      },
    });
    await expect(
      createService(executor, 950, LATER).import({
        ...importCommand(),
        operationId: uuid(312),
        bundle: {
          ...baseBundle,
          characters: [{ ...firstCharacter, currentGoal: "陈旧确认不应覆盖" }],
        },
        resolutions: {
          characters: {
            "character.gugu": {
              action: "use_import",
              existingRecordId: existingId,
              expectedRevision: 1,
              expectedCurrentVersion: 1,
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_CONFLICT_CHANGED" });
    await executor.close();
  });

  it("preserves portable relationship evidence and writing preference source", async () => {
    const executor = await createExecutor();
    const template = createStorySettingsTemplate();
    const firstRelationship = requireAt(template.relationships, 0, "template relationship");
    const firstPreference = requireAt(
      template.writingPreferences,
      0,
      "template writing preference",
    );
    await createService(executor).import({
      ...importCommand(),
      bundle: {
        ...template,
        relationships: [{ ...firstRelationship, evidence: "第一章中两人牵手。" }],
        writingPreferences: [{ ...firstPreference, source: "作者导入的写作约定" }],
      },
    });
    const rows = await executor.select<{ fact_type: string; value_json: string }>(
      "SELECT fact_type, value_json FROM story_facts ORDER BY fact_type ASC",
    );
    expect(rows.map(({ value_json }) => parseJson(value_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidence: "第一章中两人牵手。" }),
        expect.objectContaining({ source: "作者导入的写作约定" }),
      ]),
    );
    await executor.close();
  });

  it("blocks undo when a later review item references an imported record", async () => {
    const executor = await createExecutor();
    const service = createService(executor);
    const receipt = await service.import(importCommand());
    const recordId = receipt.createdRecordIds[0];
    if (recordId === undefined) throw new Error("Expected imported record.");
    await executor.execute(
      `INSERT INTO story_review_items (
         id, project_id, item_type, status, revision, target_record_id,
         source_chapter_id, source_version_id, deferred_until,
         created_at, updated_at, snapshot_json
       ) VALUES (?, ?, 'extraction', 'pending', 1, ?, ?, ?, NULL, ?, ?, '{}')`,
      [uuid(980), PROJECT_ID, recordId, uuid(981), uuid(982), LATER, LATER],
    );

    await expect(
      service.undo({
        receiptId: receipt.id,
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_UNDO_CONFLICT" });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(3);
    const statuses = await executor.select<{ status: string }>(
      "SELECT status FROM story_settings_import_receipts WHERE id = ?",
      [receipt.id],
    );
    expect(statuses[0]?.status).toBe("committed");
    await executor.close();
  });

  it("rejects malformed receipt arrays at the database boundary", async () => {
    const executor = await createExecutor();
    await expect(
      executor.execute(
        `INSERT INTO story_settings_import_receipts (
           id, project_id, source_sha256, request_sha256, status,
           created_record_ids_json, updated_record_fences_json,
           created_fact_ids_json, created_memory_ids_json,
           imported_count, skipped_count, created_at, undone_at
         ) VALUES (?, ?, ?, ?, 'committed', '{', '[]', '[]', '[]', 0, 0, ?, NULL)`,
        [uuid(990), PROJECT_ID, "a".repeat(64), "b".repeat(64), NOW],
      ),
    ).rejects.toBeDefined();
    await executor.close();
  });

  it("matches imported character names and aliases against existing names and aliases", async () => {
    const executor = await createExecutor();
    const template = createStorySettingsTemplate();
    const firstCharacter = requireAt(template.characters, 0, "template character");
    const seeded = await createService(executor).import({
      ...importCommand(),
      operationId: uuid(1100),
      bundle: {
        ...template,
        characters: [{ ...firstCharacter, name: "林舟", aliases: ["顾顾"] }],
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
    });
    const existingId = requireAt(seeded.createdRecordIds, 0, "seeded character id");

    const receipt = await createService(executor, 1200).import({
      ...importCommand(),
      operationId: uuid(1201),
      bundle: {
        ...template,
        characters: [firstCharacter],
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
      resolutions: {
        characters: {
          [firstCharacter.id]: {
            action: "keep_current",
            existingRecordId: existingId,
            expectedRevision: 1,
            expectedCurrentVersion: 1,
          },
        },
      },
    });

    expect(receipt).toMatchObject({ importedCount: 0, skippedCount: 1 });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(1);
    await executor.close();
  });

  it("fails closed when one imported character matches multiple existing aliases", async () => {
    const executor = await createExecutor();
    await insertCharacterFixture(executor, uuid(1300), "林舟", ["小舟"]);
    await insertCharacterFixture(executor, uuid(1301), "旧王子", ["小舟"]);
    const template = createStorySettingsTemplate();
    const firstCharacter = requireAt(template.characters, 0, "template character");

    await expect(
      createService(executor, 1310).import({
        ...importCommand(),
        operationId: uuid(1311),
        bundle: {
          ...template,
          characters: [{ ...firstCharacter, name: "小舟", aliases: [] }],
          relationships: [],
          worldRules: [],
          writingPreferences: [],
        },
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_CONFLICT_CHANGED" });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(2);
    await executor.close();
  });

  it("allocates deterministic unique names for repeated imported copies", async () => {
    const executor = await createExecutor();
    const template = createStorySettingsTemplate();
    const firstCharacter = requireAt(template.characters, 0, "template character");
    const seeded = await createService(executor).import({
      ...importCommand(),
      operationId: uuid(1400),
      bundle: {
        ...template,
        characters: [firstCharacter],
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
    });
    const existingId = requireAt(seeded.createdRecordIds, 0, "seeded character id");
    const copyCommand = (operationId: string) => ({
      ...importCommand(),
      operationId,
      bundle: {
        ...template,
        characters: [firstCharacter],
        relationships: [],
        worldRules: [],
        writingPreferences: [],
      },
      resolutions: {
        characters: {
          [firstCharacter.id]: {
            action: "new_copy" as const,
            existingRecordId: existingId,
          },
        },
      },
    });
    await createService(executor, 1410).import(copyCommand(uuid(1411)));
    await createService(executor, 1420).import(copyCommand(uuid(1421)));

    const rows = await executor.select<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM story_formal_records ORDER BY created_at ASC, id ASC",
    );
    const values = rows.map(({ snapshot_json }) => currentFormalValue(snapshot_json));
    expect(values.map((value) => storyString(value, "name"))).toEqual([
      "顾顾",
      "顾顾（导入副本）",
      "顾顾（导入副本）（2）",
    ]);
    await executor.close();
  });

  it("traces a legacy repair source and rejects a second superseding relationship", async () => {
    const executor = await createExecutor();
    const source = { kind: "fact" as const, sourceId: uuid(1500), expectedRevision: 1 };
    const first = await createService(executor, 1510).import({
      ...importCommand(),
      operationId: uuid(1511),
      legacyRepairSource: source,
    });
    const facts = await executor.select<{ value_json: string }>(
      "SELECT value_json FROM story_facts WHERE fact_type = 'core_relationship'",
    );
    expect(parseJson(requireAt(facts, 0, "relationship row").value_json)).toMatchObject({
      legacyRepair: {
        schemaVersion: "inkshadow.legacy-relationship-repair.v1",
        supersedesKind: "fact",
        supersedesSourceId: source.sourceId,
        expectedSourceRevision: 1,
      },
    });
    await expect(
      createService(executor, 1550).findLegacyRepairRelationship({
        projectId: PROJECT_ID,
        source: { ...source, expectedRevision: 2 },
      }),
    ).resolves.toEqual({
      relationshipFactId: first.createdFactIds[0],
      expectedSourceRevision: 1,
    });
    await expect(
      createService(executor, 1600).import({
        ...importCommand(),
        operationId: uuid(1601),
        legacyRepairSource: { ...source, expectedRevision: 2 },
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_CONFLICT_CHANGED" });
    expect(first.createdFactIds).toHaveLength(2);
    await expect(countRows(executor, "story_facts")).resolves.toBe(2);
    await executor.close();
  });

  it("rejects malformed legacy repair metadata before writing", async () => {
    const executor = await createExecutor();
    await expect(
      createService(executor).import({
        ...importCommand(),
        legacyRepairSource: { kind: "record", sourceId: uuid(1700), expectedRevision: 0 },
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_INVALID" });
    await expect(countRows(executor, "story_formal_records")).resolves.toBe(0);
    await executor.close();
  });

  it("blocks receipt undo after the superseded legacy fact was deprecated", async () => {
    const executor = await createExecutor();
    const sourceId = uuid(1800);
    const source = StoryFact.create({
      id: sourceId,
      projectId: PROJECT_ID,
      factType: "relationship",
      contentText: "人物关系：青梅竹马",
      source: { kind: "user_statement", reference: "guided-opening:test" },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: NOW,
    });
    if (!source.ok) throw source.error;
    await insertNewStoryFact(executor, source.value);
    const service = createService(executor, 1810);
    const receipt = await service.import({
      ...importCommand(),
      operationId: uuid(1811),
      legacyRepairSource: { kind: "fact", sourceId, expectedRevision: 1 },
    });
    await executor.execute(
      "UPDATE story_facts SET deprecated = 1, status = 'deprecated', revision = 2 WHERE id = ?",
      [sourceId],
    );

    await expect(
      service.undo({
        receiptId: receipt.id,
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "STORY_SETTINGS_UNDO_CONFLICT" });
    await expect(countRows(executor, "story_facts")).resolves.toBe(3);
    await executor.close();
  });
});

function importCommand() {
  return {
    operationId: uuid(100),
    projectId: PROJECT_ID,
    actorId: ACTOR_ID,
    bundle: createStorySettingsTemplate(),
    humanConfirmed: true,
  } as const;
}

function createService(executor: SqlExecutor, start = 200, now = NOW) {
  let cursor = start;
  return new StorySettingsImportService({
    executor,
    ids: { next: () => uuid(cursor++) },
    clock: { now: () => now },
    hasher: {
      sha256: (value: string) =>
        Promise.resolve(
          parseContentChecksum(createHash("sha256").update(value, "utf8").digest("hex")),
        ),
    },
  });
}

function requireAt<Value>(values: readonly Value[], index: number, label: string): Value {
  const value = values[index];
  if (value === undefined) throw new Error(`Expected ${label} at index ${String(index)}.`);
  return value;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

async function createExecutor(): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(migration);
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Story Settings Test', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [PROJECT_ID, NOW, NOW],
  );
  return executor;
}

async function countRows(executor: SqlExecutor, table: string): Promise<number> {
  const rows = await executor.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return rows[0]?.count ?? -1;
}

async function makeProjectUnavailable(
  executor: SqlExecutor,
  status: "archived" | "trashed" | "missing",
): Promise<void> {
  if (status === "missing") {
    await executor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);
    return;
  }
  if (status === "archived") {
    await executor.execute(
      `UPDATE projects
       SET status = 'archived', revision = revision + 1, updated_at = ?, archived_at = ?
       WHERE id = ?`,
      [LATER, LATER, PROJECT_ID],
    );
    return;
  }
  await executor.execute(
    `UPDATE projects
     SET status = 'trashed', revision = revision + 1, deletion_generation = 1,
         updated_at = ?, trashed_at = ?, retention_until = ?, status_before_trash = 'active'
     WHERE id = ?`,
    [LATER, LATER, "2026-09-08T10:01:00.000Z", PROJECT_ID],
  );
}

async function insertCharacterFixture(
  executor: NodeSqliteExecutor,
  id: string,
  name: string,
  aliases: readonly string[],
): Promise<void> {
  const created = FormalStoryRecord.create({
    id,
    projectId: PROJECT_ID,
    kind: "character",
    recordKey: `character.fixture.${id.replaceAll("-", "")}`,
    value: { schemaVersion: "inkshadow.character-setting.v1", name, aliases },
    actorId: ACTOR_ID,
    humanConfirmed: true,
    now: NOW,
  });
  if (!created.ok) throw created.error;
  await insertFormalRecord(executor, created.value);
}

function currentFormalValue(snapshotJson: string): unknown {
  const snapshot = parseJson(snapshotJson);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const record = snapshot as Readonly<Record<string, unknown>>;
  const versions: readonly unknown[] = Array.isArray(record.versions) ? record.versions : [];
  const current = versions.find(
    (version) =>
      typeof version === "object" &&
      version !== null &&
      !Array.isArray(version) &&
      (version as Readonly<Record<string, unknown>>).version === record.currentVersion,
  );
  return typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Readonly<Record<string, unknown>>).value
    : null;
}

function storyString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function readMigration(name: string): string {
  return readWorkspaceFile("packages", "data", "migrations", name);
}

function readWorkspaceFile(...segments: readonly string[]): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) throw new Error("InkShadow workspace root could not be located.");
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, ...segments), "utf8");
}

function uuid(value: number): string {
  return `019fa700-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

class FailMatchingExecutor implements SqlExecutor {
  private failed = false;

  public constructor(
    private readonly delegate: NodeSqliteExecutor,
    private readonly queryFragment: string,
  ) {}

  public select<Row extends object>(
    query: string,
    values?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, values);
  }

  public execute(query: string, values?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.delegate.execute(query, values);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, values?: readonly SqlPrimitive[]) =>
          transaction.select<Row>(query, values),
        execute: (query: string, values?: readonly SqlPrimitive[]) => {
          if (!this.failed && query.includes(this.queryFragment)) {
            this.failed = true;
            return Promise.reject(new Error("injected Story Settings write failure"));
          }
          return transaction.execute(query, values);
        },
      }),
    );
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}
