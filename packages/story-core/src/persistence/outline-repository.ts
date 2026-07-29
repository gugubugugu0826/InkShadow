import { Outline, type OutlineSnapshot } from "../outline.js";
import type { OutlineRepository } from "../ports.js";
import type { Result } from "../result.js";
import type { StoryCoreError } from "../errors.js";
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

interface OutlineRow {
  project_id: string;
  revision: number;
  snapshot_json: string;
}

export class SqliteOutlineRepository implements OutlineRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(outline: Outline): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      const snapshot = outline.toSnapshot();
      await this.executor.execute(
        `INSERT INTO story_outlines (project_id, revision, snapshot_json)
         VALUES (?, ?, ?)`,
        [snapshot.projectId, snapshot.revision, serializeSnapshot(snapshot)],
      );
    });
  }

  public findByProjectId(projectId: UuidV7): Promise<Result<Outline | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<OutlineRow>(
        `SELECT project_id, revision, snapshot_json
         FROM story_outlines
         WHERE project_id = ?`,
        [projectId],
      );
      const row = rows[0];
      return row === undefined ? null : hydrateOutline(row);
    });
  }

  public save(outline: Outline, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      assertNextRevision("Outline", outline.revision, expectedRevision);
      const snapshot = outline.toSnapshot();
      const updated = await this.executor.execute(
        `UPDATE story_outlines
         SET revision = ?, snapshot_json = ?
         WHERE project_id = ? AND revision = ?`,
        [snapshot.revision, serializeSnapshot(snapshot), snapshot.projectId, expectedRevision],
      );
      if (updated.rowsAffected !== 1) {
        await abortRevisionConflict(this.executor, {
          table: "story_outlines",
          idColumn: "project_id",
          id: snapshot.projectId,
          entity: "Outline",
          expectedRevision,
        });
      }
    });
  }
}

function hydrateOutline(row: OutlineRow): Outline {
  const result = Outline.rehydrate(parseSnapshot(row.snapshot_json) as OutlineSnapshot);
  if (
    !result.ok ||
    result.value.projectId !== row.project_id ||
    result.value.revision !== row.revision
  ) {
    abortCorruptSnapshot(result.ok ? "OUTLINE_PROJECTION_MISMATCH" : result.error.code);
  }
  return result.value;
}
