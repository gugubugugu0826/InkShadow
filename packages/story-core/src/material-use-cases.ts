import { StoryCoreError } from "./errors.js";
import {
  Material,
  MaterialReference,
  type MaterialFieldsInput,
  type MaterialUsagePurpose,
} from "./material.js";
import type {
  ChapterVersionReader,
  MaterialDispositionUnitOfWork,
  MaterialReferenceRepository,
  MaterialRepository,
} from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export interface MaterialApplicationOptions {
  readonly materials: MaterialRepository;
  readonly references: MaterialReferenceRepository;
  readonly dispositions: MaterialDispositionUnitOfWork;
  readonly chapterVersions: ChapterVersionReader;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export interface CreateMaterialCommand extends MaterialFieldsInput {
  readonly projectId: string;
  readonly humanConfirmed: boolean;
}

export interface EditMaterialCommand extends MaterialFieldsInput {
  readonly materialId: string;
  readonly expectedRevision: number;
  readonly humanConfirmed: boolean;
}

export interface CreateMaterialReferenceCommand {
  readonly materialId: string;
  readonly targetChapterId: string;
  readonly expectedTargetVersionId: string;
  readonly excerptStart: number;
  readonly excerptEnd: number;
  readonly note: string;
  readonly humanConfirmed: boolean;
}

export class MaterialApplicationService {
  public constructor(private readonly options: MaterialApplicationOptions) {}

  public async create(command: CreateMaterialCommand): Promise<Result<Material, StoryCoreError>> {
    if (!command.humanConfirmed) {
      return humanDecisionRequired();
    }
    const projectId = parseUuidV7(command.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const duplicate = await this.options.materials.findActiveByFingerprint(
      projectId.value,
      command.contentFingerprint,
    );
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value !== null) {
      return duplicateMaterial(duplicate.value);
    }
    const material = Material.create({
      ...command,
      id: this.options.ids.next(),
      projectId: projectId.value,
      now: this.options.clock.now(),
    });
    if (!material.ok) {
      return material;
    }
    const saved = await this.options.materials.create(material.value);
    return saved.ok ? material : saved;
  }

  public async edit(command: EditMaterialCommand): Promise<Result<Material, StoryCoreError>> {
    const loaded = await this.load(command.materialId);
    if (!loaded.ok) {
      return loaded;
    }
    const duplicate = await this.options.materials.findActiveByFingerprint(
      loaded.value.projectId,
      command.contentFingerprint,
      loaded.value.id,
    );
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value !== null) {
      return duplicateMaterial(duplicate.value);
    }
    const changed = loaded.value.edit({
      ...command,
      now: this.options.clock.now(),
    });
    if (!changed.ok) {
      return changed;
    }
    const saved = await this.options.materials.save(changed.value, loaded.value.revision);
    return saved.ok ? changed : saved;
  }

  public async createReference(
    command: CreateMaterialReferenceCommand,
  ): Promise<Result<MaterialReference, StoryCoreError>> {
    if (!command.humanConfirmed) {
      return humanDecisionRequired();
    }
    const loaded = await this.load(command.materialId);
    if (!loaded.ok) {
      return loaded;
    }
    const chapterId = parseUuidV7(command.targetChapterId);
    if (!chapterId.ok) {
      return chapterId;
    }
    const expectedVersionId = parseUuidV7(command.expectedTargetVersionId);
    if (!expectedVersionId.ok) {
      return expectedVersionId;
    }
    const current = await this.options.chapterVersions.findCurrent(chapterId.value);
    if (!current.ok) {
      return current;
    }
    if (
      current.value?.projectId !== loaded.value.projectId ||
      current.value.versionId !== expectedVersionId.value
    ) {
      return err(
        new StoryCoreError({
          code: "REVIEW_SOURCE_CHANGED",
          message: "The target chapter changed before the material reference was recorded.",
          retryable: true,
          actions: ["OPEN_SOURCE", "RETRY"],
        }),
      );
    }
    const reference = MaterialReference.create({
      id: this.options.ids.next(),
      material: loaded.value,
      targetChapterId: chapterId.value,
      targetVersionId: expectedVersionId.value,
      excerptStart: command.excerptStart,
      excerptEnd: command.excerptEnd,
      note: command.note,
      now: this.options.clock.now(),
    });
    if (!reference.ok) {
      return reference;
    }
    const saved = await this.options.references.create(reference.value);
    return saved.ok ? reference : saved;
  }

  public async softDelete(command: {
    readonly materialId: string;
    readonly expectedRevision: number;
    readonly expectedReferenceCount: number;
    readonly humanConfirmed: boolean;
  }): Promise<Result<Material, StoryCoreError>> {
    const loaded = await this.load(command.materialId);
    if (!loaded.ok) {
      return loaded;
    }
    const count = await this.options.references.countByMaterialId(loaded.value.id);
    if (!count.ok) {
      return count;
    }
    const changed = loaded.value.softDelete({
      ...command,
      actualReferenceCount: count.value,
      now: this.options.clock.now(),
    });
    if (!changed.ok) {
      return changed;
    }
    const committed = await this.options.dispositions.commit({
      material: changed.value,
      expectedMaterialRevision: loaded.value.revision,
      expectedReferenceCount: command.expectedReferenceCount,
      survivorId: null,
      expectedSurvivorRevision: null,
    });
    return committed.ok ? changed : committed;
  }

  public async restore(command: {
    readonly materialId: string;
    readonly expectedRevision: number;
    readonly humanConfirmed: boolean;
  }): Promise<Result<Material, StoryCoreError>> {
    const loaded = await this.load(command.materialId);
    if (!loaded.ok) {
      return loaded;
    }
    const changed = loaded.value.restore({
      ...command,
      now: this.options.clock.now(),
    });
    if (!changed.ok) {
      return changed;
    }
    const saved = await this.options.materials.save(changed.value, loaded.value.revision);
    return saved.ok ? changed : saved;
  }

  public async merge(command: {
    readonly sourceMaterialId: string;
    readonly survivorMaterialId: string;
    readonly expectedSourceRevision: number;
    readonly expectedSurvivorRevision: number;
    readonly expectedReferenceCount: number;
    readonly humanConfirmed: boolean;
  }): Promise<Result<Material, StoryCoreError>> {
    const source = await this.load(command.sourceMaterialId);
    if (!source.ok) {
      return source;
    }
    const survivor = await this.load(command.survivorMaterialId);
    if (!survivor.ok) {
      return survivor;
    }
    if (
      source.value.projectId !== survivor.value.projectId ||
      survivor.value.status !== "active" ||
      survivor.value.revision !== command.expectedSurvivorRevision
    ) {
      return err(
        new StoryCoreError({
          code: "MATERIAL_INVALID_TRANSITION",
          message: "Material merge survivor changed or belongs to another project.",
          retryable: true,
          actions: ["RECOMPARE", "OPEN_REFERENCES"],
        }),
      );
    }
    const count = await this.options.references.countByMaterialId(source.value.id);
    if (!count.ok) {
      return count;
    }
    const changed = source.value.mergeInto({
      survivorId: survivor.value.id,
      expectedRevision: command.expectedSourceRevision,
      expectedReferenceCount: command.expectedReferenceCount,
      actualReferenceCount: count.value,
      humanConfirmed: command.humanConfirmed,
      now: this.options.clock.now(),
    });
    if (!changed.ok) {
      return changed;
    }
    const committed = await this.options.dispositions.commit({
      material: changed.value,
      expectedMaterialRevision: source.value.revision,
      expectedReferenceCount: command.expectedReferenceCount,
      survivorId: survivor.value.id,
      expectedSurvivorRevision: survivor.value.revision,
    });
    return committed.ok ? changed : committed;
  }

  public async authorizeUsage(
    materialIdValue: string,
    purpose: MaterialUsagePurpose,
  ): Promise<Result<Material, StoryCoreError>> {
    const loaded = await this.load(materialIdValue);
    if (!loaded.ok) {
      return loaded;
    }
    if (!loaded.value.canUseFor(purpose)) {
      return err(
        new StoryCoreError({
          code: "MATERIAL_USAGE_FORBIDDEN",
          message: `Material is not authorized for ${purpose}.`,
          actions: ["REVIEW_RIGHTS", "OPEN_SOURCE"],
          details: { purpose },
        }),
      );
    }
    return loaded;
  }

  private async load(materialIdValue: string): Promise<Result<Material, StoryCoreError>> {
    const materialId = parseUuidV7(materialIdValue);
    if (!materialId.ok) {
      return materialId;
    }
    const loaded = await this.options.materials.findById(materialId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new StoryCoreError({
          code: "MATERIAL_NOT_FOUND",
          message: "Material was not found.",
        }),
      );
    }
    return ok(loaded.value);
  }
}

function duplicateMaterial(material: Material): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MATERIAL_DUPLICATE_FOUND",
      message: "An active material with the same content already exists.",
      actions: ["USE_EXISTING_MATERIAL", "OPEN_SOURCE"],
      details: { existingMaterialId: material.id },
    }),
  );
}

function humanDecisionRequired(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Material provenance changes require explicit human confirmation.",
      actions: ["REVIEW_RIGHTS"],
    }),
  );
}
