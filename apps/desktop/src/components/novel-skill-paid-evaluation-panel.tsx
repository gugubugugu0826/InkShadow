import { useEffect, useState, type ReactNode } from "react";
import {
  NOVEL_SKILL_EVALUATION_METRICS,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Select,
} from "@inkshadow/ui";

import { projectOrdinaryUiError } from "../infrastructure/ui-error";

const TOTAL_PROVIDER_CALLS = 192;
const TOTAL_MANUAL_SCORES = 2_496;

export type NovelSkillPaidEvaluationPhase =
  | "unavailable"
  | "not_prepared"
  | "awaiting_quote"
  | "awaiting_authorization"
  | "authorized_not_started"
  | "running_waiting"
  | "running_active"
  | "invalidated_ambiguous"
  | "awaiting_blind_review"
  | "blind_reviewing"
  | "completed";

export interface NovelSkillPaidEvaluationTargetOption {
  readonly targetId: string;
  readonly providerLabel: string;
  readonly modelLabel: string;
  /** Exact provider model identifier that will be placed on the wire. */
  readonly providerModelId: string;
}

export interface NovelSkillPaidEvaluationCurrencyQuote {
  readonly currencyCode: string;
  readonly estimatedCostMicros: number;
  readonly hardCeilingMicros: number;
}

export interface NovelSkillPaidEvaluationQuote {
  readonly quoteId: string;
  readonly exactTargetIds: readonly [string, string];
  readonly currencies: readonly NovelSkillPaidEvaluationCurrencyQuote[];
}

/**
 * Deliberately contains no model, provider, slot or experiment-arm field. The
 * reviewer must see only the randomized item and its candidate text.
 */
export interface NovelSkillPaidEvaluationBlindItem {
  readonly blindItemId: string;
  readonly randomizedPosition: number;
  readonly fixtureLabel: string;
  readonly boundaries: readonly string[];
  readonly lockedFacts: readonly string[];
  readonly requestedOutcome: string;
  readonly candidateText: string;
}

export interface NovelSkillPaidEvaluationSnapshot {
  readonly phase: NovelSkillPaidEvaluationPhase;
  readonly runId: string | null;
  readonly quote: NovelSkillPaidEvaluationQuote | null;
  readonly authorizationId: string | null;
  readonly completedProviderCalls: number;
  readonly sealedManualScores: number;
  readonly blindItem: NovelSkillPaidEvaluationBlindItem | null;
  readonly unavailableReason?: string;
}

export interface NovelSkillPaidEvaluationStartInput {
  readonly runId: string;
  readonly authorizationId: string;
  readonly onProgress: (snapshot: NovelSkillPaidEvaluationSnapshot) => void;
}

export interface NovelSkillPaidEvaluationPanelPort {
  /** Local-only recovery. Called only after the user expands the expert panel. */
  readonly initialize?: () => Promise<NovelSkillPaidEvaluationSnapshot>;
  /** Local-only: freezes the exact pair, validates prerequisites and calculates the quote. */
  readonly prepareAndQuote: (input: {
    readonly exactTargetIds: readonly [string, string];
  }) => Promise<NovelSkillPaidEvaluationSnapshot>;
  /** Persists explicit commercial authorization. It must never start the run. */
  readonly authorizeCommercialRun: (input: {
    readonly runId: string;
    readonly quoteId: string;
    readonly commercialUseAcknowledged: boolean;
  }) => Promise<NovelSkillPaidEvaluationSnapshot>;
  /** The sole UI path that may begin or explicitly resume paid dispatch. */
  readonly startAuthorizedRun: (
    input: NovelSkillPaidEvaluationStartInput,
  ) => Promise<NovelSkillPaidEvaluationSnapshot>;
  readonly cancelRun: (input: {
    readonly runId: string;
  }) => Promise<NovelSkillPaidEvaluationSnapshot>;
  readonly beginBlindReview: (input: {
    readonly runId: string;
  }) => Promise<NovelSkillPaidEvaluationSnapshot>;
  readonly sealBlindScores: (input: {
    readonly runId: string;
    readonly blindItemId: string;
    readonly scores: Readonly<Record<NovelSkillEvaluationMetric, number>>;
  }) => Promise<NovelSkillPaidEvaluationSnapshot>;
}

