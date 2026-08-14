import {
  AcceptAiCandidate,
  ArchiveProject,
  CreateChapter,
  CreateProject,
  EditChapter,
  ImportProject,
  ListChapterVersions,
  ListProjects,
  RejectAiCandidate,
  ReviseAiCandidate,
  RenameProject,
  RestoreChapterVersion,
  RestoreProject,
  SaveChapter,
  SetChapterPrivacy,
  TrashProject,
  UnarchiveProject,
  type AiCandidateRepository,
  type ChapterRepository,
  type ChapterPrivacyRepository,
  type ChapterVersionRepository,
  type ContentCommitRepository,
  type ContentHasher,
  type ProjectRepository,
  type ProjectImportCommitRepository,
  type RecoveryDraftRepository,
} from "@inkshadow/application";
import {
  CONSERVATIVE_GENERATION_CONTEXT_POLICY,
  estimateGenerationCost,
  combineContinuationFragments,
  recoverVisiblePartialOutput,
  rerankWithLocalEvidence,
  resolveContinuationOutputContract,
  resolveDynamicContextBudget,
  resolveModelRoute,
  runGenerationPreflight,
  type ContextCandidateDraft,
  type CandidateQualityGateResult,
  type GenerationPreflightSnapshot,
  type ModelPricing,
  type ModelRouteCandidate,
  type ModelRouteRole,
  type ContinuationOutputContract,
  type ContinuationOutputProfileId,
  type ContextBudgetProfileId,
  type DynamicContextBudget,
} from "@inkshadow/ai-core";
import { CloudMarketplaceClient, InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import { DEFAULT_FEATURE_FLAGS, resolveFeatureFlags, type FeatureFlags } from "@inkshadow/config";
import {
  AiCandidate,
  AppError,
  err,
  ok,
  parseUuidV7 as parseDomainUuid,
  type Clock,
  type Chapter,
  type Result,
  type ProjectSeedStore,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import {
  CloudDeletionJournalSqliteStore,
  DatabaseMaintenanceService,
  GovernedCreativeExtensionSqliteStore,
  MultiAgentReviewSqliteStore,
  ProjectSeedSqliteStore,
  SearchVectorSqliteStore,
  TauriSqliteExecutor,
  createSqliteRepositories,
  type DatabaseBackupReceipt,
  type DatabaseIntegrityReport,
  type DatabaseRestoreReceipt,
  type NativePathTicket,
  type NativePathTicketReceipt,
  type SqlExecutor,
} from "@inkshadow/data";
import type { AccessSqliteStore } from "@inkshadow/data/access-sqlite-store";
import type { ProjectKeySqliteStore } from "@inkshadow/data/project-key-sqlite-store";
import type { SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import { CryptoContentHasher, CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import type { HybridSearchHit } from "@inkshadow/search-core";
import {
  FormalRecordApplicationService,
  IdeationApplicationService,
  MaterialApplicationService,
  MemoryApplicationService,
  OutlineApplicationService,
  ReviewDecisionService,
  ReviewIntakeService,
  SqliteChapterVersionReader,
  SqliteFormalStoryRecordRepository,
  SqliteIdeationDraftRepository,
  SqliteMaterialDispositionUnitOfWork,
  SqliteMaterialReferenceRepository,
  SqliteMaterialRepository,
  SqliteMemoryPolicyRepository,
  SqliteMemoryGovernanceUnitOfWork,
  SqliteMemoryRecordCreationUnitOfWork,
  SqliteMemoryRecordRepository,
  SqliteOutlineDraftReader,
  SqliteOutlineRepository,
  SqliteReviewDecisionUnitOfWork,
  SqliteReviewItemRepository,
  SqliteStoryFactStore,
  SqliteWhatIfPromotionUnitOfWork,
  SqliteWhatIfRepository,
  StoryFactApplicationService,
  StoryCoreError,
  WhatIfApplicationService,
  err as storyErr,
  ok as storyOk,
  parseSafeIdentifier as parseStoryIdentifier,
  parseUuidV7 as parseStoryUuid,
  validateAuthoritativeExtractionProvenance,
  type AuthoritativeExtractionProvenance,
  type ChapterVersionReader,
  type CurrentChapterVersion,
  type FormalStoryRecordListReader,
  type FormalStoryRecordRepository,
  type FormalTimelineReader,
  type IdeationDraftRepository,
  type IdeationProjectCommitUnitOfWork,
  type MaterialDispositionUnitOfWork,
  type MaterialReferenceRepository,
  type MaterialRepository,
  type MemoryPolicyRepository,
  type MemoryGovernanceUnitOfWork,
  type MemoryRecordCreationUnitOfWork,
  type MemoryRecordListReader,
  type MemoryRecordRepository,
  type OutlineDraftReader,
  type OutlineRepository,
  type Result as StoryResult,
  type ReviewDecisionUnitOfWork,
  type ReviewItemListReader,
  type ReviewItemRepository,
  type StoryFactStore,
  type WhatIfBranchListReader,
  type WhatIfPromotionUnitOfWork,
  type WhatIfRepository,
} from "@inkshadow/story-core";
import { TaskEngineError } from "@inkshadow/task-engine";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { createDevelopmentRepositories } from "./development-storage";
import {
  BrowserCreativeJourneyStore,
  SqliteCreativeJourneyStore,
  type CreativeJourneyStore,
} from "./creative-journey-store";
import { BrowserProjectSeedStore, backfillLegacyProjectSeeds } from "./project-seed-local-store";
import { selectProjectSeedContextCandidates } from "./project-seed-context-adapter";
import {
  BrowserDevelopmentContextCompilationTraceStore,
  SqliteContextCompilationTraceStore,
  createContextCompilationTrace,
  type ContextCompilationTraceStore,
} from "./context-compilation-trace-store";
import {
  BrowserDevelopmentContextTraceOutputCommitUnitOfWork,
  SqliteContextTraceOutputCommitUnitOfWork,
  type ContextTraceOutputCommitUnitOfWork,
} from "./context-trace-output-commit";
import {
  BrowserDevelopmentChapterValidationSnapshotStore,
  ChapterValidationSnapshotService,
  SqliteChapterValidationSnapshotStore,
  type ChapterValidationSnapshotStore,
} from "./chapter-validation-snapshot-store";
import { createIdempotentAsyncCloser } from "./desktop-close-coordinator";
import {
  createTauriAutomaticBackupRuntime,
  type AutomaticBackupRuntime,
} from "./automatic-backup-runtime";
import { AcceptedChapterPipelineWorker } from "./accepted-chapter-pipeline-worker";
import {
  createAcceptedChapterPipelineTaskInput,
  createLocalCandidateAcceptancePipelineInput,
} from "./accepted-chapter-pipeline";
import { HistoricalChapterBackfillService } from "./historical-chapter-backfill-service";
import { StorySettingsImportService } from "./story-settings-import-service";
import { CloudAiUsageService, type CloudAiUsageRuntimePort } from "./cloud-ai-usage-service";
import { CloudAccountManagementService } from "./cloud-account-management-service";
import { CloudDeletionLifecycleService } from "./cloud-deletion-lifecycle-service";
import { CloudIdentityService } from "./cloud-identity-service";
import { CloudProjectKeyCoordinator } from "./cloud-project-key-coordinator";
import type { CloudProjectSyncEnrollmentService } from "./cloud-project-sync-enrollment-service";
import { CloudSessionCoordinator } from "./cloud-session-coordinator";
import {
  CloudTeamWorkspaceService,
  type CloudTeamWorkspacePort,
} from "./cloud-team-workspace-service";
import {
  CloudTeamProjectKeyEnvelopeCoordinator,
  type CloudTeamProjectKeyEnvelopePort,
} from "./cloud-team-project-key-envelope-coordinator";
import { TauriCloudSessionVault, type CloudEndpoint } from "./cloud-session-vault";
import {
  createCloudProjectSyncEnrollmentService,
  createCloudSyncControlService,
  createCloudSyncRuntimeService,
  createCloudSyncSupervisor,
  createSyncConflictResolutionCoordinator,
} from "./cloud-sync-runtime-wiring";
import type { CloudSyncControlService } from "./cloud-sync-control-service";
import type { CloudSyncRuntimeService } from "./cloud-sync-runtime-service";
import type { CloudSyncSupervisor } from "./cloud-sync-supervisor";
import {
  BrowserDevelopmentGenerationGovernanceStore,
  GenerationGovernanceError,
  TauriGenerationGovernanceStore,
  type DeferredGenerationRequest,
  type GenerationAttemptUsageInput,
  type GenerationGovernanceStore,
} from "./generation-governance-store";
import {
  DEFAULT_NOVEL_SKILL_TOKEN_BUDGET,
  createNovelSkillRuntime,
  type NovelSkillRuntimePort,
  type PreparedNovelSkillInvocation,
} from "./novel-skill-runtime";
import { NovelSkillSqliteStore } from "./novel-skill-sqlite-store";
import {
  createLazyNovelSkillPaidEvaluationCoordinator,
  createUnavailableNovelSkillPaidEvaluationCoordinator,
} from "./novel-skill-paid-evaluation-lazy-coordinator";
import type { NovelSkillPaidEvaluationCoordinatorPort } from "./novel-skill-paid-evaluation-coordinator";
import {
  recordSafeGenerationErrorCode,
  recordSafeGenerationPreflightDiagnostic,
  recordSafeGenerationPreflightFailureDiagnostic,
  recordSafeInvocationRouteDiagnostic,
} from "./generation-preflight-diagnostics";
import {
  createAuthoritativeExtractionDesktopRuntime,
  type AuthoritativeExtractionDesktopPort,
} from "./authoritative-extraction-runtime";
import { GovernedCreativeExtensionsRuntime } from "./governed-creative-extensions-runtime";
import {
  BrowserDevelopmentMaterialDispositionUnitOfWork,
  BrowserDevelopmentMaterialReferenceRepository,
  BrowserDevelopmentMaterialRepository,
} from "./material-storage";
import {
  BrowserDevelopmentModelCenterStore,
  ModelCenterError,
  TauriModelCenterStore,
  type ModelCenterStore,
  type ModelCenterFailureDiagnostics,
  type ModelProfile,
} from "./model-center-store";
import {
  isNativeGenerationTopP,
  isNativeGatewayProviderKind,
  type NativeGatewayEndpointConfig,
  type NativeModelDispatchScope,
  type NativeGatewayProviderKind,
} from "./native-model-gateway-contract";
import {
  BrowserDevelopmentModelRoutingStore,
  TauriModelRoutingStore,
  type ModelRoutingStore,
} from "./model-routing-store";
import {
  BrowserDevelopmentModelHubStore,
  TauriModelHubStore,
  type ModelHubStore,
} from "./model-hub-store";
import { bridgeLegacyModelProfilesToModelHub } from "./model-hub-legacy-bridge";
import { recoverModelHubCredentialCommits } from "./model-hub-credential-commit-recovery";
import {
  executeModelHubTextTask,
  inspectModelHubTextTask,
  ModelHubExecutionError,
  type ModelHubTextTaskExecutionResult,
  type ModelHubTextTaskInspection,
} from "./model-hub-execution-service";
import {
  getModelProviderPreset,
  isLoopbackModelBaseUrl,
  modelProviderKindForOfficialEndpoint,
  modelProviderVisibleProsePolicy,
} from "./model-hub-provider-registry";
import {
  resolveFinalModelProfileGatewayConfig,
  resolveModelProfileGatewayConfig,
  type ModelProfileGatewayConfigResolution,
} from "./model-profile-gateway-config";
import {
  compileStoryContextForGeneration,
  formatStoryContextPrompt,
  StoryContextRuntimeError,
  type StoryContextCompilationReceipt,
} from "./story-context-runtime";
import {
  MultiAgentReviewRuntime,
  SqliteMultiAgentReviewContextReader,
} from "./multi-agent-review-runtime";
import {
  NativeGovernedCreativeExtensionGateway,
  resolveConfiguredGovernedCreativeExtensionRoute,
} from "./native-governed-creative-extension-gateway";
import { resolveConfiguredAuthoritativeExtractionProvider } from "./native-authoritative-extraction-provider";
import type {
  NativeEmbeddingGatewayClient,
  NativeEmbeddingInput,
  NativeEmbeddingResult,
} from "./native-embedding-gateway";
import type {
  NativeRerankGatewayClient,
  NativeRerankInput,
  NativeRerankResult,
} from "./native-rerank-gateway";
import { LocalProjectSearchService, type ProjectSearchService } from "./project-search";
import {
  ProjectContextPrivacyAuthority,
  ProjectContextPrivacyError,
  projectContextDispatchScope,
  projectContextRequiredDataDestination,
  type ProjectContextPrivacyReceipt,
} from "./project-context-privacy-authority";
import {
  BrowserDevelopmentProjectSearchSnapshotStore,
  TauriProjectSearchSnapshotStore,
  type ProjectSearchSnapshotStore,
} from "./project-search-store";
import { PersistentProjectEmbeddingService } from "./project-search-vector-service";
import {
  BrowserDevelopmentProjectKeyVault,
  TauriProjectKeyVault,
  type ProjectKeyVault,
} from "./project-key-vault";
import { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import { TauriCloudTransport } from "./tauri-cloud-transport";
import { SqliteUsageCenterService, type UsageCenterReader } from "./usage-center-service";
import {
  BrowserDevelopmentIdeationDraftRepository,
  BrowserDevelopmentFormalStoryRecordRepository,
  BrowserDevelopmentMemoryPolicyRepository,
  BrowserDevelopmentMemoryGovernanceUnitOfWork,
  BrowserDevelopmentMemoryRecordCreationUnitOfWork,
  BrowserDevelopmentMemoryRecordRepository,
  BrowserDevelopmentOutlineDraftReader,
  BrowserDevelopmentOutlineRepository,
  BrowserDevelopmentReviewDecisionUnitOfWork,
  BrowserDevelopmentReviewItemRepository,
  BrowserDevelopmentWhatIfPromotionUnitOfWork,
  BrowserDevelopmentWhatIfRepository,
} from "./story-storage";
import { BrowserDevelopmentStoryFactStore } from "./story-fact-store";
import {
  BrowserDevelopmentCausalEventGraphStore,
  SqliteCausalEventGraphStore,
  type CausalChapterVersionSource,
  type CausalEvidenceReader,
  type CausalEventGraphStore,
} from "./causal-event-graph-store";
import { selectCausalContextCandidates } from "./causal-context-adapter";
import { CausalStoryFactProjector } from "./causal-story-fact-projector";
import { CausalWhatIfSimulationService } from "./causal-what-if-simulation-service";
import { ModelHubCausalWhatIfModelPort } from "./model-hub-causal-what-if-model";
import { ContinuousStoryStateExtractionService } from "./continuous-story-state-extraction";
import { ContinuousStoryStateProjectionAdapter } from "./continuous-story-state-projection-adapter";
import { ModelHubContinuousStoryStateModel } from "./model-hub-continuous-story-state-model";
import {
  BrowserChapterSummaryPreferenceStore,
  ChapterSummaryService,
} from "./chapter-summary-service";
import { ModelHubChapterSummaryModel } from "./model-hub-chapter-summary-model";
import { ModelHubImageGenerationService } from "./model-hub-image-generation-service";
import {
  mergeRemoteRerankWithLocalFallback,
  ModelHubRerankService,
} from "./model-hub-rerank-service";
import { ModelHubStoryPlanningService } from "./model-hub-story-planning-service";
import {
  BrowserDevelopmentStoryPlanningCandidateStore,
  SqliteStoryPlanningCandidateStore,
  type StoryPlanningCandidateStore,
} from "./story-planning-candidate-store";
import {
  TauriNativeImageGenerationGateway,
  UnavailableNativeImageGenerationGateway,
} from "./native-image-generation-gateway";
import { evaluateGeneratedCandidateQuality } from "./candidate-quality-evaluator";
import { ChapterNarrativeAnalysisRuntime } from "./narrative-analysis-runtime";
import { ChapterNovelValidationRuntime } from "./novel-validation-runtime";
import { RecomputedChapterSupplementalFindingVerifier } from "./chapter-supplemental-finding-verifier";
import { CharacterVoicePovEvidenceAdapter } from "./character-voice-pov-evidence-adapter";
import { ChapterCharacterVoicePovRuntime } from "./chapter-character-voice-pov-runtime";
import { AmbiguousNovelReviewService } from "./ambiguous-novel-review-service";
import { WritingFeedbackLearningService } from "./writing-feedback-learning-service";
import {
  BrowserDevelopmentWritingFeedbackStore,
  SqliteWritingFeedbackStore,
  type WritingFeedbackStore,
} from "./writing-feedback-store";
import { selectWritingPreferenceContextCandidates } from "./writing-preference-context-adapter";
import { BrowserDevelopmentIdeationProjectCommitUnitOfWork } from "./development-ideation-project-commit";
import { SqliteIdeationProjectCommitUnitOfWork } from "./ideation-project-commit";
import {
  BrowserDevelopmentTaskCenterStore,
  TauriTaskCenterStore,
  type TaskCenterStore,
} from "./task-center-store";
import { createStudioReviewRuntime, type StudioReviewRuntime } from "./studio-review-runtime";
import {
  createStudioTeamTemplateRuntime,
  type StudioTeamTemplateRuntime,
} from "./studio-team-template-runtime";
import { createSqliteStoryGraphRuntime, type StoryGraphRuntimePort } from "./story-graph-runtime";
import type { SyncConflictResolutionCoordinator } from "./sync-conflict-resolution-coordinator";
import {
  BrowserDevelopmentSecureUpdater,
  TauriSecureUpdater,
  type SecureUpdaterPort,
} from "./secure-updater";
import {
  createFineTuningDesktopRuntime,
  type FineTuningDesktopPort,
} from "./fine-tuning-governance-runtime";
import {
  BrowserMarketplaceInstallStore,
  InMemoryMarketplaceInstallStore,
  MarketplaceRuntime,
  SqliteMarketplaceInstallStore,
  createUnavailableMarketplaceCloudGateway,
} from "./marketplace-runtime";

export { normalizeUiError } from "./ui-error";

export type RuntimeMode = "tauri" | "browser-development";

export interface CandidateStore extends AiCandidateRepository {
  create(candidate: AiCandidate): Promise<Result<void, AppError>>;
  listByChapterId(chapterId: UuidV7): Promise<Result<readonly AiCandidate[], AppError>>;
}

export interface RuntimeRepositories {
  readonly projects: ProjectRepository;
  readonly chapters: ChapterRepository;
  readonly chapterPrivacy: ChapterPrivacyRepository;
  readonly chapterVersions: ChapterVersionRepository;
  readonly recoveryDrafts: RecoveryDraftRepository;
  readonly aiCandidates: CandidateStore;
  readonly contentCommits: ContentCommitRepository;
  readonly projectImports: ProjectImportCommitRepository;
}

export interface RuntimeUseCases {
  readonly createProject: CreateProject;
  readonly listProjects: ListProjects;
  readonly archiveProject: ArchiveProject;
  readonly renameProject: RenameProject;
  readonly unarchiveProject: UnarchiveProject;
  readonly trashProject: TrashProject;
  readonly restoreProject: RestoreProject;
  readonly createChapter: CreateChapter;
  readonly importProject: ImportProject;
  readonly editChapter: EditChapter;
  readonly saveChapter: SaveChapter;
  readonly setChapterPrivacy: SetChapterPrivacy;
  readonly listChapterVersions: ListChapterVersions;
  readonly restoreChapterVersion: RestoreChapterVersion;
  readonly acceptCandidate: AcceptAiCandidate;
  readonly reviseCandidate: ReviseAiCandidate;
  readonly rejectCandidate: RejectAiCandidate;
}

export interface SecretSummary {
  readonly configured: boolean;
  readonly lastFour: string | null;
}

export interface CredentialStore {
  getSummary(providerId: string): Promise<SecretSummary>;
  save(providerId: string, secret: string): Promise<SecretSummary>;
  delete(providerId: string): Promise<SecretSummary>;
}

export interface RuntimeMaintenance {
  inspect(): Promise<Result<DatabaseIntegrityReport, AppError>>;
  chooseBackupDestination(): Promise<NativePathTicket | null>;
  choosePreRestoreBackupDestination(): Promise<NativePathTicket | null>;
  chooseRestoreSource(): Promise<NativePathTicket | null>;
  createConsistentBackup(
    destinationTicket: NativePathTicket,
  ): Promise<Result<DatabaseBackupReceipt, AppError>>;
  restoreConsistentBackup(
    sourceTicket: NativePathTicket,
  ): Promise<Result<DatabaseRestoreReceipt, AppError>>;
}

export interface NativeMaintenanceExecutor extends SqlExecutor {
  chooseBackupDestination(): Promise<NativePathTicketReceipt | null>;
  choosePreRestoreBackupDestination(): Promise<NativePathTicketReceipt | null>;
  chooseRestoreSource(): Promise<NativePathTicketReceipt | null>;
}

export interface RuntimeInformation {
  readonly appVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly environment: "development" | "production";
}

export type NativeModelEndpointConfig = NativeGatewayEndpointConfig;

export interface NativeModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly sizeBytes?: number | null;
}

export interface NativeModelListResponse {
  readonly provider: NativeGatewayProviderKind;
  readonly models: readonly NativeModelDescriptor[];
}

export interface NativeModelConnectionResponse {
  readonly provider: NativeGatewayProviderKind;
  readonly endpointOrigin: string;
  readonly modelCount: number;
  readonly latencyMs: number;
}

export interface NativeCapacityMetric {
  readonly status: "measured" | "unavailable";
  readonly totalBytes: number | null;
  readonly availableBytes: number | null;
  readonly reason: string | null;
}

export interface NativeModelCapacityResponse {
  readonly logicalCpuCount: number;
  readonly physicalMemory: NativeCapacityMetric;
  readonly applicationDataDisk: NativeCapacityMetric;
  readonly gpuMemory: NativeCapacityMetric;
}

export interface NativeModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface NativeModelGenerationInput {
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
  readonly messages: readonly NativeModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly reasoningMode?: "disabled";
  /** OpenAI-compatible JSON mode. Callers still validate the returned JSON locally. */
  readonly responseFormat?: "json_object";
  readonly dispatchScope: NativeModelDispatchScope;
  readonly onDelta?: (accumulatedText: string) => void;
}

export interface NativeModelGenerationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
}

export interface NativeModelGenerationResult {
  readonly text: string;
  readonly usage: NativeModelGenerationUsage | null;
  /** Authoritative native transport observation; absent only in legacy test doubles. */
  readonly streamed?: boolean;
}

export interface NativeModelGatewayClient extends NativeEmbeddingGatewayClient {
  readonly available: boolean;
  listModels(config: NativeModelEndpointConfig): Promise<NativeModelListResponse>;
  checkConnection(config: NativeModelEndpointConfig): Promise<NativeModelConnectionResponse>;
  inspectCapacity?(): Promise<NativeModelCapacityResponse>;
  generate(input: NativeModelGenerationInput): Promise<NativeModelGenerationResult>;
  cancelGeneration(generationId: string): Promise<boolean>;
  readonly rerank?: NativeRerankGatewayClient["rerank"];
}

export interface RuntimeStory {
  readonly facts: StoryFactStore;
  readonly factService: StoryFactApplicationService;
  readonly chapterValidation: ChapterNovelValidationRuntime;
  readonly chapterValidationSnapshots: ChapterValidationSnapshotService;
  readonly characterVoicePov: ChapterCharacterVoicePovRuntime;
  readonly ambiguousReview: AmbiguousNovelReviewService;
  readonly continuousState: ContinuousStoryStateExtractionService;
  readonly continuousProjection: ContinuousStoryStateProjectionAdapter;
  readonly chapterSummaries: ChapterSummaryService;
  readonly historicalBackfill: HistoricalChapterBackfillService;
  readonly narrativeAnalysis: ChapterNarrativeAnalysisRuntime;
  readonly causalGraph: CausalEventGraphStore;
  readonly causalProjector: CausalStoryFactProjector;
  readonly causalWhatIf: CausalWhatIfSimulationService;
  readonly writingFeedback: WritingFeedbackLearningService;
  readonly ideationDrafts: IdeationDraftRepository;
  readonly ideationService: IdeationApplicationService;
  readonly outlines: OutlineRepository;
  readonly outlineService: OutlineApplicationService;
  readonly storyPlanning: ModelHubStoryPlanningService;
  readonly formalRecords: FormalStoryRecordRepository &
    FormalStoryRecordListReader &
    FormalTimelineReader;
  readonly formalRecordService: FormalRecordApplicationService;
  readonly memoryPolicies: MemoryPolicyRepository;
  readonly memoryRecords: MemoryRecordRepository & MemoryRecordListReader;
  readonly memoryService: MemoryApplicationService;
  readonly whatIfBranches: WhatIfRepository & WhatIfBranchListReader;
  readonly outlineDrafts: OutlineDraftReader;
  readonly whatIfService: WhatIfApplicationService;
  readonly extractionItems: ReviewItemRepository<"extraction"> & ReviewItemListReader<"extraction">;
  readonly consistencyItems: ReviewItemRepository<"consistency"> &
    ReviewItemListReader<"consistency">;
  readonly extractionIntake: ReviewIntakeService<"extraction">;
  readonly consistencyIntake: ReviewIntakeService<"consistency">;
  readonly extractionDecisions: ReviewDecisionService<"extraction">;
  readonly consistencyDecisions: ReviewDecisionService<"consistency">;
  readonly materials: MaterialRepository;
  readonly materialReferences: MaterialReferenceRepository;
  readonly materialService: MaterialApplicationService;
  readonly actorId: UuidV7;
}

export interface RuntimeCloudFoundation {
  readonly sync: SyncSqliteStore;
  readonly access: AccessSqliteStore;
  readonly projectKeys: ProjectKeySqliteStore;
}

export interface DesktopRuntime {
  readonly mode: RuntimeMode;
  readonly repositories: RuntimeRepositories;
  readonly useCases: RuntimeUseCases;
  readonly taskCenter: TaskCenterStore;
  readonly generationGovernance: GenerationGovernanceStore;
  readonly usageCenter: UsageCenterReader | null;
  readonly modelCenter: ModelCenterStore;
  readonly modelRouting: ModelRoutingStore;
  readonly modelHub: ModelHubStore;
  readonly modelGateway: NativeModelGatewayClient;
  readonly imageGeneration: ModelHubImageGenerationService;
  readonly rerank: ModelHubRerankService;
  readonly creativeJourneys: CreativeJourneyStore;
  readonly projectSeeds: ProjectSeedStore;
  readonly storySettingsImport: StorySettingsImportService | null;
  readonly contextTraces: ContextCompilationTraceStore;
  readonly contextTraceOutputs: ContextTraceOutputCommitUnitOfWork;
  readonly novelSkills: NovelSkillRuntimePort;
  readonly novelSkillPaidEvaluation: NovelSkillPaidEvaluationCoordinatorPort;
  readonly projectContextPrivacy: ProjectContextPrivacyAuthority;
  readonly multiAgentReview: MultiAgentReviewRuntime | null;
  readonly governedCreativeExtensions: GovernedCreativeExtensionsRuntime | null;
  readonly projectKeyVault: ProjectKeyVault;
  readonly projectSecurity: ProjectKeyLifecycleService | null;
  readonly story: RuntimeStory;
  readonly search: ProjectSearchService;
  readonly cloudFoundation: RuntimeCloudFoundation | null;
  readonly cloudIdentity: CloudIdentityService | null;
  readonly cloudSession: CloudSessionCoordinator | null;
  readonly cloudTeams?: CloudTeamWorkspacePort | null;
  readonly cloudAiUsage?: CloudAiUsageRuntimePort | null;
  readonly cloudTeamProjectKeys: CloudTeamProjectKeyEnvelopePort | null;
  readonly cloudAccount: CloudAccountManagementService | null;
  readonly cloudDeletion: CloudDeletionLifecycleService | null;
  readonly cloudProjectKeys: CloudProjectKeyCoordinator | null;
  readonly cloudSync: CloudSyncRuntimeService | null;
  readonly cloudSyncEnrollment: CloudProjectSyncEnrollmentService | null;
  readonly cloudSyncControl: CloudSyncControlService | null;
  readonly syncConflictResolution: SyncConflictResolutionCoordinator | null;
  readonly cloudSyncSupervisor: CloudSyncSupervisor | null;
  readonly studioReview: StudioReviewRuntime | null;
  readonly studioTeamTemplates: StudioTeamTemplateRuntime | null;
  readonly storyGraph: StoryGraphRuntimePort | null;
  readonly authoritativeExtraction: AuthoritativeExtractionDesktopPort | null;
  readonly featureFlags: Readonly<FeatureFlags>;
  readonly credentials: CredentialStore;
  readonly maintenance: RuntimeMaintenance | null;
  readonly automaticBackup: AutomaticBackupRuntime | null;
  readonly secureUpdater?: SecureUpdaterPort;
  readonly fineTuningGovernance?: FineTuningDesktopPort | null;
  readonly marketplace: MarketplaceRuntime;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
  readonly hasher: ContentHasher;
  getRuntimeInformation(): Promise<RuntimeInformation>;
  close(): Promise<void>;
}

class TauriCredentialStore implements CredentialStore {
  getSummary(providerId: string): Promise<SecretSummary> {
    return invoke<SecretSummary>("get_model_secret_summary", { providerId });
  }

  save(providerId: string, secret: string): Promise<SecretSummary> {
    return invoke<SecretSummary>("save_model_secret", { providerId, secret });
  }

  delete(providerId: string): Promise<SecretSummary> {
    return invoke<SecretSummary>("delete_model_secret", { providerId });
  }
}

class BrowserDevelopmentCredentialStore implements CredentialStore {
  getSummary(): Promise<SecretSummary> {
    return Promise.resolve({ configured: false, lastFour: null });
  }

  save(): Promise<SecretSummary> {
    return Promise.reject(new Error("浏览器开发模式不接受模型密钥。"));
  }

  delete(): Promise<SecretSummary> {
    return Promise.resolve({ configured: false, lastFour: null });
  }
}

type NativeGenerationStatus =
  | Readonly<{ phase: "started" }>
  | Readonly<{ phase: "delta" }>
  | Readonly<{
      phase: "completed";
      usage: NativeModelGenerationUsage | null;
      streamed?: boolean;
    }>
  | Readonly<{ phase: "cancelled" }>
  | Readonly<{
      phase: "failed";
      code: string;
      retryable: boolean;
      requestId?: string;
      httpStatus?: number | null;
      finishReason?: string | null;
      reasoningPresent?: boolean | null;
      stream?: boolean | null;
      usage?: NativeModelGenerationUsage | null;
    }>;

interface NativeGenerationEvent {
  readonly generationId: string;
  readonly sequence: number;
  readonly delta: string;
  readonly status: NativeGenerationStatus;
}

export class TauriNativeModelGatewayClient implements NativeModelGatewayClient {
  public readonly available = true;

  public async listModels(config: NativeModelEndpointConfig): Promise<NativeModelListResponse> {
    try {
      const response = await invoke<unknown>("list_native_models", {
        request: { config },
      });
      return validateNativeModelListResponse(response, config);
    } catch (cause) {
      throw normalizeNativeModelGatewayError(cause);
    }
  }

  public async checkConnection(
    config: NativeModelEndpointConfig,
  ): Promise<NativeModelConnectionResponse> {
    try {
      const response = await invoke<unknown>("check_native_model_connection", {
        request: { config },
      });
      return validateNativeModelConnectionResponse(response, config);
    } catch (cause) {
      throw normalizeNativeModelGatewayError(cause);
    }
  }

  public inspectCapacity(): Promise<NativeModelCapacityResponse> {
    return invoke<NativeModelCapacityResponse>("inspect_native_model_capacity");
  }

  public async embed(input: NativeEmbeddingInput): Promise<NativeEmbeddingResult> {
    if (input.config.provider === "anthropic") {
      throw new ModelCenterError(
        "MODEL_OPERATION_UNSUPPORTED",
        "Anthropic Claude does not provide an embedding API. Choose an embedding-capable provider such as Gemini or Ollama.",
      );
    }
    try {
      const result = await invoke<NativeEmbeddingResult>("embed_native_model", {
        request: {
          config: input.config,
          model: input.model,
          inputs: input.inputs,
          dispatchScope: input.dispatchScope,
        },
      });
      return validateNativeEmbeddingResult(result, input);
    } catch (cause) {
      throw normalizeNativeModelGatewayError(cause);
    }
  }

  public async rerank(input: NativeRerankInput): Promise<NativeRerankResult> {
    if (input.config.provider !== "open_ai_compatible") {
      throw new ModelCenterError(
        "MODEL_OPERATION_UNSUPPORTED",
        "The native gateway supports reranking only through the explicit Alibaba Qwen protocol.",
      );
    }
    try {
      const result = await invoke<unknown>("rerank_native_model", {
        request: {
          config: input.config,
          protocol: input.protocol,
          model: input.model,
          query: input.query,
          documents: input.documents,
          topN: input.topN,
          dispatchScope: input.dispatchScope,
        },
      });
      return validateNativeRerankResult(result, input);
    } catch (cause) {
      throw normalizeNativeModelGatewayError(cause);
    }
  }

  public generate(input: NativeModelGenerationInput): Promise<NativeModelGenerationResult> {
    if (input.topP !== undefined && !isNativeGenerationTopP(input.topP)) {
      return Promise.reject(
        new ModelCenterError(
          "MODEL_REQUEST_INVALID",
          "Nucleus sampling topP must be a finite number between 0 and 1.",
        ),
      );
    }
    if (
      input.config.provider === "anthropic" &&
      input.temperature !== undefined &&
      input.temperature !== 1
    ) {
      return Promise.reject(
        new ModelCenterError(
          "MODEL_OPERATION_UNSUPPORTED",
          "Current Claude models accept only the provider default temperature. Remove the temperature setting or use 1.0.",
        ),
      );
    }
    const includeTemperature =
      input.config.provider !== "anthropic" && input.temperature !== undefined;
    return new Promise<NativeModelGenerationResult>((resolve, reject) => {
      let unlisten: UnlistenFn | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let lastSequence = -1;
      let accumulated = "";

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        unlisten?.();
      };
      const fail = (cause: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(normalizeNativeModelGatewayError(cause));
      };
      const complete = (
        usage: NativeModelGenerationUsage | null,
        streamed: boolean | undefined,
      ) => {
        if (settled) {
          return;
        }
        if (accumulated.trim().length === 0) {
          fail(
            new ModelCenterError(
              "MODEL_OUTPUT_EMPTY",
              "The model completed without producing candidate text.",
            ),
          );
          return;
        }
        let validatedUsage: NativeModelGenerationUsage | null;
        try {
          validatedUsage = usage === null ? null : validateNativeGenerationUsage(usage);
        } catch {
          fail(
            new ModelCenterError(
              "MODEL_USAGE_INVALID",
              "The provider returned invalid token usage metadata.",
            ),
          );
          return;
        }
        settled = true;
        cleanup();
        resolve(
          Object.freeze({
            text: accumulated,
            usage: validatedUsage,
            ...(streamed === undefined ? {} : { streamed }),
          }),
        );
      };

      void (async () => {
        unlisten = await listen<NativeGenerationEvent>("model-generation-event", ({ payload }) => {
          if (payload.generationId !== input.generationId || settled) {
            return;
          }
          if (!Number.isSafeInteger(payload.sequence) || payload.sequence !== lastSequence + 1) {
            void this.cancelGeneration(input.generationId).catch(() => undefined);
            fail(
              new ModelCenterError(
                "MODEL_EVENT_SEQUENCE_INVALID",
                "Native model events arrived out of order.",
              ),
            );
            return;
          }
          lastSequence = payload.sequence;
          switch (payload.status.phase) {
            case "started":
              return;
            case "delta":
              accumulated += payload.delta;
              input.onDelta?.(accumulated);
              return;
            case "completed":
              complete(payload.status.usage, payload.status.streamed);
              return;
            case "cancelled":
              fail(
                new ModelCenterError(
                  "MODEL_GENERATION_CANCELLED",
                  "Model generation was cancelled.",
                  true,
                ),
              );
              return;
            case "failed":
              fail(
                new ModelCenterError(
                  payload.status.code,
                  "Native model generation failed.",
                  payload.status.retryable,
                  nativeFailureDiagnostics(payload.status, accumulated.length),
                ),
              );
          }
        });
        timeoutId = setTimeout(() => {
          void this.cancelGeneration(input.generationId).catch(() => undefined);
          fail(
            new ModelCenterError(
              "MODEL_TIMEOUT",
              "Native model generation exceeded the desktop time limit.",
              true,
            ),
          );
        }, 620_000);
        const accepted = await invoke<{
          readonly generationId: string;
          readonly accepted: boolean;
        }>("start_native_generation", {
          request: {
            generationId: input.generationId,
            config: input.config,
            model: input.model,
            messages: input.messages,
            maxOutputTokens: input.maxOutputTokens,
            ...(includeTemperature ? { temperature: input.temperature } : {}),
            ...(input.topP === undefined ? {} : { topP: input.topP }),
            ...(input.reasoningMode === undefined ? {} : { reasoningMode: input.reasoningMode }),
            ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
            dispatchScope: input.dispatchScope,
          },
        });
        if (accepted.generationId !== input.generationId || !accepted.accepted) {
          fail(
            new ModelCenterError(
              "MODEL_GENERATION_NOT_ACCEPTED",
              "Native model generation was not accepted.",
            ),
          );
        }
      })().catch(fail);
    });
  }

  public async cancelGeneration(generationId: string): Promise<boolean> {
    const response = await invoke<{
      readonly generationId: string;
      readonly cancellationRequested: boolean;
    }>("cancel_native_generation", {
      request: { generationId },
    });
    return response.generationId === generationId && response.cancellationRequested;
  }
}

class BrowserDevelopmentModelGatewayClient implements NativeModelGatewayClient {
  public readonly available = false;

  public listModels(): Promise<NativeModelListResponse> {
    return Promise.reject(
      new ModelCenterError(
        "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
        "Native model discovery is available only in the Tauri desktop app.",
      ),
    );
  }

  public checkConnection(): Promise<NativeModelConnectionResponse> {
    return Promise.reject(
      new ModelCenterError(
        "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
        "Native model connection checks are available only in the Tauri desktop app.",
      ),
    );
  }

  public generate(): Promise<NativeModelGenerationResult> {
    return Promise.reject(
      new ModelCenterError(
        "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
        "Native model generation is available only in the Tauri desktop app.",
      ),
    );
  }

  public embed(): Promise<NativeEmbeddingResult> {
    return Promise.reject(
      new ModelCenterError(
        "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
        "Native embedding is available only in the Tauri desktop app.",
      ),
    );
  }

  public rerank(): Promise<NativeRerankResult> {
    return Promise.reject(
      new ModelCenterError(
        "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
        "Native reranking is available only in the Tauri desktop app.",
      ),
    );
  }

  public cancelGeneration(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class RepositoryChapterVersionReader implements ChapterVersionReader {
  public constructor(private readonly chapters: ChapterRepository) {}

  public async findCurrent(
    chapterIdValue: string,
  ): Promise<StoryResult<CurrentChapterVersion | null, StoryCoreError>> {
    const chapterId = parseDomainUuid(chapterIdValue);
    if (!chapterId.ok) {
      return storyErr(
        new StoryCoreError({
          code: "STORY_INVALID_UUID",
          message: "Chapter identifier is not a valid UUIDv7.",
        }),
      );
    }
    const loaded = await this.chapters.findById(chapterId.value);
    if (!loaded.ok) {
      return storyErr(
        new StoryCoreError({
          code: "STORY_REPOSITORY_ERROR",
          message: "Unable to read the current chapter version.",
          retryable: loaded.error.retryable,
          actions: ["RETRY", "CONTACT_SUPPORT"],
          details: { sourceCode: loaded.error.code },
        }),
      );
    }
    if (loaded.value === null) {
      return storyOk(null);
    }
    const projectId = parseStoryUuid(loaded.value.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const versionId = parseStoryUuid(loaded.value.currentVersionId);
    if (!versionId.ok) {
      return versionId;
    }
    const storyChapterId = parseStoryUuid(loaded.value.id);
    if (!storyChapterId.ok) {
      return storyChapterId;
    }
    return storyOk({
      chapterId: storyChapterId.value,
      projectId: projectId.value,
      versionId: versionId.value,
    });
  }
}

class RepositoryCausalEvidenceReader implements CausalEvidenceReader {
  public constructor(private readonly versions: ChapterVersionRepository) {}

  public async readChapterVersion(
    chapterVersionIdValue: string,
  ): Promise<CausalChapterVersionSource | null> {
    const chapterVersionId = parseDomainUuid(chapterVersionIdValue);
    if (!chapterVersionId.ok) {
      return null;
    }
    const loaded = await this.versions.findVersionById(chapterVersionId.value);
    if (!loaded.ok) {
      throw loaded.error;
    }
    if (loaded.value === null) {
      return null;
    }
    const snapshot = loaded.value.toSnapshot();
    return Object.freeze({
      chapterVersionId: snapshot.id,
      projectId: snapshot.projectId,
      chapterId: snapshot.chapterId,
      content: snapshot.content,
      contentChecksum: snapshot.contentChecksum,
    });
  }
}

function buildRuntime(
  mode: RuntimeMode,
  repositories: RuntimeRepositories,
  creativeJourneys: CreativeJourneyStore,
  projectSeeds: ProjectSeedStore,
  close: () => Promise<void>,
  maintenance: RuntimeMaintenance | null,
  createTaskCenter: (clock: Clock) => TaskCenterStore,
  createGenerationGovernance: (clock: Clock) => GenerationGovernanceStore,
  createModelCenter: (clock: Clock) => ModelCenterStore,
  createModelRouting: (clock: Clock, modelCenter: ModelCenterStore) => ModelRoutingStore,
  createModelHub: (clock: Clock) => ModelHubStore,
  createContextTraces: (clock: Clock) => ContextCompilationTraceStore,
  createChapterValidationSnapshots: () => ChapterValidationSnapshotStore,
  createWritingFeedback: () => WritingFeedbackStore,
  createStoryPersistence: (
    ids: UuidV7Generator,
    clock: Clock,
    hasher: ContentHasher,
  ) => StoryPersistence,
  createSearchSnapshots: () => ProjectSearchSnapshotStore,
  cloudFoundation: RuntimeCloudFoundation | null,
  cloudExecutor: SqlExecutor | null,
): DesktopRuntime {
  const clock = new SystemClock();
  const ids = new CryptoUuidV7Generator();
  const hasher = new CryptoContentHasher();
  const projectContextPrivacy = new ProjectContextPrivacyAuthority(repositories.chapters, hasher);
  const taskCenter = createTaskCenter(clock);
  const modelCenter = createModelCenter(clock);
  const modelRouting = createModelRouting(clock, modelCenter);
  const modelHub = createModelHub(clock);
  const usageCenter =
    mode === "tauri" && cloudExecutor !== null ? new SqliteUsageCenterService(cloudExecutor) : null;
  const contextTraces = createContextTraces(clock);
  const contextTraceOutputs =
    mode === "tauri"
      ? createRequiredSqliteContextTraceOutputs(cloudExecutor)
      : new BrowserDevelopmentContextTraceOutputCommitUnitOfWork(
          repositories.aiCandidates,
          contextTraces,
          {
            projects: repositories.projects,
            chapters: repositories.chapters,
          },
        );
  const novelSkills =
    mode === "tauri" && cloudExecutor !== null
      ? createNovelSkillRuntime({
          mode: "tauri",
          store: new NovelSkillSqliteStore(cloudExecutor),
          clock,
        })
      : createNovelSkillRuntime({ mode: "browser-development" });
  const chapterValidationSnapshotStore = createChapterValidationSnapshots();
  const writingFeedback = new WritingFeedbackLearningService(createWritingFeedback(), ids, clock);
  const modelGateway: NativeModelGatewayClient =
    mode === "tauri"
      ? new TauriNativeModelGatewayClient()
      : new BrowserDevelopmentModelGatewayClient();
  const credentials: CredentialStore =
    mode === "tauri" ? new TauriCredentialStore() : new BrowserDevelopmentCredentialStore();
  const imageGeneration = new ModelHubImageGenerationService({
    modelHub,
    imageGateway:
      mode === "tauri"
        ? new TauriNativeImageGenerationGateway()
        : new UnavailableNativeImageGenerationGateway(),
    credentials,
    ids,
    clock,
  });
  const rerank = new ModelHubRerankService({
    modelHub,
    gateway: {
      available: mode === "tauri" && modelGateway.rerank !== undefined,
      rerank: (input) => {
        if (modelGateway.rerank === undefined) {
          return Promise.reject(
            new ModelCenterError(
              "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
              "Native reranking is unavailable in this runtime.",
            ),
          );
        }
        return modelGateway.rerank(input);
      },
    },
    credentials,
    ids,
    clock,
  });
  const secureUpdater: SecureUpdaterPort =
    mode === "tauri" ? new TauriSecureUpdater() : new BrowserDevelopmentSecureUpdater();
  const projectKeyVault: ProjectKeyVault =
    mode === "tauri" ? new TauriProjectKeyVault() : new BrowserDevelopmentProjectKeyVault();
  let featureFlags = mode === "tauri" ? readDesktopFeatureFlags() : DEFAULT_FEATURE_FLAGS;
  const fineTuningGovernance =
    mode === "tauri" && cloudExecutor !== null
      ? createFineTuningDesktopRuntime({
          featureEnabled: featureFlags.fineTuning,
          persistence: "native_sqlite",
          executor: cloudExecutor,
          hasher,
          clock,
          ids,
        })
      : null;
  const governedCreativeExtensions =
    mode === "tauri" && cloudExecutor !== null
      ? new GovernedCreativeExtensionsRuntime({
          store: new GovernedCreativeExtensionSqliteStore(cloudExecutor, clock),
          gateway: new NativeGovernedCreativeExtensionGateway(modelGateway, ids, {
            modelCenter,
            modelHub,
            credentials,
          }),
          ids,
          clock,
          resolveRoute: (kind) =>
            resolveConfiguredGovernedCreativeExtensionRoute(kind, {
              modelCenter,
              modelHub,
              modelRouting,
              credentials,
            }),
          readEnvironment: () => ({
            online: navigator.onLine,
            readOnly: false,
          }),
          isSourceReadOnly: (projectId, chapterId) =>
            isGovernedSourceReadOnly(repositories, projectId, chapterId),
          isSourceLocalOnly: (projectId, chapterId) =>
            isGovernedSourceLocalOnly(repositories, projectId, chapterId),
          projectContextPrivacy,
          readFeatureFlags: () => ({
            translation: featureFlags.translation,
            shortDrama: featureFlags.shortDrama,
          }),
        })
      : null;
  const multiAgentReview =
    mode === "tauri" && cloudExecutor !== null
      ? new MultiAgentReviewRuntime({
          store: new MultiAgentReviewSqliteStore(cloudExecutor, clock),
          contextReader: new SqliteMultiAgentReviewContextReader(cloudExecutor),
          modelCenter,
          modelHub,
          modelRouting,
          modelGateway,
          credentials,
          projectContextPrivacy,
          ids,
          clock,
          enabled: featureFlags.multiAgent,
        })
      : null;
  const projectSecurity =
    cloudFoundation === null
      ? null
      : new ProjectKeyLifecycleService(projectKeyVault, cloudFoundation.projectKeys, ids, clock);
  const cloudEndpoint = mode === "tauri" ? readDesktopCloudEndpoint() : null;
  const marketplaceClient =
    cloudEndpoint === null
      ? null
      : new CloudMarketplaceClient({
          transport: new TauriCloudTransport(cloudEndpoint),
        });
  const marketplace = new MarketplaceRuntime({
    client: marketplaceClient ?? createUnavailableMarketplaceCloudGateway(),
    featureEnabled: featureFlags.communityMarketplace,
    installStore:
      mode === "tauri" && cloudExecutor !== null
        ? new SqliteMarketplaceInstallStore(cloudExecutor)
        : createBrowserMarketplaceInstallStore(),
  });
  const cloudApi =
    featureFlags.cloudIdentity && cloudFoundation !== null && cloudEndpoint !== null
      ? new InkShadowCloudApiClient({
          transport: new TauriCloudTransport(cloudEndpoint),
        })
      : null;
  const cloudIdentity =
    cloudApi !== null &&
    cloudFoundation !== null &&
    projectSecurity !== null &&
    cloudEndpoint !== null
      ? new CloudIdentityService(
          new TauriCloudSessionVault(cloudEndpoint),
          cloudApi,
          projectSecurity,
          cloudFoundation.access,
          cloudFoundation.projectKeys,
          ids,
          clock,
        )
      : null;
  const cloudSession =
    cloudIdentity === null ? null : new CloudSessionCoordinator(cloudIdentity, clock);
  const cloudTeams =
    !featureFlags.teamCollaboration || cloudApi === null || cloudSession === null
      ? null
      : new CloudTeamWorkspaceService(cloudApi, cloudSession, ids);
  const cloudAiUsage =
    !featureFlags.teamCollaboration || cloudApi === null || cloudSession === null
      ? null
      : new CloudAiUsageService(cloudApi, cloudSession, ids);
  const cloudTeamProjectKeys =
    !featureFlags.teamCollaboration ||
    !featureFlags.cloudSync ||
    cloudApi === null ||
    cloudSession === null ||
    projectSecurity === null
      ? null
      : new CloudTeamProjectKeyEnvelopeCoordinator(cloudApi, cloudSession, projectSecurity, ids);
  const cloudAccount =
    cloudApi === null || cloudIdentity === null || cloudSession === null || cloudFoundation === null
      ? null
      : new CloudAccountManagementService(
          cloudApi,
          cloudSession,
          cloudIdentity,
          cloudFoundation.access,
          cloudFoundation.projectKeys,
          ids,
          clock,
        );
  const cloudDeletion =
    cloudApi === null || cloudIdentity === null || cloudSession === null || cloudExecutor === null
      ? null
      : new CloudDeletionLifecycleService(
          cloudApi,
          cloudSession,
          cloudIdentity,
          new CloudDeletionJournalSqliteStore(cloudExecutor),
          ids,
          clock,
          hasher,
        );
  const cloudProjectKeys =
    !featureFlags.cloudSync ||
    cloudApi === null ||
    cloudSession === null ||
    cloudAccount === null ||
    projectSecurity === null ||
    cloudFoundation === null
      ? null
      : new CloudProjectKeyCoordinator(
          cloudApi,
          cloudSession,
          cloudAccount,
          projectSecurity,
          cloudFoundation.projectKeys,
          ids,
          clock,
        );
  const cloudSync = createCloudSyncRuntimeService({
    mode,
    enabled: featureFlags.cloudSync,
    executor: cloudExecutor,
    syncStore: cloudFoundation?.sync ?? null,
    api: cloudApi,
    session: cloudSession,
    projectSecurity,
    cloudProjectKeys,
    ids,
    clock,
  });
  const cloudSyncEnrollment = createCloudProjectSyncEnrollmentService({
    mode,
    enabled: featureFlags.cloudSync,
    executor: cloudExecutor,
    syncStore: cloudFoundation?.sync ?? null,
    projectKeyStore: cloudFoundation?.projectKeys ?? null,
    session: cloudSession,
    cloudProjectKeys,
    cloudSync,
    clock,
  });
  const cloudSyncControl = createCloudSyncControlService({
    mode,
    enabled: featureFlags.cloudSync,
    executor: cloudExecutor,
    cloudSync,
    enrollment: cloudSyncEnrollment,
    clock,
  });
  const syncConflictResolution = createSyncConflictResolutionCoordinator({
    mode,
    enabled: featureFlags.cloudSync,
    executor: cloudExecutor,
    syncStore: cloudFoundation?.sync ?? null,
    session: cloudSession,
    projectSecurity,
    cloudProjectKeys,
    ids,
    clock,
  });
  const cloudSyncSupervisor = createCloudSyncSupervisor({
    mode,
    enabled: featureFlags.cloudSync,
    executor: cloudExecutor,
    cloudSync,
  });
  const storyPersistence = createStoryPersistence(ids, clock, hasher);
  const storyGraph =
    mode === "tauri" && featureFlags.graphRag && cloudExecutor !== null
      ? createSqliteStoryGraphRuntime({
          executor: cloudExecutor,
          hasher,
          clock,
        })
      : null;
  featureFlags = Object.freeze({
    ...featureFlags,
    graphRag: storyGraph !== null,
  });
  const actorId = ids.next();
  const novelSkillPaidEvaluation =
    mode === "tauri" && cloudExecutor !== null
      ? createLazyNovelSkillPaidEvaluationCoordinator(async () => {
          const { createTauriNovelSkillPaidEvaluationCoordinator } =
            await import("./novel-skill-paid-evaluation-tauri-factory");
          return createTauriNovelSkillPaidEvaluationCoordinator({
            executor: cloudExecutor,
            projects: repositories.projects,
            exactTargetDependencies: {
              modelHub,
              modelGateway,
              credentials,
              clock,
            },
            ids,
          });
        })
      : createUnavailableNovelSkillPaidEvaluationCoordinator(
          "付费写作方法评测只在桌面原生模式可用；浏览器模式不会发送或回退模型请求。",
        );
  const factService = new StoryFactApplicationService({
    facts: storyPersistence.facts,
    clock,
    ids,
  });
  const continuousProjection = new ContinuousStoryStateProjectionAdapter({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    storyFacts: storyPersistence.facts,
    causalGraph: storyPersistence.causalGraph,
    hasher,
  });
  const characterEvidence = new CharacterVoicePovEvidenceAdapter({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    storyFacts: storyPersistence.facts,
    hasher,
    continuousProjection,
  });
  const characterVoicePov = new ChapterCharacterVoicePovRuntime(characterEvidence);
  const narrativeAnalysis = new ChapterNarrativeAnalysisRuntime({
    storyFacts: storyPersistence.facts,
    chapterVersions: repositories.chapterVersions,
    causalGraph: storyPersistence.causalGraph,
    hasher,
    continuousProjection,
  });
  const chapterValidation = new ChapterNovelValidationRuntime({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    storyFacts: storyPersistence.facts,
    hasher,
    continuousProjection,
    supplementalFindingVerifier: new RecomputedChapterSupplementalFindingVerifier({
      characterVoicePov,
      narrativeAnalysis,
    }),
    mutations: { factService, actorId },
  });
  const chapterValidationSnapshots = new ChapterValidationSnapshotService({
    validator: chapterValidation,
    store: chapterValidationSnapshotStore,
    ids,
    clock,
    hasher,
  });
  const ambiguousReview = new AmbiguousNovelReviewService({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    storyFacts: storyPersistence.facts,
    hasher,
    characterEvidence,
    modelHub: { modelHub, modelGateway, credentials, clock, ids },
    projectContextPrivacy,
  });
  const storyProcessingPreferences = new BrowserChapterSummaryPreferenceStore(
    typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage,
  );
  const continuousState = new ContinuousStoryStateExtractionService({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    facts: storyPersistence.facts,
    factService,
    model: new ModelHubContinuousStoryStateModel({
      modelHub,
      modelGateway,
      credentials,
      clock,
      ids,
    }),
    hasher,
    ids,
    clock,
    preferences: storyProcessingPreferences,
    projectContextPrivacy,
  });
  const chapterSummaries = new ChapterSummaryService({
    projects: repositories.projects,
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    facts: storyPersistence.facts,
    factService,
    hasher,
    model: new ModelHubChapterSummaryModel({
      modelHub,
      modelGateway,
      credentials,
      clock,
      ids,
    }),
    preferences: storyProcessingPreferences,
    projectContextPrivacy,
  });
  const historicalBackfill = new HistoricalChapterBackfillService({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    taskCenter,
    preferences: storyProcessingPreferences,
    hasher,
    ids,
    clock,
  });
  const causalWhatIf = new CausalWhatIfSimulationService(
    storyPersistence.causalGraph,
    storyPersistence.facts,
    new ModelHubCausalWhatIfModelPort({
      modelHub,
      modelGateway,
      credentials,
      clock,
      ids,
      projectContextPrivacy,
    }),
    ids,
    clock,
  );
  const outlineService = new OutlineApplicationService({
    outlines: storyPersistence.outlines,
    clock,
    ids,
  });
  const storyPlanning = new ModelHubStoryPlanningService({
    modelHub,
    modelGateway,
    credentials,
    clock,
    ids,
    facts: storyPersistence.facts,
    causalGraph: storyPersistence.causalGraph,
    outlines: storyPersistence.outlines,
    outlineService,
    candidates: storyPersistence.planningCandidates,
    projectContextPrivacy,
  });
  const searchVectors = new PersistentProjectEmbeddingService(
    cloudExecutor === null ? null : new SearchVectorSqliteStore(cloudExecutor),
    modelRouting,
    modelCenter,
    modelGateway,
    hasher,
    clock,
    {
      modelHub,
      modelGateway,
      credentials,
      clock,
      ids,
    },
    async (projectId, documents) => {
      const parsedProjectId = parseDomainUuid(projectId);
      if (!parsedProjectId.ok) {
        return documents.filter(({ sourceType }) => sourceType !== "chapter");
      }
      const chapters = await repositories.chapters.listByProjectId(parsedProjectId.value);
      if (!chapters.ok) {
        throw chapters.error;
      }
      const remoteEligibleChapterIds = new Set(
        chapters.value
          .filter((chapter) => !chapter.isLocalOnly)
          .map((chapter) => chapter.id as string),
      );
      return documents.filter(
        (document) =>
          document.sourceType !== "chapter" || remoteEligibleChapterIds.has(document.sourceId),
      );
    },
    projectContextPrivacy,
  );
  const search = new LocalProjectSearchService({
    projects: repositories.projects,
    chapters: repositories.chapters,
    outlines: storyPersistence.outlines,
    snapshots: createSearchSnapshots(),
    hasher,
    clock,
    vectors: searchVectors,
  });
  const acceptCandidate = new AcceptAiCandidate(
    repositories.aiCandidates,
    repositories.chapters,
    repositories.contentCommits,
    ids,
    clock,
    hasher,
    repositories.chapterVersions,
  );
  const studioReview =
    mode !== "tauri" ||
    !featureFlags.teamCollaboration ||
    !featureFlags.cloudSync ||
    cloudApi === null ||
    cloudSession === null ||
    cloudTeams === null ||
    projectSecurity === null ||
    cloudExecutor === null
      ? null
      : createStudioReviewRuntime({
          api: cloudApi,
          session: cloudSession,
          teams: cloudTeams,
          projectSecurity,
          executor: cloudExecutor,
          chapters: repositories.chapters,
          chapterVersions: repositories.chapterVersions,
          candidates: repositories.aiCandidates,
          acceptCandidate,
          ids,
          clock,
          hasher,
        });
  const studioTeamTemplates =
    mode !== "tauri" ||
    !featureFlags.teamCollaboration ||
    !featureFlags.cloudSync ||
    cloudApi === null ||
    cloudSession === null ||
    cloudTeams === null ||
    projectSecurity === null ||
    cloudExecutor === null
      ? null
      : createStudioTeamTemplateRuntime({
          api: cloudApi,
          session: cloudSession,
          teams: cloudTeams,
          projectSecurity,
          executor: cloudExecutor,
          ids,
          clock,
          mutationEnabled: featureFlags.teamCollaboration,
        });
  const closeRuntime = createIdempotentAsyncCloser(async () => {
    try {
      await cloudSyncSupervisor?.stop();
    } finally {
      await close();
    }
  });

  return {
    mode,
    repositories,
    creativeJourneys,
    projectSeeds,
    storySettingsImport:
      cloudExecutor === null
        ? null
        : new StorySettingsImportService({ executor: cloudExecutor, ids, clock, hasher }),
    contextTraces,
    contextTraceOutputs,
    novelSkills,
    novelSkillPaidEvaluation,
    projectContextPrivacy,
    taskCenter,
    generationGovernance: createGenerationGovernance(clock),
    usageCenter,
    modelCenter,
    modelRouting,
    modelHub,
    modelGateway,
    imageGeneration,
    rerank,
    multiAgentReview,
    governedCreativeExtensions,
    projectKeyVault,
    projectSecurity,
    story: {
      actorId,
      facts: storyPersistence.facts,
      factService,
      chapterValidation,
      chapterValidationSnapshots,
      characterVoicePov,
      ambiguousReview,
      continuousState,
      continuousProjection,
      chapterSummaries,
      historicalBackfill,
      narrativeAnalysis,
      causalGraph: storyPersistence.causalGraph,
      causalProjector: new CausalStoryFactProjector({
        facts: storyPersistence.facts,
        chapterVersions: repositories.chapterVersions,
        graph: storyPersistence.causalGraph,
      }),
      causalWhatIf,
      writingFeedback,
      ideationDrafts: storyPersistence.ideationDrafts,
      ideationService: new IdeationApplicationService({
        drafts: storyPersistence.ideationDrafts,
        projects: storyPersistence.ideationProjects,
        clock,
        ids,
      }),
      outlines: storyPersistence.outlines,
      outlineService,
      storyPlanning,
      formalRecords: storyPersistence.formalRecords,
      formalRecordService: new FormalRecordApplicationService({
        records: storyPersistence.formalRecords,
        clock,
        ids,
      }),
      memoryPolicies: storyPersistence.memoryPolicies,
      memoryRecords: storyPersistence.memoryRecords,
      memoryService: new MemoryApplicationService({
        policies: storyPersistence.memoryPolicies,
        records: storyPersistence.memoryRecords,
        creation: storyPersistence.memoryCreation,
        governance: storyPersistence.memoryGovernance,
        clock,
        ids,
      }),
      whatIfBranches: storyPersistence.whatIfBranches,
      outlineDrafts: storyPersistence.outlineDrafts,
      whatIfService: new WhatIfApplicationService({
        branches: storyPersistence.whatIfBranches,
        timeline: storyPersistence.formalRecords,
        promotions: storyPersistence.whatIfPromotions,
        clock,
        ids,
      }),
      extractionItems: storyPersistence.extractionItems,
      consistencyItems: storyPersistence.consistencyItems,
      extractionIntake: new ReviewIntakeService({
        itemType: "extraction",
        items: storyPersistence.extractionItems,
        clock,
        ids,
      }),
      consistencyIntake: new ReviewIntakeService({
        itemType: "consistency",
        items: storyPersistence.consistencyItems,
        clock,
        ids,
      }),
      extractionDecisions: new ReviewDecisionService({
        items: storyPersistence.extractionItems,
        records: storyPersistence.formalRecords,
        sourceVersions: storyPersistence.sourceVersions,
        transaction: storyPersistence.extractionDecisions,
        clock,
        ids,
      }),
      consistencyDecisions: new ReviewDecisionService({
        items: storyPersistence.consistencyItems,
        records: storyPersistence.formalRecords,
        sourceVersions: storyPersistence.sourceVersions,
        transaction: storyPersistence.consistencyDecisions,
        clock,
        ids,
      }),
      materials: storyPersistence.materials,
      materialReferences: storyPersistence.materialReferences,
      materialService: new MaterialApplicationService({
        materials: storyPersistence.materials,
        references: storyPersistence.materialReferences,
        dispositions: storyPersistence.materialDispositions,
        chapterVersions: storyPersistence.sourceVersions,
        clock,
        ids,
      }),
    },
    search,
    cloudFoundation,
    cloudIdentity,
    cloudSession,
    cloudTeams,
    cloudAiUsage,
    cloudTeamProjectKeys,
    cloudAccount,
    cloudDeletion,
    cloudProjectKeys,
    cloudSync,
    cloudSyncEnrollment,
    cloudSyncControl,
    syncConflictResolution,
    cloudSyncSupervisor,
    studioReview,
    studioTeamTemplates,
    storyGraph,
    authoritativeExtraction: null,
    featureFlags,
    ids,
    clock,
    hasher,
    getRuntimeInformation:
      mode === "tauri" ? readTauriRuntimeInformation : readBrowserRuntimeInformation,
    credentials,
    secureUpdater,
    fineTuningGovernance,
    marketplace,
    maintenance,
    automaticBackup: null,
    useCases: {
      createProject: new CreateProject(repositories.projects, ids, clock),
      listProjects: new ListProjects(repositories.projects),
      archiveProject: new ArchiveProject(repositories.projects, clock),
      renameProject: new RenameProject(repositories.projects, clock),
      unarchiveProject: new UnarchiveProject(repositories.projects, clock),
      trashProject: new TrashProject(repositories.projects, clock),
      restoreProject: new RestoreProject(repositories.projects, clock),
      createChapter: new CreateChapter(
        repositories.projects,
        repositories.contentCommits,
        ids,
        clock,
        hasher,
        repositories.chapters,
        repositories.chapterVersions,
      ),
      importProject: new ImportProject(
        repositories.projects,
        repositories.projectImports,
        ids,
        clock,
        hasher,
      ),
      editChapter: new EditChapter(repositories.chapters, repositories.recoveryDrafts, ids, clock),
      saveChapter: new SaveChapter(
        repositories.chapters,
        repositories.recoveryDrafts,
        repositories.contentCommits,
        ids,
        clock,
        hasher,
      ),
      setChapterPrivacy: new SetChapterPrivacy(
        repositories.chapters,
        repositories.chapterPrivacy,
        clock,
      ),
      listChapterVersions: new ListChapterVersions(repositories.chapterVersions),
      restoreChapterVersion: new RestoreChapterVersion(
        repositories.chapters,
        repositories.chapterVersions,
        repositories.contentCommits,
        ids,
        clock,
        hasher,
      ),
      acceptCandidate,
      reviseCandidate: new ReviseAiCandidate(repositories.aiCandidates, clock, hasher),
      rejectCandidate: new RejectAiCandidate(repositories.aiCandidates, clock),
    },
    close: closeRuntime,
  };
}

function createRequiredSqliteContextTraceOutputs(
  executor: SqlExecutor | null,
): ContextTraceOutputCommitUnitOfWork {
  if (executor === null) {
    throw new Error(
      "The production desktop runtime requires an atomic SQLite context-output commit boundary.",
    );
  }
  const unitOfWork = new SqliteContextTraceOutputCommitUnitOfWork(executor);
  assertAtomicContextTraceOutputCapability(unitOfWork);
  return unitOfWork;
}

function assertAtomicContextTraceOutputCapability(
  unitOfWork: ContextTraceOutputCommitUnitOfWork,
): void {
  if (unitOfWork.capability !== "sqlite_atomic") {
    throw new Error(
      "The production desktop runtime refused a non-atomic context-output commit boundary.",
    );
  }
}

interface StoryPersistence {
  readonly facts: StoryFactStore;
  readonly causalGraph: CausalEventGraphStore;
  readonly planningCandidates: StoryPlanningCandidateStore;
  readonly ideationDrafts: IdeationDraftRepository;
  readonly ideationProjects: IdeationProjectCommitUnitOfWork;
  readonly outlines: OutlineRepository;
  readonly formalRecords: FormalStoryRecordRepository &
    FormalStoryRecordListReader &
    FormalTimelineReader;
  readonly memoryPolicies: MemoryPolicyRepository;
  readonly memoryRecords: MemoryRecordRepository & MemoryRecordListReader;
  readonly memoryCreation: MemoryRecordCreationUnitOfWork;
  readonly memoryGovernance: MemoryGovernanceUnitOfWork;
  readonly whatIfBranches: WhatIfRepository & WhatIfBranchListReader;
  readonly whatIfPromotions: WhatIfPromotionUnitOfWork;
  readonly outlineDrafts: OutlineDraftReader;
  readonly sourceVersions: ChapterVersionReader;
  readonly extractionItems: ReviewItemRepository<"extraction"> & ReviewItemListReader<"extraction">;
  readonly consistencyItems: ReviewItemRepository<"consistency"> &
    ReviewItemListReader<"consistency">;
  readonly extractionDecisions: ReviewDecisionUnitOfWork<"extraction">;
  readonly consistencyDecisions: ReviewDecisionUnitOfWork<"consistency">;
  readonly materials: MaterialRepository;
  readonly materialReferences: MaterialReferenceRepository;
  readonly materialDispositions: MaterialDispositionUnitOfWork;
}

async function isGovernedSourceReadOnly(
  repositories: Pick<RuntimeRepositories, "projects" | "chapters">,
  projectIdValue: string,
  chapterIdValue: string,
): Promise<boolean> {
  const projectId = parseDomainUuid(projectIdValue);
  const chapterId = parseDomainUuid(chapterIdValue);
  if (!projectId.ok || !chapterId.ok) {
    return true;
  }
  const [projectResult, chapterResult] = await Promise.all([
    repositories.projects.findById(projectId.value),
    repositories.chapters.findById(chapterId.value),
  ]);
  if (!projectResult.ok || !chapterResult.ok) {
    return true;
  }
  const project = projectResult.value;
  const chapter = chapterResult.value;
  return (
    project === null ||
    chapter === null ||
    project.status !== "active" ||
    chapter.status !== "active" ||
    chapter.projectId !== project.id
  );
}

async function isGovernedSourceLocalOnly(
  repositories: Pick<RuntimeRepositories, "chapters">,
  projectIdValue: string,
  chapterIdValue: string,
): Promise<boolean> {
  const projectId = parseDomainUuid(projectIdValue);
  const chapterId = parseDomainUuid(chapterIdValue);
  if (!projectId.ok || !chapterId.ok) {
    return true;
  }
  const chapterResult = await repositories.chapters.findById(chapterId.value);
  return (
    !chapterResult.ok ||
    chapterResult.value?.projectId !== projectId.value ||
    chapterResult.value.isLocalOnly
  );
}

async function readTauriRuntimeInformation(): Promise<RuntimeInformation> {
  const information = await invoke<{
    readonly appVersion: string;
    readonly os: string;
    readonly arch: string;
    readonly debug: boolean;
  }>("get_runtime_info");
  return {
    appVersion: information.appVersion,
    platform: information.os,
    architecture: information.arch,
    environment: information.debug ? "development" : "production",
  };
}

function readBrowserRuntimeInformation(): Promise<RuntimeInformation> {
  return Promise.resolve({
    appVersion: "0.2.3",
    platform: "browser",
    architecture: "web",
    environment: "development",
  });
}

function readDesktopCloudEndpoint(): CloudEndpoint | null {
  const baseUrl = import.meta.env.VITE_INKSHADOW_CLOUD_API_BASE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    return null;
  }
  return Object.freeze({
    baseUrl,
    allowInsecureLoopback:
      import.meta.env.DEV &&
      import.meta.env.VITE_INKSHADOW_CLOUD_ALLOW_INSECURE_LOOPBACK === "true",
  });
}

function readDesktopFeatureFlags(): Readonly<FeatureFlags> {
  const cloudIdentity = import.meta.env.VITE_INKSHADOW_CLOUD_IDENTITY_ENABLED === "true";
  const cloudSync = cloudIdentity && import.meta.env.VITE_INKSHADOW_CLOUD_SYNC_ENABLED === "true";
  const teamCollaboration =
    cloudIdentity && import.meta.env.VITE_INKSHADOW_TEAM_COLLABORATION_ENABLED === "true";
  const graphRag = import.meta.env.VITE_INKSHADOW_GRAPH_RAG_ENABLED === "true";
  const authoritativeExtraction =
    graphRag && import.meta.env.VITE_INKSHADOW_AUTHORITATIVE_EXTRACTION_ENABLED === "true";
  const multiAgent = import.meta.env.VITE_INKSHADOW_MULTI_AGENT_ENABLED === "true";
  const fineTuning = import.meta.env.VITE_INKSHADOW_FINE_TUNING_ENABLED === "true";
  const communityMarketplace =
    cloudIdentity && import.meta.env.VITE_INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED === "true";
  const translation = import.meta.env.VITE_INKSHADOW_TRANSLATION_ENABLED === "true";
  const shortDrama = import.meta.env.VITE_INKSHADOW_SHORT_DRAMA_ENABLED === "true";
  return resolveFeatureFlags({
    cloudIdentity,
    cloudSync,
    teamCollaboration,
    graphRag,
    authoritativeExtraction,
    multiAgent,
    fineTuning,
    communityMarketplace,
    translation,
    shortDrama,
  });
}

function createBrowserMarketplaceInstallStore():
  BrowserMarketplaceInstallStore | InMemoryMarketplaceInstallStore {
  try {
    return new BrowserMarketplaceInstallStore(globalThis.localStorage);
  } catch {
    return new InMemoryMarketplaceInstallStore();
  }
}

export function createTauriRuntimeMaintenance(
  executor: NativeMaintenanceExecutor,
): RuntimeMaintenance {
  const service = new DatabaseMaintenanceService(executor);
  const maintenance: RuntimeMaintenance = {
    inspect: () => service.inspect(),
    chooseBackupDestination: async () => (await executor.chooseBackupDestination())?.ticket ?? null,
    choosePreRestoreBackupDestination: async () =>
      (await executor.choosePreRestoreBackupDestination())?.ticket ?? null,
    chooseRestoreSource: async () => (await executor.chooseRestoreSource())?.ticket ?? null,
    createConsistentBackup: (destinationTicket) =>
      service.createConsistentBackup(destinationTicket),
    restoreConsistentBackup: (sourceTicket) => service.restoreConsistentBackup(sourceTicket),
  };
  return Object.freeze(maintenance);
}

async function createConfiguredAuthoritativeExtractionRuntime(options: {
  readonly enabled: boolean;
  readonly executor: SqlExecutor;
  readonly runtime: DesktopRuntime;
}): Promise<AuthoritativeExtractionDesktopPort | null> {
  if (!options.enabled || options.runtime.storyGraph === null) {
    return null;
  }
  let configured: Awaited<ReturnType<typeof resolveConfiguredAuthoritativeExtractionProvider>> =
    null;
  try {
    configured = await resolveConfiguredAuthoritativeExtractionProvider({
      modelCenter: options.runtime.modelCenter,
      modelHub: options.runtime.modelHub,
      modelRouting: options.runtime.modelRouting,
      credentials: options.runtime.credentials,
      gateway: options.runtime.modelGateway,
      hasher: options.runtime.hasher,
      ids: options.runtime.ids,
      chapters: options.runtime.repositories.chapters,
      projectContextPrivacy: options.runtime.projectContextPrivacy,
    });
  } catch {
    configured = null;
  }
  return createAuthoritativeExtractionDesktopRuntime({
    featureEnabled: true,
    persistence: "native_sqlite",
    executor: options.executor,
    ...(configured === null ? {} : { provider: configured.provider }),
    graph: options.runtime.storyGraph,
    contentHasher: options.runtime.hasher,
    clock: options.runtime.clock,
    ids: options.runtime.ids,
    provenance: configured?.provenance ?? unavailableExtractionProvenance(),
    evaluationSuiteId: "authoritative.extraction.golden.v1",
    ...(configured === null ? {} : { goldenSuite: configured.goldenSuite }),
    executionMode: configured?.executionMode ?? "local",
    ...(configured === null
      ? {}
      : {
          captureProjectContextAuthority: async (projectId: string) => {
            const receipt = await options.runtime.projectContextPrivacy.inspect(projectId);
            const verifiedLocalEligible = configured.executionMode === "local";
            options.runtime.projectContextPrivacy.assertRouteEligible(
              receipt,
              verifiedLocalEligible,
            );
            return async () => {
              await options.runtime.projectContextPrivacy.assertCurrentBeforeDispatch(receipt);
              options.runtime.projectContextPrivacy.assertRouteEligible(
                receipt,
                verifiedLocalEligible,
              );
            };
          },
        }),
  });
}

function unavailableExtractionProvenance(): AuthoritativeExtractionProvenance {
  const registryId = parseStoryIdentifier("authoritative.extraction");
  const evaluationVersion = parseStoryIdentifier("authoritative.extraction.eval.v1");
  if (!registryId.ok || !evaluationVersion.ok) {
    throw new Error("The built-in authoritative extraction identifiers are invalid.");
  }
  const parsed = validateAuthoritativeExtractionProvenance({
    prompt: {
      registryId: registryId.value,
      version: 1,
      checksumSha256: "0".repeat(64),
    },
    model: {
      provider: "unconfigured",
      id: "unconfigured",
      revision: "unconfigured",
    },
    evaluationVersion: evaluationVersion.value,
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

export async function createDesktopRuntime(): Promise<DesktopRuntime> {
  if (isTauri()) {
    const executor = await TauriSqliteExecutor.open();
    const acceptedCandidateTaskIds = new CryptoUuidV7Generator();
    const repositories = createSqliteRepositories(executor, {
      syncProjectionIds: new CryptoUuidV7Generator(),
      acceptedCandidateTaskFactory: (commit) => {
        const version = commit.version.toSnapshot();
        return createAcceptedChapterPipelineTaskInput(
          acceptedCandidateTaskIds.next(),
          version.createdAt,
          createLocalCandidateAcceptancePipelineInput({
            projectId: version.projectId,
            chapterId: version.chapterId,
            versionId: version.id,
            acceptedCharacterCount: version.content.length,
          }),
        );
      },
    });
    const [{ AccessSqliteStore }, { ProjectKeySqliteStore }, { SyncSqliteStore }] =
      await Promise.all([
        import("@inkshadow/data/access-sqlite-store"),
        import("@inkshadow/data/project-key-sqlite-store"),
        import("@inkshadow/data/sync-sqlite-store"),
      ]);
    const baseRuntime = buildRuntime(
      "tauri",
      repositories,
      new SqliteCreativeJourneyStore(executor),
      new ProjectSeedSqliteStore(executor),
      () => executor.close(),
      createTauriRuntimeMaintenance(executor),
      (clock) => new TauriTaskCenterStore(executor, clock),
      (clock) => new TauriGenerationGovernanceStore(executor, clock),
      (clock) => new TauriModelCenterStore(executor, clock),
      (clock) => new TauriModelRoutingStore(executor, clock),
      (clock) => new TauriModelHubStore(executor, clock),
      () => new SqliteContextCompilationTraceStore(executor),
      () => new SqliteChapterValidationSnapshotStore(executor),
      () => new SqliteWritingFeedbackStore(executor),
      (ids, clock, hasher) => {
        const extractionItems = new SqliteReviewItemRepository(executor, "extraction");
        const consistencyItems = new SqliteReviewItemRepository(executor, "consistency");
        return {
          facts: new SqliteStoryFactStore(executor),
          causalGraph: new SqliteCausalEventGraphStore(executor),
          planningCandidates: new SqliteStoryPlanningCandidateStore(executor),
          ideationDrafts: new SqliteIdeationDraftRepository(executor),
          ideationProjects: new SqliteIdeationProjectCommitUnitOfWork(executor, ids, clock, hasher),
          outlines: new SqliteOutlineRepository(executor),
          formalRecords: new SqliteFormalStoryRecordRepository(executor),
          memoryPolicies: new SqliteMemoryPolicyRepository(executor),
          memoryRecords: new SqliteMemoryRecordRepository(executor),
          memoryCreation: new SqliteMemoryRecordCreationUnitOfWork(executor),
          memoryGovernance: new SqliteMemoryGovernanceUnitOfWork(executor),
          whatIfBranches: new SqliteWhatIfRepository(executor),
          whatIfPromotions: new SqliteWhatIfPromotionUnitOfWork(executor),
          outlineDrafts: new SqliteOutlineDraftReader(executor),
          sourceVersions: new SqliteChapterVersionReader(executor),
          extractionItems,
          consistencyItems,
          extractionDecisions: new SqliteReviewDecisionUnitOfWork(executor, "extraction"),
          consistencyDecisions: new SqliteReviewDecisionUnitOfWork(executor, "consistency"),
          materials: new SqliteMaterialRepository(executor),
          materialReferences: new SqliteMaterialReferenceRepository(executor),
          materialDispositions: new SqliteMaterialDispositionUnitOfWork(executor),
        };
      },
      () => new TauriProjectSearchSnapshotStore(executor),
      {
        sync: new SyncSqliteStore(executor),
        access: new AccessSqliteStore(executor),
        projectKeys: new ProjectKeySqliteStore(executor),
      },
      executor,
    );
    await baseRuntime.novelSkills.initialize();
    const configuredRuntime: DesktopRuntime = Object.freeze({
      ...baseRuntime,
      authoritativeExtraction: await createConfiguredAuthoritativeExtractionRuntime({
        enabled: baseRuntime.featureFlags.authoritativeExtraction,
        executor,
        runtime: baseRuntime,
      }),
    });
    const automaticBackup = createTauriAutomaticBackupRuntime({
      executor,
      ids: configuredRuntime.ids,
      clock: configuredRuntime.clock,
    });
    const backupRuntime = attachAutomaticBackupRuntime(configuredRuntime, automaticBackup);
    const acceptedChapterPipelineWorker = new AcceptedChapterPipelineWorker(backupRuntime, {
      reportError: () => {
        globalThis.console.error(
          "[ACCEPTED_VERSION_PIPELINE_WORKER_FAILED] Accepted正文 remains safe; derived story data can be retried from the task center.",
        );
      },
    });
    const runtime = attachAcceptedChapterPipelineWorker(
      backupRuntime,
      acceptedChapterPipelineWorker,
    );
    await recoverModelHubCredentialCommits(runtime).catch(() => {
      globalThis.console.error(
        "[MODEL_HUB_CREDENTIAL_COMMIT_RECOVERY_FAILED] Published connections remain unchanged; pending credential cleanup will retry later.",
      );
    });
    await bridgeLegacyModelProfilesToModelHub({
      modelCenter: runtime.modelCenter,
      modelHub: runtime.modelHub,
      credentials: runtime.credentials,
      clock: runtime.clock,
    }).catch(() => {
      // Compatibility import is additive. A damaged legacy profile must not
      // prevent the local workspace or the unchanged legacy route from opening.
      globalThis.console.error(
        "[MODEL_HUB_LEGACY_BRIDGE_FAILED] Legacy model configuration remains available through the compatibility runtime.",
      );
    });
    if (typeof window.localStorage !== "undefined") {
      await backfillLegacyProjectSeeds(runtime.projectSeeds, window.localStorage).catch(() => {
        globalThis.console.error(
          "[PROJECT_SEED_LEGACY_BACKFILL_FAILED] Legacy creation recovery data remains unchanged.",
        );
      });
    }
    if (runtime.cloudIdentity !== null) {
      try {
        await runtime.cloudIdentity.reconcileLocalState();
        runtime.cloudSyncSupervisor?.start();
      } catch {
        // Cloud state is fail-closed; a reconciliation failure must not block
        // access to the local workspace or local export.
        runtime.cloudIdentity.disableAfterReconciliationFailure();
      }
    }
    await recoverOptionalMultiAgentReviewAtStartup(runtime.multiAgentReview);
    await recoverOptionalGovernedCreativeExtensionsAtStartup(
      runtime.governedCreativeExtensions,
      runtime.clock.now(),
    );
    automaticBackup.start();
    acceptedChapterPipelineWorker.start();
    return runtime;
  }

  return createDevelopmentRuntime(window.localStorage);
}

export function attachAutomaticBackupRuntime(
  runtime: DesktopRuntime,
  automaticBackup: AutomaticBackupRuntime,
): DesktopRuntime {
  const close = createIdempotentAsyncCloser(async () => {
    try {
      await automaticBackup.stop();
    } finally {
      await runtime.close();
    }
  });
  return Object.freeze({ ...runtime, automaticBackup, close });
}

export function attachAcceptedChapterPipelineWorker(
  runtime: DesktopRuntime,
  worker: Pick<AcceptedChapterPipelineWorker, "stop">,
): DesktopRuntime {
  const close = createIdempotentAsyncCloser(async () => {
    try {
      await worker.stop();
    } finally {
      await runtime.close();
    }
  });
  return Object.freeze({ ...runtime, close });
}

export interface MultiAgentReviewStartupRecoveryResult {
  readonly state: "disabled" | "ready" | "degraded";
  readonly recoveredSessionCount: number;
  readonly errorCode: "MULTI_AGENT_STARTUP_RECOVERY_FAILED" | null;
}

export async function recoverOptionalMultiAgentReviewAtStartup(
  review: Pick<MultiAgentReviewRuntime, "recoverInterruptedReviews"> | null,
): Promise<MultiAgentReviewStartupRecoveryResult> {
  if (review === null) {
    return {
      state: "disabled",
      recoveredSessionCount: 0,
      errorCode: null,
    };
  }
  try {
    return {
      state: "ready",
      recoveredSessionCount: await review.recoverInterruptedReviews(),
      errorCode: null,
    };
  } catch {
    // Multi-Agent is an optional, default-off capability. Corrupt historical
    // review state must remain isolated from the authoritative local workspace.
    globalThis.console.error(
      "[MULTI_AGENT_STARTUP_RECOVERY_FAILED] Optional review recovery was degraded.",
    );
    return {
      state: "degraded",
      recoveredSessionCount: 0,
      errorCode: "MULTI_AGENT_STARTUP_RECOVERY_FAILED",
    };
  }
}

export interface GovernedCreativeExtensionStartupRecoveryResult {
  readonly state: "disabled" | "ready" | "degraded";
  readonly recoveredRequestCount: number;
  readonly errorCode: "EXTENSION_STARTUP_RECOVERY_FAILED" | null;
}

export async function recoverOptionalGovernedCreativeExtensionsAtStartup(
  runtime: Pick<GovernedCreativeExtensionsRuntime, "recoverAfterCrash"> | null,
  staleBefore: string,
): Promise<GovernedCreativeExtensionStartupRecoveryResult> {
  if (runtime === null) {
    return {
      state: "disabled",
      recoveredRequestCount: 0,
      errorCode: null,
    };
  }
  try {
    return {
      state: "ready",
      recoveredRequestCount: await runtime.recoverAfterCrash(staleBefore),
      errorCode: null,
    };
  } catch {
    globalThis.console.error(
      "[EXTENSION_STARTUP_RECOVERY_FAILED] Governed provider reservations remain fail-closed.",
    );
    return {
      state: "degraded",
      recoveredRequestCount: 0,
      errorCode: "EXTENSION_STARTUP_RECOVERY_FAILED",
    };
  }
}

export function createDevelopmentRuntime(storage: Storage): DesktopRuntime {
  const repositories = createDevelopmentRepositories(storage);
  return buildRuntime(
    "browser-development",
    repositories,
    new BrowserCreativeJourneyStore(storage),
    new BrowserProjectSeedStore(storage),
    () => Promise.resolve(),
    null,
    (clock) => new BrowserDevelopmentTaskCenterStore(storage, clock),
    (clock) => new BrowserDevelopmentGenerationGovernanceStore(storage, clock),
    (clock) => new BrowserDevelopmentModelCenterStore(storage, clock),
    (clock, modelCenter) => new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter),
    (clock) => new BrowserDevelopmentModelHubStore(storage, clock),
    () => new BrowserDevelopmentContextCompilationTraceStore(storage),
    () => new BrowserDevelopmentChapterValidationSnapshotStore(storage),
    () => new BrowserDevelopmentWritingFeedbackStore(storage),
    (ids, clock, hasher) => {
      const sourceVersions = new RepositoryChapterVersionReader(repositories.chapters);
      const extractionItems = new BrowserDevelopmentReviewItemRepository(storage, "extraction");
      const consistencyItems = new BrowserDevelopmentReviewItemRepository(storage, "consistency");
      return {
        facts: new BrowserDevelopmentStoryFactStore(storage),
        causalGraph: new BrowserDevelopmentCausalEventGraphStore(
          storage,
          new RepositoryCausalEvidenceReader(repositories.chapterVersions),
        ),
        planningCandidates: new BrowserDevelopmentStoryPlanningCandidateStore(storage),
        ideationDrafts: new BrowserDevelopmentIdeationDraftRepository(storage),
        ideationProjects: new BrowserDevelopmentIdeationProjectCommitUnitOfWork(
          storage,
          ids,
          clock,
          hasher,
        ),
        outlines: new BrowserDevelopmentOutlineRepository(storage),
        formalRecords: new BrowserDevelopmentFormalStoryRecordRepository(storage),
        memoryPolicies: new BrowserDevelopmentMemoryPolicyRepository(storage),
        memoryRecords: new BrowserDevelopmentMemoryRecordRepository(storage),
        memoryCreation: new BrowserDevelopmentMemoryRecordCreationUnitOfWork(storage),
        memoryGovernance: new BrowserDevelopmentMemoryGovernanceUnitOfWork(storage),
        whatIfBranches: new BrowserDevelopmentWhatIfRepository(storage),
        whatIfPromotions: new BrowserDevelopmentWhatIfPromotionUnitOfWork(storage),
        outlineDrafts: new BrowserDevelopmentOutlineDraftReader(storage),
        sourceVersions,
        extractionItems,
        consistencyItems,
        extractionDecisions: new BrowserDevelopmentReviewDecisionUnitOfWork(
          storage,
          "extraction",
          sourceVersions,
        ),
        consistencyDecisions: new BrowserDevelopmentReviewDecisionUnitOfWork(
          storage,
          "consistency",
          sourceVersions,
        ),
        materials: new BrowserDevelopmentMaterialRepository(storage),
        materialReferences: new BrowserDevelopmentMaterialReferenceRepository(storage),
        materialDispositions: new BrowserDevelopmentMaterialDispositionUnitOfWork(storage),
      };
    },
    () => new BrowserDevelopmentProjectSearchSnapshotStore(storage),
    null,
    null,
  );
}

export interface ChapterStoryContextCompilationReceipt extends StoryContextCompilationReceipt {
  readonly projectPrivacy: ProjectContextPrivacyReceipt;
}

export interface PreparedGenerationPlan {
  readonly requestId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly generationId: string;
  readonly contextTraceId: string | null;
  readonly leaseToken: string;
  readonly idempotencyKey: string;
  readonly projectId: string | null;
  readonly chapterId: UuidV7;
  readonly baseVersionId: string | null;
  readonly partialCandidateId: UuidV7 | null;
  readonly partialCandidateContent: string | null;
  /** Exact saved-text UTF-16 anchor captured when the author requested continuation. */
  readonly applicationCursorUtf16: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelRole: ModelRouteRole;
  readonly routeReason:
    | "legacy_default"
    | "role_primary"
    | "role_fallback"
    | "model_hub_primary"
    | "model_hub_fallback"
    | "local_demo";
  readonly routeFallback: Readonly<{
    providerId: string;
    modelId: string;
  }> | null;
  readonly routeRequiresConfirmation: boolean;
  readonly deferredRequest: DeferredGenerationRequest | null;
  readonly maximumOutputTokens: number;
  readonly outputContract: ContinuationOutputContract;
  /** Request policy only; internal reasoning content is never exposed to the editor. */
  readonly visibleProseReasoningMode: "disabled" | "provider_default";
  readonly contextBudget: DynamicContextBudget;
  readonly tokenEstimateSource: "utf8_conservative" | "local_demo";
  readonly preflight: GenerationPreflightSnapshot;
  readonly profile: ModelProfile | null;
  /** In-memory resolved endpoint; providerId is the current versioned vault slot. */
  readonly legacyGatewayConfig: NativeModelEndpointConfig | null;
  /** In-memory authoritative identity used by the final pre-dispatch guard. */
  readonly legacyGatewayResolution: ModelProfileGatewayConfigResolution | null;
  /** In-memory only. Deferred/task persistence deliberately excludes prompt content. */
  readonly messages: readonly NativeModelMessage[];
  readonly contextCompilation: ChapterStoryContextCompilationReceipt | null;
  readonly novelSkillPreparation: PreparedNovelSkillInvocation;
  readonly executionMode: "local_demo" | "model_hub" | "legacy_profile";
  readonly modelHubInspection: ModelHubTextTaskInspection | null;
  readonly approvedPricing: ModelPricing | null;
}

export interface GovernedGenerationOutcome {
  readonly candidate: AiCandidate | null;
  /** A synchronous, evidence-bounded gate; null for cancelled partial output. */
  readonly qualityGate: CandidateQualityGateResult | null;
  readonly cancelled: boolean;
  /** True when provider-visible prose was preserved after an early stop. */
  readonly incomplete: boolean;
  readonly reused: boolean;
  readonly taskId: string;
  readonly runId: string;
}

export type GovernedGenerationError =
  AppError | ModelCenterError | GenerationGovernanceError | TaskEngineError;

const activeGenerationIdsByRuntime = new WeakMap<object, Map<string, string>>();
const cancelledGenerationTasksByRuntime = new WeakMap<object, Set<string>>();

export async function prepareGenerationPlan(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
  input: {
    readonly chapterSaved: boolean;
    readonly networkAvailable: boolean;
    readonly cursorUtf16?: number;
    readonly outputProfile?: ContinuationOutputProfileId;
    readonly customTargetVisibleCharacters?: number | null;
    readonly destination?: ContinuationOutputContract["destination"];
    readonly customDestinationInstruction?: string | null;
    readonly contextBudgetProfile?: ContextBudgetProfileId;
    readonly customContextBudget?: number | null;
    /** Resume an incomplete, still-isolated Candidate without changing正文. */
    readonly partialCandidateId?: UuidV7 | null;
  },
): Promise<PreparedGenerationPlan> {
  await runtime.taskCenter.recoverExpiredTasks();
  const requestId = runtime.ids.next();
  const modelRole: ModelRouteRole = "high_quality";
  const [chapterResult, waitingDeferred] = await Promise.all([
    runtime.repositories.chapters.findById(chapterId),
    runtime.generationGovernance.findWaitingDeferredRequest(chapterId, modelRole),
  ]);
  if (!chapterResult.ok) {
    throw chapterResult.error;
  }
  const chapter = chapterResult.value;
  let partialCandidate: AiCandidate | null = null;
  if (input.partialCandidateId !== undefined && input.partialCandidateId !== null) {
    const partialResult = await runtime.repositories.aiCandidates.findById(
      input.partialCandidateId,
    );
    if (!partialResult.ok) throw partialResult.error;
    const candidate = partialResult.value;
    if (
      candidate?.chapterId !== chapterId ||
      candidate.status !== "ready" ||
      !candidate.toSnapshot().incomplete ||
      candidate.applicationIntent.task !== "continuation"
    ) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "只能继续补全当前章节中仍待确认的不完整 AI 建议版本。",
        details: { field: "partialCandidateId" },
      });
    }
    partialCandidate = candidate;
  }
  const projectResult =
    chapter === null ? null : await runtime.repositories.projects.findById(chapter.projectId);
  if (projectResult !== null && !projectResult.ok) {
    throw projectResult.error;
  }
  const project = projectResult?.value ?? null;
  const generationPreflightScope =
    chapter === null
      ? undefined
      : Object.freeze({ projectId: chapter.projectId, chapterId: chapter.id });
  const applicationCursorUtf16 = resolveContinuationCursor(
    chapter?.content ?? "",
    partialCandidate?.applicationIntent.startUtf16 ?? input.cursorUtf16,
  );
  if (partialCandidate !== null && partialCandidate.baseVersionId !== chapter?.currentVersionId) {
    throw new AppError({
      code: "BASE_VERSION_CHANGED",
      message: "正文已在这段 AI 建议生成后发生变化，请保留当前建议并重新发起续写。",
      retryable: true,
      actions: ["RETRY", "EXPORT_DRAFT"],
    });
  }
  const demo = runtime.mode === "browser-development";
  let outputContract = resolveContinuationOutputContract({
    ...(input.outputProfile === undefined ? {} : { profile: input.outputProfile }),
    ...(input.customTargetVisibleCharacters === undefined
      ? {}
      : { customTargetVisibleCharacters: input.customTargetVisibleCharacters }),
    ...(input.destination === undefined ? {} : { destination: input.destination }),
    ...(input.customDestinationInstruction === undefined
      ? {}
      : { customDestinationInstruction: input.customDestinationInstruction }),
  });
  let maximumOutputTokens = outputContract.requestedMaxOutputTokens;
  let metadataInspection: ModelHubTextTaskInspection | null = null;
  let privacyPreview: ProjectContextPrivacyReceipt | null = null;
  if (!demo && chapter !== null) {
    privacyPreview = await runtime.projectContextPrivacy.inspect(chapter.projectId);
    runtime.projectContextPrivacy.assertChapterMatches(privacyPreview, chapter);
    const requiredDataDestination = projectContextRequiredDataDestination(privacyPreview);
    try {
      metadataInspection = await inspectModelHubTextTask(runtime, {
        task: "continuation",
        messages: Object.freeze([
          Object.freeze({
            role: "system" as const,
            content: "Inspect the configured continuation route without project content.",
          }),
        ]),
        maximumOutputTokens,
        temperature: 0.8,
        ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
      });
      recordSafeInvocationRouteDiagnostic(runtime, {
        taskType: "continuation",
        modelHubRouteFound: true,
        legacyProfileChecked: false,
        legacyProfileSelected: false,
        resolvedConnectionId: metadataInspection.connectionId,
        resolvedModelId: metadataInspection.modelId,
        routeSource: "model_hub",
        ready: true,
        blockerCode: null,
        checkedAt: runtime.clock.now(),
      });
    } catch (cause: unknown) {
      const routeMissing =
        cause instanceof ModelHubExecutionError && cause.code === "MODEL_HUB_ROUTE_NOT_CONFIGURED";
      if (!routeMissing) {
        const code =
          cause instanceof ModelHubExecutionError ? cause.code : "MODEL_HUB_PREFLIGHT_FAILED";
        recordSafeInvocationRouteDiagnostic(runtime, {
          taskType: "continuation",
          modelHubRouteFound:
            cause instanceof ModelHubExecutionError &&
            cause.code !== "MODEL_HUB_GATEWAY_UNAVAILABLE"
              ? true
              : null,
          legacyProfileChecked: false,
          legacyProfileSelected: false,
          resolvedConnectionId: null,
          resolvedModelId: null,
          routeSource: "none",
          ready: false,
          blockerCode: code,
          checkedAt: runtime.clock.now(),
        });
        recordSafeGenerationPreflightFailureDiagnostic(runtime, {
          taskType: "continuation",
          routeFound: code !== "MODEL_HUB_ROUTE_NOT_CONFIGURED",
          blockerCode: code,
          checkedAt: runtime.clock.now(),
          scope: generationPreflightScope,
        });
        throw new ModelCenterError(
          code,
          cause instanceof Error ? cause.message : "AI 分工检查失败，请检查模型、隐私和费用设置。",
          cause instanceof ModelHubExecutionError ? cause.retryable : true,
        );
      }
    }
  }

  let profile: ModelProfile | null = null;
  let routeResolved = demo || metadataInspection !== null;
  let routeReason: PreparedGenerationPlan["routeReason"] = demo ? "local_demo" : "legacy_default";
  let routeRequiresConfirmation = false;
  let routeFallback: PreparedGenerationPlan["routeFallback"] = null;
  let credentialConfigured = demo;
  let connectionStatus: "verified" | "failed" | "not_checked" = demo ? "verified" : "not_checked";
  let selectedModelAvailable = demo;
  let legacyGatewayConfig: NativeModelEndpointConfig | null = null;
  let legacyGatewayResolution: ModelProfileGatewayConfigResolution | null = null;

  if (!demo && metadataInspection === null) {
    const [profiles, roleRoute] = await Promise.all([
      runtime.modelCenter.listProfiles(),
      runtime.modelRouting.findRoute(modelRole),
    ]);
    routeFallback =
      roleRoute?.fallbackProviderId === null ||
      roleRoute?.fallbackProviderId === undefined ||
      roleRoute.fallbackModelId === null
        ? null
        : Object.freeze({
            providerId: roleRoute.fallbackProviderId,
            modelId: roleRoute.fallbackModelId,
          });
    if (roleRoute !== null) {
      const routeProfiles = profiles.filter(
        (candidate) =>
          candidate.selectedModel !== null &&
          ((candidate.providerId === roleRoute.primaryProviderId &&
            candidate.selectedModel === roleRoute.primaryModelId) ||
            (candidate.providerId === roleRoute.fallbackProviderId &&
              candidate.selectedModel === roleRoute.fallbackModelId)),
      );
      const inspections = await Promise.all(
        routeProfiles.map((candidate) =>
          inspectModelRouteProfile(runtime, candidate, input.networkAvailable),
        ),
      );
      const resolution = resolveModelRoute(
        {
          role: modelRole,
          primary: {
            providerId: roleRoute.primaryProviderId,
            modelId: roleRoute.primaryModelId,
          },
          fallback: routeFallback,
        },
        inspections.map(({ candidate }) => candidate),
      );
      routeResolved = resolution.status === "resolved";
      const selectedReference =
        resolution.status === "resolved" ? resolution.selected : resolution.preferred;
      const selectedInspection =
        selectedReference === null
          ? null
          : (inspections.find(
              ({ candidate }) =>
                candidate.providerId === selectedReference.providerId &&
                candidate.modelId === selectedReference.modelId,
            ) ?? null);
      profile =
        selectedInspection?.profile ??
        profiles.find(({ providerId }) => providerId === roleRoute.primaryProviderId) ??
        null;
      if (selectedInspection !== null) {
        credentialConfigured = selectedInspection.credentialConfigured;
        connectionStatus = selectedInspection.connectionStatus;
        selectedModelAvailable = selectedInspection.selectedModelAvailable;
        legacyGatewayConfig = selectedInspection.gatewayConfig;
        legacyGatewayResolution = selectedInspection.gatewayResolution;
      }
      if (resolution.status === "resolved") {
        routeReason = resolution.reason === "fallback_verified" ? "role_fallback" : "role_primary";
        routeRequiresConfirmation = resolution.requiresConfirmation;
      } else {
        routeReason = "role_primary";
      }
    } else {
      profile =
        profiles.find((candidate) => candidate.selectedModel !== null) ?? profiles[0] ?? null;
      if (profile !== null && profile.selectedModel !== null) {
        const inspected = await inspectModelRouteProfile(runtime, profile, input.networkAvailable);
        credentialConfigured = inspected.credentialConfigured;
        connectionStatus = inspected.connectionStatus;
        selectedModelAvailable = inspected.selectedModelAvailable;
        legacyGatewayConfig = inspected.gatewayConfig;
        legacyGatewayResolution = inspected.gatewayResolution;
        routeResolved = inspected.gatewayResolution !== null;
      }
    }
    const legacyConnectionId = profile?.providerId ?? null;
    const legacySelectedModel = profile?.selectedModel ?? null;
    const legacySelection =
      routeResolved &&
      legacyConnectionId !== null &&
      legacySelectedModel !== null &&
      legacyGatewayResolution !== null
        ? Object.freeze({ connectionId: legacyConnectionId, modelId: legacySelectedModel })
        : null;
    const legacyReady = legacySelection !== null;
    const blockerCode = legacyReady ? null : "MODEL_PROFILE_NOT_READY";
    recordSafeInvocationRouteDiagnostic(runtime, {
      taskType: "continuation",
      modelHubRouteFound: false,
      legacyProfileChecked: true,
      legacyProfileSelected: profile?.selectedModel !== null && profile !== null,
      resolvedConnectionId: legacySelection?.connectionId ?? null,
      resolvedModelId: legacySelection?.modelId ?? null,
      routeSource: legacyReady ? "legacy_profile" : "none",
      ready: legacyReady,
      blockerCode,
      checkedAt: runtime.clock.now(),
    });
  }

  let providerId = demo ? "local-demo" : (profile?.providerId ?? "unconfigured");
  let modelId = demo ? "built-in-demo" : (profile?.selectedModel ?? "unselected");
  let contextBudget = resolveDynamicContextBudget({
    ...(input.contextBudgetProfile === undefined ? {} : { profile: input.contextBudgetProfile }),
    ...(input.customContextBudget === undefined ? {} : { customLimit: input.customContextBudget }),
    modelContextWindow: demo
      ? null
      : (metadataInspection?.inputTokenLimit ?? profile?.pricing?.contextWindowTokens ?? null),
    outputReserve: maximumOutputTokens,
  });
  let messages: readonly NativeModelMessage[] = [];
  let contextCompilation: ChapterStoryContextCompilationReceipt | null = null;
  let novelSkillPreparation = runtime.novelSkills.describeNotApplied(
    demo ? "browser_demo" : "legacy_route_untraceable",
  );
  let modelHubInspection: ModelHubTextTaskInspection | null = null;
  let executionMode: PreparedGenerationPlan["executionMode"] = demo
    ? "local_demo"
    : metadataInspection === null
      ? "legacy_profile"
      : "model_hub";
  if (demo && chapter !== null) {
    messages = buildContinuationMessages(chapter);
  } else if (chapter !== null) {
    privacyPreview ??= await runtime.projectContextPrivacy.inspect(chapter.projectId);
    runtime.projectContextPrivacy.assertChapterMatches(privacyPreview, chapter);
    const requiredDataDestination = projectContextRequiredDataDestination(privacyPreview);
    if (metadataInspection !== null) {
      executionMode = "model_hub";
      providerId = metadataInspection.connectionId;
      modelId = metadataInspection.modelId;
      outputContract = resolveContinuationOutputContract({
        ...(input.outputProfile === undefined ? {} : { profile: input.outputProfile }),
        ...(input.customTargetVisibleCharacters === undefined
          ? {}
          : { customTargetVisibleCharacters: input.customTargetVisibleCharacters }),
        ...(input.destination === undefined ? {} : { destination: input.destination }),
        ...(input.customDestinationInstruction === undefined
          ? {}
          : { customDestinationInstruction: input.customDestinationInstruction }),
        providerOutputLimit: metadataInspection.maximumOutputTokens,
      });
      maximumOutputTokens = outputContract.requestedMaxOutputTokens;
      contextBudget = resolveDynamicContextBudget({
        ...(input.contextBudgetProfile === undefined
          ? {}
          : { profile: input.contextBudgetProfile }),
        ...(input.customContextBudget === undefined
          ? {}
          : { customLimit: input.customContextBudget }),
        modelContextWindow: metadataInspection.inputTokenLimit,
        outputReserve: maximumOutputTokens,
      });
    }
    if (contextBudget.budgetStatus === "model_window_exhausted") {
      recordSafeGenerationPreflightFailureDiagnostic(runtime, {
        taskType: "continuation",
        routeFound: metadataInspection !== null || routeResolved,
        blockerCode: "MODEL_CONTEXT_WINDOW_EXHAUSTED",
        checkedAt: runtime.clock.now(),
        scope: generationPreflightScope,
      });
      throw new ModelCenterError(
        "MODEL_CONTEXT_WINDOW_EXHAUSTED",
        "当前模型的上下文窗口不足以同时容纳本次续写输出和必要指令。请缩短输出长度或更换模型。",
      );
    }
    try {
      const preparedContext = await buildContextualContinuationMessages(
        runtime,
        chapter,
        contextBudget.effectiveInputBudget,
        partialCandidate?.content ?? null,
        outputContract,
        metadataInspection !== null,
      );
      messages = preparedContext.messages;
      contextCompilation = preparedContext.contextCompilation;
      novelSkillPreparation = preparedContext.novelSkillPreparation;
    } catch (cause: unknown) {
      const normalized = normalizeStoryContextFailure(cause);
      recordSafeGenerationPreflightFailureDiagnostic(runtime, {
        taskType: "continuation",
        routeFound: metadataInspection !== null || routeResolved,
        blockerCode: normalized.code,
        checkedAt: runtime.clock.now(),
        scope: generationPreflightScope,
      });
      throw normalized;
    }
    if (metadataInspection !== null) {
      try {
        modelHubInspection = await inspectModelHubTextTask(runtime, {
          task: "continuation",
          messages,
          maximumOutputTokens,
          temperature: 0.8,
          ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
        });
      } catch (cause: unknown) {
        const code =
          cause instanceof ModelHubExecutionError ? cause.code : "MODEL_HUB_PREFLIGHT_FAILED";
        recordSafeInvocationRouteDiagnostic(runtime, {
          taskType: "continuation",
          modelHubRouteFound: true,
          legacyProfileChecked: false,
          legacyProfileSelected: false,
          resolvedConnectionId: metadataInspection.connectionId,
          resolvedModelId: metadataInspection.modelId,
          routeSource: "model_hub",
          ready: false,
          blockerCode: code,
          checkedAt: runtime.clock.now(),
        });
        recordSafeGenerationPreflightFailureDiagnostic(runtime, {
          taskType: "continuation",
          routeFound: true,
          blockerCode: code,
          checkedAt: runtime.clock.now(),
          scope: generationPreflightScope,
        });
        throw new ModelCenterError(
          code,
          cause instanceof Error ? cause.message : "AI 分工检查失败，请检查模型、隐私和费用设置。",
          cause instanceof ModelHubExecutionError ? cause.retryable : true,
        );
      }
      maximumOutputTokens = modelHubInspection.maximumOutputTokens;
      providerId = modelHubInspection.connectionId;
      modelId = modelHubInspection.modelId;
      routeResolved = true;
      routeReason = modelHubInspection.usedFallback ? "model_hub_fallback" : "model_hub_primary";
      routeRequiresConfirmation = modelHubInspection.usedFallback;
      routeFallback = null;
      credentialConfigured = true;
      connectionStatus = "verified";
      selectedModelAvailable = true;
      profile = null;
      legacyGatewayConfig = null;
      legacyGatewayResolution = null;
      recordSafeInvocationRouteDiagnostic(runtime, {
        taskType: "continuation",
        modelHubRouteFound: true,
        legacyProfileChecked: false,
        legacyProfileSelected: false,
        resolvedConnectionId: modelHubInspection.connectionId,
        resolvedModelId: modelHubInspection.modelId,
        routeSource: "model_hub",
        ready: true,
        blockerCode: null,
        checkedAt: runtime.clock.now(),
      });
    }
  }
  if (
    !demo &&
    contextCompilation?.projectPrivacy.requiresVerifiedLocal === true &&
    modelHubInspection === null &&
    !isVerifiedLocalGatewayConfig(legacyGatewayConfig)
  ) {
    recordSafeGenerationPreflightFailureDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: metadataInspection !== null || routeResolved,
      blockerCode: "PRIVATE_CHAPTER_LOCAL_ONLY",
      checkedAt: runtime.clock.now(),
      scope: generationPreflightScope,
    });
    throw privateChapterModelBlocked();
  }
  const inputBytes = demo ? 0 : measureMessageBytes(messages);
  const inputTokens = demo
    ? 0
    : (modelHubInspection?.estimatedInputTokens ?? Math.ceil(inputBytes / 3));
  const pricing = resolvePreparedGenerationPricing(
    runtime.clock.now(),
    profile,
    modelHubInspection,
  );
  const monthKey = runtime.clock.now().slice(0, 7);
  const budgets =
    chapter === null || pricing === null
      ? []
      : await runtime.generationGovernance.getBudgetLimits(
          chapter.projectId,
          monthKey,
          pricing.currency,
        );
  const basePreflight = runGenerationPreflight({
    now: runtime.clock.now(),
    migrationReady: true,
    chapterExists: chapter !== null,
    chapterSaved: input.chapterSaved,
    projectWritable: project?.status === "active",
    gatewayAvailable: demo || runtime.modelGateway.available,
    networkAvailable: input.networkAvailable,
    providerLocation: demo
      ? "demo"
      : modelHubInspection?.dataDestination === "local" ||
          isVerifiedLocalGatewayConfig(legacyGatewayConfig)
        ? "local"
        : "remote",
    routeResolved,
    profileConfigured: demo || modelHubInspection !== null || profile !== null,
    modelSelected: demo || modelHubInspection !== null || profile?.selectedModel !== null,
    credentialConfigured,
    connectionStatus,
    selectedModelAvailable,
    inputBytes,
    maximumInputBytes: 1_000_000,
    inputTokens,
    maximumOutputTokens,
    maximumCompiledInputTokens: Math.max(1, contextBudget.effectiveInputBudget),
    contextWindowTokens: demo
      ? null
      : (modelHubInspection?.inputTokenLimit ?? profile?.pricing?.contextWindowTokens ?? null),
    tokenizerStatus: demo ? "exact" : "approximate",
    pricing,
    budgets,
  });
  const preflight: GenerationPreflightSnapshot = Object.freeze({
    ...basePreflight,
    generationBudget: Object.freeze({
      outputProfile: outputContract.profile,
      targetVisibleCharacters: outputContract.targetVisibleCharacters,
      minimumVisibleCharacters: outputContract.minimumVisibleCharacters,
      maximumVisibleCharacters: outputContract.maximumVisibleCharacters,
      requestedMaximumOutputTokens: maximumOutputTokens,
      providerOutputLimit: outputContract.providerOutputLimit,
      contextProfile: contextBudget.profile,
      effectiveInputBudget: contextBudget.effectiveInputBudget,
      budgetStatus: contextBudget.budgetStatus,
    }),
    contextSelectionSummary: safeContextSelectionSummary(
      contextCompilation,
      contextBudget.effectiveInputBudget,
    ),
  });
  recordSafeGenerationPreflightDiagnostic(runtime, {
    taskType: "continuation",
    routeFound: routeResolved,
    connectionUsable:
      credentialConfigured && connectionStatus !== "failed" && selectedModelAvailable,
    capabilityStatus:
      !routeResolved || !selectedModelAvailable
        ? "unavailable"
        : modelHubInspection !== null || connectionStatus === "verified"
          ? "supported"
          : "unknown",
    snapshot: preflight,
    scope: generationPreflightScope,
  });
  const baseVersionId = chapter?.currentVersionId ?? null;
  let deferredRequest = waitingDeferred;
  if (
    deferredRequest !== null &&
    baseVersionId !== null &&
    deferredRequest.baseVersionId !== baseVersionId
  ) {
    await runtime.generationGovernance.transitionDeferredRequest({
      id: deferredRequest.id,
      expectedRevision: deferredRequest.revision,
      status: "blocked_stale",
    });
    await runtime.taskCenter.cancelTask(deferredRequest.taskId).catch(() => undefined);
    deferredRequest = null;
  }
  const retryableRun =
    baseVersionId === null || preflight.estimate === null || !preflight.canStart
      ? null
      : await runtime.generationGovernance.findLatestRetryableRun({
          chapterId,
          baseVersionId,
          providerId,
          modelId,
          pricingVersion: preflight.estimate.pricingVersion,
          estimatedCostMicros: preflight.estimate.micros.toString(),
        });
  const deferredResumeIdempotencyKey =
    deferredRequest === null ? null : `ai.generate.resume:${deferredRequest.id}`;
  const deferredResumeRun =
    retryableRun === null && deferredResumeIdempotencyKey !== null
      ? await runtime.generationGovernance.findRunByIdempotencyKey(deferredResumeIdempotencyKey)
      : null;
  const idempotencyKey =
    retryableRun?.idempotencyKey ??
    deferredResumeRun?.idempotencyKey ??
    deferredResumeIdempotencyKey ??
    (baseVersionId === null
      ? `ai.generate:blocked:${requestId}`
      : `ai.generate:${chapterId}:${baseVersionId}:${requestId}`);
  const generationId = runtime.ids.next();
  const contextTraceId =
    contextCompilation === null || chapter === null ? null : runtime.ids.next();
  return Object.freeze({
    requestId,
    taskId: retryableRun?.taskId ?? deferredResumeRun?.taskId ?? runtime.ids.next(),
    runId: retryableRun?.id ?? deferredResumeRun?.id ?? runtime.ids.next(),
    generationId,
    contextTraceId,
    leaseToken: runtime.ids.next(),
    idempotencyKey,
    projectId: chapter?.projectId ?? null,
    chapterId,
    baseVersionId,
    partialCandidateId: partialCandidate?.id ?? null,
    partialCandidateContent: partialCandidate?.content ?? null,
    applicationCursorUtf16,
    providerId,
    modelId,
    modelRole,
    routeReason,
    routeFallback,
    routeRequiresConfirmation,
    deferredRequest,
    maximumOutputTokens,
    outputContract,
    visibleProseReasoningMode: preparedGenerationReasoningMode({
      executionMode,
      modelHubInspection,
      legacyGatewayConfig,
    }),
    contextBudget,
    tokenEstimateSource: demo ? "local_demo" : "utf8_conservative",
    preflight,
    profile,
    legacyGatewayConfig,
    legacyGatewayResolution,
    messages,
    contextCompilation,
    novelSkillPreparation,
    executionMode,
    modelHubInspection,
    approvedPricing: pricing,
  });
}

function safeContextSelectionSummary(
  receipt: ChapterStoryContextCompilationReceipt | null,
  effectiveInputBudget: number,
): NonNullable<GenerationPreflightSnapshot["contextSelectionSummary"]> {
  if (receipt === null) {
    return Object.freeze({
      availableSourceCount: 0,
      selectedSourceCount: 0,
      deduplicatedSourceCount: 0,
      excludedSourceCount: 0,
      estimatedSelectedTokens: 0,
      effectiveInputBudget,
      excludedReasonCounts: Object.freeze([]),
      missingSourceTypes: Object.freeze([]),
    });
  }
  const entries = receipt.compiled.entries;
  const excluded = entries.filter(({ included }) => !included);
  const reasonCounts = new Map<string, number>();
  for (const entry of excluded) {
    const reason = entry.discardedReason ?? "unknown";
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const missingSourceTypes = receipt.compiled.trace.layers
    .filter(({ candidateCount }) => candidateCount === 0)
    .map(({ layer }) => layer);
  return Object.freeze({
    availableSourceCount: entries.length,
    selectedSourceCount: entries.filter(({ included }) => included).length,
    deduplicatedSourceCount: excluded.filter(
      ({ discardedReason }) => discardedReason === "duplicate_source",
    ).length,
    excludedSourceCount: excluded.length,
    estimatedSelectedTokens: receipt.compiled.trace.usedTokens,
    effectiveInputBudget,
    excludedReasonCounts: Object.freeze(
      [...reasonCounts.entries()].map(([reason, count]) => Object.freeze({ reason, count })),
    ),
    missingSourceTypes: Object.freeze(missingSourceTypes),
  });
}

function preparedGenerationReasoningMode(
  plan: Pick<
    PreparedGenerationPlan,
    "executionMode" | "modelHubInspection" | "legacyGatewayConfig"
  >,
): PreparedGenerationPlan["visibleProseReasoningMode"] {
  if (plan.executionMode === "model_hub" && plan.modelHubInspection !== null) {
    return modelProviderVisibleProsePolicy(plan.modelHubInspection.providerKind).reasoningMode ===
      "disabled"
      ? "disabled"
      : "provider_default";
  }
  if (plan.executionMode === "legacy_profile" && plan.legacyGatewayConfig !== null) {
    return legacyVisibleProseReasoningPolicy(plan.legacyGatewayConfig).reasoningMode === "disabled"
      ? "disabled"
      : "provider_default";
  }
  return "provider_default";
}

function resolveContinuationCursor(content: string, requested: number | undefined): number {
  const cursor = requested ?? content.length;
  const splitsSurrogate =
    cursor > 0 &&
    cursor < content.length &&
    content.charCodeAt(cursor - 1) >= 0xd800 &&
    content.charCodeAt(cursor - 1) <= 0xdbff &&
    content.charCodeAt(cursor) >= 0xdc00 &&
    content.charCodeAt(cursor) <= 0xdfff;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > content.length || splitsSurrogate) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "The continuation cursor is no longer a valid saved-text position.",
      details: { field: "cursorUtf16" },
    });
  }
  return cursor;
}

