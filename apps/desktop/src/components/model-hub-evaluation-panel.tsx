import { useState } from "react";
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

import {
  MODEL_HUB_TEXT_TASKS,
  type ModelHubTextTask,
} from "../infrastructure/model-hub-execution-service";
import type {
  ModelHubLocalEvaluationDisclosure,
  ModelHubLocalEvaluationReceipt,
  ModelHubLocalEvaluationService,
} from "../infrastructure/model-hub-local-evaluation-service";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

export interface ModelHubEvaluationPanelProps {
  readonly service: Pick<ModelHubLocalEvaluationService, "prepare" | "evaluate">;
  readonly disabled?: boolean;
}

export function ModelHubEvaluationPanel({
  service,
  disabled = false,
}: ModelHubEvaluationPanelProps) {
  const [task, setTask] = useState<ModelHubTextTask>("continuation");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ModelHubLocalEvaluationReceipt | null>(null);
  const [disclosure, setDisclosure] = useState<ModelHubLocalEvaluationDisclosure | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function prepare(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setDisclosure(await service.prepare(task));
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusy(false);
    }
  }

  async function run(): Promise<void> {
    if (disclosure === null) return;
    setBusy(true);
    setError(null);
    try {
      setReceipt(
        await service.evaluate({
          task,
          disclosureFingerprint: disclosure.fingerprint,
          humanConfirmed: true,
        }),
      );
      setDisclosure(null);
    } catch (cause: unknown) {
      setDisclosure(null);
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle>模型基础评测</CardTitle>
            <p>验证当前任务分工能否遵守短指令和结构要求，并记录实际延迟。</p>
          </div>
          <Badge tone="info">不含作品内容</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <InlineAlert
          tone="info"
          title="这不是文学质量评分"
          description="评测只发送两条固定测试文字，可能产生少量供应商费用。结果会用于任务分工参考，不会保存模型回复，也不会读取小说正文。"
        />
        <FormField label="要检查的小说任务" required>
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={task}
              disabled={disabled || busy}
              options={MODEL_HUB_TEXT_TASKS.map((value) => ({
                value,
                label: taskLabel(value),
              }))}
              onChange={(event) => {
                setTask(event.currentTarget.value as ModelHubTextTask);
                setDisclosure(null);
              }}
            />
          )}
        </FormField>
        {disclosure === null ? (
          <Button loading={busy} disabled={disabled} onClick={() => void prepare()}>
            查看两项测试的发送前说明
          </Button>
        ) : (
          <section aria-label="两项基础测试发送确认">
            <InlineAlert
              tone="warning"
              title="确认后会固定调用 2 次"
              description={`${disclosure.connectionDisplayName} · ${disclosure.modelId}；${disclosure.privacy} 发送内容：${disclosure.sends.join("；")}。自动重试 0 次；${formatDisclosedCost(disclosure)}。`}
            />
            <div className="button-row">
              <Button loading={busy} disabled={disabled} onClick={() => void run()}>
                确认并运行 2 次固定测试
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setDisclosure(null)}>
                取消，不发送
              </Button>
            </div>
          </section>
        )}
        {error !== null && (
          <InlineAlert
            tone="error"
            title="模型基础评测未完成"
            description={`${error} 没有写入不完整的评测结果。`}
            onDismiss={() => setError(null)}
          />
        )}
        {receipt !== null && (
          <InlineAlert
            tone={receipt.exactInstructionPassCount === receipt.sampleCount ? "info" : "warning"}
            title="基础评测已完成"
            description={`${receipt.modelId}：${String(receipt.exactInstructionPassCount)}/${String(receipt.sampleCount)} 项严格遵循；基础遵循分 ${formatScore(receipt.result.scoreBasisPoints)}，中位延迟 ${String(receipt.result.latencyP50Ms)} ms。该结果不代表文笔、剧情或一致性质量。`}
          />
        )}
      </CardContent>
    </Card>
  );
}

function formatScore(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(0)}%`;
}

function formatDisclosedCost(disclosure: ModelHubLocalEvaluationDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "当前无法核定费用上限，供应商仍可能收费";
  }
  return `两次合计费用上限 ${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}`;
}

function taskLabel(task: ModelHubTextTask): string {
  const labels: Readonly<Record<ModelHubTextTask, string>> = {
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
    pov_check: "视角边界检查",
    character_voice_check: "人物说话一致性",
    content_quality_check: "内容质量复核",
    what_if_simulation: "剧情试演",
    translation: "翻译",
  };
  return labels[task];
}
