import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Textarea,
} from "@inkshadow/ui";

import type {
  ModelHubImageGenerationInspection,
  ModelHubImageGenerationReceipt,
  ModelHubImageGenerationService,
} from "../infrastructure/model-hub-image-generation-service";

export interface ModelHubImageGenerationPanelProps {
  readonly service: Pick<
    ModelHubImageGenerationService,
    "inspect" | "chooseDestination" | "generate"
  >;
  readonly disabled?: boolean;
}

export function ModelHubImageGenerationPanel({
  service,
  disabled = false,
}: ModelHubImageGenerationPanelProps) {
  const [inspection, setInspection] = useState<ModelHubImageGenerationInspection | null>(null);
  const [prompt, setPrompt] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ModelHubImageGenerationReceipt | null>(null);

  const inspect = useCallback(async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      const nextInspection = await service.inspect();
      setInspection(nextInspection);
      setAcknowledged(false);
    } catch (cause: unknown) {
      setInspection(null);
      setError(messageFrom(cause, "还没有找到可安全使用的图片模型。"));
    } finally {
      setChecking(false);
    }
  }, [service]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void inspect();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [inspect]);

  async function generate(): Promise<void> {
    if (inspection === null || !acknowledged || prompt.trim() === "") {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setReceipt(null);
    try {
      const destination = await service.chooseDestination();
      if (destination === null) {
        setNotice("已取消保存，没有向模型发送图片请求，也不会产生本次生成费用。");
        return;
      }
      const generated = await service.generate({
        prompt,
        destination,
        acknowledgedCostAndPrivacy: true,
        expectedConfirmationFingerprint: inspection.confirmationFingerprint,
      });
      setReceipt(generated);
      setNotice(
        `图片已保存为 ${generated.file.fileName}。它不会自动插入正文，也不会覆盖已有图片。`,
      );
    } catch (cause: unknown) {
      const message = messageFrom(cause, "图片生成未完成，未改变正文和已有图片。");
      setAcknowledged(false);
      if (errorCodeFrom(cause) === "MODEL_HUB_IMAGE_CONFIRMATION_STALE") {
        await inspect();
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle>生成小说配图</CardTitle>
            <p>用经过能力确认的模型生成一张 PNG，并保存到你亲自选择的位置。</p>
          </div>
          <Badge tone="info">不会写入正文</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {checking && (
          <InlineAlert
            tone="info"
            title="正在检查图片模型"
            description="只读取本机 Model Hub 配置，不会发送小说内容。"
          />
        )}

        {!checking && inspection === null && (
          <InlineAlert
            tone="warning"
            title="图片生成暂不可用"
            description={`${error ?? "没有可用图片模型。"} 请在设置的 AI 分工中，为“图片生成”选择一个已确认支持该能力的模型。`}
            action={{ label: "重新检查", onClick: () => void inspect() }}
          />
        )}

        {inspection !== null && (
          <>
            <InlineAlert
              tone="warning"
              title="生成前请确认费用与隐私"
              description={`${inspection.connectionDisplayName} · ${inspection.modelId}；${destinationLabel(inspection.dataDestination)}。Model Hub 当前没有可审计的逐张图片价格，供应商可能收费，请以供应商价格页为准。`}
            />

            <FormField
              label="你想生成什么画面？"
              hint="只发送这里的描述，不会自动附带章节正文、人物卡或世界设定。"
              required
            >
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  value={prompt}
                  maxLength={inspection.maximumPromptCharacters}
                  currentLength={prompt.length}
                  rows={5}
                  disabled={disabled || busy}
                  placeholder="例如：雨夜的旧书店门口，两位年轻人隔着暖黄色灯光重逢，克制的青春小说插画"
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                />
              )}
            </FormField>

            <Button
              variant={acknowledged ? "secondary" : "ghost"}
              aria-pressed={acknowledged}
              disabled={disabled || busy}
              onClick={() => setAcknowledged((current) => !current)}
            >
              {acknowledged ? "已确认费用与数据去向" : "确认提示会发送给模型并可能产生费用"}
            </Button>

            <Button
              variant="ai-primary"
              loading={busy}
              loadingLabel="正在生成并保存"
              disabled={disabled || checking || !acknowledged || prompt.trim() === ""}
              onClick={() => void generate()}
            >
              选择保存位置并生成
            </Button>
          </>
        )}

        {error !== null && inspection !== null && (
          <InlineAlert
            tone="error"
            title="图片生成未完成"
            description={`${error} 如果供应商已开始处理，请先查看其用量记录再重试，以免重复费用。`}
            onDismiss={() => setError(null)}
          />
        )}
        {notice !== null && (
          <InlineAlert
            tone="info"
            title={receipt === null ? "没有发起生成" : "图片已安全保存"}
            description={notice}
            onDismiss={() => setNotice(null)}
          />
        )}
        {receipt !== null && (
          <p>
            实际调用：{receipt.providerKind} / {receipt.modelId}；文件大小{" "}
            {formatBytes(receipt.file.bytesWritten)}。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function destinationLabel(value: "local" | "remote"): string {
  return value === "local" ? "提示仅在本机模型处理" : "图片描述会发送到远程供应商";
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${String(value)} B`;
  }
  if (value < 1_024 * 1_024) {
    return `${(value / 1_024).toFixed(1)} KB`;
  }
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;
}

function errorCodeFrom(cause: unknown): string | null {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : null;
}
