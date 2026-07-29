import {
  Material,
  MaterialReference,
  StoryCoreError,
  err,
  ok,
  type CommitMaterialDispositionInput,
  type MaterialDispositionUnitOfWork,
  type MaterialReferenceRepository,
  type MaterialReferenceSnapshot,
  type MaterialRepository,
  type MaterialSnapshot,
  type Result,
  type UuidV7,
} from "@inkshadow/story-core";

export const DEVELOPMENT_MATERIAL_STORE_KEY = "inkshadow.development.materials.v1";

interface StoredMaterialDatabase {
  readonly schemaVersion: 1;
  readonly materials: Record<string, MaterialSnapshot>;
  readonly references: Record<string, MaterialReferenceSnapshot>;
}

export class BrowserDevelopmentMaterialRepository implements MaterialRepository {
  public constructor(private readonly storage: Storage) {}

  public create(material: Material): Promise<Result<void, StoryCoreError>> {
    return mutateDatabase(this.storage, (database) => {
      const snapshot = material.toSnapshot();
      if (database.materials[snapshot.id] !== undefined) {
        return repositoryError("Material already exists.");
      }
      const duplicate = activeDuplicate(
        database,
        snapshot.projectId,
        snapshot.contentFingerprint,
        null,
      );
      if (duplicate !== null) {
        return duplicateError(duplicate.id);
      }
      database.materials[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }

  public findById(id: UuidV7): Promise<Result<Material | null, StoryCoreError>> {
    return readResult(this.storage, (database) => {
      const snapshot = database.materials[id];
      return snapshot === undefined ? null : requireMaterial(snapshot);
    });
  }

  public findActiveByFingerprint(
    projectId: UuidV7,
    contentFingerprint: string,
    excludeMaterialId?: UuidV7,
  ): Promise<Result<Material | null, StoryCoreError>> {
    return readResult(this.storage, (database) =>
      activeDuplicate(database, projectId, contentFingerprint, excludeMaterialId ?? null),
    );
  }

  public listByProjectId(
    projectId: UuidV7,
    includeDisposed: boolean,
  ): Promise<Result<readonly Material[], StoryCoreError>> {
    return readResult(this.storage, (database) =>
      Object.values(database.materials)
        .map(requireMaterial)
        .filter(
          (material) =>
            material.projectId === projectId && (includeDisposed || material.status === "active"),
        )
        .sort(compareMaterials),
    );
  }

  public save(material: Material, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return mutateDatabase(this.storage, (database) => {
      const snapshot = material.toSnapshot();
      const currentSnapshot = database.materials[snapshot.id];
      if (currentSnapshot === undefined) {
        return materialNotFound();
      }
      const current = requireMaterial(currentSnapshot);
      if (
        current.projectId !== material.projectId ||
        current.revision !== expectedRevision ||
        material.revision !== expectedRevision + 1
      ) {
        return revisionConflict(expectedRevision, current.revision);
      }
      if (material.status === "active") {
        const duplicate = activeDuplicate(
          database,
          material.projectId,
          material.contentFingerprint,
          material.id,
        );
        if (duplicate !== null) {
          return duplicateError(duplicate.id);
        }
      }
      database.materials[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentMaterialReferenceRepository implements MaterialReferenceRepository {
  public constructor(private readonly storage: Storage) {}

  public create(reference: MaterialReference): Promise<Result<void, StoryCoreError>> {
    return mutateDatabase(this.storage, (database) => {
      const snapshot = reference.toSnapshot();
      if (database.references[snapshot.id] !== undefined) {
        return repositoryError("Material reference already exists.");
      }
      const materialSnapshot = database.materials[snapshot.materialId];
      const material =
        materialSnapshot === undefined ? null : requireMaterial(materialSnapshot).toSnapshot();
      if (
        material?.status !== "active" ||
        material.projectId !== snapshot.projectId ||
        material.contentFingerprint !== snapshot.provenance.contentFingerprint
      ) {
        return err(
          new StoryCoreError({
            code: "MATERIAL_INVALID_TRANSITION",
            message: "Material changed before its reference was stored.",
            retryable: true,
            actions: ["OPEN_SOURCE", "RETRY"],
          }),
        );
      }
      database.references[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }

  public countByMaterialId(materialId: UuidV7): Promise<Result<number, StoryCoreError>> {
    return readResult(
      this.storage,
      (database) =>
        Object.values(database.references).filter(
          (reference) => reference.materialId === materialId,
        ).length,
    );
  }

  public listByMaterialId(
    materialId: UuidV7,
  ): Promise<Result<readonly MaterialReference[], StoryCoreError>> {
    return readResult(this.storage, (database) =>
      Object.values(database.references)
        .filter((snapshot) => snapshot.materialId === materialId)
        .map(requireReference)
        .sort(
          (left, right) =>
            right.toSnapshot().createdAt.localeCompare(left.toSnapshot().createdAt) ||
            left.id.localeCompare(right.id),
        ),
    );
  }
}

export class BrowserDevelopmentMaterialDispositionUnitOfWork implements MaterialDispositionUnitOfWork {
  public constructor(private readonly storage: Storage) {}

  public commit(input: CommitMaterialDispositionInput): Promise<Result<void, StoryCoreError>> {
    return mutateDatabase(this.storage, (database) => {
      const snapshot = input.material.toSnapshot();
      const currentSnapshot = database.materials[snapshot.id];
      if (currentSnapshot === undefined) {
        return materialNotFound();
      }
      const current = requireMaterial(currentSnapshot);
      const actualReferenceCount = Object.values(database.references).filter(
        (reference) => reference.materialId === snapshot.id,
      ).length;
      if (
        current.revision !== input.expectedMaterialRevision ||
        snapshot.revision !== input.expectedMaterialRevision + 1
      ) {
        return revisionConflict(input.expectedMaterialRevision, current.revision);
      }
      if (
        actualReferenceCount !== input.expectedReferenceCount ||
        snapshot.dispositionReferenceCount !== actualReferenceCount
      ) {
        return err(
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
          return invalidDisposition();
        }
      } else {
        const survivorSnapshot = database.materials[input.survivorId];
        const survivor =
          survivorSnapshot === undefined ? null : requireMaterial(survivorSnapshot).toSnapshot();
        if (
          survivor?.status !== "active" ||
          survivor.projectId !== snapshot.projectId ||
          survivor.revision !== input.expectedSurvivorRevision ||
          snapshot.status !== "merged" ||
          snapshot.mergedIntoId !== survivor.id
        ) {
          return invalidDisposition();
        }
      }
      database.materials[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }
}

function readResult<Value>(
  storage: Storage,
  operation: (database: StoredMaterialDatabase) => Value,
): Promise<Result<Value, StoryCoreError>> {
  try {
    return Promise.resolve(ok(operation(readDatabase(storage))));
  } catch (cause: unknown) {
    return Promise.resolve(err(asRepositoryError(cause)));
  }
}

function mutateDatabase<Value>(
  storage: Storage,
  operation: (database: StoredMaterialDatabase) => Result<Value, StoryCoreError>,
): Promise<Result<Value, StoryCoreError>> {
  try {
    const database = readDatabase(storage);
    const result = operation(database);
    if (result.ok) {
      validateDatabase(database);
      storage.setItem(DEVELOPMENT_MATERIAL_STORE_KEY, JSON.stringify(database));
    }
    return Promise.resolve(result);
  } catch (cause: unknown) {
    return Promise.resolve(err(asRepositoryError(cause)));
  }
}

function readDatabase(storage: Storage): StoredMaterialDatabase {
  const serialized = storage.getItem(DEVELOPMENT_MATERIAL_STORE_KEY);
  if (serialized === null) {
    return {
      schemaVersion: 1,
      materials: {},
      references: {},
    };
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isObject(parsed) ||
      parsed.schemaVersion !== 1 ||
      !isRecordMap(parsed.materials) ||
      !isRecordMap(parsed.references)
    ) {
      throw corruptStore();
    }
    const database = structuredClone(parsed) as unknown as StoredMaterialDatabase;
    validateDatabase(database);
    return database;
  } catch (cause: unknown) {
    throw cause instanceof StoryCoreError ? cause : corruptStore();
  }
}

function validateDatabase(database: StoredMaterialDatabase): void {
  for (const [id, snapshot] of Object.entries(database.materials)) {
    const material = requireMaterial(snapshot);
    if (material.id !== id) {
      throw corruptStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.references)) {
    const reference = requireReference(snapshot);
    const material = database.materials[reference.materialId];
    if (
      reference.id !== id ||
      material === undefined ||
      requireMaterial(material).projectId !== reference.projectId
    ) {
      throw corruptStore();
    }
  }
  const activeFingerprints = new Set<string>();
  for (const material of Object.values(database.materials).map(requireMaterial)) {
    if (material.status !== "active") {
      continue;
    }
    const key = `${material.projectId}:${material.contentFingerprint}`;
    if (activeFingerprints.has(key)) {
      throw corruptStore();
    }
    activeFingerprints.add(key);
  }
}

function activeDuplicate(
  database: StoredMaterialDatabase,
  projectId: UuidV7,
  fingerprint: string,
  excludeMaterialId: UuidV7 | null,
): Material | null {
  return (
    Object.values(database.materials)
      .map(requireMaterial)
      .find(
        (material) =>
          material.projectId === projectId &&
          material.status === "active" &&
          material.contentFingerprint === fingerprint &&
          material.id !== excludeMaterialId,
      ) ?? null
  );
}

function requireMaterial(snapshot: MaterialSnapshot): Material {
  const material = Material.rehydrate(snapshot);
  if (!material.ok) {
    throw corruptStore();
  }
  return material.value;
}

function requireReference(snapshot: MaterialReferenceSnapshot): MaterialReference {
  const reference = MaterialReference.rehydrate(snapshot);
  if (!reference.ok) {
    throw corruptStore();
  }
  return reference.value;
}

function compareMaterials(left: Material, right: Material): number {
  const statusOrder = { active: 0, deleted: 1, merged: 2 } as const;
  const leftSnapshot = left.toSnapshot();
  const rightSnapshot = right.toSnapshot();
  return (
    statusOrder[left.status] - statusOrder[right.status] ||
    rightSnapshot.updatedAt.localeCompare(leftSnapshot.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function duplicateError(existingMaterialId: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MATERIAL_DUPLICATE_FOUND",
      message: "An active material with the same content already exists.",
      actions: ["USE_EXISTING_MATERIAL", "OPEN_SOURCE"],
      details: { existingMaterialId },
    }),
  );
}

function materialNotFound(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MATERIAL_NOT_FOUND",
      message: "Material was not found.",
    }),
  );
}

function invalidDisposition(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MATERIAL_INVALID_TRANSITION",
      message: "Material disposition no longer matches its validated impact.",
      retryable: true,
      actions: ["RECOMPARE", "OPEN_REFERENCES"],
    }),
  );
}

function revisionConflict(expectedRevision: number, actualRevision: number) {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Material revision changed before persistence.",
      retryable: true,
      actions: ["RETRY", "RECOMPARE"],
      details: { expectedRevision, actualRevision },
    }),
  );
}

function repositoryError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message,
      retryable: true,
      actions: ["RETRY"],
    }),
  );
}

function asRepositoryError(cause: unknown): StoryCoreError {
  return cause instanceof StoryCoreError
    ? cause
    : new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: "Material development storage operation failed.",
        retryable: true,
        actions: ["RETRY", "CONTACT_SUPPORT"],
      });
}

function corruptStore(): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "Stored material data failed integrity validation.",
    actions: ["CONTACT_SUPPORT"],
  });
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return isObject(value);
}
