import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { MAX_NOVEL_SKILLS_PER_INVOCATION, type NovelSkillTask } from "@inkshadow/ai-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  InlineAlert,
  Input,
  Select,
  Textarea,
} from "@inkshadow/ui";

import type {
  CustomNovelSkillDraft,
  CustomNovelSkillImportPreview,
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

const EMPTY_DRAFT: CustomNovelSkillDraft = Object.freeze({
  displayName: "",
  summary: "",
  taskTypes: Object.freeze(["continuation"] as const),
  rules: Object.freeze([""]),
  prohibitions: Object.freeze([]),
  precedence: 500,
  projectScope: "current_project",
});

const TASK_OPTIONS = [
  ["idea_discussion", "讨论灵感"],
  ["book_start_guidance", "设计开头"],
  ["prose_generation", "生成正文"],
  ["continuation", "续写"],
  ["rewrite", "改写"],
  ["polish", "润色"],
  ["outline_planning", "故事规划"],
  ["scene_breakdown", "场景规划"],
  ["chapter_summary", "章节总结"],
  ["translation", "翻译"],
] as const;

export function NovelSkillPanel({ projectId, runtime, readonly = false }: NovelSkillPanelProps) {
  const [state, setState] = useState<NovelSkillProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "import" | null>(null);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomNovelSkillDraft>(EMPTY_DRAFT);
  const [naturalDescription, setNaturalDescription] = useState("");
  const [importSource, setImportSource] = useState("");
  const [importPreview, setImportPreview] = useState<CustomNovelSkillImportPreview | null>(null);
  const [exportedDocument, setExportedDocument] = useState<string | null>(null);
  const [currentTask, setCurrentTask] = useState<NovelSkillTask>("continuation");
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
      if (operationRevision.current === revision)
        setError(projectOrdinaryUiError(cause).description);
    } finally {
      if (operationRevision.current === revision) setLoading(false);
    }
  }, [projectId, runtime]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setBusySkillId(null);
        setEditorMode(null);
        setEditingSkillId(null);
        setExportedDocument(null);
        void load();
      }
    });
    return () => {
      active = false;
      operationRevision.current += 1;
    };
  }, [load]);

  async function toggle(method: NovelSkillProjectMethodView): Promise<void> {
    await runMethodOperation(method.skillId, () =>
      runtime.setMethodEnabled(projectId, method.skillId, !method.enabled),
    );
  }

  async function runMethodOperation(
    skillId: string,
    operation: () => Promise<NovelSkillProjectState>,
  ): Promise<void> {
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    setBusySkillId(skillId);
    try {
      const next = await operation();
      if (operationRevision.current === revision) {
        setState(next);
        setError(null);
      }
    } catch (cause: unknown) {
      if (operationRevision.current === revision)
        setError(projectOrdinaryUiError(cause).description);
    } finally {
      if (operationRevision.current === revision) setBusySkillId(null);
    }
  }

  function openCreate(): void {
    setEditorMode("create");
    setEditingSkillId(null);
    setDraft(EMPTY_DRAFT);
    setNaturalDescription("");
    setExportedDocument(null);
  }

  async function openEdit(method: NovelSkillProjectMethodView): Promise<void> {
    setBusySkillId(method.skillId);
    try {
      const serialized = await runtime.exportCustomSkill(projectId, method.skillId);
      const document = JSON.parse(serialized) as { readonly skill: CustomNovelSkillDraft };
      setDraft({ ...document.skill, projectScope: "current_project" });
      setEditingSkillId(method.skillId);
      setEditorMode("create");
      setError(null);
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusySkillId(null);
    }
  }

  function organizeNaturalDescription(): void {
    try {
      setDraft(runtime.organizeCustomSkillDraft(naturalDescription));
      setError(null);
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
    }
  }

  async function saveDraft(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const operation =
      editingSkillId === null
        ? runtime.createCustomSkill(projectId, normalizedDraft(draft))
        : runtime.updateCustomSkill(projectId, editingSkillId, normalizedDraft(draft));
    setBusySkillId(editingSkillId ?? "new-custom-skill");
    try {
      setState(await operation);
      setEditorMode(null);
      setEditingSkillId(null);
      setError(null);
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusySkillId(null);
    }
  }

  async function previewImport(): Promise<void> {
    setBusySkillId("import-preview");
    try {
      setImportPreview(await runtime.previewCustomSkillImport(projectId, importSource));
      setError(null);
    } catch (cause: unknown) {
      setImportPreview(null);
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusySkillId(null);
    }
  }

  async function confirmImport(resolution: "copy" | "replace"): Promise<void> {
    if (importPreview === null) return;
    setBusySkillId("import-confirm");
    try {
      setState(await runtime.importCustomSkill(projectId, importPreview, resolution));
      setEditorMode(null);
      setImportPreview(null);
      setImportSource("");
      setError(null);
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusySkillId(null);
    }
  }

  async function showExport(method: NovelSkillProjectMethodView): Promise<void> {
    setBusySkillId(method.skillId);
    try {
      setExportedDocument(await runtime.exportCustomSkill(projectId, method.skillId));
      setError(null);
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setBusySkillId(null);
    }
  }

  const methods = state?.methods ?? [];
  const enabled = methods.filter((method) => method.enabled && !method.archived);
  const builtIn = methods.filter(({ ownerScope }) => ownerScope === "builtin");
  const mine = methods.filter(({ ownerScope }) => ownerScope === "user");

  return (
    <section aria-labelledby="novel-skill-panel-title" className="settings-section">
      <div className="section-heading">
        <div>
          <h2 id="novel-skill-panel-title">写作技能</h2>
          <p>按当前项目启用。每次生成都会记录本次实际采用、未采用技能及其原因。</p>
        </div>
        {state?.availability.status === "ready" && (
          <Badge tone={enabled.length > 0 ? "warning" : "neutral"}>{enabled.length} 项已启用</Badge>
        )}
      </div>

      <InlineAlert
        tone="info"
        title="只采用你明确启用的技能"
        description={`写作技能不会覆盖正文、正式设定或本次任务，也不能改变私密章节和发送确认规则。本次最多参考的写作技能数量：${String(MAX_NOVEL_SKILLS_PER_INVOCATION)} 项。`}
      />

      {error !== null && (
        <InlineAlert
          tone="error"
          title="写作技能操作未完成"
          description={error}
          action={{ label: "重新读取", onClick: () => void load() }}
          onDismiss={() => setError(null)}
        />
      )}

      {(state?.isolatedRecords?.length ?? 0) > 0 && (
        <InlineAlert
          tone="warning"
          title={`${String(state?.isolatedRecords?.length ?? 0)} 项自定义技能记录暂不可用`}
          description="损坏记录已隔离，不会阻断正文或其他技能。你可以从原导出文件重新导入，或复制现有可读版本创建修复项；原记录没有被删除。"
          action={{
            label: "导入修复文件",
            onClick: () => {
              setEditorMode("import");
              setImportPreview(null);
            },
          }}
        />
      )}

      {loading && state === null ? (
        <p role="status">正在读取写作技能…</p>
      ) : state?.availability.status !== "ready" ? (
        <InlineAlert
          tone="info"
          title="本环境未应用写作技能"
          description={state?.availability.reason ?? "写作技能当前不可用；正文和已有版本不受影响。"}
        />
      ) : methods.length === 0 ? (
        <EmptyState
          title="还没有可用的写作技能"
          description="内置技能没有完成初始化。基础写作仍可使用，请重新打开桌面版后再试。"
        />
      ) : (
        <>
          <FormField
            label="当前要做的事"
            hint="切换后会在每项技能的开关旁直接说明它是否适用于这次任务。"
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={currentTask}
                options={TASK_OPTIONS.map(([value, label]) => ({ value, label }))}
                onChange={(event) => setCurrentTask(event.currentTarget.value as NovelSkillTask)}
              />
            )}
          </FormField>
          <section aria-labelledby="enabled-writing-skills">
            <h3 id="enabled-writing-skills">当前项目已启用</h3>
            {enabled.length === 0 ? (
              <p className="candidate-panel__hint">当前项目尚未启用写作技能。</p>
            ) : (
              <ul>
                {enabled.map((method) => (
                  <li key={method.skillId}>{method.displayName}</li>
                ))}
              </ul>
            )}
          </section>

          <div className="editor-toolbar-actions">
            <Button size="sm" disabled={readonly || busySkillId !== null} onClick={openCreate}>
              创建技能
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={readonly || busySkillId !== null}
              onClick={() => {
                setEditorMode("import");
                setImportPreview(null);
                setExportedDocument(null);
              }}
            >
              导入技能
            </Button>
          </div>

          {editorMode === "create" && (
            <CustomSkillEditor
              draft={draft}
              naturalDescription={naturalDescription}
              editing={editingSkillId !== null}
              busy={busySkillId !== null}
              onDraftChange={setDraft}
              onNaturalDescriptionChange={setNaturalDescription}
              onOrganize={organizeNaturalDescription}
              onSubmit={(event) => void saveDraft(event)}
              onCancel={() => setEditorMode(null)}
            />
          )}

          {editorMode === "import" && (
            <Card>
              <CardHeader>
                <CardTitle>导入写作技能</CardTitle>
              </CardHeader>
              <CardContent>
                <FormField
                  label="技能文件内容"
                  hint="只接受墨影写作技能格式；导入前仅预览，不保存也不执行任何脚本。"
                >
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      value={importSource}
                      onChange={(event) => setImportSource(event.currentTarget.value)}
                      rows={8}
                    />
                  )}
                </FormField>
                <div className="editor-toolbar-actions">
                  <Button
                    size="sm"
                    loading={busySkillId === "import-preview"}
                    onClick={() => void previewImport()}
                  >
                    预览导入
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditorMode(null)}>
                    取消
                  </Button>
                </div>
                {importPreview !== null && (
                  <InlineAlert
                    tone={importPreview.conflict ? "warning" : "info"}
                    title={`准备导入“${importPreview.document.skill.displayName}”`}
                    description={
                      importPreview.conflict
                        ? "检测到它来自已存在的同一项技能。请选择保存副本或用新版本替换。"
                        : importPreview.document.skill.summary
                    }
                    action={{
                      label: importPreview.conflict ? "保存为副本" : "确认导入",
                      onClick: () => void confirmImport("copy"),
                    }}
                  />
                )}
                {importPreview?.conflict === true && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busySkillId === "import-confirm"}
                    onClick={() => void confirmImport("replace")}
                  >
                    用新版本替换
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {exportedDocument !== null && (
            <FormField label="导出的写作技能" hint="复制并保存为 UTF-8 文本即可再次导入。">
              {(fieldProps) => (
                <Textarea {...fieldProps} readOnly value={exportedDocument} rows={8} />
              )}
            </FormField>
          )}

          <MethodSection
            title="内置技能"
            methods={builtIn}
            readonly={readonly}
            busySkillId={busySkillId}
            currentTask={currentTask}
            onToggle={(method) => void toggle(method)}
          />
          <MethodSection
            title="我的技能"
            methods={mine}
            readonly={readonly}
            busySkillId={busySkillId}
            currentTask={currentTask}
            onToggle={(method) => void toggle(method)}
            onEdit={(method) => void openEdit(method)}
            onDuplicate={(method) =>
              void runMethodOperation(method.skillId, () =>
                runtime.duplicateCustomSkill(projectId, method.skillId),
              )
            }
            onArchive={(method) =>
              void runMethodOperation(method.skillId, () =>
                runtime.archiveCustomSkill(projectId, method.skillId),
              )
            }
            onExport={(method) => void showExport(method)}
          />
        </>
      )}
    </section>
  );
}

