import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  InlineAlert,
} from "@inkshadow/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CloudSyncControlService,
  CloudSyncControlSnapshot,
  CloudSyncControlState,
} from "../infrastructure/cloud-sync-control-service";

import "./cloud-sync-control-panel.css";

export type CloudSyncControlPanelService = Pick<
  CloudSyncControlService,
  "inspectProject" | "pauseProject" | "resumeProject" | "retryProject" | "runProject"
>;

export interface CloudSyncControlPanelProps {
  readonly projectId: string;
  readonly service: CloudSyncControlPanelService;
  readonly onOpenConflicts?: () => void;
  readonly onOpenSecurity?: () => void;
}

type BusyAction = "pause" | "resume" | "retry" | "sync" | null;

const STATE_COPY: Record<
  CloudSyncControlState,
  Readonly<{
    label: string;
    title: string;
    description: string;
    tone: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  }>
> = {
  attention_required: {
    label: "需要检查",
    title: "同步需要你的注意",
    description: "墨影已经停止本次云操作，没有覆盖本机内容。",
    tone: "warning",
  },
  cancelled: {
    label: "已停止",
    title: "本次同步已停止",
    description: "尚未提交的同步工作仍保存在本机队列中。",
    tone: "neutral",
  },
  conflict: {
    label: "存在冲突",
    title: "双方版本需要人工选择",
    description: "冲突解决前不会继续覆盖相关内容，双方版本都被保留。",
    tone: "warning",
  },
  device_revoked: {
    label: "设备已撤销",
    title: "此设备不再具有同步权限",
    description: "后续云端读写已被拒绝；请在安全设置中核对此设备。",
    tone: "danger",
  },
  disabled: {
    label: "未启用",
    title: "此项目未启用云同步",
    description: "项目仍完整保存在本机，你可以照常编辑、备份和导出。",
    tone: "neutral",
  },
  key_error: {
    label: "密钥问题",
    title: "无法打开项目加密密钥",
    description: "同步已安全停止；请前往安全设置恢复项目密钥。",
    tone: "danger",
  },
  offline: {
    label: "离线",
    title: "当前无法连接云端",
    description: "本机修改已排队，恢复网络后可以重试。",
    tone: "warning",
  },
  paused: {
    label: "已暂停",
    title: "云同步已暂停",
    description: "暂停边界已持久保存，恢复前不会读取密钥或推送新内容。",
    tone: "warning",
  },
  pending: {
    label: "等待同步",
    title: "本机队列正在等待处理",
    description: "可以立即同步，也可以继续本机工作。",
    tone: "info",
  },
  quota_exceeded: {
    label: "配额不足",
    title: "云端空间暂时不足",
    description: "本机内容未受影响；处理云端配额后再继续同步。",
    tone: "danger",
  },
  reauth_required: {
    label: "需要登录",
    title: "云会话需要重新验证",
    description: "墨影不会在会话失效时继续云端请求。",
    tone: "warning",
  },
  retry_wait: {
    label: "等待重试",
    title: "同步遇到可恢复问题",
    description: "本机队列仍然安全，可以现在重试或稍后自动继续。",
    tone: "warning",
  },
  synced: {
    label: "已同步",
    title: "加密同步已完成",
    description: "当前已处理的本机队列和远端游标保持一致。",
    tone: "success",
  },
  syncing: {
    label: "同步中",
    title: "正在交换加密数据",
    description: "正文与项目密钥不会作为明文发送到云端。",
    tone: "accent",
  },
  version_incompatible: {
    label: "版本不兼容",
    title: "需要更新墨影后继续",
    description: "协议不兼容时同步会保守停止，不会尝试降级覆盖。",
    tone: "danger",
  },
};

