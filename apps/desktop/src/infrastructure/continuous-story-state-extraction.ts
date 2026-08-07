import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  StoryCoreError,
  err,
  parseUuidV7 as parseStoryUuid,
  storyFactUpdatePolicy,
  type Result,
  type StoryFact,
  type StoryFactApplicationService,
  type StoryFactStore,
  type StoryValue,
  type UuidV7Generator,
} from "@inkshadow/story-core";

export const CONTINUOUS_STORY_STATE_TASKS = ["character_extraction", "world_extraction"] as const;
export type ContinuousStoryStateTask = (typeof CONTINUOUS_STORY_STATE_TASKS)[number];

export const CONTINUOUS_STORY_FACT_TYPES = [
  "character_identity",
  "character_state",
  "relationship_change",
  "pov_knowledge",
  "character_voice",
  "world_setting",
  "world_rule",
  "timeline_event",
  "foreshadow_status",
  "plotline_state",
  "pacing_metric",
] as const;
export type ContinuousStoryFactType = (typeof CONTINUOUS_STORY_FACT_TYPES)[number];

export const KNOWLEDGE_STATES = ["known", "unknown", "suspected", "false_belief"] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

export const CONTINUOUS_STORY_STATE_SCHEMA = "inkshadow.continuous-story-state.v2" as const;

