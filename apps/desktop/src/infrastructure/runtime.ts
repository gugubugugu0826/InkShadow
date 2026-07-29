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
  RenameProject,
  RestoreChapterVersion,
  RestoreProject,
  SaveChapter,
  TrashProject,
  UnarchiveProject,
  type AiCandidateRepository,
  type ChapterRepository,
  type ChapterVersionRepository,
  type ContentCommitRepository,
  type ContentHasher,
  type ProjectRepository,
  type ProjectImportCommitRepository,
  type RecoveryDraftRepository,
} from "@inkshadow/application";
import {
  estimateGenerationCost,
  resolveModelRoute,
  runGenerationPreflight,
  type GenerationPreflightSnapshot,
  type ModelRouteCandidate,
  type ModelRouteRole,
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
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import {
  CloudDeletionJournalSqliteStore,
  DatabaseMaintenanceService,
  GovernedCreativeExtensionSqliteStore,
  MultiAgentReviewSqliteStore,
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
  SqliteMemoryRecordCreationUnitOfWork,
  SqliteMemoryRecordRepository,
  SqliteOutlineDraftReader,
  SqliteOutlineRepository,
  SqliteReviewDecisionUnitOfWork,
  SqliteReviewItemRepository,
  SqliteWhatIfPromotionUnitOfWork,
  SqliteWhatIfRepository,
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
  type MemoryRecordCreationUnitOfWork,
  type MemoryRecordListReader,
  type MemoryRecordRepository,
  type OutlineDraftReader,
  type OutlineRepository,
  type Result as StoryResult,
  type ReviewDecisionUnitOfWork,
  type ReviewItemListReader,
  type ReviewItemRepository,
  type WhatIfBranchListReader,
  type WhatIfPromotionUnitOfWork,
  type WhatIfRepository,
} from "@inkshadow/story-core";
import { TaskEngineError } from "@inkshadow/task-engine";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { createDevelopmentRepositories } from "./development-storage";
import { createIdempotentAsyncCloser } from "./desktop-close-coordinator";
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
  type ModelProfile,
  type NativeAuthenticationMode,
  type NativeProviderKind,
} from "./model-center-store";
import {
  BrowserDevelopmentModelRoutingStore,
  TauriModelRoutingStore,
  type ModelRoutingStore,
} from "./model-routing-store";
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
import { LocalProjectSearchService, type ProjectSearchService } from "./project-search";
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
import {
  BrowserDevelopmentIdeationDraftRepository,
  BrowserDevelopmentFormalStoryRecordRepository,
  BrowserDevelopmentMemoryPolicyRepository,
  BrowserDevelopmentMemoryRecordCreationUnitOfWork,
  BrowserDevelopmentMemoryRecordRepository,
  BrowserDevelopmentOutlineDraftReader,
  BrowserDevelopmentOutlineRepository,
  BrowserDevelopmentReviewDecisionUnitOfWork,
  BrowserDevelopmentReviewItemRepository,
  BrowserDevelopmentWhatIfPromotionUnitOfWork,
  BrowserDevelopmentWhatIfRepository,
} from "./story-storage";
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
  readonly listChapterVersions: ListChapterVersions;
  readonly restoreChapterVersion: RestoreChapterVersion;
  readonly acceptCandidate: AcceptAiCandidate;
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

export interface NativeModelEndpointConfig {
  readonly providerId: string;
  readonly provider: NativeProviderKind;
  readonly baseUrl: string;
  readonly authentication: NativeAuthenticationMode;
}

export interface NativeModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly sizeBytes?: number | null;
}

export interface NativeModelListResponse {
  readonly provider: NativeProviderKind;
  readonly models: readonly NativeModelDescriptor[];
}

export interface NativeModelConnectionResponse {
  readonly provider: NativeProviderKind;
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
}

export interface NativeModelGatewayClient extends NativeEmbeddingGatewayClient {
  readonly available: boolean;
  listModels(config: NativeModelEndpointConfig): Promise<NativeModelListResponse>;
  checkConnection(config: NativeModelEndpointConfig): Promise<NativeModelConnectionResponse>;
  inspectCapacity?(): Promise<NativeModelCapacityResponse>;
  generate(input: NativeModelGenerationInput): Promise<NativeModelGenerationResult>;
  cancelGeneration(generationId: string): Promise<boolean>;
}

