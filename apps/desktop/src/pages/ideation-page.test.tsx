import {
  IDEATION_STEP_KEYS,
  IdeationApplicationService,
  IdeationDraft,
  StoryCoreError,
  err,
  ok,
  type CommitIdeationProjectInput,
  type IdeationDraftRepository,
  type IdeationProjectCommitUnitOfWork,
  type ProjectSeed,
  type Result,
  type UuidV7,
} from "@inkshadow/story-core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { desktopPersistenceLifecycle } from "../infrastructure/persistence-lifecycle";
import { RuntimeProvider } from "../runtime-context";
import { IdeationPage } from "./ideation-page";

describe("IdeationPage", () => {
  it("maps every quick-book field exactly and leaves unmapped steps pending", async () => {
    const harness = new IdeationHarness();
    const createQuick = vi.spyOn(harness.service, "createQuick");
    renderPage(harness);
    const user = userEvent.setup();

    const quickCard = screen.getByRole("heading", { name: "快速开书" }).closest(".ink-card");
    if (!(quickCard instanceof HTMLElement)) {
      throw new Error("找不到快速开书表单。");
    }
    await user.type(within(quickCard).getByLabelText("项目名称"), "雾港来信");
    await user.type(within(quickCard).getByLabelText("一句话创意"), "失忆邮差收到未来来信。");
    await user.type(within(quickCard).getByLabelText("类型"), "悬疑幻想");
    await user.clear(within(quickCard).getByLabelText("目标字数"));
    await user.type(within(quickCard).getByLabelText("目标字数"), "320000");
    await user.type(within(quickCard).getByLabelText("主角类型"), "谨慎但执拗的普通人");
    await user.type(within(quickCard).getByLabelText(/^风格/u), "克制、带黑色幽默");
    await user.click(within(quickCard).getByRole("button", { name: "创建快速草稿" }));

    expect(createQuick).toHaveBeenCalledWith({
      projectName: "雾港来信",
      seed: {
        idea: "失忆邮差收到未来来信。",
        genre: "悬疑幻想",
        targetWords: 320_000,
        protagonistType: "谨慎但执拗的普通人",
        style: "克制、带黑色幽默",
      },
    });
    expect(await screen.findByText("第 2 / 9 步")).toBeInTheDocument();
    const draft = harness.onlyDraft().toSnapshot();
    expect(draft.steps.find((step) => step.key === "genre")).toMatchObject({
      state: "completed",
      origin: "quick_seed",
      value: "悬疑幻想",
    });
    expect(draft.steps.find((step) => step.key === "target_audience")).toMatchObject({
      state: "pending",
      value: "",
    });
    expect(draft.steps.find((step) => step.key === "output_spec")?.value).toBe(
      "目标字数：320,000；风格：克制、带黑色幽默",
    );
  });

  it("lists and resumes the latest active draft", async () => {
    const harness = new IdeationHarness();
    const created = unwrap(await harness.service.createGuided({ projectName: "纸月" }));
    renderPage(harness);
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "纸月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "恢复草稿" }));

    expect(
      await screen.findByText(`修订 ${String(created.revision)} · 已处理 0 / 9`),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "固定九步构思进度" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /待决定/u })).toHaveLength(9);
  });

  it("keeps locked answers isolated from local suggestion generation", async () => {
    const harness = new IdeationHarness();
    let draft = unwrap(await harness.service.createGuided({ projectName: "城门之外" }));
    draft = unwrap(
      await harness.service.apply({
        draftId: draft.id,
        expectedRevision: draft.revision,
        change: { kind: "update", step: "genre", value: "东方奇幻" },
      }),
    );
    draft = unwrap(
      await harness.service.apply({
        draftId: draft.id,
        expectedRevision: draft.revision,
        change: { kind: "lock", step: "genre" },
      }),
    );
    unwrap(
      await harness.service.apply({
        draftId: draft.id,
        expectedRevision: draft.revision,
        change: { kind: "go_to_step", step: "premise" },
      }),
    );
    const apply = vi.spyOn(harness.service, "apply");
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));

    expect(screen.getByText("未调用模型")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成本地建议" }));
    expect(await screen.findByRole("button", { name: "再生成" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /类型与基调/u }));

    expect(await screen.findByDisplayValue("东方奇幻")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "生成本地建议" })).toBeDisabled();
    expect(
      apply.mock.calls.filter(
        ([command]) =>
          command.change.kind === "offer_suggestion" && command.change.step === "genre",
      ),
    ).toHaveLength(0);
    expect(harness.onlyDraft().toSnapshot().steps[0]).toMatchObject({
      value: "东方奇幻",
      locked: true,
      suggestion: null,
    });
  });

  it("keeps finalization disabled while any step remains pending", async () => {
    const harness = new IdeationHarness();
    await harness.service.createGuided({ projectName: "未完成的书" });
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));

    expect(screen.getByText("还有 9 个 pending 步骤，创建保持禁用。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建项目并打开" })).toBeDisabled();
  });

  it("atomically finalizes a resolved draft and navigates to the new project", async () => {
    const harness = new IdeationHarness();
    let draft = unwrap(await harness.service.createGuided({ projectName: "全部决定完成" }));
    for (const step of IDEATION_STEP_KEYS) {
      draft = unwrap(
        await harness.service.apply({
          draftId: draft.id,
          expectedRevision: draft.revision,
          change: { kind: "skip", step },
        }),
      );
    }
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));

    expect(screen.getByText("九步均已完成或明确跳过，可以创建。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建项目并打开" }));

    expect(await screen.findByText(/已打开项目/u)).toBeInTheDocument();
    expect(harness.createdProjects).toHaveLength(1);
    expect(harness.onlyStoredDraft().status).toBe("finalized");
  });

  it("shows a revision conflict and reloads only after an explicit user action", async () => {
    const harness = new IdeationHarness();
    const draft = unwrap(await harness.service.createGuided({ projectName: "并发草稿" }));
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));

    unwrap(
      await harness.service.apply({
        draftId: draft.id,
        expectedRevision: draft.revision,
        change: { kind: "update", step: "genre", value: "外部窗口保存的类型" },
      }),
    );
    await user.type(screen.getByLabelText("你的决定"), "当前窗口未保存的类型");
    await user.click(screen.getByRole("button", { name: "保存当前步骤" }));

    expect(await screen.findByText(/草稿修订冲突/u)).toBeInTheDocument();
    expect(screen.getByLabelText("你的决定")).toHaveValue("当前窗口未保存的类型");
    await user.click(screen.getByRole("button", { name: "重新读取草稿" }));
    expect(await screen.findByDisplayValue("外部窗口保存的类型")).toBeInTheDocument();
    expect(screen.queryByText(/草稿修订冲突/u)).not.toBeInTheDocument();
  });

  it("persists the complete dirty step before a controlled route change", async () => {
    const harness = new IdeationHarness();
    await harness.service.createGuided({ projectName: "离开前保存" });
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));

    const editor = screen.getByLabelText("你的决定");
    await user.type(editor, "雾港中的完整构思文本");

    await expect(desktopPersistenceLifecycle.flush("route-change", 1_000)).resolves.toEqual({
      status: "success",
      flushedHandlerIds: ["ideation:current-step"],
    });
    expect(harness.onlyDraft().toSnapshot().steps[0]).toMatchObject({
      state: "completed",
      value: "雾港中的完整构思文本",
    });
  });

  it("blocks window close during IME composition and saves only the completed value", async () => {
    const harness = new IdeationHarness();
    await harness.service.createGuided({ projectName: "组合输入门禁" });
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));

    const editor = screen.getByLabelText("你的决定");
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, {
      target: { value: "组合中的半", selectionStart: 6 },
    });

    await expect(desktopPersistenceLifecycle.flush("window-close", 1_000)).resolves.toEqual({
      status: "blocked",
      blockers: [
        {
          handlerId: "ideation:current-step",
          code: "COMPOSITION_ACTIVE",
          message: "请先完成当前中文输入，再离开构思草稿。",
        },
      ],
    });
    expect(harness.onlyDraft().toSnapshot().steps[0]?.value).toBe("");

    fireEvent.change(editor, {
      target: { value: "组合输入已经完整", selectionStart: 8 },
    });
    fireEvent.compositionEnd(editor, {
      data: "完整",
    });
    await expect(desktopPersistenceLifecycle.flush("window-close", 1_000)).resolves.toEqual({
      status: "success",
      flushedHandlerIds: ["ideation:current-step"],
    });
    expect(harness.onlyDraft().toSnapshot().steps[0]?.value).toBe("组合输入已经完整");
  });

  it("keeps a dirty step open when lifecycle persistence is rejected", async () => {
    const harness = new IdeationHarness();
    await harness.service.createGuided({ projectName: "失败不离开" });
    renderPage(harness);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "恢复草稿" }));
    await user.type(screen.getByLabelText("你的决定"), "必须继续留在页面的文本");
    vi.spyOn(harness.service, "apply").mockResolvedValueOnce(
      err(
        new StoryCoreError({
          code: "STORY_REPOSITORY_ERROR",
          message: "injected persistence failure",
          retryable: true,
        }),
      ),
    );

    const outcome = await desktopPersistenceLifecycle.flush("route-change", 1_000);
    expect(outcome.status).toBe("failed");
    expect(screen.getByLabelText("你的决定")).toHaveValue("必须继续留在页面的文本");
    expect(harness.onlyDraft().toSnapshot().steps[0]?.value).toBe("");
    expect(await screen.findByText(/构思操作未完成/u)).toBeInTheDocument();
  });
});

