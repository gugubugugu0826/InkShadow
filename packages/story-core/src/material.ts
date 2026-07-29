import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { validateBoundedText } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "./value-objects.js";

export const MATERIAL_LICENSE_KINDS = [
  "owned",
  "licensed",
  "public_domain",
  "permission_unknown",
] as const;
export type MaterialLicenseKind = (typeof MATERIAL_LICENSE_KINDS)[number];

export const MATERIAL_STATUSES = ["active", "deleted", "merged"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

export const MATERIAL_USAGE_PURPOSES = ["generation", "training"] as const;
export type MaterialUsagePurpose = (typeof MATERIAL_USAGE_PURPOSES)[number];

export const MATERIAL_RETENTION_DAYS = 30;
export const MAX_MATERIAL_BODY_LENGTH = 100_000;
export const MAX_MATERIAL_REFERENCE_EXCERPT_LENGTH = 2_000;

export interface MaterialPermissionSnapshot {
  readonly rightsBasis: string;
  readonly rightsConfirmedAt: IsoUtcTimestamp | null;
  readonly allowGeneration: boolean;
  readonly allowTraining: boolean;
}

export interface MaterialSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly title: string;
  readonly sourceName: string;
  readonly author: string | null;
  readonly sourceUrl: string | null;
  readonly license: MaterialLicenseKind;
  readonly permissions: MaterialPermissionSnapshot;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly body: string;
  readonly contentFingerprint: string;
  readonly status: MaterialStatus;
  readonly mergedIntoId: UuidV7 | null;
  readonly deletedAt: IsoUtcTimestamp | null;
  readonly retentionUntil: IsoUtcTimestamp | null;
  readonly dispositionReferenceCount: number | null;
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface MaterialProvenanceSnapshot {
  readonly materialId: UuidV7;
  readonly title: string;
  readonly sourceName: string;
  readonly author: string | null;
  readonly sourceUrl: string | null;
  readonly license: MaterialLicenseKind;
  readonly rightsBasis: string;
  readonly contentFingerprint: string;
  readonly summary: string;
}

export interface MaterialReferenceSnapshot {
  readonly id: UuidV7;
  readonly materialId: UuidV7;
  readonly projectId: UuidV7;
  readonly targetChapterId: UuidV7;
  readonly targetVersionId: UuidV7;
  readonly excerpt: string;
  readonly excerptStart: number;
  readonly excerptEnd: number;
  readonly sourceLength: number;
  readonly note: string;
  readonly provenance: MaterialProvenanceSnapshot;
  readonly createdAt: IsoUtcTimestamp;
}

export interface MaterialFieldsInput {
  readonly title: string;
  readonly sourceName: string;
  readonly author: string | null;
  readonly sourceUrl: string | null;
  readonly license: MaterialLicenseKind;
  readonly rightsBasis: string;
  readonly rightsConfirmed: boolean;
  readonly allowGeneration: boolean;
  readonly allowTraining: boolean;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly body: string;
  readonly contentFingerprint: string;
}

interface ValidatedMaterialFields {
  readonly title: string;
  readonly sourceName: string;
  readonly author: string | null;
  readonly sourceUrl: string | null;
  readonly license: MaterialLicenseKind;
  readonly rightsBasis: string;
  readonly rightsConfirmed: boolean;
  readonly allowGeneration: boolean;
  readonly allowTraining: boolean;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly body: string;
  readonly contentFingerprint: string;
}

export class Material {
  private constructor(private readonly snapshot: MaterialSnapshot) {
    Object.freeze(this.snapshot.permissions);
    Object.freeze(this.snapshot.tags);
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(
    input: MaterialFieldsInput & {
      readonly id: string;
      readonly projectId: string;
      readonly now: string;
    },
  ): Result<Material, StoryCoreError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const projectId = parseUuidV7(input.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const fields = validateMaterialFields(input);
    if (!fields.ok) {
      return fields;
    }
    return Material.rehydrate({
      id: id.value,
      projectId: projectId.value,
      ...materialSnapshotFields(fields.value, fields.value.rightsConfirmed ? now.value : null),
      status: "active",
      mergedIntoId: null,
      deletedAt: null,
      retentionUntil: null,
      dispositionReferenceCount: null,
      revision: 1,
      createdAt: now.value,
      updatedAt: now.value,
    });
  }

  public static rehydrate(snapshot: MaterialSnapshot): Result<Material, StoryCoreError> {
    const id = parseUuidV7(snapshot.id);
    if (!id.ok) {
      return id;
    }
    const projectId = parseUuidV7(snapshot.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
    if (!createdAt.ok) {
      return createdAt;
    }
    const updatedAt = parseIsoUtcTimestamp(snapshot.updatedAt);
    if (!updatedAt.ok) {
      return updatedAt;
    }
    const rightsConfirmed =
      snapshot.permissions.rightsConfirmedAt === null
        ? false
        : parseIsoUtcTimestamp(snapshot.permissions.rightsConfirmedAt);
    if (rightsConfirmed !== false && !rightsConfirmed.ok) {
      return rightsConfirmed;
    }
    const fields = validateMaterialFields({
      title: snapshot.title,
      sourceName: snapshot.sourceName,
      author: snapshot.author,
      sourceUrl: snapshot.sourceUrl,
      license: snapshot.license,
      rightsBasis: snapshot.permissions.rightsBasis,
      rightsConfirmed: rightsConfirmed !== false,
      allowGeneration: snapshot.permissions.allowGeneration,
      allowTraining: snapshot.permissions.allowTraining,
      tags: snapshot.tags,
      summary: snapshot.summary,
      body: snapshot.body,
      contentFingerprint: snapshot.contentFingerprint,
    });
    if (!fields.ok) {
      return fields;
    }
    const lifecycle = validateLifecycle(snapshot);
    if (!lifecycle.ok) {
      return lifecycle;
    }
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      compareTimestamps(updatedAt.value, createdAt.value) < 0 ||
      (rightsConfirmed !== false && compareTimestamps(rightsConfirmed.value, createdAt.value) < 0)
    ) {
      return materialValidationError("Material snapshot metadata is invalid.");
    }
    return ok(
      new Material({
        id: id.value,
        projectId: projectId.value,
        ...materialSnapshotFields(
          fields.value,
          rightsConfirmed === false ? null : rightsConfirmed.value,
        ),
        ...lifecycle.value,
        revision: snapshot.revision,
        createdAt: createdAt.value,
        updatedAt: updatedAt.value,
      }),
    );
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public get status(): MaterialStatus {
    return this.snapshot.status;
  }

  public get contentFingerprint(): string {
    return this.snapshot.contentFingerprint;
  }

  public get body(): string {
    return this.snapshot.body;
  }

  public toSnapshot(): MaterialSnapshot {
    return {
      ...this.snapshot,
      permissions: { ...this.snapshot.permissions },
      tags: Object.freeze([...this.snapshot.tags]),
    };
  }

  public toProvenanceSnapshot(): MaterialProvenanceSnapshot {
    return Object.freeze({
      materialId: this.snapshot.id,
      title: this.snapshot.title,
      sourceName: this.snapshot.sourceName,
      author: this.snapshot.author,
      sourceUrl: this.snapshot.sourceUrl,
      license: this.snapshot.license,
      rightsBasis: this.snapshot.permissions.rightsBasis,
      contentFingerprint: this.snapshot.contentFingerprint,
      summary: this.snapshot.summary,
    });
  }

  public canUseFor(purpose: MaterialUsagePurpose): boolean {
    return (
      this.snapshot.status === "active" &&
      this.snapshot.permissions.rightsConfirmedAt !== null &&
      (purpose === "generation"
        ? this.snapshot.permissions.allowGeneration
        : this.snapshot.permissions.allowTraining)
    );
  }

  public edit(
    input: MaterialFieldsInput & {
      readonly expectedRevision: number;
      readonly humanConfirmed: unknown;
      readonly now: string;
    },
  ): Result<Material, StoryCoreError> {
    const mutable = this.requireActiveMutation(
      input.expectedRevision,
      input.humanConfirmed,
      input.now,
    );
    if (!mutable.ok) {
      return mutable;
    }
    const fields = validateMaterialFields(input);
    if (!fields.ok) {
      return fields;
    }
    return Material.rehydrate({
      ...this.snapshot,
      ...materialSnapshotFields(
        fields.value,
        fields.value.rightsConfirmed
          ? (this.snapshot.permissions.rightsConfirmedAt ?? mutable.value)
          : null,
      ),
      revision: this.snapshot.revision + 1,
      updatedAt: mutable.value,
    });
  }

  public softDelete(input: {
    readonly expectedRevision: number;
    readonly expectedReferenceCount: number;
    readonly actualReferenceCount: number;
    readonly humanConfirmed: unknown;
    readonly now: string;
  }): Result<Material, StoryCoreError> {
    const mutable = this.requireActiveMutation(
      input.expectedRevision,
      input.humanConfirmed,
      input.now,
    );
    if (!mutable.ok) {
      return mutable;
    }
    const referenceCount = validateReferenceImpact(
      input.expectedReferenceCount,
      input.actualReferenceCount,
    );
    if (!referenceCount.ok) {
      return referenceCount;
    }
    return Material.rehydrate({
      ...this.snapshot,
      status: "deleted",
      mergedIntoId: null,
      deletedAt: mutable.value,
      retentionUntil: retentionDeadline(mutable.value),
      dispositionReferenceCount: referenceCount.value,
      revision: this.snapshot.revision + 1,
      updatedAt: mutable.value,
    });
  }

  public restore(input: {
    readonly expectedRevision: number;
    readonly humanConfirmed: unknown;
    readonly now: string;
  }): Result<Material, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanMaterialDecisionRequired();
    }
    if (input.expectedRevision !== this.snapshot.revision) {
      return materialRevisionConflict(input.expectedRevision, this.snapshot.revision);
    }
    if (this.snapshot.status !== "deleted" || this.snapshot.retentionUntil === null) {
      return materialTransitionError("Only a soft-deleted material can be restored.");
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (
      compareTimestamps(now.value, this.snapshot.updatedAt) < 0 ||
      compareTimestamps(now.value, this.snapshot.retentionUntil) > 0
    ) {
      return materialTransitionError("The material restoration window has expired.");
    }
    return Material.rehydrate({
      ...this.snapshot,
      status: "active",
      mergedIntoId: null,
      deletedAt: null,
      retentionUntil: null,
      dispositionReferenceCount: null,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  public mergeInto(input: {
    readonly survivorId: string;
    readonly expectedRevision: number;
    readonly expectedReferenceCount: number;
    readonly actualReferenceCount: number;
    readonly humanConfirmed: unknown;
    readonly now: string;
  }): Result<Material, StoryCoreError> {
    const mutable = this.requireActiveMutation(
      input.expectedRevision,
      input.humanConfirmed,
      input.now,
    );
    if (!mutable.ok) {
      return mutable;
    }
    const survivorId = parseUuidV7(input.survivorId);
    if (!survivorId.ok) {
      return survivorId;
    }
    if (survivorId.value === this.snapshot.id) {
      return materialTransitionError("A material cannot be merged into itself.");
    }
    const referenceCount = validateReferenceImpact(
      input.expectedReferenceCount,
      input.actualReferenceCount,
    );
    if (!referenceCount.ok) {
      return referenceCount;
    }
    return Material.rehydrate({
      ...this.snapshot,
      status: "merged",
      mergedIntoId: survivorId.value,
      deletedAt: mutable.value,
      retentionUntil: retentionDeadline(mutable.value),
      dispositionReferenceCount: referenceCount.value,
      revision: this.snapshot.revision + 1,
      updatedAt: mutable.value,
    });
  }

  private requireActiveMutation(
    expectedRevision: number,
    humanConfirmed: unknown,
    nowValue: string,
  ): Result<IsoUtcTimestamp, StoryCoreError> {
    if (humanConfirmed !== true) {
      return humanMaterialDecisionRequired();
    }
    if (expectedRevision !== this.snapshot.revision) {
      return materialRevisionConflict(expectedRevision, this.snapshot.revision);
    }
    if (this.snapshot.status !== "active") {
      return materialTransitionError("Only an active material can be changed.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(now.value, this.snapshot.updatedAt) < 0) {
      return materialValidationError("Material mutation time cannot move backwards.");
    }
    return now;
  }
}

export class MaterialReference {
  private constructor(private readonly snapshot: MaterialReferenceSnapshot) {
    Object.freeze(this.snapshot.provenance);
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: {
    readonly id: string;
    readonly material: Material;
    readonly targetChapterId: string;
    readonly targetVersionId: string;
    readonly excerptStart: number;
    readonly excerptEnd: number;
    readonly note: string;
    readonly now: string;
  }): Result<MaterialReference, StoryCoreError> {
    if (input.material.status !== "active") {
      return materialTransitionError("Deleted or merged material cannot receive new references.");
    }
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const targetChapterId = parseUuidV7(input.targetChapterId);
    if (!targetChapterId.ok) {
      return targetChapterId;
    }
    const targetVersionId = parseUuidV7(input.targetVersionId);
    if (!targetVersionId.ok) {
      return targetVersionId;
    }
    const note = validateBoundedText(input.note, 500, "Material reference note");
    if (!note.ok) {
      return note;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const body = input.material.body;
    if (
      !Number.isSafeInteger(input.excerptStart) ||
      !Number.isSafeInteger(input.excerptEnd) ||
      input.excerptStart < 0 ||
      input.excerptEnd <= input.excerptStart ||
      input.excerptEnd > body.length ||
      input.excerptEnd - input.excerptStart > MAX_MATERIAL_REFERENCE_EXCERPT_LENGTH
    ) {
      return materialValidationError("Material reference excerpt range is invalid.");
    }
    return MaterialReference.rehydrate({
      id: id.value,
      materialId: input.material.id,
      projectId: input.material.projectId,
      targetChapterId: targetChapterId.value,
      targetVersionId: targetVersionId.value,
      excerpt: body.slice(input.excerptStart, input.excerptEnd),
      excerptStart: input.excerptStart,
      excerptEnd: input.excerptEnd,
      sourceLength: body.length,
      note: note.value,
      provenance: input.material.toProvenanceSnapshot(),
      createdAt: now.value,
    });
  }

  public static rehydrate(
    snapshot: MaterialReferenceSnapshot,
  ): Result<MaterialReference, StoryCoreError> {
    const id = parseUuidV7(snapshot.id);
    if (!id.ok) {
      return id;
    }
    const materialId = parseUuidV7(snapshot.materialId);
    if (!materialId.ok) {
      return materialId;
    }
    const projectId = parseUuidV7(snapshot.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const targetChapterId = parseUuidV7(snapshot.targetChapterId);
    if (!targetChapterId.ok) {
      return targetChapterId;
    }
    const targetVersionId = parseUuidV7(snapshot.targetVersionId);
    if (!targetVersionId.ok) {
      return targetVersionId;
    }
    const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
    if (!createdAt.ok) {
      return createdAt;
    }
    const note = validateBoundedText(snapshot.note, 500, "Material reference note");
    if (!note.ok) {
      return note;
    }
    const provenance = validateProvenance(snapshot.provenance, materialId.value);
    if (!provenance.ok) {
      return provenance;
    }
    if (
      typeof snapshot.excerpt !== "string" ||
      snapshot.excerpt.length === 0 ||
      snapshot.excerpt.length > MAX_MATERIAL_REFERENCE_EXCERPT_LENGTH ||
      snapshot.excerpt.includes("\u0000") ||
      !Number.isSafeInteger(snapshot.excerptStart) ||
      !Number.isSafeInteger(snapshot.excerptEnd) ||
      !Number.isSafeInteger(snapshot.sourceLength) ||
      snapshot.excerptStart < 0 ||
      snapshot.excerptEnd <= snapshot.excerptStart ||
      snapshot.excerptEnd > snapshot.sourceLength ||
      snapshot.excerptEnd - snapshot.excerptStart !== snapshot.excerpt.length
    ) {
      return materialValidationError("Material reference snapshot is invalid.");
    }
    return ok(
      new MaterialReference({
        id: id.value,
        materialId: materialId.value,
        projectId: projectId.value,
        targetChapterId: targetChapterId.value,
        targetVersionId: targetVersionId.value,
        excerpt: snapshot.excerpt,
        excerptStart: snapshot.excerptStart,
        excerptEnd: snapshot.excerptEnd,
        sourceLength: snapshot.sourceLength,
        note: note.value,
        provenance: provenance.value,
        createdAt: createdAt.value,
      }),
    );
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get materialId(): UuidV7 {
    return this.snapshot.materialId;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public toSnapshot(): MaterialReferenceSnapshot {
    return {
      ...this.snapshot,
      provenance: { ...this.snapshot.provenance },
    };
  }
}

function validateMaterialFields(
  input: MaterialFieldsInput,
): Result<ValidatedMaterialFields, StoryCoreError> {
  const title = validateBoundedText(input.title, 200, "Material title");
  if (!title.ok) {
    return title;
  }
  const sourceName = validateBoundedText(input.sourceName, 300, "Material source");
  if (!sourceName.ok) {
    return sourceName;
  }
  const author = validateNullableText(input.author, 200, "Material author");
  if (!author.ok) {
    return author;
  }
  const sourceUrl = validateSourceUrl(input.sourceUrl);
  if (!sourceUrl.ok) {
    return sourceUrl;
  }
  if (!isMaterialLicenseKind(input.license)) {
    return materialValidationError("Material license kind is invalid.");
  }
  const rightsBasis = validateBoundedText(input.rightsBasis, 500, "Material rights basis");
  if (!rightsBasis.ok) {
    return rightsBasis;
  }
  if (
    typeof input.rightsConfirmed !== "boolean" ||
    typeof input.allowGeneration !== "boolean" ||
    typeof input.allowTraining !== "boolean" ||
    ((!input.rightsConfirmed || input.license === "permission_unknown") &&
      (input.allowGeneration || input.allowTraining)) ||
    (input.license === "permission_unknown" && input.rightsConfirmed)
  ) {
    return err(
      new StoryCoreError({
        code: "MATERIAL_RIGHTS_NOT_CONFIRMED",
        message: "Generation or training use requires an explicit, known rights basis.",
        actions: ["REVIEW_RIGHTS"],
      }),
    );
  }
  const tags = validateTags(input.tags);
  if (!tags.ok) {
    return tags;
  }
  const summary = validateBoundedText(input.summary, 1_000, "Material summary");
  if (!summary.ok) {
    return summary;
  }
  if (
    typeof input.body !== "string" ||
    input.body.trim().length === 0 ||
    input.body.length > MAX_MATERIAL_BODY_LENGTH ||
    input.body.includes("\u0000")
  ) {
    return materialValidationError("Material body exceeds its bounded text contract.");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.contentFingerprint)) {
    return materialValidationError("Material content fingerprint must be SHA-256.");
  }
  return ok({
    title: title.value,
    sourceName: sourceName.value,
    author: author.value,
    sourceUrl: sourceUrl.value,
    license: input.license,
    rightsBasis: rightsBasis.value,
    rightsConfirmed: input.rightsConfirmed,
    allowGeneration: input.allowGeneration,
    allowTraining: input.allowTraining,
    tags: tags.value,
    summary: summary.value,
    body: input.body.trim(),
    contentFingerprint: input.contentFingerprint,
  });
}

function materialSnapshotFields(
  fields: ValidatedMaterialFields,
  rightsConfirmedAt: IsoUtcTimestamp | null,
): Pick<
  MaterialSnapshot,
  | "title"
  | "sourceName"
  | "author"
  | "sourceUrl"
  | "license"
  | "permissions"
  | "tags"
  | "summary"
  | "body"
  | "contentFingerprint"
> {
  return {
    title: fields.title,
    sourceName: fields.sourceName,
    author: fields.author,
    sourceUrl: fields.sourceUrl,
    license: fields.license,
    permissions: Object.freeze({
      rightsBasis: fields.rightsBasis,
      rightsConfirmedAt,
      allowGeneration: fields.allowGeneration,
      allowTraining: fields.allowTraining,
    }),
    tags: Object.freeze([...fields.tags]),
    summary: fields.summary,
    body: fields.body,
    contentFingerprint: fields.contentFingerprint,
  };
}

function validateLifecycle(
  snapshot: MaterialSnapshot,
): Result<
  Pick<
    MaterialSnapshot,
    "status" | "mergedIntoId" | "deletedAt" | "retentionUntil" | "dispositionReferenceCount"
  >,
  StoryCoreError
> {
  if (!isMaterialStatus(snapshot.status)) {
    return materialValidationError("Material status is invalid.");
  }
  if (snapshot.status === "active") {
    if (
      snapshot.mergedIntoId !== null ||
      snapshot.deletedAt !== null ||
      snapshot.retentionUntil !== null ||
      snapshot.dispositionReferenceCount !== null
    ) {
      return materialValidationError("Active material cannot carry disposition metadata.");
    }
    return ok({
      status: "active",
      mergedIntoId: null,
      deletedAt: null,
      retentionUntil: null,
      dispositionReferenceCount: null,
    });
  }
  const deletedAt = snapshot.deletedAt === null ? null : parseIsoUtcTimestamp(snapshot.deletedAt);
  const retentionUntil =
    snapshot.retentionUntil === null ? null : parseIsoUtcTimestamp(snapshot.retentionUntil);
  const mergedIntoId = snapshot.mergedIntoId === null ? null : parseUuidV7(snapshot.mergedIntoId);
  const dispositionReferenceCount = snapshot.dispositionReferenceCount;
  if (
    deletedAt === null ||
    !deletedAt.ok ||
    retentionUntil === null ||
    !retentionUntil.ok ||
    compareTimestamps(retentionUntil.value, deletedAt.value) <= 0 ||
    dispositionReferenceCount === null ||
    !Number.isSafeInteger(dispositionReferenceCount) ||
    dispositionReferenceCount < 0 ||
    (snapshot.status === "deleted" && mergedIntoId !== null) ||
    (snapshot.status === "merged" && !mergedIntoId?.ok)
  ) {
    return materialValidationError("Material disposition metadata is invalid.");
  }
  return ok({
    status: snapshot.status,
    mergedIntoId:
      snapshot.status === "merged" && mergedIntoId?.ok === true ? mergedIntoId.value : null,
    deletedAt: deletedAt.value,
    retentionUntil: retentionUntil.value,
    dispositionReferenceCount,
  });
}

function validateProvenance(
  snapshot: MaterialProvenanceSnapshot,
  materialId: UuidV7,
): Result<MaterialProvenanceSnapshot, StoryCoreError> {
  const title = validateBoundedText(snapshot.title, 200, "Material provenance title");
  const sourceName = validateBoundedText(snapshot.sourceName, 300, "Material provenance source");
  const author = validateNullableText(snapshot.author, 200, "Material provenance author");
  const sourceUrl = validateSourceUrl(snapshot.sourceUrl);
  const rightsBasis = validateBoundedText(
    snapshot.rightsBasis,
    500,
    "Material provenance rights basis",
  );
  const summary = validateBoundedText(snapshot.summary, 1_000, "Material provenance summary");
  if (
    !title.ok ||
    !sourceName.ok ||
    !author.ok ||
    !sourceUrl.ok ||
    !isMaterialLicenseKind(snapshot.license) ||
    !rightsBasis.ok ||
    !summary.ok ||
    snapshot.materialId !== materialId ||
    !/^[a-f0-9]{64}$/u.test(snapshot.contentFingerprint)
  ) {
    return materialValidationError("Material provenance snapshot is invalid.");
  }
  return ok(
    Object.freeze({
      materialId,
      title: title.value,
      sourceName: sourceName.value,
      author: author.value,
      sourceUrl: sourceUrl.value,
      license: snapshot.license,
      rightsBasis: rightsBasis.value,
      contentFingerprint: snapshot.contentFingerprint,
      summary: summary.value,
    }),
  );
}

function validateNullableText(
  value: string | null,
  maximumLength: number,
  field: string,
): Result<string | null, StoryCoreError> {
  if (value === null) {
    return ok(null);
  }
  const parsed = validateBoundedText(value, maximumLength, field);
  return parsed.ok ? ok(parsed.value) : parsed;
}

function validateSourceUrl(value: string | null): Result<string | null, StoryCoreError> {
  if (value === null) {
    return ok(null);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    return materialValidationError("Material source URL is invalid.");
  }
  try {
    const parsed = new URL(normalized);
    const sensitiveParameter = [...parsed.searchParams.keys()].some((key) =>
      /(?:key|token|secret|signature|password|auth|credential)/iu.test(key),
    );
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      sensitiveParameter
    ) {
      return materialValidationError(
        "Material source URL contains unsafe credentials or protocol.",
      );
    }
    return ok(parsed.toString());
  } catch {
    return materialValidationError("Material source URL is invalid.");
  }
}

function validateTags(tags: unknown): Result<readonly string[], StoryCoreError> {
  if (!Array.isArray(tags) || tags.length > 20) {
    return materialValidationError("Material tags exceed their collection limit.");
  }
  const normalized = new Set<string>();
  for (const tagValue of tags) {
    if (typeof tagValue !== "string") {
      return materialValidationError("Material tag must be text.");
    }
    const tag = validateBoundedText(tagValue, 40, "Material tag");
    if (!tag.ok) {
      return tag;
    }
    normalized.add(tag.value.toLocaleLowerCase());
  }
  return ok(Object.freeze([...normalized].sort((left, right) => left.localeCompare(right))));
}

function validateReferenceImpact(expected: number, actual: number): Result<number, StoryCoreError> {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    !Number.isSafeInteger(actual) ||
    actual < 0
  ) {
    return materialValidationError("Material reference impact count is invalid.");
  }
  if (expected !== actual) {
    return err(
      new StoryCoreError({
        code: "MATERIAL_REFERENCE_IMPACT_CHANGED",
        message: "Material references changed after the impact preview.",
        retryable: true,
        actions: ["OPEN_REFERENCES", "RETRY"],
        details: { expectedReferenceCount: expected, actualReferenceCount: actual },
      }),
    );
  }
  return ok(actual);
}

function retentionDeadline(now: IsoUtcTimestamp): IsoUtcTimestamp {
  return new Date(Date.parse(now) + MATERIAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000)
    .toISOString()
    .replace(".000Z", "Z") as IsoUtcTimestamp;
}

function isMaterialLicenseKind(value: unknown): value is MaterialLicenseKind {
  return MATERIAL_LICENSE_KINDS.includes(value as MaterialLicenseKind);
}

function isMaterialStatus(value: unknown): value is MaterialStatus {
  return MATERIAL_STATUSES.includes(value as MaterialStatus);
}

function humanMaterialDecisionRequired(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Material rights and disposition changes require an explicit human decision.",
      actions: ["REVIEW_RIGHTS"],
    }),
  );
}

function materialRevisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Material revision changed before the operation completed.",
      retryable: true,
      actions: ["RETRY", "RECOMPARE"],
      details: { expectedRevision, actualRevision },
    }),
  );
}

function materialTransitionError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MATERIAL_INVALID_TRANSITION",
      message,
      actions: ["OPEN_REFERENCES"],
    }),
  );
}

function materialValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}
