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
            description: "启用实验功能前不会读写治理记录、启动训练或发送内容。",
          }
        : {
            title: "需要桌面原生持久化",
            description: "浏览器开发模式不会伪造训练或治理记录。",
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
      "数据集已绑定当前来源版本；正文仍仅保存在本机。",
    );
  }

  return (
    <div className="desktop-page fine-tuning-governance-page">
      <header className="page-heading">
        <div>
          <p className="fine-tuning-governance-page__eyebrow">实验性 · 本地优先</p>
          <h1>微调治理（实验）</h1>
          <p>先核对来源和许可，再审批、训练、评测并人工启用。</p>
        </div>
        <div className="fine-tuning-governance-page__header-actions">
          <Badge tone="success">桌面本地数据库</Badge>
          <Badge tone={trainerAvailable ? "ai" : "warning"}>
            {trainerAvailable ? "本地训练工具已连接" : "未配置本地训练工具"}
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
        title="训练结果始终先等待确认"
        description="训练结果须通过对照评测，并经人工批准后才能启用。"
      />
      {!trainerAvailable && (
        <InlineAlert
          tone="warning"
          title="仅治理模式"
          description="仍可管理来源、数据集和上限；训练与启用保持关闭。"
        />
      )}
      <InlineAlert
        tone="info"
        title="远端训练固定关闭"
        description="不会上传训练正文或使用云端凭据。"
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
        <SummaryCard label="待确认模型" value={String(dashboard?.artifacts.length ?? 0)} />
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
          description="未取得可靠记录，请恢复本地数据库后重试。"
          primaryAction={{ label: "重试", onClick: () => void load() }}
        />
      ) : (
        <>
          <section className="fine-tuning-governance-page__section" aria-labelledby="sources-title">
            <SectionHeading
              id="sources-title"
              title="1. 冻结本地训练来源"
              description="只显示来源记录；本页不能修改许可。"
            />
            <div className="fine-tuning-governance-page__two-column">
              <Card>
                <CardHeader>
                  <CardTitle>可选来源</CardTitle>
                  <CardDescription>选择时会锁定当前版本、内容大小和校验记录。</CardDescription>
                </CardHeader>
                <CardContent>
                  {dashboard?.sources.length === 0 ? (
                    <EmptyState
                      title="没有可用来源"
                      description="先创建稳定版本或有训练许可的素材。"
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
                        hint="说明授权依据；不要粘贴密钥或私密正文。"
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
                        label="我确认许可适用于当前来源版本。"
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
              description="审批会锁定隐私、版权、用途、清单和版本。"
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
                          "数据集已由人工审批并绑定当前清单内容与版本。",
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
              description="训练仅调用本机工具；状态和费用都会保存。"
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
                          "中断的训练任务已按保存状态恢复。",
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
                        "本地队列已执行；空队列不会新增记录。",
                      )
                    }
                  >
                    执行下一个本地作业
                  </Button>
                </div>
              }
            />
            {dashboard?.jobs.length === 0 ? (
              <EmptyState title="队列为空" description="通过开始前检查后，训练计划才会进入此处。" />
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
                        "取消请求已保存；迟到结果不会越过当前状态。",
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
                        "这次失败已重新排队，并重新预留受限用量。",
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
              description="评测须来自本机工具；页面不会生成分数。"
            />
            {dashboard?.artifacts.length === 0 ? (
              <EmptyState
                title="还没有待确认模型"
                description="本机训练返回可核对结果后才会显示。"
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
              description="只显示治理摘要和时间；精确值见高级诊断。"
            />
            {dashboard?.audit.length === 0 ? (
              <EmptyState title="暂无操作记录" description="治理操作完成后会在此留下记录。" />
            ) : (
              <ol className="fine-tuning-governance-page__audit-list">
                {dashboard?.audit.map((event) => (
                  <li key={event.id}>
                    <strong>治理记录已更新</strong>
                    <div>
                      <span>{formatTimestamp(event.createdAt)}</span>
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
        title="3. 用量限制与本地训练检查"
        description="费用均为内部上限或本机估算，不代表服务方账单。"
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
              label="单次训练费用上限（内部计价）"
              value={maximumSingleJobCostMicros}
              onChange={setMaximumSingleJobCostMicros}
            />
            <NumberField
              label="月度费用上限（内部计价）"
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
            <CardDescription>仅可使用已批准数据集和已确认许可。</CardDescription>
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
                    label: `${dataset.name} · 第 ${String(dataset.revision)} 版`,
                  }))}
                  onChange={(event) => setDatasetId(event.currentTarget.value)}
                />
              )}
            </FormField>
            <details className="fine-tuning-governance-page__wide-field">
              <summary>高级模型与许可证设置</summary>
              <div className="fine-tuning-governance-page__form-grid">
                <TextValueField
                  label="模型服务内部标识"
                  value={providerId}
                  onChange={setProviderId}
                />
                <TextValueField label="基础模型内部标识" value={modelId} onChange={setModelId} />
                <TextValueField
                  label="基础模型版本原始值"
                  value={modelRevision}
                  onChange={setModelRevision}
                />
                <TextValueField label="许可证内部标识" value={licenseId} onChange={setLicenseId} />
                <TextValueField
                  label="许可证版本原始值"
                  value={licenseVersion}
                  onChange={setLicenseVersion}
                />
                <div className="fine-tuning-governance-page__wide-field">
                  <Confirmation
                    checked={licenseConfirmed}
                    onChange={setLicenseConfirmed}
                    label="我确认许可证允许微调和商业使用，并已记录再分发权限。"
                  />
                </div>
              </div>
            </details>
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
                  "训练计划已通过本地检查并进入队列。",
                )
              }
            >
              检查并加入本地队列
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
      "评测已记录并绑定当前训练结果。",
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
            <CardTitle>{artifact.registrationName ?? "待确认模型"}</CardTitle>
            <CardDescription>基于已确认的本地基础模型</CardDescription>
          </div>
          <Badge tone={artifactTone(artifact.state)}>{artifactStateLabel(artifact.state)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="fine-tuning-governance-page__form-stack">
        <KeyValues
          items={[
            ["结果版本", `第 ${String(artifact.revision)} 版`],
            ["产物校验", "内容已校验"],
            ["评测记录", artifact.latestEvaluationId === null ? "尚未记录" : "已记录"],
          ]}
        />

        {evaluating && (
          <div className="fine-tuning-governance-page__evaluation">
            <InlineAlert
              tone="warning"
              title="只接受真实评测输出"
              description="导入真实的对照结果、本次结果和通过条件；页面不会生成分数。"
            />
            <details className="fine-tuning-governance-page__diagnostics">
              <summary>高级诊断与评测数据导入</summary>
              <div className="fine-tuning-governance-page__form-grid">
                <TextValueField
                  label="评测工具内部标识"
                  value={evaluatorId}
                  onChange={setEvaluatorId}
                />
                <TextValueField
                  label="评测工具版本原始值"
                  value={evaluatorVersion}
                  onChange={setEvaluatorVersion}
                />
                <TextValueField
                  label="对照模型内部标识"
                  value={baselineModelId}
                  onChange={setBaselineModelId}
                />
              </div>
              <StructuredValueField
                label="对照模型评测数据"
                hint={'格式：[{"name":"quality","score":0.72}]'}
                rows={3}
                value={baselineJson}
                onChange={setBaselineJson}
              />
              <StructuredValueField
                label="本次训练结果评测数据"
                hint={'格式：[{"name":"quality","score":0.79}]'}
                rows={3}
                value={candidateJson}
                onChange={setCandidateJson}
              />
              <StructuredValueField
                label="评测通过条件"
                hint={
                  '[{"metric":"quality","direction":"higher_is_better","minimumImprovement":0.03}]'
                }
                rows={4}
                value={rulesJson}
                onChange={setRulesJson}
              />
              <Button
                loading={props.busyKey === `artifact:evaluate:${artifact.id}`}
                disabled={!canEvaluate || props.busyKey !== null}
                onClick={recordEvaluation}
              >
                重新计算并记录评测
              </Button>
            </details>
          </div>
        )}

        {artifact.state === "evaluation_passed" && (
          <ApprovalAction
            checked={registrationConfirmed}
            onCheckedChange={setRegistrationConfirmed}
            label="我已核对评测、许可与来源，同意登记。"
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
                "登记已批准并绑定当前结果。",
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
                  "训练结果已登记到本地模型库。",
                )
              }
            >
              登记到本地模型库
            </Button>
          </div>
        )}

        {artifact.state === "registered" && (
          <div className="fine-tuning-governance-page__form-stack">
            <FormField label="部署目标角色" required hint="批准后不能更换用途。">
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
              label={`我确认此模型用于“${roleLabel(deploymentRole)}”。`}
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
                  "启用批准已绑定当前模型和用途。",
                )
              }
            />
          </div>
        )}

        {artifact.state === "deployment_approved" && (
          <div className="fine-tuning-governance-page__form-stack">
            <InlineAlert
              tone="warning"
              title="用途必须一致"
              description="请重新选择获批用途；不匹配时会拒绝启用。"
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
                  "模型已按批准用途在本机启用。",
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
              label="我确认撤销并保留审计记录。"
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
                  "模型已撤销并留存审计。",
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
            <CardDescription>已登记模型</CardDescription>
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
            label="我确认回滚；此用途将停止使用模型。"
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
                "本机启用已回滚并留存审计。",
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
        <KeyValues
          items={[
            ["清单版本", `第 ${String(dataset.revision)} 版`],
            ["清单校验", "内容已校验"],
            [
              "训练 / 验证 / 测试",
              `${String(dataset.splitCounts.train)} / ${String(dataset.splitCounts.validation)} / ${String(dataset.splitCounts.test)}`,
            ],
          ]}
        />

        {dataset.readinessIssues.length > 0 && (
          <ul className="fine-tuning-governance-page__issue-list">
            {dataset.readinessIssues.map((issue, index) => (
              <li key={`${issue.code}:${issue.sampleId ?? String(index)}`}>
                {datasetReadinessIssueLabel(issue)}
              </li>
            ))}
          </ul>
        )}
        {dataset.state === "review_required" && dataset.readinessIssues.length === 0 && (
          <div className="fine-tuning-governance-page__approval-checks">
            <Confirmation
              checked={review.privacy}
              onChange={(checked) => props.onReview("privacy", checked)}
              label="我已核对隐私扫描和必要脱敏。"
            />
            <Confirmation
              checked={review.copyright}
              onChange={(checked) => props.onReview("copyright", checked)}
              label="我已核对每条来源的许可。"
            />
            <Confirmation
              checked={review.purpose}
              onChange={(checked) => props.onReview("purpose", checked)}
              label="我确认数据集只用于上述本地训练。"
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
            <CardTitle>本地训练任务</CardTitle>
            <CardDescription>
              {trainingMethodLabel(job.plan.method)} · 已尝试 {String(job.attemptCount)} 次，最多{" "}
              {String(job.maximumAttempts)} 次
            </CardDescription>
          </div>
          <Badge tone={jobTone(job.status)}>{jobStateLabel(job.status)}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <KeyValues
          items={[
            ["数据集版本", `第 ${String(job.datasetRevision)} 版`],
            [
              "预计费用上限",
              `${formatMicros(job.reservedCostMicros)} ${currencyLabel(job.currency)}`,
            ],
            [
              "结算费用",
              job.settledCostMicros === null
                ? "尚未结算"
                : `${formatMicros(job.settledCostMicros)} ${currencyLabel(job.currency)}`,
            ],
            [
              "任务情况",
              job.failureCode === null ? "未发现失败" : "训练未完成，请按当前状态处理。",
            ],
          ]}
        />
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
          {sourceKindLabel(source.kind)} · 第 {String(source.revision)} 版 ·{" "}
          {formatBytes(source.contentBytes)}
        </span>
        <span>来源内容已校验</span>
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

function KeyValues({ items }: { readonly items: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <dl className="fine-tuning-governance-page__kv">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TextValueField({
  label,
  onChange,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <FormField label={label} required>
      {(field) => (
        <Input {...field} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      )}
    </FormField>
  );
}

function StructuredValueField({
  hint,
  label,
  onChange,
  rows,
  value,
}: {
  readonly hint: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly rows: number;
  readonly value: string;
}) {
  return (
    <FormField label={label} required hint={hint}>
      {(field) => (
        <Textarea
          {...field}
          rows={rows}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
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
    throw new Error("评测数据格式不正确。");
  }
  return (parsed as unknown[]).map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.score !== "number") {
      throw new Error("评测数据格式不正确。");
    }
    return { name: item.name, score: item.score };
  });
}

function parseRuleJson(value: string): FineTuningEvaluationGateInput["rules"] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("通过条件格式不正确。");
  }
  return (parsed as unknown[]).map((item) => {
    if (
      !isRecord(item) ||
      typeof item.metric !== "string" ||
      (item.direction !== "higher_is_better" && item.direction !== "lower_is_better")
    ) {
      throw new Error("通过条件格式不正确。");
    }
    const optionalKeys = [
      "minimumCandidate",
      "maximumCandidate",
      "minimumImprovement",
      "maximumRegression",
    ] as const;
    if (optionalKeys.some((key) => item[key] !== undefined && typeof item[key] !== "number")) {
      throw new Error("评测阈值必须是数值。");
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

function currencyLabel(currency: string): string {
  return currency === "CNY" ? "人民币" : currency === "USD" ? "美元" : "其他费用单位";
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

function datasetReadinessIssueLabel(
  issue: FineTuningDatasetSnapshot["readinessIssues"][number],
): string {
  switch (issue.code) {
    case "FINE_TUNING_SAMPLE_COUNT_TOO_LOW":
      return "至少需要三条不同样本。";
    case "FINE_TUNING_RIGHTS_UNCONFIRMED":
      return "尚未确认样本许可。";
    case "FINE_TUNING_TRAINING_NOT_ALLOWED":
      return "来源未授权训练。";
    case "FINE_TUNING_PRIVACY_BLOCKED":
      return "请先移除个人或敏感信息。";
    case "FINE_TUNING_SPLIT_INCOMPLETE":
      return "训练、验证和测试集均须有不同样本。";
    default:
      return "数据集尚未准备好。";
  }
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
  return method === "lora" ? "低秩适配" : "量化低秩适配";
}

function jobStateLabel(state: FineTuningJobRecord["status"]): string {
  return {
    queued: "已排队",
    running: "训练中",
    cancelling: "取消中",
    cancelled: "已取消",
    failed_retryable: "失败，可重试",
    failed_final: "最终失败",
    artifact_ready: "训练结果待确认",
  }[state];
}

function artifactStateLabel(state: FineTuningModelArtifactRecord["state"]): string {
  return {
    candidate: "待评测模型",
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