export interface NovelSkillPaidEvaluationPanelProps {
  /** This control is intentionally absent from ordinary-author screens. */
  readonly expertMode?: boolean;
  readonly targets: readonly NovelSkillPaidEvaluationTargetOption[];
  readonly initialSnapshot?: NovelSkillPaidEvaluationSnapshot;
  readonly port: NovelSkillPaidEvaluationPanelPort;
}

type BusyAction = "prepare" | "authorize" | "start" | "cancel" | "review" | "score";

const EMPTY_SNAPSHOT: NovelSkillPaidEvaluationSnapshot = Object.freeze({
  phase: "not_prepared",
  runId: null,
  quote: null,
  authorizationId: null,
  completedProviderCalls: 0,
  sealedManualScores: 0,
  blindItem: null,
});

const METRIC_LABELS: Readonly<Record<NovelSkillEvaluationMetric, string>> = Object.freeze({
  instruction_following: "遵循写作任务",
  canon_preservation: "保留已锁定事实",
  character_consistency: "人物一致性",
  pov_preservation: "视角边界",
  causal_progression: "因果推进",
  scene_function: "场景作用",
  dialogue_distinction: "人物对白区分",
  specificity: "细节具体度",
  repetition_cliche_control: "重复与套话控制",
  pacing: "节奏",
  user_preference: "符合作者偏好",
  unnecessary_rewrite_avoidance: "避免无关改写",
  evidence_completeness: "证据完整性",
});

const SCORE_OPTIONS = Object.freeze([
  { value: "0", label: "0 · 明显不满足" },
  { value: "0.25", label: "0.25 · 较差" },
  { value: "0.5", label: "0.5 · 一般" },
  { value: "0.75", label: "0.75 · 良好" },
  { value: "1", label: "1 · 完全满足" },
]);