function resolvePreparedGenerationPricing(
  now: string,
  profile: ModelProfile | null,
  inspection: ModelHubTextTaskInspection | null,
): ModelPricing | null {
  if (inspection !== null) {
    const source = inspection.pricing;
    if (
      source.currency !== null &&
      source.inputMicrosPerMillionTokens !== null &&
      source.outputMicrosPerMillionTokens !== null &&
      source.pricingVersion !== null &&
      source.priceUpdatedAt !== null
    ) {
      return Object.freeze({
        currency: source.currency,
        pricingVersion: source.pricingVersion,
        updatedAt: source.priceUpdatedAt,
        inputMicrosPerMillionTokens: BigInt(source.inputMicrosPerMillionTokens),
        outputMicrosPerMillionTokens: BigInt(source.outputMicrosPerMillionTokens),
        ...(source.cachedInputMicrosPerMillionTokens === null
          ? {}
          : {
              cachedInputMicrosPerMillionTokens: BigInt(source.cachedInputMicrosPerMillionTokens),
            }),
      });
    }
    if (inspection.dataDestination === "local") {
      return Object.freeze({
        currency: source.currency ?? "USD",
        pricingVersion: source.pricingVersion ?? "model-hub-local-zero-cost",
        updatedAt: source.priceUpdatedAt ?? now,
        inputMicrosPerMillionTokens: 0n,
        outputMicrosPerMillionTokens: 0n,
        cachedInputMicrosPerMillionTokens: 0n,
      });
    }
    return null;
  }
  if (profile?.pricing === null || profile?.pricing === undefined) {
    return null;
  }
  return Object.freeze({
    currency: profile.pricing.currency,
    pricingVersion: profile.pricing.pricingVersion,
    updatedAt: profile.pricing.priceUpdatedAt,
    inputMicrosPerMillionTokens: BigInt(profile.pricing.inputMicrosPerMillionTokens),
    outputMicrosPerMillionTokens: BigInt(profile.pricing.outputMicrosPerMillionTokens),
    ...(profile.pricing.cachedInputMicrosPerMillionTokens === null
      ? {}
      : {
          cachedInputMicrosPerMillionTokens: BigInt(
            profile.pricing.cachedInputMicrosPerMillionTokens,
          ),
        }),
  });
}