function renderPage(harness: IdeationHarness): void {
  const runtime = createDevelopmentRuntime(window.localStorage);
  render(
    <MemoryRouter initialEntries={["/ideation"]}>
      <RuntimeProvider runtime={runtime}>
        <Routes>
          <Route
            path="/ideation"
            element={<IdeationPage drafts={harness.drafts} service={harness.service} />}
          />
          <Route path="/projects/:projectId" element={<ProjectDestination />} />
        </Routes>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function ProjectDestination() {
  const { projectId } = useParams();
  return <div>已打开项目 {projectId}</div>;
}

class IdeationHarness {
  private readonly stored = new Map<string, IdeationDraft>();
  private sequence = 700;

  public readonly createdProjects: {
    readonly projectId: UuidV7;
    readonly seed: ProjectSeed;
  }[] = [];

  public readonly drafts: IdeationDraftRepository = {
    create: (draft) => {
      if (this.stored.has(draft.id)) {
        return Promise.resolve(repositoryError());
      }
      this.stored.set(draft.id, cloneDraft(draft));
      return Promise.resolve(ok(undefined));
    },
    findById: (id) => {
      const draft = this.stored.get(id);
      return Promise.resolve(ok(draft === undefined ? null : cloneDraft(draft)));
    },
    listActive: () =>
      Promise.resolve(
        ok(
          [...this.stored.values()]
            .filter((draft) => draft.status === "active")
            .sort((left, right) =>
              right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
            )
            .map(cloneDraft),
        ),
      ),
    save: (draft, expectedRevision) => {
      const current = this.stored.get(draft.id);
      if (current === undefined) {
        return Promise.resolve(repositoryError());
      }
      if (current.revision !== expectedRevision) {
        return Promise.resolve(revisionConflict(expectedRevision, current.revision));
      }
      this.stored.set(draft.id, cloneDraft(draft));
      return Promise.resolve(ok(undefined));
    },
  };

  private readonly projects: IdeationProjectCommitUnitOfWork = {
    commit: (input) => this.commit(input),
  };

  public readonly service = new IdeationApplicationService({
    drafts: this.drafts,
    projects: this.projects,
    clock: { now: () => "2026-07-28T00:00:00.000Z" as const },
    ids: { next: () => uuid(this.sequence++) },
  });

  public onlyDraft(): IdeationDraft {
    const active = [...this.stored.values()].filter((draft) => draft.status === "active");
    if (active.length !== 1 || active[0] === undefined) {
      throw new Error("测试预期恰好一个活跃草稿。");
    }
    return cloneDraft(active[0]);
  }

  public onlyStoredDraft(): IdeationDraft {
    const drafts = [...this.stored.values()];
    if (drafts.length !== 1 || drafts[0] === undefined) {
      throw new Error("测试预期恰好一个草稿。");
    }
    return cloneDraft(drafts[0]);
  }

  private commit(input: CommitIdeationProjectInput): Promise<Result<void, StoryCoreError>> {
    const current = this.stored.get(input.draft.id);
    if (current?.revision !== input.expectedDraftRevision) {
      return Promise.resolve(revisionConflict(input.expectedDraftRevision, current?.revision ?? 0));
    }
    this.stored.set(input.draft.id, cloneDraft(input.draft));
    this.createdProjects.push({ projectId: input.projectId, seed: input.seed });
    return Promise.resolve(ok(undefined));
  }
}

function cloneDraft(draft: IdeationDraft): IdeationDraft {
  return unwrap(IdeationDraft.rehydrate(draft.toSnapshot()));
}

function unwrap<Value>(result: Result<Value, StoryCoreError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function uuid(sequence: number): UuidV7 {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString().padStart(12, "0")}` as UuidV7;
}

function revisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Sensitive raw repository conflict.",
      details: { expectedRevision, actualRevision },
    }),
  );
}

function repositoryError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message: "Sensitive raw repository failure.",
      retryable: true,
    }),
  );
}
