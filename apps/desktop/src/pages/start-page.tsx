import { Badge, Button, InlineAlert } from "@inkshadow/ui";
import { parseUuidV7, type UuidV7 } from "@inkshadow/domain";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

const creationEntries = [
  {
    to: "/create/idea",
    eyebrow: "推荐首次使用",
    title: "从一个想法开始",
    description: "写下一句话，AI 会先给你一段可修改的试写，再一次只和你确认一个问题。",
    action: "说出我的想法",
    mark: "想",
    primary: true,
  },
  {
    to: "/create/import",
    eyebrow: "已有小说",
    title: "导入小说，继续写或改写",
    description: "先分析作品和试改一小段，确认方向后再逐章处理，原文始终保留。",
    action: "选择作品",
    mark: "入",
    primary: false,
  },
  {
    to: "/create/professional",
    eyebrow: "准备充分",
    title: "专业创建",
    description: "从人物、世界、剧情规划和写作规则开始，按自己的方式深入控制。",
    action: "开始专业创建",
    mark: "专",
    primary: false,
  },
] as const;

export function StartPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const [exampleBusy, setExampleBusy] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const cloudIdentityAvailable =
    runtime.featureFlags.cloudIdentity && runtime.cloudIdentity?.available === true;

  async function openExampleProject(): Promise<void> {
    if (exampleBusy) {
      return;
    }
    setExampleBusy(true);
    setExampleError(null);
    try {
      const savedExample = readExamplePointer();
      if (savedExample !== null) {
        const [projectResult, chapterResult] = await Promise.all([
          runtime.repositories.projects.findById(savedExample.projectId),
          runtime.repositories.chapters.findById(savedExample.chapterId),
        ]);
        if (!projectResult.ok) {
          throw projectResult.error;
        }
        if (!chapterResult.ok) {
          throw chapterResult.error;
        }
        if (
          projectResult.value?.status === "active" &&
          chapterResult.value?.status === "active" &&
          chapterResult.value.projectId === projectResult.value.id
        ) {
          void navigate(`/projects/${projectResult.value.id}/chapters/${chapterResult.value.id}`);
          return;
        }
      }
      let project = await runtime.useCases.createProject.execute({ name: EXAMPLE_PROJECT_NAME });
      if (!project.ok && project.error.code === "PROJECT_NAME_CONFLICT") {
        project = await runtime.useCases.createProject.execute({
          name: `${EXAMPLE_PROJECT_NAME}-${runtime.ids.next().slice(-4)}`,
        });
      }
      if (!project.ok) {
        throw project.error;
      }
      const chapter = await runtime.useCases.createChapter.execute({
        projectId: project.value.id,
        title: EXAMPLE_CHAPTER_TITLE,
        content: EXAMPLE_CHAPTER_CONTENT,
      });
      if (!chapter.ok) {
        throw chapter.error;
      }
      rememberExamplePointer(project.value.id, chapter.value.chapter.id);
      void navigate(`/projects/${project.value.id}/chapters/${chapter.value.chapter.id}`);
    } catch (cause: unknown) {
      setExampleError(normalizeUiError(cause).description);
    } finally {
      setExampleBusy(false);
    }
  }

  return (
    <main className="start-page">
      <header className="start-page__header" aria-labelledby="start-heading">
        <div className="start-page__brand" aria-label="InkShadow 墨影">
          <span className="start-page__mark" aria-hidden="true">
            墨
          </span>
          <span>InkShadow 墨影</span>
        </div>
        <Badge tone="success">本地优先 · 无需登录</Badge>
        <h1 id="start-heading">一句想法，也能开始一部长篇</h1>
        <p>
          先告诉墨影你想做什么。人物、世界和写作规则可以在创作过程中逐步形成，不必一次准备齐全。
        </p>
      </header>

      <section className="start-page__entries" aria-label="选择创作方式">
        {creationEntries.map((entry) => (
          <Link
            className={`start-page__entry${entry.primary ? " start-page__entry--primary" : ""}`}
            key={entry.to}
            to={entry.to}
          >
            <span className="start-page__entry-mark" aria-hidden="true">
              {entry.mark}
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

      <nav className="start-page__secondary" aria-label="已有内容与数据工具">
        <span>已经在创作？</span>
        <Link to="/projects">打开最近创作与作品库</Link>
        <span aria-hidden="true">·</span>
        <Button
          variant="ghost"
          size="sm"
          loading={exampleBusy}
          onClick={() => void openExampleProject()}
        >
          体验示例作品
        </Button>
        <span aria-hidden="true">·</span>
        <Link to="/settings#data-transfer">从备份恢复</Link>
      </nav>

      {exampleError !== null && (
        <InlineAlert
          tone="error"
          title="示例作品暂时无法打开"
          description={`${exampleError} 请重试；已有本地作品不会受到影响。`}
        />
      )}

      <section className="start-page__assurance" aria-labelledby="local-control-heading">
        <div>
          <h2 id="local-control-heading">作品留在你的设备</h2>
          <p>正文、版本和备份默认保存在本地；云能力暂时不可用，也不会阻断写作与导出。</p>
        </div>
        <ul>
          <li>AI 修改先成为建议版本，不会静默覆盖原文</li>
          <li>登录或订阅状态不会锁住本地正文</li>
        </ul>
      </section>

      <div className="start-page__cloud-status">
        {cloudIdentityAvailable ? (
          <Link className="start-page__cloud-link" to="/auth/login">
            登录已有云账户
          </Link>
        ) : (
          <span className="start-page__cloud-note">云账户可稍后连接，本地创作功能保持完整。</span>
        )}
      </div>
    </main>
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