export function canDeferGenerationPlan(plan: PreparedGenerationPlan): boolean {
  const blockingCodes = plan.preflight.checks
    .filter(({ severity }) => severity === "blocking")
    .map(({ code }) => code);
  return (
    plan.deferredRequest === null &&
    plan.projectId !== null &&
    plan.baseVersionId !== null &&
    plan.profile?.provider === "open_ai_compatible" &&
    plan.preflight.estimate !== null &&
    !plan.preflight.canStart &&
    blockingCodes.length === 1 &&
    blockingCodes[0] === "NETWORK_OFFLINE"
  );
}

export async function saveDeferredGenerationPlan(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
): Promise<DeferredGenerationRequest> {
  if (plan.deferredRequest !== null) {
    return plan.deferredRequest;
  }
  if (!canDeferGenerationPlan(plan) || plan.projectId === null || plan.baseVersionId === null) {
    throw new GenerationGovernanceError(
      "AI_DEFERRED_PREFLIGHT_INELIGIBLE",
      "Only a saved remote generation blocked solely by network availability can be deferred.",
    );
  }
  const requestId = runtime.ids.next();
  const taskId = runtime.ids.next();
  const idempotencyKey = `ai.generate.deferred:${plan.chapterId}:${plan.baseVersionId}:${plan.modelRole}`;
  const enqueued = await runtime.taskCenter.enqueueTask({
    id: taskId,
    type: "ai.generate.deferred",
    idempotencyKey,
    metadata: {
      projectId: plan.projectId,
      chapterId: plan.chapterId,
      baseVersionId: plan.baseVersionId,
      providerId: plan.providerId,
      modelRole: plan.modelRole,
      operation: "wait_for_network",
    },
    priority: 70,
    maxAttempts: 1,
    now: runtime.clock.now(),
    runAfter: "9999-12-31T23:59:59.999Z",
  });
  const created = await runtime.generationGovernance.createDeferredRequest({
    id: requestId,
    taskId: enqueued.task.id,
    idempotencyKey,
    projectId: plan.projectId,
    chapterId: plan.chapterId,
    baseVersionId: plan.baseVersionId,
    modelRole: plan.modelRole,
    providerId: plan.providerId,
    modelId: plan.modelId,
    maximumOutputTokens: plan.maximumOutputTokens,
    preflight: plan.preflight,
  });
  return created.request;
}

