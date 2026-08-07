import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import type { ChapterVersionSnapshot, UuidV7 } from "@inkshadow/domain";
import {
  buildCharacterVoiceProfile,
  validateNovelConsistency,
  type CharacterDialogueSample,
  type CharacterVoiceFeatureCatalog,
  type CharacterVoiceProfile,
  type DetectCharacterVoiceDeviationInput,
  type NovelCurrentClaim,
  type NovelEvidenceReference,
  type NovelReferenceFact,
  type NovelValidationInput,
  type StoryFact,
  type StoryFactSnapshot,
  type StoryFactStore,
  type StoryValue,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";

import type {
  ContinuousProjectionDiagnostic,
  ContinuousStoryStateProjectionAdapter,
} from "./continuous-story-state-projection-adapter";

/**
 * Voice facts use an explicit schema marker so this adapter never infers a
 * speaker, addressee, or style feature from a fact name or free-form text.
 */
export const CHARACTER_VOICE_EVIDENCE_SCHEMA = "inkshadow.character-voice-evidence.v1";

export const CHARACTER_VOICE_EVIDENCE_ROLES = [
  "voice_feature_catalog",
  "voice_historical_dialogue",
  "voice_current_dialogue",
] as const;

export type CharacterVoiceEvidenceRole = (typeof CHARACTER_VOICE_EVIDENCE_ROLES)[number];

export type CharacterVoicePovEvidenceRole =
  CharacterVoiceEvidenceRole | "pov_current_knowledge_claim" | "pov_confirmed_knowledge";

export const CHARACTER_VOICE_POV_EVIDENCE_SKIP_REASONS = [
  "chapter_not_found",
  "chapter_not_active",
  "chapter_project_mismatch",
  "current_version_not_found",
  "current_version_scope_mismatch",
  "current_version_content_mismatch",
  "current_version_hash_mismatch",
  "fact_project_mismatch",
  "not_user_confirmed_formal",
  "structured_fields_missing",
  "source_not_versioned_chapter_span",
  "evidence_version_not_found",
  "evidence_version_scope_mismatch",
  "evidence_span_mismatch",
  "evidence_hash_mismatch",
  "historical_dialogue_uses_current_version",
  "current_evidence_not_current_version",
  "voice_catalog_missing",
  "voice_catalog_ambiguous",
  "historical_dialogue_insufficient",
  "current_dialogue_insufficient",
  "detector_input_rejected",
  "pov_current_claim_missing",
  "pov_confirmed_knowledge_missing",
] as const;

export type CharacterVoicePovEvidenceSkipReason =
  (typeof CHARACTER_VOICE_POV_EVIDENCE_SKIP_REASONS)[number];

export interface CharacterVoicePovEvidenceDiagnostic {
  readonly source: "chapter" | "story_fact" | "voice_check" | "pov_check";
  readonly factId: string | null;
  readonly factRevision: number | null;
  readonly role: CharacterVoicePovEvidenceRole | null;
  readonly characterId: string | null;
  readonly reason: CharacterVoicePovEvidenceSkipReason;
  readonly missingRequirements: readonly string[];
}

export interface PreparedCharacterVoiceEvidenceCheck {
  readonly status: "ready";
  readonly characterId: string;
  readonly profile: CharacterVoiceProfile;
  readonly input: DetectCharacterVoiceDeviationInput;
  readonly sourceFactIds: Readonly<{
    readonly featureCatalog: string;
    readonly historicalDialogue: readonly string[];
    readonly currentDialogue: readonly string[];
  }>;
}

export interface SkippedCharacterVoiceEvidenceCheck {
  readonly status: "skipped";
  readonly characterId: string;
  readonly reason:
    | "voice_catalog_missing"
    | "voice_catalog_ambiguous"
    | "historical_dialogue_insufficient"
    | "current_dialogue_insufficient"
    | "detector_input_rejected";
  readonly missingRequirements: readonly string[];
}

export type CharacterVoiceEvidenceCheck =
  PreparedCharacterVoiceEvidenceCheck | SkippedCharacterVoiceEvidenceCheck;

export interface PreparedPovKnowledgeEvidenceCheck {
  readonly status: "ready";
  readonly input: NovelValidationInput;
  readonly sourceFactIds: Readonly<{
    readonly currentClaims: readonly string[];
    readonly confirmedKnowledge: readonly string[];
  }>;
}

export interface SkippedPovKnowledgeEvidenceCheck {
  readonly status: "skipped";
  readonly reason:
    "pov_current_claim_missing" | "pov_confirmed_knowledge_missing" | "detector_input_rejected";
  readonly missingRequirements: readonly string[];
}

export type PovKnowledgeEvidenceCheck =
  PreparedPovKnowledgeEvidenceCheck | SkippedPovKnowledgeEvidenceCheck;

export interface CharacterVoicePovEvidencePreparation {
  readonly status: "ready" | "partial" | "skipped";
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly chapterVersionId: UuidV7 | null;
  readonly chapterRevision: number | null;
  readonly currentContentHash: string | null;
  readonly voiceChecks: readonly CharacterVoiceEvidenceCheck[];
  readonly povCheck: PovKnowledgeEvidenceCheck;
  readonly diagnostics: readonly CharacterVoicePovEvidenceDiagnostic[];
  readonly missingRequirements: readonly string[];
  readonly ignoredUnrelatedFactCount: number;
  readonly capabilities: Readonly<{
    readonly evidenceVerification: "immutable_chapter_version_sha256";
    readonly authorityGate: "user_confirmed_formal_only";
    readonly speakerInference: "disabled";
    readonly freeTextFactInference: "disabled";
    readonly modelInvocation: "not_used";
  }>;
}

export interface PrepareCharacterVoicePovEvidenceRequest {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  /** Null means the main story. Global confirmed facts still apply to a branch request. */
  readonly branchId?: string | null;
}

export interface CharacterVoicePovEvidenceAdapterDependencies {
  readonly chapters: Pick<ChapterRepository, "findById">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly storyFacts: Pick<StoryFactStore, "listByProjectId">;
  readonly hasher: ContentHasher;
  readonly continuousProjection?: Pick<
    ContinuousStoryStateProjectionAdapter,
    "projectVoicePovFacts"
  >;
}

export type CharacterVoicePovEvidenceAdapterErrorCode =
  "CHARACTER_EVIDENCE_STORAGE_UNAVAILABLE" | "CHARACTER_EVIDENCE_HASH_UNAVAILABLE";

export class CharacterVoicePovEvidenceAdapterError extends Error {
  public constructor(
    readonly code: CharacterVoicePovEvidenceAdapterErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CharacterVoicePovEvidenceAdapterError";
  }
}

interface ResolvedVersionEvidence {
  readonly version: ChapterVersionSnapshot;
  readonly contentHash: string;
}

type EvidenceResolution =
  | Readonly<{ readonly ok: true; readonly evidence: VoiceAndPovTextEvidence }>
  | Readonly<{
      readonly ok: false;
      readonly reason:
        | "source_not_versioned_chapter_span"
        | "evidence_version_not_found"
        | "evidence_version_scope_mismatch"
        | "evidence_span_mismatch"
        | "evidence_hash_mismatch";
      readonly missingRequirements: readonly string[];
    }>;

interface VoiceAndPovTextEvidence {
  readonly id: string;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

interface VoiceCatalogCandidate {
  readonly snapshot: StoryFactSnapshot;
  readonly characterId: string;
  readonly featureCatalog: CharacterVoiceFeatureCatalog;
}

interface VoiceDialogueCandidate {
  readonly snapshot: StoryFactSnapshot;
  readonly characterId: string;
  readonly sample: CharacterDialogueSample;
}

interface PovCollections {
  readonly currentClaims: NovelCurrentClaim[];
  readonly referenceFacts: NovelReferenceFact[];
  readonly currentFactIds: string[];
  readonly referenceFactIds: string[];
}

interface CollectionState {
  readonly catalogs: Map<string, VoiceCatalogCandidate[]>;
  readonly historicalDialogue: Map<string, VoiceDialogueCandidate[]>;
  readonly currentDialogue: Map<string, VoiceDialogueCandidate[]>;
  readonly pov: PovCollections;
  readonly diagnostics: CharacterVoicePovEvidenceDiagnostic[];
  ignoredUnrelatedFactCount: number;
}

const MINIMUM_CURRENT_DIALOGUE_CHARACTERS = 24;
const MAIN_BRANCH_PROFILE_ID = "main";

/**
 * Converts persisted authority-controlled facts into the exact inputs expected
 * by the deterministic voice and POV validators. It performs no NLP, speaker
 * attribution, name matching, or model calls.
 */
export class CharacterVoicePovEvidenceAdapter {
  public constructor(private readonly dependencies: CharacterVoicePovEvidenceAdapterDependencies) {}

  public async prepare(
    request: PrepareCharacterVoicePovEvidenceRequest,
  ): Promise<CharacterVoicePovEvidencePreparation> {
    const chapterResult = await this.dependencies.chapters.findById(request.chapterId);
    if (!chapterResult.ok) {
      throw storageFailure("Unable to read the chapter for character evidence preparation.");
    }
    if (chapterResult.value === null) {
      return skippedPreparation(request, "chapter_not_found", ["existing_current_chapter"]);
    }
    const chapter = chapterResult.value.toSnapshot();
    if (chapter.projectId !== request.projectId) {
      return skippedPreparation(request, "chapter_project_mismatch", [
        "chapter_owned_by_requested_project",
      ]);
    }
    if (chapter.status !== "active") {
      return skippedPreparation(request, "chapter_not_active", ["active_current_chapter"]);
    }

    const versionCache = new Map<string, Promise<ResolvedVersionEvidence | null>>();
    const currentVersion = await this.resolveVersion(chapter.currentVersionId, versionCache);
    if (currentVersion === null) {
      return skippedPreparation(request, "current_version_not_found", [
        "existing_current_chapter_version",
      ]);
    }
    if (
      currentVersion.version.id !== chapter.currentVersionId ||
      currentVersion.version.projectId !== request.projectId ||
      currentVersion.version.chapterId !== request.chapterId
    ) {
      return skippedPreparation(request, "current_version_scope_mismatch", [
        "current_version_owned_by_requested_project_and_chapter",
      ]);
    }
    if (currentVersion.version.content !== chapter.content) {
      return skippedPreparation(request, "current_version_content_mismatch", [
        "chapter_content_identical_to_current_immutable_version",
      ]);
    }
    if (currentVersion.contentHash !== currentVersion.version.contentChecksum) {
      return skippedPreparation(request, "current_version_hash_mismatch", [
        "verified_current_version_sha256",
      ]);
    }

    const factsResult = await this.dependencies.storyFacts.listByProjectId(
      request.projectId as unknown as StoryUuidV7,
    );
    if (!factsResult.ok) {
      throw storageFailure("Unable to read story facts for character evidence preparation.");
    }

    const state: CollectionState = {
      catalogs: new Map(),
      historicalDialogue: new Map(),
      currentDialogue: new Map(),
      pov: {
        currentClaims: [],
        referenceFacts: [],
        currentFactIds: [],
        referenceFactIds: [],
      },
      diagnostics: [],
      ignoredUnrelatedFactCount: 0,
    };
    for (const fact of factsResult.value) {
      if (
        this.dependencies.continuousProjection !== undefined &&
        isContinuousExtractionSource(fact.toSnapshot())
      ) {
        continue;
      }
      await this.collectFact(fact, request, chapter.currentVersionId, versionCache, state);
    }
    if (this.dependencies.continuousProjection !== undefined) {
      try {
        const projected = await this.dependencies.continuousProjection.projectVoicePovFacts({
          projectId: request.projectId,
          chapterId: request.chapterId,
          currentVersionId: chapter.currentVersionId,
          ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
        });
        state.diagnostics.push(...projected.diagnostics.map(continuousProjectionDiagnostic));
        for (const fact of projected.facts) {
          await this.collectFact(fact, request, chapter.currentVersionId, versionCache, state);
        }
      } catch {
        state.diagnostics.push(
          diagnostic("story_fact", null, null, null, null, "structured_fields_missing", [
            "verified_continuous_story_state_projection_available",
          ]),
        );
      }
    }

    const voiceChecks = this.prepareVoiceChecks(request, state);
    const povCheck = this.preparePovCheck(state);
    const readyVoiceCount = voiceChecks.filter(({ status }) => status === "ready").length;
    const readySubsystemCount = Number(readyVoiceCount > 0) + Number(povCheck.status === "ready");
    const missingRequirements = [
      ...(readyVoiceCount === 0
        ? ["evidence_backed_voice_catalog_historical_dialogue_and_current_dialogue"]
        : []),
      ...(povCheck.status === "skipped"
        ? ["explicit_current_pov_claim_and_confirmed_character_knowledge"]
        : []),
    ];
    return freezePreparation({
      status:
        readySubsystemCount === 2 ? "ready" : readySubsystemCount === 1 ? "partial" : "skipped",
      projectId: request.projectId,
      chapterId: request.chapterId,
      chapterVersionId: chapter.currentVersionId,
      chapterRevision: chapter.revision,
      currentContentHash: currentVersion.contentHash,
      voiceChecks,
      povCheck,
      diagnostics: state.diagnostics,
      missingRequirements,
      ignoredUnrelatedFactCount: state.ignoredUnrelatedFactCount,
    });
  }

  private async collectFact(
    fact: StoryFact,
    request: PrepareCharacterVoicePovEvidenceRequest,
    currentVersionId: UuidV7,
    versionCache: Map<string, Promise<ResolvedVersionEvidence | null>>,
    state: CollectionState,
  ): Promise<void> {
    const snapshot = fact.toSnapshot();
    const voiceRole = explicitVoiceRole(snapshot.structuredValue);
    const isKnowledgeFact = snapshot.factType === "character_knowledge";
    const knowledgeRole = isKnowledgeFact ? explicitKnowledgeRole(snapshot) : null;
    if (voiceRole === null && !isKnowledgeFact) {
      state.ignoredUnrelatedFactCount += 1;
      return;
    }
    const role = voiceRole ?? knowledgeRole;
    if (!idsEqual(snapshot.projectId, request.projectId)) {
      state.diagnostics.push(
        factDiagnostic(snapshot, role, null, "fact_project_mismatch", [
          "fact_owned_by_requested_project",
        ]),
      );
      return;
    }
    if (
      snapshot.status !== "formal" ||
      !snapshot.userConfirmed ||
      snapshot.needsReview ||
      snapshot.deprecated
    ) {
      state.diagnostics.push(
        factDiagnostic(
          snapshot,
          role,
          structuredCharacterId(snapshot),
          "not_user_confirmed_formal",
          ["active_user_confirmed_formal_story_fact"],
        ),
      );
      return;
    }
    if (voiceRole === null && knowledgeRole === null) {
      state.diagnostics.push(
        factDiagnostic(
          snapshot,
          null,
          structuredCharacterId(snapshot),
          "structured_fields_missing",
          ["validationRole_current_claim_or_reference_fact"],
        ),
      );
      return;
    }

    if (voiceRole === "voice_feature_catalog") {
      this.collectVoiceCatalog(snapshot, state);
      return;
    }

    const evidence = await this.resolveFactEvidence(snapshot, versionCache);
    if (!evidence.ok) {
      state.diagnostics.push(
        factDiagnostic(
          snapshot,
          role,
          structuredCharacterId(snapshot),
          evidence.reason,
          evidence.missingRequirements,
        ),
      );
      return;
    }

    if (voiceRole !== null) {
      this.collectVoiceDialogue(
        snapshot,
        voiceRole,
        request,
        currentVersionId,
        evidence.evidence,
        state,
      );
      return;
    }
    this.collectKnowledgeFact(
      snapshot,
      knowledgeRole,
      request,
      currentVersionId,
      evidence.evidence,
      state,
    );
  }

  private collectVoiceCatalog(snapshot: StoryFactSnapshot, state: CollectionState): void {
    const structured = snapshot.structuredValue;
    if (
      !isRecord(structured) ||
      !isSafeReference(structured.characterId) ||
      !isRecord(structured.featureCatalog)
    ) {
      state.diagnostics.push(
        factDiagnostic(snapshot, "voice_feature_catalog", null, "structured_fields_missing", [
          "characterId_and_complete_featureCatalog",
        ]),
      );
      return;
    }
    appendGrouped(state.catalogs, structured.characterId, {
      snapshot,
      characterId: structured.characterId,
      featureCatalog: structured.featureCatalog as unknown as CharacterVoiceFeatureCatalog,
    });
  }

  private collectVoiceDialogue(
    snapshot: StoryFactSnapshot,
    role: Exclude<CharacterVoiceEvidenceRole, "voice_feature_catalog">,
    request: PrepareCharacterVoicePovEvidenceRequest,
    currentVersionId: UuidV7,
    evidence: VoiceAndPovTextEvidence,
    state: CollectionState,
  ): void {
    const structured = snapshot.structuredValue;
    if (
      !isRecord(structured) ||
      !isSafeReference(structured.characterId) ||
      !isNullableSafeReference(structured.addresseeCharacterId) ||
      typeof structured.typical !== "boolean"
    ) {
      state.diagnostics.push(
        factDiagnostic(
          snapshot,
          role,
          structuredCharacterId(snapshot),
          "structured_fields_missing",
          ["characterId_addresseeCharacterId_and_typical"],
        ),
      );
      return;
    }
    if (role === "voice_historical_dialogue" && evidence.chapterVersionId === currentVersionId) {
      state.diagnostics.push(
        factDiagnostic(
          snapshot,
          role,
          structured.characterId,
          "historical_dialogue_uses_current_version",
          ["historical_dialogue_from_an_earlier_immutable_version"],
        ),
      );
      return;
    }
    if (
      role === "voice_current_dialogue" &&
      (evidence.chapterVersionId !== currentVersionId || evidence.chapterId !== request.chapterId)
    ) {
      state.diagnostics.push(
        factDiagnostic(
          snapshot,
          role,
          structured.characterId,
          "current_evidence_not_current_version",
          ["dialogue_span_from_selected_current_chapter_version"],
        ),
      );
      return;
    }
    const sample = Object.freeze({
      id: `${role}:${snapshot.id}:r${String(snapshot.revision)}`,
      projectId: request.projectId,
      branchId: profileBranchId(request.branchId),
      characterId: structured.characterId,
      addresseeCharacterId: structured.addresseeCharacterId,
      text: evidence.excerpt,
      typical: structured.typical,
      evidence: toCharacterVoiceEvidence(snapshot, evidence),
    });
    appendGrouped(
      role === "voice_historical_dialogue" ? state.historicalDialogue : state.currentDialogue,
      structured.characterId,
      { snapshot, characterId: structured.characterId, sample },
    );
  }

  private collectKnowledgeFact(
    snapshot: StoryFactSnapshot,
    role: "pov_current_knowledge_claim" | "pov_confirmed_knowledge" | null,
    request: PrepareCharacterVoicePovEvidenceRequest,
    currentVersionId: UuidV7,
    evidence: VoiceAndPovTextEvidence,
    state: CollectionState,
  ): void {
    if (role === null || !isRecord(snapshot.structuredValue)) {
      state.diagnostics.push(
        factDiagnostic(snapshot, role, null, "structured_fields_missing", [
          "explicit_validationRole_and_structured_character_knowledge_fields",
        ]),
      );
      return;
    }
    const structured = snapshot.structuredValue;
    if (role === "pov_current_knowledge_claim") {
      if (
        evidence.chapterVersionId !== currentVersionId ||
        evidence.chapterId !== request.chapterId
      ) {
        state.diagnostics.push(
          factDiagnostic(
            snapshot,
            role,
            structuredCharacterId(snapshot),
            "current_evidence_not_current_version",
            ["knowledge_claim_span_from_selected_current_chapter_version"],
          ),
        );
        return;
      }
      const claim = {
        id: `pov-current:${snapshot.id}:r${String(snapshot.revision)}`,
        factType: "character_knowledge",
        subjectId: structured.subjectId,
        attributeKey: structured.attributeKey,
        branchId: request.branchId ?? null,
        effectiveRange: structured.effectiveRange,
        value: structured.value,
        evidence: [toNovelEvidence(evidence)],
        basis: structured.basis,
        claimText: evidence.excerpt,
        povContext: structured.povContext,
      } as unknown as NovelCurrentClaim;
      if (!isValidPovClaim(claim)) {
        state.diagnostics.push(
          factDiagnostic(
            snapshot,
            role,
            structuredCharacterId(snapshot),
            "detector_input_rejected",
            ["explicit_character_knowledge_claim_with_matching_first_or_limited_pov"],
          ),
        );
        return;
      }
      state.pov.currentClaims.push(claim);
      state.pov.currentFactIds.push(snapshot.id);
      return;
    }

    const reference = {
      id: `pov-reference:${snapshot.id}:r${String(snapshot.revision)}`,
      factType: "character_knowledge",
      subjectId: structured.subjectId,
      attributeKey: structured.attributeKey,
      branchId: snapshot.branchId,
      effectiveRange: structured.effectiveRange,
      value: structured.value,
      evidence: [toNovelEvidence(evidence)],
      status: "confirmed",
      factText: snapshot.contentText ?? evidence.excerpt,
    } as unknown as NovelReferenceFact;
    if (!isValidPovReference(reference)) {
      state.diagnostics.push(
        factDiagnostic(snapshot, role, structuredCharacterId(snapshot), "detector_input_rejected", [
          "valid_confirmed_character_knowledge_state_and_effective_range",
        ]),
      );
      return;
    }
    state.pov.referenceFacts.push(reference);
    state.pov.referenceFactIds.push(snapshot.id);
  }

  private prepareVoiceChecks(
    request: PrepareCharacterVoicePovEvidenceRequest,
    state: CollectionState,
  ): readonly CharacterVoiceEvidenceCheck[] {
    const characterIds = new Set([
      ...state.catalogs.keys(),
      ...state.historicalDialogue.keys(),
      ...state.currentDialogue.keys(),
    ]);
    const checks: CharacterVoiceEvidenceCheck[] = [];
    for (const characterId of [...characterIds].sort()) {
      const catalogs = state.catalogs.get(characterId) ?? [];
      const historical = state.historicalDialogue.get(characterId) ?? [];
      const current = state.currentDialogue.get(characterId) ?? [];
      if (catalogs.length === 0) {
        checks.push(
          this.skippedVoiceCheck(state, characterId, "voice_catalog_missing", [
            "one_user_confirmed_formal_voice_feature_catalog",
          ]),
        );
        continue;
      }
      if (catalogs.length > 1) {
        checks.push(
          this.skippedVoiceCheck(state, characterId, "voice_catalog_ambiguous", [
            "exactly_one_active_voice_feature_catalog",
          ]),
        );
        continue;
      }
      const catalog = catalogs[0];
      if (catalog === undefined) {
        continue;
      }
      let profile: CharacterVoiceProfile;
      try {
        profile = buildCharacterVoiceProfile({
          id: `voice-profile:${catalog.snapshot.id}:r${String(catalog.snapshot.revision)}`,
          projectId: request.projectId,
          branchId: profileBranchId(request.branchId),
          characterId,
          historicalDialogue: historical.map(({ sample }) => sample),
          featureCatalog: catalog.featureCatalog,
        });
      } catch {
        checks.push(
          this.skippedVoiceCheck(state, characterId, "detector_input_rejected", [
            "valid_explicit_feature_catalog_and_dialogue_metadata",
          ]),
        );
        continue;
      }
      if (profile.evidenceReadiness.status !== "ready") {
        checks.push(
          this.skippedVoiceCheck(state, characterId, "historical_dialogue_insufficient", [
            `${String(profile.evidenceReadiness.minimumSampleCount)}_evidence_backed_samples`,
            `${String(profile.evidenceReadiness.minimumCharacterCount)}_evidence_backed_characters`,
          ]),
        );
        continue;
      }
      const currentDialogue = current.map(({ sample }) => sample);
      if (
        currentDialogue.length === 0 ||
        visibleCharacterCount(currentDialogue.map(({ text }) => text).join("\n")) <
          MINIMUM_CURRENT_DIALOGUE_CHARACTERS
      ) {
        checks.push(
          this.skippedVoiceCheck(state, characterId, "current_dialogue_insufficient", [
            `${String(MINIMUM_CURRENT_DIALOGUE_CHARACTERS)}_current_evidence_backed_characters`,
          ]),
        );
        continue;
      }
      const input = Object.freeze({ profile, currentDialogue: Object.freeze(currentDialogue) });
      checks.push(
        Object.freeze({
          status: "ready",
          characterId,
          profile,
          input,
          sourceFactIds: Object.freeze({
            featureCatalog: catalog.snapshot.id,
            historicalDialogue: Object.freeze(historical.map(({ snapshot }) => snapshot.id).sort()),
            currentDialogue: Object.freeze(current.map(({ snapshot }) => snapshot.id).sort()),
          }),
        }),
      );
    }
    return Object.freeze(checks);
  }

  private skippedVoiceCheck(
    state: CollectionState,
    characterId: string,
    reason: SkippedCharacterVoiceEvidenceCheck["reason"],
    missingRequirements: readonly string[],
  ): SkippedCharacterVoiceEvidenceCheck {
    state.diagnostics.push(
      diagnostic("voice_check", null, null, null, characterId, reason, missingRequirements),
    );
    return Object.freeze({
      status: "skipped",
      characterId,
      reason,
      missingRequirements: Object.freeze([...missingRequirements]),
    });
  }

  private preparePovCheck(state: CollectionState): PovKnowledgeEvidenceCheck {
    if (state.pov.currentClaims.length === 0) {
      const missingRequirements = ["explicit_current_version_character_knowledge_claim"];
      state.diagnostics.push(
        diagnostic(
          "pov_check",
          null,
          null,
          null,
          null,
          "pov_current_claim_missing",
          missingRequirements,
        ),
      );
      return Object.freeze({
        status: "skipped",
        reason: "pov_current_claim_missing",
        missingRequirements: Object.freeze(missingRequirements),
      });
    }
    if (state.pov.referenceFacts.length === 0) {
      const missingRequirements = ["user_confirmed_formal_character_knowledge_fact"];
      state.diagnostics.push(
        diagnostic(
          "pov_check",
          null,
          null,
          null,
          null,
          "pov_confirmed_knowledge_missing",
          missingRequirements,
        ),
      );
      return Object.freeze({
        status: "skipped",
        reason: "pov_confirmed_knowledge_missing",
        missingRequirements: Object.freeze(missingRequirements),
      });
    }
    const input: NovelValidationInput = Object.freeze({
      currentClaims: Object.freeze([...state.pov.currentClaims]),
      referenceFacts: Object.freeze([...state.pov.referenceFacts]),
      hardRules: Object.freeze([]),
    });
    try {
      validateNovelConsistency(input);
    } catch {
      const missingRequirements = ["validator_accepted_character_knowledge_input"];
      state.diagnostics.push(
        diagnostic(
          "pov_check",
          null,
          null,
          null,
          null,
          "detector_input_rejected",
          missingRequirements,
        ),
      );
      return Object.freeze({
        status: "skipped",
        reason: "detector_input_rejected",
        missingRequirements: Object.freeze(missingRequirements),
      });
    }
    return Object.freeze({
      status: "ready",
      input,
      sourceFactIds: Object.freeze({
        currentClaims: Object.freeze([...state.pov.currentFactIds].sort()),
        confirmedKnowledge: Object.freeze([...state.pov.referenceFactIds].sort()),
      }),
    });
  }

  private async resolveFactEvidence(
    snapshot: StoryFactSnapshot,
    versionCache: Map<string, Promise<ResolvedVersionEvidence | null>>,
  ): Promise<EvidenceResolution> {
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
      return evidenceFailure("source_not_versioned_chapter_span", [
        "complete_chapter_version_span",
      ]);
    }
    const resolved = await this.resolveVersion(source.versionId, versionCache);
    if (resolved === null) {
      return evidenceFailure("evidence_version_not_found", ["existing_immutable_source_version"]);
    }
    if (
      !idsEqual(resolved.version.projectId, snapshot.projectId) ||
      !idsEqual(resolved.version.chapterId, source.chapterId) ||
      !idsEqual(resolved.version.id, source.versionId)
    ) {
      return evidenceFailure("evidence_version_scope_mismatch", [
        "source_version_owned_by_fact_project_and_source_chapter",
      ]);
    }
    if (
      resolved.version.content.length !== source.sourceLength ||
      resolved.version.content.slice(source.startOffset, source.endOffset) !== source.excerpt
    ) {
      return evidenceFailure("evidence_span_mismatch", [
        "exact_excerpt_offsets_in_immutable_source_version",
      ]);
    }
    if (resolved.contentHash !== resolved.version.contentChecksum) {
      return evidenceFailure("evidence_hash_mismatch", ["verified_source_version_sha256"]);
    }
    return Object.freeze({
      ok: true,
      evidence: Object.freeze({
        id: `story-fact:${snapshot.id}:r${String(snapshot.revision)}`,
        chapterId: source.chapterId,
        chapterVersionId: source.versionId,
        contentHash: resolved.contentHash,
        locator: source.reference,
        excerpt: source.excerpt,
        startOffset: source.startOffset,
        endOffset: source.endOffset,
        sourceLength: source.sourceLength,
      }),
    });
  }

  private resolveVersion(
    versionId: string,
    cache: Map<string, Promise<ResolvedVersionEvidence | null>>,
  ): Promise<ResolvedVersionEvidence | null> {
    const cached = cache.get(versionId);
    if (cached !== undefined) {
      return cached;
    }
    const loading = this.loadVersion(versionId);
    cache.set(versionId, loading);
    return loading;
  }

  private async loadVersion(versionId: string): Promise<ResolvedVersionEvidence | null> {
    const versionResult = await this.dependencies.chapterVersions.findVersionById(
      versionId as UuidV7,
    );
    if (!versionResult.ok) {
      throw storageFailure("Unable to read a chapter version used as character evidence.");
    }
    if (versionResult.value === null) {
      return null;
    }
    const version = versionResult.value.toSnapshot();
    const hashResult = await this.dependencies.hasher.sha256(version.content);
    if (!hashResult.ok) {
      throw new CharacterVoicePovEvidenceAdapterError(
        "CHARACTER_EVIDENCE_HASH_UNAVAILABLE",
        "Unable to hash an immutable chapter version used as character evidence.",
        true,
      );
    }
    return Object.freeze({ version, contentHash: hashResult.value });
  }
}

function explicitVoiceRole(value: StoryValue | null): CharacterVoiceEvidenceRole | null {
  if (
    !isRecord(value) ||
    value.characterEvidenceSchema !== CHARACTER_VOICE_EVIDENCE_SCHEMA ||
    !CHARACTER_VOICE_EVIDENCE_ROLES.includes(
      value.characterEvidenceRole as CharacterVoiceEvidenceRole,
    )
  ) {
    return null;
  }
  return value.characterEvidenceRole as CharacterVoiceEvidenceRole;
}

function explicitKnowledgeRole(
  snapshot: StoryFactSnapshot,
): "pov_current_knowledge_claim" | "pov_confirmed_knowledge" | null {
  if (snapshot.factType !== "character_knowledge" || !isRecord(snapshot.structuredValue)) {
    return null;
  }
  return snapshot.structuredValue.validationRole === "current_claim"
    ? "pov_current_knowledge_claim"
    : snapshot.structuredValue.validationRole === "reference_fact"
      ? "pov_confirmed_knowledge"
      : null;
}

function structuredCharacterId(snapshot: StoryFactSnapshot): string | null {
  const value = snapshot.structuredValue;
  if (!isRecord(value)) {
    return null;
  }
  if (isSafeReference(value.characterId)) {
    return value.characterId;
  }
  return isSafeReference(value.subjectId) ? value.subjectId : null;
}

function isValidPovClaim(claim: NovelCurrentClaim): boolean {
  try {
    const result = validateNovelConsistency({
      currentClaims: [claim],
      referenceFacts: [],
      hardRules: [],
    });
    return result.skippedChecks.length === 0;
  } catch {
    return false;
  }
}

function isValidPovReference(fact: NovelReferenceFact): boolean {
  try {
    const result = validateNovelConsistency({
      currentClaims: [],
      referenceFacts: [fact],
      hardRules: [],
    });
    return result.skippedChecks.length === 0;
  } catch {
    return false;
  }
}

function toCharacterVoiceEvidence(
  snapshot: StoryFactSnapshot,
  evidence: VoiceAndPovTextEvidence,
): VoiceAndPovTextEvidence {
  return Object.freeze({
    ...evidence,
    id: `story-fact:${snapshot.id}:r${String(snapshot.revision)}`,
  });
}

function toNovelEvidence(evidence: VoiceAndPovTextEvidence): NovelEvidenceReference {
  return Object.freeze({
    sourceKind: "chapter",
    sourceId: evidence.chapterId,
    sourceVersionId: evidence.chapterVersionId,
    contentHash: evidence.contentHash,
    locator: evidence.locator,
    excerpt: evidence.excerpt,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
    sourceLength: evidence.sourceLength,
  });
}

function factDiagnostic(
  snapshot: StoryFactSnapshot,
  role: CharacterVoicePovEvidenceRole | null,
  characterId: string | null,
  reason: CharacterVoicePovEvidenceSkipReason,
  missingRequirements: readonly string[],
): CharacterVoicePovEvidenceDiagnostic {
  return diagnostic(
    "story_fact",
    snapshot.id,
    snapshot.revision,
    role,
    characterId,
    reason,
    missingRequirements,
  );
}

function isContinuousExtractionSource(snapshot: StoryFactSnapshot): boolean {
  return snapshot.source.reference.startsWith("continuous-story-state:");
}

function continuousProjectionDiagnostic(
  value: ContinuousProjectionDiagnostic,
): CharacterVoicePovEvidenceDiagnostic {
  const reason: CharacterVoicePovEvidenceSkipReason =
    value.reason === "human_confirmation_required"
      ? "not_user_confirmed_formal"
      : value.reason === "current_version_required"
        ? "current_evidence_not_current_version"
        : value.reason === "evidence_invalid"
          ? "evidence_span_mismatch"
          : "structured_fields_missing";
  return diagnostic(
    "story_fact",
    value.sourceFactId,
    null,
    null,
    null,
    reason,
    value.missingRequirements,
  );
}

function diagnostic(
  source: CharacterVoicePovEvidenceDiagnostic["source"],
  factId: string | null,
  factRevision: number | null,
  role: CharacterVoicePovEvidenceRole | null,
  characterId: string | null,
  reason: CharacterVoicePovEvidenceSkipReason,
  missingRequirements: readonly string[],
): CharacterVoicePovEvidenceDiagnostic {
  return Object.freeze({
    source,
    factId,
    factRevision,
    role,
    characterId,
    reason,
    missingRequirements: Object.freeze([...missingRequirements]),
  });
}

function evidenceFailure(
  reason: Extract<
    CharacterVoicePovEvidenceSkipReason,
    | "source_not_versioned_chapter_span"
    | "evidence_version_not_found"
    | "evidence_version_scope_mismatch"
    | "evidence_span_mismatch"
    | "evidence_hash_mismatch"
  >,
  missingRequirements: readonly string[],
): EvidenceResolution {
  return Object.freeze({
    ok: false,
    reason,
    missingRequirements: Object.freeze([...missingRequirements]),
  });
}

function skippedPreparation(
  request: PrepareCharacterVoicePovEvidenceRequest,
  reason: Extract<
    CharacterVoicePovEvidenceSkipReason,
    | "chapter_not_found"
    | "chapter_not_active"
    | "chapter_project_mismatch"
    | "current_version_not_found"
    | "current_version_scope_mismatch"
    | "current_version_content_mismatch"
    | "current_version_hash_mismatch"
  >,
  missingRequirements: readonly string[],
): CharacterVoicePovEvidencePreparation {
  return freezePreparation({
    status: "skipped",
    projectId: request.projectId,
    chapterId: request.chapterId,
    chapterVersionId: null,
    chapterRevision: null,
    currentContentHash: null,
    voiceChecks: [],
    povCheck: Object.freeze({
      status: "skipped",
      reason: "pov_current_claim_missing",
      missingRequirements: Object.freeze(["verified_current_chapter_version"]),
    }),
    diagnostics: [diagnostic("chapter", null, null, null, null, reason, missingRequirements)],
    missingRequirements: [
      ...missingRequirements,
      "evidence_backed_voice_catalog_historical_dialogue_and_current_dialogue",
      "explicit_current_pov_claim_and_confirmed_character_knowledge",
    ],
    ignoredUnrelatedFactCount: 0,
  });
}

function freezePreparation(
  input: Omit<CharacterVoicePovEvidencePreparation, "capabilities">,
): CharacterVoicePovEvidencePreparation {
  return Object.freeze({
    ...input,
    voiceChecks: Object.freeze([...input.voiceChecks]),
    diagnostics: Object.freeze([...input.diagnostics].sort(compareDiagnostics)),
    missingRequirements: Object.freeze([...new Set(input.missingRequirements)]),
    capabilities: Object.freeze({
      evidenceVerification: "immutable_chapter_version_sha256",
      authorityGate: "user_confirmed_formal_only",
      speakerInference: "disabled",
      freeTextFactInference: "disabled",
      modelInvocation: "not_used",
    }),
  });
}

function appendGrouped<Value>(map: Map<string, Value[]>, key: string, value: Value): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function profileBranchId(branchId: string | null | undefined): string {
  return branchId ?? MAIN_BRANCH_PROFILE_ID;
}

function visibleCharacterCount(value: string): number {
  return Array.from(value.normalize("NFC")).filter((character) => !/\s/u.test(character)).length;
}

function isSafeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isNullableSafeReference(value: unknown): value is string | null {
  return value === null || isSafeReference(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idsEqual(left: string, right: string): boolean {
  return left === right;
}

function compareDiagnostics(
  left: CharacterVoicePovEvidenceDiagnostic,
  right: CharacterVoicePovEvidenceDiagnostic,
): number {
  return (
    left.source.localeCompare(right.source) ||
    (left.characterId ?? "").localeCompare(right.characterId ?? "") ||
    (left.factId ?? "").localeCompare(right.factId ?? "") ||
    left.reason.localeCompare(right.reason)
  );
}

function storageFailure(message: string): CharacterVoicePovEvidenceAdapterError {
  return new CharacterVoicePovEvidenceAdapterError(
    "CHARACTER_EVIDENCE_STORAGE_UNAVAILABLE",
    message,
    true,
  );
}
