// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime, executeGenerationPlan, prepareGenerationPlan } from "./runtime";
import {
  selectionWritingActionLabel,
  selectionWritingActionFromIntent,
  selectionWritingModelTask,
} from "./selection-rewrite-service";

describe("editor generation action identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([
    ["   ", "prose_generation", "生成开头"],
    ["已保存正文", "continuation", "生成续写建议"],
  ] as const)(
    "maps authoritative immutable body %j to %s / %s",
    async (content, modelTask, actionLabel) => {
      const { runtime, chapterId } = await seedChapter(content);

      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: true,
        networkAvailable: true,
      });

      expect(plan).toMatchObject({ modelTask, actionLabel });
      const prompt = plan.messages.map(({ content: message }) => message).join("\n");
      if (modelTask === "prose_generation") {
        expect(prompt).toContain("创作本章开头");
        expect(prompt).not.toContain("请续写下一段情节");
      } else {
        expect(prompt).toContain("请续写下一段情节");
        expect(prompt).not.toContain("当前章节为空白");
      }
    },
  );

  it("persists the opening identity in bounded background-task metadata", async () => {
    const { runtime, chapterId } = await seedChapter("");
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const result = await executeGenerationPlan(runtime, plan);

    expect(result.ok).toBe(true);
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(plan.idempotencyKey),
    ).resolves.toMatchObject({
      metadata: { modelTask: "prose_generation" },
    });
  });

  it.each([
    [undefined, "selection_rewrite"],
    ["selection_rewrite", "selection_rewrite"],
    ["polish", "polish"],
    ["expand", "expand"],
    ["shorten", "shorten"],
  ] as const)("restores persisted selection action %s as %s", (selectionAction, expected) => {
    expect(
      selectionWritingActionFromIntent({
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: 1,
        endUtf16: 2,
        ...(selectionAction === undefined ? {} : { selectionAction }),
      }),
    ).toBe(expected);
  });

  it.each([
    ["selection_rewrite", "改写", "rewrite"],
    ["polish", "润色", "polish"],
    ["expand", "扩写", "rewrite"],
    ["shorten", "缩写", "rewrite"],
  ] as const)("keeps %s as %s on the safe existing %s task", (action, label, task) => {
    expect(selectionWritingActionLabel(action)).toBe(label);
    expect(selectionWritingModelTask(action)).toBe(task);
  });
});

async function seedChapter(content: string) {
  const runtime = createDevelopmentRuntime(window.localStorage);
  const project = await runtime.useCases.createProject.execute({ name: "动作身份测试" });
  if (!project.ok) throw project.error;
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content,
  });
  if (!chapter.ok) throw chapter.error;
  return { runtime, chapterId: chapter.value.chapter.id };
}
