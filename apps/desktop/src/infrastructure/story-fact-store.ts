import {
  CONTINUOUS_STORY_STATE_ROUTE_TASKS,
  STORY_FACT_REVISION_CHANGE_KINDS,
  STORY_FACT_STATUSES,
  MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES,
  StoryCoreError,
  StoryFact,
  err,
  ok,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type Result,
  type ContinuousStoryStateRouteCommit,
  type ContinuousStoryStateRouteCommitReceipt,
  type ContinuousStoryStateRouteIdentity,
  type ContinuousStoryStateRouteReceipt,
  type StoryFactListFilter,
  type StoryFactAuthorityFence,
  type StoryFactConditionalCreateReceipt,
  type StoryFactConditionalDeprecateReceipt,
  type StoryFactRevision,
  type StoryFactRevisionChangeKind,
  type StoryFactSnapshot,
  type StoryFactStore,
  type StoryFactSupplementalResolutionUndoFence,
  type UuidV7,
} from "@inkshadow/story-core";

import { DEVELOPMENT_DATABASE_KEY } from "./development-atomic-journal";

export const DEVELOPMENT_STORY_FACT_STORE_KEY = "inkshadow.development.story-facts.v1";
const CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA =
  "inkshadow.chapter-supplemental-finding-resolution.v1";

interface StoredRevision {
  readonly changeKind: StoryFactRevisionChangeKind;
  readonly recordedAt: string;
  readonly snapshot: StoryFactSnapshot;
}

interface BrowserStoryFactDatabase {
  readonly schemaVersion: 2;
  facts: Record<string, StoryFactSnapshot>;
  revisions: Record<string, readonly StoredRevision[]>;
  routeReceipts: Record<string, ContinuousStoryStateRouteReceipt>;
}

interface DevelopmentChapterAuthority {
  readonly currentVersionId: string;
  readonly status: string;
  readonly versionContent: string;
  readonly contentChecksum: string | null;
}

function readDevelopmentChapterAuthority(
  storage: Storage,
  chapterId: string,
  projectId: string,
  versionId: string,
): DevelopmentChapterAuthority | null {
  const serialized = storage.getItem(DEVELOPMENT_DATABASE_KEY);
  if (serialized === null) return null;
  const parsed: unknown = JSON.parse(serialized);
  if (
    !isPlainObject(parsed) ||
    !Array.isArray(parsed.chapters) ||
    !Array.isArray(parsed.versions)
  ) {
    return null;
  }
  const chapters = (parsed.chapters as readonly unknown[]).filter(
    (value) => isPlainObject(value) && value.id === chapterId && value.projectId === projectId,
  );
  const versions = (parsed.versions as readonly unknown[]).filter(
    (value) =>
      isPlainObject(value) &&
      value.id === versionId &&
      value.chapterId === chapterId &&
      value.projectId === projectId,
  );
  const chapter = chapters[0];
  const version = versions[0];
  return chapters.length === 1 &&
    versions.length === 1 &&
    isPlainObject(chapter) &&
    isPlainObject(version) &&
    typeof chapter.currentVersionId === "string" &&
    typeof chapter.status === "string" &&
    typeof version.content === "string"
    ? Object.freeze({
        currentVersionId: chapter.currentVersionId,
        status: chapter.status,
        versionContent: version.content,
        contentChecksum:
          typeof version.contentChecksum === "string" ? version.contentChecksum : null,
      })
    : null;
}

function activeCausalEventIdCounts(
  database: BrowserStoryFactDatabase,
  projectId: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const snapshot of Object.values(database.facts)) {
    if (
      snapshot.projectId !== projectId ||
      snapshot.factType !== "causal_event" ||
      !isActiveFormalMainFact(snapshot) ||
      !isPlainObject(snapshot.structuredValue) ||
      (snapshot.structuredValue.schemaVersion !== "inkshadow.causal-event-fact.v1" &&
        snapshot.structuredValue.schemaVersion !== "inkshadow.causal-event-fact.v2")
    ) {
      continue;
    }
    const eventId =
      typeof snapshot.structuredValue.eventId === "string"
        ? snapshot.structuredValue.eventId
        : snapshot.id;
    counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
  }
  return counts;
}

function isActiveFormalMainFact(snapshot: StoryFactSnapshot): boolean {
  return (
    snapshot.status === "formal" &&
    snapshot.userConfirmed &&
    !snapshot.needsReview &&
    !snapshot.deprecated &&
    snapshot.invalidatedAt === null &&
    snapshot.branchId === null
  );
}

function activeConfirmedCharacterIdCounts(
  database: BrowserStoryFactDatabase,
  projectId: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const snapshot of Object.values(database.facts)) {
    if (
      snapshot.projectId !== projectId ||
      snapshot.factType !== "character_identity" ||
      !isActiveFormalMainFact(snapshot) ||
      !isPlainObject(snapshot.structuredValue) ||
      !isPlainObject(snapshot.structuredValue.subject)
    ) {
      continue;
    }
    const subject = snapshot.structuredValue.subject;
    if (subject.kind === "character" && typeof subject.entityKey === "string") {
      counts.set(subject.entityKey, (counts.get(subject.entityKey) ?? 0) + 1);
    }
  }
  return counts;
}

const CAUSAL_EVENT_FACT_SCHEMAS = new Set([
  "inkshadow.causal-event-fact.v1",
  "inkshadow.causal-event-fact.v2",
]);
const CAUSAL_RELATION_FACT_SCHEMA = "inkshadow.causal-relation-fact.v1";

