import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const unifiedStoryFactsMigration = readFileSync(
  new URL("../migrations/0032_unified_story_facts.sql", import.meta.url),
  "utf8",
);
const aliasResolutionMigration = readFileSync(
  new URL("../migrations/0043_story_fact_entity_alias_resolution.sql", import.meta.url),
  "utf8",
);
const userRevisionMigration = readFileSync(
  new URL("../migrations/0073_story_fact_user_revisions.sql", import.meta.url),
  "utf8",
);
const directLocalAuthorRevisionMigration = readFileSync(
  new URL("../migrations/0076_direct_local_story_fact_author_revision.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "project-direct-local";
const CHAPTER_ID = "chapter-direct-local";
const VERSION_ID = "version-direct-local";
const ACTOR_ID = "author-direct-local";
const CREATED_AT = "2026-08-23T00:00:00.000Z";
const UPDATED_AT = "2026-08-23T00:01:00.000Z";
const CONTENT = "周望五十七岁。";
const DIRECT_REFERENCE = "direct-local:inkshadow.direct-local-story-fact.v1:0123456789abcdef";
const DIRECT_VALUE = JSON.stringify({
  schemaVersion: "inkshadow.rebuildable-system-fact.v1",
  payload: {
    schemaVersion: "inkshadow.direct-local-story-fact.v1",
    kind: "character_profile",
    age: 57,
  },
});
const AMBIGUOUS_ALIAS_VALUE = JSON.stringify({
  schemaVersion: "inkshadow.continuous-story-state.v1",
  subject: {
    entityKey: "character.linzhou.distinct",
    displayName: "林舟",
    mergeStatus: "ambiguous_confirmed_alias",
    matchedEntityKeys: ["character.linzhou.older", "character.linzhou.younger"],
  },
  attributeKey: "location",
  valueText: "旧宅",
});
const RESOLVED_ALIAS_VALUE = JSON.stringify({
  schemaVersion: "inkshadow.continuous-story-state.v1",
  subject: {
    entityKey: "character.linzhou.younger",
    displayName: "林舟",
    mergeStatus: "human_resolved_existing_entity",
    matchedEntityKeys: ["character.linzhou.younger"],
  },
  attributeKey: "location",
  valueText: "旧宅",
});
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("0076 direct-local story fact author revision migration", () => {
  it("allows the author to revise only a pending direct-local fact and preserves its locator", async () => {
    const executor = createExecutor();
    await insertPendingFact(executor, "fact-allowed");

    await expect(
      authorRevision(executor, "fact-allowed", "周望五十八岁。", 1),
    ).resolves.toBeDefined();

    await expect(
      executor.select<{
        content_text: string;
        value_json: string | null;
        evidence_reference: string;
        source_chapter_id: string;
        source_version_id: string;
        source_start_offset: number;
        source_end_offset: number;
        source_length: number;
        source_excerpt: string;
        status: string;
        origin: string;
        revision: number;
      }>(
        `SELECT content_text, value_json, evidence_reference, source_chapter_id,
                source_version_id, source_start_offset, source_end_offset,
                source_length, source_excerpt, status, origin, revision
         FROM story_facts WHERE id = 'fact-allowed'`,
      ),
    ).resolves.toEqual([
      {
        content_text: "周望五十八岁。",
        value_json: null,
        evidence_reference: DIRECT_REFERENCE,
        source_chapter_id: CHAPTER_ID,
        source_version_id: VERSION_ID,
        source_start_offset: 0,
        source_end_offset: CONTENT.length,
        source_length: CONTENT.length,
        source_excerpt: CONTENT,
        status: "formal",
        origin: "user",
        revision: 2,
      },
    ]);

    const revisions = await executor.select<{ revision: number; snapshot_json: string }>(
      `SELECT revision, snapshot_json
       FROM story_fact_revisions
       WHERE fact_id = 'fact-allowed'
       ORDER BY revision`,
    );
    expect(revisions).toHaveLength(2);
    expect(JSON.parse(revisions[0]?.snapshot_json ?? "null")).toMatchObject({
      structuredValue: JSON.parse(DIRECT_VALUE),
      source: {
        reference: DIRECT_REFERENCE,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        startOffset: 0,
        endOffset: CONTENT.length,
      },
      revision: 1,
    });
    expect(JSON.parse(revisions[1]?.snapshot_json ?? "null")).toMatchObject({
      contentText: "周望五十八岁。",
      structuredValue: null,
      source: {
        reference: DIRECT_REFERENCE,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        startOffset: 0,
        endOffset: CONTENT.length,
      },
      status: "formal",
      origin: "user",
      revision: 2,
    });
  });

  it("continues to reject non-local and ordinary structured facts", async () => {
    const executor = createExecutor();
    await insertPendingFact(executor, "fact-non-local", {
      reference: "chapter:ordinary-local-parser",
    });
    await insertPendingFact(executor, "fact-ordinary-structured", {
      valueJson: JSON.stringify({ schemaVersion: "ordinary-structured-fact.v1" }),
    });

    await expect(authorRevision(executor, "fact-non-local", "不应被接受。", 1)).rejects.toThrow();
    await expect(
      authorRevision(executor, "fact-ordinary-structured", "不应被接受。", 1),
    ).rejects.toThrow();
  });

  it("preserves the released plain author revision and alias resolution branches", async () => {
    const executor = createExecutor();
    await insertPlainFormalFact(executor, "fact-plain-author-edit");
    await executor.execute(
      `UPDATE story_facts
       SET content_text = '作者修改后的普通设定。', confidence = 1.0,
           origin = 'user', status = 'formal', user_confirmed = 1,
           locked = 0, deprecated = 0, needs_review = 0,
           confirmed_by_actor_id = ?, confirmed_at = ?, revision = 2, updated_at = ?
       WHERE id = 'fact-plain-author-edit' AND revision = 1`,
      [ACTOR_ID, UPDATED_AT, UPDATED_AT],
    );

    await insertAmbiguousAliasFact(executor, "fact-alias-resolution");
    await executor.execute(
      `UPDATE story_facts
       SET value_json = ?, revision = 2, updated_at = ?
       WHERE id = 'fact-alias-resolution' AND revision = 1`,
      [RESOLVED_ALIAS_VALUE, UPDATED_AT],
    );

    const rows = await executor.select<{
      id: string;
      contentText: string;
      valueJson: string | null;
      revision: number;
    }>(
      `SELECT id, content_text AS contentText, value_json AS valueJson, revision
       FROM story_facts
       WHERE id IN ('fact-plain-author-edit', 'fact-alias-resolution')
       ORDER BY id`,
    );
    expect(rows[0]).toEqual({
      id: "fact-alias-resolution",
      contentText: "林舟回到旧宅。",
      valueJson: RESOLVED_ALIAS_VALUE,
      revision: 2,
    });
    expect(rows[1]).toEqual({
      id: "fact-plain-author-edit",
      contentText: "作者修改后的普通设定。",
      valueJson: null,
      revision: 2,
    });
  });

  it("continues to reject formal and locked structured facts", async () => {
    const executor = createExecutor();
    await insertFormalFact(executor, "fact-formal", false);
    await insertFormalFact(executor, "fact-locked", true);

    await expect(authorRevision(executor, "fact-formal", "不应原地改写。", 2)).rejects.toThrow();
    await expect(authorRevision(executor, "fact-locked", "不应绕过固定。", 2)).rejects.toThrow();
  });

  it("continues to reject evidence and identity changes", async () => {
    const executor = createExecutor();
    await insertPendingFact(executor, "fact-evidence");
    await insertPendingFact(executor, "fact-identity");

    await expect(
      executor.execute(
        `${authorRevisionSql("evidence_reference = 'direct-local:inkshadow.direct-local-story-fact.v1:forged',")}
         AND id = 'fact-evidence'`,
        ["证据不应改变。", ACTOR_ID, UPDATED_AT, UPDATED_AT],
      ),
    ).rejects.toThrow(/identity and evidence are immutable/u);
    await expect(
      executor.execute(
        `${authorRevisionSql("fact_type = 'world_rule',")}
         AND id = 'fact-identity'`,
        ["身份不应改变。", ACTOR_ID, UPDATED_AT, UPDATED_AT],
      ),
    ).rejects.toThrow(/identity and evidence are immutable/u);
    await expect(
      executor.select<{ id: string; revision: number }>(
        `SELECT id, revision FROM story_facts
         WHERE id IN ('fact-evidence', 'fact-identity') ORDER BY id`,
      ),
    ).resolves.toEqual([
      { id: "fact-evidence", revision: 1 },
      { id: "fact-identity", revision: 1 },
    ]);
  });
});

function createExecutor(): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE chapter_versions (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id) VALUES ('${PROJECT_ID}');
    INSERT INTO chapters (id, project_id) VALUES ('${CHAPTER_ID}', '${PROJECT_ID}');
    INSERT INTO chapter_versions (id, project_id, chapter_id)
      VALUES ('${VERSION_ID}', '${PROJECT_ID}', '${CHAPTER_ID}');
    ${unifiedStoryFactsMigration}
    ${aliasResolutionMigration}
    ${userRevisionMigration}
    ${directLocalAuthorRevisionMigration}
  `);
  executors.push(executor);
  return executor;
}

async function insertPendingFact(
  executor: NodeSqliteExecutor,
  id: string,
  overrides: Readonly<{ reference?: string; valueJson?: string }> = {},
): Promise<void> {
  const reference = overrides.reference ?? DIRECT_REFERENCE;
  const valueJson = overrides.valueJson ?? DIRECT_VALUE;
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json, source_kind,
       evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'character_profile', ?, ?, 'chapter_span', ?, ?, ?,
       0, ?, ?, ?, NULL, NULL, NULL, 1.0, 'unconfirmed', 'system',
       0, 0, 0, 1, NULL, NULL, 1, ?, ?
     )`,
    [
      id,
      PROJECT_ID,
      CONTENT,
      valueJson,
      reference,
      CHAPTER_ID,
      VERSION_ID,
      CONTENT.length,
      CONTENT.length,
      CONTENT,
      CREATED_AT,
      CREATED_AT,
    ],
  );
  await insertInitialRevision(executor, id, reference, valueJson, 1);
}