export const CONTINUOUS_VALIDATION_FACT_TYPES = [
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
export type ContinuousValidationFactType = (typeof CONTINUOUS_VALIDATION_FACT_TYPES)[number];

export interface ContinuousEffectiveRange {
  readonly startOrder: number;
  readonly endOrder: number | null;
}

export interface ContinuousValidationProjection {
  readonly factType: ContinuousValidationFactType;
  /** Null binds to the evidence-backed merged subject key during staging. */
  readonly subjectId: string | null;
  readonly attributeKey: string;
  readonly value: string | number | boolean;
  readonly effectiveRange: ContinuousEffectiveRange;
}

export interface ContinuousPovProjection {
  /** Null binds to the evidence-backed merged character key during staging. */
  readonly characterId: string | null;
  readonly attributeKey: string;
  readonly knowledgeStatus: KnowledgeState;
  readonly effectiveRange: ContinuousEffectiveRange;
  readonly mode: "first_person" | "third_person_limited";
}

export interface ContinuousVoiceFeatureCatalog {
  readonly commonTermCandidates: readonly string[];
  readonly emotionMarkers: readonly string[];
  readonly politeMarkers: readonly string[];
  readonly casualMarkers: readonly string[];
  readonly directMarkers: readonly string[];
  readonly indirectMarkers: readonly string[];
  readonly metaphorMarkers: readonly string[];
  readonly dialectMarkers: readonly string[];
  readonly addressTerms: readonly Readonly<{
    readonly addresseeCharacterId: string;
    readonly terms: readonly string[];
  }>[];
}

export interface ContinuousVoiceDialogueProjection {
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly addresseeCharacterId: string | null;
  readonly typical: boolean;
}

export interface ContinuousVoiceProjection {
  /** Null binds to the evidence-backed merged character key during staging. */
  readonly characterId: string | null;
  readonly featureCatalog: ContinuousVoiceFeatureCatalog;
  readonly dialogues: readonly ContinuousVoiceDialogueProjection[];
}

export interface ContinuousNarrativeSceneProjection {
  readonly sceneId: string;
  readonly sequence: number;
  readonly goal: string;
  readonly conflictIntensity: number;
  readonly tension: Readonly<{
    readonly start: number;
    readonly end: number;
    readonly peak: number;
  }>;
  readonly composition: Readonly<{
    readonly informationRatio: number;
    readonly dialogueRatio: number;
    readonly descriptionRatio: number;
    readonly innerActivityRatio: number;
    readonly measuredUnits: number;
  }>;
  readonly plotlineIds: readonly string[];
  readonly characterIds: readonly string[];
  readonly movesPlot: boolean;
  readonly changesCharacter: boolean;
  readonly functionTags: readonly string[];
  readonly setupBeatIds: readonly string[];
  readonly climax: Readonly<{
    readonly isClimax: boolean;
    readonly requiredSetupBeatIds: readonly string[];
  }>;
}

export interface ContinuousNarrativePlotlineProjection {
  /** Null binds to the evidence-backed merged plotline key during staging. */
  readonly plotlineId: string | null;
  readonly goal: string;
  readonly characterIds: readonly string[];
  readonly progress: Readonly<{
    readonly sequence: number;
    readonly eventId: string;
    readonly summary: string;
  }> | null;
}

export interface ContinuousNarrativeProjection {
  readonly chapterOrder: number;
  readonly scene: ContinuousNarrativeSceneProjection | null;
  readonly plotline: ContinuousNarrativePlotlineProjection | null;
}

export interface ContinuousStoryStateProjection {
  readonly validation: ContinuousValidationProjection | null;
  readonly pov: ContinuousPovProjection | null;
  readonly voice: ContinuousVoiceProjection | null;
  readonly narrative: ContinuousNarrativeProjection | null;
}

export type StoryEntityKind = "character" | "foreshadow" | "plotline" | "world" | "event";

export interface ContinuousStoryStateModelSubject {
  readonly kind: StoryEntityKind;
  readonly entityKey: string | null;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
}

export interface ContinuousStoryStateModelCandidate {
  readonly factType: ContinuousStoryFactType;
  readonly contentText: string;
  readonly confidence: number;
  readonly subject: ContinuousStoryStateModelSubject | null;
  readonly state: Readonly<Record<string, StoryValue>>;
  readonly evidence: Readonly<{
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  }>;
  readonly effectiveAt: string | null;
  readonly invalidatedAt: string | null;
  readonly projection?: ContinuousStoryStateProjection | null;
}

export interface ContinuousStoryStateModelInput {
  readonly task: ContinuousStoryStateTask;
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly contentChecksum: string;
  readonly content: string;
  readonly knownEntities: readonly ContinuousStoryStateKnownEntity[];
}

export interface ContinuousStoryStateKnownEntity {
  readonly kind: StoryEntityKind;
  readonly entityKey: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
}

export interface ContinuousStoryStateModelOutput {
  readonly candidates: readonly ContinuousStoryStateModelCandidate[];
  readonly providerKind: string;
  readonly modelId: string;
  readonly invocationId: string;
}

export interface ContinuousStoryStateModelPort {
  extract(input: ContinuousStoryStateModelInput): Promise<ContinuousStoryStateModelOutput>;
}

export class ContinuousStoryStateModelUnavailableError extends Error {
  public override readonly name = "ContinuousStoryStateModelUnavailableError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ContinuousStoryStateExtractionReceipt {
  readonly status: "completed" | "partially_completed" | "skipped" | "already_processed";
  readonly detectedCount: number;
  readonly needsConfirmationCount: number;
  readonly reversibleCount: number;
  readonly skippedTasks: readonly Readonly<{ task: ContinuousStoryStateTask; code: string }>[];
  readonly providerInvocations: readonly Readonly<{
    task: ContinuousStoryStateTask;
    providerKind: string;
    modelId: string;
    invocationId: string;
  }>[];
}

export interface ContinuousStoryStateChange {
  readonly fact: StoryFact;
  readonly evidenceState: "current" | "historical" | "invalid";
  readonly evidenceMessage: string;
}

export interface ContinuousStoryStateDashboard {
  readonly changes: readonly ContinuousStoryStateChange[];
  readonly detectedCount: number;
  readonly needsConfirmationCount: number;
  readonly reversibleCount: number;
  readonly historicalCount: number;
  readonly invalidEvidenceCount: number;
}

export interface ContinuousStoryStatePreferenceStore {
  isContinuousStoryStateOnManualSaveEnabled(projectId: string): boolean;
  setContinuousStoryStateOnManualSaveEnabled(projectId: string, enabled: boolean): void;
}

interface ContinuousStoryStateExtractionDependencies {
  readonly chapters: Pick<ChapterRepository, "findById">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly facts: StoryFactStore;
  readonly factService: Pick<
    StoryFactApplicationService,
    "stageAutomaticFact" | "replaceRebuildableSystemFact" | "confirm"
  >;
  readonly model: ContinuousStoryStateModelPort;
  readonly hasher: ContentHasher;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly preferences: ContinuousStoryStatePreferenceStore;
}

const REFERENCE_PREFIX = "continuous-story-state";
const MAXIMUM_CANDIDATES_PER_TASK = 128;

/** Automatic persistence must never silently incur provider work or cost. */
export function shouldRunContinuousStoryStateExtraction(
  reason: "autosave" | "manual",
  automaticOnManualSaveEnabled: boolean,
): boolean {
  return reason === "manual" && automaticOnManualSaveEnabled;
}

/**
 * Turns an immutable, successfully saved chapter version into reviewable story
 * state candidates. It never edits chapter text and never promotes a model
 * result into a formal fact.
 */
export class ContinuousStoryStateExtractionService {
  private readonly processedRouteKeys = new Set<string>();
  private readonly inFlight = new Map<string, Promise<ContinuousStoryStateExtractionReceipt>>();

  public constructor(private readonly dependencies: ContinuousStoryStateExtractionDependencies) {}

  public isAutomaticOnManualSaveEnabled(projectId: string): boolean {
    return this.dependencies.preferences.isContinuousStoryStateOnManualSaveEnabled(projectId);
  }

  public setAutomaticOnManualSaveEnabled(projectId: string, enabled: boolean): void {
    this.dependencies.preferences.setContinuousStoryStateOnManualSaveEnabled(projectId, enabled);
  }

  public extractAfterSave(input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly reason: "autosave" | "manual";
  }): Promise<ContinuousStoryStateExtractionReceipt | null> {
    if (
      !shouldRunContinuousStoryStateExtraction(
        input.reason,
        this.dependencies.preferences.isContinuousStoryStateOnManualSaveEnabled(input.projectId),
      )
    ) {
      return Promise.resolve(null);
    }
    return this.extractSavedVersion(input);
  }

  public extractSavedVersion(input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly force?: boolean;
  }): Promise<ContinuousStoryStateExtractionReceipt> {
    const routeKey = `${input.projectId}:${input.chapterId}:${input.versionId}`;
    const running = this.inFlight.get(routeKey);
    if (running !== undefined) {
      return running;
    }
    const extraction = this.extractSavedVersionOnce(input).finally(() => {
      this.inFlight.delete(routeKey);
    });
    this.inFlight.set(routeKey, extraction);
    return extraction;
  }

  public async inspectProject(projectIdValue: string): Promise<ContinuousStoryStateDashboard> {
    const projectId = parseStoryUuid(projectIdValue);
    if (!projectId.ok) {
      throw projectId.error;
    }
    const listed = await this.dependencies.facts.listByProjectId(projectId.value);
    if (!listed.ok) {
      throw listed.error;
    }
    const candidates = listed.value.filter((fact) => {
      const snapshot = fact.toSnapshot();
      return (
        !snapshot.deprecated &&
        (snapshot.status === "temporary" || snapshot.status === "unconfirmed") &&
        snapshot.source.kind === "chapter_span" &&
        snapshot.source.reference.startsWith(`${REFERENCE_PREFIX}:`)
      );
    });
    const changes = await Promise.all(
      candidates.map(async (fact): Promise<ContinuousStoryStateChange> => {
        const evidence = await this.inspectEvidence(fact);
        return Object.freeze({ fact, ...evidence });
      }),
    );
    return Object.freeze({
      changes: Object.freeze(changes),
      detectedCount: changes.length,
      needsConfirmationCount: changes.filter(({ fact }) => fact.toSnapshot().needsReview).length,
      reversibleCount: changes.filter(
        ({ fact }) =>
          storyFactUpdatePolicy(fact.toSnapshot().factType) !== "human_confirmation_required",
      ).length,
      historicalCount: changes.filter(({ evidenceState }) => evidenceState === "historical").length,
      invalidEvidenceCount: changes.filter(({ evidenceState }) => evidenceState === "invalid")
        .length,
    });
  }

  /** Confirmation fails closed when the exact saved-version evidence is stale or corrupt. */
  public async confirmChange(input: {
    readonly factId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly lock?: boolean;
    readonly humanConfirmed: boolean;
  }): Promise<Result<StoryFact, StoryCoreError>> {
    const factId = parseStoryUuid(input.factId);
    if (!factId.ok) {
      return factId;
    }
    const loaded = await this.dependencies.facts.findById(factId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new StoryCoreError({
          code: "STORY_FACT_NOT_FOUND",
          message: "The story-state change no longer exists.",
        }),
      );
    }
    const evidence = await this.inspectEvidence(loaded.value);
    if (evidence.evidenceState !== "current") {
      return err(
        new StoryCoreError({
          code:
            evidence.evidenceState === "historical"
              ? "EXTRACTION_SOURCE_CHANGED"
              : "STORY_EVIDENCE_RANGE_INVALID",
          message: evidence.evidenceMessage,
          actions: ["OPEN_SOURCE", "REVIEW_EVIDENCE"],
        }),
      );
    }
    return this.dependencies.factService.confirm(input);
  }

  private async extractSavedVersionOnce(input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly force?: boolean;
  }): Promise<ContinuousStoryStateExtractionReceipt> {
    const projectId = requireStoryUuid(input.projectId, "Project identity is invalid.");
    requireDomainUuid(input.chapterId, "Chapter identity is invalid.");
    const versionId = requireDomainUuid(input.versionId, "Chapter version identity is invalid.");
    const versionResult = await this.dependencies.chapterVersions.findVersionById(versionId);
    if (!versionResult.ok) {
      throw extractionError("STORY_STATE_VERSION_READ_FAILED", versionResult.error.message);
    }
    if (versionResult.value === null) {
      throw extractionError(
        "STORY_STATE_VERSION_NOT_FOUND",
        "The saved chapter version no longer exists.",
      );
    }
    const version = versionResult.value;
    const snapshot = version.toSnapshot();
    if (
      snapshot.projectId !== input.projectId ||
      snapshot.chapterId !== input.chapterId ||
      snapshot.id !== input.versionId
    ) {
      throw extractionError(
        "STORY_STATE_VERSION_SCOPE_MISMATCH",
        "The saved chapter version does not belong to the requested project and chapter.",
      );
    }
    const checksum = await this.dependencies.hasher.sha256(snapshot.content);
    if (!checksum.ok || checksum.value !== snapshot.contentChecksum) {
      throw extractionError(
        "STORY_STATE_VERSION_INTEGRITY_FAILED",
        "The saved chapter version failed its content checksum verification.",
      );
    }
    if (snapshot.content.trim().length === 0) {
      return emptyReceipt(
        "skipped",
        CONTINUOUS_STORY_STATE_TASKS.map((task) => ({
          task,
          code: "EMPTY_CHAPTER",
        })),
      );
    }

    const listed = await this.dependencies.facts.listByProjectId(projectId);
    if (!listed.ok) {
      throw listed.error;
    }
    const knownEntities = buildKnownEntityRegistry(listed.value);
    const stagedFacts: StoryFact[] = [];
    const skippedTasks: { task: ContinuousStoryStateTask; code: string }[] = [];
    const providerInvocations: {
      task: ContinuousStoryStateTask;
      providerKind: string;
      modelId: string;
      invocationId: string;
    }[] = [];
    let completedTaskCount = 0;
    let alreadyProcessedCount = 0;

    for (const task of CONTINUOUS_STORY_STATE_TASKS) {
      const taskKey = `${task}:${snapshot.id}`;
      const existingFingerprints = new Set(
        listed.value
          .filter((fact) => isFactFromTaskAndVersion(fact, task, snapshot.id))
          .map(factFingerprint),
      );
      if (input.force !== true && this.processedRouteKeys.has(taskKey)) {
        alreadyProcessedCount += 1;
        continue;
      }
      let output: ContinuousStoryStateModelOutput;
      try {
        output = await this.dependencies.model.extract({
          task,
          projectId: input.projectId,
          chapterId: input.chapterId,
          versionId: input.versionId,
          contentChecksum: checksum.value,
          content: snapshot.content,
          knownEntities,
        });
      } catch (cause: unknown) {
        if (cause instanceof ContinuousStoryStateModelUnavailableError) {
          skippedTasks.push({ task, code: cause.code });
          continue;
        }
        throw cause;
      }
      if (output.candidates.length > MAXIMUM_CANDIDATES_PER_TASK) {
        throw extractionError(
          "STORY_STATE_RESPONSE_TOO_LARGE",
          "The model returned too many story-state candidates for one saved version.",
        );
      }
      completedTaskCount += 1;
      providerInvocations.push({
        task,
        providerKind: output.providerKind,
        modelId: output.modelId,
        invocationId: output.invocationId,
      });
      const seen = new Set<string>();
      for (const candidate of output.candidates) {
        assertTaskAllowsFactType(task, candidate.factType);
        assertExactEvidence(snapshot.content, candidate.evidence);
        const merged = mergeCandidateEntity(candidate, knownEntities, snapshot.id);
        const fingerprint = modelCandidateFingerprint(candidate, merged.entityKey);
        if (seen.has(fingerprint) || existingFingerprints.has(fingerprint)) {
          continue;
        }
        seen.add(fingerprint);
        const reference = evidenceReference(task, snapshot.id, checksum.value);
        const boundProjection = bindProjection(candidate.projection ?? null, merged, knownEntities);
        const structuredValue = {
          schemaVersion: CONTINUOUS_STORY_STATE_SCHEMA,
          subject: merged,
          payload: candidate.state,
          // The story-value boundary intentionally caps object nesting at five
          // levels. Keep the validated optional projection as inert JSON and
          // parse it again in the strict read-only projection adapter.
          projectionJson:
            boundProjection.projection === null ? null : JSON.stringify(boundProjection.projection),
          projectionIssues: boundProjection.issues,
          extraction: {
            task,
            providerKind: output.providerKind,
            modelId: output.modelId,
            invocationId: output.invocationId,
          },
        };
        const source = {
          kind: "chapter_span" as const,
          reference,
          chapterId: input.chapterId,
          versionId: input.versionId,
          startOffset: candidate.evidence.start,
          endOffset: candidate.evidence.end,
          sourceLength: snapshot.content.length,
          excerpt: candidate.evidence.excerpt,
        };
        const policy = storyFactUpdatePolicy(candidate.factType);
        const staged =
          policy === "rebuildable_automatic"
            ? await this.dependencies.factService.replaceRebuildableSystemFact({
                projectId: input.projectId,
                factType: candidate.factType,
                replacementKey: rebuildableReplacementKey(input.chapterId, candidate),
                contentText: candidate.contentText,
                payload: structuredValue,
                source,
                effectiveAt: candidate.effectiveAt,
                invalidatedAt: candidate.invalidatedAt,
                confidence: candidate.confidence,
              })
            : await this.dependencies.factService.stageAutomaticFact({
                projectId: input.projectId,
                factType: candidate.factType,
                contentText: candidate.contentText,
                structuredValue,
                source,
                effectiveAt: candidate.effectiveAt,
                invalidatedAt: candidate.invalidatedAt,
                confidence: candidate.confidence,
                // Reversible facts are transparent system projections of exact AI
                // extraction evidence. Critical facts remain AI-origin review items.
                origin: policy === "automatic_reversible" ? "system" : "ai_extraction",
              });
        if (!staged.ok) {
          throw staged.error;
        }
        stagedFacts.push(staged.value.fact);
      }
      this.processedRouteKeys.add(taskKey);
    }

    const status =
      completedTaskCount === CONTINUOUS_STORY_STATE_TASKS.length
        ? "completed"
        : completedTaskCount > 0
          ? "partially_completed"
          : alreadyProcessedCount === CONTINUOUS_STORY_STATE_TASKS.length
            ? "already_processed"
            : "skipped";
    return Object.freeze({
      status,
      detectedCount: stagedFacts.length,
      needsConfirmationCount: stagedFacts.filter(
        ({ status: factStatus }) => factStatus === "unconfirmed",
      ).length,
      reversibleCount: stagedFacts.filter(
        (fact) =>
          storyFactUpdatePolicy(fact.toSnapshot().factType) !== "human_confirmation_required",
      ).length,
      skippedTasks: Object.freeze(skippedTasks),
      providerInvocations: Object.freeze(providerInvocations),
    });
  }

  private async inspectEvidence(fact: StoryFact): Promise<{
    readonly evidenceState: "current" | "historical" | "invalid";
    readonly evidenceMessage: string;
  }> {
    const source = fact.toSnapshot().source;
    if (
      source.kind !== "chapter_span" ||
      source.chapterId === null ||
      source.versionId === null ||
      source.startOffset === null ||
      source.endOffset === null ||
      source.sourceLength === null ||
      source.excerpt === null
    ) {
      return {
        evidenceState: "invalid",
        evidenceMessage: "这项变化没有完整的章节版本证据，不能确认。",
      };
    }
    const domainChapterId = parseDomainUuid(source.chapterId);
    const domainVersionId = parseDomainUuid(source.versionId);
    if (!domainChapterId.ok || !domainVersionId.ok) {
      return {
        evidenceState: "invalid",
        evidenceMessage: "这项变化的章节或版本编号无效，不能确认。",
      };
    }
    const [chapter, version] = await Promise.all([
      this.dependencies.chapters.findById(domainChapterId.value),
      this.dependencies.chapterVersions.findVersionById(domainVersionId.value),
    ]);
    if (!chapter.ok || !version.ok || chapter.value === null || version.value === null) {
      return {
        evidenceState: "invalid",
        evidenceMessage: "找不到这项变化引用的原始章节版本，不能确认。",
      };
    }
    const versionSnapshot = version.value.toSnapshot();
    const expectedChecksum = readChecksumFromReference(source.reference);
    const actualChecksum = await this.dependencies.hasher.sha256(versionSnapshot.content);
    const valid =
      actualChecksum.ok &&
      actualChecksum.value === versionSnapshot.contentChecksum &&
      expectedChecksum === actualChecksum.value &&
      String(versionSnapshot.projectId) === String(fact.toSnapshot().projectId) &&
      String(versionSnapshot.chapterId) === String(source.chapterId) &&
      versionSnapshot.content.length === source.sourceLength &&
      versionSnapshot.content.slice(source.startOffset, source.endOffset) === source.excerpt;
    if (!valid) {
      return {
        evidenceState: "invalid",
        evidenceMessage: "这项变化引用的原文、UTF-16 位置或内容校验值已经不一致，不能确认。",
      };
    }
    if (String(chapter.value.currentVersionId) !== String(source.versionId)) {
      return {
        evidenceState: "historical",
        evidenceMessage: "这项变化来自较早的正文版本。请以当前正文重新识别后再确认。",
      };
    }
    return { evidenceState: "current", evidenceMessage: "证据与当前正文版本一致。" };
  }
}

