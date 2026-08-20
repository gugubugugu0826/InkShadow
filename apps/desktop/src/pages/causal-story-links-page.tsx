import { useCallback, useEffect, useMemo, useState } from "react";
import type { CausalEventGraph, CausalImpactTraceResult, StoryFact } from "@inkshadow/story-core";
import type { ChapterRepository } from "@inkshadow/application";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  PageStateBoundary,
  Textarea,
} from "@inkshadow/ui";
import { Link, useNavigate } from "react-router-dom";

import type { CausalEventGraphStore } from "../infrastructure/causal-event-graph-store";
import { CausalFactAuthoringPanel } from "../components/causal-fact-authoring-panel";
import type {
  CausalFactAuthoringService,
  ConfirmedCausalCharacter,
} from "../infrastructure/causal-fact-authoring-service";
import type {
  CausalStoryFactProjectionReceipt,
  CausalStoryFactProjector,
} from "../infrastructure/causal-story-fact-projector";
import {
  readCausalWhatIfSimulationValue,
  type CausalWhatIfSimulationService,
  type CausalWhatIfSimulationValue,
} from "../infrastructure/causal-what-if-simulation-service";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

interface CausalStoryLinksPageProps {
  readonly projectId: string;
  readonly graph: CausalEventGraphStore;
  readonly projector: CausalStoryFactProjector;
  readonly whatIf: Pick<CausalWhatIfSimulationService, "simulate" | "list">;
  readonly whatIfEnabled: boolean;
  readonly authoring: Pick<
    CausalFactAuthoringService,
    "createEvent" | "createRelation" | "listConfirmedCharacters"
  >;
  readonly chapters: Pick<ChapterRepository, "listByProjectId">;
  readonly actorId: string;
  readonly legacyProjectionAvailable: boolean;
}

type PageState = "loading" | "ready" | "fatal_error";