export interface RuntimeStory {
  readonly ideationDrafts: IdeationDraftRepository;
  readonly ideationService: IdeationApplicationService;
  readonly outlines: OutlineRepository;
  readonly outlineService: OutlineApplicationService;
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
  readonly modelCenter: ModelCenterStore;
  readonly modelRouting: ModelRoutingStore;
  readonly modelGateway: NativeModelGatewayClient;
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
    }>
  | Readonly<{ phase: "cancelled" }>
  | Readonly<{
      phase: "failed";
      code: string;
      retryable: boolean;
    }>;

interface NativeGenerationEvent {
  readonly generationId: string;
  readonly sequence: number;
  readonly delta: string;
  readonly status: NativeGenerationStatus;
}

export class TauriNativeModelGatewayClient implements NativeModelGatewayClient {
  public readonly available = true;

  public listModels(config: NativeModelEndpointConfig): Promise<NativeModelListResponse> {
    return invoke<NativeModelListResponse>("list_native_models", {
      request: { config },
    });
  }

  public checkConnection(
    config: NativeModelEndpointConfig,
  ): Promise<NativeModelConnectionResponse> {
    return invoke<NativeModelConnectionResponse>("check_native_model_connection", {
      request: { config },
    });
  }

  public inspectCapacity(): Promise<NativeModelCapacityResponse> {
    return invoke<NativeModelCapacityResponse>("inspect_native_model_capacity");
  }

  public async embed(input: NativeEmbeddingInput): Promise<NativeEmbeddingResult> {
    const result = await invoke<NativeEmbeddingResult>("embed_native_model", {
      request: {
        config: input.config,
        model: input.model,
        inputs: input.inputs,
      },
    });
    return validateNativeEmbeddingResult(result, input);
  }

