import type { ContentHasher } from "@inkshadow/application";
import { parseUuidV7, type Clock, type UuidV7, type UuidV7Generator } from "@inkshadow/domain";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

import type {
  ChapterNovelValidationRequest,
  ChapterNovelValidationResult,
  ChapterNovelValidationRuntime,
} from "./novel-validation-runtime";

export const CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CHAPTER_VALIDATION_RULE_SET_VERSION = "deterministic-novel-validator.v2";
export const DEVELOPMENT_CHAPTER_VALIDATION_SNAPSHOT_KEY =
  "inkshadow.development.chapter-validation-snapshots.v1";

const SNAPSHOT_COVERAGE_CATEGORIES = [
  "character_life_status",
  "character_age",
  "character_identity",
  "relationship",
  "event_time",
  "entity_location",
  "item_ownership",
  "ability_state",
  "world_property",
  "character_knowledge",
] as const;

export type ChapterValidationSnapshotRunMode = "reuse_current" | "rerun";
export type ChapterValidationSnapshotRunKind = "initial" | "rerun";

export interface ChapterValidationSnapshot {
  readonly schemaVersion: typeof CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION;
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly chapterVersionId: UuidV7 | null;
  readonly chapterRevision: number | null;
  readonly ruleSetVersion: string;
  readonly runSequence: number;
  readonly runKind: ChapterValidationSnapshotRunKind;
  readonly supersedesSnapshotId: UuidV7 | null;
  readonly resultStatus: ChapterNovelValidationResult["status"];
  readonly issueCount: number;
  readonly resultChecksumSha256: string;
  readonly result: ChapterNovelValidationResult;
  readonly generatedAt: string;
}

export interface SaveChapterValidationSnapshotInput {
  readonly id: UuidV7;
  readonly ruleSetVersion: string;
  readonly resultChecksumSha256: string;
  readonly result: ChapterNovelValidationResult;
  readonly generatedAt: string;
  readonly mode: ChapterValidationSnapshotRunMode;
}

export interface ChapterValidationSnapshotStore {
  save(input: SaveChapterValidationSnapshotInput): Promise<ChapterValidationSnapshot>;
  findLatest(projectId: UuidV7, chapterId: UuidV7): Promise<ChapterValidationSnapshot | null>;
}

export type ChapterValidationSnapshotErrorCode =
  | "CHAPTER_VALIDATION_SNAPSHOT_INVALID"
  | "CHAPTER_VALIDATION_SNAPSHOT_CORRUPT"
  | "CHAPTER_VALIDATION_SNAPSHOT_UNAVAILABLE"
  | "CHAPTER_VALIDATION_SNAPSHOT_HASH_UNAVAILABLE";

export class ChapterValidationSnapshotError extends Error {
  public constructor(
    readonly code: ChapterValidationSnapshotErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChapterValidationSnapshotError";
  }
}

interface BrowserSnapshotDatabase {
  readonly schemaVersion: typeof CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION;
  readonly snapshots: Readonly<Record<string, ChapterValidationSnapshot>>;
}

interface SnapshotRow {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly chapterVersionId: string | null;
  readonly chapterRevision: number | null;
  readonly schemaVersion: number;
  readonly ruleSetVersion: string;
  readonly runSequence: number;
  readonly runKind: string;
  readonly supersedesSnapshotId: string | null;
  readonly resultStatus: string;
  readonly issueCount: number;
  readonly resultChecksumSha256: string;
  readonly resultJson: string;
  readonly generatedAt: string;
}

const SNAPSHOT_SELECT = `SELECT
  id,
  project_id AS projectId,
  chapter_id AS chapterId,
  chapter_version_id AS chapterVersionId,
  chapter_revision AS chapterRevision,
  schema_version AS schemaVersion,
  rule_set_version AS ruleSetVersion,
  run_sequence AS runSequence,
  run_kind AS runKind,
  supersedes_snapshot_id AS supersedesSnapshotId,
  result_status AS resultStatus,
  issue_count AS issueCount,
  result_checksum_sha256 AS resultChecksumSha256,
  result_json AS resultJson,
  generated_at AS generatedAt
FROM chapter_validation_snapshots`;

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const RULE_SET_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAXIMUM_RESULTS = 10_000;
const MAXIMUM_TEXT_LENGTH = 5_000_000;

