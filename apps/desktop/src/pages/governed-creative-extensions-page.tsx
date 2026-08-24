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
  CardFooter,
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
  type ReactNode,
} from "react";

import { handleCandidateDecisionNavigation } from "../components/candidate-decision-navigation";

import {
  DEFAULT_GOVERNED_CREATIVE_EXTENSION_FLAGS,
  type GovernedCreativeExtensionDraft,
  type GovernedCreativeExtensionPreflight,
  type GovernedCreativeExtensionSource,
  type GovernedCreativeExtensionsRuntime,
  type GovernedExtensionHistory,
} from "../infrastructure/governed-creative-extensions-runtime";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

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
  { value: "en-US", label: "美国英语" },
  { value: "en-GB", label: "英国英语" },
  { value: "ja-JP", label: "日语" },
  { value: "ko-KR", label: "韩语" },
  { value: "fr-FR", label: "法语" },
  { value: "de-DE", label: "德语" },
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
    setAnnouncement("正在生成；结果不会直接覆盖正文或大纲。");
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
          : "结果已就绪；请审阅后采纳或放弃。",
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
        `已准备第 ${String(next.retry?.attempt ?? 1)} 次尝试；这会产生新的预算占用和费用记录。`,
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
            ? "已采纳为独立成果；正文和大纲未变。"
            : "来源已变化；结果过期且未写入。",
        );
      } else {
        await runtime.rejectCandidate(selectedCandidate.id, selectedCandidate.revision);
        setAnnouncement("已放弃；正文和大纲未变。");
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
      setAnnouncement("历史已准备导出，不含一次性确认凭据。");
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
          <p>固定来源、发送位置和费用；结果须确认后使用。</p>
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
          description="仍可查看和导出历史，但不能生成、重试或处理结果。"
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
                description="服务须绑定当前章节版本。"
              />
            ) : (
              <form onSubmit={(event) => void run(event)}>
                <Card className="governed-extensions-source">
                  <CardHeader>
                    <CardTitle>来源权威</CardTitle>
                    <CardDescription>只读取当前版本，不会修改正文。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <KeyValues
                      className="governed-extensions-kv"
                      items={[
                        ["章节", source.chapterTitle],
                        ["版本", "当前已接受版本"],
                        ["项目", "当前作品"],
                        ["来源校验", "来源已校验"],
                      ]}
                    />
                  </CardContent>
                </Card>

                <TabsContent value="translation">
                  <Card>
                    <CardHeader>
                      <CardTitle>翻译设置</CardTitle>
                      <CardDescription>逐段翻译并绑定语言、语气和术语表。</CardDescription>
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
                      <FormField label="术语表版本" required hint="版本变化后须重新确认发送。">
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
                        输出包含集、场、镜头、对白、时长和来源引用。
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
                        ? "生成新的待确认结果"
                        : `执行第 ${String(preflight?.retry?.attempt ?? 1)} 次尝试`}
                    </strong>
                    <span>
                      {preflight === null
                        ? "等待发送前检查"
                        : `${formatMicros(preflight.estimate.maximumCostMicros, preflight.estimate.currency)} 本次最高费用估算`}
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
                        : "生成待确认结果"}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </section>

          <aside className="governed-extensions-history" aria-label="请求历史">
            <div className="governed-extensions-section-heading">
              <div>
                <h2>历史与待确认结果</h2>
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
                description="完成发送前检查后，记录会显示在这里。"
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

      <section className="governed-extensions-review" aria-label="待确认结果审阅">
        <div className="governed-extensions-section-heading">
          <div>
            <h2>待确认结果审阅</h2>
            <span>只有明确采纳后才写入独立的翻译成果或短剧脚本。</span>
          </div>
          {selectedCandidate !== null && <StatusBadge status={selectedCandidate.status} />}
        </div>
        {selectedRequest === null ? (
          <EmptyState title="选择一条历史记录" description="可查看费用、用量与待确认内容。" />
        ) : (
          <Card
            className={
              selectedCandidate?.status === "ready" ? "candidate-decision-surface" : undefined
            }
            aria-label="受治理创意成果待确认结果处理"
          >
            <CardHeader>
              <CardTitle>
                {selectedRequest.kind === "translation" ? "待确认翻译" : "待确认短剧脚本"}
              </CardTitle>
              <CardDescription>已绑定来源版本；采纳后才写入独立成果。</CardDescription>
            </CardHeader>
            <CardContent
              tabIndex={selectedCandidate?.status === "ready" ? 0 : undefined}
              aria-label="受治理创意成果待确认内容"
              onKeyDown={handleCandidateDecisionNavigation}
            >
              <div className="governed-extensions-review__metrics">
                <Metric label="状态" value={requestStatusLabel(selectedRequest.status)} />
                <Metric label="发送计量" value={tokenValue(selectedRequest, "input")} />
                <Metric label="返回计量" value={tokenValue(selectedRequest, "output")} />
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
                          )}（本次最高费用估算）`
                        : "未知"
                  }
                />
              </div>
              {selectedRequest.usage?.source !== "provider_reported" && (
                <InlineAlert
                  tone="warning"
                  title="本次服务计量未知"
                  description="服务未提供可核对用量，系统不会显示为 0；费用按最高估算记录，不代表服务方账单。"
                />
              )}
              {preview === null ? (
                <EmptyState
                  title="没有可审阅的待确认结果"
                  description={
                    selectedRequest.errorCode === null
                      ? "此请求尚未完成。"
                      : projectOrdinaryUiError({ code: selectedRequest.errorCode }).description
                  }
                />
              ) : preview.kind === "translation" ? (
                <TranslationPreview candidate={preview} sourceParagraphs={sourceParagraphs} />
              ) : (
                <ShortDramaPreview candidate={preview} />
              )}
            </CardContent>
            {(isRetryableStatus(selectedRequest.status) ||
              selectedCandidate?.status === "ready") && (
              <CardFooter className="candidate-decision-actions">
                {isRetryableStatus(selectedRequest.status) && (
                  <Button
                    size="lg"
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
                      size="lg"
                      variant="secondary"
                      loading={busy === "decision"}
                      disabled={!featureEnabled || capabilities.environment.readOnly}
                      onClick={() => void decideCandidate("reject")}
                    >
                      放弃这版
                    </Button>
                    <Button
                      size="lg"
                      variant="ai-primary"
                      loading={busy === "decision"}
                      disabled={!featureEnabled || capabilities.environment.readOnly}
                      onClick={() => void decideCandidate("accept")}
                    >
                      采纳为独立成果
                    </Button>
                  </>
                )}
              </CardFooter>
            )}
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
        <CardTitle>发送前检查</CardTitle>
        <CardDescription>开始时锁定发送位置、资料、费用和来源版本。</CardDescription>
      </CardHeader>
      <CardContent>
        {loading || preflight === null ? (
          <p className="governed-extensions-muted" role="status">
            正在检查…
          </p>
        ) : (
          <>
            <KeyValues
              className="governed-extensions-destination"
              items={[
                [
                  "处理位置",
                  preflight.destination.location === "remote" ? "远程模型服务" : "本机模型服务",
                ],
                [
                  "模型服务",
                  `${preflight.destination.location === "remote" ? "已锁定远程服务" : "已锁定本机服务"}（精确信息见高级诊断）`,
                ],
                [
                  "发送资料",
                  preflight.destination.dataCategories.map(dataCategoryLabel).join("、"),
                ],
                [
                  "费用依据",
                  `已锁定 · ${formatTimestamp(preflight.snapshot.pricing.priceUpdatedAt)}`,
                ],
                [
                  "预计用量",
                  `发送约 ${preflight.estimate.estimatedInputTokens.toLocaleString()}，返回约 ${preflight.estimate.estimatedOutputTokens.toLocaleString()}；最高 ${formatMicros(preflight.estimate.maximumCostMicros, preflight.estimate.currency)}`,
                ],
              ]}
            />
            <ul className="governed-extensions-preflight__checks">
              {preflight.checks.map((check) => {
                const copy = ordinaryPreflightCheck(check);
                return (
                  <li key={check.code} data-level={check.level}>
                    <span aria-hidden="true">
                      {check.level === "blocking" ? "!" : check.level === "action" ? "→" : "i"}
                    </span>
                    <div>
                      <strong>{copy[0]}</strong>
                      <p>{copy[1]}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <details className="governed-extensions-diagnostics">
              <summary>高级诊断详情</summary>
              <pre>{JSON.stringify(preflight.destination, null, 2)}</pre>
            </details>
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
                    我确认向高级诊断中的服务发送所列资料；确认绑定作品、来源版本、资料和费用，仅使用一次。
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

function KeyValues({
  className,
  items,
}: {
  readonly className: string;
  readonly items: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <dl className={className}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
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
    return "本次服务计量未知";
  }
  return `发送 ${request.usage.inputTokens.toLocaleString()} / 返回 ${request.usage.outputTokens.toLocaleString()}`;
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
      return { label: "结果待确认", tone: "success" };
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
      return { label: "状态未知", tone: "neutral" };
  }
}

function dataCategoryLabel(category: string): string {
  return (
    {
      chapter_text: "当前章节正文",
      glossary: "本次术语表",
      translation_settings: "本次翻译设置",
      short_drama_settings: "本次短剧设置",
    }[category] ?? "其他已锁定资料"
  );
}

function ordinaryPreflightCheck(
  check: GovernedCreativeExtensionPreflight["checks"][number],
): readonly [string, string] {
  return check.level === "blocking"
    ? ["发送前检查未通过", "请修正设置后重试；原因见高级诊断。"]
    : check.level === "action"
      ? ["需要你确认", "请核对发送资料；精确信息见高级诊断。"]
      : ["检查已完成", "本次生成遵守已锁定的安全和费用边界。"];
}
function formatMicros(micros: number, currency: string): string {
  return `${currencyLabel(currency)} ${(micros / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  })}`;
}

function currencyLabel(currency: string): string {
  return (
    {
      AUD: "澳元",
      CAD: "加元",
      CNY: "人民币",
      EUR: "欧元",
      GBP: "英镑",
      HKD: "港元",
      JPY: "日元",
      USD: "美元",
    }[currency] ?? "未识别费用单位"
  );
}

function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toLocaleString();
}

function publicError(error: unknown): string {
  return projectOrdinaryUiError(error).description;
}
