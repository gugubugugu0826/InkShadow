import { parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/story-core";

export const DEVELOPMENT_DATABASE_KEY = "inkshadow.development.database.v1";
export const DEVELOPMENT_STORY_STORE_KEY = "inkshadow.development.story.v1";
export const DEVELOPMENT_IDEATION_JOURNAL_KEY =
  "inkshadow.development.ideation-project-commit.journal.v1";

const JOURNAL_TARGET_KEYS = [DEVELOPMENT_DATABASE_KEY, DEVELOPMENT_STORY_STORE_KEY] as const;

export interface IdeationJournalArtifacts {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly auditId: string;
  readonly formalRecordIds: readonly string[];
  readonly draft: Readonly<{
    id: string;
    expectedRevision: number;
    finalizedRevision: number;
    previousUpdatedAt: string;
  }>;
}

export interface PreparedIdeationJournalInput {
  readonly developmentBefore: string | null;
  readonly developmentAfter: string;
  readonly developmentBeforeSchemaVersion: 0 | 1 | 2;
  readonly storyBefore: string;
  readonly storyAfter: string;
  readonly artifacts: IdeationJournalArtifacts;
}

interface StorageFingerprint {
  readonly present: boolean;
  readonly length: number;
  readonly checksum: string;
}

interface JournalTarget {
  readonly key: (typeof JOURNAL_TARGET_KEYS)[number];
  readonly before: StorageFingerprint;
  readonly after: StorageFingerprint;
  readonly rollback: StorageFingerprint;
}

interface PreparedIdeationJournal {
  readonly schemaVersion: 1;
  readonly operation: "ideation_project_commit";
  readonly state: "prepared";
  readonly targets: readonly [JournalTarget, JournalTarget];
  readonly developmentBeforeSchemaVersion: 0 | 1 | 2;
  readonly artifacts: IdeationJournalArtifacts;
}

export function createPreparedIdeationJournal(
  input: PreparedIdeationJournalInput,
): PreparedIdeationJournal {
  validateArtifacts(input.artifacts);
  if (
    !isDevelopmentBeforeVersion(input.developmentBeforeSchemaVersion) ||
    (input.developmentBefore === null) !== (input.developmentBeforeSchemaVersion === 0)
  ) {
    throw new AtomicIdeationJournalError("InvalidDevelopmentBeforeState");
  }

  const developmentRollback = rollbackDevelopmentDatabase(
    input.developmentAfter,
    input.developmentBeforeSchemaVersion,
    input.artifacts,
  );
  const storyRollback = rollbackStoryDatabase(input.storyAfter, input.artifacts);

  const targets: readonly [JournalTarget, JournalTarget] = Object.freeze([
    createTarget(
      DEVELOPMENT_DATABASE_KEY,
      input.developmentBefore,
      input.developmentAfter,
      developmentRollback,
    ),
    createTarget(DEVELOPMENT_STORY_STORE_KEY, input.storyBefore, input.storyAfter, storyRollback),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    operation: "ideation_project_commit",
    state: "prepared",
    targets,
    developmentBeforeSchemaVersion: input.developmentBeforeSchemaVersion,
    artifacts: freezeArtifacts(input.artifacts),
  });
}

export function serializePreparedIdeationJournal(journal: PreparedIdeationJournal): string {
  return JSON.stringify(journal);
}

export function recoverPreparedIdeationCommit(storage: Storage): void {
  const serialized = storage.getItem(DEVELOPMENT_IDEATION_JOURNAL_KEY);
  if (serialized === null) {
    return;
  }

  const journal = parsePreparedJournal(serialized);
  const developmentRaw = storage.getItem(DEVELOPMENT_DATABASE_KEY);
  const storyRaw = storage.getItem(DEVELOPMENT_STORY_STORE_KEY);
  const developmentState = classifyTarget(journal.targets[0], developmentRaw);
  const storyState = classifyTarget(journal.targets[1], storyRaw);

  const developmentRollback =
    developmentState === "after"
      ? rollbackDevelopmentDatabase(
          requirePresent(developmentRaw),
          journal.developmentBeforeSchemaVersion,
          journal.artifacts,
        )
      : developmentRaw;
  const storyRollback =
    storyState === "after"
      ? rollbackStoryDatabase(requirePresent(storyRaw), journal.artifacts)
      : storyRaw;

  if (
    (developmentState === "after" &&
      !fingerprintsEqual(fingerprint(developmentRollback), journal.targets[0].rollback)) ||
    (storyState === "after" &&
      !fingerprintsEqual(fingerprint(storyRollback), journal.targets[1].rollback))
  ) {
    throw new AtomicIdeationJournalError("RollbackFingerprintMismatch");
  }

  if (developmentState === "after") {
    restoreStorageValue(storage, DEVELOPMENT_DATABASE_KEY, developmentRollback);
  }
  if (storyState === "after") {
    restoreStorageValue(storage, DEVELOPMENT_STORY_STORE_KEY, storyRollback);
  }
  storage.removeItem(DEVELOPMENT_IDEATION_JOURNAL_KEY);
}

export function restoreStorageValue(
  storage: Storage,
  key: (typeof JOURNAL_TARGET_KEYS)[number],
  value: string | null,
): void {
  if (value === null) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, value);
  }
}