function emptyReceipt(
  status: ContinuousStoryStateExtractionReceipt["status"],
  skippedTasks: ContinuousStoryStateExtractionReceipt["skippedTasks"],
): ContinuousStoryStateExtractionReceipt {
  return Object.freeze({
    status,
    detectedCount: 0,
    needsConfirmationCount: 0,
    reversibleCount: 0,
    skippedTasks: Object.freeze([...skippedTasks]),
    providerInvocations: Object.freeze([]),
  });
}

function assertTaskAllowsFactType(
  task: ContinuousStoryStateTask,
  factType: ContinuousStoryFactType,
): void {
  const allowed =
    task === "character_extraction"
      ? new Set<ContinuousStoryFactType>([
          "character_identity",
          "character_state",
          "relationship_change",
          "pov_knowledge",
          "character_voice",
        ])
      : new Set<ContinuousStoryFactType>([
          "world_setting",
          "world_rule",
          "timeline_event",
          "foreshadow_status",
          "plotline_state",
          "pacing_metric",
        ]);
  if (!allowed.has(factType)) {
    throw extractionError(
      "STORY_STATE_TASK_SCOPE_INVALID",
      "The model returned a fact type outside the selected extraction task.",
    );
  }
}

function assertExactEvidence(
  content: string,
  evidence: ContinuousStoryStateModelCandidate["evidence"],
): void {
  if (
    !Number.isSafeInteger(evidence.start) ||
    !Number.isSafeInteger(evidence.end) ||
    evidence.start < 0 ||
    evidence.end <= evidence.start ||
    evidence.end > content.length ||
    evidence.excerpt.length > 2_000 ||
    evidence.end - evidence.start !== evidence.excerpt.length ||
    content.slice(evidence.start, evidence.end) !== evidence.excerpt
  ) {
    throw extractionError(
      "STORY_STATE_EVIDENCE_INVALID",
      "A model candidate did not cite an exact UTF-16 span from the saved chapter version.",
    );
  }
}

