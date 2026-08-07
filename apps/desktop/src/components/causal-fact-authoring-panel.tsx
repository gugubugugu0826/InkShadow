import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChapterRepository } from "@inkshadow/application";
import { parseUuidV7 } from "@inkshadow/domain";
import {
  CAUSAL_EVENT_RELATION_KINDS,
  type CausalEventNode,
  type CausalEventRelationKind,
} from "@inkshadow/story-core";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Input,
  Select,
  Textarea,
} from "@inkshadow/ui";

import type {
  CausalFactAuthoringReceipt,
  CausalFactAuthoringService,
} from "../infrastructure/causal-fact-authoring-service";

export interface CausalFactAuthoringPanelProps {
  readonly projectId: string;
  readonly actorId: string;
  readonly events: readonly CausalEventNode[];
  readonly chapters: Pick<ChapterRepository, "listByProjectId">;
  readonly service: Pick<CausalFactAuthoringService, "createEvent" | "createRelation">;
  onCreated(receipt: CausalFactAuthoringReceipt): void | Promise<void>;
}

type AuthoringMode = "event" | "relation";

export function CausalFactAuthoringPanel(props: CausalFactAuthoringPanelProps) {
  const [mode, setMode] = useState<AuthoringMode>("event");
  const [chapterOptions, setChapterOptions] = useState<readonly { value: string; label: string }[]>(
    [],
  );
  const [chapterId, setChapterId] = useState("");
  const [evidenceExcerpt, setEvidenceExcerpt] = useState("");
  const [eventText, setEventText] = useState("");
  const [resultText, setResultText] = useState("");
  const [narrativeLabel, setNarrativeLabel] = useState("");
  const [narrativeOrder, setNarrativeOrder] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [participantNames, setParticipantNames] = useState("");
  const [informedNames, setInformedNames] = useState("");
  const [fromEventId, setFromEventId] = useState("");
  const [toEventId, setToEventId] = useState("");
  const [relationKind, setRelationKind] = useState<CausalEventRelationKind>("causes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadChapters = useCallback(async () => {
    const parsed = parseUuidV7(props.projectId);
    if (!parsed.ok) {
      setError("当前作品标识无效，请返回作品库后重新打开。");
      return;
    }
    const loaded = await props.chapters.listByProjectId(parsed.value);
    if (!loaded.ok) {
      setError("暂时无法读取章节。请稍后重试；正文和故事设定没有改变。");
      return;
    }
    const next = loaded.value
      .filter(({ status }) => status === "active")
      .map((chapter) => ({ value: String(chapter.id), label: chapter.title }));
    setChapterOptions(next);
    setChapterId((current) =>
      current.length > 0 && next.some(({ value }) => value === current)
        ? current
        : (next[0]?.value ?? ""),
    );
  }, [props.chapters, props.projectId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadChapters();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadChapters]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      const nextOrder =
        Math.max(0, ...props.events.map(({ narrativeTime }) => narrativeTime.order)) + 10;
      setNarrativeOrder((current) => current || String(nextOrder));
      setFromEventId((current) =>
        props.events.some(({ id }) => id === current) ? current : (props.events[0]?.id ?? ""),
      );
      setToEventId((current) =>
        props.events.some(({ id }) => id === current) ? current : (props.events[1]?.id ?? ""),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [props.events]);

  const eventOptions = useMemo(
    () =>
      props.events.map((event) => ({
        value: event.id,
        label: `${event.narrativeTime.label} · ${event.eventText}`,
      })),
    [props.events],
  );

  async function submit(): Promise<void> {
    if (busy || chapterId.length === 0 || evidenceExcerpt.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const receipt =
        mode === "event"
          ? await props.service.createEvent({
              projectId: props.projectId,
              chapterId,
              evidenceExcerpt,
              eventText,
              resultText,
              narrativeOrder: Number(narrativeOrder),
              narrativeLabel,
              locationLabel,
              participantCharacterIds: splitReferences(participantNames),
              informedCharacterIds: splitReferences(informedNames),
              actorId: props.actorId,
            })
          : await props.service.createRelation({
              projectId: props.projectId,
              chapterId,
              evidenceExcerpt,
              fromEventId,
              toEventId,
              kind: relationKind,
              actorId: props.actorId,
            });
      await props.onCreated(receipt);
      setEvidenceExcerpt("");
      if (mode === "event") {
        setEventText("");
        setResultText("");
        setNarrativeLabel("");
        setLocationLabel("");
        setParticipantNames("");
        setInformedNames("");
        setNarrativeOrder(
          String(
            Math.max(
              0,
              ...receipt.projection.graph.events.map((event) => event.narrativeTime.order),
            ) + 10,
          ),
        );
      }
      setNotice(
        mode === "event"
          ? "事件已作为你确认的正式设定保存，并重新整理了故事关联。"
          : "事件关系已保存，并重新计算了后续影响范围。",
      );
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "没有保存，请检查输入后重试。");
    } finally {
      setBusy(false);
    }
  }

  const eventReady =
    eventText.trim().length > 0 &&
    resultText.trim().length > 0 &&
    narrativeLabel.trim().length > 0 &&
    locationLabel.trim().length > 0 &&
    /^\d+$/u.test(narrativeOrder);
  const relationReady =
    props.events.length >= 2 &&
    fromEventId.length > 0 &&
    toEventId.length > 0 &&
    fromEventId !== toEventId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>补充一个有原文依据的关联</CardTitle>
        <p>你明确保存后才会进入正式故事链；系统会先核对证据是否来自当前已保存章节。</p>
      </CardHeader>
      <CardContent>
        <div className="settings-actions" role="group" aria-label="要补充的内容">
          <Button
            size="sm"
            variant={mode === "event" ? "primary" : "secondary"}
            onClick={() => setMode("event")}
          >
            新事件
          </Button>
          <Button
            size="sm"
            variant={mode === "relation" ? "primary" : "secondary"}
            disabled={props.events.length < 2}
            onClick={() => setMode("relation")}
          >
            两个事件的关系
          </Button>
        </div>

        {error !== null && (
          <InlineAlert
            tone="error"
            title="没有保存故事关联"
            description={`${error} 正文和已有设定均未改变。`}
            onDismiss={() => setError(null)}
          />
        )}
        {notice !== null && (
          <InlineAlert
            tone="info"
            title="故事关联已更新"
            description={notice}
            onDismiss={() => setNotice(null)}
          />
        )}

        <FormField label="证据来自哪一章" required>
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={chapterId}
              options={chapterOptions}
              disabled={busy || chapterOptions.length === 0}
              placeholder="请选择章节"
              onChange={(event) => setChapterId(event.currentTarget.value)}
            />
          )}
        </FormField>

        {mode === "event" ? (
          <>
            <FormField label="发生了什么" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={eventText}
                  maxLength={2_000}
                  disabled={busy}
                  onChange={(event) => setEventText(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="造成了什么结果" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={resultText}
                  maxLength={2_000}
                  disabled={busy}
                  onChange={(event) => setResultText(event.currentTarget.value)}
                />
              )}
            </FormField>
            <div className="settings-grid">
              <FormField label="故事中的时间" hint="例如：开学第一天傍晚" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={narrativeLabel}
                    maxLength={2_000}
                    disabled={busy}
                    onChange={(event) => setNarrativeLabel(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="发生地点" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={locationLabel}
                    maxLength={2_000}
                    disabled={busy}
                    onChange={(event) => setLocationLabel(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="先后顺序" hint="推荐使用 10、20、30" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    min={0}
                    step={1}
                    value={narrativeOrder}
                    disabled={busy}
                    onChange={(event) => setNarrativeOrder(event.currentTarget.value)}
                  />
                )}
              </FormField>
            </div>
            <details>
              <summary>补充参与人物与知情范围</summary>
              <div className="settings-grid">
                <FormField label="参与人物" hint="用逗号或换行分隔；留空表示暂不标注。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      rows={2}
                      maxLength={4_000}
                      currentLength={participantNames.length}
                      value={participantNames}
                      disabled={busy}
                      onChange={(event) => setParticipantNames(event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <FormField
                  label="事件后已经知道此事的人物"
                  hint="用逗号或换行分隔；留空表示暂不标注。"
                >
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      rows={2}
                      maxLength={4_000}
                      currentLength={informedNames.length}
                      value={informedNames}
                      disabled={busy}
                      onChange={(event) => setInformedNames(event.currentTarget.value)}
                    />
                  )}
                </FormField>
              </div>
            </details>
          </>
        ) : (
          <div className="settings-grid">
            <FormField label="起点事件" required>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={fromEventId}
                  options={eventOptions}
                  disabled={busy}
                  onChange={(event) => setFromEventId(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="关系" required>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={relationKind}
                  options={CAUSAL_EVENT_RELATION_KINDS.map((value) => ({
                    value,
                    label: relationLabel(value),
                  }))}
                  disabled={busy}
                  onChange={(event) =>
                    setRelationKind(event.currentTarget.value as CausalEventRelationKind)
                  }
                />
              )}
            </FormField>
            <FormField label="终点事件" required>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={toEventId}
                  options={eventOptions}
                  disabled={busy}
                  onChange={(event) => setToEventId(event.currentTarget.value)}
                />
              )}
            </FormField>
          </div>
        )}

        <FormField
          label="从已保存正文复制原文证据"
          hint="如果同一句出现多次，请连同前后句一起复制，直到能唯一定位。"
          required
        >
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              rows={4}
              maxLength={20_000}
              currentLength={evidenceExcerpt.length}
              value={evidenceExcerpt}
              disabled={busy}
              onChange={(event) => setEvidenceExcerpt(event.currentTarget.value)}
            />
          )}
        </FormField>
        <Button
          loading={busy}
          disabled={
            chapterId.length === 0 ||
            evidenceExcerpt.trim().length === 0 ||
            (mode === "event" ? !eventReady : !relationReady)
          }
          onClick={() => void submit()}
        >
          {mode === "event" ? "确认并保存事件" : "确认并保存关系"}
        </Button>
      </CardContent>
    </Card>
  );
}

function relationLabel(kind: CausalEventRelationKind): string {
  const labels: Readonly<Record<CausalEventRelationKind, string>> = {
    causes: "导致",
    depends_on: "依赖",
    prevents: "阻止",
    reveals: "揭示",
    misleads: "误导",
    before: "发生在之前",
    changes_state: "改变状态",
    gains_information: "获得信息",
    loses_item: "失去物品",
  };
  return labels[kind];
}

function splitReferences(value: string): readonly string[] {
  return Object.freeze(
    value
      .split(/[，,\n]/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}