  public generate(input: NativeModelGenerationInput): Promise<NativeModelGenerationResult> {
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
      const complete = (usage: NativeModelGenerationUsage | null) => {
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
              complete(payload.status.usage);
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
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
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

function buildRuntime(
  mode: RuntimeMode,
  repositories: RuntimeRepositories,
  close: () => Promise<void>,
  maintenance: RuntimeMaintenance | null,
  createTaskCenter: (clock: Clock) => TaskCenterStore,
  createGenerationGovernance: (clock: Clock) => GenerationGovernanceStore,
  createModelCenter: (clock: Clock) => ModelCenterStore,
  createModelRouting: (clock: Clock, modelCenter: ModelCenterStore) => ModelRoutingStore,
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
  const modelCenter = createModelCenter(clock);
  const modelRouting = createModelRouting(clock, modelCenter);
  const modelGateway: NativeModelGatewayClient =
    mode === "tauri"
      ? new TauriNativeModelGatewayClient()
      : new BrowserDevelopmentModelGatewayClient();
  const credentials: CredentialStore =
    mode === "tauri" ? new TauriCredentialStore() : new BrowserDevelopmentCredentialStore();
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
          gateway: new NativeGovernedCreativeExtensionGateway(modelGateway, ids),
          ids,
          clock,
          resolveRoute: (kind) =>
            resolveConfiguredGovernedCreativeExtensionRoute(kind, {
              modelCenter,
              modelRouting,
              credentials,
            }),
          readEnvironment: () => ({
            online: navigator.onLine,
            readOnly: false,
          }),
          isSourceReadOnly: (projectId, chapterId) =>
            isGovernedSourceReadOnly(repositories, projectId, chapterId),
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
          modelRouting,
          modelGateway,
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
  const searchVectors = new PersistentProjectEmbeddingService(
    cloudExecutor === null ? null : new SearchVectorSqliteStore(cloudExecutor),
    modelRouting,
    modelCenter,
    modelGateway,
    hasher,
    clock,
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
    taskCenter: createTaskCenter(clock),
    generationGovernance: createGenerationGovernance(clock),
    modelCenter,
    modelRouting,
    modelGateway,
    multiAgentReview,
    governedCreativeExtensions,
    projectKeyVault,
    projectSecurity,
    story: {
      actorId,
      ideationDrafts: storyPersistence.ideationDrafts,
      ideationService: new IdeationApplicationService({
        drafts: storyPersistence.ideationDrafts,
        projects: storyPersistence.ideationProjects,
        clock,
        ids,
      }),
      outlines: storyPersistence.outlines,
      outlineService: new OutlineApplicationService({
        outlines: storyPersistence.outlines,
        clock,
        ids,
      }),
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
      rejectCandidate: new RejectAiCandidate(repositories.aiCandidates, clock),
    },
    close: closeRuntime,
  };
}

interface StoryPersistence {
  readonly ideationDrafts: IdeationDraftRepository;
  readonly ideationProjects: IdeationProjectCommitUnitOfWork;
  readonly outlines: OutlineRepository;
  readonly formalRecords: FormalStoryRecordRepository &
    FormalStoryRecordListReader &
    FormalTimelineReader;
  readonly memoryPolicies: MemoryPolicyRepository;
  readonly memoryRecords: MemoryRecordRepository & MemoryRecordListReader;
  readonly memoryCreation: MemoryRecordCreationUnitOfWork;
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
    appVersion: "0.1.0",
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
      modelRouting: options.runtime.modelRouting,
      credentials: options.runtime.credentials,
      gateway: options.runtime.modelGateway,
      hasher: options.runtime.hasher,
      ids: options.runtime.ids,
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
    const repositories = createSqliteRepositories(executor, {
      syncProjectionIds: new CryptoUuidV7Generator(),
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
      () => executor.close(),
      createTauriRuntimeMaintenance(executor),
      (clock) => new TauriTaskCenterStore(executor, clock),
      (clock) => new TauriGenerationGovernanceStore(executor, clock),
      (clock) => new TauriModelCenterStore(executor, clock),
      (clock) => new TauriModelRoutingStore(executor, clock),
      (ids, clock, hasher) => {
        const extractionItems = new SqliteReviewItemRepository(executor, "extraction");
        const consistencyItems = new SqliteReviewItemRepository(executor, "consistency");
        return {
          ideationDrafts: new SqliteIdeationDraftRepository(executor),
          ideationProjects: new SqliteIdeationProjectCommitUnitOfWork(executor, ids, clock, hasher),
          outlines: new SqliteOutlineRepository(executor),
          formalRecords: new SqliteFormalStoryRecordRepository(executor),
          memoryPolicies: new SqliteMemoryPolicyRepository(executor),
          memoryRecords: new SqliteMemoryRecordRepository(executor),
          memoryCreation: new SqliteMemoryRecordCreationUnitOfWork(executor),
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
    const runtime: DesktopRuntime = Object.freeze({
      ...baseRuntime,
      authoritativeExtraction: await createConfiguredAuthoritativeExtractionRuntime({
        enabled: baseRuntime.featureFlags.authoritativeExtraction,
        executor,
        runtime: baseRuntime,
      }),
    });
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
    return runtime;
  }

  return createDevelopmentRuntime(window.localStorage);
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
    () => Promise.resolve(),
    null,
    (clock) => new BrowserDevelopmentTaskCenterStore(storage, clock),
    (clock) => new BrowserDevelopmentGenerationGovernanceStore(storage, clock),
    (clock) => new BrowserDevelopmentModelCenterStore(storage, clock),
    (clock, modelCenter) => new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter),
    (ids, clock, hasher) => {
      const sourceVersions = new RepositoryChapterVersionReader(repositories.chapters);
      const extractionItems = new BrowserDevelopmentReviewItemRepository(storage, "extraction");
      const consistencyItems = new BrowserDevelopmentReviewItemRepository(storage, "consistency");
      return {
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

export interface PreparedGenerationPlan {
  readonly requestId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly generationId: string;
  readonly leaseToken: string;
  readonly idempotencyKey: string;
  readonly projectId: string | null;
  readonly chapterId: UuidV7;
  readonly baseVersionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelRole: ModelRouteRole;
  readonly routeReason: "legacy_default" | "role_primary" | "role_fallback" | "local_demo";
  readonly routeFallback: Readonly<{
    providerId: string;
    modelId: string;
  }> | null;
  readonly routeRequiresConfirmation: boolean;
  readonly deferredRequest: DeferredGenerationRequest | null;
  readonly maximumOutputTokens: number;
  readonly tokenEstimateSource: "utf8_conservative" | "local_demo";
  readonly preflight: GenerationPreflightSnapshot;
  readonly profile: ModelProfile | null;
}

export interface GovernedGenerationOutcome {
  readonly candidate: AiCandidate | null;
  readonly cancelled: boolean;
  readonly reused: boolean;
  readonly taskId: string;
  readonly runId: string;
}

export type GovernedGenerationError =
  AppError | ModelCenterError | GenerationGovernanceError | TaskEngineError;

export async function prepareGenerationPlan(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
  input: {
    readonly chapterSaved: boolean;
    readonly networkAvailable: boolean;
  },
): Promise<PreparedGenerationPlan> {
  await runtime.taskCenter.recoverExpiredTasks();
  const requestId = runtime.ids.next();
  const modelRole: ModelRouteRole = "high_quality";
  const [chapterResult, profiles, roleRoute, waitingDeferred] = await Promise.all([
    runtime.repositories.chapters.findById(chapterId),
    runtime.modelCenter.listProfiles(),
    runtime.modelRouting.findRoute(modelRole),
    runtime.generationGovernance.findWaitingDeferredRequest(chapterId, modelRole),
  ]);
  if (!chapterResult.ok) {
    throw chapterResult.error;
  }
  const chapter = chapterResult.value;
  const projectResult =
    chapter === null ? null : await runtime.repositories.projects.findById(chapter.projectId);
  if (projectResult !== null && !projectResult.ok) {
    throw projectResult.error;
  }
  const project = projectResult?.value ?? null;
  const demo = runtime.mode === "browser-development";
  let profile: ModelProfile | null = null;
  let routeResolved = true;
  let routeReason: PreparedGenerationPlan["routeReason"] = demo ? "local_demo" : "legacy_default";
  let routeRequiresConfirmation = false;
  const routeFallback =
    roleRoute?.fallbackProviderId === null ||
    roleRoute?.fallbackProviderId === undefined ||
    roleRoute.fallbackModelId === null
      ? null
      : Object.freeze({
          providerId: roleRoute.fallbackProviderId,
          modelId: roleRoute.fallbackModelId,
        });
  let credentialConfigured = demo;
  let connectionStatus: "verified" | "failed" | "not_checked" = demo ? "verified" : "not_checked";
  let selectedModelAvailable = demo;

  if (!demo && roleRoute !== null) {
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
    }
    if (resolution.status === "resolved") {
      routeReason = resolution.reason === "fallback_verified" ? "role_fallback" : "role_primary";
      routeRequiresConfirmation = resolution.requiresConfirmation;
    } else {
      routeReason = "role_primary";
    }
  } else if (!demo) {
    profile = profiles.find((candidate) => candidate.selectedModel !== null) ?? profiles[0] ?? null;
    if (profile !== null) {
      const inspected = await inspectModelRouteProfile(runtime, profile, input.networkAvailable);
      credentialConfigured = inspected.credentialConfigured;
      connectionStatus = inspected.connectionStatus;
      selectedModelAvailable = inspected.selectedModelAvailable;
    }
  }

  const providerId = demo ? "local-demo" : (profile?.providerId ?? "unconfigured");
  const modelId = demo ? "built-in-demo" : (profile?.selectedModel ?? "unselected");
  const maximumOutputTokens = 2_048;
  const messages = chapter === null ? [] : buildContinuationMessages(chapter);
  const inputBytes = demo ? 0 : measureMessageBytes(messages);
  const inputTokens = demo ? 0 : Math.ceil(inputBytes / 3);
  const pricing =
    profile?.pricing === null || profile?.pricing === undefined
      ? null
      : {
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
        };
  const monthKey = runtime.clock.now().slice(0, 7);
  const budgets =
    chapter === null || pricing === null
      ? []
      : await runtime.generationGovernance.getBudgetLimits(
          chapter.projectId,
          monthKey,
          pricing.currency,
        );
  const preflight = runGenerationPreflight({
    now: runtime.clock.now(),
    migrationReady: true,
    chapterExists: chapter !== null,
    chapterSaved: input.chapterSaved,
    projectWritable: project?.status === "active",
    gatewayAvailable: demo || runtime.modelGateway.available,
    networkAvailable: input.networkAvailable,
    providerLocation: demo ? "demo" : profile?.provider === "ollama" ? "local" : "remote",
    routeResolved,
    profileConfigured: demo || profile !== null,
    modelSelected: demo || profile?.selectedModel !== null,
    credentialConfigured,
    connectionStatus,
    selectedModelAvailable,
    inputBytes,
    maximumInputBytes: 1_000_000,
    inputTokens,
    maximumOutputTokens,
    contextWindowTokens: demo ? null : (profile?.pricing?.contextWindowTokens ?? null),
    pricing,
    budgets,
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
  return Object.freeze({
    requestId,
    taskId: retryableRun?.taskId ?? deferredResumeRun?.taskId ?? runtime.ids.next(),
    runId: retryableRun?.id ?? deferredResumeRun?.id ?? runtime.ids.next(),
    generationId: runtime.ids.next(),
    leaseToken: runtime.ids.next(),
    idempotencyKey,
    projectId: chapter?.projectId ?? null,
    chapterId,
    baseVersionId,
    providerId,
    modelId,
    modelRole,
    routeReason,
    routeFallback,
    routeRequiresConfirmation,
    deferredRequest,
    maximumOutputTokens,
    tokenEstimateSource: demo ? "local_demo" : "utf8_conservative",
    preflight,
    profile,
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
  if (
    !plan.preflight.canStart ||
    plan.projectId === null ||
    plan.baseVersionId === null ||
    plan.preflight.estimate === null
  ) {
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
        reason: plan.routeReason,
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
      await publishGenerationNotification(runtime, plan, "completed", run.attempt);
      return ok({
        candidate: candidate.value,
        cancelled: false,
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
    let candidate: AiCandidate;
    let attemptUsage: GenerationAttemptUsageInput = {
      source: "provider_unavailable",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      usagePricedEstimateMicros: null,
    };
    try {
      if (runtime.mode === "browser-development") {
        const demo = await createLocalDemoCandidate(runtime, plan.chapterId);
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
        if (plan.profile?.selectedModel === null || plan.profile === null) {
          throw new ModelCenterError(
            "MODEL_PROFILE_NOT_READY",
            "The preflight model profile is no longer ready.",
          );
        }
        const generated = await runtime.modelGateway.generate({
          generationId: plan.generationId,
          config: {
            providerId: plan.profile.providerId,
            provider: plan.profile.provider,
            baseUrl: plan.profile.baseUrl,
            authentication: plan.profile.authentication,
          },
          model: plan.profile.selectedModel,
          messages: buildContinuationMessages(chapter),
          maxOutputTokens: plan.maximumOutputTokens,
          temperature: 0.8,
          onDelta: (next) => {
            accumulated = next;
            onDelta?.(next);
          },
        });
        attemptUsage = priceProviderReportedUsage(plan, generated.usage);
        accumulated = generated.text;
        const persisted = await persistGeneratedCandidate(runtime, chapter, generated.text, false);
        if (!persisted.ok) {
          throw persisted.error;
        }
        candidate = persisted.value;
      }
    } catch (cause: unknown) {
      const normalized = normalizeGovernedGenerationError(cause);
      if (normalized.code === "MODEL_GENERATION_CANCELLED") {
        let partialCandidate: AiCandidate | null = null;
        if (accumulated.trim().length > 0) {
          const persisted = await persistGeneratedCandidate(runtime, chapter, accumulated, true);
          if (persisted.ok) {
            partialCandidate = persisted.value;
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
          cancelled: true,
          reused: false,
          taskId: plan.taskId,
          runId: run.id,
        });
      }
      const retryable = normalized.retryable;
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
      return err(normalized);
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
          cancelled: true,
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
    await publishGenerationNotification(runtime, plan, "completed", run.attempt);
    return ok({
      candidate,
      cancelled: false,
      reused: false,
      taskId: plan.taskId,
      runId: run.id,
    });
  } catch (cause: unknown) {
    return err(normalizeGovernedGenerationError(cause));
  }
}

export async function cancelGenerationPlan(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
): Promise<boolean> {
  const [taskCancelled, gatewayCancelled] = await Promise.all([
    runtime.taskCenter
      .cancelTask(plan.taskId)
      .then(() => true)
      .catch(() => false),
    runtime.mode === "tauri"
      ? runtime.modelGateway.cancelGeneration(plan.generationId).catch(() => false)
      : Promise.resolve(true),
  ]);
  return taskCancelled || gatewayCancelled;
}

interface InspectedModelRouteProfile {
  readonly profile: ModelProfile;
  readonly candidate: ModelRouteCandidate;
  readonly credentialConfigured: boolean;
  readonly connectionStatus: "verified" | "failed" | "not_checked";
  readonly selectedModelAvailable: boolean;
}

const TEXT_GENERATION_MODEL_ROLES = [
  "fast",
  "high_quality",
  "long_context",
  "validation",
  "translation",
] as const satisfies readonly ModelRouteRole[];

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
  const pricing = plan.profile?.pricing;
  if (pricing === null || pricing === undefined) {
    throw new ModelCenterError(
      "MODEL_PRICING_MISSING",
      "Provider usage cannot be priced without the approved pricing snapshot.",
    );
  }
  const estimate = estimateGenerationCost(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens === null ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    },
    {
      currency: pricing.currency,
      pricingVersion: pricing.pricingVersion,
      updatedAt: pricing.priceUpdatedAt,
      inputMicrosPerMillionTokens: BigInt(pricing.inputMicrosPerMillionTokens),
      outputMicrosPerMillionTokens: BigInt(pricing.outputMicrosPerMillionTokens),
      ...(pricing.cachedInputMicrosPerMillionTokens === null
        ? {}
        : {
            cachedInputMicrosPerMillionTokens: BigInt(pricing.cachedInputMicrosPerMillionTokens),
          }),
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
  let credentialConfigured = profile.authentication === "none";
  if (profile.authentication === "bearer_keyring") {
    try {
      credentialConfigured = (await runtime.credentials.getSummary(profile.providerId)).configured;
    } catch {
      credentialConfigured = false;
    }
  }

  const canProbe =
    runtime.modelGateway.available &&
    credentialConfigured &&
    (profile.provider === "ollama" || networkAvailable);
  let verification: ModelRouteCandidate["verification"] = "not_checked";
  let connectionStatus: InspectedModelRouteProfile["connectionStatus"] = "not_checked";
  let selectedModelAvailable = true;
  if (canProbe) {
    try {
      const listed = await runtime.modelGateway.listModels({
        providerId: profile.providerId,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        authentication: profile.authentication,
      });
      connectionStatus = "verified";
      selectedModelAvailable = listed.models.some(({ id }) => id === modelId);
      verification = selectedModelAvailable ? "verified" : "unavailable";
    } catch {
      connectionStatus = "failed";
      selectedModelAvailable = false;
      verification = "unavailable";
    }
  }

  const capabilities: readonly ModelRouteRole[] =
    profile.provider === "ollama"
      ? [...TEXT_GENERATION_MODEL_ROLES, "local_private"]
      : TEXT_GENERATION_MODEL_ROLES;
  return Object.freeze({
    profile,
    candidate: Object.freeze({
      providerId: profile.providerId,
      modelId,
      location: profile.provider === "ollama" ? "local" : "remote",
      verification,
      capabilities: Object.freeze([...capabilities]),
    }),
    credentialConfigured,
    connectionStatus,
    selectedModelAvailable,
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

function measureMessageBytes(messages: readonly NativeModelMessage[]): number {
  return new TextEncoder().encode(messages.map(({ content }) => content).join("\n")).length;
}

async function persistGeneratedCandidate(
  runtime: DesktopRuntime,
  chapter: Chapter,
  generatedText: string,
  incomplete: boolean,
): Promise<Result<AiCandidate, AppError>> {
  const created = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
  });
  if (!created.ok) {
    return created;
  }
  const generated = generatedText.trim();
  const content =
    chapter.content.trim().length === 0
      ? generated
      : `${chapter.content.trimEnd()}\n\n${generated}`;
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    return checksum;
  }
  const ready = created.value.markReady(content, checksum.value, runtime.clock.now(), incomplete);
  if (!ready.ok) {
    return ready;
  }
  const persisted = await runtime.repositories.aiCandidates.create(ready.value);
  return persisted.ok ? ok(ready.value) : persisted;
}

function normalizeGovernedGenerationError(cause: unknown): GovernedGenerationError {
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
  outcome: "completed" | "failed" | "cancelled",
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
      requiresResolution: outcome === "failed",
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
        "Save a model profile with a selected model before generating.",
      ),
    );
  }
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
  const messages: readonly NativeModelMessage[] = [
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

  let generatedText: string;
  try {
    const generated = await runtime.modelGateway.generate({
      generationId: runtime.ids.next(),
      config: {
        providerId: profile.providerId,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        authentication: profile.authentication,
      },
      model: profile.selectedModel,
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
        : new ModelCenterError("MODEL_GENERATION_FAILED", "Native model generation failed.", true),
    );
  }

  const created = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
  });
  if (!created.ok) {
    return created;
  }
  const generated = generatedText.trim();
  const content =
    chapter.content.trim().length === 0
      ? generated
      : `${chapter.content.trimEnd()}\n\n${generated}`;
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

export async function createLocalDemoCandidate(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
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
  const created = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
  });
  if (!created.ok) {
    return created;
  }

  const demoParagraph = "【本地演示候选】暮色沿着窗棂缓慢下沉，人物在未说出口的决定前停了一瞬。";
  const content =
    chapter.content.trim().length === 0
      ? demoParagraph
      : `${chapter.content.trimEnd()}\n\n${demoParagraph}`;
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
    );
  }
  return new ModelCenterError(
    "MODEL_RUNTIME_FAILED",
    "Native model generation failed unexpectedly.",
    true,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
