import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChapterRepository } from "@inkshadow/application";
import { parseUuidV7 } from "@inkshadow/domain";
import {
  CAUSAL_EVENT_RELATION_KINDS,
  type CausalEventNode,
  type CausalEventRelationKind,
  type CausalForeshadowChangeKind,
  type CausalItemChangeKind,
  type CausalPrerequisiteKind,
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
  ConfirmedCausalCharacter,
} from "../infrastructure/causal-fact-authoring-service";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import {
  MAXIMUM_CAUSAL_CHARACTER_SELECTIONS,
  MAXIMUM_CAUSAL_EVENT_CHANGES,
  MAXIMUM_CAUSAL_KNOWLEDGE_GAINS,
} from "../infrastructure/causal-fact-authoring-service";

export interface CausalFactAuthoringPanelProps {
  readonly projectId: string;
  readonly actorId: string;
  readonly events: readonly CausalEventNode[];
  readonly chapters: Pick<ChapterRepository, "listByProjectId">;
  readonly service: Pick<
    CausalFactAuthoringService,
    "createEvent" | "createRelation" | "listConfirmedCharacters"
  >;
  onCreated(receipt: CausalFactAuthoringReceipt): void | Promise<void>;
}

type AuthoringMode = "event" | "relation";

interface KnowledgeGainDraft {
  readonly id: number;
  readonly characterId: string;
  readonly knowledgeLabel: string;
  readonly informationText: string;
}

interface KnowledgeGainDraftErrors {
  readonly characterId?: string;
  readonly knowledgeLabel?: string;
  readonly informationText?: string;
}

interface PrerequisiteDraft {
  readonly id: number;
  readonly kind: CausalPrerequisiteKind;
  readonly referenceId: string;
  readonly referenceLabel: string;
  readonly description: string;
}

interface CharacterStateDraft {
  readonly id: number;
  readonly characterId: string;
  readonly attributeLabel: string;
  readonly beforeValue: string;
  readonly afterValue: string;
}

interface RelationshipDraft {
  readonly id: number;
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly relationshipLabel: string;
  readonly beforeValue: string;
  readonly afterValue: string;
}

interface ItemChangeDraft {
  readonly id: number;
  readonly itemLabel: string;
  readonly kind: CausalItemChangeKind;
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
}

interface ForeshadowDraft {
  readonly id: number;
  readonly foreshadowLabel: string;
  readonly kind: CausalForeshadowChangeKind;
  readonly description: string;
}

