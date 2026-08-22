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
  Input,
  Select,
  Textarea,
} from "@inkshadow/ui";
import type { CloudReviewThread, CloudReviewThreadItem } from "@inkshadow/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  StudioReviewCoordinatorError,
  type AcceptStudioReviewSuggestionOutcome,
  type AppendStudioReviewThreadItemInput,
  type DecryptedStudioReview,
  type StudioReviewCoordinator,
  type StudioReviewSuggestionPartialRetry,
  type StudioReviewThreadView,
} from "../infrastructure/studio-review-coordinator";
import {
  StudioReviewCryptoError,
  type StudioReviewTextAnchor,
} from "../infrastructure/studio-review-crypto";
import {
  StudioReviewServiceError,
  type StudioReviewSessionContext,
} from "../infrastructure/studio-review-service";

export type StudioReviewPageCoordinator = Pick<
  StudioReviewCoordinator,
  | "acceptSuggestion"
  | "appendThreadItem"
  | "capabilities"
  | "decideReview"
  | "listReviews"
  | "listThreads"
  | "readReview"
  | "readThread"
  | "rejectSuggestion"
  | "resolveThread"
  | "retryAcceptedSuggestionDecision"
  | "submitReview"
>;

export interface StudioReviewPageProps {
  readonly coordinator: StudioReviewPageCoordinator;
  readonly context: StudioReviewSessionContext;
  readonly online: boolean;
  /**
   * Verified editor selection supplied by the future Studio route adapter.
   * This page never derives a selected-text hash from unsaved plaintext.
   */
  readonly selection?: StudioReviewTextAnchor | null;
}

type ReviewPageState =
  | "loading"
  | "empty"
  | "ready"
  | "offline"
  | "key_missing"
  | "permission_denied"
  | "corrupt_ciphertext"
  | "revision_conflict"
  | "partial_retry"
  | "error";

interface PageFailure {
  readonly code: string;
  readonly message: string;
}

const THREAD_ITEM_LABELS = {
  comment: "批注",
  suggestion: "建议",
  question: "问题",
  rewrite_request: "重写请求",
} as const;