export async function executeGenerationPlan(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  onDelta?: (accumulatedText: string) => void,
): Promise<Result<GovernedGenerationOutcome, GovernedGenerationError>> {
  if (!plan.preflight.canStart || plan.projectId === null || plan.baseVersionId === null) {
    return err(
      new GenerationGovernanceError(
        "AI_GENERATION_PREFLIGHT_BLOCKED",
        "Generation cannot start while preflight has blocking checks.",
      ),
    );
  }
  const chapterResult = await runtime.repositories.chapters.findById(plan.chapterId);
  if (!chapterResult.ok) {
    return chapterResult;
  }
  const chapter = chapterResult.value;
  if (chapter === null) {
    return err(
      new AppError({
        code: "CHAPTER_NOT_FOUND",
        message: "Chapter does not exist.",
      }),
    );
  }
  if (chapter.currentVersionId !== plan.baseVersionId) {
    return err(
      new AppError({
        code: "BASE_VERSION_CHANGED",
        message: "The chapter changed after generation preflight.",
        retryable: true,
        actions: ["RETRY", "EXPORT_DRAFT"],
      }),
    );
  }
  try {
    await assertGenerationProjectActive(runtime, plan.projectId);
  } catch (cause: unknown) {
    return err(normalizeGovernedGenerationError(cause));
  }
  if (plan.contextCompilation !== null) {
    try {
      runtime.projectContextPrivacy.assertChapterMatches(
        plan.contextCompilation.projectPrivacy,
        chapter,
      );
      runtime.projectContextPrivacy.assertRouteEligible(
        plan.contextCompilation.projectPrivacy,
        isPreparedGenerationTargetLocal(plan),
      );
    } catch (cause: unknown) {
      return err(normalizeProjectContextPrivacyFailure(cause));
    }
  }

  try {
    const enqueued = await runtime.taskCenter.enqueueTask({
      id: plan.taskId,
      type: "ai.generate",
      idempotencyKey: plan.idempotencyKey,
      metadata: {
        projectId: plan.projectId,
        chapterId: plan.chapterId,
        baseVersionId: plan.baseVersionId,
        providerId: plan.providerId,
        operation: "generate",
      },
      priority: 80,
      maxAttempts: 3,
      now: runtime.clock.now(),
    });
    const runResult = await runtime.generationGovernance.createRun({
      id: plan.runId,
      taskId: enqueued.task.id,
      idempotencyKey: plan.idempotencyKey,
      projectId: plan.projectId,
      chapterId: plan.chapterId,
      baseVersionId: plan.baseVersionId,
      providerId: plan.providerId,
      modelId: plan.modelId,
      route: {
        role: plan.modelRole,
        reason:
          plan.routeReason === "model_hub_primary"
            ? "role_primary"
            : plan.routeReason === "model_hub_fallback"
              ? "role_fallback"
              : plan.routeReason,
        fallbackProviderId: plan.routeFallback?.providerId ?? null,
        fallbackModelId: plan.routeFallback?.modelId ?? null,
      },
      preflight: plan.preflight,
    });
    let run = runResult.run;
    if (plan.deferredRequest !== null) {
      if (plan.deferredRequest.baseVersionId !== plan.baseVersionId) {
        throw new GenerationGovernanceError(
          "AI_DEFERRED_BASE_VERSION_CHANGED",
          "The deferred generation base version changed before execution.",
        );
      }
      await runtime.taskCenter.cancelTask(plan.deferredRequest.taskId);
      await runtime.generationGovernance.transitionDeferredRequest({
        id: plan.deferredRequest.id,
        expectedRevision: plan.deferredRequest.revision,
        status: "consumed",
        consumedRunId: run.id,
      });
    }
    if (!runResult.created && run.state === "completed" && run.candidateId !== null) {
      const candidateId = parseDomainUuid(run.candidateId);
      if (!candidateId.ok) {
        return candidateId;
      }
      const candidate = await runtime.repositories.aiCandidates.findById(candidateId.value);
      if (!candidate.ok) {
        return candidate;
      }
      if (candidate.value === null) {
        return err(
          new GenerationGovernanceError(
            "AI_GENERATION_CANDIDATE_MISSING",
            "The idempotent generation candidate is no longer available.",
          ),
        );
      }
      await publishGenerationNotification(
        runtime,
        plan,
        candidate.value.toSnapshot().incomplete ? "partial" : "completed",
        run.attempt,
      );
      const qualityGate = await evaluateCandidateAgainstLocalGate(
        runtime,
        plan,
        candidate.value,
        chapter.content,
      );
      return ok({
        candidate: candidate.value,
        qualityGate,
        cancelled: false,
        incomplete: candidate.value.toSnapshot().incomplete,
        reused: true,
        taskId: enqueued.task.id,
        runId: run.id,
      });
    }
    const task = enqueued.task;
    if (
      !runResult.created &&
      run.state === "failed_retryable" &&
      task.status === "waiting_retry" &&
      task.runAfter !== null &&
      Date.parse(task.runAfter) <= Date.parse(runtime.clock.now())
    ) {
      run = await runtime.generationGovernance.transitionRun({
        runId: run.id,
        expectedRevision: run.revision,
        state: "queued",
        attempt: run.attempt + 1,
        failureCode: null,
      });
    } else if (!runResult.created && run.state !== "queued") {
      return err(
        new GenerationGovernanceError(
          "AI_GENERATION_ALREADY_ACTIVE",
          "This generation request is already active or waiting for retry.",
          true,
        ),
      );
    }

    const leaseExpiresAt = new Date(
      Date.parse(runtime.clock.now()) + 15 * 60 * 1_000,
    ).toISOString();
    await runtime.taskCenter.startTask(
      task.id,
      "desktop.foreground",
      plan.leaseToken,
      leaseExpiresAt,
    );
    run = await runtime.generationGovernance.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      state: "retrieving",
    });
    await runtime.taskCenter.reportTaskProgress(
      plan.taskId,
      plan.leaseToken,
      "context.retrieving",
      1,
      5,
    );
    await persistPreparedContextTrace(runtime, plan);
    run = await runtime.generationGovernance.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      state: "generating",
    });
    await runtime.taskCenter.reportTaskProgress(
      plan.taskId,
      plan.leaseToken,
      "model.generating",
      2,
      5,
    );

    let accumulated = "";
    let candidate!: AiCandidate;
    let activeExecutionPlan = plan;
    let attemptUsage: GenerationAttemptUsageInput = {
      source: "provider_unavailable",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      usagePricedEstimateMicros: null,
    };
    try {
      if (runtime.mode === "browser-development") {
        await assertGenerationProjectActive(runtime, plan.projectId);
        const demo = await createLocalDemoCandidate(
          runtime,
          plan.chapterId,
          plan.applicationCursorUtf16,
        );
        if (!demo.ok) {
          throw demo.error;
        }
        candidate = demo.value;
        attemptUsage = {
          source: "local_demo",
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          usagePricedEstimateMicros: "0",
        };
      } else {
        const privacyReceipt = plan.contextCompilation?.projectPrivacy ?? null;
        if (privacyReceipt === null) {
          throw new ModelCenterError(
            "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
            "无法建立作品隐私边界，因此没有调用 AI。",
            true,
          );
        }
        const requiredDataDestination = projectContextRequiredDataDestination(privacyReceipt);
        const executeProviderAttempt = (
          attemptPlan: PreparedGenerationPlan,
          forceReasoningDisabled: boolean,
        ): Promise<NativeModelGenerationResult | ModelHubTextTaskExecutionResult> => {
          assertGenerationTaskNotCancelled(runtime, attemptPlan.taskId);
          setActiveGenerationId(runtime, attemptPlan.taskId, attemptPlan.generationId);
          const execution =
            attemptPlan.executionMode === "model_hub"
              ? executeModelHubTextTask(runtime, {
                  dispatchScope: projectContextDispatchScope(privacyReceipt),
                  task: "continuation",
                  messages: attemptPlan.messages,
                  maximumOutputTokens: attemptPlan.maximumOutputTokens,
                  temperature: 0.8,
                  reasoningPolicy: "visible_prose",
                  ...(forceReasoningDisabled ? { reasoningModeOverride: "disabled" as const } : {}),
                  ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
                  generationId: attemptPlan.generationId,
                  onBeforeDispatch: async ({
                    invocationId,
                    connectionId,
                    modelId,
                    localOnlyEligible,
                  }) => {
                    if (
                      connectionId !== attemptPlan.providerId ||
                      modelId !== attemptPlan.modelId
                    ) {
                      throw new ModelHubExecutionError(
                        "MODEL_HUB_PLAN_CHANGED",
                        "AI 分工在生成前发生变化。为避免使用未经本次检查的模型，请重新执行生成前检查。",
                        true,
                      );
                    }
                    await linkPreparedContextModelInvocation(runtime, attemptPlan, invocationId);
                    await assertGenerationProjectActive(runtime, attemptPlan.projectId);
                    await assertProjectContextBeforeModelHubDispatch(
                      runtime,
                      privacyReceipt,
                      localOnlyEligible === true,
                    );
                    await commitPreparedNovelSkillSnapshot(runtime, attemptPlan, invocationId);
                    await assertPreparedGenerationTargetCurrent(runtime, attemptPlan);
                    await assertProjectContextBeforeModelHubDispatch(
                      runtime,
                      privacyReceipt,
                      localOnlyEligible === true,
                    );
                  },
                  onFinalBeforeProviderDispatch: async ({ localOnlyEligible }) => {
                    await assertGenerationProjectActive(runtime, attemptPlan.projectId);
                    await assertPreparedGenerationTargetCurrent(runtime, attemptPlan);
                    await assertProjectContextBeforeModelHubDispatch(
                      runtime,
                      privacyReceipt,
                      localOnlyEligible === true,
                    );
                  },
                  assertBeforeProviderDispatch: () =>
                    assertGenerationTaskNotCancelled(runtime, attemptPlan.taskId),
                  onDelta: (next) => {
                    accumulated = next;
                    onDelta?.(
                      combineContinuationFragments(attemptPlan.partialCandidateContent ?? "", next),
                    );
                  },
                })
              : generateLegacyContinuation(
                  runtime,
                  attemptPlan,
                  (next) => {
                    accumulated = next;
                    onDelta?.(
                      combineContinuationFragments(attemptPlan.partialCandidateContent ?? "", next),
                    );
                  },
                  {
                    generationId: attemptPlan.generationId,
                    forceReasoningDisabled,
                  },
                );
          return execution.finally(() =>
            clearActiveGenerationId(runtime, attemptPlan.taskId, attemptPlan.generationId),
          );
        };
        let generated: NativeModelGenerationResult | ModelHubTextTaskExecutionResult;
        try {
          generated = await executeProviderAttempt(activeExecutionPlan, false);
        } catch (firstCause: unknown) {
          const normalizedFirst = normalizeGovernedGenerationError(firstCause);
          if (!shouldRetryReasoningOnlyTruncation(plan, normalizedFirst, accumulated)) {
            throw firstCause;
          }
          accumulated = "";
          activeExecutionPlan = Object.freeze({
            ...plan,
            generationId: runtime.ids.next(),
            contextTraceId: plan.contextTraceId === null ? null : runtime.ids.next(),
          });
          await persistPreparedContextTrace(runtime, activeExecutionPlan);
          generated = await executeProviderAttempt(activeExecutionPlan, true);
        }
        let currentChapter: Chapter;
        try {
          currentChapter = await assertPreparedGenerationTargetCurrent(
            runtime,
            activeExecutionPlan,
          );
        } catch (cause: unknown) {
          // A cancellation that wins after the provider returns is an explicit
          // instruction to discard that late response, not to preserve it as
          // an incomplete Candidate.
          accumulated = "";
          throw cause;
        }
        attemptUsage = priceProviderReportedUsage(plan, generated.usage);
        accumulated = generated.text;
        const completeVisibleText = combineContinuationFragments(
          plan.partialCandidateContent ?? "",
          generated.text,
        );
        const built = await buildGeneratedCandidate(
          runtime,
          currentChapter,
          completeVisibleText,
          false,
          plan.applicationCursorUtf16,
        );
        if (!built.ok) {
          throw built.error;
        }
        candidate = built.value;
      }
      await commitPreparedContextOutputCandidate(runtime, activeExecutionPlan, candidate);
    } catch (cause: unknown) {
      const normalized = normalizeGovernedGenerationError(cause);
      recordSafeGenerationErrorCode(runtime, normalized.code);
      let recoveredTruncation = false;
      if (normalized.code === "MODEL_OUTPUT_TRUNCATED") {
        const visible = recoverVisiblePartialOutput(accumulated);
        if (visible.preserved) {
          const built = await buildGeneratedCandidate(
            runtime,
            chapter,
            combineContinuationFragments(plan.partialCandidateContent ?? "", visible.text),
            true,
            plan.applicationCursorUtf16,
          );
          if (built.ok) {
            await commitPreparedContextOutputCandidate(runtime, activeExecutionPlan, built.value);
            candidate = built.value;
            recoveredTruncation = true;
          }
        }
      }
      if (normalized.code === "MODEL_GENERATION_CANCELLED") {
        let partialCandidate: AiCandidate | null = null;
        const visible = recoverVisiblePartialOutput(accumulated);
        if (visible.preserved) {
          const built = await buildGeneratedCandidate(
            runtime,
            chapter,
            combineContinuationFragments(plan.partialCandidateContent ?? "", visible.text),
            true,
            plan.applicationCursorUtf16,
          );
          if (built.ok) {
            try {
              await commitPreparedContextOutputCandidate(runtime, activeExecutionPlan, built.value);
              partialCandidate = built.value;
            } catch {}
          }
        }
        run = await runtime.generationGovernance.transitionRun({
          runId: run.id,
          expectedRevision: run.revision,
          state: "cancelled",
          candidateId: partialCandidate?.id ?? null,
          addIncurredCost: true,
          attemptUsage,
        });
        await runtime.taskCenter.cancelTask(plan.taskId).catch(() => undefined);
        await runtime.taskCenter
          .acknowledgeTaskCancellation(plan.taskId, plan.leaseToken)
          .catch(() => undefined);
        await publishGenerationNotification(runtime, plan, "cancelled", run.attempt);
        return ok({
          candidate: partialCandidate,
          qualityGate: null,
          cancelled: true,
          incomplete: partialCandidate?.toSnapshot().incomplete ?? false,
          reused: false,
          taskId: plan.taskId,
          runId: run.id,
        });
      }
      if (recoveredTruncation) {
        // The provider stopped early, but all visible prose remains an isolated,
        // incomplete Candidate. Validation and persistence continue below.
      } else {
        const retryable =
          normalized.code === "MODEL_OUTPUT_TRUNCATED" ? true : normalized.retryable;
        run = await runtime.generationGovernance.transitionRun({
          runId: run.id,
          expectedRevision: run.revision,
          state: retryable ? "failed_retryable" : "failed_final",
          failureCode: safeFailureCode(normalized.code),
          addIncurredCost: true,
          attemptUsage,
        });
        await runtime.taskCenter
          .failTask(
            plan.taskId,
            plan.leaseToken,
            {
              code: safeFailureCode(normalized.code),
              retryable,
              actions: retryable
                ? ["RETRY", "SWITCH_MODEL", "REDUCE_CONTEXT", "EXPORT_DIAGNOSTICS"]
                : ["SWITCH_MODEL", "REDUCE_CONTEXT", "EXPORT_DIAGNOSTICS"],
              requestId: plan.requestId,
            },
            retryable ? new Date(Date.parse(runtime.clock.now()) + 1_000).toISOString() : null,
          )
          .catch(() => undefined);
        await publishGenerationNotification(
          runtime,
          plan,
          "failed",
          run.attempt,
          safeFailureCode(normalized.code),
        );
        return err(
          retryable && !normalized.retryable
            ? new ModelCenterError(normalized.code, normalized.message, true)
            : normalized,
        );
      }
    }

    run = await runtime.generationGovernance.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      state: "validating",
    });
    await runtime.taskCenter.reportTaskProgress(
      plan.taskId,
      plan.leaseToken,
      "candidate.validating",
      3,
      5,
    );
    const qualityGate = await evaluateCandidateAgainstLocalGate(
      runtime,
      plan,
      candidate,
      chapter.content,
    );
    run = await runtime.generationGovernance.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      state: "candidate_ready",
      candidateId: candidate.id,
      addIncurredCost: true,
      attemptUsage,
    });
    await runtime.taskCenter.reportTaskProgress(
      plan.taskId,
      plan.leaseToken,
      "candidate.persisted",
      4,
      5,
    );
    await runtime.taskCenter.reportTaskProgress(
      plan.taskId,
      plan.leaseToken,
      "candidate.finalized",
      5,
      5,
    );
    try {
      await runtime.taskCenter.completeTask(plan.taskId, plan.leaseToken);
    } catch (cause: unknown) {
      if (cause instanceof TaskEngineError && cause.code === "TASK_CANCEL_REQUESTED") {
        run = await runtime.generationGovernance.transitionRun({
          runId: run.id,
          expectedRevision: run.revision,
          state: "cancelled",
          candidateId: candidate.id,
        });
        await runtime.taskCenter
          .acknowledgeTaskCancellation(plan.taskId, plan.leaseToken)
          .catch(() => undefined);
        await publishGenerationNotification(runtime, plan, "cancelled", run.attempt);
        return ok({
          candidate,
          qualityGate,
          cancelled: true,
          incomplete: candidate.toSnapshot().incomplete,
          reused: false,
          taskId: plan.taskId,
          runId: run.id,
        });
      }
      throw cause;
    }
    run = await runtime.generationGovernance.transitionRun({
      runId: run.id,
      expectedRevision: run.revision,
      state: "completed",
      candidateId: candidate.id,
    });
    await publishGenerationNotification(
      runtime,
      plan,
      candidate.toSnapshot().incomplete ? "partial" : "completed",
      run.attempt,
    );
    return ok({
      candidate,
      qualityGate,
      cancelled: false,
      incomplete: candidate.toSnapshot().incomplete,
      reused: false,
      taskId: plan.taskId,
      runId: run.id,
    });
  } catch (cause: unknown) {
    const normalized = normalizeGovernedGenerationError(cause);
    recordSafeGenerationErrorCode(runtime, normalized.code);
    return err(normalized);
  } finally {
    clearGenerationTaskCancellation(runtime, plan.taskId);
  }
}

