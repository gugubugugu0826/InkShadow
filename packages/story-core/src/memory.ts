import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { MAX_MEMORY_TEXT_LENGTH, validateBoundedText } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "./value-objects.js";

export const MEMORY_LEVELS = ["L1", "L2", "L3", "L4"] as const;
export type MemoryLevel = (typeof MEMORY_LEVELS)[number];

export const MEMORY_ORIGINS = ["user", "automatic"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export const MEMORY_STATUSES = ["enabled", "disabled"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SOURCE_KINDS = [
  "chapter",
  "timeline_event",
  "session",
  "user_rule",
  "import",
] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export interface MemorySource {
  readonly kind: MemorySourceKind;
  readonly sourceId: UuidV7;
  readonly sourceVersionId: UuidV7 | null;
}

export interface MemoryPolicySnapshot {
  readonly projectId: UuidV7;
  readonly automaticLearningEnabled: boolean;
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface AutomaticMemoryAuthorizationSnapshot {
  readonly projectId: UuidV7;
  readonly policyRevision: number;
}

const AUTOMATIC_MEMORY_AUTHORIZATION_ISSUER = Symbol("AutomaticMemoryAuthorizationIssuer");

export class AutomaticMemoryAuthorization {
  private constructor(private readonly snapshot: AutomaticMemoryAuthorizationSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static fromEnabledPolicy(
    policy: MemoryPolicySnapshot,
    issuer: symbol,
  ): Result<AutomaticMemoryAuthorization, StoryCoreError> {
    if (issuer !== AUTOMATIC_MEMORY_AUTHORIZATION_ISSUER) {
      return err(
        new StoryCoreError({
          code: "MEMORY_INVALID_GOVERNANCE",
          message: "Automatic memory authorization must be issued by its project policy.",
        }),
      );
    }
    if (
      !policy.automaticLearningEnabled ||
      !Number.isSafeInteger(policy.revision) ||
      policy.revision < 2
    ) {
      return err(
        new StoryCoreError({
          code: "MEMORY_AUTO_LEARNING_DISABLED",
          message: "Automatic memory learning is disabled until a user enables it.",
          actions: ["ENABLE_MEMORY"],
        }),
      );
    }
    return ok(
      new AutomaticMemoryAuthorization({
        projectId: policy.projectId,
        policyRevision: policy.revision,
      }),
    );
  }

  public toSnapshot(): AutomaticMemoryAuthorizationSnapshot {
    return { ...this.snapshot };
  }
}

export class MemoryPolicy {
  private constructor(private readonly snapshot: MemoryPolicySnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(
    projectIdValue: string,
    nowValue: string,
  ): Result<MemoryPolicy, StoryCoreError> {
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return ok(
      new MemoryPolicy({
        projectId: projectId.value,
        automaticLearningEnabled: false,
        revision: 1,
        createdAt: now.value,
        updatedAt: now.value,
      }),
    );
  }

  public static rehydrate(snapshot: MemoryPolicySnapshot): Result<MemoryPolicy, StoryCoreError> {
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
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      typeof snapshot.automaticLearningEnabled !== "boolean" ||
      snapshot.automaticLearningEnabled !== (snapshot.revision % 2 === 0) ||
      (snapshot.revision === 1 && compareTimestamps(updatedAt.value, createdAt.value) !== 0) ||
      compareTimestamps(updatedAt.value, createdAt.value) < 0
    ) {
      return memoryValidationError("Memory policy snapshot is invalid.");
    }
    return ok(
      new MemoryPolicy({
        projectId: projectId.value,
        automaticLearningEnabled: snapshot.automaticLearningEnabled,
        revision: snapshot.revision,
        createdAt: createdAt.value,
        updatedAt: updatedAt.value,
      }),
    );
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get automaticLearningEnabled(): boolean {
    return this.snapshot.automaticLearningEnabled;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public toSnapshot(): MemoryPolicySnapshot {
    return { ...this.snapshot };
  }

  public authorizeAutomaticLearning(): Result<AutomaticMemoryAuthorization, StoryCoreError> {
    return AutomaticMemoryAuthorization.fromEnabledPolicy(
      this.snapshot,
      AUTOMATIC_MEMORY_AUTHORIZATION_ISSUER,
    );
  }

  public setAutomaticLearning(input: {
    readonly enabled: boolean;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryPolicy, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanMemoryError();
    }
    if (typeof input.enabled !== "boolean") {
      return memoryValidationError("Automatic learning setting must be a boolean.");
    }
    if (input.expectedRevision !== this.snapshot.revision) {
      return memoryRevisionConflict(input.expectedRevision, this.snapshot.revision);
    }
    if (input.enabled === this.snapshot.automaticLearningEnabled) {
      return ok(this);
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(now.value, this.snapshot.updatedAt) < 0) {
      return memoryValidationError("Memory policy mutation time cannot move backwards.");
    }
    return MemoryPolicy.rehydrate({
      ...this.snapshot,
      automaticLearningEnabled: input.enabled,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }
}

export interface MemoryRecordSnapshot {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly level: MemoryLevel;
  readonly content: string;
  readonly source: MemorySource;
  readonly origin: MemoryOrigin;
  readonly automaticLearningPolicyRevision: number | null;
  readonly status: MemoryStatus;
  readonly pinned: boolean;
  readonly excluded: boolean;
  readonly weight: number;
  readonly useCount: number;
  readonly lastUsedAt: IsoUtcTimestamp | null;
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateMemoryRecordInput {
  readonly id: string;
  readonly projectId: string;
  readonly level: MemoryLevel;
  readonly content: string;
  readonly source: Readonly<{
    kind: MemorySourceKind;
    sourceId: string;
    sourceVersionId: string | null;
  }>;
  readonly origin: MemoryOrigin;
  readonly automaticLearningAuthorization?: AutomaticMemoryAuthorization;
  readonly now: string;
}

export class MemoryRecord {
  private constructor(private readonly snapshot: MemoryRecordSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: CreateMemoryRecordInput): Result<MemoryRecord, StoryCoreError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const projectId = parseUuidV7(input.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const content = validateBoundedText(input.content, MAX_MEMORY_TEXT_LENGTH, "Memory content");
    if (!content.ok) {
      return content;
    }
    const source = validateMemorySource(input.source);
    if (!source.ok) {
      return source;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if (!MEMORY_LEVELS.includes(input.level) || !MEMORY_ORIGINS.includes(input.origin)) {
      return memoryValidationError("Memory level or origin is invalid.");
    }
    const authorization = input.automaticLearningAuthorization?.toSnapshot() ?? null;
    if (input.origin === "automatic") {
      if (authorization === null) {
        return err(
          new StoryCoreError({
            code: "MEMORY_AUTO_LEARNING_DISABLED",
            message: "Automatic memory learning is disabled until a user enables it.",
            actions: ["ENABLE_MEMORY"],
          }),
        );
      }
      if (authorization.projectId !== projectId.value || authorization.policyRevision % 2 !== 0) {
        return memoryValidationError(
          "Automatic memory authorization does not match the project policy.",
        );
      }
    } else if (authorization !== null) {
      return memoryValidationError("User memory cannot carry automatic-learning authorization.");
    }
    return ok(
      new MemoryRecord({
        id: id.value,
        projectId: projectId.value,
        level: input.level,
        content: content.value,
        source: source.value,
        origin: input.origin,
        automaticLearningPolicyRevision: authorization?.policyRevision ?? null,
        status: "enabled",
        pinned: false,
        excluded: false,
        weight: 1,
        useCount: 0,
        lastUsedAt: null,
        revision: 1,
        createdAt: now.value,
        updatedAt: now.value,
      }),
    );
  }

  public static rehydrate(snapshot: MemoryRecordSnapshot): Result<MemoryRecord, StoryCoreError> {
    const validated = validateMemoryRecordSnapshot(snapshot);
    return validated.ok ? ok(new MemoryRecord(validated.value)) : validated;
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

  public toSnapshot(): MemoryRecordSnapshot {
    return {
      ...this.snapshot,
      source: Object.freeze({ ...this.snapshot.source }),
    };
  }

  public setEnabled(input: {
    readonly enabled: boolean;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryRecord, StoryCoreError> {
    if (typeof input.enabled !== "boolean") {
      return memoryValidationError("Memory enabled state must be a boolean.");
    }
    return this.govern(input, (snapshot) => ({
      ...snapshot,
      status: input.enabled ? "enabled" : "disabled",
    }));
  }

  public pin(input: {
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryRecord, StoryCoreError> {
    return this.govern(input, (snapshot) => ({
      ...snapshot,
      pinned: true,
      excluded: false,
      weight: 1,
    }));
  }

  public exclude(input: {
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryRecord, StoryCoreError> {
    return this.govern(input, (snapshot) => ({
      ...snapshot,
      pinned: false,
      excluded: true,
      weight: 0,
    }));
  }

  public downweight(input: {
    readonly weight: number;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryRecord, StoryCoreError> {
    if (!Number.isFinite(input.weight) || input.weight <= 0 || input.weight >= 1) {
      return memoryValidationError(
        "Downweighted memory must retain a weight between zero and one.",
      );
    }
    return this.govern(input, (snapshot) => ({
      ...snapshot,
      pinned: false,
      excluded: false,
      weight: input.weight,
    }));
  }

  public resetContextPriority(input: {
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryRecord, StoryCoreError> {
    return this.govern(input, (snapshot) => ({
      ...snapshot,
      pinned: false,
      excluded: false,
      weight: 1,
    }));
  }

  public edit(input: {
    readonly content: string;
    readonly humanConfirmed: unknown;
    readonly expectedRevision: number;
    readonly now: string;
  }): Result<MemoryRecord, StoryCoreError> {
    const content = validateBoundedText(input.content, MAX_MEMORY_TEXT_LENGTH, "Memory content");
    if (!content.ok) {
      return content;
    }
    return this.govern(input, (snapshot) => ({
      ...snapshot,
      content: content.value,
    }));
  }

  public recordUse(
    expectedRevision: number,
    nowValue: string,
  ): Result<MemoryRecord, StoryCoreError> {
    if (expectedRevision !== this.snapshot.revision) {
      return memoryRevisionConflict(expectedRevision, this.snapshot.revision);
    }
    if (this.snapshot.status !== "enabled" || this.snapshot.excluded) {
      return err(
        new StoryCoreError({
          code: "MEMORY_INVALID_GOVERNANCE",
          message: "Disabled or excluded memory cannot be used in context.",
        }),
      );
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(now.value, this.snapshot.updatedAt) < 0) {
      return memoryValidationError("Memory use time cannot move backwards.");
    }
    return MemoryRecord.rehydrate({
      ...this.snapshot,
      useCount: this.snapshot.useCount + 1,
      lastUsedAt: now.value,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }

  private govern(
    input: {
      readonly humanConfirmed: unknown;
      readonly expectedRevision: number;
      readonly now: string;
    },
    change: (snapshot: MemoryRecordSnapshot) => MemoryRecordSnapshot,
  ): Result<MemoryRecord, StoryCoreError> {
    if (input.humanConfirmed !== true) {
      return humanMemoryError();
    }
    if (input.expectedRevision !== this.snapshot.revision) {
      return memoryRevisionConflict(input.expectedRevision, this.snapshot.revision);
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const changed = change(this.snapshot);
    if (
      changed.status === this.snapshot.status &&
      changed.pinned === this.snapshot.pinned &&
      changed.excluded === this.snapshot.excluded &&
      changed.weight === this.snapshot.weight &&
      changed.content === this.snapshot.content
    ) {
      return ok(this);
    }
    if (compareTimestamps(now.value, this.snapshot.updatedAt) < 0) {
      return memoryValidationError("Memory governance time cannot move backwards.");
    }
    return MemoryRecord.rehydrate({
      ...changed,
      revision: this.snapshot.revision + 1,
      updatedAt: now.value,
    });
  }
}

function validateMemoryRecordSnapshot(
  snapshot: MemoryRecordSnapshot,
): Result<MemoryRecordSnapshot, StoryCoreError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const projectId = parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  const content = validateBoundedText(snapshot.content, MAX_MEMORY_TEXT_LENGTH, "Memory content");
  if (!content.ok) {
    return content;
  }
  const source = validateMemorySource(snapshot.source);
  if (!source.ok) {
    return source;
  }
  const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseIsoUtcTimestamp(snapshot.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  const lastUsedAt =
    snapshot.lastUsedAt === null ? ok(null) : parseIsoUtcTimestamp(snapshot.lastUsedAt);
  if (!lastUsedAt.ok) {
    return lastUsedAt;
  }
  const governanceValid =
    (snapshot.pinned && !snapshot.excluded && snapshot.weight === 1) ||
    (snapshot.excluded && !snapshot.pinned && snapshot.weight === 0) ||
    (!snapshot.pinned && !snapshot.excluded && snapshot.weight > 0 && snapshot.weight <= 1);
  const useHistoryValid =
    snapshot.useCount <= snapshot.revision - 1 &&
    ((snapshot.useCount === 0 && lastUsedAt.value === null) ||
      (snapshot.useCount > 0 &&
        lastUsedAt.value !== null &&
        compareTimestamps(lastUsedAt.value, createdAt.value) >= 0 &&
        compareTimestamps(lastUsedAt.value, updatedAt.value) <= 0));
  const initialStateValid =
    snapshot.revision !== 1 ||
    (snapshot.status === "enabled" &&
      !snapshot.pinned &&
      !snapshot.excluded &&
      snapshot.weight === 1 &&
      snapshot.useCount === 0 &&
      lastUsedAt.value === null &&
      compareTimestamps(updatedAt.value, createdAt.value) === 0);
  const automaticAuthorizationValid =
    (snapshot.origin === "automatic" &&
      snapshot.automaticLearningPolicyRevision !== null &&
      Number.isSafeInteger(snapshot.automaticLearningPolicyRevision) &&
      snapshot.automaticLearningPolicyRevision >= 2 &&
      snapshot.automaticLearningPolicyRevision % 2 === 0) ||
    (snapshot.origin === "user" && snapshot.automaticLearningPolicyRevision === null);
  if (
    !MEMORY_LEVELS.includes(snapshot.level) ||
    !MEMORY_ORIGINS.includes(snapshot.origin) ||
    !MEMORY_STATUSES.includes(snapshot.status) ||
    typeof snapshot.pinned !== "boolean" ||
    typeof snapshot.excluded !== "boolean" ||
    !governanceValid ||
    !Number.isSafeInteger(snapshot.useCount) ||
    snapshot.useCount < 0 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !useHistoryValid ||
    !initialStateValid ||
    !automaticAuthorizationValid ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0
  ) {
    return memoryValidationError("Memory record snapshot is invalid.");
  }
  return ok({
    id: id.value,
    projectId: projectId.value,
    level: snapshot.level,
    content: content.value,
    source: source.value,
    origin: snapshot.origin,
    automaticLearningPolicyRevision: snapshot.automaticLearningPolicyRevision,
    status: snapshot.status,
    pinned: snapshot.pinned,
    excluded: snapshot.excluded,
    weight: snapshot.weight,
    useCount: snapshot.useCount,
    lastUsedAt: lastUsedAt.value,
    revision: snapshot.revision,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function validateMemorySource(
  source: Readonly<{
    kind: MemorySourceKind;
    sourceId: string;
    sourceVersionId: string | null;
  }>,
): Result<MemorySource, StoryCoreError> {
  if (!MEMORY_SOURCE_KINDS.includes(source.kind)) {
    return memoryValidationError("Memory source kind is invalid.");
  }
  const sourceId = parseUuidV7(source.sourceId);
  if (!sourceId.ok) {
    return sourceId;
  }
  const sourceVersionId =
    source.sourceVersionId === null ? ok(null) : parseUuidV7(source.sourceVersionId);
  if (!sourceVersionId.ok) {
    return sourceVersionId;
  }
  if (source.kind === "chapter" && sourceVersionId.value === null) {
    return memoryValidationError("Chapter memory must retain its source version.");
  }
  return ok(
    Object.freeze({
      kind: source.kind,
      sourceId: sourceId.value,
      sourceVersionId: sourceVersionId.value,
    }),
  );
}

function memoryValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function humanMemoryError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Memory governance changes require explicit user action.",
    }),
  );
}

function memoryRevisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Memory record changed before this operation.",
      retryable: true,
      actions: ["RETRY"],
      details: { expectedRevision, actualRevision },
    }),
  );
}