async function insertFormalFact(
  executor: NodeSqliteExecutor,
  id: string,
  locked: boolean,
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json, source_kind,
       evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'character_profile', ?, ?, 'chapter_span', ?, ?, ?,
       0, ?, ?, ?, NULL, NULL, NULL, 1.0, 'formal', 'user',
       1, ?, 0, 0, ?, ?, 2, ?, ?
     )`,
    [
      id,
      PROJECT_ID,
      CONTENT,
      DIRECT_VALUE,
      DIRECT_REFERENCE,
      CHAPTER_ID,
      VERSION_ID,
      CONTENT.length,
      CONTENT.length,
      CONTENT,
      locked ? 1 : 0,
      ACTOR_ID,
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    ],
  );
  await insertInitialRevision(executor, id, DIRECT_REFERENCE, DIRECT_VALUE, 2);
}

async function insertPlainFormalFact(executor: NodeSqliteExecutor, id: string): Promise<void> {
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json, source_kind,
       evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'world_rule', '普通作者设定。', NULL, 'user_statement',
       'user-statement:plain-author-edit', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0.8, 'formal', 'user',
       1, 0, 0, 0, ?, ?, 1, ?, ?
     )`,
    [id, PROJECT_ID, ACTOR_ID, CREATED_AT, CREATED_AT, CREATED_AT],
  );
}