export async function cancelGenerationPlan(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
): Promise<boolean> {
  requestGenerationTaskCancellation(runtime, plan.taskId);
  const generationId = activeGenerationId(runtime, plan.taskId) ?? plan.generationId;
  const [taskCancelled, gatewayCancelled] = await Promise.all([
    runtime.taskCenter
      .cancelTask(plan.taskId)
      .then(() => true)
      .catch(() => false),
    runtime.mode === "tauri"
      ? runtime.modelGateway.cancelGeneration(generationId).catch(() => false)
      : Promise.resolve(true),
  ]);
  return taskCancelled || gatewayCancelled;
}

function setActiveGenerationId(runtime: object, taskId: string, generationId: string): void {
  const current = activeGenerationIdsByRuntime.get(runtime) ?? new Map<string, string>();
  current.set(taskId, generationId);
  activeGenerationIdsByRuntime.set(runtime, current);
}

function clearActiveGenerationId(runtime: object, taskId: string, generationId: string): void {
  const current = activeGenerationIdsByRuntime.get(runtime);
  if (current?.get(taskId) !== generationId) return;
  current.delete(taskId);
  if (current.size === 0) activeGenerationIdsByRuntime.delete(runtime);
}

function activeGenerationId(runtime: object, taskId: string): string | null {
  return activeGenerationIdsByRuntime.get(runtime)?.get(taskId) ?? null;
}

