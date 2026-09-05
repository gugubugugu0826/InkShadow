// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  NovelSkillProjectState,
  NovelSkillRuntimePort,
} from "../infrastructure/novel-skill-runtime";
import { NovelSkillPanel } from "./novel-skill-panel";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";

describe("NovelSkillPanel", () => {
  it.each([
    ["NOVEL_SKILL_BINDING_CONFLICT", "技能与当前作品的关联未完成"],
    ["NOVEL_SKILL_DEFINITION_CONFLICT", "技能内容保存未完成"],
  ])("reports the precise %s creation failure while retaining input", async (code, message) => {
    const user = userEvent.setup();
    const createCustomSkill = vi.fn(() =>
      Promise.reject(Object.assign(new Error("受控写入失败"), { code })),
    );
    const runtime = {
      listProjectState: vi.fn(() => Promise.resolve(projectState(false))),
      createCustomSkill,
    } as unknown as NovelSkillRuntimePort;
    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(await screen.findByRole("button", { name: "创建技能" }));
    await user.type(screen.getByRole("textbox", { name: "技能名称" }), "克制对白");
    await user.type(screen.getByRole("textbox", { name: "用途说明" }), "用动作承接情绪");
    await user.type(screen.getByRole("textbox", { name: "写作规则" }), "对白保持简短。");
    const form = screen.getByRole("textbox", { name: "技能名称" }).closest("form");
    if (form === null) throw new Error("未取得技能表单。");
    await user.click(within(form).getByRole("button", { name: "创建技能" }));
    expect(await screen.findByText(new RegExp(message, "u"))).toBeVisible();
    expect(screen.getByRole("textbox", { name: "技能名称" })).toHaveValue("克制对白");
    expect(screen.getByRole("textbox", { name: "写作规则" })).toHaveValue("对白保持简短。");
    expect(createCustomSkill).toHaveBeenCalledOnce();
    expect(screen.queryByText(/已保存“克制对白”/u)).not.toBeInTheDocument();
  });
  it("explains incomplete creation before attempting to save an empty skill", async () => {
    const user = userEvent.setup();
    const createCustomSkill = vi.fn(() => Promise.reject(new Error("Invalid empty custom skill")));
    const runtime = {
      listProjectState: vi.fn(() => Promise.resolve(projectState(false))),
      createCustomSkill,
    } as unknown as NovelSkillRuntimePort;
    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(await screen.findByRole("button", { name: "创建技能" }));
    const form = screen.getByRole("textbox", { name: "技能名称" }).closest("form");
    if (form === null) throw new Error("未找到创建表单");
    await user.click(within(form).getByRole("button", { name: "创建技能" }));
    expect(await screen.findByText(/请填写技能名称、用途说明和至少一条写作规则/u)).toBeVisible();
    expect(createCustomSkill).not.toHaveBeenCalled();
  });
  it("separates built-in and project-enabled writing skills and lets the author enable then disable one", async () => {
    const user = userEvent.setup();
    let enabled = false;
    const listProjectState = vi.fn(() => Promise.resolve(projectState(enabled)));
    const setMethodEnabled = vi.fn((_projectId: string, _skillId: string, next: boolean) => {
      enabled = next;
      return Promise.resolve(projectState(enabled));
    });
    const runtime = {
      listProjectState,
      setMethodEnabled,
    } as Pick<
      NovelSkillRuntimePort,
      "listProjectState" | "setMethodEnabled"
    > as NovelSkillRuntimePort;

    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);

    expect(await screen.findByText("写作技能")).toBeVisible();
    expect(screen.getByRole("heading", { name: "内置技能" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "当前项目已启用" })).toBeVisible();
    expect(screen.getByText("未启用")).toBeVisible();
    const skillCard = screen.getByRole("button", { name: "启用场景推进" }).closest(".ink-card");
    if (!(skillCard instanceof HTMLElement)) throw new Error("找不到写作技能卡片。");
    expect(within(skillCard).getByText("适用于当前任务：续写")).toBeVisible();
    await user.selectOptions(
      screen.getByRole("combobox", { name: /当前要做的事/u }),
      "outline_planning",
    );
    expect(within(skillCard).getByText("不适用于当前任务")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "启用场景推进" }));
    expect(setMethodEnabled).toHaveBeenCalledWith(PROJECT_ID, "core.scene_craft", true);
    expect(await screen.findByText("已启用")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "停用场景推进" }));
    expect(setMethodEnabled).toHaveBeenLastCalledWith(PROJECT_ID, "core.scene_craft", false);
    expect(await screen.findByText("未启用")).toBeVisible();
    expect(screen.queryByText("core.scene_craft")).not.toBeInTheDocument();
  });

  it("offers creation, safe import preview, editing, copying, archiving and export for user skills", async () => {
    const user = userEvent.setup();
    const customState: NovelSkillProjectState = {
      availability: { status: "ready", reason: null },
      evaluationStatus: "not_evaluated",
      methods: [
        {
          skillId: "custom.user.1234abcd",
          displayName: "克制对白",
          summary: "让对白简短，并用动作承接情绪。",
          version: "1.0.0",
          kind: "custom",
          ownerScope: "user",
          status: "active",
          enabled: true,
          archived: false,
          appliesToContinuation: true,
          taskTypes: ["continuation", "rewrite"],
        },
      ],
    };
    const duplicateCustomSkill = vi.fn(() => Promise.resolve(customState));
    const archiveCustomSkill = vi.fn(() => Promise.resolve(customState));
    const exportCustomSkill = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          schema: "inkshadow-writing-skill",
          schemaVersion: 1,
          skill: {
            sourceSkillId: "custom.user.1234abcd",
            displayName: "克制对白",
            summary: "让对白简短，并用动作承接情绪。",
            taskTypes: ["continuation", "rewrite"],
            rules: ["对白尽量简短。"],
            prohibitions: [],
            precedence: 500,
            projectScope: "current_project",
          },
        }),
      ),
    );
    const runtime = {
      listProjectState: vi.fn(() => Promise.resolve(customState)),
      duplicateCustomSkill,
      archiveCustomSkill,
      exportCustomSkill,
    } as Pick<
      NovelSkillRuntimePort,
      "listProjectState" | "duplicateCustomSkill" | "archiveCustomSkill" | "exportCustomSkill"
    > as NovelSkillRuntimePort;

    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "我的技能" })).toBeVisible();
    expect(screen.getByRole("button", { name: "创建技能" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导入技能" })).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑" })).toBeVisible();
    expect(screen.getByRole("button", { name: "复制" })).toBeVisible();
    expect(screen.getByRole("button", { name: "归档" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(duplicateCustomSkill).toHaveBeenCalledWith(PROJECT_ID, "custom.user.1234abcd");
    await user.click(screen.getByRole("button", { name: "导出" }));
    expect(
      (await screen.findByLabelText(/导出的写作技能/u)).getAttribute("value") ??
        (await screen.findByLabelText(/导出的写作技能/u)).textContent,
    ).toContain("inkshadow-writing-skill");
    await user.click(screen.getByRole("button", { name: "归档" }));
    expect(archiveCustomSkill).toHaveBeenCalledWith(PROJECT_ID, "custom.user.1234abcd");
  });

  it("does not let a slow result from the previous project overwrite the current project", async () => {
    let resolveOld: ((value: NovelSkillProjectState) => void) | null = null;
    const oldState = new Promise<NovelSkillProjectState>((resolve) => {
      resolveOld = resolve;
    });
    const listProjectState = vi.fn((projectId: string) =>
      projectId === PROJECT_ID ? oldState : Promise.resolve(projectState(false, "新项目方法")),
    );
    const runtime = {
      listProjectState,
    } as Pick<NovelSkillRuntimePort, "listProjectState"> as NovelSkillRuntimePort;
    const { rerender } = render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);
    await waitFor(() => expect(listProjectState).toHaveBeenCalledWith(PROJECT_ID));

    const nextProjectId = "019f9f4a-b3c7-7350-9226-000000000099";
    rerender(<NovelSkillPanel projectId={nextProjectId} runtime={runtime} />);
    expect(await screen.findByText("新项目方法")).toBeVisible();

    await act(async () => {
      resolveOld?.(projectState(false, "旧项目方法"));
      await oldState;
    });
    expect(screen.queryByText("旧项目方法")).not.toBeInTheDocument();
    expect(screen.getByText("新项目方法")).toBeVisible();
  });

  it("does not let a slow toggle from the previous project overwrite the current project", async () => {
    const user = userEvent.setup();
    let resolveOldToggle: ((value: NovelSkillProjectState) => void) | null = null;
    const oldToggle = new Promise<NovelSkillProjectState>((resolve) => {
      resolveOldToggle = resolve;
    });
    const nextProjectId = "019f9f4a-b3c7-7350-9226-000000000099";
    const runtime = {
      listProjectState: vi.fn((projectId: string) =>
        Promise.resolve(
          projectId === PROJECT_ID
            ? projectState(false, "旧项目方法")
            : projectState(false, "新项目方法"),
        ),
      ),
      setMethodEnabled: vi.fn(() => oldToggle),
    } as Pick<
      NovelSkillRuntimePort,
      "listProjectState" | "setMethodEnabled"
    > as NovelSkillRuntimePort;
    const { rerender } = render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(await screen.findByRole("button", { name: "启用旧项目方法" }));

    rerender(<NovelSkillPanel projectId={nextProjectId} runtime={runtime} />);
    expect(await screen.findByText("新项目方法")).toBeVisible();
    await act(async () => {
      resolveOldToggle?.(projectState(true, "旧项目方法"));
      await oldToggle;
    });

    expect(screen.queryByText("旧项目方法")).not.toBeInTheDocument();
    expect(screen.getByText("新项目方法")).toBeVisible();
    expect(screen.getByRole("button", { name: "启用新项目方法" })).toBeEnabled();
  });

  it("states that browser demo does not apply methods or fabricate receipts", async () => {
    const runtime = {
      listProjectState: vi.fn(() =>
        Promise.resolve({
          availability: {
            status: "unavailable" as const,
            reason: "浏览器演示不会应用或保存写作技能采用记录。",
          },
          evaluationStatus: "not_evaluated" as const,
          methods: [],
        }),
      ),
    } as Pick<NovelSkillRuntimePort, "listProjectState"> as NovelSkillRuntimePort;

    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);

    expect(await screen.findByText(/浏览器演示不会应用或保存写作技能/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /启用/u })).not.toBeInTheDocument();
  });

  it("does not expose an uncontrolled runtime error in the ordinary writing-method UI", async () => {
    const rawMessage = "SQLITE_IOERR /users/private/novel-skill.json";
    const runtime = {
      listProjectState: vi.fn(() => Promise.reject(new Error(rawMessage))),
    } as Pick<NovelSkillRuntimePort, "listProjectState"> as NovelSkillRuntimePort;

    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(document.body).not.toHaveTextContent(rawMessage);
  });
});

function projectState(enabled: boolean, displayName = "场景推进"): NovelSkillProjectState {
  return {
    availability: { status: "ready", reason: null },
    evaluationStatus: "not_evaluated",
    methods: [
      {
        skillId: "core.scene_craft",
        displayName,
        summary: "让场景围绕可感知的目标、阻力和变化前进。",
        version: "1.0.0",
        kind: "core",
        ownerScope: "builtin",
        status: "experimental",
        enabled,
        archived: false,
        appliesToContinuation: true,
        taskTypes: ["continuation"],
      },
    ],
  };
}
