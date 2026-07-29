import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DocumentEmbedding } from "@inkshadow/search-core";
import { afterEach, describe, expect, it } from "vitest";

import { SearchVectorSqliteStore } from "../src/search-vector-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0006_search_index.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0021_search_vector_index.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T01:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const FIRST_DOCUMENT_ID = "chapter:019f9f4a-b3c7-7350-9226-000000000002:0";
const SECOND_DOCUMENT_ID = "chapter:019f9f4a-b3c7-7350-9226-000000000003:0";
const FIRST_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const SECOND_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const FIRST_HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SearchVectorSqliteStore", () => {
  it("persists exact project-scoped cosine results with version and hash provenance", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-vector-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "vectors.sqlite");
    let executor = new NodeSqliteExecutor(migration, databasePath);
    await seedSearchProjection(executor);
    let store = new SearchVectorSqliteStore(executor);

    const state = await store.replaceProject({
      projectId: PROJECT_ID,
      expectedGeneration: 0,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
      embeddings: [
        embedding(FIRST_DOCUMENT_ID, FIRST_VERSION_ID, FIRST_HASH, [1, 0]),
        embedding(SECOND_DOCUMENT_ID, SECOND_VERSION_ID, SECOND_HASH, [0, 1]),
      ],
      rebuiltAt: NOW,
    });
    expect(state).toMatchObject({
      projectId: PROJECT_ID,
      generation: 1,
      status: "ready",
      embeddingCount: 2,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
    });

    await executor.close();
    executor = new NodeSqliteExecutor("", databasePath);
    store = new SearchVectorSqliteStore(executor);
    const result = await store.findNearest({
      projectId: PROJECT_ID,
      modelId: "local-embed-v1",
      values: [1, 0],
      limit: 2,
    });

    expect(result).toEqual({
      status: "ready",
      generation: 1,
      hits: [
        {
          documentId: FIRST_DOCUMENT_ID,
          similarity: 1,
          sourceVersionId: FIRST_VERSION_ID,
          contentHash: FIRST_HASH,
        },
        {
          documentId: SECOND_DOCUMENT_ID,
          similarity: 0.5,
          sourceVersionId: SECOND_VERSION_ID,
          contentHash: SECOND_HASH,
        },
      ],
      notice: null,
    });
    await executor.close();
  });

  it("requires an explicit rebuild after a model or dimension change", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedSearchProjection(executor);
    const store = new SearchVectorSqliteStore(executor);
    await store.replaceProject({
      projectId: PROJECT_ID,
      expectedGeneration: 0,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
      embeddings: [embedding(FIRST_DOCUMENT_ID, FIRST_VERSION_ID, FIRST_HASH, [1, 0])],
      rebuiltAt: NOW,
    });

    const changed = await store.configureProject({
      projectId: PROJECT_ID,
      expectedGeneration: 1,
      configuration: { modelId: "local-embed-v2", dimension: 3 },
      configuredAt: LATER,
    });
    expect(changed).toMatchObject({
      generation: 2,
      status: "rebuild_required",
      embeddingCount: 1,
      configuration: { modelId: "local-embed-v2", dimension: 3 },
    });
    await expect(
      store.findNearest({
        projectId: PROJECT_ID,
        modelId: "local-embed-v2",
        values: [1, 0, 0],
      }),
    ).resolves.toEqual({
      status: "rebuild_required",
      generation: 2,
      hits: [],
      notice: "vector_index_rebuild_required",
    });
    await expect(
      store.configureProject({
        projectId: PROJECT_ID,
        expectedGeneration: 1,
        configuration: { modelId: "local-embed-v3", dimension: 3 },
        configuredAt: LATER,
      }),
    ).rejects.toMatchObject({
      code: "VECTOR_INDEX_CONFLICT",
      retryable: true,
    });
    await executor.close();
  });

  it("marks source drift without deleting the previous atomic vector generation", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedSearchProjection(executor);
    const store = new SearchVectorSqliteStore(executor);
    await store.replaceProject({
      projectId: PROJECT_ID,
      expectedGeneration: 0,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
      embeddings: [embedding(FIRST_DOCUMENT_ID, FIRST_VERSION_ID, FIRST_HASH, [1, 0])],
      rebuiltAt: NOW,
    });

    const marked = await store.markProjectRebuildRequired({
      projectId: PROJECT_ID,
      expectedGeneration: 1,
      markedAt: LATER,
    });

    expect(marked).toMatchObject({
      generation: 2,
      status: "rebuild_required",
      embeddingCount: 1,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
    });
    const loaded = await store.loadProject(PROJECT_ID);
    expect(loaded).toMatchObject({
      state: { generation: 2, status: "rebuild_required" },
      embeddings: [{ documentId: FIRST_DOCUMENT_ID, values: [1, 0] }],
    });
    await executor.close();
  });

  it("rolls the whole rebuild back when a source version changes before commit", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedSearchProjection(executor);
    const store = new SearchVectorSqliteStore(executor);
    await store.replaceProject({
      projectId: PROJECT_ID,
      expectedGeneration: 0,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
      embeddings: [embedding(FIRST_DOCUMENT_ID, FIRST_VERSION_ID, FIRST_HASH, [1, 0])],
      rebuiltAt: NOW,
    });
    await executor.execute(
      `UPDATE search_index_documents
       SET source_version_id = ?, content_hash = ?
       WHERE project_id = ? AND document_id = ?`,
      [SECOND_VERSION_ID, SECOND_HASH, PROJECT_ID, SECOND_DOCUMENT_ID],
    );

    await expect(
      store.replaceProject({
        projectId: PROJECT_ID,
        expectedGeneration: 1,
        configuration: { modelId: "local-embed-v1", dimension: 2 },
        embeddings: [
          embedding(FIRST_DOCUMENT_ID, FIRST_VERSION_ID, FIRST_HASH, [0, 1]),
          embedding(SECOND_DOCUMENT_ID, SECOND_VERSION_ID, "c".repeat(64), [1, 0]),
        ],
        rebuiltAt: LATER,
      }),
    ).rejects.toMatchObject({ code: "VECTOR_INDEX_CONFLICT" });

    const loaded = await store.loadProject(PROJECT_ID);
    expect(loaded).toMatchObject({
      state: { generation: 1, embeddingCount: 1, lastRebuiltAt: NOW },
      embeddings: [{ documentId: FIRST_DOCUMENT_ID, values: [1, 0] }],
    });
    await executor.close();
  });

  it("fails closed on corrupted vector bytes and never returns stale similarity", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedSearchProjection(executor);
    const store = new SearchVectorSqliteStore(executor);
    await store.replaceProject({
      projectId: PROJECT_ID,
      expectedGeneration: 0,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
      embeddings: [embedding(FIRST_DOCUMENT_ID, FIRST_VERSION_ID, FIRST_HASH, [1, 0])],
      rebuiltAt: NOW,
    });
    await executor.execute(
      `UPDATE search_vector_embeddings
       SET vector_blob = ?
       WHERE project_id = ? AND document_id = ?`,
      [Uint8Array.from([0, 0, 192, 127, 0, 0, 0, 0]), PROJECT_ID, FIRST_DOCUMENT_ID],
    );

    await expect(
      store.findNearest({
        projectId: PROJECT_ID,
        modelId: "local-embed-v1",
        values: [1, 0],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "SearchVectorIndexStoreError",
        code: "VECTOR_INDEX_CORRUPT",
      }),
    );
    await executor.close();
  });

  it("returns a visible disabled or incompatible fallback instead of inventing vector scores", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedSearchProjection(executor);
    const store = new SearchVectorSqliteStore(executor);
    await expect(
      store.findNearest({
        projectId: PROJECT_ID,
        modelId: "missing-model",
        values: [1, 0],
      }),
    ).resolves.toMatchObject({
      status: "disabled",
      hits: [],
      notice: "vector_index_not_configured",
    });
    await store.replaceProject({
      projectId: PROJECT_ID,
      expectedGeneration: 0,
      configuration: { modelId: "local-embed-v1", dimension: 2 },
      embeddings: [],
      rebuiltAt: NOW,
    });
    await expect(
      store.findNearest({
        projectId: PROJECT_ID,
        modelId: "other-model",
        values: [1, 0],
      }),
    ).resolves.toMatchObject({
      status: "ready",
      hits: [],
      notice: "vector_query_incompatible",
    });
    await executor.close();
  });
});

