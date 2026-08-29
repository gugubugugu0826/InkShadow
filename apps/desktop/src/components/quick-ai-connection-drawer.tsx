import { Badge, Button, Drawer, FormField, InlineAlert, Input, Select } from "@inkshadow/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { MODEL_HUB_READINESS_CHANGED_EVENT } from "../infrastructure/model-hub-readiness";
import { modelHubCapabilityProbeSupportId } from "../infrastructure/model-hub-text-capability-probe";
import { modelHubCredentialProviderId } from "../infrastructure/model-hub-native-config";
import { getModelProviderPreset } from "../infrastructure/model-hub-provider-registry";
import {
  QUICK_MODEL_PROVIDERS,
  QuickModelConnectionError,
  configureQuickBookStartRoute,
  connectQuickModelProvider,
  inspectQuickBookStartRouteProbe,
  listQuickBookStartTextCatalogEntries,
  selectQuickBookStartCatalogEntry,
  type QuickBookStartProbeDisclosure,
  type QuickModelConnectionResult,
  type QuickModelProvider,
} from "../infrastructure/quick-model-connection-service";
import type { DiscoveredModelCredentialSummary } from "../infrastructure/runtime";
import { useModelHubReadiness } from "../hooks/use-model-hub-readiness";
import { useRuntime } from "../runtime-context";

export type QuickAiContinueChoice = "ai" | "self" | "sample";

export interface QuickAiConnectionDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSkip: () => void;
  readonly onContinue: (choice: QuickAiContinueChoice) => void | Promise<void>;
}

type DrawerPhase = "connection" | "catalog" | "failure";
type FailureStage = "connection" | "route";

interface CredentialDiscoveryFailure {
  readonly description: string;
  readonly supportId: string;
}

const PROVIDER_COPY: Readonly<
  Record<QuickModelProvider, Readonly<{ label: string; description: string }>>
> = Object.freeze({
  openai: Object.freeze({ label: "OpenAI", description: "官方云端 API" }),
  deepseek: Object.freeze({ label: "DeepSeek", description: "官方云端接口" }),
  alibaba_qwen: Object.freeze({ label: "阿里云百炼 / Qwen", description: "选择地域和模型" }),
  volcengine_doubao: Object.freeze({
    label: "火山方舟 / 豆包",
    description: "使用模型或接入点编号",
  }),
  zhipu_glm: Object.freeze({ label: "智谱 GLM", description: "填写账号可用模型编号" }),
  ollama: Object.freeze({ label: "Ollama", description: "本机运行，无需接口密钥" }),
  custom_openai_compatible: Object.freeze({
    label: "自定义兼容接口",
    description: "兼容接口根地址",
  }),
});

const QWEN_REGION_OPTIONS = Object.freeze([
  { value: "china_beijing", label: "中国（北京）" },
  { value: "singapore", label: "新加坡" },
  { value: "japan_tokyo", label: "日本（东京）" },
  { value: "germany_frankfurt", label: "德国（法兰克福）" },
  { value: "us_virginia", label: "美国（弗吉尼亚）" },
]);

const MANUAL_MODEL_PROVIDERS = new Set<QuickModelProvider>([
  "alibaba_qwen",
  "volcengine_doubao",
  "zhipu_glm",
]);

export function QuickAiConnectionDrawer({
  onContinue,
  onOpenChange,
  onSkip,
  open,
}: QuickAiConnectionDrawerProps): ReactNode {
  return open ? (
    <OpenQuickAiConnectionDrawer
      open={open}
      onOpenChange={onOpenChange}
      onSkip={onSkip}
      onContinue={onContinue}
    />
  ) : null;
}