export function CausalStoryLinksPage(props: CausalStoryLinksPageProps) {
  const navigate = useNavigate();
  const [pageState, setPageState] = useState<PageState>("loading");
  const [graph, setGraph] = useState<CausalEventGraph | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [impact, setImpact] = useState<CausalImpactTraceResult | null>(null);
  const [projection, setProjection] = useState<CausalStoryFactProjectionReceipt | null>(null);
  const [hypothesis, setHypothesis] = useState("");
  const [simulation, setSimulation] = useState<CausalWhatIfSimulationValue | null>(null);
  const [simulationHistory, setSimulationHistory] = useState<readonly StoryFact[]>([]);
  const [confirmedCharacters, setConfirmedCharacters] = useState<
    readonly ConfirmedCausalCharacter[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPageState("loading");
    try {
      const [loaded, history, characters] = await Promise.all([
        props.graph.loadProjectBranch(props.projectId, "main"),
        props.whatIfEnabled
          ? props.whatIf.list(props.projectId).catch(() => Object.freeze([]))
          : Promise.resolve(Object.freeze([])),
        props.authoring.listConfirmedCharacters(props.projectId).catch(() => Object.freeze([])),
      ]);
      setGraph(loaded);
      setSimulationHistory(history);
      setConfirmedCharacters(characters);
      setSelectedEventId((current) =>
        current !== null && loaded.events.some(({ id }) => id === current)
          ? current
          : (loaded.events[0]?.id ?? null),
      );
      setError(null);
      setPageState("ready");
    } catch (cause: unknown) {
      setError(cause);
      setPageState("fatal_error");
    }
  }, [props.authoring, props.graph, props.projectId, props.whatIf, props.whatIfEnabled]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const selectedEvent = useMemo(
    () => graph?.events.find(({ id }) => id === selectedEventId) ?? null,
    [graph, selectedEventId],
  );
  const relatedRelations = useMemo(
    () =>
      selectedEvent === null
        ? []
        : (graph?.relations.filter(
            ({ fromEventId, toEventId }) =>
              fromEventId === selectedEvent.id || toEventId === selectedEvent.id,
          ) ?? []),
    [graph, selectedEvent],
  );
  const characterNames = useMemo(
    () => new Map(confirmedCharacters.map(({ id, name }) => [id, name] as const)),
    [confirmedCharacters],
  );
  const eventLabels = useMemo(
    () =>
      new Map(
        (graph?.events ?? []).map(
          (event) => [event.id, `${event.narrativeTime.label} · ${event.eventText}`] as const,
        ),
      ),
    [graph],
  );

  async function rebuild(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setImpact(null);
    try {
      const receipt = await props.projector.rebuildProject(props.projectId, "main");
      setProjection(receipt);
      setGraph(receipt.graph);
      setSelectedEventId(receipt.graph.events[0]?.id ?? null);
      setError(null);
      setPageState("ready");
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function traceImpact(): Promise<void> {
    if (!props.whatIfEnabled || selectedEvent === null || busy) {
      return;
    }
    setBusy(true);
    try {
      setImpact(
        await props.graph.traceImpacts({
          projectId: props.projectId,
          branchId: "main",
          changedEventIds: [selectedEvent.id],
          maximumDepth: 32,
          maximumImpactedEvents: 256,
        }),
      );
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function simulateAlternateDirection(): Promise<void> {
    const normalizedHypothesis = hypothesis.trim();
    if (
      !props.whatIfEnabled ||
      selectedEvent === null ||
      normalizedHypothesis.length === 0 ||
      busy
    ) {
      return;
    }
    setBusy(true);
    try {
      const receipt = await props.whatIf.simulate({
        projectId: props.projectId,
        sourceEventId: selectedEvent.id,
        hypothesis: normalizedHypothesis,
      });
      setSimulation(readCausalWhatIfSimulationValue(receipt.fact));
      setSimulationHistory(await props.whatIf.list(props.projectId));
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const normalizedError = error === null ? null : projectOrdinaryUiError(error);

  return (
    <div className="desktop-page causal-story-links-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${props.projectId}/story`}>
            返回故事设定
          </Link>
          <p className="page-heading__eyebrow">事件、原因与后续影响</p>
          <h1>故事关联</h1>
          <p>这里仅使用你已确认且能回到原文的事件；AI 猜测不会混入正式剧情链。</p>
        </div>
        <div className="settings-actions">
          <Badge>{String(graph?.events.length ?? 0)} 个确认事件</Badge>
          <Button loading={busy} onClick={() => void rebuild()}>
            从确认设定重新整理
          </Button>
        </div>
      </header>

      <InlineAlert
        tone="info"
        title="每条关联都能回到原文"
        description="事件和关系保存章节版本、原文片段与摘要校验。正文或证据不一致时，系统会停止使用这条关联并提示重新整理。"
      />

      {projection !== null && (
        <InlineAlert
          tone={projection.skipped.length > 0 ? "warning" : "info"}
          title="故事关联已重新整理"
          description={`纳入 ${String(projection.eventCount)} 个事件、${String(projection.relationCount)} 条关系；${String(projection.skipped.length)} 条内容因未确认、证据不完整或分支不符而跳过。`}
        />
      )}

      {normalizedError !== null && pageState !== "fatal_error" && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={`${normalizedError.description} 已保存的正文和设定没有改变，可以重试重新整理。`}
          onDismiss={() => setError(null)}
        />
      )}

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        loadingLabel="正在核对事件与原文证据"
        fallbacks={{
          fatal_error: (
            <ErrorState
              title={normalizedError?.title ?? "无法读取故事关联"}
              description={normalizedError?.description ?? "请重试；正文和故事设定不会受影响。"}
              primaryAction={{ label: "重试", onClick: () => void load() }}
            />
          ),
        }}
      >
        <>
          <CausalFactAuthoringPanel
            projectId={props.projectId}
            actorId={props.actorId}
            events={graph?.events ?? []}
            chapters={props.chapters}
            service={props.authoring}
            onCreated={(receipt) => {
              if (receipt.projection === null) {
                setProjection(null);
                return;
              }
              setProjection(receipt.projection);
              setGraph(receipt.projection.graph);
              setSelectedEventId(receipt.projection.graph.events.at(-1)?.id ?? null);
              setImpact(null);
              setError(null);
              setPageState("ready");
            }}
          />
          {graph === null || graph.events.length === 0 ? (
            <EmptyState
              title="还没有可用的故事关联"
              description="可以在上方从已保存正文明确添加事件；也可以先去确认 AI 识别出的故事变化。没有章节证据的说明不会被强行画成因果链。"
              primaryAction={{ label: "从确认设定重新整理", onClick: () => void rebuild() }}
              secondaryAction={{
                label: "去确认故事变化",
                onClick: () => {
                  void navigate(`/projects/${props.projectId}/story`);
                },
              }}
            />
          ) : (
            <div className="settings-grid">
              <Card>
                <CardHeader>
                  <CardTitle>确认事件</CardTitle>
                  <CardDescription>
                    按故事时间排序；选择一个事件查看证据与后续影响。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="settings-actions">
                    {graph.events
                      .slice()
                      .sort(
                        (left, right) =>
                          left.narrativeTime.order - right.narrativeTime.order ||
                          left.id.localeCompare(right.id),
                      )
                      .map((event) => (
                        <Button
                          key={event.id}
                          variant={selectedEventId === event.id ? "primary" : "secondary"}
                          onClick={() => {
                            setSelectedEventId(event.id);
                            setImpact(null);
                          }}
                        >
                          {event.narrativeTime.label} · {event.eventText}
                        </Button>
                      ))}
                  </div>
                </CardContent>
              </Card>

              {selectedEvent !== null && (
                <Card>
                  <CardHeader>
                    <CardTitle>{selectedEvent.eventText}</CardTitle>
                    <CardDescription>
                      {selectedEvent.narrativeTime.label} · {selectedEvent.location.label}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="detail-list">
                      <div>
                        <dt>结果</dt>
                        <dd>{selectedEvent.resultText}</dd>
                      </div>
                      <div>
                        <dt>参与人物</dt>
                        <dd>
                          {selectedEvent.participantCharacterIds
                            .map(
                              (id, index) =>
                                characterNames.get(id) ?? `未命名人物 ${String(index + 1)}`,
                            )
                            .join("、") || "未标注"}
                        </dd>
                      </div>
                      <div>
                        <dt>谁已经知道</dt>
                        <dd>
                          {selectedEvent.informedCharacterIds
                            .map(
                              (id, index) =>
                                characterNames.get(id) ?? `未命名人物 ${String(index + 1)}`,
                            )
                            .join("、") || "未标注"}
                        </dd>
                      </div>
                      <div>
                        <dt>前置条件</dt>
                        <dd>
                          {selectedEvent.prerequisites.length === 0 ? (
                            "未标注"
                          ) : (
                            <ul className="privacy-list">
                              {selectedEvent.prerequisites.map((prerequisite) => (
                                <li key={prerequisite.id}>
                                  {prerequisiteKindLabel(prerequisite.kind)} ·{" "}
                                  {prerequisite.referenceLabel ?? "已确认前置项"}：
                                  {prerequisite.description}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>人物状态变化</dt>
                        <dd>
                          {selectedEvent.characterStateChanges.length === 0 ? (
                            "未标注"
                          ) : (
                            <ul className="privacy-list">
                              {selectedEvent.characterStateChanges.map((change) => (
                                <li key={change.id}>
                                  {characterNames.get(change.characterId) ?? "未命名人物"} ·{" "}
                                  {change.attributeLabel ?? "状态"}：
                                  {formatCausalState(change.beforeValue)} →{" "}
                                  {formatCausalState(change.afterValue)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>人物关系变化</dt>
                        <dd>
                          {selectedEvent.relationshipChanges.length === 0 ? (
                            "未标注"
                          ) : (
                            <ul className="privacy-list">
                              {selectedEvent.relationshipChanges.map((change) => (
                                <li key={change.id}>
                                  {characterNames.get(change.fromCharacterId) ?? "未命名人物"} 与{" "}
                                  {characterNames.get(change.toCharacterId) ?? "未命名人物"} ·{" "}
                                  {change.relationshipLabel ?? "人物关系"}：
                                  {formatCausalState(change.beforeValue)} →{" "}
                                  {formatCausalState(change.afterValue)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>物品变化</dt>
                        <dd>
                          {selectedEvent.itemChanges.length === 0 ? (
                            "未标注"
                          ) : (
                            <ul className="privacy-list">
                              {selectedEvent.itemChanges.map((change) => (
                                <li key={change.id}>
                                  {change.itemLabel ?? "未命名物品"} ·{" "}
                                  {itemChangeKindLabel(change.kind)}
                                  {change.fromCharacterId === null
                                    ? ""
                                    : ` · 原持有人：${characterNames.get(change.fromCharacterId) ?? "未命名人物"}`}
                                  {change.toCharacterId === null
                                    ? ""
                                    : ` · 新持有人：${characterNames.get(change.toCharacterId) ?? "未命名人物"}`}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>伏笔推进</dt>
                        <dd>
                          {selectedEvent.foreshadowProgress.length === 0 ? (
                            "未标注"
                          ) : (
                            <ul className="privacy-list">
                              {selectedEvent.foreshadowProgress.map((progress) => (
                                <li key={progress.id}>
                                  {progress.foreshadowLabel ?? "未命名伏笔"} ·{" "}
                                  {foreshadowChangeKindLabel(progress.kind)}：{progress.description}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>原文证据</dt>
                        <dd>“{selectedEvent.evidence.excerpt}”</dd>
                      </div>
                    </dl>
                    {relatedRelations.length > 0 && (
                      <ul className="privacy-list">
                        {relatedRelations.map((relation) => (
                          <li key={relation.id}>
                            {eventLabels.get(relation.fromEventId) ?? "已确认事件"} →{" "}
                            {relationKindLabel(relation.kind)} →{" "}
                            {eventLabels.get(relation.toEventId) ?? "已确认事件"}
                          </li>
                        ))}
                      </ul>
                    )}
                    {props.whatIfEnabled && (
                      <Button loading={busy} onClick={() => void traceImpact()}>
                        试演改变它会影响哪里
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}

              {props.whatIfEnabled && impact !== null && (
                <Card>
                  <CardHeader>
                    <CardTitle>受影响的后续剧情</CardTitle>
                    <CardDescription>
                      这是按已确认因果关系计算的影响范围，不会自动改写正文。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {impact.impactedEvents.length === 0 ? (
                      <p>当前没有找到会被这个改变波及的已确认后续事件。</p>
                    ) : (
                      <ol className="privacy-list">
                        {impact.impactedEvents.map((event, index) => (
                          <li key={event.eventId}>
                            {eventLabels.get(event.eventId) ?? `后续事件 ${String(index + 1)}`} ·
                            相隔 {String(event.depth)} 层 · 路径{" "}
                            {event.pathEventIds
                              .map(
                                (eventId, pathIndex) =>
                                  eventLabels.get(eventId) ?? `路径节点 ${String(pathIndex + 1)}`,
                              )
                              .join(" → ")}
                          </li>
                        ))}
                      </ol>
                    )}
                    {impact.truncated && (
                      <InlineAlert
                        tone="warning"
                        title="影响范围已按安全上限截断"
                        description="请缩小起点或分支范围后重新试演，截断部分不会被当作完整结果。"
                      />
                    )}
                    <InlineAlert
                      tone="info"
                      title="下一步只会创建沙盒方案"
                      description="墨影会把上面的确定性影响范围、原文证据和锁定规则交给已配置的剧情试演模型。结果不会改写正文，也不会成为正式设定。"
                    />
                    <FormField
                      label="想改变什么"
                      hint="例如：如果林夏没有打开旧门，而是先去找老师，会怎样？"
                      required
                    >
                      {(fieldProps) => (
                        <Textarea
                          {...fieldProps}
                          rows={3}
                          maxLength={2_000}
                          currentLength={hypothesis.length}
                          value={hypothesis}
                          disabled={busy}
                          onChange={(event) => setHypothesis(event.currentTarget.value)}
                        />
                      )}
                    </FormField>
                    <Button
                      loading={busy}
                      disabled={hypothesis.trim().length === 0}
                      onClick={() => void simulateAlternateDirection()}
                    >
                      生成另一条剧情方案
                    </Button>
                  </CardContent>
                </Card>
              )}

              {props.whatIfEnabled && simulation !== null && (
                <Card>
                  <CardHeader>
                    <CardTitle>沙盒剧情方案</CardTitle>
                    <CardDescription>仅供比较，尚未采用，也没有改动任何正式内容。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p>{simulation.alternateDirection}</p>
                    {simulation.effects.length > 0 && (
                      <ul className="privacy-list">
                        {simulation.effects.map((effect, index) => (
                          <li key={effect.eventId}>
                            <strong>
                              {eventLabels.get(effect.eventId) ?? `受影响事件 ${String(index + 1)}`}
                            </strong>
                            ：{effect.summary}（把握度 {Math.round(effect.confidence * 100)}%）
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="candidate-panel__hint">
                      已保存为独立沙盒分支；正式正文、确认设定和主因果链保持不变。
                    </p>
                  </CardContent>
                </Card>
              )}

              {props.whatIfEnabled && simulationHistory.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>此前的沙盒试演</CardTitle>
                    <CardDescription>
                      {String(simulationHistory.length)} 份，可追溯且与正式故事隔离。
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
          )}
        </>
      </PageStateBoundary>

      {props.legacyProjectionAvailable && (
        <details>
          <summary>旧版关联投影（专家）</summary>
          <p>如需核对旧版派生投影，可打开兼容视图；普通创作和剧情试演优先使用上方的确认因果链。</p>
          <Link className="button-link button-link--secondary" to={`?legacy=1`}>
            打开旧版投影视图
          </Link>
        </details>
      )}
    </div>
  );
}

function relationKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    causes: "导致",
    depends_on: "依赖",
    prevents: "阻止",
    reveals: "揭示",
    misleads: "误导",
    before: "发生在之前",
    changes_state: "改变状态",
    gains_information: "获得信息",
    loses_item: "失去物品",
  };
  return labels[kind] ?? kind;
}

function prerequisiteKindLabel(kind: string): string {
  return kind === "event" ? "前置事件" : kind === "state" ? "所需状态" : "所需规则";
}

function itemChangeKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    acquired: "取得",
    lost: "失去",
    transferred: "转移",
    created: "新出现",
    destroyed: "被毁或消失",
  };
  return labels[kind] ?? kind;
}

function foreshadowChangeKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    planted: "埋设",
    advanced: "推进",
    revealed: "揭示",
    resolved: "回收",
    misdirected: "误导",
  };
  return labels[kind] ?? kind;
}

function formatCausalState(value: string | number | boolean | null): string {
  if (value === null) return "无";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}
