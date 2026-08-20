import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readMigration("0001_core.sql");
const searchMigration = readMigration("0006_search_index.sql");
const multigranularMigration = readMigration("0070_multigranular_search_retrieval.sql");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000070";
const NOW = "2026-08-20T00:00:00.000Z";

describe("multigranular search retrieval migration", () => {
  it("creates the fresh scoped schema and indexes", async () => {
    const executor = new NodeSqliteExecutor(
      [coreMigration, searchMigration, multigranularMigration].join("\n"),
    );

    const columns = await executor.select<{ name: string }>(
      `SELECT name FROM pragma_table_info('search_index_documents')
       WHERE name IN (
         'chunk_kind', 'parent_document_id', 'utf16_start', 'utf16_end',
         'source_length', 'scene_id', 'event_id', 'character_ids_json',
         'location_ids_json', 'story_time',
         'branch_id', 'pov_character_id', 'story_order', 'authority',
         'privacy', 'currentness', 'omitted_scope_fields_json'
       )
       ORDER BY name`,
    );
    const indexes = await executor.select<{ name: string }>(
      `SELECT name FROM sqlite_schema
       WHERE type = 'index'
         AND name IN ('search_index_documents_scope_idx', 'search_index_documents_parent_idx')
       ORDER BY name`,
    );

    expect(columns).toHaveLength(17);
    expect(indexes.map(({ name }) => name)).toEqual([
      "search_index_documents_parent_idx",
      "search_index_documents_scope_idx",
    ]);
    await executor.close();
  });

  it("upgrades a 0069-era search row without claiming current authority", async () => {
    const executor = new NodeSqliteExecutor([coreMigration, searchMigration].join("\n"));
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Project', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO search_index_state (
         project_id, schema_version, revision, document_count,
         content_characters, indexed_at, updated_at
       ) VALUES (?, 1, 1, 1, 6, ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO search_index_documents (
         project_id, document_id, source_type, source_id, source_version_id,
         title, search_text, normalized_title, normalized_search_text,
         content_hash, source_updated_at, importance, pinned, indexed_at
       ) VALUES (?, 'legacy-document', 'chapter', 'chapter-1', 'version-1',
                 'Legacy', 'legacy', 'legacy', 'legacy', ?, ?, 0, 0, ?)`,
      [PROJECT_ID, "a".repeat(64), NOW, NOW],
    );

    executor.database.exec(multigranularMigration);

    const rows = await executor.select<{
      chunkKind: string;
      authority: string;
      currentness: string;
      utf16Start: number;
      utf16End: number;
      sourceLength: number;
      characterIds: string;
      locationIds: string;
      omissions: string;
    }>(
      `SELECT chunk_kind AS chunkKind, authority, currentness,
              utf16_start AS utf16Start, utf16_end AS utf16End,
              source_length AS sourceLength,
              character_ids_json AS characterIds,
              location_ids_json AS locationIds,
              omitted_scope_fields_json AS omissions
       FROM search_index_documents
       WHERE project_id = ? AND document_id = 'legacy-document'`,
      [PROJECT_ID],
    );
    const currentRows = await executor.select<{ count: number }>(
      `SELECT count(*) AS count FROM search_index_documents
       WHERE project_id = ? AND currentness = 'current'`,
      [PROJECT_ID],
    );

    expect(rows).toEqual([
      {
        chunkKind: "chapter",
        authority: "rebuildable",
        currentness: "legacy_unknown",
        utf16Start: 0,
        utf16End: 0,
        sourceLength: 6,
        characterIds: "[]",
        locationIds: "[]",
        omissions:
          '["current_version","branch","pov","story_order","scene","event","characters","locations","story_time"]',
      },
    ]);
    expect(currentRows).toEqual([{ count: 0 }]);
    executor.database.exec("INSERT INTO search_index_fts(search_index_fts) VALUES('rebuild')");
    expect(
      await executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM search_index_fts WHERE search_index_fts MATCH 'leg'",
      ),
    ).toEqual([{ count: 1 }]);
    await executor.close();
  });
});

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
