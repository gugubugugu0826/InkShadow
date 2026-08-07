import {
  parseCreativeExtensionCandidate,
  type CreativeExtensionCandidatePayload,
} from "@inkshadow/ai-core";
import type {
  GovernedExtensionCandidate,
  GovernedExtensionKind,
  GovernedExtensionRequest,
} from "@inkshadow/data";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  InlineAlert,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@inkshadow/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from "react";

import {
  DEFAULT_GOVERNED_CREATIVE_EXTENSION_FLAGS,
  type GovernedCreativeExtensionDraft,
  type GovernedCreativeExtensionPreflight,
  type GovernedCreativeExtensionSource,
  type GovernedCreativeExtensionsRuntime,
  type GovernedExtensionHistory,
} from "../infrastructure/governed-creative-extensions-runtime";

import "./governed-creative-extensions-page.css";

export type GovernedCreativeExtensionsPageRuntime = Pick<
  GovernedCreativeExtensionsRuntime,
  | "acceptCandidate"
  | "cancel"
  | "confirmRemoteEgress"
  | "exportHistory"
  | "getCapabilities"
  | "listHistory"
  | "preflight"
  | "prepareRetry"
  | "rejectCandidate"
  | "run"
>;

export interface GovernedCreativeExtensionsPageProps {
  readonly runtime: GovernedCreativeExtensionsPageRuntime | null;
  readonly projectId: string;
  readonly source: GovernedCreativeExtensionSource | null;
  readonly initialKind?: GovernedExtensionKind;
  readonly onExportHistory?: (filename: string, content: string) => void;
}

type BusyAction = "consent" | "run" | "cancel" | "retry" | "decision" | "export" | null;

const EMPTY_HISTORY: GovernedExtensionHistory = Object.freeze({
  requests: Object.freeze([]),
  candidates: Object.freeze([]),
});

const LANGUAGE_OPTIONS = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
] as const;

const FORMAT_OPTIONS = [
  { value: "vertical_micro_drama", label: "竖屏微短剧" },
  { value: "standard_short_drama", label: "标准短剧" },
] as const;