function authorityFenceBindingFailure(
  snapshot: StoryFactSnapshot,
  fence: StoryFactAuthorityFence,
): StoryCoreError | null {
  const source = snapshot.source;
  const structured = isPlainObject(snapshot.structuredValue) ? snapshot.structuredValue : null;
  const supplementalIdentity = supplementalResolutionIdentity(snapshot);
  if (supplementalIdentity !== null) {
    return source.kind === "review_decision" &&
      supplementalIdentity.chapterId === fence.chapterId &&
      supplementalIdentity.chapterVersionId === fence.expectedCurrentVersionId &&
      sameAuthorityReferences(fence.requiredCausalEventIds, []) &&
      sameAuthorityReferences(fence.requiredCharacterIds, [])
      ? null
      : validationFailure("The supplemental finding authority fence is invalid.");
  }
  if (
    source.kind !== "chapter_span" ||
    source.chapterId !== fence.chapterId ||
    source.versionId !== fence.expectedCurrentVersionId
  ) {
    return new StoryCoreError({
      code: "STORY_FACT_SOURCE_FENCE_FAILED",
      message: "The authority fence does not match the fact's exact chapter version.",
    });
  }

  const schemaVersion = structured?.schemaVersion;
  const hasCausalEventSchema =
    typeof schemaVersion === "string" && CAUSAL_EVENT_FACT_SCHEMAS.has(schemaVersion);
  if (snapshot.factType === "causal_relation" || schemaVersion === CAUSAL_RELATION_FACT_SCHEMA) {
    const fromEventId = safeAuthorityReference(structured?.fromEventId);
    const toEventId = safeAuthorityReference(structured?.toEventId);
    if (
      snapshot.factType !== "causal_relation" ||
      schemaVersion !== CAUSAL_RELATION_FACT_SCHEMA ||
      fromEventId === null ||
      toEventId === null ||
      fromEventId === toEventId ||
      !sameAuthorityReferences(fence.requiredCausalEventIds, [fromEventId, toEventId]) ||
      !sameAuthorityReferences(fence.requiredCharacterIds, [])
    ) {
      return new StoryCoreError({
        code: "STORY_FACT_RELATION_ENDPOINT_INVALID",
        message: "The causal relation fence does not match the relation endpoints.",
      });
    }
    return null;
  }

  if (snapshot.factType === "causal_event" || hasCausalEventSchema) {
    if (
      snapshot.factType !== "causal_event" ||
      typeof schemaVersion !== "string" ||
      !CAUSAL_EVENT_FACT_SCHEMAS.has(schemaVersion)
    ) {
      return validationFailure("The causal event authority fence is invalid.");
    }
    const prerequisiteEventIds = causalEventPrerequisiteEventReferences(structured);
    const characterIds = causalEventCharacterReferences(structured);
    if (
      prerequisiteEventIds === null ||
      !sameAuthorityReferences(fence.requiredCausalEventIds, prerequisiteEventIds)
    ) {
      return new StoryCoreError({
        code: "STORY_FACT_RELATION_ENDPOINT_INVALID",
        message: "The causal event prerequisite fence does not match its event references.",
      });
    }
    if (
      characterIds === null ||
      !sameAuthorityReferences(fence.requiredCharacterIds, characterIds)
    ) {
      return new StoryCoreError({
        code: "STORY_FACT_CHARACTER_AUTHORITY_INVALID",
        message: "The character authority fence does not match the causal event references.",
      });
    }
    return null;
  }

  return sameAuthorityReferences(fence.requiredCausalEventIds, []) &&
    sameAuthorityReferences(fence.requiredCharacterIds, [])
    ? null
    : validationFailure("This story fact cannot carry causal authority references.");
}

function causalEventPrerequisiteEventReferences(
  structured: Readonly<Record<string, unknown>> | null,
): readonly string[] | null {
  if (structured === null || !Array.isArray(structured.prerequisites)) return null;
  if (structured.prerequisites.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) return null;
  const references: string[] = [];
  for (const value of structured.prerequisites as readonly unknown[]) {
    if (!isPlainObject(value)) return null;
    if (value.kind !== "event") continue;
    const referenceId = safeAuthorityReference(value.referenceId);
    if (referenceId === null) return null;
    references.push(referenceId);
  }
  return Object.freeze(references);
}

function causalEventCharacterReferences(
  structured: Readonly<Record<string, unknown>> | null,
): readonly string[] | null {
  if (structured === null) return null;
  const references: string[] = [];
  if (
    !appendAuthorityReferenceArray(references, structured.participantCharacterIds) ||
    !appendAuthorityReferenceArray(references, structured.informedCharacterIds) ||
    !appendAuthorityRecordReferences(references, structured.knowledgeGains, ["characterId"]) ||
    !appendAuthorityRecordReferences(references, structured.characterStateChanges, [
      "characterId",
    ]) ||
    !appendAuthorityRecordReferences(references, structured.relationshipChanges, [
      "fromCharacterId",
      "toCharacterId",
    ]) ||
    !appendAuthorityRecordReferences(
      references,
      structured.itemChanges,
      ["fromCharacterId", "toCharacterId"],
      true,
    )
  ) {
    return null;
  }
  return Object.freeze([...new Set(references)]);
}

function appendAuthorityReferenceArray(target: string[], value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) {
    return false;
  }
  for (const item of value as readonly unknown[]) {
    const reference = safeAuthorityReference(item);
    if (reference === null) return false;
    target.push(reference);
  }
  return true;
}

function appendAuthorityRecordReferences(
  target: string[],
  value: unknown,
  keys: readonly string[],
  nullable = false,
): boolean {
  if (!Array.isArray(value) || value.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) {
    return false;
  }
  for (const item of value as readonly unknown[]) {
    if (!isPlainObject(item)) return false;
    for (const key of keys) {
      if (nullable && (item[key] === null || item[key] === undefined)) continue;
      const reference = safeAuthorityReference(item[key]);
      if (reference === null) return false;
      target.push(reference);
    }
  }
  return true;
}

function sameAuthorityReferences(
  actualValue: readonly string[] | undefined,
  expectedValue: readonly string[],
): boolean {
  const actual = actualValue ?? [];
  if (
    actual.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES ||
    new Set(actual).size !== actual.length ||
    new Set(expectedValue).size !== expectedValue.length ||
    actual.some((value) => safeAuthorityReference(value) === null)
  ) {
    return false;
  }
  const expected = new Set(expectedValue);
  return actual.length === expected.size && actual.every((value) => expected.has(value));
}

