import { Badge, Button, Drawer, FormField, InlineAlert, Input, Select } from "@inkshadow/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { modelHubCredentialProviderId } from "../infrastructure/model-hub-native-config";
import { getModelProviderPreset } from "../infrastructure/model-hub-provider-registry";
import {
  QUICK_MODEL_PROVIDERS,
  QuickModelConnectionError,
  configureQuickBookStartRoute,
  connectQuickModelProvider,
  type QuickModelConnectionResult,
  type QuickModelProvider,
} from "../infrastructure/quick-model-connection-service";
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

const PROVIDER_COPY: Readonly<
  Record<QuickModelProvider, Readonly<{ label: string; description: string }>>
> = Object.freeze({
  openai: Object.freeze({ label: "OpenAI", description: "官方云端 API" }),
  deepseek: Object.freeze({ label: "DeepSeek", description: "官方云端 API" }),
  alibaba_qwen: Object.freeze({ label: "阿里云百炼 / Qwen", description: "选择地域和模型" }),
  volcengine_doubao: Object.freeze({
    label: "火山方舟 / 豆包",
    description: "使用模型或 Endpoint ID",
  }),
  zhipu_glm: Object.freeze({ label: "智谱 GLM", description: "填写账号可用模型 ID" }),
  ollama: Object.freeze({ label: "Ollama", description: "本机运行，无需 API Key" }),
  custom_openai_compatible: Object.freeze({
    label: "自定义兼容接口",
    description: "OpenAI-compatible 根地址",
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
  const [provider, setProvider] = useState<QuickModelProvider>("openai");
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
  const [phase, setPhase] = useState<DrawerPhase>("connection");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuickModelConnectionResult | null>(null);
  const [selectedCatalogEntryId, setSelectedCatalogEntryId] = useState("");
  const [choice, setChoice] = useState<QuickAiContinueChoice>("ai");
  const [failure, setFailure] = useState<QuickModelConnectionError | null>(null);
  const [failureStage, setFailureStage] = useState<FailureStage>("connection");

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
        const connection =
          connections.find(({ id }) => id === provider) ??
          connections.find(({ providerKind }) => providerKind === provider);
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
                ? "已保存可用 Key"
                : `已保存 Key（末四位 ${summary.lastFour}）`,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [provider, runtime]);

  const modelOptions = useMemo(
    () =>
      result?.catalog.map(({ displayName, id, providerModelId }) => ({
        value: id,
        label:
          displayName === providerModelId ? displayName : `${displayName} · ${providerModelId}`,
      })) ?? [],
    [result],
  );
  const browserOnly = runtime.mode !== "tauri";
  const providerPreset = getModelProviderPreset(provider);
  const currentCredentialHint = credentialHint?.provider === provider ? credentialHint.label : null;
  const needsSecret = providerPreset.credentialRequired && currentCredentialHint === null;
  const needsManualModel = MANUAL_MODEL_PROVIDERS.has(provider);
  const workspaceRequired =
    provider === "alibaba_qwen" && (region === "japan_tokyo" || region === "germany_frankfurt");
  const connectionFormIncomplete =
    (needsSecret && secret.length === 0) ||
    (needsManualModel && manualModelId.trim().length === 0) ||
    (provider === "custom_openai_compatible" && baseUrl.trim().length === 0) ||
    (workspaceRequired && workspaceId.trim().length === 0);

  async function connect(): Promise<void> {
    if (busy || browserOnly) return;
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
      });
      setResult(connected);
      setSelectedCatalogEntryId(connected.catalog[0]?.id ?? "");
      setSecret("");
      setPhase("catalog");
    } catch (cause: unknown) {
      setFailure(normalizeDrawerError(cause));
      setFailureStage("connection");
      setPhase("failure");
    } finally {
      setBusy(false);
    }
  }

  async function continueWithChoice(): Promise<void> {
    if (busy) return;
    if (choice !== "ai") {
      await onContinue(choice);
      onOpenChange(false);
      return;
    }
    if (result === null || selectedCatalogEntryId.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      await configureQuickBookStartRoute(runtime, {
        connectionId: result.connection.id,
        catalogEntryId: selectedCatalogEntryId,
      });
      await onContinue("ai");
      onOpenChange(false);
    } catch (cause: unknown) {
      setFailure(normalizeDrawerError(cause));
      setFailureStage("route");
      setPhase("failure");
    } finally {
      setBusy(false);
    }
  }

  function skip(): void {
    setSecret("");
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
    setPhase("catalog");
  }

  function requestOpenChange(nextOpen: boolean): void {
    if (busy && !nextOpen) return;
    onOpenChange(nextOpen);
  }

  return (
    <Drawer
      open
      onOpenChange={requestOpenChange}
      dismissible={!busy}
      side="right"
      className="quick-ai-drawer"
      closeLabel="关闭 AI 连接"
      title={phase === "failure" ? "连接没成功" : "连接你的 AI"}
      description="连上后 AI 可以帮你起头、续写、查矛盾。不连也能正常写。"
      footer={
        phase === "catalog" ? (
          <div className="quick-ai-drawer__footer">
            <Button variant="ghost" disabled={busy} onClick={skip}>
              先不连接，继续开书
            </Button>
            <Button
              loading={busy}
              disabled={choice === "ai" && selectedCatalogEntryId.length === 0}
              onClick={() => void continueWithChoice()}
            >
              继续
            </Button>
          </div>
        ) : phase === "failure" ? (
          <div className="quick-ai-drawer__footer">
            <Button variant="ghost" disabled={busy} onClick={skip}>
              先不连接，继续开书
            </Button>
            {failureStage === "connection" && (
              <Button variant="secondary" disabled={busy} onClick={returnToConnectionForm}>
                返回修改
              </Button>
            )}
            {failureStage === "route" && (
              <Button variant="secondary" disabled={busy} onClick={returnToCatalog}>
                返回选择
              </Button>
            )}
            <Button
              loading={busy}
              onClick={() => void (failureStage === "route" ? continueWithChoice() : connect())}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="quick-ai-drawer__footer">
            <Button variant="ghost" disabled={busy} onClick={skip}>
              先不连接，继续开书
            </Button>
            <Button
              loading={busy}
              disabled={browserOnly || connectionFormIncomplete}
              onClick={() => void connect()}
            >
              测试连接并查找模型
            </Button>
          </div>
        )
      }
    >
      {busy && (
        <InlineAlert
          tone="info"
          title="正在安全完成连接"
          description="墨影正在验证模型并安全保存连接。完成前暂时不能关闭此面板，以免让仍在进行的凭据操作看起来像已经取消。"
        />
      )}
      {phase === "connection" && (
        <div className="quick-ai-drawer__content">
          {browserOnly && (
            <InlineAlert
              tone="info"
              title="浏览器预览不能保存凭据"
              description="为保护 API Key，连接供应商和本机模型只在桌面版开放。你可以先跳过，作品仍会保存在本机。"
            />
          )}

          <fieldset className="quick-ai-drawer__providers" disabled={busy || browserOnly}>
            <legend>选择供应商</legend>
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
                  label="Workspace ID"
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
              label="Base URL"
              hint="填写兼容服务的根地址，不要粘贴完整 chat/completions 地址。"
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
              label={provider === "volcengine_doubao" ? "模型或 Endpoint ID" : "模型 ID"}
              hint={
                provider === "custom_openai_compatible"
                  ? "可选；接口没有 /models 时填写，墨影会用固定短句验证。"
                  : "从供应商控制台复制；墨影不会把某个模型名称永久写死。"
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
              label={provider === "custom_openai_compatible" ? "API Key（可选）" : "API Key"}
              hint={
                currentCredentialHint ??
                (provider === "custom_openai_compatible"
                  ? "只在兼容服务要求 Bearer Key 时填写。其他鉴权方式请使用完整 Model Hub。"
                  : "只需填写供应商提供的 API Key。")
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
                    currentCredentialHint === null ? "粘贴 API Key" : "留空可继续使用已保存 Key"
                  }
                  onChange={(event) => setSecret(event.currentTarget.value)}
                />
              )}
            </FormField>
          )}

          <p className="quick-ai-drawer__privacy-note">
            API Key 保存在 Windows 凭据管理器中，仅在调用你选择的服务商时直接用于鉴权。墨影不会将
            Key 发送到自己的服务器。
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
            更多供应商与完整 Model Hub 设置
          </Link>
        </div>
      )}

      {phase === "catalog" && result !== null && (
        <div className="quick-ai-drawer__content">
          <InlineAlert
            tone="info"
            title="连接成功 · 已找到模型"
            description={`真实连接测试已通过，共找到 ${String(result.catalog.length)} 个可用模型。选择“让 AI 起个头”后，还会用固定短句验证所选模型确实能生成文字。`}
          />
          <FormField label="开书使用的模型" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={selectedCatalogEntryId}
                options={modelOptions}
                onChange={(event) => setSelectedCatalogEntryId(event.currentTarget.value)}
              />
            )}
          </FormField>
          <fieldset className="quick-ai-drawer__choices" disabled={busy}>
            <legend>接下来怎么开始？</legend>
            {(
              [
                ["ai", "让 AI 起个头", "验证所选模型并用于这次开书"],
                ["self", "我自己写", "不调用模型，进入空白创建"],
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
                  onChange={() => setChoice(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {phase === "failure" && failure !== null && (
        <div className="quick-ai-drawer__content">
          <InlineAlert tone="error" title="连接没成功" description={failure.message} />
          <p className="quick-ai-drawer__error-code">错误码：{failure.code}</p>
          <p>已有项目、正文和 AI 建议版本都没有被修改。你可以重试，也可以先跳过继续写。</p>
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
            打开完整 Model Hub 排查
          </Link>
        </div>
      )}
    </Drawer>
  );
}

function normalizeDrawerError(cause: unknown): QuickModelConnectionError {
  return cause instanceof QuickModelConnectionError
    ? cause
    : new QuickModelConnectionError(
        "QUICK_MODEL_CONNECTION_FAILED",
        "连接或模型检查没有成功。请检查网络、Key 和模型状态后重试。",
      );
}
