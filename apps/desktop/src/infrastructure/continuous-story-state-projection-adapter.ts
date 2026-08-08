import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  type CausalEventGraph,
  type CausalEventNode,
  StoryFact,
  createStoryValue,
  type StoryFactSnapshot,
  type StoryFactStore,
} from "@inkshadow/story-core";

import {
  CONTINUOUS_STORY_FACT_TYPES,
  CONTINUOUS_STORY_STATE_SCHEMA,
  CONTINUOUS_VALIDATION_FACT_TYPES,
  KNOWLEDGE_STATES,
  type ContinuousStoryFactType,
  type ContinuousValidationFactType,
} from "./continuous-story-state-extraction";
import type { CausalEventGraphStore } from "./causal-event-graph-store";

const REBUILDABLE_SYSTEM_FACT_SCHEMA = "inkshadow.rebuildable-system-fact.v1";
const CHARACTER_VOICE_EVIDENCE_SCHEMA = "inkshadow.character-voice-evidence.v1";
const NARRATIVE_ANALYSIS_FACT_SCHEMA = "inkshadow.narrative-analysis-fact.v1";
const CAUSAL_EVENT_FACT_SCHEMA = "inkshadow.causal-event-fact.v2";
const POV_KNOWLEDGE_SOURCE_SCHEMA = "inkshadow.pov-knowledge-source.v2";
const CONTINUOUS_REFERENCE_PATTERN =
  /^continuous-story-state:(?:character_extraction|world_extraction):([0-9a-f-]+):sha256:([a-f0-9]{64})$/u;
const SAFE_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,511}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type ContinuousProjectionArea = "validation" | "voice_pov" | "narrative";
export type ContinuousProjectionDiagnosticReason =
  | "branch_mismatch"
  | "schema_missing"
  | "projection_missing"
  | "projection_invalid"
  | "projection_reference_invalid"
  | "evidence_invalid"
  | "current_version_required"
  | "human_confirmation_required"
  | "rebuildable_authority_required"
  | "knowledge_source_incomplete"
  | "knowledge_source_unverified"
  | "knowledge_source_inactive"
  | "duplicate_projection";

export interface ContinuousProjectionDiagnostic {
  readonly sourceFactId: string;
  readonly area: ContinuousProjectionArea;
  readonly reason: ContinuousProjectionDiagnosticReason;
  readonly missingRequirements: readonly string[];
}

export interface ContinuousProjectedFactBatch {
  readonly facts: readonly StoryFact[];
  readonly diagnostics: readonly ContinuousProjectionDiagnostic[];
}

export interface ContinuousStoryStateProjectionRequest {
  readonly projectId: string;
  readonly chapterId: string;
  /** Required by current-claim consumers; narrative projections verify currentness through ChapterRepository. */
  readonly currentVersionId: string | null;
  readonly branchId?: string | null;
}

export interface ContinuousStoryStateProjectionDependencies {
  readonly chapters: Pick<ChapterRepository, "findById">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly storyFacts: Pick<StoryFactStore, "listByProjectId">;
  readonly causalGraph: Pick<CausalEventGraphStore, "loadProjectBranch">;
  readonly hasher: ContentHasher;
}

export class ContinuousStoryStateProjectionError extends Error {
  public constructor(
    readonly code:
      "CONTINUOUS_PROJECTION_STORAGE_UNAVAILABLE" | "CONTINUOUS_PROJECTION_HASH_UNAVAILABLE",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ContinuousStoryStateProjectionError";
  }
}

interface StoredContinuousFact {
  readonly fact: StoryFact;
  readonly snapshot: StoryFactSnapshot;
  readonly record: Readonly<Record<string, unknown>>;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly rebuildableSystemProjection: boolean;
}

interface VerifiedEvidence {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly content: string;
}

interface ValidationProjection {
  readonly factType: ContinuousValidationFactType;
  readonly subjectId: string;
  readonly attributeKey: string;
  readonly value: string | number | boolean;
  readonly effectiveRange: Readonly<{
    readonly startOrder: number;
    readonly endOrder: number | null;
  }>;
}

interface PovProjection {
  readonly characterId: string;
  readonly attributeKey: string;
  readonly knowledgeStatus: "known" | "unknown" | "suspected" | "false_belief";
  readonly effectiveRange: Readonly<{
    readonly startOrder: number;
    readonly endOrder: number | null;
  }>;
  readonly mode: "first_person" | "third_person_limited";
  readonly acquiredAt: number | null;
  readonly sourceEventId: string | null;
  readonly sourceFactId: string | null;
  readonly informationId: string | null;
  readonly sourceCompleteness: "declared" | "legacy_incomplete";
}

interface VerifiedPovKnowledgeSource {
  readonly sourceSnapshot: StoryFactSnapshot;
  readonly event: CausalEventNode;
  readonly evidence: VerifiedEvidence;
  readonly acquiredAt: number;
}

type PovKnowledgeSourceResolution =
  | Readonly<{ readonly ok: true; readonly value: VerifiedPovKnowledgeSource }>
  | Readonly<{
      readonly ok: false;
      readonly reason: "knowledge_source_unverified" | "knowledge_source_inactive";
    }>;

interface VoiceProjection {
  readonly characterId: string;
  readonly featureCatalog: Readonly<Record<string, unknown>>;
  readonly dialogues: readonly Readonly<{
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
    readonly addresseeCharacterId: string | null;
    readonly typical: boolean;
  }>[];
}

interface NarrativeProjection {
  readonly chapterOrder: number;
  readonly scene: Readonly<Record<string, unknown>> | null;
  readonly plotline: Readonly<Record<string, unknown>> | null;
}

interface NarrativeSource {
  readonly source: StoredContinuousFact;
  readonly projection: NarrativeProjection;
}

/**
 * Strict read-only bridge from the continuous extraction schema to the three
 * established detector schemas. It never promotes a source fact, guesses an
 * entity, or weakens the original adapters' authority/evidence gates.
 */
export class ContinuousStoryStateProjectionAdapter {
  public constructor(private readonly dependencies: ContinuousStoryStateProjectionDependencies) {}