function OpenQuickAiConnectionDrawer({
  onContinue,
  onOpenChange,
  onSkip,
}: QuickAiConnectionDrawerProps): ReactNode {
  const runtime = useRuntime();
  const sharedReadinessSnapshot = useModelHubReadiness(runtime);
  const sharedReadiness = sharedReadinessSnapshot.readiness;
  const [provider, setProvider] = useState<QuickModelProvider>("deepseek");
  const customConnectionIdRef = useRef(`quick-custom-${runtime.ids.next()}`);
  const [secret, setSecret] = useState("");
  const [region, setRegion] = useState("china_beijing");
  const [workspaceId, setWorkspaceId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [credentialHint, setCredentialHint] = useState<Readonly<{
    provider: QuickModelProvider;
    label: string;
  }> | null>(null);
  const [discoveredCredentials, setDiscoveredCredentials] = useState<
    readonly DiscoveredModelCredentialSummary[]
  >([]);
  const [selectedDiscoveredCredentialId, setSelectedDiscoveredCredentialId] = useState<
    string | null
  >(null);
  const [pendingDeleteDiscoveryId, setPendingDeleteDiscoveryId] = useState<string | null>(null);
  const [credentialDiscoveryFailure, setCredentialDiscoveryFailure] =
    useState<CredentialDiscoveryFailure | null>(null);
  const [phase, setPhase] = useState<DrawerPhase>("connection");
  const [busy, setBusy] = useState(false);
  const operationInFlightRef = useRef(false);
  const [result, setResult] = useState<QuickModelConnectionResult | null>(null);
  const [selectedCatalogEntryId, setSelectedCatalogEntryId] = useState("");
  const [automaticTextSelectionUnavailable, setAutomaticTextSelectionUnavailable] = useState(false);
  const [choice, setChoice] = useState<QuickAiContinueChoice>("ai");
  const [probeDisclosure, setProbeDisclosure] = useState<QuickBookStartProbeDisclosure | null>(
    null,
  );
  const [failure, setFailure] = useState<QuickModelConnectionError | null>(null);
  const [failureStage, setFailureStage] = useState<FailureStage>("connection");
  const probeResultAmbiguous = failure?.code === "PROVIDER_RESULT_AMBIGUOUS";
  const probePreparationFailed = failure?.failureStage === "probe_preparation";
  const routeStateRequiresReview = failure?.code === "QUICK_MODEL_ROUTE_STATE_REQUIRES_REVIEW";
  const failureTitle = routeStateRequiresReview
    ? "开书模型设置需要核对"
    : probeResultAmbiguous
      ? "模型能力检查结果待核对"
      : probePreparationFailed
        ? "模型能力检查未发送"
        : failureStage === "connection"
          ? "连接没有完成"
          : "模型能力检查未完成";

  useEffect(() => {
    let active = true;
    if (runtime.mode !== "tauri" || runtime.credentials.discoverModelCredentials === undefined) {
      return () => {
        active = false;
      };
    }
    void runtime.modelHub
      .listConnections()
      .then((connections) =>
        runtime.credentials.discoverModelCredentials?.(
          connections
            .filter(
              ({ authenticationMode, connectionStatus, credentialRef, enabled }) =>
                enabled &&
                connectionStatus !== "disabled" &&
                authenticationMode !== "none" &&
                credentialRef !== null,
            )
            .map((connection) => modelHubCredentialProviderId(connection)),
        ),
      )
      .then((credentials) => {
        if (!active || credentials === undefined) return;
        setDiscoveredCredentials(credentials);
        setCredentialDiscoveryFailure(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setDiscoveredCredentials([]);
        setCredentialDiscoveryFailure(
          normalizeCredentialDiscoveryFailure(cause, runtime.ids.next(), runtime.clock.now()),
        );
      });
    return () => {
      active = false;
    };
  }, [runtime]);

  useEffect(() => {
    let active = true;
    if (
      runtime.mode !== "tauri" ||
      provider === "ollama" ||
      provider === "custom_openai_compatible"
    ) {
      return () => {
        active = false;
      };
    }
    void runtime.modelHub
      .listConnections()
      .then(async (connections) => {
        const activeConnections = connections.filter(
          ({ connectionStatus, enabled }) => enabled && connectionStatus !== "disabled",
        );
        const connection =
          activeConnections.find(({ id }) => id === provider) ??
          activeConnections.find(({ providerKind }) => providerKind === provider);
        if (connection === undefined) {
          return {
            connection: null,
            summary: { configured: false, lastFour: null },
            catalog: [],
          } as const;
        }
        const [summary, catalog] = await Promise.all([
          runtime.credentials.getSummary(modelHubCredentialProviderId(connection)),
          runtime.modelHub.listCatalog(connection.id),
        ]);
        return { connection, summary, catalog } as const;
      })
      .then(({ catalog, connection, summary }) => {
        if (!active) return;
        if (connection !== null) {
          if (provider === "alibaba_qwen") {
            setRegion((current) =>
              current === "china_beijing" ? (connection.region ?? current) : current,
            );
            setWorkspaceId((current) =>
              current.length > 0 ? current : (connection.workspaceId ?? ""),
            );
          }
          const savedModelId =
            connection.endpointId ??
            catalog.find(
              ({ availability, lifecycle }) =>
                availability === "available" && lifecycle !== "deprecated",
            )?.providerModelId;
          if (MANUAL_MODEL_PROVIDERS.has(provider) && savedModelId !== undefined) {
            setManualModelId((current) => (current.length > 0 ? current : savedModelId));
          }
        }
        if (summary.configured) {
          setCredentialHint({
            provider,
            label:
              summary.lastFour === null
                ? "已保存可用接口密钥"
                : `已保存接口密钥（末四位 ${summary.lastFour}）`,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [provider, runtime]);

  const modelOptions = useMemo(
    () => [
      { value: "", label: "请选择纯文字模型" },
      ...(result?.catalog.map(({ displayName, id, providerModelId }) => ({
        value: id,
        label:
          displayName === providerModelId ? displayName : `${displayName} · ${providerModelId}`,
      })) ?? []),
    ],
    [result],
  );
  const browserOnly = runtime.mode !== "tauri";
  const providerPreset = getModelProviderPreset(provider);
  const mappedCredentialHint = credentialHint?.provider === provider ? credentialHint.label : null;
  const trustedDiscoveredCredentials = discoveredCredentials.filter(
    (credential) =>
      credential.providerKind === provider &&
      typeof credential.sourceConnectionId === "string" &&
      credential.sourceConnectionId.length > 0,
  );
  const unknownOriginCredentialCount = discoveredCredentials.filter(
    (credential) =>
      typeof credential.providerKind !== "string" ||
      typeof credential.sourceConnectionId !== "string" ||
      credential.sourceConnectionId.length === 0,
  ).length;
  const selectedDiscoveredCredential = trustedDiscoveredCredentials.find(
    ({ discoveryId }) => discoveryId === selectedDiscoveredCredentialId,
  );
  const currentCredentialHint =
    mappedCredentialHint ??
    (selectedDiscoveredCredential === undefined
      ? null
      : `将使用本机已保存接口密钥（末四位 ${selectedDiscoveredCredential.lastFour}）`);
  const needsSecret = providerPreset.credentialRequired && currentCredentialHint === null;
  const needsManualModel = MANUAL_MODEL_PROVIDERS.has(provider);
  const workspaceRequired =
    provider === "alibaba_qwen" && (region === "japan_tokyo" || region === "germany_frankfurt");

  const connectionActionBlockers = [
    browserOnly ? "请改用墨影桌面应用" : null,
    needsSecret && secret.length === 0 ? "请填写接口密钥，或选择一条本机已保存的密钥" : null,
    needsManualModel && manualModelId.trim().length === 0 ? "请填写模型编号" : null,
    provider === "custom_openai_compatible" && baseUrl.trim().length === 0
      ? "请填写服务根地址"
      : null,
    workspaceRequired && workspaceId.trim().length === 0
      ? "请填写服务工作区编号，或改用不需要工作区编号的地域"
      : null,
  ].filter((value): value is string => value !== null);
  const connectionActionHelp =
    connectionActionBlockers.length === 0
      ? null
      : `暂时不能测试连接：${connectionActionBlockers.join("；")}。也可以先不连接，继续开书。`;
  const catalogContinueBlocked = choice === "ai" && selectedCatalogEntryId.length === 0;
  const catalogContinueHelp = automaticTextSelectionUnavailable
    ? "暂时不能继续：当前目录没有已确认可用于纯文字开书的模型。实验性视觉模型不会被自动选作纯文字开书模型，向量模型和能力不明确的模型也不会出现在这里。请到完整模型中心核对能力；也可以选择“我自己写”或“先看看示例”。"
    : "暂时不能继续：请先选择一个开书模型；如果不想使用 AI，可以选择“我自己写”或“先看看示例”。";

  async function deleteDiscoveredCredential(discoveryId: string): Promise<void> {
    if (operationInFlightRef.current || busy) return;
    if (runtime.credentials.deleteDiscovered === undefined) {
      setCredentialDiscoveryFailure({
        description: "当前桌面环境无法安全删除这条本机密钥，请重新启动墨影后再试。",
        supportId: modelHubCapabilityProbeSupportId({
          id: runtime.ids.next(),
          startedAt: runtime.clock.now(),
        }),
      });
      return;
    }
    operationInFlightRef.current = true;
    setBusy(true);
    setCredentialDiscoveryFailure(null);
    try {
      await runtime.credentials.deleteDiscovered(discoveryId);
      setDiscoveredCredentials((current) =>
        current.filter((credential) => credential.discoveryId !== discoveryId),
      );
      setSelectedDiscoveredCredentialId((current) => (current === discoveryId ? null : current));
      setPendingDeleteDiscoveryId(null);
    } catch (cause: unknown) {
      setCredentialDiscoveryFailure(
        normalizeCredentialDiscoveryFailure(cause, runtime.ids.next(), runtime.clock.now()),
      );
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function connect(): Promise<void> {
    if (operationInFlightRef.current || busy || browserOnly) return;
    operationInFlightRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const connected = await connectQuickModelProvider(runtime, {
        provider,
        ...(provider === "custom_openai_compatible"
          ? { connectionId: customConnectionIdRef.current, baseUrlOverride: baseUrl }
          : {}),
        ...(provider === "alibaba_qwen" ? { region, workspaceId } : {}),
        ...(provider === "volcengine_doubao" ? { endpointId: manualModelId } : {}),
        ...(manualModelId.trim().length === 0 ? {} : { manualModelId }),
        ...(secret.length === 0 ? {} : { secret }),
        ...(secret.length > 0 || selectedDiscoveredCredentialId === null
          ? {}
          : { discoveredCredentialId: selectedDiscoveredCredentialId }),
      });
      const textCatalog = await listQuickBookStartTextCatalogEntries(runtime, connected);
      const textConnection = Object.freeze({ ...connected, catalog: textCatalog });
      const selected = await selectQuickBookStartCatalogEntry(runtime, textConnection);
      setAutomaticTextSelectionUnavailable(selected === null && connected.catalog.length > 0);
      setResult(textConnection);
      setSelectedCatalogEntryId(selected?.id ?? "");
      setProbeDisclosure(null);
      setSecret("");
      setSelectedDiscoveredCredentialId(null);
      setPendingDeleteDiscoveryId(null);
      setPhase("catalog");
    } catch (cause: unknown) {
      setFailure(
        normalizeDrawerError(
          cause,
          modelHubCapabilityProbeSupportId({
            id: runtime.ids.next(),
            startedAt: runtime.clock.now(),
          }),
        ),
      );
      setFailureStage("connection");
      setPhase("failure");
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function continueWithChoice(): Promise<void> {
    const connectionResult = result;
    if (choice === "ai" && (connectionResult === null || selectedCatalogEntryId.length === 0))
      return;
    if (operationInFlightRef.current || busy) return;
    operationInFlightRef.current = true;
    if (choice !== "ai") {
      try {
        setProbeDisclosure(null);
        await onContinue(choice);
        onOpenChange(false);
      } finally {
        operationInFlightRef.current = false;
      }
      return;
    }
    if (connectionResult === null) return;
    setBusy(true);
    setFailure(null);
    try {
      if (probeDisclosure === null) {
        const inspected = await inspectQuickBookStartRouteProbe(runtime, {
          connectionId: connectionResult.connection.id,
          catalogEntryId: selectedCatalogEntryId,
        });
        setProbeDisclosure(inspected);
        return;
      }
      await configureQuickBookStartRoute(runtime, {
        connectionId: connectionResult.connection.id,
        catalogEntryId: selectedCatalogEntryId,
        targetSnapshot: probeDisclosure.targetSnapshot,
        invocationId: probeDisclosure.invocationId,
        humanConfirmed: true,
        disclosureFingerprint: probeDisclosure.fingerprint,
      });
      await onContinue("ai");
      onOpenChange(false);
    } catch (cause: unknown) {
      setProbeDisclosure(null);
      setFailure(
        normalizeDrawerError(
          cause,
          modelHubCapabilityProbeSupportId({
            id: runtime.ids.next(),
            startedAt: runtime.clock.now(),
          }),
        ),
      );
      setFailureStage("route");
      setPhase("failure");
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }

  function skip(): void {
    setSecret("");
    setSelectedDiscoveredCredentialId(null);
    setPendingDeleteDiscoveryId(null);
    onSkip();
    onOpenChange(false);
  }

  function returnToConnectionForm(): void {
    if (failure !== null && /AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN|401|403/u.test(failure.code)) {
      setSecret("");
    }
    setFailure(null);
    setPhase("connection");
  }

  function returnToCatalog(): void {
    setFailure(null);
    setProbeDisclosure(null);
    setPhase("catalog");
  }

  function requestOpenChange(nextOpen: boolean): void {
    if (busy && !nextOpen) return;
    onOpenChange(nextOpen);
  }

  const busyHelpId = busy ? "quick-ai-drawer-busy-help" : undefined;
  const skipButton = (
    <Button variant="ghost" disabled={busy} aria-describedby={busyHelpId} onClick={skip}>
      先不连接，继续开书
    </Button>
  );

  return (
    <Drawer
      open
      onOpenChange={requestOpenChange}
      dismissible={!busy}
      side="right"
      className="quick-ai-drawer"
      closeLabel="关闭 AI 连接"
      title={phase === "failure" ? failureTitle : "连接你的 AI"}
      description="连上后 AI 可以帮你起头、续写、查矛盾。不连也能正常写。"
      footer={
        <div className="quick-ai-drawer__footer">
          {skipButton}
          {phase === "catalog" ? (
            <>
              <Button
                loading={busy}
                disabled={busy || catalogContinueBlocked}
                aria-describedby={
                  busy
                    ? busyHelpId
                    : catalogContinueBlocked
                      ? "quick-ai-drawer-catalog-help"
                      : undefined
                }
                onClick={() => void continueWithChoice()}
              >
                {choice === "ai"
                  ? probeDisclosure === null
                    ? "查看固定验证说明"
                    : "确认 1 次固定验证并继续"
                  : "继续"}
              </Button>
              {!busy && catalogContinueBlocked && (
                <p id="quick-ai-drawer-catalog-help">{catalogContinueHelp}</p>
              )}
            </>
          ) : phase === "failure" ? (
            <>
              {failureStage === "connection" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  aria-describedby={busyHelpId}
                  onClick={returnToConnectionForm}
                >
                  返回修改
                </Button>
              )}
              {failureStage === "route" && !probeResultAmbiguous && !routeStateRequiresReview && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  aria-describedby={busyHelpId}
                  onClick={returnToCatalog}
                >
                  返回选择
                </Button>
              )}
              {failureStage === "connection" && !probeResultAmbiguous && (
                <Button
                  loading={busy}
                  disabled={busy}
                  aria-describedby={busyHelpId}
                  onClick={() => void connect()}
                >
                  重试
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                loading={busy}
                disabled={busy || connectionActionBlockers.length > 0}
                aria-describedby={
                  busy
                    ? busyHelpId
                    : connectionActionHelp === null
                      ? undefined
                      : "quick-ai-drawer-connection-help"
                }
                onClick={() => void connect()}
              >
                测试连接并查找模型
              </Button>
              {!busy && connectionActionHelp !== null && (
                <p id="quick-ai-drawer-connection-help">{connectionActionHelp}</p>
              )}
            </>
          )}
        </div>
      }
    >
      <InlineAlert
        tone={sharedReadinessSnapshot.failure !== null ? "warning" : "info"}
        title={`当前 AI 状态：${sharedReadiness.label}`}
        description={
          sharedReadinessSnapshot.failure === null
            ? `${sharedReadiness.description} 已保存连接：${String(sharedReadiness.savedConnectionCount)}；${sharedReadiness.needsRecheck ? "需要重新核对" : "当前证据已核对"}。`
            : `${sharedReadinessSnapshot.failure.description} 问题编号：${sharedReadinessSnapshot.failure.supportId}（联系支持时提供）。${sharedReadinessSnapshot.failure.recovery}`
        }
      />
      {sharedReadinessSnapshot.failure !== null && (
        <Button
          variant="secondary"
          onClick={() => window.dispatchEvent(new Event(MODEL_HUB_READINESS_CHANGED_EVENT))}
        >
          重新读取模型中心状态
        </Button>
      )}
      {busy && (
        <InlineAlert
          id="quick-ai-drawer-busy-help"
          tone="info"
          title="正在安全完成连接"
          description="正在验证并保存连接；完成前不能关闭，以免凭据操作被误认为已取消。"
        />
      )}
      {phase === "connection" && (
        <div className="quick-ai-drawer__content">
          {browserOnly && (
            <InlineAlert
              tone="info"
              title="浏览器预览不能保存凭据"
              description="为保护密钥，模型连接仅在桌面版开放；可先跳过，作品仍保存在本机。"
            />
          )}

          {sharedReadiness.savedConnectionCount === 0 && (
            <InlineAlert
              tone="info"
              title="模型连接不会跟随新数据目录"
              description="新目录不自动使用系统密钥。请恢复备份或重新连接；密钥须由你选择并验证。"
            />
          )}

          {credentialDiscoveryFailure !== null && (
            <InlineAlert
              tone="error"
              title="暂时无法检查本机已保存的接口密钥"
              description={`${credentialDiscoveryFailure.description} 问题编号：${credentialDiscoveryFailure.supportId}（联系支持时提供）`}
            />
          )}

          {mappedCredentialHint === null && unknownOriginCredentialCount > 0 && (
            <InlineAlert
              tone="warning"
              title={"发现 " + String(unknownOriginCredentialCount) + " 个来源无法确认的本机密钥"}
              description="无法确认原服务商或账号，不显示末四位，也不提供复用或删除。密钥未进入页面；请从对应服务重新复制。"
            />
          )}

          {mappedCredentialHint === null && trustedDiscoveredCredentials.length > 0 && (
            <section aria-label="本机已保存的墨影接口密钥">
              <InlineAlert
                tone="info"
                title={`找到 ${String(trustedDiscoveredCredentials.length)} 个墨影曾保存的接口密钥`}
                description="只显示末四位，不把密钥交给页面。选择“使用”后仍需测试连接；取消不会复用、替换或删除。"
              />
              {trustedDiscoveredCredentials.map((credential) => {
                const deleting = pendingDeleteDiscoveryId === credential.discoveryId;
                const selected = selectedDiscoveredCredentialId === credential.discoveryId;
                return (
                  <div key={credential.discoveryId}>
                    <p>已保存密钥 · 末四位 {credential.lastFour}</p>
                    <Button
                      variant={deleting || selected ? "secondary" : "ghost"}
                      disabled={busy}
                      aria-pressed={deleting ? undefined : selected}
                      aria-label={
                        deleting
                          ? `确认删除末四位 ${credential.lastFour} 的本机密钥`
                          : `使用末四位 ${credential.lastFour} 的已保存密钥`
                      }
                      onClick={() => {
                        if (deleting) {
                          void deleteDiscoveredCredential(credential.discoveryId);
                          return;
                        }
                        setSecret("");
                        setSelectedDiscoveredCredentialId(credential.discoveryId);
                        setPendingDeleteDiscoveryId(null);
                      }}
                    >
                      {deleting ? "确认删除" : "使用"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={
                        deleting
                          ? `取消删除末四位 ${credential.lastFour} 的本机密钥`
                          : `删除末四位 ${credential.lastFour} 的已保存密钥`
                      }
                      onClick={() =>
                        setPendingDeleteDiscoveryId(deleting ? null : credential.discoveryId)
                      }
                    >
                      {deleting ? "取消删除" : "删除"}
                    </Button>
                  </div>
                );
              })}
            </section>
          )}

          <fieldset className="quick-ai-drawer__providers" disabled={busy || browserOnly}>
            <legend>选择模型服务</legend>
            {QUICK_MODEL_PROVIDERS.map((candidate) => (
              <label key={candidate} className="quick-ai-drawer__provider">
                <input
                  type="radio"
                  name="quick-ai-provider"
                  value={candidate}
                  checked={provider === candidate}
                  onChange={() => {
                    setProvider(candidate);
                    setSecret("");
                    setRegion("china_beijing");
                    setWorkspaceId("");
                    setBaseUrl("");
                    setManualModelId("");
                    setCredentialHint(null);
                    setSelectedDiscoveredCredentialId(null);
                    setPendingDeleteDiscoveryId(null);
                    setFailure(null);
                  }}
                />
                <span>
                  <strong>{PROVIDER_COPY[candidate].label}</strong>
                  <small>{PROVIDER_COPY[candidate].description}</small>
                </span>
                {candidate === "deepseek" && <Badge tone="info">常用</Badge>}
                {candidate === "ollama" && <Badge tone="success">本地</Badge>}
              </label>
            ))}
          </fieldset>

          {provider === "alibaba_qwen" && (
            <>
              <FormField label="地域" required>
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={region}
                    options={QWEN_REGION_OPTIONS}
                    disabled={busy || browserOnly}
                    onChange={(event) => setRegion(event.currentTarget.value)}
                  />
                )}
              </FormField>
              {(region === "singapore" || workspaceRequired) && (
                <FormField
                  label="服务工作区编号"
                  hint={workspaceRequired ? "该地域必须填写。" : "新加坡地域可选。"}
                  required={workspaceRequired}
                >
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={workspaceId}
                      disabled={busy || browserOnly}
                      autoComplete="off"
                      onChange={(event) => setWorkspaceId(event.currentTarget.value)}
                    />
                  )}
                </FormField>
              )}
            </>
          )}

          {provider === "custom_openai_compatible" && (
            <FormField
              label="服务根地址"
              hint="填写兼容服务的根地址，不要粘贴完整的 /chat/completions 路径。"
              required
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="url"
                  value={baseUrl}
                  disabled={busy || browserOnly}
                  autoComplete="off"
                  placeholder="https://example.com/v1"
                  onChange={(event) => setBaseUrl(event.currentTarget.value)}
                />
              )}
            </FormField>
          )}

          {(needsManualModel || provider === "custom_openai_compatible") && (
            <FormField
              label={provider === "volcengine_doubao" ? "模型或接入点编号" : "模型编号"}
              hint={
                provider === "custom_openai_compatible"
                  ? "可选；接口没有提供可用模型列表时填写，墨影会用固定短句验证。"
                  : "从模型服务控制台复制；墨影不会把某个模型名称永久写死。"
              }
              required={needsManualModel}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={manualModelId}
                  disabled={busy || browserOnly}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setManualModelId(event.currentTarget.value)}
                />
              )}
            </FormField>
          )}

          {provider === "ollama" ? (
            <InlineAlert
              tone="info"
              title="内容留在这台电脑"
              description="本地模型在本机运算，内容不出这台电脑。请先确认 Ollama 已启动并安装了文本模型。"
            />
          ) : (
            <FormField
              label={provider === "custom_openai_compatible" ? "接口密钥（可选）" : "接口密钥"}
              hint={
                currentCredentialHint ??
                (provider === "custom_openai_compatible"
                  ? "只在兼容服务要求访问密钥时填写。其他鉴权方式请使用完整模型中心。"
                  : "只需填写模型服务提供的接口密钥。")
              }
              required={needsSecret}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy || browserOnly}
                  value={secret}
                  placeholder={
                    currentCredentialHint === null ? "粘贴接口密钥" : "留空可继续使用已保存密钥"
                  }
                  onChange={(event) => {
                    setSecret(event.currentTarget.value);
                    setSelectedDiscoveredCredentialId(null);
                    setPendingDeleteDiscoveryId(null);
                  }}
                />
              )}
            </FormField>
          )}

          <p className="quick-ai-drawer__privacy-note">
            接口密钥仅保存在 Windows 凭据管理器，用于连接所选模型服务，不会发送到墨影服务器。
          </p>
          <Link
            className="back-link"
            to="/settings#model-center"
            aria-disabled={busy}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) {
                event.preventDefault();
                return;
              }
              onOpenChange(false);
            }}
          >
            更多模型服务与完整模型中心设置
          </Link>
        </div>
      )}

      {phase === "catalog" && result !== null && (
        <div className="quick-ai-drawer__content">
          <InlineAlert
            tone="info"
            title="连接成功 · 已找到模型"
            description={`连接和可用模型检查已完成，共找到 ${String(result.catalog.length)} 个可用模型；这一步没有发送作品内容，也没有向模型发送生成请求。选择“让 AI 起个头”后，墨影会先展示固定验证的精确范围。`}
          />
          <FormField label="开书使用的模型" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={selectedCatalogEntryId}
                options={modelOptions}
                onChange={(event) => {
                  setSelectedCatalogEntryId(event.currentTarget.value);
                  setAutomaticTextSelectionUnavailable(false);
                  setProbeDisclosure(null);
                }}
              />
            )}
          </FormField>
          <fieldset className="quick-ai-drawer__choices" disabled={busy}>
            <legend>接下来怎么开始？</legend>
            {(
              [
                ["ai", "让 AI 起个头", "验证所选模型并用于这次开书"],
                ["self", "我自己写", "不向模型发送内容，进入空白创建"],
                ["sample", "先看看示例", "使用明确标注的本地示例，不发送灵感"],
              ] as const
            ).map(([value, label, description]) => (
              <label key={value} className="quick-ai-drawer__choice">
                <input
                  type="radio"
                  aria-label={`${label}：${description}`}
                  name="quick-ai-next-step"
                  value={value}
                  checked={choice === value}
                  onChange={() => {
                    setChoice(value);
                    setProbeDisclosure(null);
                  }}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {choice === "ai" && probeDisclosure !== null && (
            <InlineAlert
              tone="warning"
              title="发送固定验证前确认"
              description={`将通过“${probeDisclosure.connectionDisplayName}”的“${probeDisclosure.modelId}”发送固定短句“只回复：OK”，AI 最多返回 ${String(probeDisclosure.maximumOutputTokens)} 个文字量单位（这不是金额）；最多向模型服务发送 ${String(probeDisclosure.maximumProviderCalls)} 次，自动重试 ${String(probeDisclosure.automaticRetryCount)} 次。${probeDisclosure.dataDestination === "local" ? "验证只在本机运行。" : "验证会发送到所选远程模型服务。"} 不发送作品正文、灵感、设定或接口密钥；当前没有可核验的费用上限，模型服务仍可能收取少量费用。`}
            />
          )}
        </div>
      )}

      {phase === "failure" && failure !== null && (
        <div className="quick-ai-drawer__content">
          <InlineAlert
            tone={probeResultAmbiguous ? "warning" : "error"}
            title={failureTitle}
            description={failure.message}
          />
          {failure.supportId !== null && <p>问题编号：{failure.supportId}（联系支持时提供）</p>}
          <p>
            {routeStateRequiresReview
              ? "请到模型中心核对开书设置。系统不会自动验证或改动作品。"
              : probeResultAmbiguous
                ? "项目、正文和 AI 建议未修改，也不会自动重发；可先跳过，或到模型使用与费用核对记录。"
                : probePreparationFailed
                  ? "连接和可用模型列表仍可用，作品未发送或修改；可查看说明后再试。"
                  : "项目、正文和 AI 建议未修改；可重试或先跳过。"}
          </p>
          <Link
            className="back-link"
            to="/settings?targetSection=model-capabilities#model-center"
            aria-disabled={busy}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) {
                event.preventDefault();
                return;
              }
              onOpenChange(false);
            }}
          >
            打开完整模型中心排查
          </Link>
        </div>
      )}
    </Drawer>
  );
}

