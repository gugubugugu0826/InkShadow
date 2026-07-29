import { StoryCoreError } from "../errors.js";
import {
  MemoryPolicy,
  MemoryRecord,
  type MemoryPolicySnapshot,
  type MemoryRecordSnapshot,
} from "../memory.js";
import type {
  CreateMemoryPolicyResult,
  CreateMemoryRecordPersistenceInput,
  MemoryPolicyRepository,
  MemoryRecordCreationUnitOfWork,
  MemoryRecordListReader,
  MemoryRecordRepository,
} from "../ports.js";
import type { Result } from "../result.js";
import type { UuidV7 } from "../value-objects.js";
import {
  abortCorruptSnapshot,
  abortPersistence,
  abortRevisionConflict,
  assertNextRevision,
  parseSnapshot,
  runPersistence,
  serializeSnapshot,
} from "./common.js";
import type { StorySqlExecutor, StorySqlTransaction } from "./executor.js";

interface MemoryPolicyRow {
  project_id: string;
  automatic_learning_enabled: number;
  revision: number;
  snapshot_json: string;
}

interface MemoryRecordRow {
  id: string;
  project_id: string;
  level: string;
  origin: string;
  status: string;
  revision: number;
  source_kind: string;
  source_id: string;
  source_version_id: string | null;
  automatic_learning_policy_revision: number | null;
  snapshot_json: string;
}

export class SqliteMemoryPolicyRepository implements MemoryPolicyRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public createIfAbsent(
    policy: MemoryPolicy,
  ): Promise<Result<CreateMemoryPolicyResult, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = policy.toSnapshot();
        const inserted = await transaction.execute(
          `INSERT INTO story_memory_policies (
             project_id, automatic_learning_enabled, revision,
             created_at, updated_at, snapshot_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO NOTHING`,
          [
            snapshot.projectId,
            snapshot.automaticLearningEnabled ? 1 : 0,
            snapshot.revision,
            snapshot.createdAt,
            snapshot.updatedAt,
            serializeSnapshot(snapshot),
          ],
        );
        if (inserted.rowsAffected === 1) {
          return { policy, created: true };
        }

        const existing = await selectPolicy(transaction, snapshot.projectId);
        if (existing === null) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_REPOSITORY_ERROR",
              message: "Memory policy conflict did not resolve to a stored policy.",
              retryable: true,
              actions: ["RETRY", "CONTACT_SUPPORT"],
            }),
          );
        }
        return { policy: existing, created: false };
      }),
    );
  }

  public findByProjectId(projectId: UuidV7): Promise<Result<MemoryPolicy | null, StoryCoreError>> {
    return runPersistence(() => selectPolicy(this.executor, projectId));
  }

  public save(
    policy: MemoryPolicy,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      assertNextRevision("Memory policy", policy.revision, expectedRevision);
      const snapshot = policy.toSnapshot();
      const updated = await this.executor.execute(
        `UPDATE story_memory_policies
         SET automatic_learning_enabled = ?, revision = ?, updated_at = ?, snapshot_json = ?
         WHERE project_id = ? AND revision = ?`,
        [
          snapshot.automaticLearningEnabled ? 1 : 0,
          snapshot.revision,
          snapshot.updatedAt,
          serializeSnapshot(snapshot),
          snapshot.projectId,
          expectedRevision,
        ],
      );
      if (updated.rowsAffected !== 1) {
        await abortRevisionConflict(this.executor, {
          table: "story_memory_policies",
          idColumn: "project_id",
          id: snapshot.projectId,
          entity: "Memory policy",
          expectedRevision,
        });
      }
    });
  }
}

