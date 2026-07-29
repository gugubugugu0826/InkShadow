import type { StoryCoreError } from "../errors.js";
import { FormalStoryRecord, type FormalStoryRecordSnapshot } from "../formal-record.js";
import type {
  FormalStoryRecordListReader,
  FormalStoryRecordRepository,
  FormalTimelineReader,
  FormalTimelineSnapshot,
} from "../ports.js";
import type { Result } from "../result.js";
import type { UuidV7 } from "../value-objects.js";
import {
  abortCorruptSnapshot,
  abortRevisionConflict,
  assertNextRevision,
  parseSnapshot,
  runPersistence,
  serializeSnapshot,
} from "./common.js";
import type { StorySqlExecutor, StorySqlTransaction } from "./executor.js";

export interface FormalRecordRow {
  id: string;
  project_id: string;
  kind: string;
  record_key: string;
  revision: number;
  current_version: number;
  snapshot_json: string;
}

interface TimelineStateRow {
  revision: number;
}

export class SqliteFormalStoryRecordRepository
  implements FormalStoryRecordRepository, FormalStoryRecordListReader, FormalTimelineReader
{
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(record: FormalStoryRecord): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        await insertFormalRecord(transaction, record);
      }),
    );
  }

  public findById(id: UuidV7): Promise<Result<FormalStoryRecord | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<FormalRecordRow>(
        `${FORMAL_RECORD_SELECT}
         WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? null : hydrateFormalRecord(row);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly FormalStoryRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<FormalRecordRow>(
        `${FORMAL_RECORD_SELECT}
         WHERE project_id = ?
         ORDER BY kind ASC, updated_at DESC, id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateFormalRecord));
    });
  }

  public save(
    record: FormalStoryRecord,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        await updateFormalRecord(transaction, record, expectedRevision);
      }),
    );
  }

  public load(projectId: UuidV7): Promise<Result<FormalTimelineSnapshot, StoryCoreError>> {
    return runPersistence(async () => {
      const [stateRows, recordRows] = await Promise.all([
        this.executor.select<TimelineStateRow>(
          `SELECT revision
           FROM story_timeline_state
           WHERE project_id = ?`,
          [projectId],
        ),
        this.executor.select<FormalRecordRow>(
          `${FORMAL_RECORD_SELECT}
           WHERE project_id = ? AND kind = 'timeline_event'
           ORDER BY created_at ASC, id ASC`,
          [projectId],
        ),
      ]);
      const events = recordRows.map(hydrateFormalRecord);
      const state = stateRows[0];
      if (events.length > 0 && state === undefined) {
        abortCorruptSnapshot("TIMELINE_STATE_MISSING");
      }
      return {
        projectId,
        revision: state?.revision ?? 1,
        events: Object.freeze(events),
      };
    });
  }
}

export async function insertFormalRecord(
  transaction: StorySqlTransaction,
  record: FormalStoryRecord,
): Promise<void> {
  const snapshot = record.toSnapshot();
  await transaction.execute(
    `INSERT INTO story_formal_records (
       id, project_id, kind, record_key, revision, current_version,
       created_at, updated_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.kind,
      snapshot.recordKey,
      snapshot.revision,
      snapshot.currentVersion,
      snapshot.createdAt,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
    ],
  );
  if (snapshot.kind === "timeline_event") {
    await bumpTimelineRevision(transaction, snapshot.projectId);
  }
}

export async function updateFormalRecord(
  transaction: StorySqlTransaction,
  record: FormalStoryRecord,
  expectedRevision: number,
): Promise<void> {
  assertNextRevision("Formal story record", record.revision, expectedRevision);
  const snapshot = record.toSnapshot();
  const updated = await transaction.execute(
    `UPDATE story_formal_records
     SET revision = ?, current_version = ?, updated_at = ?, snapshot_json = ?
     WHERE id = ? AND project_id = ? AND kind = ? AND revision = ?`,
    [
      snapshot.revision,
      snapshot.currentVersion,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
      snapshot.id,
      snapshot.projectId,
      snapshot.kind,
      expectedRevision,
    ],
  );
  if (updated.rowsAffected !== 1) {
    await abortRevisionConflict(transaction, {
      table: "story_formal_records",
      idColumn: "id",
      id: snapshot.id,
      entity: "Formal story record",
      expectedRevision,
    });
  }
  if (snapshot.kind === "timeline_event") {
    await bumpTimelineRevision(transaction, snapshot.projectId);
  }
}

export async function bumpTimelineRevision(
  transaction: StorySqlTransaction,
  projectId: string,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO story_timeline_state (project_id, revision)
     VALUES (?, 2)
     ON CONFLICT(project_id)
     DO UPDATE SET revision = story_timeline_state.revision + 1`,
    [projectId],
  );
}

export function hydrateFormalRecord(row: FormalRecordRow): FormalStoryRecord {
  const result = FormalStoryRecord.rehydrate(
    parseSnapshot(row.snapshot_json) as FormalStoryRecordSnapshot,
  );
  if (
    !result.ok ||
    result.value.id !== row.id ||
    result.value.projectId !== row.project_id ||
    result.value.kind !== row.kind ||
    result.value.revision !== row.revision ||
    result.value.toSnapshot().recordKey !== row.record_key ||
    result.value.toSnapshot().currentVersion !== row.current_version
  ) {
    abortCorruptSnapshot(result.ok ? "FORMAL_PROJECTION_MISMATCH" : result.error.code);
  }
  return result.value;
}

const FORMAL_RECORD_SELECT = `SELECT
  id, project_id, kind, record_key, revision, current_version, snapshot_json
FROM story_formal_records`;
