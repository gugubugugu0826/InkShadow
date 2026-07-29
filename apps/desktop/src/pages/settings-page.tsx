import { useCallback, useEffect, useState } from "react";
import { MODEL_ROUTE_ROLES, type ModelRouteRole } from "@inkshadow/ai-core";
import type { DatabaseIntegrityReport, NativePathTicket } from "@inkshadow/data";
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

import { DataTransferPanel } from "../components/data-transfer-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import { collectDesktopDiagnosticArtifact } from "../infrastructure/diagnostics";
import { downloadBrowserExportArtifact } from "../infrastructure/export-artifact-download";
import {
  assessLocalModelCapacity,
  canCheckModelEndpointWhileOffline,
  type LocalModelCapacityAssessment,
} from "../infrastructure/model-capacity";
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

export function SettingsPage() {
  const runtime = useRuntime();
  const location = useLocation();
  const online = useOnlineStatus();
  const [summary, setSummary] = useState<SecretSummary>({
    configured: false,
    lastFour: null,
  });
  const [profiles, setProfiles] = useState<readonly ModelProfile[]>([]);
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [roleRoutes, setRoleRoutes] = useState<readonly ModelRoleRoute[]>([]);
  const [routeRole, setRouteRole] = useState<ModelRouteRole>("high_quality");
  const [routePrimaryProviderId, setRoutePrimaryProviderId] = useState("");
  const [routeFallbackProviderId, setRouteFallbackProviderId] = useState("");
  const [routeSaving, setRouteSaving] = useState(false);
  const [routeError, setRouteError] = useState<unknown>(null);
  const [providerId, setProviderId] = useState<string>(DEFAULT_OPENAI_PROFILE.providerId);
  const [provider, setProvider] = useState<NativeProviderKind>(DEFAULT_OPENAI_PROFILE.provider);
  const [baseUrl, setBaseUrl] = useState<string>(DEFAULT_OPENAI_PROFILE.baseUrl);
  const [authentication, setAuthentication] = useState<NativeAuthenticationMode>(
    DEFAULT_OPENAI_PROFILE.authentication,
  );
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingModel, setCheckingModel] = useState(false);
  const [credentialError, setCredentialError] = useState<unknown>(null);
  const [integrity, setIntegrity] = useState<DatabaseIntegrityReport | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState<"inspect" | "backup" | "restore" | null>(
    null,
  );
  const [maintenanceError, setMaintenanceError] = useState<unknown>(null);
  const [backupComplete, setBackupComplete] = useState(false);
  const [restoreSourceTicket, setRestoreSourceTicket] = useState<NativePathTicket | null>(null);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<unknown>(null);
  const [diagnosticId, setDiagnosticId] = useState<string | null>(null);

  const applyPricingToForm = useCallback((pricing: ModelPricingProfile | null): void => {
    setContextWindowTokens(pricing === null ? "" : String(pricing.contextWindowTokens));
    setPricingCurrency(pricing?.currency ?? "USD");
    setInputPricePerMillion(
      pricing === null ? "" : formatMicrosAsCurrency(pricing.inputMicrosPerMillionTokens),
    );
    setOutputPricePerMillion(
      pricing === null ? "" : formatMicrosAsCurrency(pricing.outputMicrosPerMillionTokens),
    );
    setCachedInputPricePerMillion(
      pricing?.cachedInputMicrosPerMillionTokens === null ||
        pricing?.cachedInputMicrosPerMillionTokens === undefined
        ? ""
        : formatMicrosAsCurrency(pricing.cachedInputMicrosPerMillionTokens),
    );
    setPricingVersion(pricing?.pricingVersion ?? "");
    setPriceUpdatedDate(pricing?.priceUpdatedAt.slice(0, 10) ?? "");
  }, []);

  const loadModelCenter = useCallback(async () => {
    setLoading(true);
    try {
      const [storedProfiles, storedRoutes] = await Promise.all([
        runtime.modelCenter.listProfiles(),
        runtime.modelRouting.listRoutes(),
      ]);
      const selectedProfile = storedProfiles[0] ?? null;
      setProfiles(storedProfiles);
      setRoleRoutes(storedRoutes);
      const selectedRoute = storedRoutes.find(({ role }) => role === "high_quality");
      setRoutePrimaryProviderId(
        selectedRoute?.primaryProviderId ??
          storedProfiles.find(({ selectedModel }) => selectedModel !== null)?.providerId ??
          "",
      );
      setRouteFallbackProviderId(selectedRoute?.fallbackProviderId ?? "");
      setProfile(selectedProfile);
      setProviderId(selectedProfile?.providerId ?? DEFAULT_OPENAI_PROFILE.providerId);
      setProvider(selectedProfile?.provider ?? DEFAULT_OPENAI_PROFILE.provider);
      setBaseUrl(selectedProfile?.baseUrl ?? DEFAULT_OPENAI_PROFILE.baseUrl);
      setAuthentication(selectedProfile?.authentication ?? DEFAULT_OPENAI_PROFILE.authentication);
      setSelectedModel(selectedProfile?.selectedModel ?? "");
      applyPricingToForm(selectedProfile?.pricing ?? null);
      setModels([]);
      setConnection(null);
      setModelCapacity(null);
      setSummary(
        runtime.mode === "tauri"
          ? await runtime.credentials.getSummary(
              selectedProfile?.providerId ?? DEFAULT_OPENAI_PROFILE.providerId,
            )
          : { configured: false, lastFour: null },
      );
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
    } finally {
      setLoading(false);
    }
  }, [applyPricingToForm, runtime]);

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

  useEffect(() => {
    void Promise.resolve().then(loadModelCenter);
    if (runtime.maintenance !== null) {
      void Promise.resolve().then(inspectDatabase);
    }
  }, [inspectDatabase, loadModelCenter, runtime]);

  useEffect(() => {
    const targetId = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    if (targetId.length === 0) {
      return;
    }
    const timeout = window.setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [location.hash]);

  async function selectStoredProfile(providerIdValue: string): Promise<void> {
    const selected = profiles.find((candidate) => candidate.providerId === providerIdValue);
    if (selected === undefined) {
      return;
    }
    setProfile(selected);
    setProviderId(selected.providerId);
    setProvider(selected.provider);
    setBaseUrl(selected.baseUrl);
    setAuthentication(selected.authentication);
    setSelectedModel(selected.selectedModel ?? "");
    applyPricingToForm(selected.pricing);
    setModels([]);
    setConnection(null);
    setModelCapacity(null);
    setSecret("");
    try {
      setSummary(
        runtime.mode === "tauri"
          ? await runtime.credentials.getSummary(selected.providerId)
          : { configured: false, lastFour: null },
      );
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
    }
  }

  function applyProviderPreset(nextProvider: NativeProviderKind): void {
    setProvider(nextProvider);
    setProfile(null);
    setModels([]);
    setConnection(null);
    setModelCapacity(null);
    setSelectedModel("");
    setContextWindowTokens(nextProvider === "ollama" ? "32768" : "");
    setPricingCurrency("USD");
    setInputPricePerMillion(nextProvider === "ollama" ? "0" : "");
    setOutputPricePerMillion(nextProvider === "ollama" ? "0" : "");
    setCachedInputPricePerMillion("");
    setPricingVersion(nextProvider === "ollama" ? "local-zero-cost" : "");
    setPriceUpdatedDate(new Date().toISOString().slice(0, 10));
    if (nextProvider === "ollama") {
      setProviderId("ollama-local");
      setBaseUrl("http://127.0.0.1:11434");
      setAuthentication("none");
      setSummary({ configured: false, lastFour: null });
    } else {
      setProviderId(DEFAULT_OPENAI_PROFILE.providerId);
      setBaseUrl(DEFAULT_OPENAI_PROFILE.baseUrl);
      setAuthentication(DEFAULT_OPENAI_PROFILE.authentication);
      setSummary({ configured: false, lastFour: null });
    }
  }

  async function saveModelProfile(): Promise<void> {
    setSaving(true);
    try {
      const saved = await runtime.modelCenter.save({
        providerId,
        provider,
        baseUrl,
        authentication,
        selectedModel: selectedModel.trim().length === 0 ? null : selectedModel,
        pricing: buildPricingProfile(),
        expectedRevision: profile?.providerId === providerId ? profile.revision : null,
      });
      const nextProfiles = await runtime.modelCenter.listProfiles();
      setProfiles(nextProfiles);
      setProfile(saved);
      setProviderId(saved.providerId);
      setBaseUrl(saved.baseUrl);
      setSelectedModel(saved.selectedModel ?? "");
      applyPricingToForm(saved.pricing);
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

  function buildPricingProfile(): ModelPricingProfile | null {
    if (selectedModel.trim().length === 0) {
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

  async function checkModelConnection(): Promise<void> {
    if (!runtime.modelGateway.available) {
      return;
    }
    setCheckingModel(true);
    setConnection(null);
    setModelCapacity(null);
    try {
      const config = {
        providerId,
        provider,
        baseUrl,
        authentication,
      } as const;
      const capacityInspection =
        provider === "ollama" && runtime.modelGateway.inspectCapacity !== undefined
          ? runtime.modelGateway.inspectCapacity().catch(() => null)
          : Promise.resolve(null);
      const [checked, listed, capacity] = await Promise.all([
        runtime.modelGateway.checkConnection(config),
        runtime.modelGateway.listModels(config),
        capacityInspection,
      ]);
      setConnection(checked);
      setModels(listed.models);
      setModelCapacity(capacity);
      if (selectedModel.length === 0 && listed.models[0] !== undefined) {
        setSelectedModel(listed.models[0].id);
      }
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
      setModels([]);
      setModelCapacity(null);
    } finally {
      setCheckingModel(false);
    }
  }

  async function saveSecret(): Promise<void> {
    if (runtime.mode !== "tauri") {
      return;
    }
    setSaving(true);
    try {
      const nextSummary = await runtime.credentials.save(providerId, secret);
      setSummary(nextSummary);
      setSecret("");
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSecret(): Promise<void> {
    if (runtime.mode !== "tauri") {
      return;
    }
    setSaving(true);
    try {
      setSummary(await runtime.credentials.delete(providerId));
      setSecret("");
      setCredentialError(null);
    } catch (reason: unknown) {
      setCredentialError(reason);
    } finally {
      setSaving(false);
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

  const normalizedCredentialError =
    credentialError === null ? null : normalizeUiError(credentialError);
  const normalizedRouteError = routeError === null ? null : normalizeUiError(routeError);
  const normalizedMaintenanceError =
    maintenanceError === null ? null : normalizeUiError(maintenanceError);
  const normalizedDiagnosticError =
    diagnosticError === null ? null : normalizeUiError(diagnosticError);
  const selectedModelDescriptor = models.find(({ id }) => id === selectedModel) ?? null;
  const localCapacityAssessment = assessLocalModelCapacity(selectedModelDescriptor, modelCapacity);

  return (
    <div className="desktop-page settings-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">隐私与本地数据</p>
          <h1>设置</h1>
          <p>正文保存在本地数据库；模型凭据只进入操作系统凭据库。</p>
        </div>
        <Badge tone="success">本地优先</Badge>
      </header>

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前处于离线状态"
          description="本地项目、数据检查、备份与回环地址上的 Ollama 仍可使用；远程模型能力暂不可用。"
        />
      )}

      <div className="settings-grid">
        <Card>
          <CardHeader>
            <CardTitle>数据与隐私</CardTitle>
            <CardDescription>核心写作能力不要求登录，也不依赖云端账户。</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="privacy-list">
              <li>项目、章节、恢复草稿与版本默认存储在当前设备。</li>
              <li>候选内容在明确接受前不会写入正式正文。</li>
              <li>浏览器开发模式仅用于本地调试，不代表桌面生产数据层。</li>
              <li>API Key 不写入项目数据库、localStorage、日志或通知。</li>
            </ul>
          </CardContent>
        </Card>

        <Card id="model-center" className="settings-card--wide">
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle>模型中心</CardTitle>
                <CardDescription>
                  配置 OpenAI 兼容接口或 Ollama；远程端点强制 HTTPS，本机回环地址可使用 HTTP。
                </CardDescription>
              </div>
              <SaveStatus
                state={saving ? "saving" : profile === null ? "clean" : "saved_local"}
                labels={{
                  clean: "配置未保存",
                  saved_local: `配置修订 ${String(profile?.revision ?? 0)}`,
                }}
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="model-center-settings">
              {normalizedCredentialError !== null && (
                <InlineAlert
                  tone="error"
                  title={normalizedCredentialError.title}
                  description={`${normalizedCredentialError.description}（${normalizedCredentialError.code}）`}
                />
              )}

              {runtime.mode === "browser-development" && (
                <InlineAlert
                  tone="warning"
                  title="浏览器开发模式不连接模型"
                  description="可验证并保存非敏感配置，但不会接收密钥、访问端点或伪造模型目录。真实检查只在 Tauri 桌面应用中运行。"
                />
              )}

              {profiles.length > 0 && (
                <FormField label="已保存配置">
                  {(fieldProps) => (
                    <Select
                      {...fieldProps}
                      value={profile?.providerId ?? ""}
                      placeholder="选择已保存配置"
                      options={profiles.map((candidate) => ({
                        value: candidate.providerId,
                        label: `${candidate.providerId} · ${providerLabel(candidate.provider)}`,
                      }))}
                      onChange={(event) => void selectStoredProfile(event.currentTarget.value)}
                    />
                  )}
                </FormField>
              )}

              <div className="model-center-grid">
                <FormField label="协议" required>
                  {(fieldProps) => (
                    <Select
                      {...fieldProps}
                      value={provider}
                      options={[
                        {
                          value: "open_ai_compatible",
                          label: "OpenAI 兼容",
                        },
                        { value: "ollama", label: "Ollama" },
                      ]}
                      disabled={loading || saving || checkingModel}
                      onChange={(event) =>
                        applyProviderPreset(event.currentTarget.value as NativeProviderKind)
                      }
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
                        setProviderId(event.currentTarget.value);
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
                      options={[
                        { value: "none", label: "无认证" },
                        {
                          value: "bearer_keyring",
                          label: "Bearer 密钥（系统凭据库）",
                        },
                      ]}
                      disabled={loading || saving || checkingModel}
                      onChange={(event) =>
                        setAuthentication(event.currentTarget.value as NativeAuthenticationMode)
                      }
                    />
                  )}
                </FormField>
              </div>

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
                      onChange={(event) => setSelectedModel(event.currentTarget.value)}
                    />
                  )}
                </FormField>
              ) : (
                <FormField label="模型标识" hint="可手工填写；连接检查后会改为端点返回的模型列表。">
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={selectedModel}
                      maxLength={512}
                      onChange={(event) => setSelectedModel(event.currentTarget.value)}
                    />
                  )}
                </FormField>
              )}

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
                      onChange={(event) => setContextWindowTokens(event.currentTarget.value)}
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
                      onChange={(event) => setInputPricePerMillion(event.currentTarget.value)}
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
                      onChange={(event) => setOutputPricePerMillion(event.currentTarget.value)}
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
                      onChange={(event) => setCachedInputPricePerMillion(event.currentTarget.value)}
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

              <div className="settings-actions">
                <Button
                  loading={saving}
                  disabled={
                    loading ||
                    checkingModel ||
                    providerId.trim().length === 0 ||
                    baseUrl.trim().length === 0
                  }
                  onClick={() => void saveModelProfile()}
                >
                  保存非敏感配置
                </Button>
                <Button
                  variant="secondary"
                  loading={checkingModel}
                  disabled={
                    !runtime.modelGateway.available ||
                    (!online && !canCheckModelEndpointWhileOffline(provider, baseUrl)) ||
                    loading ||
                    saving ||
                    (authentication === "bearer_keyring" && !summary.configured)
                  }
                  onClick={() => void checkModelConnection()}
                >
                  检查连接并读取模型
                </Button>
              </div>

              {connection !== null && (
                <InlineAlert
                  tone="info"
                  title="模型目录连接成功"
                  description={`${connection.endpointOrigin} · ${String(connection.modelCount)} 个模型 · ${String(connection.latencyMs)} ms。生成与流式输出尚未在这次目录检查中执行。`}
                />
              )}

              {connection !== null && provider === "ollama" && (
                <InlineAlert
                  tone={localCapacityAssessment.status === "warning" ? "warning" : "info"}
                  title="本地模型容量初步体检"
                  description={describeLocalModelCapacity(localCapacityAssessment, modelCapacity)}
                />
              )}

              {authentication === "bearer_keyring" &&
                (runtime.mode === "browser-development" ? (
                  <InlineAlert
                    tone="warning"
                    title="浏览器开发模式不接受模型密钥"
                    description="请在 Tauri 桌面应用中配置。页面不会把密钥写入 localStorage 或模型配置表。"
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
                      label="API Key"
                      hint="保存后仅显示末四位；页面不会再次读取完整密钥。"
                      required
                    >
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          type="password"
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
                      {summary.configured && (
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
                <CardTitle>模型角色路由</CardTitle>
                <CardDescription>
                  为七类任务绑定精确的供应商与模型；配置变化使用修订号保护。
                </CardDescription>
              </div>
              <Badge tone={roleRoutes.length > 0 ? "success" : "neutral"}>
                {roleRoutes.length > 0
                  ? `${String(roleRoutes.length)} / ${String(MODEL_ROUTE_ROLES.length)} 已配置`
                  : "尚未配置"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="model-center-settings">
              <InlineAlert
                tone="info"
                title="路由不会静默改变数据去向"
                description="每次执行仍会重新核验模型目录、凭据和网络。主模型不可用时，只有已明确配置的备用模型可进入生成前确认；Embedding 在真实能力接通前不会被伪装为可用。"
              />
              {normalizedRouteError !== null && (
                <InlineAlert
                  tone="error"
                  title={normalizedRouteError.title}
                  description={`${normalizedRouteError.description}（${normalizedRouteError.code}）`}
                />
              )}
              {profiles.every(({ selectedModel: model }) => model === null) ? (
                <InlineAlert
                  tone="warning"
                  title="先选择至少一个模型"
                  description="角色路由只能引用已经保存且具有模型标识的配置。"
                />
              ) : (
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
                    <FormField label="主模型" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={routePrimaryProviderId}
                          placeholder="选择主模型"
                          options={profiles
                            .filter(
                              (
                                candidate,
                              ): candidate is ModelProfile & { readonly selectedModel: string } =>
                                candidate.selectedModel !== null,
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
                    <FormField label="备用模型" hint="可选；切换前仍需在预检中确认。">
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

              {roleRoutes.length > 0 && (
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

        <Card id="sync-security" className="settings-card--wide">
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle>同步安全</CardTitle>
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
                <CardTitle>本地数据维护</CardTitle>
                <CardDescription>
                  检查 SQLite 数据完整性，并创建可独立恢复的一致性备份。
                </CardDescription>
              </div>
              {runtime.maintenance !== null && (
                <Badge
                  tone={integrity === null ? "neutral" : integrity.healthy ? "success" : "danger"}
                >
                  {integrity === null ? "尚未检查" : integrity.healthy ? "数据健康" : "需要处理"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {runtime.maintenance === null ? (
              <InlineAlert
                tone="warning"
                title="桌面应用专属能力"
                description="SQLite 一致性检查与文件备份仅在 Tauri 桌面应用中可用。浏览器开发数据保存在 localStorage。"
              />
            ) : (
              <div className="maintenance-settings">
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

        <Card className="settings-card--wide">
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle>脱敏诊断包</CardTitle>
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
                  description={`支持编号：${diagnosticId}。发送前仍可自行打开 JSON 检查内容。`}
                />
              )}
              <ul className="privacy-list">
                <li>明确排除正文、Prompt、API Key、密码、恢复码和上传文件。</li>
                <li>当前未启用持久日志采集，诊断包会如实记录 recentLogs 为空。</li>
                <li>本地搜索索引从稳定章节与大纲按需重建；未执行过重建时健康状态为 unknown。</li>
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
      </div>

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

function formatMicrosAsCurrency(value: number): string {
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${String(whole)}.${fraction}`;
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

function providerLabel(provider: NativeProviderKind): string {
  return provider === "open_ai_compatible" ? "OpenAI 兼容" : "Ollama";
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