function MethodSection({
  title,
  methods,
  readonly,
  busySkillId,
  currentTask,
  onToggle,
  onEdit,
  onDuplicate,
  onArchive,
  onExport,
}: Readonly<{
  title: string;
  methods: readonly NovelSkillProjectMethodView[];
  readonly: boolean;
  busySkillId: string | null;
  currentTask: NovelSkillTask;
  onToggle(method: NovelSkillProjectMethodView): void;
  onEdit?(method: NovelSkillProjectMethodView): void;
  onDuplicate?(method: NovelSkillProjectMethodView): void;
  onArchive?(method: NovelSkillProjectMethodView): void;
  onExport?(method: NovelSkillProjectMethodView): void;
}>) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {methods.length === 0 ? (
        <p className="candidate-panel__hint">这里还没有技能。</p>
      ) : (
        <div className="story-governance-grid">
          {methods.map((method) => (
            <Card key={method.skillId}>
              <CardHeader>
                <div className="card-heading-row">
                  <CardTitle>{method.displayName}</CardTitle>
                  <Badge
                    tone={method.archived ? "neutral" : method.enabled ? "success" : "neutral"}
                  >
                    {method.archived ? "已归档" : method.enabled ? "已启用" : "未启用"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>{method.summary}</p>
                <p className="candidate-panel__hint">
                  {method.ownerScope === "user"
                    ? "我的技能"
                    : method.kind === "genre"
                      ? "题材技能"
                      : "通用技能"}{" "}
                  · 版本 {method.version} · 适用于：{taskTypeLabels(method.taskTypes)}
                </p>
                <p className="candidate-panel__hint">
                  {method.taskTypes.includes(currentTask)
                    ? `适用于当前任务：${taskTypeLabel(currentTask)}`
                    : "不适用于当前任务"}
                </p>
                <div className="editor-toolbar-actions">
                  {!method.archived && (
                    <Button
                      size="sm"
                      variant={method.enabled ? "secondary" : "primary"}
                      loading={busySkillId === method.skillId}
                      disabled={readonly || busySkillId !== null}
                      onClick={() => onToggle(method)}
                    >
                      {method.enabled ? `停用${method.displayName}` : `启用${method.displayName}`}
                    </Button>
                  )}
                  {onEdit !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readonly || busySkillId !== null}
                      onClick={() => onEdit(method)}
                    >
                      编辑
                    </Button>
                  )}
                  {onDuplicate !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readonly || busySkillId !== null}
                      onClick={() => onDuplicate(method)}
                    >
                      复制
                    </Button>
                  )}
                  {onExport !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busySkillId !== null}
                      onClick={() => onExport(method)}
                    >
                      导出
                    </Button>
                  )}
                  {onArchive !== undefined && !method.archived && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readonly || busySkillId !== null}
                      onClick={() => onArchive(method)}
                    >
                      归档
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function CustomSkillEditor({
  draft,
  naturalDescription,
  editing,
  busy,
  onDraftChange,
  onNaturalDescriptionChange,
  onOrganize,
  onSubmit,
  onCancel,
}: Readonly<{
  draft: CustomNovelSkillDraft;
  naturalDescription: string;
  editing: boolean;
  busy: boolean;
  onDraftChange(value: CustomNovelSkillDraft): void;
  onNaturalDescriptionChange(value: string): void;
  onOrganize(): void;
  onSubmit(event: SyntheticEvent<HTMLFormElement>): void;
  onCancel(): void;
}>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? "编辑写作技能" : "创建写作技能"}</CardTitle>
      </CardHeader>
      <CardContent>
        <FormField label="用自然语言描述" hint="整理完全在本机完成，不会发送正文或技能内容。">
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              value={naturalDescription}
              maxLength={8_000}
              rows={4}
              onChange={(event) => onNaturalDescriptionChange(event.currentTarget.value)}
            />
          )}
        </FormField>
        <Button
          size="sm"
          variant="secondary"
          disabled={naturalDescription.trim().length === 0}
          onClick={onOrganize}
        >
          本地整理成表单
        </Button>
        <form onSubmit={onSubmit}>
          <FormField label="技能名称" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={draft.displayName}
                maxLength={120}
                onChange={(event) =>
                  onDraftChange({ ...draft, displayName: event.currentTarget.value })
                }
              />
            )}
          </FormField>
          <FormField label="用途说明" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={draft.summary}
                maxLength={500}
                rows={3}
                onChange={(event) =>
                  onDraftChange({ ...draft, summary: event.currentTarget.value })
                }
              />
            )}
          </FormField>
          <fieldset>
            <legend>适用任务</legend>
            {TASK_OPTIONS.map(([task, label]) => (
              <label key={task}>
                <input
                  type="checkbox"
                  checked={draft.taskTypes.includes(task)}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      taskTypes: event.currentTarget.checked
                        ? [...draft.taskTypes, task]
                        : draft.taskTypes.filter((entry) => entry !== task),
                    })
                  }
                />{" "}
                {label}
              </label>
            ))}
          </fieldset>
          <FormField label="写作规则" hint="每行一条，最多 16 条。" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={draft.rules.join("\n")}
                rows={5}
                onChange={(event) =>
                  onDraftChange({ ...draft, rules: event.currentTarget.value.split(/\r?\n/u) })
                }
              />
            )}
          </FormField>
          <FormField label="不允许做的事" hint="每行一条；不能修改系统、隐私或发送规则。">
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={draft.prohibitions.join("\n")}
                rows={4}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    prohibitions: event.currentTarget.value.split(/\r?\n/u),
                  })
                }
              />
            )}
          </FormField>
          <FormField label="优先级" hint="高优先级先参考，但始终低于正文、正式设定和当前任务。">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={String(draft.precedence)}
                options={[
                  { value: "450", label: "较低" },
                  { value: "500", label: "普通" },
                  { value: "550", label: "较高" },
                ]}
                onChange={(event) =>
                  onDraftChange({ ...draft, precedence: Number(event.currentTarget.value) })
                }
              />
            )}
          </FormField>
          <p className="candidate-panel__hint">适用项目范围：当前项目</p>
          <div className="editor-toolbar-actions">
            <Button type="submit" size="sm" loading={busy}>
              {editing ? "保存新版本" : "创建技能"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function normalizedDraft(draft: CustomNovelSkillDraft): CustomNovelSkillDraft {
  return {
    ...draft,
    taskTypes: [...new Set(draft.taskTypes)],
    rules: draft.rules.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    prohibitions: draft.prohibitions
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  };
}

function taskTypeLabels(taskTypes: readonly NovelSkillTask[]): string {
  return TASK_OPTIONS.filter(([task]) => taskTypes.includes(task))
    .map(([, label]) => label)
    .join("、");
}

function taskTypeLabel(taskType: NovelSkillTask): string {
  return TASK_OPTIONS.find(([task]) => task === taskType)?.[1] ?? "当前任务";
}
