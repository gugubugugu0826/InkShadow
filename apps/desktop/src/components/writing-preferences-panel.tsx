import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  FormField,
  InlineAlert,
  Textarea,
} from "@inkshadow/ui";

import type {
  WritingFeedbackLearningService,
  WritingPreferenceDashboard,
} from "../infrastructure/writing-feedback-learning-service";
import {
  WRITING_FEEDBACK_CODE_LABELS,
  type WritingPreference,
} from "../infrastructure/writing-feedback-store";
import { normalizeUiError } from "../infrastructure/ui-error";

export interface WritingPreferencesPanelProps {
  readonly projectId: string;
  readonly service: WritingFeedbackLearningService;
  readonly readonly?: boolean;
}

export function WritingPreferencesPanel({
  projectId,
  service,
  readonly = false,
}: WritingPreferencesPanelProps) {
  const [dashboard, setDashboard] = useState<WritingPreferenceDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<WritingPreference | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [clearOpen, setClearOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDashboard(await service.loadDashboard(projectId));
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [projectId, service]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void load();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const actionSummary = useMemo(() => {
    const events = dashboard?.recentEvents ?? [];
    return {
      accepted: events.filter(
        (event) => event.action === "accepted" || event.action === "partially_accepted",
      ).length,
      rejected: events.filter((event) => event.action === "rejected").length,
      regenerated: events.filter((event) => event.action === "regenerated").length,
      feedback: events.filter((event) => event.action === "explicit_feedback").length,
    };
  }, [dashboard]);

  async function run(operation: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      await load();
      setError(null);
      setNotice(success);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function addPreference(): Promise<void> {
    const value = draft.trim();
    if (value.length === 0) return;
    await run(async () => {
      await service.addManualPreference(projectId, value);
      setDraft("");
    }, "写作偏好已保存，之后的 AI 创作会把它作为可见参考。");
  }

  const normalizedError = error === null ? null : normalizeUiError(error);

  if (loading && dashboard === null) {
    return <p role="status">正在读取写作偏好…</p>;
  }

  if (dashboard === null) {
    return (
      <InlineAlert
        tone="error"
        title={normalizedError?.title ?? "暂时无法读取写作偏好"}
        description={normalizedError?.description ?? "请稍后重试；现有正文不会受到影响。"}
        action={{ label: "重试", onClick: () => void load() }}
      />
    );
  }

  return (
    <section aria-labelledby="writing-preferences-title" className="writing-preferences-panel">
      <div className="section-heading">
        <div>
          <h2 id="writing-preferences-title">我的写作偏好</h2>
          <p>
            这里只保存你能看见和修改的偏好。暂停学习后仍会保留你的明确反馈，但不会自动形成新偏好。
          </p>
        </div>
        <div className="settings-actions">
          <Badge tone={dashboard.policy.learningEnabled ? "success" : "neutral"}>
            {dashboard.policy.learningEnabled ? "学习已开启" : "学习已暂停"}
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            disabled={readonly || busy}
            onClick={() =>
              void run(
                () =>
                  service.setLearningEnabled(dashboard.policy, !dashboard.policy.learningEnabled),
                dashboard.policy.learningEnabled
                  ? "偏好学习已暂停。现有偏好不会被删除。"
                  : "偏好学习已开启。只有重复的明确反馈才会形成新偏好。",
              )
            }
          >
            {dashboard.policy.learningEnabled ? "暂停学习" : "继续学习"}
          </Button>
        </div>
      </div>

      {normalizedError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={`${normalizedError.description} 现有偏好和正文均未被覆盖。`}
          onDismiss={() => setError(null)}
        />
      )}
      {notice !== null && (
        <InlineAlert
          tone="info"
          title="写作偏好已更新"
          description={notice}
          onDismiss={() => setNotice(null)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>手动添加</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField
            label="希望 AI 长期遵守什么"
            hint="例如：减少环境描写；战斗段落使用短句；不要使用总结式结尾。"
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={draft}
                maxLength={500}
                currentLength={draft.length}
                rows={3}
                disabled={readonly || busy}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
            )}
          </FormField>
        </CardContent>
        <CardFooter>
          <Button
            size="sm"
            disabled={readonly || busy || draft.trim().length === 0}
            onClick={() => void addPreference()}
          >
            保存偏好
          </Button>
        </CardFooter>
      </Card>

      {dashboard.preferences.length === 0 ? (
        <EmptyState
          title="还没有写作偏好"
          description="可以手动添加；也可以在评价 AI 建议时选择具体原因，同一反馈重复出现两次后会在这里形成可编辑偏好。"
        />
      ) : (
        <div className="story-governance-grid">
          {dashboard.preferences.map((preference) => (
            <Card key={preference.id}>
              <CardHeader>
                <div className="card-heading-row">
                  <CardTitle>
                    {preference.source === "manual" && preference.sourceFeedbackHash === null
                      ? "手动偏好"
                      : "从反馈中学到"}
                  </CardTitle>
                  <Badge tone={preference.enabled ? "success" : "neutral"}>
                    {preference.enabled ? "使用中" : "已停用"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="story-governance-copy">{preference.preferenceText}</p>
                {preference.sourceFeedbackCode !== null && (
                  <p className="candidate-panel__hint">
                    来源：你选择过“
                    {WRITING_FEEDBACK_CODE_LABELS[preference.sourceFeedbackCode]}”共
                    {preference.evidenceCount}次
                  </p>
                )}
                {preference.sourceFeedbackHash !== null && (
                  <p className="candidate-panel__hint">
                    来源：你重复提交过同一条自定义意见，共{preference.evidenceCount}次
                  </p>
                )}
              </CardContent>
              <CardFooter className="story-governance-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={readonly || busy}
                  onClick={() => {
                    setEditing(preference);
                    setEditDraft(preference.preferenceText);
                  }}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readonly || busy}
                  onClick={() =>
                    void run(
                      () => service.setPreferenceEnabled(preference, !preference.enabled),
                      preference.enabled ? "这条偏好已停用。" : "这条偏好已重新启用。",
                    )
                  }
                >
                  {preference.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readonly || busy}
                  onClick={() =>
                    void run(() => service.deletePreference(preference), "这条偏好已删除。")
                  }
                >
                  删除
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>最近反馈记录</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            接受或局部接受 {actionSummary.accepted} 次 · 拒绝 {actionSummary.rejected} 次 · 重新生成
            {actionSummary.regenerated}次 · 明确意见 {actionSummary.feedback} 次
          </p>
          <p className="candidate-panel__hint">
            这里仅记录操作类型、关联编号和反馈选项，不保存候选正文、章节正文或提示词副本。
          </p>
        </CardContent>
        {dashboard.preferences.length > 0 && (
          <CardFooter>
            <Button
              size="sm"
              variant="ghost"
              disabled={readonly || busy}
              onClick={() => setClearOpen(true)}
            >
              清空全部偏好
            </Button>
          </CardFooter>
        )}
      </Card>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
        title="编辑写作偏好"
        description="修改后只影响今后的 AI 创作，不会重写已有正文。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={editing === null || editDraft.trim().length === 0}
              onClick={() => {
                if (editing === null) return;
                void run(async () => {
                  await service.editPreference(editing, editDraft);
                  setEditing(null);
                }, "写作偏好已修改。");
              }}
            >
              保存修改
            </Button>
          </>
        }
      >
        <FormField label="偏好内容" required>
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              value={editDraft}
              maxLength={500}
              currentLength={editDraft.length}
              rows={4}
              disabled={busy}
              onChange={(event) => setEditDraft(event.currentTarget.value)}
            />
          )}
        </FormField>
      </Dialog>

      <Dialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!busy) setClearOpen(open);
        }}
        title="清空全部写作偏好？"
        description="现有偏好将不再参与 AI 创作。反馈操作记录和正文不会被删除。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await service.clearPreferences(projectId);
                  setClearOpen(false);
                }, "全部写作偏好已清空。")
              }
            >
              确认清空
            </Button>
          </>
        }
      >
        <p>清空只影响 AI 以后参考的偏好，不会删除任何正文或反馈操作记录。</p>
      </Dialog>
    </section>
  );
}