function safeAuthorityReference(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function sameSubmission(left: StoryFactSnapshot, right: StoryFactSnapshot): boolean {
  return (
    left.projectId === right.projectId &&
    left.factType === right.factType &&
    left.contentText === right.contentText &&
    JSON.stringify(left.structuredValue) === JSON.stringify(right.structuredValue) &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    left.effectiveAt === right.effectiveAt &&
    left.invalidatedAt === right.invalidatedAt &&
    left.branchId === right.branchId &&
    left.status === right.status &&
    left.origin === right.origin &&
    left.userConfirmed === right.userConfirmed
  );
}

function supplementalResolutionIdentity(snapshot: StoryFactSnapshot): Readonly<{
  readonly key: string;
  readonly action: "ignore" | "allow";
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly findingId: string;
  readonly evidenceSignature: string;
}> | null {
  if (
    snapshot.factType !== "validation_resolution" ||
    snapshot.status !== "formal" ||
    !snapshot.userConfirmed ||
    snapshot.needsReview ||
    snapshot.deprecated ||
    snapshot.invalidatedAt !== null ||
    snapshot.branchId !== null
  ) {
    return null;
  }
  return supplementalResolutionMetadata(snapshot);
}

function supplementalResolutionMetadata(snapshot: StoryFactSnapshot): Readonly<{
  readonly key: string;
  readonly action: "ignore" | "allow";
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly findingId: string;
  readonly evidenceSignature: string;
}> | null {
  if (
    snapshot.factType !== "validation_resolution" ||
    !snapshot.userConfirmed ||
    snapshot.needsReview ||
    snapshot.invalidatedAt !== null ||
    snapshot.branchId !== null
  ) {
    return null;
  }
  const value = isPlainObject(snapshot.structuredValue) ? snapshot.structuredValue : null;
  const action = value?.resolutionAction;
  const findingId = boundedResolutionIdentityPart(value?.resolvedFindingId, 1_000);
  const chapterId = safeAuthorityReference(value?.resolvedChapterId);
  const chapterVersionId = safeAuthorityReference(value?.resolvedChapterVersionId);
  const evidenceSignature = boundedResolutionIdentityPart(value?.evidenceSignature, 5_000);
  if (
    value?.resolutionSchema !== CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA ||
    (action !== "ignore" && action !== "allow") ||
    findingId === null ||
    chapterId === null ||
    chapterVersionId === null ||
    evidenceSignature === null
  ) {
    return null;
  }
  return Object.freeze({
    key: JSON.stringify([
      snapshot.projectId,
      chapterId,
      chapterVersionId,
      findingId,
      evidenceSignature,
    ]),
    action,
    chapterId,
    chapterVersionId,
    findingId,
    evidenceSignature,
  });
}

function boundedResolutionIdentityPart(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

/** Browser-development parity adapter for the Tauri/SQLite story-fact store. */
export class BrowserDevelopmentStoryFactStore implements StoryFactStore {
  public constructor(private readonly storage: Storage) {}

  public create(fact: StoryFact): Promise<Result<void, StoryCoreError>> {
    return this.mutate((database) => {
      const snapshot = fact.toSnapshot();
      if (
        database.facts[snapshot.id] !== undefined ||
        snapshot.revision !== 1 ||
        (snapshot.status === "formal" && snapshot.origin !== "user") ||
        !hasSafeEntityAliasPayload(snapshot)
      ) {
        return err(storeFailure("Story fact already exists or has an invalid initial revision."));
      }
      database.facts[snapshot.id] = snapshot;
      database.revisions[snapshot.id] = Object.freeze([
        Object.freeze({
          changeKind: "created",
          recordedAt: snapshot.updatedAt,
          snapshot,
        }),
      ]);
      return ok(undefined);
    });
  }

  public createWithAuthorityFence(
    fact: StoryFact,
    fence: StoryFactAuthorityFence,
  ): Promise<Result<StoryFactConditionalCreateReceipt, StoryCoreError>> {
    return this.mutate<StoryFactConditionalCreateReceipt>((database) => {
      const snapshot = fact.toSnapshot();
      const bindingFailure = authorityFenceBindingFailure(snapshot, fence);
      if (bindingFailure !== null) {
        return err(bindingFailure);
      }
      const chapter = readDevelopmentChapterAuthority(
        this.storage,
        fence.chapterId,
        snapshot.projectId,
        fence.expectedCurrentVersionId,
      );
      if (
        chapter?.status !== "active" ||
        chapter.currentVersionId !== fence.expectedCurrentVersionId
      ) {
        return err(
          new StoryCoreError({
            code: "STORY_FACT_SOURCE_FENCE_FAILED",
            message: "The chapter current version changed before the story fact was committed.",
          }),
        );
      }
      const source = snapshot.source;
      const supplementalIdentity = supplementalResolutionIdentity(snapshot);
      if (
        supplementalIdentity === null &&
        (source.kind !== "chapter_span" ||
          source.startOffset === null ||
          source.endOffset === null ||
          source.sourceLength === null ||
          source.excerpt === null ||
          chapter.versionContent.length !== source.sourceLength ||
          chapter.versionContent.slice(source.startOffset, source.endOffset) !== source.excerpt)
      ) {
        return err(
          new StoryCoreError({
            code: "REVIEW_SOURCE_CHANGED",
            message: "The cited chapter evidence no longer matches its version.",
            retryable: true,
            actions: ["OPEN_SOURCE", "RECOMPARE"],
          }),
        );
      }
      if ((fence.requiredCausalEventIds?.length ?? 0) > 0) {
        const counts = activeCausalEventIdCounts(database, snapshot.projectId);
        if (fence.requiredCausalEventIds?.some((eventId) => counts.get(eventId) !== 1)) {
          return err(
            new StoryCoreError({
              code: "STORY_FACT_RELATION_ENDPOINT_INVALID",
              message: "A causal relation endpoint is missing, duplicated, or no longer active.",
            }),
          );
        }
      }
      if ((fence.requiredCharacterIds?.length ?? 0) > 0) {
        const characterIdCounts = activeConfirmedCharacterIdCounts(database, snapshot.projectId);
        if (
          fence.requiredCharacterIds?.some(
            (characterId) => characterIdCounts.get(characterId) !== 1,
          )
        ) {
          return err(
            new StoryCoreError({
              code: "STORY_FACT_CHARACTER_AUTHORITY_INVALID",
              message:
                "A referenced character is missing, duplicated, or no longer an active confirmed formal fact.",
            }),
          );
        }
      }
      if (supplementalIdentity !== null) {
        const existingResolution = Object.values(database.facts).find((candidate) => {
          const identity = supplementalResolutionIdentity(candidate);
          return identity !== null && identity.key === supplementalIdentity.key;
        });
        if (existingResolution !== undefined) {
          const existingIdentity = supplementalResolutionIdentity(existingResolution);
          if (existingIdentity?.action === supplementalIdentity.action) {
            return ok(Object.freeze({ fact: requireFact(existingResolution), created: false }));
          }
          return err(
            new StoryCoreError({
              code: "STORY_FACT_IDEMPOTENCY_CONFLICT",
              message: "A supplemental finding already has a different active disposition.",
            }),
          );
        }
      }
      const existingSnapshot = Object.values(database.facts).find(
        (candidate) => isActiveFormalMainFact(candidate) && sameSubmission(candidate, snapshot),
      );
      if (existingSnapshot !== undefined) {
        return ok(Object.freeze({ fact: requireFact(existingSnapshot), created: false }));
      }
      if (
        database.facts[snapshot.id] !== undefined ||
        snapshot.revision !== 1 ||
        snapshot.status !== "formal" ||
        snapshot.origin !== "user" ||
        !hasSafeEntityAliasPayload(snapshot)
      ) {
        return err(storeFailure("Story fact already exists or has an invalid initial revision."));
      }
      database.facts[snapshot.id] = snapshot;
      database.revisions[snapshot.id] = Object.freeze([
        Object.freeze({
          changeKind: "created",
          recordedAt: snapshot.updatedAt,
          snapshot,
        }),
      ]);
      return ok(Object.freeze({ fact, created: true }));
    });
  }

  public deprecateSupplementalResolutionWithAuthorityFence(
    factId: UuidV7,
    fence: StoryFactSupplementalResolutionUndoFence,
  ): Promise<Result<StoryFactConditionalDeprecateReceipt, StoryCoreError>> {
    return this.mutate<StoryFactConditionalDeprecateReceipt>((database) => {
      const currentSnapshot = database.facts[factId];
      if (currentSnapshot === undefined) {
        return err(
          new StoryCoreError({
            code: "STORY_FACT_NOT_FOUND",
            message: "The supplemental finding disposition was not found.",
          }),
        );
      }
      const identity = supplementalResolutionMetadata(currentSnapshot);
      if (
        currentSnapshot.projectId !== fence.expectedProjectId ||
        identity?.chapterId !== fence.chapterId ||
        identity.chapterVersionId !== fence.expectedCurrentVersionId ||
        identity.findingId !== fence.findingId ||
        identity.evidenceSignature !== fence.evidenceSignature
      ) {
        return err(validationFailure("The supplemental finding undo identity is invalid."));
      }
      const chapter = readDevelopmentChapterAuthority(
        this.storage,
        fence.chapterId,
        fence.expectedProjectId,
        fence.expectedCurrentVersionId,
      );
      if (
        chapter?.status !== "active" ||
        chapter.currentVersionId !== fence.expectedCurrentVersionId
      ) {
        return err(
          new StoryCoreError({
            code: "STORY_FACT_SOURCE_FENCE_FAILED",
            message: "The chapter current version changed before the disposition was undone.",
            retryable: true,
          }),
        );
      }
      if (
        currentSnapshot.status === "deprecated" &&
        currentSnapshot.deprecated &&
        currentSnapshot.revision === fence.expectedRevision + 1
      ) {
        return ok(Object.freeze({ fact: requireFact(currentSnapshot), deprecated: false }));
      }
      if (
        currentSnapshot.status !== "formal" ||
        currentSnapshot.deprecated ||
        currentSnapshot.revision !== fence.expectedRevision
      ) {
        return err(revisionConflict(fence.expectedRevision, currentSnapshot.revision));
      }
      const current = requireFact(currentSnapshot);
      const deprecated = current.deprecate({
        humanConfirmed: true,
        expectedRevision: fence.expectedRevision,
        now: fence.now,
      });
      if (!deprecated.ok) return deprecated;
      const next = deprecated.value.toSnapshot();
      const revisions = database.revisions[factId] ?? [];
      if (revisions.length !== fence.expectedRevision) {
        return err(storeFailure("Story fact revision history is incomplete."));
      }
      database.facts[factId] = next;
      database.revisions[factId] = Object.freeze([
        ...revisions,
        Object.freeze({ changeKind: "deprecated", recordedAt: next.updatedAt, snapshot: next }),
      ]);
      return ok(Object.freeze({ fact: deprecated.value, deprecated: true }));
    });
  }

  public findById(id: UuidV7): Promise<Result<StoryFact | null, StoryCoreError>> {
    return this.readResult((database) => {
      const snapshot = database.facts[id];
      return snapshot === undefined ? null : requireFact(snapshot);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
    filter: StoryFactListFilter = {},
  ): Promise<Result<readonly StoryFact[], StoryCoreError>> {
    return this.readResult((database) => {
      const normalized = validateFilter(filter);
      return Object.freeze(
        Object.values(database.facts)
          .map(requireFact)
          .filter((fact) => {
            const snapshot = fact.toSnapshot();
            return (
              snapshot.projectId === projectId &&
              (normalized.status === undefined || snapshot.status === normalized.status) &&
              (normalized.factType === undefined || snapshot.factType === normalized.factType) &&
              (normalized.branchId === undefined || snapshot.branchId === normalized.branchId) &&
              (normalized.needsReview === undefined ||
                snapshot.needsReview === normalized.needsReview)
            );
          })
          .sort((left, right) => {
            const leftSnapshot = left.toSnapshot();
            const rightSnapshot = right.toSnapshot();
            return (
              rightSnapshot.updatedAt.localeCompare(leftSnapshot.updatedAt) ||
              leftSnapshot.factType.localeCompare(rightSnapshot.factType) ||
              leftSnapshot.id.localeCompare(rightSnapshot.id)
            );
          }),
      );
    });
  }

  public save(fact: StoryFact, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return this.mutate((database) => {
      const next = fact.toSnapshot();
      const currentSnapshot = database.facts[next.id];
      if (currentSnapshot === undefined) {
        return err(
          new StoryCoreError({
            code: "STORY_FACT_NOT_FOUND",
            message: "Story fact was not found.",
          }),
        );
      }
      const current = requireFact(currentSnapshot).toSnapshot();
      if (!hasSafeEntityAliasPayload(current) || !hasSafeEntityAliasPayload(next)) {
        return err(storeFailure("Story fact entity alias data is invalid."));
      }
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        return err(revisionConflict(expectedRevision, current.revision));
      }
      if (!sameImmutableFact(current, next) && !isEntityAliasResolutionMutation(current, next)) {
        return err(
          storeFailure("Story fact identity, content, and evidence cannot change in place."),
        );
      }
      const revisions = database.revisions[next.id] ?? [];
      if (revisions.length !== expectedRevision) {
        return err(storeFailure("Story fact revision history is incomplete."));
      }
      const changeKind = classifyChange(current, next);
      database.facts[next.id] = next;
      database.revisions[next.id] = Object.freeze([
        ...revisions,
        Object.freeze({ changeKind, recordedAt: next.updatedAt, snapshot: next }),
      ]);
      return ok(undefined);
    });
  }

  public listRevisions(
    factId: UuidV7,
  ): Promise<Result<readonly StoryFactRevision[], StoryCoreError>> {
    return this.readResult((database) =>
      Object.freeze(
        (database.revisions[factId] ?? []).map((revision, index) => {
          const fact = requireFact(revision.snapshot);
          if (
            fact.id !== factId ||
            fact.revision !== index + 1 ||
            fact.toSnapshot().updatedAt !== revision.recordedAt ||
            !STORY_FACT_REVISION_CHANGE_KINDS.includes(revision.changeKind)
          ) {
            throw corruptStore();
          }
          return Object.freeze({
            fact,
            changeKind: revision.changeKind,
            recordedAt: fact.toSnapshot().updatedAt,
          });
        }),
      ),
    );
  }

  public findContinuousStoryStateRouteReceipt(
    identity: ContinuousStoryStateRouteIdentity,
  ): Promise<Result<ContinuousStoryStateRouteReceipt | null, StoryCoreError>> {
    return this.readResult((database) => {
      requireContinuousRouteIdentity(identity);
      return database.routeReceipts[continuousRouteKey(identity)] ?? null;
    });
  }

  public commitContinuousStoryStateRoute(
    command: ContinuousStoryStateRouteCommit,
  ): Promise<Result<ContinuousStoryStateRouteCommitReceipt, StoryCoreError>> {
    return this.mutate<ContinuousStoryStateRouteCommitReceipt>((database) => {
      requireContinuousRouteCommit(command);
      const routeKey = continuousRouteKey(command);
      const existing = database.routeReceipts[routeKey];
      if (existing !== undefined) {
        return ok(
          Object.freeze({
            receipt: existing,
            facts: Object.freeze([]),
            retiredFactIds: Object.freeze([]),
            alreadyCommitted: true,
          }),
        );
      }
      const authority = readDevelopmentChapterAuthority(
        this.storage,
        command.chapterId,
        command.projectId,
        command.versionId,
      );
      if (
        authority?.status !== "active" ||
        authority.currentVersionId !== command.versionId ||
        authority.contentChecksum !== command.sourceContentHash
      ) {
        return err(continuousRouteSourceChanged());
      }
      for (const { fact } of command.facts) {
        const source = fact.toSnapshot().source;
        if (
          source.startOffset === null ||
          source.endOffset === null ||
          source.sourceLength !== authority.versionContent.length ||
          source.excerpt === null ||
          authority.versionContent.slice(source.startOffset, source.endOffset) !== source.excerpt
        ) {
          return err(
            new StoryCoreError({
              code: "REVIEW_SOURCE_CHANGED",
              message: "The cited chapter evidence no longer matches its immutable version.",
              retryable: true,
              actions: ["OPEN_SOURCE", "RECOMPARE"],
            }),
          );
        }
      }

      const replacementKeys = new Set(
        command.facts
          .filter(({ replacementKey }) => replacementKey !== null)
          .map(({ fact, replacementKey }) =>
            continuousReplacementIdentity(fact.toSnapshot().factType, replacementKey ?? ""),
          ),
      );
      const retiredFactIds: UuidV7[] = [];
      for (const [factId, snapshot] of Object.entries(database.facts)) {
        const replacementKey = readContinuousReplacementKey(snapshot);
        if (
          snapshot.projectId !== command.projectId ||
          replacementKey === null ||
          !replacementKeys.has(continuousReplacementIdentity(snapshot.factType, replacementKey)) ||
          snapshot.status !== "temporary" ||
          snapshot.origin !== "system" ||
          snapshot.userConfirmed ||
          snapshot.locked ||
          snapshot.deprecated ||
          snapshot.needsReview ||
          snapshot.branchId !== null
        ) {
          continue;
        }
        const current = requireFact(snapshot);
        const retired = current.deprecateAutomaticSystemProjection({
          expectedRevision: snapshot.revision,
          now: command.completedAt,
        });
        if (!retired.ok) {
          return retired;
        }
        const retiredSnapshot = retired.value.toSnapshot();
        const revisions = database.revisions[factId] ?? [];
        if (revisions.length !== snapshot.revision) {
          return err(storeFailure("Story fact revision history is incomplete."));
        }
        database.facts[factId] = retiredSnapshot;
        database.revisions[factId] = Object.freeze([
          ...revisions,
          Object.freeze({
            changeKind: "deprecated" as const,
            recordedAt: retiredSnapshot.updatedAt,
            snapshot: retiredSnapshot,
          }),
        ]);
        retiredFactIds.push(retiredSnapshot.id);
      }

      const committedFacts: StoryFact[] = [];
      for (const { fact } of command.facts) {
        const snapshot = fact.toSnapshot();
        if (database.facts[snapshot.id] !== undefined) {
          return err(storeFailure("Continuous story-state fact identity already exists."));
        }
        database.facts[snapshot.id] = snapshot;
        database.revisions[snapshot.id] = Object.freeze([
          Object.freeze({
            changeKind: "created" as const,
            recordedAt: snapshot.updatedAt,
            snapshot,
          }),
        ]);
        committedFacts.push(fact);
      }
      const receipt: ContinuousStoryStateRouteReceipt = Object.freeze({
        projectId: command.projectId,
        chapterId: command.chapterId,
        versionId: command.versionId,
        task: command.task,
        sourceContentHash: command.sourceContentHash,
        providerKind: command.providerKind,
        modelId: command.modelId,
        invocationId: command.invocationId,
        candidateCount: command.candidateCount,
        createdFactCount: committedFacts.length,
        retiredFactCount: retiredFactIds.length,
        completedAt: command.completedAt,
      });
      database.routeReceipts[routeKey] = receipt;
      return ok(
        Object.freeze({
          receipt,
          facts: Object.freeze(committedFacts),
          retiredFactIds: Object.freeze(retiredFactIds),
          alreadyCommitted: false,
        }),
      );
    });
  }

  private readResult<Value>(
    operation: (database: BrowserStoryFactDatabase) => Value,
  ): Promise<Result<Value, StoryCoreError>> {
    try {
      return Promise.resolve(ok(operation(this.read())));
    } catch (cause: unknown) {
      return Promise.resolve(err(normalizeFailure(cause)));
    }
  }

  private mutate<Value>(
    operation: (database: BrowserStoryFactDatabase) => Result<Value, StoryCoreError>,
  ): Promise<Result<Value, StoryCoreError>> {
    try {
      const database = this.read();
      const result = operation(database);
      if (result.ok) {
        this.storage.setItem(DEVELOPMENT_STORY_FACT_STORE_KEY, JSON.stringify(database));
      }
      return Promise.resolve(result);
    } catch (cause: unknown) {
      return Promise.resolve(err(normalizeFailure(cause)));
    }
  }

  private read(): BrowserStoryFactDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_STORY_FACT_STORE_KEY);
    if (serialized === null) {
      return { schemaVersion: 2, facts: {}, revisions: {}, routeReceipts: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isPlainObject(parsed) ||
        (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
        !isPlainObject(parsed.facts) ||
        !isPlainObject(parsed.revisions) ||
        (parsed.schemaVersion === 2 && !isPlainObject(parsed.routeReceipts)) ||
        hasProhibitedKey(parsed)
      ) {
        throw corruptStore();
      }
      const cloned = structuredClone(parsed);
      const database: BrowserStoryFactDatabase = {
        schemaVersion: 2,
        facts: cloned.facts as Record<string, StoryFactSnapshot>,
        revisions: cloned.revisions as Record<string, readonly StoredRevision[]>,
        routeReceipts:
          cloned.schemaVersion === 2
            ? (cloned.routeReceipts as Record<string, ContinuousStoryStateRouteReceipt>)
            : {},
      };
      for (const [factId, snapshot] of Object.entries(database.facts)) {
        const fact = requireFact(snapshot);
        const revisions = database.revisions[factId];
        if (
          fact.id !== factId ||
          !hasSafeEntityAliasPayload(fact.toSnapshot()) ||
          !Array.isArray(revisions) ||
          revisions.length !== fact.revision
        ) {
          throw corruptStore();
        }
        revisions.forEach((revision, index) => validateStoredRevision(revision, factId, index + 1));
        const latestRevision: unknown = revisions.at(-1);
        if (
          !isPlainObject(latestRevision) ||
          JSON.stringify(latestRevision.snapshot) !== JSON.stringify(snapshot)
        ) {
          throw corruptStore();
        }
      }
      for (const [factId, revisions] of Object.entries(database.revisions)) {
        if (!Array.isArray(revisions) || database.facts[factId] === undefined) {
          throw corruptStore();
        }
      }
      for (const [key, receipt] of Object.entries(database.routeReceipts)) {
        requireStoredContinuousRouteReceipt(receipt);
        if (key !== continuousRouteKey(receipt)) {
          throw corruptStore();
        }
      }
      return database;
    } catch (cause: unknown) {
      throw cause instanceof StoryCoreError ? cause : corruptStore();
    }
  }
}

function requireContinuousRouteIdentity(identity: ContinuousStoryStateRouteIdentity): void {
  if (
    !parseUuidV7(identity.projectId).ok ||
    !parseUuidV7(identity.chapterId).ok ||
    !parseUuidV7(identity.versionId).ok ||
    !CONTINUOUS_STORY_STATE_ROUTE_TASKS.includes(identity.task)
  ) {
    throw validationFailure("Continuous story-state route scope is invalid.");
  }
}

function requireContinuousRouteCommit(command: ContinuousStoryStateRouteCommit): void {
  requireContinuousRouteIdentity(command);
  if (
    !/^[a-f0-9]{64}$/u.test(command.sourceContentHash) ||
    !parseIsoUtcTimestamp(command.completedAt).ok ||
    !Number.isSafeInteger(command.candidateCount) ||
    command.candidateCount < 0 ||
    command.candidateCount > 128 ||
    command.facts.length > command.candidateCount
  ) {
    throw validationFailure("Continuous story-state route metadata is invalid.");
  }
  requireContinuousRouteText(command.providerKind, 100, "provider");
  requireContinuousRouteText(command.modelId, 500, "model");
  requireContinuousRouteText(command.invocationId, 500, "invocation");
  const expectedReference = `continuous-story-state:${command.task}:${command.versionId}:sha256:${command.sourceContentHash}`;
  const factIds = new Set<string>();
  const replacementKeys = new Set<string>();
  for (const candidate of command.facts) {
    const snapshot = candidate.fact.toSnapshot();
    if (
      factIds.has(snapshot.id) ||
      snapshot.revision !== 1 ||
      snapshot.projectId !== command.projectId ||
      snapshot.source.kind !== "chapter_span" ||
      snapshot.source.chapterId !== command.chapterId ||
      snapshot.source.versionId !== command.versionId ||
      snapshot.source.reference !== expectedReference
    ) {
      throw validationFailure("A continuous story-state fact has invalid route authority.");
    }
    factIds.add(snapshot.id);
    const storedReplacementKey = readContinuousReplacementKey(snapshot);
    if (candidate.replacementKey === null) {
      if (
        storedReplacementKey !== null ||
        snapshot.status !== "unconfirmed" ||
        snapshot.origin !== "ai_extraction" ||
        !snapshot.needsReview ||
        snapshot.userConfirmed ||
        snapshot.locked ||
        snapshot.deprecated ||
        snapshot.branchId !== null
      ) {
        throw validationFailure("A review-required story-state fact has invalid governance.");
      }
      continue;
    }
    requireContinuousRouteText(candidate.replacementKey, 500, "replacement key");
    const identity = continuousReplacementIdentity(snapshot.factType, candidate.replacementKey);
    if (
      replacementKeys.has(identity) ||
      storedReplacementKey !== candidate.replacementKey ||
      snapshot.status !== "temporary" ||
      snapshot.origin !== "system" ||
      snapshot.needsReview ||
      snapshot.userConfirmed ||
      snapshot.locked ||
      snapshot.deprecated ||
      snapshot.branchId !== null
    ) {
      throw validationFailure(
        "A disposable story-state projection has invalid replacement authority.",
      );
    }
    replacementKeys.add(identity);
  }
}

function requireStoredContinuousRouteReceipt(
  value: unknown,
): asserts value is ContinuousStoryStateRouteReceipt {
  if (!isPlainObject(value)) {
    throw corruptStore();
  }
  requireContinuousRouteIdentity(value as unknown as ContinuousStoryStateRouteIdentity);
  if (
    typeof value.sourceContentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceContentHash) ||
    typeof value.completedAt !== "string" ||
    !parseIsoUtcTimestamp(value.completedAt).ok ||
    typeof value.providerKind !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.invocationId !== "string" ||
    !Number.isSafeInteger(value.candidateCount) ||
    !Number.isSafeInteger(value.createdFactCount) ||
    !Number.isSafeInteger(value.retiredFactCount) ||
    (value.candidateCount as number) < 0 ||
    (value.candidateCount as number) > 128 ||
    (value.createdFactCount as number) < 0 ||
    (value.createdFactCount as number) > (value.candidateCount as number) ||
    (value.retiredFactCount as number) < 0
  ) {
    throw corruptStore();
  }
  requireContinuousRouteText(value.providerKind, 100, "provider");
  requireContinuousRouteText(value.modelId, 500, "model");
  requireContinuousRouteText(value.invocationId, 500, "invocation");
}

function requireContinuousRouteText(value: string, maximum: number, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw validationFailure(`Continuous story-state ${label} is invalid.`);
  }
}

