import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  InlineAlert,
  Input,
} from "@inkshadow/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  type ApplyPublishedStudioTeamTemplateOutcome,
  type DecryptedStudioTeamTemplateListItem,
  type StudioTeamTemplateApplicationPartialRetry,
  type StudioTeamTemplateCoordinator,
  StudioTeamTemplateCoordinatorError,
  type StudioTeamTemplateHistoryExport,
} from "../infrastructure/studio-team-template-coordinator";
import {
  STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION,
  StudioTeamTemplateCryptoError,
} from "../infrastructure/studio-team-template-crypto";
import {
  type StudioTeamTemplateSessionContext,
  StudioTeamTemplateServiceError,
} from "../infrastructure/studio-team-template-service";

export type StudioTeamTemplatesPageCoordinator = Pick<
  StudioTeamTemplateCoordinator,
  | "applyPublished"
  | "archiveTemplate"
  | "capabilities"
  | "clonePublished"
  | "createDraft"
  | "exportTemplateHistory"
  | "listTemplates"
  | "publishDraft"
  | "retryApplicationRecord"
>;

export interface StudioTeamTemplatesPageProps {
  readonly coordinator: StudioTeamTemplatesPageCoordinator;
  readonly context: StudioTeamTemplateSessionContext;
  readonly online: boolean;
  readonly mutationFeatureEnabled: boolean;
  readonly projectWritable?: boolean;
  readonly expectedProjectRevision: number;
  readonly onProjectRevisionAdvanced?: (revision: number) => void;
  readonly onExportHistory?: (history: StudioTeamTemplateHistoryExport) => void | Promise<void>;
}

type PageState =
  "loading" | "empty" | "ready" | "offline" | "forbidden" | "readonly" | "conflict" | "error";

interface VisibleFailure {
  readonly code: string;
  readonly message: string;
}

