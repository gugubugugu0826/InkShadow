import type { StoryCoreError } from "../errors.js";
import { IdeationDraft, type IdeationDraftSnapshot } from "../ideation.js";
import type { IdeationDraftRepository } from "../ports.js";
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
import type { StorySqlExecutor } from "./executor.js";

interface IdeationDraftRow {
  id: string;
  mode: string;
  status: string;
  project_id: string | null;
  revision: number;
  updated_at: string;
  snapshot_json: string;
}

export class SqliteIdeationDraftRepository implements IdeationDraftRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(draft: IdeationDraft): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      const snapshot = draft.toSnapshot();
      await this.executor.execute(
        `INSERT INTO story_ideation_drafts (
           id, mode, status, project_id, revision, updated_at, snapshot_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          snapshot.mode,
          snapshot.status,
          snapshot.projectId,
          snapshot.revision,
          snapshot.updatedAt,
          serializeSnapshot(snapshot),
        ],
      );
    });
  }

  public findById(id: UuidV7): Promise<Result<IdeationDraft | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<IdeationDraftRow>(
        `${SELECT_DRAFT}
         WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? null : hydrateDraft(row);
    });
  }

  public listActive(): Promise<Result<readonly IdeationDraft[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<IdeationDraftRow>(
        `${SELECT_DRAFT}
         WHERE status = 'active'
         ORDER BY updated_at DESC, id`,
      );
      return Object.freeze(rows.map(hydrateDraft));
    });
  }

  public save(
    draft: IdeationDraft,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      assertNextRevision("Ideation draft", draft.revision, expectedRevision);
      const snapshot = draft.toSnapshot();
      const updated = await this.executor.execute(
        `UPDATE story_ideation_drafts
         SET mode = ?, status = ?, project_id = ?, revision = ?,
             updated_at = ?, snapshot_json = ?
         WHERE id = ? AND revision = ?`,
        [
          snapshot.mode,
          snapshot.status,
          snapshot.projectId,
          snapshot.revision,
          snapshot.updatedAt,
          serializeSnapshot(snapshot),
          snapshot.id,
          expectedRevision,
        ],
      );
      if (updated.rowsAffected !== 1) {
        await abortRevisionConflict(this.executor, {
          table: "story_ideation_drafts",
          idColumn: "id",
          id: snapshot.id,
          entity: "Ideation draft",
          expectedRevision,
        });
      }
    });
  }
}

const SELECT_DRAFT = `SELECT id, mode, status, project_id, revision, updated_at, snapshot_json
FROM story_ideation_drafts`;

function hydrateDraft(row: IdeationDraftRow): IdeationDraft {
  const result = IdeationDraft.rehydrate(parseSnapshot(row.snapshot_json) as IdeationDraftSnapshot);
  if (
    !result.ok ||
    result.value.id !== row.id ||
    result.value.revision !== row.revision ||
    result.value.status !== row.status ||
    result.value.projectId !== row.project_id ||
    result.value.toSnapshot().mode !== row.mode ||
    result.value.toSnapshot().updatedAt !== row.updated_at
  ) {
    abortCorruptSnapshot(result.ok ? "IDEATION_PROJECTION_MISMATCH" : result.error.code);
  }
  return result.value;
}
