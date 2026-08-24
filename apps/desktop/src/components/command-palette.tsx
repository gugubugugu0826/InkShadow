import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseUuidV7 as parseDomainUuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7, type StoryValue } from "@inkshadow/story-core";
import { Dialog } from "@inkshadow/ui";
import { useNavigate } from "react-router-dom";

import type { DesktopRuntime } from "../infrastructure/runtime";
import { useRuntime } from "../runtime-context";

interface CommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly to: string;
  readonly group: "创作" | "写作" | "AI" | "导出" | "项目" | "工具";
}

const MAX_COMMAND_RESULTS = 60;

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string | null;
}

export function CommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return null;
  }

  return <OpenCommandPalette key={props.projectId ?? "global"} {...props} />;
}

function OpenCommandPalette({ onOpenChange, projectId }: CommandPaletteProps) {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [projectSearchCommands, setProjectSearchCommands] = useState<readonly CommandDefinition[]>(
    [],
  );
  const baseCommands = useMemo(() => createCommands(projectId), [projectId]);
  const commands = useMemo(
    () => [...baseCommands, ...projectSearchCommands],
    [baseCommands, projectSearchCommands],
  );
  const filtered = useMemo(
    () =>
      filterCommands(query.trim().length === 0 ? baseCommands : commands, query).slice(
        0,
        MAX_COMMAND_RESULTS,
      ),
    [baseCommands, commands, query],
  );
  const activeCommandIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  useEffect(() => {
    let active = true;
    if (projectId === null) return () => undefined;
    void loadProjectSearchCommands(runtime, projectId).then(
      (loaded) => {
        if (active) setProjectSearchCommands(loaded);
      },
      () => {
        if (active) setProjectSearchCommands([]);
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, runtime]);

  const select = (command: CommandDefinition): void => {
    onOpenChange(false);
    void navigate(command.to);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        filtered.length === 0 ? 0 : (Math.min(current, filtered.length - 1) + 1) % filtered.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        filtered.length === 0
          ? 0
          : (Math.min(current, filtered.length - 1) - 1 + filtered.length) % filtered.length,
      );
      return;
    }
    if (event.key === "Enter") {
      const command = filtered[activeCommandIndex];
      if (command !== undefined) {
        event.preventDefault();
        select(command);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="快速前往"
      description="搜索页面或创作操作。"
      closeLabel="关闭快速前往"
      initialFocusRef={inputRef}
      className="command-palette"
    >
      <div className="command-palette__search">
        <label htmlFor="inkshadow-command-search">搜索命令</label>
        <input
          ref={inputRef}
          id="inkshadow-command-search"
          type="search"
          value={query}
          autoComplete="off"
          placeholder="例如：正文、任务、模型中心"
          aria-controls="inkshadow-command-results"
          aria-activedescendant={filtered[activeCommandIndex]?.id}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <span className="command-palette__hint" aria-hidden="true">
          ↑↓ 选择 · Enter 打开 · Esc 关闭
        </span>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        找到 {String(filtered.length)} 个命令
      </p>
      {filtered.length === 0 ? (
        <div className="command-palette__empty">
          <strong>没有匹配命令</strong>
          <span>可以换一个页面名称或操作关键词。</span>
        </div>
      ) : (
        <ul id="inkshadow-command-results" className="command-palette__results">
          {filtered.map((command, index) => (
            <li key={command.id}>
              <button
                id={command.id}
                type="button"
                className="command-palette__item"
                data-active={index === activeCommandIndex || undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(command)}
              >
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
                <span className="command-palette__group">{command.group}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function createCommands(projectId: string | null): readonly CommandDefinition[] {
  const commands: CommandDefinition[] = [
    command(
      "command-start",
      "创作首页",
      "从一句想法、已有小说或专业设定开始",
      ["开始", "首页", "灵感"],
      "/start",
      "创作",
    ),
    command(
      "command-idea",
      "从一个想法开始",
      "输入一句灵感，由 AI 或本地引导陪你开书",
      ["新建", "开书", "灵感", "写作"],
      "/create/idea",
      "写作",
    ),
    command(
      "command-import",
      "导入小说并改写",
      "导入已有作品，先试改一小段再决定后续处理",
      ["导入", "续写", "改写", "原文"],
      "/create/import",
      "写作",
    ),
    command(
      "command-projects",
      "作品库",
      "打开、搜索、归档或恢复本地作品",
      ["项目", "小说", "书库"],
      "/projects",
      "创作",
    ),
    command(
      "command-tasks",
      "任务与通知",
      "查看生成、分析和后台更新进度",
      ["后台", "失败", "重试", "通知"],
      "/tasks",
      "工具",
    ),
    command(
      "command-usage",
      "模型使用与费用",
      "查看模型使用记录、内容额度与费用估算",
      ["用量", "费用", "账单", "内容额度"],
      "/usage",
      "工具",
    ),
    command(
      "command-model-hub",
      "模型中心",
      "连接供应商、同步模型并设置创作任务安排",
      ["模型", "供应商", "API", "连接"],
      "/settings#model-center",
      "AI",
    ),
    command(
      "command-image-generation",
      "生成小说配图",
      "选择已确认支持图片生成的模型并预览发送内容",
      ["AI", "图片", "封面", "插图"],
      "/settings#image-generation",
      "AI",
    ),
    command(
      "command-export",
      "导出作品",
      "导出 EPUB、Markdown、DOCX 或 PDF",
      ["EPUB", "Markdown", "DOCX", "PDF", "分享"],
      "/settings#data-transfer",
      "导出",
    ),
    command(
      "command-backup",
      "备份与恢复",
      "创建一致性备份，或从已有备份安全恢复",
      ["备份", "恢复", "SQLite", "数据"],
      "/settings#local-maintenance",
      "导出",
    ),
    command(
      "command-settings",
      "设置",
      "调整外观、本地数据与高级选项",
      ["外观", "备份", "偏好"],
      "/settings",
      "工具",
    ),
  ];
  if (projectId !== null) {
    commands.splice(
      2,
      0,
      command(
        "command-body",
        "正文",
        "继续当前作品的章节写作",
        ["写作", "编辑器", "章节"],
        `/projects/${projectId}`,
        "项目",
      ),
      command(
        "command-plan",
        "规划",
        "查看故事方向、大纲、场景和伏笔",
        ["大纲", "剧情", "场景"],
        `/projects/${projectId}/outline`,
        "项目",
      ),
      command(
        "command-story",
        "设定",
        "管理人物、世界、关系、事件和规则",
        ["人物", "世界", "记忆"],
        `/projects/${projectId}/story`,
        "项目",
      ),
      command(
        "command-checks",
        "检查",
        "查看矛盾、视角、声纹和节奏问题",
        ["矛盾", "POV", "审稿"],
        `/projects/${projectId}/checks`,
        "项目",
      ),
    );
  }
  return commands;
}

async function loadProjectSearchCommands(
  runtime: DesktopRuntime,
  projectId: string,
): Promise<readonly CommandDefinition[]> {
  const domainProjectId = parseDomainUuidV7(projectId);
  const storyProjectId = parseStoryUuidV7(projectId);
  if (!domainProjectId.ok || !storyProjectId.ok) return [];

  const [chapterResult, recordResult, factResult] = await Promise.all([
    runtime.repositories.chapters.listByProjectId(domainProjectId.value),
    runtime.story.formalRecords.listByProjectId(storyProjectId.value),
    runtime.story.facts.listByProjectId(storyProjectId.value),
  ]);
  const loaded: CommandDefinition[] = [];
  if (chapterResult.ok) {
    chapterResult.value.forEach((chapter) => {
      loaded.push(
        command(
          `command-chapter-${chapter.id}`,
          `章节：${chapter.title}`,
          "直接打开这一章继续写作",
          ["章节", "正文", chapter.title],
          `/projects/${projectId}/chapters/${chapter.id}`,
          "写作",
        ),
      );
    });
  }

  const characterLabels = new Set<string>();
  if (recordResult.ok) {
    recordResult.value.forEach((record) => {
      const snapshot = record.toSnapshot();
      if (snapshot.kind !== "character") return;
      const currentValue = snapshot.versions.find(
        ({ version }) => version === snapshot.currentVersion,
      )?.value;
      characterLabels.add(
        readCharacterLabel(currentValue) ?? humanizeCharacterKey(String(snapshot.recordKey)),
      );
    });
  }
  if (factResult.ok) {
    factResult.value.forEach((fact) => {
      const snapshot = fact.toSnapshot();
      if (!String(snapshot.factType).includes("character")) return;
      const label =
        readCharacterLabel(snapshot.structuredValue) ?? compactCharacterText(snapshot.contentText);
      if (label !== null) characterLabels.add(label);
    });
  }
  [...characterLabels]
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .forEach((label, index) => {
      loaded.push(
        command(
          `command-character-${String(index)}`,
          `人物：${label}`,
          "在故事设定中查看这个人物及其证据",
          ["人物", "角色", "设定", label],
          `/projects/${projectId}/story`,
          "项目",
        ),
      );
    });
  return loaded;
}

function readCharacterLabel(value: StoryValue | null | undefined): string | null {
  if (typeof value === "string") return normalizeCharacterLabel(value);
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  for (const key of ["name", "displayName", "characterName", "subjectName", "label"]) {
    const candidate = (value as Readonly<Record<string, StoryValue>>)[key];
    if (typeof candidate === "string") {
      const normalized = normalizeCharacterLabel(candidate);
      if (normalized !== null) return normalized;
    }
  }
  return null;
}

function compactCharacterText(value: string | null): string | null {
  const normalized = normalizeCharacterLabel(value ?? "");
  if (normalized === null) return null;
  return normalized.length <= 36 ? normalized : `${normalized.slice(0, 35)}…`;
}

function normalizeCharacterLabel(value: string): string | null {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? null : normalized;
}

function humanizeCharacterKey(value: string): string {
  const tail = value.split(/[.:/]/u).at(-1)?.replace(/[-_]+/gu, " ").trim();
  return tail === undefined || tail.length === 0 ? "未命名人物" : tail;
}

function command(
  id: string,
  label: string,
  description: string,
  keywords: readonly string[],
  to: string,
  group: CommandDefinition["group"],
): CommandDefinition {
  return { id, label, description, keywords, to, group };
}

function filterCommands(
  commands: readonly CommandDefinition[],
  query: string,
): readonly CommandDefinition[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (normalized.length === 0) {
    return commands;
  }
  return commands.filter((command) =>
    [command.label, command.description, ...command.keywords]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(normalized),
  );
}