function continuousRouteKey(identity: ContinuousStoryStateRouteIdentity): string {
  return JSON.stringify([
    identity.projectId,
    identity.chapterId,
    identity.versionId,
    identity.task,
  ]);
}

function readContinuousReplacementKey(snapshot: StoryFactSnapshot): string | null {
  if (!isPlainObject(snapshot.structuredValue)) {
    return null;
  }
  const root = snapshot.structuredValue;
  if (
    root.schemaVersion !== "inkshadow.rebuildable-system-fact.v1" &&
    root.schemaVersion !== "inkshadow.continuous-story-state.v2"
  ) {
    return null;
  }
  return typeof root.replacementKey === "string" ? root.replacementKey : null;
}

function continuousReplacementIdentity(factType: string, replacementKey: string): string {
  return `${factType}\u0000${replacementKey}`;
}

function continuousRouteSourceChanged(): StoryCoreError {
  return new StoryCoreError({
    code: "CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED",
    message: "The chapter version changed before the story-state route was committed.",
    retryable: true,
    actions: ["RETRY", "OPEN_SOURCE"],
  });
}

function validateStoredRevision(value: unknown, factId: string, revision: number): void {
  if (
    !isPlainObject(value) ||
    typeof value.changeKind !== "string" ||
    !STORY_FACT_REVISION_CHANGE_KINDS.includes(value.changeKind as StoryFactRevisionChangeKind) ||
    typeof value.recordedAt !== "string"
  ) {
    throw corruptStore();
  }
  const fact = requireFact(value.snapshot as StoryFactSnapshot);
  if (
    fact.id !== factId ||
    fact.revision !== revision ||
    fact.toSnapshot().updatedAt !== value.recordedAt
  ) {
    throw corruptStore();
  }
}

