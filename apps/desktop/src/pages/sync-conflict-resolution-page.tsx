import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Input,
  Textarea,
} from "@inkshadow/ui";
import { useCallback, useEffect, useState } from "react";

import type {
  SyncConflictListItem,
  SyncConflictResolutionAction,
  SyncConflictResolutionCoordinator,
  SyncConflictReview,
} from "../infrastructure/sync-conflict-resolution-coordinator";

import "./sync-conflict-resolution-page.css";

export type SyncConflictResolutionPageCoordinator = Pick<
  SyncConflictResolutionCoordinator,
  "listUnresolved" | "loadReview" | "resolve"
>;

export interface SyncConflictResolutionPageProps {
  readonly projectId: string;
  readonly coordinator: SyncConflictResolutionPageCoordinator;
  readonly onResolved?: (conflictId: string) => void;
}

type LoadState = "loading" | "ready" | "error";

const ACTION_LABELS: Record<SyncConflictResolutionAction, string> = {
  accept_local: "保留本机版本",
  accept_remote: "采用远端版本",
  keep_both: "两个版本都保留",
  manual_merge: "手动合并",
};

export function SyncConflictResolutionPage({
  coordinator,
  onResolved,
  projectId,
}: SyncConflictResolutionPageProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [conflicts, setConflicts] = useState<readonly SyncConflictListItem[]>([]);
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(null);
  const [review, setReview] = useState<SyncConflictReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [action, setAction] = useState<SyncConflictResolutionAction | null>(null);
  const [mergedTitle, setMergedTitle] = useState("");
  const [mergedContent, setMergedContent] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadState("loading");
    setFailure(null);
    try {
      const next = await coordinator.listUnresolved(projectId);
      setConflicts(next);
      setSelectedConflictId((current) =>
        current !== null && next.some((item) => item.conflictId === current)
          ? current
          : (next[0]?.conflictId ?? null),
      );
      setLoadState("ready");
    } catch {
      setLoadState("error");
      setFailure("无法读取本机冲突目录。你的本机正文没有被修改，请稍后重试。");
    }
  }, [coordinator, projectId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) {
        return;
      }
      setReview(null);
      setSelectedConflictId(null);
      setConflicts([]);
      setNotice(null);
      void refresh().catch(() => {
        if (active) {
          setLoadState("error");
        }
      });
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) {
        return;
      }
      setReview(null);
      setAction(null);
      setConfirmed(false);
      setFailure(null);
      if (selectedConflictId === null) {
        setReviewLoading(false);
        return;
      }
      setReviewLoading(true);
      void coordinator
        .loadReview(selectedConflictId)
        .then((loaded) => {
          if (!active) {
            return;
          }
          setReview(loaded);
          if (loaded.status === "ready") {
            setMergedTitle(loaded.local.title);
            setMergedContent(loaded.local.content);
          } else {
            setMergedTitle("");
            setMergedContent("");
          }
        })
        .catch(() => {
          if (active) {
            setFailure("无法打开这条冲突。双方版本仍被保留，请重新加载后再试。");
          }
        })
        .finally(() => {
          if (active) {
            setReviewLoading(false);
          }
        });
    });
    return () => {
      active = false;
    };
  }, [coordinator, selectedConflictId]);

  function chooseAction(next: SyncConflictResolutionAction): void {
    setAction(next);
    setConfirmed(false);
    setFailure(null);
    setNotice(null);
  }

  async function resolveSelected(): Promise<void> {
    if (review?.status !== "ready" || action === null || !confirmed || resolving) {
      return;
    }
    setResolving(true);
    setFailure(null);
    setNotice(null);
    try {
      await coordinator.resolve({
        conflictId: review.conflict.conflictId,
        reviewToken: review.reviewToken,
        action,
        confirmed: true,
        ...(action === "manual_merge" ? { mergedTitle, mergedContent } : {}),
      });
      const resolvedConflictId = review.conflict.conflictId;
      setReview(null);
      setSelectedConflictId(null);
      setAction(null);
      setConfirmed(false);
      setNotice("解决方案已保存为新的稳定版本，并已进入加密同步队列。");
      onResolved?.(resolvedConflictId);
      await refresh();
    } catch (error: unknown) {
      setFailure(conflictResolutionFailure(error));
    } finally {
      setResolving(false);
    }
  }

  const manualMergeInvalid =
    action === "manual_merge" &&
    (mergedTitle.trim().length === 0 ||
      mergedTitle.trim().length > 200 ||
      mergedContent.length > 5_000_000 ||
      mergedContent.includes("\u0000"));

  return (
    <section className="sync-conflict-page" aria-labelledby="sync-conflict-page-title">
      <header className="sync-conflict-page__header">
        <div>
          <p className="sync-conflict-page__eyebrow">端到端加密同步</p>
          <h1 id="sync-conflict-page-title">解决内容冲突</h1>
          <p>墨影不会静默覆盖正文。请先比较共同基线、本机版本和远端版本，再明确选择处理方式。</p>
        </div>
        <Badge tone={conflicts.length === 0 ? "success" : "warning"}>
          {conflicts.length === 0 ? "没有待处理冲突" : `${String(conflicts.length)} 条待处理`}
        </Badge>
      </header>

      {failure !== null && (
        <InlineAlert
          tone="error"
          title="冲突操作未完成"
          description={failure}
          {...(loadState === "error"
            ? { action: { label: "重新加载", onClick: () => void refresh() } }
            : {})}
        />
      )}
      {notice !== null && <InlineAlert tone="info" title="冲突已处理" description={notice} />}

      {loadState === "loading" ? (
        <Card>
          <CardContent>
            <p role="status">正在读取本机冲突目录…</p>
          </CardContent>
        </Card>
      ) : loadState === "error" ? null : conflicts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>所有版本都已安全归位</CardTitle>
            <CardDescription>
              当前没有需要人工处理的内容。离线编辑、导出和本机备份始终可用。
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="sync-conflict-page__workspace">
          <nav className="sync-conflict-page__list" aria-label="待处理同步冲突">
            {conflicts.map((item, index) => (
              <button
                key={item.conflictId}
                type="button"
                className="sync-conflict-page__list-item"
                aria-current={selectedConflictId === item.conflictId ? "true" : undefined}
                onClick={() => {
                  setSelectedConflictId(item.conflictId);
                }}
              >
                <span>内容冲突 {index + 1}</span>
                <small>
                  {item.remoteKind === "delete" ? "远端删除" : "双方均有修改"} ·{" "}
                  {formatTime(item.createdAt)}
                </small>
              </button>
            ))}
          </nav>

          <main className="sync-conflict-page__review">
            {reviewLoading ? (
              <p role="status">正在解密并核对版本…</p>
            ) : review === null ? (
              <InlineAlert
                tone="warning"
                title="无法显示版本"
                description="冲突记录仍被保留。请选择其他记录，或重新加载后再试。"
              />
            ) : review.status === "remote_delete" ? (
              <RemoteDeleteReview review={review} />
            ) : review.status === "unsupported" ? (
              <InlineAlert
                tone="warning"
                title="此冲突需要更新后的客户端"
                description="墨影没有改动双方记录，也不会用未知格式覆盖本机内容。你仍可继续本机编辑、备份和导出。"
              />
            ) : (
              <>
                <div className="sync-conflict-page__three-way">
                  <VersionPane
                    heading="共同基线"
                    meta={review.base === null ? "没有可验证的共同基线" : "双方修改前的版本"}
                    content={review.base?.content ?? "—"}
                  />
                  <VersionPane
                    heading="本机版本"
                    meta={`本机 · ${formatTime(review.local.updatedAt)}`}
                    title={review.local.title}
                    content={review.local.content}
                  />
                  <VersionPane
                    heading="远端版本"
                    meta={`${remoteDeviceLabel(review.remote.deviceId)} · ${formatTime(
                      review.remote.updatedAt,
                    )}`}
                    title={review.remote.title}
                    content={review.remote.content}
                  />
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>选择解决方案</CardTitle>
                    <CardDescription>
                      每一种方案都会创建新的稳定版本；“两个版本都保留”还会建立一份独立章节副本。
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="sync-conflict-page__actions">
                    {(Object.keys(ACTION_LABELS) as SyncConflictResolutionAction[]).map(
                      (candidate) => (
                        <Button
                          key={candidate}
                          type="button"
                          variant={action === candidate ? "primary" : "secondary"}
                          aria-pressed={action === candidate}
                          disabled={resolving}
                          onClick={() => {
                            chooseAction(candidate);
                          }}
                        >
                          {ACTION_LABELS[candidate]}
                        </Button>
                      ),
                    )}
                  </CardContent>
                </Card>

                {action === "manual_merge" && (
                  <Card>
                    <CardHeader>
                      <CardTitle>编辑合并后的稳定版本</CardTitle>
                      <CardDescription>
                        这里只编辑新版本；本机和远端原始版本仍保留在冲突证据中，直到提交成功。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="sync-conflict-page__merge-fields">
                      <FormField label="章节标题" required>
                        {(fieldProps) => (
                          <Input
                            {...fieldProps}
                            value={mergedTitle}
                            maxLength={200}
                            disabled={resolving}
                            onChange={(event) => {
                              setMergedTitle(event.currentTarget.value);
                              setConfirmed(false);
                            }}
                          />
                        )}
                      </FormField>
                      <FormField label="合并后的正文" required>
                        {(fieldProps) => (
                          <Textarea
                            {...fieldProps}
                            value={mergedContent}
                            currentLength={mergedContent.length}
                            maxLength={5_000_000}
                            rows={14}
                            disabled={resolving}
                            onChange={(event) => {
                              setMergedContent(event.currentTarget.value);
                              setConfirmed(false);
                            }}
                          />
                        )}
                      </FormField>
                    </CardContent>
                  </Card>
                )}

                {action !== null && (
                  <div className="sync-conflict-page__confirmation">
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={resolving}
                        onChange={(event) => {
                          setConfirmed(event.currentTarget.checked);
                        }}
                      />
                      我已检查三个版本，确认执行“{ACTION_LABELS[action]}”
                    </label>
                    <Button
                      type="button"
                      loading={resolving}
                      disabled={!confirmed || manualMergeInvalid}
                      onClick={() => void resolveSelected()}
                    >
                      确认并创建稳定版本
                    </Button>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function VersionPane({
  content,
  heading,
  meta,
  title,
}: Readonly<{
  content: string;
  heading: string;
  meta: string;
  title?: string;
}>) {
  return (
    <section className="sync-conflict-page__version-pane" aria-label={heading}>
      <header>
        <h2>{heading}</h2>
        <small>{meta}</small>
      </header>
      {title !== undefined && <strong>{title}</strong>}
      <pre>{content}</pre>
    </section>
  );
}

function RemoteDeleteReview({
  review,
}: Readonly<{
  review: Extract<SyncConflictReview, { status: "remote_delete" }>;
}>) {
  return (
    <div className="sync-conflict-page__blocked-review">
      <InlineAlert
        tone="warning"
        title="远端删除与本机修改发生冲突"
        description="删除墓碑不会自动覆盖本机正文。这类冲突必须通过独立的删除审查流程处理；当前记录保持未解决状态。"
      />
      {review.local !== null && (
        <VersionPane
          heading="受保护的本机版本"
          meta={`本机 · ${formatTime(review.local.updatedAt)}`}
          title={review.local.title}
          content={review.local.content}
        />
      )}
      <p>你可以继续本机编辑、备份或导出；云端状态不会阻断这些操作。</p>
    </div>
  );
}

function remoteDeviceLabel(deviceId: string | null): string {
  return deviceId === null ? "远端设备" : `远端设备 ${deviceId.slice(0, 8)}`;
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return "时间未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function conflictResolutionFailure(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  if (code === "SYNC_CONFLICT_REVIEW_STALE") {
    return "冲突在你审查期间发生了变化。没有内容被覆盖，请重新加载并再次比较。";
  }
  if (code === "SYNC_CONFLICT_MERGED_CONTENT_INVALID") {
    return "合并后的标题或正文不符合保存限制，请检查后重试。";
  }
  return "解决方案未提交，双方版本仍被保留。请重新加载后再试。";
}
