import { Button, InkIcon, InlineAlert } from "@inkshadow/ui";
import { parseUuidV7, type Chapter, type Project, type UuidV7 } from "@inkshadow/domain";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { loadEditorView, type EditorViewState } from "../infrastructure/editor-view-state-store";
import type { DesktopRuntime } from "../infrastructure/runtime";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useWritingExperience } from "../hooks/use-writing-experience";
import { useRuntime } from "../runtime-context";

const creationEntries = [
  {
    to: "/create/idea",
    eyebrow: "推荐首次使用",
    title: "从一个想法开始",
    description: "写下一句话，AI 会先给你三种彼此隔离的开头方案，再一次只和你确认一个问题。",
    action: "说出我的想法",
    icon: "sparkles",
    primary: true,
  },
  {
    to: "/create/import",
    eyebrow: "已有小说",
    title: "导入小说，继续写或改写",
    description: "先分析作品和试改一小段，确认方向后再逐章处理，原文始终保留。",
    action: "选择作品",
    icon: "upload",
    primary: false,
  },
  {
    to: "/create/professional",
    eyebrow: "准备充分",
    title: "专业创建",
    description: "从人物、世界、剧情规划和写作规则开始，按自己的方式深入控制。",
    action: "开始专业创建",
    icon: "alert-triangle",
    primary: false,
  },
] as const;

interface RecentWritingTarget {
  readonly project: Project;
  readonly chapter: Chapter;
  readonly activityAt: number;
  readonly editorView: EditorViewState | null;
}

interface RecentWritingResolution {
  readonly target: RecentWritingTarget | null;
  readonly identityReadFailed: boolean;
}

const RECENT_WRITING_IDENTITY_WARNING =
  "有一项作品的显示信息暂时无法读取，已跳过该项。其他作者作品仍可继续打开。";

