import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import type { Clock } from "@inkshadow/domain";

import {
  MODEL_HUB_SCHEMES,
  getModelProviderPreset,
  isLoopbackModelBaseUrl,
  isModelHubCapability,
  isModelProviderKind,
  isNovelAiTask,
  normalizeCredentialHeaderName,
  normalizeModelHubApiPath,
  normalizeModelHubRequestTimeoutMs,
  normalizeModelHubRetryLimit,
  resolveProviderBaseUrl,
  type ModelHubAuthenticationMode,
  type ModelHubCapability,
  type ModelHubScheme,
  type ModelProviderKind,
  type ModelProviderProtocol,
  type NovelAiTask,
} from "./model-hub-provider-registry";

export type ModelHubConnectionStatus =
  "not_tested" | "checking" | "ready" | "degraded" | "error" | "disabled";
export type ModelHubCatalogSyncStatus = "never" | "syncing" | "succeeded" | "partial" | "failed";
export type ModelHubPrivacyPolicy = "cloud_allowed" | "local_preferred" | "local_only";

export const MODEL_FAILURE_STAGES = [
  "request_preparation",
  "dispatch",
  "transport",
  "http_response",
  "stream_parse",
  "response_normalization",
  "capability_commit",
  "invocation_commit",
  "unknown",
] as const;

export type ModelFailureStage = (typeof MODEL_FAILURE_STAGES)[number];

/**
 * Bounded provider-failure metadata. This contract intentionally has no field
 * capable of carrying prompts, messages, chapter text, credentials or model
 * output. `visibleContentLength` is a count only.
 */
export interface SafeModelFailureMetadata {
  readonly requestId: string | null;
  readonly stage: ModelFailureStage | null;
  readonly retryable: boolean | null;
  readonly httpStatus: number | null;
  readonly finishReason: string | null;
  readonly visibleContentLength: number | null;
  readonly reasoningPresent: boolean | null;
  readonly stream: boolean | null;
  readonly attempt: number | null;
  readonly requestedMaxOutputTokens: number | null;
}

export interface SafeAiFailureMetadata {
  readonly requestId?: string | null;
  readonly stage?: ModelFailureStage | null;
  readonly retryable?: boolean | null;
  readonly httpStatus?: number | null;
  readonly finishReason?: string | null;
  readonly visibleContentLength?: number | null;
  readonly reasoningPresent?: boolean | null;
  readonly stream?: boolean | null;
  readonly attempt?: number | null;
  readonly requestedMaxOutputTokens?: number | null;
}

/**
 * Bounded successful-generation observation. It deliberately stores only
 * counts and transport shape, never the generated text itself.
 */
export interface SafeModelCompletionMetadata {
  readonly visibleContentLength: number;
  readonly stream: boolean | null;
}

export interface SafeAiCompletionMetadata {
  readonly visibleContentLength: number;
  readonly stream?: boolean | null;
}

export interface RecentAiFailure {
  readonly diagnosticId: string;
  readonly timestamp: string;
  readonly providerKind: ModelProviderKind;
  readonly connectionId: string;
  readonly modelId: string;
  readonly taskType: NovelAiTask | "capability_probe";
  readonly stage: ModelFailureStage | null;
  readonly normalizedErrorCode: string;
  readonly retryable: boolean | null;
  readonly httpStatus: number | null;
  readonly finishReason: string | null;
  readonly visibleContentLength: number | null;
  readonly reasoningPresent: boolean | null;
  readonly stream: boolean | null;
  readonly attempt: number;
  readonly requestedMaxOutputTokens: number | null;
  readonly requestId: string | null;
}

const RETIRED_CONNECTION_ERROR_CODE = "MODEL_HUB_CONNECTION_RETIRED";
const RETIRED_CONNECTION_SUMMARY =
  "The connection was retired. Its credential reference was cleared while immutable invocation history was retained.";