function requireFact(snapshot: StoryFactSnapshot): StoryFact {
  const result = StoryFact.rehydrate(snapshot);
  if (!result.ok) {
    throw corruptStore();
  }
  return result.value;
}

function validateFilter(filter: StoryFactListFilter): StoryFactListFilter {
  if (filter.status !== undefined && !STORY_FACT_STATUSES.includes(filter.status)) {
    throw validationFailure("Story fact status filter is invalid.");
  }
  const factType = filter.factType === undefined ? null : parseSafeIdentifier(filter.factType);
  if (factType !== null && !factType.ok) {
    throw factType.error;
  }
  const branchId =
    filter.branchId === undefined || filter.branchId === null ? null : parseUuidV7(filter.branchId);
  if (branchId !== null && !branchId.ok) {
    throw branchId.error;
  }
  if (filter.needsReview !== undefined && typeof filter.needsReview !== "boolean") {
    throw validationFailure("Story fact review filter must be a boolean.");
  }
  return Object.freeze({
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(factType === null ? {} : { factType: factType.value }),
    ...(filter.branchId === undefined
      ? {}
      : { branchId: branchId === null ? null : branchId.value }),
    ...(filter.needsReview === undefined ? {} : { needsReview: filter.needsReview }),
  });
}

function sameImmutableFact(left: StoryFactSnapshot, right: StoryFactSnapshot): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.factType === right.factType &&
    left.contentText === right.contentText &&
    JSON.stringify(left.structuredValue) === JSON.stringify(right.structuredValue) &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    left.effectiveAt === right.effectiveAt &&
    left.invalidatedAt === right.invalidatedAt &&
    left.branchId === right.branchId &&
    left.confidence === right.confidence &&
    left.origin === right.origin &&
    left.createdAt === right.createdAt
  );
}