function requestGenerationTaskCancellation(runtime: object, taskId: string): void {
  const current = cancelledGenerationTasksByRuntime.get(runtime) ?? new Set<string>();
  current.add(taskId);
  cancelledGenerationTasksByRuntime.set(runtime, current);
}

function assertGenerationTaskNotCancelled(runtime: object, taskId: string): void {
  if (!cancelledGenerationTasksByRuntime.get(runtime)?.has(taskId)) return;
  throw new ModelHubExecutionError(
    "MODEL_GENERATION_CANCELLED",
    "Model generation was cancelled before provider dispatch.",
    true,
    false,
  );
}

function clearGenerationTaskCancellation(runtime: object, taskId: string): void {
  const current = cancelledGenerationTasksByRuntime.get(runtime);
  current?.delete(taskId);
  if (current?.size === 0) cancelledGenerationTasksByRuntime.delete(runtime);
}

async function persistPreparedContextTrace(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
): Promise<void> {
  if (plan.contextCompilation === null || plan.projectId === null) {
    return;
  }
  if (plan.contextTraceId === null) {
    throw new ModelCenterError(
      "CONTEXT_TRACE_UNAVAILABLE",
      "无法建立本次生成与上下文来源的精确关联，因此没有调用模型。正文和已有 AI 建议版本均未改变。",
      true,
    );
  }
  await runtime.contextTraces.save(
    createContextCompilationTrace({
      id: plan.contextTraceId,
      projectId: plan.projectId,
      chapterId: plan.chapterId,
      taskType: "continuation",
      compiled: plan.contextCompilation.compiled,
      createdAt: runtime.clock.now(),
      execution: {
        generationId: plan.generationId,
        generationRunId: plan.runId,
      },
    }),
  );
}

async function linkPreparedContextModelInvocation(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  modelInvocationId: string,
): Promise<void> {
  if (plan.contextTraceId === null) {
    throw new ModelCenterError(
      "CONTEXT_TRACE_UNAVAILABLE",
      "无法建立本次模型调用与上下文来源的精确关联，因此没有发送正文。",
      true,
    );
  }
  try {
    await runtime.contextTraces.linkModelInvocation({
      traceId: plan.contextTraceId,
      modelInvocationId,
      linkedAt: runtime.clock.now(),
    });
  } catch {
    throw new ModelCenterError(
      "CONTEXT_TRACE_UNAVAILABLE",
      "无法建立本次模型调用与上下文来源的精确关联，因此没有发送正文。",
      true,
    );
  }
}

async function commitPreparedNovelSkillSnapshot(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  modelInvocationId: string,
): Promise<void> {
  if (plan.contextTraceId === null || plan.projectId === null) {
    if (plan.novelSkillPreparation.compiled !== null) {
      throw new ModelCenterError(
        "NOVEL_SKILL_RECEIPT_FAILED",
        "无法建立本次写作方法与上下文的精确关联，因此没有发送正文。",
        true,
      );
    }
    return;
  }
  await runtime.novelSkills.commitBeforeDispatch({
    snapshotId: runtime.ids.next(),
    projectId: plan.projectId,
    contextTraceId: plan.contextTraceId,
    modelInvocationId,
    taskType: "continuation",
    invocationMode: "draft",
    preparation: plan.novelSkillPreparation,
    createdAt: runtime.clock.now(),
  });
}

async function commitPreparedContextOutputCandidate(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  candidate: AiCandidate,
): Promise<void> {
  if (plan.contextTraceId === null) {
    if (runtime.mode === "tauri") {
      throw new ModelCenterError(
        "CONTEXT_TRACE_UNAVAILABLE",
        "无法建立本次 AI 建议版本与上下文来源的精确关联，因此没有保存该版本。正文和已有 AI 建议版本均未改变。",
        true,
      );
    }
    return;
  }
  try {
    await runtime.contextTraceOutputs.commit({
      traceId: plan.contextTraceId,
      candidate,
      linkedAt: runtime.clock.now(),
    });
  } catch {
    throw new ModelCenterError(
      "CONTEXT_TRACE_UNAVAILABLE",
      "无法同时保存 AI 建议版本及其上下文来源记录，因此本次建议版本未保存。正文和已有 AI 建议版本均未改变。",
      true,
    );
  }
}

async function saveDirectContinuationContextTrace(
  runtime: DesktopRuntime,
  chapter: Chapter,
  receipt: StoryContextCompilationReceipt,
  execution: Readonly<{
    traceId: string;
    generationId: string;
    modelInvocationId: string | null;
  }>,
): Promise<void> {
  try {
    await runtime.contextTraces.save(
      createContextCompilationTrace({
        id: execution.traceId,
        projectId: chapter.projectId,
        chapterId: chapter.id,
        taskType: "continuation",
        compiled: receipt.compiled,
        createdAt: runtime.clock.now(),
        execution: {
          generationId: execution.generationId,
          modelInvocationId: execution.modelInvocationId,
        },
      }),
    );
  } catch {
    throw new ModelCenterError(
      "CONTEXT_TRACE_UNAVAILABLE",
      "无法保存本次上下文来源记录，因此没有调用模型。正文和已有 AI 建议版本均未改变。",
      true,
    );
  }
}

interface InspectedModelRouteProfile {
  readonly profile: ModelProfile;
  readonly candidate: ModelRouteCandidate;
  readonly credentialConfigured: boolean;
  readonly connectionStatus: "verified" | "failed" | "not_checked";
  readonly selectedModelAvailable: boolean;
  readonly gatewayConfig: NativeModelEndpointConfig | null;
  readonly gatewayResolution: ModelProfileGatewayConfigResolution | null;
}

const TEXT_GENERATION_MODEL_ROLES = [
  "fast",
  "high_quality",
  "long_context",
  "validation",
  "translation",
] as const satisfies readonly ModelRouteRole[];

function validateNativeModelListResponse(
  response: unknown,
  config: NativeModelEndpointConfig,
): NativeModelListResponse {
  if (
    !isRecord(response) ||
    !isNativeGatewayProviderKind(response.provider) ||
    response.provider !== config.provider ||
    !Array.isArray(response.models) ||
    response.models.length > 10_000
  ) {
    throw invalidNativeModelResponse("model discovery");
  }

  const modelIds = new Set<string>();
  const models: NativeModelDescriptor[] = response.models.map((model: unknown) => {
    if (
      !isRecord(model) ||
      !isSafeNativeModelText(model.id, 512) ||
      !isSafeNativeModelText(model.displayName, 1_024) ||
      modelIds.has(model.id) ||
      (model.sizeBytes !== undefined &&
        model.sizeBytes !== null &&
        (typeof model.sizeBytes !== "number" ||
          !Number.isSafeInteger(model.sizeBytes) ||
          model.sizeBytes < 0))
    ) {
      throw invalidNativeModelResponse("model discovery");
    }
    modelIds.add(model.id);
    return Object.freeze({
      id: model.id,
      displayName: model.displayName,
      ...(model.sizeBytes === undefined ? {} : { sizeBytes: model.sizeBytes }),
    });
  });

  return Object.freeze({
    provider: response.provider,
    models: Object.freeze(models),
  });
}

function validateNativeModelConnectionResponse(
  response: unknown,
  config: NativeModelEndpointConfig,
): NativeModelConnectionResponse {
  const expectedOrigin = new URL(config.baseUrl).origin;
  if (
    !isRecord(response) ||
    !isNativeGatewayProviderKind(response.provider) ||
    response.provider !== config.provider ||
    response.endpointOrigin !== expectedOrigin ||
    typeof response.modelCount !== "number" ||
    !Number.isSafeInteger(response.modelCount) ||
    response.modelCount < 0 ||
    response.modelCount > 10_000 ||
    typeof response.latencyMs !== "number" ||
    !Number.isSafeInteger(response.latencyMs) ||
    response.latencyMs < 0
  ) {
    throw invalidNativeModelResponse("connection check");
  }

  return Object.freeze({
    provider: response.provider,
    endpointOrigin: response.endpointOrigin,
    modelCount: response.modelCount,
    latencyMs: response.latencyMs,
  });
}

function isSafeNativeModelText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function invalidNativeModelResponse(operation: string): ModelCenterError {
  return new ModelCenterError(
    "MODEL_RESPONSE_INVALID",
    `The native ${operation} response is invalid.`,
  );
}

