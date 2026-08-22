import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MODEL_ROUTE_ROLES, type ModelRouteRole } from "@inkshadow/ai-core";
import type { DatabaseIntegrityReport, NativePathTicket } from "@inkshadow/data";
import type { MemoryPolicy, MemoryRecord } from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  FormField,
  InlineAlert,
  Input,
  SaveStatus,
  Select,
} from "@inkshadow/ui";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useAppearancePreference } from "../appearance-preference";
import { DataTransferPanel } from "../components/data-transfer-panel";
import { DirectModeAuthorizationDialog } from "../components/direct-mode-authorization-dialog";
import {
  ModelHubSelectableCatalogBrowser,
  type ModelHubSelectableCatalogConnectedModel,
  type ModelHubSelectableCatalogSelection,
} from "../components/model-hub-selectable-catalog-browser";
import { ModelHubEvaluationPanel } from "../components/model-hub-evaluation-panel";
import { ModelHubImageGenerationPanel } from "../components/model-hub-image-generation-panel";
import {
  NovelSkillPaidEvaluationPanel,
  type NovelSkillPaidEvaluationTargetOption,
} from "../components/novel-skill-paid-evaluation-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import { useWritingExperience } from "../hooks/use-writing-experience";
import { collectDesktopDiagnosticArtifact } from "../infrastructure/diagnostics";
import type { AutomaticBackupRuntimeCheckResult } from "../infrastructure/automatic-backup-runtime";
import type { AutomaticBackupFailureKind } from "../infrastructure/automatic-backup-service";
import {
  loadEditorPreferences,
  saveEditorPreferences,
  type EditorPreferences,
} from "../infrastructure/editor-preferences-store";
import {
  loadEditorTypography,
  saveEditorTypography,
  type EditorFontFamily,
  type EditorMeasure,
  type EditorTypography,
} from "../infrastructure/editor-view-state-store";
import { downloadBrowserExportArtifact } from "../infrastructure/export-artifact-download";
import {
  assessLocalModelCapacity,
  canCheckModelEndpointWhileOffline,
  type LocalModelCapacityAssessment,
} from "../infrastructure/model-capacity";
import {
  MODEL_HUB_CAPABILITIES,
  MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS,
  MODEL_HUB_MAX_REQUEST_TIMEOUT_MS,
  MODEL_HUB_MAX_RETRY_LIMIT,
  MODEL_HUB_MIN_REQUEST_TIMEOUT_MS,
  MODEL_PROVIDER_KINDS,
  NOVEL_AI_TASKS,
  getModelProviderPreset,
  isLoopbackModelBaseUrl,
  normalizeCredentialHeaderName,
  normalizeModelHubApiPath,
  normalizeModelHubRequestTimeoutMs,
  normalizeModelHubRetryLimit,
  resolveProviderBaseUrl,
  type ModelHubCapability,
  type ModelHubScheme,
  type ModelProviderKind,
  type NovelAiTask,
} from "../infrastructure/model-hub-provider-registry";
import {
  modelHubCredentialRef,
  modelHubNativeEndpointConfig,
} from "../infrastructure/model-hub-native-config";
import {
  clearModelHubConnectionIntent,
  loadModelHubConnectionIntent,
  saveModelHubConnectionIntent,
  type ModelHubConnectionIntent,
} from "../infrastructure/model-hub-connection-intent";
import { retireModelHubConnection } from "../infrastructure/model-hub-connection-retirement-service";
import {
  deleteModelHubCredential,
  saveModelHubCredential,
} from "../infrastructure/model-hub-credential-mutation-service";
import {
  modelHubReadinessBlockerLabel,
  MODEL_HUB_READINESS_CHANGED_EVENT,
  MODEL_HUB_READINESS_REFRESH_INTERVAL_MS,
  MODEL_HUB_STATE_EXPLANATIONS,
  USER_FACING_MODEL_HUB_STATES,
  projectModelHubReadiness,
  type ModelHubReadinessProjection,
} from "../infrastructure/model-hub-readiness";
import { applyAutomaticModelHubRouting } from "../infrastructure/model-hub-routing-service";
import {
  MODEL_HUB_TASK_GROUPS,
  buildModelHubRoutingVisibility,
  capabilityLabel,
  modelHubTaskGroupLabel,
  type ModelHubCapabilityDisplayState,
} from "../infrastructure/model-hub-routing-visibility";
import { bridgeLegacyModelProfilesToModelHub } from "../infrastructure/model-hub-legacy-bridge";
import { resolveModelHubFormReadiness } from "../infrastructure/model-hub-form-readiness";
import {
  ModelHubOperationCoordinator,
  createInitialModelHubPageSnapshot,
  createProviderDraftModelHubPageSnapshot,
  isModelHubHydrationPending,
  loadAuthoritativeModelHubHydration,
  modelHubHydrationPhaseLabel,
  preserveModelHubPageSnapshotAfterFailure,
  transitionModelHubPageSnapshot,
  type ModelHubHydrationPhase,
  type ModelHubOperationToken,
  type ModelHubPageAction,
} from "../infrastructure/model-hub-page-hydration";
import {
  finishModelHubDiagnosticAction,
  recordModelHubUiUnmount,
  recordModelHubUiSnapshot,
  startModelHubDiagnosticAction,
} from "../infrastructure/model-hub-ui-diagnostics";
import { ModelHubLocalEvaluationService } from "../infrastructure/model-hub-local-evaluation-service";
import {
  MODEL_HUB_TEXT_CAPABILITY_PROBE_DISPATCH_SCOPE,
  MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  MODEL_HUB_TEXT_CAPABILITY_PROBE_MESSAGES,
  executeAuditedModelHubTextCapabilityProbe,
  modelHubTextCapabilityProbeFailureMetadata,
} from "../infrastructure/model-hub-text-capability-probe";
import {
  MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION,
  executeAuditedModelHubStructuredCapabilityProbe,
} from "../infrastructure/model-hub-structured-capability-probe";
import {
  MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION,
  executeAuditedModelHubTranslationCapabilityProbe,
} from "../infrastructure/model-hub-translation-capability-probe";
import {
  recommendConnectedModelsForTask,
  type ModelHubTaskRecommendation,
} from "../infrastructure/model-hub-task-recommendation";
import {
  assertConfirmedModelHubTaskCapabilityProbeDisclosure,
  ModelHubTaskCapabilityProbeDisclosureError,
  prepareModelHubTaskCapabilityProbeDisclosure,
  type ModelHubTaskCapabilityProbeDisclosure,
} from "../infrastructure/model-hub-task-capability-probe-disclosure";
import { providerRecommendationsForTask } from "../infrastructure/provider-recommendation-registry";
import {
  SELECTABLE_MODEL_CATALOG_ENTRIES,
  SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
  mergeConnectedAndSelectableModels,
  projectSelectableModelCatalog,
  selectableModelsForTask,
  type MergedSelectableModelCatalogEntry,
  type SelectableModelCatalogProjection,
} from "../infrastructure/selectable-model-catalog-registry";
import {
  assertModelHubFinalDispatchUnchanged,
  ModelHubFinalDispatchError,
  modelHubFinalDispatchIdentity,
} from "../infrastructure/model-hub-final-dispatch-guard";
import { providerActionFingerprint } from "../infrastructure/provider-action-disclosure";
import {
  isRetiredModelProviderConnection,
  ModelHubStoreError,
  type ModelCatalogEntry,
  type ModelCapabilityEvidence,
  type ModelCostPrivacyProfile,
  type ModelHubPrivacyPolicy,
  type ModelHubStore,
  type ModelInvocationFact,
  type ModelProviderConnection,
  type NovelTaskRoute,
  type RecentAiFailure,
  type SaveModelProviderConnectionInput,
} from "../infrastructure/model-hub-store";
import type {
  NativeGatewayAuthenticationMode,
  NativeGatewayProviderKind,
} from "../infrastructure/native-model-gateway-contract";
import {
  type NativeModelConnectionResponse,
  type NativeModelCapacityResponse,
  type NativeModelDescriptor,
  type SecretSummary,
} from "../infrastructure/runtime";
import {
  normalizeUiError,
  projectOrdinaryUiError,
  UiActionError,
} from "../infrastructure/ui-error";
import type {
  ModelPricingProfile,
  ModelProfile,
  NativeAuthenticationMode,
  NativeProviderKind,
} from "../infrastructure/model-center-store";
import type { ModelRoleRoute } from "../infrastructure/model-routing-store";
import { useRuntime } from "../runtime-context";
import { SecureUpdateCard } from "./secure-update-card";

const DEFAULT_OPENAI_PROFILE = {
  providerId: "openai",
  provider: "open_ai_compatible",
  baseUrl: "https://api.openai.com/v1",
  authentication: "bearer_keyring",
  selectedModel: null,
} as const;

const CONNECTABLE_PROVIDER_KINDS = MODEL_PROVIDER_KINDS;

type ConnectableProviderKind = (typeof CONNECTABLE_PROVIDER_KINDS)[number];

interface SettingsTextProbeFormSnapshot {
  readonly providerId: string;
  readonly providerKind: ConnectableProviderKind;
  readonly loadedConnectionId: string | null;
  readonly baseUrl: string;
  readonly region: string;
  readonly workspaceId: string;
  readonly endpointId: string;
  readonly authentication: NativeGatewayAuthenticationMode;
  readonly credentialHeaderName: string;
  readonly modelDiscoveryPath: string;
  readonly textGenerationPath: string;
  readonly embeddingPath: string;
  readonly requestTimeoutMs: string;
  readonly retryLimit: string;
  readonly selectedModel: string;
  readonly credentialConfigured: boolean;
  readonly credentialEditRevision: number;
}

interface PreparedSettingsTextProbeAuthorization {
  readonly form: SettingsTextProbeFormSnapshot;
  readonly connectionInput: SaveModelProviderConnectionInput;
  readonly submittedSecret: string | null;
  readonly modelId: string;
  readonly disclosureFingerprint: string;
}

class SettingsTextProbePostDispatchConflictError extends Error {
  public readonly code = "MODEL_HUB_PROBE_TARGET_CHANGED_AFTER_DISPATCH";
  public readonly retryable = true;

  public constructor() {
    super("The fixed probe target changed after the provider call and its result was not saved.");
    this.name = "SettingsTextProbePostDispatchConflictError";
  }
}

type SettingsPricingProfile = Omit<ModelPricingProfile, "contextWindowTokens"> & {
  readonly contextWindowTokens: number | null;
};

const MODEL_HUB_SECTION_IDS = [
  "model-center",
  "model-routing",
  "model-evaluation",
  "image-generation",
] as const;
type ModelHubSectionId = (typeof MODEL_HUB_SECTION_IDS)[number];

const MODEL_HUB_SECTION_META: Readonly<
  Record<
    ModelHubSectionId,
    Readonly<{ title: string; navigationLabel: string; description: string }>
  >
> = Object.freeze({
  "model-center": Object.freeze({
    title: "模型中心 · 连接与模型",
    navigationLabel: "连接与模型",
    description: "连接供应商、验证凭据、发现模型，并确认模型真正可用的能力。",
  }),
  "model-routing": Object.freeze({
    title: "模型中心 · AI 分工",
    navigationLabel: "AI 分工",
    description: "为写作、规划、记忆和检查选择主模型、备用模型与隐私边界。",
  }),
  "model-evaluation": Object.freeze({
    title: "模型中心 · 模型评测",
    navigationLabel: "模型评测",
    description: "用本地评测证据比较模型表现；评测不会替代真实连接状态。",
  }),
  "image-generation": Object.freeze({
    title: "模型中心 · 图片生成",
    navigationLabel: "图片生成",
    description: "使用经过能力确认的图片模型，并在发送前明确确认提示与费用。",
  }),
});

const MODEL_HUB_SCHEME_OPTIONS = [
  {
    value: "smart",
    label: "智能推荐",
    description: "按写作、规划和检查任务自动使用当前已连接的模型。",
  },
  {
    value: "quality",
    label: "高质量",
    description: "优先把正文和深度检查交给当前高质量模型。",
  },
  {
    value: "economy",
    label: "经济模式",
    description: "优先把高频轻量任务交给低延迟、低成本模型。",
  },
  {
    value: "local_privacy",
    label: "本地隐私",
    description: "只使用已连接的本机 Ollama；没有本地模型时不会回退到云端。",
  },
  {
    value: "custom",
    label: "完全自定义",
    description: "在专家设置中逐项调整兼容路由。",
  },
] as const satisfies readonly {
  readonly value: ModelHubScheme;
  readonly label: string;
  readonly description: string;
}[];

function resolveModelHubSection(hash: string): ModelHubSectionId | null {
  const sectionId = hash.startsWith("#") ? hash.slice(1) : hash;
  return MODEL_HUB_SECTION_IDS.find((candidate) => candidate === sectionId) ?? null;
}

type ModelHubTargetSection =
  | "model-center"
  | "provider-connection"
  | "model-selection"
  | "model-pricing"
  | "model-capabilities";

function resolveModelHubTargetSection(search: string): ModelHubTargetSection {
  const requested = new URLSearchParams(search).get("targetSection");
  return (
    [
      "model-center",
      "provider-connection",
      "model-selection",
      "model-pricing",
      "model-capabilities",
    ] as const
  ).includes(requested as ModelHubTargetSection)
    ? (requested as ModelHubTargetSection)
    : "model-center";
}