export class SqliteMemoryRecordRepository
  implements MemoryRecordRepository, MemoryRecordListReader
{
  public constructor(private readonly executor: StorySqlExecutor) {}

  public findById(id: UuidV7): Promise<Result<MemoryRecord | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<MemoryRecordRow>(
        `${MEMORY_RECORD_SELECT}
         WHERE id = ?`,
        [id],
      );
      return rows[0] === undefined ? null : hydrateMemoryRecord(rows[0]);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly MemoryRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<MemoryRecordRow>(
        `${MEMORY_RECORD_SELECT}
         WHERE project_id = ?
         ORDER BY level ASC, updated_at DESC, id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateMemoryRecord));
    });
  }

  public save(
    record: MemoryRecord,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      assertNextRevision("Memory record", record.revision, expectedRevision);
      const snapshot = record.toSnapshot();
      const updated = await this.executor.execute(
        `UPDATE story_memory_records
         SET level = ?, status = ?, revision = ?, updated_at = ?, snapshot_json = ?
         WHERE id = ? AND project_id = ? AND revision = ?`,
        [
          snapshot.level,
          snapshot.status,
          snapshot.revision,
          snapshot.updatedAt,
          serializeSnapshot(snapshot),
          snapshot.id,
          snapshot.projectId,
          expectedRevision,
        ],
      );
      if (updated.rowsAffected !== 1) {
        await abortRevisionConflict(this.executor, {
          table: "story_memory_records",
          idColumn: "id",
          id: snapshot.id,
          entity: "Memory record",
          expectedRevision,
        });
      }
    });
  }
}

export class SqliteMemoryRecordCreationUnitOfWork implements MemoryRecordCreationUnitOfWork {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(input: CreateMemoryRecordPersistenceInput): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = input.record.toSnapshot();
        if (snapshot.origin === "automatic") {
          await assertAutomaticMemoryAuthorization(transaction, snapshot, input);
        } else if (
          input.expectedAutomaticLearningPolicyRevision !== null ||
          snapshot.automaticLearningPolicyRevision !== null
        ) {
          abortCorruptSnapshot("USER_MEMORY_POLICY_AUTHORIZATION_PRESENT");
        }
        await insertMemoryRecord(transaction, snapshot);
      }),
    );
  }
}

async function selectPolicy(
  executor: StorySqlTransaction,
  projectId: string,
): Promise<MemoryPolicy | null> {
  const rows = await executor.select<MemoryPolicyRow>(
    `SELECT project_id, automatic_learning_enabled, revision, snapshot_json
     FROM story_memory_policies
     WHERE project_id = ?`,
    [projectId],
  );
  return rows[0] === undefined ? null : hydrateMemoryPolicy(rows[0]);
}

async function assertAutomaticMemoryAuthorization(
  transaction: StorySqlTransaction,
  snapshot: MemoryRecordSnapshot,
  input: CreateMemoryRecordPersistenceInput,
): Promise<void> {
  const expectedRevision = input.expectedAutomaticLearningPolicyRevision;
  if (expectedRevision === null || snapshot.automaticLearningPolicyRevision !== expectedRevision) {
    abortCorruptSnapshot("AUTOMATIC_MEMORY_POLICY_AUTHORIZATION_MISMATCH");
  }

  const rows = await transaction.select<{
    automatic_learning_enabled: number;
    revision: number;
  }>(
    `SELECT automatic_learning_enabled, revision
     FROM story_memory_policies
     WHERE project_id = ?`,
    [snapshot.projectId],
  );
  const policy = rows[0];
  const policyMatches =
    policy?.automatic_learning_enabled === 1 && policy.revision === expectedRevision;
  if (!policyMatches) {
    abortPersistence(
      new StoryCoreError({
        code: "MEMORY_AUTO_LEARNING_DISABLED",
        message: "Automatic memory policy changed before the record could be persisted.",
        retryable: true,
        actions: ["ENABLE_MEMORY", "RETRY"],
        details: {
          expectedPolicyRevision: expectedRevision,
          actualPolicyRevision: policy?.revision ?? null,
          automaticLearningEnabled: policy?.automatic_learning_enabled === 1,
        },
      }),
    );
  }
}

async function insertMemoryRecord(
  executor: StorySqlTransaction,
  snapshot: MemoryRecordSnapshot,
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_memory_records (
       id, project_id, level, origin, status, revision,
       source_kind, source_id, source_version_id,
       automatic_learning_policy_revision, created_at, updated_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.level,
      snapshot.origin,
      snapshot.status,
      snapshot.revision,
      snapshot.source.kind,
      snapshot.source.sourceId,
      snapshot.source.sourceVersionId,
      snapshot.automaticLearningPolicyRevision,
      snapshot.createdAt,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
    ],
  );
}

function hydrateMemoryPolicy(row: MemoryPolicyRow): MemoryPolicy {
  const result = MemoryPolicy.rehydrate(parseSnapshot(row.snapshot_json) as MemoryPolicySnapshot);
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const snapshot = result.value.toSnapshot();
  if (
    snapshot.projectId !== row.project_id ||
    snapshot.automaticLearningEnabled !== (row.automatic_learning_enabled === 1) ||
    snapshot.revision !== row.revision
  ) {
    abortCorruptSnapshot("MEMORY_POLICY_PROJECTION_MISMATCH");
  }
  return result.value;
}

function hydrateMemoryRecord(row: MemoryRecordRow): MemoryRecord {
  const result = MemoryRecord.rehydrate(parseSnapshot(row.snapshot_json) as MemoryRecordSnapshot);
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const snapshot = result.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.projectId !== row.project_id ||
    snapshot.level !== row.level ||
    snapshot.origin !== row.origin ||
    snapshot.status !== row.status ||
    snapshot.revision !== row.revision ||
    snapshot.source.kind !== row.source_kind ||
    snapshot.source.sourceId !== row.source_id ||
    snapshot.source.sourceVersionId !== row.source_version_id ||
    snapshot.automaticLearningPolicyRevision !== row.automatic_learning_policy_revision
  ) {
    abortCorruptSnapshot("MEMORY_RECORD_PROJECTION_MISMATCH");
  }
  return result.value;
}

const MEMORY_RECORD_SELECT = `SELECT
  id, project_id, level, origin, status, revision,
  source_kind, source_id, source_version_id,
  automatic_learning_policy_revision, snapshot_json
FROM story_memory_records`;