function buildKnownEntityRegistry(
  facts: readonly StoryFact[],
): readonly ContinuousStoryStateKnownEntity[] {
  const entities = new Map<string, ContinuousStoryStateKnownEntity>();
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    if (
      snapshot.status !== "formal" ||
      !snapshot.userConfirmed ||
      snapshot.deprecated ||
      snapshot.structuredValue === null ||
      typeof snapshot.structuredValue !== "object" ||
      Array.isArray(snapshot.structuredValue)
    ) {
      continue;
    }
    const structured = asStoryRecord(snapshot.structuredValue);
    if (structured === null) {
      continue;
    }
    const subject = asStoryRecord(structured.subject);
    if (subject === null) {
      continue;
    }
    const kind = readEntityKind(subject.kind);
    const entityKey = readBoundedString(subject.entityKey, 200);
    const canonicalName = readBoundedString(subject.canonicalName, 200);
    const aliases = readBoundedStringArray(subject.aliases, 16, 200);
    if (kind === null || entityKey === null || canonicalName === null || aliases === null) {
      continue;
    }
    const existing = entities.get(entityKey);
    if (existing !== undefined && existing.kind !== kind) {
      continue;
    }
    entities.set(
      entityKey,
      Object.freeze({
        kind,
        entityKey,
        canonicalName,
        aliases: Object.freeze(
          [...new Set([...(existing?.aliases ?? []), canonicalName, ...aliases])].sort(),
        ),
      }),
    );
  }
  return Object.freeze(
    [...entities.values()].sort((left, right) => left.entityKey.localeCompare(right.entityKey)),
  );
}

