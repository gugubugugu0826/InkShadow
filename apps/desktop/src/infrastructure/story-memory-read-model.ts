import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import {
  createEvidenceRef,
  type EvidenceCurrentness,
  type EvidencePrivacy,
  type EvidenceRef,
  type EvidenceSourceKind,
  type StoryMemoryExclusion,
  type StoryMemoryExclusionReason,
  type StoryMemoryLayer,
  type StoryMemoryReadEntry,
  type StoryMemoryReadModel,
  type StoryMemoryReadRequest,
  type StoryMemoryReadResult,
  type StoryMemoryRetrievalScope,
} from "@inkshadow/ai-core";
import {
  PROJECT_SEED_FIELD_KEYS,
  parseUuidV7,
  type AppError,
  type AiCandidate,
  type Chapter,
  type ProjectSeedFieldKey,
  type ProjectSeedStore,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import {
  isRebuildableStoryFactType,
  parseUuidV7 as parseStoryUuidV7,
  type MemoryRecord,
  type MemoryRecordListReader,
  type StoryFact,
  type StoryFactSnapshot,
  type StoryFactStore,
} from "@inkshadow/story-core";

import {
  assembleStoryContextCandidates,
  type StoryContextFactDiscardReason,
} from "./story-context-source-adapter";
import {
  buildNarrativeStateReadView,
  normalizeStoryMemoryRetrievalScope,
  type NarrativeStateProjectionCandidate as DesktopNarrativeStateProjectionCandidate,
} from "./narrative-state-read-model";

export interface StoryMemoryCandidateReader {
  listByChapterId(chapterId: UuidV7): Promise<Result<readonly AiCandidate[], AppError>>;
}

export interface CompositeStoryMemoryReadModelDependencies {
  readonly chapters: Pick<ChapterRepository, "listByProjectId">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly facts: Pick<StoryFactStore, "listByProjectId">;
  readonly memoryRecords: Pick<MemoryRecordListReader, "listByProjectId">;
  readonly projectSeeds: Pick<ProjectSeedStore, "findByProjectId">;
  readonly hasher: ContentHasher;
  readonly candidates?: Pick<StoryMemoryCandidateReader, "listByChapterId">;
  readonly authorPreferences?: Readonly<{
    listByProjectId(projectId: string): Promise<
      readonly Readonly<{
        id: string;
        content: string;
        revision: number;
        updatedAt: string;
        enabled: boolean;
      }>[]
    >;
  }>;
}

export type StoryMemoryReadModelErrorCode =
  | "STORY_MEMORY_REQUEST_INVALID"
  | "STORY_MEMORY_SOURCE_UNAVAILABLE"
  | "STORY_MEMORY_DIGEST_UNAVAILABLE";

export class StoryMemoryReadModelError extends Error {
  public constructor(
    readonly code: StoryMemoryReadModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoryMemoryReadModelError";
  }
}

interface ChapterAuthority {
  readonly chapterId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly contentLength: number;
  readonly sourceCreatedAt: string;
  readonly privacy: EvidencePrivacy;
}

interface MutableProjection {
  readonly L0: StoryMemoryReadEntry[];
  readonly L1: StoryMemoryReadEntry[];
  readonly L2: StoryMemoryReadEntry[];
  readonly L3: StoryMemoryReadEntry[];
  readonly legacy: StoryMemoryReadEntry[];
  readonly advisory: StoryMemoryReadEntry[];
  readonly exclusions: StoryMemoryExclusion[];
  readonly projectCore: StoryMemoryReadEntry[];
  readonly authorPreferences: StoryMemoryReadEntry[];
  readonly narrativeCandidates: DesktopNarrativeStateProjectionCandidate[];
}

/**
 * Read-only composition over current chapter versions, StoryFact, ProjectSeed
 * and legacy MemoryRecord. It never writes a second fact or evidence store.
 */
export class CompositeStoryMemoryReadModel implements StoryMemoryReadModel {
  public constructor(private readonly dependencies: CompositeStoryMemoryReadModelDependencies) {}

  public async read(request: StoryMemoryReadRequest): Promise<StoryMemoryReadResult> {
    const projectId = parseUuidV7(request.projectId);
    const storyProjectId = parseStoryUuidV7(request.projectId);
    if (
      !projectId.ok ||
      !storyProjectId.ok ||
      !isCanonicalTimestamp(request.observedAt) ||
      !["local", "remote"].includes(request.destination) ||
      !validOptionalScope(request)
    ) {
      throw new StoryMemoryReadModelError(
        "STORY_MEMORY_REQUEST_INVALID",
        "Story memory read scope is invalid.",
      );
    }

    const [chaptersResult, factsResult, memoriesResult, seedRecord] = await Promise.all([
      this.dependencies.chapters.listByProjectId(projectId.value),
      this.dependencies.facts.listByProjectId(storyProjectId.value),
      this.dependencies.memoryRecords.listByProjectId(storyProjectId.value),
      this.dependencies.projectSeeds.findByProjectId(request.projectId),
    ]);
    if (!chaptersResult.ok || !factsResult.ok || !memoriesResult.ok) {
      throw new StoryMemoryReadModelError(
        "STORY_MEMORY_SOURCE_UNAVAILABLE",
        "One or more authoritative story-memory sources could not be read.",
      );
    }

    const projection: MutableProjection = {
      L0: [],
      L1: [],
      L2: [],
      L3: [],
      legacy: [],
      advisory: [],
      exclusions: [],
      projectCore: [],
      authorPreferences: [],
      narrativeCandidates: [],
    };
    const chapterAuthorities = new Map<string, ChapterAuthority>();
    await Promise.all(
      chaptersResult.value.map(async (chapter) => {
        const version = await this.dependencies.chapterVersions.findVersionById(
          chapter.currentVersionId,
        );
        if (!version.ok || version.value === null) {
          projection.exclusions.push(
            exclusion(chapter.id, "chapter", "L0", "source_unavailable", null),
          );
          return;
        }
        const snapshot = version.value.toSnapshot();
        const calculated = await this.digest(chapter.content);
        if (
          snapshot.projectId !== request.projectId ||
          snapshot.chapterId !== chapter.id ||
          snapshot.id !== chapter.currentVersionId ||
          snapshot.content !== chapter.content ||
          snapshot.contentChecksum !== calculated
        ) {
          projection.exclusions.push(exclusion(chapter.id, "chapter", "L0", "stale_version", null));
          return;
        }
        const privacy: EvidencePrivacy = chapter.isLocalOnly ? "local_only" : "standard";
        const authority: ChapterAuthority = Object.freeze({
          chapterId: chapter.id,
          versionId: snapshot.id,
          contentHash: calculated,
          contentLength: snapshot.content.length,
          sourceCreatedAt: snapshot.createdAt,
          privacy,
        });
        chapterAuthorities.set(chapter.id, authority);
        if (chapter.status !== "active") return;
        const evidence = this.chapterEvidence(authority, request);
        if (request.destination === "remote" && privacy === "local_only") {
          projection.exclusions.push(
            exclusion(chapter.id, "chapter", "L0", "private_remote_denied", evidence),
          );
          return;
        }
        projection.L0.push(
          entry({
            id: `chapter:${chapter.id}:${snapshot.id}`,
            layer: "L0",
            kind: "evidence",
            content: chapter.content,
            evidence: [evidence],
            rebuildable: false,
          }),
        );
      }),
    );

    await this.projectFacts(factsResult.value, chapterAuthorities, request, projection);
    await this.projectLegacyMemories(memoriesResult.value, chapterAuthorities, request, projection);
    if (seedRecord !== null) {
      await this.projectSeed(seedRecord, request, projection);
    }
    await this.projectAuthorPreferences(request, projection);
    await this.projectRejectedCandidates(chaptersResult.value, request, projection);

    return freezeProjection(resolveScope(request, chapterAuthorities), projection);
  }

  private async projectFacts(
    facts: readonly StoryFact[],
    chapterAuthorities: ReadonlyMap<string, ChapterAuthority>,
    request: StoryMemoryReadRequest,
    projection: MutableProjection,
  ): Promise<void> {
    const eligibleFacts: StoryFact[] = [];
    for (const fact of facts) {
      const snapshot = fact.toSnapshot();
      const evidence = await this.factEvidence(snapshot, chapterAuthorities, request);
      if (snapshot.source.kind === "chapter_span" && evidence.currentness === "stale") {
        projection.exclusions.push(
          exclusion(
            snapshot.id,
            "story_fact",
            intendedFactLayer(snapshot),
            "stale_version",
            evidence,
          ),
        );
        continue;
      }
      if (request.destination === "remote" && evidence.privacy === "local_only") {
        projection.exclusions.push(
          exclusion(
            snapshot.id,
            "story_fact",
            intendedFactLayer(snapshot),
            "private_remote_denied",
            evidence,
          ),
        );
        continue;
      }
      eligibleFacts.push(fact);
    }

    const versions = Object.fromEntries(
      [...chapterAuthorities.values()].map(({ chapterId, versionId, contentHash }) => [
        chapterId,
        Object.freeze({ versionId, contentHash }),
      ]),
    );
    const assembled = assembleStoryContextCandidates({
      projectId: request.projectId,
      currentBranchId: request.currentBranchId,
      currentTask: {
        id: `story-memory-read:${request.projectId}`,
        content: "Read the current governed story memory without changing it.",
        selectionReason: "The local read model requested a governed projection.",
        evidence: [
          {
            sourceType: "generation_task",
            sourceId: `story-memory-read:${request.projectId}`,
            sourceVersionId: null,
            locator: null,
            contentHash: null,
            excerpt: null,
          },
        ],
      },
      facts: eligibleFacts,
      currentChapterVersions: versions,
      currentPovCharacterId: request.currentPovCharacterId ?? null,
      currentNarrativeOrder: request.currentStoryOrder ?? null,
    });
    const included = new Set(assembled.includedFactIds);
    const discardById = new Map(assembled.discardedFacts.map((item) => [item.factId, item]));

    for (const fact of eligibleFacts) {
      const snapshot = fact.toSnapshot();
      const evidence = await this.factEvidence(snapshot, chapterAuthorities, request);
      if (included.has(snapshot.id)) {
        const readEntry = entry({
          id: `story-fact:${snapshot.id}:r${String(snapshot.revision)}`,
          layer: intendedFactLayer(snapshot),
          kind:
            snapshot.status === "formal"
              ? "confirmed_canon"
              : isRebuildableStoryFactType(snapshot.factType)
                ? "rebuildable_narrative_projection"
                : "advisory",
          content: factContent(snapshot),
          evidence: [evidence],
          rebuildable: snapshot.status !== "formal",
        });
        if (snapshot.status === "formal") {
          projection.L1.push(readEntry);
          projection.narrativeCandidates.push({
            snapshot,
            content: readEntry.content,
            evidence,
          });
          if (snapshot.locked) projection.projectCore.push(readEntry);
        } else if (isRebuildableStoryFactType(snapshot.factType)) projection.L2.push(readEntry);
        else {
          projection.advisory.push(entry({ ...readEntry, layer: null, kind: "advisory" }));
        }
        continue;
      }

      const discard = discardById.get(snapshot.id);
      const reason = mapFactDiscard(discard?.reason);
      projection.exclusions.push(
        exclusion(snapshot.id, "story_fact", intendedFactLayer(snapshot), reason, evidence),
      );
      if (reason === "unconfirmed") {
        const readEntry = entry({
          id: `story-fact:${snapshot.id}:r${String(snapshot.revision)}`,
          layer: null,
          kind: snapshot.origin === "legacy" ? "legacy_compatibility" : "advisory",
          content: factContent(snapshot),
          evidence: [evidence],
          rebuildable: false,
        });
        if (snapshot.origin === "legacy") projection.legacy.push(readEntry);
        else projection.advisory.push(readEntry);
      }
    }
  }

  private async projectLegacyMemories(
    memories: readonly MemoryRecord[],
    chapterAuthorities: ReadonlyMap<string, ChapterAuthority>,
    request: StoryMemoryReadRequest,
    projection: MutableProjection,
  ): Promise<void> {
    for (const memory of memories) {
      const snapshot = memory.toSnapshot();
      const authority =
        snapshot.source.kind === "chapter"
          ? chapterAuthorities.get(snapshot.source.sourceId)
          : undefined;
      const currentness: EvidenceCurrentness =
        snapshot.source.sourceVersionId === null ||
        authority?.versionId === snapshot.source.sourceVersionId
          ? "current"
          : "stale";
      const privacy = authority?.privacy ?? "standard";
      const digest = await this.digest(snapshot.content);
      const evidence = createEvidenceRef({
        projectId: request.projectId,
        chapterId: snapshot.source.kind === "chapter" ? snapshot.source.sourceId : null,
        immutableVersionId: snapshot.source.sourceVersionId,
        sourceKind: "legacy_memory",
        locator: {
          kind: "stable",
          value: `legacy-memory:${snapshot.id}:r${String(snapshot.revision)}`,
        },
        excerptDigest: digest,
        sourceCreatedAt: snapshot.createdAt,
        observedAt: request.observedAt,
        currentness,
        branchId: null,
        privacy,
      });
      const excludedReason: StoryMemoryExclusionReason | null =
        snapshot.status === "disabled"
          ? "disabled"
          : snapshot.excluded
            ? "excluded_by_user"
            : currentness === "stale"
              ? "stale_version"
              : request.destination === "remote" && privacy === "local_only"
                ? "private_remote_denied"
                : null;
      if (excludedReason !== null) {
        projection.exclusions.push(
          exclusion(snapshot.id, "legacy_memory", null, excludedReason, evidence),
        );
        continue;
      }
      projection.legacy.push(
        entry({
          id: `legacy-memory:${snapshot.id}:r${String(snapshot.revision)}`,
          layer: null,
          kind: "legacy_compatibility",
          content: snapshot.content,
          evidence: [evidence],
          rebuildable: false,
        }),
      );
    }
  }

  private async projectSeed(
    record: NonNullable<Awaited<ReturnType<ProjectSeedStore["findByProjectId"]>>>,
    request: StoryMemoryReadRequest,
    projection: MutableProjection,
  ): Promise<void> {
    for (const key of PROJECT_SEED_FIELD_KEYS) {
      const field = record.seed[key];
      if (field.values.length === 0 || field.confirmation === "skipped") continue;
      const content = renderProjectSeedField(key, field.values);
      const evidence = createEvidenceRef({
        projectId: request.projectId,
        chapterId: null,
        immutableVersionId: null,
        sourceKind: "project_seed",
        locator: { kind: "stable", value: `project-seed:${key}:r${String(record.revision)}` },
        excerptDigest: await this.digest(content),
        sourceCreatedAt: field.updatedAt,
        observedAt: request.observedAt,
        currentness: "current",
        branchId: null,
        privacy: "standard",
      });
      if (field.confirmation === "confirmed") {
        const coreEntry = entry({
          id: `project-seed:${request.projectId}:${key}:r${String(record.revision)}`,
          layer: "L3",
          kind: "confirmed_project_core",
          content,
          evidence: [evidence],
          rebuildable: false,
        });
        projection.L3.push(coreEntry);
        projection.projectCore.push(coreEntry);
      } else {
        projection.exclusions.push(
          exclusion(`project-seed:${key}`, "project_seed", "L3", "unconfirmed", evidence),
        );
        projection.advisory.push(
          entry({
            id: `project-seed:${request.projectId}:${key}:r${String(record.revision)}`,
            layer: null,
            kind: "advisory",
            content,
            evidence: [evidence],
            rebuildable: false,
          }),
        );
      }
    }
  }

  private async projectAuthorPreferences(
    request: StoryMemoryReadRequest,
    projection: MutableProjection,
  ): Promise<void> {
    const reader = this.dependencies.authorPreferences;
    if (reader === undefined) return;
    const preferences = await reader.listByProjectId(request.projectId);
    for (const preference of preferences) {
      if (!preference.enabled || preference.content.trim().length === 0) continue;
      const content = preference.content.trim();
      const evidence = createEvidenceRef({
        projectId: request.projectId,
        chapterId: null,
        immutableVersionId: null,
        sourceKind: "other",
        locator: {
          kind: "stable",
          value: `writing-preference:${preference.id}:r${String(preference.revision)}`,
        },
        excerptDigest: await this.digest(content),
        sourceCreatedAt: preference.updatedAt,
        observedAt: request.observedAt,
        currentness: "current",
        branchId: null,
        privacy: "standard",
      });
      projection.authorPreferences.push(
        entry({
          id: `writing-preference:${preference.id}:r${String(preference.revision)}`,
          layer: null,
          kind: "advisory",
          content,
          evidence: [evidence],
          rebuildable: false,
        }),
      );
    }
  }

  private async projectRejectedCandidates(
    chapters: readonly Chapter[],
    request: StoryMemoryReadRequest,
    projection: MutableProjection,
  ): Promise<void> {
    const candidates = this.dependencies.candidates;
    if (candidates === undefined) return;
    const results = await Promise.all(
      chapters.map((chapter) => candidates.listByChapterId(chapter.id).catch(() => null)),
    );
    for (const result of results) {
      if (!result?.ok) continue;
      for (const candidate of result.value) {
        const snapshot = candidate.toSnapshot();
        if (snapshot.projectId !== request.projectId || snapshot.status !== "rejected") continue;
        projection.exclusions.push(
          exclusion(snapshot.id, "candidate", null, "rejected_candidate", null),
        );
      }
    }
  }

  private chapterEvidence(
    authority: ChapterAuthority,
    request: StoryMemoryReadRequest,
  ): EvidenceRef {
    return createEvidenceRef({
      projectId: request.projectId,
      chapterId: authority.chapterId,
      immutableVersionId: authority.versionId,
      sourceKind: "chapter",
      locator:
        authority.contentLength === 0
          ? { kind: "stable", value: `chapter:${authority.chapterId}:empty` }
          : {
              kind: "utf16",
              startOffset: 0,
              endOffset: authority.contentLength,
              sourceLength: authority.contentLength,
            },
      excerptDigest: authority.contentHash,
      sourceCreatedAt: authority.sourceCreatedAt,
      observedAt: request.observedAt,
      currentness: "current",
      branchId: null,
      privacy: authority.privacy,
    });
  }

  private async factEvidence(
    snapshot: StoryFactSnapshot,
    chapterAuthorities: ReadonlyMap<string, ChapterAuthority>,
    request: StoryMemoryReadRequest,
  ): Promise<EvidenceRef> {
    const source = snapshot.source;
    const authority =
      source.chapterId === null ? undefined : chapterAuthorities.get(source.chapterId);
    const versionIsCurrent =
      source.kind !== "chapter_span" ||
      (authority !== undefined &&
        source.versionId !== null &&
        authority.versionId === source.versionId);
    const excerpt =
      source.excerpt ?? snapshot.contentText ?? canonicalValue(snapshot.structuredValue);
    const locator =
      source.kind === "chapter_span" &&
      source.startOffset !== null &&
      source.endOffset !== null &&
      source.sourceLength !== null &&
      source.endOffset > source.startOffset
        ? ({
            kind: "utf16",
            startOffset: source.startOffset,
            endOffset: source.endOffset,
            sourceLength: source.sourceLength,
          } as const)
        : ({ kind: "stable", value: source.reference } as const);
    return createEvidenceRef({
      projectId: request.projectId,
      chapterId: source.chapterId,
      immutableVersionId: source.versionId,
      sourceKind: source.kind === "chapter_span" ? "chapter" : "story_fact",
      locator,
      excerptDigest: await this.digest(excerpt.length === 0 ? snapshot.id : excerpt),
      sourceCreatedAt:
        source.kind === "chapter_span" && authority !== undefined
          ? authority.sourceCreatedAt
          : snapshot.createdAt,
      observedAt: request.observedAt,
      currentness: versionIsCurrent ? "current" : "stale",
      branchId: snapshot.branchId,
      privacy: authority?.privacy ?? "standard",
    });
  }

  private async digest(content: string): Promise<string> {
    const hashed = await this.dependencies.hasher.sha256(content);
    if (!hashed.ok) {
      throw new StoryMemoryReadModelError(
        "STORY_MEMORY_DIGEST_UNAVAILABLE",
        "Evidence digest calculation failed.",
      );
    }
    return hashed.value;
  }
}

function entry(input: StoryMemoryReadEntry): StoryMemoryReadEntry {
  return Object.freeze({
    ...input,
    evidence: Object.freeze([...input.evidence]),
  });
}

function exclusion(
  sourceId: string,
  sourceKind: EvidenceSourceKind,
  attemptedLayer: StoryMemoryLayer | null,
  reason: StoryMemoryExclusionReason,
  evidence: EvidenceRef | null,
): StoryMemoryExclusion {
  return Object.freeze({ sourceId, sourceKind, attemptedLayer, reason, evidence });
}

function intendedFactLayer(snapshot: StoryFactSnapshot): "L1" | "L2" | null {
  if (snapshot.status === "formal") return "L1";
  return isRebuildableStoryFactType(snapshot.factType) ? "L2" : null;
}

function mapFactDiscard(
  reason: StoryContextFactDiscardReason | undefined,
): StoryMemoryExclusionReason {
  switch (reason) {
    case "unconfirmed":
    case "formal_not_user_confirmed":
    case "branch_not_user_authored":
      return "unconfirmed";
    case "needs_review":
      return "needs_review";
    case "no_current_branch":
    case "other_branch":
      return "other_branch";
    case "deprecated":
    case "invalidated":
      return "deprecated";
    case "temporary":
      return "temporary_not_rebuildable";
    case "rebuildable_source_not_current":
    case "automatic_reversible_source_not_current":
      return "stale_version";
    default:
      return "source_unavailable";
  }
}

function factContent(snapshot: StoryFactSnapshot): string {
  if (snapshot.contentText !== null) return snapshot.contentText;
  return canonicalValue(snapshot.structuredValue);
}

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function renderProjectSeedField(key: ProjectSeedFieldKey, values: readonly string[]): string {
  return [`[ProjectSeed:${key}]`, ...values].join("\n");
}

function freezeProjection(
  scope: StoryMemoryRetrievalScope,
  projection: MutableProjection,
): StoryMemoryReadResult {
  const sortEntries = (values: StoryMemoryReadEntry[]): readonly StoryMemoryReadEntry[] =>
    Object.freeze([...values].sort((left, right) => left.id.localeCompare(right.id)));
  const exclusions = Object.freeze(
    [...projection.exclusions].sort((left, right) =>
      `${left.sourceKind}:${left.sourceId}:${left.reason}`.localeCompare(
        `${right.sourceKind}:${right.sourceId}:${right.reason}`,
      ),
    ),
  );
  const layers = Object.freeze({
    L0: sortEntries(projection.L0),
    L1: sortEntries(projection.L1),
    L2: sortEntries(projection.L2),
    L3: sortEntries(projection.L3),
  });
  const projectCore = sortEntries(projection.projectCore);
  const authorPreferences = sortEntries(projection.authorPreferences);
  const narrativeState = buildNarrativeStateReadView(scope, projection.narrativeCandidates);
  const retrievalCandidates = Object.freeze([
    ...layers.L3,
    ...layers.L1,
    ...layers.L2,
    ...layers.L0,
    ...authorPreferences,
  ]);
  const evidenceRefs = uniqueEvidenceRefs([
    ...retrievalCandidates.flatMap(({ evidence }) => evidence),
    ...exclusions.flatMap(({ evidence }) => (evidence === null ? [] : [evidence])),
  ]);
  const contextDecisionTrace = Object.freeze([
    ...retrievalCandidates.map((candidate) =>
      Object.freeze({
        sourceId: candidate.id,
        included: true,
        layer: candidate.layer,
        reason:
          candidate.kind === "rebuildable_narrative_projection"
            ? ("included_projection" as const)
            : candidate.kind === "legacy_compatibility"
              ? ("included_legacy_compatibility" as const)
              : candidate.kind === "advisory"
                ? ("included_author_preference" as const)
                : ("included_authority" as const),
        evidenceRefCount: candidate.evidence.length,
      }),
    ),
    ...exclusions.map((excluded) =>
      Object.freeze({
        sourceId: excluded.sourceId,
        included: false,
        layer: excluded.attemptedLayer,
        reason: decisionReason(excluded.reason),
        evidenceRefCount: excluded.evidence === null ? 0 : 1,
      }),
    ),
    ...narrativeState.omissions
      .filter(({ sourceId }) => sourceId === null)
      .map((omission) =>
        Object.freeze({
          sourceId: `scope:${omission.reason}`,
          included: false,
          layer: null,
          reason: "insufficient_scope" as const,
          evidenceRefCount: 0,
        }),
      ),
  ]);
  const missingRequirements = Object.freeze(
    narrativeState.omissions
      .filter(({ sourceId }) => sourceId === null)
      .map(({ reason }) => reason),
  );
  return Object.freeze({
    projectId: scope.projectId,
    observedAt: scope.observedAt,
    scope,
    layers,
    legacy: sortEntries(projection.legacy),
    advisory: sortEntries(projection.advisory),
    exclusions,
    projectCore,
    canonFacts: layers.L1,
    narrativeState,
    authorPreferences,
    evidenceRefs,
    retrievalCandidates,
    contextDecisionTrace,
    activeTaskState: Object.freeze({
      taskType: scope.taskType,
      status: missingRequirements.length === 0 ? "ready" : "insufficient_evidence",
      missingRequirements,
    }),
  });
}

function resolveScope(
  request: StoryMemoryReadRequest,
  authorities: ReadonlyMap<string, ChapterAuthority>,
): StoryMemoryRetrievalScope {
  const normalized = normalizeStoryMemoryRetrievalScope(request);
  if (normalized.currentChapterId === null) return normalized;
  const authority = authorities.get(normalized.currentChapterId);
  if (
    authority === undefined ||
    normalized.currentImmutableVersionId === null ||
    authority.versionId !== normalized.currentImmutableVersionId
  ) {
    return Object.freeze({
      ...normalized,
      currentImmutableVersionId: null,
    });
  }
  return normalized;
}

function validOptionalScope(request: StoryMemoryReadRequest): boolean {
  const references = [
    request.currentChapterId,
    request.currentImmutableVersionId,
    request.currentPovCharacterId,
  ];
  return (
    references.every(
      (value) =>
        value === undefined ||
        value === null ||
        (typeof value === "string" &&
          value.length > 0 &&
          value.length <= 512 &&
          value.trim() === value),
    ) &&
    (request.currentStoryOrder === undefined ||
      request.currentStoryOrder === null ||
      (Number.isSafeInteger(request.currentStoryOrder) && request.currentStoryOrder >= 0)) &&
    (request.authorityRevision === undefined ||
      request.authorityRevision === null ||
      (Number.isSafeInteger(request.authorityRevision) && request.authorityRevision >= 0)) &&
    (request.taskType === undefined ||
      [
        "continuation",
        "consistency_investigation",
        "character_voice",
        "pov",
        "pacing",
        "overall_review",
        "other",
      ].includes(request.taskType))
  );
}

function uniqueEvidenceRefs(values: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const byIdentity = new Map<string, EvidenceRef>();
  for (const value of values) {
    const identity = JSON.stringify([
      value.projectId,
      value.chapterId,
      value.immutableVersionId,
      value.sourceKind,
      value.locator,
      value.excerptDigest,
      value.branchId,
      value.privacy,
      value.currentness,
    ]);
    if (!byIdentity.has(identity)) byIdentity.set(identity, value);
  }
  return Object.freeze([...byIdentity.values()]);
}

function decisionReason(reason: StoryMemoryExclusionReason) {
  switch (reason) {
    case "unconfirmed":
    case "needs_review":
    case "temporary_not_rebuildable":
      return "excluded_unconfirmed" as const;
    case "stale_version":
    case "source_unavailable":
      return "excluded_stale" as const;
    case "other_branch":
      return "excluded_branch" as const;
    case "private_remote_denied":
      return "excluded_privacy" as const;
    case "rejected_candidate":
      return "excluded_rejected_candidate" as const;
    default:
      return "excluded_other" as const;
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
