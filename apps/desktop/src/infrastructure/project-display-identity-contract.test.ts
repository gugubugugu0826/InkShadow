import { AiCandidate, type UuidV7 } from "@inkshadow/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { collectProjectExportSnapshot } from "./project-export-snapshot";
import { createDevelopmentRuntime, type DesktopRuntime } from "./runtime";

describe("测试作品标记完整合同", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("标记、重启和取消标记只改变显示身份，不改变正文、版本、候选或导出", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const projectResult = await runtime.useCases.createProject.execute({ name: "未命名新故事" });
    expect(projectResult.ok).toBe(true);
    if (!projectResult.ok) throw projectResult.error;
    const project = projectResult.value;
    const chapterResult = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第一章",
      content: "这段正文必须在作品分类变化前后保持不变。",
    });
    expect(chapterResult.ok).toBe(true);
    if (!chapterResult.ok) throw chapterResult.error;
    const chapter = chapterResult.value.chapter;
    const streaming = AiCandidate.createStreaming({
      id: runtime.ids.next(),
      projectId: project.id,
      chapterId: chapter.id,
      source: "generate",
      baseVersionId: chapter.currentVersionId,
      now: runtime.clock.now(),
    });
    expect(streaming.ok).toBe(true);
    if (!streaming.ok) throw streaming.error;
    const candidateContent = "这是仍在等待作者决定的隔离候选。";
    const checksum = await runtime.hasher.sha256(candidateContent);
    expect(checksum.ok).toBe(true);
    if (!checksum.ok) throw checksum.error;
    const ready = streaming.value.markReady(candidateContent, checksum.value, runtime.clock.now());
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw ready.error;
    const candidate = ready.value;
    const stored = await runtime.repositories.aiCandidates.create(candidate);
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw stored.error;

    const initialIdentity = await runtime.repositories.projectDisplayIdentities.resolveByProjectId(
      project.id,
    );
    expect(initialIdentity.ok && initialIdentity.value).toMatchObject({
      displayKind: "author_work",
      provenance: "explicit_creation",
      revision: 1,
    });
    const before = await contentAndExportSnapshot(runtime, project.id, chapter.id, candidate.id);

    const marked = await runtime.repositories.projectDisplayIdentities.recordTestWork(
      project.id,
      runtime.clock.now(),
    );
    expect(marked.ok && marked.value).toMatchObject({
      displayKind: "test_work",
      provenance: "explicit_test",
      revision: 2,
    });
    expect(await contentAndExportSnapshot(runtime, project.id, chapter.id, candidate.id)).toEqual(
      before,
    );

    const restarted = createDevelopmentRuntime(window.localStorage);
    const afterRestart = await restarted.repositories.projectDisplayIdentities.resolveByProjectId(
      project.id,
    );
    expect(afterRestart.ok && afterRestart.value).toMatchObject({
      displayKind: "test_work",
      provenance: "explicit_test",
      revision: 2,
    });
    expect(await contentAndExportSnapshot(restarted, project.id, chapter.id, candidate.id)).toEqual(
      before,
    );

    const restored = await restarted.repositories.projectDisplayIdentities.recordAuthorWork(
      project.id,
      restarted.clock.now(),
    );
    expect(restored.ok && restored.value).toMatchObject({
      displayKind: "author_work",
      provenance: "explicit_creation",
      revision: 3,
    });
    expect(await contentAndExportSnapshot(restarted, project.id, chapter.id, candidate.id)).toEqual(
      before,
    );
    const revisions = await restarted.repositories.projectDisplayIdentities.listRevisions(
      project.id,
    );
    expect(revisions.ok && revisions.value.map(({ displayKind }) => displayKind)).toEqual([
      "author_work",
      "test_work",
      "author_work",
    ]);
  });
});

async function contentAndExportSnapshot(
  runtime: DesktopRuntime,
  projectId: UuidV7,
  chapterId: UuidV7,
  candidateId: UuidV7,
) {
  const project = await runtime.repositories.projects.findById(projectId);
  const chapter = await runtime.repositories.chapters.findById(chapterId);
  const versions = await runtime.repositories.chapterVersions.listByChapterId(chapterId);
  const candidate = await runtime.repositories.aiCandidates.findById(candidateId);
  const exported = await collectProjectExportSnapshot(
    {
      projects: runtime.repositories.projects,
      chapters: runtime.repositories.chapters,
      story: {
        outlines: runtime.story.outlines,
        formalRecords: runtime.story.formalRecords,
        extractionItems: runtime.story.extractionItems,
        consistencyItems: runtime.story.consistencyItems,
      },
      generationGovernance: runtime.generationGovernance,
      clock: runtime.clock,
    },
    projectId,
  );
  expect(project.ok && project.value).not.toBeNull();
  expect(chapter.ok && chapter.value).not.toBeNull();
  expect(versions.ok).toBe(true);
  expect(candidate.ok && candidate.value).not.toBeNull();
  expect(exported.ok).toBe(true);
  if (!project.ok || project.value === null) throw new Error("作品读取失败");
  if (!chapter.ok || chapter.value === null) throw new Error("章节读取失败");
  if (!versions.ok) throw versions.error;
  if (!candidate.ok || candidate.value === null) throw new Error("候选读取失败");
  if (!exported.ok) throw exported.error;
  return {
    project: project.value.toSnapshot(),
    chapter: chapter.value.toSnapshot(),
    versions: versions.value.map((version) => version.toSnapshot()),
    candidate: candidate.value.toSnapshot(),
    export: {
      project: exported.value.project,
      chapters: exported.value.chapters,
      outline: exported.value.outline,
      formalRecords: exported.value.formalRecords,
      review: exported.value.review,
      aiUsage: exported.value.aiUsage,
    },
  };
}
