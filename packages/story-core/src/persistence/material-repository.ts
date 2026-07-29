import { StoryCoreError } from "../errors.js";
import {
  Material,
  MaterialReference,
  type MaterialReferenceSnapshot,
  type MaterialSnapshot,
} from "../material.js";
import type {
  CommitMaterialDispositionInput,
  MaterialDispositionUnitOfWork,
  MaterialReferenceRepository,
  MaterialRepository,
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

interface MaterialRow {
  id: string;
  project_id: string;
  status: string;
  license: string;
  rights_confirmed: number;
  allow_generation: number;
  allow_training: number;
  content_fingerprint: string;
  revision: number;
  merged_into_id: string | null;
  deleted_at: string | null;
  retention_until: string | null;
  disposition_reference_count: number | null;
  created_at: string;
  updated_at: string;
  snapshot_json: string;
}

interface MaterialReferenceRow {
  id: string;
  material_id: string;
  project_id: string;
  target_chapter_id: string;
  target_version_id: string;
  created_at: string;
  snapshot_json: string;
}

interface CountRow {
  count: number;
}

export class SqliteMaterialRepository implements MaterialRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(material: Material): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = material.toSnapshot();
        await rejectActiveDuplicate(
          transaction,
          snapshot.projectId,
          snapshot.contentFingerprint,
          null,
        );
        await insertMaterial(transaction, snapshot);
      }),
    );
  }

  public findById(id: UuidV7): Promise<Result<Material | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<MaterialRow>(
        `${MATERIAL_SELECT}
         WHERE id = ?`,
        [id],
      );
      return rows[0] === undefined ? null : hydrateMaterial(rows[0]);
    });
  }

  public findActiveByFingerprint(
    projectId: UuidV7,
    contentFingerprint: string,
    excludeMaterialId?: UuidV7,
  ): Promise<Result<Material | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<MaterialRow>(
        `${MATERIAL_SELECT}
         WHERE project_id = ?
           AND content_fingerprint = ?
           AND status = 'active'
           ${excludeMaterialId === undefined ? "" : "AND id <> ?"}
         ORDER BY updated_at DESC, id ASC
         LIMIT 1`,
        excludeMaterialId === undefined
          ? [projectId, contentFingerprint]
          : [projectId, contentFingerprint, excludeMaterialId],
      );
      return rows[0] === undefined ? null : hydrateMaterial(rows[0]);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
    includeDisposed: boolean,
  ): Promise<Result<readonly Material[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<MaterialRow>(
        `${MATERIAL_SELECT}
         WHERE project_id = ?
           ${includeDisposed ? "" : "AND status = 'active'"}
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'deleted' THEN 1 ELSE 2 END,
           updated_at DESC,
           id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateMaterial));
    });
  }

  public save(material: Material, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = material.toSnapshot();
        if (snapshot.status === "active") {
          await rejectActiveDuplicate(
            transaction,
            snapshot.projectId,
            snapshot.contentFingerprint,
            snapshot.id,
          );
        }
        await updateMaterial(transaction, snapshot, expectedRevision);
      }),
    );
  }
}

export class SqliteMaterialReferenceRepository implements MaterialReferenceRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(reference: MaterialReference): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      const snapshot = reference.toSnapshot();
      const materialRows = await this.executor.select<MaterialRow>(
        `${MATERIAL_SELECT}
         WHERE id = ?`,
        [snapshot.materialId],
      );
      const material =
        materialRows[0] === undefined ? null : hydrateMaterial(materialRows[0]).toSnapshot();
      if (
        material?.status !== "active" ||
        material.projectId !== snapshot.projectId ||
        material.contentFingerprint !== snapshot.provenance.contentFingerprint
      ) {
        abortPersistence(
          new StoryCoreError({
            code: "MATERIAL_INVALID_TRANSITION",
            message: "Material changed before its reference was stored.",
            actions: ["OPEN_SOURCE", "RETRY"],
          }),
        );
      }
      await this.executor.execute(
        `INSERT INTO story_material_references (
           id, material_id, project_id, target_chapter_id,
           target_version_id, created_at, snapshot_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          snapshot.materialId,
          snapshot.projectId,
          snapshot.targetChapterId,
          snapshot.targetVersionId,
          snapshot.createdAt,
          serializeSnapshot(snapshot),
        ],
      );
    });
  }

  public countByMaterialId(materialId: UuidV7): Promise<Result<number, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<CountRow>(
        `SELECT count(*) AS count
         FROM story_material_references
         WHERE material_id = ?`,
        [materialId],
      );
      return requireCount(rows[0]?.count);
    });
  }

  public listByMaterialId(
    materialId: UuidV7,
  ): Promise<Result<readonly MaterialReference[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<MaterialReferenceRow>(
        `${MATERIAL_REFERENCE_SELECT}
         WHERE material_id = ?
         ORDER BY created_at DESC, id ASC`,
        [materialId],
      );
      return Object.freeze(rows.map(hydrateReference));
    });
  }
}

