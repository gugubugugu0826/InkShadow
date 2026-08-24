import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureCurrentSavedVersionStoryFactsForDirectMode } from "./accepted-chapter-fact-preflight";
import { AcceptedChapterPipelineWorker, retryInput } from "./accepted-chapter-pipeline-worker";
import { createDevelopmentRuntime } from "./runtime";

const IMPORTED_CONTENT = [
  "周望是钟楼的管理员。",
  "周望五十七岁。",
  "周望担任钟楼管理员。",
  "周望在旧城守了三十一年。",
  "周望和赵伯是多年的老邻居。",
  "钟摆倒转。",
].join("");

describe("imported chapter local story-fact organization", () => {
  beforeEach(() => window.localStorage.clear());

  it("organizes the committed immutable import after restart, with exact evidence and zero remote calls", async () => {
    const first = createDevelopmentRuntime(window.localStorage);
    const firstGenerate = vi.spyOn(first.modelGateway, "generate");
    const imported = expectOk(
      await first.useCases.importProject.execute({
        name: "钟楼旧城导入",
        chapters: [{ title: "第一章", content: IMPORTED_CONTENT }],
      }),
    );
    const project = imported.project;
    const chapter = expectPresent(imported.chapters[0]);
    const chapterBefore = expectPresent(
      expectOk(await first.repositories.chapters.findById(chapter.id)),
    ).toSnapshot();
    const versionBefore = expectPresent(
      expectOk(
        await first.repositories.chapterVersions.findVersionById(chapterBefore.currentVersionId),
      ),
    ).toSnapshot();
    expect(versionBefore).toMatchObject({
      content: IMPORTED_CONTENT,
      reason: "import",
      organizeLocalStoryFacts: true,
    });

    const queued = expectPresent(
      (await first.taskCenter.load()).tasks.find(
        (task) => task.metadata.versionId === versionBefore.id,
      ),
    );
    expect(queued).toMatchObject({
      status: "queued",
      metadata: {
        source: "chapter_import",
        projectId: project.id,
        chapterId: chapter.id,
        versionId: versionBefore.id,
        organizeLocalStoryFacts: true,
      },
    });
    const input = expectPresent(retryInput(queued));
    expect(
      expectStoryOk(await first.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toHaveLength(0);

    const restarted = createDevelopmentRuntime(window.localStorage);
    const restartedGenerate = vi.spyOn(restarted.modelGateway, "generate");
    const reportError = vi.fn();
    const worker = new AcceptedChapterPipelineWorker(restarted, {
      queuedGraceMilliseconds: 0,
      ensureCurrentFacts: (pipelineInput) =>
        ensureCurrentSavedVersionStoryFactsForDirectMode(restarted, pipelineInput),
      reportError,
    });

    await expect(worker.runDueTasksNow()).resolves.toBe(1);

    const settings = expectStoryOk(
      await restarted.story.facts.listByProjectId(expectStoryUuid(project.id)),
    )
      .map((fact) => fact.toSnapshot())
      .filter(({ factType }) => factType !== "chapter_summary");
    expect(settings).toHaveLength(7);
    expect(settings.map(({ source }) => source.excerpt)).toEqual(
      expect.arrayContaining([
        "周望是钟楼的管理员。",
        "周望五十七岁。",
        "周望担任钟楼管理员。",
        "周望在旧城守了三十一年。",
        "周望和赵伯是多年的老邻居。",
        "钟摆倒转。",
      ]),
    );
    expect(
      settings.map(({ source }) => ({
        excerpt: source.excerpt,
        startOffset: source.startOffset,
        endOffset: source.endOffset,
      })),
    ).toEqual(
      expect.arrayContaining([
        { excerpt: "周望是钟楼的管理员。", startOffset: 0, endOffset: 10 },
        { excerpt: "周望五十七岁。", startOffset: 10, endOffset: 17 },
        { excerpt: "周望担任钟楼管理员。", startOffset: 17, endOffset: 27 },
        { excerpt: "周望在旧城守了三十一年。", startOffset: 27, endOffset: 39 },
        { excerpt: "周望和赵伯是多年的老邻居。", startOffset: 39, endOffset: 52 },
        { excerpt: "钟摆倒转。", startOffset: 52, endOffset: 57 },
      ]),
    );
    for (const setting of settings) {
      expect(setting).toMatchObject({
        status: "unconfirmed",
        origin: "system",
        needsReview: true,
        userConfirmed: false,
        source: {
          chapterId: chapter.id,
          versionId: versionBefore.id,
          sourceLength: IMPORTED_CONTENT.length,
        },
      });
      expect(
        IMPORTED_CONTENT.slice(setting.source.startOffset ?? -1, setting.source.endOffset ?? -1),
      ).toBe(setting.source.excerpt);
    }
    const factIdsBeforeRetry = expectStoryOk(
      await restarted.story.facts.listByProjectId(expectStoryUuid(project.id)),
    )
      .map(({ id }) => id)
      .sort();
    await ensureCurrentSavedVersionStoryFactsForDirectMode(restarted, input);
    const factIdsAfterRetry = expectStoryOk(
      await restarted.story.facts.listByProjectId(expectStoryUuid(project.id)),
    )
      .map(({ id }) => id)
      .sort();
    expect(factIdsAfterRetry).toEqual(factIdsBeforeRetry);
    expect(reportError).not.toHaveBeenCalled();
    expect(firstGenerate).not.toHaveBeenCalled();
    expect(restartedGenerate).not.toHaveBeenCalled();
  });

  it("keeps imported body and immutable version when local organization fails", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const imported = expectOk(
      await runtime.useCases.importProject.execute({
        name: "整理失败仍安全",
        chapters: [{ title: "第一章", content: IMPORTED_CONTENT }],
      }),
    );
    const chapter = expectPresent(imported.chapters[0]);
    const chapterBefore = expectPresent(
      expectOk(await runtime.repositories.chapters.findById(chapter.id)),
    ).toSnapshot();
    const versionBefore = expectPresent(
      expectOk(
        await runtime.repositories.chapterVersions.findVersionById(chapterBefore.currentVersionId),
      ),
    ).toSnapshot();
    const queued = expectPresent(
      (await runtime.taskCenter.load()).tasks.find(
        (task) => task.metadata.versionId === versionBefore.id,
      ),
    );
    const reportError = vi.fn();
    const worker = new AcceptedChapterPipelineWorker(runtime, {
      queuedGraceMilliseconds: 0,
      ensureCurrentFacts: vi.fn().mockRejectedValue(new Error("injected local organizer failure")),
      reportError,
    });

    await expect(worker.runDueTasksNow()).resolves.toBe(1);

    expect(
      expectPresent(
        expectOk(await runtime.repositories.chapters.findById(chapter.id)),
      ).toSnapshot(),
    ).toEqual(chapterBefore);
    expect(
      expectPresent(
        expectOk(await runtime.repositories.chapterVersions.findVersionById(versionBefore.id)),
      ).toSnapshot(),
    ).toEqual(versionBefore);
    expect(
      expectStoryOk(
        await runtime.story.facts.listByProjectId(expectStoryUuid(imported.project.id)),
      ),
    ).toHaveLength(0);
    expect(
      (await runtime.taskCenter.load()).tasks.find((task) => task.id === queued.id),
    ).toMatchObject({
      status: "waiting_retry",
      failure: {
        code: "ACCEPTED_VERSION_FACT_PREFLIGHT_FAILED",
        causeCode: "CURRENT_SAVED_VERSION_FACTS_UNAVAILABLE",
        retryable: true,
      },
    });
    expect(reportError).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });
});

function expectOk<Value>(result: { ok: true; value: Value } | { ok: false; error: Error }): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectStoryOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: Error },
): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectPresent<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) {
    throw new Error("Expected a persisted value.");
  }
  return value;
}

function expectStoryUuid(value: string) {
  return expectStoryOk(parseStoryUuidV7(value));
}