export function StudioTeamTemplatesPage({
  coordinator,
  context,
  online,
  mutationFeatureEnabled,
  projectWritable = true,
  expectedProjectRevision,
  onProjectRevisionAdvanced,
  onExportHistory,
}: StudioTeamTemplatesPageProps) {
  const capabilities = useMemo(() => {
    const available = coordinator.capabilities(context);
    if (mutationFeatureEnabled && projectWritable) {
      return available;
    }
    return Object.freeze({
      ...available,
      create: false,
      createVersion: false,
      clone: false,
      apply: false,
      publish: false,
      archive: false,
    });
  }, [context, coordinator, mutationFeatureEnabled, projectWritable]);
  const readOnly =
    capabilities.read &&
    !capabilities.create &&
    !capabilities.clone &&
    !capabilities.apply &&
    !capabilities.publish &&
    !capabilities.archive;
  const [state, setState] = useState<PageState>("loading");
  const [items, setItems] = useState<readonly DecryptedStudioTeamTemplateListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<VisibleFailure | null>(null);
  const [partial, setPartial] = useState<StudioTeamTemplateApplicationPartialRetry | null>(null);
  const operationAbort = useRef<AbortController | null>(null);
  const seenCursors = useRef(new Set<string>());

  const load = useCallback(async () => {
    operationAbort.current?.abort();
    setFailure(null);
    setPartial(null);
    if (!online) {
      setState("offline");
      return;
    }
    if (!capabilities.read) {
      setState("forbidden");
      return;
    }
    const abort = new AbortController();
    operationAbort.current = abort;
    setState("loading");
    try {
      const listed = await coordinator.listTemplates(context, {
        limit: 50,
        signal: abort.signal,
      });
      if (abort.signal.aborted) {
        return;
      }
      setItems(listed.items);
      setCursor(listed.nextCursor);
      seenCursors.current = new Set(listed.nextCursor === null ? [] : [listed.nextCursor]);
      setState(listed.items.length === 0 ? "empty" : readOnly ? "readonly" : "ready");
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        applyFailure(error, setState, setFailure);
      }
    } finally {
      if (operationAbort.current === abort) {
        operationAbort.current = null;
      }
    }
  }, [capabilities.read, context, coordinator, online, readOnly]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => operationAbort.current?.abort();
  }, [load]);

  async function runOperation(
    label: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    operationAbort.current?.abort();
    const abort = new AbortController();
    operationAbort.current = abort;
    setBusy(label);
    setFailure(null);
    let succeeded = false;
    try {
      await operation(abort.signal);
      succeeded = true;
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        applyFailure(error, setState, setFailure);
      }
    } finally {
      if (operationAbort.current === abort) {
        operationAbort.current = null;
        setBusy(null);
      }
    }
    return succeeded;
  }

  async function createDraft(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) {
      setFailure({
        code: "TEAM_TEMPLATE_TITLE_REQUIRED",
        message: "创建草稿前请输入私密模板标题。",
      });
      return;
    }
    const created = await runOperation("create", async (signal) => {
      await coordinator.createDraft(
        context,
        {
          schemaVersion: STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION,
          kind: "team_template",
          title: normalizedTitle,
          projectSettings: [],
          promptRegistryRefs: [],
          promptRules: [],
          reviewChecklist: [],
        },
        signal,
      );
      setTitle("");
    });
    if (created) {
      await load();
    }
  }

  async function mutateAndReload(
    label: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    const mutated = await runOperation(label, async (signal) => {
      await operation(signal);
    });
    if (mutated) {
      await load();
    }
  }

  async function applyTemplate(item: DecryptedStudioTeamTemplateListItem): Promise<void> {
    if (item.state !== "ready") {
      return;
    }
    await runOperation(`apply:${item.template.templateId}`, async (signal) => {
      const outcome = await coordinator.applyPublished(
        context,
        {
          templateId: item.template.templateId,
          expectedProjectRevision,
        },
        signal,
      );
      handleApplicationOutcome(outcome);
    });
  }

  async function retryCloudRecord(): Promise<void> {
    if (partial === null) {
      return;
    }
    await runOperation("retry-cloud-record", async (signal) => {
      const outcome = await coordinator.retryApplicationRecord(context, partial, signal);
      handleApplicationOutcome(outcome);
    });
  }

  function handleApplicationOutcome(outcome: ApplyPublishedStudioTeamTemplateOutcome): void {
    if (outcome.status === "partial_retry") {
      setPartial(outcome);
      setState("error");
      setFailure({
        code: outcome.failureCode,
        message: "模板已安全提交到本地，只剩云端元数据回执待确认；重试不会重复应用模板。",
      });
      onProjectRevisionAdvanced?.(outcome.receipt.projectRevisionAfter);
      return;
    }
    setPartial(null);
    setFailure(null);
    setState(readOnly ? "readonly" : "ready");
    onProjectRevisionAdvanced?.(outcome.receipt.projectRevisionAfter);
  }

  async function loadMore(): Promise<void> {
    if (cursor === null) {
      return;
    }
    await runOperation("load-more", async (signal) => {
      const listed = await coordinator.listTemplates(context, {
        cursor,
        limit: 50,
        signal,
      });
      if (listed.nextCursor !== null && seenCursors.current.has(listed.nextCursor)) {
        throw new StudioTeamTemplateCoordinatorError(
          "TEAM_TEMPLATE_PAGINATION_INVALID",
          "团队模板分页返回了重复游标。",
        );
      }
      if (listed.nextCursor !== null) {
        seenCursors.current.add(listed.nextCursor);
      }
      const known = new Set(items.map(({ template }) => template.templateId));
      const appended = listed.items.filter(({ template }) => !known.has(template.templateId));
      setItems(Object.freeze([...items, ...appended]));
      setCursor(listed.nextCursor);
      setState(readOnly ? "readonly" : "ready");
    });
  }

  async function exportHistory(item: DecryptedStudioTeamTemplateListItem): Promise<void> {
    await runOperation(`export:${item.template.templateId}`, async (signal) => {
      const history = await coordinator.exportTemplateHistory(
        context,
        item.template.templateId,
        signal,
      );
      if (onExportHistory !== undefined) {
        await onExportHistory(history);
      } else {
        downloadHistory(history);
      }
    });
  }

  if (state === "offline") {
    return (
      <EmptyState
        kind="offline"
        headingLevel={1}
        title="团队模板当前离线"
        description="离线时不会伪造远端成功。重新联网后才能读取或修改加密团队模板。"
      />
    );
  }
  if (state === "forbidden") {
    return (
      <EmptyState
        kind="forbidden"
        headingLevel={1}
        title="无权访问团队模板"
        description="当前角色或项目权限不允许读取这个项目的团队模板。"
      />
    );
  }
  if (state === "loading") {
    return (
      <section role="status" aria-label="正在读取加密团队模板">
        正在读取加密团队模板…
      </section>
    );
  }
  if (state === "empty") {
    return (
      <section data-page-state="empty">
        <PageHeader />
        {!mutationFeatureEnabled && <RolloutNotice />}
        <EmptyState
          headingLevel={2}
          title="还没有团队模板"
          description="这个项目中还没有加密团队模板。"
        />
        {capabilities.create && (
          <CreateDraftForm
            title={title}
            busy={busy}
            setTitle={setTitle}
            submit={(event) => void createDraft(event)}
          />
        )}
      </section>
    );
  }

  const visibleState = state === "conflict" ? "conflict" : readOnly ? "readonly" : state;
  return (
    <section data-page-state={visibleState} aria-label="加密团队模板">
      <PageHeader />
      {!mutationFeatureEnabled && <RolloutNotice />}
      {readOnly && (
        <InlineAlert
          title="模板历史为只读"
          description="当前角色可以解密并查看这个项目的模板历史，但不能创建、克隆、应用、发布或归档。"
        />
      )}
      {failure !== null && (
        <InlineAlert
          tone="error"
          title="团队模板操作未完成"
          description={`${failure.message}（${failure.code}）`}
          {...(partial === null
            ? {}
            : {
                action: {
                  label: "仅重试云端回执",
                  onClick: () => void retryCloudRecord(),
                },
              })}
        />
      )}
      {capabilities.create && (
        <CreateDraftForm
          title={title}
          busy={busy}
          setTitle={setTitle}
          submit={(event) => void createDraft(event)}
        />
      )}
      <div className="studio-team-templates-page__grid">
        {items.map((item) => (
          <TemplateCard
            key={item.template.templateId}
            item={item}
            busy={busy}
            canApply={capabilities.apply}
            canArchive={capabilities.archive}
            canClone={capabilities.clone}
            canPublish={capabilities.publish}
            apply={() => applyTemplate(item)}
            archive={() =>
              mutateAndReload(`archive:${item.template.templateId}`, (signal) =>
                coordinator.archiveTemplate(context, item.template.templateId, signal),
              )
            }
            clone={() =>
              mutateAndReload(`clone:${item.template.templateId}`, (signal) =>
                coordinator.clonePublished(context, item.template.templateId, signal),
              )
            }
            exportHistory={() => exportHistory(item)}
            publish={() =>
              mutateAndReload(`publish:${item.template.templateId}`, (signal) =>
                coordinator.publishDraft(context, item.template.templateId, signal),
              )
            }
          />
        ))}
      </div>
      {cursor !== null && (
        <Button
          type="button"
          variant="secondary"
          loading={busy === "load-more"}
          disabled={busy !== null}
          onClick={() => void loadMore()}
        >
          加载更多模板
        </Button>
      )}
    </section>
  );
}

