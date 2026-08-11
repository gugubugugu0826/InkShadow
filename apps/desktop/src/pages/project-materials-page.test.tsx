import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { parseUuidV7 as parseStoryUuid } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("ProjectMaterialsPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("governs rights, exact duplicates, citations, soft deletion, and restoration", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const seeded = await seedProject(runtime);
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${seeded.projectId}/materials`);

    expect(
      await screen.findByRole("heading", { name: "雾港素材项目", level: 1 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "录入第一条素材" }));
    await fillMaterialForm(user, {
      title: "雨夜钟楼",
      sourceName: "作者自有设定集",
      author: "林舟",
      sourceUrl: "https://example.test/archive/bell-tower",
      license: "owned",
      rightsBasis: "本人原创并持有完整权利。",
      summary: "雾港钟楼在雨夜为失踪船只报时。",
      body: "午夜十二点，雾港钟楼的铜钟穿过雨幕，守塔人看见一艘没有灯火的船。",
      allowGeneration: true,
    });
    await user.click(screen.getByRole("button", { name: "保存素材" }));

    const materialHeading = await screen.findByRole("heading", { name: "雨夜钟楼", level: 3 });
    let materialCard = materialHeading.closest(".ink-card");
    if (!(materialCard instanceof HTMLElement)) {
      throw new Error("找不到素材卡片。");
    }
    expect(within(materialCard).getByText("生成：允许")).toBeInTheDocument();
    expect(within(materialCard).getByText("训练：禁止")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "录入素材" }));
    await fillMaterialForm(user, {
      title: "重复钟楼摘录",
      sourceName: "另一份记录",
      rightsBasis: "权利仍待确认。",
      summary: "重复正文测试。",
      body: "午夜十二点，雾港钟楼的铜钟穿过雨幕，守塔人看见一艘没有灯火的船。",
    });
    await user.click(screen.getByRole("button", { name: "保存素材" }));
    expect(
      await screen.findByText(
        "已存在正文内容相同的有效素材。请取消本次录入并使用已有素材，或修改正文后再保存。",
      ),
    ).toBeInTheDocument();
    const storedAfterDuplicate = await runtime.story.materials.listByProjectId(
      parseStoryId(seeded.projectId),
      true,
    );
    expect(storedAfterDuplicate.ok && storedAfterDuplicate.value).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "取消" }));

    materialCard = screen.getByRole("heading", { name: "雨夜钟楼", level: 3 }).closest(".ink-card");
    if (!(materialCard instanceof HTMLElement)) {
      throw new Error("找不到素材卡片。");
    }
    await user.click(within(materialCard).getByRole("button", { name: "记录引用" }));
    await user.type(
      screen.getByRole("textbox", { name: "引用说明" }),
      "用于第一章钟声场景的出处说明。",
    );
    await user.click(screen.getByRole("button", { name: "确认引用" }));
    await waitFor(
      () => {
        const referencedCard = screen
          .getByRole("heading", { name: "雨夜钟楼", level: 3 })
          .closest(".ink-card");
        expect(referencedCard).not.toBeNull();
        if (referencedCard instanceof HTMLElement) {
          expect(
            within(referencedCard).getByText("用于第一章钟声场景的出处说明。"),
          ).toBeInTheDocument();
        }
      },
      { timeout: 10_000 },
    );

    materialCard = screen.getByRole("heading", { name: "雨夜钟楼", level: 3 }).closest(".ink-card");
    if (!(materialCard instanceof HTMLElement)) {
      throw new Error("找不到素材卡片。");
    }
    await user.click(within(materialCard).getByRole("button", { name: "删除并保留引用" }));
    expect(screen.getByText(/当前影响：1 条章节引用。引用保留最小出处快照/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      const deletedCard = screen
        .getByRole("heading", { name: "雨夜钟楼", level: 3 })
        .closest(".ink-card");
      expect(deletedCard).not.toBeNull();
      if (deletedCard instanceof HTMLElement) {
        expect(within(deletedCard).getByText("已删除")).toBeInTheDocument();
        expect(within(deletedCard).getByText("生成：禁止")).toBeInTheDocument();
        expect(within(deletedCard).getByText("用于第一章钟声场景的出处说明。")).toBeInTheDocument();
      }
    });

    const storedDeleted = await runtime.story.materials.listByProjectId(
      parseStoryId(seeded.projectId),
      true,
    );
    if (!storedDeleted.ok || storedDeleted.value[0] === undefined) {
      throw new Error("软删除素材没有持久化。");
    }
    const storedReferences = await runtime.story.materialReferences.listByMaterialId(
      storedDeleted.value[0].id,
    );
    expect(storedDeleted.value[0].status).toBe("deleted");
    expect(storedReferences.ok && storedReferences.value).toHaveLength(1);
    expect(
      storedReferences.ok && storedReferences.value[0]?.toSnapshot().provenance.sourceName,
    ).toBe("作者自有设定集");

    const deletedCard = screen
      .getByRole("heading", { name: "雨夜钟楼", level: 3 })
      .closest(".ink-card");
    if (!(deletedCard instanceof HTMLElement)) {
      throw new Error("找不到已删除素材卡片。");
    }
    await user.click(within(deletedCard).getByRole("button", { name: "恢复素材" }));
    await waitFor(() => {
      const restoredCard = screen
        .getByRole("heading", { name: "雨夜钟楼", level: 3 })
        .closest(".ink-card");
      expect(restoredCard).not.toBeNull();
      if (restoredCard instanceof HTMLElement) {
        expect(within(restoredCard).getByText("有效")).toBeInTheDocument();
        expect(within(restoredCard).getByText("生成：允许")).toBeInTheDocument();
      }
    });
  }, 20_000);

  it("merges a source without rewriting its immutable citation provenance", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const seeded = await seedProject(runtime);
    const source = await createMaterial(runtime, seeded.projectId, {
      title: "码头旧档",
      body: "潮水退去后，石阶下露出一枚刻着旧王室徽记的铜扣。",
    });
    const survivor = await createMaterial(runtime, seeded.projectId, {
      title: "码头档案汇编",
      body: "港务档案记载，旧王室徽记只出现在北侧军用码头。",
    });
    const reference = await runtime.story.materialService.createReference({
      materialId: source.id,
      targetChapterId: seeded.chapterId,
      expectedTargetVersionId: seeded.versionId,
      excerptStart: 0,
      excerptEnd: source.body.length,
      note: "保留旧档原始出处。",
      humanConfirmed: true,
    });
    if (!reference.ok) {
      throw reference.error;
    }

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${seeded.projectId}/materials`);
    const sourceHeading = await screen.findByRole("heading", { name: "码头旧档", level: 3 });
    const sourceCard = sourceHeading.closest(".ink-card");
    if (!(sourceCard instanceof HTMLElement)) {
      throw new Error("找不到待合并素材卡片。");
    }
    await user.click(within(sourceCard).getByRole("button", { name: "合并到…" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "保留素材" }), survivor.id);
    expect(
      screen.getByText(/当前影响：1 条章节引用。合并不会迁移或覆盖这些引用/u),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认合并" }));

    await waitFor(() => {
      const mergedCard = screen
        .getByRole("heading", { name: "码头旧档", level: 3 })
        .closest(".ink-card");
      expect(mergedCard).not.toBeNull();
      if (mergedCard instanceof HTMLElement) {
        expect(within(mergedCard).getByText("已合并")).toBeInTheDocument();
        expect(within(mergedCard).getByText("保留旧档原始出处。")).toBeInTheDocument();
      }
    });

    const loadedSource = await runtime.story.materials.findById(source.id);
    const references = await runtime.story.materialReferences.listByMaterialId(source.id);
    expect(loadedSource.ok && loadedSource.value?.status).toBe("merged");
    expect(loadedSource.ok && loadedSource.value?.toSnapshot().mergedIntoId).toBe(survivor.id);
    expect(references.ok && references.value[0]?.toSnapshot().provenance.materialId).toBe(
      source.id,
    );
    expect(references.ok && references.value[0]?.toSnapshot().provenance.title).toBe("码头旧档");
  });
});

