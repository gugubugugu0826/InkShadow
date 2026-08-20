import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  InlineAlert,
} from "@inkshadow/ui";

import type {
  NovelSkillProjectMethodView,
  NovelSkillProjectState,
  NovelSkillRuntimePort,
} from "../infrastructure/novel-skill-runtime";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

export interface NovelSkillPanelProps {
  readonly projectId: string;
  readonly runtime: NovelSkillRuntimePort;
  readonly readonly?: boolean;
}

export function NovelSkillPanel({ projectId, runtime, readonly = false }: NovelSkillPanelProps) {
  const [state, setState] = useState<NovelSkillProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationRevision = useRef(0);

  const load = useCallback(async () => {
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    setLoading(true);
    try {
      const next = await runtime.listProjectState(projectId);
      if (operationRevision.current === revision) {
        setState(next);
        setError(null);
      }
    } catch (cause: unknown) {
      if (operationRevision.current === revision) {
        setError(projectOrdinaryUiError(cause).description);
      }
    } finally {
      if (operationRevision.current === revision) setLoading(false);
    }
  }, [projectId, runtime]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setBusySkillId(null);
        void load();
      }
    });
    return () => {
      active = false;
      operationRevision.current += 1;
    };
  }, [load]);

  async function toggle(method: NovelSkillProjectMethodView): Promise<void> {
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    setBusySkillId(method.skillId);
    try {
      const next = await runtime.setMethodEnabled(projectId, method.skillId, !method.enabled);
      if (operationRevision.current === revision) {
        setState(next);
        setError(null);
      }
    } catch (cause: unknown) {
      if (operationRevision.current === revision) {
        setError(projectOrdinaryUiError(cause).description);
      }
    } finally {
      if (operationRevision.current === revision) setBusySkillId(null);
    }
  }

  return (
    <section aria-labelledby="novel-skill-panel-title" className="settings-section">
      <div className="section-heading">
        <div>
          <h2 id="novel-skill-panel-title">写作方法（实验）</h2>
          <p>按作品开启可版本追溯的写作方法；关闭后只影响之后的新生成。</p>
        </div>
        {state?.availability.status === "ready" && (
          <Badge tone={state.methods.some(({ enabled }) => enabled) ? "warning" : "neutral"}>
            {state.methods.filter(({ enabled }) => enabled).length} 项已开启
          </Badge>
        )}
      </div>

      <InlineAlert
        tone="warning"
        title="尚未完成真实双模型对照评测"
        description="这些方法目前只提供作者主动开启的实验体验，默认全部关闭。开启后，每次实际采用的名称和版本会进入本地参考记录；你可以随时关闭。"
      />

      {error !== null && (
        <InlineAlert
          tone="error"
          title="写作方法设置未完成"
          description={error}
          action={{ label: "重新读取", onClick: () => void load() }}
          onDismiss={() => setError(null)}
        />
      )}

      {loading && state === null ? (
        <p role="status">正在读取写作方法…</p>
      ) : state?.availability.status !== "ready" ? (
        <InlineAlert
          tone="info"
          title="本环境未应用写作方法"
          description={
            state?.availability.reason ??
            "写作方法当前不可用；基础写作、正文保存和已有版本不受影响。"
          }
        />
      ) : state.methods.length === 0 ? (
        <EmptyState
          title="还没有可用的写作方法"
          description="内置方法没有完成初始化。基础写作仍可使用，请重新打开桌面版后再试。"
        />
      ) : (
        <div className="story-governance-grid">
          {state.methods.map((method) => (
            <Card key={method.skillId}>
              <CardHeader>
                <div className="card-heading-row">
                  <CardTitle>{method.displayName}</CardTitle>
                  <Badge tone={method.enabled ? "warning" : "neutral"}>
                    {method.enabled ? "实验中" : "未开启"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>{method.summary}</p>
                <p className="candidate-panel__hint">
                  {method.kind === "genre" ? "题材方法" : "通用方法"} · 版本 {method.version} ·{" "}
                  {method.appliesToContinuation ? "可用于续写" : "不用于续写"}
                </p>
                <Button
                  size="sm"
                  variant={method.enabled ? "secondary" : "primary"}
                  loading={busySkillId === method.skillId}
                  disabled={readonly || busySkillId !== null}
                  onClick={() => void toggle(method)}
                >
                  {method.enabled ? `关闭${method.displayName}` : `实验性开启${method.displayName}`}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