function isEntityAliasResolutionMutation(
  current: StoryFactSnapshot,
  next: StoryFactSnapshot,
): boolean {
  if (
    (current.status !== "temporary" && current.status !== "unconfirmed") ||
    current.locked ||
    current.deprecated ||
    !isPlainObject(current.structuredValue) ||
    !hasSafeEntityAliasPayload(current) ||
    !hasSafeEntityAliasPayload(next)
  ) {
    return false;
  }
  const structuredValue: Record<string, unknown> = current.structuredValue;
  const subjectValue = structuredValue.subject;
  if (!isPlainObject(subjectValue)) {
    return false;
  }
  const subject: Record<string, unknown> = subjectValue;
  const matchedEntityKeysValue = subject.matchedEntityKeys;
  if (
    subject.mergeStatus !== "ambiguous_confirmed_alias" ||
    !isBoundedEntityKey(subject.entityKey) ||
    !isBoundedUniqueEntityKeyArray(matchedEntityKeysValue)
  ) {
    return false;
  }
  const matchedEntityKeys = matchedEntityKeysValue;
  const expectedSnapshot = (
    resolvedSubject: Readonly<Record<string, unknown>>,
  ): StoryFactSnapshot =>
    ({
      ...current,
      structuredValue: {
        ...structuredValue,
        subject: resolvedSubject,
      },
      revision: current.revision + 1,
      updatedAt: next.updatedAt,
    }) as StoryFactSnapshot;
  const separate = expectedSnapshot({
    ...subject,
    mergeStatus: "human_resolved_separate_entity",
  });
  if (JSON.stringify(next) === JSON.stringify(separate)) {
    return true;
  }
  return matchedEntityKeys.some((targetEntityKey) => {
    const existing = expectedSnapshot({
      ...subject,
      entityKey: targetEntityKey,
      mergeStatus: "human_resolved_existing_entity",
      matchedEntityKeys: [targetEntityKey],
    });
    return JSON.stringify(next) === JSON.stringify(existing);
  });
}

