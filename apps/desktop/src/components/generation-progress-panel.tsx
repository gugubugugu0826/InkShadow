import { Badge, Button } from "@inkshadow/ui";

export type GenerationProgressStage = "preparing" | "generating" | "finalizing";

export interface GenerationProgressPanelProps {
  readonly actionLabel: "生成开头" | "生成续写建议";
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly reasoningMode: "disabled" | "provider_default";
  readonly minimumVisibleCharacters: number;
  readonly maximumVisibleCharacters: number;
  readonly receivedVisibleCharacters: number;
  readonly stage: GenerationProgressStage;
  readonly preview: string;
  readonly cancelBusy: boolean;
  readonly onStop: () => void;
}

const STAGE_LABELS: Readonly<Record<GenerationProgressStage, string>> = Object.freeze({
  preparing: "正在挑选故事资料并完成发送前检查",
  generating: "正在接收可见正文",
  finalizing: "正在保存隔离的 AI 建议版本",
});

export function GenerationProgressPanel(props: GenerationProgressPanelProps) {
  return (
    <div className="candidate-content" aria-live="polite" aria-label={props.actionLabel + "进度"}>
      <div className="candidate-content__meta">
        <Badge tone="ai">{props.actionLabel === "生成开头" ? "开头生成中" : "续写生成中"}</Badge>
        <span>{props.receivedVisibleCharacters.toLocaleString("zh-CN")} 字符</span>
      </div>
      <dl className="generation-receipt">
        <div>
          <dt>服务与模型</dt>
          <dd>
            {props.providerLabel} · {props.modelLabel}
          </dd>
        </div>
        <div>
          <dt>推理模式</dt>
          <dd>
            {props.reasoningMode === "disabled"
              ? "已关闭，只请求可见正文"
              : "服务默认；不会展示内部推理"}
          </dd>
        </div>
        <div>
          <dt>本次目标</dt>
          <dd>
            {props.minimumVisibleCharacters.toLocaleString("zh-CN")}–
            {props.maximumVisibleCharacters.toLocaleString("zh-CN")} 字
          </dd>
        </div>
        <div>
          <dt>当前阶段</dt>
          <dd>{STAGE_LABELS[props.stage]}</dd>
        </div>
      </dl>
      <pre>{props.preview || "正在准备第一段建议……"}</pre>
      <p className="candidate-panel__hint">
        当前内容尚未写入正式正文；停止后，已收到的可见正文会作为不完整 AI 建议版本保留。
      </p>
      <Button variant="secondary" loading={props.cancelBusy} onClick={props.onStop}>
        停止生成
      </Button>
    </div>
  );
}