  public async projectValidationFacts(
    request: ContinuousStoryStateProjectionRequest,
  ): Promise<ContinuousProjectedFactBatch> {
    const loaded = await this.loadContinuousFacts(request.projectId);
    const diagnostics: ContinuousProjectionDiagnostic[] = [...loaded.diagnostics];
    const facts: StoryFact[] = [];
    const versionCache = new Map<string, Promise<VerifiedEvidence | null>>();
    const graphCache = new Map<string, Promise<CausalEventGraph | null>>();
    for (const source of loaded.facts) {
      if (source.snapshot.deprecated) continue;
      if (!branchMatches(source.snapshot, request.branchId)) {
        diagnostics.push(
          diagnostic(source, "validation", "branch_mismatch", ["matching_story_branch"]),
        );
        continue;
      }
      if (source.snapshot.factType === "pov_knowledge") {
        const pov = parsePovProjection(source);
        if (pov === null) {
          diagnostics.push(
            diagnostic(source, "validation", "projection_missing", [
              "explicit_pov_character_mode_knowledge_and_effective_range",
            ]),
          );
          continue;
        }
        const projected = await this.projectPovKnowledge({
          source,
          projection: pov,
          request,
          allFactsById: loaded.allFactsById,
          versionCache,
          graphCache,
          area: "validation",
          requireConfirmedCurrent: false,
        });
        facts.push(...projected.facts);
        diagnostics.push(...projected.diagnostics);
        continue;
      }
      const validation = parseValidationProjection(source);
      const normalized = validation;
      if (normalized === null) {
        if (expectsValidationProjection(source.snapshot.factType)) {
          diagnostics.push(
            diagnostic(source, "validation", "projection_missing", [
              "explicit_subject_attribute_value_and_effective_range",
            ]),
          );
        }
        continue;
      }
      if (!validationMatchesSourceType(source.snapshot.factType, normalized.factType)) {
        diagnostics.push(
          diagnostic(source, "validation", "projection_invalid", [
            "fact_type_compatible_with_continuous_source",
          ]),
        );
        continue;
      }
      if ((await this.verifyEvidence(source.snapshot, versionCache)) === null) {
        diagnostics.push(
          diagnostic(source, "validation", "evidence_invalid", [
            "exact_immutable_chapter_span_and_checksum",
          ]),
        );
        continue;
      }
      const current = isCurrentTargetSource(source.snapshot, request);
      const confirmed = isConfirmedFormal(source.snapshot);
      const role =
        confirmed && source.snapshot.locked
          ? "hard_rule"
          : current
            ? "current_claim"
            : confirmed
              ? "reference_fact"
              : null;
      if (role === null) {
        diagnostics.push(
          diagnostic(source, "validation", "human_confirmation_required", [
            "historical_reference_must_be_human_confirmed_formal",
          ]),
        );
        continue;
      }
      const structuredValue =
        role === "hard_rule"
          ? {
              validationRole: role,
              subjectId: normalized.subjectId,
              attributeKey: normalized.attributeKey,
              effectiveRange: normalized.effectiveRange,
              operator: "equals",
              expectedValue: normalized.value,
            }
          : {
              validationRole: role,
              subjectId: normalized.subjectId,
              attributeKey: normalized.attributeKey,
              effectiveRange: normalized.effectiveRange,
              value: normalized.value,
              ...(role === "current_claim"
                ? {
                    basis: "explicit_text",
                  }
                : {}),
            };
      const projected = rehydrateProjectedFact(
        source.snapshot,
        source.snapshot.id,
        normalized.factType,
        structuredValue,
      );
      if (projected === null) {
        diagnostics.push(
          diagnostic(source, "validation", "projection_invalid", ["validator_story_fact_schema"]),
        );
      } else {
        facts.push(projected);
      }
    }
    return freezeBatch(facts, diagnostics);
  }

  public async projectVoicePovFacts(
    request: ContinuousStoryStateProjectionRequest,
  ): Promise<ContinuousProjectedFactBatch> {
    const loaded = await this.loadContinuousFacts(request.projectId);
    const diagnostics: ContinuousProjectionDiagnostic[] = [...loaded.diagnostics];
    const facts: StoryFact[] = [];
    const versionCache = new Map<string, Promise<VerifiedEvidence | null>>();
    const graphCache = new Map<string, Promise<CausalEventGraph | null>>();
    const voices: { source: StoredContinuousFact; projection: VoiceProjection }[] = [];
    for (const source of loaded.facts) {
      if (source.snapshot.deprecated) continue;
      if (!branchMatches(source.snapshot, request.branchId)) continue;
      if (
        source.snapshot.factType !== "pov_knowledge" &&
        source.snapshot.factType !== "character_voice"
      ) {
        continue;
      }
      if (source.snapshot.factType === "pov_knowledge") {
        const pov = parsePovProjection(source);
        if (pov === null) {
          diagnostics.push(
            diagnostic(source, "voice_pov", "projection_missing", [
              "explicit_pov_character_mode_knowledge_and_effective_range",
            ]),
          );
          continue;
        }
        const projected = await this.projectPovKnowledge({
          source,
          projection: pov,
          request,
          allFactsById: loaded.allFactsById,
          versionCache,
          graphCache,
          area: "voice_pov",
          requireConfirmedCurrent: true,
        });
        facts.push(...projected.facts);
        diagnostics.push(...projected.diagnostics);
        continue;
      }
      if (!isConfirmedFormal(source.snapshot)) {
        diagnostics.push(
          diagnostic(source, "voice_pov", "human_confirmation_required", [
            "user_confirmed_formal_voice_or_knowledge_fact",
          ]),
        );
        continue;
      }
      const verified = await this.verifyEvidence(source.snapshot, versionCache);
      if (verified === null) {
        diagnostics.push(
          diagnostic(source, "voice_pov", "evidence_invalid", [
            "exact_immutable_chapter_span_and_checksum",
          ]),
        );
        continue;
      }
      const voice = parseVoiceProjection(source, verified.content);
      if (voice === null) {
        diagnostics.push(
          diagnostic(source, "voice_pov", "projection_missing", [
            "feature_catalog_and_exact_dialogue_spans",
          ]),
        );
        continue;
      }
      voices.push({ source, projection: voice });
    }

    for (const [characterId, candidates] of groupBy(
      voices,
      ({ projection }) => projection.characterId,
    )) {
      const catalogKeys = new Map<string, (typeof candidates)[number]>();
      for (const candidate of candidates) {
        catalogKeys.set(stableJson(candidate.projection.featureCatalog), candidate);
      }
      if (catalogKeys.size !== 1) {
        for (const candidate of candidates) {
          diagnostics.push(
            diagnostic(candidate.source, "voice_pov", "duplicate_projection", [
              "one_unambiguous_feature_catalog_per_character",
            ]),
          );
        }
        continue;
      }
      const catalogSource = catalogKeys.values().next().value;
      if (catalogSource === undefined) continue;
      const catalogId = await this.derivedUuid(catalogSource.source.snapshot.id, "voice-catalog");
      const catalog = rehydrateProjectedFact(
        catalogSource.source.snapshot,
        catalogId,
        "character_voice",
        {
          characterEvidenceSchema: CHARACTER_VOICE_EVIDENCE_SCHEMA,
          characterEvidenceRole: "voice_feature_catalog",
          characterId,
          featureCatalog: catalogSource.projection.featureCatalog,
        },
      );
      if (catalog !== null) facts.push(catalog);

      for (const candidate of candidates) {
        for (const [index, dialogue] of candidate.projection.dialogues.entries()) {
          const sourceSnapshot = candidate.source.snapshot;
          const source = sourceSnapshot.source;
          if (
            source.startOffset === null ||
            source.endOffset === null ||
            dialogue.start < source.startOffset ||
            dialogue.end > source.endOffset ||
            dialogue.end - dialogue.start !== dialogue.excerpt.length
          ) {
            diagnostics.push(
              diagnostic(candidate.source, "voice_pov", "projection_reference_invalid", [
                "dialogue_exactly_inside_candidate_evidence",
              ]),
            );
            continue;
          }
          const dialogueId = await this.derivedUuid(
            sourceSnapshot.id,
            `voice-dialogue:${String(index)}`,
          );
          const projected = rehydrateProjectedFact(
            {
              ...sourceSnapshot,
              source: {
                ...source,
                reference: `${source.reference}:projection:voice-dialogue:${String(index)}`,
                startOffset: dialogue.start,
                endOffset: dialogue.end,
                excerpt: dialogue.excerpt,
              },
            },
            dialogueId,
            "character_voice",
            {
              characterEvidenceSchema: CHARACTER_VOICE_EVIDENCE_SCHEMA,
              characterEvidenceRole: isCurrentTargetSource(sourceSnapshot, request)
                ? "voice_current_dialogue"
                : "voice_historical_dialogue",
              characterId,
              addresseeCharacterId: dialogue.addresseeCharacterId,
              typical: dialogue.typical,
            },
          );
          if (projected !== null) facts.push(projected);
        }
      }
    }
    return freezeBatch(facts, diagnostics);
  }