function validateNativeEmbeddingResult(
  result: NativeEmbeddingResult,
  input: NativeEmbeddingInput,
): NativeEmbeddingResult {
  const expectedOrigin = new URL(input.config.baseUrl).origin;
  const rawEmbeddings: unknown = result.embeddings;
  if (
    result.provider !== input.config.provider ||
    result.endpointOrigin !== expectedOrigin ||
    result.model !== input.model ||
    !Number.isSafeInteger(result.dimension) ||
    result.dimension < 1 ||
    result.dimension > 4_096 ||
    result.vectorCount !== input.inputs.length ||
    !Array.isArray(rawEmbeddings) ||
    rawEmbeddings.length !== input.inputs.length
  ) {
    throw invalidNativeEmbeddingResponse();
  }
  const embeddings = rawEmbeddings.map((embedding: unknown) => {
    if (!Array.isArray(embedding) || embedding.length !== result.dimension) {
      throw invalidNativeEmbeddingResponse();
    }
    const values: number[] = [];
    let nonZero = false;
    for (const value of embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidNativeEmbeddingResponse();
      }
      values.push(value);
      nonZero ||= value !== 0;
    }
    if (!nonZero) {
      throw invalidNativeEmbeddingResponse();
    }
    return Object.freeze(values);
  });
  return Object.freeze({
    provider: result.provider,
    endpointOrigin: result.endpointOrigin,
    model: result.model,
    dimension: result.dimension,
    vectorCount: result.vectorCount,
    embeddings: Object.freeze(embeddings),
  });
}

function invalidNativeEmbeddingResponse(): ModelCenterError {
  return new ModelCenterError(
    "MODEL_RESPONSE_INVALID",
    "The native embedding response is invalid.",
  );
}

function validateNativeRerankResult(result: unknown, input: NativeRerankInput): NativeRerankResult {
  const expectedOrigin = new URL(input.config.baseUrl).origin;
  if (
    !isRecord(result) ||
    !isNativeGatewayProviderKind(result.provider) ||
    result.provider !== input.config.provider ||
    result.protocol !== "qwen_open_ai_compatible" ||
    result.endpointOrigin !== expectedOrigin ||
    result.model !== input.model ||
    !Array.isArray(result.rankings) ||
    result.rankings.length < 1 ||
    result.rankings.length > input.topN ||
    !(
      result.inputTokens === null ||
      (typeof result.inputTokens === "number" &&
        Number.isSafeInteger(result.inputTokens) &&
        result.inputTokens >= 0)
    )
  ) {
    throw invalidNativeRerankResponse();
  }
  const seen = new Set<number>();
  const rankings = result.rankings.map((ranking: unknown) => {
    if (
      !isRecord(ranking) ||
      typeof ranking.index !== "number" ||
      !Number.isSafeInteger(ranking.index) ||
      ranking.index < 0 ||
      ranking.index >= input.documents.length ||
      seen.has(ranking.index) ||
      typeof ranking.relevanceScore !== "number" ||
      !Number.isFinite(ranking.relevanceScore) ||
      ranking.relevanceScore < 0 ||
      ranking.relevanceScore > 1
    ) {
      throw invalidNativeRerankResponse();
    }
    const index = ranking.index;
    const relevanceScore = ranking.relevanceScore;
    seen.add(index);
    return Object.freeze({
      index,
      relevanceScore,
    });
  });
  rankings.sort(
    (left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index,
  );
  return Object.freeze({
    provider: result.provider,
    protocol: "qwen_open_ai_compatible",
    endpointOrigin: result.endpointOrigin,
    model: result.model,
    rankings: Object.freeze(rankings),
    inputTokens: result.inputTokens,
  });
}

function invalidNativeRerankResponse(): ModelCenterError {
  return new ModelCenterError("MODEL_RESPONSE_INVALID", "The native rerank response is invalid.");
}

function validateNativeGenerationUsage(
  usage: NativeModelGenerationUsage,
): NativeModelGenerationUsage {
  const validTokenCount = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
  if (
    !validTokenCount(usage.inputTokens) ||
    !validTokenCount(usage.outputTokens) ||
    (usage.cachedInputTokens !== null &&
      (!validTokenCount(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens))
  ) {
    throw new ModelCenterError(
      "MODEL_USAGE_INVALID",
      "The provider returned invalid token usage metadata.",
    );
  }
  return Object.freeze({ ...usage });
}

function priceProviderReportedUsage(
  plan: PreparedGenerationPlan,
  usage: NativeModelGenerationUsage | null,
): GenerationAttemptUsageInput {
  if (usage === null) {
    return Object.freeze({
      source: "provider_unavailable",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      usagePricedEstimateMicros: null,
    });
  }
  const pricing = plan.approvedPricing;
  if (pricing === null) {
    return Object.freeze({
      source: "provider_reported_unpriced",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      usagePricedEstimateMicros: null,
    });
  }
  const estimate = estimateGenerationCost(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens === null ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    },
    {
      ...pricing,
    },
  );
  return Object.freeze({
    source: "provider_reported",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    usagePricedEstimateMicros: estimate.micros.toString(),
  });
}

async function generateLegacyContinuation(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  onDelta: (next: string) => void,
  options: Readonly<{
    generationId: string;
    forceReasoningDisabled: boolean;
  }>,
): Promise<NativeModelGenerationResult> {
  if (
    plan.profile?.selectedModel === null ||
    plan.profile === null ||
    plan.legacyGatewayResolution === null
  ) {
    throw new ModelCenterError(
      "MODEL_PROFILE_NOT_READY",
      "The preflight model profile is no longer ready.",
    );
  }
  if (plan.contextCompilation !== null) {
    await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(
      plan.contextCompilation.projectPrivacy,
    );
    runtime.projectContextPrivacy.assertRouteEligible(
      plan.contextCompilation.projectPrivacy,
      isVerifiedLocalGatewayConfig(plan.legacyGatewayResolution.config),
    );
  }
  if (plan.contextCompilation === null) {
    throw new ModelCenterError(
      "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
      "无法建立作品隐私边界，因此没有调用 AI。",
      true,
    );
  }
  const current = await resolveFinalModelProfileGatewayConfig(
    {
      modelCenter: runtime.modelCenter,
      modelHub: runtime.modelHub,
      credentials: runtime.credentials,
    },
    plan.profile,
    plan.legacyGatewayResolution,
  ).catch(() => {
    throw new ModelCenterError(
      "MODEL_PROFILE_NOT_READY",
      "The preflight model connection or credential changed before dispatch.",
      true,
    );
  });
  await assertGenerationProjectActive(runtime, plan.projectId);
  return runtime.modelGateway.generate({
    dispatchScope: projectContextDispatchScope(plan.contextCompilation.projectPrivacy),
    generationId: options.generationId,
    config: current.resolution.config,
    model: current.profile.selectedModel ?? plan.profile.selectedModel,
    messages: plan.messages,
    maxOutputTokens: plan.maximumOutputTokens,
    temperature: 0.8,
    ...(options.forceReasoningDisabled
      ? { reasoningMode: "disabled" as const }
      : legacyVisibleProseReasoningPolicy(current.resolution.config)),
    onDelta,
  });
}

function legacyVisibleProseReasoningPolicy(
  config: NativeModelEndpointConfig,
): Readonly<{ reasoningMode?: "disabled" }> {
  const provider = modelProviderKindForOfficialEndpoint(config.baseUrl);
  if (provider === null) return Object.freeze({});
  const policy = modelProviderVisibleProsePolicy(provider);
  return policy.reasoningMode === null
    ? Object.freeze({})
    : Object.freeze({ reasoningMode: policy.reasoningMode });
}

function shouldRetryReasoningOnlyTruncation(
  plan: PreparedGenerationPlan,
  failure: GovernedGenerationError,
  accumulatedVisibleText: string,
): boolean {
  if (
    !(failure instanceof ModelCenterError) ||
    failure.code !== "MODEL_OUTPUT_TRUNCATED" ||
    accumulatedVisibleText.length > 0 ||
    failure.diagnostics?.reasoningPresent !== true ||
    (failure.diagnostics.visibleContentLength !== null &&
      failure.diagnostics.visibleContentLength !== 0)
  ) {
    return false;
  }
  if (plan.executionMode === "model_hub") {
    const providerKind = plan.modelHubInspection?.providerKind;
    if (providerKind === undefined) return false;
    const preset = getModelProviderPreset(providerKind);
    return (
      preset.protocol === "openai_compatible" &&
      modelProviderVisibleProsePolicy(providerKind).reasoningMode !== "disabled"
    );
  }
  if (plan.executionMode === "legacy_profile") {
    return (
      plan.legacyGatewayConfig?.provider === "open_ai_compatible" &&
      legacyVisibleProseReasoningPolicy(plan.legacyGatewayConfig).reasoningMode !== "disabled"
    );
  }
  return false;
}

async function assertGenerationProjectActive(
  runtime: Pick<DesktopRuntime, "repositories">,
  projectIdValue: string | null,
): Promise<void> {
  if (projectIdValue === null) {
    throw new AppError({
      code: "PROJECT_NOT_FOUND",
      message: "The project no longer exists.",
    });
  }
  const projectId = parseDomainUuid(projectIdValue);
  if (!projectId.ok) {
    throw projectId.error;
  }
  const projectResult = await runtime.repositories.projects.findById(projectId.value);
  if (!projectResult.ok) {
    throw projectResult.error;
  }
  const project = projectResult.value;
  if (project === null) {
    throw new AppError({
      code: "PROJECT_NOT_FOUND",
      message: "The project no longer exists.",
    });
  }
  if (project.status === "archived") {
    throw new AppError({
      code: "PROJECT_ARCHIVED",
      message: "Restore the project to active before generating a new AI candidate.",
      actions: ["RESTORE"],
    });
  }
  if (project.status === "trashed") {
    throw new AppError({
      code: "PROJECT_DELETED",
      message: "Restore the project from the recycle bin before generating a new AI candidate.",
      actions: ["RESTORE"],
    });
  }
}

async function assertPreparedGenerationTargetCurrent(
  runtime: Pick<DesktopRuntime, "repositories">,
  plan: PreparedGenerationPlan,
): Promise<Chapter> {
  assertGenerationTaskNotCancelled(runtime, plan.taskId);
  await assertGenerationProjectActive(runtime, plan.projectId);
  const chapterResult = await runtime.repositories.chapters.findById(plan.chapterId);
  if (!chapterResult.ok) {
    throw chapterResult.error;
  }
  const chapter = chapterResult.value;
  if (chapter?.projectId !== plan.projectId) {
    throw new AppError({
      code: "CHAPTER_NOT_FOUND",
      message: "The chapter no longer exists in the prepared project.",
    });
  }
  if (chapter.status !== "active") {
    throw new AppError({
      code: "CHAPTER_DELETED",
      message: "Restore the chapter before creating a new AI Candidate.",
      actions: ["RESTORE"],
    });
  }
  if (chapter.currentVersionId !== plan.baseVersionId) {
    throw new AppError({
      code: "BASE_VERSION_CHANGED",
      message: "The accepted chapter version changed while the model was generating.",
      retryable: true,
      actions: ["RETRY", "EXPORT_DRAFT"],
    });
  }
  return chapter;
}

function isVerifiedLocalGatewayConfig(config: NativeModelEndpointConfig | null): boolean {
  return config?.provider === "ollama" && isLoopbackModelBaseUrl(config.baseUrl);
}

function isPreparedGenerationTargetLocal(plan: PreparedGenerationPlan): boolean {
  return (
    plan.executionMode === "local_demo" ||
    plan.modelHubInspection?.dataDestination === "local" ||
    (plan.executionMode === "legacy_profile" &&
      isVerifiedLocalGatewayConfig(plan.legacyGatewayConfig))
  );
}

function privateChapterModelBlocked(): ModelCenterError {
  return new ModelCenterError(
    "PRIVATE_CHAPTER_LOCAL_ONLY",
    "私密章节只能由已验证的本地模型处理；本次请求在发送 0 字后停止。",
  );
}

async function assertProjectContextBeforeModelHubDispatch(
  runtime: Pick<DesktopRuntime, "projectContextPrivacy">,
  receipt: ProjectContextPrivacyReceipt,
  localOnlyEligible: boolean,
): Promise<void> {
  try {
    await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(receipt);
    runtime.projectContextPrivacy.assertRouteEligible(receipt, localOnlyEligible);
  } catch (cause: unknown) {
    if (cause instanceof ProjectContextPrivacyError) {
      throw new ModelHubExecutionError(cause.code, cause.message, cause.retryable);
    }
    throw cause;
  }
}

function normalizeProjectContextPrivacyFailure(cause: unknown): ModelCenterError {
  return cause instanceof ProjectContextPrivacyError
    ? new ModelCenterError(cause.code, cause.message, cause.retryable)
    : new ModelCenterError(
        "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
        "无法核对这个作品的本地隐私范围，因此没有调用 AI。请重试；若问题持续，请先检查本地数据库。",
        true,
      );
}

async function inspectModelRouteProfile(
  runtime: DesktopRuntime,
  profile: ModelProfile,
  networkAvailable: boolean,
): Promise<InspectedModelRouteProfile> {
  const modelId = profile.selectedModel;
  if (modelId === null) {
    throw new ModelCenterError(
      "MODEL_PROFILE_NOT_READY",
      "A route target profile no longer has a selected model.",
    );
  }
  const resolvedEndpoint = await resolveModelProfileGatewayConfig(
    { modelHub: runtime.modelHub, credentials: runtime.credentials },
    profile,
  ).catch(() => null);
  const credentialConfigured = resolvedEndpoint !== null;

  const canProbe =
    runtime.modelGateway.available &&
    credentialConfigured &&
    (resolvedEndpoint.config.provider === "ollama" || networkAvailable);
  let verification: ModelRouteCandidate["verification"] = "not_checked";
  let connectionStatus: InspectedModelRouteProfile["connectionStatus"] = "not_checked";
  let selectedModelAvailable = true;
  if (canProbe) {
    try {
      const listed = await runtime.modelGateway.listModels(resolvedEndpoint.config);
      connectionStatus = "verified";
      selectedModelAvailable = listed.models.some(({ id }) => id === modelId);
      verification = selectedModelAvailable ? "verified" : "unavailable";
    } catch {
      connectionStatus = "failed";
      selectedModelAvailable = false;
      verification = "unavailable";
    }
  }

  const capabilities: readonly ModelRouteRole[] = isVerifiedLocalGatewayConfig(
    resolvedEndpoint?.config ?? null,
  )
    ? [...TEXT_GENERATION_MODEL_ROLES, "local_private"]
    : TEXT_GENERATION_MODEL_ROLES;
  return Object.freeze({
    profile,
    candidate: Object.freeze({
      providerId: profile.providerId,
      modelId,
      location: isVerifiedLocalGatewayConfig(resolvedEndpoint?.config ?? null) ? "local" : "remote",
      verification,
      capabilities: Object.freeze([...capabilities]),
    }),
    credentialConfigured,
    connectionStatus,
    selectedModelAvailable,
    gatewayConfig: resolvedEndpoint?.config ?? null,
    gatewayResolution: resolvedEndpoint,
  });
}

function buildContinuationMessages(chapter: Chapter): readonly NativeModelMessage[] {
  return [
    {
      role: "system",
      content:
        "你是长篇小说续写助手。只输出可直接追加到章节末尾的新正文，不要解释、标题、Markdown 代码围栏或元评论。保持既有人称、时态、语气和事实连续性；不要把建议直接当成正式设定。",
    },
    {
      role: "user",
      content: `章节标题：${chapter.title}\n\n当前正文：\n${chapter.content}\n\n请续写下一段情节。`,
    },
  ];
}

interface ContextualContinuationMessages {
  readonly messages: readonly NativeModelMessage[];
  readonly contextCompilation: ChapterStoryContextCompilationReceipt;
  readonly novelSkillPreparation: PreparedNovelSkillInvocation;
}

export interface ChapterStoryContextCompilationInput {
  readonly currentTask: ContextCandidateDraft;
  readonly retrievalQuery?: string;
  readonly maximumContextTokens?: number;
  /** Supply only from author-confirmed scene/chapter metadata; the pair is fail-closed. */
  readonly currentPovCharacterId?: string | null;
  readonly currentNarrativeOrder?: number | null;
  /**
   * Remote reranking is optional enrichment, never a prerequisite. Callers
   * handling bounded source text can keep preparation entirely local.
   */
  readonly allowRemoteRerank?: boolean;
}

/**
 * Compiles the governed, traceable story context shared by chapter-level AI
 * actions. The caller still owns the task-specific prompt and persistence
 * policy; this helper only selects verified story sources.
 */
export async function compileChapterStoryContext(
  runtime: DesktopRuntime,
  chapter: Chapter,
  input: ChapterStoryContextCompilationInput,
): Promise<ChapterStoryContextCompilationReceipt> {
  const projectPrivacy = await runtime.projectContextPrivacy.inspect(chapter.projectId);
  runtime.projectContextPrivacy.assertChapterMatches(projectPrivacy, chapter);
  const [
    retrieval,
    causalCandidates,
    preferenceCandidates,
    currentChapterVersions,
    creationSeedCandidates,
    verifiedPovKnowledgeFacts,
  ] = await Promise.all([
    retrieveSemanticContinuationCandidates(
      runtime,
      chapter,
      projectPrivacy,
      input.retrievalQuery,
      (input.allowRemoteRerank ?? true) && !projectPrivacy.requiresVerifiedLocal,
    ),
    retrieveCausalContinuationCandidates(runtime, chapter, input.retrievalQuery),
    runtime.story.writingFeedback
      .loadDashboard(chapter.projectId)
      .then(({ preferences }) => selectWritingPreferenceContextCandidates(preferences))
      .catch(() => Object.freeze([])),
    buildVerifiedCurrentChapterVersionRegistry(runtime, chapter.projectId),
    runtime.projectSeeds
      .findByProjectId(chapter.projectId)
      .then(selectProjectSeedContextCandidates)
      .catch(() => Object.freeze([])),
    runtime.story.continuousProjection
      .projectVoicePovFacts({
        projectId: chapter.projectId,
        chapterId: chapter.id,
        currentVersionId: chapter.currentVersionId,
      })
      .then(({ facts }) =>
        Object.freeze(facts.filter((fact) => fact.toSnapshot().factType === "character_knowledge")),
      )
      .catch(() => Object.freeze([])),
  ]);
  const currentVersionAuthority = currentChapterVersions[chapter.id];
  if (currentVersionAuthority?.versionId !== chapter.currentVersionId) {
    throw new StoryContextRuntimeError(
      "STORY_CONTEXT_COMPILATION_FAILED",
      "The current chapter version and checksum could not be verified for context compilation.",
    );
  }
  const compiled = await compileStoryContextForGeneration(runtime.story.facts, {
    projectId: chapter.projectId,
    currentTask: input.currentTask,
    currentTaskSupplements: preferenceCandidates,
    creationSeedCandidates,
    currentChapter: {
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      contentHash: currentVersionAuthority.contentHash,
      title: chapter.title,
      content: chapter.content,
    },
    currentChapterVersions,
    causalCandidates,
    semanticCandidates: retrieval.semanticCandidates,
    rerankCandidates: retrieval.rerankCandidates,
    verifiedDerivedFacts: verifiedPovKnowledgeFacts,
    currentPovCharacterId: input.currentPovCharacterId ?? null,
    currentNarrativeOrder: input.currentNarrativeOrder ?? null,
    maximumContextTokens:
      input.maximumContextTokens ??
      CONSERVATIVE_GENERATION_CONTEXT_POLICY.maximumCompiledInputTokens,
  });
  return Object.freeze({ ...compiled, projectPrivacy });
}

async function buildContextualContinuationMessages(
  runtime: DesktopRuntime,
  chapter: Chapter,
  maximumContextTokens: number = CONSERVATIVE_GENERATION_CONTEXT_POLICY.maximumCompiledInputTokens,
  partialCandidateContent: string | null = null,
  outputContract = resolveContinuationOutputContract(),
  applyNovelSkills = false,
): Promise<ContextualContinuationMessages> {
  const reservedSkillTokens = applyNovelSkills
    ? await runtime.novelSkills.getReservedTokens({
        projectId: chapter.projectId,
        taskType: "continuation",
      })
    : 0;
  const contextCompilation = await compileChapterStoryContext(runtime, chapter, {
    currentTask: {
      id: `continuation-task:${chapter.id}:${chapter.currentVersionId}`,
      content:
        partialCandidateContent === null
          ? `续写《${chapter.title}》，${continuationDestinationTaskLabel(outputContract)}，保持已保存正文、正式设定与锁定规则连续。`
          : `继续补全《${chapter.title}》中尚未完成的 AI 建议版本，不重复已有片段。`,
      selectionReason: "The author explicitly requested a continuation of the current chapter.",
      evidence: [
        {
          sourceType: "generation_task",
          sourceId: `continuation:${chapter.id}`,
          sourceVersionId: chapter.currentVersionId,
          locator: null,
          contentHash: null,
          excerpt: null,
        },
      ],
      priority: 1_000,
    },
    maximumContextTokens: Math.max(1, maximumContextTokens - reservedSkillTokens),
  });
  const novelSkillPreparation = applyNovelSkills
    ? await runtime.novelSkills.prepareInvocation({
        projectId: chapter.projectId,
        taskType: "continuation",
        invocationMode: "draft",
        maximumSkillTokens: Math.min(
          reservedSkillTokens === 0 ? DEFAULT_NOVEL_SKILL_TOKEN_BUDGET : reservedSkillTokens,
          Math.max(0, maximumContextTokens - contextCompilation.compiled.trace.usedTokens),
        ),
        availableContextLayers: Object.freeze([
          ...new Set(
            contextCompilation.compiled.entries
              .filter(({ included }) => included)
              .map(({ layer }) => layer),
          ),
        ]),
      })
    : runtime.novelSkills.describeNotApplied("legacy_route_untraceable");
  const baseSystemMessage =
    "你是长篇小说续写助手。只输出可直接追加到章节中的新正文，不输出思考过程、解释、标题、Markdown 代码围栏或元评论。保持既有人称、时态、语气和事实连续性；不得把推测或 AI 建议直接写成正式设定。";
  const systemMessage =
    novelSkillPreparation.promptSection === null
      ? baseSystemMessage
      : `${baseSystemMessage}\n\n以下是作者明确开启的实验性写作方法，只用于辅助完成本次任务。若方法与作者当前要求、已确认并锁定的故事规则、人物知识边界或已保存正文冲突，必须忽略冲突的方法规则并遵守更高优先级资料。不要向作者解释这些方法。\n${novelSkillPreparation.promptSection}`;
  const messages: NativeModelMessage[] = [
    {
      role: "system",
      content: systemMessage,
    },
    { role: "user", content: formatStoryContextPrompt(contextCompilation) },
  ];
  if (partialCandidateContent !== null && partialCandidateContent.trim().length > 0) {
    messages.push({ role: "assistant", content: partialCandidateContent.trim() });
  }
  messages.push({
    role: "user",
    content:
      partialCandidateContent === null
        ? `请依据以上资料续写下一段情节，${continuationDestinationPrompt(outputContract)}目标约 ${String(outputContract.targetVisibleCharacters)} 字（可在 ${String(outputContract.minimumVisibleCharacters)}–${String(outputContract.maximumVisibleCharacters)} 字内自然收束）。若资料存在未确认或无法消解的冲突，优先遵守已确认并锁定的规则。只输出新增正文。`
        : `从上次可见正文的结尾自然继续，完成当前场景；本次新补全部分目标约 ${String(outputContract.targetVisibleCharacters)} 字。不要复述、解释或重复已有片段，只输出新补全部分。`,
  });
  return Object.freeze({
    contextCompilation,
    novelSkillPreparation,
    messages: Object.freeze(messages.map((message) => Object.freeze(message))),
  });
}

function continuationDestinationTaskLabel(contract: ContinuationOutputContract): string {
  if (contract.destination === "next_segment") return "只推进下一小段";
  if (contract.destination === "custom_instruction") {
    return `按作者要求推进到“${contract.customDestinationInstruction ?? "指定位置"}”`;
  }
  return "推进一个完整场景";
}

function continuationDestinationPrompt(contract: ContinuationOutputContract): string {
  if (contract.destination === "next_segment") {
    return "只写紧接当前正文的下一小段，不必强行完成整个场景；";
  }
  if (contract.destination === "custom_instruction") {
    return `写到以下作者指定位置即自然收束：${contract.customDestinationInstruction ?? ""}；`;
  }
  return "推进并自然完成一个完整场景；";
}

async function buildVerifiedCurrentChapterVersionRegistry(
  runtime: DesktopRuntime,
  projectId: UuidV7,
): Promise<Readonly<Record<string, Readonly<{ versionId: string; contentHash: string }>>>> {
  const chapters = await runtime.repositories.chapters.listByProjectId(projectId).catch(() => null);
  if (!chapters?.ok) {
    return Object.freeze({});
  }
  const verified = await Promise.all(
    chapters.value
      .filter((candidate) => candidate.status === "active")
      .map(async (candidate) => {
        const version = await runtime.repositories.chapterVersions
          .findVersionById(candidate.currentVersionId)
          .catch(() => null);
        if (version === null || !version.ok || version.value === null) {
          return null;
        }
        const snapshot = version.value.toSnapshot();
        if (
          snapshot.projectId !== projectId ||
          snapshot.chapterId !== candidate.id ||
          snapshot.id !== candidate.currentVersionId ||
          snapshot.content !== candidate.content
        ) {
          return null;
        }
        const hash = await runtime.hasher.sha256(snapshot.content).catch(() => null);
        if (hash === null || !hash.ok || hash.value !== snapshot.contentChecksum) {
          return null;
        }
        return [
          candidate.id,
          Object.freeze({ versionId: snapshot.id, contentHash: hash.value }),
        ] as const;
      }),
  );
  return Object.freeze(
    Object.fromEntries(
      verified.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    ),
  );
}

async function retrieveCausalContinuationCandidates(
  runtime: DesktopRuntime,
  chapter: Chapter,
  retrievalQuery?: string,
): Promise<readonly ContextCandidateDraft[]> {
  try {
    const graph = await runtime.story.causalGraph.loadProjectBranch(chapter.projectId, "main");
    const source = chapter.content.trim();
    const requestedQuery = retrievalQuery?.trim() ?? "";
    const query = (
      requestedQuery.length > 0
        ? requestedQuery.slice(0, 480)
        : source.length === 0
          ? chapter.title
          : source.slice(-480)
    ).trim();
    return selectCausalContextCandidates({
      graph,
      query: query.length === 0 ? "继续创作" : query,
      maximumEvents: 8,
    });
  } catch {
    // A corrupt or unavailable derived graph must not block access to the
    // saved chapter. Other governed context layers remain usable, while the
    // graph store itself fails closed and can be rebuilt from verified facts.
    return Object.freeze([]);
  }
}

interface SemanticContinuationCandidates {
  readonly semanticCandidates: readonly ContextCandidateDraft[];
  readonly rerankCandidates: readonly ContextCandidateDraft[];
}

const EMPTY_SEMANTIC_CONTINUATION_CANDIDATES: SemanticContinuationCandidates = Object.freeze({
  semanticCandidates: Object.freeze([]),
  rerankCandidates: Object.freeze([]),
});

async function retrieveSemanticContinuationCandidates(
  runtime: DesktopRuntime,
  chapter: Chapter,
  projectPrivacy: ProjectContextPrivacyReceipt,
  retrievalQuery?: string,
  allowRemoteRerank = !projectPrivacy.requiresVerifiedLocal,
): Promise<SemanticContinuationCandidates> {
  // Context preparation must not create an unreviewed remote data transfer.
  // Remote embedding is enabled only through the explicit Model Hub rebuild flow.
  if (runtime.search.embeddingDiagnostics().destination !== "local_ollama") {
    return EMPTY_SEMANTIC_CONTINUATION_CANDIDATES;
  }
  const querySource = chapter.content.trim();
  const requestedQuery = retrievalQuery?.trim() ?? "";
  const query = (
    requestedQuery.length > 0
      ? requestedQuery.slice(0, 480)
      : querySource.length === 0
        ? chapter.title
        : querySource.slice(-480)
  ).trim();
  if (query.length === 0) {
    return EMPTY_SEMANTIC_CONTINUATION_CANDIDATES;
  }
  const searched = await runtime.search.search(chapter.projectId, query, 32).catch(() => null);
  if (!searched?.ok || searched.value.capabilities.vector !== "ready") {
    return EMPTY_SEMANTIC_CONTINUATION_CANDIDATES;
  }
  const eligibleHits = searched.value.hits.filter(
    (hit) =>
      !(
        hit.document.sourceType === "chapter" &&
        hit.document.sourceId === chapter.id &&
        hit.document.sourceVersionId === chapter.currentVersionId
      ) && hit.document.text.trim().length > 0,
  );
  if (eligibleHits.length === 0) {
    return EMPTY_SEMANTIC_CONTINUATION_CANDIDATES;
  }
  const semanticHits = eligibleHits.slice(0, 6);
  const semanticHitIds = new Set(semanticHits.map(({ document }) => document.id));
  const semanticCandidates = semanticHits.map((hit) => searchHitContextCandidate(hit, "none"));
  const rerankInputs = eligibleHits.map((hit) => ({
    id: hit.document.id,
    text: hit.document.text.trim().slice(0, 4_000),
    retrievalScore: clampNormalizedScore(hit.scores.total),
    importance: clampNormalizedScore(hit.document.importance ?? 0),
    pinned: hit.document.pinned ?? false,
    evidence: {
      sourceType: searchContextSourceType(hit.document.sourceType),
      sourceId: hit.document.sourceId,
      sourceVersionId: hit.document.sourceVersionId,
      locator: `search-document:${hit.document.id}`,
      contentHash: hit.document.contentHash,
    },
  }));
  const localReranked = rerankWithLocalEvidence({
    query,
    candidates: rerankInputs,
    limit: Math.min(8, Math.max(1, eligibleHits.length)),
  });
  if (allowRemoteRerank) {
    await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(projectPrivacy);
  }
  const remoteAttempt = allowRemoteRerank
    ? await runtime.rerank.tryRerank({
        dispatchScope: projectContextDispatchScope(projectPrivacy),
        query,
        documents: rerankInputs.map(({ text }) => text),
        topN: Math.min(12, rerankInputs.length),
        onBeforeDispatch: () =>
          runtime.projectContextPrivacy.assertCurrentBeforeDispatch(projectPrivacy),
      })
    : Object.freeze({
        status: "skipped" as const,
        source: "local_deterministic_fallback" as const,
        code: "REMOTE_RERANK_NOT_ALLOWED",
        message:
          "Remote reranking was disabled for this chapter task; local evidence order was used.",
      });
  const indexById = new Map(rerankInputs.map(({ id }, index) => [id, index] as const));
  const localReasonByIndex = new Map<number, string>();
  const localRankings = localReranked.ranked.flatMap((ranked) => {
    const index = indexById.get(ranked.candidate.id);
    if (index === undefined) {
      return [];
    }
    localReasonByIndex.set(index, ranked.selectionReason);
    return [{ index, score: ranked.scores.total }];
  });
  const mergedRankings = mergeRemoteRerankWithLocalFallback({
    documentCount: rerankInputs.length,
    remoteRankings:
      remoteAttempt.status === "applied" ? remoteAttempt.result.rankings : Object.freeze([]),
    localRankings,
  });
  const rankedSupplements = mergedRankings.map((ranking) => ({
    id: rerankInputs[ranking.index]?.id ?? "",
    score: ranking.score,
    source: ranking.source,
    reason:
      ranking.source === "qwen_remote"
        ? "The author explicitly enabled Alibaba Qwen remote reranking for this task; only the bounded candidate set was sent."
        : `${localReasonByIndex.get(ranking.index) ?? "The local retrieval order preserved this source."} ${
            remoteAttempt.status === "skipped" ? remoteAttempt.message : ""
          }`.trim(),
  }));
  const hitsById = new Map(eligibleHits.map((hit) => [hit.document.id, hit]));
  const rerankCandidates: ContextCandidateDraft[] = [];
  for (const ranked of rankedSupplements) {
    if (semanticHitIds.has(ranked.id)) {
      continue;
    }
    const hit = hitsById.get(ranked.id);
    if (hit === undefined) {
      continue;
    }
    rerankCandidates.push(
      searchHitContextCandidate(hit, ranked.source, ranked.reason, ranked.score),
    );
    if (rerankCandidates.length >= 4) {
      break;
    }
  }
  return Object.freeze({
    semanticCandidates: Object.freeze(semanticCandidates),
    rerankCandidates: Object.freeze(rerankCandidates),
  });
}

function searchHitContextCandidate(
  hit: HybridSearchHit,
  rerankSource: "none" | "local" | "qwen_remote",
  rerankReason?: string,
  rerankScore?: number,
): ContextCandidateDraft {
  const content = hit.document.text.trim().slice(0, 4_000);
  const score = clampNormalizedScore(rerankScore ?? hit.scores.total);
  const reranked = rerankSource !== "none";
  return Object.freeze({
    id: `${rerankSource === "qwen_remote" ? "qwen-rerank" : reranked ? "local-rerank" : "semantic-search"}:${hit.document.id}`,
    content: `[${hit.document.title}]\n${content}`,
    selectionReason: reranked
      ? `${
          rerankSource === "qwen_remote"
            ? "The explicit Alibaba Qwen remote reranker selected this additional source."
            : "The local deterministic evidence reranker selected this additional source."
        } ${rerankReason ?? ""}`.trim()
      : "The local hybrid index found this source relevant and its vector capability was ready.",
    evidence: Object.freeze([
      Object.freeze({
        sourceType: reranked ? "rerank_result" : searchContextSourceType(hit.document.sourceType),
        sourceId: hit.document.sourceId,
        sourceVersionId: hit.document.sourceVersionId,
        locator: `search-document:${hit.document.id}`,
        contentHash: hit.document.contentHash,
        excerpt: null,
      }),
    ]),
    priority: Math.round(score * 1_000),
    relevanceScore: score,
  });
}

function clampNormalizedScore(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function searchContextSourceType(
  sourceType: "chapter" | "outline" | "character" | "world" | "foreshadow" | "material" | "memory",
): "chapter" | "outline" | "character" | "world" | "foreshadow" | "memory" | "other" {
  return sourceType === "material" ? "other" : sourceType;
}

function normalizeStoryContextFailure(cause: unknown): ModelCenterError {
  if (cause instanceof ProjectContextPrivacyError) {
    return normalizeProjectContextPrivacyFailure(cause);
  }
  if (cause instanceof StoryContextRuntimeError) {
    return new ModelCenterError(cause.code, cause.message, cause.retryable);
  }
  return new ModelCenterError(
    "STORY_CONTEXT_COMPILATION_FAILED",
    "无法安全整理本次续写所需的故事资料。请检查正式设定和上下文预算后重试；正文没有改变。",
    false,
  );
}

function measureMessageBytes(messages: readonly NativeModelMessage[]): number {
  return new TextEncoder().encode(messages.map(({ content }) => content).join("\n")).length;
}

async function buildGeneratedCandidate(
  runtime: DesktopRuntime,
  chapter: Chapter,
  generatedText: string,
  incomplete: boolean,
  cursorUtf16: number,
): Promise<Result<AiCandidate, AppError>> {
  const created = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
    applicationIntent: {
      task: "continuation",
      application: "insert_at_cursor",
      payload: "fragment",
      startUtf16: cursorUtf16,
      endUtf16: cursorUtf16,
    },
  });
  if (!created.ok) {
    return created;
  }
  const generated = generatedText.trim();
  const content =
    chapter.content.length > 0 && cursorUtf16 === chapter.content.length
      ? `\n\n${generated}`
      : generated;
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    return checksum;
  }
  const ready = created.value.markReady(content, checksum.value, runtime.clock.now(), incomplete);
  if (!ready.ok) {
    return ready;
  }
  return ok(ready.value);
}

