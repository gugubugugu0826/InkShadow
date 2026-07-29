import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0020_graph_rag_projection.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T01:00:00.000Z";

describe("0020 GraphRAG projection migration", () => {
  it("is repeatable and keeps every graph row project-owned and derived", async () => {
    const executor = new NodeSqliteExecutor(`${migration}\n${migration}`);
    const tables = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'graph_rag_%'
       ORDER BY name`,
    );

    expect(tables.map(({ name }) => name)).toEqual([
      "graph_rag_entities",
      "graph_rag_projection_state",
      "graph_rag_relation_evidence",
      "graph_rag_relation_identities",
      "graph_rag_relations",
      "graph_rag_source_versions",
    ]);

    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project-1', 'One', ?, ?)",
      [NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO graph_rag_projection_state (
         project_id, revision, status, source_version_count, entity_count,
         relation_count, evidence_count, updated_at
       ) VALUES ('project-1', 1, 'ready', 0, 0, 0, 0, ?)`,
      [NOW],
    );
    await executor.execute("DELETE FROM projects WHERE id = 'project-1'");
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM graph_rag_projection_state",
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await executor.close();
  });

  it("enforces current-source uniqueness, monotonic state, immutable relation identity, and FKs", async () => {
    const executor = new NodeSqliteExecutor(migration);
    for (const [id, name] of [
      ["project-1", "One"],
      ["project-2", "Two"],
    ] as const) {
      await executor.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [id, name, NOW, NOW],
      );
      await executor.execute(
        `INSERT INTO graph_rag_projection_state (
           project_id, revision, status, source_version_count, entity_count,
           relation_count, evidence_count, updated_at
         ) VALUES (?, 1, 'ready', 0, 0, 0, 0, ?)`,
        [id, NOW],
      );
    }
    await insertSource(executor, "project-1", "source-1", "v1", "a".repeat(64));
    await expect(
      insertSource(executor, "project-1", "source-1", "v2", "b".repeat(64)),
    ).rejects.toThrow();

    await executor.execute(
      `UPDATE graph_rag_source_versions
       SET state = 'deleted', invalidated_at = ?
       WHERE project_id = 'project-1' AND source_id = 'source-1'`,
      [LATER],
    );
    await expect(
      executor.execute(
        `UPDATE graph_rag_source_versions
         SET state = 'current', invalidated_at = NULL
         WHERE project_id = 'project-1' AND source_id = 'source-1'`,
      ),
    ).rejects.toThrow(/cannot move backwards/u);

    await insertSource(executor, "project-2", "source-2", "v1", "c".repeat(64));
    await expect(
      executor.execute(
        `INSERT INTO graph_rag_entities (
           project_id, entity_id, kind, label, source_id, source_version_id,
           source_content_hash, updated_at
         ) VALUES ('project-1', 'cross', 'character', 'Cross',
                   'source-2', 'v1', ?, ?)`,
        ["c".repeat(64), NOW],
      ),
    ).rejects.toThrow(/FOREIGN KEY/u);

    for (const entityId of ["a", "b"]) {
      await executor.execute(
        `INSERT INTO graph_rag_entities (
           project_id, entity_id, kind, label, source_id, source_version_id,
           source_content_hash, updated_at
         ) VALUES ('project-2', ?, 'character', ?,
                   'source-2', 'v1', ?, ?)`,
        [entityId, entityId, "c".repeat(64), NOW],
      );
    }
    await executor.execute(
      `INSERT INTO graph_rag_relation_identities (
         project_id, relation_id, from_entity_id, to_entity_id,
         kind, polarity, first_seen_at
       ) VALUES ('project-2', 'ab', 'a', 'b', 'knows', 'affirmed', ?)`,
      [NOW],
    );
    await executor.execute(
      `INSERT INTO graph_rag_relations (
         project_id, relation_id, from_entity_id, to_entity_id, kind,
         polarity, confidence, updated_at
       ) VALUES ('project-2', 'ab', 'a', 'b', 'knows',
                 'affirmed', 0.8, ?)`,
      [NOW],
    );
    await expect(
      executor.execute(
        `UPDATE graph_rag_relations
         SET kind = 'enemy_of'
         WHERE project_id = 'project-2' AND relation_id = 'ab'`,
      ),
    ).rejects.toThrow(/identity is immutable/u);
    await executor.execute("DELETE FROM projects WHERE id = 'project-2'");
    for (const table of [
      "graph_rag_projection_state",
      "graph_rag_source_versions",
      "graph_rag_entities",
      "graph_rag_relation_identities",
      "graph_rag_relations",
    ]) {
      await expect(
        executor.select<{ count: number }>(
          `SELECT count(*) AS count FROM ${table} WHERE project_id = 'project-2'`,
        ),
      ).resolves.toEqual([{ count: 0 }]);
    }

    await executor.close();
  });
});

async function insertSource(
  executor: NodeSqliteExecutor,
  projectId: string,
  sourceId: string,
  versionId: string,
  hash: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO graph_rag_source_versions (
       project_id, source_id, source_version_id, content_hash, content,
       state, created_at, invalidated_at
     ) VALUES (?, ?, ?, ?, 'source text', 'current', ?, NULL)`,
    [projectId, sourceId, versionId, hash, NOW],
  );
}