function mergeCandidateEntity(
  candidate: ContinuousStoryStateModelCandidate,
  knownEntities: readonly ContinuousStoryStateKnownEntity[],
  versionId: string,
): Readonly<Record<string, StoryValue>> {
  if (candidate.subject === null) {
    return Object.freeze({
      kind: "event",
      entityKey: `event:${versionId}:${String(candidate.evidence.start)}`,
      canonicalName: "",
      aliases: Object.freeze([]),
      mergeStatus: "new_evidence_entity",
      matchedEntityKeys: Object.freeze([]),
      needsReview: true,
    });
  }
  const evidenceAliases = [
    ...new Set([candidate.subject.canonicalName, ...candidate.subject.aliases]),
  ]
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length > 0 && value.length <= 200 && candidate.evidence.excerpt.includes(value),
    )
    .sort();
  if (evidenceAliases.length === 0) {
    throw extractionError(
      "STORY_STATE_ENTITY_EVIDENCE_MISSING",
      "An entity candidate did not cite its canonical name or alias in the evidence span.",
    );
  }
  const firstEvidenceAlias = evidenceAliases[0];
  if (firstEvidenceAlias === undefined) {
    throw extractionError(
      "STORY_STATE_ENTITY_EVIDENCE_MISSING",
      "An entity candidate did not retain a usable evidence alias.",
    );
  }
  const sameKind = knownEntities.filter(({ kind }) => kind === candidate.subject?.kind);
  const byRequestedKey =
    candidate.subject.entityKey === null
      ? null
      : (sameKind.find(({ entityKey }) => entityKey === candidate.subject?.entityKey) ?? null);
  const aliasMatches = sameKind.filter(({ aliases, canonicalName }) =>
    evidenceAliases.some((alias) => aliases.includes(alias) || canonicalName === alias),
  );
  let entityKey: string;
  let canonicalName: string;
  let aliases: readonly string[];
  let mergeStatus: string;
  let matchedEntityKeys: readonly string[];
  if (
    byRequestedKey !== null &&
    evidenceAliases.some(
      (alias) => byRequestedKey.aliases.includes(alias) || byRequestedKey.canonicalName === alias,
    )
  ) {
    entityKey = byRequestedKey.entityKey;
    canonicalName = byRequestedKey.canonicalName;
    aliases = Object.freeze([...new Set([...byRequestedKey.aliases, ...evidenceAliases])].sort());
    mergeStatus = "exact_confirmed_key";
    matchedEntityKeys = Object.freeze([entityKey]);
  } else if (aliasMatches.length === 1) {
    const uniqueMatch = aliasMatches[0];
    if (uniqueMatch === undefined) {
      throw extractionError(
        "STORY_STATE_ENTITY_MERGE_INVALID",
        "The confirmed alias match could not be read safely.",
      );
    }
    entityKey = uniqueMatch.entityKey;
    canonicalName = uniqueMatch.canonicalName;
    aliases = Object.freeze([...new Set([...uniqueMatch.aliases, ...evidenceAliases])].sort());
    mergeStatus = "unique_confirmed_alias";
    matchedEntityKeys = Object.freeze([entityKey]);
  } else if (aliasMatches.length > 1) {
    entityKey = `${candidate.subject.kind}:${versionId}:${String(candidate.evidence.start)}`;
    canonicalName = firstEvidenceAlias;
    aliases = Object.freeze(evidenceAliases);
    mergeStatus = "ambiguous_confirmed_alias";
    matchedEntityKeys = Object.freeze(aliasMatches.map(({ entityKey: key }) => key).sort());
  } else {
    entityKey = `${candidate.subject.kind}:${versionId}:${String(candidate.evidence.start)}`;
    canonicalName = firstEvidenceAlias;
    aliases = Object.freeze(evidenceAliases);
    mergeStatus =
      candidate.subject.entityKey === null ? "new_evidence_entity" : "untrusted_key_ignored";
    matchedEntityKeys = Object.freeze([]);
  }
  return Object.freeze({
    kind: candidate.subject.kind,
    entityKey,
    canonicalName,
    aliases,
    mergeStatus,
    matchedEntityKeys,
    needsReview: true,
  });
}