export function CloudSyncControlPanel({
  onOpenConflicts,
  onOpenSecurity,
  projectId,
  service,
}: CloudSyncControlPanelProps) {
  const [snapshot, setSnapshot] = useState<CloudSyncControlSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [failure, setFailure] = useState(false);
  const operation = useRef<AbortController | null>(null);

  const inspect = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailure(false);
    try {
      setSnapshot(await service.inspectProject(projectId));
    } catch {
      setFailure(true);
    } finally {
      setLoading(false);
    }
  }, [projectId, service]);

  useEffect(() => {
    let active = true;
    operation.current?.abort();
    operation.current = null;
    queueMicrotask(() => {
      if (active) {
        void inspect();
      }
    });
    return () => {
      active = false;
      operation.current?.abort();
      operation.current = null;
    };
  }, [inspect]);

  async function runAction(
    action: Exclude<BusyAction, null>,
    execute: (signal: AbortSignal) => Promise<CloudSyncControlSnapshot>,
  ): Promise<void> {
    if (busy !== null) {
      return;
    }
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(action);
    setFailure(false);
    try {
      setSnapshot(await execute(controller.signal));
    } catch {
      if (!controller.signal.aborted) {
        setFailure(true);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
      }
      setBusy(null);
    }
  }

  const copy = snapshot === null ? null : STATE_COPY[snapshot.state];
  return (
    <Card className="cloud-sync-control" aria-labelledby="cloud-sync-control-title">
      <CardHeader className="cloud-sync-control__header">
        <div>
          <CardTitle id="cloud-sync-control-title" headingLevel={2}>
            加密同步
          </CardTitle>
          <CardDescription>云端只接收加密对象；本机编辑能力不依赖同步状态。</CardDescription>
        </div>
        {copy !== null && <Badge tone={copy.tone}>{copy.label}</Badge>}
      </CardHeader>
      <CardContent className="cloud-sync-control__content">
        {loading ? (
          <p role="status">正在读取本机同步状态…</p>
        ) : snapshot === null || copy === null ? (
          <InlineAlert
            tone="error"
            title="无法读取同步状态"
            description="本机项目仍可使用。请重新读取状态后再执行云端操作。"
            action={{ label: "重新读取", onClick: () => void inspect() }}
          />
        ) : (
          <>
            <div className="cloud-sync-control__summary" aria-live="polite">
              <strong>{copy.title}</strong>
              <p>{copy.description}</p>
              {snapshot.lastErrorCode !== null && <small>诊断代码：{snapshot.lastErrorCode}</small>}
            </div>

            {failure && (
              <InlineAlert
                tone="error"
                title="同步操作未完成"
                description="状态没有被报告为成功。本机队列和正文仍然保留，请重新读取后再试。"
                action={{ label: "重新读取", onClick: () => void inspect() }}
              />
            )}

            <InlineAlert
              tone="info"
              title="本机工作始终可用"
              description="无论离线、暂停、冲突、密钥错误或订阅变化，你仍可读取、编辑、备份和导出本机项目。"
            />

            <div className="cloud-sync-control__actions">
              {(snapshot.state === "synced" || snapshot.state === "pending") && (
                <Button
                  loading={busy === "sync"}
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction("sync", (signal) => service.runProject(projectId, signal))
                  }
                >
                  立即同步
                </Button>
              )}
              {snapshot.canRetry && (
                <Button
                  loading={busy === "retry"}
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction("retry", (signal) => service.retryProject(projectId, signal))
                  }
                >
                  立即重试
                </Button>
              )}
              {snapshot.canResume && (
                <Button
                  loading={busy === "resume"}
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction("resume", (signal) => service.resumeProject(projectId, signal))
                  }
                >
                  恢复同步
                </Button>
              )}
              {snapshot.canPause && (
                <Button
                  variant="secondary"
                  loading={busy === "pause"}
                  disabled={busy !== null}
                  onClick={() => void runAction("pause", () => service.pauseProject(projectId))}
                >
                  暂停同步
                </Button>
              )}
              {snapshot.state === "conflict" && onOpenConflicts !== undefined && (
                <Button onClick={onOpenConflicts}>查看并解决冲突</Button>
              )}
              {requiresSecurityAction(snapshot.state) && onOpenSecurity !== undefined && (
                <Button variant="secondary" onClick={onOpenSecurity}>
                  打开安全设置
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function requiresSecurityAction(state: CloudSyncControlState): boolean {
  return (
    state === "device_revoked" ||
    state === "key_error" ||
    state === "quota_exceeded" ||
    state === "reauth_required" ||
    state === "version_incompatible"
  );
}