export class SqliteChapterValidationSnapshotStore implements ChapterValidationSnapshotStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async save(
    inputValue: SaveChapterValidationSnapshotInput,
  ): Promise<ChapterValidationSnapshot> {
    const input = normalizeWriteInput(inputValue);
    try {
      return await this.executor.transaction(async (transaction) => {
        const latest = await readSqlLatest(
          transaction,
          input.result.projectId,
          input.result.chapterId,
        );
        if (input.mode === "reuse_current" && canReuse(latest, input)) {
          return latest;
        }
        const snapshot = createSnapshot(input, latest);
        await transaction.execute(
          `INSERT INTO chapter_validation_snapshots (
             id, project_id, chapter_id, chapter_version_id, chapter_revision,
             schema_version, rule_set_version, run_sequence, run_kind,
             supersedes_snapshot_id, result_status, issue_count,
             result_checksum_sha256, result_json, generated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshot.id,
            snapshot.projectId,
            snapshot.chapterId,
            snapshot.chapterVersionId,
            snapshot.chapterRevision,
            snapshot.schemaVersion,
            snapshot.ruleSetVersion,
            snapshot.runSequence,
            snapshot.runKind,
            snapshot.supersedesSnapshotId,
            snapshot.resultStatus,
            snapshot.issueCount,
            snapshot.resultChecksumSha256,
            JSON.stringify(snapshot.result),
            snapshot.generatedAt,
          ],
        );
        return snapshot;
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to save the chapter validation snapshot.");
    }
  }

  public async findLatest(
    projectIdValue: UuidV7,
    chapterIdValue: UuidV7,
  ): Promise<ChapterValidationSnapshot | null> {
    const projectId = validateUuid(projectIdValue, false);
    const chapterId = validateUuid(chapterIdValue, false);
    try {
      return await readSqlLatest(this.executor, projectId, chapterId);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to read the latest chapter validation snapshot.");
    }
  }
}

export class BrowserDevelopmentChapterValidationSnapshotStore implements ChapterValidationSnapshotStore {
  public constructor(private readonly storage: Storage) {}

  public save(inputValue: SaveChapterValidationSnapshotInput): Promise<ChapterValidationSnapshot> {
    return Promise.resolve().then(() => {
      const input = normalizeWriteInput(inputValue);
      const database = this.readDatabase();
      const latest = latestForChapter(
        Object.values(database.snapshots),
        input.result.projectId,
        input.result.chapterId,
      );
      if (input.mode === "reuse_current" && canReuse(latest, input)) {
        return latest;
      }
      const snapshot = createSnapshot(input, latest);
      if (database.snapshots[snapshot.id] !== undefined) {
        throw invalidSnapshot("The generated snapshot identifier is already in use.");
      }
      this.writeDatabase({
        schemaVersion: CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION,
        snapshots: Object.freeze({ ...database.snapshots, [snapshot.id]: snapshot }),
      });
      return snapshot;
    });
  }

  public findLatest(
    projectIdValue: UuidV7,
    chapterIdValue: UuidV7,
  ): Promise<ChapterValidationSnapshot | null> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, false);
      const chapterId = validateUuid(chapterIdValue, false);
      return latestForChapter(Object.values(this.readDatabase().snapshots), projectId, chapterId);
    });
  }

  private readDatabase(): BrowserSnapshotDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_CHAPTER_VALIDATION_SNAPSHOT_KEY);
    if (serialized === null) {
      return Object.freeze({
        schemaVersion: CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION,
        snapshots: Object.freeze({}),
      });
    }
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (
        !isRecord(parsed) ||
        !hasExactKeys(parsed, ["schemaVersion", "snapshots"]) ||
        parsed.schemaVersion !== CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION ||
        !isRecord(parsed.snapshots)
      ) {
        throw corruptSnapshot();
      }
      const snapshots: Record<string, ChapterValidationSnapshot> = {};
      const sequences = new Set<string>();
      for (const [id, value] of Object.entries(parsed.snapshots)) {
        const snapshot = normalizeSnapshot(value, true);
        const sequenceKey = `${snapshot.chapterId}:${String(snapshot.runSequence)}`;
        if (snapshot.id !== id || sequences.has(sequenceKey)) {
          throw corruptSnapshot();
        }
        snapshots[id] = snapshot;
        sequences.add(sequenceKey);
      }
      return Object.freeze({
        schemaVersion: CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION,
        snapshots: Object.freeze(snapshots),
      });
    } catch (cause: unknown) {
      if (
        cause instanceof ChapterValidationSnapshotError &&
        cause.code === "CHAPTER_VALIDATION_SNAPSHOT_CORRUPT"
      ) {
        throw cause;
      }
      throw corruptSnapshot();
    }
  }

  private writeDatabase(database: BrowserSnapshotDatabase): void {
    try {
      this.storage.setItem(DEVELOPMENT_CHAPTER_VALIDATION_SNAPSHOT_KEY, JSON.stringify(database));
    } catch {
      throw new ChapterValidationSnapshotError(
        "CHAPTER_VALIDATION_SNAPSHOT_UNAVAILABLE",
        "Browser storage could not save the chapter validation snapshot.",
        true,
      );
    }
  }
}

export class ChapterValidationSnapshotService {
  public constructor(
    private readonly dependencies: Readonly<{
      validator: Pick<ChapterNovelValidationRuntime, "checkChapter">;
      store: ChapterValidationSnapshotStore;
      ids: UuidV7Generator;
      clock: Clock;
      hasher: ContentHasher;
      ruleSetVersion?: string;
    }>,
  ) {}

  public async findLatest(
    projectId: UuidV7,
    chapterId: UuidV7,
  ): Promise<ChapterValidationSnapshot | null> {
    const snapshot = await this.dependencies.store.findLatest(projectId, chapterId);
    if (snapshot === null) {
      return null;
    }
    await this.assertChecksum(snapshot);
    return snapshot;
  }

  public async run(
    request: ChapterNovelValidationRequest,
    options: Readonly<{ readonly mode: ChapterValidationSnapshotRunMode }> = { mode: "rerun" },
  ): Promise<ChapterValidationSnapshot> {
    const result = await this.dependencies.validator.checkChapter(request);
    const serialized = JSON.stringify(result);
    const checksum = await this.dependencies.hasher.sha256(serialized);
    if (!checksum.ok) {
      throw new ChapterValidationSnapshotError(
        "CHAPTER_VALIDATION_SNAPSHOT_HASH_UNAVAILABLE",
        "The validation result could not be checksummed, so no snapshot was saved.",
        true,
      );
    }
    const snapshot = await this.dependencies.store.save({
      id: this.dependencies.ids.next(),
      ruleSetVersion: this.dependencies.ruleSetVersion ?? CHAPTER_VALIDATION_RULE_SET_VERSION,
      resultChecksumSha256: checksum.value,
      result,
      generatedAt: this.dependencies.clock.now(),
      mode: options.mode,
    });
    // `reuse_current` may return an existing row rather than the freshly
    // computed result. Verify the returned payload before exposing it so a
    // structurally valid but corrupted stored JSON cannot bypass findLatest's
    // checksum boundary.
    await this.assertChecksum(snapshot);
    return snapshot;
  }

  private async assertChecksum(snapshot: ChapterValidationSnapshot): Promise<void> {
    const checksum = await this.dependencies.hasher.sha256(JSON.stringify(snapshot.result));
    if (!checksum.ok) {
      throw new ChapterValidationSnapshotError(
        "CHAPTER_VALIDATION_SNAPSHOT_HASH_UNAVAILABLE",
        "The stored validation snapshot could not be verified.",
        true,
      );
    }
    if (checksum.value !== snapshot.resultChecksumSha256) {
      throw corruptSnapshot();
    }
  }
}

async function readSqlLatest(
  executor: Pick<TransactionExecutor, "select">,
  projectId: UuidV7,
  chapterId: UuidV7,
): Promise<ChapterValidationSnapshot | null> {
  const rows = await executor.select<SnapshotRow>(
    `${SNAPSHOT_SELECT}
     WHERE project_id = ? AND chapter_id = ?
     ORDER BY run_sequence DESC
     LIMIT 1`,
    [projectId, chapterId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  let result: unknown;
  try {
    result = JSON.parse(row.resultJson) as unknown;
  } catch {
    throw corruptSnapshot();
  }
  return normalizeSnapshot(
    {
      schemaVersion: row.schemaVersion,
      id: row.id,
      projectId: row.projectId,
      chapterId: row.chapterId,
      chapterVersionId: row.chapterVersionId,
      chapterRevision: row.chapterRevision,
      ruleSetVersion: row.ruleSetVersion,
      runSequence: row.runSequence,
      runKind: row.runKind,
      supersedesSnapshotId: row.supersedesSnapshotId,
      resultStatus: row.resultStatus,
      issueCount: row.issueCount,
      resultChecksumSha256: row.resultChecksumSha256,
      result,
      generatedAt: row.generatedAt,
    },
    true,
  );
}

function createSnapshot(
  input: SaveChapterValidationSnapshotInput,
  latest: ChapterValidationSnapshot | null,
): ChapterValidationSnapshot {
  return normalizeSnapshot({
    schemaVersion: CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION,
    id: input.id,
    projectId: input.result.projectId,
    chapterId: input.result.chapterId,
    chapterVersionId: input.result.chapterVersionId,
    chapterRevision: input.result.chapterRevision,
    ruleSetVersion: input.ruleSetVersion,
    runSequence: (latest?.runSequence ?? 0) + 1,
    runKind: latest === null ? "initial" : "rerun",
    supersedesSnapshotId: latest?.id ?? null,
    resultStatus: input.result.status,
    issueCount: input.result.issues.length,
    resultChecksumSha256: input.resultChecksumSha256,
    result: input.result,
    generatedAt: input.generatedAt,
  });
}

function canReuse(
  latest: ChapterValidationSnapshot | null,
  input: SaveChapterValidationSnapshotInput,
): latest is ChapterValidationSnapshot {
  return (
    latest !== null &&
    latest.chapterVersionId === input.result.chapterVersionId &&
    latest.chapterRevision === input.result.chapterRevision &&
    latest.ruleSetVersion === input.ruleSetVersion &&
    latest.resultChecksumSha256 === input.resultChecksumSha256
  );
}

function latestForChapter(
  snapshots: readonly ChapterValidationSnapshot[],
  projectId: UuidV7,
  chapterId: UuidV7,
): ChapterValidationSnapshot | null {
  return (
    snapshots
      .filter((snapshot) => snapshot.projectId === projectId && snapshot.chapterId === chapterId)
      .sort((left, right) => right.runSequence - left.runSequence)[0] ?? null
  );
}

function normalizeWriteInput(
  input: SaveChapterValidationSnapshotInput,
): SaveChapterValidationSnapshotInput {
  const id = validateUuid(input.id, false);
  const result = normalizeResult(input.result, false);
  if (
    !RULE_SET_VERSION_PATTERN.test(input.ruleSetVersion) ||
    !CHECKSUM_PATTERN.test(input.resultChecksumSha256) ||
    !isIsoTimestamp(input.generatedAt)
  ) {
    throw invalidSnapshot();
  }
  return Object.freeze({
    id,
    ruleSetVersion: input.ruleSetVersion,
    resultChecksumSha256: input.resultChecksumSha256,
    result,
    generatedAt: input.generatedAt,
    mode: input.mode,
  });
}

function normalizeSnapshot(value: unknown, stored = false): ChapterValidationSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "id",
      "projectId",
      "chapterId",
      "chapterVersionId",
      "chapterRevision",
      "ruleSetVersion",
      "runSequence",
      "runKind",
      "supersedesSnapshotId",
      "resultStatus",
      "issueCount",
      "resultChecksumSha256",
      "result",
      "generatedAt",
    ])
  ) {
    throw stored ? corruptSnapshot() : invalidSnapshot();
  }
  const id = validateUuid(value.id, stored);
  const projectId = validateUuid(value.projectId, stored);
  const chapterId = validateUuid(value.chapterId, stored);
  const chapterVersionId =
    value.chapterVersionId === null ? null : validateUuid(value.chapterVersionId, stored);
  const supersedesSnapshotId =
    value.supersedesSnapshotId === null ? null : validateUuid(value.supersedesSnapshotId, stored);
  const result = normalizeResult(value.result, stored);
  const valid =
    value.schemaVersion === CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION &&
    typeof value.ruleSetVersion === "string" &&
    RULE_SET_VERSION_PATTERN.test(value.ruleSetVersion) &&
    Number.isSafeInteger(value.runSequence) &&
    Number(value.runSequence) >= 1 &&
    (value.runKind === "initial" || value.runKind === "rerun") &&
    (value.resultStatus === "checked" || value.resultStatus === "skipped") &&
    Number.isSafeInteger(value.issueCount) &&
    Number(value.issueCount) >= 0 &&
    typeof value.resultChecksumSha256 === "string" &&
    CHECKSUM_PATTERN.test(value.resultChecksumSha256) &&
    typeof value.generatedAt === "string" &&
    isIsoTimestamp(value.generatedAt) &&
    result.projectId === projectId &&
    result.chapterId === chapterId &&
    result.chapterVersionId === chapterVersionId &&
    result.chapterRevision === value.chapterRevision &&
    result.status === value.resultStatus &&
    result.issues.length === value.issueCount &&
    ((value.runKind === "initial" && value.runSequence === 1 && supersedesSnapshotId === null) ||
      (value.runKind === "rerun" &&
        Number(value.runSequence) > 1 &&
        supersedesSnapshotId !== null));
  if (!valid) {
    throw stored ? corruptSnapshot() : invalidSnapshot();
  }
  return Object.freeze({
    schemaVersion: CHAPTER_VALIDATION_SNAPSHOT_SCHEMA_VERSION,
    id,
    projectId,
    chapterId,
    chapterVersionId,
    chapterRevision: value.chapterRevision as number | null,
    ruleSetVersion: value.ruleSetVersion as string,
    runSequence: Number(value.runSequence),
    runKind: value.runKind as ChapterValidationSnapshotRunKind,
    supersedesSnapshotId,
    resultStatus: value.resultStatus as ChapterNovelValidationResult["status"],
    issueCount: Number(value.issueCount),
    resultChecksumSha256: value.resultChecksumSha256 as string,
    result,
    generatedAt: value.generatedAt as string,
  });
}

function normalizeResult(value: unknown, stored: boolean): ChapterNovelValidationResult {
  const baseKeys = [
    "status",
    "projectId",
    "chapterId",
    "chapterVersionId",
    "chapterRevision",
    "issues",
    "resolutions",
    "skippedFacts",
    "missingRequirements",
    "explanation",
    "checked",
    "capabilities",
  ] as const;
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, baseKeys) && !hasExactKeys(value, [...baseKeys, "coverage"])) ||
    (value.status !== "checked" && value.status !== "skipped") ||
    !Array.isArray(value.issues) ||
    !Array.isArray(value.resolutions) ||
    !Array.isArray(value.skippedFacts) ||
    !Array.isArray(value.missingRequirements) ||
    value.issues.length > MAXIMUM_RESULTS ||
    value.resolutions.length > MAXIMUM_RESULTS ||
    value.skippedFacts.length > MAXIMUM_RESULTS ||
    value.missingRequirements.length > MAXIMUM_RESULTS ||
    typeof value.explanation !== "string" ||
    value.explanation.length > MAXIMUM_TEXT_LENGTH ||
    !isRecord(value.checked) ||
    !isRecord(value.capabilities) ||
    (value.coverage !== undefined && !isValidCoverage(value.coverage))
  ) {
    throw stored ? corruptSnapshot() : invalidSnapshot();
  }
  validateUuid(value.projectId, stored);
  validateUuid(value.chapterId, stored);
  if (value.chapterVersionId !== null) {
    validateUuid(value.chapterVersionId, stored);
  }
  if (
    (value.chapterRevision !== null &&
      (!Number.isSafeInteger(value.chapterRevision) || Number(value.chapterRevision) < 1)) ||
    !value.missingRequirements.every(isBoundedString) ||
    !value.issues.every(isValidIssue) ||
    !value.resolutions.every(isRecord) ||
    !value.skippedFacts.every(isRecord) ||
    !hasExactKeys(value.checked, ["currentClaims", "referenceFacts", "hardRules"]) ||
    !Object.values(value.checked).every(isNonNegativeInteger) ||
    !hasExactKeys(value.capabilities, [
      "deterministicValidation",
      "naturalLanguageInference",
      "ambiguousModelReview",
      "mutatesChapter",
    ]) ||
    value.capabilities.deterministicValidation !== "ready" ||
    value.capabilities.naturalLanguageInference !== "disabled" ||
    value.capabilities.ambiguousModelReview !== "separate_read_only_service" ||
    value.capabilities.mutatesChapter !== false
  ) {
    throw stored ? corruptSnapshot() : invalidSnapshot();
  }
  const cloned = cloneJson(value, stored);
  const frozen = deepFreeze(cloned);
  return frozen as ChapterNovelValidationResult;
}

function isValidCoverage(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== SNAPSHOT_COVERAGE_CATEGORIES.length ||
    !value.every(isValidCoverageItem)
  ) {
    return false;
  }
  const categories = value.map((item) => (item as Readonly<{ category: string }>).category);
  return (
    new Set(categories).size === SNAPSHOT_COVERAGE_CATEGORIES.length &&
    SNAPSHOT_COVERAGE_CATEGORIES.every((category) => categories.includes(category))
  );
}

function isValidCoverageItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "category",
      "status",
      "reason",
      "currentClaimCount",
      "comparableReferenceCount",
      "applicableHardRuleCount",
    ]) &&
    SNAPSHOT_COVERAGE_CATEGORIES.includes(
      value.category as (typeof SNAPSHOT_COVERAGE_CATEGORIES)[number],
    ) &&
    (value.status === "checked" || value.status === "not_checked") &&
    [
      "explicit_claim_compared",
      "current_claim_missing",
      "confirmed_reference_or_rule_missing",
      "no_comparable_source",
    ].includes(String(value.reason)) &&
    isNonNegativeInteger(value.currentClaimCount) &&
    isNonNegativeInteger(value.comparableReferenceCount) &&
    isNonNegativeInteger(value.applicableHardRuleCount) &&
    (value.status === "checked"
      ? value.reason === "explicit_claim_compared" &&
        Number(value.comparableReferenceCount) + Number(value.applicableHardRuleCount) > 0
      : value.reason !== "explicit_claim_compared" &&
        Number(value.comparableReferenceCount) === 0 &&
        Number(value.applicableHardRuleCount) === 0)
  );
}

function isValidIssue(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isBoundedString(value.type) ||
    !isBoundedString(value.currentTextExcerpt) ||
    (value.severity !== "warning" && value.severity !== "error") ||
    !Array.isArray(value.currentEvidence) ||
    !Array.isArray(value.conflictingEvidence) ||
    value.currentEvidence.length > MAXIMUM_RESULTS ||
    value.conflictingEvidence.length > MAXIMUM_RESULTS ||
    !value.currentEvidence.every(isValidEvidence) ||
    !value.conflictingEvidence.every(isValidEvidence) ||
    !isRecord(value.currentClaim) ||
    !isRecord(value.conflictingFact) ||
    !isBoundedString(value.modificationSuggestion) ||
    !Array.isArray(value.availableActions) ||
    !value.availableActions.every(
      (action) => action === "ignore" || action === "allow" || action === "update_setting",
    ) ||
    !isRecord(value.resolution) ||
    typeof value.canUndoIgnore !== "boolean"
  ) {
    return false;
  }
  return true;
}

function isValidEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.sourceKind) &&
    isBoundedString(value.sourceId) &&
    isBoundedString(value.sourceVersionId) &&
    typeof value.contentHash === "string" &&
    CHECKSUM_PATTERN.test(value.contentHash) &&
    isBoundedString(value.locator) &&
    isBoundedString(value.excerpt) &&
    isNonNegativeInteger(value.startOffset) &&
    isNonNegativeInteger(value.endOffset) &&
    isNonNegativeInteger(value.sourceLength) &&
    Number(value.startOffset) <= Number(value.endOffset) &&
    Number(value.endOffset) <= Number(value.sourceLength)
  );
}

function cloneJson(value: unknown, stored: boolean): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 50_000_000) {
      throw new Error("snapshot too large");
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    throw stored ? corruptSnapshot() : invalidSnapshot();
  }
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function validateUuid(value: unknown, stored: boolean): UuidV7 {
  const parsed = typeof value === "string" ? parseUuidV7(value) : null;
  if (parsed?.ok !== true) {
    throw stored ? corruptSnapshot() : invalidSnapshot();
  }
  return parsed.value;
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAXIMUM_TEXT_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidSnapshot(
  message = "The chapter validation snapshot is invalid.",
): ChapterValidationSnapshotError {
  return new ChapterValidationSnapshotError("CHAPTER_VALIDATION_SNAPSHOT_INVALID", message, false);
}

function corruptSnapshot(): ChapterValidationSnapshotError {
  return new ChapterValidationSnapshotError(
    "CHAPTER_VALIDATION_SNAPSHOT_CORRUPT",
    "The stored chapter validation snapshot failed integrity checks.",
    false,
  );
}

function normalizeFailure(cause: unknown, message: string): ChapterValidationSnapshotError {
  if (cause instanceof ChapterValidationSnapshotError) {
    return cause;
  }
  return new ChapterValidationSnapshotError(
    "CHAPTER_VALIDATION_SNAPSHOT_UNAVAILABLE",
    message,
    true,
  );
}
