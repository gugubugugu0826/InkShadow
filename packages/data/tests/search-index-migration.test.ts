import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0006_search_index.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DOCUMENT_ID = "chapter:019f9f4a-b3c7-7350-9226-000000000002:0";
const SOURCE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";

describe("persistent search index migration", () => {
  it("is repeatable and creates only bounded, project-owned derived stores", async () => {
    const executor = new NodeSqliteExecutor(`${migration}\n${migration}`);

    const tables = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('search_index_state', 'search_index_documents')
       ORDER BY name`,
    );

    expect(tables.map(({ name }) => name)).toEqual([
      "search_index_documents",
      "search_index_state",
    ]);
    await executor.close();
  });

  it("enforces provenance, size, hash, and cascade invariants", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Project', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO search_index_state (
         project_id, document_count, content_characters, indexed_at, updated_at
       ) VALUES (?, 1, 4, ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO search_index_documents (
         project_id, document_id, source_type, source_id, source_version_id,
         title, search_text, normalized_title, normalized_search_text,
         content_hash, source_updated_at, indexed_at
       ) VALUES (
         ?, ?, 'chapter', ?, ?, '第一章', '正文内容',
         '第一章', '正文内容', ?, ?, ?
       )`,
      [PROJECT_ID, DOCUMENT_ID, SOURCE_ID, VERSION_ID, "a".repeat(64), NOW, NOW],
    );
    await expect(
      executor.select<{ rowid: number }>(
        `SELECT rowid
         FROM search_index_fts
         WHERE search_index_fts MATCH '"正文内容"'`,
      ),
    ).resolves.toHaveLength(1);

    await expect(
      executor.execute(
        `UPDATE search_index_documents
         SET content_hash = ?
         WHERE project_id = ? AND document_id = ?`,
        ["not-a-checksum", PROJECT_ID, DOCUMENT_ID],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `UPDATE search_index_documents
         SET source_type = 'candidate'
         WHERE project_id = ? AND document_id = ?`,
        [PROJECT_ID, DOCUMENT_ID],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `UPDATE search_index_state
         SET content_characters = 64000001
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).rejects.toThrow();

    await executor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_index_documents"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_index_state"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ rowid: number }>(
        `SELECT rowid
         FROM search_index_fts
         WHERE search_index_fts MATCH '"正文内容"'`,
      ),
    ).resolves.toEqual([]);
    await executor.close();
  });
});