function bindProjection(
  projection: ContinuousStoryStateProjection | null,
  subject: Readonly<Record<string, StoryValue>>,
  knownEntities: readonly ContinuousStoryStateKnownEntity[],
): Readonly<{
  readonly projection: ContinuousStoryStateProjection | null;
  readonly issues: readonly string[];
}> {
  if (projection === null) {
    return Object.freeze({
      projection: null,
      issues: Object.freeze(["model_projection_missing"]),
    });
  }
  const issues: string[] = [];
  const subjectId = typeof subject.entityKey === "string" ? subject.entityKey : null;
  const subjectKind = readEntityKind(subject.kind);
  const knownByKind = new Map<StoryEntityKind, Set<string>>();
  for (const entity of knownEntities) {
    const keys = knownByKind.get(entity.kind) ?? new Set<string>();
    keys.add(entity.entityKey);
    knownByKind.set(entity.kind, keys);
  }
  if (subjectId !== null && subjectKind !== null) {
    const keys = knownByKind.get(subjectKind) ?? new Set<string>();
    keys.add(subjectId);
    knownByKind.set(subjectKind, keys);
  }

  const validation = bindSubjectProjection(
    projection.validation,
    subjectId,
    issues,
    "validation_subject_mismatch",
  );
  const pov = bindCharacterProjection(
    projection.pov,
    subjectId,
    subjectKind,
    issues,
    "pov_character_mismatch",
  );
  const voiceBase = bindCharacterProjection(
    projection.voice,
    subjectId,
    subjectKind,
    issues,
    "voice_character_mismatch",
  );
  const voice =
    voiceBase === null
      ? null
      : Object.freeze({
          ...voiceBase,
          dialogues: Object.freeze(
            voiceBase.dialogues.flatMap((dialogue) => {
              if (
                dialogue.addresseeCharacterId !== null &&
                !knownByKind.get("character")?.has(dialogue.addresseeCharacterId)
              ) {
                issues.push("voice_addressee_not_confirmed");
                return [];
              }
              return [dialogue];
            }),
          ),
        });

  let narrative = projection.narrative;
  if (narrative?.plotline !== null && narrative !== null) {
    const requested = narrative.plotline.plotlineId;
    if (subjectKind !== "plotline" || subjectId === null) {
      issues.push("narrative_plotline_subject_missing");
      narrative = Object.freeze({ ...narrative, plotline: null });
    } else if (requested !== null && requested !== subjectId) {
      issues.push("narrative_plotline_subject_mismatch");
      narrative = Object.freeze({ ...narrative, plotline: null });
    } else {
      narrative = Object.freeze({
        ...narrative,
        plotline: Object.freeze({ ...narrative.plotline, plotlineId: subjectId }),
      });
    }
  }

  return Object.freeze({
    projection: Object.freeze({ validation, pov, voice, narrative }),
    issues: Object.freeze([...new Set(issues)]),
  });
}