export function CausalFactAuthoringPanel(props: CausalFactAuthoringPanelProps) {
  const knowledgeGainsHeadingId = useId();
  const characterScopeHeadingId = useId();
  const addKnowledgeGainButtonRef = useRef<HTMLButtonElement | null>(null);
  const knowledgeCharacterRefs = useRef(new Map<number, HTMLSelectElement>());
  const pendingKnowledgeFocus = useRef<number | "add" | null>(null);
  const [mode, setMode] = useState<AuthoringMode>("event");
  const [chapterOptions, setChapterOptions] = useState<readonly { value: string; label: string }[]>(
    [],
  );
  const [chapterId, setChapterId] = useState("");
  const [confirmedCharacters, setConfirmedCharacters] = useState<
    readonly ConfirmedCausalCharacter[]
  >([]);
  const [evidenceExcerpt, setEvidenceExcerpt] = useState("");
  const [eventText, setEventText] = useState("");
  const [resultText, setResultText] = useState("");
  const [narrativeLabel, setNarrativeLabel] = useState("");
  const [narrativeOrder, setNarrativeOrder] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [participantCharacterIds, setParticipantCharacterIds] = useState<readonly string[]>([]);
  const [informedCharacterIds, setInformedCharacterIds] = useState<readonly string[]>([]);
  const [knowledgeGains, setKnowledgeGains] = useState<readonly KnowledgeGainDraft[]>([]);
  const [nextKnowledgeGainId, setNextKnowledgeGainId] = useState(1);
  const [prerequisites, setPrerequisites] = useState<readonly PrerequisiteDraft[]>([]);
  const [characterStateChanges, setCharacterStateChanges] = useState<
    readonly CharacterStateDraft[]
  >([]);
  const [relationshipChanges, setRelationshipChanges] = useState<readonly RelationshipDraft[]>([]);
  const [itemChanges, setItemChanges] = useState<readonly ItemChangeDraft[]>([]);
  const [foreshadowProgress, setForeshadowProgress] = useState<readonly ForeshadowDraft[]>([]);
  const nextStructuredChangeId = useRef(1);
  const [fromEventId, setFromEventId] = useState("");
  const [toEventId, setToEventId] = useState("");
  const [relationKind, setRelationKind] = useState<CausalEventRelationKind>("causes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedWarning, setSavedWarning] = useState<string | null>(null);
  const [knowledgeAnnouncement, setKnowledgeAnnouncement] = useState("");

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

  const loadConfirmedCharacters = useCallback(async () => {
    try {
      const next = await props.service.listConfirmedCharacters(props.projectId);
      setConfirmedCharacters(next);
      const validIds = new Set(next.map(({ id }) => id));
      setParticipantCharacterIds((current) => current.filter((id) => validIds.has(id)));
      setInformedCharacterIds((current) => current.filter((id) => validIds.has(id)));
      setKnowledgeGains((current) =>
        current.map((draft) =>
          validIds.has(draft.characterId) ? draft : Object.freeze({ ...draft, characterId: "" }),
        ),
      );
      setCharacterStateChanges((current) =>
        current.map((draft) =>
          validIds.has(draft.characterId) ? draft : Object.freeze({ ...draft, characterId: "" }),
        ),
      );
      setRelationshipChanges((current) =>
        current.map((draft) =>
          Object.freeze({
            ...draft,
            fromCharacterId: validIds.has(draft.fromCharacterId) ? draft.fromCharacterId : "",
            toCharacterId: validIds.has(draft.toCharacterId) ? draft.toCharacterId : "",
          }),
        ),
      );
      setItemChanges((current) =>
        current.map((draft) =>
          Object.freeze({
            ...draft,
            fromCharacterId: validIds.has(draft.fromCharacterId) ? draft.fromCharacterId : "",
            toCharacterId: validIds.has(draft.toCharacterId) ? draft.toCharacterId : "",
          }),
        ),
      );
    } catch (cause: unknown) {
      setConfirmedCharacters([]);
      setError(projectOrdinaryUiError(cause).description);
    }
  }, [props.projectId, props.service]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadChapters();
        void loadConfirmedCharacters();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadChapters, loadConfirmedCharacters]);

  useEffect(() => {
    const target = pendingKnowledgeFocus.current;
    if (target === null) return;
    pendingKnowledgeFocus.current = null;
    if (target === "add") {
      addKnowledgeGainButtonRef.current?.focus();
    } else {
      knowledgeCharacterRefs.current.get(target)?.focus();
    }
  }, [knowledgeGains]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      const nextOrder =
        Math.max(0, ...props.events.map(({ narrativeTime }) => narrativeTime.order)) + 10;
      setNarrativeOrder((current) => (current.length > 0 ? current : String(nextOrder)));
      setFromEventId((current) =>
        props.events.some(({ id }) => id === current) ? current : (props.events[0]?.id ?? ""),
      );
      setToEventId((current) =>
        props.events.some(({ id }) => id === current) ? current : (props.events[1]?.id ?? ""),
      );
      const validEventIds = new Set(props.events.map(({ id }) => id));
      setPrerequisites((current) =>
        current.map((draft) =>
          draft.kind !== "event" || validEventIds.has(draft.referenceId)
            ? draft
            : Object.freeze({ ...draft, referenceId: "", referenceLabel: "" }),
        ),
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
  const characterOptions = useMemo(
    () => confirmedCharacters.map(({ id, name }) => ({ value: id, label: name })),
    [confirmedCharacters],
  );
  const knowledgeGainErrors = useMemo(
    () => validateKnowledgeGainDrafts(knowledgeGains, informedCharacterIds),
    [informedCharacterIds, knowledgeGains],
  );
  const knowledgeGainsReady = knowledgeGains.every(
    ({ id }) => Object.keys(knowledgeGainErrors.get(id) ?? {}).length === 0,
  );
  const structuredChangesReady =
    prerequisites.every(
      ({ description, kind, referenceId, referenceLabel }) =>
        description.trim().length > 0 &&
        (kind === "event" ? referenceId.length > 0 : referenceLabel.trim().length > 0),
    ) &&
    characterStateChanges.every(
      ({ afterValue, attributeLabel, beforeValue, characterId }) =>
        characterId.length > 0 &&
        attributeLabel.trim().length > 0 &&
        beforeValue.trim().length > 0 &&
        afterValue.trim().length > 0 &&
        beforeValue.trim() !== afterValue.trim(),
    ) &&
    relationshipChanges.every(
      ({ afterValue, beforeValue, fromCharacterId, relationshipLabel, toCharacterId }) =>
        fromCharacterId.length > 0 &&
        toCharacterId.length > 0 &&
        fromCharacterId !== toCharacterId &&
        relationshipLabel.trim().length > 0 &&
        beforeValue.trim().length > 0 &&
        afterValue.trim().length > 0 &&
        beforeValue.trim() !== afterValue.trim(),
    ) &&
    itemChanges.every(({ fromCharacterId, itemLabel, kind, toCharacterId }) => {
      if (itemLabel.trim().length === 0) return false;
      if (kind === "acquired") return toCharacterId.length > 0;
      if (kind === "lost") return fromCharacterId.length > 0;
      if (kind === "transferred") {
        return (
          fromCharacterId.length > 0 &&
          toCharacterId.length > 0 &&
          fromCharacterId !== toCharacterId
        );
      }
      if (kind === "created") return fromCharacterId.length === 0;
      return toCharacterId.length === 0;
    }) &&
    foreshadowProgress.every(
      ({ description, foreshadowLabel }) =>
        foreshadowLabel.trim().length > 0 && description.trim().length > 0,
    );

  function addKnowledgeGain(): void {
    if (knowledgeGains.length >= MAXIMUM_CAUSAL_KNOWLEDGE_GAINS) {
      setKnowledgeAnnouncement(
        `每个事件最多记录 ${String(MAXIMUM_CAUSAL_KNOWLEDGE_GAINS)} 条知识变化。`,
      );
      return;
    }
    const id = nextKnowledgeGainId;
    pendingKnowledgeFocus.current = id;
    setKnowledgeGains((current) => [
      ...current,
      Object.freeze({
        id,
        characterId: "",
        knowledgeLabel: "",
        informationText: "",
      }),
    ]);
    setNextKnowledgeGainId((current) => current + 1);
    setKnowledgeAnnouncement(`已添加第 ${String(knowledgeGains.length + 1)} 条知识变化。`);
  }

  function updateKnowledgeGain(
    id: number,
    field: keyof Omit<KnowledgeGainDraft, "id">,
    value: string,
  ): void {
    setKnowledgeGains((current) =>
      current.map((draft) =>
        draft.id === id ? Object.freeze({ ...draft, [field]: value }) : draft,
      ),
    );
  }

  function removeKnowledgeGain(id: number): void {
    const index = knowledgeGains.findIndex((draft) => draft.id === id);
    const nextTarget = knowledgeGains[index + 1]?.id ?? knowledgeGains[index - 1]?.id ?? "add";
    pendingKnowledgeFocus.current = nextTarget;
    setKnowledgeGains((current) => current.filter((draft) => draft.id !== id));
    setKnowledgeAnnouncement(`已删除第 ${String(index + 1)} 条知识变化。`);
  }

  function takeStructuredChangeId(): number {
    const id = nextStructuredChangeId.current;
    nextStructuredChangeId.current += 1;
    return id;
  }

  function addPrerequisite(): void {
    if (prerequisites.length >= MAXIMUM_CAUSAL_EVENT_CHANGES) return;
    setPrerequisites((current) => [
      ...current,
      Object.freeze({
        id: takeStructuredChangeId(),
        kind: "event" as const,
        referenceId: "",
        referenceLabel: "",
        description: "",
      }),
    ]);
  }

  function updatePrerequisite(
    id: number,
    field: keyof Omit<PrerequisiteDraft, "id">,
    value: string,
  ): void {
    setPrerequisites((current) =>
      current.map((draft) =>
        draft.id === id
          ? (Object.freeze({
              ...draft,
              [field]: value,
              ...(field === "kind" ? { referenceId: "", referenceLabel: "" } : {}),
            }) as PrerequisiteDraft)
          : draft,
      ),
    );
  }

  function addCharacterStateChange(): void {
    if (characterStateChanges.length >= MAXIMUM_CAUSAL_EVENT_CHANGES) return;
    setCharacterStateChanges((current) => [
      ...current,
      Object.freeze({
        id: takeStructuredChangeId(),
        characterId: "",
        attributeLabel: "",
        beforeValue: "",
        afterValue: "",
      }),
    ]);
  }

  function updateCharacterStateChange(
    id: number,
    field: keyof Omit<CharacterStateDraft, "id">,
    value: string,
  ): void {
    setCharacterStateChanges((current) =>
      current.map((draft) =>
        draft.id === id
          ? (Object.freeze({ ...draft, [field]: value }) as CharacterStateDraft)
          : draft,
      ),
    );
  }

  function addRelationshipChange(): void {
    if (relationshipChanges.length >= MAXIMUM_CAUSAL_EVENT_CHANGES) return;
    setRelationshipChanges((current) => [
      ...current,
      Object.freeze({
        id: takeStructuredChangeId(),
        fromCharacterId: "",
        toCharacterId: "",
        relationshipLabel: "",
        beforeValue: "",
        afterValue: "",
      }),
    ]);
  }

  function updateRelationshipChange(
    id: number,
    field: keyof Omit<RelationshipDraft, "id">,
    value: string,
  ): void {
    setRelationshipChanges((current) =>
      current.map((draft) =>
        draft.id === id
          ? (Object.freeze({ ...draft, [field]: value }) as RelationshipDraft)
          : draft,
      ),
    );
  }

  function addItemChange(): void {
    if (itemChanges.length >= MAXIMUM_CAUSAL_EVENT_CHANGES) return;
    setItemChanges((current) => [
      ...current,
      Object.freeze({
        id: takeStructuredChangeId(),
        itemLabel: "",
        kind: "transferred" as const,
        fromCharacterId: "",
        toCharacterId: "",
      }),
    ]);
  }

  function updateItemChange(
    id: number,
    field: keyof Omit<ItemChangeDraft, "id">,
    value: string,
  ): void {
    setItemChanges((current) =>
      current.map((draft) =>
        draft.id === id ? (Object.freeze({ ...draft, [field]: value }) as ItemChangeDraft) : draft,
      ),
    );
  }

  function addForeshadowProgress(): void {
    if (foreshadowProgress.length >= MAXIMUM_CAUSAL_EVENT_CHANGES) return;
    setForeshadowProgress((current) => [
      ...current,
      Object.freeze({
        id: takeStructuredChangeId(),
        foreshadowLabel: "",
        kind: "advanced" as const,
        description: "",
      }),
    ]);
  }

  function updateForeshadowProgress(
    id: number,
    field: keyof Omit<ForeshadowDraft, "id">,
    value: string,
  ): void {
    setForeshadowProgress((current) =>
      current.map((draft) =>
        draft.id === id ? (Object.freeze({ ...draft, [field]: value }) as ForeshadowDraft) : draft,
      ),
    );
  }

  function toggleCharacter(
    current: readonly string[],
    characterId: string,
    checked: boolean,
    label: string,
  ): readonly string[] {
    if (checked && current.length >= MAXIMUM_CAUSAL_CHARACTER_SELECTIONS) {
      setKnowledgeAnnouncement(
        `${label}最多选择 ${String(MAXIMUM_CAUSAL_CHARACTER_SELECTIONS)} 人，请先取消一人。`,
      );
      return current;
    }
    return checked
      ? Object.freeze([...new Set([...current, characterId])])
      : Object.freeze(current.filter((id) => id !== characterId));
  }

  async function submit(): Promise<void> {
    if (busy || chapterId.length === 0 || evidenceExcerpt.trim().length === 0) return;
    if (mode === "event" && (!knowledgeGainsReady || !structuredChangesReady)) {
      setError("请先补全或删除未完成的知识、前置条件和故事变化记录。");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setSavedWarning(null);
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
              participantCharacterIds,
              informedCharacterIds,
              knowledgeGains: knowledgeGains.map(
                ({ characterId, knowledgeLabel, informationText }) =>
                  Object.freeze({
                    characterId,
                    knowledgeLabel: knowledgeLabel.trim(),
                    informationText: informationText.trim(),
                  }),
              ),
              prerequisites: prerequisites.map(
                ({ description, kind, referenceId, referenceLabel }) =>
                  Object.freeze({
                    kind,
                    ...(kind === "event"
                      ? {
                          referenceId,
                          referenceLabel:
                            eventOptions.find(({ value }) => value === referenceId)?.label ??
                            referenceLabel,
                        }
                      : { referenceLabel: referenceLabel.trim() }),
                    description: description.trim(),
                  }),
              ),
              characterStateChanges: characterStateChanges.map(
                ({ afterValue, attributeLabel, beforeValue, characterId }) =>
                  Object.freeze({
                    characterId,
                    attributeLabel: attributeLabel.trim(),
                    beforeValue: beforeValue.trim(),
                    afterValue: afterValue.trim(),
                  }),
              ),
              relationshipChanges: relationshipChanges.map(
                ({ afterValue, beforeValue, fromCharacterId, relationshipLabel, toCharacterId }) =>
                  Object.freeze({
                    fromCharacterId,
                    toCharacterId,
                    relationshipLabel: relationshipLabel.trim(),
                    beforeValue: beforeValue.trim(),
                    afterValue: afterValue.trim(),
                  }),
              ),
              itemChanges: itemChanges.map(({ fromCharacterId, itemLabel, kind, toCharacterId }) =>
                Object.freeze({
                  itemLabel: itemLabel.trim(),
                  kind,
                  fromCharacterId: fromCharacterId.length === 0 ? null : fromCharacterId,
                  toCharacterId: toCharacterId.length === 0 ? null : toCharacterId,
                }),
              ),
              foreshadowProgress: foreshadowProgress.map(({ description, foreshadowLabel, kind }) =>
                Object.freeze({
                  foreshadowLabel: foreshadowLabel.trim(),
                  kind,
                  description: description.trim(),
                }),
              ),
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
      let refreshFailed = receipt.projection === null;
      try {
        await props.onCreated(receipt);
      } catch {
        refreshFailed = true;
      }
      setEvidenceExcerpt("");
      if (mode === "event") {
        setEventText("");
        setResultText("");
        setNarrativeLabel("");
        setLocationLabel("");
        setParticipantCharacterIds([]);
        setInformedCharacterIds([]);
        setKnowledgeGains([]);
        setPrerequisites([]);
        setCharacterStateChanges([]);
        setRelationshipChanges([]);
        setItemChanges([]);
        setForeshadowProgress([]);
        setNarrativeOrder(
          String(
            Math.max(
              0,
              ...(receipt.projection?.graph.events ?? props.events).map(
                (event) => event.narrativeTime.order,
              ),
            ) + 10,
          ),
        );
      }
      if (refreshFailed) {
        setSavedWarning(
          "正式设定已安全保存，但故事关联暂未更新。请使用下方“重新整理”恢复显示；重复提交不会创建副本。",
        );
      } else {
        const recovered = receipt.persistence === "existing" ? "已恢复先前保存的相同记录。" : "";
        setNotice(
          mode === "event"
            ? `${recovered}事件已作为你确认的正式设定保存，并重新整理了故事关联。`
            : `${recovered}事件关系已保存，并重新计算了后续影响范围。`,
        );
      }
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
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
        {savedWarning !== null && (
          <InlineAlert
            tone="warning"
            title="正式设定已保存，页面等待刷新"
            description={savedWarning}
            onDismiss={() => setSavedWarning(null)}
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
              <section aria-labelledby={characterScopeHeadingId}>
                <h4 id={characterScopeHeadingId}>选择已确认人物</h4>
                {confirmedCharacters.length === 0 ? (
                  <p role="status">
                    当前还没有可选择的正式人物。请先到“设定 →
                    人物”确认人物；系统不会让临时名称进入正式故事关联。
                  </p>
                ) : (
                  <div className="settings-grid">
                    <fieldset aria-label="参与人物" disabled={busy}>
                      <legend>
                        参与人物（{String(participantCharacterIds.length)} /{" "}
                        {String(MAXIMUM_CAUSAL_CHARACTER_SELECTIONS)}）
                      </legend>
                      {confirmedCharacters.map((character) => (
                        <label key={`participant:${character.id}`} className="settings-actions">
                          <input
                            type="checkbox"
                            checked={participantCharacterIds.includes(character.id)}
                            disabled={
                              busy ||
                              (!participantCharacterIds.includes(character.id) &&
                                participantCharacterIds.length >=
                                  MAXIMUM_CAUSAL_CHARACTER_SELECTIONS)
                            }
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setParticipantCharacterIds((current) =>
                                toggleCharacter(current, character.id, checked, "参与人物"),
                              );
                            }}
                          />
                          <span>{character.name}</span>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset aria-label="事件后已经知道此事的人物" disabled={busy}>
                      <legend>
                        事件后已经知道此事的人物（{String(informedCharacterIds.length)} /{" "}
                        {String(MAXIMUM_CAUSAL_CHARACTER_SELECTIONS)}）
                      </legend>
                      {confirmedCharacters.map((character) => (
                        <label key={`informed:${character.id}`} className="settings-actions">
                          <input
                            type="checkbox"
                            checked={informedCharacterIds.includes(character.id)}
                            disabled={
                              busy ||
                              (!informedCharacterIds.includes(character.id) &&
                                informedCharacterIds.length >= MAXIMUM_CAUSAL_CHARACTER_SELECTIONS)
                            }
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setInformedCharacterIds((current) =>
                                toggleCharacter(current, character.id, checked, "知情人物"),
                              );
                            }}
                          />
                          <span>{character.name}</span>
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}
              </section>
              <section aria-labelledby={knowledgeGainsHeadingId}>
                <div>
                  <h4 id={knowledgeGainsHeadingId}>明确获得的知识</h4>
                  <p>
                    只有你逐项记录的知识才会成为人物的取得来源。系统不会根据事件正文或“知情人物”自动猜测。
                  </p>
                </div>
                {knowledgeGains.length === 0 ? (
                  <p role="status">
                    还没有记录明确知识获得。可以直接保存事件；这时事件不会授权任何视角人物取得知识。
                  </p>
                ) : (
                  knowledgeGains.map((draft, index) => {
                    const errors = knowledgeGainErrors.get(draft.id) ?? {};
                    const position = index + 1;
                    return (
                      <fieldset
                        key={draft.id}
                        className="settings-grid"
                        aria-label={`明确知识获得 ${String(position)}`}
                        disabled={busy}
                      >
                        <FormField
                          label={`谁获得了知识（第 ${String(position)} 条）`}
                          hint="只能选择本事件结束后已经知情的人物。"
                          error={errors.characterId}
                          required
                        >
                          {(fieldProps) => (
                            <Select
                              {...fieldProps}
                              ref={(node) => {
                                if (node === null) knowledgeCharacterRefs.current.delete(draft.id);
                                else knowledgeCharacterRefs.current.set(draft.id, node);
                              }}
                              value={draft.characterId}
                              options={confirmedCharacters
                                .filter(({ id }) => informedCharacterIds.includes(id))
                                .map(({ id, name }) => ({ value: id, label: name }))}
                              placeholder="请选择人物"
                              onChange={(event) =>
                                updateKnowledgeGain(
                                  draft.id,
                                  "characterId",
                                  event.currentTarget.value,
                                )
                              }
                            />
                          )}
                        </FormField>
                        <FormField
                          label={`知识类别（第 ${String(position)} 条）`}
                          hint="用普通语言概括，例如“真实身份”或“钥匙位置”。"
                          error={errors.knowledgeLabel}
                          required
                        >
                          {(fieldProps) => (
                            <Input
                              {...fieldProps}
                              value={draft.knowledgeLabel}
                              maxLength={200}
                              placeholder="例如：真实身份"
                              onChange={(event) =>
                                updateKnowledgeGain(
                                  draft.id,
                                  "knowledgeLabel",
                                  event.currentTarget.value,
                                )
                              }
                            />
                          )}
                        </FormField>
                        <FormField
                          label={`人物得知的内容（第 ${String(position)} 条）`}
                          hint="写清楚具体事实，系统会在后台生成稳定引用。"
                          error={errors.informationText}
                          required
                        >
                          {(fieldProps) => (
                            <Input
                              {...fieldProps}
                              value={draft.informationText}
                              maxLength={1_000}
                              placeholder="例如：米拉是真正的继承人"
                              onChange={(event) =>
                                updateKnowledgeGain(
                                  draft.id,
                                  "informationText",
                                  event.currentTarget.value,
                                )
                              }
                            />
                          )}
                        </FormField>
                        <div className="settings-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => removeKnowledgeGain(draft.id)}
                          >
                            {`删除第 ${String(position)} 条知识获得`}
                          </Button>
                        </div>
                      </fieldset>
                    );
                  })
                )}
                <div className="settings-actions">
                  <Button
                    ref={addKnowledgeGainButtonRef}
                    size="sm"
                    variant="secondary"
                    disabled={
                      busy ||
                      informedCharacterIds.length === 0 ||
                      knowledgeGains.length >= MAXIMUM_CAUSAL_KNOWLEDGE_GAINS
                    }
                    onClick={addKnowledgeGain}
                  >
                    添加一条明确知识获得
                  </Button>
                  <span>
                    {String(knowledgeGains.length)} / {String(MAXIMUM_CAUSAL_KNOWLEDGE_GAINS)}
                  </span>
                </div>
                <p className="sr-only" role="status" aria-live="polite">
                  {knowledgeAnnouncement}
                </p>
              </section>
            </details>
            <details>
              <summary>补充前置条件与故事变化</summary>
              <p>
                这些内容只有在你点击“确认并保存事件”后才会成为正式设定；重要人物、关系、物品和伏笔变化不会被
                AI 自动确认。
              </p>

              <section>
                <h4>前置条件</h4>
                {prerequisites.map((draft, index) => (
                  <fieldset
                    key={draft.id}
                    className="settings-grid"
                    aria-label={`前置条件 ${String(index + 1)}`}
                    disabled={busy}
                  >
                    <FormField label="条件类型" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.kind}
                          options={[
                            { value: "event", label: "必须先发生某个事件" },
                            { value: "state", label: "必须满足某个状态" },
                            { value: "rule", label: "必须符合某条规则" },
                          ]}
                          onChange={(event) =>
                            updatePrerequisite(draft.id, "kind", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    {draft.kind === "event" ? (
                      <FormField label="前置事件" required>
                        {(fieldProps) => (
                          <Select
                            {...fieldProps}
                            value={draft.referenceId}
                            options={eventOptions}
                            placeholder="请选择已确认事件"
                            onChange={(event) =>
                              updatePrerequisite(draft.id, "referenceId", event.currentTarget.value)
                            }
                          />
                        )}
                      </FormField>
                    ) : (
                      <FormField label={draft.kind === "state" ? "状态名称" : "规则名称"} required>
                        {(fieldProps) => (
                          <Input
                            {...fieldProps}
                            value={draft.referenceLabel}
                            maxLength={200}
                            onChange={(event) =>
                              updatePrerequisite(
                                draft.id,
                                "referenceLabel",
                                event.currentTarget.value,
                              )
                            }
                          />
                        )}
                      </FormField>
                    )}
                    <FormField label="条件说明" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.description}
                          maxLength={1_000}
                          onChange={(event) =>
                            updatePrerequisite(draft.id, "description", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setPrerequisites((current) => current.filter(({ id }) => id !== draft.id))
                      }
                    >
                      删除前置条件
                    </Button>
                  </fieldset>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || prerequisites.length >= MAXIMUM_CAUSAL_EVENT_CHANGES}
                  onClick={addPrerequisite}
                >
                  添加前置条件
                </Button>
              </section>

              <section>
                <h4>人物状态变化</h4>
                {characterStateChanges.map((draft, index) => (
                  <fieldset
                    key={draft.id}
                    className="settings-grid"
                    aria-label={`人物状态变化 ${String(index + 1)}`}
                    disabled={busy}
                  >
                    <FormField label="人物" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.characterId}
                          options={characterOptions}
                          placeholder="请选择已确认人物"
                          onChange={(event) =>
                            updateCharacterStateChange(
                              draft.id,
                              "characterId",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="状态名称" hint="例如：是否受伤、身份、能力阶段" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.attributeLabel}
                          maxLength={200}
                          onChange={(event) =>
                            updateCharacterStateChange(
                              draft.id,
                              "attributeLabel",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="变化前" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.beforeValue}
                          maxLength={1_000}
                          onChange={(event) =>
                            updateCharacterStateChange(
                              draft.id,
                              "beforeValue",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="变化后" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.afterValue}
                          maxLength={1_000}
                          onChange={(event) =>
                            updateCharacterStateChange(
                              draft.id,
                              "afterValue",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setCharacterStateChanges((current) =>
                          current.filter(({ id }) => id !== draft.id),
                        )
                      }
                    >
                      删除人物状态变化
                    </Button>
                  </fieldset>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    busy ||
                    confirmedCharacters.length === 0 ||
                    characterStateChanges.length >= MAXIMUM_CAUSAL_EVENT_CHANGES
                  }
                  onClick={addCharacterStateChange}
                >
                  添加人物状态变化
                </Button>
              </section>

              <section>
                <h4>人物关系变化</h4>
                {relationshipChanges.map((draft, index) => (
                  <fieldset
                    key={draft.id}
                    className="settings-grid"
                    aria-label={`人物关系变化 ${String(index + 1)}`}
                    disabled={busy}
                  >
                    <FormField label="人物一" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.fromCharacterId}
                          options={characterOptions}
                          placeholder="请选择人物"
                          onChange={(event) =>
                            updateRelationshipChange(
                              draft.id,
                              "fromCharacterId",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="人物二" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.toCharacterId}
                          options={characterOptions}
                          placeholder="请选择不同人物"
                          onChange={(event) =>
                            updateRelationshipChange(
                              draft.id,
                              "toCharacterId",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="关系名称" hint="例如：信任程度、同盟关系" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.relationshipLabel}
                          maxLength={200}
                          onChange={(event) =>
                            updateRelationshipChange(
                              draft.id,
                              "relationshipLabel",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="变化前" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.beforeValue}
                          maxLength={1_000}
                          onChange={(event) =>
                            updateRelationshipChange(
                              draft.id,
                              "beforeValue",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="变化后" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.afterValue}
                          maxLength={1_000}
                          onChange={(event) =>
                            updateRelationshipChange(
                              draft.id,
                              "afterValue",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setRelationshipChanges((current) =>
                          current.filter(({ id }) => id !== draft.id),
                        )
                      }
                    >
                      删除人物关系变化
                    </Button>
                  </fieldset>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    busy ||
                    confirmedCharacters.length < 2 ||
                    relationshipChanges.length >= MAXIMUM_CAUSAL_EVENT_CHANGES
                  }
                  onClick={addRelationshipChange}
                >
                  添加人物关系变化
                </Button>
              </section>

              <section>
                <h4>物品变化</h4>
                {itemChanges.map((draft, index) => (
                  <fieldset
                    key={draft.id}
                    className="settings-grid"
                    aria-label={`物品变化 ${String(index + 1)}`}
                    disabled={busy}
                  >
                    <FormField label="物品名称" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.itemLabel}
                          maxLength={200}
                          onChange={(event) =>
                            updateItemChange(draft.id, "itemLabel", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="发生的变化" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.kind}
                          options={[
                            { value: "acquired", label: "取得" },
                            { value: "lost", label: "失去" },
                            { value: "transferred", label: "转移" },
                            { value: "created", label: "新出现" },
                            { value: "destroyed", label: "被毁或消失" },
                          ]}
                          onChange={(event) =>
                            updateItemChange(draft.id, "kind", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="原持有人" hint="新出现时留空">
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.fromCharacterId}
                          options={characterOptions}
                          placeholder="没有或不适用"
                          onChange={(event) =>
                            updateItemChange(draft.id, "fromCharacterId", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="新持有人" hint="被毁或消失时留空">
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.toCharacterId}
                          options={characterOptions}
                          placeholder="没有或不适用"
                          onChange={(event) =>
                            updateItemChange(draft.id, "toCharacterId", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setItemChanges((current) => current.filter(({ id }) => id !== draft.id))
                      }
                    >
                      删除物品变化
                    </Button>
                  </fieldset>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || itemChanges.length >= MAXIMUM_CAUSAL_EVENT_CHANGES}
                  onClick={addItemChange}
                >
                  添加物品变化
                </Button>
              </section>

              <section>
                <h4>伏笔推进</h4>
                {foreshadowProgress.map((draft, index) => (
                  <fieldset
                    key={draft.id}
                    className="settings-grid"
                    aria-label={`伏笔推进 ${String(index + 1)}`}
                    disabled={busy}
                  >
                    <FormField label="伏笔名称" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.foreshadowLabel}
                          maxLength={200}
                          onChange={(event) =>
                            updateForeshadowProgress(
                              draft.id,
                              "foreshadowLabel",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="推进阶段" required>
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={draft.kind}
                          options={[
                            { value: "planted", label: "埋设" },
                            { value: "advanced", label: "推进" },
                            { value: "revealed", label: "揭示" },
                            { value: "resolved", label: "回收" },
                            { value: "misdirected", label: "误导" },
                          ]}
                          onChange={(event) =>
                            updateForeshadowProgress(draft.id, "kind", event.currentTarget.value)
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="本次变化" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          value={draft.description}
                          maxLength={1_000}
                          onChange={(event) =>
                            updateForeshadowProgress(
                              draft.id,
                              "description",
                              event.currentTarget.value,
                            )
                          }
                        />
                      )}
                    </FormField>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setForeshadowProgress((current) =>
                          current.filter(({ id }) => id !== draft.id),
                        )
                      }
                    >
                      删除伏笔推进
                    </Button>
                  </fieldset>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || foreshadowProgress.length >= MAXIMUM_CAUSAL_EVENT_CHANGES}
                  onClick={addForeshadowProgress}
                >
                  添加伏笔推进
                </Button>
              </section>
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
              maxLength={2_000}
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
            (mode === "event"
              ? !eventReady || !knowledgeGainsReady || !structuredChangesReady
              : !relationReady)
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

function validateKnowledgeGainDrafts(
  drafts: readonly KnowledgeGainDraft[],
  informedCharacterIds: readonly string[],
): ReadonlyMap<number, KnowledgeGainDraftErrors> {
  const informed = new Set(informedCharacterIds);
  const signatures = new Map<string, number[]>();
  const errors = new Map<number, KnowledgeGainDraftErrors>();
  for (const draft of drafts) {
    const characterId = draft.characterId.trim();
    const knowledgeLabel = draft.knowledgeLabel.trim();
    const informationText = draft.informationText.trim();
    const current: {
      characterId?: string;
      knowledgeLabel?: string;
      informationText?: string;
    } = {};
    if (characterId.length === 0) {
      current.characterId = "请选择获得这条知识的人物。";
    } else if (!informed.has(characterId)) {
      current.characterId = "该人物不在本事件的知情范围中，请重新选择。";
    }
    if (knowledgeLabel.length === 0) current.knowledgeLabel = "请填写知识类别。";
    if (informationText.length === 0) current.informationText = "请填写人物得知的具体内容。";
    errors.set(draft.id, Object.freeze(current));

    if (Object.keys(current).length === 0) {
      const signature = `${characterId}\u0000${knowledgeLabel.normalize("NFKC").toLocaleLowerCase("zh-CN")}\u0000${informationText.normalize("NFKC").toLocaleLowerCase("zh-CN")}`;
      signatures.set(signature, [...(signatures.get(signature) ?? []), draft.id]);
    }
  }
  for (const duplicateIds of signatures.values()) {
    if (duplicateIds.length < 2) continue;
    duplicateIds.forEach((id) => {
      errors.set(
        id,
        Object.freeze({
          ...(errors.get(id) ?? {}),
          informationText: "这条人物与知识内容已经添加，请删除重复项。",
        }),
      );
    });
  }
  return errors;
}