export class SqliteMaterialDispositionUnitOfWork implements MaterialDispositionUnitOfWork {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public commit(input: CommitMaterialDispositionInput): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = input.material.toSnapshot();
        const countRows = await transaction.select<CountRow>(
          `SELECT count(*) AS count
           FROM story_material_references
           WHERE material_id = ?`,
          [snapshot.id],
        );
        const actualReferenceCount = requireCount(countRows[0]?.count);
        if (
          actualReferenceCount !== input.expectedReferenceCount ||
          snapshot.dispositionReferenceCount !== actualReferenceCount
        ) {
          abortPersistence(
            new StoryCoreError({
              code: "MATERIAL_REFERENCE_IMPACT_CHANGED",
              message: "Material references changed after the impact preview.",
              retryable: true,
              actions: ["OPEN_REFERENCES", "RETRY"],
              details: {
                expectedReferenceCount: input.expectedReferenceCount,
                actualReferenceCount,
              },
            }),
          );
        }
        if (input.survivorId === null) {
          if (
            input.expectedSurvivorRevision !== null ||
            snapshot.status !== "deleted" ||
            snapshot.mergedIntoId !== null
          ) {
            invalidDisposition();
          }
        } else {
          const survivorRows = await transaction.select<MaterialRow>(
            `${MATERIAL_SELECT}
             WHERE id = ?`,
            [input.survivorId],
          );
          const survivor =
            survivorRows[0] === undefined ? null : hydrateMaterial(survivorRows[0]).toSnapshot();
          if (
            survivor?.status !== "active" ||
            survivor.projectId !== snapshot.projectId ||
            survivor.revision !== input.expectedSurvivorRevision ||
            snapshot.status !== "merged" ||
            snapshot.mergedIntoId !== survivor.id
          ) {
            invalidDisposition();
          }
        }
        await updateMaterial(transaction, snapshot, input.expectedMaterialRevision);
      }),
    );
  }
}

async function insertMaterial(
  executor: StorySqlTransaction,
  snapshot: MaterialSnapshot,
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_materials (
       id, project_id, status, license, rights_confirmed,
       allow_generation, allow_training, content_fingerprint,
       revision, merged_into_id, deleted_at, retention_until,
       disposition_reference_count, created_at, updated_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    materialBindings(snapshot),
  );
}

async function updateMaterial(
  executor: StorySqlTransaction,
  snapshot: MaterialSnapshot,
  expectedRevision: number,
): Promise<void> {
  assertNextRevision("Material", snapshot.revision, expectedRevision);
  const bindings = materialBindings(snapshot);
  const updated = await executor.execute(
    `UPDATE story_materials
     SET status = ?, license = ?, rights_confirmed = ?,
         allow_generation = ?, allow_training = ?, content_fingerprint = ?,
         revision = ?, merged_into_id = ?, deleted_at = ?, retention_until = ?,
         disposition_reference_count = ?, updated_at = ?, snapshot_json = ?
     WHERE id = ? AND project_id = ? AND revision = ?`,
    [
      ...bindings.slice(2, 13),
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
      snapshot.id,
      snapshot.projectId,
      expectedRevision,
    ],
  );
  if (updated.rowsAffected !== 1) {
    await abortRevisionConflict(executor, {
      table: "story_materials",
      idColumn: "id",
      id: snapshot.id,
      entity: "Material",
      expectedRevision,
    });
  }
}