  private async projectPovKnowledge(
    input: Readonly<{
      source: StoredContinuousFact;
      projection: PovProjection;
      request: ContinuousStoryStateProjectionRequest;
      allFactsById: ReadonlyMap<string, StoryFactSnapshot>;
      versionCache: Map<string, Promise<VerifiedEvidence | null>>;
      graphCache: Map<string, Promise<CausalEventGraph | null>>;
      area: "validation" | "voice_pov";
      requireConfirmedCurrent: boolean;
    }>,
  ): Promise<ContinuousProjectedFactBatch> {
    const { source, projection, request } = input;
    const diagnostics: ContinuousProjectionDiagnostic[] = [];
    const current = isCurrentTargetSource(source.snapshot, request);
    if (source.snapshot.invalidatedAt !== null) {
      diagnostics.push(
        diagnostic(source, input.area, "knowledge_source_inactive", ["active_pov_knowledge_claim"]),
      );
      return freezeBatch([], diagnostics);
    }
    if ((await this.verifyEvidence(source.snapshot, input.versionCache)) === null) {
      diagnostics.push(
        diagnostic(source, input.area, "evidence_invalid", [
          "exact_immutable_chapter_span_and_checksum",
        ]),
      );
      return freezeBatch([], diagnostics);
    }

    if (current) {
      if (input.requireConfirmedCurrent && !isConfirmedFormal(source.snapshot)) {
        diagnostics.push(
          diagnostic(source, input.area, "human_confirmation_required", [
            "user_confirmed_formal_current_pov_claim",
          ]),
        );
        return freezeBatch([], diagnostics);
      }
      const projected = rehydrateProjectedFact(
        source.snapshot,
        source.snapshot.id,
        "character_knowledge",
        {
          validationRole: "current_claim",
          subjectId: projection.characterId,
          characterId: projection.characterId,
          attributeKey: projection.attributeKey,
          effectiveRange: projection.effectiveRange,
          value: projection.knowledgeStatus,
          basis: "explicit_text",
          povContext: { mode: projection.mode, characterId: projection.characterId },
          knowledgeSourceSchema: POV_KNOWLEDGE_SOURCE_SCHEMA,
          knowledgeSourceCompleteness:
            projection.sourceCompleteness === "legacy_incomplete"
              ? "legacy_incomplete"
              : "current_claim",
        },
      );
      if (projected === null) {
        diagnostics.push(
          diagnostic(source, input.area, "projection_invalid", ["validator_story_fact_schema"]),
        );
        return freezeBatch([], diagnostics);
      }
      return freezeBatch([projected], diagnostics);
    }

    if (!isConfirmedFormal(source.snapshot)) {
      diagnostics.push(
        diagnostic(source, input.area, "human_confirmation_required", [
          "historical_knowledge_must_be_human_confirmed_formal",
        ]),
      );
      return freezeBatch([], diagnostics);
    }
    if (
      projection.sourceCompleteness === "legacy_incomplete" ||
      projection.knowledgeStatus !== "known" ||
      projection.acquiredAt === null ||
      projection.sourceEventId === null ||
      projection.sourceFactId === null ||
      projection.informationId === null
    ) {
      diagnostics.push(
        diagnostic(source, input.area, "knowledge_source_incomplete", [
          "confirmed_source_fact_event_acquisition_order_and_exact_knowledge_gain",
        ]),
      );
      return freezeBatch([], diagnostics);
    }

    const resolved = await this.resolvePovKnowledgeSource({
      source,
      projection,
      request,
      allFactsById: input.allFactsById,
      versionCache: input.versionCache,
      graphCache: input.graphCache,
    });
    if (!resolved.ok) {
      diagnostics.push(
        diagnostic(source, input.area, resolved.reason, [
          resolved.reason === "knowledge_source_inactive"
            ? "active_confirmed_source_fact"
            : "matching_character_attribute_information_causal_event_and_exact_source_evidence",
        ]),
      );
      return freezeBatch([], diagnostics);
    }

    const acquiredAt = resolved.value.acquiredAt;
    const sourceEvidence = resolved.value.sourceSnapshot.source;
    const projectedSource: StoryFactSnapshot = {
      ...source.snapshot,
      source: sourceEvidence,
    };
    const evidenceReceipt = Object.freeze({
      chapterId: sourceEvidence.chapterId,
      versionId: sourceEvidence.versionId,
      contentHash: resolved.value.evidence.contentHash,
      reference: sourceEvidence.reference,
      startOffset: sourceEvidence.startOffset,
      endOffset: sourceEvidence.endOffset,
      sourceLength: sourceEvidence.sourceLength,
      excerpt: sourceEvidence.excerpt,
    });
    const knowledgeSource = {
      knowledgeSourceSchema: POV_KNOWLEDGE_SOURCE_SCHEMA,
      knowledgeSourceCompleteness: "verified",
      acquiredAt,
      sourceEventId: projection.sourceEventId,
      sourceFactId: projection.sourceFactId,
      informationId: projection.informationId,
      sourceEvidence: evidenceReceipt,
    } as const;
    const facts: StoryFact[] = [];
    if (projection.effectiveRange.startOrder < acquiredAt) {
      const beforeId = await this.derivedUuid(source.snapshot.id, "pov-before-acquisition");
      const before = rehydrateProjectedFact(projectedSource, beforeId, "character_knowledge", {
        validationRole: "reference_fact",
        subjectId: projection.characterId,
        characterId: projection.characterId,
        attributeKey: projection.attributeKey,
        effectiveRange: {
          startOrder: projection.effectiveRange.startOrder,
          endOrder: acquiredAt - 1,
        },
        value: "unknown",
        ...knowledgeSource,
      });
      if (before !== null) facts.push(before);
    }
    const afterId = await this.derivedUuid(source.snapshot.id, "pov-after-acquisition");
    const after = rehydrateProjectedFact(projectedSource, afterId, "character_knowledge", {
      validationRole: "reference_fact",
      subjectId: projection.characterId,
      characterId: projection.characterId,
      attributeKey: projection.attributeKey,
      effectiveRange: {
        startOrder: acquiredAt,
        endOrder: projection.effectiveRange.endOrder,
      },
      value: "known",
      ...knowledgeSource,
    });
    if (after !== null) facts.push(after);
    if (facts.length === 0) {
      diagnostics.push(
        diagnostic(source, input.area, "projection_invalid", ["validator_story_fact_schema"]),
      );
    }
    return freezeBatch(facts, diagnostics);
  }