function PageHeader() {
  return (
    <header>
      <h1>加密团队模板</h1>
      <p>标题、项目设置、提示词规则和审阅清单只会使用项目密钥在当前设备上解密。</p>
    </header>
  );
}

function RolloutNotice() {
  return (
    <InlineAlert
      tone="warning"
      title="团队模板变更尚未启用"
      description="加密历史记录仍可读取；功能正式开放前，创建和修改操作保持关闭。"
    />
  );
}

function CreateDraftForm(props: {
  readonly title: string;
  readonly busy: string | null;
  readonly setTitle: (title: string) => void;
  readonly submit: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>创建加密草稿</CardTitle>
        <CardDescription>私密标题会在任何云请求发出前完成加密。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={props.submit}>
          <FormField label="私密模板标题" required>
            {({ id }) => (
              <Input
                id={id}
                value={props.title}
                maxLength={120}
                disabled={props.busy !== null}
                onChange={(event) => props.setTitle(event.currentTarget.value)}
              />
            )}
          </FormField>
          <Button
            type="submit"
            loading={props.busy === "create"}
            disabled={props.busy !== null || props.title.trim().length === 0}
          >
            加密并创建草稿
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TemplateCard(props: {
  readonly item: DecryptedStudioTeamTemplateListItem;
  readonly busy: string | null;
  readonly canApply: boolean;
  readonly canArchive: boolean;
  readonly canClone: boolean;
  readonly canPublish: boolean;
  readonly apply: () => void;
  readonly archive: () => void;
  readonly clone: () => void;
  readonly exportHistory: () => void;
  readonly publish: () => void;
}) {
  const { item } = props;
  const disabled = props.busy !== null || item.state !== "ready";
  return (
    <Card data-template-id={item.template.templateId}>
      <CardHeader>
        <div>
          <Badge tone={stateTone(item.template.state)}>
            {templateStateLabel(item.template.state)}
          </Badge>
          <Badge tone="neutral">v{item.displayVersion.versionNumber}</Badge>
        </div>
        {item.state === "ready" ? (
          <CardTitle headingLevel={2}>{item.payload.title}</CardTitle>
        ) : (
          <>
            <CardTitle headingLevel={2}>无法解密此模板</CardTitle>
            <CardDescription>
              <code>{item.errorCode}</code>
            </CardDescription>
          </>
        )}
      </CardHeader>
      <CardContent>
        {item.state === "ready" && (
          <p>
            {item.payload.projectSettings.length} 项设置 · {item.payload.promptRules.length}{" "}
            条提示词规则 · {item.payload.reviewChecklist.length} 个审阅项
          </p>
        )}
        <div>
          {item.template.state === "draft" && props.canPublish && (
            <Button
              type="button"
              disabled={disabled}
              loading={props.busy === `publish:${item.template.templateId}`}
              onClick={props.publish}
            >
              发布最新版本
            </Button>
          )}
          {item.template.state === "published" && props.canApply && (
            <Button
              type="button"
              disabled={disabled}
              loading={props.busy === `apply:${item.template.templateId}`}
              onClick={props.apply}
            >
              应用一次到项目
            </Button>
          )}
          {item.template.state === "published" && props.canClone && (
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              loading={props.busy === `clone:${item.template.templateId}`}
              onClick={props.clone}
            >
              克隆为草稿
            </Button>
          )}
          {item.template.state !== "archived" && props.canArchive && (
            <Button
              type="button"
              variant="danger"
              disabled={disabled}
              loading={props.busy === `archive:${item.template.templateId}`}
              onClick={props.archive}
            >
              归档
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={props.busy !== null}
            loading={props.busy === `export:${item.template.templateId}`}
            onClick={props.exportHistory}
          >
            导出版本历史
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function applyFailure(
  error: unknown,
  setState: (state: PageState) => void,
  setFailure: (failure: VisibleFailure | null) => void,
): void {
  const code = errorCode(error);
  if (isAbortError(error)) {
    return;
  }
  if (code === "TEAM_TEMPLATE_OFFLINE") {
    setState("offline");
    setFailure(null);
    return;
  }
  if (code === "TEAM_TEMPLATE_PERMISSION_DENIED" || code === "ACCESS_FORBIDDEN") {
    setState("forbidden");
    setFailure(null);
    return;
  }
  if (code.includes("REVISION_CONFLICT")) {
    setState("conflict");
    setFailure({
      code,
      message: "模板或项目版本已经变化，请重新加载后再试。",
    });
    return;
  }
  setState("error");
  setFailure({
    code,
    message: visibleFailureMessage(error),
  });
}

function visibleFailureMessage(error: unknown): string {
  const code = errorCode(error);
  const knownMessages: Record<string, string> = {
    ACCESS_FORBIDDEN: "当前账户无权执行此团队模板操作。",
    TEAM_TEMPLATE_OFFLINE: "当前处于离线状态，请联网后重试。",
    TEAM_TEMPLATE_PERMISSION_DENIED: "当前团队角色或项目权限不允许执行此操作。",
    TEAM_TEMPLATE_REVISION_CONFLICT: "模板或项目版本已经变化，请重新加载后再试。",
  };
  const known = knownMessages[code];
  if (known !== undefined) {
    return known;
  }
  if (
    error instanceof StudioTeamTemplateCryptoError ||
    error instanceof StudioTeamTemplateCoordinatorError ||
    error instanceof StudioTeamTemplateServiceError
  ) {
    return "团队模板未能通过安全校验，请重新加载后再试。";
  }
  return "加密团队模板操作未完成，未暴露任何私密内容。";
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return isAbortError(error) ? "TEAM_TEMPLATE_ABORTED" : "TEAM_TEMPLATE_UNAVAILABLE";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function stateTone(state: DecryptedStudioTeamTemplateListItem["template"]["state"]) {
  switch (state) {
    case "draft":
      return "info" as const;
    case "published":
      return "success" as const;
    case "archived":
      return "neutral" as const;
  }
}

function templateStateLabel(
  state: DecryptedStudioTeamTemplateListItem["template"]["state"],
): string {
  const labels: Record<DecryptedStudioTeamTemplateListItem["template"]["state"], string> = {
    archived: "已归档",
    draft: "草稿",
    published: "已发布",
  };
  return labels[state];
}

function downloadHistory(history: StudioTeamTemplateHistoryExport): void {
  const blob = new Blob([JSON.stringify(history, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `inkshadow-team-template-${history.template.templateId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