export function GovernedCreativeExtensionsPage({
  runtime,
  projectId,
  source,
  initialKind = "translation",
  onExportHistory,
}: GovernedCreativeExtensionsPageProps) {
  const [kind, setKind] = useState<GovernedExtensionKind>(initialKind);
  const [history, setHistory] = useState<GovernedExtensionHistory>(EMPTY_HISTORY);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<GovernedCreativeExtensionPreflight | null>(null);
  const [preparedRetry, setPreparedRetry] = useState<GovernedCreativeExtensionPreflight | null>(
    null,
  );
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const [targetLanguage, setTargetLanguage] = useState("en-US");
  const [translationTone, setTranslationTone] = useState("literary");
  const [glossaryVersion, setGlossaryVersion] = useState("glossary-v1");
  const [glossaryText, setGlossaryText] = useState("");
  const [dramaFormat, setDramaFormat] = useState<"vertical_micro_drama" | "standard_short_drama">(
    "vertical_micro_drama",
  );
  const [episodeCount, setEpisodeCount] = useState(1);
  const [episodeDuration, setEpisodeDuration] = useState(90);
  const [dramaTone, setDramaTone] = useState("suspense");

  const [egressAcknowledged, setEgressAcknowledged] = useState(false);
  const [consentToken, setConsentToken] = useState<string | null>(null);
  const [consentExpiresAt, setConsentExpiresAt] = useState<string | null>(null);

  const capabilities = runtime?.getCapabilities() ?? {
    flags: DEFAULT_GOVERNED_CREATIVE_EXTENSION_FLAGS,
    environment: { online: false, readOnly: true },
  };
  const featureEnabled =
    kind === "translation" ? capabilities.flags.translation : capabilities.flags.shortDrama;

  const draft = useMemo<GovernedCreativeExtensionDraft | null>(() => {
    if (source === null) {
      return null;
    }
    if (kind === "translation") {
      const language =
        LANGUAGE_OPTIONS.find(({ value }) => value === targetLanguage) ?? LANGUAGE_OPTIONS[0];
      return {
        kind: "translation",
        source,
        settings: {
          targetLanguage: { code: language.value, label: language.label },
          tone: translationTone.trim(),
          glossaryVersion: glossaryVersion.trim(),
          glossary: parseGlossary(glossaryText),
        },
      };
    }
    return {
      kind: "short_drama",
      source,
      settings: {
        format: dramaFormat,
        targetEpisodeCount: episodeCount,
        targetEpisodeDurationSeconds: episodeDuration,
        tone: dramaTone.trim(),
      },
    };
  }, [
    dramaFormat,
    dramaTone,
    episodeCount,
    episodeDuration,
    glossaryText,
    glossaryVersion,
    kind,
    source,
    targetLanguage,
    translationTone,
  ]);

  const loadHistory = useCallback(async () => {
    if (runtime === null) {
      setHistory(EMPTY_HISTORY);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const loaded = await runtime.listHistory(projectId, undefined, 100);
      setHistory(loaded);
      setSelectedRequestId((current) => current ?? loaded.requests[0]?.id ?? null);
    } catch (error: unknown) {
      setFailure(publicError(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [projectId, runtime]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadHistory();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadHistory]);

  useEffect(() => {
    if (preparedRetry !== null) {
      return;
    }
    let active = true;
    if (runtime === null || draft === null) {
      const timer = window.setTimeout(() => {
        if (active) {
          setPreflight(null);
          setPreflightLoading(false);
        }
      }, 0);
      return () => {
        active = false;
        window.clearTimeout(timer);
      };
    }
    const timer = window.setTimeout(() => {
      if (!active) {
        return;
      }
      setPreflightLoading(true);
      void runtime
        .preflight(draft)
        .then((result) => {
          if (active) {
            setPreflight(result);
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setPreflight(null);
            setFailure(publicError(error));
          }
        })
        .finally(() => {
          if (active) {
            setPreflightLoading(false);
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft, preparedRetry, runtime]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setEgressAcknowledged(false);
      setConsentToken(null);
      setConsentExpiresAt(null);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [preflight?.requestFingerprint]);

  const selectedRequest = history.requests.find(({ id }) => id === selectedRequestId) ?? null;
  const selectedCandidate =
    history.candidates.find(
      ({ id }) => id === (selectedCandidateId ?? selectedRequest?.candidateId),
    ) ?? null;
  const preview = useMemo(() => parseCandidatePreview(selectedCandidate), [selectedCandidate]);
  const sourceParagraphs = useMemo(
    () => readHistoricalSourceParagraphs(selectedRequest, source),
    [selectedRequest, source],
  );

  function changeKind(next: string): void {
    if (next !== "translation" && next !== "short_drama") {
      return;
    }
    setKind(next);
    clearPreparedRetry();
  }

  function clearPreparedRetry(): void {
    setPreparedRetry(null);
  }

  async function confirmEgress(): Promise<void> {
    if (
      runtime === null ||
      preflight === null ||
      !preflight.requiresRemoteConsent ||
      !egressAcknowledged
    ) {
      return;
    }
    setBusy("consent");
    setFailure(null);
    try {
      const issued = await runtime.confirmRemoteEgress(preflight);
      setConsentToken(issued.token);
      setConsentExpiresAt(issued.expiresAt);
      setAnnouncement("已创建仅用于本次请求的一次性远程发送确认。");
    } catch (error: unknown) {
      setFailure(publicError(error));
    } finally {
      setBusy(null);
    }
  }

  async function run(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      runtime === null ||
      preflight === null ||
      !preflight.ready ||
      (preflight.requiresRemoteConsent && consentToken === null)
    ) {
      return;
    }
    setBusy("run");
    setFailure(null);
    setAnnouncement("正在执行模型请求。候选结果不会直接覆盖章节或大纲。");
    try {
      const result = await runtime.run(preflight, {
        ...(consentToken === null ? {} : { consentToken }),
        onRequestStarted: (request) => {
          setActiveRequestId(request.id);
          setSelectedRequestId(request.id);
          setHistory((current) => ({
            ...current,
            requests: [request, ...current.requests.filter(({ id }) => id !== request.id)],
          }));
        },
      });
      setActiveRequestId(null);
      setConsentToken(null);
      setConsentExpiresAt(null);
      setPreparedRetry(null);
      await loadHistory();
      setSelectedRequestId(result.request.id);
      setSelectedCandidateId(result.candidate?.id ?? null);
      setAnnouncement(
        result.candidate === null
          ? `请求已结束：${requestStatusLabel(result.request.status)}。`
          : "隔离候选已就绪；请审阅后再明确采纳或拒绝。",
      );
    } catch (error: unknown) {
      setActiveRequestId(null);
      setConsentToken(null);
      setConsentExpiresAt(null);
      setFailure(publicError(error));
      await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function cancelActive(): Promise<void> {
    if (runtime === null || activeRequestId === null) {
      return;
    }
    setBusy("cancel");
    setFailure(null);
    try {
      const request = await runtime.cancel(activeRequestId);
      setAnnouncement(`请求已结束：${requestStatusLabel(request.status)}。`);
      setActiveRequestId(null);
      await loadHistory();
      setSelectedRequestId(request.id);
    } catch (error: unknown) {
      setFailure(publicError(error));
    } finally {
      setBusy(null);
    }
  }

  async function prepareSelectedRetry(): Promise<void> {
    if (runtime === null || selectedRequest === null) {
      return;
    }
    setBusy("retry");
    setFailure(null);
    try {
      const next = await runtime.prepareRetry(selectedRequest.id);
      setKind(next.snapshot.kind);
      if (next.snapshot.kind === "translation") {
        setTargetLanguage(next.snapshot.settings.targetLanguage.code);
        setTranslationTone(next.snapshot.settings.tone);
        setGlossaryVersion(next.snapshot.settings.glossaryVersion);
        setGlossaryText(
          next.snapshot.settings.glossary
            .map(
              ({ source: termSource, target, note }) =>
                `${termSource} = ${target}${note === null ? "" : ` | ${note}`}`,
            )
            .join("\n"),
        );
      } else {
        setDramaFormat(next.snapshot.settings.format);
        setEpisodeCount(next.snapshot.settings.targetEpisodeCount);
        setEpisodeDuration(next.snapshot.settings.targetEpisodeDurationSeconds);
        setDramaTone(next.snapshot.settings.tone);
      }
      setPreparedRetry(next);
      setPreflight(next);
      setAnnouncement(
        `已准备第 ${String(next.retry?.attempt ?? 1)} 次尝试；这会产生新的预算预留和费用记录。`,
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error: unknown) {
      setFailure(publicError(error));
    } finally {
      setBusy(null);
    }
  }

  async function decideCandidate(decision: "accept" | "reject"): Promise<void> {
    if (runtime === null || selectedCandidate?.status !== "ready") {
      return;
    }
    setBusy("decision");
    setFailure(null);
    try {
      if (decision === "accept") {
        const result = await runtime.acceptCandidate(
          selectedCandidate.id,
          selectedCandidate.revision,
        );
        setAnnouncement(
          result.outcome === "accepted"
            ? "候选已作为独立衍生成果采纳，原章节与大纲保持不变。"
            : "来源版本已经变化，候选已自动过期且没有写入正式成果。",
        );
      } else {
        await runtime.rejectCandidate(selectedCandidate.id, selectedCandidate.revision);
        setAnnouncement("候选已拒绝；原章节与大纲保持不变。");
      }
      await loadHistory();
    } catch (error: unknown) {
      setFailure(publicError(error));
    } finally {
      setBusy(null);
    }
  }

  async function exportHistory(): Promise<void> {
    if (runtime === null) {
      return;
    }
    setBusy("export");
    setFailure(null);
    try {
      const artifact = await runtime.exportHistory(projectId);
      onExportHistory?.(artifact.filename, artifact.content);
      setAnnouncement("历史记录已准备导出；其中不包含一次性明文同意凭据。");
    } catch (error: unknown) {
      setFailure(publicError(error));
    } finally {
      setBusy(null);
    }
  }

  const canRun =
    preflight?.ready === true &&
    busy === null &&
    (!preflight.requiresRemoteConsent || consentToken !== null);

  return (
    <div className="governed-extensions-page">
      <header className="governed-extensions-page__header">
        <div>
          <p className="governed-extensions-page__eyebrow">受治理的创作扩展</p>
          <h1>翻译与短剧工作台</h1>
          <p>
            固定来源版本、目的地和费用边界。所有模型输出先进入隔离候选区，永不直接覆盖正文或大纲。
          </p>
        </div>
        <div className="governed-extensions-page__header-actions">
          {capabilities.environment.readOnly && <Badge tone="warning">只读</Badge>}
          {!capabilities.environment.online && <Badge tone="neutral">离线</Badge>}
          <Button
            variant="secondary"
            loading={busy === "export"}
            disabled={runtime === null}
            onClick={() => void exportHistory()}
          >
            导出历史
          </Button>
        </div>
      </header>

      {failure !== null && (
        <InlineAlert
          tone="error"
          title="操作未完成"
          description={failure}
          onDismiss={() => setFailure(null)}
        />
      )}
      {!featureEnabled && (
        <InlineAlert
          tone="warning"
          title={`${kind === "translation" ? "翻译" : "短剧"}服务尚未启用`}
          description="历史记录与导出仍可使用，但预检会阻止模型调用、重试和候选决策。"
        />
      )}
      <div className="governed-extensions-page__announcer" aria-live="polite" role="status">
        {announcement}
      </div>

      <Tabs
        className="governed-extensions-page__tabs"
        defaultValue={initialKind}
        value={kind}
        onValueChange={changeKind}
      >
        <TabsList label="创作扩展服务">
          <TabsTrigger value="translation">章节翻译</TabsTrigger>
          <TabsTrigger value="short_drama">短剧改编</TabsTrigger>
        </TabsList>

        <div className="governed-extensions-page__workspace">
          <section className="governed-extensions-page__composer" aria-label="服务设置">
            {source === null ? (
              <EmptyState
                kind="feature_limited"
                title="请选择一个章节"
                description="服务必须绑定当前章节的精确版本与校验值。"
              />
            ) : (
              <form onSubmit={(event) => void run(event)}>
                <Card className="governed-extensions-source">
                  <CardHeader>
                    <CardTitle>来源权威</CardTitle>
                    <CardDescription>只读取当前绑定版本，不会直接修改它。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="governed-extensions-kv">
                      <div>
                        <dt>章节</dt>
                        <dd>{source.chapterTitle}</dd>
                      </div>
                      <div>
                        <dt>版本</dt>
                        <dd title={source.sourceVersionId}>{shortId(source.sourceVersionId)}</dd>
                      </div>
                      <div>
                        <dt>项目</dt>
                        <dd title={source.projectId}>{shortId(source.projectId)}</dd>
                      </div>
                      <div>
                        <dt>SHA-256</dt>
                        <dd title={source.sourceChecksum}>{shortHash(source.sourceChecksum)}</dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>

                <TabsContent value="translation">
                  <Card>
                    <CardHeader>
                      <CardTitle>翻译设置</CardTitle>
                      <CardDescription>
                        逐段引用来源，并绑定语言、语气和术语表版本。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="governed-extensions-form-grid">
                      <FormField label="目标语言" required>
                        {(field) => (
                          <Select
                            {...field}
                            value={targetLanguage}
                            options={LANGUAGE_OPTIONS}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setTargetLanguage(event.target.value);
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                      <FormField label="语气" required>
                        {(field) => (
                          <Input
                            {...field}
                            value={translationTone}
                            maxLength={120}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setTranslationTone(event.target.value);
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                      <FormField
                        label="术语表版本"
                        required
                        hint="版本会进入请求指纹，变更后必须重新确认远程发送。"
                      >
                        {(field) => (
                          <Input
                            {...field}
                            value={glossaryVersion}
                            maxLength={128}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setGlossaryVersion(event.target.value);
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                      <FormField
                        className="governed-extensions-form-grid__wide"
                        label="术语"
                        hint="每行：原词 = 译词 | 可选备注"
                      >
                        {(field) => (
                          <Textarea
                            {...field}
                            value={glossaryText}
                            rows={5}
                            maxLength={12_000}
                            currentLength={glossaryText.length}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setGlossaryText(event.target.value);
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="short_drama">
                  <Card>
                    <CardHeader>
                      <CardTitle>短剧设置</CardTitle>
                      <CardDescription>
                        输出必须提供集、场、镜头、对白、时长汇总和可校验的来源段落引用。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="governed-extensions-form-grid">
                      <FormField label="成片格式" required>
                        {(field) => (
                          <Select
                            {...field}
                            value={dramaFormat}
                            options={FORMAT_OPTIONS}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setDramaFormat(
                                event.target.value === "standard_short_drama"
                                  ? "standard_short_drama"
                                  : "vertical_micro_drama",
                              );
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                      <FormField label="目标集数" required>
                        {(field) => (
                          <Input
                            {...field}
                            type="number"
                            min={1}
                            max={24}
                            value={episodeCount}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setEpisodeCount(readNumber(event, 1));
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                      <FormField label="单集时长（秒）" required>
                        {(field) => (
                          <Input
                            {...field}
                            type="number"
                            min={15}
                            max={7200}
                            value={episodeDuration}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setEpisodeDuration(readNumber(event, 15));
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                      <FormField label="改编语气" required>
                        {(field) => (
                          <Input
                            {...field}
                            value={dramaTone}
                            maxLength={120}
                            disabled={preparedRetry !== null}
                            onChange={(event) => {
                              setDramaTone(event.target.value);
                              clearPreparedRetry();
                            }}
                          />
                        )}
                      </FormField>
                    </CardContent>
                  </Card>
                </TabsContent>

                <PreflightPanel
                  preflight={preflight}
                  loading={preflightLoading}
                  acknowledged={egressAcknowledged}
                  consentReady={consentToken !== null}
                  consentExpiresAt={consentExpiresAt}
                  busy={busy}
                  onAcknowledged={setEgressAcknowledged}
                  onConfirm={() => void confirmEgress()}
                />

                <div className="governed-extensions-runbar">
                  <div>
                    <strong>
                      {preflight?.retry === null
                        ? "创建新的隔离候选"
                        : `执行第 ${String(preflight?.retry?.attempt ?? 1)} 次尝试`}
                    </strong>
                    <span>
                      {preflight === null
                        ? "等待预检"
                        : `${formatMicros(preflight.estimate.maximumCostMicros, preflight.estimate.currency)} 最大内部预留`}
                    </span>
                  </div>
                  <div className="governed-extensions-actions">
                    {activeRequestId !== null && (
                      <Button
                        variant="danger"
                        loading={busy === "cancel"}
                        onClick={() => void cancelActive()}
                      >
                        停止
                      </Button>
                    )}
                    <Button
                      type="submit"
                      variant="ai-primary"
                      loading={busy === "run"}
                      disabled={!canRun}
                    >
                      {preflight?.requiresRemoteConsent === true && consentToken === null
                        ? "先确认远程发送"
                        : "生成隔离候选"}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </section>

          <aside className="governed-extensions-history" aria-label="请求历史">
            <div className="governed-extensions-section-heading">
              <div>
                <h2>历史与候选</h2>
                <span>功能关闭时仍可只读查看与导出</span>
              </div>
              <Badge tone="neutral">{history.requests.length}</Badge>
            </div>
            {historyLoading ? (
              <p className="governed-extensions-muted" role="status">
                正在读取历史…
              </p>
            ) : history.requests.length === 0 ? (
              <EmptyState
                title="还没有运行记录"
                description="完成预检后，新的请求与候选会显示在这里。"
              />
            ) : (
              <ol className="governed-extensions-history__list">
                {history.requests.map((request) => (
                  <li key={request.id}>
                    <button
                      type="button"
                      className="governed-extensions-history__item"
                      data-selected={request.id === selectedRequestId ? true : undefined}
                      aria-pressed={request.id === selectedRequestId}
                      onClick={() => {
                        setSelectedRequestId(request.id);
                        setSelectedCandidateId(request.candidateId);
                      }}
                    >
                      <span className="governed-extensions-history__item-top">
                        <strong>{request.kind === "translation" ? "章节翻译" : "短剧改编"}</strong>
                        <StatusBadge status={request.status} />
                      </span>
                      <span>
                        第 {request.attempt} 次 · {formatTimestamp(request.createdAt)}
                      </span>
                      <span>{usageLabel(request)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        </div>
      </Tabs>

      <section className="governed-extensions-review" aria-label="候选审阅">
        <div className="governed-extensions-section-heading">
          <div>
            <h2>隔离候选审阅</h2>
            <span>只有明确采纳后才写入独立的翻译成果或短剧脚本。</span>
          </div>
          {selectedCandidate !== null && <StatusBadge status={selectedCandidate.status} />}
        </div>
        {selectedRequest === null ? (
          <EmptyState title="选择一条历史记录" description="可查看费用、用量与候选内容。" />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>
                {selectedRequest.kind === "translation" ? "翻译候选" : "短剧脚本候选"}
              </CardTitle>
              <CardDescription>
                请求 {shortId(selectedRequest.id)} · 来源版本{" "}
                {shortId(selectedRequest.sourceVersionId)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="governed-extensions-review__metrics">
                <Metric label="状态" value={requestStatusLabel(selectedRequest.status)} />
                <Metric label="输入 token" value={tokenValue(selectedRequest, "input")} />
                <Metric label="输出 token" value={tokenValue(selectedRequest, "output")} />
                <Metric
                  label="内部费用"
                  value={
                    selectedRequest.usage?.source === "provider_reported"
                      ? formatMicros(
                          selectedRequest.usage.calculatedCostMicros,
                          selectedRequest.pricing.currency,
                        )
                      : selectedRequest.usage?.source === "provider_unavailable"
                        ? `${formatMicros(
                            selectedRequest.usage.calculatedCostMicros,
                            selectedRequest.pricing.currency,
                          )}（最大预留估算）`
                        : "未知"
                  }
                />
              </div>
              {selectedRequest.usage?.source !== "provider_reported" && (
                <InlineAlert
                  tone="warning"
                  title="Token 用量未知"
                  description="服务方没有提供可用 token 报告；系统没有把未知值显示为 0。预算按本次最大预留内部估算保守结算，这不代表服务方账单或已知实际费用，且不会发布候选。"
                />
              )}
              {preview === null ? (
                <EmptyState
                  title="没有可审阅的候选"
                  description={
                    selectedRequest.errorCode === null
                      ? "此请求尚未完成。"
                      : `终止代码：${selectedRequest.errorCode}`
                  }
                />
              ) : preview.kind === "translation" ? (
                <TranslationPreview candidate={preview} sourceParagraphs={sourceParagraphs} />
              ) : (
                <ShortDramaPreview candidate={preview} />
              )}
              <div className="governed-extensions-review__actions">
                {isRetryableStatus(selectedRequest.status) && (
                  <Button
                    variant="secondary"
                    loading={busy === "retry"}
                    disabled={!featureEnabled || capabilities.environment.readOnly}
                    onClick={() => void prepareSelectedRetry()}
                  >
                    准备新重试
                  </Button>
                )}
                {selectedCandidate?.status === "ready" && (
                  <>
                    <Button
                      variant="secondary"
                      loading={busy === "decision"}
                      disabled={!featureEnabled || capabilities.environment.readOnly}
                      onClick={() => void decideCandidate("reject")}
                    >
                      拒绝候选
                    </Button>
                    <Button
                      variant="ai-primary"
                      loading={busy === "decision"}
                      disabled={!featureEnabled || capabilities.environment.readOnly}
                      onClick={() => void decideCandidate("accept")}
                    >
                      采纳为独立成果
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

function PreflightPanel({
  acknowledged,
  busy,
  consentExpiresAt,
  consentReady,
  loading,
  onAcknowledged,
  onConfirm,
  preflight,
}: {
  readonly acknowledged: boolean;
  readonly busy: BusyAction;
  readonly consentExpiresAt: string | null;
  readonly consentReady: boolean;
  readonly loading: boolean;
  readonly onAcknowledged: (value: boolean) => void;
  readonly onConfirm: () => void;
  readonly preflight: GovernedCreativeExtensionPreflight | null;
}) {
  return (
    <Card className="governed-extensions-preflight">
      <CardHeader>
        <CardTitle>发送前预检</CardTitle>
        <CardDescription>目的地、数据类别、价格快照和来源版本均在开始时锁定。</CardDescription>
      </CardHeader>
      <CardContent>
        {loading || preflight === null ? (
          <p className="governed-extensions-muted" role="status">
            正在计算预检…
          </p>
        ) : (
          <>
            <dl className="governed-extensions-destination">
              <div>
                <dt>位置</dt>
                <dd>
                  <Badge tone={preflight.destination.location === "remote" ? "warning" : "info"}>
                    {preflight.destination.location === "remote" ? "远程" : "本机回环"}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>服务地址</dt>
                <dd className="governed-extensions-monospace">{preflight.destination.baseUrl}</dd>
              </div>
              <div>
                <dt>服务方 / 模型</dt>
                <dd>
                  {preflight.destination.providerId} / {preflight.destination.modelId}
                </dd>
              </div>
              <div>
                <dt>发送类别</dt>
                <dd>{preflight.destination.dataCategories.join("、")}</dd>
              </div>
              <div>
                <dt>价格快照</dt>
                <dd>
                  {preflight.snapshot.pricing.priceVersion} ·{" "}
                  {formatTimestamp(preflight.snapshot.pricing.priceUpdatedAt)}
                </dd>
              </div>
              <div>
                <dt>请求指纹</dt>
                <dd className="governed-extensions-monospace" title={preflight.requestFingerprint}>
                  {shortHash(preflight.requestFingerprint)}
                </dd>
              </div>
              <div>
                <dt>内部估算</dt>
                <dd>
                  约 {preflight.estimate.estimatedInputTokens.toLocaleString()} 输入 /{" "}
                  {preflight.estimate.estimatedOutputTokens.toLocaleString()} 输出 token；最多{" "}
                  {formatMicros(preflight.estimate.maximumCostMicros, preflight.estimate.currency)}
                </dd>
              </div>
            </dl>
            <ul className="governed-extensions-preflight__checks">
              {preflight.checks.map((check) => (
                <li key={check.code} data-level={check.level}>
                  <span aria-hidden="true">
                    {check.level === "blocking" ? "!" : check.level === "action" ? "→" : "i"}
                  </span>
                  <div>
                    <strong>{check.title}</strong>
                    <p>{check.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            {preflight.requiresRemoteConsent && preflight.ready && (
              <div className="governed-extensions-consent">
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={consentReady}
                    onChange={(event) => onAcknowledged(event.target.checked)}
                  />
                  <span>
                    我确认将所列数据发送到上述精确地址、服务方和模型；确认同时绑定当前项目、来源版本、数据类别、价格快照与请求指纹，并且仅可使用一次。
                  </span>
                </label>
                <Button
                  variant="secondary"
                  loading={busy === "consent"}
                  disabled={!acknowledged || consentReady}
                  onClick={onConfirm}
                >
                  {consentReady ? "一次性确认已就绪" : "创建一次性确认"}
                </Button>
                {consentExpiresAt !== null && (
                  <span className="governed-extensions-muted">
                    到期：{formatTimestamp(consentExpiresAt)}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TranslationPreview({
  candidate,
  sourceParagraphs,
}: {
  readonly candidate: Extract<CreativeExtensionCandidatePayload, { readonly kind: "translation" }>;
  readonly sourceParagraphs: readonly string[];
}) {
  return (
    <div className="governed-extensions-translation-preview">
      <div className="governed-extensions-preview-header">
        <span>原文</span>
        <span>
          {candidate.targetLanguage.label} · {candidate.tone}
        </span>
      </div>
      {candidate.paragraphs.map((paragraph) => (
        <article key={paragraph.sourceParagraph}>
          <div lang="zh-CN">
            {sourceParagraphs[paragraph.sourceParagraph] ?? "（历史原文未载入）"}
          </div>
          <div lang={candidate.targetLanguage.code}>
            {paragraph.translatedText}
            {paragraph.glossaryTerms.length > 0 && (
              <small>术语：{paragraph.glossaryTerms.join("、")}</small>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function ShortDramaPreview({
  candidate,
}: {
  readonly candidate: Extract<CreativeExtensionCandidatePayload, { readonly kind: "short_drama" }>;
}) {
  return (
    <div className="governed-extensions-drama-preview">
      <h3>{candidate.title}</h3>
      <p>{candidate.format === "vertical_micro_drama" ? "竖屏微短剧" : "标准短剧"}</p>
      {candidate.episodes.map((episode) => (
        <section key={episode.number}>
          <h4>
            第 {episode.number} 集 · {episode.title}
            <Badge tone="neutral">{episode.durationSeconds} 秒</Badge>
          </h4>
          {episode.scenes.map((scene) => (
            <article key={scene.number}>
              <header>
                <strong>
                  {scene.number}. {scene.slugline}
                </strong>
                <span>
                  {scene.location} · {scene.timeOfDay} · {scene.durationSeconds} 秒
                </span>
              </header>
              <p>角色：{scene.characters.join("、")}</p>
              <ol>
                {scene.shots.map((shot) => (
                  <li key={shot.number}>
                    <strong>
                      镜头 {shot.number} · {shot.shotType} · {shot.durationSeconds} 秒
                    </strong>
                    <p>{shot.action}</p>
                    {shot.dialogue.map((dialogue, index) => (
                      <blockquote key={`${dialogue.character}-${String(index)}`}>
                        <b>{dialogue.character}</b>
                        {dialogue.stageDirection === null ? "" : `（${dialogue.stageDirection}）`}：
                        {dialogue.line}
                      </blockquote>
                    ))}
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  const meta = statusMeta(status);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function parseCandidatePreview(
  candidate: GovernedExtensionCandidate | null,
): CreativeExtensionCandidatePayload | null {
  if (candidate === null) {
    return null;
  }
  try {
    return parseCreativeExtensionCandidate(candidate.payloadJson);
  } catch {
    return null;
  }
}

function parseGlossary(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pair = "", noteValue] = line.split("|", 2);
      const [source = "", target = ""] = pair.split("=", 2);
      const trimmedNote = noteValue?.trim();
      return {
        source: source.trim(),
        target: target.trim(),
        note: trimmedNote === undefined || trimmedNote.length === 0 ? null : trimmedNote,
      };
    })
    .filter(({ source, target }) => source.length > 0 && target.length > 0);
}

function readHistoricalSourceParagraphs(
  request: GovernedExtensionRequest | null,
  current: GovernedCreativeExtensionSource | null,
): readonly string[] {
  let sourceText =
    request !== null &&
    current !== null &&
    request.sourceVersionId === current.sourceVersionId &&
    request.sourceChecksum === current.sourceChecksum
      ? current.sourceText
      : "";
  if (sourceText.length === 0 && request !== null) {
    try {
      const snapshot = JSON.parse(request.requestSnapshotJson) as { readonly sourceText?: unknown };
      sourceText = typeof snapshot.sourceText === "string" ? snapshot.sourceText : "";
    } catch {
      sourceText = "";
    }
  }
  return sourceText
    .split(/\r?\n(?:[ \t]*\r?\n)+/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function readNumber(event: ChangeEvent<HTMLInputElement>, fallback: number): number {
  const value = Number(event.target.value);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function usageLabel(request: GovernedExtensionRequest): string {
  if (request.usage?.source !== "provider_reported") {
    return "Token 用量未知";
  }
  return `${request.usage.inputTokens.toLocaleString()} 输入 / ${request.usage.outputTokens.toLocaleString()} 输出`;
}

function tokenValue(request: GovernedExtensionRequest, kind: "input" | "output"): string {
  if (request.usage?.source !== "provider_reported") {
    return "未知";
  }
  return (
    kind === "input" ? request.usage.inputTokens : request.usage.outputTokens
  ).toLocaleString();
}

function isRetryableStatus(status: GovernedExtensionRequest["status"]): boolean {
  return status === "cancelled" || status === "failed_retryable" || status === "failed_final";
}

function requestStatusLabel(status: GovernedExtensionRequest["status"]): string {
  return statusMeta(status).label;
}

function statusMeta(status: string): {
  readonly label: string;
  readonly tone: "neutral" | "ai" | "success" | "warning" | "danger";
} {
  switch (status) {
    case "running":
      return { label: "运行中", tone: "ai" };
    case "candidate_ready":
    case "ready":
      return { label: "候选就绪", tone: "success" };
    case "accepted":
      return { label: "已采纳", tone: "success" };
    case "rejected":
      return { label: "已拒绝", tone: "neutral" };
    case "expired":
      return { label: "已过期", tone: "warning" };
    case "cancelled":
      return { label: "已取消", tone: "neutral" };
    case "failed_retryable":
      return { label: "失败，可重试", tone: "warning" };
    case "failed_final":
      return { label: "失败", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

function formatMicros(micros: number, currency: string): string {
  return `${currency} ${(micros / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  })}`;
}

function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toLocaleString();
}

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function publicError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "操作失败，请查看预检与历史状态后重试。";
}