function normalizeCredentialDiscoveryFailure(
  cause: unknown,
  fallbackTraceId: string,
  occurredAt: string,
): CredentialDiscoveryFailure {
  const traceId =
    typeof cause === "object" &&
    cause !== null &&
    "requestId" in cause &&
    typeof cause.requestId === "string" &&
    /^[A-Za-z0-9-]{8,80}$/u.test(cause.requestId)
      ? cause.requestId
      : fallbackTraceId;
  return Object.freeze({
    description: "本机凭据检查未完成。密钥未进入页面，也未复用、替换或删除，请稍后重试。",
    supportId: modelHubCapabilityProbeSupportId({
      id: traceId,
      startedAt: occurredAt,
    }),
  });
}

function normalizeDrawerError(
  cause: unknown,
  fallbackSupportId: string,
): QuickModelConnectionError {
  if (cause instanceof QuickModelConnectionError) {
    return cause.supportId !== null
      ? cause
      : new QuickModelConnectionError(
          cause.code,
          cause.message,
          cause.retryable,
          fallbackSupportId,
          cause.failureStage,
          cause.providerDispatchCount,
        );
  }
  return new QuickModelConnectionError(
    "QUICK_MODEL_CONNECTION_FAILED",
    "连接检查未完成。请核对模型服务和连接资料；仍失败时请记下问题编号并联系支持。",
    true,
    fallbackSupportId,
    "connection",
    0,
  );
}
