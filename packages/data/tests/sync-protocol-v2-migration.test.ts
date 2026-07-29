import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const legacyMigration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0010_sync_inbox.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0013_sync_snapshot_staging.sql", import.meta.url), "utf8"),
].join("\n");
const protocolV2Migration = readFileSync(
  new URL("../migrations/0014_sync_protocol_v2_object_types.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-200000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-200000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-200000000003";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-200000000004";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-200000000005";
const OBJECT_ID = "019f9f4a-b3c7-7350-9226-200000000006";
const OTHER_OBJECT_ID = "019f9f4a-b3c7-7350-9226-200000000007";
const CHUNK_ID = "019f9f4a-b3c7-7350-9226-200000000008";
const OPERATION_ID = "019f9f4a-b3c7-7350-9226-200000000009";
const INBOX_OPERATION_ID = "019f9f4a-b3c7-7350-9226-200000000010";
const SNAPSHOT_OPERATION_ID = "019f9f4a-b3c7-7350-9226-200000000011";
const TRANSFER_ID = "019f9f4a-b3c7-7350-9226-200000000012";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-200000000013";
const BATCH_ID = "b".repeat(64);
const SNAPSHOT_ID = "snapshot_protocol_v1";
const NOW = "2026-07-28T00:00:00.000Z";
const RETAIN_UNTIL = "2027-07-29T00:00:00.000Z";

const transportTables = [
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_sessions",
  "sync_inbox_operation_chunks",
  "sync_inbox_operations",
  "sync_incoming_batches",
  "sync_operation_chunks",
  "sync_transfer_chunks",
  "sync_transfers",
  "sync_outbox_operations",
  "sync_tombstones",
  "sync_ciphertext_chunks",
  "sync_remote_checkpoints",
  "sync_device_sequences",
] as const;

describe("0014 sync protocol v2 object-type migration", () => {
  let executor: NodeSqliteExecutor;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(legacyMigration);
    await seedAuthoritativePlaintext(executor);
    await seedLegacyTransportLedger(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("resets only the unsafe v1 transport ledger and preserves authoritative plaintext", async () => {
    for (const table of transportTables) {
      await expect(
        executor.select<{ count: number }>(`SELECT count(*) AS count FROM ${table}`),
      ).resolves.toEqual([{ count: 1 }]);
    }

    executor.database.exec(protocolV2Migration);

    for (const table of transportTables) {
      await expect(
        executor.select<{ count: number }>(`SELECT count(*) AS count FROM ${table}`),
      ).resolves.toEqual([{ count: 0 }]);
    }
    await expect(
      executor.select<{ name: string }>("SELECT name FROM projects WHERE id = ?", [PROJECT_ID]),
    ).resolves.toEqual([{ name: "Protocol migration project" }]);
    await expect(
      executor.select<{ title: string; content: string }>(
        "SELECT title, content FROM chapters WHERE id = ?",
        [CHAPTER_ID],
      ),
    ).resolves.toEqual([{ title: "Preserved chapter", content: "authoritative plaintext" }]);
    await expect(
      executor.select<{ content: string }>("SELECT content FROM chapter_versions WHERE id = ?", [
        VERSION_ID,
      ]),
    ).resolves.toEqual([{ content: "authoritative plaintext" }]);
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("requires typed v2 identities in operation and tombstone persistence", async () => {
    executor.database.exec(protocolV2Migration);

    for (const table of [
      "sync_outbox_operations",
      "sync_inbox_operations",
      "sync_snapshot_staging_operations",
      "sync_tombstones",
      "sync_snapshot_staging_tombstones",
    ]) {
      const columns = executor.database.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
      }[];
      expect(columns).toContainEqual(
        expect.objectContaining({
          name: "object_type",
          notnull: 1,
        }),
      );
    }

    expect(primaryKeyColumns(executor, "sync_tombstones")).toEqual([
      "project_id",
      "object_type",
      "object_id",
      "object_generation",
    ]);
    expect(primaryKeyColumns(executor, "sync_snapshot_staging_tombstones")).toEqual([
      "snapshot_id",
      "project_id",
      "object_type",
      "object_id",
      "object_generation",
    ]);

    const triggerNames = (
      executor.database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'sync_%object_type%'
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map(({ name }) => name);
    expect(triggerNames).toEqual([
      "sync_inbox_operation_chunks_require_matching_object_type",
      "sync_inbox_operations_require_v2_object_type_insert",
      "sync_inbox_operations_require_v2_object_type_update",
      "sync_operation_chunks_require_matching_object_type",
      "sync_outbox_operations_require_v2_object_type_insert",
      "sync_outbox_operations_require_v2_object_type_update",
      "sync_snapshot_operation_chunks_require_matching_object_type",
      "sync_snapshot_operations_require_v2_object_type_insert",
      "sync_snapshot_operations_require_v2_object_type_update",
    ]);

    expect(() => insertOutboxWithoutObjectType(executor)).toThrow(
      /sync protocol v2 object_type is required/u,
    );
    expect(() => insertTombstoneWithoutObjectType(executor)).toThrow(/object_type/u);

    await insertCiphertextChunk(executor, {
      objectType: "project_manifest",
      objectId: PROJECT_ID,
    });
    await expect(
      executor.select<{ objectType: string }>(
        "SELECT object_type AS objectType FROM sync_ciphertext_chunks WHERE chunk_id = ?",
        [CHUNK_ID],
      ),
    ).resolves.toEqual([{ objectType: "project_manifest" }]);
  });

  it("rejects persisted operation/chunk mappings with different object types", async () => {
    executor.database.exec(protocolV2Migration);
    await insertCiphertextChunk(executor);
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_type,
         object_id, object_generation, kind, vector_json, status, attempt,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'memory', ?, 1, 'upsert', ?, 'queued', 0, ?, ?, ?)`,
      [
        OPERATION_ID,
        PROJECT_ID,
        DEVICE_ID,
        OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        NOW,
        NOW,
        NOW,
      ],
    );

    await expect(
      executor.execute(
        "INSERT INTO sync_operation_chunks (operation_id, chunk_id, position) VALUES (?, ?, 0)",
        [OPERATION_ID, CHUNK_ID],
      ),
    ).rejects.toThrow(/object identity must match/u);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_operation_chunks"),
    ).resolves.toEqual([{ count: 0 }]);
  });
});

async function seedAuthoritativePlaintext(executor: NodeSqliteExecutor): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "Protocol migration project", NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, current_version_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        CHAPTER_ID,
        PROJECT_ID,
        "Preserved chapter",
        "authoritative plaintext",
        VERSION_ID,
        NOW,
        NOW,
      ],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, "authoritative plaintext", "a".repeat(64), NOW],
    );
  });
}

async function seedLegacyTransportLedger(executor: NodeSqliteExecutor): Promise<void> {
  await insertCiphertextChunk(executor);
  await executor.execute(
    `INSERT INTO sync_outbox_operations (
       operation_id, project_id, device_id, device_sequence, object_id,
       object_generation, kind, vector_json, status, attempt, next_attempt_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, 1, 'upsert', ?, 'queued', 0, ?, ?, ?)`,
    [
      OPERATION_ID,
      PROJECT_ID,
      DEVICE_ID,
      OBJECT_ID,
      JSON.stringify({ [DEVICE_ID]: 1 }),
      NOW,
      NOW,
      NOW,
    ],
  );
  await executor.execute(
    "INSERT INTO sync_operation_chunks (operation_id, chunk_id, position) VALUES (?, ?, 0)",
    [OPERATION_ID, CHUNK_ID],
  );
  await executor.execute(
    `INSERT INTO sync_tombstones (
       project_id, object_id, object_generation, deleted_by_device_id,
       vector_json, deleted_at, retain_until, acknowledged_device_ids_json, updated_at
     ) VALUES (?, ?, 1, ?, ?, ?, ?, '[]', ?)`,
    [
      PROJECT_ID,
      OTHER_OBJECT_ID,
      DEVICE_ID,
      JSON.stringify({ [DEVICE_ID]: 1 }),
      NOW,
      RETAIN_UNTIL,
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO sync_transfers (
       transfer_id, project_id, object_id, version_id, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    [TRANSFER_ID, PROJECT_ID, OBJECT_ID, VERSION_ID, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO sync_transfer_chunks (
       transfer_id, chunk_id, chunk_index, ciphertext_bytes, ciphertext_sha256
     ) VALUES (?, ?, 0, 22, ?)`,
    [TRANSFER_ID, CHUNK_ID, "c".repeat(64)],
  );
  await executor.execute(
    `INSERT INTO sync_remote_checkpoints (
       project_id, signed_remote_cursor, revision, updated_at
     ) VALUES (?, 'legacy_cursor', 1, ?)`,
    [PROJECT_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO sync_device_sequences (
       project_id, device_id, last_allocated_sequence, revision, updated_at
     ) VALUES (?, ?, 1, 1, ?)`,
    [PROJECT_ID, DEVICE_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO sync_incoming_batches (
       batch_id, project_id, prior_signed_remote_cursor, next_signed_remote_cursor,
       response_digest, request_id, has_more, operation_count, chunk_count,
       tombstone_count, received_at
     ) VALUES (?, ?, NULL, 'legacy_inbox_cursor', ?, ?, 0, 1, 1, 1, ?)`,
    [BATCH_ID, PROJECT_ID, "d".repeat(64), REQUEST_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO sync_inbox_operations (
       operation_id, batch_id, operation_position, project_id, device_id,
       device_sequence, object_id, object_generation, kind, vector_json,
       operation_created_at, status, attempt, next_attempt_at, received_at, updated_at
     ) VALUES (?, ?, 0, ?, ?, 1, ?, 1, 'upsert', ?, ?, 'received', 0, ?, ?, ?)`,
    [
      INBOX_OPERATION_ID,
      BATCH_ID,
      PROJECT_ID,
      OTHER_DEVICE_ID,
      OBJECT_ID,
      JSON.stringify({ [OTHER_DEVICE_ID]: 1 }),
      NOW,
      NOW,
      NOW,
      NOW,
    ],
  );
  await executor.execute(
    "INSERT INTO sync_inbox_operation_chunks (operation_id, chunk_id, position) VALUES (?, ?, 0)",
    [INBOX_OPERATION_ID, CHUNK_ID],
  );
  await seedLegacySnapshot(executor);
}

async function seedLegacySnapshot(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_sessions (
       snapshot_id, project_id, epoch, state, base_signed_remote_cursor,
       base_checkpoint_revision, base_checkpoint_updated_at,
       snapshot_signed_remote_cursor, snapshot_expires_at, next_page_index,
       next_snapshot_cursor, pages_complete, final_signed_remote_cursor,
       total_operation_count, total_chunk_count, total_tombstone_count,
       committed_checkpoint_revision, created_at, updated_at, committed_at
     ) VALUES (
       ?, ?, 1, 'staging', NULL, 0, NULL, 'snapshot_head',
       '2026-07-30T00:00:00.000Z', 1, NULL, 1, 'snapshot_head',
       1, 1, 1, NULL, ?, ?, NULL
     )`,
    [SNAPSHOT_ID, PROJECT_ID, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_pages (
       snapshot_id, page_index, resume_cursor, snapshot_signed_remote_cursor,
       snapshot_expires_at, next_snapshot_cursor, final_signed_remote_cursor,
       response_digest, operation_count, chunk_count, tombstone_count, received_at
     ) VALUES (
       ?, 0, NULL, 'snapshot_head', '2026-07-30T00:00:00.000Z',
       NULL, 'snapshot_head', ?, 1, 1, 1, ?
     )`,
    [SNAPSHOT_ID, "e".repeat(64), NOW],
  );
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_operations (
       snapshot_id, page_index, operation_position, operation_id, project_id,
       device_id, device_sequence, object_id, object_generation, kind,
       vector_json, operation_created_at
     ) VALUES (?, 0, 0, ?, ?, ?, 2, ?, 1, 'upsert', ?, ?)`,
    [
      SNAPSHOT_ID,
      SNAPSHOT_OPERATION_ID,
      PROJECT_ID,
      DEVICE_ID,
      OBJECT_ID,
      JSON.stringify({ [DEVICE_ID]: 2 }),
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_chunks (
       snapshot_id, page_index, chunk_id, project_id, object_type, object_id,
       version_id, chunk_index, key_version, algorithm, nonce, ciphertext,
       ciphertext_sha256, plaintext_bytes, created_at
     ) VALUES (
       ?, 0, ?, ?, 'chapter_version', ?, ?, 0, 1, 'AES-256-GCM',
       'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA', ?, 6, ?
     )`,
    [SNAPSHOT_ID, CHUNK_ID, PROJECT_ID, OBJECT_ID, VERSION_ID, "c".repeat(64), NOW],
  );
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_operation_chunks (
       snapshot_id, operation_id, chunk_id, position
     ) VALUES (?, ?, ?, 0)`,
    [SNAPSHOT_ID, SNAPSHOT_OPERATION_ID, CHUNK_ID],
  );
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_tombstones (
       snapshot_id, page_index, tombstone_position, project_id, object_id,
       object_generation, deleted_by_device_id, vector_json, deleted_at,
       retain_until, acknowledged_device_ids_json, updated_at
     ) VALUES (?, 0, 0, ?, ?, 1, ?, ?, ?, ?, '[]', ?)`,
    [
      SNAPSHOT_ID,
      PROJECT_ID,
      OTHER_OBJECT_ID,
      DEVICE_ID,
      JSON.stringify({ [DEVICE_ID]: 1 }),
      NOW,
      RETAIN_UNTIL,
      NOW,
    ],
  );
}

async function insertCiphertextChunk(
  executor: NodeSqliteExecutor,
  overrides: {
    readonly objectType?: "chapter_version" | "project_manifest";
    readonly objectId?: string;
  } = {},
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_ciphertext_chunks (
       chunk_id, project_id, object_type, object_id, version_id, chunk_index,
       key_version, algorithm, nonce, ciphertext, ciphertext_sha256,
       plaintext_bytes, created_at
     ) VALUES (
       ?, ?, ?, ?, ?, 0, 1, 'AES-256-GCM',
       'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA', ?, 6, ?
     )`,
    [
      CHUNK_ID,
      PROJECT_ID,
      overrides.objectType ?? "chapter_version",
      overrides.objectId ?? OBJECT_ID,
      VERSION_ID,
      "c".repeat(64),
      NOW,
    ],
  );
}

function insertOutboxWithoutObjectType(executor: NodeSqliteExecutor): void {
  executor.database
    .prepare(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_id,
         object_generation, kind, vector_json, status, attempt, next_attempt_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, 1, 'delete', ?, 'queued', 0, ?, ?, ?)`,
    )
    .run(
      OPERATION_ID,
      PROJECT_ID,
      DEVICE_ID,
      OBJECT_ID,
      JSON.stringify({ [DEVICE_ID]: 1 }),
      NOW,
      NOW,
      NOW,
    );
}

function insertTombstoneWithoutObjectType(executor: NodeSqliteExecutor): void {
  executor.database
    .prepare(
      `INSERT INTO sync_tombstones (
         project_id, object_id, object_generation, deleted_by_device_id,
         vector_json, deleted_at, retain_until, acknowledged_device_ids_json, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, '[]', ?)`,
    )
    .run(
      PROJECT_ID,
      OBJECT_ID,
      DEVICE_ID,
      JSON.stringify({ [DEVICE_ID]: 1 }),
      NOW,
      RETAIN_UNTIL,
      NOW,
    );
}

function primaryKeyColumns(executor: NodeSqliteExecutor, table: string): string[] {
  return (
    executor.database.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      pk: number;
    }[]
  )
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => name);
}