export interface ModelProviderConnection {
  readonly id: string;
  readonly providerKind: ModelProviderKind;
  readonly displayName: string;
  readonly protocol: ModelProviderProtocol;
  readonly region: string | null;
  readonly workspaceId: string | null;
  readonly endpointId: string | null;
  readonly baseUrl: string;
  readonly credentialRef: string | null;
  readonly credentialState: "missing" | "present" | "unavailable";
  readonly authenticationMode: ModelHubAuthenticationMode;
  readonly credentialHeaderName: string | null;
  readonly modelDiscoveryPath: string | null;
  readonly textGenerationPath: string | null;
  readonly embeddingPath: string | null;
  readonly requestTimeoutMs: number;
  readonly retryLimit: number;
  readonly connectionStatus: ModelHubConnectionStatus;
  readonly catalogSyncStatus: ModelHubCatalogSyncStatus;
  readonly lastTestedAt: string | null;
  readonly lastCatalogSyncedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorSummary: string | null;
  readonly legacyProviderId: string | null;
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function isRetiredModelProviderConnection(connection: ModelProviderConnection): boolean {
  return (
    !connection.enabled &&
    connection.connectionStatus === "disabled" &&
    connection.credentialRef === null &&
    connection.credentialState === "missing" &&
    connection.lastErrorCode === RETIRED_CONNECTION_ERROR_CODE
  );
}

export interface SaveModelProviderConnectionInput {
  readonly id: string;
  readonly providerKind: ModelProviderKind;
  readonly displayName: string;
  readonly region?: string | null;
  readonly workspaceId?: string | null;
  readonly endpointId?: string | null;
  readonly baseUrlOverride?: string | null;
  readonly credentialRef?: string | null;
  readonly credentialState: "missing" | "present" | "unavailable";
  readonly authenticationMode?: ModelHubAuthenticationMode;
  readonly credentialHeaderName?: string | null;
  readonly modelDiscoveryPath?: string | null;
  readonly textGenerationPath?: string | null;
  readonly embeddingPath?: string | null;
  readonly requestTimeoutMs?: number;
  readonly retryLimit?: number;
  readonly legacyProviderId?: string | null;
  readonly enabled?: boolean;
  readonly expectedRevision: number | null;
}

export interface RecordConnectionTestInput {
  readonly connectionId: string;
  readonly status: "ready" | "degraded" | "error";
  readonly errorCode?: string | null;
  readonly errorSummary?: string | null;
  readonly expectedRevision: number;
}

export interface RetireModelProviderConnectionInput {
  readonly connectionId: string;
  readonly expectedRevision: number;
}

export interface DiscoveredModelInput {
  readonly id: string;
  readonly providerModelId: string;
  readonly displayName?: string | null;
  readonly ownedBy?: string | null;
  readonly lifecycle?: "unknown" | "stable" | "preview" | "deprecated";
  readonly inputTokenLimit?: number | null;
  readonly outputTokenLimit?: number | null;
  readonly staleAfter?: string | null;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly connectionId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly ownedBy: string | null;
  readonly catalogSource: "provider_api" | "official_preset" | "manual" | "legacy";
  readonly availability: "unknown" | "available" | "unavailable";
  readonly lifecycle: "unknown" | "stable" | "preview" | "deprecated";
  readonly inputTokenLimit: number | null;
  readonly outputTokenLimit: number | null;
  readonly firstDiscoveredAt: string;
  readonly lastSeenAt: string;
  readonly staleAfter: string | null;
  readonly lastSyncId: string | null;
  readonly revision: number;
}

export interface SyncModelCatalogInput {
  readonly syncId: string;
  readonly connectionId: string;
  readonly source: "provider_api" | "official_preset" | "manual" | "legacy";
  readonly status: "succeeded" | "partial" | "failed";
  readonly models: readonly DiscoveredModelInput[];
  readonly nextPageTokenPresent?: boolean;
  readonly errorCode?: string | null;
  readonly errorSummary?: string | null;
  readonly startedAt?: string | null;
}

export interface ModelHubConnectionCommit {
  readonly id: string;
  readonly connectionId: string;
  readonly phase: "prepared" | "cleanup_pending";
  readonly credentialProviderId: string | null;
  readonly cleanupCredentialProviderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PrepareModelHubConnectionCommitInput {
  readonly id: string;
  readonly connectionId: string;
  readonly credentialProviderId?: string | null;
}

export interface PublishModelHubConnectionCommitInput {
  readonly id: string;
  readonly connection: SaveModelProviderConnectionInput;
  readonly catalog: SyncModelCatalogInput;
  readonly credentialProviderId?: string | null;
  readonly cleanupCredentialProviderId?: string | null;
}

export interface PublishModelHubConnectionCommitResult {
  readonly connection: ModelProviderConnection;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly commit: ModelHubConnectionCommit | null;
}

export interface PublishModelHubCredentialCommitInput {
  readonly id: string;
  readonly connection: SaveModelProviderConnectionInput;
  readonly credentialProviderId?: string | null;
  readonly cleanupCredentialProviderId?: string | null;
}

export interface PublishModelHubCredentialCommitResult {
  readonly connection: ModelProviderConnection;
  readonly commit: ModelHubConnectionCommit | null;
}

export interface ModelCatalogSync {
  readonly id: string;
  readonly connectionId: string;
  readonly source: "provider_api" | "official_preset" | "manual" | "legacy";
  readonly status: "running" | "succeeded" | "partial" | "failed" | "cancelled";
  readonly discoveredModelCount: number;
  readonly nextPageTokenPresent: boolean;
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface ModelCapabilityEvidence {
  readonly id: string;
  readonly catalogEntryId: string;
  readonly scanId: string | null;
  readonly capability: ModelHubCapability;
  readonly verdict: "supported" | "unsupported" | "unknown";
  readonly evidenceSource:
    "provider_metadata" | "official_preset" | "lightweight_probe" | "user_confirmed" | "legacy";
  readonly evidenceVersion: string;
  readonly evidenceSummary: string | null;
  readonly observedAt: string;
  readonly expiresAt: string | null;
}

export interface CapabilityEvidenceInput {
  readonly id: string;
  readonly capability: ModelHubCapability;
  readonly verdict: "supported" | "unsupported" | "unknown";
  readonly evidenceSource: ModelCapabilityEvidence["evidenceSource"];
  readonly evidenceSummary?: string | null;
  readonly expiresAt?: string | null;
}

export interface RecordCapabilityScanInput {
  readonly scanId: string;
  readonly catalogEntryId: string;
  readonly scanKind: "provider_metadata" | "official_preset" | "lightweight_probe" | "user_review";
  readonly status: "succeeded" | "partial" | "failed";
  readonly evidenceVersion: string;
  readonly evidence?: readonly CapabilityEvidenceInput[];
  readonly errorCode?: string | null;
  readonly errorSummary?: string | null;
  readonly requestedAt?: string | null;
  readonly failure?: SafeAiFailureMetadata | null;
}

export interface CommitCapabilityProbeResultInput {
  readonly connectionId: string;
  readonly expectedConnectionRevision: number;
  readonly catalogEntryId: string;
  readonly expectedCatalogRevision: number;
  readonly expectedProviderModelId: string;
  readonly scan: RecordCapabilityScanInput;
  readonly connectionTest?: Omit<
    RecordConnectionTestInput,
    "connectionId" | "expectedRevision"
  > | null;
}

export interface CapabilityProbeCommitResult {
  readonly connection: ModelProviderConnection;
  readonly evidence: readonly ModelCapabilityEvidence[];
}

export interface ModelHubPreset {
  readonly id: string;
  readonly scheme: ModelHubScheme;
  readonly displayName: string;
  readonly status: "draft" | "active" | "superseded";
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly costPriority: "quality_first" | "balanced" | "cost_first";
  readonly routeGenerationVersion: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelCostPrivacyProfile {
  readonly catalogEntryId: string;
  readonly currency: string | null;
  readonly inputMicrosPerMillionTokens: string | null;
  readonly outputMicrosPerMillionTokens: string | null;
  readonly cachedInputMicrosPerMillionTokens: string | null;
  readonly pricingVersion: string | null;
  readonly priceUpdatedAt: string | null;
  readonly dataDestination: "local" | "remote" | "unknown";
  readonly retentionPolicy: "none" | "temporary" | "provider_default" | "unknown";
  readonly trainingPolicy: "not_used" | "opt_out" | "may_be_used" | "provider_default" | "unknown";
  readonly evidenceSource:
    | "provider_metadata"
    | "official_preset"
    | "provider_policy"
    | "user_confirmed"
    | "legacy"
    | "unknown";
  readonly evidenceVersion: string | null;
  readonly evidenceSummary: string | null;
  readonly evidenceUpdatedAt: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveModelCostPrivacyProfileInput {
  readonly catalogEntryId: string;
  readonly currency?: string | null;
  readonly inputMicrosPerMillionTokens?: string | null;
  readonly outputMicrosPerMillionTokens?: string | null;
  readonly cachedInputMicrosPerMillionTokens?: string | null;
  readonly pricingVersion?: string | null;
  readonly priceUpdatedAt?: string | null;
  readonly dataDestination: ModelCostPrivacyProfile["dataDestination"];
  readonly retentionPolicy: ModelCostPrivacyProfile["retentionPolicy"];
  readonly trainingPolicy: ModelCostPrivacyProfile["trainingPolicy"];
  readonly evidenceSource: ModelCostPrivacyProfile["evidenceSource"];
  readonly evidenceVersion?: string | null;
  readonly evidenceSummary?: string | null;
  readonly expectedRevision: number | null;
}

export interface ModelEvaluationResult {
  readonly id: string;
  readonly catalogEntryId: string;
  readonly task: NovelAiTask;
  readonly scoreBasisPoints: number;
  readonly latencyP50Ms: number;
  readonly sampleCount: number;
  readonly evaluationSource:
    "official_benchmark" | "local_evaluation" | "user_feedback" | "imported" | "legacy";
  readonly evaluationVersion: string;
  readonly observedAt: string;
  readonly expiresAt: string | null;
}

export interface RecordModelEvaluationResultInput {
  readonly id: string;
  readonly catalogEntryId: string;
  readonly task: NovelAiTask;
  readonly scoreBasisPoints: number;
  readonly latencyP50Ms: number;
  readonly sampleCount: number;
  readonly evaluationSource: ModelEvaluationResult["evaluationSource"];
  readonly evaluationVersion: string;
  readonly observedAt?: string | null;
  readonly expiresAt?: string | null;
}

export interface SaveModelHubPresetInput {
  readonly id: string;
  readonly scheme: ModelHubScheme;
  readonly displayName: string;
  readonly status: "draft" | "active" | "superseded";
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly costPriority: "quality_first" | "balanced" | "cost_first";
  readonly routeGenerationVersion: string;
  readonly expectedRevision: number | null;
}

export interface NovelTaskRoute {
  readonly task: NovelAiTask;
  readonly primaryCatalogEntryId: string;
  readonly fallbackCatalogEntryId: string | null;
  readonly presetId: string | null;
  readonly parameterPolicy: Readonly<Record<string, unknown>>;
  readonly maximumCostMicros: string | null;
  readonly currency: string | null;
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly failurePolicy: "use_fallback" | "ask_user" | "stop";
  readonly routeOrigin: "automatic" | "user" | "legacy";
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveNovelTaskRouteInput {
  readonly task: NovelAiTask;
  readonly primaryCatalogEntryId: string;
  readonly fallbackCatalogEntryId?: string | null;
  readonly presetId?: string | null;
  readonly parameterPolicy?: Readonly<Record<string, unknown>>;
  readonly maximumCostMicros?: string | null;
  readonly currency?: string | null;
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly failurePolicy: "use_fallback" | "ask_user" | "stop";
  readonly routeOrigin: "automatic" | "user" | "legacy";
  readonly enabled?: boolean;
  readonly expectedRevision: number | null;
}

export interface AutomaticNovelTaskRouteInput {
  readonly task: NovelAiTask;
  readonly primaryCatalogEntryId: string;
  readonly fallbackCatalogEntryId?: string | null;
  readonly parameterPolicy?: Readonly<Record<string, unknown>>;
  readonly maximumCostMicros?: string | null;
  readonly currency?: string | null;
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly failurePolicy: "use_fallback" | "ask_user" | "stop";
  readonly enabled?: boolean;
}

export interface ApplyAutomaticModelHubRoutingPlanInput {
  readonly preset: Omit<SaveModelHubPresetInput, "expectedRevision">;
  readonly routes: readonly AutomaticNovelTaskRouteInput[];
}

export interface AppliedAutomaticModelHubRoutingPlan {
  readonly preset: ModelHubPreset;
  readonly routes: readonly NovelTaskRoute[];
  readonly changed: boolean;
  readonly preservedUserRouteCount: number;
}

export interface ModelInvocationFact {
  readonly id: string;
  readonly task: NovelAiTask;
  readonly routeTask: NovelAiTask | null;
  readonly connectionId: string;
  readonly catalogEntryId: string | null;
  readonly providerKindSnapshot: string;
  readonly modelIdSnapshot: string;
  readonly routeReason: "task_primary" | "task_fallback" | "user_override" | "legacy";
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly attempt: number;
  readonly fallbackFromInvocationId: string | null;
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly dataDestination: "local" | "remote";
  readonly maximumCostMicros: string | null;
  readonly currency: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly estimatedCostMicros: string | null;
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
  readonly completion?: SafeModelCompletionMetadata | null;
  readonly failure?: SafeModelFailureMetadata | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly revision: number;
}

export interface StartModelInvocationInput {
  readonly id: string;
  readonly task: NovelAiTask;
  readonly routeTask?: NovelAiTask | null;
  readonly connectionId: string;
  readonly catalogEntryId?: string | null;
  readonly providerKindSnapshot: ModelProviderKind;
  readonly modelIdSnapshot: string;
  readonly routeReason: "task_primary" | "task_fallback" | "user_override" | "legacy";
  readonly attempt: number;
  readonly fallbackFromInvocationId?: string | null;
  readonly privacyPolicy: ModelHubPrivacyPolicy;
  readonly dataDestination: "local" | "remote";
  readonly maximumCostMicros?: string | null;
  readonly currency?: string | null;
}

export interface FinishModelInvocationInput {
  readonly id: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly estimatedCostMicros?: string | null;
  readonly currency?: string | null;
  readonly errorCode?: string | null;
  readonly errorSummary?: string | null;
  readonly completion?: SafeAiCompletionMetadata | null;
  readonly failure?: SafeAiFailureMetadata | null;
  readonly expectedRevision: number;
}

export interface ModelHubStore {
  listConnections(): Promise<readonly ModelProviderConnection[]>;
  findConnection(id: string): Promise<ModelProviderConnection | null>;
  saveConnection(input: SaveModelProviderConnectionInput): Promise<ModelProviderConnection>;
  retireConnection(input: RetireModelProviderConnectionInput): Promise<ModelProviderConnection>;
  recordConnectionTest(input: RecordConnectionTestInput): Promise<ModelProviderConnection>;
  listCatalog(connectionId: string): Promise<readonly ModelCatalogEntry[]>;
  listCatalogSyncs(connectionId: string): Promise<readonly ModelCatalogSync[]>;
  syncCatalog(input: SyncModelCatalogInput): Promise<readonly ModelCatalogEntry[]>;
  listConnectionCommits(): Promise<readonly ModelHubConnectionCommit[]>;
  findConnectionCommit(connectionId: string): Promise<ModelHubConnectionCommit | null>;
  prepareConnectionCommit(
    input: PrepareModelHubConnectionCommitInput,
  ): Promise<ModelHubConnectionCommit>;
  publishConnectionCommit(
    input: PublishModelHubConnectionCommitInput,
  ): Promise<PublishModelHubConnectionCommitResult>;
  publishCredentialCommit(
    input: PublishModelHubCredentialCommitInput,
  ): Promise<PublishModelHubCredentialCommitResult>;
  finishConnectionCommit(connectionId: string, id: string): Promise<void>;
  listCapabilityEvidence(catalogEntryId: string): Promise<readonly ModelCapabilityEvidence[]>;
  recordCapabilityScan(
    input: RecordCapabilityScanInput,
  ): Promise<readonly ModelCapabilityEvidence[]>;
  commitCapabilityProbeResult(
    input: CommitCapabilityProbeResultInput,
  ): Promise<CapabilityProbeCommitResult>;
  findCostPrivacyProfile(catalogEntryId: string): Promise<ModelCostPrivacyProfile | null>;
  saveCostPrivacyProfile(input: SaveModelCostPrivacyProfileInput): Promise<ModelCostPrivacyProfile>;
  listEvaluationResults(
    catalogEntryId: string,
    task?: NovelAiTask,
  ): Promise<readonly ModelEvaluationResult[]>;
  recordEvaluationResult(input: RecordModelEvaluationResultInput): Promise<ModelEvaluationResult>;
  listPresets(): Promise<readonly ModelHubPreset[]>;
  findActivePreset(): Promise<ModelHubPreset | null>;
  savePreset(input: SaveModelHubPresetInput): Promise<ModelHubPreset>;
  findTaskRoute(task: NovelAiTask): Promise<NovelTaskRoute | null>;
  saveTaskRoute(input: SaveNovelTaskRouteInput): Promise<NovelTaskRoute>;
  deleteTaskRoute(task: NovelAiTask, expectedRevision: number): Promise<void>;
  applyAutomaticRoutingPlan(
    input: ApplyAutomaticModelHubRoutingPlanInput,
  ): Promise<AppliedAutomaticModelHubRoutingPlan>;
  listRecentAiFailures(limit?: number): Promise<readonly RecentAiFailure[]>;
  findInvocation(id: string): Promise<ModelInvocationFact | null>;
  startInvocation(input: StartModelInvocationInput): Promise<ModelInvocationFact>;
  finishInvocation(input: FinishModelInvocationInput): Promise<ModelInvocationFact>;
}

interface ConnectionRow {
  id: string;
  provider_kind: string;
  display_name: string;
  protocol: string;
  region: string | null;
  workspace_id: string | null;
  endpoint_id: string | null;
  base_url: string;
  credential_ref: string | null;
  credential_state: string;
  authentication_mode: string;
  credential_header_name: string | null;
  model_discovery_path: string | null;
  text_generation_path: string | null;
  embedding_path: string | null;
  request_timeout_ms: number;
  retry_limit: number;
  connection_status: string;
  catalog_sync_status: string;
  last_tested_at: string | null;
  last_catalog_synced_at: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  legacy_provider_id: string | null;
  enabled: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ConnectionCommitRow {
  id: string;
  connection_id: string;
  phase: string;
  credential_provider_id: string | null;
  cleanup_credential_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CatalogRow {
  id: string;
  connection_id: string;
  provider_model_id: string;
  display_name: string;
  owned_by: string | null;
  catalog_source: string;
  availability: string;
  lifecycle: string;
  input_token_limit: number | null;
  output_token_limit: number | null;
  first_discovered_at: string;
  last_seen_at: string;
  stale_after: string | null;
  last_sync_id: string | null;
  revision: number;
}

interface CatalogSyncRow {
  id: string;
  connection_id: string;
  source: string;
  status: string;
  discovered_model_count: number;
  next_page_token_present: number;
  error_code: string | null;
  error_summary: string | null;
  started_at: string;
  completed_at: string | null;
}

interface CapabilityEvidenceRow {
  id: string;
  catalog_entry_id: string;
  scan_id: string | null;
  capability: string;
  verdict: string;
  evidence_source: string;
  evidence_version: string;
  evidence_summary: string | null;
  observed_at: string;
  expires_at: string | null;
}

interface ModelCapabilityScanFact {
  readonly id: string;
  readonly catalogEntryId: string;
  readonly scanKind: RecordCapabilityScanInput["scanKind"];
  readonly status: RecordCapabilityScanInput["status"];
  readonly errorCode: string | null;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly failure: SafeModelFailureMetadata | null;
}

interface RecentAiFailureRow {
  diagnostic_id: string;
  timestamp: string;
  provider_kind: string;
  connection_id: string;
  model_id: string;
  task_type: string;
  failure_stage: string | null;
  normalized_error_code: string;
  failure_retryable: number | null;
  http_status: number | null;
  finish_reason: string | null;
  visible_content_length: number | null;
  reasoning_present: number | null;
  streamed: number | null;
  attempt: number;
  requested_max_output_tokens: number | null;
  diagnostic_request_id: string | null;
}

interface CostPrivacyProfileRow {
  catalog_entry_id: string;
  currency: string | null;
  input_micros_per_million_tokens: string | null;
  output_micros_per_million_tokens: string | null;
  cached_input_micros_per_million_tokens: string | null;
  pricing_version: string | null;
  price_updated_at: string | null;
  data_destination: string;
  retention_policy: string;
  training_policy: string;
  evidence_source: string;
  evidence_version: string | null;
  evidence_summary: string | null;
  evidence_updated_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface EvaluationResultRow {
  id: string;
  catalog_entry_id: string;
  task: string;
  score_basis_points: number;
  latency_p50_ms: number;
  sample_count: number;
  evaluation_source: string;
  evaluation_version: string;
  observed_at: string;
  expires_at: string | null;
}

interface PresetRow {
  id: string;
  scheme: string;
  display_name: string;
  status: string;
  privacy_policy: string;
  cost_priority: string;
  route_generation_version: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RouteRow {
  task: string;
  primary_catalog_entry_id: string;
  fallback_catalog_entry_id: string | null;
  preset_id: string | null;
  parameter_policy_json: string;
  maximum_cost_micros: string | null;
  currency: string | null;
  privacy_policy: string;
  failure_policy: string;
  route_origin: string;
  enabled: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface InvocationRow {
  id: string;
  task: string;
  route_task: string | null;
  connection_id: string;
  catalog_entry_id: string | null;
  provider_kind_snapshot: string;
  model_id_snapshot: string;
  route_reason: string;
  status: string;
  attempt: number;
  fallback_from_invocation_id: string | null;
  privacy_policy: string;
  data_destination: string;
  maximum_cost_micros: string | null;
  currency: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  estimated_cost_micros: string | null;
  error_code: string | null;
  error_summary: string | null;
  diagnostic_request_id: string | null;
  failure_stage: string | null;
  failure_retryable: number | null;
  http_status: number | null;
  finish_reason: string | null;
  visible_content_length: number | null;
  reasoning_present: number | null;
  streamed: number | null;
  requested_max_output_tokens: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  revision: number;
}

export class TauriModelHubStore implements ModelHubStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async listConnections(): Promise<readonly ModelProviderConnection[]> {
    const rows = await this.executor.select<ConnectionRow>(
      `${CONNECTION_SELECT} ORDER BY enabled DESC, updated_at DESC, id ASC`,
    );
    return Object.freeze(rows.map(hydrateConnection));
  }

  public async findConnection(idValue: string): Promise<ModelProviderConnection | null> {
    const id = boundedText(idValue, "connection id", 128);
    const rows = await this.executor.select<ConnectionRow>(`${CONNECTION_SELECT} WHERE id = ?`, [
      id,
    ]);
    return rows[0] === undefined ? null : hydrateConnection(rows[0]);
  }

  public async saveConnection(
    input: SaveModelProviderConnectionInput,
  ): Promise<ModelProviderConnection> {
    const validated = validateConnectionInput(input);
    return this.executor.transaction((transaction) =>
      persistSqliteConnection(transaction, validated, this.clock.now()),
    );
  }

  public async retireConnection(
    input: RetireModelProviderConnectionInput,
  ): Promise<ModelProviderConnection> {
    const connectionId = boundedText(input.connectionId, "connection id", 128);
    const expectedRevision = validateRequiredRevision(input.expectedRevision);
    return this.executor.transaction(async (transaction) => {
      const existing = await findConnectionRow(transaction, connectionId);
      if (existing === null) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_NOT_FOUND",
          "The provider connection does not exist.",
        );
      }
      if (isRetiredConnectionRow(existing)) {
        return hydrateConnection(existing);
      }
      if (existing.revision !== expectedRevision) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      const now = this.clock.now();
      const result = await transaction.execute(
        `UPDATE model_provider_connections
         SET credential_ref = NULL, credential_state = 'missing',
             authentication_mode = CASE
               WHEN provider_kind = 'custom_openai_compatible' THEN 'none'
               ELSE authentication_mode
             END,
             credential_header_name = CASE
               WHEN provider_kind = 'custom_openai_compatible' THEN NULL
               ELSE credential_header_name
             END,
             enabled = 0, connection_status = 'disabled',
             last_error_code = ?, last_error_summary = ?,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [
          RETIRED_CONNECTION_ERROR_CODE,
          RETIRED_CONNECTION_SUMMARY,
          now,
          connectionId,
          expectedRevision,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      const retired = await findConnectionRow(transaction, connectionId);
      if (retired === null) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_WRITE_FAILED",
          "The retired connection was not persisted.",
        );
      }
      return hydrateConnection(retired);
    });
  }

  public async recordConnectionTest(
    input: RecordConnectionTestInput,
  ): Promise<ModelProviderConnection> {
    const validated = validateConnectionTestInput(input);
    const now = this.clock.now();
    const result = await this.executor.execute(
      `UPDATE model_provider_connections
       SET connection_status = ?, last_tested_at = ?, last_error_code = ?,
           last_error_summary = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [
        validated.status,
        now,
        validated.errorCode,
        validated.errorSummary,
        now,
        validated.connectionId,
        validated.expectedRevision,
      ],
    );
    if (result.rowsAffected !== 1) {
      throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
    }
    const saved = await this.findConnection(validated.connectionId);
    if (saved === null) {
      throw modelHubError(
        "MODEL_HUB_CONNECTION_NOT_FOUND",
        "The provider connection does not exist.",
      );
    }
    return saved;
  }

  public async listCatalog(connectionIdValue: string): Promise<readonly ModelCatalogEntry[]> {
    const connectionId = boundedText(connectionIdValue, "connection id", 128);
    const rows = await this.executor.select<CatalogRow>(
      `${CATALOG_SELECT}
       WHERE connection_id = ?
       ORDER BY availability = 'available' DESC, display_name COLLATE NOCASE, provider_model_id`,
      [connectionId],
    );
    return Object.freeze(rows.map(hydrateCatalog));
  }

  public async listCatalogSyncs(connectionIdValue: string): Promise<readonly ModelCatalogSync[]> {
    const connectionId = boundedText(connectionIdValue, "connection id", 128);
    const rows = await this.executor.select<CatalogSyncRow>(
      `${CATALOG_SYNC_SELECT}
       WHERE connection_id = ?
       ORDER BY started_at DESC, id ASC`,
      [connectionId],
    );
    return Object.freeze(rows.map(hydrateCatalogSync));
  }

  public async syncCatalog(input: SyncModelCatalogInput): Promise<readonly ModelCatalogEntry[]> {
    const validated = validateCatalogInput(input);
    await this.executor.transaction((transaction) =>
      persistSqliteCatalogSync(transaction, validated, this.clock.now()),
    );
    return this.listCatalog(validated.connectionId);
  }

  public async findConnectionCommit(
    connectionIdValue: string,
  ): Promise<ModelHubConnectionCommit | null> {
    const connectionId = boundedText(connectionIdValue, "connection commit connection id", 128);
    const rows = await this.executor.select<ConnectionCommitRow>(
      `SELECT id, connection_id, phase, credential_provider_id,
              cleanup_credential_provider_id, created_at, updated_at
       FROM model_hub_connection_commits
       WHERE connection_id = ?`,
      [connectionId],
    );
    return rows[0] === undefined ? null : hydrateConnectionCommit(rows[0]);
  }

  public async listConnectionCommits(): Promise<readonly ModelHubConnectionCommit[]> {
    const rows = await this.executor.select<ConnectionCommitRow>(
      `SELECT id, connection_id, phase, credential_provider_id,
              cleanup_credential_provider_id, created_at, updated_at
       FROM model_hub_connection_commits
       ORDER BY updated_at ASC, id ASC`,
    );
    return Object.freeze(rows.map(hydrateConnectionCommit));
  }

  public async prepareConnectionCommit(
    input: PrepareModelHubConnectionCommitInput,
  ): Promise<ModelHubConnectionCommit> {
    const validated = validatePrepareConnectionCommitInput(input);
    const now = this.clock.now();
    await this.executor.execute(
      `INSERT INTO model_hub_connection_commits (
         id, connection_id, phase, credential_provider_id,
         cleanup_credential_provider_id, created_at, updated_at
       ) VALUES (?, ?, 'prepared', ?, NULL, ?, ?)`,
      [validated.id, validated.connectionId, validated.credentialProviderId, now, now],
    );
    const saved = await this.findConnectionCommit(validated.connectionId);
    if (saved?.id !== validated.id) {
      throw modelHubError(
        "MODEL_HUB_CONNECTION_COMMIT_WRITE_FAILED",
        "The connection commit journal was not persisted.",
      );
    }
    return saved;
  }

  public async publishConnectionCommit(
    input: PublishModelHubConnectionCommitInput,
  ): Promise<PublishModelHubConnectionCommitResult> {
    const validated = validatePublishConnectionCommitInput(input);
    return this.executor.transaction(async (transaction) => {
      const journal = await findConnectionCommitRow(transaction, validated.connection.id);
      if (
        journal?.id !== validated.id ||
        journal.phase !== "prepared" ||
        journal.credential_provider_id !== validated.credentialProviderId
      ) {
        throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
      }
      const now = this.clock.now();
      const saved = await persistSqliteConnection(transaction, validated.connection, now);
      const testedResult = await transaction.execute(
        `UPDATE model_provider_connections
         SET connection_status = 'ready', last_tested_at = ?,
             last_error_code = NULL, last_error_summary = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [now, now, saved.id, saved.revision],
      );
      if (testedResult.rowsAffected !== 1) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      await persistSqliteCatalogSync(transaction, validated.catalog, now);
      const currentRow = await findConnectionRow(transaction, saved.id);
      if (currentRow === null) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_WRITE_FAILED",
          "The verified connection was not persisted.",
        );
      }
      const catalogRows = await transaction.select<CatalogRow>(
        `${CATALOG_SELECT}
         WHERE connection_id = ?
         ORDER BY availability = 'available' DESC, display_name COLLATE NOCASE,
                  provider_model_id`,
        [saved.id],
      );
      const currentCatalog = Object.freeze(catalogRows.map(hydrateCatalog));
      if (
        !currentCatalog.some(
          ({ availability, lastSyncId }) =>
            availability === "available" && lastSyncId === validated.catalog.syncId,
        )
      ) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_COMMIT_CATALOG_EMPTY",
          "A verified connection cannot be published without an available catalog entry.",
        );
      }
      let commit: ModelHubConnectionCommit | null = null;
      if (validated.cleanupCredentialProviderId === null) {
        await transaction.execute(
          "DELETE FROM model_hub_connection_commits WHERE id = ? AND connection_id = ?",
          [validated.id, saved.id],
        );
      } else {
        await transaction.execute(
          `UPDATE model_hub_connection_commits
           SET phase = 'cleanup_pending', cleanup_credential_provider_id = ?, updated_at = ?
           WHERE id = ? AND connection_id = ? AND phase = 'prepared'`,
          [validated.cleanupCredentialProviderId, now, validated.id, saved.id],
        );
        commit = Object.freeze({
          id: validated.id,
          connectionId: saved.id,
          phase: "cleanup_pending",
          credentialProviderId: validated.credentialProviderId,
          cleanupCredentialProviderId: validated.cleanupCredentialProviderId,
          createdAt: journal.created_at,
          updatedAt: now,
        });
      }
      return Object.freeze({
        connection: hydrateConnection(currentRow),
        catalog: currentCatalog,
        commit,
      });
    });
  }

  public async publishCredentialCommit(
    input: PublishModelHubCredentialCommitInput,
  ): Promise<PublishModelHubCredentialCommitResult> {
    const validated = validatePublishCredentialCommitInput(input);
    return this.executor.transaction(async (transaction) => {
      const journal = await findConnectionCommitRow(transaction, validated.connection.id);
      if (
        journal?.id !== validated.id ||
        journal.phase !== "prepared" ||
        journal.credential_provider_id !== validated.credentialProviderId
      ) {
        throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
      }
      const now = this.clock.now();
      const saved = await persistSqliteConnection(transaction, validated.connection, now);
      const status = saved.enabled ? "not_tested" : "disabled";
      const statusResult = await transaction.execute(
        `UPDATE model_provider_connections
         SET connection_status = ?, last_tested_at = NULL,
             last_error_code = NULL, last_error_summary = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [status, now, saved.id, saved.revision],
      );
      if (statusResult.rowsAffected !== 1) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      const currentRow = await findConnectionRow(transaction, saved.id);
      if (currentRow === null) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_WRITE_FAILED",
          "The credential connection update was not persisted.",
        );
      }
      let commit: ModelHubConnectionCommit | null = null;
      if (validated.cleanupCredentialProviderId === null) {
        await transaction.execute(
          "DELETE FROM model_hub_connection_commits WHERE id = ? AND connection_id = ?",
          [validated.id, saved.id],
        );
      } else {
        await transaction.execute(
          `UPDATE model_hub_connection_commits
           SET phase = 'cleanup_pending', cleanup_credential_provider_id = ?, updated_at = ?
           WHERE id = ? AND connection_id = ? AND phase = 'prepared'`,
          [validated.cleanupCredentialProviderId, now, validated.id, saved.id],
        );
        commit = Object.freeze({
          id: validated.id,
          connectionId: saved.id,
          phase: "cleanup_pending",
          credentialProviderId: validated.credentialProviderId,
          cleanupCredentialProviderId: validated.cleanupCredentialProviderId,
          createdAt: journal.created_at,
          updatedAt: now,
        });
      }
      return Object.freeze({ connection: hydrateConnection(currentRow), commit });
    });
  }

  public async finishConnectionCommit(connectionIdValue: string, idValue: string): Promise<void> {
    const connectionId = boundedText(connectionIdValue, "connection commit connection id", 128);
    const id = boundedText(idValue, "connection commit id", 128);
    const result = await this.executor.execute(
      "DELETE FROM model_hub_connection_commits WHERE connection_id = ? AND id = ?",
      [connectionId, id],
    );
    if (result.rowsAffected === 0) {
      const current = await this.findConnectionCommit(connectionId);
      if (current !== null) throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
    }
  }

  public async listCapabilityEvidence(
    catalogEntryIdValue: string,
  ): Promise<readonly ModelCapabilityEvidence[]> {
    const catalogEntryId = boundedText(catalogEntryIdValue, "catalog entry id", 128);
    const rows = await this.executor.select<CapabilityEvidenceRow>(
      `${CAPABILITY_EVIDENCE_SELECT}
       WHERE catalog_entry_id = ?
       ORDER BY capability, observed_at DESC, id ASC`,
      [catalogEntryId],
    );
    return Object.freeze(rows.map(hydrateCapabilityEvidence));
  }

  public async recordCapabilityScan(
    input: RecordCapabilityScanInput,
  ): Promise<readonly ModelCapabilityEvidence[]> {
    const validated = validateCapabilityScanInput(input);
    await this.executor.transaction(async (transaction) => {
      await ensureCatalogEntryExists(transaction, validated.catalogEntryId);
      await persistSqliteCapabilityScan(transaction, validated, this.clock.now());
    });
    return this.listCapabilityEvidence(validated.catalogEntryId);
  }

  public async commitCapabilityProbeResult(
    input: CommitCapabilityProbeResultInput,
  ): Promise<CapabilityProbeCommitResult> {
    const validated = validateCapabilityProbeCommitInput(input);
    return this.executor.transaction(async (transaction) => {
      const connectionGuard = await transaction.execute(
        `UPDATE model_provider_connections
         SET revision = revision
         WHERE id = ? AND revision = ? AND enabled = 1
           AND (
             authentication_mode = 'none'
             OR (credential_state = 'present' AND credential_ref IS NOT NULL)
           )`,
        [validated.connectionId, validated.expectedConnectionRevision],
      );
      if (connectionGuard.rowsAffected !== 1) {
        throw conflict("MODEL_HUB_PROBE_TARGET_CONFLICT");
      }
      const catalogGuard = await transaction.execute(
        `UPDATE model_catalog_entries
         SET revision = revision
         WHERE id = ? AND connection_id = ? AND revision = ?
           AND provider_model_id = ? AND availability = 'available'`,
        [
          validated.catalogEntryId,
          validated.connectionId,
          validated.expectedCatalogRevision,
          validated.expectedProviderModelId,
        ],
      );
      if (catalogGuard.rowsAffected !== 1) {
        throw conflict("MODEL_HUB_PROBE_TARGET_CONFLICT");
      }
      const now = this.clock.now();
      if (validated.connectionTest !== null) {
        const tested = await transaction.execute(
          `UPDATE model_provider_connections
           SET connection_status = ?, last_tested_at = ?, last_error_code = ?,
               last_error_summary = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
          [
            validated.connectionTest.status,
            now,
            validated.connectionTest.errorCode,
            validated.connectionTest.errorSummary,
            now,
            validated.connectionId,
            validated.expectedConnectionRevision,
          ],
        );
        if (tested.rowsAffected !== 1) {
          throw conflict("MODEL_HUB_PROBE_TARGET_CONFLICT");
        }
      }
      await persistSqliteCapabilityScan(transaction, validated.scan, now);
      const connection = await findConnectionRow(transaction, validated.connectionId);
      if (connection === null) {
        throw conflict("MODEL_HUB_PROBE_TARGET_CONFLICT");
      }
      const evidenceRows = await transaction.select<CapabilityEvidenceRow>(
        `${CAPABILITY_EVIDENCE_SELECT}
         WHERE catalog_entry_id = ?
         ORDER BY capability, observed_at DESC, id ASC`,
        [validated.catalogEntryId],
      );
      return Object.freeze({
        connection: hydrateConnection(connection),
        evidence: Object.freeze(evidenceRows.map(hydrateCapabilityEvidence)),
      });
    });
  }

  public async findCostPrivacyProfile(
    catalogEntryIdValue: string,
  ): Promise<ModelCostPrivacyProfile | null> {
    const catalogEntryId = boundedText(catalogEntryIdValue, "catalog entry id", 128);
    const rows = await this.executor.select<CostPrivacyProfileRow>(
      `${COST_PRIVACY_PROFILE_SELECT} WHERE catalog_entry_id = ?`,
      [catalogEntryId],
    );
    return rows[0] === undefined ? null : hydrateCostPrivacyProfile(rows[0]);
  }

  public async saveCostPrivacyProfile(
    input: SaveModelCostPrivacyProfileInput,
  ): Promise<ModelCostPrivacyProfile> {
    const validated = validateCostPrivacyProfileInput(input);
    return this.executor.transaction(async (transaction) => {
      await ensureCatalogEntryExists(transaction, validated.catalogEntryId);
      const rows = await transaction.select<CostPrivacyProfileRow>(
        `${COST_PRIVACY_PROFILE_SELECT} WHERE catalog_entry_id = ?`,
        [validated.catalogEntryId],
      );
      const existing = rows[0];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_COST_PRIVACY_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
      ) {
        throw conflict("MODEL_HUB_COST_PRIVACY_CONFLICT");
      }
      const now = this.clock.now();
      if (existing === undefined) {
        await transaction.execute(
          `INSERT INTO model_cost_privacy_profiles (
             catalog_entry_id, currency, input_micros_per_million_tokens,
             output_micros_per_million_tokens, cached_input_micros_per_million_tokens,
             pricing_version, price_updated_at, data_destination, retention_policy,
             training_policy, evidence_source, evidence_version, evidence_summary,
             evidence_updated_at, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            validated.catalogEntryId,
            validated.currency,
            validated.inputMicrosPerMillionTokens,
            validated.outputMicrosPerMillionTokens,
            validated.cachedInputMicrosPerMillionTokens,
            validated.pricingVersion,
            validated.priceUpdatedAt,
            validated.dataDestination,
            validated.retentionPolicy,
            validated.trainingPolicy,
            validated.evidenceSource,
            validated.evidenceVersion,
            validated.evidenceSummary,
            now,
            now,
            now,
          ],
        );
      } else {
        const result = await transaction.execute(
          `UPDATE model_cost_privacy_profiles
           SET currency = ?, input_micros_per_million_tokens = ?,
               output_micros_per_million_tokens = ?,
               cached_input_micros_per_million_tokens = ?, pricing_version = ?,
               price_updated_at = ?, data_destination = ?, retention_policy = ?,
               training_policy = ?, evidence_source = ?, evidence_version = ?,
               evidence_summary = ?, evidence_updated_at = ?, revision = revision + 1,
               updated_at = ?
           WHERE catalog_entry_id = ? AND revision = ?`,
          [
            validated.currency,
            validated.inputMicrosPerMillionTokens,
            validated.outputMicrosPerMillionTokens,
            validated.cachedInputMicrosPerMillionTokens,
            validated.pricingVersion,
            validated.priceUpdatedAt,
            validated.dataDestination,
            validated.retentionPolicy,
            validated.trainingPolicy,
            validated.evidenceSource,
            validated.evidenceVersion,
            validated.evidenceSummary,
            now,
            now,
            validated.catalogEntryId,
            existing.revision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw conflict("MODEL_HUB_COST_PRIVACY_CONFLICT");
        }
      }
      const saved = await transaction.select<CostPrivacyProfileRow>(
        `${COST_PRIVACY_PROFILE_SELECT} WHERE catalog_entry_id = ?`,
        [validated.catalogEntryId],
      );
      if (saved[0] === undefined) {
        throw modelHubError(
          "MODEL_HUB_COST_PRIVACY_WRITE_FAILED",
          "The model cost and privacy profile was not persisted.",
        );
      }
      return hydrateCostPrivacyProfile(saved[0]);
    });
  }

  public async listEvaluationResults(
    catalogEntryIdValue: string,
    taskValue?: NovelAiTask,
  ): Promise<readonly ModelEvaluationResult[]> {
    const catalogEntryId = boundedText(catalogEntryIdValue, "catalog entry id", 128);
    const task = taskValue === undefined ? null : validateTask(taskValue);
    const rows = await this.executor.select<EvaluationResultRow>(
      `${EVALUATION_RESULT_SELECT}
       WHERE catalog_entry_id = ? AND (? IS NULL OR task = ?)
       ORDER BY task ASC, score_basis_points DESC, latency_p50_ms ASC,
                observed_at DESC, id ASC`,
      [catalogEntryId, task, task],
    );
    return Object.freeze(rows.map(hydrateEvaluationResult));
  }

  public async recordEvaluationResult(
    input: RecordModelEvaluationResultInput,
  ): Promise<ModelEvaluationResult> {
    const validated = validateEvaluationResultInput(input);
    const observedAt = validated.observedAt ?? this.clock.now();
    validateEvaluationExpiry(observedAt, validated.expiresAt);
    return this.executor.transaction(async (transaction) => {
      await ensureCatalogEntryExists(transaction, validated.catalogEntryId);
      const duplicates = await transaction.select<{ id: string }>(
        `SELECT id
         FROM model_evaluation_results
         WHERE id = ?
            OR (
              catalog_entry_id = ? AND task = ?
              AND evaluation_source = ? AND evaluation_version = ?
            )
         LIMIT 1`,
        [
          validated.id,
          validated.catalogEntryId,
          validated.task,
          validated.evaluationSource,
          validated.evaluationVersion,
        ],
      );
      if (duplicates[0] !== undefined) {
        throw conflict("MODEL_HUB_EVALUATION_CONFLICT");
      }
      await transaction.execute(
        `INSERT INTO model_evaluation_results (
           id, catalog_entry_id, task, score_basis_points, latency_p50_ms,
           sample_count, evaluation_source, evaluation_version, observed_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          validated.id,
          validated.catalogEntryId,
          validated.task,
          validated.scoreBasisPoints,
          validated.latencyP50Ms,
          validated.sampleCount,
          validated.evaluationSource,
          validated.evaluationVersion,
          observedAt,
          validated.expiresAt,
        ],
      );
      const saved = await transaction.select<EvaluationResultRow>(
        `${EVALUATION_RESULT_SELECT} WHERE id = ?`,
        [validated.id],
      );
      if (saved[0] === undefined) {
        throw modelHubError(
          "MODEL_HUB_EVALUATION_WRITE_FAILED",
          "The model evaluation result was not persisted.",
        );
      }
      return hydrateEvaluationResult(saved[0]);
    });
  }

  public async listPresets(): Promise<readonly ModelHubPreset[]> {
    const rows = await this.executor.select<PresetRow>(
      `${PRESET_SELECT}
       ORDER BY status = 'active' DESC, updated_at DESC, id ASC`,
    );
    return Object.freeze(rows.map(hydratePreset));
  }

  public async findActivePreset(): Promise<ModelHubPreset | null> {
    const rows = await this.executor.select<PresetRow>(
      `${PRESET_SELECT} WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`,
    );
    return rows[0] === undefined ? null : hydratePreset(rows[0]);
  }

  public async savePreset(input: SaveModelHubPresetInput): Promise<ModelHubPreset> {
    const validated = validatePresetInput(input);
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<PresetRow>(`${PRESET_SELECT} WHERE id = ?`, [
        validated.id,
      ]);
      const existing = rows[0];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_PRESET_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
      ) {
        throw conflict("MODEL_HUB_PRESET_CONFLICT");
      }
      const now = this.clock.now();
      if (validated.status === "active") {
        await transaction.execute(
          `UPDATE model_hub_presets
           SET status = 'superseded', revision = revision + 1, updated_at = ?
           WHERE status = 'active' AND id <> ?`,
          [now, validated.id],
        );
      }
      if (existing === undefined) {
        await transaction.execute(
          `INSERT INTO model_hub_presets (
             id, scheme, display_name, status, privacy_policy, cost_priority,
             route_generation_version, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            validated.id,
            validated.scheme,
            validated.displayName,
            validated.status,
            validated.privacyPolicy,
            validated.costPriority,
            validated.routeGenerationVersion,
            now,
            now,
          ],
        );
      } else {
        const result = await transaction.execute(
          `UPDATE model_hub_presets
           SET scheme = ?, display_name = ?, status = ?, privacy_policy = ?,
               cost_priority = ?, route_generation_version = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
          [
            validated.scheme,
            validated.displayName,
            validated.status,
            validated.privacyPolicy,
            validated.costPriority,
            validated.routeGenerationVersion,
            now,
            validated.id,
            existing.revision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw conflict("MODEL_HUB_PRESET_CONFLICT");
        }
      }
      const saved = await transaction.select<PresetRow>(`${PRESET_SELECT} WHERE id = ?`, [
        validated.id,
      ]);
      if (saved[0] === undefined) {
        throw modelHubError("MODEL_HUB_PRESET_WRITE_FAILED", "The model preset was not persisted.");
      }
      return hydratePreset(saved[0]);
    });
  }

  public async findTaskRoute(taskValue: NovelAiTask): Promise<NovelTaskRoute | null> {
    const task = validateTask(taskValue);
    const rows = await this.executor.select<RouteRow>(`${ROUTE_SELECT} WHERE task = ?`, [task]);
    return rows[0] === undefined ? null : hydrateRoute(rows[0]);
  }

  public async saveTaskRoute(input: SaveNovelTaskRouteInput): Promise<NovelTaskRoute> {
    const validated = validateRouteInput(input);
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<RouteRow>(`${ROUTE_SELECT} WHERE task = ?`, [
        validated.task,
      ]);
      const existing = rows[0];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_ROUTE_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || validated.expectedRevision !== existing.revision)
      ) {
        throw conflict("MODEL_HUB_ROUTE_CONFLICT");
      }
      await ensureCatalogEntry(transaction, validated.primaryCatalogEntryId);
      if (validated.fallbackCatalogEntryId !== null) {
        await ensureCatalogEntry(transaction, validated.fallbackCatalogEntryId);
      }
      if (validated.privacyPolicy === "local_only") {
        await ensureLocalCatalogEntry(transaction, validated.primaryCatalogEntryId);
        if (validated.fallbackCatalogEntryId !== null) {
          await ensureLocalCatalogEntry(transaction, validated.fallbackCatalogEntryId);
        }
      }
      const now = this.clock.now();
      if (existing === undefined) {
        await transaction.execute(
          `INSERT INTO novel_task_routes (
             task, primary_catalog_entry_id, fallback_catalog_entry_id, preset_id,
             parameter_policy_json, maximum_cost_micros, currency, privacy_policy,
             failure_policy, route_origin, enabled, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            validated.task,
            validated.primaryCatalogEntryId,
            validated.fallbackCatalogEntryId,
            validated.presetId,
            validated.parameterPolicyJson,
            validated.maximumCostMicros,
            validated.currency,
            validated.privacyPolicy,
            validated.failurePolicy,
            validated.routeOrigin,
            validated.enabled ? 1 : 0,
            now,
            now,
          ],
        );
      } else {
        const result = await transaction.execute(
          `UPDATE novel_task_routes
           SET primary_catalog_entry_id = ?, fallback_catalog_entry_id = ?, preset_id = ?,
               parameter_policy_json = ?, maximum_cost_micros = ?, currency = ?,
               privacy_policy = ?, failure_policy = ?, route_origin = ?, enabled = ?,
               revision = revision + 1, updated_at = ?
           WHERE task = ? AND revision = ?`,
          [
            validated.primaryCatalogEntryId,
            validated.fallbackCatalogEntryId,
            validated.presetId,
            validated.parameterPolicyJson,
            validated.maximumCostMicros,
            validated.currency,
            validated.privacyPolicy,
            validated.failurePolicy,
            validated.routeOrigin,
            validated.enabled ? 1 : 0,
            now,
            validated.task,
            existing.revision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw conflict("MODEL_HUB_ROUTE_CONFLICT");
        }
      }
      const saved = await transaction.select<RouteRow>(`${ROUTE_SELECT} WHERE task = ?`, [
        validated.task,
      ]);
      if (saved[0] === undefined) {
        throw modelHubError("MODEL_HUB_ROUTE_WRITE_FAILED", "The task route was not persisted.");
      }
      return hydrateRoute(saved[0]);
    });
  }

  public async deleteTaskRoute(
    taskValue: NovelAiTask,
    expectedRevisionValue: number,
  ): Promise<void> {
    const task = validateTask(taskValue);
    const expectedRevision = validateRequiredRevision(expectedRevisionValue);
    const result = await this.executor.execute(
      "DELETE FROM novel_task_routes WHERE task = ? AND revision = ?",
      [task, expectedRevision],
    );
    if (result.rowsAffected !== 1) {
      throw conflict("MODEL_HUB_ROUTE_CONFLICT");
    }
  }

  public async applyAutomaticRoutingPlan(
    input: ApplyAutomaticModelHubRoutingPlanInput,
  ): Promise<AppliedAutomaticModelHubRoutingPlan> {
    const validated = validateAutomaticRoutingPlanInput(input);
    try {
      return await this.executor.transaction(async (transaction) => {
        const presetRows = await transaction.select<PresetRow>(PRESET_SELECT);
        const routeRows = await transaction.select<RouteRow>(ROUTE_SELECT);
        const existingPreset = presetRows.find(({ id }) => id === validated.preset.id);
        const preservedUserRoutes = routeRows.filter(({ route_origin }) => route_origin === "user");

        if (
          validated.preset.privacyPolicy === "local_only" &&
          preservedUserRoutes.some(
            ({ privacy_policy, enabled }) => enabled === 1 && privacy_policy !== "local_only",
          )
        ) {
          throw modelHubError(
            "MODEL_HUB_MANUAL_ROUTE_PRIVACY_CONFLICT",
            "A manual cloud route must be changed or disabled before applying local-only routing.",
          );
        }

        const userTasks = new Set(preservedUserRoutes.map(({ task }) => validateTask(task)));
        for (const route of validated.routes) {
          if (userTasks.has(route.task)) continue;
          await ensureCatalogEntry(transaction, route.primaryCatalogEntryId);
          if (route.fallbackCatalogEntryId !== null) {
            await ensureCatalogEntry(transaction, route.fallbackCatalogEntryId);
          }
          if (route.privacyPolicy === "local_only") {
            await ensureLocalCatalogEntry(transaction, route.primaryCatalogEntryId);
            if (route.fallbackCatalogEntryId !== null) {
              await ensureLocalCatalogEntry(transaction, route.fallbackCatalogEntryId);
            }
          }
        }

        const now = this.clock.now();
        let changed = false;
        if (validated.preset.status === "active") {
          const superseded = await transaction.execute(
            `UPDATE model_hub_presets
             SET status = 'superseded', revision = revision + 1, updated_at = ?
             WHERE status = 'active' AND id <> ?`,
            [now, validated.preset.id],
          );
          changed = superseded.rowsAffected > 0;
        }

        if (existingPreset === undefined) {
          await transaction.execute(
            `INSERT INTO model_hub_presets (
               id, scheme, display_name, status, privacy_policy, cost_priority,
               route_generation_version, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
              validated.preset.id,
              validated.preset.scheme,
              validated.preset.displayName,
              validated.preset.status,
              validated.preset.privacyPolicy,
              validated.preset.costPriority,
              validated.preset.routeGenerationVersion,
              now,
              now,
            ],
          );
          changed = true;
        } else if (!presetRowMatchesAutomaticPlan(existingPreset, validated.preset)) {
          const updated = await transaction.execute(
            `UPDATE model_hub_presets
             SET scheme = ?, display_name = ?, status = ?, privacy_policy = ?,
                 cost_priority = ?, route_generation_version = ?,
                 revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ?`,
            [
              validated.preset.scheme,
              validated.preset.displayName,
              validated.preset.status,
              validated.preset.privacyPolicy,
              validated.preset.costPriority,
              validated.preset.routeGenerationVersion,
              now,
              validated.preset.id,
              existingPreset.revision,
            ],
          );
          if (updated.rowsAffected !== 1) {
            throw conflict("MODEL_HUB_PRESET_CONFLICT");
          }
          changed = true;
        }

        const desiredByTask = new Map(
          validated.routes.map((route) => [route.task, route] as const),
        );
        for (const existing of routeRows) {
          if (existing.route_origin === "user") {
            desiredByTask.delete(validateTask(existing.task));
            continue;
          }
          const desired = desiredByTask.get(validateTask(existing.task));
          if (desired === undefined) {
            const deleted = await transaction.execute(
              "DELETE FROM novel_task_routes WHERE task = ? AND revision = ? AND route_origin <> 'user'",
              [existing.task, existing.revision],
            );
            if (deleted.rowsAffected !== 1) {
              throw conflict("MODEL_HUB_ROUTE_CONFLICT");
            }
            changed = true;
            continue;
          }
          if (!routeRowMatchesAutomaticPlan(existing, desired, validated.preset.id)) {
            const updated = await transaction.execute(
              `UPDATE novel_task_routes
               SET primary_catalog_entry_id = ?, fallback_catalog_entry_id = ?, preset_id = ?,
                   parameter_policy_json = ?, maximum_cost_micros = ?, currency = ?,
                   privacy_policy = ?, failure_policy = ?, route_origin = 'automatic', enabled = ?,
                   revision = revision + 1, updated_at = ?
               WHERE task = ? AND revision = ? AND route_origin <> 'user'`,
              [
                desired.primaryCatalogEntryId,
                desired.fallbackCatalogEntryId,
                validated.preset.id,
                desired.parameterPolicyJson,
                desired.maximumCostMicros,
                desired.currency,
                desired.privacyPolicy,
                desired.failurePolicy,
                desired.enabled ? 1 : 0,
                now,
                desired.task,
                existing.revision,
              ],
            );
            if (updated.rowsAffected !== 1) {
              throw conflict("MODEL_HUB_ROUTE_CONFLICT");
            }
            changed = true;
          }
          desiredByTask.delete(desired.task);
        }

        for (const desired of desiredByTask.values()) {
          await transaction.execute(
            `INSERT INTO novel_task_routes (
               task, primary_catalog_entry_id, fallback_catalog_entry_id, preset_id,
               parameter_policy_json, maximum_cost_micros, currency, privacy_policy,
               failure_policy, route_origin, enabled, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'automatic', ?, 1, ?, ?)`,
            [
              desired.task,
              desired.primaryCatalogEntryId,
              desired.fallbackCatalogEntryId,
              validated.preset.id,
              desired.parameterPolicyJson,
              desired.maximumCostMicros,
              desired.currency,
              desired.privacyPolicy,
              desired.failurePolicy,
              desired.enabled ? 1 : 0,
              now,
              now,
            ],
          );
          changed = true;
        }

        const savedPresetRows = await transaction.select<PresetRow>(
          `${PRESET_SELECT} WHERE id = ?`,
          [validated.preset.id],
        );
        const savedRouteRows = await transaction.select<RouteRow>(
          `${ROUTE_SELECT} ORDER BY task ASC`,
        );
        if (savedPresetRows[0] === undefined) {
          throw modelHubError(
            "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
            "The automatic AI routing plan was not persisted.",
          );
        }
        return Object.freeze({
          preset: hydratePreset(savedPresetRows[0]),
          routes: Object.freeze(savedRouteRows.map(hydrateRoute)),
          changed,
          preservedUserRouteCount: preservedUserRoutes.length,
        });
      });
    } catch (cause: unknown) {
      if (cause instanceof ModelHubStoreError) {
        throw cause;
      }
      throw new ModelHubStoreError(
        "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
        "The AI routing plan was not committed; the previous plan remains active.",
        true,
      );
    }
  }

  public async listRecentAiFailures(limitValue = 25): Promise<readonly RecentAiFailure[]> {
    const limit = validateRecentFailureLimit(limitValue);
    const rows = await this.executor.select<RecentAiFailureRow>(RECENT_AI_FAILURE_SELECT, [limit]);
    return Object.freeze(rows.map(hydrateRecentAiFailure));
  }

  public async startInvocation(input: StartModelInvocationInput): Promise<ModelInvocationFact> {
    const validated = validateInvocationStart(input);
    const now = this.clock.now();
    const result = await this.executor.execute(
      `INSERT INTO model_invocation_facts (
         id, task, route_task, connection_id, catalog_entry_id,
         provider_kind_snapshot, model_id_snapshot, route_reason, status, attempt,
         fallback_from_invocation_id, privacy_policy, data_destination,
         maximum_cost_micros, currency, started_at, created_at, revision
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, 1
       FROM model_provider_connections AS connection
       WHERE connection.id = ? AND connection.enabled = 1`,
      [
        validated.id,
        validated.task,
        validated.routeTask,
        validated.connectionId,
        validated.catalogEntryId,
        validated.providerKindSnapshot,
        validated.modelIdSnapshot,
        validated.routeReason,
        validated.attempt,
        validated.fallbackFromInvocationId,
        validated.privacyPolicy,
        validated.dataDestination,
        validated.maximumCostMicros,
        validated.currency,
        now,
        now,
        validated.connectionId,
      ],
    );
    if (result.rowsAffected !== 1) {
      const connection = await this.findConnection(validated.connectionId);
      throw connection === null
        ? modelHubError("MODEL_HUB_CONNECTION_NOT_FOUND", "The provider connection does not exist.")
        : modelHubError(
            "MODEL_HUB_CONNECTION_DISABLED",
            "The provider connection is disabled and cannot start a model invocation.",
          );
    }
    return this.requireInvocation(validated.id);
  }

  public async findInvocation(idValue: string): Promise<ModelInvocationFact | null> {
    const id = boundedText(idValue, "invocation id", 128);
    const rows = await this.executor.select<InvocationRow>(`${INVOCATION_SELECT} WHERE id = ?`, [
      id,
    ]);
    return rows[0] === undefined ? null : hydrateInvocation(rows[0]);
  }

  public async finishInvocation(input: FinishModelInvocationInput): Promise<ModelInvocationFact> {
    const validated = validateInvocationFinish(input);
    const result = await this.executor.execute(
      `UPDATE model_invocation_facts
       SET status = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
           estimated_cost_micros = ?, currency = COALESCE(?, currency),
           error_code = ?, error_summary = ?, diagnostic_request_id = ?,
           failure_stage = ?, failure_retryable = ?, http_status = ?, finish_reason = ?,
           visible_content_length = ?, reasoning_present = ?, streamed = ?,
           requested_max_output_tokens = ?, completed_at = ?, revision = revision + 1
       WHERE id = ? AND status = 'running' AND revision = ?`,
      [
        validated.status,
        validated.inputTokens,
        validated.outputTokens,
        validated.cachedInputTokens,
        validated.estimatedCostMicros,
        validated.currency,
        validated.errorCode,
        validated.errorSummary,
        validated.failure?.requestId ?? null,
        validated.failure?.stage ?? null,
        nullableBooleanInteger(validated.failure?.retryable ?? null),
        validated.failure?.httpStatus ?? null,
        validated.failure?.finishReason ?? null,
        validated.completion?.visibleContentLength ??
          validated.failure?.visibleContentLength ??
          null,
        nullableBooleanInteger(validated.failure?.reasoningPresent ?? null),
        nullableBooleanInteger(validated.completion?.stream ?? validated.failure?.stream ?? null),
        validated.failure?.requestedMaxOutputTokens ?? null,
        this.clock.now(),
        validated.id,
        validated.expectedRevision,
      ],
    );
    if (result.rowsAffected !== 1) {
      throw conflict("MODEL_HUB_INVOCATION_CONFLICT");
    }
    return this.requireInvocation(validated.id);
  }

  private async requireInvocation(id: string): Promise<ModelInvocationFact> {
    const invocation = await this.findInvocation(id);
    if (invocation === null) {
      throw modelHubError("MODEL_HUB_INVOCATION_NOT_FOUND", "The invocation fact does not exist.");
    }
    return invocation;
  }
}

interface MemoryModelHubState {
  readonly connectionCommits: Record<string, ModelHubConnectionCommit>;
  readonly connections: Record<string, ModelProviderConnection>;
  readonly catalog: Record<string, ModelCatalogEntry>;
  readonly catalogSyncs: Record<string, ModelCatalogSync>;
  readonly capabilityEvidence: Record<string, ModelCapabilityEvidence>;
  readonly capabilityScans: Record<string, ModelCapabilityScanFact | null>;
  readonly costPrivacyProfiles: Record<string, ModelCostPrivacyProfile>;
  readonly evaluationResults: Record<string, ModelEvaluationResult>;
  readonly presets: Record<string, ModelHubPreset>;
  readonly routes: Record<string, NovelTaskRoute>;
  readonly invocations: Record<string, ModelInvocationFact>;
}

export class InMemoryModelHubStore implements ModelHubStore {
  private state: MemoryModelHubState;

  public constructor(
    private readonly clock: Clock,
    initialState: MemoryModelHubState = createEmptyMemoryState(),
    private readonly persist: (state: MemoryModelHubState) => void = () => undefined,
  ) {
    this.state = structuredClone(initialState);
  }

  public listConnections(): Promise<readonly ModelProviderConnection[]> {
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.connections)
          .map((connection) => Object.freeze(structuredClone(connection)))
          .sort(
            (left, right) =>
              Number(right.enabled) - Number(left.enabled) ||
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.id.localeCompare(right.id),
          ),
      ),
    );
  }

  public findConnection(idValue: string): Promise<ModelProviderConnection | null> {
    const id = boundedText(idValue, "connection id", 128);
    const connection = this.state.connections[id];
    return Promise.resolve(
      connection === undefined ? null : Object.freeze(structuredClone(connection)),
    );
  }

  public saveConnection(input: SaveModelProviderConnectionInput): Promise<ModelProviderConnection> {
    return Promise.resolve().then(() => {
      const validated = validateConnectionInput(input);
      const existing = this.state.connections[validated.id];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
      ) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      if (existing !== undefined && existing.providerKind !== validated.providerKind) {
        throw modelHubError(
          "MODEL_HUB_PROVIDER_KIND_IMMUTABLE",
          "A connection id cannot be reassigned to a different provider kind.",
        );
      }
      const endpointIdentityChanged =
        existing !== undefined && connectionEndpointIdentityChanged(existing, validated);
      const now = this.clock.now();
      if (endpointIdentityChanged) {
        invalidateMemoryConnectionDerivedState(this.state, validated.id, now);
      }
      const saved: ModelProviderConnection = Object.freeze({
        id: validated.id,
        providerKind: validated.providerKind,
        displayName: validated.displayName,
        protocol: validated.protocol,
        region: validated.region,
        workspaceId: validated.workspaceId,
        endpointId: validated.endpointId,
        baseUrl: validated.baseUrl,
        credentialRef: validated.credentialRef,
        credentialState: validated.credentialState,
        authenticationMode: validated.authenticationMode,
        credentialHeaderName: validated.credentialHeaderName,
        modelDiscoveryPath: validated.modelDiscoveryPath,
        textGenerationPath: validated.textGenerationPath,
        embeddingPath: validated.embeddingPath,
        requestTimeoutMs: validated.requestTimeoutMs,
        retryLimit: validated.retryLimit,
        connectionStatus: endpointIdentityChanged
          ? "not_tested"
          : (existing?.connectionStatus ?? "not_tested"),
        catalogSyncStatus: endpointIdentityChanged
          ? "never"
          : (existing?.catalogSyncStatus ?? "never"),
        lastTestedAt: endpointIdentityChanged ? null : (existing?.lastTestedAt ?? null),
        lastCatalogSyncedAt: endpointIdentityChanged
          ? null
          : (existing?.lastCatalogSyncedAt ?? null),
        lastErrorCode: endpointIdentityChanged ? null : (existing?.lastErrorCode ?? null),
        lastErrorSummary: endpointIdentityChanged ? null : (existing?.lastErrorSummary ?? null),
        legacyProviderId: validated.legacyProviderId,
        enabled: validated.enabled,
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.state.connections[saved.id] = saved;
      this.commit();
      return saved;
    });
  }

  public retireConnection(
    input: RetireModelProviderConnectionInput,
  ): Promise<ModelProviderConnection> {
    return Promise.resolve().then(() => {
      const connectionId = boundedText(input.connectionId, "connection id", 128);
      const expectedRevision = validateRequiredRevision(input.expectedRevision);
      const existing = this.state.connections[connectionId];
      if (existing === undefined) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_NOT_FOUND",
          "The provider connection does not exist.",
        );
      }
      if (isRetiredModelProviderConnection(existing)) {
        return Object.freeze(structuredClone(existing));
      }
      if (existing.revision !== expectedRevision) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      const retired: ModelProviderConnection = Object.freeze({
        ...existing,
        credentialRef: null,
        credentialState: "missing",
        authenticationMode:
          existing.providerKind === "custom_openai_compatible"
            ? "none"
            : existing.authenticationMode,
        credentialHeaderName:
          existing.providerKind === "custom_openai_compatible"
            ? null
            : existing.credentialHeaderName,
        enabled: false,
        connectionStatus: "disabled",
        lastErrorCode: RETIRED_CONNECTION_ERROR_CODE,
        lastErrorSummary: RETIRED_CONNECTION_SUMMARY,
        revision: existing.revision + 1,
        updatedAt: this.clock.now(),
      });
      this.state.connections[connectionId] = retired;
      this.commit();
      return retired;
    });
  }

  public recordConnectionTest(input: RecordConnectionTestInput): Promise<ModelProviderConnection> {
    return Promise.resolve().then(() => {
      const validated = validateConnectionTestInput(input);
      const existing = this.state.connections[validated.connectionId];
      if (existing?.revision !== validated.expectedRevision) {
        throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
      }
      const now = this.clock.now();
      const saved: ModelProviderConnection = Object.freeze({
        ...existing,
        connectionStatus: validated.status,
        lastTestedAt: now,
        lastErrorCode: validated.errorCode,
        lastErrorSummary: validated.errorSummary,
        revision: existing.revision + 1,
        updatedAt: now,
      });
      this.state.connections[saved.id] = saved;
      this.commit();
      return saved;
    });
  }

  public listCatalog(connectionIdValue: string): Promise<readonly ModelCatalogEntry[]> {
    const connectionId = boundedText(connectionIdValue, "connection id", 128);
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.catalog)
          .filter((entry) => entry.connectionId === connectionId)
          .map((entry) => Object.freeze(structuredClone(entry)))
          .sort(
            (left, right) =>
              Number(right.availability === "available") -
                Number(left.availability === "available") ||
              left.displayName.localeCompare(right.displayName) ||
              left.providerModelId.localeCompare(right.providerModelId),
          ),
      ),
    );
  }

  public listCatalogSyncs(connectionIdValue: string): Promise<readonly ModelCatalogSync[]> {
    const connectionId = boundedText(connectionIdValue, "connection id", 128);
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.catalogSyncs)
          .filter((sync) => sync.connectionId === connectionId)
          .map((sync) => Object.freeze(structuredClone(sync)))
          .sort(
            (left, right) =>
              right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
          ),
      ),
    );
  }

  public syncCatalog(input: SyncModelCatalogInput): Promise<readonly ModelCatalogEntry[]> {
    return Promise.resolve().then(async () => {
      const validated = validateCatalogInput(input);
      const connection = this.state.connections[validated.connectionId];
      if (connection === undefined) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_NOT_FOUND",
          "The provider connection does not exist.",
        );
      }
      if (this.state.catalogSyncs[validated.syncId] !== undefined) {
        throw conflict("MODEL_HUB_CATALOG_SYNC_CONFLICT");
      }
      const now = this.clock.now();
      this.state.catalogSyncs[validated.syncId] = Object.freeze({
        id: validated.syncId,
        connectionId: validated.connectionId,
        source: validated.source,
        status: validated.status,
        discoveredModelCount: validated.models.length,
        nextPageTokenPresent: validated.nextPageTokenPresent,
        errorCode: validated.errorCode,
        errorSummary: validated.errorSummary,
        startedAt: validated.startedAt ?? now,
        completedAt: now,
      });
      for (const model of validated.models) {
        const existing = Object.values(this.state.catalog).find(
          (entry) =>
            entry.connectionId === validated.connectionId &&
            entry.providerModelId === model.providerModelId,
        );
        const id = existing?.id ?? model.id;
        this.state.catalog[id] = Object.freeze({
          id,
          connectionId: validated.connectionId,
          providerModelId: model.providerModelId,
          displayName: model.displayName,
          ownedBy: model.ownedBy,
          catalogSource: validated.source,
          availability: "available",
          lifecycle: model.lifecycle,
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
          firstDiscoveredAt: existing?.firstDiscoveredAt ?? now,
          lastSeenAt: now,
          staleAfter: model.staleAfter,
          lastSyncId: validated.syncId,
          revision: existing === undefined ? 1 : existing.revision + 1,
        });
      }
      if (validated.status === "succeeded" && validated.source === "provider_api") {
        for (const [id, entry] of Object.entries(this.state.catalog)) {
          if (
            entry.connectionId === validated.connectionId &&
            entry.catalogSource === "provider_api" &&
            entry.lastSyncId !== validated.syncId &&
            entry.availability !== "unavailable"
          ) {
            this.state.catalog[id] = Object.freeze({
              ...entry,
              availability: "unavailable",
              revision: entry.revision + 1,
            });
          }
        }
      }
      this.state.connections[connection.id] = Object.freeze({
        ...connection,
        catalogSyncStatus: validated.status,
        lastCatalogSyncedAt: now,
        lastErrorCode: validated.errorCode,
        lastErrorSummary: validated.errorSummary,
        revision: connection.revision + 1,
        updatedAt: now,
      });
      this.commit();
      return this.listCatalog(validated.connectionId);
    });
  }

  public findConnectionCommit(connectionIdValue: string): Promise<ModelHubConnectionCommit | null> {
    const connectionId = boundedText(connectionIdValue, "connection commit connection id", 128);
    const commit = this.state.connectionCommits[connectionId];
    return Promise.resolve(commit === undefined ? null : Object.freeze(structuredClone(commit)));
  }

  public listConnectionCommits(): Promise<readonly ModelHubConnectionCommit[]> {
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.connectionCommits)
          .sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
          )
          .map((commit) => Object.freeze(structuredClone(commit))),
      ),
    );
  }

  public prepareConnectionCommit(
    input: PrepareModelHubConnectionCommitInput,
  ): Promise<ModelHubConnectionCommit> {
    return Promise.resolve().then(() => {
      const validated = validatePrepareConnectionCommitInput(input);
      if (
        this.state.connectionCommits[validated.connectionId] !== undefined ||
        Object.values(this.state.connectionCommits).some(({ id }) => id === validated.id)
      ) {
        throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
      }
      const now = this.clock.now();
      const saved: ModelHubConnectionCommit = Object.freeze({
        id: validated.id,
        connectionId: validated.connectionId,
        phase: "prepared",
        credentialProviderId: validated.credentialProviderId,
        cleanupCredentialProviderId: null,
        createdAt: now,
        updatedAt: now,
      });
      this.state.connectionCommits[saved.connectionId] = saved;
      this.commit();
      return saved;
    });
  }

  public publishConnectionCommit(
    input: PublishModelHubConnectionCommitInput,
  ): Promise<PublishModelHubConnectionCommitResult> {
    return Promise.resolve().then(() => {
      const validated = validatePublishConnectionCommitInput(input);
      const journal = this.state.connectionCommits[validated.connection.id];
      if (
        journal?.id !== validated.id ||
        journal.phase !== "prepared" ||
        journal.credentialProviderId !== validated.credentialProviderId
      ) {
        throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
      }
      const working = structuredClone(this.state);
      const now = this.clock.now();
      const saved = persistMemoryConnection(working, validated.connection, now);
      working.connections[saved.id] = Object.freeze({
        ...saved,
        connectionStatus: "ready",
        lastTestedAt: now,
        lastErrorCode: null,
        lastErrorSummary: null,
        revision: saved.revision + 1,
        updatedAt: now,
      });
      persistMemoryCatalogSync(working, validated.catalog, now);
      const current = working.connections[saved.id];
      if (current === undefined) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_WRITE_FAILED",
          "The verified connection was not persisted.",
        );
      }
      const currentCatalog = Object.freeze(
        Object.values(working.catalog)
          .filter(({ connectionId }) => connectionId === saved.id)
          .sort(
            (left, right) =>
              Number(right.availability === "available") -
                Number(left.availability === "available") ||
              left.displayName.localeCompare(right.displayName) ||
              left.providerModelId.localeCompare(right.providerModelId),
          )
          .map((entry) => Object.freeze(structuredClone(entry))),
      );
      if (
        !currentCatalog.some(
          ({ availability, lastSyncId }) =>
            availability === "available" && lastSyncId === validated.catalog.syncId,
        )
      ) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_COMMIT_CATALOG_EMPTY",
          "A verified connection cannot be published without an available catalog entry.",
        );
      }
      let commit: ModelHubConnectionCommit | null = null;
      if (validated.cleanupCredentialProviderId === null) {
        Reflect.deleteProperty(working.connectionCommits, saved.id);
      } else {
        commit = Object.freeze({
          ...journal,
          phase: "cleanup_pending",
          cleanupCredentialProviderId: validated.cleanupCredentialProviderId,
          updatedAt: now,
        });
        working.connectionCommits[saved.id] = commit;
      }
      this.state = working;
      this.commit();
      return Object.freeze({
        connection: Object.freeze(structuredClone(current)),
        catalog: currentCatalog,
        commit,
      });
    });
  }

  public publishCredentialCommit(
    input: PublishModelHubCredentialCommitInput,
  ): Promise<PublishModelHubCredentialCommitResult> {
    return Promise.resolve().then(() => {
      const validated = validatePublishCredentialCommitInput(input);
      const journal = this.state.connectionCommits[validated.connection.id];
      if (
        journal?.id !== validated.id ||
        journal.phase !== "prepared" ||
        journal.credentialProviderId !== validated.credentialProviderId
      ) {
        throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
      }
      const working = structuredClone(this.state);
      const now = this.clock.now();
      const saved = persistMemoryConnection(working, validated.connection, now);
      const current: ModelProviderConnection = Object.freeze({
        ...saved,
        connectionStatus: saved.enabled ? "not_tested" : "disabled",
        lastTestedAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        revision: saved.revision + 1,
        updatedAt: now,
      });
      working.connections[saved.id] = current;
      let commit: ModelHubConnectionCommit | null = null;
      if (validated.cleanupCredentialProviderId === null) {
        Reflect.deleteProperty(working.connectionCommits, saved.id);
      } else {
        commit = Object.freeze({
          ...journal,
          phase: "cleanup_pending",
          cleanupCredentialProviderId: validated.cleanupCredentialProviderId,
          updatedAt: now,
        });
        working.connectionCommits[saved.id] = commit;
      }
      this.state = working;
      this.commit();
      return Object.freeze({
        connection: Object.freeze(structuredClone(current)),
        commit,
      });
    });
  }

  public finishConnectionCommit(connectionIdValue: string, idValue: string): Promise<void> {
    return Promise.resolve().then(() => {
      const connectionId = boundedText(connectionIdValue, "connection commit connection id", 128);
      const id = boundedText(idValue, "connection commit id", 128);
      const current = this.state.connectionCommits[connectionId];
      if (current === undefined) return;
      if (current.id !== id) throw conflict("MODEL_HUB_CONNECTION_COMMIT_CONFLICT");
      Reflect.deleteProperty(this.state.connectionCommits, connectionId);
      this.commit();
    });
  }

  public listCapabilityEvidence(
    catalogEntryIdValue: string,
  ): Promise<readonly ModelCapabilityEvidence[]> {
    const catalogEntryId = boundedText(catalogEntryIdValue, "catalog entry id", 128);
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.capabilityEvidence)
          .filter((evidence) => evidence.catalogEntryId === catalogEntryId)
          .map((evidence) => Object.freeze(structuredClone(evidence)))
          .sort(
            (left, right) =>
              left.capability.localeCompare(right.capability) ||
              right.observedAt.localeCompare(left.observedAt) ||
              left.id.localeCompare(right.id),
          ),
      ),
    );
  }

  public recordCapabilityScan(
    input: RecordCapabilityScanInput,
  ): Promise<readonly ModelCapabilityEvidence[]> {
    return Promise.resolve().then(async () => {
      const validated = validateCapabilityScanInput(input);
      if (this.state.catalog[validated.catalogEntryId] === undefined) {
        throw modelHubError("MODEL_HUB_MODEL_NOT_FOUND", "The selected model does not exist.");
      }
      if (Object.hasOwn(this.state.capabilityScans, validated.scanId)) {
        throw conflict("MODEL_HUB_CAPABILITY_SCAN_CONFLICT");
      }
      const now = this.clock.now();
      for (const evidence of validated.evidence) {
        if (this.state.capabilityEvidence[evidence.id] !== undefined) {
          throw conflict("MODEL_HUB_CAPABILITY_EVIDENCE_CONFLICT");
        }
        const duplicate = Object.values(this.state.capabilityEvidence).some(
          (stored) =>
            stored.catalogEntryId === validated.catalogEntryId &&
            stored.capability === evidence.capability &&
            stored.evidenceSource === evidence.evidenceSource &&
            stored.evidenceVersion === validated.evidenceVersion,
        );
        if (duplicate) {
          throw conflict("MODEL_HUB_CAPABILITY_EVIDENCE_CONFLICT");
        }
      }
      this.state.capabilityScans[validated.scanId] = capabilityScanFact(validated, now);
      for (const evidence of validated.evidence) {
        this.state.capabilityEvidence[evidence.id] = Object.freeze({
          id: evidence.id,
          catalogEntryId: validated.catalogEntryId,
          scanId: validated.scanId,
          capability: evidence.capability,
          verdict: evidence.verdict,
          evidenceSource: evidence.evidenceSource,
          evidenceVersion: validated.evidenceVersion,
          evidenceSummary: evidence.evidenceSummary,
          observedAt: now,
          expiresAt: evidence.expiresAt,
        });
      }
      this.commit();
      return this.listCapabilityEvidence(validated.catalogEntryId);
    });
  }

  public commitCapabilityProbeResult(
    input: CommitCapabilityProbeResultInput,
  ): Promise<CapabilityProbeCommitResult> {
    return Promise.resolve().then(() => {
      const validated = validateCapabilityProbeCommitInput(input);
      const nextState = structuredClone(this.state);
      const connection = nextState.connections[validated.connectionId];
      const catalogEntry = nextState.catalog[validated.catalogEntryId];
      if (
        connection?.revision !== validated.expectedConnectionRevision ||
        !connection.enabled ||
        (connection.authenticationMode !== "none" &&
          (connection.credentialState !== "present" || connection.credentialRef === null)) ||
        catalogEntry?.connectionId !== validated.connectionId ||
        catalogEntry.revision !== validated.expectedCatalogRevision ||
        catalogEntry.providerModelId !== validated.expectedProviderModelId ||
        catalogEntry.availability !== "available"
      ) {
        throw conflict("MODEL_HUB_PROBE_TARGET_CONFLICT");
      }
      if (Object.hasOwn(nextState.capabilityScans, validated.scan.scanId)) {
        throw conflict("MODEL_HUB_CAPABILITY_SCAN_CONFLICT");
      }
      for (const evidence of validated.scan.evidence) {
        if (nextState.capabilityEvidence[evidence.id] !== undefined) {
          throw conflict("MODEL_HUB_CAPABILITY_EVIDENCE_CONFLICT");
        }
        const duplicate = Object.values(nextState.capabilityEvidence).some(
          (stored) =>
            stored.catalogEntryId === validated.catalogEntryId &&
            stored.capability === evidence.capability &&
            stored.evidenceSource === evidence.evidenceSource &&
            stored.evidenceVersion === validated.scan.evidenceVersion,
        );
        if (duplicate) {
          throw conflict("MODEL_HUB_CAPABILITY_EVIDENCE_CONFLICT");
        }
      }
      const now = this.clock.now();
      let committedConnection = connection;
      if (validated.connectionTest !== null) {
        committedConnection = Object.freeze({
          ...connection,
          connectionStatus: validated.connectionTest.status,
          lastTestedAt: now,
          lastErrorCode: validated.connectionTest.errorCode,
          lastErrorSummary: validated.connectionTest.errorSummary,
          revision: connection.revision + 1,
          updatedAt: now,
        });
        nextState.connections[validated.connectionId] = committedConnection;
      }
      nextState.capabilityScans[validated.scan.scanId] = capabilityScanFact(validated.scan, now);
      for (const evidence of validated.scan.evidence) {
        nextState.capabilityEvidence[evidence.id] = Object.freeze({
          id: evidence.id,
          catalogEntryId: validated.catalogEntryId,
          scanId: validated.scan.scanId,
          capability: evidence.capability,
          verdict: evidence.verdict,
          evidenceSource: evidence.evidenceSource,
          evidenceVersion: validated.scan.evidenceVersion,
          evidenceSummary: evidence.evidenceSummary,
          observedAt: now,
          expiresAt: evidence.expiresAt,
        });
      }
      this.state = nextState;
      this.commit();
      const committedEvidence = Object.values(nextState.capabilityEvidence)
        .filter((evidence) => evidence.catalogEntryId === validated.catalogEntryId)
        .map((evidence) => Object.freeze(structuredClone(evidence)))
        .sort(
          (left, right) =>
            left.capability.localeCompare(right.capability) ||
            right.observedAt.localeCompare(left.observedAt) ||
            left.id.localeCompare(right.id),
        );
      return Object.freeze({
        connection: Object.freeze(structuredClone(committedConnection)),
        evidence: Object.freeze(committedEvidence),
      });
    });
  }

  public findCostPrivacyProfile(
    catalogEntryIdValue: string,
  ): Promise<ModelCostPrivacyProfile | null> {
    const catalogEntryId = boundedText(catalogEntryIdValue, "catalog entry id", 128);
    const profile = this.state.costPrivacyProfiles[catalogEntryId];
    return Promise.resolve(profile === undefined ? null : Object.freeze(structuredClone(profile)));
  }

  public saveCostPrivacyProfile(
    input: SaveModelCostPrivacyProfileInput,
  ): Promise<ModelCostPrivacyProfile> {
    return Promise.resolve().then(() => {
      const validated = validateCostPrivacyProfileInput(input);
      if (this.state.catalog[validated.catalogEntryId] === undefined) {
        throw modelHubError("MODEL_HUB_MODEL_NOT_FOUND", "The selected model does not exist.");
      }
      const existing = this.state.costPrivacyProfiles[validated.catalogEntryId];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_COST_PRIVACY_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
      ) {
        throw conflict("MODEL_HUB_COST_PRIVACY_CONFLICT");
      }
      const now = this.clock.now();
      const saved: ModelCostPrivacyProfile = Object.freeze({
        catalogEntryId: validated.catalogEntryId,
        currency: validated.currency,
        inputMicrosPerMillionTokens: validated.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens: validated.outputMicrosPerMillionTokens,
        cachedInputMicrosPerMillionTokens: validated.cachedInputMicrosPerMillionTokens,
        pricingVersion: validated.pricingVersion,
        priceUpdatedAt: validated.priceUpdatedAt,
        dataDestination: validated.dataDestination,
        retentionPolicy: validated.retentionPolicy,
        trainingPolicy: validated.trainingPolicy,
        evidenceSource: validated.evidenceSource,
        evidenceVersion: validated.evidenceVersion,
        evidenceSummary: validated.evidenceSummary,
        evidenceUpdatedAt: now,
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.state.costPrivacyProfiles[saved.catalogEntryId] = saved;
      this.commit();
      return saved;
    });
  }

  public listEvaluationResults(
    catalogEntryIdValue: string,
    taskValue?: NovelAiTask,
  ): Promise<readonly ModelEvaluationResult[]> {
    const catalogEntryId = boundedText(catalogEntryIdValue, "catalog entry id", 128);
    const task = taskValue === undefined ? null : validateTask(taskValue);
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.evaluationResults)
          .filter(
            (result) =>
              result.catalogEntryId === catalogEntryId && (task === null || result.task === task),
          )
          .map((result) => Object.freeze(structuredClone(result)))
          .sort(
            (left, right) =>
              left.task.localeCompare(right.task) ||
              right.scoreBasisPoints - left.scoreBasisPoints ||
              left.latencyP50Ms - right.latencyP50Ms ||
              right.observedAt.localeCompare(left.observedAt) ||
              left.id.localeCompare(right.id),
          ),
      ),
    );
  }

  public recordEvaluationResult(
    input: RecordModelEvaluationResultInput,
  ): Promise<ModelEvaluationResult> {
    return Promise.resolve().then(() => {
      const validated = validateEvaluationResultInput(input);
      if (this.state.catalog[validated.catalogEntryId] === undefined) {
        throw modelHubError("MODEL_HUB_MODEL_NOT_FOUND", "The selected model does not exist.");
      }
      const duplicate = Object.values(this.state.evaluationResults).some(
        (stored) =>
          stored.id === validated.id ||
          (stored.catalogEntryId === validated.catalogEntryId &&
            stored.task === validated.task &&
            stored.evaluationSource === validated.evaluationSource &&
            stored.evaluationVersion === validated.evaluationVersion),
      );
      if (duplicate) {
        throw conflict("MODEL_HUB_EVALUATION_CONFLICT");
      }
      const observedAt = validated.observedAt ?? this.clock.now();
      validateEvaluationExpiry(observedAt, validated.expiresAt);
      const saved: ModelEvaluationResult = Object.freeze({
        id: validated.id,
        catalogEntryId: validated.catalogEntryId,
        task: validated.task,
        scoreBasisPoints: validated.scoreBasisPoints,
        latencyP50Ms: validated.latencyP50Ms,
        sampleCount: validated.sampleCount,
        evaluationSource: validated.evaluationSource,
        evaluationVersion: validated.evaluationVersion,
        observedAt,
        expiresAt: validated.expiresAt,
      });
      this.state.evaluationResults[saved.id] = saved;
      this.commit();
      return saved;
    });
  }

  public listPresets(): Promise<readonly ModelHubPreset[]> {
    return Promise.resolve(
      Object.freeze(
        Object.values(this.state.presets)
          .map((preset) => Object.freeze(structuredClone(preset)))
          .sort(
            (left, right) =>
              Number(right.status === "active") - Number(left.status === "active") ||
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.id.localeCompare(right.id),
          ),
      ),
    );
  }

  public findActivePreset(): Promise<ModelHubPreset | null> {
    const preset = Object.values(this.state.presets)
      .filter(({ status }) => status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return Promise.resolve(preset === undefined ? null : Object.freeze(structuredClone(preset)));
  }

  public savePreset(input: SaveModelHubPresetInput): Promise<ModelHubPreset> {
    return Promise.resolve().then(() => {
      const validated = validatePresetInput(input);
      const existing = this.state.presets[validated.id];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_PRESET_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
      ) {
        throw conflict("MODEL_HUB_PRESET_CONFLICT");
      }
      const now = this.clock.now();
      if (validated.status === "active") {
        for (const [id, preset] of Object.entries(this.state.presets)) {
          if (id !== validated.id && preset.status === "active") {
            this.state.presets[id] = Object.freeze({
              ...preset,
              status: "superseded",
              revision: preset.revision + 1,
              updatedAt: now,
            });
          }
        }
      }
      const saved: ModelHubPreset = Object.freeze({
        id: validated.id,
        scheme: validated.scheme,
        displayName: validated.displayName,
        status: validated.status,
        privacyPolicy: validated.privacyPolicy,
        costPriority: validated.costPriority,
        routeGenerationVersion: validated.routeGenerationVersion,
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.state.presets[saved.id] = saved;
      this.commit();
      return saved;
    });
  }

  public findTaskRoute(taskValue: NovelAiTask): Promise<NovelTaskRoute | null> {
    const task = validateTask(taskValue);
    const route = this.state.routes[task];
    return Promise.resolve(route === undefined ? null : Object.freeze(structuredClone(route)));
  }

  public saveTaskRoute(input: SaveNovelTaskRouteInput): Promise<NovelTaskRoute> {
    return Promise.resolve().then(() => {
      const validated = validateRouteInput(input);
      const existing = this.state.routes[validated.task];
      if (existing === undefined && validated.expectedRevision !== null) {
        throw conflict("MODEL_HUB_ROUTE_CONFLICT");
      }
      if (
        existing !== undefined &&
        (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
      ) {
        throw conflict("MODEL_HUB_ROUTE_CONFLICT");
      }
      for (const id of [validated.primaryCatalogEntryId, validated.fallbackCatalogEntryId]) {
        if (id !== null && this.state.catalog[id]?.availability !== "available") {
          throw modelHubError(
            "MODEL_HUB_MODEL_NOT_AVAILABLE",
            "The selected model is not available.",
          );
        }
      }
      if (validated.privacyPolicy === "local_only") {
        for (const id of [validated.primaryCatalogEntryId, validated.fallbackCatalogEntryId]) {
          if (id === null) {
            continue;
          }
          const privacy = this.state.costPrivacyProfiles[id];
          const catalog = this.state.catalog[id];
          const connection =
            catalog === undefined ? undefined : this.state.connections[catalog.connectionId];
          if (
            privacy?.dataDestination !== "local" ||
            privacy.evidenceSource === "unknown" ||
            connection === undefined ||
            !isLoopbackModelBaseUrl(connection.baseUrl)
          ) {
            throw modelHubError(
              "MODEL_HUB_PRIVACY_BLOCKED",
              "Local-only routes require evidence-confirmed local models.",
            );
          }
        }
      }
      const now = this.clock.now();
      const saved: NovelTaskRoute = Object.freeze({
        task: validated.task,
        primaryCatalogEntryId: validated.primaryCatalogEntryId,
        fallbackCatalogEntryId: validated.fallbackCatalogEntryId,
        presetId: validated.presetId,
        parameterPolicy: JSON.parse(validated.parameterPolicyJson) as Readonly<
          Record<string, unknown>
        >,
        maximumCostMicros: validated.maximumCostMicros,
        currency: validated.currency,
        privacyPolicy: validated.privacyPolicy,
        failurePolicy: validated.failurePolicy,
        routeOrigin: validated.routeOrigin,
        enabled: validated.enabled,
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.state.routes[saved.task] = saved;
      this.commit();
      return saved;
    });
  }

  public deleteTaskRoute(taskValue: NovelAiTask, expectedRevisionValue: number): Promise<void> {
    return Promise.resolve().then(() => {
      const task = validateTask(taskValue);
      const expectedRevision = validateRequiredRevision(expectedRevisionValue);
      const existing = this.state.routes[task];
      if (existing?.revision !== expectedRevision) {
        throw conflict("MODEL_HUB_ROUTE_CONFLICT");
      }
      Reflect.deleteProperty(this.state.routes, task);
      this.commit();
    });
  }

  public applyAutomaticRoutingPlan(
    input: ApplyAutomaticModelHubRoutingPlanInput,
  ): Promise<AppliedAutomaticModelHubRoutingPlan> {
    return Promise.resolve()
      .then(() => {
        const validated = validateAutomaticRoutingPlanInput(input);
        const nextState = structuredClone(this.state);
        const preservedUserRoutes = Object.values(nextState.routes).filter(
          ({ routeOrigin }) => routeOrigin === "user",
        );
        if (
          validated.preset.privacyPolicy === "local_only" &&
          preservedUserRoutes.some(
            ({ privacyPolicy, enabled }) => enabled && privacyPolicy !== "local_only",
          )
        ) {
          throw modelHubError(
            "MODEL_HUB_MANUAL_ROUTE_PRIVACY_CONFLICT",
            "A manual cloud route must be changed or disabled before applying local-only routing.",
          );
        }
        const userTasks = new Set(preservedUserRoutes.map(({ task }) => task));
        for (const route of validated.routes) {
          if (userTasks.has(route.task)) continue;
          assertMemoryRouteCatalogRequirements(nextState, route);
        }

        const now = this.clock.now();
        let changed = false;
        if (validated.preset.status === "active") {
          for (const [id, preset] of Object.entries(nextState.presets)) {
            if (id !== validated.preset.id && preset.status === "active") {
              nextState.presets[id] = Object.freeze({
                ...preset,
                status: "superseded",
                revision: preset.revision + 1,
                updatedAt: now,
              });
              changed = true;
            }
          }
        }

        const existingPreset = nextState.presets[validated.preset.id];
        if (
          existingPreset === undefined ||
          !memoryPresetMatchesAutomaticPlan(existingPreset, validated.preset)
        ) {
          nextState.presets[validated.preset.id] = Object.freeze({
            id: validated.preset.id,
            scheme: validated.preset.scheme,
            displayName: validated.preset.displayName,
            status: validated.preset.status,
            privacyPolicy: validated.preset.privacyPolicy,
            costPriority: validated.preset.costPriority,
            routeGenerationVersion: validated.preset.routeGenerationVersion,
            revision: existingPreset === undefined ? 1 : existingPreset.revision + 1,
            createdAt: existingPreset?.createdAt ?? now,
            updatedAt: now,
          });
          changed = true;
        }

        const desiredByTask = new Map(
          validated.routes.map((route) => [route.task, route] as const),
        );
        for (const [task, existing] of Object.entries(nextState.routes)) {
          if (existing.routeOrigin === "user") {
            desiredByTask.delete(validateTask(task));
            continue;
          }
          const desired = desiredByTask.get(validateTask(task));
          if (desired === undefined) {
            Reflect.deleteProperty(nextState.routes, task);
            changed = true;
            continue;
          }
          if (!memoryRouteMatchesAutomaticPlan(existing, desired, validated.preset.id)) {
            nextState.routes[task] = Object.freeze({
              task: desired.task,
              primaryCatalogEntryId: desired.primaryCatalogEntryId,
              fallbackCatalogEntryId: desired.fallbackCatalogEntryId,
              presetId: validated.preset.id,
              parameterPolicy: JSON.parse(desired.parameterPolicyJson) as Readonly<
                Record<string, unknown>
              >,
              maximumCostMicros: desired.maximumCostMicros,
              currency: desired.currency,
              privacyPolicy: desired.privacyPolicy,
              failurePolicy: desired.failurePolicy,
              routeOrigin: "automatic",
              enabled: desired.enabled,
              revision: existing.revision + 1,
              createdAt: existing.createdAt,
              updatedAt: now,
            });
            changed = true;
          }
          desiredByTask.delete(desired.task);
        }

        for (const desired of desiredByTask.values()) {
          nextState.routes[desired.task] = Object.freeze({
            task: desired.task,
            primaryCatalogEntryId: desired.primaryCatalogEntryId,
            fallbackCatalogEntryId: desired.fallbackCatalogEntryId,
            presetId: validated.preset.id,
            parameterPolicy: JSON.parse(desired.parameterPolicyJson) as Readonly<
              Record<string, unknown>
            >,
            maximumCostMicros: desired.maximumCostMicros,
            currency: desired.currency,
            privacyPolicy: desired.privacyPolicy,
            failurePolicy: desired.failurePolicy,
            routeOrigin: "automatic",
            enabled: desired.enabled,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          changed = true;
        }

        if (changed) {
          this.persist(structuredClone(nextState));
          this.state = nextState;
        }
        const savedPreset = nextState.presets[validated.preset.id];
        if (savedPreset === undefined) {
          throw modelHubError(
            "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
            "The automatic AI routing plan was not persisted.",
          );
        }
        return Object.freeze({
          preset: Object.freeze(structuredClone(savedPreset)),
          routes: Object.freeze(
            Object.values(nextState.routes)
              .sort((left, right) => left.task.localeCompare(right.task))
              .map((route) => Object.freeze(structuredClone(route))),
          ),
          changed,
          preservedUserRouteCount: preservedUserRoutes.length,
        });
      })
      .catch((cause: unknown) => {
        if (cause instanceof ModelHubStoreError) {
          throw cause;
        }
        throw new ModelHubStoreError(
          "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
          "The AI routing plan was not committed; the previous plan remains active.",
          true,
        );
      });
  }

  public listRecentAiFailures(limitValue = 25): Promise<readonly RecentAiFailure[]> {
    return Promise.resolve().then(() => {
      const limit = validateRecentFailureLimit(limitValue);
      const failures: RecentAiFailure[] = [];
      for (const scan of Object.values(this.state.capabilityScans)) {
        if (
          scan === null ||
          (scan.status !== "partial" && scan.status !== "failed") ||
          scan.errorCode === null
        ) {
          continue;
        }
        const catalogEntry = this.state.catalog[scan.catalogEntryId];
        const connection =
          catalogEntry === undefined
            ? undefined
            : this.state.connections[catalogEntry.connectionId];
        if (catalogEntry === undefined || connection === undefined) continue;
        failures.push(
          recentAiFailureFromCapabilityScan(scan, connection, catalogEntry.providerModelId),
        );
      }
      for (const invocation of Object.values(this.state.invocations)) {
        if (
          (invocation.status !== "failed" && invocation.status !== "timed_out") ||
          invocation.errorCode === null ||
          invocation.completedAt === null
        ) {
          continue;
        }
        failures.push(recentAiFailureFromInvocation(invocation));
      }
      failures.sort(
        (left, right) =>
          right.timestamp.localeCompare(left.timestamp) ||
          left.diagnosticId.localeCompare(right.diagnosticId),
      );
      return Object.freeze(failures.slice(0, limit));
    });
  }

  public startInvocation(input: StartModelInvocationInput): Promise<ModelInvocationFact> {
    return Promise.resolve().then(() => {
      const validated = validateInvocationStart(input);
      if (this.state.invocations[validated.id] !== undefined) {
        throw conflict("MODEL_HUB_INVOCATION_CONFLICT");
      }
      const connection = this.state.connections[validated.connectionId];
      if (connection === undefined) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_NOT_FOUND",
          "The provider connection does not exist.",
        );
      }
      if (!connection.enabled) {
        throw modelHubError(
          "MODEL_HUB_CONNECTION_DISABLED",
          "The provider connection is disabled and cannot start a model invocation.",
        );
      }
      const now = this.clock.now();
      const fact: ModelInvocationFact = Object.freeze({
        id: validated.id,
        task: validated.task,
        routeTask: validated.routeTask,
        connectionId: validated.connectionId,
        catalogEntryId: validated.catalogEntryId,
        providerKindSnapshot: validated.providerKindSnapshot,
        modelIdSnapshot: validated.modelIdSnapshot,
        routeReason: validated.routeReason,
        status: "running",
        attempt: validated.attempt,
        fallbackFromInvocationId: validated.fallbackFromInvocationId,
        privacyPolicy: validated.privacyPolicy,
        dataDestination: validated.dataDestination,
        maximumCostMicros: validated.maximumCostMicros,
        currency: validated.currency,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        estimatedCostMicros: null,
        errorCode: null,
        errorSummary: null,
        completion: null,
        failure: null,
        startedAt: now,
        completedAt: null,
        createdAt: now,
        revision: 1,
      });
      this.state.invocations[fact.id] = fact;
      this.commit();
      return fact;
    });
  }

  public findInvocation(idValue: string): Promise<ModelInvocationFact | null> {
    const id = boundedText(idValue, "invocation id", 128);
    const invocation = this.state.invocations[id];
    return Promise.resolve(
      invocation === undefined ? null : Object.freeze(structuredClone(invocation)),
    );
  }

  public finishInvocation(input: FinishModelInvocationInput): Promise<ModelInvocationFact> {
    return Promise.resolve().then(() => {
      const validated = validateInvocationFinish(input);
      const existing = this.state.invocations[validated.id];
      if (existing?.status !== "running" || existing.revision !== validated.expectedRevision) {
        throw conflict("MODEL_HUB_INVOCATION_CONFLICT");
      }
      const fact: ModelInvocationFact = Object.freeze({
        ...existing,
        status: validated.status,
        inputTokens: validated.inputTokens,
        outputTokens: validated.outputTokens,
        cachedInputTokens: validated.cachedInputTokens,
        estimatedCostMicros: validated.estimatedCostMicros,
        currency: validated.currency ?? existing.currency,
        errorCode: validated.errorCode,
        errorSummary: validated.errorSummary,
        completion: validated.completion,
        failure: validated.failure,
        completedAt: this.clock.now(),
        revision: existing.revision + 1,
      });
      this.state.invocations[fact.id] = fact;
      this.commit();
      return fact;
    });
  }

  private commit(): void {
    this.persist(structuredClone(this.state));
  }
}

export const DEVELOPMENT_MODEL_HUB_KEY = "inkshadow.development.model-hub.v1";

interface BrowserModelHubDatabase {
  readonly schemaVersion: 6;
  readonly state: MemoryModelHubState;
}

export class BrowserDevelopmentModelHubStore extends InMemoryModelHubStore {
  public constructor(storage: Storage, clock: Clock) {
    super(clock, readBrowserState(storage), (state) => {
      const database: BrowserModelHubDatabase = { schemaVersion: 6, state };
      storage.setItem(DEVELOPMENT_MODEL_HUB_KEY, JSON.stringify(database));
    });
  }
}

function createEmptyMemoryState(): MemoryModelHubState {
  return {
    connectionCommits: {},
    connections: {},
    catalog: {},
    catalogSyncs: {},
    capabilityEvidence: {},
    capabilityScans: {},
    costPrivacyProfiles: {},
    evaluationResults: {},
    presets: {},
    routes: {},
    invocations: {},
  };
}

function readBrowserState(storage: Storage): MemoryModelHubState {
  const serialized = storage.getItem(DEVELOPMENT_MODEL_HUB_KEY);
  if (serialized === null) {
    return createEmptyMemoryState();
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) {
      throw modelHubError("MODEL_HUB_STORE_CORRUPT", "The browser Model Hub store is corrupt.");
    }
    if (parsed.schemaVersion === 6 && isMemoryState(parsed.state)) {
      return normalizeBrowserExpertOptions(parsed.state, false);
    }
    if (parsed.schemaVersion === 5 && isVersionFiveMemoryState(parsed.state)) {
      return normalizeBrowserExpertOptions(migrateLegacyCapabilityScans(parsed.state), false);
    }
    if (parsed.schemaVersion === 4 && isVersionFourMemoryState(parsed.state)) {
      return normalizeBrowserExpertOptions(
        migrateLegacyCapabilityScans({
          ...parsed.state,
          connectionCommits: {},
        }),
        false,
      );
    }
    if (parsed.schemaVersion === 3 && isVersionFourMemoryState(parsed.state)) {
      return normalizeBrowserExpertOptions(
        migrateLegacyCapabilityScans({ ...parsed.state, connectionCommits: {} }),
        true,
      );
    }
    if (parsed.schemaVersion === 2 && isVersionTwoMemoryState(parsed.state)) {
      return normalizeBrowserExpertOptions(
        migrateLegacyCapabilityScans({
          ...parsed.state,
          connectionCommits: {},
          evaluationResults: {},
        }),
        true,
      );
    }
    if (parsed.schemaVersion === 1 && isLegacyMemoryState(parsed.state)) {
      return normalizeBrowserExpertOptions(
        migrateLegacyCapabilityScans({
          ...parsed.state,
          connectionCommits: {},
          costPrivacyProfiles: {},
          evaluationResults: {},
        }),
        true,
      );
    }
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "The browser Model Hub store is corrupt.");
  } catch (cause: unknown) {
    throw cause instanceof ModelHubStoreError
      ? cause
      : modelHubError("MODEL_HUB_STORE_CORRUPT", "The browser Model Hub store is corrupt.");
  }
}

function normalizeBrowserExpertOptions(
  state: MemoryModelHubState,
  migratingLegacySchema: boolean,
): MemoryModelHubState {
  const connectionCommits = Object.fromEntries(
    Object.entries(state.connectionCommits).map(([key, value]) => {
      if (!isRecord(value) || value.connectionId !== key) {
        throw modelHubError(
          "MODEL_HUB_STORE_CORRUPT",
          "A browser Model Hub connection commit is invalid.",
        );
      }
      const normalized = hydrateConnectionCommit({
        id: value.id,
        connection_id: value.connectionId,
        phase: value.phase,
        credential_provider_id: value.credentialProviderId ?? null,
        cleanup_credential_provider_id: value.cleanupCredentialProviderId ?? null,
        created_at: value.createdAt,
        updated_at: value.updatedAt,
      });
      return [key, normalized];
    }),
  );
  const connections = Object.fromEntries(
    Object.entries(state.connections).map(([key, value]) => {
      if (!isRecord(value) || value.id !== key || !isModelProviderKind(value.providerKind)) {
        throw modelHubError(
          "MODEL_HUB_STORE_CORRUPT",
          "A browser Model Hub connection is invalid.",
        );
      }
      const credentialState = value.credentialState;
      const credentialRequired = getModelProviderPreset(value.providerKind).credentialRequired;
      const legacyAuthentication = credentialRequired
        ? "bearer_keyring"
        : credentialState === "present"
          ? "bearer_keyring"
          : "none";
      const storedAuthentication = value.authenticationMode as
        ModelHubAuthenticationMode | undefined;
      if (!migratingLegacySchema && storedAuthentication === undefined) {
        throw modelHubError(
          "MODEL_HUB_STORE_CORRUPT",
          "A browser Model Hub authentication mode is missing.",
        );
      }
      const validated = validateConnectionInput({
        id: value.id,
        providerKind: value.providerKind,
        displayName: value.displayName,
        region: value.region,
        workspaceId: value.workspaceId,
        endpointId: value.endpointId,
        baseUrlOverride: value.baseUrl,
        credentialRef: value.credentialRef,
        credentialState,
        authenticationMode: storedAuthentication ?? legacyAuthentication,
        credentialHeaderName: value.credentialHeaderName ?? null,
        modelDiscoveryPath: value.modelDiscoveryPath ?? null,
        textGenerationPath: value.textGenerationPath ?? null,
        embeddingPath: value.embeddingPath ?? null,
        ...(typeof value.requestTimeoutMs === "number"
          ? { requestTimeoutMs: value.requestTimeoutMs }
          : {}),
        ...(typeof value.retryLimit === "number" ? { retryLimit: value.retryLimit } : {}),
        legacyProviderId: value.legacyProviderId,
        enabled:
          migratingLegacySchema && credentialRequired && credentialState !== "present"
            ? false
            : value.enabled,
        expectedRevision: value.revision,
      });
      if (
        value.protocol !== validated.protocol ||
        value.baseUrl !== validated.baseUrl ||
        !["not_tested", "checking", "ready", "degraded", "error", "disabled"].includes(
          value.connectionStatus,
        ) ||
        !["never", "syncing", "succeeded", "partial", "failed"].includes(value.catalogSyncStatus)
      ) {
        throw modelHubError(
          "MODEL_HUB_STORE_CORRUPT",
          "Browser Model Hub metadata is inconsistent.",
        );
      }
      const normalized: ModelProviderConnection = Object.freeze({
        id: validated.id,
        providerKind: validated.providerKind,
        displayName: validated.displayName,
        protocol: validated.protocol,
        region: validated.region,
        workspaceId: validated.workspaceId,
        endpointId: validated.endpointId,
        baseUrl: validated.baseUrl,
        credentialRef: validated.credentialRef,
        credentialState: validated.credentialState,
        authenticationMode: validated.authenticationMode,
        credentialHeaderName: validated.credentialHeaderName,
        modelDiscoveryPath: validated.modelDiscoveryPath,
        textGenerationPath: validated.textGenerationPath,
        embeddingPath: validated.embeddingPath,
        requestTimeoutMs: validated.requestTimeoutMs,
        retryLimit: validated.retryLimit,
        connectionStatus: value.connectionStatus,
        catalogSyncStatus: value.catalogSyncStatus,
        lastTestedAt: value.lastTestedAt,
        lastCatalogSyncedAt: value.lastCatalogSyncedAt,
        lastErrorCode: value.lastErrorCode,
        lastErrorSummary: value.lastErrorSummary,
        legacyProviderId: validated.legacyProviderId,
        enabled: validated.enabled,
        revision: validated.expectedRevision ?? 1,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
      return [key, normalized];
    }),
  );
  const capabilityScans = Object.fromEntries(
    Object.entries(state.capabilityScans).map(([key, value]) => [
      key,
      value === null ? null : normalizeStoredCapabilityScanFact(key, value),
    ]),
  );
  return { ...state, connectionCommits, connections, capabilityScans };
}

type VersionFiveMemoryState = Omit<MemoryModelHubState, "capabilityScans"> & {
  readonly capabilityScanIds: Record<string, true>;
};
type VersionFourMemoryState = Omit<VersionFiveMemoryState, "connectionCommits">;
type VersionTwoMemoryState = Omit<VersionFourMemoryState, "evaluationResults">;
type LegacyMemoryState = Omit<VersionTwoMemoryState, "costPrivacyProfiles">;

function isMemoryState(value: unknown): value is MemoryModelHubState {
  if (!hasLegacyMemoryCollections(value)) return false;
  return (
    isRecord(value.connectionCommits) &&
    isRecord(value.costPrivacyProfiles) &&
    isRecord(value.evaluationResults) &&
    isRecord(value.capabilityScans) &&
    Object.values(value.capabilityScans).every(
      (scan) => scan === null || isStoredCapabilityScanFact(scan),
    )
  );
}

function isVersionFiveMemoryState(value: unknown): value is VersionFiveMemoryState {
  return (
    isVersionFourMemoryState(value) &&
    isRecord((value as Record<string, unknown>).connectionCommits)
  );
}

function isVersionFourMemoryState(value: unknown): value is VersionFourMemoryState {
  return (
    isVersionTwoMemoryState(value) && isRecord((value as Record<string, unknown>).evaluationResults)
  );
}

function isVersionTwoMemoryState(value: unknown): value is VersionTwoMemoryState {
  return (
    isLegacyMemoryState(value) && isRecord((value as Record<string, unknown>).costPrivacyProfiles)
  );
}

function isLegacyMemoryState(value: unknown): value is LegacyMemoryState {
  return hasLegacyMemoryCollections(value) && isRecord(value.capabilityScanIds);
}

function hasLegacyMemoryCollections(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return [
    value.connections,
    value.catalog,
    value.catalogSyncs,
    value.capabilityEvidence,
    value.presets,
    value.routes,
    value.invocations,
  ].every(isRecord);
}

function migrateLegacyCapabilityScans(state: VersionFiveMemoryState): MemoryModelHubState {
  const { capabilityScanIds, ...current } = state;
  return {
    ...current,
    capabilityScans: Object.fromEntries(
      Object.keys(capabilityScanIds).map((scanId) => [scanId, null]),
    ),
  };
}

function isStoredCapabilityScanFact(value: unknown): value is ModelCapabilityScanFact {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.catalogEntryId === "string" &&
    typeof value.scanKind === "string" &&
    typeof value.status === "string" &&
    (value.errorCode === null || typeof value.errorCode === "string") &&
    typeof value.requestedAt === "string" &&
    typeof value.completedAt === "string" &&
    (value.failure === undefined || value.failure === null || isRecord(value.failure))
  );
}

function normalizeStoredCapabilityScanFact(
  key: string,
  value: Omit<ModelCapabilityScanFact, "failure"> & {
    readonly failure?: SafeModelFailureMetadata | null;
  },
): ModelCapabilityScanFact {
  if (
    value.id !== key ||
    !["provider_metadata", "official_preset", "lightweight_probe", "user_review"].includes(
      value.scanKind,
    ) ||
    !["succeeded", "partial", "failed"].includes(value.status)
  ) {
    throw modelHubError(
      "MODEL_HUB_STORE_CORRUPT",
      "A browser Model Hub capability scan is invalid.",
    );
  }
  const errorCode = validateNullableErrorCode(value.errorCode);
  if ((value.status === "partial" || value.status === "failed") !== (errorCode !== null)) {
    throw modelHubError(
      "MODEL_HUB_STORE_CORRUPT",
      "A browser Model Hub capability scan has inconsistent failure state.",
    );
  }
  return Object.freeze({
    id: boundedText(value.id, "capability scan id", 128),
    catalogEntryId: boundedText(value.catalogEntryId, "catalog entry id", 128),
    scanKind: value.scanKind,
    status: value.status,
    errorCode,
    requestedAt: requireIsoTimestamp(value.requestedAt, "capability scan request timestamp"),
    completedAt: requireIsoTimestamp(value.completedAt, "capability scan completion timestamp"),
    failure:
      value.failure === undefined || value.failure === null
        ? null
        : validateSafeAiFailureMetadata(value.failure),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ModelHubStoreError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ModelHubStoreError";
  }
}

function validateConnectionInput(input: SaveModelProviderConnectionInput) {
  if (!isModelProviderKind(input.providerKind)) {
    throw modelHubError("MODEL_HUB_CONNECTION_INVALID", "The provider kind is invalid.");
  }
  const preset = getModelProviderPreset(input.providerKind);
  if (!(["missing", "present", "unavailable"] as const).includes(input.credentialState)) {
    throw modelHubError("MODEL_HUB_CONNECTION_INVALID", "The credential state is invalid.");
  }
  const credentialRef = optionalText(input.credentialRef, "credential reference", 256);
  if (input.credentialState === "present" && credentialRef === null) {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_REFERENCE_REQUIRED",
      "A present credential must be represented by an opaque vault reference.",
    );
  }
  const authenticationModeValue: unknown =
    input.authenticationMode ?? (input.credentialState === "present" ? "bearer_keyring" : "none");
  if (
    authenticationModeValue !== "none" &&
    authenticationModeValue !== "bearer_keyring" &&
    authenticationModeValue !== "custom_header_keyring"
  ) {
    throw modelHubError("MODEL_HUB_AUTHENTICATION_INVALID", "The authentication mode is invalid.");
  }
  const authenticationMode: ModelHubAuthenticationMode = authenticationModeValue;
  const credentialHeaderName = normalizeCredentialHeaderName(input.credentialHeaderName);
  const modelDiscoveryPath = normalizeModelHubApiPath(
    input.modelDiscoveryPath,
    "Model discovery path",
  );
  const textGenerationPath = normalizeModelHubApiPath(
    input.textGenerationPath,
    "Text generation path",
  );
  const embeddingPath = normalizeModelHubApiPath(input.embeddingPath, "Embedding path");
  const isCustom = input.providerKind === "custom_openai_compatible";
  if (
    !isCustom &&
    (authenticationMode === "custom_header_keyring" ||
      credentialHeaderName !== null ||
      modelDiscoveryPath !== null ||
      textGenerationPath !== null ||
      embeddingPath !== null)
  ) {
    throw modelHubError(
      "MODEL_HUB_EXPERT_OPTIONS_FORBIDDEN",
      "API path and custom Header overrides are only available for custom OpenAI-compatible connections.",
    );
  }
  if ((authenticationMode === "custom_header_keyring") !== (credentialHeaderName !== null)) {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_HEADER_REQUIRED",
      "A custom authentication mode requires exactly one safe credential Header name.",
    );
  }
  if (input.credentialState === "present" && authenticationMode === "none") {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_UNUSED",
      "A connection cannot declare a stored credential while authentication is disabled.",
    );
  }
  if (
    authenticationMode === "custom_header_keyring" &&
    (input.credentialState !== "present" || credentialRef === null)
  ) {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_REQUIRED",
      "Custom Header authentication requires a credential stored in the operating-system vault.",
    );
  }
  const enabled = input.enabled ?? true;
  if (
    enabled &&
    authenticationMode !== "none" &&
    (input.credentialState !== "present" || credentialRef === null)
  ) {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_REQUIRED",
      "An authenticated connection requires a credential stored in the operating-system vault before it can be enabled.",
    );
  }
  if (
    preset.credentialRequired &&
    (authenticationMode !== "bearer_keyring" ||
      (enabled && (input.credentialState !== "present" || credentialRef === null)))
  ) {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_REQUIRED",
      "This provider requires keyring authentication before the connection can be enabled.",
    );
  }
  return Object.freeze({
    id: boundedText(input.id, "connection id", 128),
    providerKind: input.providerKind,
    displayName: boundedText(input.displayName, "display name", 160),
    protocol: preset.protocol,
    region: optionalText(input.region, "region", 128),
    workspaceId: optionalText(input.workspaceId, "workspace id", 256),
    endpointId: optionalText(input.endpointId, "endpoint id", 512),
    baseUrl: resolveProviderBaseUrl(input.providerKind, {
      region: input.region,
      workspaceId: input.workspaceId,
      baseUrlOverride: input.baseUrlOverride,
    }),
    credentialRef,
    credentialState: input.credentialState,
    authenticationMode,
    credentialHeaderName,
    modelDiscoveryPath,
    textGenerationPath,
    embeddingPath,
    requestTimeoutMs: normalizeModelHubRequestTimeoutMs(input.requestTimeoutMs),
    retryLimit: normalizeModelHubRetryLimit(input.retryLimit),
    legacyProviderId: optionalText(input.legacyProviderId, "legacy provider id", 128),
    enabled,
    expectedRevision: validateExpectedRevision(input.expectedRevision),
  });
}

function validateConnectionTestInput(input: RecordConnectionTestInput) {
  const errorCode = optionalText(input.errorCode, "connection error code", 128);
  if ((input.status === "degraded" || input.status === "error") && errorCode === null) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_TEST_INVALID",
      "A degraded or failed connection test requires an error code.",
    );
  }
  if (input.status === "ready" && errorCode !== null) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_TEST_INVALID",
      "A successful connection test cannot retain an error code.",
    );
  }
  return Object.freeze({
    connectionId: boundedText(input.connectionId, "connection id", 128),
    status: input.status,
    errorCode,
    errorSummary: safeDiagnosticText(input.errorSummary, "connection error summary", 1000),
    expectedRevision: validateExpectedRevision(input.expectedRevision) ?? 0,
  });
}

function validateCatalogInput(input: SyncModelCatalogInput) {
  const seen = new Set<string>();
  const models = input.models.map((model) => {
    const providerModelId = boundedText(model.providerModelId, "provider model id", 512);
    if (seen.has(providerModelId)) {
      throw modelHubError("MODEL_HUB_CATALOG_DUPLICATE", "A discovery result repeated a model id.");
    }
    seen.add(providerModelId);
    return Object.freeze({
      id: boundedText(model.id, "catalog entry id", 128),
      providerModelId,
      displayName: optionalText(model.displayName, "model display name", 512) ?? providerModelId,
      ownedBy: optionalText(model.ownedBy, "model owner", 256),
      lifecycle: model.lifecycle ?? "unknown",
      inputTokenLimit: optionalPositiveInteger(model.inputTokenLimit),
      outputTokenLimit: optionalPositiveInteger(model.outputTokenLimit),
      staleAfter: optionalText(model.staleAfter, "stale timestamp", 64),
    });
  });
  const errorCode = optionalText(input.errorCode, "sync error code", 128);
  if ((input.status === "partial" || input.status === "failed") && errorCode === null) {
    throw modelHubError(
      "MODEL_HUB_SYNC_ERROR_REQUIRED",
      "A partial or failed sync requires an error code.",
    );
  }
  if (input.status === "failed" && models.length !== 0) {
    throw modelHubError(
      "MODEL_HUB_SYNC_INVALID",
      "A failed sync cannot publish a model catalog result.",
    );
  }
  return Object.freeze({
    syncId: boundedText(input.syncId, "sync id", 128),
    connectionId: boundedText(input.connectionId, "connection id", 128),
    source: input.source,
    status: input.status,
    models,
    nextPageTokenPresent: input.nextPageTokenPresent ?? false,
    errorCode,
    errorSummary: safeDiagnosticText(input.errorSummary, "sync error summary", 1000),
    startedAt: optionalText(input.startedAt, "sync start timestamp", 64),
  });
}

function validatePrepareConnectionCommitInput(input: PrepareModelHubConnectionCommitInput) {
  return Object.freeze({
    id: boundedText(input.id, "connection commit id", 128),
    connectionId: boundedText(input.connectionId, "connection commit connection id", 128),
    credentialProviderId: optionalCredentialProviderId(input.credentialProviderId),
  });
}

function validatePublishConnectionCommitInput(input: PublishModelHubConnectionCommitInput) {
  const id = boundedText(input.id, "connection commit id", 128);
  const connection = validateConnectionInput(input.connection);
  const catalog = validateCatalogInput(input.catalog);
  const credentialProviderId = optionalCredentialProviderId(input.credentialProviderId);
  const cleanupCredentialProviderId = optionalCredentialProviderId(
    input.cleanupCredentialProviderId,
  );
  if (!connection.enabled || catalog.connectionId !== connection.id) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_COMMIT_INVALID",
      "A connection commit must publish one enabled connection and its own catalog.",
    );
  }
  if (catalog.status !== "succeeded" || catalog.models.length === 0) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_COMMIT_CATALOG_EMPTY",
      "A verified connection commit requires a successful non-empty catalog.",
    );
  }
  if (
    credentialProviderId !== null &&
    connection.credentialRef !== `keyring:model-hub:${credentialProviderId}`
  ) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_COMMIT_CREDENTIAL_MISMATCH",
      "The prepared credential slot does not match the connection credential reference.",
    );
  }
  if (
    cleanupCredentialProviderId !== null &&
    cleanupCredentialProviderId === credentialProviderId
  ) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_COMMIT_CREDENTIAL_MISMATCH",
      "The active credential slot cannot also be scheduled for cleanup.",
    );
  }
  return Object.freeze({
    id,
    connection,
    catalog,
    credentialProviderId,
    cleanupCredentialProviderId,
  });
}

function validatePublishCredentialCommitInput(input: PublishModelHubCredentialCommitInput) {
  const id = boundedText(input.id, "connection commit id", 128);
  const connection = validateConnectionInput(input.connection);
  const credentialProviderId = optionalCredentialProviderId(input.credentialProviderId);
  const cleanupCredentialProviderId = optionalCredentialProviderId(
    input.cleanupCredentialProviderId,
  );
  if (
    credentialProviderId !== null &&
    connection.credentialRef !== `keyring:model-hub:${credentialProviderId}`
  ) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_COMMIT_CREDENTIAL_MISMATCH",
      "The prepared credential slot does not match the connection credential reference.",
    );
  }
  if (
    cleanupCredentialProviderId !== null &&
    cleanupCredentialProviderId === credentialProviderId
  ) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_COMMIT_CREDENTIAL_MISMATCH",
      "The active credential slot cannot also be scheduled for cleanup.",
    );
  }
  return Object.freeze({
    id,
    connection,
    credentialProviderId,
    cleanupCredentialProviderId,
  });
}

function optionalCredentialProviderId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(normalized)) {
    throw modelHubError(
      "MODEL_HUB_CREDENTIAL_PROVIDER_ID_INVALID",
      "The credential provider identifier is invalid.",
    );
  }
  return normalized;
}

function validateCapabilityScanInput(input: RecordCapabilityScanInput) {
  const evidence = (input.evidence ?? []).map((item) => {
    if (!isModelHubCapability(item.capability)) {
      throw modelHubError("MODEL_HUB_CAPABILITY_INVALID", "The model capability is invalid.");
    }
    return Object.freeze({
      id: boundedText(item.id, "capability evidence id", 128),
      capability: item.capability,
      verdict: item.verdict,
      evidenceSource: item.evidenceSource,
      evidenceSummary: optionalText(item.evidenceSummary, "capability evidence summary", 1000),
      expiresAt: optionalText(item.expiresAt, "capability evidence expiry", 64),
    });
  });
  const unique = new Set(
    evidence.map(({ capability, evidenceSource }) => `${capability}:${evidenceSource}`),
  );
  if (unique.size !== evidence.length) {
    throw modelHubError(
      "MODEL_HUB_CAPABILITY_DUPLICATE",
      "A capability scan repeated the same capability evidence source.",
    );
  }
  const errorCode = optionalText(input.errorCode, "capability scan error code", 128);
  if ((input.status === "partial" || input.status === "failed") && errorCode === null) {
    throw modelHubError(
      "MODEL_HUB_CAPABILITY_ERROR_REQUIRED",
      "A partial or failed capability scan requires an error code.",
    );
  }
  if (input.status === "succeeded" && errorCode !== null) {
    throw modelHubError(
      "MODEL_HUB_CAPABILITY_SCAN_INVALID",
      "A successful capability scan cannot contain an error code.",
    );
  }
  if (input.status === "failed" && evidence.length !== 0) {
    throw modelHubError(
      "MODEL_HUB_CAPABILITY_SCAN_INVALID",
      "A failed capability scan cannot publish evidence.",
    );
  }
  const failure =
    input.failure === undefined || input.failure === null
      ? null
      : validateSafeAiFailureMetadata(input.failure);
  if (input.status === "succeeded" && failure !== null) {
    throw modelHubError(
      "MODEL_HUB_CAPABILITY_SCAN_INVALID",
      "A successful capability scan cannot contain failure metadata.",
    );
  }
  return Object.freeze({
    scanId: boundedText(input.scanId, "capability scan id", 128),
    catalogEntryId: boundedText(input.catalogEntryId, "catalog entry id", 128),
    scanKind: input.scanKind,
    status: input.status,
    evidenceVersion: boundedText(input.evidenceVersion, "evidence version", 128),
    evidence,
    supportedCount: evidence.filter(({ verdict }) => verdict === "supported").length,
    unsupportedCount: evidence.filter(({ verdict }) => verdict === "unsupported").length,
    unknownCount: evidence.filter(({ verdict }) => verdict === "unknown").length,
    errorCode,
    errorSummary: safeDiagnosticText(input.errorSummary, "capability scan error summary", 1000),
    requestedAt: optionalText(input.requestedAt, "capability scan request timestamp", 64),
    failure,
  });
}

function validateCapabilityProbeCommitInput(input: CommitCapabilityProbeResultInput) {
  const connectionId = boundedText(input.connectionId, "connection id", 128);
  const catalogEntryId = boundedText(input.catalogEntryId, "catalog entry id", 128);
  const scan = validateCapabilityScanInput(input.scan);
  if (scan.catalogEntryId !== catalogEntryId) {
    throw modelHubError(
      "MODEL_HUB_PROBE_TARGET_INVALID",
      "The capability scan does not belong to the guarded catalog entry.",
    );
  }
  const connectionTest =
    input.connectionTest === null || input.connectionTest === undefined
      ? null
      : validateConnectionTestInput({
          ...input.connectionTest,
          connectionId,
          expectedRevision: input.expectedConnectionRevision,
        });
  return Object.freeze({
    connectionId,
    expectedConnectionRevision: validateRequiredRevision(input.expectedConnectionRevision),
    catalogEntryId,
    expectedCatalogRevision: validateRequiredRevision(input.expectedCatalogRevision),
    expectedProviderModelId: boundedText(input.expectedProviderModelId, "provider model id", 512),
    scan,
    connectionTest,
  });
}

function validatePresetInput(input: SaveModelHubPresetInput) {
  if (!(MODEL_HUB_SCHEMES as readonly string[]).includes(input.scheme)) {
    throw modelHubError("MODEL_HUB_PRESET_INVALID", "The model preset scheme is invalid.");
  }
  return Object.freeze({
    id: boundedText(input.id, "model preset id", 128),
    scheme: input.scheme,
    displayName: boundedText(input.displayName, "model preset display name", 160),
    status: input.status,
    privacyPolicy: input.privacyPolicy,
    costPriority: input.costPriority,
    routeGenerationVersion: boundedText(
      input.routeGenerationVersion,
      "route generation version",
      128,
    ),
    expectedRevision: validateExpectedRevision(input.expectedRevision),
  });
}

function validateCostPrivacyProfileInput(input: SaveModelCostPrivacyProfileInput) {
  const inputPrice = validateMicros(input.inputMicrosPerMillionTokens ?? null);
  const outputPrice = validateMicros(input.outputMicrosPerMillionTokens ?? null);
  const cachedPrice = validateMicros(input.cachedInputMicrosPerMillionTokens ?? null);
  const currency = validateCurrency(input.currency ?? null);
  const pricingVersion = optionalText(input.pricingVersion, "pricing version", 128);
  const priceUpdatedAt = optionalText(input.priceUpdatedAt, "price update timestamp", 64);
  const hasPricing = inputPrice !== null || outputPrice !== null || cachedPrice !== null;
  if (
    hasPricing !==
      (inputPrice !== null &&
        outputPrice !== null &&
        currency !== null &&
        pricingVersion !== null &&
        priceUpdatedAt !== null) ||
    (!hasPricing && (currency !== null || pricingVersion !== null || priceUpdatedAt !== null))
  ) {
    throw modelHubError(
      "MODEL_HUB_COST_PROFILE_INVALID",
      "Known pricing requires input/output prices, currency, version, and update time.",
    );
  }
  if (!("local remote unknown".split(" ") as readonly string[]).includes(input.dataDestination)) {
    throw modelHubError("MODEL_HUB_PRIVACY_PROFILE_INVALID", "The data destination is invalid.");
  }
  if (
    !("none temporary provider_default unknown".split(" ") as readonly string[]).includes(
      input.retentionPolicy,
    )
  ) {
    throw modelHubError("MODEL_HUB_PRIVACY_PROFILE_INVALID", "The retention policy is invalid.");
  }
  if (
    !(
      "not_used opt_out may_be_used provider_default unknown".split(" ") as readonly string[]
    ).includes(input.trainingPolicy)
  ) {
    throw modelHubError("MODEL_HUB_PRIVACY_PROFILE_INVALID", "The training policy is invalid.");
  }
  if (
    !(
      "provider_metadata official_preset provider_policy user_confirmed legacy unknown".split(
        " ",
      ) as readonly string[]
    ).includes(input.evidenceSource)
  ) {
    throw modelHubError("MODEL_HUB_PRIVACY_PROFILE_INVALID", "The evidence source is invalid.");
  }
  return Object.freeze({
    catalogEntryId: boundedText(input.catalogEntryId, "catalog entry id", 128),
    currency,
    inputMicrosPerMillionTokens: inputPrice,
    outputMicrosPerMillionTokens: outputPrice,
    cachedInputMicrosPerMillionTokens: cachedPrice,
    pricingVersion,
    priceUpdatedAt,
    dataDestination: input.dataDestination,
    retentionPolicy: input.retentionPolicy,
    trainingPolicy: input.trainingPolicy,
    evidenceSource: input.evidenceSource,
    evidenceVersion: optionalText(input.evidenceVersion, "evidence version", 128),
    evidenceSummary: safeDiagnosticText(input.evidenceSummary, "evidence summary", 1000),
    expectedRevision: validateExpectedRevision(input.expectedRevision),
  });
}

function validateEvaluationResultInput(input: RecordModelEvaluationResultInput) {
  if (
    !Number.isSafeInteger(input.scoreBasisPoints) ||
    input.scoreBasisPoints < 0 ||
    input.scoreBasisPoints > 10_000
  ) {
    throw modelHubError("MODEL_HUB_EVALUATION_INVALID", "The evaluation score is invalid.");
  }
  if (
    !Number.isSafeInteger(input.latencyP50Ms) ||
    input.latencyP50Ms < 0 ||
    input.latencyP50Ms > 86_400_000
  ) {
    throw modelHubError("MODEL_HUB_EVALUATION_INVALID", "The evaluation latency is invalid.");
  }
  if (
    !Number.isSafeInteger(input.sampleCount) ||
    input.sampleCount < 1 ||
    input.sampleCount > 1_000_000
  ) {
    throw modelHubError("MODEL_HUB_EVALUATION_INVALID", "The evaluation sample count is invalid.");
  }
  if (
    !(
      "official_benchmark local_evaluation user_feedback imported legacy".split(
        " ",
      ) as readonly string[]
    ).includes(input.evaluationSource)
  ) {
    throw modelHubError("MODEL_HUB_EVALUATION_INVALID", "The evaluation source is invalid.");
  }
  return Object.freeze({
    id: boundedText(input.id, "evaluation result id", 128),
    catalogEntryId: boundedText(input.catalogEntryId, "catalog entry id", 128),
    task: validateTask(input.task),
    scoreBasisPoints: input.scoreBasisPoints,
    latencyP50Ms: input.latencyP50Ms,
    sampleCount: input.sampleCount,
    evaluationSource: input.evaluationSource,
    evaluationVersion: boundedText(input.evaluationVersion, "evaluation version", 128),
    observedAt: optionalIsoTimestamp(input.observedAt, "evaluation observation time"),
    expiresAt: optionalIsoTimestamp(input.expiresAt, "evaluation expiry time"),
  });
}

function validateEvaluationExpiry(observedAt: string, expiresAt: string | null): void {
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw modelHubError(
      "MODEL_HUB_EVALUATION_INVALID",
      "The evaluation expiry must be later than its observation time.",
    );
  }
}

function validateRouteInput(input: SaveNovelTaskRouteInput) {
  const primary = boundedText(input.primaryCatalogEntryId, "primary catalog entry id", 128);
  const fallback = optionalText(input.fallbackCatalogEntryId, "fallback catalog entry id", 128);
  if (fallback === primary) {
    throw modelHubError("MODEL_HUB_ROUTE_INVALID", "Primary and fallback models must differ.");
  }
  if (input.failurePolicy === "use_fallback" && fallback === null) {
    throw modelHubError(
      "MODEL_HUB_ROUTE_INVALID",
      "A fallback failure policy requires a fallback model.",
    );
  }
  const policy = input.parameterPolicy ?? {};
  if (containsProhibitedKey(policy)) {
    throw modelHubError(
      "MODEL_HUB_ROUTE_SECRET_REJECTED",
      "Task parameter policies cannot contain credentials or content payloads.",
    );
  }
  const parameterPolicyJson = JSON.stringify(policy);
  if (parameterPolicyJson.length > 16_000) {
    throw modelHubError("MODEL_HUB_ROUTE_INVALID", "The task parameter policy is too large.");
  }
  const maximumCostMicros = validateMicros(input.maximumCostMicros ?? null);
  const currency = validateCurrency(input.currency ?? null);
  if ((maximumCostMicros === null) !== (currency === null)) {
    throw modelHubError(
      "MODEL_HUB_ROUTE_INVALID",
      "A cost limit and currency must be set together.",
    );
  }
  return Object.freeze({
    task: validateTask(input.task),
    primaryCatalogEntryId: primary,
    fallbackCatalogEntryId: fallback,
    presetId: optionalText(input.presetId, "preset id", 128),
    parameterPolicyJson,
    maximumCostMicros,
    currency,
    privacyPolicy: input.privacyPolicy,
    failurePolicy: input.failurePolicy,
    routeOrigin: input.routeOrigin,
    enabled: input.enabled ?? true,
    expectedRevision: validateExpectedRevision(input.expectedRevision),
  });
}

function validateAutomaticRoutingPlanInput(input: ApplyAutomaticModelHubRoutingPlanInput) {
  const preset = validatePresetInput({ ...input.preset, expectedRevision: null });
  if (preset.scheme === "custom" || preset.status !== "active") {
    throw modelHubError(
      "MODEL_HUB_ROUTING_PLAN_INVALID",
      "An automatic AI routing plan requires an active automatic preset.",
    );
  }
  const seenTasks = new Set<NovelAiTask>();
  const routes = input.routes.map((route) => {
    const validated = validateRouteInput({
      ...route,
      presetId: preset.id,
      routeOrigin: "automatic",
      expectedRevision: null,
    });
    if (seenTasks.has(validated.task)) {
      throw modelHubError(
        "MODEL_HUB_ROUTING_PLAN_INVALID",
        "An automatic AI routing plan cannot contain duplicate tasks.",
      );
    }
    if (validated.privacyPolicy !== preset.privacyPolicy) {
      throw modelHubError(
        "MODEL_HUB_ROUTING_PLAN_INVALID",
        "Every automatic task route must use the preset privacy policy.",
      );
    }
    seenTasks.add(validated.task);
    return validated;
  });
  return Object.freeze({ preset, routes: Object.freeze(routes) });
}

function presetRowMatchesAutomaticPlan(
  existing: PresetRow,
  desired: ReturnType<typeof validatePresetInput>,
): boolean {
  return (
    existing.scheme === desired.scheme &&
    existing.display_name === desired.displayName &&
    existing.status === desired.status &&
    existing.privacy_policy === desired.privacyPolicy &&
    existing.cost_priority === desired.costPriority &&
    existing.route_generation_version === desired.routeGenerationVersion
  );
}

function memoryPresetMatchesAutomaticPlan(
  existing: ModelHubPreset,
  desired: ReturnType<typeof validatePresetInput>,
): boolean {
  return (
    existing.scheme === desired.scheme &&
    existing.displayName === desired.displayName &&
    existing.status === desired.status &&
    existing.privacyPolicy === desired.privacyPolicy &&
    existing.costPriority === desired.costPriority &&
    existing.routeGenerationVersion === desired.routeGenerationVersion
  );
}

type ValidatedNovelTaskRoute = ReturnType<typeof validateRouteInput>;

function routeRowMatchesAutomaticPlan(
  existing: RouteRow,
  desired: ValidatedNovelTaskRoute,
  presetId: string,
): boolean {
  return (
    existing.primary_catalog_entry_id === desired.primaryCatalogEntryId &&
    existing.fallback_catalog_entry_id === desired.fallbackCatalogEntryId &&
    existing.preset_id === presetId &&
    existing.parameter_policy_json === desired.parameterPolicyJson &&
    existing.maximum_cost_micros === desired.maximumCostMicros &&
    existing.currency === desired.currency &&
    existing.privacy_policy === desired.privacyPolicy &&
    existing.failure_policy === desired.failurePolicy &&
    existing.route_origin === "automatic" &&
    existing.enabled === (desired.enabled ? 1 : 0)
  );
}

function memoryRouteMatchesAutomaticPlan(
  existing: NovelTaskRoute,
  desired: ValidatedNovelTaskRoute,
  presetId: string,
): boolean {
  return (
    existing.primaryCatalogEntryId === desired.primaryCatalogEntryId &&
    existing.fallbackCatalogEntryId === desired.fallbackCatalogEntryId &&
    existing.presetId === presetId &&
    JSON.stringify(existing.parameterPolicy) === desired.parameterPolicyJson &&
    existing.maximumCostMicros === desired.maximumCostMicros &&
    existing.currency === desired.currency &&
    existing.privacyPolicy === desired.privacyPolicy &&
    existing.failurePolicy === desired.failurePolicy &&
    existing.routeOrigin === "automatic" &&
    existing.enabled === desired.enabled
  );
}

function assertMemoryRouteCatalogRequirements(
  state: MemoryModelHubState,
  route: Readonly<{
    primaryCatalogEntryId: string;
    fallbackCatalogEntryId: string | null;
    privacyPolicy: ModelHubPrivacyPolicy;
  }>,
): void {
  for (const id of [route.primaryCatalogEntryId, route.fallbackCatalogEntryId]) {
    if (id === null) continue;
    const catalog = state.catalog[id];
    if (catalog?.availability !== "available") {
      throw modelHubError("MODEL_HUB_MODEL_NOT_AVAILABLE", "The selected model is not available.");
    }
    if (route.privacyPolicy !== "local_only") continue;
    const privacy = state.costPrivacyProfiles[id];
    const connection = state.connections[catalog.connectionId];
    if (
      privacy?.dataDestination !== "local" ||
      privacy.evidenceSource === "unknown" ||
      connection === undefined ||
      !isLoopbackModelBaseUrl(connection.baseUrl)
    ) {
      throw modelHubError(
        "MODEL_HUB_PRIVACY_BLOCKED",
        "Local-only routes require evidence-confirmed local models.",
      );
    }
  }
}

function validateInvocationStart(input: StartModelInvocationInput) {
  if (!isModelProviderKind(input.providerKindSnapshot)) {
    throw modelHubError("MODEL_HUB_INVOCATION_INVALID", "The provider snapshot is invalid.");
  }
  if (input.privacyPolicy === "local_only" && input.dataDestination !== "local") {
    throw modelHubError(
      "MODEL_HUB_PRIVACY_BLOCKED",
      "Local-only tasks cannot use a remote destination.",
    );
  }
  const maximumCostMicros = validateMicros(input.maximumCostMicros ?? null);
  const currency = validateCurrency(input.currency ?? null);
  if (maximumCostMicros !== null && currency === null) {
    throw modelHubError("MODEL_HUB_INVOCATION_INVALID", "A cost ceiling requires a currency.");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 100) {
    throw modelHubError("MODEL_HUB_INVOCATION_INVALID", "The invocation attempt is invalid.");
  }
  return Object.freeze({
    id: boundedText(input.id, "invocation id", 128),
    task: validateTask(input.task),
    routeTask:
      input.routeTask === undefined || input.routeTask === null
        ? null
        : validateTask(input.routeTask),
    connectionId: boundedText(input.connectionId, "connection id", 128),
    catalogEntryId: optionalText(input.catalogEntryId, "catalog entry id", 128),
    providerKindSnapshot: input.providerKindSnapshot,
    modelIdSnapshot: boundedText(input.modelIdSnapshot, "model id", 512),
    routeReason: input.routeReason,
    attempt: input.attempt,
    fallbackFromInvocationId: optionalText(
      input.fallbackFromInvocationId,
      "fallback invocation id",
      128,
    ),
    privacyPolicy: input.privacyPolicy,
    dataDestination: input.dataDestination,
    maximumCostMicros,
    currency,
  });
}

function validateInvocationFinish(input: FinishModelInvocationInput) {
  const errorCode = optionalText(input.errorCode, "invocation error code", 128);
  if ((input.status === "failed" || input.status === "timed_out") && errorCode === null) {
    throw modelHubError(
      "MODEL_HUB_INVOCATION_INVALID",
      "Failed invocations require an error code.",
    );
  }
  if (input.status !== "failed" && input.status !== "timed_out" && errorCode !== null) {
    throw modelHubError(
      "MODEL_HUB_INVOCATION_INVALID",
      "Successful or cancelled invocations cannot have an error code.",
    );
  }
  const failure =
    input.failure === undefined || input.failure === null
      ? null
      : validateSafeAiFailureMetadata(input.failure);
  const completion =
    input.completion === undefined || input.completion === null
      ? null
      : validateSafeAiCompletionMetadata(input.completion);
  if (input.status !== "failed" && input.status !== "timed_out" && failure !== null) {
    throw modelHubError(
      "MODEL_HUB_INVOCATION_INVALID",
      "Successful or cancelled invocations cannot contain failure metadata.",
    );
  }
  if (input.status !== "succeeded" && completion !== null) {
    throw modelHubError(
      "MODEL_HUB_INVOCATION_INVALID",
      "Only successful invocations can contain completion metadata.",
    );
  }
  return Object.freeze({
    id: boundedText(input.id, "invocation id", 128),
    status: input.status,
    inputTokens: optionalNonNegativeInteger(input.inputTokens),
    outputTokens: optionalNonNegativeInteger(input.outputTokens),
    cachedInputTokens: optionalNonNegativeInteger(input.cachedInputTokens),
    estimatedCostMicros: validateMicros(input.estimatedCostMicros ?? null),
    currency: validateCurrency(input.currency ?? null),
    errorCode,
    errorSummary: safeDiagnosticText(input.errorSummary, "invocation error summary", 1000),
    completion,
    failure,
    expectedRevision: validateExpectedRevision(input.expectedRevision) ?? 0,
  });
}

async function findConnectionRow(
  executor: TransactionExecutor,
  id: string,
): Promise<ConnectionRow | null> {
  const rows = await executor.select<ConnectionRow>(`${CONNECTION_SELECT} WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

async function findConnectionCommitRow(
  executor: TransactionExecutor,
  connectionId: string,
): Promise<ConnectionCommitRow | null> {
  const rows = await executor.select<ConnectionCommitRow>(
    `SELECT id, connection_id, phase, credential_provider_id,
            cleanup_credential_provider_id, created_at, updated_at
     FROM model_hub_connection_commits
     WHERE connection_id = ?`,
    [connectionId],
  );
  return rows[0] ?? null;
}

async function persistSqliteConnection(
  transaction: TransactionExecutor,
  validated: ReturnType<typeof validateConnectionInput>,
  now: string,
): Promise<ModelProviderConnection> {
  const existing = await findConnectionRow(transaction, validated.id);
  if (existing === null && validated.expectedRevision !== null) {
    throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
  }
  if (
    existing !== null &&
    (validated.expectedRevision === null || validated.expectedRevision !== existing.revision)
  ) {
    throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
  }
  if (existing !== null && existing.provider_kind !== validated.providerKind) {
    throw modelHubError(
      "MODEL_HUB_PROVIDER_KIND_IMMUTABLE",
      "A connection id cannot be reassigned to a different provider kind.",
    );
  }
  const endpointIdentityChanged =
    existing !== null && connectionEndpointIdentityChanged(hydrateConnection(existing), validated);
  const revision = existing === null ? 1 : existing.revision + 1;
  if (existing === null) {
    await transaction.execute(
      `INSERT INTO model_provider_connections (
         id, provider_kind, display_name, protocol, region, workspace_id,
         endpoint_id, base_url, credential_ref, credential_state,
         authentication_mode, credential_header_name, model_discovery_path,
         text_generation_path, embedding_path, request_timeout_ms, retry_limit,
         legacy_provider_id, enabled, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        validated.id,
        validated.providerKind,
        validated.displayName,
        validated.protocol,
        validated.region,
        validated.workspaceId,
        validated.endpointId,
        validated.baseUrl,
        validated.credentialRef,
        validated.credentialState,
        validated.authenticationMode,
        validated.credentialHeaderName,
        validated.modelDiscoveryPath,
        validated.textGenerationPath,
        validated.embeddingPath,
        validated.requestTimeoutMs,
        validated.retryLimit,
        validated.legacyProviderId,
        validated.enabled ? 1 : 0,
        now,
        now,
      ],
    );
  } else {
    const result = await transaction.execute(
      `UPDATE model_provider_connections
       SET provider_kind = ?, display_name = ?, protocol = ?, region = ?,
           workspace_id = ?, endpoint_id = ?, base_url = ?, credential_ref = ?,
           credential_state = ?, authentication_mode = ?, credential_header_name = ?,
           model_discovery_path = ?, text_generation_path = ?, embedding_path = ?,
           request_timeout_ms = ?, retry_limit = ?, legacy_provider_id = ?, enabled = ?,
           revision = ?, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [
        validated.providerKind,
        validated.displayName,
        validated.protocol,
        validated.region,
        validated.workspaceId,
        validated.endpointId,
        validated.baseUrl,
        validated.credentialRef,
        validated.credentialState,
        validated.authenticationMode,
        validated.credentialHeaderName,
        validated.modelDiscoveryPath,
        validated.textGenerationPath,
        validated.embeddingPath,
        validated.requestTimeoutMs,
        validated.retryLimit,
        validated.legacyProviderId,
        validated.enabled ? 1 : 0,
        revision,
        now,
        validated.id,
        existing.revision,
      ],
    );
    if (result.rowsAffected !== 1) throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
    if (endpointIdentityChanged) {
      await invalidateSqliteConnectionDerivedState(transaction, validated.id, now);
    }
  }
  const saved = await findConnectionRow(transaction, validated.id);
  if (saved === null) {
    throw modelHubError("MODEL_HUB_CONNECTION_WRITE_FAILED", "The connection was not persisted.");
  }
  return hydrateConnection(saved);
}

async function persistSqliteCatalogSync(
  transaction: TransactionExecutor,
  validated: ReturnType<typeof validateCatalogInput>,
  now: string,
): Promise<void> {
  const connection = await findConnectionRow(transaction, validated.connectionId);
  if (connection === null) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_NOT_FOUND",
      "The provider connection does not exist.",
    );
  }
  await transaction.execute(
    `INSERT INTO model_catalog_syncs (
       id, connection_id, source, status, discovered_model_count,
       next_page_token_present, error_code, error_summary, started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      validated.syncId,
      validated.connectionId,
      validated.source,
      validated.status,
      validated.models.length,
      validated.nextPageTokenPresent ? 1 : 0,
      validated.errorCode,
      validated.errorSummary,
      validated.startedAt ?? now,
      now,
    ],
  );
  for (const model of validated.models) {
    const existingRows = await transaction.select<CatalogRow>(
      `${CATALOG_SELECT} WHERE connection_id = ? AND provider_model_id = ?`,
      [validated.connectionId, model.providerModelId],
    );
    const existing = existingRows[0];
    if (existing === undefined) {
      await transaction.execute(
        `INSERT INTO model_catalog_entries (
           id, connection_id, provider_model_id, display_name, owned_by,
           catalog_source, availability, lifecycle, input_token_limit,
           output_token_limit, first_discovered_at, last_seen_at, stale_after,
           last_sync_id, revision
         ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          model.id,
          validated.connectionId,
          model.providerModelId,
          model.displayName,
          model.ownedBy,
          validated.source,
          model.lifecycle,
          model.inputTokenLimit,
          model.outputTokenLimit,
          now,
          now,
          model.staleAfter,
          validated.syncId,
        ],
      );
    } else {
      await transaction.execute(
        `UPDATE model_catalog_entries
         SET display_name = ?, owned_by = ?, catalog_source = ?, availability = 'available',
             lifecycle = ?, input_token_limit = ?, output_token_limit = ?,
             last_seen_at = ?, stale_after = ?, last_sync_id = ?, revision = revision + 1
         WHERE id = ?`,
        [
          model.displayName,
          model.ownedBy,
          validated.source,
          model.lifecycle,
          model.inputTokenLimit,
          model.outputTokenLimit,
          now,
          model.staleAfter,
          validated.syncId,
          existing.id,
        ],
      );
    }
  }
  if (validated.status === "succeeded" && validated.source === "provider_api") {
    await transaction.execute(
      `UPDATE model_catalog_entries
       SET availability = 'unavailable', revision = revision + 1
       WHERE connection_id = ?
         AND catalog_source = 'provider_api'
         AND (last_sync_id IS NULL OR last_sync_id <> ?)
         AND availability <> 'unavailable'`,
      [validated.connectionId, validated.syncId],
    );
  }
  const result = await transaction.execute(
    `UPDATE model_provider_connections
     SET catalog_sync_status = ?, last_catalog_synced_at = ?,
         last_error_code = ?, last_error_summary = ?, revision = revision + 1,
         updated_at = ?
     WHERE id = ?`,
    [
      validated.status,
      now,
      validated.errorCode,
      validated.errorSummary,
      now,
      validated.connectionId,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_WRITE_FAILED",
      "The catalog sync did not update its connection.",
    );
  }
}

function persistMemoryConnection(
  state: MemoryModelHubState,
  validated: ReturnType<typeof validateConnectionInput>,
  now: string,
): ModelProviderConnection {
  const existing = state.connections[validated.id];
  if (existing === undefined && validated.expectedRevision !== null) {
    throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
  }
  if (
    existing !== undefined &&
    (validated.expectedRevision === null || existing.revision !== validated.expectedRevision)
  ) {
    throw conflict("MODEL_HUB_CONNECTION_CONFLICT");
  }
  if (existing !== undefined && existing.providerKind !== validated.providerKind) {
    throw modelHubError(
      "MODEL_HUB_PROVIDER_KIND_IMMUTABLE",
      "A connection id cannot be reassigned to a different provider kind.",
    );
  }
  const endpointIdentityChanged =
    existing !== undefined && connectionEndpointIdentityChanged(existing, validated);
  if (endpointIdentityChanged) {
    invalidateMemoryConnectionDerivedState(state, validated.id, now);
  }
  const saved: ModelProviderConnection = Object.freeze({
    id: validated.id,
    providerKind: validated.providerKind,
    displayName: validated.displayName,
    protocol: validated.protocol,
    region: validated.region,
    workspaceId: validated.workspaceId,
    endpointId: validated.endpointId,
    baseUrl: validated.baseUrl,
    credentialRef: validated.credentialRef,
    credentialState: validated.credentialState,
    authenticationMode: validated.authenticationMode,
    credentialHeaderName: validated.credentialHeaderName,
    modelDiscoveryPath: validated.modelDiscoveryPath,
    textGenerationPath: validated.textGenerationPath,
    embeddingPath: validated.embeddingPath,
    requestTimeoutMs: validated.requestTimeoutMs,
    retryLimit: validated.retryLimit,
    connectionStatus: endpointIdentityChanged
      ? "not_tested"
      : (existing?.connectionStatus ?? "not_tested"),
    catalogSyncStatus: endpointIdentityChanged ? "never" : (existing?.catalogSyncStatus ?? "never"),
    lastTestedAt: endpointIdentityChanged ? null : (existing?.lastTestedAt ?? null),
    lastCatalogSyncedAt: endpointIdentityChanged ? null : (existing?.lastCatalogSyncedAt ?? null),
    lastErrorCode: endpointIdentityChanged ? null : (existing?.lastErrorCode ?? null),
    lastErrorSummary: endpointIdentityChanged ? null : (existing?.lastErrorSummary ?? null),
    legacyProviderId: validated.legacyProviderId,
    enabled: validated.enabled,
    revision: existing === undefined ? 1 : existing.revision + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  state.connections[saved.id] = saved;
  return saved;
}

function persistMemoryCatalogSync(
  state: MemoryModelHubState,
  validated: ReturnType<typeof validateCatalogInput>,
  now: string,
): void {
  const connection = state.connections[validated.connectionId];
  if (connection === undefined) {
    throw modelHubError(
      "MODEL_HUB_CONNECTION_NOT_FOUND",
      "The provider connection does not exist.",
    );
  }
  if (state.catalogSyncs[validated.syncId] !== undefined) {
    throw conflict("MODEL_HUB_CATALOG_SYNC_CONFLICT");
  }
  state.catalogSyncs[validated.syncId] = Object.freeze({
    id: validated.syncId,
    connectionId: validated.connectionId,
    source: validated.source,
    status: validated.status,
    discoveredModelCount: validated.models.length,
    nextPageTokenPresent: validated.nextPageTokenPresent,
    errorCode: validated.errorCode,
    errorSummary: validated.errorSummary,
    startedAt: validated.startedAt ?? now,
    completedAt: now,
  });
  for (const model of validated.models) {
    const existing = Object.values(state.catalog).find(
      (entry) =>
        entry.connectionId === validated.connectionId &&
        entry.providerModelId === model.providerModelId,
    );
    const id = existing?.id ?? model.id;
    state.catalog[id] = Object.freeze({
      id,
      connectionId: validated.connectionId,
      providerModelId: model.providerModelId,
      displayName: model.displayName,
      ownedBy: model.ownedBy,
      catalogSource: validated.source,
      availability: "available",
      lifecycle: model.lifecycle,
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
      firstDiscoveredAt: existing?.firstDiscoveredAt ?? now,
      lastSeenAt: now,
      staleAfter: model.staleAfter,
      lastSyncId: validated.syncId,
      revision: existing === undefined ? 1 : existing.revision + 1,
    });
  }
  if (validated.status === "succeeded" && validated.source === "provider_api") {
    for (const [id, entry] of Object.entries(state.catalog)) {
      if (
        entry.connectionId === validated.connectionId &&
        entry.catalogSource === "provider_api" &&
        entry.lastSyncId !== validated.syncId &&
        entry.availability !== "unavailable"
      ) {
        state.catalog[id] = Object.freeze({
          ...entry,
          availability: "unavailable",
          revision: entry.revision + 1,
        });
      }
    }
  }
  state.connections[connection.id] = Object.freeze({
    ...connection,
    catalogSyncStatus: validated.status,
    lastCatalogSyncedAt: now,
    lastErrorCode: validated.errorCode,
    lastErrorSummary: validated.errorSummary,
    revision: connection.revision + 1,
    updatedAt: now,
  });
}

type ConnectionEndpointIdentity = Pick<
  ModelProviderConnection,
  | "baseUrl"
  | "authenticationMode"
  | "credentialHeaderName"
  | "modelDiscoveryPath"
  | "textGenerationPath"
  | "embeddingPath"
>;

function connectionEndpointIdentityChanged(
  existing: ConnectionEndpointIdentity,
  next: ConnectionEndpointIdentity,
): boolean {
  return (
    existing.baseUrl !== next.baseUrl ||
    existing.authenticationMode !== next.authenticationMode ||
    existing.credentialHeaderName !== next.credentialHeaderName ||
    existing.modelDiscoveryPath !== next.modelDiscoveryPath ||
    existing.textGenerationPath !== next.textGenerationPath ||
    existing.embeddingPath !== next.embeddingPath
  );
}

async function invalidateSqliteConnectionDerivedState(
  executor: TransactionExecutor,
  connectionId: string,
  now: string,
): Promise<void> {
  await executor.execute(
    `UPDATE novel_task_routes
     SET fallback_catalog_entry_id = NULL,
         failure_policy = CASE WHEN failure_policy = 'use_fallback' THEN 'stop' ELSE failure_policy END,
         revision = revision + 1,
         updated_at = ?
     WHERE fallback_catalog_entry_id IN (
       SELECT id FROM model_catalog_entries WHERE connection_id = ?
     ) AND primary_catalog_entry_id NOT IN (
       SELECT id FROM model_catalog_entries WHERE connection_id = ?
     )`,
    [now, connectionId, connectionId],
  );
  await executor.execute(
    `DELETE FROM novel_task_routes
     WHERE primary_catalog_entry_id IN (
       SELECT id FROM model_catalog_entries WHERE connection_id = ?
     )`,
    [connectionId],
  );
  await executor.execute("DELETE FROM model_catalog_entries WHERE connection_id = ?", [
    connectionId,
  ]);
  await executor.execute("DELETE FROM model_catalog_syncs WHERE connection_id = ?", [connectionId]);
  await executor.execute(
    `UPDATE model_provider_connections
     SET connection_status = 'not_tested', catalog_sync_status = 'never',
         last_tested_at = NULL, last_catalog_synced_at = NULL,
         last_error_code = NULL, last_error_summary = NULL
     WHERE id = ?`,
    [connectionId],
  );
}

function invalidateMemoryConnectionDerivedState(
  state: MemoryModelHubState,
  connectionId: string,
  now: string,
): void {
  const catalogIds = new Set(
    Object.values(state.catalog)
      .filter((entry) => entry.connectionId === connectionId)
      .map(({ id }) => id),
  );
  for (const [task, route] of Object.entries(state.routes)) {
    if (catalogIds.has(route.primaryCatalogEntryId)) {
      Reflect.deleteProperty(state.routes, task);
    } else if (
      route.fallbackCatalogEntryId !== null &&
      catalogIds.has(route.fallbackCatalogEntryId)
    ) {
      state.routes[task] = Object.freeze({
        ...route,
        fallbackCatalogEntryId: null,
        failurePolicy: route.failurePolicy === "use_fallback" ? "stop" : route.failurePolicy,
        revision: route.revision + 1,
        updatedAt: now,
      });
    }
  }
  for (const [id, evidence] of Object.entries(state.capabilityEvidence)) {
    if (catalogIds.has(evidence.catalogEntryId)) {
      Reflect.deleteProperty(state.capabilityEvidence, id);
    }
  }
  for (const [id, evaluation] of Object.entries(state.evaluationResults)) {
    if (catalogIds.has(evaluation.catalogEntryId)) {
      Reflect.deleteProperty(state.evaluationResults, id);
    }
  }
  for (const catalogId of catalogIds) {
    Reflect.deleteProperty(state.costPrivacyProfiles, catalogId);
    Reflect.deleteProperty(state.catalog, catalogId);
  }
  for (const [id, sync] of Object.entries(state.catalogSyncs)) {
    if (sync.connectionId === connectionId) {
      Reflect.deleteProperty(state.catalogSyncs, id);
    }
  }
}

async function ensureCatalogEntry(executor: TransactionExecutor, id: string): Promise<void> {
  const rows = await executor.select<{ id: string }>(
    "SELECT id FROM model_catalog_entries WHERE id = ? AND availability = 'available'",
    [id],
  );
  if (rows[0] === undefined) {
    throw modelHubError("MODEL_HUB_MODEL_NOT_AVAILABLE", "The selected model is not available.");
  }
}

async function ensureCatalogEntryExists(executor: TransactionExecutor, id: string): Promise<void> {
  const rows = await executor.select<{ id: string }>(
    "SELECT id FROM model_catalog_entries WHERE id = ?",
    [id],
  );
  if (rows[0] === undefined) {
    throw modelHubError("MODEL_HUB_MODEL_NOT_FOUND", "The selected model does not exist.");
  }
}

async function persistSqliteCapabilityScan(
  transaction: TransactionExecutor,
  validated: ReturnType<typeof validateCapabilityScanInput>,
  now: string,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO model_capability_scans (
       id, catalog_entry_id, scan_kind, status, evidence_version,
       supported_count, unsupported_count, unknown_count,
       error_code, error_summary, requested_at, started_at, completed_at,
       diagnostic_request_id, failure_stage, failure_retryable, http_status,
       finish_reason, visible_content_length, reasoning_present, streamed,
       attempt, requested_max_output_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      validated.scanId,
      validated.catalogEntryId,
      validated.scanKind,
      validated.status,
      validated.evidenceVersion,
      validated.supportedCount,
      validated.unsupportedCount,
      validated.unknownCount,
      validated.errorCode,
      validated.errorSummary,
      validated.requestedAt ?? now,
      now,
      now,
      validated.failure?.requestId ?? null,
      validated.failure?.stage ?? null,
      nullableBooleanInteger(validated.failure?.retryable ?? null),
      validated.failure?.httpStatus ?? null,
      validated.failure?.finishReason ?? null,
      validated.failure?.visibleContentLength ?? null,
      nullableBooleanInteger(validated.failure?.reasoningPresent ?? null),
      nullableBooleanInteger(validated.failure?.stream ?? null),
      validated.failure?.attempt ?? null,
      validated.failure?.requestedMaxOutputTokens ?? null,
    ],
  );
  for (const evidence of validated.evidence) {
    await transaction.execute(
      `INSERT INTO model_capability_evidence (
         id, catalog_entry_id, scan_id, capability, verdict,
         evidence_source, evidence_version, evidence_summary,
         observed_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evidence.id,
        validated.catalogEntryId,
        validated.scanId,
        evidence.capability,
        evidence.verdict,
        evidence.evidenceSource,
        validated.evidenceVersion,
        evidence.evidenceSummary,
        now,
        evidence.expiresAt,
      ],
    );
  }
}

async function ensureLocalCatalogEntry(executor: TransactionExecutor, id: string): Promise<void> {
  const rows = await executor.select<{ catalog_entry_id: string; base_url: string }>(
    `SELECT privacy.catalog_entry_id, connection.base_url
     FROM model_cost_privacy_profiles AS privacy
     JOIN model_catalog_entries AS catalog ON catalog.id = privacy.catalog_entry_id
     JOIN model_provider_connections AS connection ON connection.id = catalog.connection_id
     WHERE privacy.catalog_entry_id = ?
       AND privacy.data_destination = 'local'
       AND privacy.evidence_source <> 'unknown'`,
    [id],
  );
  if (rows[0] === undefined || !isLoopbackModelBaseUrl(rows[0].base_url)) {
    throw modelHubError(
      "MODEL_HUB_PRIVACY_BLOCKED",
      "Local-only routes require evidence-confirmed local models.",
    );
  }
}

function hydrateConnection(row: ConnectionRow): ModelProviderConnection {
  if (!isModelProviderKind(row.provider_kind)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored provider kind is invalid.");
  }
  let expert: ReturnType<typeof validateConnectionInput>;
  try {
    expert = validateConnectionInput({
      id: row.id,
      providerKind: row.provider_kind,
      displayName: row.display_name,
      region: row.region,
      workspaceId: row.workspace_id,
      endpointId: row.endpoint_id,
      baseUrlOverride: row.base_url,
      credentialRef: row.credential_ref,
      credentialState: row.credential_state as SaveModelProviderConnectionInput["credentialState"],
      authenticationMode: row.authentication_mode as ModelHubAuthenticationMode,
      credentialHeaderName: row.credential_header_name,
      modelDiscoveryPath: row.model_discovery_path,
      textGenerationPath: row.text_generation_path,
      embeddingPath: row.embedding_path,
      requestTimeoutMs: row.request_timeout_ms,
      retryLimit: row.retry_limit,
      legacyProviderId: row.legacy_provider_id,
      enabled: row.enabled === 1,
      expectedRevision: row.revision,
    });
  } catch {
    throw modelHubError(
      "MODEL_HUB_STORE_CORRUPT",
      "Stored Model Hub connection options are invalid.",
    );
  }
  if (expert.protocol !== row.protocol || expert.baseUrl !== row.base_url) {
    throw modelHubError(
      "MODEL_HUB_STORE_CORRUPT",
      "Stored Model Hub connection metadata is inconsistent.",
    );
  }
  return Object.freeze({
    id: row.id,
    providerKind: row.provider_kind,
    displayName: row.display_name,
    protocol: row.protocol,
    region: row.region,
    workspaceId: row.workspace_id,
    endpointId: row.endpoint_id,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    credentialState: row.credential_state as ModelProviderConnection["credentialState"],
    authenticationMode: expert.authenticationMode,
    credentialHeaderName: expert.credentialHeaderName,
    modelDiscoveryPath: expert.modelDiscoveryPath,
    textGenerationPath: expert.textGenerationPath,
    embeddingPath: expert.embeddingPath,
    requestTimeoutMs: expert.requestTimeoutMs,
    retryLimit: expert.retryLimit,
    connectionStatus: row.connection_status as ModelHubConnectionStatus,
    catalogSyncStatus: row.catalog_sync_status as ModelHubCatalogSyncStatus,
    lastTestedAt: row.last_tested_at,
    lastCatalogSyncedAt: row.last_catalog_synced_at,
    lastErrorCode: row.last_error_code,
    lastErrorSummary: row.last_error_summary,
    legacyProviderId: row.legacy_provider_id,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function isRetiredConnectionRow(row: ConnectionRow): boolean {
  return (
    row.enabled === 0 &&
    row.connection_status === "disabled" &&
    row.credential_ref === null &&
    row.credential_state === "missing" &&
    row.last_error_code === RETIRED_CONNECTION_ERROR_CODE
  );
}

function hydrateConnectionCommit(row: ConnectionCommitRow): ModelHubConnectionCommit {
  if (row.phase !== "prepared" && row.phase !== "cleanup_pending") {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored connection commit phase is invalid.");
  }
  const credentialProviderId = optionalCredentialProviderId(row.credential_provider_id);
  const cleanupCredentialProviderId = optionalCredentialProviderId(
    row.cleanup_credential_provider_id,
  );
  if (row.phase === "prepared" && cleanupCredentialProviderId !== null) {
    throw modelHubError(
      "MODEL_HUB_STORE_CORRUPT",
      "A prepared connection commit cannot contain cleanup work.",
    );
  }
  return Object.freeze({
    id: boundedText(row.id, "stored connection commit id", 128),
    connectionId: boundedText(row.connection_id, "stored connection commit connection id", 128),
    phase: row.phase,
    credentialProviderId,
    cleanupCredentialProviderId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateCatalog(row: CatalogRow): ModelCatalogEntry {
  return Object.freeze({
    id: row.id,
    connectionId: row.connection_id,
    providerModelId: row.provider_model_id,
    displayName: row.display_name,
    ownedBy: row.owned_by,
    catalogSource: row.catalog_source as ModelCatalogEntry["catalogSource"],
    availability: row.availability as ModelCatalogEntry["availability"],
    lifecycle: row.lifecycle as ModelCatalogEntry["lifecycle"],
    inputTokenLimit: row.input_token_limit,
    outputTokenLimit: row.output_token_limit,
    firstDiscoveredAt: row.first_discovered_at,
    lastSeenAt: row.last_seen_at,
    staleAfter: row.stale_after,
    lastSyncId: row.last_sync_id,
    revision: row.revision,
  });
}

function hydrateCatalogSync(row: CatalogSyncRow): ModelCatalogSync {
  return Object.freeze({
    id: row.id,
    connectionId: row.connection_id,
    source: row.source as ModelCatalogSync["source"],
    status: row.status as ModelCatalogSync["status"],
    discoveredModelCount: row.discovered_model_count,
    nextPageTokenPresent: row.next_page_token_present === 1,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

function hydrateCapabilityEvidence(row: CapabilityEvidenceRow): ModelCapabilityEvidence {
  if (!isModelHubCapability(row.capability)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored model capability is invalid.");
  }
  return Object.freeze({
    id: row.id,
    catalogEntryId: row.catalog_entry_id,
    scanId: row.scan_id,
    capability: row.capability,
    verdict: row.verdict as ModelCapabilityEvidence["verdict"],
    evidenceSource: row.evidence_source as ModelCapabilityEvidence["evidenceSource"],
    evidenceVersion: row.evidence_version,
    evidenceSummary: row.evidence_summary,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
  });
}

function hydrateCostPrivacyProfile(row: CostPrivacyProfileRow): ModelCostPrivacyProfile {
  return Object.freeze({
    catalogEntryId: row.catalog_entry_id,
    currency: row.currency,
    inputMicrosPerMillionTokens: row.input_micros_per_million_tokens,
    outputMicrosPerMillionTokens: row.output_micros_per_million_tokens,
    cachedInputMicrosPerMillionTokens: row.cached_input_micros_per_million_tokens,
    pricingVersion: row.pricing_version,
    priceUpdatedAt: row.price_updated_at,
    dataDestination: row.data_destination as ModelCostPrivacyProfile["dataDestination"],
    retentionPolicy: row.retention_policy as ModelCostPrivacyProfile["retentionPolicy"],
    trainingPolicy: row.training_policy as ModelCostPrivacyProfile["trainingPolicy"],
    evidenceSource: row.evidence_source as ModelCostPrivacyProfile["evidenceSource"],
    evidenceVersion: row.evidence_version,
    evidenceSummary: row.evidence_summary,
    evidenceUpdatedAt: row.evidence_updated_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateEvaluationResult(row: EvaluationResultRow): ModelEvaluationResult {
  return Object.freeze({
    id: row.id,
    catalogEntryId: row.catalog_entry_id,
    task: validateTask(row.task),
    scoreBasisPoints: row.score_basis_points,
    latencyP50Ms: row.latency_p50_ms,
    sampleCount: row.sample_count,
    evaluationSource: row.evaluation_source as ModelEvaluationResult["evaluationSource"],
    evaluationVersion: row.evaluation_version,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
  });
}

function hydratePreset(row: PresetRow): ModelHubPreset {
  if (!(MODEL_HUB_SCHEMES as readonly string[]).includes(row.scheme)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored model preset scheme is invalid.");
  }
  return Object.freeze({
    id: row.id,
    scheme: row.scheme as ModelHubScheme,
    displayName: row.display_name,
    status: row.status as ModelHubPreset["status"],
    privacyPolicy: row.privacy_policy as ModelHubPrivacyPolicy,
    costPriority: row.cost_priority as ModelHubPreset["costPriority"],
    routeGenerationVersion: row.route_generation_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateRoute(row: RouteRow): NovelTaskRoute {
  return Object.freeze({
    task: validateTask(row.task),
    primaryCatalogEntryId: row.primary_catalog_entry_id,
    fallbackCatalogEntryId: row.fallback_catalog_entry_id,
    presetId: row.preset_id,
    parameterPolicy: JSON.parse(row.parameter_policy_json) as Readonly<Record<string, unknown>>,
    maximumCostMicros: row.maximum_cost_micros,
    currency: row.currency,
    privacyPolicy: row.privacy_policy as ModelHubPrivacyPolicy,
    failurePolicy: row.failure_policy as NovelTaskRoute["failurePolicy"],
    routeOrigin: row.route_origin as NovelTaskRoute["routeOrigin"],
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hydrateInvocation(row: InvocationRow): ModelInvocationFact {
  const succeeded = row.status === "succeeded";
  return Object.freeze({
    id: row.id,
    task: validateTask(row.task),
    routeTask: row.route_task === null ? null : validateTask(row.route_task),
    connectionId: row.connection_id,
    catalogEntryId: row.catalog_entry_id,
    providerKindSnapshot: row.provider_kind_snapshot,
    modelIdSnapshot: row.model_id_snapshot,
    routeReason: row.route_reason as ModelInvocationFact["routeReason"],
    status: row.status as ModelInvocationFact["status"],
    attempt: row.attempt,
    fallbackFromInvocationId: row.fallback_from_invocation_id,
    privacyPolicy: row.privacy_policy as ModelHubPrivacyPolicy,
    dataDestination: row.data_destination as ModelInvocationFact["dataDestination"],
    maximumCostMicros: row.maximum_cost_micros,
    currency: row.currency,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    estimatedCostMicros: row.estimated_cost_micros,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    completion: succeeded
      ? hydrateSafeCompletionMetadata({
          visibleContentLength: row.visible_content_length,
          stream: row.streamed,
        })
      : null,
    failure: succeeded
      ? null
      : hydrateSafeFailureMetadata({
          requestId: row.diagnostic_request_id,
          stage: row.failure_stage,
          retryable: row.failure_retryable,
          httpStatus: row.http_status,
          finishReason: row.finish_reason,
          visibleContentLength: row.visible_content_length,
          reasoningPresent: row.reasoning_present,
          stream: row.streamed,
          attempt: row.attempt,
          requestedMaxOutputTokens: row.requested_max_output_tokens,
        }),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    revision: row.revision,
  });
}

function hydrateRecentAiFailure(row: RecentAiFailureRow): RecentAiFailure {
  if (!isModelProviderKind(row.provider_kind)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A recent AI failure provider is invalid.");
  }
  const taskType =
    row.task_type === "capability_probe" ? "capability_probe" : validateTask(row.task_type);
  return Object.freeze({
    diagnosticId: boundedText(row.diagnostic_id, "AI failure diagnostic id", 256),
    timestamp: requireIsoTimestamp(row.timestamp, "AI failure timestamp"),
    providerKind: row.provider_kind,
    connectionId: boundedText(row.connection_id, "AI failure connection id", 128),
    modelId: boundedText(row.model_id, "AI failure model id", 512),
    taskType,
    stage: validateStoredFailureStage(row.failure_stage),
    normalizedErrorCode: validateErrorCode(row.normalized_error_code),
    retryable: storedNullableBoolean(row.failure_retryable, "AI failure retryable flag"),
    httpStatus: validateNullableHttpStatus(row.http_status),
    finishReason: validateNullableFinishReason(row.finish_reason),
    visibleContentLength: validateNullableCount(
      row.visible_content_length,
      "AI failure visible content length",
    ),
    reasoningPresent: storedNullableBoolean(row.reasoning_present, "AI reasoning presence flag"),
    stream: storedNullableBoolean(row.streamed, "AI stream flag"),
    attempt: validateRecentFailureAttempt(row.attempt),
    requestedMaxOutputTokens:
      row.requested_max_output_tokens === null
        ? null
        : (optionalPositiveInteger(row.requested_max_output_tokens) ?? null),
    requestId: validateNullableRequestId(row.diagnostic_request_id),
  });
}

function capabilityScanFact(
  validated: ReturnType<typeof validateCapabilityScanInput>,
  now: string,
): ModelCapabilityScanFact {
  return Object.freeze({
    id: validated.scanId,
    catalogEntryId: validated.catalogEntryId,
    scanKind: validated.scanKind,
    status: validated.status,
    errorCode: validated.errorCode,
    requestedAt: validated.requestedAt ?? now,
    completedAt: now,
    failure: validated.failure,
  });
}

function recentAiFailureFromCapabilityScan(
  scan: ModelCapabilityScanFact,
  connection: ModelProviderConnection,
  modelId: string,
): RecentAiFailure {
  if (scan.errorCode === null) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A failed capability scan has no error code.");
  }
  return Object.freeze({
    diagnosticId: boundedText(`capability_scan:${scan.id}`, "AI failure diagnostic id", 256),
    timestamp: requireIsoTimestamp(scan.completedAt, "AI failure timestamp"),
    providerKind: connection.providerKind,
    connectionId: boundedText(connection.id, "AI failure connection id", 128),
    modelId: boundedText(modelId, "AI failure model id", 512),
    taskType: "capability_probe",
    stage: validateStoredFailureStage(scan.failure?.stage ?? null),
    normalizedErrorCode: validateErrorCode(scan.errorCode),
    retryable: validateNullableBooleanValue(
      scan.failure?.retryable ?? null,
      "AI failure retryable flag",
    ),
    httpStatus: validateNullableHttpStatus(scan.failure?.httpStatus ?? null),
    finishReason: validateNullableFinishReason(scan.failure?.finishReason ?? null),
    visibleContentLength: validateNullableCount(
      scan.failure?.visibleContentLength ?? null,
      "AI failure visible content length",
    ),
    reasoningPresent: validateNullableBooleanValue(
      scan.failure?.reasoningPresent ?? null,
      "AI reasoning presence flag",
    ),
    stream: validateNullableBooleanValue(scan.failure?.stream ?? null, "AI stream flag"),
    attempt: validateRecentFailureAttempt(scan.failure?.attempt ?? 1),
    requestedMaxOutputTokens:
      scan.failure?.requestedMaxOutputTokens === undefined ||
      scan.failure.requestedMaxOutputTokens === null
        ? null
        : optionalPositiveInteger(scan.failure.requestedMaxOutputTokens),
    requestId: validateNullableRequestId(scan.failure?.requestId ?? null),
  });
}

function recentAiFailureFromInvocation(invocation: ModelInvocationFact): RecentAiFailure {
  if (invocation.errorCode === null || invocation.completedAt === null) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A failed invocation is incomplete.");
  }
  return Object.freeze({
    diagnosticId: boundedText(`model_invocation:${invocation.id}`, "AI failure diagnostic id", 256),
    timestamp: requireIsoTimestamp(invocation.completedAt, "AI failure timestamp"),
    providerKind: requireProviderKind(invocation.providerKindSnapshot),
    connectionId: boundedText(invocation.connectionId, "AI failure connection id", 128),
    modelId: boundedText(invocation.modelIdSnapshot, "AI failure model id", 512),
    taskType: validateTask(invocation.task),
    stage: validateStoredFailureStage(invocation.failure?.stage ?? null),
    normalizedErrorCode: validateErrorCode(invocation.errorCode),
    retryable: validateNullableBooleanValue(
      invocation.failure?.retryable ?? null,
      "AI failure retryable flag",
    ),
    httpStatus: validateNullableHttpStatus(invocation.failure?.httpStatus ?? null),
    finishReason: validateNullableFinishReason(invocation.failure?.finishReason ?? null),
    visibleContentLength: validateNullableCount(
      invocation.failure?.visibleContentLength ?? null,
      "AI failure visible content length",
    ),
    reasoningPresent: validateNullableBooleanValue(
      invocation.failure?.reasoningPresent ?? null,
      "AI reasoning presence flag",
    ),
    stream: validateNullableBooleanValue(invocation.failure?.stream ?? null, "AI stream flag"),
    attempt: validateRecentFailureAttempt(invocation.attempt),
    requestedMaxOutputTokens:
      invocation.failure?.requestedMaxOutputTokens === undefined ||
      invocation.failure.requestedMaxOutputTokens === null
        ? null
        : optionalPositiveInteger(invocation.failure.requestedMaxOutputTokens),
    requestId: validateNullableRequestId(invocation.failure?.requestId ?? null),
  });
}

function validateTask(value: unknown): NovelAiTask {
  if (!isNovelAiTask(value)) {
    throw modelHubError("MODEL_HUB_TASK_INVALID", "The novel AI task is invalid.");
  }
  return value;
}

function requireProviderKind(value: string): ModelProviderKind {
  if (!isModelProviderKind(value)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored provider kind is invalid.");
  }
  return value;
}

function validateRecentFailureLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw modelHubError(
      "MODEL_HUB_FAILURE_LIMIT_INVALID",
      "The recent AI failure limit must be between 1 and 100.",
    );
  }
  return value;
}

function validateRecentFailureAttempt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored AI failure attempt is invalid.");
  }
  return value;
}

function validateNullableErrorCode(value: string | null): string | null {
  return value === null ? null : validateErrorCode(value);
}

function validateErrorCode(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(normalized)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored AI error code is invalid.");
  }
  return normalized;
}

function requireIsoTimestamp(value: string, label: string): string {
  const normalized = optionalIsoTimestamp(value, label);
  if (normalized === null) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", `The ${label} is missing.`);
  }
  return normalized;
}

function validateStoredFailureStage(value: string | null): ModelFailureStage | null {
  if (value === null) return null;
  if (!(MODEL_FAILURE_STAGES as readonly string[]).includes(value)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored AI failure stage is invalid.");
  }
  return value as ModelFailureStage;
}

function storedNullableBoolean(value: number | null, label: string): boolean | null {
  if (value === null) return null;
  if (value !== 0 && value !== 1) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", `The stored ${label} is invalid.`);
  }
  return value === 1;
}

function validateNullableBooleanValue(value: unknown, label: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", `The stored ${label} is invalid.`);
  }
  return value;
}

function validateNullableHttpStatus(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored AI HTTP status is invalid.");
  }
  return value;
}

function validateNullableFinishReason(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(value)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored AI finish reason is invalid.");
  }
  return value;
}

function validateNullableCount(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", `The stored ${label} is invalid.`);
  }
  return value;
}

function validateNullableRequestId(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(value)) {
    throw modelHubError("MODEL_HUB_STORE_CORRUPT", "A stored AI request id is invalid.");
  }
  return value;
}

function validateExpectedRevision(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw modelHubError("MODEL_HUB_REVISION_INVALID", "The expected revision is invalid.");
  }
  return value;
}

function validateRequiredRevision(value: number): number {
  return validateExpectedRevision(value) ?? 0;
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw modelHubError("MODEL_HUB_VALUE_INVALID", `The ${label} is invalid.`);
  }
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  return boundedText(value, label, maximum);
}

function optionalIsoTimestamp(value: string | null | undefined, label: string): string | null {
  const timestamp = optionalText(value, label, 64);
  if (timestamp === null) {
    return null;
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw modelHubError("MODEL_HUB_VALUE_INVALID", `The ${label} is invalid.`);
  }
  return new Date(milliseconds).toISOString();
}

const SAFE_AI_FAILURE_KEYS = new Set([
  "requestId",
  "stage",
  "retryable",
  "httpStatus",
  "finishReason",
  "visibleContentLength",
  "reasoningPresent",
  "stream",
  "attempt",
  "requestedMaxOutputTokens",
]);

function validateSafeAiFailureMetadata(input: SafeAiFailureMetadata): SafeModelFailureMetadata {
  const candidate: unknown = input;
  if (
    !isRecord(candidate) ||
    containsProhibitedKey(candidate) ||
    Object.keys(candidate).some((key) => !SAFE_AI_FAILURE_KEYS.has(key))
  ) {
    throw modelHubError(
      "MODEL_HUB_FAILURE_METADATA_INVALID",
      "AI failure metadata contains an unsupported or sensitive field.",
    );
  }
  const metadata = candidate as unknown as SafeAiFailureMetadata;
  const requestId = optionalText(metadata.requestId, "AI failure request id", 128);
  if (requestId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(requestId)) {
    throw modelHubError(
      "MODEL_HUB_FAILURE_METADATA_INVALID",
      "The AI failure request id is invalid.",
    );
  }
  const stage = metadata.stage ?? null;
  if (stage !== null && !(MODEL_FAILURE_STAGES as readonly string[]).includes(stage)) {
    throw modelHubError("MODEL_HUB_FAILURE_METADATA_INVALID", "The AI failure stage is invalid.");
  }
  const httpStatus = metadata.httpStatus ?? null;
  if (
    httpStatus !== null &&
    (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw modelHubError(
      "MODEL_HUB_FAILURE_METADATA_INVALID",
      "The AI failure HTTP status is invalid.",
    );
  }
  const finishReason = optionalText(metadata.finishReason, "AI failure finish reason", 64);
  if (finishReason !== null && !/^[a-z][a-z0-9_.-]{0,63}$/u.test(finishReason)) {
    throw modelHubError(
      "MODEL_HUB_FAILURE_METADATA_INVALID",
      "The AI failure finish reason is invalid.",
    );
  }
  const attempt = metadata.attempt ?? null;
  if (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100)) {
    throw modelHubError("MODEL_HUB_FAILURE_METADATA_INVALID", "The AI failure attempt is invalid.");
  }
  return Object.freeze({
    requestId,
    stage,
    retryable: optionalBoolean(metadata.retryable, "AI failure retryable flag"),
    httpStatus,
    finishReason,
    visibleContentLength: optionalNonNegativeInteger(metadata.visibleContentLength),
    reasoningPresent: optionalBoolean(metadata.reasoningPresent, "AI reasoning presence flag"),
    stream: optionalBoolean(metadata.stream, "AI stream flag"),
    attempt,
    requestedMaxOutputTokens: optionalPositiveInteger(metadata.requestedMaxOutputTokens),
  });
}

function validateSafeAiCompletionMetadata(
  input: SafeAiCompletionMetadata,
): SafeModelCompletionMetadata {
  const candidate: unknown = input;
  if (
    !isRecord(candidate) ||
    containsProhibitedKey(candidate) ||
    Object.keys(candidate).some((key) => key !== "visibleContentLength" && key !== "stream")
  ) {
    throw modelHubError(
      "MODEL_HUB_COMPLETION_METADATA_INVALID",
      "AI completion metadata contains an unsupported or sensitive field.",
    );
  }
  if (!Object.hasOwn(candidate, "visibleContentLength")) {
    throw modelHubError(
      "MODEL_HUB_COMPLETION_METADATA_INVALID",
      "AI completion metadata requires a visible content length.",
    );
  }
  const metadata = candidate as unknown as SafeAiCompletionMetadata;
  const stream = metadata.stream ?? null;
  if (stream !== null && typeof stream !== "boolean") {
    throw modelHubError(
      "MODEL_HUB_COMPLETION_METADATA_INVALID",
      "The AI completion stream flag is invalid.",
    );
  }
  return Object.freeze({
    visibleContentLength:
      optionalNonNegativeInteger(metadata.visibleContentLength) ??
      (() => {
        throw modelHubError(
          "MODEL_HUB_COMPLETION_METADATA_INVALID",
          "The AI completion visible content length is invalid.",
        );
      })(),
    stream,
  });
}

function optionalBoolean(value: boolean | null | undefined, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw modelHubError("MODEL_HUB_FAILURE_METADATA_INVALID", `The ${label} is invalid.`);
  }
  return value;
}

function nullableBooleanInteger(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function hydrateSafeFailureMetadata(input: {
  readonly requestId: string | null;
  readonly stage: string | null;
  readonly retryable: number | null;
  readonly httpStatus: number | null;
  readonly finishReason: string | null;
  readonly visibleContentLength: number | null;
  readonly reasoningPresent: number | null;
  readonly stream: number | null;
  readonly attempt: number | null;
  readonly requestedMaxOutputTokens: number | null;
}): SafeModelFailureMetadata | null {
  const hasFailureDetail = [
    input.requestId,
    input.stage,
    input.retryable,
    input.httpStatus,
    input.finishReason,
    input.visibleContentLength,
    input.reasoningPresent,
    input.stream,
    input.requestedMaxOutputTokens,
  ].some((value) => value !== null);
  if (!hasFailureDetail) return null;
  return Object.freeze({
    requestId: validateNullableRequestId(input.requestId),
    stage: validateStoredFailureStage(input.stage),
    retryable: storedNullableBoolean(input.retryable, "AI failure retryable flag"),
    httpStatus: validateNullableHttpStatus(input.httpStatus),
    finishReason: validateNullableFinishReason(input.finishReason),
    visibleContentLength: validateNullableCount(
      input.visibleContentLength,
      "AI failure visible content length",
    ),
    reasoningPresent: storedNullableBoolean(input.reasoningPresent, "AI reasoning presence flag"),
    stream: storedNullableBoolean(input.stream, "AI stream flag"),
    attempt: input.attempt === null ? null : validateRecentFailureAttempt(input.attempt),
    requestedMaxOutputTokens:
      input.requestedMaxOutputTokens === null
        ? null
        : (optionalPositiveInteger(input.requestedMaxOutputTokens) ?? null),
  });
}

function hydrateSafeCompletionMetadata(input: {
  readonly visibleContentLength: number | null;
  readonly stream: number | null;
}): SafeModelCompletionMetadata | null {
  if (input.visibleContentLength === null && input.stream === null) return null;
  if (input.visibleContentLength === null) {
    throw modelHubError(
      "MODEL_HUB_STORE_CORRUPT",
      "A stored completion observation is missing its visible content length.",
    );
  }
  return Object.freeze({
    visibleContentLength:
      validateNullableCount(input.visibleContentLength, "AI completion visible content length") ??
      0,
    stream: storedNullableBoolean(input.stream, "AI completion stream flag"),
  });
}

function safeDiagnosticText(
  value: string | null | undefined,
  label: string,
  maximum: number,
): string | null {
  const normalized = optionalText(value, label, maximum);
  if (normalized === null) {
    return null;
  }
  return normalized
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]")
    .replace(
      /\b(api[-_ ]?key|password|secret|access[-_ ]?token)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    );
}

function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw modelHubError("MODEL_HUB_VALUE_INVALID", "The token limit is invalid.");
  }
  return value;
}

function optionalNonNegativeInteger(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw modelHubError("MODEL_HUB_VALUE_INVALID", "The token usage is invalid.");
  }
  return value;
}

function validateMicros(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (!/^[0-9]{1,19}$/.test(value)) {
    throw modelHubError("MODEL_HUB_VALUE_INVALID", "The cost value is invalid.");
  }
  return value;
}

function validateCurrency(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (!/^[A-Z]{3}$/.test(value)) {
    throw modelHubError("MODEL_HUB_VALUE_INVALID", "The currency is invalid.");
  }
  return value;
}

function containsProhibitedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProhibitedKey);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    if (
      normalized.includes("apikey") ||
      normalized.includes("password") ||
      normalized.includes("secret") ||
      normalized.includes("credential") ||
      normalized.includes("authorization") ||
      normalized === "prompt" ||
      normalized === "messages" ||
      normalized === "content" ||
      normalized === "response"
    ) {
      return true;
    }
    if (containsProhibitedKey(nested)) {
      return true;
    }
  }
  return false;
}

function modelHubError(code: string, message: string): ModelHubStoreError {
  return new ModelHubStoreError(code, message);
}

function conflict(code: string): ModelHubStoreError {
  return new ModelHubStoreError(code, "The stored value changed before this update.", true);
}

const CONNECTION_SELECT = `SELECT
  id, provider_kind, display_name, protocol, region, workspace_id, endpoint_id,
  base_url, credential_ref, credential_state, authentication_mode,
  credential_header_name, model_discovery_path, text_generation_path,
  embedding_path, request_timeout_ms, retry_limit, connection_status,
  catalog_sync_status, last_tested_at, last_catalog_synced_at, last_error_code,
  last_error_summary, legacy_provider_id, enabled, revision, created_at, updated_at
FROM model_provider_connections`;

const CATALOG_SELECT = `SELECT
  id, connection_id, provider_model_id, display_name, owned_by, catalog_source,
  availability, lifecycle, input_token_limit, output_token_limit,
  first_discovered_at, last_seen_at, stale_after, last_sync_id, revision
FROM model_catalog_entries`;

const CATALOG_SYNC_SELECT = `SELECT
  id, connection_id, source, status, discovered_model_count,
  next_page_token_present, error_code, error_summary, started_at, completed_at
FROM model_catalog_syncs`;

const CAPABILITY_EVIDENCE_SELECT = `SELECT
  id, catalog_entry_id, scan_id, capability, verdict, evidence_source,
  evidence_version, evidence_summary, observed_at, expires_at
FROM model_capability_evidence`;

const COST_PRIVACY_PROFILE_SELECT = `SELECT
  catalog_entry_id, currency, input_micros_per_million_tokens,
  output_micros_per_million_tokens, cached_input_micros_per_million_tokens,
  pricing_version, price_updated_at, data_destination, retention_policy,
  training_policy, evidence_source, evidence_version, evidence_summary,
  evidence_updated_at, revision, created_at, updated_at
FROM model_cost_privacy_profiles`;

const EVALUATION_RESULT_SELECT = `SELECT
  id, catalog_entry_id, task, score_basis_points, latency_p50_ms,
  sample_count, evaluation_source, evaluation_version, observed_at, expires_at
FROM model_evaluation_results`;

const PRESET_SELECT = `SELECT
  id, scheme, display_name, status, privacy_policy, cost_priority,
  route_generation_version, revision, created_at, updated_at
FROM model_hub_presets`;

const ROUTE_SELECT = `SELECT
  task, primary_catalog_entry_id, fallback_catalog_entry_id, preset_id,
  parameter_policy_json, maximum_cost_micros, currency, privacy_policy,
  failure_policy, route_origin, enabled, revision, created_at, updated_at
FROM novel_task_routes`;

const RECENT_AI_FAILURE_SELECT = `SELECT *
FROM (
  SELECT
    'capability_scan:' || scan.id AS diagnostic_id,
    scan.completed_at AS timestamp,
    connection.provider_kind AS provider_kind,
    connection.id AS connection_id,
    catalog.provider_model_id AS model_id,
    'capability_probe' AS task_type,
    scan.failure_stage,
    scan.error_code AS normalized_error_code,
    scan.failure_retryable,
    scan.http_status,
    scan.finish_reason,
    scan.visible_content_length,
    scan.reasoning_present,
    scan.streamed,
    COALESCE(scan.attempt, 1) AS attempt,
    scan.requested_max_output_tokens,
    scan.diagnostic_request_id
  FROM model_capability_scans AS scan
  JOIN model_catalog_entries AS catalog ON catalog.id = scan.catalog_entry_id
  JOIN model_provider_connections AS connection ON connection.id = catalog.connection_id
  WHERE scan.status IN ('partial', 'failed')
    AND scan.error_code IS NOT NULL
    AND scan.completed_at IS NOT NULL

  UNION ALL

  SELECT
    'model_invocation:' || invocation.id AS diagnostic_id,
    invocation.completed_at AS timestamp,
    invocation.provider_kind_snapshot AS provider_kind,
    invocation.connection_id,
    invocation.model_id_snapshot AS model_id,
    invocation.task AS task_type,
    invocation.failure_stage,
    invocation.error_code AS normalized_error_code,
    invocation.failure_retryable,
    invocation.http_status,
    invocation.finish_reason,
    invocation.visible_content_length,
    invocation.reasoning_present,
    invocation.streamed,
    invocation.attempt,
    invocation.requested_max_output_tokens,
    invocation.diagnostic_request_id
  FROM model_invocation_facts AS invocation
  WHERE invocation.status IN ('failed', 'timed_out')
    AND invocation.error_code IS NOT NULL
    AND invocation.completed_at IS NOT NULL
)
ORDER BY timestamp DESC, diagnostic_id ASC
LIMIT ?`;

const INVOCATION_SELECT = `SELECT
  id, task, route_task, connection_id, catalog_entry_id, provider_kind_snapshot,
  model_id_snapshot, route_reason, status, attempt, fallback_from_invocation_id,
  privacy_policy, data_destination, maximum_cost_micros, currency, input_tokens,
  output_tokens, cached_input_tokens, estimated_cost_micros, error_code,
  error_summary, diagnostic_request_id, failure_stage, failure_retryable,
  http_status, finish_reason, visible_content_length, reasoning_present,
  streamed, requested_max_output_tokens, started_at, completed_at, created_at, revision
FROM model_invocation_facts`;