function embedding(
  documentId: string,
  sourceVersionId: string,
  contentHash: string,
  values: readonly number[],
): DocumentEmbedding {
  return {
    documentId,
    projectId: PROJECT_ID,
    sourceVersionId,
    contentHash,
    modelId: "local-embed-v1",
    values,
  };
}

async function seedSearchProjection(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Vector project', ?, ?)",
    [PROJECT_ID, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO search_index_state (
       project_id, document_count, content_characters, indexed_at, updated_at
     ) VALUES (?, 2, 16, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
  await insertDocument(
    executor,
    FIRST_DOCUMENT_ID,
    "019f9f4a-b3c7-7350-9226-000000000002",
    FIRST_VERSION_ID,
    FIRST_HASH,
    "第一章",
  );
  await insertDocument(
    executor,
    SECOND_DOCUMENT_ID,
    "019f9f4a-b3c7-7350-9226-000000000003",
    SECOND_VERSION_ID,
    SECOND_HASH,
    "第二章",
  );
}

function insertDocument(
  executor: NodeSqliteExecutor,
  documentId: string,
  sourceId: string,
  sourceVersionId: string,
  contentHash: string,
  title: string,
): Promise<unknown> {
  return executor.execute(
    `INSERT INTO search_index_documents (
       project_id, document_id, source_type, source_id, source_version_id,
       title, search_text, normalized_title, normalized_search_text,
       content_hash, source_updated_at, indexed_at
     ) VALUES (?, ?, 'chapter', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      PROJECT_ID,
      documentId,
      sourceId,
      sourceVersionId,
      title,
      `${title}正文`,
      title,
      `${title}正文`,
      contentHash,
      NOW,
      NOW,
    ],
  );
}