function createTarget(
  key: JournalTarget["key"],
  before: string | null,
  after: string,
  rollback: string | null,
): JournalTarget {
  return Object.freeze({
    key,
    before: fingerprint(before),
    after: fingerprint(after),
    rollback: fingerprint(rollback),
  });
}

function parsePreparedJournal(serialized: string): PreparedIdeationJournal {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new AtomicIdeationJournalError("MalformedJournalJson");
  }
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "operation",
      "state",
      "targets",
      "developmentBeforeSchemaVersion",
      "artifacts",
    ]) ||
    value.schemaVersion !== 1 ||
    value.operation !== "ideation_project_commit" ||
    value.state !== "prepared" ||
    !Array.isArray(value.targets) ||
    value.targets.length !== JOURNAL_TARGET_KEYS.length ||
    !isDevelopmentBeforeVersion(value.developmentBeforeSchemaVersion)
  ) {
    throw new AtomicIdeationJournalError("InvalidJournalShape");
  }

  const targets = value.targets.map((target, index) =>
    parseTarget(target, JOURNAL_TARGET_KEYS[index]),
  );
  const first = targets[0];
  const second = targets[1];
  if (first === undefined || second === undefined) {
    throw new AtomicIdeationJournalError("InvalidJournalTargets");
  }
  validateArtifacts(value.artifacts);
  const frozenTargets: readonly [JournalTarget, JournalTarget] = Object.freeze([first, second]);
  return Object.freeze({
    schemaVersion: 1,
    operation: "ideation_project_commit",
    state: "prepared",
    targets: frozenTargets,
    developmentBeforeSchemaVersion: value.developmentBeforeSchemaVersion,
    artifacts: freezeArtifacts(value.artifacts),
  });
}

function parseTarget(value: unknown, expectedKey: JournalTarget["key"] | undefined): JournalTarget {
  if (
    expectedKey === undefined ||
    !hasExactKeys(value, ["key", "before", "after", "rollback"]) ||
    value.key !== expectedKey
  ) {
    throw new AtomicIdeationJournalError("JournalTargetNotAllowed");
  }
  return Object.freeze({
    key: expectedKey,
    before: parseFingerprint(value.before),
    after: parseFingerprint(value.after),
    rollback: parseFingerprint(value.rollback),
  });
}

function parseFingerprint(value: unknown): StorageFingerprint {
  if (
    !hasExactKeys(value, ["present", "length", "checksum"]) ||
    typeof value.present !== "boolean" ||
    typeof value.length !== "number" ||
    !Number.isSafeInteger(value.length) ||
    value.length < 0 ||
    typeof value.checksum !== "string" ||
    !/^[0-9a-f]{16}$/u.test(value.checksum) ||
    (!value.present && value.length !== 0)
  ) {
    throw new AtomicIdeationJournalError("InvalidJournalFingerprint");
  }
  return Object.freeze({
    present: value.present,
    length: value.length,
    checksum: value.checksum,
  });
}