export function StartPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const writingExperience = useWritingExperience();
  const [exampleBusy, setExampleBusy] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const [recentWriting, setRecentWriting] = useState<RecentWritingTarget | null>(null);
  const [recentWritingError, setRecentWritingError] = useState<string | null>(null);
  const directMode = writingExperience.preference?.mode === "direct";

  useEffect(() => {
    let active = true;
    void findRecentWriting(runtime)
      .then((resolution) => {
        if (active) {
          setRecentWriting(resolution.target);
          setRecentWritingError(
            resolution.identityReadFailed ? RECENT_WRITING_IDENTITY_WARNING : null,
          );
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setRecentWriting(null);
          setRecentWritingError(normalizeUiError(cause).description);
        }
      });
    return () => {
      active = false;
    };
  }, [runtime]);

  async function openExampleProject(): Promise<void> {
    if (exampleBusy) {
      return;
    }
    setExampleBusy(true);
    setExampleError(null);
    try {
      const workspace = await resolveExampleWorkspace(runtime);
      rememberExamplePointer(workspace.project.id, workspace.chapter.id);
      void navigate(`/projects/${workspace.project.id}/chapters/${workspace.chapter.id}`);
    } catch (cause: unknown) {
      setExampleError(normalizeUiError(cause).description);
    } finally {
      setExampleBusy(false);
    }
  }

  return (
    <div className="start-page">
      <header className="start-page__header" aria-labelledby="start-heading">
        <h1 id="start-heading">
          {directMode ? "开始写你的故事" : "把你的第一个想法，写成一个故事"}
        </h1>
        <p>
          {directMode
            ? "写下一句话，墨影会先为你准备一个开头，再由你查看并决定是否使用。"
            : "无需注册，本地保存。连接你自己的 AI 模型后，续写、改写与检查都由你掌控。"}
        </p>
      </header>

      {writingExperience.loading && writingExperience.preference === null ? (
        <p role="status">正在读取本机写作方式……</p>
      ) : directMode ? (
        <section className="start-page__recent" aria-labelledby="direct-writing-title">
          <div className="start-page__recent-copy">
            <p className="start-page__recent-eyebrow">新作品</p>
            <h2 id="direct-writing-title">从一句话开始</h2>
            <p className="start-page__entry-description">
              不用先填写人物、设定或大纲，想到什么就写什么。
            </p>
          </div>
          <Link className="start-page__continue-link" to="/create/idea">
            开始创作
            <span aria-hidden="true">→</span>
          </Link>
        </section>
      ) : (
        <section className="start-page__entries" aria-label="选择创作方式">
          {creationEntries.map((entry) => (
            <Link
              className={`start-page__entry${entry.primary ? " start-page__entry--primary" : ""}`}
              key={entry.to}
              to={entry.to}
            >
              <span className="start-page__entry-mark" aria-hidden="true">
                <InkIcon name={entry.icon} decorative size={24} />
              </span>
              <span className="start-page__entry-copy">
                <span className="start-page__entry-eyebrow">{entry.eyebrow}</span>
                <span className="start-page__entry-title">{entry.title}</span>
                <span className="start-page__entry-description">{entry.description}</span>
              </span>
              <span className="start-page__entry-action" aria-hidden="true">
                {entry.action}
                <span>→</span>
              </span>
            </Link>
          ))}
        </section>
      )}

      {writingExperience.error !== null && (
        <InlineAlert
          tone="warning"
          title="写作方式暂时无法读取"
          description={`${writingExperience.error} 为避免自动应用建议，当前按专业模式显示。`}
        />
      )}

      {recentWriting !== null && (
        <section className="start-page__recent" aria-labelledby="recent-writing-title">
          <div className="start-page__recent-copy">
            <p className="start-page__recent-eyebrow">继续上次创作</p>
            <h2 id="recent-writing-title">回到刚才停下的地方</h2>
            <dl className="start-page__recent-details">
              <div>
                <dt>最近作品</dt>
                <dd>{recentWriting.project.name}</dd>
              </div>
              <div>
                <dt>最近章节</dt>
                <dd>{recentWriting.chapter.title}</dd>
              </div>
              <div>
                <dt>保存时间</dt>
                <dd>{new Date(recentWriting.activityAt).toLocaleString("zh-CN")}</dd>
              </div>
              {recentWriting.editorView !== null && (
                <div>
                  <dt>上次编辑位置</dt>
                  <dd>
                    {describeEditorPosition(
                      recentWriting.editorView,
                      recentWriting.chapter.content.length,
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </div>
          <Link
            className="start-page__continue-link"
            to={`/projects/${recentWriting.project.id}/chapters/${recentWriting.chapter.id}`}
          >
            继续写
            <span aria-hidden="true">→</span>
          </Link>
        </section>
      )}

      {recentWritingError !== null && (
        <div className="start-page__recent-error">
          <InlineAlert
            tone="warning"
            title={recentWriting === null ? "最近作品暂时无法读取" : "部分最近作品暂未列出"}
            description={
              recentWritingError === RECENT_WRITING_IDENTITY_WARNING
                ? recentWritingError
                : `${recentWritingError} 你仍可以从作品库打开已有内容。`
            }
          />
        </div>
      )}

      <nav className="start-page__secondary" aria-label="已有内容与数据工具">
        <Link to="/projects">浏览作品库</Link>
        {!directMode && <Link to="/settings#data-transfer">恢复备份</Link>}
        {!directMode && (
          <Button
            variant="ghost"
            size="sm"
            loading={exampleBusy}
            onClick={() => void openExampleProject()}
          >
            体验示例作品
          </Button>
        )}
      </nav>

      {exampleError !== null && (
        <InlineAlert
          tone="error"
          title="示例作品暂时无法打开"
          description={`${exampleError} 请重试；已有本地作品不会受到影响。`}
        />
      )}
    </div>
  );
}

const EXAMPLE_PROJECT_NAME = "墨影示例：雨夜来信";
const EXAMPLE_POINTER_KEY = "inkshadow.example-project.v1";
const EXAMPLE_CHAPTER_TITLE = "第一章 雨停以前";
const EXAMPLE_CHAPTER_CONTENT = `雨是在晚自习结束前落下来的。

林澈站在教学楼门口，望着操场上被雨水揉碎的灯光，才想起自己的伞昨天借给了一个连名字都不知道的人。

“你是在等雨停，还是在等我？”

声音从身后传来。女孩把那把深蓝色的伞递到他面前，伞柄上却多了一张折成四方形的便笺。

林澈打开便笺。上面只有一行字：

不要在今晚十点以后，回答任何人关于十年前那场火的问题。

他抬起头，女孩已经撑伞走进雨里。教学楼的钟正好敲了十下。`;

async function resolveExampleWorkspace(
  runtime: DesktopRuntime,
): Promise<Readonly<{ project: Project; chapter: Chapter }>> {
  const savedExample = readExamplePointer();
  if (savedExample !== null) {
    const projectResult = await runtime.repositories.projects.findById(savedExample.projectId);
    if (!projectResult.ok) throw projectResult.error;
    const project = projectResult.value;
    if (project?.status === "active") {
      const identity = await runtime.repositories.projectDisplayIdentities.resolveByProjectId(
        project.id,
      );
      if (
        identity.ok &&
        identity.value?.displayKind === "builtin_example" &&
        identity.value.provenance === "builtin_example"
      ) {
        const chapter = await resolveExampleChapter(runtime, project, savedExample.chapterId);
        return Object.freeze({ project, chapter });
      }
    }
  }

  const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
  if (!projects.ok) throw projects.error;
  for (const project of projects.value) {
    const identity = await runtime.repositories.projectDisplayIdentities.resolveByProjectId(
      project.id,
    );
    if (
      identity.ok &&
      identity.value?.displayKind === "builtin_example" &&
      identity.value.provenance === "builtin_example"
    ) {
      const chapter = await resolveExampleChapter(runtime, project, null);
      return Object.freeze({ project, chapter });
    }
  }

  const project = await createExampleProject(runtime);
  const chapter = await resolveExampleChapter(runtime, project, null);
  return Object.freeze({ project, chapter });
}

async function resolveExampleChapter(
  runtime: DesktopRuntime,
  project: Project,
  preferredChapterId: UuidV7 | null,
): Promise<Chapter> {
  if (preferredChapterId !== null) {
    const preferred = await runtime.repositories.chapters.findById(preferredChapterId);
    if (!preferred.ok) throw preferred.error;
    if (preferred.value?.status === "active" && preferred.value.projectId === project.id) {
      return preferred.value;
    }
  }
  const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
  if (!chapters.ok) throw chapters.error;
  const existing = chapters.value.find(({ status }) => status === "active");
  if (existing !== undefined) {
    return existing;
  }
  const created = await runtime.useCases.createChapter.execute({
    projectId: project.id,
    title: EXAMPLE_CHAPTER_TITLE,
    content: EXAMPLE_CHAPTER_CONTENT,
  });
  if (!created.ok) throw created.error;
  return created.value.chapter;
}

async function createExampleProject(runtime: DesktopRuntime): Promise<Project> {
  const maximumSequence = 10_000;
  for (let sequence = 1; sequence <= maximumSequence; sequence += 1) {
    const suffix = sequence === 1 ? "" : `（${String(sequence)}）`;
    const name = `${EXAMPLE_PROJECT_NAME.slice(0, 120 - suffix.length)}${suffix}`;
    const project = await runtime.useCases.createProject.execute({
      name,
      displayKind: "builtin_example",
    });
    if (project.ok) {
      return project.value;
    }
    if (project.error.code !== "PROJECT_NAME_CONFLICT") {
      throw project.error;
    }
  }
  throw new Error("无法为示例作品确定可用名称；已有本地作品不会受到影响，请稍后重试。");
}

function readExamplePointer(): Readonly<{ projectId: UuidV7; chapterId: UuidV7 }> | null {
  try {
    const serialized = window.localStorage.getItem(EXAMPLE_POINTER_KEY);
    if (serialized === null) {
      return null;
    }
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const candidate = value as { projectId?: unknown; chapterId?: unknown };
    const projectId = parseUuidV7(
      typeof candidate.projectId === "string" ? candidate.projectId : "",
    );
    const chapterId = parseUuidV7(
      typeof candidate.chapterId === "string" ? candidate.chapterId : "",
    );
    return projectId.ok && chapterId.ok
      ? { projectId: projectId.value, chapterId: chapterId.value }
      : null;
  } catch {
    return null;
  }
}

function rememberExamplePointer(projectId: string, chapterId: string): void {
  try {
    window.localStorage.setItem(EXAMPLE_POINTER_KEY, JSON.stringify({ projectId, chapterId }));
  } catch {
    // The example remains usable even if the WebView cannot remember its shortcut.
  }
}

async function findRecentWriting(runtime: DesktopRuntime): Promise<RecentWritingResolution> {
  const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
  if (!projects.ok) {
    throw projects.error;
  }
  const targets = await Promise.all(
    projects.value.map(async (project) => {
      const identity = await runtime.repositories.projectDisplayIdentities.resolveByProjectId(
        project.id,
      );
      if (!identity.ok || identity.value === null) {
        return Object.freeze({
          targets: [] as readonly RecentWritingTarget[],
          identityReadFailed: true,
        });
      }
      if (identity.value.displayKind !== "author_work") {
        return Object.freeze({
          targets: [] as readonly RecentWritingTarget[],
          identityReadFailed: false,
        });
      }
      const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
      if (!chapters.ok) {
        throw chapters.error;
      }
      const authorTargets = chapters.value
        .filter(({ status }) => status === "active")
        .map((chapter): RecentWritingTarget => {
          const chapterUpdatedAt = Date.parse(chapter.toSnapshot().updatedAt);
          const editorView = readEditorView(project.id, chapter);
          return Object.freeze({
            project,
            chapter,
            activityAt: Math.max(
              Number.isFinite(chapterUpdatedAt) ? chapterUpdatedAt : 0,
              editorView?.updatedAt ?? 0,
            ),
            editorView,
          });
        });
      return Object.freeze({ targets: authorTargets, identityReadFailed: false });
    }),
  );
  const recentTarget =
    targets
      .flatMap(({ targets: projectTargets }) => projectTargets)
      .sort(
        (left, right) =>
          right.activityAt - left.activityAt ||
          right.chapter.toSnapshot().updatedAt.localeCompare(left.chapter.toSnapshot().updatedAt) ||
          left.chapter.id.localeCompare(right.chapter.id),
      )[0] ?? null;
  return Object.freeze({
    target: recentTarget,
    identityReadFailed: targets.some(({ identityReadFailed }) => identityReadFailed),
  });
}

function readEditorView(projectId: string, chapter: Chapter): EditorViewState | null {
  try {
    return loadEditorView(window.localStorage, projectId, chapter.id, chapter.content.length).view;
  } catch {
    return null;
  }
}

function describeEditorPosition(view: EditorViewState, contentLength: number): string {
  const { start, end } = view.selection;
  if (start !== end) {
    return `第 ${String(start + 1)} 至 ${String(end)} 个字符`;
  }
  if (contentLength === 0 || end === 0) {
    return "正文开头";
  }
  return `第 ${String(Math.min(end, contentLength))} 个字符后`;
}
