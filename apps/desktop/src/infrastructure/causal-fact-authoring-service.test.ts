import { parseUuidV7 as parseStoryUuid } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import { CausalFactAuthoringService } from "./causal-fact-authoring-service";
import { createDevelopmentRuntime } from "./runtime";

describe("causal fact authoring service", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates explicit evidence-backed events and a relation, then rebuilds the main graph", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "因果编辑测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content:
        "林夏推开旧门，发现门后没有走廊。她立刻把钥匙交给周鸣。门轴随后断裂，唯一的出口被彻底封住。",
    });
    if (!chapter.ok) throw chapter.error;
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      projector: runtime.story.causalProjector,
    });

    const first = await service.createEvent({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "林夏推开旧门，发现门后没有走廊。",
      eventText: "林夏推开旧门",
      resultText: "她发现门后没有走廊",
      narrativeOrder: 10,
      narrativeLabel: "当晚",
      locationLabel: "旧门前",
      participantCharacterIds: ["林夏", "周鸣"],
      informedCharacterIds: ["林夏"],
      actorId: runtime.story.actorId,
    });
    const second = await service.createEvent({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "门轴随后断裂，唯一的出口被彻底封住。",
      eventText: "旧门的门轴断裂",
      resultText: "唯一出口被封住",
      narrativeOrder: 20,
      narrativeLabel: "片刻后",
      locationLabel: "旧门前",
      actorId: runtime.story.actorId,
    });

    expect(first.fact.toSnapshot()).toMatchObject({
      factType: "causal_event",
      status: "formal",
      userConfirmed: true,
      source: {
        kind: "chapter_span",
        excerpt: "林夏推开旧门，发现门后没有走廊。",
      },
      structuredValue: {
        participantCharacterIds: ["林夏", "周鸣"],
        informedCharacterIds: ["林夏"],
      },
    });
    expect(second.projection.graph.events).toHaveLength(2);

    const related = await service.createRelation({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "她立刻把钥匙交给周鸣。门轴随后断裂",
      fromEventId: first.fact.id,
      toEventId: second.fact.id,
      kind: "causes",
      actorId: runtime.story.actorId,
    });

    expect(related.fact.toSnapshot()).toMatchObject({
      factType: "causal_relation",
      status: "formal",
      source: { kind: "chapter_span" },
    });
    expect(related.projection.graph.events).toHaveLength(2);
    expect(related.projection.graph.relations).toEqual([
      expect.objectContaining({
        fromEventId: first.fact.id,
        toEventId: second.fact.id,
        kind: "causes",
      }),
    ]);
  });

  it("refuses evidence that is missing or appears more than once", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "证据门禁测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "钟声响起。钟声响起。",
    });
    if (!chapter.ok) throw chapter.error;
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      projector: runtime.story.causalProjector,
    });
    const input = {
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      eventText: "钟声响起",
      resultText: "人物听见钟声",
      narrativeOrder: 10,
      narrativeLabel: "午夜",
      locationLabel: "钟楼",
      actorId: runtime.story.actorId,
    } as const;

    await expect(
      service.createEvent({ ...input, evidenceExcerpt: "不存在的句子" }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_EVIDENCE_NOT_FOUND" });
    await expect(
      service.createEvent({ ...input, evidenceExcerpt: "钟声响起。" }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_EVIDENCE_AMBIGUOUS" });
    const storyProjectId = parseStoryUuid(project.value.id);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
    expect(facts.ok && facts.value).toEqual([]);
  });
});