function classifyTarget(
  target: JournalTarget,
  current: string | null,
): "before" | "after" | "rollback" {
  const currentFingerprint = fingerprint(current);
  if (fingerprintsEqual(currentFingerprint, target.before)) {
    return "before";
  }
  if (fingerprintsEqual(currentFingerprint, target.after)) {
    return "after";
  }
  if (fingerprintsEqual(currentFingerprint, target.rollback)) {
    return "rollback";
  }
  throw new AtomicIdeationJournalError("JournalTargetChanged");
}

function fingerprint(value: string | null): StorageFingerprint {
  if (value === null) {
    return Object.freeze({
      present: false,
      length: 0,
      checksum: fnv1a64("<absent>"),
    });
  }
  return Object.freeze({
    present: true,
    length: value.length,
    checksum: fnv1a64(value),
  });
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function fingerprintsEqual(left: StorageFingerprint, right: StorageFingerprint): boolean {
  return (
    left.present === right.present &&
    left.length === right.length &&
    left.checksum === right.checksum
  );
}

function rollbackDevelopmentDatabase(
  serialized: string,
  beforeSchemaVersion: 0 | 1 | 2,
  artifacts: IdeationJournalArtifacts,
): string | null {
  const database = parseJsonObject(serialized, "DevelopmentDatabase");
  if (
    database.schemaVersion !== 2 ||
    !Array.isArray(database.projects) ||
    !Array.isArray(database.chapters) ||
    !Array.isArray(database.versions) ||
    !Array.isArray(database.drafts) ||
    !Array.isArray(database.candidates) ||
    !Array.isArray(database.auditEvents)
  ) {
    throw new AtomicIdeationJournalError("InvalidDevelopmentDatabase");
  }

  removeSingleEntity(
    database.projects,
    artifacts.projectId,
    "Project",
    (entity) => entity.id === artifacts.projectId,
  );
  removeSingleEntity(
    database.chapters,
    artifacts.chapterId,
    "Chapter",
    (entity) => entity.id === artifacts.chapterId && entity.projectId === artifacts.projectId,
  );
  removeSingleEntity(
    database.versions,
    artifacts.versionId,
    "ChapterVersion",
    (entity) =>
      entity.id === artifacts.versionId &&
      entity.projectId === artifacts.projectId &&
      entity.chapterId === artifacts.chapterId,
  );
  removeSingleEntity(
    database.auditEvents,
    artifacts.auditId,
    "AuditEvent",
    (entity) =>
      entity.id === artifacts.auditId &&
      entity.projectId === artifacts.projectId &&
      entity.entityId === artifacts.projectId &&
      entity.entityType === "project" &&
      entity.action === "create_from_ideation",
  );

  if (beforeSchemaVersion === 0) {
    if (
      database.projects.length !== 0 ||
      database.chapters.length !== 0 ||
      database.versions.length !== 0 ||
      database.drafts.length !== 0 ||
      database.candidates.length !== 0 ||
      database.auditEvents.length !== 0
    ) {
      throw new AtomicIdeationJournalError("NonEmptyAbsentDevelopmentStore");
    }
    return null;
  }
  if (beforeSchemaVersion === 1) {
    database.schemaVersion = 1;
    delete database.auditEvents;
  }
  return JSON.stringify(database);
}

function rollbackStoryDatabase(serialized: string, artifacts: IdeationJournalArtifacts): string {
  const database = parseJsonObject(serialized, "StoryDatabase");
  if (
    database.schemaVersion !== 5 ||
    !isRecord(database.outlines) ||
    !isRecord(database.formalRecords) ||
    !isRecord(database.ideationDrafts)
  ) {
    throw new AtomicIdeationJournalError("InvalidStoryDatabase");
  }

  const outline = database.outlines[artifacts.projectId];
  if (!isRecord(outline) || outline.projectId !== artifacts.projectId) {
    throw new AtomicIdeationJournalError("MissingCommittedOutline");
  }
  if (!Reflect.deleteProperty(database.outlines, artifacts.projectId)) {
    throw new AtomicIdeationJournalError("UnableToRemoveCommittedOutline");
  }

  for (const id of artifacts.formalRecordIds) {
    const record = database.formalRecords[id];
    if (!isRecord(record) || record.id !== id || record.projectId !== artifacts.projectId) {
      throw new AtomicIdeationJournalError("MissingCommittedFormalRecord");
    }
    if (!Reflect.deleteProperty(database.formalRecords, id)) {
      throw new AtomicIdeationJournalError("UnableToRemoveCommittedFormalRecord");
    }
  }

  const finalized = database.ideationDrafts[artifacts.draft.id];
  if (
    !isRecord(finalized) ||
    finalized.id !== artifacts.draft.id ||
    finalized.status !== "finalized" ||
    finalized.projectId !== artifacts.projectId ||
    finalized.revision !== artifacts.draft.finalizedRevision
  ) {
    throw new AtomicIdeationJournalError("MissingFinalizedDraft");
  }
  database.ideationDrafts[artifacts.draft.id] = {
    ...finalized,
    status: "active",
    projectId: null,
    revision: artifacts.draft.expectedRevision,
    updatedAt: artifacts.draft.previousUpdatedAt,
  };
  return JSON.stringify(database);
}

function removeSingleEntity(
  collection: unknown[],
  id: string,
  label: string,
  matches: (entity: Record<string, unknown>) => boolean,
): void {
  const indexes: number[] = [];
  for (let index = 0; index < collection.length; index += 1) {
    const entity = collection[index];
    if (isRecord(entity) && entity.id === id) {
      if (!matches(entity)) {
        throw new AtomicIdeationJournalError(`Invalid${label}`);
      }
      indexes.push(index);
    }
  }
  if (indexes.length !== 1) {
    throw new AtomicIdeationJournalError(`MissingOrDuplicate${label}`);
  }
  const [index] = indexes;
  if (index === undefined) {
    throw new AtomicIdeationJournalError(`Missing${label}`);
  }
  collection.splice(index, 1);
}

function validateArtifacts(value: unknown): asserts value is IdeationJournalArtifacts {
  if (
    !hasExactKeys(value, [
      "projectId",
      "chapterId",
      "versionId",
      "auditId",
      "formalRecordIds",
      "draft",
    ]) ||
    !isUuid(value.projectId) ||
    !isUuid(value.chapterId) ||
    !isUuid(value.versionId) ||
    !isUuid(value.auditId) ||
    !Array.isArray(value.formalRecordIds) ||
    value.formalRecordIds.length > 2 ||
    !value.formalRecordIds.every(isUuid) ||
    new Set(value.formalRecordIds).size !== value.formalRecordIds.length ||
    !hasExactKeys(value.draft, [
      "id",
      "expectedRevision",
      "finalizedRevision",
      "previousUpdatedAt",
    ]) ||
    !isUuid(value.draft.id) ||
    !isRevision(value.draft.expectedRevision) ||
    value.draft.finalizedRevision !== value.draft.expectedRevision + 1 ||
    typeof value.draft.previousUpdatedAt !== "string" ||
    !parseIsoUtcTimestamp(value.draft.previousUpdatedAt).ok
  ) {
    throw new AtomicIdeationJournalError("InvalidJournalArtifacts");
  }
}

function freezeArtifacts(value: IdeationJournalArtifacts): IdeationJournalArtifacts {
  return Object.freeze({
    projectId: value.projectId,
    chapterId: value.chapterId,
    versionId: value.versionId,
    auditId: value.auditId,
    formalRecordIds: Object.freeze([...value.formalRecordIds]),
    draft: Object.freeze({ ...value.draft }),
  });
}

function isDevelopmentBeforeVersion(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && parseUuidV7(value).ok;
}

function parseJsonObject(serialized: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // The stable error below intentionally excludes persisted content.
  }
  throw new AtomicIdeationJournalError(`Invalid${label}Json`);
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePresent(value: string | null): string {
  if (value === null) {
    throw new AtomicIdeationJournalError("MissingJournalTarget");
  }
  return value;
}

export class AtomicIdeationJournalError extends Error {
  public constructor(cause: string) {
    super("Prepared ideation transaction failed integrity validation.");
    this.name = "AtomicIdeationJournalError";
    this.cause = cause;
  }
}
