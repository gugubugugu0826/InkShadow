// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  NovelSkillProjectState,
  NovelSkillRuntimePort,
} from "../infrastructure/novel-skill-runtime";
import { NovelSkillPanel } from "./novel-skill-panel";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";

describe("NovelSkillPanel", () => {
  it("keeps experimental methods visibly default-off and lets the author enable then disable one", async () => {
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

    expect(await screen.findByText("写作方法（实验）")).toBeVisible();
    expect(screen.getByText("尚未完成真实双模型对照评测")).toBeVisible();
    expect(screen.getByText("未开启")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "实验性开启场景推进" }));
    expect(setMethodEnabled).toHaveBeenCalledWith(PROJECT_ID, "core.scene_craft", true);
    expect(await screen.findByText("实验中")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭场景推进" }));
    expect(setMethodEnabled).toHaveBeenLastCalledWith(PROJECT_ID, "core.scene_craft", false);
    expect(await screen.findByText("未开启")).toBeVisible();
    expect(screen.queryByText("core.scene_craft")).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "实验性开启旧项目方法" }));

    rerender(<NovelSkillPanel projectId={nextProjectId} runtime={runtime} />);
    expect(await screen.findByText("新项目方法")).toBeVisible();
    await act(async () => {
      resolveOldToggle?.(projectState(true, "旧项目方法"));
      await oldToggle;
    });

    expect(screen.queryByText("旧项目方法")).not.toBeInTheDocument();
    expect(screen.getByText("新项目方法")).toBeVisible();
    expect(screen.getByRole("button", { name: "实验性开启新项目方法" })).toBeEnabled();
  });

  it("states that browser demo does not apply methods or fabricate receipts", async () => {
    const runtime = {
      listProjectState: vi.fn(() =>
        Promise.resolve({
          availability: {
            status: "unavailable" as const,
            reason: "浏览器演示不会应用写作方法，也不会生成写作方法收据。",
          },
          evaluationStatus: "not_evaluated" as const,
          methods: [],
        }),
      ),
    } as Pick<NovelSkillRuntimePort, "listProjectState"> as NovelSkillRuntimePort;

    render(<NovelSkillPanel projectId={PROJECT_ID} runtime={runtime} />);

    expect(await screen.findByText(/浏览器演示不会应用写作方法/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /实验性开启/u })).not.toBeInTheDocument();
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
        status: "experimental",
        enabled,
        appliesToContinuation: true,
      },
    ],
  };
}