function renderRoute(runtime: DesktopRuntime, route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function seedProject(runtime: DesktopRuntime) {
  const project = await runtime.useCases.createProject.execute({ name: "雾港素材项目" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章 雨钟",
    content: "守塔人在雨中抬起头。",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return {
    projectId: project.value.id,
    chapterId: chapter.value.chapter.id,
    versionId: chapter.value.chapter.currentVersionId,
  };
}

async function fillMaterialForm(
  user: UserEvent,
  input: {
    readonly title: string;
    readonly sourceName: string;
    readonly author?: string;
    readonly sourceUrl?: string;
    readonly license?: "owned";
    readonly rightsBasis: string;
    readonly summary: string;
    readonly body: string;
    readonly allowGeneration?: boolean;
  },
): Promise<void> {
  await user.type(screen.getByRole("textbox", { name: "素材标题" }), input.title);
  await user.type(screen.getByRole("textbox", { name: "来源名称" }), input.sourceName);
  if (input.author !== undefined) {
    await user.type(screen.getByRole("textbox", { name: /^作者/u }), input.author);
  }
  if (input.sourceUrl !== undefined) {
    await user.type(screen.getByRole("textbox", { name: /^来源网址/u }), input.sourceUrl);
  }
  if (input.license !== undefined) {
    await user.selectOptions(screen.getByRole("combobox", { name: "许可类型" }), input.license);
  }
  const rightsBasis = screen.getByRole("textbox", { name: "权利依据" });
  await user.clear(rightsBasis);
  await user.type(rightsBasis, input.rightsBasis);
  if (input.license !== undefined) {
    await user.click(screen.getByRole("checkbox", { name: "我已核对上述权利依据" }));
  }
  if (input.allowGeneration === true) {
    await user.click(screen.getByRole("checkbox", { name: "允许作为生成参考" }));
  }
  await user.type(screen.getByRole("textbox", { name: "摘要" }), input.summary);
  await user.type(screen.getByRole("textbox", { name: "素材正文" }), input.body);
}

async function createMaterial(
  runtime: DesktopRuntime,
  projectId: string,
  input: { readonly title: string; readonly body: string },
) {
  const fingerprint = await runtime.hasher.sha256(input.body);
  if (!fingerprint.ok) {
    throw fingerprint.error;
  }
  const created = await runtime.story.materialService.create({
    projectId,
    title: input.title,
    sourceName: "测试自有档案",
    author: null,
    sourceUrl: null,
    license: "owned",
    rightsBasis: "测试作者自有内容。",
    rightsConfirmed: true,
    allowGeneration: true,
    allowTraining: false,
    tags: ["档案"],
    summary: input.title,
    body: input.body,
    contentFingerprint: fingerprint.value,
    humanConfirmed: true,
  });
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}

function parseStoryId(value: string) {
  const parsed = parseStoryUuid(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}
