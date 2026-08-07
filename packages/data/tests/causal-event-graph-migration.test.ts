import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0033_causal_event_graph.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const RELATION_KINDS = [
  "causes",
  "depends_on",
  "prevents",
  "reveals",
  "misleads",
  "before",
  "changes_state",
  "gains_information",
  "loses_item",
] as const;
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  for (const executor of executors.splice(0)) {
    await executor.close();
  }
});

describe("causal event graph migration", () => {
  it("is idempotent and stores every evidence-backed event component", async () => {
    const executor = createExecutor();

    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();
    const tables = await executor.select<{ readonly name: string }>(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'causal_%'
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "causal_event_character_changes",
      "causal_event_foreshadow_progress",
      "causal_event_informed_characters",
      "causal_event_item_changes",
      "causal_event_participants",
      "causal_event_prerequisites",
      "causal_event_relations",
      "causal_event_relationship_changes",
      "causal_events",
      "causal_evidence_sources",
    ]);
    expect(
      await executor.select<{ readonly name: string }>(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'view' AND name = 'causal_event_downstream_impacts'`,
      ),
    ).toEqual([{ name: "causal_event_downstream_impacts" }]);

    seedProjectAndChapter(executor);
    insertEvidence(executor, "evidence-main", "chapter-one", "version-one");
    insertEvent(executor, "event-a", "main", 1, "evidence-main");
    insertEvent(executor, "event-b", "main", 2, "evidence-main");

    executor.database
      .prepare(
        `INSERT INTO causal_event_participants (
           event_id, project_id, branch_id, character_id
         ) VALUES ('event-a', ?, 'main', 'character-hero')`,
      )
      .run(PROJECT_ID);
    executor.database
      .prepare(
        `INSERT INTO causal_event_prerequisites (
           id, event_id, project_id, branch_id, prerequisite_kind,
           reference_id, referenced_event_id, description, evidence_id
         ) VALUES (
           'prerequisite-a', 'event-b', ?, 'main', 'event',
           'event-a', 'event-a', 'Event A must happen first.', 'evidence-main'
         )`,
      )
      .run(PROJECT_ID);
    executor.database
      .prepare(
        `INSERT INTO causal_event_character_changes (
           id, event_id, project_id, branch_id, character_id, attribute_key,
           before_value_json, after_value_json, evidence_id
         ) VALUES (
           'character-change-a', 'event-a', ?, 'main', 'character-hero', 'location',
           '"outside"', '"inside"', 'evidence-main'
         )`,
      )
      .run(PROJECT_ID);
    executor.database
      .prepare(
        `INSERT INTO causal_event_relationship_changes (
           id, event_id, project_id, branch_id, from_character_id, to_character_id,
           relationship_key, before_value_json, after_value_json, evidence_id
         ) VALUES (
           'relationship-change-a', 'event-a', ?, 'main', 'character-guide',
           'character-hero', 'trust', '0', '1', 'evidence-main'
         )`,
      )
      .run(PROJECT_ID);
    executor.database
      .prepare(
        `INSERT INTO causal_event_item_changes (
           id, event_id, project_id, branch_id, item_id, change_kind,
           from_character_id, to_character_id, evidence_id
         ) VALUES (
           'item-change-a', 'event-a', ?, 'main', 'sealed-letter', 'acquired',
           NULL, 'character-hero', 'evidence-main'
         )`,
      )
      .run(PROJECT_ID);
    executor.database
      .prepare(
        `INSERT INTO causal_event_informed_characters (
           event_id, project_id, branch_id, character_id
         ) VALUES ('event-a', ?, 'main', 'character-guide')`,
      )
      .run(PROJECT_ID);
    executor.database
      .prepare(
        `INSERT INTO causal_event_foreshadow_progress (
           id, event_id, project_id, branch_id, foreshadow_id,
           progress_kind, description, evidence_id
         ) VALUES (
           'foreshadow-a', 'event-a', ?, 'main', 'missing-prince',
           'planted', 'The royal seal appears.', 'evidence-main'
         )`,
      )
      .run(PROJECT_ID);
    insertRelation(executor, "relation-ab", "main", "event-a", "event-b", "causes");

    expect(
      await executor.select<{
        readonly source_event_id: string;
        readonly downstream_event_id: string;
        readonly relation_kind: string;
      }>(
        `SELECT source_event_id, downstream_event_id, relation_kind
         FROM causal_event_downstream_impacts`,
      ),
    ).toEqual([
      {
        source_event_id: "event-a",
        downstream_event_id: "event-b",
        relation_kind: "causes",
      },
    ]);

    executor.database.prepare("DELETE FROM causal_events WHERE id = 'event-a'").run();
    expect(
      await executor.select<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM causal_event_relations`,
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await executor.select<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM causal_event_character_changes`,
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await executor.select<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM causal_event_prerequisites`,
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects missing or mutable evidence and invalid chapter-version bindings", () => {
    const executor = createExecutorWithMigration();
    seedProjectAndChapter(executor);
    seedSecondChapter(executor);

    expect(() => insertEvidence(executor, "mismatched", "chapter-one", "version-two")).toThrow(
      /chapter-version binding is invalid/iu,
    );
    insertEvidence(executor, "evidence-main", "chapter-one", "version-one");
    expect(() =>
      executor.database
        .prepare(
          `UPDATE causal_evidence_sources
           SET excerpt = 'changed excerpt'
           WHERE id = 'evidence-main'`,
        )
        .run(),
    ).toThrow(/immutable/iu);
    expect(() => insertEvent(executor, "missing-evidence", "main", 1, "unknown")).toThrow();
  });

  it("enforces branch isolation, relation vocabulary, temporal order, and item semantics", () => {
    const executor = createExecutorWithMigration();
    seedProjectAndChapter(executor);
    insertEvidence(executor, "evidence-main", "chapter-one", "version-one");
    insertEvent(executor, "event-main", "main", 1, "evidence-main");
    insertEvent(executor, "event-later", "main", 2, "evidence-main");
    insertEvent(executor, "event-alternate", "alternate", 1, "evidence-main");

    expect(() =>
      insertRelation(executor, "cross-branch", "main", "event-main", "event-alternate", "causes"),
    ).toThrow();
    expect(() =>
      insertRelation(
        executor,
        "invalid-kind",
        "main",
        "event-main",
        "event-later",
        "free_generation",
      ),
    ).toThrow();
    expect(() =>
      insertRelation(executor, "reverse-before", "main", "event-later", "event-main", "before"),
    ).toThrow(/must follow narrative order/iu);
    expect(() =>
      executor.database
        .prepare(
          `INSERT INTO causal_event_item_changes (
             id, event_id, project_id, branch_id, item_id, change_kind,
             from_character_id, to_character_id, evidence_id
           ) VALUES (
             'invalid-transfer', 'event-main', ?, 'main', 'sealed-letter',
             'transferred', 'character-hero', 'character-hero', 'evidence-main'
           )`,
        )
        .run(PROJECT_ID),
    ).toThrow();
    expect(() =>
      executor.database
        .prepare(
          `INSERT INTO causal_event_prerequisites (
             id, event_id, project_id, branch_id, prerequisite_kind,
             reference_id, referenced_event_id, description, evidence_id
           ) VALUES (
             'cross-branch-prerequisite', 'event-alternate', ?, 'alternate', 'event',
             'event-main', 'event-main', 'Main branch prerequisite.', 'evidence-main'
           )`,
        )
        .run(PROJECT_ID),
    ).toThrow();

    for (const relationKind of RELATION_KINDS) {
      insertRelation(
        executor,
        `valid-${relationKind}`,
        "main",
        "event-main",
        "event-later",
        relationKind,
      );
    }
    expect(
      executor.database
        .prepare(
          `SELECT relation_kind
           FROM causal_event_relations
           WHERE id LIKE 'valid-%'
           ORDER BY relation_kind`,
        )
        .all()
        .map((row) => (row as { readonly relation_kind: string }).relation_kind),
    ).toEqual([...RELATION_KINDS].sort());
  });
});

function createExecutor(): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(coreMigration);
  executors.push(executor);
  return executor;
}

