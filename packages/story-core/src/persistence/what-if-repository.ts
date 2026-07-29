import { StoryCoreError } from "../errors.js";
import type {
  OutlineDraftReader,
  PromoteWhatIfInput,
  WhatIfBranchListReader,
  WhatIfPromotionUnitOfWork,
  WhatIfRepository,
} from "../ports.js";
import type { Result } from "../result.js";
import { MAX_MEMORY_TEXT_LENGTH, validateBoundedText } from "../safety.js";
import { parseIsoUtcTimestamp, parseUuidV7, type UuidV7 } from "../value-objects.js";
import { WhatIfBranch, type OutlineDraftCandidate, type WhatIfBranchSnapshot } from "../what-if.js";
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

interface WhatIfRow {
  id: string;
  project_id: string;
  source_event_id: string;
  base_timeline_revision: number;
  status: string;
  revision: number;
  snapshot_json: string;
}

interface OutlineDraftRow {
  id: string;
  source_branch_id: string;
  project_id: string;
  created_at: string;
  snapshot_json: string;
}

export class SqliteWhatIfRepository implements WhatIfRepository, WhatIfBranchListReader {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(branch: WhatIfBranch): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      await insertBranch(this.executor, branch.toSnapshot());
    });
  }

  public findById(id: UuidV7): Promise<Result<WhatIfBranch | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<WhatIfRow>(
        `${WHAT_IF_SELECT}
         WHERE id = ?`,
        [id],
      );
      return rows[0] === undefined ? null : hydrateWhatIfBranch(rows[0]);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly WhatIfBranch[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<WhatIfRow>(
        `${WHAT_IF_SELECT}
         WHERE project_id = ?
         ORDER BY updated_at DESC, id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateWhatIfBranch));
    });
  }

  public save(
    branch: WhatIfBranch,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      await updateBranch(this.executor, branch.toSnapshot(), expectedRevision);
    });
  }
}

export class SqliteOutlineDraftReader implements OutlineDraftReader {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly OutlineDraftCandidate[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<OutlineDraftRow>(
        `SELECT id, source_branch_id, project_id, created_at, snapshot_json
         FROM story_outline_drafts
         WHERE project_id = ?
         ORDER BY created_at DESC, id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateOutlineDraft));
    });
  }
}

export class SqliteWhatIfPromotionUnitOfWork implements WhatIfPromotionUnitOfWork {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public commit(input: PromoteWhatIfInput): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const branch = input.branch.toSnapshot();
        validatePromotion(branch, input);
        await updateBranch(transaction, branch, input.expectedBranchRevision);
        await insertOutlineDraft(transaction, input.draft);
      }),
    );
  }
}

async function insertBranch(
  executor: StorySqlTransaction,
  snapshot: WhatIfBranchSnapshot,
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_what_if_branches (
       id, project_id, source_event_id, base_timeline_revision,
       status, revision, created_at, updated_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.sourceEventId,
      snapshot.baseTimelineRevision,
      snapshot.status,
      snapshot.revision,
      snapshot.createdAt,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
    ],
  );
}

async function updateBranch(
  executor: StorySqlTransaction,
  snapshot: WhatIfBranchSnapshot,
  expectedRevision: number,
): Promise<void> {
  assertNextRevision("What-if branch", snapshot.revision, expectedRevision);
  const updated = await executor.execute(
    `UPDATE story_what_if_branches
     SET status = ?, revision = ?, updated_at = ?, snapshot_json = ?
     WHERE id = ? AND project_id = ? AND revision = ?`,
    [
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
    await abortRevisionConflict(executor, {
      table: "story_what_if_branches",
      idColumn: "id",
      id: snapshot.id,
      entity: "What-if branch",
      expectedRevision,
    });
  }
}

function validatePromotion(branch: WhatIfBranchSnapshot, input: PromoteWhatIfInput): void {
  const draft = input.draft;
  if (
    branch.status !== "promoted_to_outline_draft" ||
    branch.revision !== input.expectedBranchRevision + 1 ||
    draft.sourceBranchId !== branch.id ||
    draft.projectId !== branch.projectId ||
    draft.createdAt !== branch.updatedAt
  ) {
    abortPersistence(
      new StoryCoreError({
        code: "WHAT_IF_INVALID_TRANSITION",
        message: "What-if promotion does not match its validated outline draft.",
        actions: ["RECOMPARE", "DISCARD_BRANCH"],
      }),
    );
  }
}

async function insertOutlineDraft(
  executor: StorySqlTransaction,
  draft: OutlineDraftCandidate,
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_outline_drafts (
       id, source_branch_id, project_id, created_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?)`,
    [draft.id, draft.sourceBranchId, draft.projectId, draft.createdAt, serializeSnapshot(draft)],
  );
}

function hydrateWhatIfBranch(row: WhatIfRow): WhatIfBranch {
  const result = WhatIfBranch.rehydrate(parseSnapshot(row.snapshot_json) as WhatIfBranchSnapshot);
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const snapshot = result.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.projectId !== row.project_id ||
    snapshot.sourceEventId !== row.source_event_id ||
    snapshot.baseTimelineRevision !== row.base_timeline_revision ||
    snapshot.status !== row.status ||
    snapshot.revision !== row.revision
  ) {
    abortCorruptSnapshot("WHAT_IF_PROJECTION_MISMATCH");
  }
  return result.value;
}

function hydrateOutlineDraft(row: OutlineDraftRow): OutlineDraftCandidate {
  const snapshot = parseSnapshot(row.snapshot_json) as Partial<OutlineDraftCandidate>;
  const id = typeof snapshot.id === "string" ? parseUuidV7(snapshot.id) : null;
  const sourceBranchId =
    typeof snapshot.sourceBranchId === "string" ? parseUuidV7(snapshot.sourceBranchId) : null;
  const projectId = typeof snapshot.projectId === "string" ? parseUuidV7(snapshot.projectId) : null;
  const createdBy = typeof snapshot.createdBy === "string" ? parseUuidV7(snapshot.createdBy) : null;
  const createdAt =
    typeof snapshot.createdAt === "string" ? parseIsoUtcTimestamp(snapshot.createdAt) : null;
  const title =
    typeof snapshot.title === "string"
      ? validateBoundedText(snapshot.title, 200, "Outline draft title")
      : null;
  const synopsis =
    typeof snapshot.synopsis === "string"
      ? validateBoundedText(snapshot.synopsis, MAX_MEMORY_TEXT_LENGTH, "Outline draft synopsis")
      : null;
  if (
    id === null ||
    !id.ok ||
    sourceBranchId === null ||
    !sourceBranchId.ok ||
    projectId === null ||
    !projectId.ok ||
    createdBy === null ||
    !createdBy.ok ||
    createdAt === null ||
    !createdAt.ok ||
    title === null ||
    !title.ok ||
    synopsis === null ||
    !synopsis.ok ||
    snapshot.target !== "outline_draft" ||
    id.value !== row.id ||
    sourceBranchId.value !== row.source_branch_id ||
    projectId.value !== row.project_id ||
    createdAt.value !== row.created_at
  ) {
    abortCorruptSnapshot("OUTLINE_DRAFT_PROJECTION_MISMATCH");
  }
  return Object.freeze({
    id: id.value,
    sourceBranchId: sourceBranchId.value,
    projectId: projectId.value,
    title: title.value,
    synopsis: synopsis.value,
    createdBy: createdBy.value,
    createdAt: createdAt.value,
    target: "outline_draft",
  });
}

const WHAT_IF_SELECT = `SELECT
  id, project_id, source_event_id, base_timeline_revision,
  status, revision, snapshot_json
FROM story_what_if_branches`;