async function insertAmbiguousAliasFact(executor: NodeSqliteExecutor, id: string): Promise<void> {
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json, source_kind,
       evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'character_state', '林舟回到旧宅。', ?, 'system_derivation',
       'alias-resolution:released-branch', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0.82, 'unconfirmed', 'ai_extraction',
       0, 0, 0, 1, NULL, NULL, 1, ?, ?
     )`,
    [id, PROJECT_ID, AMBIGUOUS_ALIAS_VALUE, CREATED_AT, CREATED_AT],
  );
}

function insertInitialRevision(
  executor: NodeSqliteExecutor,
  id: string,
  reference: string,
  valueJson: string,
  revision: number,
): Promise<unknown> {
  return executor.execute(
    `INSERT INTO story_fact_revisions (
       fact_id, project_id, revision, change_kind, recorded_at, snapshot_json
     ) VALUES (?, ?, ?, 'created', ?, ?)`,
    [
      id,
      PROJECT_ID,
      revision,
      CREATED_AT,
      JSON.stringify({
        structuredValue: JSON.parse(valueJson),
        source: {
          reference,
          chapterId: CHAPTER_ID,
          versionId: VERSION_ID,
          startOffset: 0,
          endOffset: CONTENT.length,
        },
        revision,
      }),
    ],
  );
}

function authorRevision(
  executor: NodeSqliteExecutor,
  id: string,
  contentText: string,
  currentRevision: number,
): Promise<unknown> {
  return executor.execute(
    `${authorRevisionSql()}
     AND id = ? AND revision = ?`,
    [contentText, ACTOR_ID, UPDATED_AT, UPDATED_AT, id, currentRevision],
  );
}

function authorRevisionSql(extraAssignment = ""): string {
  return `UPDATE story_facts SET
    ${extraAssignment}
    content_text = ?,
    value_json = NULL,
    confidence = 1.0,
    status = 'formal',
    origin = 'user',
    user_confirmed = 1,
    locked = 0,
    deprecated = 0,
    needs_review = 0,
    confirmed_by_actor_id = ?,
    confirmed_at = ?,
    revision = revision + 1,
    updated_at = ?
  WHERE 1 = 1`;
}