function createExecutorWithMigration(): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
  executors.push(executor);
  return executor;
}

function seedProjectAndChapter(executor: NodeSqliteExecutor): void {
  executor.database
    .prepare(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, 'Causal graph migration', 'active', 1, 0, ?, ?)`,
    )
    .run(PROJECT_ID, NOW, NOW);
  seedChapter(executor, "chapter-one", "version-one", "Evidence source one.");
}

function seedSecondChapter(executor: NodeSqliteExecutor): void {
  seedChapter(executor, "chapter-two", "version-two", "Evidence source two.");
}

function seedChapter(
  executor: NodeSqliteExecutor,
  chapterId: string,
  versionId: string,
  content: string,
): void {
  executor.database.exec("BEGIN IMMEDIATE");
  try {
    executor.database
      .prepare(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      )
      .run(chapterId, PROJECT_ID, `Title ${chapterId}`, content, versionId, NOW, NOW);
    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      )
      .run(versionId, PROJECT_ID, chapterId, content, "a".repeat(64), NOW);
    executor.database.exec("COMMIT");
  } catch (error: unknown) {
    executor.database.exec("ROLLBACK");
    throw error;
  }
}

function insertEvidence(
  executor: NodeSqliteExecutor,
  id: string,
  chapterId: string,
  chapterVersionId: string,
): void {
  const excerpt = "Evidence";
  executor.database
    .prepare(
      `INSERT INTO causal_evidence_sources (
         id, project_id, chapter_id, chapter_version_id, content_hash,
         locator, excerpt, start_offset, end_offset, source_length, created_at
       ) VALUES (?, ?, ?, ?, ?, 'paragraph:1', ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      PROJECT_ID,
      chapterId,
      chapterVersionId,
      "a".repeat(64),
      excerpt,
      excerpt.length,
      excerpt.length,
      NOW,
    );
}

function insertEvent(
  executor: NodeSqliteExecutor,
  id: string,
  branchId: string,
  narrativeOrder: number,
  evidenceId: string,
): void {
  executor.database
    .prepare(
      `INSERT INTO causal_events (
         id, project_id, branch_id, status, narrative_order, narrative_label,
         location_id, location_label, event_text, result_text, evidence_id,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, 'confirmed', ?, ?, 'old-gate', 'Old city gate',
         'The event occurs.', 'The event changes the story.', ?, ?, ?
       )`,
    )
    .run(
      id,
      PROJECT_ID,
      branchId,
      narrativeOrder,
      `Story order ${String(narrativeOrder)}`,
      evidenceId,
      NOW,
      NOW,
    );
}

function insertRelation(
  executor: NodeSqliteExecutor,
  id: string,
  branchId: string,
  fromEventId: string,
  toEventId: string,
  relationKind: string,
): void {
  executor.database
    .prepare(
      `INSERT INTO causal_event_relations (
         id, project_id, branch_id, from_event_id, to_event_id,
         relation_kind, evidence_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'evidence-main', ?)`,
    )
    .run(id, PROJECT_ID, branchId, fromEventId, toEventId, relationKind, NOW);
}
