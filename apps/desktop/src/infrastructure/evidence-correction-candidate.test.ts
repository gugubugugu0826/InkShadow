import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "./runtime";
import { createEvidenceCorrectionCandidate } from "./evidence-correction-candidate";

describe("createEvidenceCorrectionCandidate", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists only a ready Candidate while the stable chapter stays unchanged", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = unwrap(await runtime.useCases.createProject.execute({ name: "证据修改" }));
    const created = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: "林遥已经死去。",
      }),
    );
    const chapter = created.chapter;
    const hash = unwrap(await runtime.hasher.sha256(chapter.content));

    const candidate = await createEvidenceCorrectionCandidate(runtime, {
      projectId: project.id,
      chapterId: chapter.id,
      expectedChapterVersionId: chapter.currentVersionId,
      evidence: {
        sourceKind: "chapter",
        sourceId: chapter.id,
        sourceVersionId: chapter.currentVersionId,
        contentHash: hash,
        locator: `chapter:${String(chapter.id)}#utf16:0-${String(chapter.content.length)}`,
        excerpt: chapter.content,
        startOffset: 0,
        endOffset: chapter.content.length,
        sourceLength: chapter.content.length,
      },
      replacement: "林遥仍然活着。",
    });

    expect(candidate.toSnapshot()).toMatchObject({
      status: "ready",
      source: "polish",
      content: "林遥仍然活着。",
      baseVersionId: chapter.currentVersionId,
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    const stable = unwrap(await runtime.repositories.chapters.findById(chapter.id));
    expect(stable?.content).toBe("林遥已经死去。");
  });

  it("fails closed when the evidence no longer identifies the exact text", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = unwrap(await runtime.useCases.createProject.execute({ name: "证据失效" }));
    const created = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: "原始正文。",
      }),
    );
    const chapter = created.chapter;
    const hash = unwrap(await runtime.hasher.sha256(chapter.content));

    await expect(
      createEvidenceCorrectionCandidate(runtime, {
        projectId: project.id,
        chapterId: chapter.id,
        expectedChapterVersionId: chapter.currentVersionId,
        evidence: {
          sourceKind: "chapter",
          sourceId: chapter.id,
          sourceVersionId: chapter.currentVersionId,
          contentHash: hash,
          locator: "tampered",
          excerpt: "不是当前原文",
          startOffset: 0,
          endOffset: chapter.content.length,
          sourceLength: chapter.content.length,
        },
        replacement: "替换正文。",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_MISMATCH" });
    const candidates = unwrap(await runtime.repositories.aiCandidates.listByChapterId(chapter.id));
    expect(candidates).toHaveLength(0);
  });
});

function unwrap<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  if (!result.ok) throw result.error;
  return result.value;
}