async function evaluateCandidateAgainstLocalGate(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  candidate: AiCandidate,
  baselineContent: string,
): Promise<CandidateQualityGateResult> {
  const promptEnvelope = plan.messages
    .map(({ role, content }) => `${role}:${String(content.length)}:${content}`)
    .join("\n");
  const hashed = await runtime.hasher.sha256(promptEnvelope);
  if (!hashed.ok) {
    throw hashed.error;
  }
  return evaluateGeneratedCandidateQuality({
    candidate,
    baselineContent,
    promptTraceId: `generation-run.${plan.runId}`,
    promptContentHashSha256: hashed.value,
    measuredAt: runtime.clock.now(),
  });
}

function normalizeGovernedGenerationError(cause: unknown): GovernedGenerationError {
  if (cause instanceof ProjectContextPrivacyError) {
    return normalizeProjectContextPrivacyFailure(cause);
  }
  if (cause instanceof ModelHubExecutionError) {
    return new ModelCenterError(
      cause.code,
      cause.message,
      cause.retryable,
      cause.failure === null
        ? null
        : {
            requestId: cause.failure.requestId ?? null,
            httpStatus: cause.failure.httpStatus ?? null,
            finishReason: cause.failure.finishReason ?? null,
            visibleContentLength: cause.failure.visibleContentLength ?? null,
            reasoningPresent: cause.failure.reasoningPresent ?? null,
            stream: cause.failure.stream ?? null,
            inputTokens: null,
            outputTokens: null,
          },
    );
  }
  if (
    cause instanceof AppError ||
    cause instanceof ModelCenterError ||
    cause instanceof GenerationGovernanceError ||
    cause instanceof TaskEngineError
  ) {
    return cause;
  }
  return new ModelCenterError(
    "MODEL_GENERATION_FAILED",
    "Governed model generation failed unexpectedly.",
    true,
  );
}

function safeFailureCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : "MODEL_GENERATION_FAILED";
}

async function publishGenerationNotification(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
  outcome: "completed" | "partial" | "failed" | "cancelled",
  attempt: number,
  reasonCode: string | null = null,
): Promise<void> {
  try {
    await runtime.taskCenter.publishNotification({
      id: runtime.ids.next(),
      dedupeKey: `notification:${plan.taskId}:${outcome}`,
      messageKey: `task.${outcome}`,
      level: "inbox",
      severity: outcome === "completed" ? "success" : outcome === "failed" ? "error" : "warning",
      route: { entityType: "task", entityId: plan.taskId },
      metadata: {
        taskType: "ai.generate",
        attempt,
        ...(reasonCode === null ? {} : { reasonCode }),
      },
      requiresResolution: outcome === "failed" || outcome === "partial",
      expiresAt: null,
      now: runtime.clock.now(),
    });
  } catch {
    // Durable task/run truth has already been committed; inbox delivery is best effort.
  }
}

export async function createConfiguredModelCandidate(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
  onDelta?: (accumulatedText: string) => void,
): Promise<Result<AiCandidate, AppError | ModelCenterError>> {
  if (!runtime.modelGateway.available || runtime.mode !== "tauri") {
    return err(
      new ModelCenterError(
        "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
        "Configured model generation is available only in the Tauri desktop app.",
      ),
    );
  }
  // Compatibility API: keep one production contract by delegating to the same
  // governed plan used by the editor. The legacy implementation below remains
  // unreachable only until downstream callers finish migrating their return type.
  if (usesGovernedConfiguredCandidateCompatibility()) {
    try {
      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: true,
        networkAvailable: typeof navigator === "undefined" ? true : navigator.onLine,
        outputProfile: "standard",
        contextBudgetProfile: "standard",
      });
      if (!plan.preflight.canStart) {
        const blocker = plan.preflight.blockers[0];
        return err(
          new ModelCenterError(
            blocker?.code ?? "AI_GENERATION_PREFLIGHT_BLOCKED",
            "AI 续写预检未通过，请按提示检查模型连接、隐私范围、上下文或预算后重试。",
            true,
          ),
        );
      }
      const executed = await executeGenerationPlan(runtime, plan, onDelta);
      if (!executed.ok) {
        return err(configuredCandidateCompatibilityError(executed.error));
      }
      if (executed.value.candidate === null) {
        return err(
          new ModelCenterError(
            executed.value.cancelled ? "MODEL_GENERATION_CANCELLED" : "MODEL_OUTPUT_EMPTY",
            executed.value.cancelled
              ? "AI 续写已取消；正文和已有 AI 建议版本均未改变。"
              : "AI 没有返回可保存的正文；正文和已有 AI 建议版本均未改变。",
            true,
          ),
        );
      }
      return ok(executed.value.candidate);
    } catch (cause: unknown) {
      return err(configuredCandidateCompatibilityError(cause));
    }
  }

  /* c8 ignore start -- unreachable runtime fallback retained for binary API transition */
  const chapterResult = await runtime.repositories.chapters.findById(chapterId);
  if (!chapterResult.ok) {
    return chapterResult;
  }
  if (chapterResult.value === null) {
    return err(
      new AppError({
        code: "CHAPTER_NOT_FOUND",
        message: "章节不存在。",
      }),
    );
  }
  const chapter = chapterResult.value;
  let messages: readonly NativeModelMessage[];
  let preparedContext: ContextualContinuationMessages;
  try {
    preparedContext = await buildContextualContinuationMessages(runtime, chapter);
    messages = preparedContext.messages;
  } catch (cause: unknown) {
    return err(normalizeStoryContextFailure(cause));
  }
  const inputBytes = new TextEncoder().encode(
    messages.map(({ content }) => content).join(""),
  ).length;
  if (inputBytes > 1_000_000) {
    return err(
      new ModelCenterError(
        "MODEL_INPUT_TOO_LARGE",
        "The saved chapter is too large for the native model request limit.",
      ),
    );
  }
  let generatedText: string | null = null;
  const privacyReceipt = preparedContext.contextCompilation.projectPrivacy;
  const requiredDataDestination = projectContextRequiredDataDestination(privacyReceipt);
  const contextTraceId = runtime.ids.next();
  const generationId = runtime.ids.next();
  try {
    const generated = await executeModelHubTextTask(runtime, {
      dispatchScope: projectContextDispatchScope(privacyReceipt),
      task: "continuation",
      messages,
      maximumOutputTokens: 2_048,
      temperature: 0.8,
      generationId,
      ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
      onBeforeDispatch: async ({
        generationId: selectedGenerationId,
        invocationId,
        localOnlyEligible,
      }) => {
        await saveDirectContinuationContextTrace(
          runtime,
          chapter,
          preparedContext.contextCompilation,
          {
            traceId: contextTraceId,
            generationId: selectedGenerationId,
            modelInvocationId: invocationId,
          },
        );
        await assertProjectContextBeforeModelHubDispatch(
          runtime,
          privacyReceipt,
          localOnlyEligible === true,
        );
      },
      onFinalBeforeProviderDispatch: async ({ localOnlyEligible }) => {
        await assertProjectContextBeforeModelHubDispatch(
          runtime,
          privacyReceipt,
          localOnlyEligible === true,
        );
      },
      ...(onDelta === undefined ? {} : { onDelta }),
    });
    generatedText = generated.text;
  } catch (cause: unknown) {
    if (
      !(cause instanceof ModelHubExecutionError) ||
      cause.code !== "MODEL_HUB_ROUTE_NOT_CONFIGURED"
    ) {
      return err(
        new ModelCenterError(
          cause instanceof ModelHubExecutionError ? cause.code : "MODEL_GENERATION_FAILED",
          cause instanceof Error
            ? cause.message
            : "模型调用失败。原文和已有 AI 建议版本都没有改变。",
          cause instanceof ModelHubExecutionError ? cause.retryable : true,
        ),
      );
    }
  }

  if (generatedText === null) {
    let profiles;
    try {
      profiles = await runtime.modelCenter.listProfiles();
    } catch (cause: unknown) {
      return err(
        cause instanceof ModelCenterError
          ? cause
          : new ModelCenterError(
              "MODEL_PROFILE_STORE_UNAVAILABLE",
              "Unable to read model profiles.",
              true,
            ),
      );
    }
    const profile = profiles.find((candidate) => candidate.selectedModel !== null);
    if (!profile?.selectedModel) {
      return err(
        new ModelCenterError(
          "MODEL_PROFILE_NOT_READY",
          "请先在设置中连接供应商并为“续写”选择模型。",
        ),
      );
    }
    const resolvedEndpoint = await resolveModelProfileGatewayConfig(
      { modelHub: runtime.modelHub, credentials: runtime.credentials },
      profile,
    ).catch(() => null);
    if (resolvedEndpoint === null) {
      return err(
        new ModelCenterError(
          "MODEL_CREDENTIAL_MISSING",
          "供应商连接没有可用凭据。请在设置中重新保存并测试连接。",
          true,
        ),
      );
    }
    try {
      await saveDirectContinuationContextTrace(
        runtime,
        chapter,
        preparedContext.contextCompilation,
        { traceId: contextTraceId, generationId, modelInvocationId: null },
      );
      await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(privacyReceipt);
      runtime.projectContextPrivacy.assertRouteEligible(
        privacyReceipt,
        isVerifiedLocalGatewayConfig(resolvedEndpoint.config),
      );
      const current = await resolveFinalModelProfileGatewayConfig(
        {
          modelCenter: runtime.modelCenter,
          modelHub: runtime.modelHub,
          credentials: runtime.credentials,
        },
        profile,
        resolvedEndpoint,
      );
      const generated = await runtime.modelGateway.generate({
        dispatchScope: projectContextDispatchScope(privacyReceipt),
        generationId,
        config: current.resolution.config,
        model: current.profile.selectedModel ?? profile.selectedModel,
        messages,
        maxOutputTokens: 2_048,
        temperature: 0.8,
        ...(onDelta === undefined ? {} : { onDelta }),
      });
      generatedText = generated.text;
    } catch (cause: unknown) {
      return err(
        cause instanceof ModelCenterError
          ? cause
          : cause instanceof ProjectContextPrivacyError
            ? normalizeProjectContextPrivacyFailure(cause)
            : new ModelCenterError(
                "MODEL_GENERATION_FAILED",
                "模型调用失败。原文和已有 AI 建议版本都没有改变。",
                true,
              ),
      );
    }
  }

  const created = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
    applicationIntent: {
      task: "continuation",
      application: "insert_at_cursor",
      payload: "fragment",
      startUtf16: chapter.content.length,
      endUtf16: chapter.content.length,
    },
  });
  if (!created.ok) {
    return created;
  }
  const generated = generatedText.trim();
  const content = chapter.content.length === 0 ? generated : `\n\n${generated}`;
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    return checksum;
  }
  const ready = created.value.markReady(content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    return ready;
  }
  try {
    await runtime.contextTraceOutputs.commit({
      traceId: contextTraceId,
      candidate: ready.value,
      linkedAt: runtime.clock.now(),
    });
  } catch {
    return err(
      new ModelCenterError(
        "CONTEXT_TRACE_UNAVAILABLE",
        "无法同时保存 AI 建议版本及其上下文来源记录，因此本次建议版本未保存。正文和已有 AI 建议版本均未改变。",
        true,
      ),
    );
  }
  return ok(ready.value);
  /* c8 ignore stop */
}

function configuredCandidateCompatibilityError(cause: unknown): AppError | ModelCenterError {
  const normalized = normalizeGovernedGenerationError(cause);
  if (normalized instanceof AppError || normalized instanceof ModelCenterError) {
    return normalized;
  }
  return new ModelCenterError(normalized.code, normalized.message, normalized.retryable);
}

function usesGovernedConfiguredCandidateCompatibility(): boolean {
  return true;
}

export async function createLocalDemoCandidate(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
  requestedCursorUtf16?: number,
): Promise<Result<AiCandidate, AppError>> {
  const chapterResult = await runtime.repositories.chapters.findById(chapterId);
  if (!chapterResult.ok) {
    return chapterResult;
  }
  if (chapterResult.value === null) {
    return err(
      new AppError({
        code: "CHAPTER_NOT_FOUND",
        message: "章节不存在。",
      }),
    );
  }

  const chapter = chapterResult.value;
  const cursorUtf16 = resolveContinuationCursor(chapter.content, requestedCursorUtf16);
  const created = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
    applicationIntent: {
      task: "continuation",
      application: "insert_at_cursor",
      payload: "fragment",
      startUtf16: cursorUtf16,
      endUtf16: cursorUtf16,
    },
  });
  if (!created.ok) {
    return created;
  }

  const demoParagraph = "【本地演示候选】暮色沿着窗棂缓慢下沉，人物在未说出口的决定前停了一瞬。";
  const content =
    chapter.content.length > 0 && cursorUtf16 === chapter.content.length
      ? `\n\n${demoParagraph}`
      : demoParagraph;
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    return checksum;
  }
  const ready = created.value.markReady(content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    return ready;
  }

  const persisted = await runtime.repositories.aiCandidates.create(ready.value);
  return persisted.ok ? ok(ready.value) : persisted;
}

function normalizeNativeModelGatewayError(cause: unknown): ModelCenterError {
  if (cause instanceof ModelCenterError) {
    return cause;
  }
  if (
    isRecord(cause) &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return new ModelCenterError(
      cause.code,
      "The native model gateway rejected the operation.",
      cause.retryable === true,
      nativeFailureDiagnostics(cause, null),
    );
  }
  return new ModelCenterError(
    "MODEL_RUNTIME_FAILED",
    "Native model generation failed unexpectedly.",
    true,
  );
}

function nativeFailureDiagnostics(
  value: unknown,
  visibleContentLength: number | null,
): ModelCenterFailureDiagnostics | null {
  const record = isRecord(value) ? value : {};
  const requestId = safeDiagnosticIdentifier(record.requestId);
  const httpStatus = safeHttpStatus(record.httpStatus);
  const finishReason = safeFinishReason(record.finishReason);
  const reasoningPresent =
    typeof record.reasoningPresent === "boolean" ? record.reasoningPresent : null;
  const stream = typeof record.stream === "boolean" ? record.stream : null;
  const usage = isRecord(record.usage) ? record.usage : null;
  const inputTokens = safeDiagnosticTokenCount(usage?.inputTokens);
  const outputTokens = safeDiagnosticTokenCount(usage?.outputTokens);
  const safeVisibleLength =
    visibleContentLength !== null &&
    Number.isSafeInteger(visibleContentLength) &&
    visibleContentLength >= 0
      ? visibleContentLength
      : null;
  if (
    requestId === null &&
    httpStatus === null &&
    finishReason === null &&
    safeVisibleLength === null &&
    reasoningPresent === null &&
    stream === null &&
    inputTokens === null &&
    outputTokens === null
  ) {
    return null;
  }
  return Object.freeze({
    requestId,
    httpStatus,
    finishReason,
    visibleContentLength: safeVisibleLength,
    reasoningPresent,
    stream,
    inputTokens,
    outputTokens,
  });
}

function safeDiagnosticIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function safeHttpStatus(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : null;
}

function safeFinishReason(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/u.test(value) ? value : null;
}

function safeDiagnosticTokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000_000
    ? (value as number)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