function bindSubjectProjection(
  projection: ContinuousValidationProjection | null,
  subjectId: string | null,
  issues: string[],
  issue: string,
): ContinuousValidationProjection | null {
  if (projection === null) {
    return null;
  }
  if (subjectId === null || (projection.subjectId !== null && projection.subjectId !== subjectId)) {
    issues.push(issue);
    return null;
  }
  return Object.freeze({ ...projection, subjectId });
}

function bindCharacterProjection<Value extends { readonly characterId: string | null }>(
  projection: Value | null,
  subjectId: string | null,
  subjectKind: StoryEntityKind | null,
  issues: string[],
  issue: string,
): (Omit<Value, "characterId"> & { readonly characterId: string }) | null {
  if (projection === null) {
    return null;
  }
  if (
    subjectKind !== "character" ||
    subjectId === null ||
    (projection.characterId !== null && projection.characterId !== subjectId)
  ) {
    issues.push(issue);
    return null;
  }
  return Object.freeze({ ...projection, characterId: subjectId });
}

function rebuildableReplacementKey(
  chapterId: string,
  candidate: ContinuousStoryStateModelCandidate,
): string {
  const sceneId = candidate.projection?.narrative?.scene?.sceneId;
  return [
    "continuous-story-state",
    chapterId,
    candidate.factType,
    sceneId ?? `${String(candidate.evidence.start)}-${String(candidate.evidence.end)}`,
  ].join(":");
}