export function StudioReviewPage({
  coordinator,
  context,
  online,
  selection = null,
}: StudioReviewPageProps) {
  const capabilities = useMemo(() => coordinator.capabilities(context), [context, coordinator]);
  const [state, setState] = useState<ReviewPageState>("loading");
  const [reviews, setReviews] = useState<readonly DecryptedStudioReview[]>([]);
  const [selected, setSelected] = useState<DecryptedStudioReview | null>(null);
  const [thread, setThread] = useState<StudioReviewThreadView | null>(null);
  const [threads, setThreads] = useState<readonly CloudReviewThread[]>([]);
  const [reviewCursor, setReviewCursor] = useState<string | null>(null);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<CloudReviewThreadItem | null>(null);
  const [failure, setFailure] = useState<PageFailure | null>(null);
  const [partial, setPartial] = useState<StudioReviewSuggestionPartialRetry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const operationAbort = useRef<AbortController | null>(null);
  const seenReviewCursors = useRef(new Set<string>());
  const seenThreadCursors = useRef(new Set<string>());
  const seenItemCursors = useRef(new Set<string>());

  const load = useCallback(async () => {
    operationAbort.current?.abort();
    if (!online) {
      setState("offline");
      setFailure(null);
      return;
    }
    if (!capabilities.read) {
      setState("permission_denied");
      setFailure({
        code: "REVIEW_PERMISSION_DENIED",
        message: "当前成员角色或项目分配不允许读取团队审阅。",
      });
      return;
    }
    const abort = new AbortController();
    operationAbort.current = abort;
    setState("loading");
    setFailure(null);
    setReviews([]);
    setSelected(null);
    setThread(null);
    setThreads([]);
    setReviewCursor(null);
    setThreadCursor(null);
    setReplyTarget(null);
    seenReviewCursors.current.clear();
    seenThreadCursors.current.clear();
    seenItemCursors.current.clear();
    try {
      const listed = await coordinator.listReviews(context, { limit: 50, signal: abort.signal });
      if (abort.signal.aborted) {
        return;
      }
      if (listed.reviews.length === 0) {
        setReviews([]);
        setSelected(null);
        setState("empty");
        return;
      }
      const decrypted: DecryptedStudioReview[] = [];
      for (const summary of listed.reviews) {
        decrypted.push(await coordinator.readReview(context, summary.reviewId, abort.signal));
      }
      setReviews(decrypted);
      setSelected(decrypted[0] ?? null);
      setReviewCursor(listed.nextCursor);
      resetSeenCursors(seenReviewCursors.current, listed.nextCursor);
      const first = decrypted[0];
      if (first !== undefined) {
        const listedThreads = await coordinator.listThreads(context, first.review.reviewId, {
          limit: 50,
          signal: abort.signal,
        });
        setThreads(listedThreads.threads);
        setThreadCursor(listedThreads.nextCursor);
        resetSeenCursors(seenThreadCursors.current, listedThreads.nextCursor);
      }
      setState("ready");
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        applyFailure(error, setState, setFailure);
      }
    } finally {
      if (operationAbort.current === abort) {
        operationAbort.current = null;
      }
    }
  }, [capabilities.read, context, coordinator, online]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => operationAbort.current?.abort();
  }, [load]);

  async function runOperation<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | null> {
    operationAbort.current?.abort();
    const abort = new AbortController();
    operationAbort.current = abort;
    setBusy(label);
    setFailure(null);
    try {
      return await operation(abort.signal);
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        applyFailure(error, setState, setFailure);
      }
      return null;
    } finally {
      if (operationAbort.current === abort) {
        operationAbort.current = null;
        setBusy(null);
      }
    }
  }

  async function selectReview(reviewId: string): Promise<void> {
    const loaded = await runOperation("read-review", (signal) =>
      coordinator.readReview(context, reviewId, signal),
    );
    if (loaded !== null) {
      setSelected(loaded);
      setThread(null);
      setReplyTarget(null);
      setThreads([]);
      setThreadCursor(null);
      seenItemCursors.current.clear();
      seenThreadCursors.current.clear();
      const listedThreads = await runOperation("list-threads", (signal) =>
        coordinator.listThreads(context, reviewId, { limit: 50, signal }),
      );
      if (listedThreads !== null) {
        setThreads(listedThreads.threads);
        setThreadCursor(listedThreads.nextCursor);
        resetSeenCursors(seenThreadCursors.current, listedThreads.nextCursor);
        setState("ready");
      }
    }
  }

  async function decideReview(decision: "approved" | "rejected"): Promise<void> {
    if (selected === null) {
      return;
    }
    const result = await runOperation(`review-${decision}`, (signal) =>
      coordinator.decideReview(context, selected.review, decision, signal),
    );
    if (result !== null) {
      const updated = { ...selected, review: result.review };
      setSelected(updated);
      setReviews((current) =>
        current.map((entry) =>
          entry.review.reviewId === result.review.reviewId ? updated : entry,
        ),
      );
    }
  }

  async function loadThread(threadId: string): Promise<void> {
    if (selected === null) {
      return;
    }
    const loaded = await runOperation("read-thread", (signal) =>
      coordinator.readThread(context, selected.review.reviewId, threadId, { signal }),
    );
    if (loaded !== null) {
      setThread(loaded);
      resetSeenCursors(seenItemCursors.current, loaded.nextCursor);
      setState("ready");
    }
  }

  async function appendItem(input: AppendStudioReviewThreadItemInput): Promise<void> {
    if (selected === null) {
      return;
    }
    const appended = await runOperation("append-item", (signal) =>
      coordinator.appendThreadItem(context, selected.review.reviewId, input, signal),
    );
    if (appended !== null) {
      setThreads((current) => mergeById(current, [appended.thread], (entry) => entry.threadId));
      setThread((current) =>
        current?.thread.threadId === appended.thread.threadId
          ? {
              thread: appended.thread,
              items: mergeThreadItems(current.items, [
                { state: "ready", item: appended.item, payload: appended.payload },
              ]),
              nextCursor: current.nextCursor,
            }
          : {
              thread: appended.thread,
              items: [{ state: "ready", item: appended.item, payload: appended.payload }],
              nextCursor: null,
            },
      );
      setReplyTarget(null);
    }
  }

  async function loadMoreReviews(): Promise<void> {
    if (reviewCursor === null) {
      return;
    }
    const previousCursor = reviewCursor;
    const loaded = await runOperation("more-reviews", async (signal) => {
      const page = await coordinator.listReviews(context, {
        cursor: previousCursor,
        limit: 50,
        signal,
      });
      const decrypted = await Promise.all(
        page.reviews.map((summary) => coordinator.readReview(context, summary.reviewId, signal)),
      );
      return { page, decrypted };
    });
    if (loaded === null) {
      return;
    }
    const { page, decrypted } = loaded;
    if (isCursorLoop(seenReviewCursors.current, page.nextCursor)) {
      applyFailure(
        { code: "REVIEW_REMOTE_RESPONSE_INVALID", message: "审阅分页游标未前进。" },
        setState,
        setFailure,
      );
      return;
    }
    const known = new Set(reviews.map((entry) => entry.review.reviewId));
    if (page.reviews.some((entry) => known.has(entry.reviewId))) {
      applyFailure(
        { code: "REVIEW_REMOTE_RESPONSE_INVALID", message: "审阅分页返回了重复记录。" },
        setState,
        setFailure,
      );
      return;
    }
    setReviews((current) => [...current, ...decrypted]);
    setReviewCursor(page.nextCursor);
  }

  async function loadMoreThreads(): Promise<void> {
    if (selected === null || threadCursor === null) {
      return;
    }
    const previousCursor = threadCursor;
    const page = await runOperation("more-threads", (signal) =>
      coordinator.listThreads(context, selected.review.reviewId, {
        cursor: previousCursor,
        limit: 50,
        signal,
      }),
    );
    if (page === null) {
      return;
    }
    if (isCursorLoop(seenThreadCursors.current, page.nextCursor)) {
      applyFailure(
        { code: "REVIEW_REMOTE_RESPONSE_INVALID", message: "线程分页游标未前进。" },
        setState,
        setFailure,
      );
      return;
    }
    const known = new Set(threads.map((entry) => entry.threadId));
    if (page.threads.some((entry) => known.has(entry.threadId))) {
      applyFailure(
        { code: "REVIEW_REMOTE_RESPONSE_INVALID", message: "线程分页返回了重复记录。" },
        setState,
        setFailure,
      );
      return;
    }
    setThreads((current) => [...current, ...page.threads]);
    setThreadCursor(page.nextCursor);
  }

  async function loadMoreThreadItems(): Promise<void> {
    if (selected === null || thread?.nextCursor === undefined || thread.nextCursor === null) {
      return;
    }
    const previousCursor = thread.nextCursor;
    const page = await runOperation("more-thread-items", (signal) =>
      coordinator.readThread(context, selected.review.reviewId, thread.thread.threadId, {
        cursor: previousCursor,
        limit: 50,
        signal,
      }),
    );
    if (page === null) {
      return;
    }
    if (isCursorLoop(seenItemCursors.current, page.nextCursor)) {
      applyFailure(
        { code: "REVIEW_REMOTE_RESPONSE_INVALID", message: "线程条目分页游标未前进。" },
        setState,
        setFailure,
      );
      return;
    }
    const known = new Set(thread.items.map((entry) => entry.item.itemId));
    if (page.items.some((entry) => known.has(entry.item.itemId))) {
      applyFailure(
        { code: "REVIEW_REMOTE_RESPONSE_INVALID", message: "线程条目分页返回了重复记录。" },
        setState,
        setFailure,
      );
      return;
    }
    setThread({
      thread: page.thread,
      items: [...thread.items, ...page.items],
      nextCursor: page.nextCursor,
    });
  }

  async function resolveCurrentThread(): Promise<void> {
    if (selected === null || thread === null) {
      return;
    }
    const resolved = await runOperation("resolve-thread", (signal) =>
      coordinator.resolveThread(context, selected.review.reviewId, thread.thread, signal),
    );
    if (resolved !== null) {
      setThread({ ...thread, thread: resolved.thread });
      setThreads((current) => mergeById(current, [resolved.thread], (entry) => entry.threadId));
    }
  }

  async function decideSuggestion(
    itemId: string,
    itemRevision: number,
    decision: "accepted" | "rejected",
  ): Promise<void> {
    if (selected === null || thread === null) {
      return;
    }
    const input = {
      reviewId: selected.review.reviewId,
      threadId: thread.thread.threadId,
      itemId,
      expectedItemRevision: itemRevision,
    };
    if (decision === "rejected") {
      const rejected = await runOperation("reject-suggestion", (signal) =>
        coordinator.rejectSuggestion(context, input, signal),
      );
      if (rejected !== null) {
        await loadThread(thread.thread.threadId);
      }
      return;
    }
    const accepted = await runOperation("accept-suggestion", (signal) =>
      coordinator.acceptSuggestion(context, input, signal),
    );
    handleAcceptanceOutcome(accepted);
  }

  function handleAcceptanceOutcome(outcome: AcceptStudioReviewSuggestionOutcome | null): void {
    if (outcome === null) {
      return;
    }
    if (outcome.status === "partial_retry") {
      setPartial(outcome);
      setState("partial_retry");
      setFailure({
        code: outcome.failureCode,
        message: "本地新版本已安全创建，但云端接受标记尚未完成；可以重试，不会再次覆盖正文。",
      });
      return;
    }
    setPartial(null);
    setState("ready");
    if (thread !== null) {
      void loadThread(thread.thread.threadId);
    }
  }

  async function retryPartial(): Promise<void> {
    if (partial === null) {
      return;
    }
    const outcome = await runOperation("retry-suggestion-decision", (signal) =>
      coordinator.retryAcceptedSuggestionDecision(context, partial, signal),
    );
    handleAcceptanceOutcome(outcome);
  }

  if (state === "loading") {
    return (
      <ReviewState title="正在加载团队审阅" description="正在验证权限、密钥和加密审阅记录。" />
    );
  }
  if (state === "offline") {
    return (
      <ReviewState
        title="当前离线"
        description="团队审阅不会伪造远程成功。恢复网络后再加载。"
        action={{ label: "重新检查", onClick: () => void load() }}
      />
    );
  }
  if (state === "permission_denied") {
    return (
      <ReviewState
        title="没有审阅权限"
        description="当前成员角色或项目分配不允许读取团队审阅。"
        code={failure?.code}
      />
    );
  }
  if (state === "key_missing") {
    return (
      <ReviewState
        title="缺少项目密钥"
        description="当前设备没有该审阅所需的精确项目密钥版本，密文不会被跳过验证。"
        code={failure?.code}
        action={{ label: "重试", onClick: () => void load() }}
      />
    );
  }
  if (state === "corrupt_ciphertext") {
    return (
      <ReviewState
        title="审阅密文损坏"
        description="审阅正文未通过完整性或加密认证，已停止显示该记录。"
        code={failure?.code}
        action={{ label: "重新加载", onClick: () => void load() }}
      />
    );
  }
  if (state === "revision_conflict") {
    return (
      <ReviewState
        title="审阅版本冲突"
        description="远端修订已经变化。请重新加载后比较，不会静默覆盖。"
        code={failure?.code}
        action={{ label: "重新加载", onClick: () => void load() }}
      />
    );
  }
  if (state === "error") {
    return (
      <ReviewState
        title="团队审阅暂不可用"
        description={failure?.message ?? "团队审阅操作未完成，请稍后重试。"}
        code={failure?.code}
        action={{ label: "重试", onClick: () => void load() }}
      />
    );
  }

  return (
    <div className="desktop-page studio-review-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">团队空间 · 端到端加密协作</p>
          <h1>团队审阅</h1>
          <p>批注、建议与审阅说明只在当前设备解密；接受建议始终创建作者侧本地版本。</p>
        </div>
        <div>
          <Badge tone="success">密文传输</Badge>
          {busy !== null && (
            <Button variant="secondary" onClick={() => operationAbort.current?.abort()}>
              取消当前操作
            </Button>
          )}
        </div>
      </header>

      {state === "partial_retry" && (
        <InlineAlert
          tone="warning"
          title="本地版本已创建，云端标记待重试"
          description={failure?.message ?? ""}
          {...(partial === null
            ? {}
            : {
                action: {
                  label: "重试云端标记",
                  onClick: () => void retryPartial(),
                },
              })}
        />
      )}

      {state === "empty" && (
        <EmptyState
          kind="no_data"
          title="还没有审阅"
          description="从本地已保存且已加密的稳定版本发起第一轮团队审阅。"
        />
      )}

      {capabilities.submit && (
        <SubmissionCard
          disabled={busy !== null}
          onSubmit={(input) => {
            void runOperation("submit-review", (signal) =>
              coordinator.submitReview(context, input, signal),
            ).then((created) => {
              if (created !== null) {
                setReviews((current) => [created, ...current]);
                setSelected(created);
                setState("ready");
              }
            });
          }}
        />
      )}

      {reviews.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>审阅记录</CardTitle>
            <CardDescription>选择记录时会在本地使用其精确历史项目密钥解密。</CardDescription>
          </CardHeader>
          <CardContent>
            <ul aria-label="审阅记录">
              {reviews.map((entry) => (
                <li key={entry.review.reviewId}>
                  <Button
                    variant={
                      selected?.review.reviewId === entry.review.reviewId ? "primary" : "secondary"
                    }
                    disabled={busy !== null}
                    onClick={() => void selectReview(entry.review.reviewId)}
                  >
                    {entry.payload.title} · {reviewStateLabel(entry.review.state)}
                  </Button>
                </li>
              ))}
            </ul>
            {reviewCursor !== null && (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void loadMoreReviews()}
              >
                加载更多审阅
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {selected !== null && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{selected.payload.title}</CardTitle>
              <CardDescription>{selected.payload.note || "未附加审阅说明"}</CardDescription>
            </CardHeader>
            <CardContent>
              <p>稳定来源版本：{selected.review.sourceVersionId}</p>
              <p>来源修订：{selected.review.sourceVersionRevision}</p>
              {selected.review.state === "pending" &&
                (capabilities.approve || capabilities.reject) && (
                  <div>
                    {capabilities.approve && (
                      <Button
                        disabled={busy !== null}
                        onClick={() => void decideReview("approved")}
                      >
                        批准
                      </Button>
                    )}
                    {capabilities.reject && (
                      <Button
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() => void decideReview("rejected")}
                      >
                        驳回
                      </Button>
                    )}
                  </div>
                )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>审阅线程</CardTitle>
              <CardDescription>线程从远端加密审阅目录分页发现，无需复制内部标识。</CardDescription>
            </CardHeader>
            <CardContent>
              {threads.length === 0 ? (
                <p>尚无线程。</p>
              ) : (
                <ul aria-label="审阅线程">
                  {threads.map((entry) => (
                    <li key={entry.threadId}>
                      <Button
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void loadThread(entry.threadId)}
                      >
                        {entry.state === "open" ? "开放线程" : "已解决线程"} · {entry.itemCount} 条
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {threadCursor !== null && (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void loadMoreThreads()}
                >
                  加载更多线程
                </Button>
              )}
            </CardContent>
          </Card>

          <NewThreadItemCard
            capabilities={capabilities}
            disabled={busy !== null}
            selection={selection}
            onSubmit={(input) => void appendItem(input)}
          />
        </>
      )}

      {thread !== null && selected !== null && (
        <Card>
          <CardHeader>
            <CardTitle>审阅线程</CardTitle>
            <CardDescription>
              {thread.thread.state === "resolved" ? "已解决" : "开放中"} · 修订{" "}
              {thread.thread.revision}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {thread.items.map((entry) => (
              <article key={entry.item.itemId}>
                {entry.state === "corrupt" ? (
                  <InlineAlert
                    tone="error"
                    title="此条密文损坏"
                    description="该条目已隔离；同一线程中的其他条目仍可继续阅读。"
                  />
                ) : (
                  <>
                    <h3>{threadItemLabel(entry.item.itemType)}</h3>
                    <p>{entry.payload.body}</p>
                    {capabilities.reply && thread.thread.state === "open" && (
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setReplyTarget(entry.item)}
                      >
                        回复
                      </Button>
                    )}
                    {entry.item.itemType === "suggestion" &&
                      entry.item.suggestionDecision === "pending" &&
                      capabilities.decideSuggestion && (
                        <div>
                          <Button
                            disabled={busy !== null}
                            onClick={() =>
                              void decideSuggestion(
                                entry.item.itemId,
                                entry.item.revision,
                                "accepted",
                              )
                            }
                          >
                            接受并创建本地版本
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy !== null}
                            onClick={() =>
                              void decideSuggestion(
                                entry.item.itemId,
                                entry.item.revision,
                                "rejected",
                              )
                            }
                          >
                            拒绝建议
                          </Button>
                        </div>
                      )}
                  </>
                )}
              </article>
            ))}
            {replyTarget !== null && capabilities.reply && (
              <ReplyComposer
                disabled={busy !== null}
                onSubmit={(body) =>
                  void appendItem({
                    itemType: "reply",
                    body,
                    anchor: null,
                    threadId: thread.thread.threadId,
                    parentItemId: replyTarget.itemId,
                    expectedThreadRevision: thread.thread.revision,
                  })
                }
              />
            )}
            {thread.nextCursor !== null && (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void loadMoreThreadItems()}
              >
                加载更多条目
              </Button>
            )}
            {thread.thread.state === "open" && capabilities.resolve && (
              <Button disabled={busy !== null} onClick={() => void resolveCurrentThread()}>
                标记线程已解决
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SubmissionCard({
  disabled,
  onSubmit,
}: {
  readonly disabled: boolean;
  readonly onSubmit: (input: { title: string; note: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (title.trim().length === 0) {
      return;
    }
    onSubmit({ title, note });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>发起审阅</CardTitle>
        <CardDescription>仅允许选择已经保存并生成权威密文投影的版本。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FormField label="审阅标题" required>
            {(props) => (
              <Input
                {...props}
                value={title}
                maxLength={200}
                disabled={disabled}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="说明">
            {(props) => (
              <Textarea
                {...props}
                value={note}
                maxLength={16 * 1024}
                disabled={disabled}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            )}
          </FormField>
          <Button type="submit" disabled={disabled || title.trim().length === 0}>
            加密并提交
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function NewThreadItemCard({
  capabilities,
  disabled,
  selection,
  onSubmit,
}: {
  readonly capabilities: ReturnType<StudioReviewPageCoordinator["capabilities"]>;
  readonly disabled: boolean;
  readonly selection: StudioReviewTextAnchor | null;
  readonly onSubmit: (input: AppendStudioReviewThreadItemInput) => void;
}) {
  const options = [
    ...(capabilities.comment ? [{ value: "comment", label: "批注" }] : []),
    ...(capabilities.suggest ? [{ value: "suggestion", label: "建议" }] : []),
    ...(capabilities.question ? [{ value: "question", label: "问题" }] : []),
    ...(capabilities.requestRewrite ? [{ value: "rewrite_request", label: "重写请求" }] : []),
  ];
  const [itemType, setItemType] =
    useState<Exclude<AppendStudioReviewThreadItemInput["itemType"], "reply">>("comment");
  const [body, setBody] = useState("");
  const [replacementText, setReplacementText] = useState("");

  if (options.length === 0) {
    return null;
  }

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (body.trim().length === 0) {
      return;
    }
    if (itemType === "suggestion") {
      if (selection === null || replacementText.length === 0) {
        return;
      }
      onSubmit({ itemType, body, anchor: selection, replacementText });
      return;
    }
    onSubmit({ itemType, body, anchor: selection });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>新增审阅条目</CardTitle>
        <CardDescription>条目正文只在本地加密。审阅者没有任何正文写入入口。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FormField label="类型">
            {(props) => (
              <Select
                {...props}
                options={options}
                value={itemType}
                disabled={disabled}
                onChange={(event) =>
                  setItemType(
                    event.currentTarget.value as Exclude<
                      AppendStudioReviewThreadItemInput["itemType"],
                      "reply"
                    >,
                  )
                }
              />
            )}
          </FormField>
          <FormField label="内容" required>
            {(props) => (
              <Textarea
                {...props}
                value={body}
                maxLength={64 * 1024}
                disabled={disabled}
                onChange={(event) => setBody(event.currentTarget.value)}
              />
            )}
          </FormField>
          {itemType === "suggestion" && (
            <>
              <FormField label="候选替换文本" required>
                {(props) => (
                  <Textarea
                    {...props}
                    value={replacementText}
                    maxLength={128 * 1024}
                    disabled={disabled || selection === null}
                    onChange={(event) => setReplacementText(event.currentTarget.value)}
                  />
                )}
              </FormField>
              {selection === null && (
                <InlineAlert
                  tone="warning"
                  title="尚未取得已验证选区"
                  description="请从编辑器稳定版本选择文本；页面不会用未保存明文伪造选区哈希。"
                />
              )}
            </>
          )}
          <Button
            type="submit"
            disabled={
              disabled ||
              body.trim().length === 0 ||
              (itemType === "suggestion" && (selection === null || replacementText.length === 0))
            }
          >
            加密并发送
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ReplyComposer({
  disabled,
  onSubmit,
}: {
  readonly disabled: boolean;
  readonly onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  return (
    <form
      aria-label="回复审阅条目"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim().length > 0) {
          onSubmit(body);
        }
      }}
    >
      <FormField label="回复内容" required>
        {(props) => (
          <Textarea
            {...props}
            value={body}
            maxLength={64 * 1024}
            disabled={disabled}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
        )}
      </FormField>
      <Button type="submit" disabled={disabled || body.trim().length === 0}>
        加密并回复
      </Button>
    </form>
  );
}

function ReviewState({
  title,
  description,
  code,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly code?: string | undefined;
  readonly action?: Readonly<{ label: string; onClick: () => void }> | undefined;
}) {
  return (
    <div className="desktop-page studio-review-page">
      <ErrorState
        title={title}
        description={description}
        {...(code === undefined ? {} : { errorCode: code })}
        {...(action === undefined ? {} : { primaryAction: action })}
      />
    </div>
  );
}

function applyFailure(
  error: unknown,
  setState: (state: ReviewPageState) => void,
  setFailure: (failure: PageFailure) => void,
): void {
  const normalized = normalizeFailure(error);
  setFailure(normalized);
  switch (normalized.code) {
    case "REVIEW_OFFLINE":
    case "CLOUD_NETWORK_UNAVAILABLE":
      setState("offline");
      return;
    case "REVIEW_PERMISSION_DENIED":
    case "ACCESS_FORBIDDEN":
      setState("permission_denied");
      return;
    case "REVIEW_KEY_MISSING":
    case "REVIEW_CRYPTO_KEY_INVALID":
      setState("key_missing");
      return;
    case "REVIEW_CIPHERTEXT_CORRUPT":
    case "REVIEW_CIPHERTEXT_HASH_MISMATCH":
    case "REVIEW_PAYLOAD_INVALID":
    case "REVIEW_CRYPTO_SCOPE_INVALID":
      setState("corrupt_ciphertext");
      return;
    case "REVIEW_REVISION_CONFLICT":
    case "REVISION_CONFLICT":
      setState("revision_conflict");
      return;
    default:
      setState("error");
  }
}

function normalizeFailure(error: unknown): PageFailure {
  if (
    error instanceof StudioReviewCoordinatorError ||
    error instanceof StudioReviewCryptoError ||
    error instanceof StudioReviewServiceError
  ) {
    return { code: error.code, message: studioReviewFailureMessage(error.code) };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return { code: error.code, message: studioReviewFailureMessage(error.code) };
  }
  return { code: "REVIEW_UNEXPECTED_ERROR", message: "团队审阅操作未完成。" };
}

function studioReviewFailureMessage(code: string): string {
  switch (code) {
    case "REVIEW_OFFLINE":
    case "CLOUD_NETWORK_UNAVAILABLE":
      return "当前无法连接团队审阅服务；本地正文和版本不受影响。";
    case "REVIEW_PERMISSION_DENIED":
    case "ACCESS_FORBIDDEN":
      return "当前成员角色或项目分配不允许执行这项团队审阅操作。";
    case "REVIEW_KEY_MISSING":
    case "REVIEW_CRYPTO_KEY_INVALID":
      return "当前设备缺少可核对的项目密钥，系统没有跳过加密验证。";
    case "REVIEW_CIPHERTEXT_CORRUPT":
    case "REVIEW_CIPHERTEXT_HASH_MISMATCH":
    case "REVIEW_PAYLOAD_INVALID":
    case "REVIEW_CRYPTO_SCOPE_INVALID":
      return "审阅记录没有通过完整性核对，系统已停止读取该内容。";
    case "REVIEW_REVISION_CONFLICT":
    case "REVISION_CONFLICT":
      return "远端审阅已发生变化，请重新加载后再操作。";
    default:
      return "团队审阅操作未完成。请手动重试；系统不会自动重复提交。";
  }
}

function reviewStateLabel(state: DecryptedStudioReview["review"]["state"]): string {
  switch (state) {
    case "pending":
      return "待审阅";
    case "approved":
      return "已批准";
    case "rejected":
      return "已驳回";
  }
}

function threadItemLabel(itemType: keyof typeof THREAD_ITEM_LABELS | "reply"): string {
  return itemType === "reply" ? "回复" : THREAD_ITEM_LABELS[itemType];
}

function mergeById<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (entry: T) => string,
): readonly T[] {
  const merged = [...current];
  const positions = new Map(current.map((entry, index) => [key(entry), index]));
  for (const entry of incoming) {
    const id = key(entry);
    const position = positions.get(id);
    if (position === undefined) {
      positions.set(id, merged.length);
      merged.push(entry);
    } else {
      merged[position] = entry;
    }
  }
  return merged;
}

function mergeThreadItems(
  current: StudioReviewThreadView["items"],
  incoming: StudioReviewThreadView["items"],
): StudioReviewThreadView["items"] {
  const merged = [...current];
  const positions = new Map(current.map((entry, index) => [entry.item.itemId, index]));
  for (const entry of incoming) {
    const position = positions.get(entry.item.itemId);
    if (position === undefined) {
      positions.set(entry.item.itemId, merged.length);
      merged.push(entry);
    } else {
      merged[position] = entry;
    }
  }
  return merged;
}

function resetSeenCursors(seen: Set<string>, next: string | null): void {
  seen.clear();
  if (next !== null) {
    seen.add(next);
  }
}

function isCursorLoop(seen: Set<string>, next: string | null): boolean {
  if (next === null) {
    return false;
  }
  if (seen.has(next)) {
    return true;
  }
  seen.add(next);
  return false;
}