  private async resolvePovKnowledgeSource(
    input: Readonly<{
      source: StoredContinuousFact;
      projection: PovProjection;
      request: ContinuousStoryStateProjectionRequest;
      allFactsById: ReadonlyMap<string, StoryFactSnapshot>;
      versionCache: Map<string, Promise<VerifiedEvidence | null>>;
      graphCache: Map<string, Promise<CausalEventGraph | null>>;
    }>,
  ): Promise<PovKnowledgeSourceResolution> {
    const { projection, request } = input;
    if (
      projection.acquiredAt === null ||
      projection.sourceEventId === null ||
      projection.sourceFactId === null ||
      projection.informationId === null
    ) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    const sourceSnapshot = input.allFactsById.get(projection.sourceFactId);
    if (sourceSnapshot === undefined) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    if (
      sourceSnapshot.status !== "formal" ||
      !sourceSnapshot.userConfirmed ||
      sourceSnapshot.needsReview ||
      sourceSnapshot.deprecated ||
      sourceSnapshot.invalidatedAt !== null
    ) {
      return Object.freeze({ ok: false, reason: "knowledge_source_inactive" });
    }
    const branchId = request.branchId ?? null;
    if (
      sourceSnapshot.projectId !== request.projectId ||
      sourceSnapshot.branchId !== branchId ||
      sourceSnapshot.source.kind !== "chapter_span"
    ) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    const structured = asRecord(sourceSnapshot.structuredValue);
    const narrativeTime = asRecord(structured?.narrativeTime);
    const eventId = safeReference(structured?.eventId) ?? sourceSnapshot.id;
    const informedCharacterIds = readReferenceArray(structured?.informedCharacterIds, 512);
    const knowledgeGains = readKnowledgeGains(structured?.knowledgeGains);
    if (
      structured?.schemaVersion !== CAUSAL_EVENT_FACT_SCHEMA ||
      eventId !== projection.sourceEventId ||
      narrativeTime?.order !== projection.acquiredAt ||
      !informedCharacterIds?.includes(projection.characterId) ||
      !knowledgeGains?.some(
        (gain) =>
          gain.characterId === projection.characterId &&
          gain.attributeKey === projection.attributeKey &&
          gain.informationId === projection.informationId,
      )
    ) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    const evidence = await this.verifyChapterEvidence(sourceSnapshot, input.versionCache);
    if (evidence === null) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    const graphBranchId = branchId ?? "main";
    const graphKey = `${request.projectId}\u0000${graphBranchId}`;
    let pending = input.graphCache.get(graphKey);
    if (pending === undefined) {
      pending = this.dependencies.causalGraph
        .loadProjectBranch(request.projectId, graphBranchId)
        .catch(() => null);
      input.graphCache.set(graphKey, pending);
    }
    const graph = await pending;
    const event = graph?.events.find(({ id }) => id === projection.sourceEventId);
    if (event === undefined) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    if (
      event.projectId !== request.projectId ||
      event.branchId !== graphBranchId ||
      event.narrativeTime.order !== projection.acquiredAt ||
      !event.informedCharacterIds.includes(projection.characterId) ||
      !causalEvidenceMatchesStoryFact(event, sourceSnapshot, evidence)
    ) {
      return Object.freeze({ ok: false, reason: "knowledge_source_unverified" });
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({ sourceSnapshot, event, evidence, acquiredAt: projection.acquiredAt }),
    });
  }

  public async projectNarrativeFacts(
    request: ContinuousStoryStateProjectionRequest,
  ): Promise<ContinuousProjectedFactBatch> {
    const loaded = await this.loadContinuousFacts(request.projectId);
    const diagnostics: ContinuousProjectionDiagnostic[] = [...loaded.diagnostics];
    const versionCache = new Map<string, Promise<VerifiedEvidence | null>>();
    const sources: NarrativeSource[] = [];
    for (const source of loaded.facts) {
      if (source.snapshot.deprecated) continue;
      if (!branchMatches(source.snapshot, request.branchId)) continue;
      if (
        source.snapshot.factType !== "pacing_metric" &&
        source.snapshot.factType !== "plotline_state" &&
        source.snapshot.factType !== "timeline_event"
      ) {
        continue;
      }
      const projection = parseNarrativeProjection(source);
      if (projection === null) {
        diagnostics.push(
          diagnostic(source, "narrative", "projection_missing", [
            "explicit_chapter_order_and_scene_or_plotline_projection",
          ]),
        );
        continue;
      }
      const confirmed = isConfirmedFormal(source.snapshot);
      const rebuildable =
        source.snapshot.factType === "pacing_metric" &&
        source.rebuildableSystemProjection &&
        source.snapshot.status === "temporary" &&
        source.snapshot.origin === "system" &&
        !source.snapshot.needsReview;
      if (!confirmed && !rebuildable) {
        diagnostics.push(
          diagnostic(
            source,
            "narrative",
            source.snapshot.factType === "pacing_metric"
              ? "rebuildable_authority_required"
              : "human_confirmation_required",
            [
              source.snapshot.factType === "pacing_metric"
                ? "current_rebuildable_system_projection_or_confirmed_formal_fact"
                : "human_confirmed_formal_narrative_fact",
            ],
          ),
        );
        continue;
      }
      if ((await this.verifyEvidence(source.snapshot, versionCache)) === null) {
        diagnostics.push(
          diagnostic(source, "narrative", "evidence_invalid", [
            "exact_immutable_chapter_span_and_checksum",
          ]),
        );
        continue;
      }
      if (rebuildable && !(await this.sourceIsCurrent(source.snapshot))) {
        diagnostics.push(
          diagnostic(source, "narrative", "current_version_required", [
            "rebuildable_metric_from_current_chapter_version",
          ]),
        );
        continue;
      }
      sources.push({ source, projection });
    }

    const facts: StoryFact[] = [];
    const chapterGroups = groupBy(sources, ({ source }) => source.snapshot.source.chapterId ?? "");
    for (const [chapterId, candidates] of chapterGroups) {
      if (!isSafeReference(chapterId)) continue;
      const orders = new Set(candidates.map(({ projection }) => projection.chapterOrder));
      if (orders.size !== 1) {
        candidates.forEach(({ source }) =>
          diagnostics.push(
            diagnostic(source, "narrative", "duplicate_projection", [
              "one_unambiguous_order_per_chapter",
            ]),
          ),
        );
        continue;
      }
      const candidate = candidates[0];
      const order = candidate?.projection.chapterOrder;
      if (candidate === undefined || order === undefined) continue;
      const id = await this.derivedUuid(
        candidate.source.snapshot.id,
        `narrative-chapter:${chapterId}`,
      );
      const chapterFact = rehydrateProjectedFact(
        candidate.source.snapshot,
        id,
        "narrative_projection",
        { schemaVersion: NARRATIVE_ANALYSIS_FACT_SCHEMA, kind: "chapter", chapterId, order },
      );
      if (chapterFact !== null) facts.push(chapterFact);
    }

    const scenes = sources.flatMap((candidate) =>
      candidate.projection.scene === null
        ? []
        : [{ ...candidate, scene: candidate.projection.scene }],
    );
    for (const [sceneId, candidates] of groupBy(
      scenes,
      ({ scene }) => safeReference(scene.sceneId) ?? "",
    )) {
      if (!isSafeReference(sceneId) || candidates.length !== 1) {
        candidates.forEach(({ source }) =>
          diagnostics.push(
            diagnostic(source, "narrative", "duplicate_projection", ["unique_scene_id"]),
          ),
        );
        continue;
      }
      const candidate = candidates[0];
      const chapterId = candidate?.source.snapshot.source.chapterId;
      if (candidate === undefined || chapterId === null || chapterId === undefined) continue;
      const scene = candidate.scene;
      const id = await this.derivedUuid(candidate.source.snapshot.id, `narrative-scene:${sceneId}`);
      const sceneFact = rehydrateProjectedFact(
        candidate.source.snapshot,
        id,
        "narrative_projection",
        {
          schemaVersion: NARRATIVE_ANALYSIS_FACT_SCHEMA,
          kind: "scene_metric",
          sceneId,
          chapterId,
          sequence: scene.sequence,
          goal: scene.goal,
          conflictIntensity: scene.conflictIntensity,
          tension: scene.tension,
          composition: scene.composition,
          plotAdvancement: {
            advances: scene.movesPlot,
            plotlineIds: scene.plotlineIds,
          },
          characterChange: {
            changes: scene.changesCharacter,
            characterIds: scene.characterIds,
          },
          functionTags: scene.functionTags,
          setupBeatIds: scene.setupBeatIds,
          climax: scene.climax,
        },
      );
      if (sceneFact !== null) facts.push(sceneFact);
    }

    const plotlines = sources.flatMap((candidate) =>
      candidate.projection.plotline === null
        ? []
        : [{ ...candidate, plotline: candidate.projection.plotline }],
    );
    for (const [plotlineId, candidates] of groupBy(
      plotlines,
      ({ plotline }) => safeReference(plotline.plotlineId) ?? "",
    )) {
      if (!isSafeReference(plotlineId)) continue;
      const selected = [...candidates].sort(
        (left, right) =>
          right.projection.chapterOrder - left.projection.chapterOrder ||
          right.source.snapshot.updatedAt.localeCompare(left.source.snapshot.updatedAt),
      )[0];
      if (selected === undefined) continue;
      const plotlineIdValue = await this.derivedUuid(
        selected.source.snapshot.id,
        `narrative-plotline:${plotlineId}`,
      );
      const plotlineFact = rehydrateProjectedFact(
        selected.source.snapshot,
        plotlineIdValue,
        "narrative_projection",
        {
          schemaVersion: NARRATIVE_ANALYSIS_FACT_SCHEMA,
          kind: "plotline",
          plotlineId,
          goal: selected.plotline.goal,
        },
      );
      if (plotlineFact !== null) facts.push(plotlineFact);
      for (const characterId of readReferenceArray(selected.plotline.characterIds) ?? []) {
        const id = await this.derivedUuid(
          selected.source.snapshot.id,
          `narrative-plotline-character:${plotlineId}:${characterId}`,
        );
        const fact = rehydrateProjectedFact(selected.source.snapshot, id, "narrative_projection", {
          schemaVersion: NARRATIVE_ANALYSIS_FACT_SCHEMA,
          kind: "plotline_character",
          plotlineId,
          characterId,
        });
        if (fact !== null) facts.push(fact);
      }
      const progress = asRecord(selected.plotline.progress);
      const chapterId = selected.source.snapshot.source.chapterId;
      const progressSequence = safeInteger(progress?.sequence, 0, 1_000_000)
        ? progress.sequence
        : null;
      const progressEventId = safeReference(progress?.eventId);
      const progressSummary = safeText(progress?.summary, 2_000);
      if (
        progressSequence !== null &&
        progressEventId !== null &&
        progressSummary !== null &&
        chapterId !== null
      ) {
        const id = await this.derivedUuid(
          selected.source.snapshot.id,
          `narrative-progress:${plotlineId}:${String(progressSequence)}`,
        );
        const fact = rehydrateProjectedFact(selected.source.snapshot, id, "narrative_projection", {
          schemaVersion: NARRATIVE_ANALYSIS_FACT_SCHEMA,
          kind: "plotline_progress",
          plotlineId,
          chapterId,
          sequence: progressSequence,
          eventId: progressEventId,
          summary: progressSummary,
        });
        if (fact !== null) facts.push(fact);
      }
    }
    return freezeBatch(facts, diagnostics);
  }

  private async loadContinuousFacts(projectIdValue: string): Promise<
    Readonly<{
      facts: readonly StoredContinuousFact[];
      allFactsById: ReadonlyMap<string, StoryFactSnapshot>;
      diagnostics: readonly ContinuousProjectionDiagnostic[];
    }>
  > {
    const projectId = parseDomainUuid(projectIdValue);
    if (!projectId.ok) {
      throw new ContinuousStoryStateProjectionError(
        "CONTINUOUS_PROJECTION_STORAGE_UNAVAILABLE",
        "The project identity for continuous story-state projection is invalid.",
        false,
      );
    }
    const loaded = await this.dependencies.storyFacts.listByProjectId(
      projectId.value as unknown as Parameters<StoryFactStore["listByProjectId"]>[0],
    );
    if (!loaded.ok) {
      throw new ContinuousStoryStateProjectionError(
        "CONTINUOUS_PROJECTION_STORAGE_UNAVAILABLE",
        "Unable to read continuous story-state facts.",
        loaded.error.retryable,
      );
    }
    const facts: StoredContinuousFact[] = [];
    const allFactsById = new Map<string, StoryFactSnapshot>();
    const diagnostics: ContinuousProjectionDiagnostic[] = [];
    for (const fact of loaded.value) {
      const snapshot = fact.toSnapshot();
      allFactsById.set(snapshot.id, snapshot);
      if (!CONTINUOUS_STORY_FACT_TYPES.includes(snapshot.factType as ContinuousStoryFactType)) {
        continue;
      }
      const parsed = parseStoredContinuousFact(fact);
      if (parsed === null) {
        diagnostics.push({
          sourceFactId: snapshot.id,
          area: projectionAreaForFactType(snapshot.factType),
          reason: "schema_missing",
          missingRequirements: Object.freeze([CONTINUOUS_STORY_STATE_SCHEMA]),
        });
      } else {
        facts.push(parsed);
        for (const issue of readProjectionIssues(parsed.record.projectionIssues)) {
          diagnostics.push(
            diagnostic(parsed, projectionAreaForFactType(snapshot.factType), "projection_invalid", [
              issue,
            ]),
          );
        }
      }
    }
    return Object.freeze({
      facts: Object.freeze(facts),
      allFactsById,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  private async verifyEvidence(
    snapshot: StoryFactSnapshot,
    cache: Map<string, Promise<VerifiedEvidence | null>>,
  ): Promise<VerifiedEvidence | null> {
    const source = snapshot.source;
    const reference = CONTINUOUS_REFERENCE_PATTERN.exec(source.reference);
    if (
      source.versionId === null ||
      reference?.[1] !== source.versionId ||
      reference[2] === undefined
    ) {
      return null;
    }
    const verified = await this.verifyChapterEvidence(snapshot, cache);
    return verified !== null && reference[2] === verified.contentHash ? verified : null;
  }

  private async verifyChapterEvidence(
    snapshot: StoryFactSnapshot,
    cache: Map<string, Promise<VerifiedEvidence | null>>,
  ): Promise<VerifiedEvidence | null> {
    const source = snapshot.source;
    if (
      source.kind !== "chapter_span" ||
      source.chapterId === null ||
      source.versionId === null ||
      source.startOffset === null ||
      source.endOffset === null ||
      source.sourceLength === null ||
      source.excerpt === null
    ) {
      return null;
    }
    let pending = cache.get(source.versionId);
    if (pending === undefined) {
      pending = this.loadVersionEvidence(source.versionId);
      cache.set(source.versionId, pending);
    }
    const verified = await pending;
    if (
      verified?.projectId !== snapshot.projectId ||
      verified.chapterId !== source.chapterId ||
      verified.versionId !== source.versionId ||
      source.sourceLength !== verified.content.length ||
      source.startOffset < 0 ||
      source.endOffset <= source.startOffset ||
      source.endOffset > verified.content.length ||
      verified.content.slice(source.startOffset, source.endOffset) !== source.excerpt
    ) {
      return null;
    }
    return verified;
  }

  private async loadVersionEvidence(versionIdValue: string): Promise<VerifiedEvidence | null> {
    const versionId = parseDomainUuid(versionIdValue);
    if (!versionId.ok) return null;
    const loaded = await this.dependencies.chapterVersions.findVersionById(versionId.value);
    if (!loaded.ok || loaded.value === null) return null;
    const snapshot = loaded.value.toSnapshot();
    const hashed = await this.dependencies.hasher.sha256(snapshot.content);
    if (!hashed.ok) {
      throw new ContinuousStoryStateProjectionError(
        "CONTINUOUS_PROJECTION_HASH_UNAVAILABLE",
        "Unable to verify continuous story-state source evidence.",
        hashed.error.retryable,
      );
    }
    if (hashed.value !== snapshot.contentChecksum) return null;
    return Object.freeze({
      projectId: snapshot.projectId,
      chapterId: snapshot.chapterId,
      versionId: snapshot.id,
      contentHash: hashed.value,
      content: snapshot.content,
    });
  }

  private async sourceIsCurrent(snapshot: StoryFactSnapshot): Promise<boolean> {
    const chapterIdValue = snapshot.source.chapterId;
    const versionId = snapshot.source.versionId;
    if (chapterIdValue === null || versionId === null) return false;
    const chapterId = parseDomainUuid(chapterIdValue);
    if (!chapterId.ok) return false;
    const loaded = await this.dependencies.chapters.findById(chapterId.value);
    return (
      loaded.ok && loaded.value !== null && String(loaded.value.currentVersionId) === versionId
    );
  }

  private async derivedUuid(sourceId: string, discriminator: string): Promise<string> {
    const hashed = await this.dependencies.hasher.sha256(`${sourceId}\u0000${discriminator}`);
    if (!hashed.ok || !SHA256_PATTERN.test(hashed.value)) {
      throw new ContinuousStoryStateProjectionError(
        "CONTINUOUS_PROJECTION_HASH_UNAVAILABLE",
        "Unable to derive a stable continuous story-state projection identity.",
        hashed.ok ? false : hashed.error.retryable,
      );
    }
    const compact = sourceId.replaceAll("-", "");
    const value = `${compact.slice(0, 12)}7${hashed.value.slice(0, 3)}8${hashed.value.slice(3, 18)}`;
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
}

function parseStoredContinuousFact(fact: StoryFact): StoredContinuousFact | null {
  const snapshot = fact.toSnapshot();
  const root = asRecord(snapshot.structuredValue);
  if (root === null) return null;
  const rebuildableSystemProjection = root.schemaVersion === REBUILDABLE_SYSTEM_FACT_SCHEMA;
  const record = rebuildableSystemProjection ? asRecord(root.payload) : root;
  if (record?.schemaVersion !== CONTINUOUS_STORY_STATE_SCHEMA) return null;
  const subject = asRecord(record.subject);
  const projection = parsePersistedProjection(record);
  if (subject === null || projection === null) return null;
  return Object.freeze({
    fact,
    snapshot,
    record,
    subject,
    projection,
    rebuildableSystemProjection,
  });
}

function parsePersistedProjection(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  // Transitional support for early v2 development records that were written
  // before the bounded-depth encoding was introduced.
  if (record.projection !== undefined) {
    return record.projection === null ? Object.freeze({}) : asRecord(record.projection);
  }
  if (record.projectionJson === null) return Object.freeze({});
  if (
    typeof record.projectionJson !== "string" ||
    record.projectionJson.length === 0 ||
    record.projectionJson.length > 200_000
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(record.projectionJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function parseValidationProjection(source: StoredContinuousFact): ValidationProjection | null {
  const value = asRecord(source.projection.validation);
  if (
    value === null ||
    !hasExactKeys(value, ["factType", "subjectId", "attributeKey", "value", "effectiveRange"])
  ) {
    return null;
  }
  const factType = CONTINUOUS_VALIDATION_FACT_TYPES.includes(
    value.factType as ContinuousValidationFactType,
  )
    ? (value.factType as ContinuousValidationFactType)
    : null;
  const subjectId = safeReference(value.subjectId);
  const attributeKey = safeReference(value.attributeKey);
  const primitive = primitiveValue(value.value);
  const effectiveRange = effectiveRangeValue(value.effectiveRange);
  const boundSubject = safeReference(source.subject.entityKey);
  if (
    factType === null ||
    subjectId === null ||
    subjectId !== boundSubject ||
    attributeKey === null ||
    primitive === null ||
    effectiveRange === null ||
    !valueMatchesFactType(factType, primitive)
  ) {
    return null;
  }
  return Object.freeze({ factType, subjectId, attributeKey, value: primitive, effectiveRange });
}

function parsePovProjection(source: StoredContinuousFact): PovProjection | null {
  if (source.snapshot.factType !== "pov_knowledge") return null;
  const value = asRecord(source.projection.pov);
  const legacyKeys = [
    "characterId",
    "attributeKey",
    "knowledgeStatus",
    "effectiveRange",
    "mode",
  ] as const;
  const previousKeys = [...legacyKeys, "acquiredAt", "sourceEventId", "sourceFactId"] as const;
  const currentKeys = [...previousKeys, "informationId"] as const;
  const legacy =
    value !== null && (hasExactKeys(value, legacyKeys) || hasExactKeys(value, previousKeys));
  if (value === null || (!legacy && !hasExactKeys(value, currentKeys))) {
    return null;
  }
  const characterId = safeReference(value.characterId);
  const attributeKey = safeReference(value.attributeKey);
  const effectiveRange = effectiveRangeValue(value.effectiveRange);
  const subjectId = safeReference(source.subject.entityKey);
  if (
    characterId === null ||
    characterId !== subjectId ||
    attributeKey === null ||
    effectiveRange === null ||
    !KNOWLEDGE_STATES.includes(value.knowledgeStatus as never) ||
    (value.mode !== "first_person" && value.mode !== "third_person_limited")
  ) {
    return null;
  }
  if (
    !legacy &&
    ((value.acquiredAt !== null && !safeInteger(value.acquiredAt, 0, 1_000_000_000_000)) ||
      (value.sourceEventId !== null && safeReference(value.sourceEventId) === null) ||
      (value.sourceFactId !== null && safeReference(value.sourceFactId) === null) ||
      (value.informationId !== null && safeReference(value.informationId) === null))
  ) {
    return null;
  }
  const acquiredAt = legacy ? null : safeNullableInteger(value.acquiredAt, 0, 1_000_000_000_000);
  const sourceEventId =
    legacy || value.sourceEventId === null ? null : safeReference(value.sourceEventId);
  const sourceFactId =
    legacy || value.sourceFactId === null ? null : safeReference(value.sourceFactId);
  const informationId =
    legacy || value.informationId === null ? null : safeReference(value.informationId);
  const populatedSourceFields = [acquiredAt, sourceEventId, sourceFactId, informationId].filter(
    (item) => item !== null,
  ).length;
  if (
    (!legacy && populatedSourceFields !== 0 && populatedSourceFields !== 4) ||
    (acquiredAt !== null &&
      (acquiredAt < effectiveRange.startOrder ||
        (effectiveRange.endOrder !== null && acquiredAt > effectiveRange.endOrder)))
  ) {
    return null;
  }
  return Object.freeze({
    characterId,
    attributeKey,
    knowledgeStatus: value.knowledgeStatus as PovProjection["knowledgeStatus"],
    effectiveRange,
    mode: value.mode,
    acquiredAt,
    sourceEventId,
    sourceFactId,
    informationId,
    sourceCompleteness: legacy ? "legacy_incomplete" : "declared",
  });
}

function parseVoiceProjection(
  source: StoredContinuousFact,
  content: string,
): VoiceProjection | null {
  const value = asRecord(source.projection.voice);
  const parent = source.snapshot.source;
  if (
    source.snapshot.factType !== "character_voice" ||
    value === null ||
    !hasExactKeys(value, ["characterId", "featureCatalog", "dialogues"]) ||
    parent.startOffset === null ||
    parent.endOffset === null
  ) {
    return null;
  }
  const parentStart = parent.startOffset;
  const parentEnd = parent.endOffset;
  const characterId = safeReference(value.characterId);
  const subjectId = safeReference(source.subject.entityKey);
  const featureCatalog = parseFeatureCatalog(value.featureCatalog);
  if (
    characterId === null ||
    characterId !== subjectId ||
    featureCatalog === null ||
    !Array.isArray(value.dialogues)
  ) {
    return null;
  }
  const dialogues = value.dialogues.flatMap((raw) => {
    const dialogue = asRecord(raw);
    if (
      dialogue === null ||
      !hasExactKeys(dialogue, ["start", "end", "excerpt", "addresseeCharacterId", "typical"]) ||
      !Number.isSafeInteger(dialogue.start) ||
      !Number.isSafeInteger(dialogue.end) ||
      typeof dialogue.start !== "number" ||
      typeof dialogue.end !== "number" ||
      dialogue.start < parentStart ||
      dialogue.end <= dialogue.start ||
      dialogue.end > parentEnd ||
      typeof dialogue.excerpt !== "string" ||
      dialogue.end - dialogue.start !== dialogue.excerpt.length ||
      content.slice(dialogue.start, dialogue.end) !== dialogue.excerpt ||
      typeof dialogue.typical !== "boolean"
    ) {
      return [];
    }
    const addressee =
      dialogue.addresseeCharacterId === null ? null : safeReference(dialogue.addresseeCharacterId);
    if (dialogue.addresseeCharacterId !== null && addressee === null) return [];
    return [
      Object.freeze({
        start: dialogue.start,
        end: dialogue.end,
        excerpt: dialogue.excerpt,
        addresseeCharacterId: addressee,
        typical: dialogue.typical,
      }),
    ];
  });
  return dialogues.length === value.dialogues.length && dialogues.length > 0
    ? Object.freeze({ characterId, featureCatalog, dialogues: Object.freeze(dialogues) })
    : null;
}

function parseFeatureCatalog(value: unknown): Readonly<Record<string, unknown>> | null {
  const record = asRecord(value);
  const keys = [
    "commonTermCandidates",
    "emotionMarkers",
    "politeMarkers",
    "casualMarkers",
    "directMarkers",
    "indirectMarkers",
    "metaphorMarkers",
    "dialectMarkers",
    "addressTerms",
  ] as const;
  if (record === null || !hasExactKeys(record, keys)) return null;
  for (const key of keys.slice(0, -1)) {
    if (readTextArray(record[key], 64, 100) === null) return null;
  }
  if (!Array.isArray(record.addressTerms) || record.addressTerms.length > 32) return null;
  for (const raw of record.addressTerms) {
    const entry = asRecord(raw);
    if (
      entry === null ||
      !hasExactKeys(entry, ["addresseeCharacterId", "terms"]) ||
      safeReference(entry.addresseeCharacterId) === null ||
      readTextArray(entry.terms, 32, 100) === null
    ) {
      return null;
    }
  }
  return record;
}

function parseNarrativeProjection(source: StoredContinuousFact): NarrativeProjection | null {
  const value = asRecord(source.projection.narrative);
  if (
    value === null ||
    !hasExactKeys(value, ["chapterOrder", "scene", "plotline"]) ||
    !safeInteger(value.chapterOrder, 0, 1_000_000_000_000)
  ) {
    return null;
  }
  const scene = value.scene === null ? null : parseNarrativeScene(value.scene);
  const plotline = value.plotline === null ? null : parseNarrativePlotline(value.plotline, source);
  if ((value.scene !== null && scene === null) || (value.plotline !== null && plotline === null)) {
    return null;
  }
  if (scene === null && plotline === null) return null;
  return Object.freeze({ chapterOrder: value.chapterOrder, scene, plotline });
}

function parseNarrativeScene(value: unknown): Readonly<Record<string, unknown>> | null {
  const record = asRecord(value);
  const keys = [
    "sceneId",
    "sequence",
    "goal",
    "conflictIntensity",
    "tension",
    "composition",
    "plotlineIds",
    "characterIds",
    "movesPlot",
    "changesCharacter",
    "functionTags",
    "setupBeatIds",
    "climax",
  ] as const;
  const tension = asRecord(record?.tension);
  const composition = asRecord(record?.composition);
  const climax = asRecord(record?.climax);
  const plotlineIds = readReferenceArray(record?.plotlineIds, 64);
  const characterIds = readReferenceArray(record?.characterIds, 64);
  const setupBeatIds = readReferenceArray(record?.setupBeatIds, 64);
  const requiredSetupBeatIds = readReferenceArray(climax?.requiredSetupBeatIds, 64);
  if (
    record === null ||
    !hasExactKeys(record, keys) ||
    safeReference(record.sceneId) === null ||
    !safeInteger(record.sequence, 0, 1_000_000) ||
    safeText(record.goal, 2_000) === null ||
    !ratio(record.conflictIntensity) ||
    tension === null ||
    !hasExactKeys(tension, ["start", "end", "peak"]) ||
    !ratio(tension.start) ||
    !ratio(tension.end) ||
    !ratio(tension.peak) ||
    tension.peak < tension.start ||
    tension.peak < tension.end ||
    composition === null ||
    !hasExactKeys(composition, [
      "informationRatio",
      "dialogueRatio",
      "descriptionRatio",
      "innerActivityRatio",
      "measuredUnits",
    ]) ||
    !ratio(composition.informationRatio) ||
    !ratio(composition.dialogueRatio) ||
    !ratio(composition.descriptionRatio) ||
    !ratio(composition.innerActivityRatio) ||
    Math.abs(
      composition.informationRatio +
        composition.dialogueRatio +
        composition.descriptionRatio +
        composition.innerActivityRatio -
        1,
    ) > 1e-6 ||
    !safeInteger(composition.measuredUnits, 1, 10_000_000) ||
    plotlineIds === null ||
    characterIds === null ||
    typeof record.movesPlot !== "boolean" ||
    typeof record.changesCharacter !== "boolean" ||
    record.movesPlot !== plotlineIds.length > 0 ||
    record.changesCharacter !== characterIds.length > 0 ||
    readReferenceArray(record.functionTags, 64) === null ||
    setupBeatIds === null ||
    climax === null ||
    !hasExactKeys(climax, ["isClimax", "requiredSetupBeatIds"]) ||
    typeof climax.isClimax !== "boolean" ||
    requiredSetupBeatIds === null ||
    (!climax.isClimax && requiredSetupBeatIds.length > 0)
  ) {
    return null;
  }
  return record;
}

function parseNarrativePlotline(
  value: unknown,
  source: StoredContinuousFact,
): Readonly<Record<string, unknown>> | null {
  const record = asRecord(value);
  if (
    record === null ||
    !hasExactKeys(record, ["plotlineId", "goal", "characterIds", "progress"]) ||
    safeReference(record.plotlineId) !== safeReference(source.subject.entityKey) ||
    safeText(record.goal, 2_000) === null ||
    readReferenceArray(record.characterIds, 64) === null
  ) {
    return null;
  }
  if (record.progress !== null) {
    const progress = asRecord(record.progress);
    if (
      progress === null ||
      !hasExactKeys(progress, ["sequence", "eventId", "summary"]) ||
      !safeInteger(progress.sequence, 0, 1_000_000) ||
      safeReference(progress.eventId) === null ||
      safeText(progress.summary, 2_000) === null
    ) {
      return null;
    }
  }
  return record;
}

function rehydrateProjectedFact(
  source: StoryFactSnapshot,
  id: string,
  factType: string,
  structuredValue: unknown,
): StoryFact | null {
  const safe = createStoryValue(structuredValue);
  if (!safe.ok || safe.value === null) return null;
  const rehydrated = StoryFact.rehydrate({
    ...source,
    id: id as StoryFactSnapshot["id"],
    factType: factType as StoryFactSnapshot["factType"],
    structuredValue: safe.value,
  });
  return rehydrated.ok ? rehydrated.value : null;
}

function causalEvidenceMatchesStoryFact(
  event: CausalEventNode,
  snapshot: StoryFactSnapshot,
  verified: VerifiedEvidence,
): boolean {
  const source = snapshot.source;
  if (
    source.kind !== "chapter_span" ||
    source.chapterId === null ||
    source.versionId === null ||
    source.startOffset === null ||
    source.endOffset === null ||
    source.sourceLength === null ||
    source.excerpt === null
  ) {
    return false;
  }
  const expectedLocator = `${source.reference}#utf16:${String(source.startOffset)}-${String(source.endOffset)}/${String(source.sourceLength)}`;
  const evidence = event.evidence;
  return (
    evidence.chapterId === source.chapterId &&
    evidence.chapterVersionId === source.versionId &&
    evidence.contentHash === verified.contentHash &&
    evidence.locator === expectedLocator &&
    evidence.excerpt === source.excerpt &&
    evidence.startOffset === source.startOffset &&
    evidence.endOffset === source.endOffset &&
    evidence.sourceLength === source.sourceLength
  );
}

function isConfirmedFormal(snapshot: StoryFactSnapshot): boolean {
  return (
    snapshot.status === "formal" &&
    snapshot.userConfirmed &&
    !snapshot.needsReview &&
    !snapshot.deprecated
  );
}

function isCurrentTargetSource(
  snapshot: StoryFactSnapshot,
  request: ContinuousStoryStateProjectionRequest,
): boolean {
  return (
    request.currentVersionId !== null &&
    snapshot.source.chapterId === request.chapterId &&
    snapshot.source.versionId === request.currentVersionId
  );
}

function branchMatches(snapshot: StoryFactSnapshot, branchId: string | null | undefined): boolean {
  return snapshot.branchId === null || snapshot.branchId === (branchId ?? null);
}

function expectsValidationProjection(factType: string): boolean {
  return [
    "character_identity",
    "character_state",
    "relationship_change",
    "world_setting",
    "world_rule",
    "timeline_event",
    "pov_knowledge",
  ].includes(factType);
}

function validationMatchesSourceType(
  sourceFactType: string,
  projected: ContinuousValidationFactType,
): boolean {
  const allowed: Readonly<Record<string, readonly ContinuousValidationFactType[]>> = {
    character_identity: ["character_identity"],
    character_state: [
      "character_life_status",
      "character_age",
      "entity_location",
      "item_ownership",
      "ability_state",
    ],
    relationship_change: ["relationship"],
    world_setting: ["world_property"],
    world_rule: ["world_property"],
    timeline_event: ["event_time", "entity_location"],
    pov_knowledge: ["character_knowledge"],
  };
  return allowed[sourceFactType]?.includes(projected) === true;
}

function valueMatchesFactType(
  factType: ContinuousValidationFactType,
  value: string | number | boolean,
): boolean {
  if (factType === "character_life_status") return value === "alive" || value === "dead";
  if (factType === "character_age") {
    return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000
    );
  }
  if (factType === "character_knowledge") return KNOWLEDGE_STATES.includes(value as never);
  if (["character_identity", "entity_location", "item_ownership"].includes(factType)) {
    return typeof value === "string";
  }
  if (factType === "relationship") return typeof value === "string" || typeof value === "boolean";
  if (factType === "event_time") return typeof value === "string" || typeof value === "number";
  return true;
}

function effectiveRangeValue(
  value: unknown,
): Readonly<{ startOrder: number; endOrder: number | null }> | null {
  const record = asRecord(value);
  if (
    record === null ||
    !hasExactKeys(record, ["startOrder", "endOrder"]) ||
    !safeInteger(record.startOrder, 0, 1_000_000_000_000) ||
    (record.endOrder !== null &&
      !safeInteger(record.endOrder, record.startOrder, 1_000_000_000_000))
  ) {
    return null;
  }
  return Object.freeze({
    startOrder: record.startOrder,
    endOrder: record.endOrder ?? null,
  });
}

function primitiveValue(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  const expected = new Set(keys);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function safeReference(value: unknown): string | null {
  return typeof value === "string" && SAFE_REFERENCE_PATTERN.test(value) ? value : null;
}

function isSafeReference(value: string): boolean {
  return SAFE_REFERENCE_PATTERN.test(value);
}

function safeText(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
    ? value
    : null;
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function safeNullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : safeInteger(value, minimum, maximum) ? value : null;
}

function ratio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readTextArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const parsed = value.map((item) => safeText(item, maximumLength));
  return parsed.some((item) => item === null) ? null : (parsed as readonly string[]);
}

function readReferenceArray(value: unknown, maximumItems = 64): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const parsed = value.map((item) => safeReference(item));
  return parsed.some((item) => item === null) || new Set(parsed).size !== parsed.length
    ? null
    : (parsed as readonly string[]);
}

function readKnowledgeGains(value: unknown):
  | readonly Readonly<{
      readonly characterId: string;
      readonly attributeKey: string;
      readonly informationId: string;
    }>[]
  | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const parsed = value.map((item) => {
    const record = asRecord(item);
    if (
      record === null ||
      !hasExactKeys(record, ["characterId", "attributeKey", "informationId"])
    ) {
      return null;
    }
    const characterId = safeReference(record.characterId);
    const attributeKey = safeReference(record.attributeKey);
    const informationId = safeReference(record.informationId);
    return characterId === null || attributeKey === null || informationId === null
      ? null
      : Object.freeze({ characterId, attributeKey, informationId });
  });
  if (parsed.some((item) => item === null)) return null;
  const complete = parsed as readonly Readonly<{
    readonly characterId: string;
    readonly attributeKey: string;
    readonly informationId: string;
  }>[];
  const signatures = complete.map(
    ({ characterId, attributeKey, informationId }) =>
      `${characterId}\u0000${attributeKey}\u0000${informationId}`,
  );
  return new Set(signatures).size === signatures.length ? Object.freeze([...complete]) : null;
}

function readProjectionIssues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return Object.freeze(
    value.flatMap((item) => {
      const issue = safeText(item, 512);
      return issue === null ? [] : [issue];
    }),
  );
}

function diagnostic(
  source: StoredContinuousFact,
  area: ContinuousProjectionArea,
  reason: ContinuousProjectionDiagnosticReason,
  missingRequirements: readonly string[],
): ContinuousProjectionDiagnostic {
  return Object.freeze({
    sourceFactId: source.snapshot.id,
    area,
    reason,
    missingRequirements: Object.freeze([...missingRequirements]),
  });
}

function projectionAreaForFactType(factType: string): ContinuousProjectionArea {
  if (factType === "character_voice" || factType === "pov_knowledge") return "voice_pov";
  if (factType === "pacing_metric" || factType === "plotline_state") return "narrative";
  return "validation";
}

function freezeBatch(
  facts: readonly StoryFact[],
  diagnostics: readonly ContinuousProjectionDiagnostic[],
): ContinuousProjectedFactBatch {
  return Object.freeze({
    facts: Object.freeze([...facts]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function groupBy<Value>(
  values: readonly Value[],
  keyOf: (value: Value) => string,
): Map<string, Value[]> {
  const grouped = new Map<string, Value[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}

function stableJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(canonicalStoryValue(value));
}

function canonicalStoryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalStoryValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalStoryValue((value as Readonly<Record<string, unknown>>)[key]),
        ]),
    );
  }
  return value;
}
