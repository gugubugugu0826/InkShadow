import {
  StoryCoreError,
  type FineTuningDatasetSnapshot,
  type FineTuningDeploymentRecord,
  type FineTuningDeploymentTargetRole,
  type FineTuningEvaluationGateInput,
  type FineTuningJobRecord,
  type FineTuningModelArtifactRecord,
  type FineTuningRightsKind,
  type Result,
} from "@inkshadow/story-core";
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
  Textarea,
} from "@inkshadow/ui";
import { useCallback, useEffect, useState } from "react";

import {
  type FineTuningDashboard,
  type FineTuningDesktopPort,
  type FineTuningSourceDescriptor,
} from "../infrastructure/fine-tuning-governance-runtime";
import { normalizeUiError } from "../infrastructure/ui-error";

import "./fine-tuning-governance-page.css";

export interface FineTuningGovernancePageProps {
  readonly runtime: FineTuningDesktopPort;
  readonly projectId: string;
  readonly actorId: string;
}

type PagePhase = "loading" | "ready" | "error";

interface DatasetReviewState {
  readonly privacy: boolean;
  readonly copyright: boolean;
  readonly purpose: boolean;
}

const EMPTY_REVIEW: DatasetReviewState = {
  privacy: false,
  copyright: false,
  purpose: false,
};

const RIGHTS_OPTIONS = [
  { value: "user_owned", label: "本人拥有版权" },
  { value: "licensed_for_training", label: "已获训练许可" },
  { value: "public_domain", label: "公版内容" },
  { value: "unknown", label: "尚未确认" },
] as const;

const ROLE_OPTIONS = [
  { value: "local_private", label: "本地私有模型" },
  { value: "fast", label: "快速模型" },
  { value: "high_quality", label: "高质量模型" },
  { value: "validation", label: "验证模型" },
] as const;

