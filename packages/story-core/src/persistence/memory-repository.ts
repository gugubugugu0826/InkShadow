import { StoryCoreError } from "../errors.js";
import {
  MemoryPolicy,
  MemoryRecord,
  type MemoryPolicySnapshot,
  type MemoryRecordSnapshot,
} from "../memory.js";
import type {
  CommitMemoryGovernanceInput,
  CreateMemoryPolicyResult,
  CreateMemoryRecordPersistenceInput,
  MemoryGovernanceReceipt,
  MemoryGovernanceUnitOfWork,
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

interface MemoryGovernanceEventRow {
  id: string;
  project_id: string;
  operation: "forget_project" | "merge";
  target_record_id: string | null;
  affected_record_count: number;
  resulting_policy_revision: number | null;
  request_json: string;
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

export class SqliteMemoryGovernanceUnitOfWork implements MemoryGovernanceUnitOfWork {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public commit(
    input: CommitMemoryGovernanceInput,
  ): Promise<Result<MemoryGovernanceReceipt, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        assertMemoryGovernanceInput(input);
        const replay = await selectGovernanceEvent(transaction, input.operationId);
        if (replay !== null) {
          if (
            replay.project_id !== input.projectId ||
            replay.operation !== input.operation ||
            replay.target_record_id !== input.targetRecordId ||
            replay.request_json !== input.requestJson
          ) {
            abortMemoryIdempotencyConflict(input.operationId);
          }
          return governanceReceipt(replay, true);
        }

        await assertCurrentMemoryGovernanceState(transaction, input);
        await persistMemoryGovernancePolicy(transaction, input);
        for (const transition of input.records) {
          await persistMemoryGovernanceRecord(transaction, transition.previous, transition.next);
        }

        const beforeSnapshot = serializeSnapshot({
          policy: input.previousPolicy?.toSnapshot() ?? null,
          records: input.records.map(({ role, previous }) => ({
            role,
            snapshot: previous.toSnapshot(),
          })),
        });
        const afterSnapshot = serializeSnapshot({
          policy: input.nextPolicy?.toSnapshot() ?? null,
          records: input.records.map(({ role, next }) => ({
            role,
            snapshot: next.toSnapshot(),
          })),
        });
        await transaction.execute(
          `INSERT INTO story_memory_governance_events (
             id, project_id, operation, target_record_id, affected_record_count,
             resulting_policy_revision, request_json, before_snapshot_json,
             after_snapshot_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.operationId,
            input.projectId,
            input.operation,
            input.targetRecordId,
            input.records.length,
            input.nextPolicy?.revision ?? null,
            input.requestJson,
            beforeSnapshot,
            afterSnapshot,
            input.now,
          ],
        );
        return {
          operationId: input.operationId,
          projectId: input.projectId,
          operation: input.operation,
          affectedRecordCount: input.records.length,
          resultingPolicyRevision: input.nextPolicy?.revision ?? null,
          idempotentReplay: false,
        };
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

export async function insertMemoryRecord(
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

async function selectGovernanceEvent(
  transaction: StorySqlTransaction,
  operationId: string,
): Promise<MemoryGovernanceEventRow | null> {
  const rows = await transaction.select<MemoryGovernanceEventRow>(
    `SELECT id, project_id, operation, target_record_id, affected_record_count,
            resulting_policy_revision, request_json
     FROM story_memory_governance_events
     WHERE id = ?`,
    [operationId],
  );
  return rows[0] ?? null;
}

async function assertCurrentMemoryGovernanceState(
  transaction: StorySqlTransaction,
  input: CommitMemoryGovernanceInput,
): Promise<void> {
  if (input.operation === "forget_project") {
    const previousPolicy = input.previousPolicy;
    if (previousPolicy === null) {
      abortCorruptSnapshot("MEMORY_FORGET_POLICY_MISSING");
    }
    const currentPolicy = await selectPolicy(transaction, input.projectId);
    if (currentPolicy?.revision !== previousPolicy.revision) {
      await abortRevisionConflict(transaction, {
        table: "story_memory_policies",
        idColumn: "project_id",
        id: input.projectId,
        entity: "Memory policy",
        expectedRevision: previousPolicy.revision,
      });
    }
    const rows = await transaction.select<MemoryRecordRow>(
      `${MEMORY_RECORD_SELECT}
       WHERE project_id = ?
       ORDER BY id ASC`,
      [input.projectId],
    );
    const current = rows.map(hydrateMemoryRecord);
    const expected = [...input.records]
      .map(({ previous }) => previous)
      .sort((left, right) => left.id.localeCompare(right.id));
    const currentFingerprint = current
      .map(({ id, revision }) => `${id}:${String(revision)}`)
      .join("|");
    const expectedFingerprint = expected
      .map(({ id, revision }) => `${id}:${String(revision)}`)
      .join("|");
    if (current.length !== expected.length || currentFingerprint !== expectedFingerprint) {
      abortPersistence(
        new StoryCoreError({
          code: "STORY_REVISION_CONFLICT",
          message: "Project memory scope changed before it could be forgotten.",
          retryable: true,
          actions: ["RECOMPARE", "RETRY"],
          details: {
            expectedRevision: expected.length,
            actualRevision: current.length,
          },
        }),
      );
    }
    return;
  }

  for (const { previous } of input.records) {
    const rows = await transaction.select<MemoryRecordRow>(
      `${MEMORY_RECORD_SELECT}
       WHERE id = ?`,
      [previous.id],
    );
    const current = rows[0] === undefined ? null : hydrateMemoryRecord(rows[0]);
    const currentMatches =
      current?.projectId === input.projectId && current.revision === previous.revision;
    if (!currentMatches) {
      await abortRevisionConflict(transaction, {
        table: "story_memory_records",
        idColumn: "id",
        id: previous.id,
        entity: "Memory record",
        expectedRevision: previous.revision,
      });
    }
  }
}

async function persistMemoryGovernancePolicy(
  transaction: StorySqlTransaction,
  input: CommitMemoryGovernanceInput,
): Promise<void> {
  const previous = input.previousPolicy;
  const next = input.nextPolicy;
  if (previous === null || next === null || next.revision === previous.revision) {
    return;
  }
  assertNextRevision("Memory policy", next.revision, previous.revision);
  const snapshot = next.toSnapshot();
  const updated = await transaction.execute(
    `UPDATE story_memory_policies
     SET automatic_learning_enabled = ?, revision = ?, updated_at = ?, snapshot_json = ?
     WHERE project_id = ? AND revision = ?`,
    [
      snapshot.automaticLearningEnabled ? 1 : 0,
      snapshot.revision,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
      snapshot.projectId,
      previous.revision,
    ],
  );
  if (updated.rowsAffected !== 1) {
    await abortRevisionConflict(transaction, {
      table: "story_memory_policies",
      idColumn: "project_id",
      id: snapshot.projectId,
      entity: "Memory policy",
      expectedRevision: previous.revision,
    });
  }
}

async function persistMemoryGovernanceRecord(
  transaction: StorySqlTransaction,
  previous: MemoryRecord,
  next: MemoryRecord,
): Promise<void> {
  if (next.revision === previous.revision) {
    return;
  }
  assertNextRevision("Memory record", next.revision, previous.revision);
  const snapshot = next.toSnapshot();
  const updated = await transaction.execute(
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
      previous.revision,
    ],
  );
  if (updated.rowsAffected !== 1) {
    await abortRevisionConflict(transaction, {
      table: "story_memory_records",
      idColumn: "id",
      id: snapshot.id,
      entity: "Memory record",
      expectedRevision: previous.revision,
    });
  }
}

function assertMemoryGovernanceInput(input: CommitMemoryGovernanceInput): void {
  const seen = new Set<string>();
  let mergeTargetCount = 0;
  let mergeSourceCount = 0;
  for (const transition of input.records) {
    const previous = transition.previous.toSnapshot();
    const next = transition.next.toSnapshot();
    if (
      seen.has(previous.id) ||
      previous.id !== next.id ||
      previous.projectId !== input.projectId ||
      next.projectId !== input.projectId ||
      next.revision !== previous.revision + 1
    ) {
      abortCorruptSnapshot("MEMORY_GOVERNANCE_TRANSITION_INVALID");
    }
    seen.add(previous.id);
    mergeTargetCount += transition.role === "merge_target" ? 1 : 0;
    mergeSourceCount += transition.role === "merge_source" ? 1 : 0;
  }
  let request: unknown;
  try {
    request = JSON.parse(input.requestJson) as unknown;
  } catch {
    abortCorruptSnapshot("MEMORY_GOVERNANCE_REQUEST_JSON_INVALID");
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    abortCorruptSnapshot("MEMORY_GOVERNANCE_REQUEST_JSON_INVALID");
  }
  const forgetValid =
    input.operation === "forget_project" &&
    input.targetRecordId === null &&
    input.previousPolicy !== null &&
    input.nextPolicy !== null &&
    input.previousPolicy.projectId === input.projectId &&
    input.nextPolicy.projectId === input.projectId &&
    input.nextPolicy.revision === input.previousPolicy.revision + 1 &&
    !input.nextPolicy.automaticLearningEnabled &&
    input.records.every(({ role, next }) => role === "forgotten" && next.toSnapshot().excluded);
  const mergeValid =
    input.operation === "merge" &&
    input.targetRecordId !== null &&
    input.previousPolicy === null &&
    input.nextPolicy === null &&
    input.records.length === 2 &&
    mergeTargetCount === 1 &&
    mergeSourceCount === 1 &&
    input.records.some(
      ({ role, previous }) => role === "merge_target" && previous.id === input.targetRecordId,
    ) &&
    input.records.every(({ role, next }) =>
      role === "merge_source" ? next.toSnapshot().excluded : !next.toSnapshot().excluded,
    );
  if (!forgetValid && !mergeValid) {
    abortCorruptSnapshot("MEMORY_GOVERNANCE_OPERATION_INVALID");
  }
}

function governanceReceipt(
  row: MemoryGovernanceEventRow,
  idempotentReplay: boolean,
): MemoryGovernanceReceipt {
  return {
    operationId: row.id as MemoryGovernanceReceipt["operationId"],
    projectId: row.project_id as MemoryGovernanceReceipt["projectId"],
    operation: row.operation,
    affectedRecordCount: row.affected_record_count,
    resultingPolicyRevision: row.resulting_policy_revision,
    idempotentReplay,
  };
}

function abortMemoryIdempotencyConflict(operationId: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "MEMORY_IDEMPOTENCY_CONFLICT",
      message: "The memory operation id was already used for a different confirmed request.",
      actions: ["RECOMPARE"],
      details: { operationId },
    }),
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