function factFingerprint(fact: StoryFact): string {
  const snapshot = fact.toSnapshot();
  const structured = asStoryRecord(snapshot.structuredValue);
  const subject = asStoryRecord(structured?.subject);
  const entityKey =
    subject !== null && typeof subject.entityKey === "string" ? subject.entityKey : "";
  return [
    snapshot.factType,
    entityKey,
    String(snapshot.source.startOffset ?? -1),
    String(snapshot.source.endOffset ?? -1),
    snapshot.contentText ?? "",
  ].join("\u001f");
}

function modelCandidateFingerprint(
  candidate: ContinuousStoryStateModelCandidate,
  entityKeyValue: StoryValue | undefined,
): string {
  return [
    candidate.factType,
    typeof entityKeyValue === "string" ? entityKeyValue : "",
    String(candidate.evidence.start),
    String(candidate.evidence.end),
    candidate.contentText,
  ].join("\u001f");
}

function isFactFromTaskAndVersion(
  fact: StoryFact,
  task: ContinuousStoryStateTask,
  versionId: string,
): boolean {
  const source = fact.toSnapshot().source;
  return (
    source.kind === "chapter_span" &&
    source.versionId === versionId &&
    source.reference.startsWith(`${REFERENCE_PREFIX}:${task}:${versionId}:sha256:`)
  );
}

function evidenceReference(
  task: ContinuousStoryStateTask,
  versionId: string,
  checksum: string,
): string {
  return `${REFERENCE_PREFIX}:${task}:${versionId}:sha256:${checksum}`;
}

function readChecksumFromReference(reference: string): string | null {
  const match =
    /^continuous-story-state:(?:character_extraction|world_extraction):[0-9a-f-]+:sha256:([a-f0-9]{64})$/u.exec(
      reference,
    );
  return match?.[1] ?? null;
}

function readEntityKind(value: StoryValue | undefined): StoryEntityKind | null {
  return value === "character" ||
    value === "foreshadow" ||
    value === "plotline" ||
    value === "world" ||
    value === "event"
    ? value
    : null;
}

function readBoundedString(value: StoryValue | undefined, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? value.trim()
    : null;
}

function readBoundedStringArray(
  value: StoryValue | undefined,
  maximumItems: number,
  maximumLength: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return null;
  }
  const strings = (value as readonly StoryValue[]).map((item) =>
    readBoundedString(item, maximumLength),
  );
  return strings.some((item) => item === null) ? null : Object.freeze(strings as readonly string[]);
}

function requireDomainUuid(value: string, message: string) {
  const parsed = parseDomainUuid(value);
  if (!parsed.ok) {
    throw extractionError("STORY_STATE_ID_INVALID", message);
  }
  return parsed.value;
}

function requireStoryUuid(value: string, message: string) {
  const parsed = parseStoryUuid(value);
  if (!parsed.ok) {
    throw extractionError("STORY_STATE_ID_INVALID", message);
  }
  return parsed.value;
}

function extractionError(reasonCode: string, message: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_VALIDATION_FAILED",
    message,
    details: { reasonCode },
  });
}

function asStoryRecord(value: StoryValue | undefined): Readonly<Record<string, StoryValue>> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, StoryValue>>)
    : null;
}

/** Exposed for strict adapter/service tests, not for direct persistence. */
export const continuousStoryStateTesting = Object.freeze({
  buildKnownEntityRegistry,
  mergeCandidateEntity,
  assertExactEvidence,
  readChecksumFromReference,
});