function materialBindings(snapshot: MaterialSnapshot): readonly (string | number | null)[] {
  return [
    snapshot.id,
    snapshot.projectId,
    snapshot.status,
    snapshot.license,
    snapshot.permissions.rightsConfirmedAt === null ? 0 : 1,
    snapshot.permissions.allowGeneration ? 1 : 0,
    snapshot.permissions.allowTraining ? 1 : 0,
    snapshot.contentFingerprint,
    snapshot.revision,
    snapshot.mergedIntoId,
    snapshot.deletedAt,
    snapshot.retentionUntil,
    snapshot.dispositionReferenceCount,
    snapshot.createdAt,
    snapshot.updatedAt,
    serializeSnapshot(snapshot),
  ];
}

async function rejectActiveDuplicate(
  executor: StorySqlTransaction,
  projectId: UuidV7,
  fingerprint: string,
  excludeMaterialId: UuidV7 | null,
): Promise<void> {
  const rows = await executor.select<{ id: string }>(
    `SELECT id
     FROM story_materials
     WHERE project_id = ?
       AND content_fingerprint = ?
       AND status = 'active'
       ${excludeMaterialId === null ? "" : "AND id <> ?"}
     LIMIT 1`,
    excludeMaterialId === null
      ? [projectId, fingerprint]
      : [projectId, fingerprint, excludeMaterialId],
  );
  if (rows[0] !== undefined) {
    abortPersistence(
      new StoryCoreError({
        code: "MATERIAL_DUPLICATE_FOUND",
        message: "An active material with the same content already exists.",
        actions: ["USE_EXISTING_MATERIAL", "OPEN_SOURCE"],
        details: { existingMaterialId: rows[0].id },
      }),
    );
  }
}

function hydrateMaterial(row: MaterialRow): Material {
  const result = Material.rehydrate(parseSnapshot(row.snapshot_json) as MaterialSnapshot);
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const snapshot = result.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.projectId !== row.project_id ||
    snapshot.status !== row.status ||
    snapshot.license !== row.license ||
    (snapshot.permissions.rightsConfirmedAt === null ? 0 : 1) !== row.rights_confirmed ||
    (snapshot.permissions.allowGeneration ? 1 : 0) !== row.allow_generation ||
    (snapshot.permissions.allowTraining ? 1 : 0) !== row.allow_training ||
    snapshot.contentFingerprint !== row.content_fingerprint ||
    snapshot.revision !== row.revision ||
    snapshot.mergedIntoId !== row.merged_into_id ||
    snapshot.deletedAt !== row.deleted_at ||
    snapshot.retentionUntil !== row.retention_until ||
    snapshot.dispositionReferenceCount !== row.disposition_reference_count ||
    snapshot.createdAt !== row.created_at ||
    snapshot.updatedAt !== row.updated_at
  ) {
    abortCorruptSnapshot("MATERIAL_PROJECTION_MISMATCH");
  }
  return result.value;
}

function hydrateReference(row: MaterialReferenceRow): MaterialReference {
  const result = MaterialReference.rehydrate(
    parseSnapshot(row.snapshot_json) as MaterialReferenceSnapshot,
  );
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const snapshot = result.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.materialId !== row.material_id ||
    snapshot.projectId !== row.project_id ||
    snapshot.targetChapterId !== row.target_chapter_id ||
    snapshot.targetVersionId !== row.target_version_id ||
    snapshot.createdAt !== row.created_at
  ) {
    abortCorruptSnapshot("MATERIAL_REFERENCE_PROJECTION_MISMATCH");
  }
  return result.value;
}

function requireCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
    abortCorruptSnapshot("MATERIAL_REFERENCE_COUNT_INVALID");
  }
  return value;
}

function invalidDisposition(): never {
  return abortPersistence(
    new StoryCoreError({
      code: "MATERIAL_INVALID_TRANSITION",
      message: "Material disposition no longer matches its validated impact.",
      retryable: true,
      actions: ["RECOMPARE", "OPEN_REFERENCES"],
    }),
  );
}

const MATERIAL_SELECT = `SELECT
  id, project_id, status, license, rights_confirmed,
  allow_generation, allow_training, content_fingerprint,
  revision, merged_into_id, deleted_at, retention_until,
  disposition_reference_count, created_at, updated_at, snapshot_json
FROM story_materials`;

const MATERIAL_REFERENCE_SELECT = `SELECT
  id, material_id, project_id, target_chapter_id,
  target_version_id, created_at, snapshot_json
FROM story_material_references`;