function resolveSafeEditorReturnRoute(search: string): string | null {
  const requested = new URLSearchParams(search).get("returnRoute");
  if (requested === null || !requested.startsWith("/") || requested.startsWith("//")) {
    return null;
  }
  const parsed = new URL(requested, "https://inkshadow.local");
  if (
    parsed.origin !== "https://inkshadow.local" ||
    !/^\/projects\/[^/]+\/chapters\/[^/]+$/u.test(parsed.pathname)
  ) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}`;
}

function isCompletePaidEvaluationCostProfile(
  profile: ModelCostPrivacyProfile | undefined,
): profile is ModelCostPrivacyProfile {
  const integerRate = /^(?:0|[1-9]\d{0,17})$/u;
  return (
    profile !== undefined &&
    profile.dataDestination !== "unknown" &&
    profile.evidenceSource !== "unknown" &&
    profile.currency !== null &&
    /^[A-Z]{3}$/u.test(profile.currency) &&
    profile.inputMicrosPerMillionTokens !== null &&
    integerRate.test(profile.inputMicrosPerMillionTokens) &&
    profile.outputMicrosPerMillionTokens !== null &&
    integerRate.test(profile.outputMicrosPerMillionTokens) &&
    (profile.cachedInputMicrosPerMillionTokens === null ||
      integerRate.test(profile.cachedInputMicrosPerMillionTokens)) &&
    profile.pricingVersion !== null &&
    profile.priceUpdatedAt !== null
  );
}

export function SettingsPage() {
  const runtime = useRuntime();
  const writingExperience = useWritingExperience();
  const {
    preference: appearance,
    resolvedSurface,
    setPreference: setAppearance,
  } = useAppearancePreference();
  const modelEvaluation = useMemo(
    () => new ModelHubLocalEvaluationService(runtime, runtime.modelHub, runtime.ids, runtime.clock),
    [runtime],
  );
  const location = useLocation();
  const navigate = useNavigate();
  const activeModelHubSection = resolveModelHubSection(location.hash);
  const modelHubTargetSection = resolveModelHubTargetSection(location.search);
  const editorReturnRoute = resolveSafeEditorReturnRoute(location.search);
  const isModelHubView = activeModelHubSection !== null;
  const modelHubPageMeta =
    activeModelHubSection === null ? null : MODEL_HUB_SECTION_META[activeModelHubSection];
  const online = useOnlineStatus();
  const [editorTypography, setEditorTypography] = useState<EditorTypography>(() =>
    loadEditorTypography(window.localStorage),
  );
  const [editorPreferences, setEditorPreferences] = useState<EditorPreferences>(() =>
    loadEditorPreferences(window.localStorage),
  );
  const [writingPreferenceError, setWritingPreferenceError] = useState<string | null>(null);
  const [directAuthorizationOpen, setDirectAuthorizationOpen] = useState(false);
  const [summary, setSummary] = useState<SecretSummary>({
    configured: false,
    lastFour: null,
  });
  const modelHubOperationCoordinatorRef = useRef(new ModelHubOperationCoordinator());
  const modelHubSnapshotRevisionRef = useRef(0);
  const [modelHubPageSnapshot, setModelHubPageSnapshot] = useState(
    createInitialModelHubPageSnapshot,
  );
  const [authoritativeModelHubReadiness, setAuthoritativeModelHubReadiness] = useState<Readonly<{
    fingerprint: string;
    readiness: ModelHubReadinessProjection;
  }> | null>(null);
  const [modelHubMutationNotice, setModelHubMutationNotice] = useState<Readonly<{
    message: string;
    reloadRequired: boolean;
  }> | null>(null);
  const [profiles, setProfiles] = useState<readonly ModelProfile[]>([]);
  const [, setProfile] = useState<ModelProfile | null>(null);
  const [hubConnections, setHubConnections] = useState<readonly ModelProviderConnection[]>([]);
  const [hubConnection, setHubConnection] = useState<ModelProviderConnection | null>(null);
  const [hubCatalog, setHubCatalog] = useState<readonly ModelCatalogEntry[]>([]);
  const [routingCatalog, setRoutingCatalog] = useState<readonly ModelCatalogEntry[]>([]);
  const [routingCapabilityEvidence, setRoutingCapabilityEvidence] = useState<
    readonly ModelCapabilityEvidence[]
  >([]);
  const [routingCostPrivacyProfiles, setRoutingCostPrivacyProfiles] = useState<
    readonly ModelCostPrivacyProfile[]
  >([]);
  const [routingRecentAiFailures, setRoutingRecentAiFailures] = useState<
    readonly RecentAiFailure[]
  >([]);
  const [localCatalogEntryIds, setLocalCatalogEntryIds] = useState<readonly string[]>([]);
  const [novelTaskRoutes, setNovelTaskRoutes] = useState<readonly NovelTaskRoute[]>([]);
  const [roleRoutes, setRoleRoutes] = useState<readonly ModelRoleRoute[]>([]);
  const [providerPreset, setProviderPreset] = useState<ConnectableProviderKind>("openai");
  const [expertMode, setExpertMode] = useState(false);
  const [connectionSetupExpanded, setConnectionSetupExpanded] = useState(false);
  const [modelHubScheme, setModelHubScheme] = useState<ModelHubScheme>("smart");
  const [schemeSaving, setSchemeSaving] = useState(false);
  const [schemeMessage, setSchemeMessage] = useState<string | null>(null);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [routeRole, setRouteRole] = useState<ModelRouteRole>("high_quality");
  const [paidEvaluationExpanded, setPaidEvaluationExpanded] = useState(false);
  const [routePrimaryProviderId, setRoutePrimaryProviderId] = useState("");
  const [routeFallbackProviderId, setRouteFallbackProviderId] = useState("");
  const [routeSaving, setRouteSaving] = useState(false);
  const [recommendedTaskBusy, setRecommendedTaskBusy] = useState<NovelAiTask | null>(null);
  const [taskProbeConfirmation, setTaskProbeConfirmation] = useState<Readonly<{
    task: NovelAiTask;
    recommendation: ModelHubTaskRecommendation;
    disclosure: ModelHubTaskCapabilityProbeDisclosure;
  }> | null>(null);
  const [expandedModelTasks, setExpandedModelTasks] = useState<readonly NovelAiTask[]>([]);
  const [configuredTaskPartitionExpanded, setConfiguredTaskPartitionExpanded] = useState(false);
  const [missingTaskPartitionExpanded, setMissingTaskPartitionExpanded] = useState(false);
  const [connectionIntent, setConnectionIntent] = useState<ModelHubConnectionIntent | null>(() =>
    loadModelHubConnectionIntent(
      window.localStorage,
      runtime.clock.now(),
      SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
    ),
  );
  const [routeError, setRouteError] = useState<unknown>(null);
  const [routeFailureRollbackConfirmed, setRouteFailureRollbackConfirmed] = useState<
    boolean | null
  >(null);
  const [
    routeFailureLegacyProjectionMayHaveChanged,
    setRouteFailureLegacyProjectionMayHaveChanged,
  ] = useState(false);
  const [taskMatrixFilter, setTaskMatrixFilter] = useState<"all" | "missing" | "failed">("all");
  const [novelRouteTask, setNovelRouteTask] = useState<NovelAiTask>("prose_generation");
  const [novelRoutePrimaryCatalogId, setNovelRoutePrimaryCatalogId] = useState("");
  const [novelRouteFallbackCatalogId, setNovelRouteFallbackCatalogId] = useState("");
  const [novelRouteMaximumCost, setNovelRouteMaximumCost] = useState("");
  const [novelRouteCurrency, setNovelRouteCurrency] = useState("USD");
  const [novelRoutePrivacy, setNovelRoutePrivacy] =
    useState<ModelHubPrivacyPolicy>("cloud_allowed");
  const [novelRouteFailure, setNovelRouteFailure] =
    useState<NovelTaskRoute["failurePolicy"]>("use_fallback");
  const [novelRouteRemoteContentConsent, setNovelRouteRemoteContentConsent] = useState(false);
  const [providerId, setProviderId] = useState<string>(DEFAULT_OPENAI_PROFILE.providerId);
  const [provider, setProvider] = useState<NativeProviderKind>(DEFAULT_OPENAI_PROFILE.provider);
  const [baseUrl, setBaseUrl] = useState<string>(DEFAULT_OPENAI_PROFILE.baseUrl);
  const [region, setRegion] = useState("china_beijing");
  const [workspaceId, setWorkspaceId] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [authentication, setAuthentication] = useState<NativeGatewayAuthenticationMode>(
    DEFAULT_OPENAI_PROFILE.authentication,
  );
  const [credentialHeaderName, setCredentialHeaderName] = useState("");
  const [modelDiscoveryPath, setModelDiscoveryPath] = useState("");
  const [textGenerationPath, setTextGenerationPath] = useState("");
  const [embeddingPath, setEmbeddingPath] = useState("");
  const [requestTimeoutMs, setRequestTimeoutMs] = useState(
    String(MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS),
  );
  const [retryLimit, setRetryLimit] = useState("0");
  const [selectedModel, setSelectedModel] = useState("");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [pricingCurrency, setPricingCurrency] = useState("USD");
  const [inputPricePerMillion, setInputPricePerMillion] = useState("");
  const [outputPricePerMillion, setOutputPricePerMillion] = useState("");
  const [cachedInputPricePerMillion, setCachedInputPricePerMillion] = useState("");
  const [pricingVersion, setPricingVersion] = useState("");
  const [priceUpdatedDate, setPriceUpdatedDate] = useState("");
  const [models, setModels] = useState<readonly NativeModelDescriptor[]>([]);
  const [connection, setConnection] = useState<NativeModelConnectionResponse | null>(null);
  const [modelCapacity, setModelCapacity] = useState<NativeModelCapacityResponse | null>(null);
  const [secret, setSecret] = useState("");
  const [confirmedCapabilities, setConfirmedCapabilities] = useState<readonly ModelHubCapability[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingModel, setCheckingModel] = useState(false);
  const [probingCapability, setProbingCapability] = useState(false);
  const [capabilityProbeMessage, setCapabilityProbeMessage] = useState<string | null>(null);
  const [capabilityProbeError, setCapabilityProbeError] = useState<unknown>(null);
  const credentialEditRevisionRef = useRef(0);
  const settingsTextProbeFormRef = useRef<SettingsTextProbeFormSnapshot | null>(null);
  useLayoutEffect(() => {
    settingsTextProbeFormRef.current = Object.freeze({
      providerId,
      providerKind: providerPreset,
      loadedConnectionId: hubConnection?.id ?? null,
      baseUrl,
      region,
      workspaceId,
      endpointId,
      authentication,
      credentialHeaderName,
      modelDiscoveryPath,
      textGenerationPath,
      embeddingPath,
      requestTimeoutMs,
      retryLimit,
      selectedModel,
      credentialConfigured: summary.configured || secret.trim().length > 0,
      credentialEditRevision: credentialEditRevisionRef.current,
    });
  }, [
    authentication,
    baseUrl,
    credentialHeaderName,
    embeddingPath,
    endpointId,
    hubConnection?.id,
    modelDiscoveryPath,
    providerId,
    providerPreset,
    region,
    requestTimeoutMs,
    retryLimit,
    secret,
    selectedModel,
    summary.configured,
    textGenerationPath,
    workspaceId,
  ]);
  const [credentialError, setCredentialError] = useState<unknown>(null);
  const [retirementMessage, setRetirementMessage] = useState<string | null>(null);
  const [retireConnectionTarget, setRetireConnectionTarget] =
    useState<ModelProviderConnection | null>(null);
  const [retiringConnection, setRetiringConnection] = useState(false);
  const [integrity, setIntegrity] = useState<DatabaseIntegrityReport | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState<"inspect" | "backup" | "restore" | null>(
    null,
  );
  const [maintenanceError, setMaintenanceError] = useState<unknown>(null);
  const [backupComplete, setBackupComplete] = useState(false);
  const [automaticBackupCheck, setAutomaticBackupCheck] =
    useState<AutomaticBackupRuntimeCheckResult | null>(null);
  const [automaticBackupChecking, setAutomaticBackupChecking] = useState(false);
  const [restoreSourceTicket, setRestoreSourceTicket] = useState<NativePathTicket | null>(null);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<unknown>(null);
  const [diagnosticId, setDiagnosticId] = useState<string | null>(null);
  const [memoryProjects, setMemoryProjects] = useState<
    readonly Readonly<{ id: string; name: string; status: "active" | "archived" }>[]
  >([]);
  const [selectedMemoryProjectId, setSelectedMemoryProjectId] = useState("");
  const [selectedMemoryPolicy, setSelectedMemoryPolicy] = useState<MemoryPolicy | null>(null);
  const [selectedProjectMemories, setSelectedProjectMemories] = useState<readonly MemoryRecord[]>(
    [],
  );
  const [memoryGovernanceLoading, setMemoryGovernanceLoading] = useState(false);
  const [memoryGovernanceBusy, setMemoryGovernanceBusy] = useState(false);
  const [memoryGovernanceError, setMemoryGovernanceError] = useState<unknown>(null);
  const [memoryClearDialogOpen, setMemoryClearDialogOpen] = useState(false);
  const [memoryClearOperationId, setMemoryClearOperationId] = useState<string | null>(null);
  const [memoryClearMessage, setMemoryClearMessage] = useState<string | null>(null);

  const applyHubModelToForm = useCallback(
    (catalogEntry: ModelCatalogEntry | null, costPrivacy: ModelCostPrivacyProfile | null): void => {
      setContextWindowTokens(
        catalogEntry?.inputTokenLimit === null || catalogEntry?.inputTokenLimit === undefined
          ? ""
          : String(catalogEntry.inputTokenLimit),
      );
      setPricingCurrency(costPrivacy?.currency ?? "USD");
      setInputPricePerMillion(
        costPrivacy?.inputMicrosPerMillionTokens === null ||
          costPrivacy?.inputMicrosPerMillionTokens === undefined
          ? ""
          : formatMicrosStringAsCurrency(costPrivacy.inputMicrosPerMillionTokens),
      );
      setOutputPricePerMillion(
        costPrivacy?.outputMicrosPerMillionTokens === null ||
          costPrivacy?.outputMicrosPerMillionTokens === undefined
          ? ""
          : formatMicrosStringAsCurrency(costPrivacy.outputMicrosPerMillionTokens),
      );
      setCachedInputPricePerMillion(
        costPrivacy?.cachedInputMicrosPerMillionTokens === null ||
          costPrivacy?.cachedInputMicrosPerMillionTokens === undefined
          ? ""
          : formatMicrosStringAsCurrency(costPrivacy.cachedInputMicrosPerMillionTokens),
      );
      setPricingVersion(costPrivacy?.pricingVersion ?? "");
      setPriceUpdatedDate(costPrivacy?.priceUpdatedAt?.slice(0, 10) ?? "");
    },
    [],
  );

  const refreshRoutingVisibilityEvidence = useCallback(
    async (entries: readonly ModelCatalogEntry[]): Promise<void> => {
      const [evidenceGroups, costProfiles, recentFailures, confirmedLocalIds] = await Promise.all([
        Promise.all(entries.map((entry) => runtime.modelHub.listCapabilityEvidence(entry.id))),
        Promise.all(entries.map((entry) => runtime.modelHub.findCostPrivacyProfile(entry.id))),
        runtime.modelHub.listRecentAiFailures(25).catch(() => Object.freeze([])),
        loadEvidenceConfirmedLocalCatalogIds(runtime.modelHub, entries),
      ]);
      setRoutingCapabilityEvidence(Object.freeze(evidenceGroups.flat()));
      setRoutingCostPrivacyProfiles(
        Object.freeze(
          costProfiles.filter((profile): profile is ModelCostPrivacyProfile => profile !== null),
        ),
      );
      setRoutingRecentAiFailures(recentFailures);
      setLocalCatalogEntryIds(confirmedLocalIds);
    },
    [runtime],
  );

  const loadModelCenter = useCallback(
    async (
      options: Readonly<{
        action?: ModelHubPageAction;
        token?: ModelHubOperationToken;
        requestedConnectionId?: string | null;
        requestedModelId?: string | null;
        backendCommitted?: boolean;
        catalogRefreshFailed?: boolean;
      }> = {},
    ): Promise<boolean> => {
      const requested = new URLSearchParams(location.search);
      const requestedConnectionId = options.requestedConnectionId ?? requested.get("connectionId");
      const requestedModelId = options.requestedModelId ?? requested.get("modelId");
      const action = options.action ?? "bootstrap";
      const operationBackendCommitted = options.backendCommitted === true;
      const coordinator = modelHubOperationCoordinatorRef.current;
      const token =
        options.token ??
        coordinator.begin(action, {
          connectionId: requestedConnectionId,
          modelId: requestedModelId,
        });
      if (
        options.token !== undefined &&
        !coordinator.isCurrent(token, {
          connectionId: requestedConnectionId,
          modelId: requestedModelId,
        })
      ) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted: operationBackendCommitted,
          staleResultIgnored: true,
        });
        return false;
      }
      const activePhaseRef: { current: ModelHubHydrationPhase } = {
        current: "BOOTSTRAPPING",
      };
      if (options.token === undefined) {
        startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
      }
      setLoading(true);
      setModelHubMutationNotice(null);
      setModelHubPageSnapshot((current) =>
        transitionModelHubPageSnapshot(current, activePhaseRef.current, action),
      );

      try {
        if (runtime.mode !== "tauri") {
          await coordinator.runDeduplicated("legacy-model-hub-bridge", () =>
            bridgeLegacyModelProfilesToModelHub({
              modelCenter: runtime.modelCenter,
              modelHub: runtime.modelHub,
              credentials: runtime.credentials,
              clock: runtime.clock,
            }),
          );
        }
        if (!coordinator.isCurrent(token)) {
          finishModelHubDiagnosticAction(runtime, token, {
            completedAt: runtime.clock.now(),
            outcome: "stale_ignored",
            backendCommitted: operationBackendCommitted,
            staleResultIgnored: true,
          });
          return false;
        }

        const nextSnapshotRevision = modelHubSnapshotRevisionRef.current + 1;
        const [hydration, storedProfiles, storedRoutes] = await Promise.all([
          loadAuthoritativeModelHubHydration({
            modelHub: runtime.modelHub,
            credentials: runtime.credentials,
            mode: runtime.mode,
            clock: runtime.clock,
            requestedConnectionId,
            requestedModelId,
            snapshotRevision: nextSnapshotRevision,
            lastAction: action,
            onPhase: (phase) => {
              activePhaseRef.current = phase;
              if (!coordinator.isCurrent(token)) return;
              setModelHubPageSnapshot((current) =>
                transitionModelHubPageSnapshot(current, phase, action),
              );
            },
          }),
          runtime.modelCenter.listProfiles(),
          runtime.modelRouting.listRoutes(),
        ]);

        if (!coordinator.isCurrent(token)) {
          finishModelHubDiagnosticAction(runtime, token, {
            completedAt: runtime.clock.now(),
            outcome: "stale_ignored",
            backendCommitted: operationBackendCommitted,
            staleResultIgnored: true,
            catalogCount: hydration.allCatalogEntries.length,
          });
          return false;
        }

        modelHubSnapshotRevisionRef.current = nextSnapshotRevision;
        const selectedConnection = hydration.selectedConnection;
        const selectedProfile =
          storedProfiles.find(({ providerId: id }) => id === selectedConnection?.id) ?? null;
        const proseRoute = hydration.routes.find(({ task }) => task === "prose_generation");
        const selectedRoute = storedRoutes.find(({ role }) => role === "high_quality");

        setHubConnections(hydration.page.connections);
        setHubConnection(selectedConnection);
        setHubCatalog(hydration.selectedCatalog);
        setRoutingCatalog(hydration.allCatalogEntries);
        setRoutingCapabilityEvidence(hydration.routingCapabilityEvidence);
        setRoutingCostPrivacyProfiles(hydration.routingCostPrivacyProfiles);
        setRoutingRecentAiFailures(hydration.recentAiFailures);
        setLocalCatalogEntryIds(hydration.evidenceConfirmedLocalCatalogIds);
        setNovelTaskRoutes(hydration.routes);
        setProfiles(storedProfiles);
        setRoleRoutes(storedRoutes);
        setNovelRoutePrimaryCatalogId(proseRoute?.primaryCatalogEntryId ?? "");
        setNovelRouteFallbackCatalogId(proseRoute?.fallbackCatalogEntryId ?? "");
        setNovelRouteMaximumCost(
          proseRoute?.maximumCostMicros === null || proseRoute?.maximumCostMicros === undefined
            ? ""
            : formatMicrosStringAsCurrency(proseRoute.maximumCostMicros),
        );
        setNovelRouteCurrency(proseRoute?.currency ?? "USD");
        setNovelRoutePrivacy(proseRoute?.privacyPolicy ?? "cloud_allowed");
        setNovelRouteFailure(proseRoute?.failurePolicy ?? "use_fallback");
        setNovelRouteRemoteContentConsent(false);
        setModelHubScheme(hydration.activePreset?.scheme ?? inferModelHubScheme(storedRoutes));
        setRoutePrimaryProviderId(
          selectedRoute?.primaryProviderId ??
            storedProfiles.find(({ selectedModel }) => selectedModel !== null)?.providerId ??
            "",
        );
        setRouteFallbackProviderId(selectedRoute?.fallbackProviderId ?? "");
        setProfile(selectedProfile);
        setProviderPreset(selectedConnection?.providerKind ?? "openai");
        setProviderId(selectedConnection?.id ?? DEFAULT_OPENAI_PROFILE.providerId);
        setProvider(
          selectedConnection === null
            ? DEFAULT_OPENAI_PROFILE.provider
            : legacyProviderKind(selectedConnection.providerKind),
        );
        setBaseUrl(selectedConnection?.baseUrl ?? DEFAULT_OPENAI_PROFILE.baseUrl);
        setRegion(selectedConnection?.region ?? "china_beijing");
        setWorkspaceId(selectedConnection?.workspaceId ?? "");
        setEndpointId(selectedConnection?.endpointId ?? "");
        setAuthentication(selectedConnection?.authenticationMode ?? "bearer_keyring");
        setCredentialHeaderName(selectedConnection?.credentialHeaderName ?? "");
        setModelDiscoveryPath(selectedConnection?.modelDiscoveryPath ?? "");
        setTextGenerationPath(selectedConnection?.textGenerationPath ?? "");
        setEmbeddingPath(selectedConnection?.embeddingPath ?? "");
        setRequestTimeoutMs(
          String(selectedConnection?.requestTimeoutMs ?? MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS),
        );
        setRetryLimit(String(selectedConnection?.retryLimit ?? 0));
        setSelectedModel(hydration.selectedCatalogEntry?.providerModelId ?? "");
        applyHubModelToForm(hydration.selectedCatalogEntry, hydration.selectedCostPrivacy);
        setConfirmedCapabilities(
          hydration.selectedCapabilities
            .filter(
              ({ evidenceSource, verdict, expiresAt }) =>
                evidenceSource === "user_confirmed" &&
                verdict === "supported" &&
                (expiresAt === null || expiresAt > new Date().toISOString()),
            )
            .map(({ capability }) => capability),
        );
        setModels(hydration.selectedCatalog.map(catalogEntryToDescriptor));
        setConnection(null);
        setConnectionChecked(false);
        setModelCapacity(null);
        setSummary(hydration.credential ?? { configured: false, lastFour: null });
        setCredentialError(
          hydration.credentialErrorCode === null
            ? null
            : Object.assign(new Error("Credential status unavailable"), {
                code: hydration.credentialErrorCode,
              }),
        );
        setCapabilityProbeError(null);
        setCapabilityProbeMessage(null);
        setModelHubPageSnapshot(hydration.page);
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome:
            hydration.page.phase === "READY_WITH_WARNINGS" ? "succeeded_with_warning" : "succeeded",
          backendCommitted: operationBackendCommitted,
          storeRefreshed: true,
          errorCode: hydration.page.errorCode,
          catalogCount: hydration.allCatalogEntries.length,
        });
        return true;
      } catch (reason: unknown) {
        if (!coordinator.isCurrent(token)) {
          finishModelHubDiagnosticAction(runtime, token, {
            completedAt: runtime.clock.now(),
            outcome: "stale_ignored",
            backendCommitted: operationBackendCommitted,
            staleResultIgnored: true,
          });
          return false;
        }
        const normalized = normalizeUiError(reason);
        setCredentialError(activePhaseRef.current === "CHECKING_CREDENTIAL" ? reason : null);
        setModelHubPageSnapshot((current) =>
          preserveModelHubPageSnapshotAfterFailure(current, {
            action,
            failedPhase: activePhaseRef.current,
            errorCode: normalized.code,
            catalogRefreshFailed:
              options.catalogRefreshFailed === true || activePhaseRef.current === "LOADING_CATALOG",
            hydratedAt: runtime.clock.now(),
          }),
        );
        if (options.backendCommitted === true) {
          setModelHubMutationNotice({
            message: "更改已经保存，但页面状态刷新失败。你可以重新加载模型中心，不需要重复保存。",
            reloadRequired: true,
          });
        }
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: options.backendCommitted === true ? "succeeded_with_warning" : "failed",
          backendCommitted: operationBackendCommitted,
          storeRefreshed: false,
          errorCode: normalized.code,
        });
        return false;
      } finally {
        if (coordinator.isCurrent(token)) setLoading(false);
      }
    },
    [applyHubModelToForm, location.search, runtime],
  );

  const inspectDatabase = useCallback(async () => {
    if (runtime.maintenance === null) {
      return;
    }
    setMaintenanceBusy("inspect");
    setMaintenanceError(null);
    const result = await runtime.maintenance.inspect();
    if (result.ok) {
      setIntegrity(result.value);
    } else {
      setMaintenanceError(result.error);
    }
    setMaintenanceBusy(null);
  }, [runtime]);

  const loadProjectMemoryGovernance = useCallback(
    async (projectId: string): Promise<void> => {
      setMemoryGovernanceLoading(true);
      setMemoryGovernanceError(null);
      const policy = await runtime.story.memoryService.ensureDefaultPolicy(projectId);
      if (!policy.ok) {
        setMemoryGovernanceError(policy.error);
        setSelectedMemoryPolicy(null);
        setSelectedProjectMemories([]);
        setMemoryGovernanceLoading(false);
        return;
      }
      const parsedProjectId = policy.value.projectId;
      const records = await runtime.story.memoryRecords.listByProjectId(parsedProjectId);
      if (!records.ok) {
        setMemoryGovernanceError(records.error);
        setSelectedMemoryPolicy(policy.value);
        setSelectedProjectMemories([]);
      } else {
        setSelectedMemoryPolicy(policy.value);
        setSelectedProjectMemories(records.value);
      }
      setMemoryGovernanceLoading(false);
    },
    [runtime],
  );

  const loadMemoryProjects = useCallback(async (): Promise<void> => {
    const projects = await runtime.useCases.listProjects.execute({
      statuses: ["active", "archived"],
    });
    if (!projects.ok) {
      setMemoryGovernanceError(projects.error);
      setMemoryProjects([]);
      return;
    }
    const options = projects.value.map((project) => ({
      id: String(project.id),
      name: project.name,
      status: project.status as "active" | "archived",
    }));
    setMemoryProjects(options);
    const selected =
      options.find(({ id }) => id === selectedMemoryProjectId)?.id ?? options[0]?.id ?? "";
    setSelectedMemoryProjectId(selected);
    if (selected.length > 0) {
      await loadProjectMemoryGovernance(selected);
    } else {
      setSelectedMemoryPolicy(null);
      setSelectedProjectMemories([]);
    }
  }, [loadProjectMemoryGovernance, runtime, selectedMemoryProjectId]);

  const checkAutomaticBackup = useCallback(async () => {
    if (runtime.automaticBackup === null) {
      return;
    }
    setAutomaticBackupChecking(true);
    try {
      const result = await runtime.automaticBackup.checkNow();
      setAutomaticBackupCheck(result);
    } catch {
      setAutomaticBackupCheck({
        state: "degraded",
        run: null,
        errorCode: "AUTOMATIC_BACKUP_CHECK_FAILED",
      });
    } finally {
      setAutomaticBackupChecking(false);
    }
  }, [runtime]);

  useEffect(() => {
    if (isModelHubView) return;
    if (runtime.maintenance !== null) {
      void Promise.resolve().then(inspectDatabase);
    }
    if (runtime.automaticBackup !== null) {
      void Promise.resolve().then(checkAutomaticBackup);
    }
  }, [checkAutomaticBackup, inspectDatabase, isModelHubView, runtime]);

  useEffect(() => {
    if (!isModelHubView) return;
    const operationCoordinator = modelHubOperationCoordinatorRef.current;
    void loadModelCenter();
    return () => {
      operationCoordinator.invalidate();
      recordModelHubUiUnmount(runtime, runtime.clock.now());
    };
  }, [isModelHubView, loadModelCenter, runtime]);

  useEffect(() => {
    if (!isModelHubView) return;
    recordModelHubUiSnapshot(runtime, modelHubPageSnapshot, runtime.clock.now());
  }, [isModelHubView, modelHubPageSnapshot, runtime]);

  useEffect(() => {
    if (!isModelHubView) {
      void Promise.resolve().then(loadMemoryProjects);
    }
  }, [isModelHubView, loadMemoryProjects]);

  useEffect(() => {
    if (
      modelHubTargetSection !== "provider-connection" &&
      modelHubTargetSection !== "model-pricing" &&
      modelHubTargetSection !== "model-capabilities"
    ) {
      return;
    }

    const timeout = window.setTimeout(() => setExpertMode(true), 0);
    return () => window.clearTimeout(timeout);
  }, [modelHubTargetSection]);

  useEffect(() => {
    const targetId = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    const preciseTargetId =
      modelHubTargetSection === "provider-connection"
        ? "model-hub-expert-settings"
        : modelHubTargetSection;
    const resolvedTargetId = preciseTargetId === "model-center" ? targetId : preciseTargetId;
    if (resolvedTargetId.length === 0) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const target = document.getElementById(resolvedTargetId);
      if (target === null) {
        return;
      }
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [expertMode, location.hash, modelHubTargetSection]);

  async function selectStoredProfile(
    providerIdValue: string,
    requestedModelId?: string,
  ): Promise<void> {
    const selected = hubConnections.find((candidate) => candidate.id === providerIdValue);
    if (selected === undefined) {
      return;
    }
    setProbingCapability(false);
    setSecret("");
    const token = modelHubOperationCoordinatorRef.current.begin("restore_selection", {
      providerKind: selected.providerKind,
      connectionId: selected.id,
      modelId: requestedModelId ?? null,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    await loadModelCenter({
      action: "restore_selection",
      token,
      requestedConnectionId: selected.id,
      requestedModelId: requestedModelId ?? null,
    });
  }

  async function selectCatalogModel(providerModelId: string): Promise<void> {
    const catalogEntry = hubCatalog.find(
      (candidate) => candidate.providerModelId === providerModelId,
    );
    if (catalogEntry === undefined) {
      setConfirmedCapabilities([]);
      return;
    }
    setProbingCapability(false);
    const token = modelHubOperationCoordinatorRef.current.begin("restore_selection", {
      providerKind: hubConnection?.providerKind ?? providerPreset,
      connectionId: hubConnection?.id ?? null,
      modelId: providerModelId,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    await loadModelCenter({
      action: "restore_selection",
      token,
      requestedConnectionId: hubConnection?.id ?? null,
      requestedModelId: providerModelId,
    });
  }

  function applyProviderPreset(nextProvider: ConnectableProviderKind): void {
    const reusableConnection =
      nextProvider === "custom_openai_compatible"
        ? undefined
        : hubConnections.find(
            (connection) =>
              connection.providerKind === nextProvider &&
              !isRetiredModelProviderConnection(connection),
          );
    if (reusableConnection !== undefined) {
      void selectStoredProfile(reusableConnection.id);
      return;
    }
    modelHubOperationCoordinatorRef.current.invalidate();
    const preset = getModelProviderPreset(nextProvider);
    const nativeProvider = legacyProviderKind(nextProvider);
    const nextBaseUrl =
      nextProvider === "custom_openai_compatible" ? "" : resolveProviderBaseUrl(nextProvider);
    setProviderPreset(nextProvider);
    modelHubSnapshotRevisionRef.current += 1;
    setModelHubPageSnapshot((current) =>
      createProviderDraftModelHubPageSnapshot(current, {
        providerKind: nextProvider,
        credentialRequired: preset.credentialRequired,
        hydratedAt: runtime.clock.now(),
        snapshotRevision: modelHubSnapshotRevisionRef.current,
      }),
    );
    setProvider(nativeProvider);
    setHubConnection(null);
    setHubCatalog([]);
    setProfile(null);
    setModels([]);
    setConnection(null);
    setConnectionChecked(false);
    setModelCapacity(null);
    setSelectedModel("");
    setRegion(nextProvider === "alibaba_qwen" ? "china_beijing" : "");
    setWorkspaceId("");
    setEndpointId("");
    setCredentialHeaderName("");
    setModelDiscoveryPath("");
    setTextGenerationPath("");
    setEmbeddingPath("");
    setRequestTimeoutMs(String(MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS));
    setRetryLimit("0");
    setConfirmedCapabilities([]);
    setContextWindowTokens(nativeProvider === "ollama" ? "32768" : "");
    setPricingCurrency("USD");
    setInputPricePerMillion(nativeProvider === "ollama" ? "0" : "");
    setOutputPricePerMillion(nativeProvider === "ollama" ? "0" : "");
    setCachedInputPricePerMillion("");
    setPricingVersion(nativeProvider === "ollama" ? "local-zero-cost" : "");
    setPriceUpdatedDate(nativeProvider === "ollama" ? new Date().toISOString().slice(0, 10) : "");
    setProviderId(nextAvailableProviderConnectionId(nextProvider, hubConnections));
    setBaseUrl(nextBaseUrl);
    setAuthentication(preset.credentialRequired ? "bearer_keyring" : "none");
    setSummary({ configured: false, lastFour: null });
    setCredentialError(null);
    setModelHubMutationNotice(null);
    setLoading(false);
    setProbingCapability(false);
    setSchemeMessage(null);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
  }

  function beginModelHubConnectionIntent(
    task: NovelAiTask,
    candidate: SelectableModelCatalogProjection,
  ): void {
    if (candidate.modelId === null || candidate.appSupport !== "routable_after_verification") {
      return;
    }
    const intent = saveModelHubConnectionIntent(window.localStorage, {
      task,
      providerKind: candidate.providerKind,
      providerModelId: candidate.modelId,
      catalogRegistryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
      now: runtime.clock.now(),
    });
    if (intent === null) {
      setRouteError(new Error("无法保存本次连接返回位置；当前 AI 分工没有修改。"));
      return;
    }
    setConnectionIntent(intent);
    applyProviderPreset(candidate.providerKind);
    setSelectedModel(candidate.modelId);
    setModelHubMutationNotice({
      message: `准备连接 ${candidate.displayName}；连接并同步账户目录后会返回“${novelAiTaskLabel(task)}”。当前分工尚未修改。`,
      reloadRequired: false,
    });
    void navigate("/settings#model-center");
  }

  function cancelModelHubConnectionIntent(): void {
    clearModelHubConnectionIntent(window.localStorage);
    setConnectionIntent(null);
    setModelHubMutationNotice({
      message: "已取消本次模型选择；原有 AI 分工没有修改。",
      reloadRequired: false,
    });
  }

  function restoreProviderConnectionDefaults(): void {
    if (providerPreset === "custom_openai_compatible") {
      return;
    }
    setBaseUrl(resolveProviderBaseUrl(providerPreset, { region, workspaceId }));
    setAuthentication(
      getModelProviderPreset(providerPreset).credentialRequired ? "bearer_keyring" : "none",
    );
    setCredentialHeaderName("");
    setModelDiscoveryPath("");
    setTextGenerationPath("");
    setEmbeddingPath("");
    setRequestTimeoutMs(String(MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS));
    setRetryLimit("0");
    setConnection(null);
    setConnectionChecked(false);
    setSchemeMessage("已恢复供应商默认连接参数；系统凭据、已保存连接和 AI 分工均未删除。");
  }

  function captureSettingsTextProbeForm(): SettingsTextProbeFormSnapshot {
    return Object.freeze({
      providerId,
      providerKind: providerPreset,
      loadedConnectionId: hubConnection?.id ?? null,
      baseUrl,
      region,
      workspaceId,
      endpointId,
      authentication,
      credentialHeaderName,
      modelDiscoveryPath,
      textGenerationPath,
      embeddingPath,
      requestTimeoutMs,
      retryLimit,
      selectedModel,
      credentialConfigured: summary.configured || secret.trim().length > 0,
      credentialEditRevision: credentialEditRevisionRef.current,
    });
  }

  function assertSettingsTextProbeFormUnchanged(expected: SettingsTextProbeFormSnapshot): void {
    const current = settingsTextProbeFormRef.current;
    if (
      current === null ||
      settingsTextProbeFormIdentity(current) !== settingsTextProbeFormIdentity(expected)
    ) {
      throw settingsTextProbeDisclosureChanged();
    }
  }

  async function modelHubConnectionInputFromSnapshot(
    form: SettingsTextProbeFormSnapshot,
    credentialConfigured: boolean,
    authenticationOverride: NativeGatewayAuthenticationMode,
  ): Promise<SaveModelProviderConnectionInput> {
    const existing = await runtime.modelHub.findConnection(form.providerId);
    assertProbeConnectionTargetIsOwned(existing, form);
    const resolvedBaseUrl = resolveProviderBaseUrl(form.providerKind, {
      region: form.region,
      workspaceId: form.workspaceId,
      baseUrlOverride: form.baseUrl,
    });
    return Object.freeze({
      id: form.providerId,
      providerKind: form.providerKind,
      displayName: existing?.displayName ?? getModelProviderPreset(form.providerKind).displayName,
      region: form.region.trim().length === 0 ? null : form.region,
      workspaceId: form.workspaceId.trim().length === 0 ? null : form.workspaceId,
      endpointId: form.endpointId.trim().length === 0 ? null : form.endpointId,
      baseUrlOverride: resolvedBaseUrl,
      credentialRef:
        credentialConfigured && authenticationOverride !== "none"
          ? (existing?.credentialRef ?? modelHubCredentialRef(form.providerId))
          : null,
      credentialState:
        credentialConfigured && authenticationOverride !== "none" ? "present" : "missing",
      authenticationMode: authenticationOverride,
      credentialHeaderName:
        form.providerKind === "custom_openai_compatible" &&
        authenticationOverride === "custom_header_keyring"
          ? form.credentialHeaderName
          : null,
      modelDiscoveryPath:
        form.providerKind === "custom_openai_compatible" ? form.modelDiscoveryPath : null,
      textGenerationPath:
        form.providerKind === "custom_openai_compatible" ? form.textGenerationPath : null,
      embeddingPath: form.providerKind === "custom_openai_compatible" ? form.embeddingPath : null,
      requestTimeoutMs: Number(form.requestTimeoutMs),
      retryLimit: Number(form.retryLimit),
      enabled: authenticationOverride === "none" || credentialConfigured,
      expectedRevision: existing?.revision ?? null,
    });
  }

  async function prepareSettingsTextProbeAuthorization(
    form: SettingsTextProbeFormSnapshot,
    submittedSecretValue: string,
    requestedModelId: string,
  ): Promise<PreparedSettingsTextProbeAuthorization> {
    const modelId = requestedModelId.normalize("NFKC").trim();
    if (modelId.length === 0) {
      throw new Error("请先填写模型标识；豆包也可以填写 Endpoint ID。");
    }
    validateExpertConnectionDraft({
      provider: form.providerKind,
      baseUrl: form.baseUrl,
      region: form.region,
      workspaceId: form.workspaceId,
      authentication: form.authentication,
      credentialHeaderName: form.credentialHeaderName,
      modelDiscoveryPath: form.modelDiscoveryPath,
      textGenerationPath: form.textGenerationPath,
      embeddingPath: form.embeddingPath,
      requestTimeoutMs: form.requestTimeoutMs,
      retryLimit: form.retryLimit,
    });
    const submittedSecret = submittedSecretValue.trim().length === 0 ? null : submittedSecretValue;
    const credentialConfigured =
      form.authentication !== "none" && (form.credentialConfigured || submittedSecret !== null);
    const connectionInput = await modelHubConnectionInputFromSnapshot(
      form,
      credentialConfigured,
      form.authentication,
    );
    assertSettingsTextProbeFormUnchanged(form);
    const disclosureFingerprint = await settingsTextProbeFingerprintFromInput(
      connectionInput,
      modelId,
    );
    assertSettingsTextProbeFormUnchanged(form);
    return Object.freeze({
      form,
      connectionInput,
      submittedSecret,
      modelId,
      disclosureFingerprint,
    });
  }

  async function persistPreparedSettingsTextProbeConnection(
    prepared: PreparedSettingsTextProbeAuthorization,
    token: ModelHubOperationToken,
  ): Promise<ModelProviderConnection> {
    assertSettingsTextProbeFormUnchanged(prepared.form);
    if (prepared.submittedSecret === null || prepared.form.authentication === "none") {
      return runtime.modelHub.saveConnection(prepared.connectionInput);
    }
    const saved = await saveModelHubCredential(runtime, {
      connection: prepared.connectionInput,
      secret: prepared.submittedSecret,
    });
    if (
      modelHubOperationCoordinatorRef.current.isCurrent(token, {
        providerKind: saved.connection.providerKind,
        connectionId: saved.connection.id,
      })
    ) {
      setHubConnection(saved.connection);
      setSummary(saved.credential);
      setSecret("");
      if (saved.oldCredentialCleanupPending) {
        setSchemeMessage("新密钥已安全保存；旧密钥槽将在下次启动或重试时继续清理。");
      }
    }
    return saved.connection;
  }

  async function modelHubConnectionInput(
    credentialConfigured = summary.configured,
    authenticationOverride: NativeGatewayAuthenticationMode = authentication,
  ): Promise<SaveModelProviderConnectionInput> {
    return modelHubConnectionInputFromSnapshot(
      captureSettingsTextProbeForm(),
      credentialConfigured,
      authenticationOverride,
    );
  }

  async function persistModelHubConnection(
    credentialConfigured = summary.configured,
    authenticationOverride: NativeGatewayAuthenticationMode = authentication,
  ): Promise<ModelProviderConnection> {
    return runtime.modelHub.saveConnection(
      await modelHubConnectionInput(credentialConfigured, authenticationOverride),
    );
  }

  async function persistConnectionWithAvailableCredential(
    token?: ModelHubOperationToken,
  ): Promise<ModelProviderConnection> {
    if (authentication === "none" || secret.trim().length === 0) {
      return persistModelHubConnection(summary.configured, authentication);
    }
    validateExpertConnectionDraft({
      provider: providerPreset,
      baseUrl,
      region,
      workspaceId,
      authentication,
      credentialHeaderName,
      modelDiscoveryPath,
      textGenerationPath,
      embeddingPath,
      requestTimeoutMs,
      retryLimit,
    });
    await assertCredentialMutationTarget("save");
    const saved = await saveModelHubCredential(runtime, {
      connection: await modelHubConnectionInput(true, authentication),
      secret,
    });
    if (
      token === undefined ||
      modelHubOperationCoordinatorRef.current.isCurrent(token, {
        providerKind: saved.connection.providerKind,
        connectionId: saved.connection.id,
      })
    ) {
      setHubConnection(saved.connection);
      setSummary(saved.credential);
      setSecret("");
      if (saved.oldCredentialCleanupPending) {
        setSchemeMessage("新密钥已安全保存；旧密钥槽将在下次启动或重试时继续清理。");
      }
    }
    return saved.connection;
  }

  function assertConnectionTargetIsOwned(existingConnection: ModelProviderConnection | null): void {
    if (existingConnection !== null && existingConnection.providerKind !== providerPreset) {
      throw new ModelHubStoreError(
        "MODEL_HUB_PROVIDER_KIND_IMMUTABLE",
        "这个配置标识已经属于另一家供应商。请使用新的配置标识，原配置和凭据不会被覆盖。",
      );
    }
    if (
      existingConnection !== null &&
      hubConnection?.id !== existingConnection.id &&
      !(hubConnection === null && isCredentialDeletedConnection(existingConnection))
    ) {
      throw new ModelHubStoreError(
        "MODEL_HUB_CONNECTION_ID_CONFLICT",
        "这个配置标识已经属于另一项已保存配置。请先从已保存配置中加载它，原配置和凭据不会被覆盖。",
      );
    }
  }

  function assertProbeConnectionTargetIsOwned(
    existingConnection: ModelProviderConnection | null,
    form: SettingsTextProbeFormSnapshot,
  ): void {
    if (existingConnection !== null && existingConnection.providerKind !== form.providerKind) {
      throw new ModelHubStoreError(
        "MODEL_HUB_PROVIDER_KIND_IMMUTABLE",
        "这个配置标识已经属于另一家供应商。请使用新的配置标识，原配置和凭据不会被覆盖。",
      );
    }
    if (
      existingConnection !== null &&
      form.loadedConnectionId !== existingConnection.id &&
      !(form.loadedConnectionId === null && isCredentialDeletedConnection(existingConnection))
    ) {
      throw new ModelHubStoreError(
        "MODEL_HUB_CONNECTION_ID_CONFLICT",
        "这个配置标识已经属于另一项已保存配置。请先从已保存配置中加载它，原配置和凭据不会被覆盖。",
      );
    }
  }

  async function findOwnedConnectionTarget(): Promise<ModelProviderConnection | null> {
    const existingConnection = await runtime.modelHub.findConnection(providerId);
    assertConnectionTargetIsOwned(existingConnection);
    return existingConnection;
  }

  async function assertCredentialMutationTarget(
    operation: "save" | "delete",
  ): Promise<ModelProviderConnection | null> {
    const existingConnection = await findOwnedConnectionTarget();
    if (
      operation === "delete" &&
      (existingConnection === null ||
        hubConnection?.id !== existingConnection.id ||
        hubConnection.providerKind !== providerPreset ||
        !summary.configured)
    ) {
      throw new ModelHubStoreError(
        "MODEL_HUB_CREDENTIAL_TARGET_MISMATCH",
        "只能删除当前已加载配置的密钥。请先从已保存配置中重新选择它。",
      );
    }
    return existingConnection;
  }

  async function saveModelProfile(): Promise<void> {
    const token = modelHubOperationCoordinatorRef.current.begin("save_connection", {
      providerKind: providerPreset,
      connectionId: providerId,
      modelId: selectedModel.trim().length === 0 ? null : selectedModel,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    let backendCommitted = false;
    let refreshAttempted = false;
    setSaving(true);
    try {
      const savedConnection = await persistConnectionWithAvailableCredential(token);
      backendCommitted = true;
      const pricing = buildPricingProfile();
      const legacyPricing: ModelPricingProfile | null =
        pricing?.contextWindowTokens == null
          ? null
          : { ...pricing, contextWindowTokens: pricing.contextWindowTokens };
      let nextCatalog = await runtime.modelHub.listCatalog(savedConnection.id);
      let selectedCatalogEntry = nextCatalog.find(
        ({ providerModelId }) => providerModelId === selectedModel,
      );
      if (selectedModel.trim().length > 0 && selectedCatalogEntry === undefined) {
        nextCatalog = await runtime.modelHub.syncCatalog({
          syncId: createModelHubId("manual-sync"),
          connectionId: savedConnection.id,
          source: "manual",
          status: "succeeded",
          models: [
            {
              id: createModelHubId("catalog"),
              providerModelId: selectedModel,
              inputTokenLimit:
                contextWindowTokens.trim().length === 0 ? null : Number(contextWindowTokens),
            },
          ],
        });
        selectedCatalogEntry = nextCatalog.find(
          ({ providerModelId }) => providerModelId === selectedModel,
        );
      }
      if (selectedCatalogEntry !== undefined) {
        const existingCostPrivacy = await runtime.modelHub.findCostPrivacyProfile(
          selectedCatalogEntry.id,
        );
        await runtime.modelHub.saveCostPrivacyProfile({
          catalogEntryId: selectedCatalogEntry.id,
          ...(pricing === null
            ? {}
            : {
                currency: pricing.currency,
                inputMicrosPerMillionTokens: String(pricing.inputMicrosPerMillionTokens),
                outputMicrosPerMillionTokens: String(pricing.outputMicrosPerMillionTokens),
                cachedInputMicrosPerMillionTokens:
                  pricing.cachedInputMicrosPerMillionTokens === null
                    ? null
                    : String(pricing.cachedInputMicrosPerMillionTokens),
                pricingVersion: pricing.pricingVersion,
                priceUpdatedAt: pricing.priceUpdatedAt,
              }),
          dataDestination: isLoopbackModelBaseUrl(savedConnection.baseUrl) ? "local" : "remote",
          retentionPolicy: isLoopbackModelBaseUrl(savedConnection.baseUrl)
            ? "none"
            : "provider_default",
          trainingPolicy: isLoopbackModelBaseUrl(savedConnection.baseUrl) ? "not_used" : "unknown",
          evidenceSource: "user_confirmed",
          evidenceVersion: "settings-confirmation-v1",
          expectedRevision: existingCostPrivacy?.revision ?? null,
        });
        if (confirmedCapabilities.length > 0) {
          const evidenceVersion = createModelHubId("user-capabilities");
          await runtime.modelHub.recordCapabilityScan({
            scanId: createModelHubId("user-scan"),
            catalogEntryId: selectedCatalogEntry.id,
            scanKind: "user_review",
            status: "succeeded",
            evidenceVersion,
            evidence: confirmedCapabilities.map((capability) => ({
              id: createModelHubId("capability"),
              capability,
              verdict: "supported",
              evidenceSource: "user_confirmed",
            })),
          });
        }
      }

      let savedLegacyProfile: ModelProfile | null = null;
      if (supportsLegacyModelProfile(providerPreset)) {
        const existingLegacyProfile = await runtime.modelCenter.findByProviderId(providerId);
        const legacyAuthentication: NativeAuthenticationMode =
          authentication === "none" ? "none" : "bearer_keyring";
        savedLegacyProfile = await runtime.modelCenter.save({
          providerId,
          provider,
          baseUrl: savedConnection.baseUrl,
          authentication: legacyAuthentication,
          selectedModel:
            savedConnection.enabled && selectedModel.trim().length > 0 ? selectedModel : null,
          pricing: savedConnection.enabled ? legacyPricing : null,
          expectedRevision: existingLegacyProfile?.revision ?? null,
        });
      }

      void savedLegacyProfile;
      refreshAttempted = true;
      await loadModelCenter({
        action: "save_connection",
        token,
        requestedConnectionId: savedConnection.id,
        requestedModelId: selectedModel.trim().length === 0 ? null : selectedModel,
        backendCommitted: true,
      });
    } catch (reason: unknown) {
      const normalized = normalizeUiError(reason);
      if (backendCommitted) {
        setModelHubMutationNotice({
          message:
            "连接已经保存，但后续模型资料没有全部更新。请重新加载模型中心后再检查，无需重复填写密钥。",
          reloadRequired: true,
        });
      } else {
        setCredentialError(reason);
      }
      if (!refreshAttempted) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: backendCommitted ? "succeeded_with_warning" : "failed",
          backendCommitted,
          storeRefreshed: false,
          errorCode: normalized.code,
        });
      }
    } finally {
      setSaving(false);
    }
  }

  function selectRouteRole(nextRole: ModelRouteRole): void {
    setRouteRole(nextRole);
    const stored = roleRoutes.find(({ role }) => role === nextRole);
    const firstReadyProfile = profiles.find(({ selectedModel: model }) => model !== null);
    setRoutePrimaryProviderId(stored?.primaryProviderId ?? firstReadyProfile?.providerId ?? "");
    setRouteFallbackProviderId(stored?.fallbackProviderId ?? "");
    setRouteError(null);
    setRouteFailureRollbackConfirmed(null);
    setRouteFailureLegacyProjectionMayHaveChanged(false);
  }

  async function saveModelRoleRoute(): Promise<void> {
    const existing = roleRoutes.find(({ role }) => role === routeRole);
    setRouteSaving(true);
    setRouteError(null);
    setRouteFailureRollbackConfirmed(null);
    setRouteFailureLegacyProjectionMayHaveChanged(false);
    try {
      const saved = await runtime.modelRouting.saveRoute({
        role: routeRole,
        primaryProviderId: routePrimaryProviderId,
        fallbackProviderId: routeFallbackProviderId.length === 0 ? null : routeFallbackProviderId,
        expectedRevision: existing?.revision ?? null,
      });
      const routes = await runtime.modelRouting.listRoutes();
      setRoleRoutes(routes);
      setRoutePrimaryProviderId(saved.primaryProviderId);
      setRouteFallbackProviderId(saved.fallbackProviderId ?? "");
    } catch (cause: unknown) {
      setRouteError(cause);
    } finally {
      setRouteSaving(false);
    }
  }

  function selectNovelTaskRoute(nextTask: NovelAiTask): void {
    const stored = novelTaskRoutes.find(({ task }) => task === nextTask);
    setNovelRouteTask(nextTask);
    setNovelRoutePrimaryCatalogId(stored?.primaryCatalogEntryId ?? "");
    setNovelRouteFallbackCatalogId(stored?.fallbackCatalogEntryId ?? "");
    setNovelRouteMaximumCost(
      stored?.maximumCostMicros === null || stored?.maximumCostMicros === undefined
        ? ""
        : formatMicrosStringAsCurrency(stored.maximumCostMicros),
    );
    setNovelRouteCurrency(stored?.currency ?? "USD");
    setNovelRoutePrivacy(stored?.privacyPolicy ?? "cloud_allowed");
    setNovelRouteFailure(stored?.failurePolicy ?? "use_fallback");
    setNovelRouteRemoteContentConsent(stored?.parameterPolicy.remoteContentConsent === true);
    setRouteError(null);
    setRouteFailureRollbackConfirmed(null);
    setRouteFailureLegacyProjectionMayHaveChanged(false);
  }

  async function saveNovelTaskRoute(): Promise<void> {
    const existing = novelTaskRoutes.find(({ task }) => task === novelRouteTask);
    const routesBeforeSave = novelTaskRoutes;
    const fallbackCatalogEntryId =
      novelRouteFallbackCatalogId.trim().length === 0 ? null : novelRouteFallbackCatalogId;
    setRouteSaving(true);
    setRouteError(null);
    setRouteFailureRollbackConfirmed(null);
    setRouteFailureLegacyProjectionMayHaveChanged(false);
    try {
      if (novelRoutePrimaryCatalogId === fallbackCatalogEntryId) {
        throw new Error("主模型和备用模型不能相同。");
      }
      if (novelRoutePrivacy === "local_only") {
        for (const catalogEntryId of [
          novelRoutePrimaryCatalogId,
          ...(fallbackCatalogEntryId === null ? [] : [fallbackCatalogEntryId]),
        ]) {
          const privacy = await runtime.modelHub.findCostPrivacyProfile(catalogEntryId);
          if (privacy?.dataDestination !== "local") {
            throw new Error("本地隐私任务只能选择已明确标记为本机的模型。");
          }
        }
      }
      const customPreset = (await runtime.modelHub.listPresets()).find(
        ({ id }) => id === "custom-user",
      );
      const preset = await runtime.modelHub.savePreset({
        id: "custom-user",
        scheme: "custom",
        displayName: "完全自定义",
        status: "active",
        privacyPolicy: novelRoutePrivacy,
        costPriority: "balanced",
        routeGenerationVersion: "user-route-v1",
        expectedRevision: customPreset?.revision ?? null,
      });
      const maximumCostMicros =
        novelRouteMaximumCost.trim().length === 0
          ? null
          : String(parseCurrencyAsMicros(novelRouteMaximumCost));
      const saved = await runtime.modelHub.saveTaskRoute({
        task: novelRouteTask,
        primaryCatalogEntryId: novelRoutePrimaryCatalogId,
        fallbackCatalogEntryId,
        presetId: preset.id,
        parameterPolicy: rerankParameterPolicy(
          removeLegacyTemperature(existing?.parameterPolicy ?? {}),
          novelRouteTask,
          novelRouteRemoteContentConsent,
        ),
        maximumCostMicros,
        currency: maximumCostMicros === null ? null : novelRouteCurrency.trim().toUpperCase(),
        privacyPolicy: novelRoutePrivacy,
        failurePolicy:
          fallbackCatalogEntryId === null && novelRouteFailure === "use_fallback"
            ? "ask_user"
            : novelRouteFailure,
        routeOrigin: "user",
        enabled: true,
        expectedRevision: existing?.revision ?? null,
      });
      const nextRoutes = await Promise.all(
        NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task)),
      );
      const persisted = nextRoutes.filter((route): route is NovelTaskRoute => route !== null);
      setNovelTaskRoutes(persisted);
      setModelHubScheme("custom");
      setNovelRoutePrimaryCatalogId(saved.primaryCatalogEntryId);
      setNovelRouteFallbackCatalogId(saved.fallbackCatalogEntryId ?? "");
      setNovelRouteFailure(saved.failurePolicy);
      setSchemeMessage(`已保存“${novelAiTaskLabel(saved.task)}”的自定义分工。`);
    } catch (cause: unknown) {
      setRouteError(cause);
      await confirmNovelRoutingUnchanged(routesBeforeSave);
    } finally {
      setRouteSaving(false);
    }
  }

  async function confirmNovelRoutingUnchanged(
    routesBeforeSave: readonly NovelTaskRoute[],
  ): Promise<void> {
    try {
      const currentRoutes = (
        await Promise.all(NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task)))
      ).filter((route): route is NovelTaskRoute => route !== null);
      setNovelTaskRoutes(currentRoutes);
      setRouteFailureRollbackConfirmed(routeSnapshotsMatch(routesBeforeSave, currentRoutes));
    } catch {
      setRouteFailureRollbackConfirmed(null);
    }
  }

  function buildPricingProfile(): SettingsPricingProfile | null {
    if (selectedModel.trim().length === 0) {
      return null;
    }
    const pricingFields = [
      inputPricePerMillion,
      outputPricePerMillion,
      pricingVersion,
      priceUpdatedDate,
    ];
    if (pricingFields.every((value) => value.trim().length === 0)) {
      return null;
    }
    const parsedContext = Number(contextWindowTokens);
    if (
      (contextWindowTokens.trim().length > 0 &&
        (!Number.isSafeInteger(parsedContext) || parsedContext < 1)) ||
      inputPricePerMillion.trim().length === 0 ||
      outputPricePerMillion.trim().length === 0 ||
      pricingVersion.trim().length === 0 ||
      priceUpdatedDate.length === 0
    ) {
      throw new Error(
        "如需费用估算，请同时填写输入价、输出价、价格版本和更新时间；上下文窗口可单独留空。",
      );
    }
    return {
      contextWindowTokens: contextWindowTokens.trim().length === 0 ? null : parsedContext,
      currency: pricingCurrency.trim().toUpperCase(),
      inputMicrosPerMillionTokens: parseCurrencyAsMicros(inputPricePerMillion),
      outputMicrosPerMillionTokens: parseCurrencyAsMicros(outputPricePerMillion),
      cachedInputMicrosPerMillionTokens:
        cachedInputPricePerMillion.trim().length === 0
          ? null
          : parseCurrencyAsMicros(cachedInputPricePerMillion),
      pricingVersion: pricingVersion.trim(),
      priceUpdatedAt: `${priceUpdatedDate}T00:00:00.000Z`,
    };
  }

  async function refreshRoutingCatalogState(
    connections: readonly ModelProviderConnection[],
  ): Promise<readonly ModelCatalogEntry[]> {
    const entries = (
      await Promise.all(connections.map((candidate) => runtime.modelHub.listCatalog(candidate.id)))
    ).flat();
    setRoutingCatalog(entries);
    await refreshRoutingVisibilityEvidence(entries);
    return entries;
  }

  async function ensureCatalogEntryForModel(
    savedConnection: ModelProviderConnection,
    modelIdValue: string,
  ): Promise<
    Readonly<{
      connection: ModelProviderConnection;
      catalog: readonly ModelCatalogEntry[];
      entry: ModelCatalogEntry;
    }>
  > {
    const modelId = modelIdValue.normalize("NFKC").trim();
    if (modelId.length === 0) {
      throw new Error("请先填写模型标识；豆包也可以填写 Endpoint ID。");
    }
    let catalogWasWritten = false;
    let catalog = await runtime.modelHub.listCatalog(savedConnection.id);
    let entry = catalog.find(({ providerModelId }) => providerModelId === modelId);
    if (entry === undefined) {
      catalogWasWritten = true;
      catalog = await runtime.modelHub.syncCatalog({
        syncId: createModelHubId("manual-sync"),
        connectionId: savedConnection.id,
        source: "manual",
        status: "succeeded",
        models: [
          {
            id: createModelHubId("catalog"),
            providerModelId: modelId,
            displayName: modelId,
          },
        ],
      });
      entry = catalog.find(({ providerModelId }) => providerModelId === modelId);
    }
    if (entry === undefined) {
      throw new Error("模型目录没有保存所选模型，请重新保存后再试。");
    }
    const authoritative = await readAuthoritativeProbeTarget(savedConnection.id, entry.id);
    const expectedConnection = Object.freeze({
      ...savedConnection,
      revision: savedConnection.revision + (catalogWasWritten ? 1 : 0),
    });
    assertModelHubFinalDispatchUnchanged(
      settingsProbeDispatchIdentity(expectedConnection, entry),
      settingsProbeDispatchIdentity(authoritative.connection, authoritative.entry),
    );
    return authoritative;
  }

  async function readAuthoritativeProbeTarget(
    connectionId: string,
    catalogEntryId: string,
  ): Promise<
    Readonly<{
      connection: ModelProviderConnection;
      catalog: readonly ModelCatalogEntry[];
      entry: ModelCatalogEntry;
    }>
  > {
    const [connection, catalog] = await Promise.all([
      runtime.modelHub.findConnection(connectionId),
      runtime.modelHub.listCatalog(connectionId),
    ]);
    const entry = catalog.find(({ id }) => id === catalogEntryId);
    if (connection === null || entry === undefined) {
      throw new ModelHubFinalDispatchError();
    }
    return Object.freeze({ connection, catalog, entry });
  }

  async function ensureProbeCostPrivacyProfile(
    connection: ModelProviderConnection,
    catalogEntry: ModelCatalogEntry,
  ): Promise<void> {
    if ((await runtime.modelHub.findCostPrivacyProfile(catalogEntry.id)) !== null) return;
    const local = isLoopbackModelBaseUrl(connection.baseUrl);
    try {
      await runtime.modelHub.saveCostPrivacyProfile({
        catalogEntryId: catalogEntry.id,
        dataDestination: local ? "local" : "remote",
        retentionPolicy: local ? "none" : "provider_default",
        trainingPolicy: local ? "not_used" : "unknown",
        evidenceSource: "provider_metadata",
        evidenceVersion: "text-capability-probe-endpoint-v1",
        evidenceSummary: local
          ? "连接目标是本机回环地址；探针未发送作品内容。"
          : "连接目标是供应商远程端点；留存与训练政策仍以供应商当前政策为准。",
        expectedRevision: null,
      });
    } catch (cause: unknown) {
      if (
        cause instanceof ModelHubStoreError &&
        cause.code === "MODEL_HUB_COST_PRIVACY_CONFLICT" &&
        (await runtime.modelHub.findCostPrivacyProfile(catalogEntry.id)) !== null
      ) {
        return;
      }
      throw cause;
    }
  }

  async function performLightweightTextProbe(
    savedConnection: ModelProviderConnection,
    catalogEntry: ModelCatalogEntry,
    authorization: PreparedSettingsTextProbeAuthorization,
    updateConnectionStatus = false,
  ): Promise<
    Readonly<{
      streamed: boolean;
      latencyMs: number;
      connection: ModelProviderConnection;
      catalog: readonly ModelCatalogEntry[];
      entry: ModelCatalogEntry;
    }>
  > {
    const scanId = createModelHubId("probe-scan");
    const evidenceVersion = createModelHubId("lightweight-probe-v1");
    const invocationId = createModelHubId("capability-probe-invocation");
    const startedAt = Date.parse(runtime.clock.now());
    const expectedDispatchIdentity = settingsProbeDispatchIdentity(savedConnection, catalogEntry);
    try {
      const current = await readAuthoritativeProbeTarget(savedConnection.id, catalogEntry.id);
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        settingsProbeDispatchIdentity(current.connection, current.entry),
      );
      assertSettingsTextProbeFormUnchanged(authorization.form);
      const currentDisclosureFingerprint = await settingsTextProbeFingerprintFromConnection(
        current.connection,
        current.entry.providerModelId,
      );
      if (currentDisclosureFingerprint !== authorization.disclosureFingerprint) {
        throw settingsTextProbeDisclosureChanged();
      }
      const dispatchTarget = await readAuthoritativeProbeTarget(
        savedConnection.id,
        catalogEntry.id,
      );
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        settingsProbeDispatchIdentity(dispatchTarget.connection, dispatchTarget.entry),
      );
      assertSettingsTextProbeFormUnchanged(authorization.form);
      const result = await executeAuditedModelHubTextCapabilityProbe({
        gateway: runtime.modelGateway,
        modelHub: runtime.modelHub,
        clock: runtime.clock,
        providerKind: dispatchTarget.connection.providerKind,
        generationId: createModelHubId("capability-probe"),
        invocationId,
        connection: dispatchTarget.connection,
        catalogEntry: dispatchTarget.entry,
        config: Object.freeze({
          ...modelHubNativeEndpointConfig(dispatchTarget.connection),
          retryLimit: 0,
        }),
        model: dispatchTarget.entry.providerModelId,
        assertBeforeProviderDispatch: async () => {
          const finalTarget = await readAuthoritativeProbeTarget(
            savedConnection.id,
            catalogEntry.id,
          );
          assertModelHubFinalDispatchUnchanged(
            expectedDispatchIdentity,
            settingsProbeDispatchIdentity(finalTarget.connection, finalTarget.entry),
          );
          assertSettingsTextProbeFormUnchanged(authorization.form);
        },
      });
      const verified = await readAuthoritativeProbeTarget(savedConnection.id, catalogEntry.id);
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        settingsProbeDispatchIdentity(verified.connection, verified.entry),
      );
      await ensureProbeCostPrivacyProfile(verified.connection, verified.entry);
      const committed = await runtime.modelHub.commitCapabilityProbeResult({
        connectionId: savedConnection.id,
        expectedConnectionRevision: savedConnection.revision,
        catalogEntryId: catalogEntry.id,
        expectedCatalogRevision: catalogEntry.revision,
        expectedProviderModelId: catalogEntry.providerModelId,
        scan: {
          scanId,
          catalogEntryId: verified.entry.id,
          modelInvocationId: result.invocation.id,
          scanKind: "lightweight_probe",
          status: result.acceptedTruncatedOutput ? "partial" : "succeeded",
          evidenceVersion,
          evidence: [
            {
              id: createModelHubId("capability"),
              capability: "text_generation",
              verdict: "supported",
              evidenceSource: "lightweight_probe",
              evidenceSummary: "固定短文本探测成功；未保存探测输入或模型输出。",
            },
            ...(result.streamed
              ? [
                  {
                    id: createModelHubId("capability"),
                    capability: "streaming" as const,
                    verdict: "supported" as const,
                    evidenceSource: "lightweight_probe" as const,
                    evidenceSummary: "固定短文本探测观察到流式增量；未保存增量内容。",
                  },
                ]
              : []),
          ],
          ...(result.partialFailure === null
            ? {}
            : {
                errorCode: "MODEL_OUTPUT_TRUNCATED",
                errorSummary:
                  "固定能力探针已返回可见文字，但响应以输出上限结束；文本生成能力已确认，未保存探针输出。",
                failure: result.partialFailure,
              }),
        },
        ...(updateConnectionStatus ? { connectionTest: { status: "ready" as const } } : {}),
      });
      return Object.freeze({
        streamed: result.streamed,
        latencyMs: Math.max(0, Date.parse(runtime.clock.now()) - startedAt),
        connection: committed.connection,
        catalog: verified.catalog,
        entry: verified.entry,
      });
    } catch (cause: unknown) {
      const probeInvocation = await runtime.modelHub.findInvocation(invocationId).catch(() => null);
      const providerDispatched =
        probeInvocation !== null && probeInvocation.providerDispatchStartedAt !== null;
      if (!providerDispatched && cause instanceof ModelHubFinalDispatchError) {
        throw settingsTextProbeDisclosureChanged();
      }
      if (
        !providerDispatched &&
        cause instanceof UiActionError &&
        cause.code === "MODEL_HUB_PROBE_DISCLOSURE_CHANGED"
      ) {
        throw cause;
      }
      const normalized = normalizeUiError(cause);
      if (
        probeInvocation !== null &&
        (probeInvocation.status === "queued" || probeInvocation.status === "running")
      ) {
        throw cause;
      }
      if (isCapabilityProbeResultAmbiguous(normalized.code, probeInvocation)) {
        // The invocation is the sole durable fact for an uncertain result.
        // Do not manufacture a failed scan or downgrade a previously healthy
        // connection when the Provider may already have completed the call.
        throw cause;
      }
      try {
        await runtime.modelHub.commitCapabilityProbeResult({
          connectionId: savedConnection.id,
          expectedConnectionRevision: savedConnection.revision,
          catalogEntryId: catalogEntry.id,
          expectedCatalogRevision: catalogEntry.revision,
          expectedProviderModelId: catalogEntry.providerModelId,
          scan: {
            scanId,
            catalogEntryId: catalogEntry.id,
            ...(probeInvocation === null ? {} : { modelInvocationId: probeInvocation.id }),
            scanKind: "lightweight_probe",
            status: "failed",
            evidenceVersion,
            errorCode: normalized.code,
            errorSummary: normalized.description,
            failure: modelHubTextCapabilityProbeFailureMetadata(
              cause,
              savedConnection.providerKind,
            ),
          },
          ...(updateConnectionStatus
            ? {
                connectionTest: {
                  status: "error" as const,
                  errorCode: normalized.code,
                  errorSummary: normalized.description,
                },
              }
            : {}),
        });
      } catch (commitCause: unknown) {
        if (
          commitCause instanceof ModelHubStoreError &&
          commitCause.code === "MODEL_HUB_PROBE_TARGET_CONFLICT"
        ) {
          throw providerDispatched
            ? new SettingsTextProbePostDispatchConflictError()
            : new ModelHubFinalDispatchError();
        }
        throw commitCause;
      }
      if (providerDispatched && cause instanceof ModelHubFinalDispatchError) {
        throw new SettingsTextProbePostDispatchConflictError();
      }
      throw cause;
    }
  }

  async function requestRecommendedTaskAssignment(
    task: NovelAiTask,
    recommendation: ModelHubTaskRecommendation,
  ): Promise<void> {
    if (recommendation.readiness === "ready") {
      await verifyAndAssignRecommendedTask(task, recommendation);
      return;
    }
    if (recommendedTaskBusy !== null || routeSaving || taskProbeConfirmation !== null) {
      return;
    }
    setRecommendedTaskBusy(task);
    setRouteError(null);
    setSchemeMessage(null);
    try {
      const prepared = await prepareModelHubTaskCapabilityProbeDisclosure(
        { modelHub: runtime.modelHub, clock: runtime.clock },
        {
          task,
          connectionId: recommendation.model.connection.id,
          catalogEntryId: recommendation.model.catalogEntry.id,
          readiness: recommendation.readiness,
        },
      );
      setTaskProbeConfirmation(
        Object.freeze({ task, recommendation, disclosure: prepared.disclosure }),
      );
    } catch (cause: unknown) {
      setRouteError(cause);
    } finally {
      setRecommendedTaskBusy(null);
    }
  }

  async function verifyAndAssignRecommendedTask(
    task: NovelAiTask,
    recommendation: ModelHubTaskRecommendation,
    confirmation?: Readonly<{
      humanConfirmed: boolean;
      disclosedFingerprint: string;
    }>,
  ): Promise<void> {
    if (recommendedTaskBusy !== null || routeSaving) return;
    const routesBeforeSave = novelTaskRoutes;
    setRecommendedTaskBusy(task);
    setRouteSaving(true);
    setRouteError(null);
    setSchemeMessage(null);
    try {
      const initial =
        recommendation.readiness === "ready"
          ? await readAuthoritativeProbeTarget(
              recommendation.model.connection.id,
              recommendation.model.catalogEntry.id,
            )
          : await assertConfirmedModelHubTaskCapabilityProbeDisclosure(
              { modelHub: runtime.modelHub, clock: runtime.clock },
              {
                task,
                connectionId: recommendation.model.connection.id,
                catalogEntryId: recommendation.model.catalogEntry.id,
                readiness: recommendation.readiness,
                humanConfirmed: confirmation?.humanConfirmed === true,
                disclosedFingerprint: confirmation?.disclosedFingerprint ?? "",
              },
            ).then(({ connection, catalogEntry }) => ({ connection, entry: catalogEntry }));
      assertModelHubFinalDispatchUnchanged(
        settingsProbeDispatchIdentity(
          recommendation.model.connection,
          recommendation.model.catalogEntry,
        ),
        settingsProbeDispatchIdentity(initial.connection, initial.entry),
      );

      if (recommendation.readiness === "verify_structured_output") {
        const scanId = createModelHubId("structured-probe-scan");
        const invocationId = createModelHubId("capability-probe-invocation");
        const evidenceVersion = MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION;
        try {
          const result = await executeAuditedModelHubStructuredCapabilityProbe({
            gateway: runtime.modelGateway,
            modelHub: runtime.modelHub,
            clock: runtime.clock,
            providerKind: initial.connection.providerKind,
            generationId: createModelHubId("structured-probe"),
            invocationId,
            connection: initial.connection,
            catalogEntry: initial.entry,
            config: modelHubNativeEndpointConfig(initial.connection),
            model: initial.entry.providerModelId,
            assertBeforeProviderDispatch: async () => {
              await assertConfirmedModelHubTaskCapabilityProbeDisclosure(
                { modelHub: runtime.modelHub, clock: runtime.clock },
                {
                  task,
                  connectionId: initial.connection.id,
                  catalogEntryId: initial.entry.id,
                  readiness: "verify_structured_output",
                  humanConfirmed: confirmation?.humanConfirmed === true,
                  disclosedFingerprint: confirmation?.disclosedFingerprint ?? "",
                },
              );
            },
          });
          const verified = await readAuthoritativeProbeTarget(
            initial.connection.id,
            initial.entry.id,
          );
          assertModelHubFinalDispatchUnchanged(
            settingsProbeDispatchIdentity(initial.connection, initial.entry),
            settingsProbeDispatchIdentity(verified.connection, verified.entry),
          );
          await runtime.modelHub.commitCapabilityProbeResult({
            connectionId: verified.connection.id,
            expectedConnectionRevision: verified.connection.revision,
            catalogEntryId: verified.entry.id,
            expectedCatalogRevision: verified.entry.revision,
            expectedProviderModelId: verified.entry.providerModelId,
            scan: {
              scanId,
              catalogEntryId: verified.entry.id,
              modelInvocationId: result.invocation.id,
              scanKind: "lightweight_probe",
              status: "succeeded",
              evidenceVersion,
              evidence: [
                {
                  id: createModelHubId("capability"),
                  capability: "structured_output",
                  verdict: "supported",
                  evidenceSource: "lightweight_probe",
                  evidenceSummary: `固定结构化数据格式探针通过（${result.evidenceVersion}，${String(result.attempts)} 次尝试）；未发送或保存作品内容与模型响应。`,
                },
              ],
            },
          });
        } catch (cause: unknown) {
          if (
            cause instanceof ModelHubTaskCapabilityProbeDisclosureError ||
            cause instanceof ModelHubFinalDispatchError
          ) {
            throw cause;
          }
          const normalized = normalizeUiError(cause);
          const probeInvocation = await runtime.modelHub
            .findInvocation(invocationId)
            .catch(() => null);
          if (
            probeInvocation !== null &&
            (probeInvocation.status === "queued" || probeInvocation.status === "running")
          ) {
            throw cause;
          }
          if (isCapabilityProbeResultAmbiguous(normalized.code, probeInvocation)) {
            throw cause;
          }
          const current = await readAuthoritativeProbeTarget(
            initial.connection.id,
            initial.entry.id,
          );
          assertModelHubFinalDispatchUnchanged(
            settingsProbeDispatchIdentity(initial.connection, initial.entry),
            settingsProbeDispatchIdentity(current.connection, current.entry),
          );
          await runtime.modelHub.commitCapabilityProbeResult({
            connectionId: current.connection.id,
            expectedConnectionRevision: current.connection.revision,
            catalogEntryId: current.entry.id,
            expectedCatalogRevision: current.entry.revision,
            expectedProviderModelId: current.entry.providerModelId,
            scan: {
              scanId,
              catalogEntryId: current.entry.id,
              ...(probeInvocation === null ? {} : { modelInvocationId: probeInvocation.id }),
              scanKind: "lightweight_probe",
              status: "failed",
              evidenceVersion,
              errorCode: normalized.code,
              errorSummary: normalized.description,
            },
          });
          throw cause;
        }
      }

      if (recommendation.readiness === "verify_translation") {
        const scanId = createModelHubId("translation-probe-scan");
        const invocationId = createModelHubId("capability-probe-invocation");
        try {
          const result = await executeAuditedModelHubTranslationCapabilityProbe({
            gateway: runtime.modelGateway,
            modelHub: runtime.modelHub,
            clock: runtime.clock,
            providerKind: initial.connection.providerKind,
            generationId: createModelHubId("translation-probe"),
            invocationId,
            connection: initial.connection,
            catalogEntry: initial.entry,
            config: modelHubNativeEndpointConfig(initial.connection),
            model: initial.entry.providerModelId,
            assertBeforeProviderDispatch: async () => {
              await assertConfirmedModelHubTaskCapabilityProbeDisclosure(
                { modelHub: runtime.modelHub, clock: runtime.clock },
                {
                  task,
                  connectionId: initial.connection.id,
                  catalogEntryId: initial.entry.id,
                  readiness: "verify_translation",
                  humanConfirmed: confirmation?.humanConfirmed === true,
                  disclosedFingerprint: confirmation?.disclosedFingerprint ?? "",
                },
              );
            },
          });
          const verified = await readAuthoritativeProbeTarget(
            initial.connection.id,
            initial.entry.id,
          );
          assertModelHubFinalDispatchUnchanged(
            settingsProbeDispatchIdentity(initial.connection, initial.entry),
            settingsProbeDispatchIdentity(verified.connection, verified.entry),
          );
          await runtime.modelHub.commitCapabilityProbeResult({
            connectionId: verified.connection.id,
            expectedConnectionRevision: verified.connection.revision,
            catalogEntryId: verified.entry.id,
            expectedCatalogRevision: verified.entry.revision,
            expectedProviderModelId: verified.entry.providerModelId,
            scan: {
              scanId,
              catalogEntryId: verified.entry.id,
              modelInvocationId: result.invocation.id,
              scanKind: "lightweight_probe",
              status: "succeeded",
              evidenceVersion: MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION,
              evidence: [
                {
                  id: createModelHubId("capability"),
                  capability: "translation",
                  verdict: "supported",
                  evidenceSource: "lightweight_probe",
                  evidenceSummary: `固定中英翻译探针通过（${result.evidenceVersion}）；未发送或保存作品内容与模型响应。`,
                },
              ],
            },
          });
        } catch (cause: unknown) {
          if (
            cause instanceof ModelHubTaskCapabilityProbeDisclosureError ||
            cause instanceof ModelHubFinalDispatchError
          ) {
            throw cause;
          }
          const normalized = normalizeUiError(cause);
          const probeInvocation = await runtime.modelHub
            .findInvocation(invocationId)
            .catch(() => null);
          if (
            probeInvocation !== null &&
            (probeInvocation.status === "queued" || probeInvocation.status === "running")
          ) {
            throw cause;
          }
          if (isCapabilityProbeResultAmbiguous(normalized.code, probeInvocation)) {
            throw cause;
          }
          const current = await readAuthoritativeProbeTarget(
            initial.connection.id,
            initial.entry.id,
          );
          assertModelHubFinalDispatchUnchanged(
            settingsProbeDispatchIdentity(initial.connection, initial.entry),
            settingsProbeDispatchIdentity(current.connection, current.entry),
          );
          await runtime.modelHub.commitCapabilityProbeResult({
            connectionId: current.connection.id,
            expectedConnectionRevision: current.connection.revision,
            catalogEntryId: current.entry.id,
            expectedCatalogRevision: current.entry.revision,
            expectedProviderModelId: current.entry.providerModelId,
            scan: {
              scanId,
              catalogEntryId: current.entry.id,
              ...(probeInvocation === null ? {} : { modelInvocationId: probeInvocation.id }),
              scanKind: "lightweight_probe",
              status: "failed",
              evidenceVersion: MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION,
              errorCode: normalized.code,
              errorSummary: normalized.description,
              failure: modelHubTextCapabilityProbeFailureMetadata(
                cause,
                current.connection.providerKind,
              ),
            },
          });
          throw cause;
        }
      }

      const existing = await runtime.modelHub.findTaskRoute(task);
      if (existing !== null) {
        throw new Error("这项任务已经由其他操作完成分配，请刷新后查看。");
      }
      const privacy = await runtime.modelHub.findCostPrivacyProfile(initial.entry.id);
      const saved = await runtime.modelHub.saveTaskRoute({
        task,
        primaryCatalogEntryId: initial.entry.id,
        fallbackCatalogEntryId: null,
        presetId: null,
        parameterPolicy: Object.freeze({}),
        maximumCostMicros: null,
        currency: null,
        privacyPolicy: privacy?.dataDestination === "local" ? "local_only" : "cloud_allowed",
        failurePolicy: "ask_user",
        routeOrigin: "user",
        enabled: true,
        expectedRevision: null,
      });
      const [nextConnections, nextRoutes] = await Promise.all([
        runtime.modelHub.listConnections(),
        Promise.all(NOVEL_AI_TASKS.map((candidate) => runtime.modelHub.findTaskRoute(candidate))),
      ]);
      setHubConnections(nextConnections);
      setNovelTaskRoutes(nextRoutes.filter((route): route is NovelTaskRoute => route !== null));
      await refreshRoutingCatalogState(nextConnections);
      if (connectionIntent?.task === task) {
        clearModelHubConnectionIntent(window.localStorage);
        setConnectionIntent(null);
      }
      setSchemeMessage(
        `${recommendation.readiness === "verify_structured_output" ? "结构化输出已验证，并" : "已"}将“${novelAiTaskLabel(saved.task)}”分配给 ${catalogEntryLabel(initial.entry, nextConnections)}。`,
      );
    } catch (cause: unknown) {
      setRouteError(cause);
      await confirmNovelRoutingUnchanged(routesBeforeSave);
    } finally {
      setTaskProbeConfirmation(null);
      setRouteSaving(false);
      setRecommendedTaskBusy(null);
    }
  }

  async function applyInitialSmartRoutingIfEmpty(
    token: ModelHubOperationToken,
  ): Promise<number | null> {
    const currentRoutes = await Promise.all(
      NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task)),
    );
    if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) return null;
    const persistedRoutes = currentRoutes.filter(
      (route): route is NovelTaskRoute => route !== null,
    );
    if (persistedRoutes.length > 0) {
      const activePreset = await runtime.modelHub.findActivePreset();
      const canRecoverInterruptedSmartPlan =
        persistedRoutes.length === 15 &&
        activePreset?.id === "automatic-smart" &&
        activePreset.scheme === "smart" &&
        persistedRoutes.every(
          ({ enabled, presetId, routeOrigin }) =>
            enabled && presetId === "automatic-smart" && routeOrigin === "automatic",
        );
      if (!canRecoverInterruptedSmartPlan) return null;
    }
    const currentProfiles = await runtime.modelCenter.listProfiles();
    if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) return null;
    setRouteError(null);
    setRouteFailureRollbackConfirmed(null);
    setRouteFailureLegacyProjectionMayHaveChanged(false);
    const applied = await applyAutomaticModelHubRouting({
      modelHub: runtime.modelHub,
      legacyRouting: runtime.modelRouting,
      legacyReadyModels: currentProfiles.flatMap(
        ({ providerId: connectionId, selectedModel: modelId }) =>
          modelId === null ? [] : [{ connectionId, modelId }],
      ),
      scheme: "smart",
      now: new Date().toISOString(),
    });
    if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) return null;
    let legacyRefreshFailed = applied.legacySyncStatus === "failed";
    if (!legacyRefreshFailed) {
      try {
        const refreshedRoleRoutes = await runtime.modelRouting.listRoutes();
        if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) return null;
        setRoleRoutes(refreshedRoleRoutes);
      } catch {
        legacyRefreshFailed = true;
      }
    }
    if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) return null;
    setModelHubScheme("smart");
    setNovelTaskRoutes(applied.routes);
    if (legacyRefreshFailed) {
      setSchemeMessage(
        "核心 AI 分工已保存；旧版兼容分工暂未同步，不影响当前模型中心任务，可以稍后重试。",
      );
    }
    return applied.savedNovelTaskCount;
  }

  async function probeSelectedModelCapability(): Promise<void> {
    if (!runtime.modelGateway.available || selectedModel.trim().length === 0) {
      return;
    }
    const probeForm = captureSettingsTextProbeForm();
    const requestedModelId = effectiveSettingsTextProbeModelId({
      automaticDiscovery: getModelProviderPreset(probeForm.providerKind).modelDiscovery.automatic,
      endpointModelId: probeForm.endpointId,
      selectedModelId: probeForm.selectedModel,
    });
    const token = modelHubOperationCoordinatorRef.current.begin("verify_capability", {
      providerKind: probeForm.providerKind,
      connectionId: probeForm.loadedConnectionId ?? probeForm.providerId,
      modelId: requestedModelId,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    let backendCommitted = false;
    let refreshAttempted = false;
    setProbingCapability(true);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
    try {
      const authorization = await prepareSettingsTextProbeAuthorization(
        probeForm,
        secret,
        requestedModelId,
      );
      const savedConnection = await persistPreparedSettingsTextProbeConnection(
        authorization,
        token,
      );
      backendCommitted = true;
      if (
        !modelHubOperationCoordinatorRef.current.isCurrent(token, {
          providerKind: savedConnection.providerKind,
          connectionId: savedConnection.id,
          modelId: authorization.modelId,
        })
      ) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted,
          staleResultIgnored: true,
        });
        return;
      }
      const target = await ensureCatalogEntryForModel(savedConnection, authorization.modelId);
      const result = await performLightweightTextProbe(
        target.connection,
        target.entry,
        authorization,
        true,
      );
      if (
        !modelHubOperationCoordinatorRef.current.isCurrent(token, {
          providerKind: result.connection.providerKind,
          connectionId: result.connection.id,
          modelId: result.entry.providerModelId,
        })
      ) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted,
          staleResultIgnored: true,
          catalogCount: result.catalog.length,
        });
        return;
      }
      let automaticallyConfigured: number | null = null;
      let automaticRoutingFailed = false;
      const routesBeforeAutomaticConfiguration = novelTaskRoutes;
      if (connectionIntent === null) {
        try {
          automaticallyConfigured = await applyInitialSmartRoutingIfEmpty(token);
        } catch (cause: unknown) {
          if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) return;
          automaticRoutingFailed = true;
          setRouteError(cause);
          await confirmNovelRoutingUnchanged(routesBeforeAutomaticConfiguration);
        }
      }
      if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted,
          staleResultIgnored: true,
          catalogCount: result.catalog.length,
        });
        return;
      }
      const successMessage = `${
        result.streamed
          ? `已验证“${result.entry.displayName}”可生成文字并支持流式返回。`
          : `已验证“${result.entry.displayName}”可生成文字；本次没有观察到流式增量。`
      }${
        automaticallyConfigured === null
          ? ""
          : ` 已自动完成 ${String(automaticallyConfigured)} 类 AI 任务的基础分工。`
      }${automaticRoutingFailed ? " 写作能力证据已保留；自动分工未完成，请重试应用 AI 分工。" : ""}`;
      setCapabilityProbeMessage(successMessage);
      refreshAttempted = true;
      const refreshed = await loadModelCenter({
        action: "verify_capability",
        token,
        requestedConnectionId: result.connection.id,
        requestedModelId: result.entry.providerModelId,
        backendCommitted: true,
      });
      if (refreshed) setCapabilityProbeMessage(successMessage);
    } catch (cause: unknown) {
      if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted,
          staleResultIgnored: true,
        });
        return;
      }
      const visibleCause =
        cause instanceof ModelHubFinalDispatchError ? settingsTextProbeDisclosureChanged() : cause;
      const normalizedVisibleCause = normalizeUiError(visibleCause);
      const resultAmbiguous = normalizedVisibleCause.code === "PROVIDER_RESULT_AMBIGUOUS";
      setCapabilityProbeError(visibleCause);
      if (!refreshAttempted) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: resultAmbiguous ? "succeeded_with_warning" : "failed",
          backendCommitted,
          storeRefreshed: false,
          errorCode: normalizedVisibleCause.code,
        });
      }
    } finally {
      setProbingCapability(false);
    }
  }

  async function checkModelConnection(): Promise<void> {
    if (!runtime.modelGateway.available) {
      return;
    }
    const automaticDiscovery = getModelProviderPreset(providerPreset).modelDiscovery.automatic;
    const probeForm = automaticDiscovery ? null : captureSettingsTextProbeForm();
    const requestedOperationModelId = effectiveSettingsTextProbeModelId({
      automaticDiscovery,
      endpointModelId: probeForm?.endpointId ?? endpointId,
      selectedModelId: probeForm?.selectedModel ?? selectedModel,
    });
    const token = modelHubOperationCoordinatorRef.current.begin("discover_models", {
      providerKind: providerPreset,
      connectionId: hubConnection?.id ?? providerId,
      modelId: requestedOperationModelId.length === 0 ? null : requestedOperationModelId,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    setCheckingModel(true);
    setConnectionChecked(false);
    setConnection(null);
    setModelCapacity(null);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
    let savedConnection: ModelProviderConnection | null = null;
    let probeAuthorization: PreparedSettingsTextProbeAuthorization | null = null;
    let lightweightProbeOwnsConnectionOutcome = false;
    let refreshAttempted = false;
    try {
      probeAuthorization =
        probeForm === null
          ? null
          : await prepareSettingsTextProbeAuthorization(
              probeForm,
              secret,
              requestedOperationModelId,
            );
      savedConnection =
        probeAuthorization === null
          ? await persistConnectionWithAvailableCredential(token)
          : await persistPreparedSettingsTextProbeConnection(probeAuthorization, token);
      if (
        !modelHubOperationCoordinatorRef.current.isCurrent(token, {
          providerKind: savedConnection.providerKind,
          connectionId: savedConnection.id,
          modelId: requestedOperationModelId.length === 0 ? null : requestedOperationModelId,
        })
      ) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted: true,
          staleResultIgnored: true,
        });
        return;
      }
      const config = modelHubNativeEndpointConfig(savedConnection);
      const capacityInspection =
        providerPreset === "ollama" && runtime.modelGateway.inspectCapacity !== undefined
          ? runtime.modelGateway.inspectCapacity().catch(() => null)
          : Promise.resolve(null);
      if (!automaticDiscovery) {
        if (probeAuthorization === null) {
          throw settingsTextProbeDisclosureChanged();
        }
        const modelId = requestedOperationModelId.normalize("NFKC");
        const target = await ensureCatalogEntryForModel(savedConnection, modelId);
        lightweightProbeOwnsConnectionOutcome = true;
        const result = await performLightweightTextProbe(
          target.connection,
          target.entry,
          probeAuthorization,
          true,
        );
        const descriptors = result.catalog.map(catalogEntryToDescriptor);
        if (
          !modelHubOperationCoordinatorRef.current.isCurrent(token, {
            providerKind: result.connection.providerKind,
            connectionId: result.connection.id,
            modelId: result.entry.providerModelId,
          })
        ) {
          finishModelHubDiagnosticAction(runtime, token, {
            completedAt: runtime.clock.now(),
            outcome: "stale_ignored",
            backendCommitted: true,
            staleResultIgnored: true,
            catalogCount: result.catalog.length,
          });
          return;
        }
        const successMessage = result.streamed
          ? `连接成功，并已验证“${result.entry.displayName}”可生成文字和流式返回。`
          : `连接成功，并已验证“${result.entry.displayName}”可生成文字。`;
        setCapabilityProbeMessage(successMessage);
        refreshAttempted = true;
        const refreshed = await loadModelCenter({
          action: "discover_models",
          token,
          requestedConnectionId: result.connection.id,
          requestedModelId: result.entry.providerModelId,
          backendCommitted: true,
        });
        if (refreshed) {
          setCapabilityProbeMessage(successMessage);
          setConnection({
            provider: gatewayProviderKind(providerPreset),
            endpointOrigin: new URL(result.connection.baseUrl).origin,
            modelCount: descriptors.length,
            latencyMs: result.latencyMs,
          });
        }
        return;
      }
      const [checked, listed, capacity] = await Promise.all([
        runtime.modelGateway.checkConnection(config),
        runtime.modelGateway.listModels(config),
        capacityInspection,
      ]);
      if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted: true,
          staleResultIgnored: true,
          catalogCount: listed.models.length,
        });
        return;
      }
      const testedConnection = await runtime.modelHub.recordConnectionTest({
        connectionId: savedConnection.id,
        status: "ready",
        expectedRevision: savedConnection.revision,
      });
      const syncId = createModelHubId("provider-sync");
      const catalog = await runtime.modelHub.syncCatalog({
        syncId,
        connectionId: savedConnection.id,
        source: "provider_api",
        status: "succeeded",
        models: listed.models.map((model) => ({
          id: createModelHubId("catalog"),
          providerModelId: model.id,
          displayName: model.displayName,
        })),
      });
      for (const catalogEntry of catalog.filter(
        ({ lastSyncId, availability }) => lastSyncId === syncId && availability === "available",
      )) {
        await runtime.modelHub.recordCapabilityScan({
          scanId: createModelHubId("metadata-scan"),
          catalogEntryId: catalogEntry.id,
          scanKind: "provider_metadata",
          status: "succeeded",
          evidenceVersion: syncId,
          evidence: MODEL_HUB_CAPABILITIES.map((capability) => ({
            id: createModelHubId("capability"),
            capability,
            verdict: "unknown",
            evidenceSource: "provider_metadata",
            evidenceSummary: "供应商目录没有返回可验证的模型能力结论。",
          })),
        });
      }
      void testedConnection;
      void catalog;
      const refreshedModelId =
        selectedModel.length === 0 ? (listed.models[0]?.id ?? null) : selectedModel;
      refreshAttempted = true;
      const refreshed = await loadModelCenter({
        action: "discover_models",
        token,
        requestedConnectionId: savedConnection.id,
        requestedModelId: refreshedModelId,
        backendCommitted: true,
      });
      if (refreshed) {
        setConnection(checked);
        setModels(listed.models);
        setModelCapacity(capacity);
      }
    } catch (reason: unknown) {
      if (!modelHubOperationCoordinatorRef.current.isCurrent(token)) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "stale_ignored",
          backendCommitted: savedConnection !== null,
          staleResultIgnored: true,
        });
        return;
      }
      const visibleReason =
        probeAuthorization !== null && reason instanceof ModelHubFinalDispatchError
          ? settingsTextProbeDisclosureChanged()
          : reason;
      if (
        savedConnection !== null &&
        !lightweightProbeOwnsConnectionOutcome &&
        !(visibleReason instanceof UiActionError)
      ) {
        const normalized = normalizeUiError(visibleReason);
        await runtime.modelHub
          .recordConnectionTest({
            connectionId: savedConnection.id,
            status: "error",
            errorCode: normalized.code,
            errorSummary: normalized.description,
            expectedRevision: savedConnection.revision,
          })
          .catch(() => undefined);
        setHubConnections(await runtime.modelHub.listConnections().catch(() => hubConnections));
      }
      setCredentialError(visibleReason);
      setModelCapacity(null);
      const normalized = normalizeUiError(visibleReason);
      setModelHubPageSnapshot((current) =>
        preserveModelHubPageSnapshotAfterFailure(current, {
          action: "discover_models",
          failedPhase: "LOADING_CATALOG",
          errorCode: normalized.code,
          catalogRefreshFailed: true,
          hydratedAt: runtime.clock.now(),
        }),
      );
      if (!refreshAttempted) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: "failed",
          backendCommitted: savedConnection !== null,
          storeRefreshed: false,
          errorCode: normalized.code,
          catalogCount: hubCatalog.length,
        });
      }
    } finally {
      setConnectionChecked(true);
      setCheckingModel(false);
    }
  }

  async function saveSecret(): Promise<void> {
    if (runtime.mode !== "tauri") {
      return;
    }
    const token = modelHubOperationCoordinatorRef.current.begin("save_credential", {
      providerKind: providerPreset,
      connectionId: providerId,
      modelId: selectedModel.trim().length === 0 ? null : selectedModel,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    let backendCommitted = false;
    let refreshAttempted = false;
    setSaving(true);
    try {
      validateExpertConnectionDraft({
        provider: providerPreset,
        baseUrl,
        region,
        workspaceId,
        authentication,
        credentialHeaderName,
        modelDiscoveryPath,
        textGenerationPath,
        embeddingPath,
        requestTimeoutMs,
        retryLimit,
      });
      await assertCredentialMutationTarget("save");
      const nextAuthentication =
        providerPreset === "custom_openai_compatible" && authentication === "none"
          ? "bearer_keyring"
          : authentication;
      setAuthentication(nextAuthentication);
      const saved = await saveModelHubCredential(runtime, {
        connection: await modelHubConnectionInput(true, nextAuthentication),
        secret,
      });
      backendCommitted = true;
      setSecret("");
      if (saved.oldCredentialCleanupPending) {
        setSchemeMessage("新密钥已安全保存；旧密钥槽将在下次启动或重试时继续清理。");
      }
      refreshAttempted = true;
      await loadModelCenter({
        action: "save_credential",
        token,
        requestedConnectionId: saved.connection.id,
        requestedModelId: selectedModel.trim().length === 0 ? null : selectedModel,
        backendCommitted: true,
      });
    } catch (reason: unknown) {
      const normalized = normalizeUiError(reason);
      if (backendCommitted) {
        setModelHubMutationNotice({
          message: "密钥已经安全保存，但页面状态刷新失败。请重新加载模型中心，无需再次输入密钥。",
          reloadRequired: true,
        });
      } else {
        setCredentialError(reason);
      }
      if (!refreshAttempted) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: backendCommitted ? "succeeded_with_warning" : "failed",
          backendCommitted,
          storeRefreshed: false,
          errorCode: normalized.code,
        });
      }
    } finally {
      setSaving(false);
    }
  }

  async function applyModelHubScheme(): Promise<void> {
    setSchemeMessage(null);
    setRouteFailureRollbackConfirmed(null);
    setRouteFailureLegacyProjectionMayHaveChanged(false);
    if (modelHubScheme === "custom") {
      setExpertMode(true);
      setSchemeMessage("已打开专家设置，可逐项调整模型能力和兼容路由。");
      return;
    }
    setSchemeSaving(true);
    setRouteError(null);
    const routesBeforeSave = novelTaskRoutes;
    try {
      const applied = await applyAutomaticModelHubRouting({
        modelHub: runtime.modelHub,
        legacyRouting: runtime.modelRouting,
        legacyReadyModels: profiles.flatMap(
          ({ providerId: connectionId, selectedModel: modelId }) =>
            modelId === null ? [] : [{ connectionId, modelId }],
        ),
        scheme: modelHubScheme,
        now: new Date().toISOString(),
      });
      let legacyRefreshFailed = applied.legacySyncStatus === "failed";
      if (!legacyRefreshFailed) {
        try {
          setRoleRoutes(await runtime.modelRouting.listRoutes());
        } catch {
          legacyRefreshFailed = true;
        }
      }
      setNovelTaskRoutes(applied.routes);
      const missing = NOVEL_AI_TASKS.length - applied.savedNovelTaskCount;
      const legacyWarning = legacyRefreshFailed
        ? "；旧版兼容分工暂未同步，不影响当前模型中心任务，可以稍后重试"
        : "";
      setSchemeMessage(
        modelHubScheme === "local_privacy"
          ? missing === 0
            ? `本地隐私方案已覆盖 ${String(applied.savedNovelTaskCount)} 类任务；主模型和备用模型都只会使用本机连接${legacyWarning}。`
            : `本地隐私方案已安全应用；${String(applied.savedNovelTaskCount)} 类任务基础配置完成，${String(missing)} 类缺少本机能力证据，且不会回退到云端${legacyWarning}。`
          : `已按当前可用能力配置 ${String(applied.savedNovelTaskCount)} 类任务；${String(missing)} 类任务等待能力证据${legacyWarning}。`,
      );
    } catch (cause: unknown) {
      setRouteError(cause);
      setRouteFailureLegacyProjectionMayHaveChanged(modelHubScheme === "local_privacy");
      await confirmNovelRoutingUnchanged(routesBeforeSave);
    } finally {
      setSchemeSaving(false);
    }
  }

  async function deleteSecret(): Promise<void> {
    if (runtime.mode !== "tauri") {
      return;
    }
    const token = modelHubOperationCoordinatorRef.current.begin("delete_credential", {
      providerKind: providerPreset,
      connectionId: providerId,
      modelId: selectedModel.trim().length === 0 ? null : selectedModel,
    });
    startModelHubDiagnosticAction(runtime, token, runtime.clock.now());
    let backendCommitted = false;
    let refreshAttempted = false;
    setSaving(true);
    try {
      const targetConnection = await assertCredentialMutationTarget("delete");
      if (targetConnection === null) {
        throw new ModelHubStoreError(
          "MODEL_HUB_CREDENTIAL_TARGET_MISMATCH",
          "只能删除当前已加载配置的密钥。请先从已保存配置中重新选择它。",
        );
      }
      const nextAuthentication =
        providerPreset === "custom_openai_compatible" && authentication === "custom_header_keyring"
          ? "none"
          : authentication;
      if (nextAuthentication !== authentication) {
        setAuthentication(nextAuthentication);
        setCredentialHeaderName("");
      }
      const deleted = await deleteModelHubCredential(runtime, {
        connection: await modelHubConnectionInput(false, nextAuthentication),
      });
      backendCommitted = true;
      setSecret("");
      if (deleted.credentialCleanup === "skipped_unowned_reference") {
        setSchemeMessage(
          "连接已安全停用；检测到来源不明的旧凭据引用，因此没有猜测或删除任何系统凭据槽。",
        );
      }
      refreshAttempted = true;
      await loadModelCenter({
        action: "delete_credential",
        token,
        requestedConnectionId: deleted.connection.id,
        requestedModelId: selectedModel.trim().length === 0 ? null : selectedModel,
        backendCommitted: true,
      });
    } catch (reason: unknown) {
      const normalized = normalizeUiError(reason);
      if (backendCommitted) {
        setModelHubMutationNotice({
          message: "密钥删除已经完成，但页面状态刷新失败。请重新加载模型中心，不要重复删除。",
          reloadRequired: true,
        });
      } else {
        setCredentialError(reason);
      }
      const current = await runtime.modelHub.findConnection(providerId).catch(() => null);
      if (current !== null) {
        setHubConnection(current);
        setHubConnections(await runtime.modelHub.listConnections().catch(() => hubConnections));
      }
      if (!refreshAttempted) {
        finishModelHubDiagnosticAction(runtime, token, {
          completedAt: runtime.clock.now(),
          outcome: backendCommitted ? "succeeded_with_warning" : "failed",
          backendCommitted,
          storeRefreshed: false,
          errorCode: normalized.code,
        });
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirmRetireConnection(): Promise<void> {
    const target = retireConnectionTarget;
    if (target === null) {
      return;
    }
    setRetiringConnection(true);
    setCredentialError(null);
    setRetirementMessage(null);
    try {
      const result = await retireModelHubConnection(
        {
          modelHub: runtime.modelHub,
          modelCenter: runtime.modelCenter,
          credentials: runtime.credentials,
        },
        { connectionId: target.id, expectedRevision: target.revision },
      );
      const [nextConnections, nextProfiles] = await Promise.all([
        runtime.modelHub.listConnections(),
        runtime.modelCenter.listProfiles(),
      ]);
      setHubConnections(nextConnections);
      setHubConnection(null);
      setProfiles(nextProfiles);
      setProfile(null);
      setSummary(result.credential);
      setSecret("");
      setConnection(null);
      setConnectionChecked(false);
      setModelCapacity(null);
      setProviderId(nextAvailableProviderConnectionId(target.providerKind, nextConnections));
      setSelectedModel("");
      setModels([]);
      setHubCatalog([]);
      setRetirementMessage(
        `“${target.displayName}”已退役：不会再参与选择、推荐或 AI 分工，系统凭据已清理；已有正文、模型目录和调用记录仍会保留。`,
      );
      if (result.credentialCleanup === "skipped_unowned_reference") {
        setRetirementMessage(
          `“${target.displayName}”已退役；检测到来源不明的旧凭据引用，因此没有猜测或删除任何系统凭据槽。正文、模型目录和调用记录仍然保留。`,
        );
      }
      setRetireConnectionTarget(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
      const current = await runtime.modelHub.findConnection(target.id).catch(() => null);
      if (current !== null) {
        setHubConnection(current);
        setHubConnections(await runtime.modelHub.listConnections().catch(() => hubConnections));
        // Disabling the connection is committed before credential/profile
        // cleanup. If cleanup fails, that commit advances the authoritative CAS
        // revision. Keep the dialog open but bind the retry to the fresh row so
        // the user can safely finish cleanup without an artificial conflict.
        setRetireConnectionTarget(current);
      }
    } finally {
      setRetiringConnection(false);
    }
  }

  async function createBackup(): Promise<void> {
    if (runtime.maintenance === null) {
      return;
    }

    setMaintenanceBusy("backup");
    setMaintenanceError(null);
    setBackupComplete(false);
    try {
      const destinationTicket = await runtime.maintenance.chooseBackupDestination();
      if (destinationTicket === null) {
        return;
      }

      const result = await runtime.maintenance.createConsistentBackup(destinationTicket);
      if (!result.ok) {
        setMaintenanceError(result.error);
        return;
      }
      setBackupComplete(true);
      await inspectDatabase();
    } catch (reason: unknown) {
      setMaintenanceError(reason);
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function selectRestoreBackup(): Promise<void> {
    if (runtime.maintenance === null) {
      return;
    }
    setMaintenanceBusy("restore");
    setMaintenanceError(null);
    try {
      const sourceTicket = await runtime.maintenance.chooseRestoreSource();
      if (sourceTicket !== null) {
        setRestoreSourceTicket(sourceTicket);
      }
    } catch (reason: unknown) {
      setMaintenanceError(reason);
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function confirmRestore(): Promise<void> {
    if (runtime.maintenance === null || restoreSourceTicket === null) {
      return;
    }
    const sourceTicket = restoreSourceTicket;
    setMaintenanceBusy("restore");
    setMaintenanceError(null);
    setRestoreComplete(false);
    try {
      const rollbackTicket = await runtime.maintenance.choosePreRestoreBackupDestination();
      if (rollbackTicket === null) {
        return;
      }

      const rollback = await runtime.maintenance.createConsistentBackup(rollbackTicket);
      if (!rollback.ok) {
        setMaintenanceError(rollback.error);
        return;
      }
      const restored = await runtime.maintenance.restoreConsistentBackup(sourceTicket);
      if (!restored.ok) {
        setMaintenanceError(restored.error);
        return;
      }
      setRestoreSourceTicket(null);
      setRestoreComplete(true);
      window.setTimeout(() => window.location.reload(), 1_200);
    } catch (reason: unknown) {
      setMaintenanceError(reason);
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function downloadDiagnostics(): Promise<void> {
    setDiagnosticBusy(true);
    setDiagnosticError(null);
    setDiagnosticId(null);
    try {
      const artifact = await collectDesktopDiagnosticArtifact(runtime);
      downloadBrowserExportArtifact(artifact);
      setDiagnosticId(artifact.bundle.summary.diagnosticId);
    } catch (reason: unknown) {
      setDiagnosticError(reason);
    } finally {
      setDiagnosticBusy(false);
    }
  }

  function updateEditorTypography(next: EditorTypography): void {
    try {
      saveEditorTypography(window.localStorage, next, window);
      setEditorTypography(next);
      setWritingPreferenceError(null);
    } catch {
      setWritingPreferenceError("无法保存正文显示设置。请检查系统存储权限后重试。");
    }
  }

  function updateEditorPreferences(next: EditorPreferences): void {
    try {
      const saved = saveEditorPreferences(window.localStorage, next, window);
      setEditorPreferences(saved);
      setWritingPreferenceError(null);
    } catch {
      setWritingPreferenceError("无法保存自动保存设置。请检查系统存储权限后重试。");
    }
  }

  async function selectMemoryProject(projectId: string): Promise<void> {
    setSelectedMemoryProjectId(projectId);
    setMemoryClearMessage(null);
    await loadProjectMemoryGovernance(projectId);
  }

  function openProjectMemoryClearDialog(): void {
    if (selectedMemoryProjectId.length === 0 || selectedMemoryPolicy === null) {
      return;
    }
    setMemoryGovernanceError(null);
    setMemoryClearOperationId(runtime.ids.next());
    setMemoryClearDialogOpen(true);
  }

  async function confirmProjectMemoryClear(): Promise<void> {
    if (
      memoryGovernanceBusy ||
      memoryClearOperationId === null ||
      selectedMemoryPolicy === null ||
      selectedMemoryProjectId.length === 0
    ) {
      return;
    }
    setMemoryGovernanceBusy(true);
    setMemoryGovernanceError(null);
    const result = await runtime.story.memoryService.forgetProjectMemory({
      operationId: memoryClearOperationId,
      projectId: selectedMemoryProjectId,
      expectedPolicyRevision: selectedMemoryPolicy.revision,
      expectedRecords: selectedProjectMemories.map((memory) => ({
        id: memory.id,
        revision: memory.revision,
      })),
      humanConfirmed: true,
    });
    setMemoryGovernanceBusy(false);
    setMemoryClearDialogOpen(false);
    setMemoryClearOperationId(null);
    if (!result.ok) {
      setMemoryGovernanceError(result.error);
      await loadProjectMemoryGovernance(selectedMemoryProjectId);
      return;
    }
    setMemoryClearMessage(
      `已忘掉该项目的 ${String(result.value.affectedRecordCount)} 条本地 AI 记忆，并关闭自动学习；审计记录和来源仍保留。`,
    );
    await loadProjectMemoryGovernance(selectedMemoryProjectId);
  }

  const modelHubHydrationPending = isModelHubHydrationPending(modelHubPageSnapshot.phase);
  const shallowModelHubReadiness = useMemo(
    () =>
      projectModelHubReadiness({
        connections: hubConnections,
        catalog: routingCatalog,
        routes: novelTaskRoutes,
        transientChecking: modelHubHydrationPending || checkingModel,
        loadFailed: credentialError !== null,
      }),
    [
      checkingModel,
      credentialError,
      hubConnections,
      modelHubHydrationPending,
      novelTaskRoutes,
      routingCatalog,
    ],
  );
  const authoritativeModelHubReadinessFingerprint = useMemo(
    () =>
      JSON.stringify({
        connections: hubConnections.map(
          ({ id, revision, enabled, connectionStatus, catalogSyncStatus, credentialState }) => [
            id,
            revision,
            enabled,
            connectionStatus,
            catalogSyncStatus,
            credentialState,
          ],
        ),
        catalog: routingCatalog.map(({ id, revision, availability, lifecycle, staleAfter }) => [
          id,
          revision,
          availability,
          lifecycle,
          staleAfter,
        ]),
        routes: novelTaskRoutes.map(
          ({ task, revision, enabled, primaryCatalogEntryId, fallbackCatalogEntryId }) => [
            task,
            revision,
            enabled,
            primaryCatalogEntryId,
            fallbackCatalogEntryId,
          ],
        ),
        evidence: routingCapabilityEvidence.map(({ id, verdict, observedAt, expiresAt }) => [
          id,
          verdict,
          observedAt,
          expiresAt,
        ]),
        costPrivacy: routingCostPrivacyProfiles.map(({ catalogEntryId, revision }) => [
          catalogEntryId,
          revision,
        ]),
        credentialConfigured: summary.configured,
      }),
    [
      hubConnections,
      novelTaskRoutes,
      routingCapabilityEvidence,
      routingCatalog,
      routingCostPrivacyProfiles,
      summary.configured,
    ],
  );
  const matchingAuthoritativeModelHubReadiness =
    authoritativeModelHubReadiness?.fingerprint === authoritativeModelHubReadinessFingerprint
      ? authoritativeModelHubReadiness.readiness
      : null;
  const authoritativeModelHubReadinessPending =
    isModelHubView && !modelHubHydrationPending && matchingAuthoritativeModelHubReadiness === null;

  useEffect(() => {
    if (!isModelHubView || modelHubHydrationPending) return;
    let active = true;
    let refreshSequence = 0;
    const refresh = (): void => {
      const sequence = refreshSequence + 1;
      refreshSequence = sequence;
      void import("../infrastructure/model-hub-authoritative-readiness")
        .then(({ loadAuthoritativeModelHubReadiness }) =>
          loadAuthoritativeModelHubReadiness(runtime),
        )
        .then((readiness) => {
          if (!active || sequence !== refreshSequence) return;
          setAuthoritativeModelHubReadiness({
            fingerprint: authoritativeModelHubReadinessFingerprint,
            readiness,
          });
        })
        .catch(() => {
          if (!active || sequence !== refreshSequence) return;
          setAuthoritativeModelHubReadiness({
            fingerprint: authoritativeModelHubReadinessFingerprint,
            readiness: projectModelHubReadiness({
              connections: [],
              catalog: [],
              routes: [],
              loadFailed: true,
            }),
          });
        });
    };
    const refreshTimer = window.setInterval(refresh, MODEL_HUB_READINESS_REFRESH_INTERVAL_MS);
    refresh();
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
    };
  }, [
    authoritativeModelHubReadinessFingerprint,
    isModelHubView,
    modelHubHydrationPending,
    runtime,
  ]);
  const modelHubReadiness =
    matchingAuthoritativeModelHubReadiness ??
    (authoritativeModelHubReadinessPending
      ? projectModelHubReadiness({
          connections: hubConnections,
          catalog: routingCatalog,
          routes: novelTaskRoutes,
          transientChecking: true,
        })
      : shallowModelHubReadiness);
  const modelHubReadinessEventFingerprint = JSON.stringify({
    state: modelHubReadiness.state,
    enabledConnectionCount: modelHubReadiness.enabledConnectionCount,
    usableConnectionCount: modelHubReadiness.usableConnectionCount,
    runnableCoreTaskCount: modelHubReadiness.runnableCoreTaskCount,
    totalCoreTaskCount: modelHubReadiness.totalCoreTaskCount,
    missingCoreTasks: modelHubReadiness.missingCoreTasks,
    exactBlockers: modelHubReadiness.exactBlockers,
  });

  useEffect(() => {
    if (modelHubHydrationPending || authoritativeModelHubReadinessPending) return;
    window.dispatchEvent(new Event(MODEL_HUB_READINESS_CHANGED_EVENT));
  }, [
    authoritativeModelHubReadinessPending,
    modelHubHydrationPending,
    modelHubReadinessEventFingerprint,
  ]);

  const normalizedCredentialError =
    credentialError === null ? null : projectOrdinaryUiError(credentialError);
  const normalizedModelHubPageError =
    modelHubPageSnapshot.errorCode === null
      ? null
      : projectOrdinaryUiError({ code: modelHubPageSnapshot.errorCode });
  const normalizedCapabilityProbeError =
    capabilityProbeError === null ? null : normalizeUiError(capabilityProbeError);
  const normalizedRouteError = routeError === null ? null : normalizeUiError(routeError);
  const taskProbeDisclosureError =
    routeError instanceof ModelHubTaskCapabilityProbeDisclosureError ? routeError : null;
  const routeProbeResultAmbiguous = normalizedRouteError?.code === "PROVIDER_RESULT_AMBIGUOUS";
  const routingVisibility = useMemo(
    () =>
      buildModelHubRoutingVisibility({
        connections: hubConnections,
        catalog: routingCatalog,
        routes: novelTaskRoutes,
        capabilityEvidence: routingCapabilityEvidence,
        recentAiFailures: routingRecentAiFailures,
        now: runtime.clock.now(),
        validating: modelHubHydrationPending || checkingModel || probingCapability,
        loadFailed: credentialError !== null,
        saveFailed:
          normalizedRouteError !== null &&
          taskProbeDisclosureError === null &&
          !routeProbeResultAmbiguous,
        exactBlockers: matchingAuthoritativeModelHubReadiness?.exactBlockers ?? [],
      }),
    [
      checkingModel,
      credentialError,
      hubConnections,
      matchingAuthoritativeModelHubReadiness,
      modelHubHydrationPending,
      novelTaskRoutes,
      normalizedRouteError,
      routeProbeResultAmbiguous,
      taskProbeDisclosureError,
      probingCapability,
      routingCapabilityEvidence,
      routingCatalog,
      routingRecentAiFailures,
      runtime,
    ],
  );
  const paidEvaluationTargets = useMemo<readonly NovelSkillPaidEvaluationTargetOption[]>(() => {
    const connectionById = new Map(hubConnections.map((connection) => [connection.id, connection]));
    const costByCatalogId = new Map(
      routingCostPrivacyProfiles.map((profile) => [profile.catalogEntryId, profile]),
    );
    const now = runtime.clock.now();
    return routingCatalog
      .filter((entry) => {
        const connection = connectionById.get(entry.connectionId);
        const cost = costByCatalogId.get(entry.id);
        const hasTextEvidence = routingCapabilityEvidence.some(
          (evidence) =>
            evidence.catalogEntryId === entry.id &&
            evidence.capability === "text_generation" &&
            evidence.verdict === "supported" &&
            (evidence.expiresAt === null || evidence.expiresAt > now),
        );
        return (
          connection?.enabled === true &&
          connection.connectionStatus === "ready" &&
          connection.catalogSyncStatus === "succeeded" &&
          entry.availability === "available" &&
          entry.lifecycle !== "deprecated" &&
          (entry.staleAfter === null || entry.staleAfter > now) &&
          entry.inputTokenLimit !== null &&
          entry.inputTokenLimit >= 7_000 &&
          entry.outputTokenLimit !== null &&
          entry.outputTokenLimit >= 4_096 &&
          hasTextEvidence &&
          isCompletePaidEvaluationCostProfile(cost)
        );
      })
      .map((entry) => {
        const connection = connectionById.get(entry.connectionId);
        if (connection === undefined) {
          throw new Error("Paid evaluation target connection disappeared during projection.");
        }
        return Object.freeze({
          targetId: entry.id,
          providerLabel: connection.displayName,
          modelLabel: entry.displayName,
          providerModelId: entry.providerModelId,
        });
      })
      .sort(
        (left, right) =>
          left.providerLabel.localeCompare(right.providerLabel, "zh-CN") ||
          left.modelLabel.localeCompare(right.modelLabel, "zh-CN") ||
          left.targetId.localeCompare(right.targetId, "en"),
      );
  }, [
    hubConnections,
    routingCapabilityEvidence,
    routingCatalog,
    routingCostPrivacyProfiles,
    runtime,
  ]);
  const connectedTaskRecommendations = useMemo(
    () =>
      new Map(
        routingVisibility.tasks.map(({ definition, status }) => [
          definition.task,
          status === "configured"
            ? (recommendConnectedModelsForTask(definition.task, routingVisibility.models)[0] ??
              null)
            : null,
        ]),
      ),
    [routingVisibility.models, routingVisibility.tasks],
  );
  const selectableCatalogOfficialCandidates = useMemo(
    () => projectSelectableModelCatalog(runtime.clock.now()),
    [runtime],
  );
  const selectableCatalogConnectedModels = useMemo<
    readonly ModelHubSelectableCatalogConnectedModel[]
  >(() => {
    const now = runtime.clock.now();
    return routingVisibility.models.flatMap((model) => {
      const entry = model.catalogEntry;
      const connection = model.connection;
      if (
        isRetiredModelProviderConnection(connection) ||
        (entry.staleAfter !== null && entry.staleAfter <= now)
      ) {
        return [];
      }
      const supportedCapabilities = model.capabilities
        .filter(({ state }) => state === "verified" || state === "user_confirmed")
        .map(({ capability }) => capability);
      const applicationVerifiedCapabilities = model.capabilities.filter(
        ({ state }) => state === "verified",
      );
      return [
        Object.freeze({
          catalogEntryId: entry.id,
          providerKind: connection.providerKind,
          providerModelId: entry.providerModelId,
          displayName: entry.displayName,
          providerLabel: getModelProviderPreset(connection.providerKind).displayName,
          connectionLabel: connection.displayName,
          regionGroup: connectedModelRegionGroup(connection),
          tags: Object.freeze(supportedCapabilities),
          lifecycle: entry.lifecycle === "unknown" ? "not_provided" : entry.lifecycle,
          appSupport:
            applicationVerifiedCapabilities.length > 0 &&
            model.connectionUsable &&
            connection.connectionStatus === "ready" &&
            connection.catalogSyncStatus === "succeeded" &&
            entry.availability === "available"
              ? "verified_in_app"
              : "verification_required",
        }),
      ];
    });
  }, [routingVisibility.models, runtime]);
  const selectableTaskModels = useMemo<
    ReadonlyMap<
      NovelAiTask,
      readonly MergedSelectableModelCatalogEntry<
        SelectableModelCatalogProjection,
        ModelCatalogEntry
      >[]
    >
  >(() => {
    const now = runtime.clock.now();
    return new Map(
      routingVisibility.tasks.map(({ definition }) => {
        const selectable: readonly SelectableModelCatalogProjection[] = expertMode
          ? selectableModelsForTask(definition.task, now, { expert: true })
          : selectableModelsForTask(definition.task, now);
        const connected = recommendConnectedModelsForTask(
          definition.task,
          routingVisibility.models,
        ).map(({ model }) => ({
          providerKind: model.connection.providerKind,
          entry: model.catalogEntry,
        }));
        return [definition.task, mergeConnectedAndSelectableModels(connected, selectable)] as const;
      }),
    );
  }, [expertMode, routingVisibility.models, routingVisibility.tasks, runtime]);
  const connectionIntentModel = useMemo(() => {
    if (connectionIntent === null) return null;
    const registryEntry = SELECTABLE_MODEL_CATALOG_ENTRIES.find(
      (entry) =>
        entry.providerKind === connectionIntent.providerKind &&
        entry.modelId === connectionIntent.providerModelId,
    );
    const acceptedIds = new Set([
      connectionIntent.providerModelId.toLocaleLowerCase("en-US"),
      ...(registryEntry?.aliases.map((alias) => alias.toLocaleLowerCase("en-US")) ?? []),
    ]);
    const now = runtime.clock.now();
    return (
      routingVisibility.models
        .filter(
          (model) =>
            model.connection.providerKind === connectionIntent.providerKind &&
            model.connection.enabled &&
            model.connection.connectionStatus !== "disabled" &&
            !isRetiredModelProviderConnection(model.connection) &&
            model.catalogEntry.availability === "available" &&
            model.catalogEntry.lifecycle !== "deprecated" &&
            (model.catalogEntry.staleAfter === null || model.catalogEntry.staleAfter > now) &&
            acceptedIds.has(model.catalogEntry.providerModelId.toLocaleLowerCase("en-US")),
        )
        .sort((left, right) => {
          const leftReady = recommendConnectedModelsForTask(connectionIntent.task, [left]).some(
            ({ readiness }) => readiness === "ready",
          );
          const rightReady = recommendConnectedModelsForTask(connectionIntent.task, [right]).some(
            ({ readiness }) => readiness === "ready",
          );
          const leftTrustedEvidence = left.capabilities.filter(
            ({ state }) => state === "verified" || state === "user_confirmed",
          ).length;
          const rightTrustedEvidence = right.capabilities.filter(
            ({ state }) => state === "verified" || state === "user_confirmed",
          ).length;
          return (
            Number(rightReady) - Number(leftReady) ||
            Number(right.connectionUsable) - Number(left.connectionUsable) ||
            Number(right.connection.connectionStatus === "ready") -
              Number(left.connection.connectionStatus === "ready") ||
            rightTrustedEvidence - leftTrustedEvidence ||
            left.catalogEntry.id.localeCompare(right.catalogEntry.id, "en")
          );
        })[0] ?? null
    );
  }, [connectionIntent, routingVisibility.models, runtime]);
  const connectionIntentCatalogEntry = connectionIntentModel?.catalogEntry ?? null;
  const connectionIntentTaskRecommendation = useMemo(() => {
    if (connectionIntent === null || connectionIntentModel === null) return null;
    return (
      recommendConnectedModelsForTask(connectionIntent.task, [connectionIntentModel])[0] ?? null
    );
  }, [connectionIntent, connectionIntentModel]);
  useEffect(() => {
    if (
      connectionIntent === null ||
      connectionIntentCatalogEntry === null ||
      connectionIntentTaskRecommendation === null
    ) {
      return;
    }
    if (activeModelHubSection !== "model-routing") {
      void navigate("/settings#model-routing", { replace: true });
      return;
    }
    const targetTask = routingVisibility.tasks.find(
      ({ definition }) => definition.task === connectionIntent.task,
    );
    if (targetTask === undefined) return;
    const targetsConfiguredPartition = targetTask.route !== null;
    const targetPartitionExpanded = targetsConfiguredPartition
      ? configuredTaskPartitionExpanded
      : missingTaskPartitionExpanded;
    const targetModelsExpanded = expandedModelTasks.includes(connectionIntent.task);
    if (!targetPartitionExpanded || !targetModelsExpanded) {
      const expansionTimeout = window.setTimeout(() => {
        if (targetsConfiguredPartition) {
          setConfiguredTaskPartitionExpanded(true);
        } else {
          setMissingTaskPartitionExpanded(true);
        }
        setExpandedModelTasks((current) =>
          current.includes(connectionIntent.task)
            ? current
            : Object.freeze([...current, connectionIntent.task]),
        );
      }, 0);
      return () => window.clearTimeout(expansionTimeout);
    }
    const timeout = window.setTimeout(() => {
      const target = document.getElementById(`model-routing-task-${connectionIntent.task}`);
      if (typeof target?.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      target?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    activeModelHubSection,
    configuredTaskPartitionExpanded,
    connectionIntent,
    connectionIntentCatalogEntry,
    connectionIntentTaskRecommendation,
    expandedModelTasks,
    missingTaskPartitionExpanded,
    navigate,
    routingVisibility.tasks,
  ]);
  const providerTaskRecommendations = useMemo(() => {
    const now = runtime.clock.now();
    return new Map(
      routingVisibility.tasks.map(({ definition }) => [
        definition.task,
        providerRecommendationsForTask(definition.task, now)[0] ?? null,
      ]),
    );
  }, [routingVisibility.tasks, runtime]);
  const missingNovelTaskRouteCount = routingVisibility.missingRouteCount;
  const modelHubRouteBadgeTone = modelHubOverallBadgeTone(routingVisibility.state);
  const modelHubRouteBadgeLabel = modelHubOverallBadgeLabel(routingVisibility.state);
  const visibleExpertTasks = routingVisibility.tasks.filter(({ status }) =>
    taskMatrixFilter === "all" ? true : status === taskMatrixFilter,
  );
  const schemeMessageIsWarning =
    schemeMessage?.includes("缺少") === true ||
    schemeMessage?.includes("暂未同步") === true ||
    schemeMessage?.includes("等待能力证据") === true;
  const normalizedMaintenanceError =
    maintenanceError === null ? null : normalizeUiError(maintenanceError);
  const normalizedDiagnosticError =
    diagnosticError === null ? null : normalizeUiError(diagnosticError);
  const normalizedMemoryGovernanceError =
    memoryGovernanceError === null ? null : normalizeUiError(memoryGovernanceError);
  const selectedMemoryProject =
    memoryProjects.find(({ id }) => id === selectedMemoryProjectId) ?? null;
  const activeProjectMemoryCount = selectedProjectMemories.filter(
    (memory) => !memory.toSnapshot().excluded,
  ).length;
  const projectMemoryCanBeCleared =
    selectedMemoryPolicy?.automaticLearningEnabled === true || activeProjectMemoryCount > 0;
  const automaticBackupPresentation = describeAutomaticBackupCheck(automaticBackupCheck);
  const selectedModelDescriptor = models.find(({ id }) => id === selectedModel) ?? null;
  const localCapacityAssessment = assessLocalModelCapacity(selectedModelDescriptor, modelCapacity);
  const manageableHubConnections = hubConnections.filter(
    (connection) => !isRetiredModelProviderConnection(connection),
  );
  const retiredHubConnections = hubConnections.filter(isRetiredModelProviderConnection);
  const credentialDeletedConnection =
    hubConnection !== null && isCredentialDeletedConnection(hubConnection) ? hubConnection : null;
  const automaticModelDiscovery = getModelProviderPreset(providerPreset).modelDiscovery.automatic;
  const effectiveTextProbeModelId = effectiveSettingsTextProbeModelId({
    automaticDiscovery: automaticModelDiscovery,
    endpointModelId: endpointId,
    selectedModelId: selectedModel,
  });
  const selectableRoutingCatalog = routingCatalog.filter(
    ({ id, availability, connectionId }) =>
      availability === "available" &&
      hubConnections.some(
        (connection) =>
          connection.id === connectionId &&
          connection.enabled &&
          connection.connectionStatus !== "disabled" &&
          !isRetiredModelProviderConnection(connection),
      ) &&
      (novelRoutePrivacy !== "local_only" || localCatalogEntryIds.includes(id)),
  );
  const modelHubFormReadiness = resolveModelHubFormReadiness({
    busy: modelHubHydrationPending || saving || checkingModel || probingCapability,
    nativeGatewayAvailable: runtime.modelGateway.available,
    online,
    endpointCanRunOffline: canCheckModelEndpointWhileOffline(provider, baseUrl),
    providerId,
    baseUrl,
    connectionFieldsValid: expertConnectionInputsAreComplete(
      authentication,
      credentialHeaderName,
      requestTimeoutMs,
      retryLimit,
    ),
    authenticationRequired: authentication !== "none",
    storedCredentialConfigured: summary.configured,
    newlyEnteredCredentialValid: secret.trim().length >= 8,
    automaticDiscovery: automaticModelDiscovery,
    selectedModelId: selectedModel,
    endpointModelId: endpointId,
    connectionReady:
      connection !== null ||
      (hubConnection?.id === providerId &&
        (hubConnection.connectionStatus === "ready" ||
          hubConnection.connectionStatus === "degraded")),
  });
  const showModelHubOnboarding =
    activeModelHubSection === "model-center" &&
    !connectionSetupExpanded &&
    !expertMode &&
    connectionIntent === null &&
    modelHubMutationNotice === null &&
    !modelHubHydrationPending &&
    manageableHubConnections.length === 0 &&
    !summary.configured &&
    secret.trim().length === 0;
  const hasRetirementResult = retirementMessage !== null;

  function selectableModelsForTaskDisclosure(task: NovelAiTask) {
    const candidates = selectableTaskModels.get(task) ?? [];
    const connectedCandidateCount = candidates.filter(
      ({ source }) => source === "connected",
    ).length;
    const taskProjection = routingVisibility.tasks.find(
      ({ definition }) => definition.task === task,
    );
    return (
      <details
        className="model-routing-model-options"
        open={expandedModelTasks.includes(task)}
        onToggle={(event) => {
          const expanded = event.currentTarget.open;
          setExpandedModelTasks((current) =>
            expanded
              ? current.includes(task)
                ? current
                : Object.freeze([...current, task])
              : Object.freeze(current.filter((candidate) => candidate !== task)),
          );
        }}
      >
        <summary>查看可选模型（{String(candidates.length)}）</summary>
        {expandedModelTasks.includes(task) && (
          <>
            <p>
              {connectedCandidateCount > 0
                ? "已连接账户中的模型优先显示；内置推荐只用于选择和连接，连接后仍需能力验证与明确分配。"
                : "以下是内置推荐连接，不是你的账户目录；连接并同步真实目录后，才会显示账户中的模型。"}
            </p>
            <ul className="model-routing-model-options__list">
              {candidates.map((candidate) => {
                const connected = candidate.source === "connected";
                const modelId = connected
                  ? candidate.entry.providerModelId
                  : candidate.entry.modelId;
                const support = connected ? null : candidate.entry.appSupport;
                const connectedRecommendation = connected
                  ? (recommendConnectedModelsForTask(task, routingVisibility.models).find(
                      ({ model }) => model.catalogEntry.id === candidate.entry.id,
                    ) ?? null)
                  : null;
                return (
                  <li
                    key={
                      connected
                        ? `connected:${candidate.entry.id}`
                        : `${candidate.source}:${candidate.providerKind}:${modelId ?? candidate.entry.displayName}`
                    }
                  >
                    <div>
                      <strong>{candidate.entry.displayName}</strong>
                      <small>
                        {getModelProviderPreset(candidate.providerKind).displayName} ·{" "}
                        {connected
                          ? connectedModelRegionLabel(candidate.providerKind)
                          : selectableModelRegionLabel(candidate.entry.regionGroup)}
                        {" · "}
                        {connected
                          ? connectedRecommendation?.readiness === "ready"
                            ? "已连接且具备本任务所需证据"
                            : "已连接；分配前仍需完成能力验证"
                          : selectableModelSupportLabel(candidate.entry.appSupport)}
                        {!connected && candidate.entry.lifecycle === "preview" ? " · 预览型号" : ""}
                      </small>
                    </div>
                    {connected ? (
                      taskProjection?.route === null ? (
                        task === "rerank" ? (
                          <a
                            className="button-link button-link--secondary"
                            href="#expert-model-routing"
                          >
                            确认素材隐私后分配
                          </a>
                        ) : (
                          <Button
                            variant="secondary"
                            loading={recommendedTaskBusy === task}
                            disabled={
                              routeProbeResultAmbiguous ||
                              recommendedTaskBusy !== null ||
                              routeSaving ||
                              taskProbeConfirmation !== null ||
                              modelHubHydrationPending
                            }
                            onClick={() => {
                              if (connectedRecommendation !== null) {
                                void requestRecommendedTaskAssignment(
                                  task,
                                  connectedRecommendation,
                                );
                              }
                            }}
                          >
                            {routeProbeResultAmbiguous
                              ? "结果待核对"
                              : connectedRecommendation?.readiness === "ready"
                                ? "用于此任务"
                                : "查看验证说明"}
                          </Button>
                        )
                      ) : (
                        <Badge tone="success">账户目录 · 保留当前分工</Badge>
                      )
                    ) : support === "routable_after_verification" && modelId !== null ? (
                      <Button
                        variant="secondary"
                        disabled={modelHubHydrationPending || routeSaving}
                        onClick={() => beginModelHubConnectionIntent(task, candidate.entry)}
                      >
                        选择并连接
                      </Button>
                    ) : (
                      <Badge tone="neutral">暂不可直接连接</Badge>
                    )}
                    {!connected && expertMode && "officialSource" in candidate.entry && (
                      <a
                        className="back-link"
                        href={candidate.entry.officialSource.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看供应商证据
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </details>
    );
  }

  function selectCatalogBrowserModel(selection: ModelHubSelectableCatalogSelection): void {
    if (selection.source === "connected") {
      const catalogEntry = routingCatalog.find(({ id }) => id === selection.model.catalogEntryId);
      const connection =
        catalogEntry === undefined
          ? undefined
          : hubConnections.find(({ id }) => id === catalogEntry.connectionId);
      if (catalogEntry === undefined || connection === undefined) {
        setRouteError(new Error("所选账户模型已经变化，请刷新目录后重试。"));
        return;
      }
      setModelHubMutationNotice({
        message: `已选择 ${catalogEntry.displayName}。请在任务清单中明确选择“用于此任务”；当前 AI 分工没有修改。`,
        reloadRequired: false,
      });
      void navigate("/settings#model-center");
      void selectStoredProfile(connection.id, catalogEntry.providerModelId);
      return;
    }

    const candidate = selection.model;
    if (candidate.appSupport === "protocol_not_implemented") {
      setModelHubMutationNotice({
        message: `${candidate.displayName} 可在目录中浏览，但墨影当前尚未实现它所需的调用协议，因此不会把它标记为可用。`,
        reloadRequired: false,
      });
      return;
    }
    if (candidate.appSupport === "special_connection_required") {
      setModelHubMutationNotice({
        message: `${candidate.displayName} 需要专用连接方式；当前通用供应商预设不会冒充该连接。`,
        reloadRequired: false,
      });
      return;
    }
    applyProviderPreset(candidate.providerKind);
    if (candidate.modelId !== null) setSelectedModel(candidate.modelId);
    setModelHubMutationNotice({
      message:
        candidate.modelId === null
          ? `请先连接 ${candidate.displayName} 对应的供应商，再从账户真实目录发现模型标识。`
          : `准备连接 ${candidate.displayName}；连接、目录同步和能力验证完成前，它不会参与 AI 分工。`,
      reloadRequired: false,
    });
    void navigate("/settings#model-center");
  }

  const directSettingsProjection = projectDirectSettingsPage(writingExperience);
  if (directSettingsProjection !== null) return directSettingsProjection;

  return (
    <div
      className={`desktop-page settings-page ${isModelHubView ? "settings-page--model-hub" : "settings-page--global"}`}
    >
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">
            {isModelHubView ? "AI 连接与分工" : "写作、数据与隐私"}
          </p>
          <h1>{modelHubPageMeta?.title ?? "全局设置"}</h1>
          <p>
            {modelHubPageMeta?.description ??
              "调整外观、本地数据、同步安全和维护方式；这些设置不会改变作品正文。"}
          </p>
        </div>
        <div className="page-heading__actions">
          <Badge tone={isModelHubView ? "info" : "success"}>
            {isModelHubView ? (expertMode ? "专家模式" : "普通模式") : "本地优先"}
          </Badge>
          {isModelHubView && (
            <Button
              variant="secondary"
              aria-expanded={expertMode}
              aria-controls="model-hub-expert-settings"
              onClick={() => {
                if (expertMode) setPaidEvaluationExpanded(false);
                setExpertMode((current) => !current);
              }}
            >
              {expertMode ? "收起专家设置" : "专家设置"}
            </Button>
          )}
        </div>
      </header>

      {isModelHubView ? (
        <nav className="model-hub-section-nav" aria-label="模型中心分区">
          {MODEL_HUB_SECTION_IDS.map((sectionId) => {
            const active = sectionId === activeModelHubSection;
            return (
              <Link
                key={sectionId}
                className="model-hub-section-nav__link"
                data-active={active}
                aria-current={active ? "page" : undefined}
                to={`/settings#${sectionId}`}
              >
                {MODEL_HUB_SECTION_META[sectionId].navigationLabel}
              </Link>
            );
          })}
        </nav>
      ) : (
        <nav className="settings-actions settings-section-nav" aria-label="全局设置分区">
          <Link className="button-link button-link--secondary" to="/settings#appearance">
            外观
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#writing-preferences">
            正文与自动保存
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#writing-experience">
            写作体验
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#data-privacy">
            数据与隐私
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#ai-memory">
            AI 记忆
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#model-center">
            打开模型中心
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#sync-security">
            同步安全
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#local-maintenance">
            本地维护
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#secure-updates">
            安全更新
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#diagnostics">
            诊断
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#data-transfer">
            导入与导出
          </Link>
        </nav>
      )}

      {isModelHubView && connectionIntent !== null && (
        <div className="model-hub-connection-intent" role="status">
          <InlineAlert
            tone="info"
            title={
              connectionIntentCatalogEntry === null
                ? `正在为“${novelAiTaskLabel(connectionIntent.task)}”连接模型`
                : connectionIntentTaskRecommendation === null
                  ? "所选模型已发现，仍需验证能力"
                  : connectionIntentTaskRecommendation.readiness === "ready"
                    ? "所选模型已验证，可以返回任务"
                    : "基础能力已验证，可以返回任务继续验证"
            }
            description={
              connectionIntentCatalogEntry === null
                ? `目标：${connectionIntent.providerModelId}。请保存连接、同步账户目录并验证能力；在你明确分配前，原有 AI 分工不会改变。`
                : connectionIntentTaskRecommendation === null
                  ? `${connectionIntentCatalogEntry.displayName} 已出现在账户目录中，但“${novelAiTaskLabel(connectionIntent.task)}”所需能力还没有可信证据。请在模型中心专家设置中补充或验证这项能力；系统不会自动返回或修改路由。`
                  : connectionIntentTaskRecommendation.readiness === "ready"
                    ? `${connectionIntentCatalogEntry.displayName} 已具备“${novelAiTaskLabel(connectionIntent.task)}”所需的可信能力证据。返回后仍需明确点击“用于此任务”，系统不会自动覆盖原路由。`
                    : `${connectionIntentCatalogEntry.displayName} 已具备文本生成证据。返回任务后，点击“查看验证说明”，明确确认固定探针的连接、模型、发送范围、隐私与费用信息后再验证和分配；系统不会自动发送或修改路由。`
            }
          />
          <div className="settings-actions">
            <Link
              className="button-link button-link--secondary"
              to={
                connectionIntentCatalogEntry === null || connectionIntentTaskRecommendation === null
                  ? "/settings#model-center"
                  : "/settings#model-routing"
              }
            >
              {connectionIntentCatalogEntry === null
                ? "继续连接"
                : connectionIntentTaskRecommendation === null
                  ? "验证能力"
                  : connectionIntentTaskRecommendation.readiness === "ready"
                    ? "返回任务并分配"
                    : "返回任务后查看验证说明"}
            </Link>
            <Button variant="ghost" onClick={cancelModelHubConnectionIntent}>
              取消选择
            </Button>
          </div>
        </div>
      )}

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前处于离线状态"
          description="本地项目、数据检查、备份与回环地址上的 Ollama 仍可使用；远程模型能力暂不可用。"
        />
      )}

      <div className="settings-grid">
        {!isModelHubView && (
          <>
            <Card id="appearance">
              <CardHeader>
                <CardTitle headingLevel={2}>外观</CardTitle>
                <CardDescription>选择舒适的阅读与写作界面，不会改变作品内容。</CardDescription>
              </CardHeader>
              <CardContent>
                <FormField label="外观模式" hint="跟随系统时，电脑的浅色或深色外观变化会立即同步。">
                  {(fieldProps) => (
                    <Select
                      {...fieldProps}
                      value={appearance}
                      options={[
                        { value: "system", label: "跟随系统" },
                        { value: "light", label: "浅色" },
                        { value: "dark", label: "深色" },
                      ]}
                      onChange={(event) => {
                        const selected = event.currentTarget.value;
                        if (selected === "system" || selected === "light" || selected === "dark") {
                          setAppearance(selected);
                        }
                      }}
                    />
                  )}
                </FormField>
                <InlineAlert
                  tone="info"
                  title="当前显示"
                  description={
                    appearance === "system"
                      ? `正在跟随系统，当前为${resolvedSurface === "dark" ? "深色" : "浅色"}。`
                      : appearance === "dark"
                        ? "当前固定为深色。"
                        : "当前固定为浅色。"
                  }
                />
              </CardContent>
            </Card>

            <Card id="writing-preferences" className="settings-card--wide">
              <CardHeader>
                <CardTitle headingLevel={2}>正文阅读与自动保存</CardTitle>
                <CardDescription>
                  调整只影响编辑器显示和保存节奏；已打开的正文会立即应用新的阅读设置。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="settings-inline-grid settings-inline-grid--four">
                  <FormField label="正文字体" hint="衬线字体更接近纸书，无衬线字体更清爽。">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={editorTypography.fontFamily}
                        options={[
                          { value: "serif", label: "衬线" },
                          { value: "sans", label: "无衬线" },
                          { value: "mono", label: "等宽" },
                        ]}
                        onChange={(event) => {
                          const selected = event.currentTarget.value;
                          if (selected === "serif" || selected === "sans" || selected === "mono") {
                            updateEditorTypography({
                              ...editorTypography,
                              fontFamily: selected satisfies EditorFontFamily,
                            });
                          }
                        }}
                      />
                    )}
                  </FormField>

                  <FormField label="字号" hint="默认 16 像素，适合长时间写作。">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={String(editorTypography.fontSize)}
                        options={[
                          { value: "16", label: "16 像素" },
                          { value: "17", label: "17 像素" },
                          { value: "18", label: "18 像素" },
                          { value: "20", label: "20 像素" },
                          { value: "22", label: "22 像素" },
                        ]}
                        onChange={(event) => {
                          const selected = Number(event.currentTarget.value);
                          if ([16, 17, 18, 20, 22].includes(selected)) {
                            updateEditorTypography({ ...editorTypography, fontSize: selected });
                          }
                        }}
                      />
                    )}
                  </FormField>

                  <FormField label="行距" hint="默认 1.75 倍，减少长段落的阅读疲劳。">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={String(editorTypography.lineHeight)}
                        options={[
                          { value: "1.6", label: "紧凑 · 1.6" },
                          { value: "1.75", label: "舒适 · 1.75" },
                          { value: "1.95", label: "宽松 · 1.95" },
                          { value: "2.2", label: "超宽 · 2.2" },
                        ]}
                        onChange={(event) => {
                          const selected = Number(event.currentTarget.value);
                          if ([1.6, 1.75, 1.95, 2.2].includes(selected)) {
                            updateEditorTypography({ ...editorTypography, lineHeight: selected });
                          }
                        }}
                      />
                    )}
                  </FormField>

                  <FormField label="正文宽度" hint="舒适宽度约 720 像素，适合连续阅读。">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={editorTypography.measure}
                        options={[
                          { value: "narrow", label: "窄" },
                          { value: "comfortable", label: "舒适" },
                          { value: "wide", label: "宽" },
                        ]}
                        onChange={(event) => {
                          const selected = event.currentTarget.value;
                          if (
                            selected === "narrow" ||
                            selected === "comfortable" ||
                            selected === "wide"
                          ) {
                            updateEditorTypography({
                              ...editorTypography,
                              measure: selected satisfies EditorMeasure,
                            });
                          }
                        }}
                      />
                    )}
                  </FormField>
                </div>

                <div className="settings-preference-row">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      aria-label="自动保存正式版本"
                      checked={editorPreferences.autosaveEnabled}
                      onChange={(event) =>
                        updateEditorPreferences({
                          ...editorPreferences,
                          autosaveEnabled: event.currentTarget.checked,
                        })
                      }
                    />
                    <span>
                      <strong>自动保存正式版本</strong>
                      <small>
                        关闭后仍会保留快速恢复草稿；切换章节或离开编辑器时仍会做一次安全保存。
                      </small>
                    </span>
                  </label>

                  <FormField label="自动保存等待时间" hint="停止输入后再保存，避免连续打断写作。">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        disabled={!editorPreferences.autosaveEnabled}
                        value={String(editorPreferences.autosaveDebounceMs)}
                        options={[
                          { value: "750", label: "0.75 秒" },
                          { value: "1000", label: "1 秒（推荐）" },
                          { value: "1500", label: "1.5 秒" },
                          { value: "2000", label: "2 秒" },
                        ]}
                        onChange={(event) => {
                          const selected = Number(event.currentTarget.value);
                          if ([750, 1000, 1500, 2000].includes(selected)) {
                            updateEditorPreferences({
                              ...editorPreferences,
                              autosaveDebounceMs: selected,
                            });
                          }
                        }}
                      />
                    )}
                  </FormField>
                </div>

                {writingPreferenceError !== null && (
                  <InlineAlert
                    tone="error"
                    title="设置没有保存"
                    description={writingPreferenceError}
                  />
                )}
              </CardContent>
            </Card>

            <Card id="writing-experience" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>写作体验</CardTitle>
                    <CardDescription>
                      只改变下一次写作操作的交互方式；不会调用模型，也不会修改正文、候选、版本、路由或任务。
                    </CardDescription>
                  </div>
                  <Badge tone="neutral">
                    {writingExperience.preference?.mode === "direct"
                      ? "直接模式"
                      : writingExperience.preference?.mode === "professional"
                        ? "专业模式"
                        : "正在读取"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <FormField
                  label="默认写作方式"
                  hint="生成中切换只影响下一次操作；备份恢复后仍保留这个选择。"
                >
                  {(fieldProps) => (
                    <Select
                      {...fieldProps}
                      value={writingExperience.preference?.mode ?? ""}
                      placeholder="正在读取本机设置"
                      disabled={
                        writingExperience.loading ||
                        writingExperience.switching ||
                        writingExperience.preference === null
                      }
                      options={[
                        { value: "direct", label: "直接写作" },
                        { value: "professional", label: "专业创作" },
                      ]}
                      onChange={(event) => {
                        const mode = event.currentTarget.value;
                        if (
                          mode === "direct" &&
                          writingExperience.preference?.directLocalOrganizationAuthorizedAt === null
                        ) {
                          setDirectAuthorizationOpen(true);
                        } else if (mode === "direct" || mode === "professional") {
                          void writingExperience.switchMode(mode);
                        }
                      }}
                    />
                  )}
                </FormField>
                <InlineAlert
                  tone="info"
                  title={writingExperience.preference?.mode === "direct" ? "直接写作" : "专业创作"}
                  description={
                    writingExperience.preference?.mode === "direct"
                      ? "续写会先持久化为隔离的 AI 建议草稿；只有你明确选择使用后，才会写入正文并创建不可变版本。本地整理授权不允许自动接受正文。"
                      : "所有 AI 建议保持隔离，明确点击“使用这版”后才写入正文并创建不可变版本。"
                  }
                />
                {writingExperience.preference?.directLocalOrganizationAuthorizedAt !== undefined &&
                  writingExperience.preference.directLocalOrganizationAuthorizedAt !== null && (
                    <div className="settings-actions">
                      <Button
                        variant="secondary"
                        loading={writingExperience.switching}
                        onClick={() => void writingExperience.revokeDirectModeAuthorization()}
                      >
                        撤销本地整理授权
                      </Button>
                    </div>
                  )}
                {writingExperience.error !== null && (
                  <InlineAlert
                    tone="error"
                    title="写作体验设置没有保存"
                    description={writingExperience.error}
                  />
                )}
              </CardContent>
            </Card>

            <Card id="data-privacy">
              <CardHeader>
                <CardTitle headingLevel={2}>数据与隐私</CardTitle>
                <CardDescription>核心写作能力不要求登录，也不依赖云端账户。</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="privacy-list">
                  <li>项目、章节、恢复草稿与版本默认存储在当前设备。</li>
                  <li>候选内容在明确接受前不会写入正式正文。</li>
                  <li>浏览器开发模式仅用于本地调试，不代表桌面生产数据层。</li>
                  <li>模型密钥不写入项目数据库、浏览器调试存储、日志或通知。</li>
                </ul>
              </CardContent>
            </Card>

            <Card id="ai-memory" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>项目 AI 记忆</CardTitle>
                    <CardDescription>
                      查看并清空某一个本地项目的 AI 记忆。这里永远不会跨项目清空数据库。
                    </CardDescription>
                  </div>
                  <Badge tone="neutral">按项目治理</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="maintenance-settings">
                  {memoryProjects.length === 0 ? (
                    <InlineAlert
                      tone="info"
                      title="还没有可治理的本地项目"
                      description="请先创建一个项目；墨影不会在没有项目范围时执行清空。"
                    />
                  ) : (
                    <>
                      <FormField
                        label="选择项目"
                        hint="包括进行中和已归档项目；不会显示回收站，也不会选择全部项目。"
                        required
                      >
                        {(fieldProps) => (
                          <Select
                            {...fieldProps}
                            value={selectedMemoryProjectId}
                            options={memoryProjects.map((project) => ({
                              value: project.id,
                              label: `${project.name}${project.status === "archived" ? "（已归档）" : ""}`,
                            }))}
                            disabled={memoryGovernanceLoading || memoryGovernanceBusy}
                            onChange={(event) =>
                              void selectMemoryProject(event.currentTarget.value)
                            }
                          />
                        )}
                      </FormField>

                      <InlineAlert
                        tone="info"
                        title={
                          memoryGovernanceLoading
                            ? "正在读取项目记忆"
                            : `当前有 ${String(activeProjectMemoryCount)} 条可用记忆`
                        }
                        description={
                          selectedMemoryPolicy?.automaticLearningEnabled === true
                            ? "自动学习当前已开启。清空时会在同一事务中关闭自动学习，并排除该项目的全部记忆。"
                            : "自动学习当前已关闭。已经忘掉的记录仍作为审计证据保留，不会参与后续上下文。"
                        }
                      />
                    </>
                  )}

                  {normalizedMemoryGovernanceError !== null && (
                    <InlineAlert
                      tone="error"
                      title={normalizedMemoryGovernanceError.title}
                      description={`${normalizedMemoryGovernanceError.description} 请重新核对当前项目后再试。`}
                    />
                  )}
                  {memoryClearMessage !== null && (
                    <InlineAlert
                      tone="info"
                      title="项目 AI 记忆已清空"
                      description={memoryClearMessage}
                    />
                  )}

                  <ul className="privacy-list">
                    <li>清空只作用于上方明确选择的项目，不会触碰其他项目或正式正文。</li>
                    <li>记忆不会物理删除：来源、操作前后快照和审计事件都会保留。</li>
                    <li>任一记录或策略在确认后发生变化，整个操作会回滚并要求重新确认。</li>
                  </ul>
                  <div className="settings-actions">
                    <Button
                      variant="danger"
                      disabled={
                        selectedMemoryProject === null ||
                        selectedMemoryPolicy === null ||
                        memoryGovernanceLoading ||
                        memoryGovernanceBusy ||
                        !projectMemoryCanBeCleared
                      }
                      onClick={openProjectMemoryClearDialog}
                    >
                      清空该项目全部 AI 记忆
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {isModelHubView && (
          <>
            {activeModelHubSection === "model-center" && (
              <Card id="model-center" className="settings-card--wide">
                <CardHeader>
                  <div className="card-heading-row">
                    <div>
                      <CardTitle headingLevel={2}>墨影模型中心</CardTitle>
                      <CardDescription>
                        连接供应商、测试连接并发现模型。普通模式只显示开始写作真正需要的选项。
                      </CardDescription>
                    </div>
                    {modelHubHydrationPending ? (
                      <Badge tone="info">
                        {modelHubHydrationPhaseLabel(modelHubPageSnapshot.phase)}
                      </Badge>
                    ) : (
                      <SaveStatus
                        state={saving ? "saving" : hubConnection === null ? "clean" : "saved_local"}
                        labels={{
                          clean: "配置未保存",
                          saved_local: `配置修订 ${String(hubConnection?.revision ?? 0)}`,
                        }}
                      />
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {editorReturnRoute !== null && (
                    <>
                      <InlineAlert
                        tone="info"
                        title="正在修复本章的 AI 设置"
                        description="已定位到这次生成所需的连接或模型字段；返回时会恢复原章节、滚动位置和光标。"
                      />
                      <div className="settings-actions">
                        <Link className="button-link button-link--secondary" to={editorReturnRoute}>
                          返回原章节
                        </Link>
                      </div>
                    </>
                  )}
                  {showModelHubOnboarding && !hasRetirementResult ? (
                    <section
                      className="model-hub-readiness model-hub-onboarding"
                      aria-labelledby="model-hub-onboarding-title"
                    >
                      <p className="page-heading__eyebrow">首次使用</p>
                      <h3 id="model-hub-onboarding-title">需要 AI 时，再连接一个模型服务</h3>
                      <p>
                        墨影没有检测到已连接服务或本地凭据。你可以连接
                        DeepSeek、通义千问、OpenAI、Claude、Gemini 或 Ollama；不连接 AI
                        也可以继续手动写作。
                      </p>
                      <div className="settings-actions">
                        <Button onClick={() => setConnectionSetupExpanded(true)}>
                          连接 AI 服务
                        </Button>
                        <Link className="button-link button-link--secondary" to="/start">
                          稍后再说
                        </Link>
                      </div>
                    </section>
                  ) : (
                    <div className="model-center-settings">
                      <section
                        className="model-hub-readiness"
                        aria-labelledby="model-hub-status-title"
                      >
                        <div className="model-hub-readiness__heading">
                          <div>
                            <p className="page-heading__eyebrow">当前 AI 状态</p>
                            <h3 id="model-hub-status-title">{modelHubReadiness.label}</h3>
                          </div>
                          <Badge tone={modelHubReadiness.tone}>当前</Badge>
                        </div>
                        <p>{modelHubReadiness.description}</p>
                        <div className="model-hub-readiness__metrics" aria-label="AI 基础配置情况">
                          <span>
                            可用连接 <strong>{modelHubReadiness.usableConnectionCount}</strong>
                          </span>
                          <span>
                            基础配置检查 <strong>{modelHubReadiness.runnableCoreTaskCount}</strong>{" "}
                            / {modelHubReadiness.totalCoreTaskCount}
                          </span>
                        </div>
                        {modelHubReadiness.missingCoreTasks.length > 0 &&
                          modelHubReadiness.usableConnectionCount > 0 && (
                            <p className="model-hub-readiness__missing">
                              尚未通过基础配置检查：
                              {modelHubReadiness.missingCoreTasks
                                .slice(0, 4)
                                .map(novelAiTaskLabel)
                                .join("、")}
                              {modelHubReadiness.missingCoreTasks.length > 4 ? "等" : ""}。
                            </p>
                          )}
                        {modelHubReadiness.exactBlockers.length > 0 && (
                          <InlineAlert
                            tone="warning"
                            title={`${novelAiTaskLabel(modelHubReadiness.exactBlockers[0]?.task ?? "continuation")}尚未通过基础配置检查`}
                            description={`${modelHubReadinessBlockerLabel(modelHubReadiness.exactBlockers[0]?.code ?? "MODEL_HUB_PREFLIGHT_FAILED")}。这里没有读取或发送作品内容；请在“连接与模型”中修复后重新验证。当前章节仍会在真正发送前单独检查隐私、上下文与请求长度；作品正文、不可变版本和隔离建议均未改变。`}
                          />
                        )}
                        {manageableHubConnections.length > 0 && (
                          <ul className="model-hub-connection-summary" aria-label="当前 AI 连接">
                            {manageableHubConnections.map((candidate) => (
                              <li key={candidate.id}>
                                <span>
                                  <strong>{candidate.displayName}</strong>
                                  <small>{connectionEndpointLabel(candidate.baseUrl)}</small>
                                </span>
                                <Badge
                                  tone={
                                    candidate.connectionStatus === "ready"
                                      ? "success"
                                      : candidate.connectionStatus === "error"
                                        ? "danger"
                                        : candidate.connectionStatus === "degraded"
                                          ? "warning"
                                          : "neutral"
                                  }
                                >
                                  {connectionManagementLabel(candidate)}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                        {retiredHubConnections.length > 0 && (
                          <details>
                            <summary>
                              已退役连接历史（{String(retiredHubConnections.length)}）
                            </summary>
                            <p>这些记录只用于调用审计，不再参与选择、推荐或 AI 分工。</p>
                            <ul
                              className="model-hub-connection-summary"
                              aria-label="已退役连接历史"
                            >
                              {retiredHubConnections.map((candidate) => (
                                <li key={candidate.id}>
                                  <span>
                                    <strong>{candidate.displayName}</strong>
                                    <small>{connectionEndpointLabel(candidate.baseUrl)}</small>
                                  </span>
                                  <Badge tone="neutral">已退役</Badge>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <details>
                          <summary>了解全部 7 种 AI 状态</summary>
                          <ul className="model-hub-state-legend" aria-label="AI 状态说明">
                            {USER_FACING_MODEL_HUB_STATES.map((state) => (
                              <li key={state} data-current={state === modelHubReadiness.state}>
                                <strong>{MODEL_HUB_STATE_EXPLANATIONS[state].label}</strong>
                                <span>{MODEL_HUB_STATE_EXPLANATIONS[state].description}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </section>

                      {normalizedCredentialError !== null && (
                        <InlineAlert
                          tone="error"
                          title={normalizedCredentialError.title}
                          description={normalizedCredentialError.description}
                        />
                      )}

                      {normalizedCredentialError === null &&
                        normalizedModelHubPageError !== null && (
                          <InlineAlert
                            tone={
                              modelHubPageSnapshot.catalogStatus === "cached_warning"
                                ? "warning"
                                : "error"
                            }
                            title={
                              modelHubPageSnapshot.catalogStatus === "cached_warning"
                                ? "模型目录重新检查未完成"
                                : "模型中心状态没有完整载入"
                            }
                            description={`${
                              modelHubPageSnapshot.catalogStatus === "cached_warning"
                                ? `重新检查失败，已保留 ${String(modelHubPageSnapshot.catalogEntries.length)} 个缓存模型。`
                                : "连接、模型目录或 AI 分工暂时无法读取。"
                            } ${normalizedModelHubPageError.description}`}
                          />
                        )}

                      {modelHubMutationNotice !== null && (
                        <>
                          <InlineAlert
                            tone={modelHubMutationNotice.reloadRequired ? "warning" : "info"}
                            title={
                              modelHubMutationNotice.reloadRequired
                                ? "更改已保存，页面状态需要刷新"
                                : "模型选择提示"
                            }
                            description={modelHubMutationNotice.message}
                          />
                          {modelHubMutationNotice.reloadRequired && (
                            <div className="settings-actions">
                              <Button
                                variant="secondary"
                                disabled={modelHubHydrationPending || saving || checkingModel}
                                onClick={() => void loadModelCenter({ action: "refresh_snapshot" })}
                              >
                                刷新模型中心状态
                              </Button>
                            </div>
                          )}
                        </>
                      )}

                      {retirementMessage !== null && (
                        <InlineAlert
                          tone="info"
                          title="连接已退役"
                          description={retirementMessage}
                        />
                      )}

                      {credentialDeletedConnection !== null && (
                        <InlineAlert
                          tone="warning"
                          title="凭据已删除，可重新绑定"
                          description={`“${credentialDeletedConnection.displayName}”仍保留模型目录和历史调用，但不会参与 AI 分工。输入新的接口密钥并选择“重新绑定原连接”，无需修改配置标识；也可选择“退役连接”后建立一条新连接。`}
                        />
                      )}

                      {runtime.mode === "browser-development" && (
                        <InlineAlert
                          tone="warning"
                          title="浏览器开发模式不连接模型"
                          description="可查看和填写非敏感配置，但需要密钥的连接只能在墨影桌面应用中保存、测试和验证；这里不会接收密钥、访问端点或伪造模型目录。"
                        />
                      )}

                      <div className="settings-actions">
                        {providerPreset !== "custom_openai_compatible" && (
                          <Button
                            variant="secondary"
                            disabled={loading || saving || checkingModel || probingCapability}
                            onClick={restoreProviderConnectionDefaults}
                          >
                            恢复供应商默认配置
                          </Button>
                        )}
                        {hubConnection !== null &&
                          hubConnection.id === providerId &&
                          hubConnection.providerKind === providerPreset &&
                          (!isRetiredModelProviderConnection(hubConnection) ||
                            summary.configured) && (
                            <Button
                              variant="danger"
                              disabled={
                                loading ||
                                saving ||
                                checkingModel ||
                                probingCapability ||
                                retiringConnection
                              }
                              onClick={() => setRetireConnectionTarget(hubConnection)}
                            >
                              退役连接
                            </Button>
                          )}
                      </div>

                      <section aria-labelledby="provider-choice-title">
                        <h3 id="provider-choice-title">1. 连接供应商</h3>
                        <p>选择供应商后只填写必要信息；模型列表和能力证据会在连接测试后更新。</p>
                        <div className="model-center-grid">
                          <FormField label="供应商" required>
                            {(fieldProps) => (
                              <Select
                                {...fieldProps}
                                value={providerPreset}
                                options={CONNECTABLE_PROVIDER_KINDS.map((kind) => {
                                  const preset = getModelProviderPreset(kind);
                                  return { value: kind, label: preset.displayName };
                                })}
                                disabled={loading || saving || checkingModel || probingCapability}
                                onChange={(event) =>
                                  applyProviderPreset(
                                    event.currentTarget.value as ConnectableProviderKind,
                                  )
                                }
                              />
                            )}
                          </FormField>
                          {manageableHubConnections.length > 0 && (
                            <FormField label="已连接的供应商">
                              {(fieldProps) => (
                                <Select
                                  {...fieldProps}
                                  value={hubConnection?.id ?? ""}
                                  placeholder="选择已有连接"
                                  options={manageableHubConnections.map((candidate) => ({
                                    value: candidate.id,
                                    label: `${candidate.displayName} · ${connectionManagementLabel(candidate)}`,
                                  }))}
                                  disabled={
                                    modelHubHydrationPending ||
                                    saving ||
                                    checkingModel ||
                                    probingCapability
                                  }
                                  onChange={(event) =>
                                    void selectStoredProfile(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                          )}
                          {providerPreset === "custom_openai_compatible" && (
                            <FormField
                              label="Base URL"
                              hint="自定义兼容接口必须提供地址；远程地址必须使用 HTTPS。"
                              required
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="url"
                                  value={baseUrl}
                                  maxLength={2048}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => {
                                    setBaseUrl(event.currentTarget.value);
                                    setConnection(null);
                                    setConnectionChecked(false);
                                  }}
                                />
                              )}
                            </FormField>
                          )}
                          {providerPreset === "alibaba_qwen" && (
                            <>
                              <FormField label="地域" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={region}
                                    options={qwenRegionOptions()}
                                    disabled={loading || saving || checkingModel}
                                    onChange={(event) => {
                                      const nextRegion = event.currentTarget.value;
                                      setRegion(nextRegion);
                                      setBaseUrl(resolveQwenBaseUrl(nextRegion, workspaceId));
                                      setConnection(null);
                                      setConnectionChecked(false);
                                    }}
                                  />
                                )}
                              </FormField>
                              {qwenRegionShowsWorkspace(region) && (
                                <FormField
                                  label="Workspace ID"
                                  hint={
                                    qwenRegionNeedsWorkspace(region)
                                      ? "日本和德国地域必须填写。"
                                      : region === "china_beijing"
                                        ? "北京地域可留空使用普通文本接口；如需使用已验证的官方文本重排协议，请填写 Workspace ID。"
                                        : "新加坡可留空使用共享端点；填写后使用专属 Workspace 端点。"
                                  }
                                  required={qwenRegionNeedsWorkspace(region)}
                                >
                                  {(fieldProps) => (
                                    <Input
                                      {...fieldProps}
                                      value={workspaceId}
                                      maxLength={256}
                                      disabled={loading || saving || checkingModel}
                                      onChange={(event) => {
                                        const nextWorkspaceId = event.currentTarget.value;
                                        setWorkspaceId(nextWorkspaceId);
                                        setBaseUrl(resolveQwenBaseUrl(region, nextWorkspaceId));
                                        setConnection(null);
                                        setConnectionChecked(false);
                                      }}
                                    />
                                  )}
                                </FormField>
                              )}
                            </>
                          )}
                          {providerPreset === "volcengine_doubao" && (
                            <FormField label="Endpoint ID" hint="仅专属推理接入点需要填写。">
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  value={endpointId}
                                  maxLength={512}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => setEndpointId(event.currentTarget.value)}
                                />
                              )}
                            </FormField>
                          )}
                        </div>
                      </section>

                      {expertMode && (
                        <section
                          id="model-hub-expert-settings"
                          aria-labelledby="model-connection-title"
                        >
                          <h3 id="model-connection-title">专家连接设置</h3>
                          {manageableHubConnections.length > 0 && (
                            <FormField label="已保存配置">
                              {(fieldProps) => (
                                <Select
                                  {...fieldProps}
                                  value={hubConnection?.id ?? ""}
                                  placeholder="选择已保存配置"
                                  options={manageableHubConnections.map((candidate) => ({
                                    value: candidate.id,
                                    label: `${candidate.id} · ${candidate.displayName} · ${connectionManagementLabel(candidate)}`,
                                  }))}
                                  disabled={
                                    modelHubHydrationPending ||
                                    saving ||
                                    checkingModel ||
                                    probingCapability
                                  }
                                  onChange={(event) =>
                                    void selectStoredProfile(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                          )}

                          <div className="model-center-grid">
                            <FormField label="协议" required>
                              {(fieldProps) => (
                                <Select
                                  {...fieldProps}
                                  value={gatewayProviderKind(providerPreset)}
                                  options={[
                                    {
                                      value: "open_ai_compatible",
                                      label: "OpenAI 兼容",
                                    },
                                    { value: "ollama", label: "Ollama" },
                                    { value: "anthropic", label: "Anthropic" },
                                    { value: "gemini", label: "Gemini" },
                                  ]}
                                  disabled
                                />
                              )}
                            </FormField>
                            <FormField
                              label="配置标识"
                              hint="只允许小写字母、数字、点、下划线和连字符。"
                              required
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  value={providerId}
                                  maxLength={128}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => {
                                    const nextProviderId = event.currentTarget.value;
                                    setProviderId(nextProviderId);
                                    if (nextProviderId !== hubConnection?.id) {
                                      setSummary({ configured: false, lastFour: null });
                                    }
                                    setProfile(null);
                                    setConnection(null);
                                  }}
                                />
                              )}
                            </FormField>
                            <FormField label="基础地址" required>
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="url"
                                  value={baseUrl}
                                  maxLength={2048}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => {
                                    setBaseUrl(event.currentTarget.value);
                                    setConnection(null);
                                  }}
                                />
                              )}
                            </FormField>
                            <FormField label="认证方式" required>
                              {(fieldProps) => (
                                <Select
                                  {...fieldProps}
                                  value={authentication}
                                  options={authenticationOptions(providerPreset)}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => {
                                    const nextAuthentication = event.currentTarget
                                      .value as NativeGatewayAuthenticationMode;
                                    setAuthentication(nextAuthentication);
                                    if (nextAuthentication !== "custom_header_keyring") {
                                      setCredentialHeaderName("");
                                    }
                                    setConnection(null);
                                    setConnectionChecked(false);
                                  }}
                                />
                              )}
                            </FormField>
                            {providerPreset === "custom_openai_compatible" && (
                              <>
                                <FormField
                                  label="模型目录路径"
                                  hint="留空使用 /models；必须是无查询参数的绝对路径。"
                                >
                                  {(fieldProps) => (
                                    <Input
                                      {...fieldProps}
                                      value={modelDiscoveryPath}
                                      placeholder="/models"
                                      maxLength={1024}
                                      disabled={loading || saving || checkingModel}
                                      onChange={(event) => {
                                        setModelDiscoveryPath(event.currentTarget.value);
                                        setConnection(null);
                                      }}
                                    />
                                  )}
                                </FormField>
                                <FormField label="文本生成路径" hint="留空使用 /chat/completions。">
                                  {(fieldProps) => (
                                    <Input
                                      {...fieldProps}
                                      value={textGenerationPath}
                                      placeholder="/chat/completions"
                                      maxLength={1024}
                                      disabled={loading || saving || checkingModel}
                                      onChange={(event) => {
                                        setTextGenerationPath(event.currentTarget.value);
                                        setConnection(null);
                                      }}
                                    />
                                  )}
                                </FormField>
                                <FormField label="向量检索路径" hint="留空使用 /embeddings。">
                                  {(fieldProps) => (
                                    <Input
                                      {...fieldProps}
                                      value={embeddingPath}
                                      placeholder="/embeddings"
                                      maxLength={1024}
                                      disabled={loading || saving || checkingModel}
                                      onChange={(event) => {
                                        setEmbeddingPath(event.currentTarget.value);
                                        setConnection(null);
                                      }}
                                    />
                                  )}
                                </FormField>
                                {authentication === "custom_header_keyring" && (
                                  <FormField
                                    label="认证请求头名称"
                                    hint="这里只保存名称；内容使用下方同一份系统凭据。"
                                    required
                                  >
                                    {(fieldProps) => (
                                      <Input
                                        {...fieldProps}
                                        value={credentialHeaderName}
                                        placeholder="x-api-key"
                                        maxLength={128}
                                        autoComplete="off"
                                        disabled={loading || saving || checkingModel}
                                        onChange={(event) => {
                                          setCredentialHeaderName(event.currentTarget.value);
                                          setConnection(null);
                                        }}
                                      />
                                    )}
                                  </FormField>
                                )}
                              </>
                            )}
                            <FormField
                              label="请求超时（毫秒）"
                              hint={`${String(MODEL_HUB_MIN_REQUEST_TIMEOUT_MS)}–${String(MODEL_HUB_MAX_REQUEST_TIMEOUT_MS)}；生成仅约束发出请求阶段，流式读取仍有独立空闲保护。`}
                              required
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="number"
                                  min={MODEL_HUB_MIN_REQUEST_TIMEOUT_MS}
                                  max={MODEL_HUB_MAX_REQUEST_TIMEOUT_MS}
                                  step={1000}
                                  value={requestTimeoutMs}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => {
                                    setRequestTimeoutMs(event.currentTarget.value);
                                    setConnection(null);
                                  }}
                                />
                              )}
                            </FormField>
                            <FormField
                              label="安全重试次数"
                              hint={`0–${String(MODEL_HUB_MAX_RETRY_LIMIT)}；只用于连接测试和模型目录 GET。`}
                              required
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="number"
                                  min={0}
                                  max={MODEL_HUB_MAX_RETRY_LIMIT}
                                  step={1}
                                  value={retryLimit}
                                  disabled={loading || saving || checkingModel}
                                  onChange={(event) => {
                                    setRetryLimit(event.currentTarget.value);
                                    setConnection(null);
                                  }}
                                />
                              )}
                            </FormField>
                          </div>
                          <InlineAlert
                            tone="info"
                            title="重试不会重复计费请求"
                            description="这里只会自动重试读取连接和模型目录。文本生成、向量检索、结果排序与图片生成一旦发送都不会自动重试，避免重复生成或重复计费。温度、采样概率、结构化输出与推理强度仍由任务预设管理。"
                          />
                          {providerPreset === "custom_openai_compatible" && (
                            <InlineAlert
                              tone="info"
                              title="当前只支持一个认证 Header"
                              description="Header 值只保存到系统凭据库。图片生成路径暂不支持自定义；图片任务仍使用经过验证的固定 /images/generations 路径。"
                            />
                          )}
                        </section>
                      )}

                      <section id="model-selection" aria-labelledby="model-selection-title">
                        <h3 id="model-selection-title">2. 测试连接并选择模型</h3>
                        {models.length > 0 ? (
                          <>
                            <FormField
                              label="模型"
                              hint={
                                modelHubPageSnapshot.catalogStatus === "cached_warning"
                                  ? `正在使用上次保存的 ${String(models.length)} 个模型；重新检查失败后没有清空目录。`
                                  : modelHubHydrationPending
                                    ? `${modelHubHydrationPhaseLabel(modelHubPageSnapshot.phase)} 已保存的模型仍可查看。`
                                    : `本次从端点读取 ${String(models.length)} 个模型。`
                              }
                              required
                            >
                              {(fieldProps) => (
                                <Select
                                  {...fieldProps}
                                  value={selectedModel}
                                  placeholder="选择模型"
                                  options={models.map((model) => ({
                                    value: model.id,
                                    label:
                                      model.sizeBytes === null || model.sizeBytes === undefined
                                        ? model.displayName
                                        : `${model.displayName} · ${formatBytes(model.sizeBytes)}`,
                                  }))}
                                  disabled={
                                    modelHubHydrationPending ||
                                    saving ||
                                    checkingModel ||
                                    probingCapability
                                  }
                                  onChange={(event) =>
                                    void selectCatalogModel(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                            {modelHubPageSnapshot.catalogStatus === "cached_warning" && (
                              <InlineAlert
                                tone="warning"
                                title="正在使用上次保存的模型目录"
                                description="本次重新检查没有完成，原有模型和选择已保留。你可以稍后再次测试连接。"
                              />
                            )}
                          </>
                        ) : modelHubHydrationPending ? (
                          <InlineAlert
                            tone="info"
                            title="正在恢复模型中心"
                            description={modelHubHydrationPhaseLabel(modelHubPageSnapshot.phase)}
                          />
                        ) : modelHubPageSnapshot.phase === "ERROR" ||
                          modelHubPageSnapshot.catalogStatus === "error" ? (
                          <InlineAlert
                            tone="error"
                            title="模型目录暂时无法读取"
                            description="已保存连接和密钥没有被清除。请重新加载模型中心；若仍失败，再检查本地数据库或供应商连接。"
                          />
                        ) : expertMode ||
                          !getModelProviderPreset(providerPreset).modelDiscovery.automatic ? (
                          <FormField
                            label={
                              providerPreset === "volcengine_doubao"
                                ? "模型或 Endpoint ID"
                                : "模型标识"
                            }
                            hint="该供应商不保证提供模型列表，请填写控制台显示的真实模型或接入点标识。"
                            required={
                              !getModelProviderPreset(providerPreset).modelDiscovery.automatic
                            }
                          >
                            {(fieldProps) => (
                              <Input
                                {...fieldProps}
                                value={selectedModel}
                                maxLength={512}
                                disabled={saving || checkingModel || probingCapability}
                                onChange={(event) => setSelectedModel(event.currentTarget.value)}
                              />
                            )}
                          </FormField>
                        ) : (
                          <InlineAlert
                            tone={connectionChecked ? "warning" : "info"}
                            title={connectionChecked ? "没有发现可用模型" : "还没有读取模型"}
                            description={
                              connectionChecked
                                ? "请检查密钥权限和供应商服务状态后重试；如供应商确实不提供模型目录，可在专家设置中手动填写模型标识。"
                                : provider === "ollama"
                                  ? "请先启动本机 Ollama，然后点击“测试连接并发现模型”。"
                                  : summary.configured
                                    ? "密钥已保存。点击“测试连接并发现模型”读取当前账号真正可用的模型。"
                                    : "先把接口密钥保存到系统凭据库，再测试连接；密钥不会写入普通数据库。"
                            }
                          />
                        )}
                      </section>

                      {expertMode && (
                        <section id="model-pricing" aria-labelledby="model-pricing-title">
                          <h3 id="model-pricing-title">计价信息</h3>
                          <InlineAlert
                            tone="info"
                            title="费用预估依据"
                            description="这些字段只用于整理资料、费用估算和预算，不是开始写作的必填项。不确定时可以留空；价格单位为每百万内容额度，供应商仍可能正常计费。"
                          />
                          <div className="model-center-grid">
                            <FormField
                              label="单次读取上限（内容额度）"
                              hint="模型一次可读取的最大内容额度。目录没有提供时可留空，墨影会使用保守默认长度；这里不是小说字数。"
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="number"
                                  min={1}
                                  max={100_000_000}
                                  step={1}
                                  value={contextWindowTokens}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) =>
                                    setContextWindowTokens(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                            <FormField
                              label="计价币种"
                              hint="只在填写价格时使用；三位大写代码，例如 USD。"
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  value={pricingCurrency}
                                  minLength={3}
                                  maxLength={3}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) =>
                                    setPricingCurrency(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                            <FormField
                              label="输入价 / 百万内容额度"
                              hint="从供应商价格页获取；不确定可留空。"
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="number"
                                  min={0}
                                  step="0.000001"
                                  value={inputPricePerMillion}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) =>
                                    setInputPricePerMillion(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                            <FormField
                              label="输出价 / 百万内容额度"
                              hint="从供应商价格页获取；不确定可留空。"
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="number"
                                  min={0}
                                  step="0.000001"
                                  value={outputPricePerMillion}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) =>
                                    setOutputPricePerMillion(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                            <FormField
                              label="缓存输入价 / 百万内容额度"
                              hint="供应商未区分时可留空。"
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="number"
                                  min={0}
                                  step="0.000001"
                                  value={cachedInputPricePerMillion}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) =>
                                    setCachedInputPricePerMillion(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                            <FormField
                              label="价格版本"
                              hint="仅在填写价格时使用，例如价格表-2026-07。"
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  value={pricingVersion}
                                  maxLength={128}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) => setPricingVersion(event.currentTarget.value)}
                                />
                              )}
                            </FormField>
                            <FormField label="价格更新时间" hint="仅在填写价格时使用。">
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="date"
                                  value={priceUpdatedDate}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) =>
                                    setPriceUpdatedDate(event.currentTarget.value)
                                  }
                                />
                              )}
                            </FormField>
                          </div>
                        </section>
                      )}

                      {expertMode && (
                        <section id="model-capabilities" aria-labelledby="model-capabilities-title">
                          <h3 id="model-capabilities-title">模型能力确认</h3>
                          <InlineAlert
                            tone="info"
                            title="只确认实际验证过的能力"
                            description="普通用户不需要勾选；能力由目录和真实探针验证。专家手动确认只影响路由选择，不代表墨影已经实际验证；语义向量、图片和工具调用都不是基础写作的前提。"
                          />
                          <div className="model-center-grid" role="group" aria-label="模型能力">
                            {MODEL_HUB_CAPABILITIES.map((capability) => (
                              <label key={capability} className="checkbox-row">
                                <input
                                  type="checkbox"
                                  checked={confirmedCapabilities.includes(capability)}
                                  disabled={selectedModel.trim().length === 0}
                                  onChange={(event) => {
                                    setConfirmedCapabilities((current) =>
                                      event.currentTarget.checked
                                        ? Object.freeze([...new Set([...current, capability])])
                                        : Object.freeze(
                                            current.filter((candidate) => candidate !== capability),
                                          ),
                                    );
                                  }}
                                />
                                <span>{modelHubCapabilityLabel(capability)}</span>
                              </label>
                            ))}
                          </div>
                        </section>
                      )}

                      {effectiveTextProbeModelId.length > 0 && runtime.modelGateway.available && (
                        <InlineAlert
                          tone="warning"
                          title="固定能力验证需要明确确认"
                          description={`点击“${automaticModelDiscovery ? "确认 1 次固定验证" : "确认 1 次固定验证并检查连接"}”将通过“${hubConnection?.displayName ?? getModelProviderPreset(providerPreset).displayName}”的“${effectiveTextProbeModelId}”发送固定短句“只回复：OK”，最多请求 64 个输出内容额度；本次最多调用 1 次，自动重试 0 次。${modelProbeDestinationDisclosure(providerPreset, { region, workspaceId, baseUrl })}不发送作品正文、灵感、设定或接口密钥；当前费用上限未知，供应商可能收取少量费用。测试输入和输出不会写入能力记录。`}
                        />
                      )}

                      {normalizedCapabilityProbeError !== null && (
                        <InlineAlert
                          tone={
                            normalizedCapabilityProbeError.code === "PROVIDER_RESULT_AMBIGUOUS"
                              ? "warning"
                              : "error"
                          }
                          title={
                            normalizedCapabilityProbeError.code === "PROVIDER_RESULT_AMBIGUOUS"
                              ? "写作能力验证结果待核对"
                              : "写作能力验证失败"
                          }
                          description={
                            normalizedCapabilityProbeError.code === "PROVIDER_RESULT_AMBIGUOUS"
                              ? `${normalizedCapabilityProbeError.description} 系统不会自动重发；连接和模型目录会保留。`
                              : `${normalizedCapabilityProbeError.description} 连接和模型目录会保留，修正模型或接入点后可以重试。`
                          }
                        />
                      )}

                      {capabilityProbeMessage !== null && (
                        <InlineAlert
                          tone="info"
                          title="写作能力已验证"
                          description={capabilityProbeMessage}
                        />
                      )}

                      <div className="settings-actions">
                        <Button
                          loading={saving}
                          disabled={!modelHubFormReadiness.save.enabled}
                          onClick={() => void saveModelProfile()}
                        >
                          保存供应商与模型
                        </Button>
                        <Button
                          variant="secondary"
                          loading={checkingModel}
                          disabled={!modelHubFormReadiness.discover.enabled}
                          onClick={() => void checkModelConnection()}
                        >
                          {automaticModelDiscovery
                            ? "测试连接并发现模型"
                            : "确认 1 次固定验证并检查连接"}
                        </Button>
                        {automaticModelDiscovery && (
                          <Button
                            variant="secondary"
                            loading={probingCapability}
                            disabled={!modelHubFormReadiness.verify.enabled}
                            onClick={() => void probeSelectedModelCapability()}
                          >
                            确认 1 次固定验证
                          </Button>
                        )}
                      </div>

                      {connection !== null && (
                        <InlineAlert
                          tone="info"
                          title={
                            getModelProviderPreset(providerPreset).modelDiscovery.automatic
                              ? "模型目录连接成功"
                              : "供应商连接成功"
                          }
                          description={`${connection.endpointOrigin} · ${String(connection.modelCount)} 个模型 · ${String(connection.latencyMs)} ms。${getModelProviderPreset(providerPreset).modelDiscovery.automatic ? "目录检查不会自动证明模型可生成正文，请按需继续验证写作能力。" : "已通过明确确认的固定短文本验证模型可生成文字。"}`}
                        />
                      )}

                      {connection !== null && providerPreset === "ollama" && (
                        <InlineAlert
                          tone={localCapacityAssessment.status === "warning" ? "warning" : "info"}
                          title="本地模型容量初步体检"
                          description={describeLocalModelCapacity(
                            localCapacityAssessment,
                            modelCapacity,
                          )}
                        />
                      )}

                      {(authentication === "bearer_keyring" ||
                        providerPreset === "custom_openai_compatible") &&
                        (runtime.mode === "browser-development" ? (
                          <InlineAlert
                            tone="warning"
                            title="浏览器开发模式不接受模型密钥"
                            description="请在桌面应用中配置。页面不会把密钥写入浏览器调试存储或模型配置表。"
                          />
                        ) : (
                          <div className="secret-settings">
                            <div className="card-heading-row">
                              <strong>系统凭据库</strong>
                              {modelHubPageSnapshot.credentialStatus === "checking" ||
                              modelHubHydrationPending ? (
                                <Badge tone="info">
                                  {modelHubHydrationPhaseLabel(modelHubPageSnapshot.phase)}
                                </Badge>
                              ) : modelHubPageSnapshot.credentialStatus === "error" ? (
                                <Badge tone="warning">系统凭据状态暂时无法确认</Badge>
                              ) : modelHubPageSnapshot.credentialStatus === "not_required" ? (
                                <Badge tone="neutral">此连接不需要密钥</Badge>
                              ) : (
                                <SaveStatus
                                  state={
                                    saving ? "saving" : summary.configured ? "saved_local" : "clean"
                                  }
                                  labels={{
                                    clean: "未配置",
                                    saved_local: `已配置 ····${summary.lastFour ?? ""}`,
                                  }}
                                />
                              )}
                            </div>
                            <FormField
                              label={
                                authentication === "custom_header_keyring"
                                  ? "认证请求头内容"
                                  : "接口密钥"
                              }
                              hint="保存后仅显示末四位；页面不会再次读取完整密钥，也不会写入配置数据库或日志。"
                              required={authentication !== "none"}
                            >
                              {(fieldProps) => (
                                <Input
                                  {...fieldProps}
                                  type="password"
                                  revealable
                                  revealLabel="显示接口访问密钥"
                                  concealLabel="隐藏接口访问密钥"
                                  autoComplete="off"
                                  value={secret}
                                  placeholder={
                                    modelHubHydrationPending
                                      ? "正在检查已保存凭据"
                                      : summary.configured
                                        ? "留空继续使用已保存凭据"
                                        : "输入新的接口密钥"
                                  }
                                  disabled={
                                    modelHubHydrationPending ||
                                    saving ||
                                    checkingModel ||
                                    probingCapability
                                  }
                                  onChange={(event) => {
                                    credentialEditRevisionRef.current += 1;
                                    setSecret(event.currentTarget.value);
                                  }}
                                />
                              )}
                            </FormField>
                            <div className="settings-actions">
                              <Button
                                loading={saving}
                                disabled={probingCapability || secret.trim().length < 8}
                                onClick={() => void saveSecret()}
                              >
                                {credentialDeletedConnection === null
                                  ? "保存到系统凭据库"
                                  : "重新绑定原连接"}
                              </Button>
                              {summary.configured &&
                                hubConnection?.id === providerId &&
                                hubConnection.providerKind === providerPreset && (
                                  <Button
                                    variant="danger"
                                    loading={saving}
                                    disabled={probingCapability}
                                    onClick={() => void deleteSecret()}
                                  >
                                    删除密钥
                                  </Button>
                                )}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}

                  {normalizedRouteError !== null && (
                    <InlineAlert
                      tone={routeProbeResultAmbiguous ? "warning" : "error"}
                      title={
                        routeProbeResultAmbiguous
                          ? "固定能力验证结果待核对"
                          : taskProbeDisclosureError === null
                            ? "AI 分工没有保存"
                            : "固定能力验证没有发送"
                      }
                      description={
                        routeProbeResultAmbiguous
                          ? "模型服务调用已经发送，但结果无法确认；系统不会自动重发，本次 AI 分工也没有保存。请到调用记录核对结果。"
                          : taskProbeDisclosureError === null
                            ? "写作能力证据已保留，但自动分工没有完成。请打开“AI 分工”查看回读结果并重试。"
                            : taskProbeDisclosureError.message
                      }
                    />
                  )}
                </CardContent>
              </Card>
            )}

            {activeModelHubSection === "model-routing" && (
              <Card id="model-routing" className="settings-card--wide">
                <CardHeader>
                  <div className="card-heading-row">
                    <div>
                      <CardTitle headingLevel={2}>AI 分工</CardTitle>
                      <CardDescription>
                        选择一种使用方案，让写作、规划和检查使用合适的已连接模型。
                      </CardDescription>
                    </div>
                    <Badge tone={modelHubRouteBadgeTone}>{modelHubRouteBadgeLabel}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="model-center-settings">
                    {taskProbeDisclosureError !== null && (
                      <InlineAlert
                        tone="warning"
                        title="固定能力验证没有发送"
                        description={taskProbeDisclosureError.message}
                      />
                    )}
                    {routeProbeResultAmbiguous && (
                      <InlineAlert
                        tone="warning"
                        title="固定能力验证结果待核对"
                        description="模型服务调用已经发送，但结果无法确认；系统不会自动重发，本次 AI 分工也没有保存。请到调用记录核对结果。"
                      />
                    )}
                    {normalizedRouteError !== null &&
                      taskProbeDisclosureError === null &&
                      !routeProbeResultAmbiguous && (
                        <div className="model-routing-save-failure">
                          <InlineAlert
                            tone="error"
                            title="AI 分工没有保存"
                            description={`系统在保存模型分配时遇到本地数据问题。${
                              routeFailureRollbackConfirmed === true
                                ? routeFailureLegacyProjectionMayHaveChanged
                                  ? "已重新读取并确认：模型中心的 22 项分工未修改；为防止云端回退，旧版兼容分工可能已被安全停用。请重试应用本地隐私方案。"
                                  : "已重新读取并确认：模型中心的 22 项分工没有被修改，本次任务路由事务已回滚。"
                                : routeFailureRollbackConfirmed === false
                                  ? "重新读取后发现分工状态发生变化，请先查看下面的 22 项清单再重试。"
                                  : "暂时无法重新读取并确认旧分工状态；请先导出诊断包。"
                            }`}
                          />
                          <div className="settings-actions">
                            <Button
                              variant="secondary"
                              disabled={schemeSaving || routeSaving}
                              onClick={() => void applyModelHubScheme()}
                            >
                              重试保存
                            </Button>
                            <Button
                              variant="secondary"
                              loading={diagnosticBusy}
                              onClick={() => void downloadDiagnostics()}
                            >
                              导出脱敏诊断
                            </Button>
                          </div>
                          {expertMode && (
                            <p className="model-routing-technical-detail">
                              技术详情：{normalizedRouteError.code}；旧状态校验：
                              {routeFailureRollbackConfirmed === null
                                ? "未能确认"
                                : routeFailureRollbackConfirmed
                                  ? routeFailureLegacyProjectionMayHaveChanged
                                    ? "模型中心快照未变化；旧兼容分工可能已安全停用"
                                    : "模型中心快照未变化"
                                  : "检测到变化"}
                              。原始 SQL 不会在界面中显示。
                            </p>
                          )}
                        </div>
                      )}

                    {(normalizedRouteError === null || routeProbeResultAmbiguous) && (
                      <InlineAlert
                        tone={modelHubOverallAlertTone(routingVisibility.state)}
                        title={modelHubOverallTitle(routingVisibility.state)}
                        description={modelHubOverallDescription(routingVisibility)}
                      />
                    )}
                    <div className="model-routing-summary" aria-label="AI 分工总体状态">
                      <strong>
                        {`${String(routingVisibility.enabledRouteCount)} / ${String(
                          NOVEL_AI_TASKS.length,
                        )} 类已配置${
                          missingNovelTaskRouteCount > 0
                            ? ` · ${String(missingNovelTaskRouteCount)} 类缺能力`
                            : ""
                        }`}
                      </strong>
                      <span>
                        手动 {String(routingVisibility.manuallyConfiguredCount)} 项 · 智能推荐{" "}
                        {String(routingVisibility.automaticallyConfiguredCount)} 项
                      </span>
                    </div>

                    <ModelHubSelectableCatalogBrowser
                      connectedModels={selectableCatalogConnectedModels}
                      officialCandidates={selectableCatalogOfficialCandidates}
                      disabled={modelHubHydrationPending || routeSaving}
                      onSelect={selectCatalogBrowserModel}
                    />

                    {routingVisibility.models.length > 0 && (
                      <section
                        className="model-routing-capabilities"
                        aria-labelledby="connected-model-capabilities-title"
                      >
                        <h3 id="connected-model-capabilities-title">当前模型能做什么</h3>
                        <div className="model-routing-model-grid">
                          {routingVisibility.models.map((model) => (
                            <article className="model-routing-model" key={model.catalogEntry.id}>
                              <header>
                                <div>
                                  <strong>
                                    {
                                      getModelProviderPreset(model.connection.providerKind)
                                        .displayName
                                    }
                                    {" / "}
                                    {model.catalogEntry.displayName}
                                  </strong>
                                  <small>
                                    协议：{model.connection.protocol} · 最后验证：
                                    {formatVerificationTime(model.lastVerifiedAt)}
                                  </small>
                                </div>
                                <Badge
                                  tone={
                                    !model.connectionUsable
                                      ? "danger"
                                      : model.latestProbeFailureCode === null
                                        ? "success"
                                        : "warning"
                                  }
                                >
                                  {!model.connectionUsable
                                    ? "连接异常"
                                    : model.latestProbeFailureCode === null
                                      ? "能力证据已读取"
                                      : model.capabilities.some(
                                            ({ capability, state }) =>
                                              capability === "text_generation" &&
                                              state === "ambiguous",
                                          )
                                        ? "最近结果待核对"
                                        : "最近实测失败"}
                                </Badge>
                              </header>
                              <ul className="model-capability-list">
                                {model.capabilities.map((capability) => (
                                  <li key={capability.capability} data-state={capability.state}>
                                    <span>{capabilityLabel(capability.capability)}</span>
                                    <small>
                                      {capabilityDisplayStateLabel(capability.state)} ·{" "}
                                      {capabilityEvidenceSourceLabel(capability.source)}
                                      {capability.observedAt === null
                                        ? ""
                                        : ` · ${formatVerificationTime(capability.observedAt)}`}
                                      {capability.failureCode === null
                                        ? ""
                                        : ` · ${capabilityFailureLabel(capability.failureCode)}`}
                                    </small>
                                  </li>
                                ))}
                              </ul>
                            </article>
                          ))}
                        </div>
                      </section>
                    )}

                    <div className="model-routing-task-disclosure">
                      <details
                        open={configuredTaskPartitionExpanded}
                        onToggle={(event) =>
                          setConfiguredTaskPartitionExpanded(event.currentTarget.open)
                        }
                      >
                        <summary>
                          查看已配置的 {String(routingVisibility.enabledRouteCount)} 项
                        </summary>
                        <div className="model-routing-task-groups">
                          {MODEL_HUB_TASK_GROUPS.map((group) => {
                            const tasks = routingVisibility.tasks.filter(
                              ({ definition, route }) =>
                                definition.group === group && route !== null,
                            );
                            if (tasks.length === 0) return null;
                            return (
                              <section key={group}>
                                <h4>{modelHubTaskGroupLabel(group)}</h4>
                                <ul className="model-routing-task-list">
                                  {tasks.map((task) => (
                                    <li
                                      id={`model-routing-task-${task.definition.task}`}
                                      key={task.definition.task}
                                      data-state={task.status}
                                      tabIndex={-1}
                                    >
                                      <div>
                                        <strong>{task.definition.displayName}</strong>
                                        <small>{task.definition.description}</small>
                                      </div>
                                      <dl>
                                        <div>
                                          <dt>主模型</dt>
                                          <dd>
                                            {task.primaryModel === null
                                              ? "模型已不可用"
                                              : catalogEntryLabel(
                                                  task.primaryModel,
                                                  hubConnections,
                                                )}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>备用模型</dt>
                                          <dd>
                                            {task.fallbackModel === null
                                              ? "未配置"
                                              : catalogEntryLabel(
                                                  task.fallbackModel,
                                                  hubConnections,
                                                )}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>所需能力</dt>
                                          <dd>
                                            {task.definition.requiredCapabilities
                                              .map(capabilityLabel)
                                              .join("、")}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>来源</dt>
                                          <dd>
                                            {task.route === null
                                              ? "未配置"
                                              : routeOriginLabel(task.route.routeOrigin)}
                                          </dd>
                                        </div>
                                      </dl>
                                      {task.status === "failed" && (
                                        <p className="model-routing-task-warning">{task.reason}</p>
                                      )}
                                      {selectableModelsForTaskDisclosure(task.definition.task)}
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            );
                          })}
                        </div>
                      </details>
                      <details
                        open={missingTaskPartitionExpanded}
                        onToggle={(event) =>
                          setMissingTaskPartitionExpanded(event.currentTarget.open)
                        }
                      >
                        <summary>
                          查看尚未配置的 {String(routingVisibility.missingRouteCount)} 项
                        </summary>
                        <div className="model-routing-task-groups">
                          {MODEL_HUB_TASK_GROUPS.map((group) => {
                            const tasks = routingVisibility.tasks.filter(
                              ({ definition, route }) =>
                                definition.group === group && route === null,
                            );
                            if (tasks.length === 0) return null;
                            return (
                              <section key={group}>
                                <h4>{modelHubTaskGroupLabel(group)}</h4>
                                <ul className="model-routing-task-list">
                                  {tasks.map((task) => {
                                    const recommendation =
                                      connectedTaskRecommendations.get(task.definition.task) ??
                                      null;
                                    const providerRecommendation =
                                      providerTaskRecommendations.get(task.definition.task) ?? null;
                                    return (
                                      <li
                                        id={`model-routing-task-${task.definition.task}`}
                                        key={task.definition.task}
                                        data-state="missing"
                                        tabIndex={-1}
                                      >
                                        <div>
                                          <strong>{task.definition.displayName}</strong>
                                          <small>{task.reason}</small>
                                        </div>
                                        <p>
                                          <strong>影响：</strong>
                                          {task.definition.impactWhenMissing}
                                        </p>
                                        <p>
                                          <strong>下一步：</strong>
                                          {recommendation === null
                                            ? providerRecommendation === null
                                              ? task.nextStep
                                              : `可连接 ${providerRecommendation.providerLabel}，再发现并验证 ${providerRecommendation.modelFamilies.join(" / ")}；供应商文档不是墨影能力验证。`
                                            : recommendation.reason}
                                        </p>
                                        {recommendation !== null && (
                                          <div className="settings-actions">
                                            <span>
                                              建议：
                                              {catalogEntryLabel(
                                                recommendation.model.catalogEntry,
                                                hubConnections,
                                              )}
                                            </span>
                                            {task.definition.task === "rerank" ? (
                                              <a
                                                className="button-link button-link--secondary"
                                                href="#expert-model-routing"
                                              >
                                                确认素材隐私后分配
                                              </a>
                                            ) : (
                                              <Button
                                                variant="secondary"
                                                loading={
                                                  recommendedTaskBusy === task.definition.task
                                                }
                                                disabled={
                                                  routeProbeResultAmbiguous ||
                                                  recommendedTaskBusy !== null ||
                                                  routeSaving ||
                                                  taskProbeConfirmation !== null ||
                                                  modelHubHydrationPending
                                                }
                                                onClick={() =>
                                                  void requestRecommendedTaskAssignment(
                                                    task.definition.task,
                                                    recommendation,
                                                  )
                                                }
                                              >
                                                {routeProbeResultAmbiguous
                                                  ? "结果待核对"
                                                  : recommendation.readiness !== "ready"
                                                    ? "查看验证说明"
                                                    : "用于此任务"}
                                              </Button>
                                            )}
                                          </div>
                                        )}
                                        {recommendation === null &&
                                          providerRecommendation !== null && (
                                            <div className="settings-actions">
                                              <span>
                                                专用能力候选：
                                                {providerRecommendation.providerLabel} ·
                                                {providerRecommendation.modelFamilies.join(" / ")}
                                              </span>
                                              <a
                                                className="button-link button-link--secondary"
                                                href="#model-center"
                                                onClick={() =>
                                                  applyProviderPreset(
                                                    providerRecommendation.providerKind,
                                                  )
                                                }
                                              >
                                                连接此供应商
                                              </a>
                                              {expertMode && (
                                                <a
                                                  className="back-link"
                                                  href={providerRecommendation.evidenceUrl}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                >
                                                  查看供应商证据
                                                </a>
                                              )}
                                            </div>
                                          )}
                                        {selectableModelsForTaskDisclosure(task.definition.task)}
                                        {task.definition.isCoreWritingTask ? (
                                          <Badge tone="danger">会阻止这项基础任务配置</Badge>
                                        ) : (
                                          <Badge tone="neutral">不阻止其他基础配置</Badge>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </section>
                            );
                          })}
                        </div>
                      </details>
                    </div>

                    <section
                      className="model-routing-missing-capabilities"
                      aria-labelledby="missing-capabilities-title"
                    >
                      <h3 id="missing-capabilities-title">完善全部功能还需要</h3>
                      {routingVisibility.missingCapabilities.length === 0 ? (
                        <p>当前 22 项任务所需能力均已满足。</p>
                      ) : (
                        <ul>
                          {routingVisibility.missingCapabilities.map((missing) => (
                            <li key={missing.capability}>
                              <div>
                                <strong>{capabilityLabel(missing.capability)}</strong>
                                <span>
                                  {missing.core ? "核心写作能力" : "非核心扩展能力"} · 影响
                                  {String(missing.tasks.length)} 项任务
                                </span>
                              </div>
                              <p>{missing.degradedBehavior}</p>
                              <Badge tone={missing.blocksBasicWriting ? "danger" : "neutral"}>
                                {missing.blocksBasicWriting
                                  ? "会阻止部分基础任务配置"
                                  : "其他基础配置不受影响"}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                      <a className="button-link button-link--secondary" href="#model-center">
                        新增或验证模型连接
                      </a>
                    </section>

                    <FormField label="使用方案" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={modelHubScheme}
                          options={MODEL_HUB_SCHEME_OPTIONS.map((option) => ({
                            value: option.value,
                            label: option.label,
                          }))}
                          disabled={schemeSaving || routeSaving}
                          onChange={(event) => {
                            setModelHubScheme(event.currentTarget.value as ModelHubScheme);
                            setSchemeMessage(null);
                          }}
                        />
                      )}
                    </FormField>
                    <p>
                      {MODEL_HUB_SCHEME_OPTIONS.find(({ value }) => value === modelHubScheme)
                        ?.description ?? ""}
                    </p>
                    <ul className="privacy-list" aria-label="小说任务分工示例">
                      <li>正文：开书引导、正文生成、续写、改写与润色。</li>
                      <li>规划：大纲、场景拆解、章节摘要与长期记忆压缩。</li>
                      <li>检查：矛盾、视角边界、人物说话一致性与深度复核。</li>
                    </ul>
                    <div className="settings-actions">
                      <Button
                        loading={schemeSaving}
                        disabled={routeSaving}
                        onClick={() => void applyModelHubScheme()}
                      >
                        应用 AI 分工
                      </Button>
                    </div>
                    {schemeMessage !== null && (
                      <InlineAlert
                        tone={schemeMessageIsWarning ? "warning" : "info"}
                        title={schemeMessageIsWarning ? "AI 分工部分配置完成" : "AI 分工已更新"}
                        description={schemeMessage}
                      />
                    )}

                    {hubCatalog.every(({ availability }) => availability !== "available") && (
                      <InlineAlert
                        tone="warning"
                        title="还没有可用模型"
                        description="请先在上方连接供应商、测试连接并保存一个模型。手动写作仍可使用，但需要 AI 的功能会明确提示尚未就绪。"
                      />
                    )}

                    {expertMode && (
                      <>
                        <section
                          className="model-routing-expert-matrix"
                          aria-labelledby="model-routing-expert-matrix-title"
                        >
                          <div className="model-routing-expert-matrix__heading">
                            <div>
                              <h3 id="model-routing-expert-matrix-title">22 项任务矩阵</h3>
                              <p>
                                这里复用下方单项编辑器，不会创建第二套分工入口；任务能力、证据、费用和隐私均使用可理解的中文说明。
                              </p>
                            </div>
                            <FormField label="矩阵筛选">
                              {(fieldProps) => (
                                <Select
                                  {...fieldProps}
                                  value={taskMatrixFilter}
                                  options={[
                                    { value: "all", label: "全部 22 项" },
                                    { value: "missing", label: "只看未配置" },
                                    { value: "failed", label: "只看失败" },
                                  ]}
                                  onChange={(event) =>
                                    setTaskMatrixFilter(
                                      event.currentTarget.value as "all" | "missing" | "failed",
                                    )
                                  }
                                />
                              )}
                            </FormField>
                          </div>
                          <div className="model-routing-expert-rows">
                            {visibleExpertTasks.length === 0 ? (
                              <p className="model-routing-expert-empty">当前筛选下没有任务。</p>
                            ) : (
                              visibleExpertTasks.map((task) => {
                                const costProfile =
                                  task.primaryModel === null
                                    ? null
                                    : (routingCostPrivacyProfiles.find(
                                        ({ catalogEntryId }) =>
                                          catalogEntryId === task.primaryModel?.id,
                                      ) ?? null);
                                const primaryProjection =
                                  task.primaryModel === null
                                    ? null
                                    : (routingVisibility.models.find(
                                        ({ catalogEntry }) =>
                                          catalogEntry.id === task.primaryModel?.id,
                                      ) ?? null);
                                return (
                                  <article key={task.definition.task} data-state={task.status}>
                                    <header>
                                      <div>
                                        <strong>{novelAiTaskLabel(task.definition.task)}</strong>
                                      </div>
                                      <Badge
                                        tone={
                                          task.status === "configured"
                                            ? "success"
                                            : task.status === "failed"
                                              ? "danger"
                                              : "neutral"
                                        }
                                      >
                                        {task.status === "configured"
                                          ? "已配置"
                                          : task.status === "failed"
                                            ? "需要修复"
                                            : "未配置"}
                                      </Badge>
                                    </header>
                                    <dl>
                                      <div>
                                        <dt>任务组</dt>
                                        <dd>{modelHubTaskGroupLabel(task.definition.group)}</dd>
                                      </div>
                                      <div>
                                        <dt>所需能力</dt>
                                        <dd>
                                          {task.definition.requiredCapabilities.map(
                                            (capability) => (
                                              <span key={capability}>
                                                {capabilityLabel(capability)}
                                              </span>
                                            ),
                                          )}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>主模型</dt>
                                        <dd>
                                          {task.primaryModel === null
                                            ? "未配置"
                                            : catalogEntryLabel(task.primaryModel, hubConnections)}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>备用模型</dt>
                                        <dd>
                                          {task.fallbackModel === null
                                            ? "未配置"
                                            : catalogEntryLabel(task.fallbackModel, hubConnections)}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>能力证据</dt>
                                        <dd>
                                          {primaryProjection === null
                                            ? "没有可读证据"
                                            : task.definition.requiredCapabilities
                                                .map((capability) => {
                                                  const evidence =
                                                    primaryProjection.capabilities.find(
                                                      (item) => item.capability === capability,
                                                    );
                                                  const capabilityName =
                                                    capabilityLabel(capability);
                                                  return evidence === undefined
                                                    ? `${capabilityName}：没有可读证据`
                                                    : `${capabilityName}：${capabilityDisplayStateLabel(
                                                        evidence.state,
                                                      )}，${capabilityEvidenceSourceLabel(
                                                        evidence.source,
                                                      )}`;
                                                })
                                                .join("；")}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>费用</dt>
                                        <dd>
                                          {task.route?.maximumCostMicros === null ||
                                          task.route?.maximumCostMicros === undefined
                                            ? costProfile?.pricingVersion === null ||
                                              costProfile?.pricingVersion === undefined
                                              ? "未设置上限；价格证据未知"
                                              : `未设置上限；价格版本 ${costProfile.pricingVersion}`
                                            : `${task.route.maximumCostMicros} 微单位 / ${task.route.currency ?? "币种未知"}`}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>隐私</dt>
                                        <dd>
                                          {modelHubPrivacyPolicyLabel(task.route?.privacyPolicy)}
                                          ；证据
                                          {costPrivacyEvidenceSourceLabel(
                                            costProfile?.evidenceSource,
                                          )}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>来源</dt>
                                        <dd>
                                          {task.route === null
                                            ? "未配置"
                                            : routeOriginLabel(task.route.routeOrigin)}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>最后验证</dt>
                                        <dd>{formatVerificationTime(task.lastVerifiedAt)}</dd>
                                      </div>
                                      <div>
                                        <dt>状态说明</dt>
                                        <dd>{task.reason}</dd>
                                      </div>
                                    </dl>
                                    <Button
                                      variant="secondary"
                                      onClick={() => {
                                        selectNovelTaskRoute(task.definition.task);
                                        document
                                          .getElementById("novel-task-route-editor")
                                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                                      }}
                                    >
                                      在单项编辑器中查看
                                    </Button>
                                  </article>
                                );
                              })
                            )}
                          </div>
                        </section>
                        <InlineAlert
                          tone="info"
                          title="小说任务路由"
                          description={`逐项覆盖 ${String(NOVEL_AI_TASKS.length)} 类小说任务的主模型、备用模型、费用上限、隐私与失败处理。未明确保存的任务继续使用当前自动方案。`}
                        />
                        {routingCatalog.some(
                          ({ availability }) => availability === "available",
                        ) && (
                          <>
                            <div id="novel-task-route-editor" className="model-center-grid">
                              <FormField label="小说任务" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={novelRouteTask}
                                    options={NOVEL_AI_TASKS.map((task) => ({
                                      value: task,
                                      label: novelAiTaskLabel(task),
                                    }))}
                                    disabled={routeSaving}
                                    onChange={(event) =>
                                      selectNovelTaskRoute(event.currentTarget.value as NovelAiTask)
                                    }
                                  />
                                )}
                              </FormField>
                              <FormField label="主模型" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={novelRoutePrimaryCatalogId}
                                    placeholder="选择主模型"
                                    options={selectableRoutingCatalog.map((catalogEntry) => ({
                                      value: catalogEntry.id,
                                      label: catalogEntryLabel(catalogEntry, hubConnections),
                                    }))}
                                    disabled={routeSaving}
                                    onChange={(event) => {
                                      const next = event.currentTarget.value;
                                      setNovelRoutePrimaryCatalogId(next);
                                      if (novelRouteFallbackCatalogId === next) {
                                        setNovelRouteFallbackCatalogId("");
                                      }
                                    }}
                                  />
                                )}
                              </FormField>
                              <FormField
                                label="备用模型"
                                hint="建议选择不同连接；本地隐私只能选择本机模型。"
                              >
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={novelRouteFallbackCatalogId}
                                    options={[
                                      { value: "", label: "不配置备用模型" },
                                      ...selectableRoutingCatalog
                                        .filter(({ id }) => id !== novelRoutePrimaryCatalogId)
                                        .map((catalogEntry) => ({
                                          value: catalogEntry.id,
                                          label: catalogEntryLabel(catalogEntry, hubConnections),
                                        })),
                                    ]}
                                    disabled={routeSaving}
                                    onChange={(event) =>
                                      setNovelRouteFallbackCatalogId(event.currentTarget.value)
                                    }
                                  />
                                )}
                              </FormField>
                              <FormField
                                label="单次费用上限"
                                hint="留空表示不设置；按所选币种填写。"
                              >
                                {(fieldProps) => (
                                  <Input
                                    {...fieldProps}
                                    type="number"
                                    min={0}
                                    step="0.000001"
                                    value={novelRouteMaximumCost}
                                    disabled={routeSaving}
                                    onChange={(event) =>
                                      setNovelRouteMaximumCost(event.currentTarget.value)
                                    }
                                  />
                                )}
                              </FormField>
                              <FormField label="费用币种">
                                {(fieldProps) => (
                                  <Input
                                    {...fieldProps}
                                    value={novelRouteCurrency}
                                    minLength={3}
                                    maxLength={3}
                                    disabled={
                                      routeSaving || novelRouteMaximumCost.trim().length === 0
                                    }
                                    onChange={(event) =>
                                      setNovelRouteCurrency(event.currentTarget.value)
                                    }
                                  />
                                )}
                              </FormField>
                              <FormField label="隐私限制" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={novelRoutePrivacy}
                                    options={[
                                      { value: "cloud_allowed", label: "允许云端" },
                                      { value: "local_preferred", label: "优先本机" },
                                      { value: "local_only", label: "仅限本机" },
                                    ]}
                                    disabled={routeSaving}
                                    onChange={(event) => {
                                      const nextPrivacy = event.currentTarget
                                        .value as ModelHubPrivacyPolicy;
                                      setNovelRoutePrivacy(nextPrivacy);
                                      if (nextPrivacy === "local_only") {
                                        setNovelRouteRemoteContentConsent(false);
                                        if (
                                          !localCatalogEntryIds.includes(novelRoutePrimaryCatalogId)
                                        ) {
                                          setNovelRoutePrimaryCatalogId("");
                                        }
                                        if (
                                          !localCatalogEntryIds.includes(
                                            novelRouteFallbackCatalogId,
                                          )
                                        ) {
                                          setNovelRouteFallbackCatalogId("");
                                        }
                                      }
                                    }}
                                  />
                                )}
                              </FormField>
                              <FormField label="失败处理" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={novelRouteFailure}
                                    options={[
                                      { value: "use_fallback", label: "使用备用模型" },
                                      { value: "ask_user", label: "询问我" },
                                      { value: "stop", label: "停止任务" },
                                    ]}
                                    disabled={routeSaving}
                                    onChange={(event) =>
                                      setNovelRouteFailure(
                                        event.currentTarget
                                          .value as NovelTaskRoute["failurePolicy"],
                                      )
                                    }
                                  />
                                )}
                              </FormField>
                            </div>
                            {novelRouteTask === "rerank" && (
                              <div className="maintenance-settings">
                                <label className="checkbox-row">
                                  <input
                                    type="checkbox"
                                    checked={novelRouteRemoteContentConsent}
                                    disabled={routeSaving || novelRoutePrivacy !== "cloud_allowed"}
                                    onChange={(event) =>
                                      setNovelRouteRemoteContentConsent(event.currentTarget.checked)
                                    }
                                  />
                                  <span>
                                    允许检索重排任务把一次写作所需的查询与候选片段发送到所选云端供应商
                                  </span>
                                </label>
                                <InlineAlert
                                  tone={novelRouteRemoteContentConsent ? "warning" : "info"}
                                  title={
                                    novelRouteRemoteContentConsent
                                      ? "已明确允许远程候选片段发送"
                                      : "远程重排默认关闭"
                                  }
                                  description={
                                    novelRouteRemoteContentConsent
                                      ? "保存后，仅在已验证的阿里云百炼北京地域 Workspace、重排能力、隐私与费用检查全部通过时发送；失败会继续使用本地排序。"
                                      : "不勾选时，正文续写只使用本地确定性复核，不会为了重排把候选片段发送到云端。"
                                  }
                                />
                              </div>
                            )}
                            {novelRoutePrivacy === "local_only" && (
                              <InlineAlert
                                tone={selectableRoutingCatalog.length === 0 ? "warning" : "info"}
                                title="仅显示证据确认的本机模型"
                                description={
                                  selectableRoutingCatalog.length === 0
                                    ? "当前没有已确认数据仅在本机处理的可用模型。请先保存本机连接的隐私信息；墨影不会用云端模型补位。"
                                    : "主模型和备用模型列表已过滤为数据去向明确为本机、且证据来源不是未知的模型。"
                                }
                              />
                            )}
                            <div className="settings-actions">
                              <Button
                                loading={routeSaving}
                                disabled={novelRoutePrimaryCatalogId.length === 0}
                                onClick={() => void saveNovelTaskRoute()}
                              >
                                保存小说任务分工
                              </Button>
                            </div>
                          </>
                        )}
                        <InlineAlert
                          tone="info"
                          title="专家兼容设置：旧 7 角色路由"
                          description={`${String(NOVEL_AI_TASKS.length)} 类小说任务由模型中心负责；这组旧角色仅桥接尚未迁移的生成链路。应用方案时会完整刷新，无法安全映射的旧角色会被清除。`}
                        />
                        {profiles.some(({ selectedModel: model }) => model !== null) && (
                          <>
                            <div className="model-center-grid">
                              <FormField label="任务角色" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={routeRole}
                                    options={MODEL_ROUTE_ROLES.map((role) => ({
                                      value: role,
                                      label: modelRouteRoleLabel(role),
                                    }))}
                                    disabled={routeSaving}
                                    onChange={(event) =>
                                      selectRouteRole(event.currentTarget.value as ModelRouteRole)
                                    }
                                  />
                                )}
                              </FormField>
                              <FormField label="兼容主模型" required>
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={routePrimaryProviderId}
                                    placeholder="选择主模型"
                                    options={profiles
                                      .filter(
                                        (
                                          candidate,
                                        ): candidate is ModelProfile & {
                                          readonly selectedModel: string;
                                        } => candidate.selectedModel !== null,
                                      )
                                      .map((candidate) => ({
                                        value: candidate.providerId,
                                        label: `${candidate.providerId} · ${candidate.selectedModel}`,
                                      }))}
                                    disabled={routeSaving}
                                    onChange={(event) => {
                                      const next = event.currentTarget.value;
                                      setRoutePrimaryProviderId(next);
                                      if (routeFallbackProviderId === next) {
                                        setRouteFallbackProviderId("");
                                      }
                                    }}
                                  />
                                )}
                              </FormField>
                              <FormField label="兼容备用模型" hint="可选；切换前仍需在预检中确认。">
                                {(fieldProps) => (
                                  <Select
                                    {...fieldProps}
                                    value={routeFallbackProviderId}
                                    options={[
                                      { value: "", label: "不配置备用模型" },
                                      ...profiles
                                        .filter(
                                          (
                                            candidate,
                                          ): candidate is ModelProfile & {
                                            readonly selectedModel: string;
                                          } =>
                                            candidate.selectedModel !== null &&
                                            candidate.providerId !== routePrimaryProviderId,
                                        )
                                        .map((candidate) => ({
                                          value: candidate.providerId,
                                          label: `${candidate.providerId} · ${candidate.selectedModel}`,
                                        })),
                                    ]}
                                    disabled={routeSaving}
                                    onChange={(event) =>
                                      setRouteFallbackProviderId(event.currentTarget.value)
                                    }
                                  />
                                )}
                              </FormField>
                            </div>
                            <div className="settings-actions">
                              <Button
                                loading={routeSaving}
                                disabled={routePrimaryProviderId.length === 0}
                                onClick={() => void saveModelRoleRoute()}
                              >
                                保存角色路由
                              </Button>
                            </div>
                          </>
                        )}
                      </>
                    )}

                    {expertMode && roleRoutes.length > 0 && (
                      <ul className="privacy-list" aria-label="已配置模型角色">
                        {roleRoutes.map((route) => (
                          <li key={route.role}>
                            <strong>{modelRouteRoleLabel(route.role)}</strong>
                            {"："}
                            {route.primaryProviderId} / {route.primaryModelId}
                            {route.fallbackProviderId === null
                              ? "；无备用模型"
                              : `；备用 ${route.fallbackProviderId} / ${route.fallbackModelId ?? ""}`}
                            {`；修订 ${String(route.revision)}`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeModelHubSection === "model-evaluation" && (
              <section id="model-evaluation" className="settings-card--wide">
                <ModelHubEvaluationPanel
                  service={modelEvaluation}
                  disabled={!runtime.modelGateway.available || hubCatalog.length === 0}
                />
                {expertMode && (
                  <div className="settings-actions">
                    <Button
                      variant="secondary"
                      aria-expanded={paidEvaluationExpanded}
                      aria-controls="novel-skill-paid-evaluation"
                      onClick={() => setPaidEvaluationExpanded((current) => !current)}
                    >
                      {paidEvaluationExpanded
                        ? "收起写作方法 A/B 评测"
                        : "写作方法 A/B 评测（专家）"}
                    </Button>
                  </div>
                )}
                {expertMode && paidEvaluationExpanded && (
                  <div id="novel-skill-paid-evaluation">
                    {paidEvaluationTargets.length < 2 && (
                      <InlineAlert
                        tone="warning"
                        title="需要两个已验证且价格完整的文本模型"
                        description="这里不会自动补模型或回退路由。请先完成两个不同模型的连接、文本能力验证、上下文上限和价格资料。"
                      />
                    )}
                    <NovelSkillPaidEvaluationPanel
                      expertMode
                      targets={paidEvaluationTargets}
                      initialSnapshot={runtime.novelSkillPaidEvaluation.getSnapshot()}
                      port={runtime.novelSkillPaidEvaluation}
                    />
                  </div>
                )}
              </section>
            )}

            {activeModelHubSection === "image-generation" && (
              <section id="image-generation" className="settings-card--wide">
                <ModelHubImageGenerationPanel
                  service={runtime.imageGeneration}
                  disabled={!runtime.modelGateway.available}
                />
              </section>
            )}
          </>
        )}

        {!isModelHubView && (
          <>
            <Card id="sync-security" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>同步安全</CardTitle>
                    <CardDescription>
                      逐设备、逐项目准备端到端加密密钥，并确认只显示一次的恢复码。
                    </CardDescription>
                  </div>
                  <Badge tone="neutral">默认关闭</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="maintenance-settings">
                  <ul className="privacy-list">
                    <li>确认恢复码前不会激活项目密钥，也不会开启任何上传。</li>
                    <li>账号密码找回与项目密钥恢复严格分离；云端无法读取正文。</li>
                  </ul>
                  <div className="settings-actions">
                    <Link className="button-link" to="/settings/sync">
                      打开同步安全设置
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card id="local-maintenance" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>本地数据维护</CardTitle>
                    <CardDescription>
                      检查本地数据库（SQLite）的数据完整性，并创建可独立恢复的一致性备份。
                    </CardDescription>
                  </div>
                  {runtime.maintenance !== null && (
                    <Badge
                      tone={
                        integrity === null ? "neutral" : integrity.healthy ? "success" : "danger"
                      }
                    >
                      {integrity === null
                        ? "尚未检查"
                        : integrity.healthy
                          ? "数据健康"
                          : "需要处理"}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {runtime.maintenance === null ? (
                  <InlineAlert
                    tone="warning"
                    title="桌面应用专属能力"
                    description="本地数据库一致性检查与文件备份仅在桌面应用中可用。浏览器开发数据保存在调试存储中。"
                  />
                ) : (
                  <div className="maintenance-settings">
                    <section
                      className="maintenance-automatic-backup"
                      aria-labelledby="automatic-backup-title"
                    >
                      <div className="card-heading-row">
                        <div>
                          <h3 id="automatic-backup-title">自动备份</h3>
                          <p className="maintenance-note">
                            每天本地时间 03:00
                            创建一次；若当时未运行，会在下次启动时补做。同一天只做一次，并保留 30
                            天。
                          </p>
                        </div>
                        {runtime.automaticBackup !== null && (
                          <Button
                            variant="secondary"
                            loading={automaticBackupChecking}
                            disabled={automaticBackupChecking}
                            onClick={() => void checkAutomaticBackup()}
                          >
                            立即检查自动备份
                          </Button>
                        )}
                      </div>
                      {runtime.automaticBackup === null ? (
                        <InlineAlert
                          tone="warning"
                          title="自动备份仅在桌面应用中运行"
                          description="浏览器开发模式不会伪装本地文件备份；仍可使用下方的一致性备份流程做界面验证。"
                        />
                      ) : automaticBackupPresentation === null ? (
                        <InlineAlert
                          tone="info"
                          title="正在确认自动备份状态"
                          description="系统正在检查今天是否需要补做备份，并验证受管备份目录。"
                        />
                      ) : (
                        <InlineAlert
                          tone={automaticBackupPresentation.tone}
                          title={automaticBackupPresentation.title}
                          description={automaticBackupPresentation.description}
                        />
                      )}
                    </section>
                    {normalizedMaintenanceError !== null && (
                      <InlineAlert
                        tone="error"
                        title={normalizedMaintenanceError.title}
                        description={normalizedMaintenanceError.description}
                      />
                    )}
                    {integrity !== null && (
                      <InlineAlert
                        tone={integrity.healthy ? "info" : "warning"}
                        title={integrity.healthy ? "本地数据库检查通过" : "本地数据库需要处理"}
                        description={
                          integrity.healthy
                            ? "数据库结构与外键关系均正常。"
                            : `发现 ${String(integrity.integrityMessages.length)} 条完整性信息和 ${String(integrity.foreignKeyViolations.length)} 条外键异常；为避免生成不可信备份，备份操作会被拒绝。`
                        }
                      />
                    )}
                    {backupComplete && (
                      <InlineAlert
                        tone="info"
                        title="备份已创建"
                        description="备份文件已通过创建前一致性检查，并保存到你选择的位置。"
                      />
                    )}
                    {restoreComplete && (
                      <InlineAlert
                        tone="info"
                        title="备份已恢复"
                        description="项目数据已原子替换，墨影正在重新载入本地工作区。"
                      />
                    )}
                    <p className="maintenance-note">
                      备份不会覆盖已有文件。恢复前必须另存当前数据库作为回滚副本；来源检查或写入失败时，
                      当前数据保持不变。
                    </p>
                    <div className="settings-actions">
                      <Button
                        variant="secondary"
                        loading={maintenanceBusy === "inspect"}
                        disabled={maintenanceBusy !== null}
                        onClick={() => void inspectDatabase()}
                      >
                        检查数据库
                      </Button>
                      <Button
                        loading={maintenanceBusy === "backup"}
                        disabled={maintenanceBusy !== null || integrity?.healthy === false}
                        onClick={() => void createBackup()}
                      >
                        创建一致性备份
                      </Button>
                      <Button
                        variant="secondary"
                        loading={maintenanceBusy === "restore"}
                        disabled={maintenanceBusy !== null || integrity?.healthy === false}
                        onClick={() => void selectRestoreBackup()}
                      >
                        从备份恢复
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <SecureUpdateCard updater={runtime.secureUpdater} online={online} />

            <Card id="diagnostics" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>脱敏诊断包</CardTitle>
                    <CardDescription>
                      汇总版本、运行环境、任务状态和数据库/索引健康，供故障排查使用。
                    </CardDescription>
                  </div>
                  <Badge tone="info">不含正文与密钥</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="maintenance-settings">
                  {normalizedDiagnosticError !== null && (
                    <InlineAlert
                      tone="error"
                      title={normalizedDiagnosticError.title}
                      description={normalizedDiagnosticError.description}
                    />
                  )}
                  {diagnosticId !== null && (
                    <InlineAlert
                      tone="info"
                      title="诊断包已下载"
                      description={`支持编号：${diagnosticId}。发送前仍可自行打开结构化文件检查内容。`}
                    />
                  )}
                  <ul className="privacy-list">
                    <li>明确排除正文、提示词、模型密钥、密码、恢复码和上传文件。</li>
                    <li>当前未启用持久日志采集，诊断包会如实记录“最近日志”列表为空。</li>
                    <li>本地搜索索引从稳定章节与大纲按需重建；未执行过重建时标记为“尚未检查”。</li>
                  </ul>
                  <div className="settings-actions">
                    <Button loading={diagnosticBusy} onClick={() => void downloadDiagnostics()}>
                      下载脱敏诊断包
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <DataTransferPanel />
          </>
        )}
      </div>

      <Dialog
        open={taskProbeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && recommendedTaskBusy === null && !routeSaving) {
            setTaskProbeConfirmation(null);
          }
        }}
        title="确认 1 次固定能力验证？"
        description={
          taskProbeConfirmation === null
            ? "请先查看固定能力验证的发送说明。"
            : `将通过“${taskProbeConfirmation.disclosure.connectionDisplayName}”使用模型“${taskProbeConfirmation.disclosure.modelId}”，验证“${novelAiTaskLabel(taskProbeConfirmation.task)}”所需能力。只有点击下方明确确认按钮后才会发送。`
        }
        footer={
          <>
            <Button
              variant="secondary"
              disabled={recommendedTaskBusy !== null || routeSaving}
              onClick={() => setTaskProbeConfirmation(null)}
            >
              取消（不发送）
            </Button>
            <Button
              loading={
                taskProbeConfirmation !== null && recommendedTaskBusy === taskProbeConfirmation.task
              }
              disabled={taskProbeConfirmation === null || routeSaving}
              onClick={() => {
                if (taskProbeConfirmation === null) return;
                void verifyAndAssignRecommendedTask(
                  taskProbeConfirmation.task,
                  taskProbeConfirmation.recommendation,
                  {
                    humanConfirmed: true,
                    disclosedFingerprint: taskProbeConfirmation.disclosure.fingerprint,
                  },
                );
              }}
            >
              确认 1 次验证并用于此任务
            </Button>
          </>
        }
      >
        {taskProbeConfirmation !== null && (
          <div className="maintenance-settings">
            <InlineAlert
              tone="info"
              title="本次发送范围"
              description={taskProbeConfirmation.disclosure.privacy}
            />
            <ul className="privacy-list">
              {taskProbeConfirmation.disclosure.sends.map((item) => (
                <li key={item}>{item}</li>
              ))}
              <li>
                最大输出：
                {String(taskProbeConfirmation.disclosure.maximumOutputTokens)} 个输出内容额度。
              </li>
              <li>
                最大模型服务调用：
                {String(taskProbeConfirmation.disclosure.maximumProviderCalls)} 次；自动重试：
                {String(taskProbeConfirmation.disclosure.automaticRetryCount)} 次。
              </li>
              <li>费用上限：暂无法估算；远程模型服务可能收取少量费用。</li>
            </ul>
          </div>
        )}
      </Dialog>

      <Dialog
        open={memoryClearDialogOpen}
        onOpenChange={(open) => {
          if (!open && !memoryGovernanceBusy) {
            setMemoryClearDialogOpen(false);
            setMemoryClearOperationId(null);
          }
        }}
        title="清空该项目的全部 AI 记忆？"
        description={`只会处理“${selectedMemoryProject?.name ?? "当前项目"}”的 ${String(selectedProjectMemories.length)} 条本地记忆，并同时关闭自动学习。正式正文、其他项目和数据库中的审计记录不会被删除。`}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={memoryGovernanceBusy}
              onClick={() => {
                setMemoryClearDialogOpen(false);
                setMemoryClearOperationId(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={memoryGovernanceBusy}
              onClick={() => void confirmProjectMemoryClear()}
            >
              确认清空该项目记忆
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="这是一次项目范围的批量治理"
          description="所有记录和自动学习策略会在同一个原子操作中更新；若其中任何一项版本已变化，则不会留下部分清空状态。"
        />
      </Dialog>

      <DirectModeAuthorizationDialog
        open={directAuthorizationOpen}
        busy={writingExperience.switching}
        onCancel={() => setDirectAuthorizationOpen(false)}
        onAuthorize={() => {
          void writingExperience.authorizeDirectMode().then((authorized) => {
            if (authorized) setDirectAuthorizationOpen(false);
          });
        }}
      />

      <Dialog
        open={retireConnectionTarget !== null}
        onOpenChange={(open) => {
          if (!open && !retiringConnection) {
            setRetireConnectionTarget(null);
          }
        }}
        title={
          retireConnectionTarget === null
            ? "退役模型连接？"
            : `退役“${retireConnectionTarget.displayName}”连接？`
        }
        description="退役会永久停止这条连接参与选择、推荐和 AI 分工，并删除仍存在的系统凭据。模型目录与不可变调用记录只作为历史审计保留。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={retiringConnection}
              onClick={() => setRetireConnectionTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={retiringConnection}
              onClick={() => void confirmRetireConnection()}
            >
              确认退役连接
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="退役不同于删除凭据或暂时停用"
          description="正文、AI 建议版本、模型调用记录和费用凭据不会删除；这条连接本身将只读保留。以后连接同一供应商时，墨影会自动建立新连接，无需手工修改内部标识。"
        />
      </Dialog>

      {!isModelHubView && (
        <Dialog
          open={restoreSourceTicket !== null}
          onOpenChange={(open) => {
            if (!open && maintenanceBusy !== "restore") {
              setRestoreSourceTicket(null);
            }
          }}
          title="确认恢复本地备份"
          description="这会用所选备份替换当前项目数据。下一步会先要求你保存当前数据库的回滚副本；任一步失败都不会提交替换。"
          footer={
            <>
              <Button
                variant="secondary"
                disabled={maintenanceBusy === "restore"}
                onClick={() => setRestoreSourceTicket(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                loading={maintenanceBusy === "restore"}
                onClick={() => void confirmRestore()}
              >
                创建回滚备份并恢复
              </Button>
            </>
          }
        >
          <InlineAlert
            tone="warning"
            title="恢复后应用会重新载入"
            description="当前未保存的界面输入不会随数据库恢复；请先完成或导出正在编辑的草稿。"
          />
        </Dialog>
      )}
    </div>
  );
}

function projectDirectSettingsPage(writingExperience: ReturnType<typeof useWritingExperience>) {
  if (writingExperience.preference === null) {
    return (
      <div className="desktop-page settings-page" aria-busy={writingExperience.loading}>
        <header className="page-heading">
          <div>
            <h1>设置</h1>
          </div>
        </header>
        {writingExperience.loading ? (
          <div role="status">正在读取设置…</div>
        ) : (
          <InlineAlert
            tone="error"
            title="设置暂时无法读取"
            description={writingExperience.error ?? "请重试。"}
            action={{ label: "重试", onClick: () => void writingExperience.refresh() }}
          />
        )}
      </div>
    );
  }
  return writingExperience.preference.mode === "direct" ? (
    <DirectSettingsPage writingExperience={writingExperience} />
  ) : null;
}

function DirectSettingsPage({
  writingExperience,
}: {
  readonly writingExperience: ReturnType<typeof useWritingExperience>;
}) {
  const runtime = useRuntime();
  const {
    preference: appearance,
    resolvedSurface,
    setPreference: setAppearance,
  } = useAppearancePreference();
  const [integrity, setIntegrity] = useState<DatabaseIntegrityReport | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState<"inspect" | "backup" | "restore" | null>(
    null,
  );
  const [maintenanceError, setMaintenanceError] = useState<unknown>(null);
  const [backupComplete, setBackupComplete] = useState(false);
  const [restoreSourceTicket, setRestoreSourceTicket] = useState<NativePathTicket | null>(null);
  const [restoreComplete, setRestoreComplete] = useState(false);

  const inspectLocalData = useCallback(async (): Promise<void> => {
    if (runtime.maintenance === null) return;
    setMaintenanceBusy("inspect");
    setMaintenanceError(null);
    try {
      const result = await runtime.maintenance.inspect();
      if (result.ok) {
        setIntegrity(result.value);
      } else {
        setMaintenanceError(result.error);
      }
    } catch (cause: unknown) {
      setMaintenanceError(cause);
    } finally {
      setMaintenanceBusy(null);
    }
  }, [runtime]);

  useEffect(() => {
    if (runtime.maintenance !== null) {
      void Promise.resolve().then(inspectLocalData);
    }
  }, [inspectLocalData, runtime]);

  async function createDirectBackup(): Promise<void> {
    if (runtime.maintenance === null) return;
    setMaintenanceBusy("backup");
    setMaintenanceError(null);
    setBackupComplete(false);
    try {
      const destination = await runtime.maintenance.chooseBackupDestination();
      if (destination === null) return;
      const result = await runtime.maintenance.createConsistentBackup(destination);
      if (!result.ok) {
        setMaintenanceError(result.error);
        return;
      }
      setBackupComplete(true);
      await inspectLocalData();
    } catch (cause: unknown) {
      setMaintenanceError(cause);
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function chooseDirectRestore(): Promise<void> {
    if (runtime.maintenance === null) return;
    setMaintenanceBusy("restore");
    setMaintenanceError(null);
    try {
      const source = await runtime.maintenance.chooseRestoreSource();
      if (source !== null) setRestoreSourceTicket(source);
    } catch (cause: unknown) {
      setMaintenanceError(cause);
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function confirmDirectRestore(): Promise<void> {
    if (runtime.maintenance === null || restoreSourceTicket === null) return;
    const source = restoreSourceTicket;
    setMaintenanceBusy("restore");
    setMaintenanceError(null);
    setRestoreComplete(false);
    try {
      const rollbackDestination = await runtime.maintenance.choosePreRestoreBackupDestination();
      if (rollbackDestination === null) return;
      const rollback = await runtime.maintenance.createConsistentBackup(rollbackDestination);
      if (!rollback.ok) {
        setMaintenanceError(rollback.error);
        return;
      }
      const restored = await runtime.maintenance.restoreConsistentBackup(source);
      if (!restored.ok) {
        setMaintenanceError(restored.error);
        return;
      }
      setRestoreSourceTicket(null);
      setRestoreComplete(true);
      window.setTimeout(() => window.location.reload(), 1_200);
    } catch (cause: unknown) {
      setMaintenanceError(cause);
    } finally {
      setMaintenanceBusy(null);
    }
  }

  const normalizedMaintenanceError =
    maintenanceError === null ? null : normalizeUiError(maintenanceError);

  return (
    <div className="desktop-page settings-page settings-page--global">
      <header className="page-heading">
        <div>
          <Link className="back-link" to="/projects">
            返回作品库
          </Link>
          <p className="page-heading__eyebrow">阅读、写作与数据保护</p>
          <h1>设置</h1>
          <p>这里只保留日常创作需要的选项，不会改变作品正文。</p>
        </div>
      </header>

      <nav className="settings-actions settings-section-nav" aria-label="设置分区">
        <a className="button-link button-link--secondary" href="#appearance">
          外观
        </a>
        <a className="button-link button-link--secondary" href="#data-protection">
          备份与恢复
        </a>
        <a className="button-link button-link--secondary" href="#writing-mode">
          写作方式
        </a>
      </nav>

      <div className="settings-grid">
        <Card id="appearance">
          <CardHeader>
            <CardTitle headingLevel={2}>外观</CardTitle>
            <CardDescription>选择舒适的浅色或深色界面。</CardDescription>
          </CardHeader>
          <CardContent>
            <FormField label="外观模式">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={appearance}
                  options={[
                    { value: "system", label: "跟随系统" },
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                  ]}
                  onChange={(event) => {
                    const selected = event.currentTarget.value;
                    if (selected === "system" || selected === "light" || selected === "dark") {
                      setAppearance(selected);
                    }
                  }}
                />
              )}
            </FormField>
            <InlineAlert
              tone="info"
              title="当前显示"
              description={
                appearance === "system"
                  ? resolvedSurface === "dark"
                    ? "正在跟随系统，当前为深色。"
                    : "正在跟随系统，当前为浅色。"
                  : appearance === "dark"
                    ? "当前固定为深色。"
                    : "当前固定为浅色。"
              }
            />
          </CardContent>
        </Card>

        <Card id="data-protection" className="settings-card--wide">
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle headingLevel={2}>备份与恢复</CardTitle>
                <CardDescription>
                  备份不会覆盖已有文件；恢复前会先要求保存当前数据的回滚副本。
                </CardDescription>
              </div>
              {integrity !== null && (
                <Badge tone={integrity.healthy ? "success" : "danger"}>
                  {integrity.healthy ? "数据正常" : "需要处理"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {runtime.maintenance === null ? (
              <InlineAlert
                tone="warning"
                title="请在桌面应用中使用"
                description="文件备份与恢复在桌面应用中可用；当前预览环境不会伪装成功。"
              />
            ) : (
              <div className="maintenance-settings">
                {runtime.automaticBackup !== null && (
                  <InlineAlert
                    tone="info"
                    title="自动备份保护已启用"
                    description="墨影会按已有计划检查并保留本机备份；也可以随时手动创建一份。"
                  />
                )}
                {normalizedMaintenanceError !== null && (
                  <InlineAlert
                    tone="error"
                    title={normalizedMaintenanceError.title}
                    description={normalizedMaintenanceError.description}
                  />
                )}
                {backupComplete && (
                  <InlineAlert
                    tone="info"
                    title="备份已创建"
                    description="备份文件已完成检查并保存到你选择的位置。"
                  />
                )}
                {restoreComplete && (
                  <InlineAlert
                    tone="info"
                    title="备份已恢复"
                    description="作品数据已经安全恢复，墨影正在重新载入。"
                  />
                )}
                <div className="settings-actions">
                  <Button
                    variant="secondary"
                    loading={maintenanceBusy === "inspect"}
                    disabled={maintenanceBusy !== null}
                    onClick={() => void inspectLocalData()}
                  >
                    检查本地数据
                  </Button>
                  <Button
                    loading={maintenanceBusy === "backup"}
                    disabled={maintenanceBusy !== null || integrity?.healthy === false}
                    onClick={() => void createDirectBackup()}
                  >
                    创建备份
                  </Button>
                  <Button
                    variant="secondary"
                    loading={maintenanceBusy === "restore"}
                    disabled={maintenanceBusy !== null || integrity?.healthy === false}
                    onClick={() => void chooseDirectRestore()}
                  >
                    从备份恢复
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card id="writing-mode" className="settings-card--wide">
          <CardHeader>
            <CardTitle headingLevel={2}>写作方式</CardTitle>
            <CardDescription>当前使用简洁的直接写作界面。</CardDescription>
          </CardHeader>
          <CardContent>
            <p>需要比较多个结果或调整高级创作设置时，可以切换到专业模式。</p>
            <div className="settings-actions">
              <Button
                variant="secondary"
                loading={writingExperience.switching}
                disabled={writingExperience.switching}
                onClick={() => void writingExperience.switchMode("professional")}
              >
                切换到专业模式
              </Button>
            </div>
            {writingExperience.error !== null && (
              <InlineAlert
                tone="error"
                title="写作方式没有保存"
                description={writingExperience.error}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={restoreSourceTicket !== null}
        onOpenChange={(open) => {
          if (!open && maintenanceBusy !== "restore") setRestoreSourceTicket(null);
        }}
        title="确认恢复本地备份"
        description="所选备份会替换当前作品数据。下一步会先要求保存当前数据的回滚副本；任一步失败都不会提交替换。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={maintenanceBusy === "restore"}
              onClick={() => setRestoreSourceTicket(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={maintenanceBusy === "restore"}
              onClick={() => void confirmDirectRestore()}
            >
              创建回滚备份并恢复
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="恢复后应用会重新载入"
          description="当前尚未保存的界面输入不会随备份恢复，请先保存正在编辑的内容。"
        />
      </Dialog>
    </div>
  );
}

function parseCurrencyAsMicros(value: string): number {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(normalized)) {
    throw new Error("模型价格必须是非负数字，最多保留六位小数。");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("模型价格超出可安全计算的范围。");
  }
  return Number(micros);
}

function formatMicrosStringAsCurrency(value: string): string {
  const micros = BigInt(value);
  const whole = micros / 1_000_000n;
  const fraction = String(micros % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function describeLocalModelCapacity(
  assessment: LocalModelCapacityAssessment,
  capacity: NativeModelCapacityResponse | null,
): string {
  const verdict =
    assessment.reason === "memory_headroom_available"
      ? `内存余量初步通过：模型文件 ${formatBytes(assessment.modelSizeBytes)}，按 1.2 倍保守系数预计至少需要 ${formatBytes(assessment.requiredMemoryBytes)} 可用内存。`
      : assessment.reason === "memory_headroom_insufficient"
        ? `内存余量可能不足：模型文件 ${formatBytes(assessment.modelSizeBytes)}，按 1.2 倍保守系数预计至少需要 ${formatBytes(assessment.requiredMemoryBytes)} 可用内存。`
        : assessment.reason === "model_size_unavailable"
          ? "端点没有提供所选模型的文件大小，无法给出内存余量结论。"
          : "本机物理内存测量不可用，无法给出内存余量结论。";
  const cpu = capacity === null ? "未知" : String(capacity.logicalCpuCount);
  const memory = formatCapacityMetric(capacity?.physicalMemory);
  const disk = formatCapacityMetric(capacity?.applicationDataDisk);
  return `${verdict} 逻辑处理器：${cpu}；物理内存：${memory}；墨影应用数据卷：${disk}。GPU/显存未测量；应用数据卷也不一定是 Ollama 模型存储卷，因此这只是启动前启发式提示，不是性能或可运行性保证。`;
}

function formatCapacityMetric(
  metric: NativeModelCapacityResponse["physicalMemory"] | undefined,
): string {
  if (
    metric?.status !== "measured" ||
    metric.availableBytes === null ||
    metric.totalBytes === null
  ) {
    return "未知";
  }
  return `${formatBytes(metric.availableBytes)} 可用 / ${formatBytes(metric.totalBytes)} 总量`;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return "未知";
  }
  const gibibytes = value / 1024 ** 3;
  return `${gibibytes >= 10 ? gibibytes.toFixed(0) : gibibytes.toFixed(1)} GiB`;
}

function describeAutomaticBackupCheck(
  check: AutomaticBackupRuntimeCheckResult | null,
): Readonly<{ tone: "info" | "warning" | "error"; title: string; description: string }> | null {
  if (check === null) return null;
  if (check.state === "degraded" || check.run === null) {
    return {
      tone: "error",
      title: "自动备份失败",
      description:
        "这次检查没有完成，也没有删除或覆盖现有备份。请先使用下方“创建一致性备份”保存一份副本，再查看脱敏诊断信息。",
    };
  }

  const run = check.run;
  const nextDue = formatAutomaticBackupTime(run.nextDueAt);
  if (run.status === "busy") {
    return {
      tone: "warning",
      title: "另一个墨影窗口正在处理自动备份",
      description: `本窗口没有重复写入。稍后可再次检查；下一计划时间为 ${nextDue}。`,
    };
  }
  if (run.status === "attention" && run.attention !== null) {
    if (run.attention.status === "unknown") {
      return {
        tone: "warning",
        title: "自动备份结果待核对",
        description: `这次备份没有被当作成功，也不会自动覆盖或重试；上一份健康备份仍会保留。建议先创建一份手动备份并查看脱敏诊断信息。下一计划时间为 ${nextDue}。`,
      };
    }
    const reason = describeAutomaticBackupFailure(run.attention.failureKind);
    return {
      tone: run.attention.status === "failed" ? "error" : "warning",
      title: run.attention.status === "failed" ? "自动备份失败" : "自动备份未开始",
      description: `${reason}没有删除、覆盖或自动重试，上一份健康备份仍会保留。下一计划时间为 ${nextDue}。`,
    };
  }
  if (run.createdBackup !== null) {
    const cleanup = run.prunedCount > 0 ? `，并清理了 ${String(run.prunedCount)} 份过期备份` : "";
    return {
      tone: "info",
      title: "今天的自动备份已完成",
      description: `已创建 ${formatBackupBytes(run.createdBackup.byteLength)} 的一致性备份${cleanup}；保留至 ${formatAutomaticBackupTime(run.createdBackup.retentionUntil)}。下一计划时间为 ${nextDue}。`,
    };
  }
  return {
    tone: "info",
    title: "自动备份已完成",
    description: `今天的计划槽位已经处理，受管备份会保留 30 天。下一计划时间为 ${nextDue}。`,
  };
}

function describeAutomaticBackupFailure(failureKind: AutomaticBackupFailureKind): string {
  switch (failureKind) {
    case "database_busy":
      return "本地数据当时正忙，未能在限定时间内取得一致副本。";
    case "database_unavailable":
      return "本地数据当时暂时无法读取。";
    case "disk_full":
      return "可用存储空间不足，无法完成写入。";
    case "permission_denied":
      return "应用没有获得完成备份所需的本地写入权限。";
    case "target_conflict":
      return "目标位置已经存在同名文件，应用没有覆盖它。";
    case "verification_failed":
      return "写入结果没有通过完整性校验，因此未被标记为成功。";
    case "result_unconfirmed":
      return "写入结果无法确认，因此不会被标记为成功。";
    case "write_failed":
      return "本地写入没有完成。";
  }
}

function formatAutomaticBackupTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(date);
}

function formatBackupBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "大小待确认";
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function legacyProviderKind(provider: ModelProviderKind): NativeProviderKind {
  return provider === "ollama" ? "ollama" : "open_ai_compatible";
}

function gatewayProviderKind(provider: ModelProviderKind): NativeGatewayProviderKind {
  const protocol = getModelProviderPreset(provider).protocol;
  return protocol === "openai_compatible" ? "open_ai_compatible" : protocol;
}

function supportsLegacyModelProfile(provider: ModelProviderKind): boolean {
  const protocol = getModelProviderPreset(provider).protocol;
  return (
    provider !== "custom_openai_compatible" &&
    (protocol === "openai_compatible" || protocol === "ollama")
  );
}

function authenticationOptions(
  provider: ModelProviderKind,
): readonly { readonly value: NativeGatewayAuthenticationMode; readonly label: string }[] {
  if (provider === "custom_openai_compatible") {
    return [
      { value: "none", label: "无认证" },
      { value: "bearer_keyring", label: "Bearer（系统凭据库）" },
      { value: "custom_header_keyring", label: "单一自定义认证 Header（系统凭据库）" },
    ];
  }
  if (getModelProviderPreset(provider).credentialRequired) {
    return [{ value: "bearer_keyring", label: "接口访问密钥（系统凭据库）" }];
  }
  return [
    { value: "none", label: "无认证" },
    { value: "bearer_keyring", label: "Bearer（系统凭据库）" },
  ];
}

function expertConnectionInputsAreComplete(
  authentication: NativeGatewayAuthenticationMode,
  credentialHeaderName: string,
  requestTimeoutMs: string,
  retryLimit: string,
): boolean {
  const timeout = Number(requestTimeoutMs);
  const retries = Number(retryLimit);
  return (
    (authentication !== "custom_header_keyring" || credentialHeaderName.trim().length > 0) &&
    Number.isSafeInteger(timeout) &&
    timeout >= MODEL_HUB_MIN_REQUEST_TIMEOUT_MS &&
    timeout <= MODEL_HUB_MAX_REQUEST_TIMEOUT_MS &&
    Number.isSafeInteger(retries) &&
    retries >= 0 &&
    retries <= MODEL_HUB_MAX_RETRY_LIMIT
  );
}

function validateExpertConnectionDraft(
  input: Readonly<{
    provider: ModelProviderKind;
    baseUrl: string;
    region: string;
    workspaceId: string;
    authentication: NativeGatewayAuthenticationMode;
    credentialHeaderName: string;
    modelDiscoveryPath: string;
    textGenerationPath: string;
    embeddingPath: string;
    requestTimeoutMs: string;
    retryLimit: string;
  }>,
): void {
  resolveProviderBaseUrl(input.provider, {
    region: input.region,
    workspaceId: input.workspaceId,
    baseUrlOverride: input.baseUrl,
  });
  const custom = input.provider === "custom_openai_compatible";
  const headerName = normalizeCredentialHeaderName(input.credentialHeaderName);
  const paths = [
    normalizeModelHubApiPath(input.modelDiscoveryPath, "Model discovery path"),
    normalizeModelHubApiPath(input.textGenerationPath, "Text generation path"),
    normalizeModelHubApiPath(input.embeddingPath, "向量检索路径"),
  ];
  if (
    !custom &&
    (input.authentication === "custom_header_keyring" ||
      headerName !== null ||
      paths.some((path) => path !== null))
  ) {
    throw new Error("只有自定义 OpenAI-compatible 连接可以覆盖 API 路径或认证 Header。");
  }
  if ((input.authentication === "custom_header_keyring") !== (headerName !== null)) {
    throw new Error("自定义 Header 认证必须填写且只能填写一个安全的 Header 名称。");
  }
  if (
    getModelProviderPreset(input.provider).credentialRequired &&
    input.authentication !== "bearer_keyring"
  ) {
    throw new Error("这个供应商必须使用系统凭据库中的接口访问密钥。");
  }
  normalizeModelHubRequestTimeoutMs(Number(input.requestTimeoutMs));
  normalizeModelHubRetryLimit(Number(input.retryLimit));
}

function createModelHubId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function settingsTextProbeFormIdentity(form: SettingsTextProbeFormSnapshot): string {
  return JSON.stringify([
    form.providerId,
    form.providerKind,
    form.baseUrl,
    form.region,
    form.workspaceId,
    form.endpointId,
    form.authentication,
    form.credentialHeaderName,
    form.modelDiscoveryPath,
    form.textGenerationPath,
    form.embeddingPath,
    form.requestTimeoutMs,
    form.retryLimit,
    form.selectedModel,
    form.credentialConfigured,
    form.credentialEditRevision,
  ]);
}

function effectiveSettingsTextProbeModelId(
  input: Readonly<{
    automaticDiscovery: boolean;
    endpointModelId: string;
    selectedModelId: string;
  }>,
): string {
  const selectedModelId = input.selectedModelId.normalize("NFKC").trim();
  if (input.automaticDiscovery) return selectedModelId;
  const endpointModelId = input.endpointModelId.normalize("NFKC").trim();
  return endpointModelId.length > 0 ? endpointModelId : selectedModelId;
}

function settingsTextProbeDisclosureChanged(): UiActionError {
  return new UiActionError(
    "MODEL_HUB_PROBE_DISCLOSURE_CHANGED",
    "连接、接入地址、凭据、模型或发送范围已经变化。本次没有发送请求，请重新查看固定验证说明并再次确认。",
    "需要重新确认",
  );
}

async function settingsTextProbeFingerprintFromInput(
  input: SaveModelProviderConnectionInput,
  modelId: string,
): Promise<string> {
  const authentication =
    input.authenticationMode ?? (input.credentialState === "present" ? "bearer_keyring" : "none");
  const endpoint = Object.freeze({
    providerKind: input.providerKind,
    protocol: getModelProviderPreset(input.providerKind).protocol,
    baseUrl: resolveProviderBaseUrl(input.providerKind, {
      region: input.region,
      workspaceId: input.workspaceId,
      baseUrlOverride: input.baseUrlOverride,
    }),
    authentication,
    credentialHeaderName: normalizeCredentialHeaderName(input.credentialHeaderName),
    modelDiscoveryPath: normalizeModelHubApiPath(input.modelDiscoveryPath, "Model discovery path"),
    textGenerationPath: normalizeModelHubApiPath(input.textGenerationPath, "Text generation path"),
    embeddingPath: normalizeModelHubApiPath(input.embeddingPath, "向量检索路径"),
    requestTimeoutMs: normalizeModelHubRequestTimeoutMs(input.requestTimeoutMs),
    persistedRetryLimit: normalizeModelHubRetryLimit(input.retryLimit),
  });
  return settingsTextProbeFingerprint({
    connectionId: input.id,
    connectionDisplayName: input.displayName,
    providerKind: input.providerKind,
    region: normalizeSettingsProbeOptionalText(input.region),
    workspaceId: normalizeSettingsProbeOptionalText(input.workspaceId),
    endpointId: normalizeSettingsProbeOptionalText(input.endpointId),
    endpointFingerprint: await providerActionFingerprint(endpoint),
    authentication,
    credentialState: input.credentialState,
    enabled: input.enabled ?? true,
    modelId,
    dataDestination: isLoopbackModelBaseUrl(endpoint.baseUrl) ? "local" : "remote",
  });
}

async function settingsTextProbeFingerprintFromConnection(
  connection: ModelProviderConnection,
  modelId: string,
): Promise<string> {
  const endpoint = Object.freeze({
    providerKind: connection.providerKind,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    authentication: connection.authenticationMode,
    credentialHeaderName: connection.credentialHeaderName,
    modelDiscoveryPath: connection.modelDiscoveryPath,
    textGenerationPath: connection.textGenerationPath,
    embeddingPath: connection.embeddingPath,
    requestTimeoutMs: connection.requestTimeoutMs,
    persistedRetryLimit: connection.retryLimit,
  });
  return settingsTextProbeFingerprint({
    connectionId: connection.id,
    connectionDisplayName: connection.displayName,
    providerKind: connection.providerKind,
    region: connection.region,
    workspaceId: connection.workspaceId,
    endpointId: connection.endpointId,
    endpointFingerprint: await providerActionFingerprint(endpoint),
    authentication: connection.authenticationMode,
    credentialState: connection.credentialState,
    enabled: connection.enabled,
    modelId,
    dataDestination: isLoopbackModelBaseUrl(connection.baseUrl) ? "local" : "remote",
  });
}

function settingsTextProbeFingerprint(
  target: Readonly<{
    connectionId: string;
    connectionDisplayName: string;
    providerKind: ModelProviderKind;
    region: string | null;
    workspaceId: string | null;
    endpointId: string | null;
    endpointFingerprint: string;
    authentication: NativeGatewayAuthenticationMode;
    credentialState: ModelProviderConnection["credentialState"];
    enabled: boolean;
    modelId: string;
    dataDestination: "local" | "remote";
  }>,
): Promise<string> {
  return providerActionFingerprint({
    schemaVersion: "settings-text-capability-probe-disclosure-v1",
    task: "settings_text_generation_capability_probe",
    probeKind: "fixed_content_free_text_capability",
    connectionId: target.connectionId,
    connectionDisplayName: target.connectionDisplayName,
    providerKind: target.providerKind,
    region: target.region,
    workspaceId: target.workspaceId,
    endpointId: target.endpointId,
    endpointFingerprint: target.endpointFingerprint,
    authentication: target.authentication,
    credentialState: target.credentialState,
    enabled: target.enabled,
    modelId: target.modelId.normalize("NFKC").trim(),
    dataDestination: target.dataDestination,
    dispatchScope: MODEL_HUB_TEXT_CAPABILITY_PROBE_DISPATCH_SCOPE,
    fixedMessages: MODEL_HUB_TEXT_CAPABILITY_PROBE_MESSAGES,
    maximumOutputTokens: MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
    maximumProviderCalls: 1,
    automaticRetryCount: 0,
    estimatedMaximumCostMicros: null,
    currency: null,
  });
}

function normalizeSettingsProbeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length === 0 ? null : normalized;
}

function settingsProbeDispatchIdentity(
  connection: ModelProviderConnection,
  catalogEntry: ModelCatalogEntry,
): string {
  return JSON.stringify([
    modelHubFinalDispatchIdentity({ connection, catalogEntry }),
    connection.region,
    connection.workspaceId,
    connection.endpointId,
  ]);
}

function catalogEntryToDescriptor(catalogEntry: ModelCatalogEntry): NativeModelDescriptor {
  return Object.freeze({
    id: catalogEntry.providerModelId,
    displayName: catalogEntry.displayName,
    sizeBytes: null,
  });
}

function qwenRegionOptions(): readonly { readonly value: string; readonly label: string }[] {
  return (
    getModelProviderPreset("alibaba_qwen").basicFields.find(({ key }) => key === "region")
      ?.options ?? []
  );
}

function qwenRegionNeedsWorkspace(region: string): boolean {
  return ["japan_tokyo", "germany_frankfurt"].includes(region);
}

function qwenRegionShowsWorkspace(region: string): boolean {
  return ["china_beijing", "singapore", "japan_tokyo", "germany_frankfurt"].includes(region);
}

function resolveQwenBaseUrl(region: string, workspaceId: string): string {
  try {
    return resolveProviderBaseUrl("alibaba_qwen", { region, workspaceId });
  } catch {
    return "";
  }
}

function connectionStatusLabel(status: ModelProviderConnection["connectionStatus"]): string {
  const labels: Record<ModelProviderConnection["connectionStatus"], string> = {
    not_tested: "尚未测试",
    checking: "正在检查",
    ready: "已连接",
    degraded: "部分能力可用",
    error: "连接失败",
    disabled: "已停用",
  };
  return labels[status];
}

function isCredentialDeletedConnection(connection: ModelProviderConnection): boolean {
  return (
    !connection.enabled &&
    !isRetiredModelProviderConnection(connection) &&
    connection.connectionStatus === "disabled" &&
    connection.credentialRef === null &&
    connection.credentialState === "missing"
  );
}

function connectionManagementLabel(connection: ModelProviderConnection): string {
  if (isRetiredModelProviderConnection(connection)) return "已退役";
  if (isCredentialDeletedConnection(connection)) return "凭据已删除 · 可重新绑定";
  if (!connection.enabled) return "已停用";
  return connectionStatusLabel(connection.connectionStatus);
}

function nextAvailableProviderConnectionId(
  providerKind: ConnectableProviderKind,
  connections: readonly ModelProviderConnection[],
): string {
  const base = providerKind === "custom_openai_compatible" ? "custom-provider" : providerKind;
  const occupied = new Set(connections.map(({ id }) => id));
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID()}`;
}

function connectionEndpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "自定义端点";
  }
}

function modelProbeDestinationDisclosure(
  providerKind: ConnectableProviderKind,
  input: Readonly<{ region: string; workspaceId: string; baseUrl: string }>,
): string {
  try {
    const resolved = resolveProviderBaseUrl(providerKind, {
      region: input.region,
      workspaceId: input.workspaceId,
      baseUrlOverride: input.baseUrl,
    });
    return isLoopbackModelBaseUrl(resolved) ? "请求只在本机运行。" : "请求会发送到所选远程供应商。";
  } catch {
    return "当前接入地址尚未通过校验；修正前不会发送请求。";
  }
}

function catalogEntryLabel(
  catalogEntry: ModelCatalogEntry,
  connections: readonly ModelProviderConnection[],
): string {
  const connection = connections.find(({ id }) => id === catalogEntry.connectionId);
  const providerName =
    connection === undefined
      ? catalogEntry.connectionId
      : getModelProviderPreset(connection.providerKind).displayName;
  return `${providerName} · ${catalogEntry.displayName}`;
}

function removeLegacyTemperature(
  policy: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = { ...policy };
  delete sanitized.temperature;
  return Object.freeze(sanitized);
}

function rerankParameterPolicy(
  policy: Readonly<Record<string, unknown>>,
  task: NovelAiTask,
  remoteContentConsent: boolean,
): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = { ...policy };
  if (task === "rerank" && remoteContentConsent) {
    sanitized.remoteContentConsent = true;
  } else {
    delete sanitized.remoteContentConsent;
  }
  return Object.freeze(sanitized);
}

async function loadEvidenceConfirmedLocalCatalogIds(
  modelHub: ModelHubStore,
  catalog: readonly ModelCatalogEntry[],
): Promise<readonly string[]> {
  const profiles = await Promise.all(
    catalog.map((entry) => modelHub.findCostPrivacyProfile(entry.id)),
  );
  return Object.freeze(
    catalog.flatMap((entry, index) => {
      const profile = profiles[index];
      return profile?.dataDestination === "local" && profile.evidenceSource !== "unknown"
        ? [entry.id]
        : [];
    }),
  );
}

function modelHubCapabilityLabel(capability: ModelHubCapability): string {
  const labels: Record<ModelHubCapability, string> = {
    text_generation: "文本生成",
    reasoning: "推理",
    structured_output: "结构化输出",
    embedding: "向量检索",
    rerank: "结果排序",
    image_generation: "图片生成",
    vision: "图片理解",
    translation: "翻译",
    tool_calling: "工具调用",
    token_counting: "内容额度计数",
    streaming: "流式输出",
    long_context: "长上下文",
  };
  return labels[capability];
}

function selectableModelSupportLabel(
  support: SelectableModelCatalogProjection["appSupport"],
): string {
  if (support === "routable_after_verification") return "连接后验证";
  if (support === "special_connection_required") return "需要专用连接方式";
  if (support === "protocol_not_implemented") return "当前应用协议尚未实现";
  return "连接供应商后从账户目录发现";
}

function selectableModelRegionLabel(
  region: SelectableModelCatalogProjection["regionGroup"],
): string {
  if (region === "DOMESTIC") return "国内";
  if (region === "INTERNATIONAL") return "海外";
  return "本地";
}

function connectedModelRegionLabel(providerKind: ModelProviderKind): string {
  if (providerKind === "ollama") return "本机或自托管";
  if (
    providerKind === "deepseek" ||
    providerKind === "zhipu_glm" ||
    providerKind === "alibaba_qwen" ||
    providerKind === "volcengine_doubao"
  ) {
    return "国内";
  }
  if (providerKind === "custom_openai_compatible") return "自定义位置";
  return "海外";
}

function connectedModelRegionGroup(
  connection: ModelProviderConnection,
): SelectableModelCatalogProjection["regionGroup"] {
  if (isLoopbackModelBaseUrl(connection.baseUrl)) return "LOCAL";
  if (
    connection.providerKind === "deepseek" ||
    connection.providerKind === "zhipu_glm" ||
    connection.providerKind === "alibaba_qwen" ||
    connection.providerKind === "volcengine_doubao"
  ) {
    return "DOMESTIC";
  }
  return "INTERNATIONAL";
}

function modelHubOverallBadgeLabel(
  state: ReturnType<typeof buildModelHubRoutingVisibility>["state"],
): string {
  const labels = {
    unconnected: "AI 未连接",
    validating: "正在验证",
    writing_ready: "基础配置可用",
    partial: "部分基础配置需完善",
    complete: "基础配置完整",
    anomaly: "连接或分工异常",
    save_failed: "配置写入失败",
  } as const;
  return labels[state];
}

function modelHubOverallBadgeTone(
  state: ReturnType<typeof buildModelHubRoutingVisibility>["state"],
): "neutral" | "info" | "success" | "warning" | "danger" {
  if (state === "complete" || state === "writing_ready") return "success";
  if (state === "validating") return "info";
  if (state === "partial") return "warning";
  if (state === "anomaly" || state === "save_failed") return "danger";
  return "neutral";
}

function modelHubOverallAlertTone(
  state: ReturnType<typeof buildModelHubRoutingVisibility>["state"],
): "info" | "warning" | "error" {
  if (state === "anomaly" || state === "save_failed") return "error";
  if (state === "partial") return "warning";
  return "info";
}

function modelHubOverallTitle(
  state: ReturnType<typeof buildModelHubRoutingVisibility>["state"],
): string {
  const titles = {
    unconnected: "AI 尚未连接",
    validating: "正在验证 AI 连接与能力",
    writing_ready: "AI 基础配置已可用",
    partial: "部分 AI 基础配置可用",
    complete: "AI 基础配置已完整",
    anomaly: "AI 连接或分工需要修复",
    save_failed: "AI 分工没有保存",
  } as const;
  return titles[state];
}

function modelHubOverallDescription(
  visibility: ReturnType<typeof buildModelHubRoutingVisibility>,
): string {
  if (visibility.state === "unconnected") {
    return "连接并验证一个文本生成模型后即可开始 AI 写作；没有 AI 时仍可手动创作。";
  }
  if (visibility.state === "validating") {
    return "正在读取连接、模型目录和能力证据；完成前不会把未知能力当作可用。";
  }
  if (visibility.state === "save_failed") {
    return "新的分工没有确认保存。请查看上方回读结果后重试或导出脱敏诊断。";
  }
  if (visibility.state === "anomaly") {
    return "连接、模型目录、能力证据或已保存分工存在失效项；手动写作和已有正文不会受影响。";
  }
  if (visibility.state === "complete") {
    return "22 项小说任务均已通过无正文的基础配置检查；当前章节仍会在发送前检查隐私、上下文与请求长度。";
  }
  if (visibility.coreWritingReady) {
    return `开书、正文生成、续写、改写和润色的基础配置已通过；${String(
      visibility.missingRouteCount,
    )} 项高级能力尚未配置。实际请求仍需通过当前作品预检。`;
  }
  return `${String(visibility.enabledRouteCount)} 项任务已配置；基础写作链仍有缺口，请按下方建议验证所需能力。`;
}

function modelHubPrivacyPolicyLabel(policy: string | null | undefined): string {
  if (policy === null || policy === undefined) return "未配置";
  const labels = Object.freeze({
    cloud_allowed: "允许使用云端模型",
    local_preferred: "优先使用本机模型",
    local_only: "只使用本机模型",
  }) satisfies Readonly<Record<ModelHubPrivacyPolicy, string>>;
  return policy in labels ? labels[policy as ModelHubPrivacyPolicy] : "隐私策略未知";
}

function costPrivacyEvidenceSourceLabel(source: string | null | undefined): string {
  if (source === null || source === undefined) return "没有证据";
  const labels = Object.freeze({
    provider_metadata: "供应商目录",
    official_preset: "官方预设",
    provider_policy: "供应商政策",
    user_confirmed: "用户确认",
    legacy: "旧版迁移",
    unknown: "来源未知",
  }) satisfies Readonly<Record<ModelCostPrivacyProfile["evidenceSource"], string>>;
  return source in labels
    ? labels[source as ModelCostPrivacyProfile["evidenceSource"]]
    : "来源未知";
}

function capabilityDisplayStateLabel(state: string): string {
  const labels: Readonly<Record<ModelHubCapabilityDisplayState, string>> = Object.freeze({
    verified: "已实测",
    catalog_declared: "目录或官方资料声明",
    user_confirmed: "由用户确认，尚未实测",
    unknown: "未知",
    failed: "验证失败",
    ambiguous: "结果待核对",
    unsupported: "明确不支持",
  });
  return state in labels ? labels[state as ModelHubCapabilityDisplayState] : "状态未知";
}

function isCapabilityProbeResultAmbiguous(
  normalizedCode: string,
  invocation: ModelInvocationFact | null,
): boolean {
  return (
    normalizedCode === "PROVIDER_RESULT_AMBIGUOUS" ||
    (invocation?.task === "capability_probe" &&
      invocation.status === "timed_out" &&
      invocation.providerDispatchStartedAt !== null)
  );
}

function capabilityEvidenceSourceLabel(source: string | null): string {
  if (source === null) return "没有证据";
  const labels: Readonly<Record<ModelCapabilityEvidence["evidenceSource"], string>> = Object.freeze(
    {
      lightweight_probe: "轻量实测",
      provider_metadata: "供应商目录",
      official_preset: "官方预设",
      user_confirmed: "用户确认",
      legacy: "旧版迁移",
    },
  );
  return source in labels
    ? labels[source as ModelCapabilityEvidence["evidenceSource"]]
    : "证据来源未知";
}

function capabilityFailureLabel(code: string): string {
  if (code === "PROVIDER_RESULT_AMBIGUOUS") {
    return "调用结果无法确认，系统不会自动重发";
  }
  return code === "MODEL_OUTPUT_TRUNCATED"
    ? "最近一次验证未返回完整可见内容"
    : "最近一次验证未通过";
}

function routeOriginLabel(origin: NovelTaskRoute["routeOrigin"]): string {
  const labels: Readonly<Record<NovelTaskRoute["routeOrigin"], string>> = Object.freeze({
    automatic: "智能推荐",
    user: "手动设置",
    legacy: "旧版兼容",
  });
  return labels[origin];
}

function formatVerificationTime(value: string | null): string {
  if (value === null) return "尚未验证";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function routeSnapshotsMatch(
  left: readonly NovelTaskRoute[],
  right: readonly NovelTaskRoute[],
): boolean {
  const snapshot = (routes: readonly NovelTaskRoute[]) =>
    routes
      .map((route) => ({
        task: route.task,
        primaryCatalogEntryId: route.primaryCatalogEntryId,
        fallbackCatalogEntryId: route.fallbackCatalogEntryId,
        presetId: route.presetId,
        parameterPolicy: route.parameterPolicy,
        maximumCostMicros: route.maximumCostMicros,
        currency: route.currency,
        privacyPolicy: route.privacyPolicy,
        failurePolicy: route.failurePolicy,
        routeOrigin: route.routeOrigin,
        enabled: route.enabled,
        revision: route.revision,
      }))
      .sort((first, second) => first.task.localeCompare(second.task));
  return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}

function novelAiTaskLabel(task: NovelAiTask): string {
  const labels: Record<NovelAiTask, string> = {
    idea_discussion: "灵感讨论",
    book_start_guidance: "开书引导",
    prose_generation: "正文生成",
    continuation: "续写",
    rewrite: "改写",
    polish: "润色",
    outline_planning: "大纲规划",
    scene_breakdown: "场景拆解",
    chapter_summary: "章节摘要",
    long_memory_compression: "长期记忆压缩",
    character_extraction: "人物提取",
    world_extraction: "世界设定提取",
    contradiction_check: "矛盾检查",
    pov_check: "POV 检查",
    character_voice_check: "人物声纹检查",
    content_quality_check: "内容质量复核",
    what_if_simulation: "剧情试演",
    embedding: "语义记忆",
    rerank: "检索重排",
    image_generation: "图片生成",
    vision_understanding: "图片理解",
    translation: "翻译",
  };
  return labels[task];
}

function inferModelHubScheme(routes: readonly ModelRoleRoute[]): ModelHubScheme {
  if (routes.some(({ role }) => role === "local_private")) {
    return "local_privacy";
  }
  const roles = new Set(routes.map(({ role }) => role));
  if (roles.has("fast") && roles.has("high_quality") && roles.has("validation")) {
    return "smart";
  }
  if (roles.has("high_quality") && roles.has("validation")) {
    return "quality";
  }
  if (roles.has("fast")) {
    return "economy";
  }
  return routes.length === 0 ? "smart" : "custom";
}

function modelRouteRoleLabel(role: ModelRouteRole): string {
  const labels: Record<ModelRouteRole, string> = {
    fast: "快速",
    high_quality: "高质量",
    long_context: "长上下文",
    embedding: "向量检索",
    validation: "检查",
    translation: "翻译",
    local_private: "本地隐私",
  };
  return labels[role];
}