function classifyChange(
  current: StoryFactSnapshot,
  next: StoryFactSnapshot,
): StoryFactRevisionChangeKind {
  if (next.status === "formal" && current.status !== "formal") {
    return "confirmed";
  }
  if (next.status === "deprecated" && current.status !== "deprecated") {
    return "deprecated";
  }
  return "governance_updated";
}

function revisionConflict(expectedRevision: number, actualRevision: number): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REVISION_CONFLICT",
    message: "Story fact changed before it could be saved.",
    retryable: true,
    actions: ["RECOMPARE", "RETRY"],
    details: { expectedRevision, actualRevision },
  });
}

function validationFailure(message: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_VALIDATION_FAILED",
    message,
    actions: ["REVIEW_EVIDENCE"],
  });
}

function storeFailure(message: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}

function corruptStore(): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "Stored unified story facts failed integrity validation.",
    actions: ["CONTACT_SUPPORT"],
  });
}

function normalizeFailure(cause: unknown): StoryCoreError {
  return cause instanceof StoryCoreError ? cause : storeFailure("Unable to access story facts.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSafeEntityAliasPayload(snapshot: StoryFactSnapshot): boolean {
  const structuredValue = snapshot.structuredValue;
  if (structuredValue === null) {
    return true;
  }
  if (!isPlainObject(structuredValue) || hasProhibitedKey(structuredValue)) {
    return false;
  }
  const subject = structuredValue.subject;
  if (!isPlainObject(subject)) {
    return true;
  }
  const mergeStatus = subject.mergeStatus;
  if (
    mergeStatus !== "ambiguous_confirmed_alias" &&
    mergeStatus !== "human_resolved_existing_entity" &&
    mergeStatus !== "human_resolved_separate_entity"
  ) {
    return true;
  }
  if (
    !isBoundedEntityKey(subject.entityKey) ||
    !isBoundedUniqueEntityKeyArray(subject.matchedEntityKeys)
  ) {
    return false;
  }
  return (
    mergeStatus !== "human_resolved_existing_entity" ||
    (subject.matchedEntityKeys.length === 1 && subject.matchedEntityKeys[0] === subject.entityKey)
  );
}

function isBoundedEntityKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function isBoundedUniqueEntityKeyArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const values: readonly unknown[] = value;
  return (
    values.length >= 1 &&
    values.length <= 64 &&
    values.every(isBoundedEntityKey) &&
    new Set(values).size === values.length
  );
}

function hasProhibitedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasProhibitedKey);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      hasProhibitedKey(nested),
  );
}