export function FineTuningGovernancePage({
  runtime,
  projectId,
  actorId,
}: FineTuningGovernancePageProps) {
  const [phase, setPhase] = useState<PagePhase>("loading");
  const [dashboard, setDashboard] = useState<FineTuningDashboard | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [datasetName, setDatasetName] = useState("");
  const [rightsKind, setRightsKind] = useState<FineTuningRightsKind>("user_owned");
  const [rightsBasis, setRightsBasis] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [trainingAllowed, setTrainingAllowed] = useState(false);
  const [datasetReviews, setDatasetReviews] = useState<
    Readonly<Record<string, DatasetReviewState>>
  >({});

  const load = useCallback(async () => {
    if (!runtime.availability.available) {
      setPhase("ready");
      return;
    }
    setPhase("loading");
    setFailure(null);
    try {
      const result = await runtime.inspect(projectId);
      if (!result.ok) {
        setFailure(result.error);
        setPhase("error");
        return;
      }
      setDashboard(result.value);
      setPhase("ready");
    } catch (cause: unknown) {
      setFailure(cause);
      setPhase("error");
    }
  }, [projectId, runtime]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const perform = useCallback(
    async (
      key: string,
      action: () => Promise<Result<unknown, StoryCoreError>>,
      successMessage: string,
    ) => {
      if (busyKey !== null) return;
      setBusyKey(key);
      setFailure(null);
      setNotice(null);
      try {
        const result = await action();
        if (!result.ok) {
          setFailure(result.error);
          return;
        }
        setNotice(successMessage);
        await load();
      } catch (cause: unknown) {
        setFailure(cause);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, load],
  );

  if (!runtime.availability.available) {
    const copy =
      runtime.availability.reason === "feature_disabled"
        ? {
            title: "微调治理默认关闭",
            description:
              "只有显式启用实验功能后才能读取或写入治理记录；本页没有启动训练，也没有发送任何内容。",
          }
        : {
            title: "需要桌面原生持久化",
            description: "浏览器开发模式不会伪装生产级数据集、配额、训练队列、评测或部署记录。",
          };
    return (
      <div className="desktop-page fine-tuning-governance-page">
        <header className="page-heading">
          <div>
            <h1>微调治理（实验）</h1>
            <p>以版权、隐私、配额、评测和人工审批约束模型微调。</p>
          </div>
          <Badge tone="neutral">默认关闭</Badge>
        </header>
        <EmptyState kind="feature_limited" title={copy.title} description={copy.description} />
      </div>
    );
  }

  const normalizedFailure = failure === null ? null : normalizeUiError(failure);
  const trainerAvailable = runtime.availability.localTrainer.available;
  const selectedSources = dashboard?.sources.filter(({ id }) => selectedSourceIds.has(id)) ?? [];
  const selectedNeedsDeclaration = selectedSources.some(
    ({ rightsDeclarationRequired }) => rightsDeclarationRequired,
  );
  const canCreateDataset =
    selectedSources.length > 0 &&
    datasetName.trim().length > 0 &&
    (!selectedNeedsDeclaration ||
      (rightsConfirmed && trainingAllowed && rightsBasis.trim().length > 0));

  function toggleSource(sourceId: string): void {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  function updateReview(
    datasetId: string,
    field: keyof DatasetReviewState,
    checked: boolean,
  ): void {
    setDatasetReviews((current) => ({
      ...current,
      [datasetId]: {
        ...(current[datasetId] ?? EMPTY_REVIEW),
        [field]: checked,
      },
    }));
  }

  function createDataset(): void {
    if (!canCreateDataset) return;
    const selected = selectedSources.map((source) => ({
      sourceId: source.id,
      expectedRevision: source.revision,
      expectedContentHash: source.contentHash,
      ...(source.rightsDeclarationRequired
        ? {
            rights: {
              kind: rightsKind,
              basis: rightsBasis.trim(),
              allowTraining: trainingAllowed,
              humanConfirmed: rightsConfirmed,
            },
          }
        : {}),
    }));
    void perform(
      "dataset:create",
      () =>
        runtime.createDataset({
          projectId,
          actorId,
          name: datasetName.trim(),
          sources: selected,
        }),
      "数据集清单已按当前来源版本创建；正文仍只保留在本地数据库。",
    );
  }

  return (
    <div className="desktop-page fine-tuning-governance-page">
      <header className="page-heading">
        <div>
          <p className="fine-tuning-governance-page__eyebrow">实验性 · 本地优先</p>
          <h1>微调治理（实验）</h1>
          <p>先冻结来源与许可，再审批数据集、控制配额、评测候选，最后人工登记与部署。</p>
        </div>
        <div className="fine-tuning-governance-page__header-actions">
          <Badge tone="success">桌面本地数据库</Badge>
          <Badge tone={trainerAvailable ? "ai" : "warning"}>
            {trainerAvailable
              ? `本地训练器：${runtime.availability.localTrainer.providerId}`
              : "未配置本地训练器"}
          </Badge>
          <Button
            variant="secondary"
            loading={phase === "loading"}
            disabled={busyKey !== null}
            onClick={() => void load()}
          >
            刷新
          </Button>
        </div>
      </header>

      <InlineAlert
        tone="ai-clarification"
        title="微调产物始终先是候选"
        description="训练完成不等于可用。候选必须通过基线评测，并分别取得人工登记审批和绑定目标角色的部署审批。"
      />
      {!trainerAvailable && (
        <InlineAlert
          tone="warning"
          title="仅治理模式"
          description="你仍可盘点来源、创建与审批数据集、配置硬上限；排队、执行、登记、部署、回滚和撤销都会保持阻止状态。"
        />
      )}
      <InlineAlert
        tone="info"
        title="远端训练固定关闭"
        description="此工作台不会上传训练正文，也不会自动使用云端凭据或商业授权。"
      />
      {normalizedFailure !== null && (
        <InlineAlert
          tone="error"
          title={normalizedFailure.title}
          description={normalizedFailure.description}
          action={{ label: "重新加载", onClick: () => void load() }}
        />
      )}
      {notice !== null && (
        <InlineAlert
          tone="info"
          title="操作已完成"
          description={notice}
          onDismiss={() => setNotice(null)}
        />
      )}

      <section
        className="fine-tuning-governance-page__summary"
        aria-label="微调治理摘要"
        aria-busy={phase === "loading"}
      >
        <SummaryCard label="数据集" value={String(dashboard?.datasets.length ?? 0)} />
        <SummaryCard label="训练作业" value={String(dashboard?.jobs.length ?? 0)} />
        <SummaryCard label="模型候选" value={String(dashboard?.artifacts.length ?? 0)} />
        <SummaryCard
          label="本月预留 / 上限"
          value={
            dashboard?.policy === null || dashboard?.policy === undefined
              ? "未配置"
              : `${formatMicros(dashboard.policy.reservedMicros)} / ${formatMicros(
                  dashboard.policy.monthlyCostLimitMicros,
                )} ${dashboard.policy.currency}`
          }
        />
      </section>

      {phase === "error" && dashboard === null ? (
        <EmptyState
          title="无法读取微调治理记录"
          description="本页没有报告任何训练或治理操作成功。请恢复本地数据库后重试。"
          primaryAction={{ label: "重试", onClick: () => void load() }}
        />
      ) : (
        <>
          <section className="fine-tuning-governance-page__section" aria-labelledby="sources-title">
            <SectionHeading
              id="sources-title"
              title="1. 冻结本地训练来源"
              description="只展示来源元数据；素材许可来自权威素材快照，不能被此页面覆盖。"
            />
            <div className="fine-tuning-governance-page__two-column">
              <Card>
                <CardHeader>
                  <CardTitle>可选来源</CardTitle>
                  <CardDescription>选择时绑定当前版本、字节数与 SHA-256。</CardDescription>
                </CardHeader>
                <CardContent>
                  {dashboard?.sources.length === 0 ? (
                    <EmptyState
                      title="没有可用来源"
                      description="先创建稳定章节版本或带明确训练许可的素材。"
                    />
                  ) : (
                    <div className="fine-tuning-governance-page__source-list">
                      {dashboard?.sources.map((source) => (
                        <SourceOption
                          key={source.id}
                          source={source}
                          checked={selectedSourceIds.has(source.id)}
                          disabled={!canSelectSource(source) || busyKey !== null}
                          onChange={() => toggleSource(source.id)}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>新建数据集清单</CardTitle>
                  <CardDescription>
                    章节与本地导入需要在本次创建中明确声明版权和训练用途。
                  </CardDescription>
                </CardHeader>
                <CardContent className="fine-tuning-governance-page__form-stack">
                  <FormField label="数据集名称" required>
                    {(field) => (
                      <Input
                        {...field}
                        value={datasetName}
                        maxLength={160}
                        onChange={(event) => setDatasetName(event.currentTarget.value)}
                      />
                    )}
                  </FormField>
                  {selectedNeedsDeclaration && (
                    <>
                      <FormField label="版权基础" required>
                        {(field) => (
                          <Select
                            {...field}
                            value={rightsKind}
                            options={RIGHTS_OPTIONS}
                            onChange={(event) =>
                              setRightsKind(event.currentTarget.value as FineTuningRightsKind)
                            }
                          />
                        )}
                      </FormField>
                      <FormField
                        label="授权依据"
                        required
                        hint="填写合同、本人创作或公版依据；不要粘贴密钥或私密正文。"
                      >
                        {(field) => (
                          <Textarea
                            {...field}
                            rows={3}
                            maxLength={1_000}
                            value={rightsBasis}
                            onChange={(event) => setRightsBasis(event.currentTarget.value)}
                          />
                        )}
                      </FormField>
                      <Confirmation
                        checked={trainingAllowed}
                        onChange={setTrainingAllowed}
                        label="我确认所选章节或导入内容允许用于模型训练。"
                      />
                      <Confirmation
                        checked={rightsConfirmed}
                        onChange={setRightsConfirmed}
                        label="我已人工核对上述版权依据，且它适用于当前精确来源版本。"
                      />
                    </>
                  )}
                  <p className="fine-tuning-governance-page__selection-count">
                    已选择 {String(selectedSources.length)} 条来源
                  </p>
                </CardContent>
                <CardFooter>
                  <Button
                    loading={busyKey === "dataset:create"}
                    disabled={!canCreateDataset || busyKey !== null}
                    onClick={createDataset}
                  >
                    创建待审数据集
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </section>

          <section
            className="fine-tuning-governance-page__section"
            aria-labelledby="datasets-title"
          >
            <SectionHeading
              id="datasets-title"
              title="2. 数据集人工审批"
              description="隐私、版权和训练目的必须逐项确认，审批绑定清单哈希与版本。"
            />
            {dashboard?.datasets.length === 0 ? (
              <EmptyState title="还没有数据集" description="从上方冻结至少三条合规来源。" />
            ) : (
              <div className="fine-tuning-governance-page__card-grid">
                {dashboard?.datasets.map((dataset) => {
                  const review = datasetReviews[dataset.id] ?? EMPTY_REVIEW;
                  return (
                    <DatasetCard
                      key={dataset.id}
                      dataset={dataset}
                      review={review}
                      busy={busyKey === `dataset:approve:${dataset.id}`}
                      disabled={busyKey !== null}
                      onReview={(field, checked) => updateReview(dataset.id, field, checked)}
                      onApprove={() =>
                        void perform(
                          `dataset:approve:${dataset.id}`,
                          () =>
                            runtime.approveDataset({
                              datasetId: dataset.id,
                              actorId,
                              expectedRevision: dataset.revision,
                              expectedManifestHash: dataset.manifestHash,
                              privacyReviewed: review.privacy,
                              copyrightReviewed: review.copyright,
                              trainingPurposeConfirmed: review.purpose,
                              humanConfirmed: true,
                            }),
                          "数据集已由人工审批并绑定当前清单哈希。",
                        )
                      }
                    />
                  );
                })}
              </div>
            )}
          </section>

          <PolicyAndQueue
            runtime={runtime}
            projectId={projectId}
            actorId={actorId}
            dashboard={dashboard}
            trainerAvailable={trainerAvailable}
            busyKey={busyKey}
            perform={perform}
          />

          <section className="fine-tuning-governance-page__section" aria-labelledby="jobs-title">
            <SectionHeading
              id="jobs-title"
              title="4. 可恢复训练队列"
              description="执行只调用已注入的本地训练器；租约、取消、失败和费用结算都持久化。"
              actions={
                <div className="fine-tuning-governance-page__section-actions">
                  {(dashboard?.recoverableJobs.length ?? 0) > 0 && (
                    <Button
                      variant="secondary"
                      loading={busyKey === "jobs:recover"}
                      disabled={busyKey !== null}
                      onClick={() =>
                        void perform(
                          "jobs:recover",
                          () => runtime.recoverExpiredJobs(projectId, actorId),
                          "过期租约已按持久化状态恢复。",
                        )
                      }
                    >
                      恢复过期作业
                    </Button>
                  )}
                  <Button
                    loading={busyKey === "jobs:run"}
                    disabled={!trainerAvailable || busyKey !== null}
                    onClick={() =>
                      void perform(
                        "jobs:run",
                        () => runtime.runNextLocalJob(projectId, actorId),
                        "本地队列已执行一次；没有待处理作业时不会创建新记录。",
                      )
                    }
                  >
                    执行下一个本地作业
                  </Button>
                </div>
              }
            />
            {dashboard?.jobs.length === 0 ? (
              <EmptyState title="队列为空" description="通过预检后，训练计划才会进入此处。" />
            ) : (
              <div className="fine-tuning-governance-page__card-grid">
                {dashboard?.jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    busyKey={busyKey}
                    onCancel={() =>
                      void perform(
                        `job:cancel:${job.id}`,
                        () =>
                          runtime.cancelJob({
                            jobId: job.id,
                            actorId,
                            expectedRevision: job.revision,
                          }),
                        "取消请求已持久化；迟到的训练结果不会越过状态机。",
                      )
                    }
                    onRetry={() =>
                      void perform(
                        `job:retry:${job.id}`,
                        () =>
                          runtime.retryJob({
                            jobId: job.id,
                            actorId,
                            expectedRevision: job.revision,
                          }),
                        "可重试失败已重新排队，并重新预留受限额度。",
                      )
                    }
                  />
                ))}
              </div>
            )}
          </section>

          <section
            className="fine-tuning-governance-page__section"
            aria-labelledby="artifacts-title"
          >
            <SectionHeading
              id="artifacts-title"
              title="5. 评测、登记与部署"
              description="评测数据必须来自经过验证的本地评测器；本页不会生成或伪造分数。"
            />
            {dashboard?.artifacts.length === 0 ? (
              <EmptyState
                title="还没有模型候选"
                description="只有本地训练器成功返回可验证回执后，候选才会出现在这里。"
              />
            ) : (
              <div className="fine-tuning-governance-page__artifact-list">
                {dashboard?.artifacts.map((artifact) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    runtime={runtime}
                    projectId={projectId}
                    actorId={actorId}
                    trainerAvailable={trainerAvailable}
                    busyKey={busyKey}
                    onPerform={perform}
                  />
                ))}
              </div>
            )}
            {(dashboard?.deployments.length ?? 0) > 0 && (
              <div className="fine-tuning-governance-page__deployment-list">
                <h3>部署记录</h3>
                {dashboard?.deployments.map((deployment) => (
                  <DeploymentCard
                    key={deployment.id}
                    deployment={deployment}
                    runtime={runtime}
                    actorId={actorId}
                    trainerAvailable={trainerAvailable}
                    busyKey={busyKey}
                    onPerform={perform}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="fine-tuning-governance-page__section" aria-labelledby="audit-title">
            <SectionHeading
              id="audit-title"
              title="6. 审计轨迹"
              description="仅显示治理动作、对象、操作者与请求标识；不显示训练正文。"
            />
            {dashboard?.audit.length === 0 ? (
              <EmptyState title="暂无审计事件" description="治理操作完成后会在此留下记录。" />
            ) : (
              <ol className="fine-tuning-governance-page__audit-list">
                {dashboard?.audit.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{event.action}</strong>
                      <span>
                        {event.entityType} · {shortId(event.entityId)}
                      </span>
                    </div>
                    <div>
                      <span>{formatTimestamp(event.createdAt)}</span>
                      <span title={event.requestId}>请求 {shortId(event.requestId)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

interface PolicyAndQueueProps {
  readonly runtime: FineTuningDesktopPort;
  readonly projectId: string;
  readonly actorId: string;
  readonly dashboard: FineTuningDashboard | null;
  readonly trainerAvailable: boolean;
  readonly busyKey: string | null;
  readonly perform: Perform;
}

function PolicyAndQueue(props: PolicyAndQueueProps) {
  const policy = props.dashboard?.policy;
  const approvedDatasets =
    props.dashboard?.datasets.filter(({ state }) => state === "approved") ?? [];
  const [maximumDatasetBytesOverride, setMaximumDatasetBytes] = useState<string | null>(null);
  const [maximumConcurrentJobsOverride, setMaximumConcurrentJobs] = useState<string | null>(null);
  const [maximumSingleJobCostMicrosOverride, setMaximumSingleJobCostMicros] = useState<
    string | null
  >(null);
  const [monthlyCostLimitMicrosOverride, setMonthlyCostLimitMicros] = useState<string | null>(null);
  const [currencyOverride, setCurrency] = useState<string | null>(null);
  const [selectedDatasetId, setDatasetId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelRevision, setModelRevision] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [licenseVersion, setLicenseVersion] = useState("");
  const [licenseConfirmed, setLicenseConfirmed] = useState(false);

  const maximumDatasetBytes =
    maximumDatasetBytesOverride ?? String(policy?.maximumDatasetBytes ?? 50_000_000);
  const maximumConcurrentJobs =
    maximumConcurrentJobsOverride ?? String(policy?.maximumConcurrentJobs ?? 1);
  const maximumSingleJobCostMicros =
    maximumSingleJobCostMicrosOverride ?? String(policy?.maximumSingleJobCostMicros ?? 1_000_000);
  const monthlyCostLimitMicros =
    monthlyCostLimitMicrosOverride ?? String(policy?.monthlyCostLimitMicros ?? 5_000_000);
  const currency = currencyOverride ?? policy?.currency ?? "USD";
  const datasetId = approvedDatasets.some(({ id }) => id === selectedDatasetId)
    ? selectedDatasetId
    : (approvedDatasets[0]?.id ?? "");

  const policyInput = {
    maximumDatasetBytes: parseInteger(maximumDatasetBytes),
    maximumConcurrentJobs: parseInteger(maximumConcurrentJobs),
    maximumSingleJobCostMicros: parseInteger(maximumSingleJobCostMicros),
    monthlyCostLimitMicros: parseInteger(monthlyCostLimitMicros),
  };
  const policyValid =
    Object.values(policyInput).every((value) => value !== null && value >= 0) &&
    policyInput.maximumConcurrentJobs !== null &&
    policyInput.maximumConcurrentJobs >= 1 &&
    /^[A-Z]{3}$/u.test(currency);
  const canQueue =
    props.trainerAvailable &&
    policy !== null &&
    policy !== undefined &&
    datasetId !== "" &&
    providerId.trim() !== "" &&
    modelId.trim() !== "" &&
    modelRevision.trim() !== "" &&
    licenseId.trim() !== "" &&
    licenseVersion.trim() !== "" &&
    licenseConfirmed;

  return (
    <section className="fine-tuning-governance-page__section" aria-labelledby="policy-title">
      <SectionHeading
        id="policy-title"
        title="3. 配额策略与本地训练预检"
        description="所有费用数字都是内部微单位硬上限或本地资源估算，不会冒充供应商账单。"
      />
      <div className="fine-tuning-governance-page__two-column">
        <Card>
          <CardHeader>
            <CardTitle>项目硬上限</CardTitle>
            <CardDescription>远端训练不可开启；修改策略使用版本检查。</CardDescription>
          </CardHeader>
          <CardContent className="fine-tuning-governance-page__form-grid">
            <NumberField
              label="数据集最大字节数"
              value={maximumDatasetBytes}
              onChange={setMaximumDatasetBytes}
            />
            <NumberField
              label="最大并发作业"
              value={maximumConcurrentJobs}
              onChange={setMaximumConcurrentJobs}
            />
            <NumberField
              label="单作业费用上限（微单位）"
              value={maximumSingleJobCostMicros}
              onChange={setMaximumSingleJobCostMicros}
            />
            <NumberField
              label="月度费用上限（微单位）"
              value={monthlyCostLimitMicros}
              onChange={setMonthlyCostLimitMicros}
            />
            <FormField label="币种" required>
              {(field) => (
                <Input
                  {...field}
                  value={currency}
                  maxLength={3}
                  onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())}
                />
              )}
            </FormField>
            <FormField label="远端训练">
              {(field) => <Input {...field} value="固定关闭" readOnly />}
            </FormField>
          </CardContent>
          <CardFooter>
            <Button
              loading={props.busyKey === "policy:save"}
              disabled={!policyValid || props.busyKey !== null}
              onClick={() => {
                if (
                  policyInput.maximumDatasetBytes === null ||
                  policyInput.maximumConcurrentJobs === null ||
                  policyInput.maximumSingleJobCostMicros === null ||
                  policyInput.monthlyCostLimitMicros === null
                ) {
                  return;
                }
                const parsedPolicy = {
                  maximumDatasetBytes: policyInput.maximumDatasetBytes,
                  maximumConcurrentJobs: policyInput.maximumConcurrentJobs,
                  maximumSingleJobCostMicros: policyInput.maximumSingleJobCostMicros,
                  monthlyCostLimitMicros: policyInput.monthlyCostLimitMicros,
                };
                void props.perform(
                  "policy:save",
                  () =>
                    props.runtime.configurePolicy({
                      projectId: props.projectId,
                      actorId: props.actorId,
                      policy: {
                        allowRemoteTraining: false,
                        ...parsedPolicy,
                        currency,
                      },
                      monthKey: currentMonthKey(),
                      expectedRevision: policy?.revision ?? null,
                    }),
                  "本地训练配额策略已保存；远端训练仍保持关闭。",
                );
              }}
            >
              保存硬上限
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>训练计划</CardTitle>
            <CardDescription>仅可选择已审批数据集；基础模型许可证需由人明确确认。</CardDescription>
          </CardHeader>
          <CardContent className="fine-tuning-governance-page__form-grid">
            <FormField label="已审批数据集" required>
              {(field) => (
                <Select
                  {...field}
                  value={datasetId}
                  placeholder="选择数据集"
                  options={approvedDatasets.map((dataset) => ({
                    value: dataset.id,
                    label: `${dataset.name} · r${String(dataset.revision)}`,
                  }))}
                  onChange={(event) => setDatasetId(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="基础模型提供方标识" required>
              {(field) => (
                <Input
                  {...field}
                  value={providerId}
                  onChange={(event) => setProviderId(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="基础模型 ID" required>
              {(field) => (
                <Input
                  {...field}
                  value={modelId}
                  onChange={(event) => setModelId(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="基础模型版本" required>
              {(field) => (
                <Input
                  {...field}
                  value={modelRevision}
                  onChange={(event) => setModelRevision(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="许可证标识" required>
              {(field) => (
                <Input
                  {...field}
                  value={licenseId}
                  onChange={(event) => setLicenseId(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="许可证版本" required>
              {(field) => (
                <Input
                  {...field}
                  value={licenseVersion}
                  onChange={(event) => setLicenseVersion(event.currentTarget.value)}
                />
              )}
            </FormField>
            <div className="fine-tuning-governance-page__wide-field">
              <Confirmation
                checked={licenseConfirmed}
                onChange={setLicenseConfirmed}
                label="我已人工确认该许可证允许微调与商业使用；再分发权限按许可证原文记录。"
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button
              loading={props.busyKey === "job:queue"}
              disabled={!canQueue || props.busyKey !== null}
              onClick={() =>
                void props.perform(
                  "job:queue",
                  () =>
                    props.runtime.queueTraining({
                      projectId: props.projectId,
                      datasetId,
                      actorId: props.actorId,
                      maximumAttempts: 3,
                      baseModel: {
                        providerId: providerId.trim(),
                        modelId: modelId.trim(),
                        revision: modelRevision.trim(),
                        licenseId: licenseId.trim(),
                        licenseVersion: licenseVersion.trim(),
                        fineTuningAllowed: true,
                        commercialUseAllowed: true,
                        redistributionAllowed: false,
                        humanConfirmed: licenseConfirmed,
                      },
                      method: "qlora",
                      hyperparameters: {
                        rank: 16,
                        alpha: 32,
                        dropout: 0.05,
                        learningRate: 0.0002,
                        epochs: 3,
                      },
                      limits: {
                        maximumDurationMs: 6 * 60 * 60 * 1_000,
                        maximumCostMicros: Math.min(
                          policy?.maximumSingleJobCostMicros ?? 0,
                          1_000_000,
                        ),
                        estimatedCostMicros: Math.min(
                          policy?.maximumSingleJobCostMicros ?? 0,
                          500_000,
                        ),
                        estimatedGpuMinutes: 120,
                        currency: policy?.currency ?? currency,
                      },
                    }),
                  "本地训练计划已通过许可证、数据集、配额和训练器预检并进入队列。",
                )
              }
            >
              预检并加入本地队列
            </Button>
          </CardFooter>
        </Card>
      </div>
    </section>
  );
}

interface ArtifactCardProps {
  readonly artifact: FineTuningModelArtifactRecord;
  readonly runtime: FineTuningDesktopPort;
  readonly projectId: string;
  readonly actorId: string;
  readonly trainerAvailable: boolean;
  readonly busyKey: string | null;
  readonly onPerform: Perform;
}

function ArtifactCard(props: ArtifactCardProps) {
  const { artifact } = props;
  const [evaluatorId, setEvaluatorId] = useState("");
  const [evaluatorVersion, setEvaluatorVersion] = useState("");
  const [baselineModelId, setBaselineModelId] = useState(artifact.baseModelId);
  const [baselineJson, setBaselineJson] = useState("");
  const [candidateJson, setCandidateJson] = useState("");
  const [rulesJson, setRulesJson] = useState("");
  const [registrationConfirmed, setRegistrationConfirmed] = useState(false);
  const [registrationName, setRegistrationName] = useState("");
  const [deploymentRole, setDeploymentRole] =
    useState<FineTuningDeploymentTargetRole>("local_private");
  const [deploymentConfirmed, setDeploymentConfirmed] = useState(false);
  const [revocationConfirmed, setRevocationConfirmed] = useState(false);

  function recordEvaluation(): void {
    let gate: FineTuningEvaluationGateInput;
    try {
      gate = {
        baselineModelId: baselineModelId.trim(),
        candidateArtifactId: artifact.id,
        baseline: parseMetricJson(baselineJson),
        candidate: parseMetricJson(candidateJson),
        rules: parseRuleJson(rulesJson),
      };
    } catch (cause: unknown) {
      void props.onPerform(
        `artifact:evaluation-invalid:${artifact.id}`,
        () =>
          Promise.resolve({
            ok: false,
            error: new StoryCoreError({
              code: "FINE_TUNING_VALIDATION_FAILED",
              message:
                cause instanceof Error ? cause.message : "评测结构化数据必须是符合格式的数组。",
            }),
          }),
        "",
      );
      return;
    }
    void props.onPerform(
      `artifact:evaluate:${artifact.id}`,
      () =>
        props.runtime.recordEvaluation({
          projectId: props.projectId,
          artifactId: artifact.id,
          actorId: props.actorId,
          expectedArtifactRevision: artifact.revision,
          evaluatorId: evaluatorId.trim(),
          evaluatorVersion: evaluatorVersion.trim(),
          gate,
        }),
      "经验证的本地评测结果已重新计算并绑定候选版本。",
    );
  }

  const evaluating = artifact.state === "candidate" || artifact.state === "evaluation_failed";
  const canEvaluate =
    evaluatorId.trim() !== "" &&
    evaluatorVersion.trim() !== "" &&
    baselineModelId.trim() !== "" &&
    baselineJson.trim() !== "" &&
    candidateJson.trim() !== "" &&
    rulesJson.trim() !== "";

  return (
    <Card className="fine-tuning-governance-page__artifact-card">
      <CardHeader>
        <div className="fine-tuning-governance-page__card-heading">
          <div>
            <CardTitle>{artifact.registrationName ?? shortId(artifact.id)}</CardTitle>
            <CardDescription>
              {artifact.baseModelProviderId}/{artifact.baseModelId}@{artifact.baseModelRevision}
            </CardDescription>
          </div>
          <Badge tone={artifactTone(artifact.state)}>{artifactStateLabel(artifact.state)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="fine-tuning-governance-page__form-stack">
        <dl className="fine-tuning-governance-page__kv">
          <div>
            <dt>候选版本</dt>
            <dd>r{String(artifact.revision)}</dd>
          </div>
          <div>
            <dt>产物摘要</dt>
            <dd title={artifact.artifactDigest}>{shortHash(artifact.artifactDigest)}</dd>
          </div>
          <div>
            <dt>评测记录</dt>
            <dd>
              {artifact.latestEvaluationId === null
                ? "尚未绑定"
                : shortId(artifact.latestEvaluationId)}
            </dd>
          </div>
        </dl>

        {evaluating && (
          <div className="fine-tuning-governance-page__evaluation">
            <InlineAlert
              tone="warning"
              title="只接受真实评测输出"
              description="请从经过验证的本地评测器导入基线、候选分数与门禁规则。页面只解析并提交，不生成默认分数。"
            />
            <div className="fine-tuning-governance-page__form-grid">
              <FormField label="评测器标识" required>
                {(field) => (
                  <Input
                    {...field}
                    value={evaluatorId}
                    onChange={(event) => setEvaluatorId(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="评测器版本" required>
                {(field) => (
                  <Input
                    {...field}
                    value={evaluatorVersion}
                    onChange={(event) => setEvaluatorVersion(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="基线模型 ID" required>
                {(field) => (
                  <Input
                    {...field}
                    value={baselineModelId}
                    onChange={(event) => setBaselineModelId(event.currentTarget.value)}
                  />
                )}
              </FormField>
            </div>
            <FormField
              label="基线指标结构化数据"
              required
              hint={'格式：[{"name":"quality","score":0.72}]'}
            >
              {(field) => (
                <Textarea
                  {...field}
                  rows={3}
                  spellCheck={false}
                  value={baselineJson}
                  onChange={(event) => setBaselineJson(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField
              label="候选指标结构化数据"
              required
              hint={'格式：[{"name":"quality","score":0.79}]'}
            >
              {(field) => (
                <Textarea
                  {...field}
                  rows={3}
                  spellCheck={false}
                  value={candidateJson}
                  onChange={(event) => setCandidateJson(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField
              label="门禁规则结构化数据"
              required
              hint={
                '[{"metric":"quality","direction":"higher_is_better","minimumImprovement":0.03}]'
              }
            >
              {(field) => (
                <Textarea
                  {...field}
                  rows={4}
                  spellCheck={false}
                  value={rulesJson}
                  onChange={(event) => setRulesJson(event.currentTarget.value)}
                />
              )}
            </FormField>
            <Button
              loading={props.busyKey === `artifact:evaluate:${artifact.id}`}
              disabled={!canEvaluate || props.busyKey !== null}
              onClick={recordEvaluation}
            >
              重新计算并记录评测
            </Button>
          </div>
        )}

        {artifact.state === "evaluation_passed" && (
          <ApprovalAction
            checked={registrationConfirmed}
            onCheckedChange={setRegistrationConfirmed}
            label="我已核对评测结果、许可证与数据集血缘，同意登记此候选。"
            buttonLabel="批准模型登记"
            loading={props.busyKey === `artifact:approve-registration:${artifact.id}`}
            disabled={props.busyKey !== null}
            onClick={() =>
              void props.onPerform(
                `artifact:approve-registration:${artifact.id}`,
                () =>
                  props.runtime.approveRegistration({
                    artifactId: artifact.id,
                    actorId: props.actorId,
                    expectedRevision: artifact.revision,
                    humanConfirmed: registrationConfirmed,
                  }),
                "模型登记已获人工批准，并绑定当前候选版本。",
              )
            }
          />
        )}

        {artifact.state === "registration_approved" && (
          <div className="fine-tuning-governance-page__form-stack">
            <FormField label="本地登记名称" required>
              {(field) => (
                <Input
                  {...field}
                  value={registrationName}
                  onChange={(event) => setRegistrationName(event.currentTarget.value)}
                />
              )}
            </FormField>
            <Button
              loading={props.busyKey === `artifact:register:${artifact.id}`}
              disabled={
                !props.trainerAvailable || registrationName.trim() === "" || props.busyKey !== null
              }
              onClick={() =>
                void props.onPerform(
                  `artifact:register:${artifact.id}`,
                  () =>
                    props.runtime.registerArtifact({
                      artifactId: artifact.id,
                      actorId: props.actorId,
                      expectedRevision: artifact.revision,
                      registrationName: registrationName.trim(),
                    }),
                  "候选已由本地训练器登记；登记回执摘要已持久化。",
                )
              }
            >
              登记到本地模型库
            </Button>
          </div>
        )}

        {artifact.state === "registered" && (
          <div className="fine-tuning-governance-page__form-stack">
            <FormField
              label="部署目标角色"
              required
              hint="审批会与此角色绑定，之后不能换角色复用。"
            >
              {(field) => (
                <Select
                  {...field}
                  value={deploymentRole}
                  options={ROLE_OPTIONS}
                  onChange={(event) =>
                    setDeploymentRole(event.currentTarget.value as FineTuningDeploymentTargetRole)
                  }
                />
              )}
            </FormField>
            <ApprovalAction
              checked={deploymentConfirmed}
              onCheckedChange={setDeploymentConfirmed}
              label={`我已人工确认将此模型批准用于“${roleLabel(deploymentRole)}”角色。`}
              buttonLabel="批准此目标角色"
              loading={props.busyKey === `artifact:approve-deployment:${artifact.id}`}
              disabled={props.busyKey !== null}
              onClick={() =>
                void props.onPerform(
                  `artifact:approve-deployment:${artifact.id}`,
                  () =>
                    props.runtime.approveDeployment({
                      artifactId: artifact.id,
                      actorId: props.actorId,
                      expectedRevision: artifact.revision,
                      targetRole: deploymentRole,
                      humanConfirmed: deploymentConfirmed,
                    }),
                  "部署审批已绑定当前模型版本与目标角色。",
                )
              }
            />
          </div>
        )}

        {artifact.state === "deployment_approved" && (
          <div className="fine-tuning-governance-page__form-stack">
            <InlineAlert
              tone="warning"
              title="目标角色必须与审批一致"
              description="重新加载后请再次选择获批角色；运行时会拒绝任何不匹配的角色。"
            />
            <FormField label="已获批目标角色" required>
              {(field) => (
                <Select
                  {...field}
                  value={deploymentRole}
                  options={ROLE_OPTIONS}
                  onChange={(event) =>
                    setDeploymentRole(event.currentTarget.value as FineTuningDeploymentTargetRole)
                  }
                />
              )}
            </FormField>
            <Button
              loading={props.busyKey === `artifact:deploy:${artifact.id}`}
              disabled={!props.trainerAvailable || props.busyKey !== null}
              onClick={() =>
                void props.onPerform(
                  `artifact:deploy:${artifact.id}`,
                  () =>
                    props.runtime.activateDeployment({
                      artifactId: artifact.id,
                      actorId: props.actorId,
                      expectedRevision: artifact.revision,
                      targetRole: deploymentRole,
                    }),
                  "模型已部署到与人工审批一致的本地角色。",
                )
              }
            >
              激活本地部署
            </Button>
          </div>
        )}

        {artifact.state !== "revoked" && (
          <div className="fine-tuning-governance-page__danger-zone">
            <Confirmation
              checked={revocationConfirmed}
              onChange={setRevocationConfirmed}
              label="我确认撤销此模型候选或已登记模型；该动作会留下审计记录。"
            />
            <Button
              variant="danger"
              loading={props.busyKey === `artifact:revoke:${artifact.id}`}
              disabled={!props.trainerAvailable || !revocationConfirmed || props.busyKey !== null}
              onClick={() =>
                void props.onPerform(
                  `artifact:revoke:${artifact.id}`,
                  () =>
                    props.runtime.revokeArtifact({
                      artifactId: artifact.id,
                      actorId: props.actorId,
                      expectedRevision: artifact.revision,
                      humanConfirmed: revocationConfirmed,
                    }),
                  "模型已由本地适配器撤销并记录治理审计。",
                )
              }
            >
              撤销模型
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface DeploymentCardProps {
  readonly deployment: FineTuningDeploymentRecord;
  readonly runtime: FineTuningDesktopPort;
  readonly actorId: string;
  readonly trainerAvailable: boolean;
  readonly busyKey: string | null;
  readonly onPerform: Perform;
}

function DeploymentCard(props: DeploymentCardProps) {
  const [confirmed, setConfirmed] = useState(false);
  const { deployment } = props;
  return (
    <Card>
      <CardHeader>
        <div className="fine-tuning-governance-page__card-heading">
          <div>
            <CardTitle>{roleLabel(deployment.targetRole)}</CardTitle>
            <CardDescription>模型 {shortId(deployment.artifactId)}</CardDescription>
          </div>
          <Badge tone={deployment.status === "active" ? "success" : "neutral"}>
            {deploymentStatusLabel(deployment.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="fine-tuning-governance-page__form-stack">
        <p>激活于 {formatTimestamp(deployment.activatedAt)}</p>
        {deployment.status === "active" && (
          <ApprovalAction
            checked={confirmed}
            onCheckedChange={setConfirmed}
            label="我确认回滚此部署；当前角色将不再使用该模型。"
            buttonLabel="回滚部署"
            variant="danger"
            loading={props.busyKey === `deployment:rollback:${deployment.id}`}
            disabled={!props.trainerAvailable || props.busyKey !== null}
            onClick={() =>
              void props.onPerform(
                `deployment:rollback:${deployment.id}`,
                () =>
                  props.runtime.rollbackDeployment({
                    deploymentId: deployment.id,
                    actorId: props.actorId,
                    humanConfirmed: confirmed,
                  }),
                "本地部署已回滚，回执摘要与人工审批已记录。",
              )
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

interface DatasetCardProps {
  readonly dataset: FineTuningDatasetSnapshot;
  readonly review: DatasetReviewState;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onReview: (field: keyof DatasetReviewState, checked: boolean) => void;
  readonly onApprove: () => void;
}

function DatasetCard(props: DatasetCardProps) {
  const { dataset, review } = props;
  const canApprove =
    dataset.state === "review_required" &&
    dataset.readinessIssues.length === 0 &&
    review.privacy &&
    review.copyright &&
    review.purpose;
  return (
    <Card>
      <CardHeader>
        <div className="fine-tuning-governance-page__card-heading">
          <div>
            <CardTitle>{dataset.name}</CardTitle>
            <CardDescription>
              {String(dataset.includedSampleCount)} 条有效样本 ·{" "}
              {formatBytes(dataset.totalContentBytes)}
            </CardDescription>
          </div>
          <Badge tone={dataset.state === "approved" ? "success" : "warning"}>
            {datasetStateLabel(dataset.state)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="fine-tuning-governance-page__form-stack">
        <dl className="fine-tuning-governance-page__kv">
          <div>
            <dt>清单版本</dt>
            <dd>r{String(dataset.revision)}</dd>
          </div>
          <div>
            <dt>清单哈希</dt>
            <dd title={dataset.manifestHash}>{shortHash(dataset.manifestHash)}</dd>
          </div>
          <div>
            <dt>训练 / 验证 / 测试</dt>
            <dd>
              {String(dataset.splitCounts.train)} / {String(dataset.splitCounts.validation)} /{" "}
              {String(dataset.splitCounts.test)}
            </dd>
          </div>
        </dl>
        {dataset.readinessIssues.length > 0 && (
          <ul className="fine-tuning-governance-page__issue-list">
            {dataset.readinessIssues.map((issue, index) => (
              <li key={`${issue.code}:${issue.sampleId ?? String(index)}`}>{issue.detail}</li>
            ))}
          </ul>
        )}
        {dataset.state === "review_required" && dataset.readinessIssues.length === 0 && (
          <div className="fine-tuning-governance-page__approval-checks">
            <Confirmation
              checked={review.privacy}
              onChange={(checked) => props.onReview("privacy", checked)}
              label="我已核对隐私扫描与必要的源头脱敏。"
            />
            <Confirmation
              checked={review.copyright}
              onChange={(checked) => props.onReview("copyright", checked)}
              label="我已核对每条来源的版权或许可依据。"
            />
            <Confirmation
              checked={review.purpose}
              onChange={(checked) => props.onReview("purpose", checked)}
              label="我确认此数据集只用于已说明的本地训练目的。"
            />
            <Button
              loading={props.busy}
              disabled={!canApprove || props.disabled}
              onClick={props.onApprove}
            >
              批准当前清单版本
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface JobCardProps {
  readonly job: FineTuningJobRecord;
  readonly busyKey: string | null;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}

function JobCard({ job, busyKey, onCancel, onRetry }: JobCardProps) {
  const canCancel = ["queued", "running", "failed_retryable"].includes(job.status);
  return (
    <Card>
      <CardHeader>
        <div className="fine-tuning-governance-page__card-heading">
          <div>
            <CardTitle>{shortId(job.id)}</CardTitle>
            <CardDescription>
              {trainingMethodLabel(job.plan.method)} · 尝试 {String(job.attemptCount)}/
              {String(job.maximumAttempts)}
            </CardDescription>
          </div>
          <Badge tone={jobTone(job.status)}>{jobStateLabel(job.status)}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="fine-tuning-governance-page__kv">
          <div>
            <dt>数据集版本</dt>
            <dd>r{String(job.datasetRevision)}</dd>
          </div>
          <div>
            <dt>预留费用</dt>
            <dd>
              {formatMicros(job.reservedCostMicros)} {job.currency}
            </dd>
          </div>
          <div>
            <dt>结算费用</dt>
            <dd>
              {job.settledCostMicros === null
                ? "尚未结算"
                : `${formatMicros(job.settledCostMicros)} ${job.currency}`}
            </dd>
          </div>
          <div>
            <dt>失败代码</dt>
            <dd>{job.failureCode ?? "无"}</dd>
          </div>
        </dl>
      </CardContent>
      {(canCancel || job.status === "failed_retryable") && (
        <CardFooter className="fine-tuning-governance-page__section-actions">
          {canCancel && (
            <Button
              variant="secondary"
              loading={busyKey === `job:cancel:${job.id}`}
              disabled={busyKey !== null}
              onClick={onCancel}
            >
              取消作业
            </Button>
          )}
          {job.status === "failed_retryable" && (
            <Button
              loading={busyKey === `job:retry:${job.id}`}
              disabled={busyKey !== null}
              onClick={onRetry}
            >
              重新排队
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function SourceOption({
  source,
  checked,
  disabled,
  onChange,
}: {
  readonly source: FineTuningSourceDescriptor;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: () => void;
}) {
  return (
    <label className="fine-tuning-governance-page__source" data-disabled={disabled || undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <strong>{source.label}</strong>
        <span>
          {sourceKindLabel(source.kind)} · r{String(source.revision)} ·{" "}
          {formatBytes(source.contentBytes)}
        </span>
        <span title={source.contentHash}>SHA-256 {shortHash(source.contentHash)}</span>
        <span>
          {source.rights === null
            ? "需要本次人工声明版权与训练许可"
            : `${rightsKindLabel(source.rights.kind)} · ${
                source.rights.allowTraining ? "允许训练" : "禁止训练"
              }`}
        </span>
        {source.blocker !== null && (
          <span className="fine-tuning-governance-page__blocker">{source.blocker}</span>
        )}
      </span>
    </label>
  );
}

function SectionHeading({
  id,
  title,
  description,
  actions,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div className="fine-tuning-governance-page__section-heading">
      <div>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
      {actions}
    </div>
  );
}

function SummaryCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Card>
      <CardContent>
        <span>{label}</span>
        <strong>{value}</strong>
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <FormField label={label} required>
      {(field) => (
        <Input
          {...field}
          type="number"
          min={0}
          step={1}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

function Confirmation({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  return (
    <label className="fine-tuning-governance-page__confirmation">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ApprovalAction({
  checked,
  onCheckedChange,
  label,
  buttonLabel,
  variant,
  loading,
  disabled,
  onClick,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly buttonLabel: string;
  readonly variant?: "primary" | "danger";
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <div className="fine-tuning-governance-page__approval-checks">
      <Confirmation checked={checked} onChange={onCheckedChange} label={label} />
      <Button
        {...(variant === undefined ? {} : { variant })}
        loading={loading}
        disabled={!checked || disabled}
        onClick={onClick}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

type Perform = (
  key: string,
  action: () => Promise<Result<unknown, StoryCoreError>>,
  successMessage: string,
) => Promise<void>;

function canSelectSource(source: FineTuningSourceDescriptor): boolean {
  return source.status === "eligible" || source.rightsDeclarationRequired;
}

function parseMetricJson(value: string): FineTuningEvaluationGateInput["baseline"] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("指标结构化数据必须是包含名称字段（name）与数值评分字段（score）的数组。");
  }
  return (parsed as unknown[]).map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.score !== "number") {
      throw new Error("指标结构化数据必须是包含名称字段（name）与数值评分字段（score）的数组。");
    }
    return { name: item.name, score: item.score };
  });
}

function parseRuleJson(value: string): FineTuningEvaluationGateInput["rules"] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      "规则结构化数据必须是包含指标字段（metric）与排序方向字段（direction）的数组。",
    );
  }
  return (parsed as unknown[]).map((item) => {
    if (
      !isRecord(item) ||
      typeof item.metric !== "string" ||
      (item.direction !== "higher_is_better" && item.direction !== "lower_is_better")
    ) {
      throw new Error(
        "规则结构化数据必须是包含指标字段（metric）与排序方向字段（direction）的数组。",
      );
    }
    const optionalKeys = [
      "minimumCandidate",
      "maximumCandidate",
      "minimumImprovement",
      "maximumRegression",
    ] as const;
    if (optionalKeys.some((key) => item[key] !== undefined && typeof item[key] !== "number")) {
      throw new Error("评测门禁阈值必须是数值。");
    }
    return {
      metric: item.metric,
      direction: item.direction,
      ...(typeof item.minimumCandidate === "number"
        ? { minimumCandidate: item.minimumCandidate }
        : {}),
      ...(typeof item.maximumCandidate === "number"
        ? { maximumCandidate: item.maximumCandidate }
        : {}),
      ...(typeof item.minimumImprovement === "number"
        ? { minimumImprovement: item.minimumImprovement }
        : {}),
      ...(typeof item.maximumRegression === "number"
        ? { maximumRegression: item.maximumRegression }
        : {}),
    };
  });
}

function parseInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatMicros(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(value / 1_000_000);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} 字节`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} 千字节`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} 兆字节`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}…${value.slice(-4)}`;
}

function sourceKindLabel(kind: FineTuningSourceDescriptor["kind"]): string {
  return {
    chapter_version: "章节版本",
    material: "故事素材",
    local_import: "本地导入",
  }[kind];
}

function rightsKindLabel(kind: FineTuningRightsKind): string {
  return {
    user_owned: "本人拥有版权",
    licensed_for_training: "已获训练许可",
    public_domain: "公版内容",
    unknown: "权利未知",
  }[kind];
}

function datasetStateLabel(state: FineTuningDatasetSnapshot["state"]): string {
  return {
    draft: "草稿",
    review_required: "待人工审批",
    approved: "已批准",
    archived: "已归档",
  }[state];
}

function trainingMethodLabel(method: FineTuningJobRecord["plan"]["method"]): string {
  return method === "lora" ? "低秩适配（LoRA）" : "量化低秩适配（QLoRA）";
}

function jobStateLabel(state: FineTuningJobRecord["status"]): string {
  return {
    queued: "已排队",
    running: "训练中",
    cancelling: "取消中",
    cancelled: "已取消",
    failed_retryable: "失败，可重试",
    failed_final: "最终失败",
    artifact_ready: "候选已就绪",
  }[state];
}

function artifactStateLabel(state: FineTuningModelArtifactRecord["state"]): string {
  return {
    candidate: "待评测候选",
    evaluation_failed: "评测未通过",
    evaluation_passed: "评测通过",
    registration_approved: "登记已批准",
    registered: "已登记",
    deployment_approved: "部署已批准",
    deployed: "已部署",
    rolled_back: "已回滚",
    revoked: "已撤销",
  }[state];
}

function roleLabel(role: FineTuningDeploymentTargetRole): string {
  return ROLE_OPTIONS.find(({ value }) => value === role)?.label ?? role;
}

function deploymentStatusLabel(state: FineTuningDeploymentRecord["status"]): string {
  return {
    active: "使用中",
    rolled_back: "已回滚",
    revoked: "已撤销",
  }[state];
}

function jobTone(
  state: FineTuningJobRecord["status"],
): "ai" | "success" | "warning" | "danger" | "neutral" {
  if (state === "artifact_ready") return "success";
  if (state === "queued" || state === "running") return "ai";
  if (state === "failed_final") return "danger";
  if (state === "failed_retryable" || state === "cancelling") return "warning";
  return "neutral";
}

function artifactTone(
  state: FineTuningModelArtifactRecord["state"],
): "ai" | "success" | "warning" | "danger" | "neutral" {
  if (state === "candidate") return "ai";
  if (state === "evaluation_failed") return "danger";
  if (
    state === "evaluation_passed" ||
    state === "registration_approved" ||
    state === "deployment_approved"
  ) {
    return "warning";
  }
  if (state === "registered" || state === "deployed") return "success";
  return "neutral";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
