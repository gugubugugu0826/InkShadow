import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Link, useLocation } from "react-router-dom";

import { useAppearancePreference } from "../appearance-preference";
import { DataTransferPanel } from "../components/data-transfer-panel";
import { ModelHubEvaluationPanel } from "../components/model-hub-evaluation-panel";
import { ModelHubImageGenerationPanel } from "../components/model-hub-image-generation-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import { collectDesktopDiagnosticArtifact } from "../infrastructure/diagnostics";
import type { AutomaticBackupRuntimeCheckResult } from "../infrastructure/automatic-backup-runtime";
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
  modelHubCredentialProviderId,
  modelHubCredentialRef,
  modelHubNativeEndpointConfig,
} from "../infrastructure/model-hub-native-config";
import { retireModelHubConnection } from "../infrastructure/model-hub-connection-retirement-service";
import {
  deleteModelHubCredential,
  saveModelHubCredential,
} from "../infrastructure/model-hub-credential-mutation-service";
import {
  MODEL_HUB_READINESS_CHANGED_EVENT,
  MODEL_HUB_STATE_EXPLANATIONS,
  USER_FACING_MODEL_HUB_STATES,
  projectModelHubReadiness,
} from "../infrastructure/model-hub-readiness";
import { applyAutomaticModelHubRouting } from "../infrastructure/model-hub-routing-service";
import { bridgeLegacyModelProfilesToModelHub } from "../infrastructure/model-hub-legacy-bridge";
import { ModelHubLocalEvaluationService } from "../infrastructure/model-hub-local-evaluation-service";
import {
  assertModelHubFinalDispatchUnchanged,
  ModelHubFinalDispatchError,
  modelHubFinalDispatchIdentity,
} from "../infrastructure/model-hub-final-dispatch-guard";
import {
  isRetiredModelProviderConnection,
  ModelHubStoreError,
  type ModelCatalogEntry,
  type ModelCostPrivacyProfile,
  type ModelHubPrivacyPolicy,
  type ModelHubStore,
  type ModelProviderConnection,
  type NovelTaskRoute,
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
import { normalizeUiError } from "../infrastructure/ui-error";
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
    title: "Model Hub · 连接与模型",
    navigationLabel: "连接与模型",
    description: "连接供应商、验证凭据、发现模型，并确认模型真正可用的能力。",
  }),
  "model-routing": Object.freeze({
    title: "Model Hub · AI 分工",
    navigationLabel: "AI 分工",
    description: "为写作、规划、记忆和检查选择主模型、备用模型与隐私边界。",
  }),
  "model-evaluation": Object.freeze({
    title: "Model Hub · 模型评测",
    navigationLabel: "模型评测",
    description: "用本地评测证据比较模型表现；评测不会替代真实连接状态。",
  }),
  "image-generation": Object.freeze({
    title: "Model Hub · 图片生成",
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

export function SettingsPage() {
  const runtime = useRuntime();
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
  const activeModelHubSection = resolveModelHubSection(location.hash);
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
  const [summary, setSummary] = useState<SecretSummary>({
    configured: false,
    lastFour: null,
  });
  const [profiles, setProfiles] = useState<readonly ModelProfile[]>([]);
  const [, setProfile] = useState<ModelProfile | null>(null);
  const [hubConnections, setHubConnections] = useState<readonly ModelProviderConnection[]>([]);
  const [hubConnection, setHubConnection] = useState<ModelProviderConnection | null>(null);
  const [hubCatalog, setHubCatalog] = useState<readonly ModelCatalogEntry[]>([]);
  const [routingCatalog, setRoutingCatalog] = useState<readonly ModelCatalogEntry[]>([]);
  const [localCatalogEntryIds, setLocalCatalogEntryIds] = useState<readonly string[]>([]);
  const [novelTaskRoutes, setNovelTaskRoutes] = useState<readonly NovelTaskRoute[]>([]);
  const [novelTaskRouteCount, setNovelTaskRouteCount] = useState(0);
  const [roleRoutes, setRoleRoutes] = useState<readonly ModelRoleRoute[]>([]);
  const [providerPreset, setProviderPreset] = useState<ConnectableProviderKind>("openai");
  const [expertMode, setExpertMode] = useState(false);
  const [modelHubScheme, setModelHubScheme] = useState<ModelHubScheme>("smart");
  const [schemeSaving, setSchemeSaving] = useState(false);
  const [schemeMessage, setSchemeMessage] = useState<string | null>(null);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [routeRole, setRouteRole] = useState<ModelRouteRole>("high_quality");
  const [routePrimaryProviderId, setRoutePrimaryProviderId] = useState("");
  const [routeFallbackProviderId, setRouteFallbackProviderId] = useState("");
  const [routeSaving, setRouteSaving] = useState(false);
  const [routeError, setRouteError] = useState<unknown>(null);
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

  const loadModelCenter = useCallback(async () => {
    setLoading(true);
    try {
      await bridgeLegacyModelProfilesToModelHub({
        modelCenter: runtime.modelCenter,
        modelHub: runtime.modelHub,
        credentials: runtime.credentials,
        clock: runtime.clock,
      });
      const [storedConnections, storedProfiles, storedRoutes, storedNovelRoutes, activePreset] =
        await Promise.all([
          runtime.modelHub.listConnections(),
          runtime.modelCenter.listProfiles(),
          runtime.modelRouting.listRoutes(),
          Promise.all(NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task))),
          runtime.modelHub.findActivePreset(),
        ]);
      const selectedConnection = storedConnections[0] ?? null;
      const selectedProfile =
        storedProfiles.find(({ providerId: id }) => id === selectedConnection?.id) ?? null;
      const catalog =
        selectedConnection === null
          ? []
          : await runtime.modelHub.listCatalog(selectedConnection.id);
      const allCatalogEntries = (
        await Promise.all(
          storedConnections.map((connection) => runtime.modelHub.listCatalog(connection.id)),
        )
      ).flat();
      const confirmedLocalIds = await loadEvidenceConfirmedLocalCatalogIds(
        runtime.modelHub,
        allCatalogEntries,
      );
      const persistedNovelRoutes = storedNovelRoutes.filter(
        (route): route is NovelTaskRoute => route !== null,
      );
      const proseRoute = storedNovelRoutes.find((route) => route?.task === "prose_generation");
      const selectedCatalogEntry =
        catalog.find(({ id }) => id === proseRoute?.primaryCatalogEntryId) ??
        catalog.find(({ availability }) => availability === "available") ??
        null;
      const [costPrivacy, capabilities] =
        selectedCatalogEntry === null
          ? [null, []]
          : await Promise.all([
              runtime.modelHub.findCostPrivacyProfile(selectedCatalogEntry.id),
              runtime.modelHub.listCapabilityEvidence(selectedCatalogEntry.id),
            ]);
      setHubConnections(storedConnections);
      setHubConnection(selectedConnection);
      setHubCatalog(catalog);
      setRoutingCatalog(allCatalogEntries);
      setLocalCatalogEntryIds(confirmedLocalIds);
      setNovelTaskRoutes(persistedNovelRoutes);
      setProfiles(storedProfiles);
      setRoleRoutes(storedRoutes);
      setNovelTaskRouteCount(persistedNovelRoutes.length);
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
      setModelHubScheme(activePreset?.scheme ?? inferModelHubScheme(storedRoutes));
      const selectedRoute = storedRoutes.find(({ role }) => role === "high_quality");
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
      setSelectedModel(selectedCatalogEntry?.providerModelId ?? "");
      applyHubModelToForm(selectedCatalogEntry, costPrivacy);
      setConfirmedCapabilities(
        capabilities
          .filter(
            ({ evidenceSource, verdict, expiresAt }) =>
              evidenceSource === "user_confirmed" &&
              verdict === "supported" &&
              (expiresAt === null || expiresAt > new Date().toISOString()),
          )
          .map(({ capability }) => capability),
      );
      setModels(catalog.map(catalogEntryToDescriptor));
      setConnection(null);
      setConnectionChecked(false);
      setModelCapacity(null);
      setSummary(
        runtime.mode === "tauri"
          ? await runtime.credentials.getSummary(
              selectedConnection === null
                ? DEFAULT_OPENAI_PROFILE.providerId
                : modelHubCredentialProviderId(selectedConnection),
            )
          : { configured: false, lastFour: null },
      );
      setCredentialError(null);
      setCapabilityProbeError(null);
      setCapabilityProbeMessage(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
    } finally {
      setLoading(false);
    }
  }, [applyHubModelToForm, runtime]);

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
    void Promise.resolve().then(loadModelCenter);
    if (runtime.maintenance !== null) {
      void Promise.resolve().then(inspectDatabase);
    }
    if (runtime.automaticBackup !== null) {
      void Promise.resolve().then(checkAutomaticBackup);
    }
  }, [checkAutomaticBackup, inspectDatabase, loadModelCenter, runtime]);

  useEffect(() => {
    if (!isModelHubView) {
      void Promise.resolve().then(loadMemoryProjects);
    }
  }, [isModelHubView, loadMemoryProjects]);

  useEffect(() => {
    const targetId = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    if (targetId.length === 0) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const target = document.getElementById(targetId);
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
  }, [location.hash]);

  async function selectStoredProfile(providerIdValue: string): Promise<void> {
    const selected = hubConnections.find((candidate) => candidate.id === providerIdValue);
    if (selected === undefined) {
      return;
    }
    const catalog = await runtime.modelHub.listCatalog(selected.id);
    const selectedCatalogEntry =
      catalog.find(({ availability }) => availability === "available") ?? null;
    const [costPrivacy, capabilities] =
      selectedCatalogEntry === null
        ? [null, []]
        : await Promise.all([
            runtime.modelHub.findCostPrivacyProfile(selectedCatalogEntry.id),
            runtime.modelHub.listCapabilityEvidence(selectedCatalogEntry.id),
          ]);
    const legacyProfile = profiles.find(({ providerId: id }) => id === selected.id) ?? null;
    setHubConnection(selected);
    setHubCatalog(catalog);
    setProfile(legacyProfile);
    setProviderPreset(selected.providerKind);
    setProviderId(selected.id);
    setProvider(legacyProviderKind(selected.providerKind));
    setBaseUrl(selected.baseUrl);
    setRegion(selected.region ?? "china_beijing");
    setWorkspaceId(selected.workspaceId ?? "");
    setEndpointId(selected.endpointId ?? "");
    setAuthentication(selected.authenticationMode);
    setCredentialHeaderName(selected.credentialHeaderName ?? "");
    setModelDiscoveryPath(selected.modelDiscoveryPath ?? "");
    setTextGenerationPath(selected.textGenerationPath ?? "");
    setEmbeddingPath(selected.embeddingPath ?? "");
    setRequestTimeoutMs(String(selected.requestTimeoutMs));
    setRetryLimit(String(selected.retryLimit));
    setSelectedModel(selectedCatalogEntry?.providerModelId ?? "");
    applyHubModelToForm(selectedCatalogEntry, costPrivacy);
    setConfirmedCapabilities(
      capabilities
        .filter(
          ({ evidenceSource, verdict }) =>
            evidenceSource === "user_confirmed" && verdict === "supported",
        )
        .map(({ capability }) => capability),
    );
    setModels(catalog.map(catalogEntryToDescriptor));
    setConnection(null);
    setConnectionChecked(false);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
    setModelCapacity(null);
    setSecret("");
    try {
      setSummary(
        runtime.mode === "tauri"
          ? await runtime.credentials.getSummary(modelHubCredentialProviderId(selected))
          : { configured: false, lastFour: null },
      );
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
    }
  }

  async function selectCatalogModel(providerModelId: string): Promise<void> {
    setSelectedModel(providerModelId);
    const catalogEntry = hubCatalog.find(
      (candidate) => candidate.providerModelId === providerModelId,
    );
    if (catalogEntry === undefined) {
      setConfirmedCapabilities([]);
      return;
    }
    const [costPrivacy, capabilities] = await Promise.all([
      runtime.modelHub.findCostPrivacyProfile(catalogEntry.id),
      runtime.modelHub.listCapabilityEvidence(catalogEntry.id),
    ]);
    applyHubModelToForm(catalogEntry, costPrivacy);
    setConfirmedCapabilities(
      capabilities
        .filter(
          ({ evidenceSource, verdict }) =>
            evidenceSource === "user_confirmed" && verdict === "supported",
        )
        .map(({ capability }) => capability),
    );
  }

  function applyProviderPreset(nextProvider: ConnectableProviderKind): void {
    const preset = getModelProviderPreset(nextProvider);
    const nativeProvider = legacyProviderKind(nextProvider);
    const nextBaseUrl =
      nextProvider === "custom_openai_compatible" ? "" : resolveProviderBaseUrl(nextProvider);
    setProviderPreset(nextProvider);
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
    setProviderId(nextProvider === "custom_openai_compatible" ? "custom-provider" : nextProvider);
    setBaseUrl(nextBaseUrl);
    setAuthentication(preset.credentialRequired ? "bearer_keyring" : "none");
    setSummary({ configured: false, lastFour: null });
    setSchemeMessage(null);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
  }

  async function modelHubConnectionInput(
    credentialConfigured = summary.configured,
    authenticationOverride: NativeGatewayAuthenticationMode = authentication,
  ): Promise<SaveModelProviderConnectionInput> {
    const existing = await findOwnedConnectionTarget();
    const resolvedBaseUrl = resolveProviderBaseUrl(providerPreset, {
      region,
      workspaceId,
      baseUrlOverride: baseUrl,
    });
    return {
      id: providerId,
      providerKind: providerPreset,
      displayName: getModelProviderPreset(providerPreset).displayName,
      region: region.trim().length === 0 ? null : region,
      workspaceId: workspaceId.trim().length === 0 ? null : workspaceId,
      endpointId: endpointId.trim().length === 0 ? null : endpointId,
      baseUrlOverride: resolvedBaseUrl,
      credentialRef:
        credentialConfigured && authenticationOverride !== "none"
          ? (existing?.credentialRef ?? modelHubCredentialRef(providerId))
          : null,
      credentialState:
        credentialConfigured && authenticationOverride !== "none" ? "present" : "missing",
      authenticationMode: authenticationOverride,
      credentialHeaderName:
        providerPreset === "custom_openai_compatible" &&
        authenticationOverride === "custom_header_keyring"
          ? credentialHeaderName
          : null,
      modelDiscoveryPath: providerPreset === "custom_openai_compatible" ? modelDiscoveryPath : null,
      textGenerationPath: providerPreset === "custom_openai_compatible" ? textGenerationPath : null,
      embeddingPath: providerPreset === "custom_openai_compatible" ? embeddingPath : null,
      requestTimeoutMs: Number(requestTimeoutMs),
      retryLimit: Number(retryLimit),
      enabled: authenticationOverride === "none" || credentialConfigured,
      expectedRevision: existing?.revision ?? null,
    };
  }

  async function persistModelHubConnection(
    credentialConfigured = summary.configured,
    authenticationOverride: NativeGatewayAuthenticationMode = authentication,
  ): Promise<ModelProviderConnection> {
    return runtime.modelHub.saveConnection(
      await modelHubConnectionInput(credentialConfigured, authenticationOverride),
    );
  }

  function assertConnectionTargetIsOwned(existingConnection: ModelProviderConnection | null): void {
    if (existingConnection !== null && existingConnection.providerKind !== providerPreset) {
      throw new ModelHubStoreError(
        "MODEL_HUB_PROVIDER_KIND_IMMUTABLE",
        "这个配置标识已经属于另一家供应商。请使用新的配置标识，原配置和凭据不会被覆盖。",
      );
    }
    if (existingConnection !== null && hubConnection?.id !== existingConnection.id) {
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
    setSaving(true);
    try {
      const savedConnection = await persistModelHubConnection();
      const pricing = buildPricingProfile();
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
          pricing: savedConnection.enabled ? pricing : null,
          expectedRevision: existingLegacyProfile?.revision ?? null,
        });
      }

      const [nextConnections, nextProfiles] = await Promise.all([
        runtime.modelHub.listConnections(),
        runtime.modelCenter.listProfiles(),
      ]);
      setHubConnections(nextConnections);
      setHubConnection(
        nextConnections.find(({ id }) => id === savedConnection.id) ?? savedConnection,
      );
      setHubCatalog(nextCatalog);
      await refreshRoutingCatalogState(nextConnections);
      setProfiles(nextProfiles);
      setProfile(savedLegacyProfile);
      setProviderId(savedConnection.id);
      setBaseUrl(savedConnection.baseUrl);
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
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
  }

  async function saveModelRoleRoute(): Promise<void> {
    const existing = roleRoutes.find(({ role }) => role === routeRole);
    setRouteSaving(true);
    setRouteError(null);
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
  }

  async function saveNovelTaskRoute(): Promise<void> {
    const existing = novelTaskRoutes.find(({ task }) => task === novelRouteTask);
    const fallbackCatalogEntryId =
      novelRouteFallbackCatalogId.trim().length === 0 ? null : novelRouteFallbackCatalogId;
    setRouteSaving(true);
    setRouteError(null);
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
      setNovelTaskRouteCount(persisted.length);
      setModelHubScheme("custom");
      setNovelRoutePrimaryCatalogId(saved.primaryCatalogEntryId);
      setNovelRouteFallbackCatalogId(saved.fallbackCatalogEntryId ?? "");
      setNovelRouteFailure(saved.failurePolicy);
      setSchemeMessage(`已保存“${novelAiTaskLabel(saved.task)}”的自定义分工。`);
    } catch (cause: unknown) {
      setRouteError(cause);
    } finally {
      setRouteSaving(false);
    }
  }

  function buildPricingProfile(): ModelPricingProfile | null {
    if (selectedModel.trim().length === 0) {
      return null;
    }
    const pricingFields = [
      contextWindowTokens,
      inputPricePerMillion,
      outputPricePerMillion,
      cachedInputPricePerMillion,
      pricingVersion,
      priceUpdatedDate,
    ];
    if (pricingFields.every((value) => value.trim().length === 0)) {
      return null;
    }
    const parsedContext = Number(contextWindowTokens);
    if (
      !Number.isSafeInteger(parsedContext) ||
      parsedContext < 1 ||
      pricingVersion.trim().length === 0 ||
      priceUpdatedDate.length === 0
    ) {
      throw new Error("请填写有效的上下文窗口、价格版本和价格更新日期。");
    }
    return {
      contextWindowTokens: parsedContext,
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
    setLocalCatalogEntryIds(await loadEvidenceConfirmedLocalCatalogIds(runtime.modelHub, entries));
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

  async function performLightweightTextProbe(
    savedConnection: ModelProviderConnection,
    catalogEntry: ModelCatalogEntry,
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
    const startedAt = Date.now();
    const probeObservation = { streamed: false };
    const expectedDispatchIdentity = settingsProbeDispatchIdentity(savedConnection, catalogEntry);
    try {
      const current = await readAuthoritativeProbeTarget(savedConnection.id, catalogEntry.id);
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        settingsProbeDispatchIdentity(current.connection, current.entry),
      );
      const result = await runtime.modelGateway.generate({
        dispatchScope: { kind: "non_project", reason: "connection_probe" },
        generationId: createModelHubId("capability-probe"),
        config: modelHubNativeEndpointConfig(current.connection),
        model: current.entry.providerModelId,
        messages: [{ role: "user", content: "只回复：OK" }],
        maxOutputTokens: 8,
        onDelta: (text) => {
          if (text.trim().length > 0) {
            probeObservation.streamed = true;
          }
        },
      });
      if (result.text.trim().length === 0) {
        throw new Error("模型已连接，但没有返回可用文字。请检查模型或接入点是否支持文本生成。");
      }
      const verified = await readAuthoritativeProbeTarget(savedConnection.id, catalogEntry.id);
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        settingsProbeDispatchIdentity(verified.connection, verified.entry),
      );
      const committed = await runtime.modelHub.commitCapabilityProbeResult({
        connectionId: savedConnection.id,
        expectedConnectionRevision: savedConnection.revision,
        catalogEntryId: catalogEntry.id,
        expectedCatalogRevision: catalogEntry.revision,
        expectedProviderModelId: catalogEntry.providerModelId,
        scan: {
          scanId,
          catalogEntryId: verified.entry.id,
          scanKind: "lightweight_probe",
          status: "succeeded",
          evidenceVersion,
          evidence: [
            {
              id: createModelHubId("capability"),
              capability: "text_generation",
              verdict: "supported",
              evidenceSource: "lightweight_probe",
              evidenceSummary: "固定短文本探测成功；未保存探测输入或模型输出。",
            },
            ...(probeObservation.streamed
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
        },
        ...(updateConnectionStatus ? { connectionTest: { status: "ready" as const } } : {}),
      });
      return Object.freeze({
        streamed: probeObservation.streamed,
        latencyMs: Math.max(0, Date.now() - startedAt),
        connection: committed.connection,
        catalog: verified.catalog,
        entry: verified.entry,
      });
    } catch (cause: unknown) {
      const normalized = normalizeUiError(cause);
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
            scanKind: "lightweight_probe",
            status: "failed",
            evidenceVersion,
            errorCode: normalized.code,
            errorSummary: normalized.description,
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
          throw new ModelHubFinalDispatchError();
        }
        throw commitCause;
      }
      throw cause;
    }
  }

  async function probeSelectedModelCapability(): Promise<void> {
    if (!runtime.modelGateway.available || selectedModel.trim().length === 0) {
      return;
    }
    setProbingCapability(true);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
    try {
      const savedConnection = await persistModelHubConnection();
      const target = await ensureCatalogEntryForModel(savedConnection, selectedModel);
      const result = await performLightweightTextProbe(target.connection, target.entry);
      setHubCatalog(result.catalog);
      setModels(result.catalog.map(catalogEntryToDescriptor));
      const nextConnections = await runtime.modelHub.listConnections();
      setHubConnections(nextConnections);
      await refreshRoutingCatalogState(nextConnections);
      setCapabilityProbeMessage(
        result.streamed
          ? `已验证“${result.entry.displayName}”可生成文字并支持流式返回。`
          : `已验证“${result.entry.displayName}”可生成文字；本次没有观察到流式增量。`,
      );
    } catch (cause: unknown) {
      setCapabilityProbeError(cause);
    } finally {
      setProbingCapability(false);
    }
  }

  async function checkModelConnection(): Promise<void> {
    if (!runtime.modelGateway.available) {
      return;
    }
    setCheckingModel(true);
    setConnectionChecked(false);
    setConnection(null);
    setModelCapacity(null);
    setCapabilityProbeError(null);
    setCapabilityProbeMessage(null);
    let savedConnection: ModelProviderConnection | null = null;
    let lightweightProbeOwnsConnectionOutcome = false;
    try {
      savedConnection = await persistModelHubConnection();
      const config = modelHubNativeEndpointConfig(savedConnection);
      const capacityInspection =
        providerPreset === "ollama" && runtime.modelGateway.inspectCapacity !== undefined
          ? runtime.modelGateway.inspectCapacity().catch(() => null)
          : Promise.resolve(null);
      if (!getModelProviderPreset(providerPreset).modelDiscovery.automatic) {
        const modelId = (endpointId.trim() || selectedModel.trim()).normalize("NFKC");
        const target = await ensureCatalogEntryForModel(savedConnection, modelId);
        lightweightProbeOwnsConnectionOutcome = true;
        const result = await performLightweightTextProbe(target.connection, target.entry, true);
        const descriptors = result.catalog.map(catalogEntryToDescriptor);
        setConnection({
          provider: gatewayProviderKind(providerPreset),
          endpointOrigin: new URL(result.connection.baseUrl).origin,
          modelCount: descriptors.length,
          latencyMs: result.latencyMs,
        });
        setModels(descriptors);
        setHubCatalog(result.catalog);
        setHubConnection(result.connection);
        setSelectedModel(result.entry.providerModelId);
        const nextConnections = await runtime.modelHub.listConnections();
        setHubConnections(nextConnections);
        await refreshRoutingCatalogState(nextConnections);
        setCapabilityProbeMessage(
          result.streamed
            ? `连接成功，并已验证“${result.entry.displayName}”可生成文字和流式返回。`
            : `连接成功，并已验证“${result.entry.displayName}”可生成文字。`,
        );
        setCredentialError(null);
        return;
      }
      const [checked, listed, capacity] = await Promise.all([
        runtime.modelGateway.checkConnection(config),
        runtime.modelGateway.listModels(config),
        capacityInspection,
      ]);
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
      setConnection(checked);
      setModels(listed.models);
      setHubCatalog(catalog);
      setHubConnection(
        (await runtime.modelHub.findConnection(savedConnection.id)) ?? testedConnection,
      );
      const nextConnections = await runtime.modelHub.listConnections();
      setHubConnections(nextConnections);
      await refreshRoutingCatalogState(nextConnections);
      setModelCapacity(capacity);
      if (selectedModel.length === 0 && listed.models[0] !== undefined) {
        setSelectedModel(listed.models[0].id);
      }
      setCredentialError(null);
    } catch (reason: unknown) {
      if (savedConnection !== null && !lightweightProbeOwnsConnectionOutcome) {
        const normalized = normalizeUiError(reason);
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
      setCredentialError(reason);
      setModels([]);
      setModelCapacity(null);
    } finally {
      setConnectionChecked(true);
      setCheckingModel(false);
    }
  }

  async function saveSecret(): Promise<void> {
    if (runtime.mode !== "tauri") {
      return;
    }
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
      setHubConnection(saved.connection);
      setHubConnections(await runtime.modelHub.listConnections());
      setSummary(saved.credential);
      setSecret("");
      setCredentialError(null);
      if (saved.oldCredentialCleanupPending) {
        setSchemeMessage("新密钥已安全保存；旧密钥槽将在下次启动或重试时继续清理。");
      }
    } catch (reason: unknown) {
      setCredentialError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function applyModelHubScheme(): Promise<void> {
    setSchemeMessage(null);
    if (modelHubScheme === "custom") {
      setExpertMode(true);
      setSchemeMessage("已打开专家设置，可逐项调整模型能力和兼容路由。");
      return;
    }
    setSchemeSaving(true);
    setRouteError(null);
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
      const nextRoleRoutes = await runtime.modelRouting.listRoutes();
      setRoleRoutes(nextRoleRoutes);
      setNovelTaskRouteCount(applied.savedNovelTaskCount);
      const missing = applied.plan.unroutableTasks.length;
      setSchemeMessage(
        modelHubScheme === "local_privacy"
          ? missing === 0
            ? `本地隐私方案已覆盖 ${String(applied.savedNovelTaskCount)} 类任务；主模型和备用模型都只会使用本机连接。`
            : `本地隐私方案已安全应用；${String(applied.savedNovelTaskCount)} 类任务可用，${String(missing)} 类缺少本机能力证据，且不会回退到云端。`
          : `已按能力、评测、成本和隐私证据配置 ${String(applied.savedNovelTaskCount)} 类任务；${String(missing)} 类任务等待能力证据。`,
      );
    } catch (cause: unknown) {
      setRouteError(cause);
    } finally {
      setSchemeSaving(false);
    }
  }

  async function deleteSecret(): Promise<void> {
    if (runtime.mode !== "tauri") {
      return;
    }
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
      setHubConnection(deleted.connection);
      setHubConnections(await runtime.modelHub.listConnections());
      setSummary(deleted.credential);
      setSecret("");
      setCredentialError(null);
      if (deleted.credentialCleanup === "skipped_unowned_reference") {
        setSchemeMessage(
          "连接已安全停用；检测到来源不明的旧凭据引用，因此没有猜测或删除任何系统凭据槽。",
        );
      }
    } catch (reason: unknown) {
      setCredentialError(reason);
      const current = await runtime.modelHub.findConnection(providerId).catch(() => null);
      if (current !== null) {
        setHubConnection(current);
        setHubConnections(await runtime.modelHub.listConnections().catch(() => hubConnections));
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
      setHubConnection(
        nextConnections.find(({ id }) => id === result.connection.id) ?? result.connection,
      );
      setProfiles(nextProfiles);
      setProfile(null);
      setSummary(result.credential);
      setSecret("");
      setConnection(null);
      setConnectionChecked(false);
      setModelCapacity(null);
      setRetirementMessage(
        `“${target.displayName}”已移除：不会再参与 AI 分工，系统凭据已清理；已有正文、模型目录和调用记录仍会保留。`,
      );
      if (result.credentialCleanup === "skipped_unowned_reference") {
        setRetirementMessage(
          `“${target.displayName}”已安全停用并移除；检测到来源不明的旧凭据引用，因此没有猜测或删除任何系统凭据槽。正文、模型目录和调用记录仍然保留。`,
        );
      }
      setRetireConnectionTarget(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
      const current = await runtime.modelHub.findConnection(target.id).catch(() => null);
      if (current !== null) {
        setHubConnection(current);
        setHubConnections(await runtime.modelHub.listConnections().catch(() => hubConnections));
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

  const modelHubReadiness = useMemo(
    () =>
      projectModelHubReadiness({
        connections: hubConnections,
        catalog: routingCatalog,
        routes: novelTaskRoutes,
        transientChecking: loading || checkingModel,
        loadFailed: credentialError !== null,
      }),
    [checkingModel, credentialError, hubConnections, loading, novelTaskRoutes, routingCatalog],
  );

  useEffect(() => {
    if (loading) return;
    window.dispatchEvent(new Event(MODEL_HUB_READINESS_CHANGED_EVENT));
  }, [loading, modelHubReadiness]);

  const normalizedCredentialError =
    credentialError === null ? null : normalizeUiError(credentialError);
  const normalizedCapabilityProbeError =
    capabilityProbeError === null ? null : normalizeUiError(capabilityProbeError);
  const normalizedRouteError = routeError === null ? null : normalizeUiError(routeError);
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
  const selectableRoutingCatalog = routingCatalog.filter(
    ({ id, availability }) =>
      availability === "available" &&
      (novelRoutePrivacy !== "local_only" || localCatalogEntryIds.includes(id)),
  );

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
        <Badge tone={isModelHubView ? "info" : "success"}>
          {isModelHubView ? (expertMode ? "专家模式" : "普通模式") : "本地优先"}
        </Badge>
      </header>

      {isModelHubView ? (
        <nav className="model-hub-section-nav" aria-label="Model Hub 分区">
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
          <Link className="button-link button-link--secondary" to="/settings#data-privacy">
            数据与隐私
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#ai-memory">
            AI 记忆
          </Link>
          <Link className="button-link button-link--secondary" to="/settings#model-center">
            打开 Model Hub
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
                      description={`${normalizedMemoryGovernanceError.description}（${normalizedMemoryGovernanceError.code}）请重新核对当前项目后再试。`}
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
            <Card id="model-center" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>InkShadow Model Hub</CardTitle>
                    <CardDescription>
                      连接供应商、测试连接并发现模型。普通模式只显示开始写作真正需要的选项。
                    </CardDescription>
                  </div>
                  <SaveStatus
                    state={saving ? "saving" : hubConnection === null ? "clean" : "saved_local"}
                    labels={{
                      clean: "配置未保存",
                      saved_local: `配置修订 ${String(hubConnection?.revision ?? 0)}`,
                    }}
                  />
                </div>
              </CardHeader>
              <CardContent>
                <div className="model-center-settings">
                  <section className="model-hub-readiness" aria-labelledby="model-hub-status-title">
                    <div className="model-hub-readiness__heading">
                      <div>
                        <p className="page-heading__eyebrow">当前 AI 状态</p>
                        <h3 id="model-hub-status-title">{modelHubReadiness.label}</h3>
                      </div>
                      <Badge tone={modelHubReadiness.tone}>当前</Badge>
                    </div>
                    <p>{modelHubReadiness.description}</p>
                    <div className="model-hub-readiness__metrics" aria-label="AI 就绪情况">
                      <span>
                        可用连接 <strong>{modelHubReadiness.usableConnectionCount}</strong>
                      </span>
                      <span>
                        核心任务 <strong>{modelHubReadiness.runnableCoreTaskCount}</strong> /{" "}
                        {modelHubReadiness.totalCoreTaskCount}
                      </span>
                    </div>
                    {modelHubReadiness.missingCoreTasks.length > 0 &&
                      modelHubReadiness.usableConnectionCount > 0 && (
                        <p className="model-hub-readiness__missing">
                          尚未完整分工：
                          {modelHubReadiness.missingCoreTasks
                            .slice(0, 4)
                            .map(novelAiTaskLabel)
                            .join("、")}
                          {modelHubReadiness.missingCoreTasks.length > 4 ? "等" : ""}。
                        </p>
                      )}
                    {hubConnections.length > 0 && (
                      <ul className="model-hub-connection-summary" aria-label="已保存的 AI 连接">
                        {hubConnections.map((candidate) => (
                          <li key={candidate.id}>
                            <span>
                              <strong>
                                {getModelProviderPreset(candidate.providerKind).displayName}
                              </strong>
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
                              {isRetiredModelProviderConnection(candidate)
                                ? "已移除"
                                : connectionStatusLabel(candidate.connectionStatus)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
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
                      description={`${normalizedCredentialError.description}（${normalizedCredentialError.code}）`}
                    />
                  )}

                  {retirementMessage !== null && (
                    <InlineAlert
                      tone="info"
                      title="连接已安全移除"
                      description={retirementMessage}
                    />
                  )}

                  {runtime.mode === "browser-development" && (
                    <InlineAlert
                      tone="warning"
                      title="浏览器开发模式不连接模型"
                      description="可验证并保存非敏感配置，但不会接收密钥、访问端点或伪造模型目录。真实检查只在 Tauri 桌面应用中运行。"
                    />
                  )}

                  <div className="settings-actions">
                    <Button
                      variant="secondary"
                      aria-expanded={expertMode}
                      aria-controls="model-hub-expert-settings"
                      onClick={() => setExpertMode((current) => !current)}
                    >
                      {expertMode ? "收起专家设置" : "专家设置"}
                    </Button>
                    {hubConnection !== null &&
                      hubConnection.id === providerId &&
                      hubConnection.providerKind === providerPreset &&
                      (!isRetiredModelProviderConnection(hubConnection) || summary.configured) && (
                        <Button
                          variant="danger"
                          disabled={loading || saving || checkingModel || retiringConnection}
                          onClick={() => setRetireConnectionTarget(hubConnection)}
                        >
                          移除连接
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
                            disabled={loading || saving || checkingModel}
                            onChange={(event) =>
                              applyProviderPreset(
                                event.currentTarget.value as ConnectableProviderKind,
                              )
                            }
                          />
                        )}
                      </FormField>
                      {hubConnections.length > 0 && (
                        <FormField label="已连接的供应商">
                          {(fieldProps) => (
                            <Select
                              {...fieldProps}
                              value={hubConnection?.id ?? ""}
                              placeholder="选择已有连接"
                              options={hubConnections.map((candidate) => ({
                                value: candidate.id,
                                label: `${getModelProviderPreset(candidate.providerKind).displayName} · ${isRetiredModelProviderConnection(candidate) ? "已移除" : connectionStatusLabel(candidate.connectionStatus)}`,
                              }))}
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
                      {hubConnections.length > 0 && (
                        <FormField label="已保存配置">
                          {(fieldProps) => (
                            <Select
                              {...fieldProps}
                              value={hubConnection?.id ?? ""}
                              placeholder="选择已保存配置"
                              options={hubConnections.map((candidate) => ({
                                value: candidate.id,
                                label: `${candidate.id} · ${getModelProviderPreset(candidate.providerKind).displayName}`,
                              }))}
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
                            <FormField label="Embedding 路径" hint="留空使用 /embeddings。">
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
                                label="认证 Header 名称"
                                hint="这里只保存名称；值使用下方同一份系统凭据。"
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
                        description="这里只会自动重试读取连接和模型目录。文本生成、Embedding、Rerank 与图片生成一旦发送都不会自动重试，避免重复生成或重复计费。温度、Top P、结构化输出与推理强度仍由任务预设管理。"
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
                      <FormField
                        label="模型"
                        hint={`本次从端点读取 ${String(models.length)} 个模型。`}
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
                            onChange={(event) => void selectCatalogModel(event.currentTarget.value)}
                          />
                        )}
                      </FormField>
                    ) : expertMode ||
                      !getModelProviderPreset(providerPreset).modelDiscovery.automatic ? (
                      <FormField
                        label={
                          providerPreset === "volcengine_doubao" ? "模型或 Endpoint ID" : "模型标识"
                        }
                        hint="该供应商不保证提供模型列表，请填写控制台显示的真实模型或接入点标识。"
                        required={!getModelProviderPreset(providerPreset).modelDiscovery.automatic}
                      >
                        {(fieldProps) => (
                          <Input
                            {...fieldProps}
                            value={selectedModel}
                            maxLength={512}
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
                                : "先把 API Key 保存到系统凭据库，再测试连接；密钥不会写入普通数据库。"
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
                        description="为已选模型填写上下文上限和每百万输入、输出 token 的价格。墨影会在生成前显示估算、价格版本与更新时间；Ollama 等本地免费模型可明确填写 0。"
                      />
                      <div className="model-center-grid">
                        <FormField label="上下文窗口（token）" required>
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
                        <FormField label="计价币种" hint="三位大写代码，例如 USD。" required>
                          {(fieldProps) => (
                            <Input
                              {...fieldProps}
                              value={pricingCurrency}
                              minLength={3}
                              maxLength={3}
                              disabled={selectedModel.trim().length === 0}
                              onChange={(event) => setPricingCurrency(event.currentTarget.value)}
                            />
                          )}
                        </FormField>
                        <FormField label="输入价 / 百万 token" required>
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
                        <FormField label="输出价 / 百万 token" required>
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
                        <FormField label="缓存输入价 / 百万 token" hint="供应商未区分时可留空。">
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
                        <FormField label="价格版本" hint="例如 provider-2026-07。" required>
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
                        <FormField label="价格更新时间" required>
                          {(fieldProps) => (
                            <Input
                              {...fieldProps}
                              type="date"
                              value={priceUpdatedDate}
                              disabled={selectedModel.trim().length === 0}
                              onChange={(event) => setPriceUpdatedDate(event.currentTarget.value)}
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
                        description="模型目录无法证明的能力会保持“未知”。这里的勾选会作为用户确认的路由证据；取消勾选不会自动写成“不支持”。"
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

                  {selectedModel.trim().length > 0 && runtime.modelGateway.available && (
                    <InlineAlert
                      tone="warning"
                      title="能力验证会调用一次模型"
                      description="点击“验证写作能力”会发送一条不含作品内容的固定短测试，最多请求 8 个输出 token，供应商可能收取极少费用。测试输入和输出不会写入能力记录。"
                    />
                  )}

                  {normalizedCapabilityProbeError !== null && (
                    <InlineAlert
                      tone="error"
                      title="写作能力验证失败"
                      description={`${normalizedCapabilityProbeError.description}（${normalizedCapabilityProbeError.code}）连接和模型目录会保留，修正模型或接入点后可以重试。`}
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
                      disabled={
                        loading ||
                        checkingModel ||
                        probingCapability ||
                        providerId.trim().length === 0 ||
                        baseUrl.trim().length === 0 ||
                        !expertConnectionInputsAreComplete(
                          authentication,
                          credentialHeaderName,
                          requestTimeoutMs,
                          retryLimit,
                        )
                      }
                      onClick={() => void saveModelProfile()}
                    >
                      保存供应商与模型
                    </Button>
                    <Button
                      variant="secondary"
                      loading={checkingModel}
                      disabled={
                        !runtime.modelGateway.available ||
                        (!online && !canCheckModelEndpointWhileOffline(provider, baseUrl)) ||
                        loading ||
                        saving ||
                        probingCapability ||
                        (!getModelProviderPreset(providerPreset).modelDiscovery.automatic &&
                          selectedModel.trim().length === 0 &&
                          endpointId.trim().length === 0) ||
                        (authentication !== "none" && !summary.configured) ||
                        !expertConnectionInputsAreComplete(
                          authentication,
                          credentialHeaderName,
                          requestTimeoutMs,
                          retryLimit,
                        )
                      }
                      onClick={() => void checkModelConnection()}
                    >
                      {getModelProviderPreset(providerPreset).modelDiscovery.automatic
                        ? "测试连接并发现模型"
                        : "验证连接与写作能力"}
                    </Button>
                    {getModelProviderPreset(providerPreset).modelDiscovery.automatic && (
                      <Button
                        variant="secondary"
                        loading={probingCapability}
                        disabled={
                          !runtime.modelGateway.available ||
                          selectedModel.trim().length === 0 ||
                          loading ||
                          saving ||
                          checkingModel ||
                          (authentication !== "none" && !summary.configured) ||
                          !expertConnectionInputsAreComplete(
                            authentication,
                            credentialHeaderName,
                            requestTimeoutMs,
                            retryLimit,
                          )
                        }
                        onClick={() => void probeSelectedModelCapability()}
                      >
                        验证写作能力
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
                      description={`${connection.endpointOrigin} · ${String(connection.modelCount)} 个模型 · ${String(connection.latencyMs)} ms。${getModelProviderPreset(providerPreset).modelDiscovery.automatic ? "目录检查不会自动证明模型可生成正文，请按需继续验证写作能力。" : "已通过固定短文本验证模型可生成文字。"}`}
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
                          <SaveStatus
                            state={saving ? "saving" : summary.configured ? "saved_local" : "clean"}
                            labels={{
                              clean: "未配置",
                              saved_local: `已配置 ····${summary.lastFour ?? ""}`,
                            }}
                          />
                        </div>
                        <FormField
                          label={
                            authentication === "custom_header_keyring"
                              ? "认证 Header 值"
                              : "API Key（接口访问密钥）"
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
                              disabled={loading || saving || checkingModel}
                              onChange={(event) => setSecret(event.currentTarget.value)}
                            />
                          )}
                        </FormField>
                        <div className="settings-actions">
                          <Button
                            loading={saving}
                            disabled={secret.trim().length < 8}
                            onClick={() => void saveSecret()}
                          >
                            保存到系统凭据库
                          </Button>
                          {summary.configured &&
                            hubConnection?.id === providerId &&
                            hubConnection.providerKind === providerPreset && (
                              <Button
                                variant="danger"
                                loading={saving}
                                onClick={() => void deleteSecret()}
                              >
                                删除密钥
                              </Button>
                            )}
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>

            <Card id="model-routing" className="settings-card--wide">
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle headingLevel={2}>AI 分工</CardTitle>
                    <CardDescription>
                      选择一种使用方案，让写作、规划和检查使用合适的已连接模型。
                    </CardDescription>
                  </div>
                  <Badge tone={novelTaskRouteCount > 0 ? "success" : "neutral"}>
                    {novelTaskRouteCount > 0
                      ? `${String(novelTaskRouteCount)} / ${String(NOVEL_AI_TASKS.length)} 类任务已配置`
                      : "尚未配置"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="model-center-settings">
                  {normalizedRouteError !== null && (
                    <InlineAlert
                      tone="error"
                      title={normalizedRouteError.title}
                      description={`${normalizedRouteError.description}（${normalizedRouteError.code}）`}
                    />
                  )}

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
                      tone={schemeMessage.startsWith("还没有") ? "warning" : "info"}
                      title={schemeMessage.startsWith("还没有") ? "暂时无法应用" : "AI 分工已更新"}
                      description={schemeMessage}
                    />
                  )}

                  {hubCatalog.every(({ availability }) => availability !== "available") && (
                    <InlineAlert
                      tone="warning"
                      title="还没有可用模型"
                      description="请先在上方连接供应商、测试连接并保存一个模型。基础写作仍可使用，但需要 AI 的功能会明确提示尚未就绪。"
                    />
                  )}

                  {expertMode && (
                    <>
                      <InlineAlert
                        tone="info"
                        title="小说任务路由"
                        description={`逐项覆盖 ${String(NOVEL_AI_TASKS.length)} 类小说任务的主模型、备用模型、费用上限、隐私与失败处理。未明确保存的任务继续使用当前自动方案。`}
                      />
                      {routingCatalog.some(({ availability }) => availability === "available") && (
                        <>
                          <div className="model-center-grid">
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
                            <FormField label="单次费用上限" hint="留空表示不设置；按所选币种填写。">
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
                                        !localCatalogEntryIds.includes(novelRouteFallbackCatalogId)
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
                                      event.currentTarget.value as NovelTaskRoute["failurePolicy"],
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
                        description={`${String(NOVEL_AI_TASKS.length)} 类小说任务由 Model Hub 负责；这组旧角色仅桥接尚未迁移的生成链路。应用方案时会完整刷新，无法安全映射的旧角色会被清除。`}
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

            <section id="model-evaluation" className="settings-card--wide">
              <ModelHubEvaluationPanel
                service={modelEvaluation}
                disabled={!runtime.modelGateway.available || hubCatalog.length === 0}
              />
            </section>

            <section id="image-generation" className="settings-card--wide">
              <ModelHubImageGenerationPanel
                service={runtime.imageGeneration}
                disabled={!runtime.modelGateway.available}
              />
            </section>
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
                        description={`${normalizedMaintenanceError.description}（${normalizedMaintenanceError.code}）`}
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
                      description={`${normalizedDiagnosticError.description}（${normalizedDiagnosticError.code}）`}
                    />
                  )}
                  {diagnosticId !== null && (
                    <InlineAlert
                      tone="info"
                      title="诊断包已下载"
                      description={`支持编号：${diagnosticId}。发送前仍可自行打开结构化文件（JSON）检查内容。`}
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

      <Dialog
        open={retireConnectionTarget !== null}
        onOpenChange={(open) => {
          if (!open && !retiringConnection) {
            setRetireConnectionTarget(null);
          }
        }}
        title={
          retireConnectionTarget === null
            ? "移除模型连接？"
            : `移除“${retireConnectionTarget.displayName}”连接？`
        }
        description="连接会立即停止参与 AI 分工，并删除系统凭据库中的密钥。已生成内容、模型目录和不可变调用记录会保留。"
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
              停用并移除凭据
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="不会删除创作与审计历史"
          description="正文、AI 建议版本、模型调用记录和费用凭据都不会被删除。以后如需重新连接，可再次保存密钥并测试连接。"
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
      title: "自动备份需要处理",
      description: `${check.errorCode ?? "AUTOMATIC_BACKUP_CHECK_FAILED"}：没有删除或覆盖现有备份。请先使用下方“创建一致性备份”保存一份副本，再检查应用数据目录权限。`,
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
    title: "当前无需补做自动备份",
    description: `今天的计划槽位已经处理，受管备份会保留 30 天。下一计划时间为 ${nextDue}。`,
  };
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
    normalizeModelHubApiPath(input.embeddingPath, "Embedding path"),
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

function connectionEndpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "自定义端点";
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
    embedding: "语义向量",
    rerank: "结果重排",
    image_generation: "图片生成",
    vision: "图片理解",
    translation: "翻译",
    tool_calling: "工具调用",
    token_counting: "Token 计数",
    streaming: "流式输出",
    long_context: "长上下文",
  };
  return labels[capability];
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
    embedding: "Embedding",
    validation: "检查",
    translation: "翻译",
    local_private: "本地隐私",
  };
  return labels[role];
}
