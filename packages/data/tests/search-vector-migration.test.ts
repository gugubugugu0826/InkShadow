import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const foundation = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0006_search_index.sql", import.meta.url), "utf8"),
].join("\n");
const vectorMigration = readFileSync(
  new URL("../migrations/0021_search_vector_index.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-07-28T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DOCUMENT_ID = "chapter:019f9f4a-b3c7-7350-9226-000000000002:0";

describe("search vector index migration", () => {
  it("is repeatable and creates only rebuildable vector projection tables", async () => {
    const executor = new NodeSqliteExecutor(
      `${foundation}\n${vectorMigration}\n${vectorMigration}`,
    );
    const tables = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'search_vector_%'
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "search_vector_embeddings",
      "search_vector_index_state",
    ]);
    await executor.close();
  });

  it("binds vector bytes to an existing exact document and cascades derived deletion", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${vectorMigration}`);
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
       ) VALUES (?, ?, 'chapter', 'chapter-1', 'version-1', '第一章', '正文',
                 '第一章', '正文', ?, ?, ?)`,
      [PROJECT_ID, DOCUMENT_ID, "a".repeat(64), NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO search_vector_index_state (
         project_id, generation, model_id, dimension, status, last_rebuilt_at, updated_at
       ) VALUES (?, 1, 'embed-v1', 2, 'ready', ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO search_vector_embeddings (
         project_id, document_id, source_version_id, content_hash, model_id,
         dimension, vector_blob, vector_norm, indexed_at
       ) VALUES (?, ?, 'version-1', ?, 'embed-v1', 2, ?, 1, ?)`,
      [PROJECT_ID, DOCUMENT_ID, "a".repeat(64), Uint8Array.from([0, 0, 128, 63, 0, 0, 0, 0]), NOW],
    );

    await expect(
      executor.execute(
        `INSERT INTO search_vector_embeddings (
           project_id, document_id, source_version_id, content_hash, model_id,
           dimension, vector_blob, vector_norm, indexed_at
         ) VALUES (?, 'missing', 'version-1', ?, 'embed-v1', 2, ?, 1, ?)`,
        [PROJECT_ID, "a".repeat(64), Uint8Array.from([0, 0, 128, 63, 0, 0, 0, 0]), NOW],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `UPDATE search_vector_embeddings
         SET vector_blob = ?
         WHERE project_id = ? AND document_id = ?`,
        [Uint8Array.from([0, 0, 128, 63]), PROJECT_ID, DOCUMENT_ID],
      ),
    ).rejects.toThrow();

    await executor.execute("DELETE FROM search_index_documents WHERE project_id = ?", [PROJECT_ID]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_vector_embeddings"),
    ).resolves.toEqual([{ count: 0 }]);
    await executor.execute("DELETE FROM search_index_state WHERE project_id = ?", [PROJECT_ID]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_vector_index_state"),
    ).resolves.toEqual([{ count: 0 }]);
    await executor.close();
  });
});