export function NovelSkillPaidEvaluationPanel({
  expertMode = false,
  initialSnapshot = EMPTY_SNAPSHOT,
  port,
  targets,
}: NovelSkillPaidEvaluationPanelProps): ReactNode {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [firstTargetId, setFirstTargetId] = useState(
    initialSnapshot.quote?.exactTargetIds[0] ?? "",
  );
  const [secondTargetId, setSecondTargetId] = useState(
    initialSnapshot.quote?.exactTargetIds[1] ?? "",
  );
  const [commercialTermsAccepted, setCommercialTermsAccepted] = useState(false);
  const [scores, setScores] = useState<Partial<Record<NovelSkillEvaluationMetric, number>>>({});
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expertMode || port.initialize === undefined) return undefined;
    let active = true;
    void port.initialize().then(
      (recovered) => {
        if (active) setSnapshot(recovered);
      },
      (cause: unknown) => {
        if (!active) return;
        const projected = projectOrdinaryUiError(cause);
        setError(
          `付费评测的本地恢复检查没有完成。${projected.description}基础写作仍可使用，且没有发送模型请求。`,
        );
      },
    );
    return () => {
      active = false;
    };
  }, [expertMode, port]);

  if (!expertMode) return null;

  const targetOptions = targets.map((target) => ({
    value: target.targetId,
    label: formatTargetLabel(target),
  }));
  const pairIsValid =
    firstTargetId.length > 0 && secondTargetId.length > 0 && firstTargetId !== secondTargetId;
  const hasCompleteScores = NOVEL_SKILL_EVALUATION_METRICS.every(
    (metric) => scores[metric] !== undefined,
  );
  const operationDisabled = busyAction !== null;

  async function perform(
    action: BusyAction,
    operation: () => Promise<NovelSkillPaidEvaluationSnapshot>,
  ): Promise<void> {
    setBusyAction(action);
    setError(null);
    try {
      setSnapshot(await operation());
    } catch (cause: unknown) {
      const projected = projectOrdinaryUiError(cause);
      setError(`${projected.description}系统没有自动开始、重试或重发任何模型调用。`);
    } finally {
      setBusyAction((current) => (current === action ? null : current));
    }
  }

  async function prepareAndQuote(): Promise<void> {
    if (!pairIsValid) {
      setError("请选择两个不同的精确模型后再进行本地预检。");
      return;
    }
    await perform("prepare", () =>
      port.prepareAndQuote({ exactTargetIds: [firstTargetId, secondTargetId] }),
    );
  }

  async function authorize(): Promise<void> {
    const { quote, runId } = snapshot;
    if (runId === null || quote === null || !commercialTermsAccepted) return;
    await perform("authorize", () =>
      port.authorizeCommercialRun({
        runId,
        quoteId: quote.quoteId,
        commercialUseAcknowledged: true,
      }),
    );
  }

  async function startOrResume(): Promise<void> {
    const { authorizationId, runId } = snapshot;
    if (runId === null || authorizationId === null) return;
    await perform("start", () =>
      port.startAuthorizedRun({
        runId,
        authorizationId,
        onProgress: (next) => setSnapshot(next),
      }),
    );
  }

  async function cancel(): Promise<void> {
    const { runId } = snapshot;
    if (runId === null) return;
    await perform("cancel", () => port.cancelRun({ runId }));
  }

  async function beginReview(): Promise<void> {
    const { runId } = snapshot;
    if (runId === null) return;
    await perform("review", () => port.beginBlindReview({ runId }));
  }

  async function sealScores(): Promise<void> {
    const { blindItem, runId } = snapshot;
    if (runId === null || blindItem === null || !hasCompleteScores) return;
    const completeScores = Object.fromEntries(
      NOVEL_SKILL_EVALUATION_METRICS.map((metric) => [metric, requireScore(scores, metric)]),
    ) as Readonly<Record<NovelSkillEvaluationMetric, number>>;
    await perform("score", async () => {
      const next = await port.sealBlindScores({
        runId,
        blindItemId: blindItem.blindItemId,
        scores: completeScores,
      });
      setScores({});
      return next;
    });
  }

  const currentStep = stepForPhase(snapshot.phase);
  const selectedTargets = resolveSelectedTargets(snapshot.quote, targets);
  const quoteMayBeShown =
    snapshot.phase !== "awaiting_blind_review" && snapshot.phase !== "blind_reviewing";

  return (
    <section
      className="settings-section"
      aria-labelledby="novel-skill-paid-evaluation-title"
      data-expert-only="true"
    >
      <div className="section-heading">
        <div>
          <h2 id="novel-skill-paid-evaluation-title">内置小说 Skill 付费 A/B 评测</h2>
          <p>仅供专家验证写作方法；不会改变正文、已接受版本或作者默认设置。</p>
        </div>
        <Badge tone="warning">专家功能 · 默认不运行</Badge>
      </div>

      <InlineAlert
        tone="warning"
        title="这是固定 192 次的商业模型评测"
        description="仅在你完成本地预检、逐币种确认硬顶并单独点击“手动开始”后才会调用。全程无 fallback、无自动 retry；取消或崩溃后不会自动重发。"
      />

      <ol aria-label="付费评测四步进度">
        {["精确选择双模型", "本地预检与报价", "商业授权", "手动开始与 13 项人工盲评"].map(
          (label, index) => {
            const step = index + 1;
            return (
              <li key={label} aria-current={currentStep === step ? "step" : undefined}>
                <strong>
                  {String(step)}. {label}
                </strong>
                {currentStep > step ? " · 已完成" : currentStep === step ? " · 当前" : " · 未开始"}
              </li>
            );
          },
        )}
      </ol>

      <EvaluationProgress snapshot={snapshot} />

      <p className="candidate-panel__hint">
        本地只记录可核对的响应观察摘要；它不是供应商签名收据，也不证明内容质量。
      </p>

      {error !== null && (
        <InlineAlert
          tone="error"
          title="这一步没有完成"
          description={`${error} 进度已保留；请检查后手动重试，系统不会自动调用或重发。`}
          dismissLabel="关闭评测错误"
          onDismiss={() => setError(null)}
        />
      )}

      {snapshot.phase === "unavailable" && (
        <InlineAlert
          tone="error"
          title="当前不能进行付费评测"
          description={
            snapshot.unavailableReason ??
            "请先完成模型、价格、上下文上限和本地持久化检查。没有模型调用被发出。"
          }
        />
      )}

      {(snapshot.phase === "not_prepared" || snapshot.phase === "awaiting_quote") && (
        <Card>
          <CardHeader>
            <CardTitle>1–2. 锁定模型并生成本地报价</CardTitle>
          </CardHeader>
          <CardContent>
            <p>这里锁定的是供应商与精确模型标识。预检和报价只读取本地配置，不会调用模型。</p>
            <div className="story-governance-grid">
              <FormField label="模型 A" required optionalLabel="">
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={firstTargetId}
                    placeholder="选择第一个精确模型"
                    options={targetOptions}
                    disabled={operationDisabled}
                    onChange={(event) => setFirstTargetId(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField
                label="模型 B"
                required
                optionalLabel=""
                error={
                  firstTargetId !== "" && firstTargetId === secondTargetId
                    ? "必须选择另一个精确模型。"
                    : undefined
                }
              >
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={secondTargetId}
                    placeholder="选择第二个精确模型"
                    options={targetOptions}
                    disabled={operationDisabled}
                    onChange={(event) => setSecondTargetId(event.currentTarget.value)}
                  />
                )}
              </FormField>
            </div>
            <Button
              loading={busyAction === "prepare"}
              disabled={operationDisabled || !pairIsValid}
              onClick={() => void prepareAndQuote()}
            >
              生成本地预检报价
            </Button>
          </CardContent>
        </Card>
      )}

      {snapshot.quote !== null && quoteMayBeShown && (
        <Card>
          <CardHeader>
            <div className="card-heading-row">
              <CardTitle>2. 本地预检报价</CardTitle>
              <Badge tone="info">0 次模型调用</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p>
              已精确锁定：{selectedTargets[0]}；{selectedTargets[1]}。
            </p>
            <ul aria-label="逐币种费用硬顶">
              {snapshot.quote.currencies.map((quote) => (
                <li key={quote.currencyCode}>
                  <strong>{quote.currencyCode}</strong>：本地预估 {formatMicros(quote)}；硬顶{" "}
                  {formatMicros(quote, true)}。不同币种分别限制，不会合并抵扣。
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {snapshot.phase === "awaiting_authorization" && snapshot.quote !== null && (
        <Card>
          <CardHeader>
            <CardTitle>3. 商业授权</CardTitle>
          </CardHeader>
          <CardContent>
            <label>
              <input
                type="checkbox"
                checked={commercialTermsAccepted}
                disabled={operationDisabled}
                onChange={(event) => setCommercialTermsAccepted(event.currentTarget.checked)}
              />{" "}
              我确认固定 192 次调用、上述逐币种硬顶、无 fallback、无自动 retry。
            </label>
            <p className="candidate-panel__hint">
              保存授权不会开始评测。授权完成后仍需你单独点击“手动开始”。
            </p>
            <Button
              loading={busyAction === "authorize"}
              disabled={operationDisabled || !commercialTermsAccepted}
              onClick={() => void authorize()}
            >
              仅保存商业授权
            </Button>
          </CardContent>
        </Card>
      )}

      {snapshot.phase === "authorized_not_started" && (
        <Card>
          <CardHeader>
            <CardTitle>4. 等待手动开始</CardTitle>
          </CardHeader>
          <CardContent>
            <InlineAlert
              tone="info"
              title="商业授权已保存，但尚未产生调用"
              description="关闭并重新打开页面也不会自动开始。下方按钮是唯一允许进入付费调用路径的界面操作。"
            />
            <Button
              loading={busyAction === "start"}
              disabled={operationDisabled}
              onClick={() => void startOrResume()}
            >
              手动开始 192 次付费调用
            </Button>
          </CardContent>
        </Card>
      )}

      {(snapshot.phase === "running_waiting" || snapshot.phase === "running_active") && (
        <Card>
          <CardHeader>
            <div className="card-heading-row">
              <CardTitle>4. 评测运行中</CardTitle>
              <Badge tone="warning">串行执行</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p>每次只处理一个已锁定单元；失败会停下并保留证据，不会 fallback，也不会自动 retry。</p>
            {snapshot.phase === "running_waiting" && (
              <Button
                loading={busyAction === "start"}
                disabled={operationDisabled}
                onClick={() => void startOrResume()}
              >
                手动继续下一项
              </Button>
            )}
            <Button
              variant="secondary"
              loading={busyAction === "cancel"}
              disabled={busyAction !== null && busyAction !== "start"}
              onClick={() => void cancel()}
            >
              取消并停止后续调用
            </Button>
            <p className="candidate-panel__hint">
              取消只停止尚未发出的项目；崩溃恢复后，系统同样不会自动重发状态不确定的调用。
            </p>
          </CardContent>
        </Card>
      )}

      {snapshot.phase === "invalidated_ambiguous" && (
        <InlineAlert
          tone="error"
          title="运行已停止，需要人工核对"
          description="有一次调用在崩溃或断连后无法确认是否已发出。为避免重复计费，系统已失效本次运行且不会自动重发。"
        />
      )}

      {snapshot.phase === "awaiting_blind_review" && (
        <Card>
          <CardHeader>
            <CardTitle>4. 开始人工盲评</CardTitle>
          </CardHeader>
          <CardContent>
            <p>192 个匿名结果已经封存。接下来逐项填写 13 个指标，共 2,496 项。</p>
            <Button
              loading={busyAction === "review"}
              disabled={operationDisabled}
              onClick={() => void beginReview()}
            >
              开始 13 项人工盲评
            </Button>
          </CardContent>
        </Card>
      )}

      {snapshot.phase === "blind_reviewing" && snapshot.blindItem !== null && (
        <BlindReviewCard
          item={snapshot.blindItem}
          scores={scores}
          busy={busyAction === "score"}
          disabled={operationDisabled}
          onScoreChange={(metric, score) =>
            setScores((current) => ({ ...current, [metric]: score }))
          }
          onSubmit={() => void sealScores()}
          complete={hasCompleteScores}
        />
      )}

      {snapshot.phase === "completed" && (
        <InlineAlert
          tone="info"
          title="付费调用与人工盲评均已完成"
          description="结果仍需按预先锁定的判断规则复核；完成状态不会自动开启任何写作方法。"
        />
      )}
    </section>
  );
}

function EvaluationProgress({
  snapshot,
}: {
  readonly snapshot: NovelSkillPaidEvaluationSnapshot;
}): ReactNode {
  const calls = clampProgress(snapshot.completedProviderCalls, TOTAL_PROVIDER_CALLS);
  const scores = clampProgress(snapshot.sealedManualScores, TOTAL_MANUAL_SCORES);
  return (
    <Card>
      <CardHeader>
        <CardTitle>持续进度</CardTitle>
      </CardHeader>
      <CardContent>
        <div role="status" aria-live="polite">
          <p>
            已结算调用：<strong>{calls.toLocaleString("zh-CN")} / 192</strong>
          </p>
          <progress aria-label="已结算模型调用" value={calls} max={TOTAL_PROVIDER_CALLS} />
          <p>
            已封存人工评分：<strong>{scores.toLocaleString("zh-CN")} / 2,496</strong>
          </p>
          <progress aria-label="已封存人工评分" value={scores} max={TOTAL_MANUAL_SCORES} />
        </div>
      </CardContent>
    </Card>
  );
}

interface BlindReviewCardProps {
  readonly item: NovelSkillPaidEvaluationBlindItem;
  readonly scores: Partial<Record<NovelSkillEvaluationMetric, number>>;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly complete: boolean;
  readonly onScoreChange: (metric: NovelSkillEvaluationMetric, score: number) => void;
  readonly onSubmit: () => void;
}

function BlindReviewCard({
  busy,
  complete,
  disabled,
  item,
  onScoreChange,
  onSubmit,
  scores,
}: BlindReviewCardProps): ReactNode {
  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <CardTitle>匿名样本 {item.randomizedPosition.toLocaleString("zh-CN")} / 192</CardTitle>
          <Badge tone="neutral">模型与实验分组已隐藏</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p>{item.fixtureLabel}</p>
        <div className="story-governance-grid">
          <div>
            <strong>写作边界</strong>
            <ul>
              {item.boundaries.map((boundary) => (
                <li key={boundary}>{boundary}</li>
              ))}
            </ul>
          </div>
          <div>
            <strong>锁定事实</strong>
            <ul>
              {item.lockedFacts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        </div>
        <p>
          <strong>期望结果：</strong>
          {item.requestedOutcome}
        </p>
        <pre className="candidate-content">{item.candidateText}</pre>
        <fieldset disabled={disabled}>
          <legend>13 项人工评分</legend>
          <div className="story-governance-grid">
            {NOVEL_SKILL_EVALUATION_METRICS.map((metric) => (
              <FormField key={metric} label={METRIC_LABELS[metric]} required optionalLabel="">
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={scores[metric]?.toString() ?? ""}
                    placeholder="请选择评分"
                    options={SCORE_OPTIONS}
                    onChange={(event) => onScoreChange(metric, Number(event.currentTarget.value))}
                  />
                )}
              </FormField>
            ))}
          </div>
        </fieldset>
        <Button loading={busy} disabled={disabled || !complete} onClick={onSubmit}>
          封存本项 13 个评分
        </Button>
        <p className="candidate-panel__hint">
          封存后才计入 2,496 项总进度；盲评完成前不会揭示模型或实验分组。
        </p>
      </CardContent>
    </Card>
  );
}

function stepForPhase(phase: NovelSkillPaidEvaluationPhase): number {
  if (phase === "not_prepared") return 1;
  if (phase === "awaiting_quote") return 2;
  if (phase === "awaiting_authorization") return 3;
  return 4;
}

function formatTargetLabel(target: NovelSkillPaidEvaluationTargetOption): string {
  return `${target.providerLabel} · ${target.modelLabel} · ${target.providerModelId}`;
}

function resolveSelectedTargets(
  quote: NovelSkillPaidEvaluationQuote | null,
  targets: readonly NovelSkillPaidEvaluationTargetOption[],
): readonly [string, string] {
  if (quote === null) return ["尚未锁定", "尚未锁定"];
  return quote.exactTargetIds.map((targetId) => {
    const target = targets.find((candidate) => candidate.targetId === targetId);
    return target === undefined ? `已锁定目标 ${targetId}` : formatTargetLabel(target);
  }) as [string, string];
}

function formatMicros(quote: NovelSkillPaidEvaluationCurrencyQuote, hardCeiling = false): string {
  const micros = hardCeiling ? quote.hardCeilingMicros : quote.estimatedCostMicros;
  return `${quote.currencyCode} ${(micros / 1_000_000).toFixed(6)}`;
}

function clampProgress(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function requireScore(
  scores: Partial<Record<NovelSkillEvaluationMetric, number>>,
  metric: NovelSkillEvaluationMetric,
): number {
  const score = scores[metric];
  if (score === undefined) throw new Error(`Missing manual score: ${metric}`);
  return score;
}
