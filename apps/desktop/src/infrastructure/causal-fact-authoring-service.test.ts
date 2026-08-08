import { parseUuidV7 as parseStoryUuid, type StoryFact } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CausalFactAuthoringService } from "./causal-fact-authoring-service";
import { DEVELOPMENT_DATABASE_KEY } from "./development-storage";
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
    await confirmCharacter(runtime, project.value.id, "character-linxia", "林夏");
    await confirmCharacter(runtime, project.value.id, "character-zhouming", "周鸣");
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
    });

    const first = await service.createEvent({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "林夏推开旧门，发现门后没有走廊。她立刻把钥匙交给周鸣。",
      eventText: "林夏推开旧门并交出钥匙",
      resultText: "她发现门后没有走廊，周鸣取得钥匙",
      narrativeOrder: 10,
      narrativeLabel: "当晚",
      locationLabel: "旧门前",
      participantCharacterIds: ["character-linxia"],
      informedCharacterIds: ["character-linxia"],
      knowledgeGains: [
        {
          characterId: "character-linxia",
          knowledgeLabel: "门后结构",
          informationText: "旧门后没有走廊",
        },
      ],
      prerequisites: [
        { kind: "state", referenceLabel: "持有旧门钥匙", description: "林夏先持有钥匙" },
        { kind: "rule", referenceLabel: "旧门只能用钥匙开启", description: "必须使用钥匙" },
      ],
      characterStateChanges: [
        {
          characterId: "character-linxia",
          attributeLabel: "对旧门的认知",
          beforeValue: "以为门后有走廊",
          afterValue: "确认门后没有走廊",
        },
      ],
      relationshipChanges: [
        {
          fromCharacterId: "character-linxia",
          toCharacterId: "character-zhouming",
          relationshipLabel: "信任程度",
          beforeValue: "保留",
          afterValue: "信任",
        },
      ],
      itemChanges: [
        {
          itemLabel: "旧门钥匙",
          kind: "transferred",
          fromCharacterId: "character-linxia",
          toCharacterId: "character-zhouming",
        },
      ],
      foreshadowProgress: [
        {
          foreshadowLabel: "门后没有走廊",
          kind: "planted",
          description: "埋下旧门结构异常的线索",
        },
      ],
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
      prerequisites: [
        {
          kind: "event",
          referenceId: first.fact.id,
          referenceLabel: "林夏打开旧门",
          description: "旧门先被打开",
        },
      ],
      actorId: runtime.story.actorId,
    });

    const firstSnapshot = first.fact.toSnapshot();
    expect(firstSnapshot).toMatchObject({
      factType: "causal_event",
      status: "formal",
      userConfirmed: true,
      source: {
        kind: "chapter_span",
        excerpt: "林夏推开旧门，发现门后没有走廊。她立刻把钥匙交给周鸣。",
      },
      structuredValue: {
        participantCharacterIds: ["character-linxia"],
        schemaVersion: "inkshadow.causal-event-fact.v2",
        informedCharacterIds: ["character-linxia"],
        knowledgeGains: [
          {
            characterId: "character-linxia",
          },
        ],
        characterStateChanges: [
          {
            characterId: "character-linxia",
            attributeLabel: "对旧门的认知",
            beforeValue: "以为门后有走廊",
            afterValue: "确认门后没有走廊",
          },
        ],
        relationshipChanges: [
          {
            fromCharacterId: "character-linxia",
            toCharacterId: "character-zhouming",
            relationshipLabel: "信任程度",
          },
        ],
        itemChanges: [{ itemLabel: "旧门钥匙", kind: "transferred" }],
        foreshadowProgress: [{ foreshadowLabel: "门后没有走廊", kind: "planted" }],
      },
    });
    const firstStructured = firstSnapshot.structuredValue as Readonly<{
      knowledgeGains: readonly Readonly<{
        attributeKey: string;
        informationId: string;
      }>[];
    }>;
    expect(firstStructured.knowledgeGains[0]?.attributeKey).toMatch(/^k-[a-f0-9]{16}$/u);
    expect(firstStructured.knowledgeGains[0]?.informationId).toMatch(/^i-[a-f0-9]{16}$/u);
    expect(second.projection?.graph.events).toHaveLength(2);
    const projectedFirstEvent = second.projection?.graph.events.find(
      ({ id }) => id === first.fact.id,
    );
    expect(
      projectedFirstEvent?.prerequisites.some(
        ({ referenceLabel }) => referenceLabel === "持有旧门钥匙",
      ),
    ).toBe(true);
    expect(
      projectedFirstEvent?.characterStateChanges.some(
        ({ attributeLabel }) => attributeLabel === "对旧门的认知",
      ),
    ).toBe(true);
    expect(
      projectedFirstEvent?.relationshipChanges.some(
        ({ relationshipLabel }) => relationshipLabel === "信任程度",
      ),
    ).toBe(true);
    expect(projectedFirstEvent?.itemChanges.some(({ itemLabel }) => itemLabel === "旧门钥匙")).toBe(
      true,
    );
    expect(
      projectedFirstEvent?.foreshadowProgress.some(
        ({ foreshadowLabel }) => foreshadowLabel === "门后没有走廊",
      ),
    ).toBe(true);
    const projectedSecondEvent = second.projection?.graph.events.find(
      ({ id }) => id === second.fact.id,
    );
    expect(projectedSecondEvent?.prerequisites).toHaveLength(1);
    expect(projectedSecondEvent?.prerequisites[0]).toMatchObject({
      kind: "event",
      referenceId: first.fact.id,
    });
    expect(second.projection?.graph.relations).toEqual([
      expect.objectContaining({
        fromEventId: first.fact.id,
        toEventId: second.fact.id,
        kind: "depends_on",
      }),
    ]);

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
    expect(related.projection?.graph.events).toHaveLength(2);
    expect(related.projection?.graph.relations).toEqual([
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
      factStore: runtime.story.facts,
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

  it("rejects incomplete, unbound, unsafe, or duplicate explicit knowledge gains", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "知识取得门禁测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "林夏读完密信，知道了真正的继承人。",
    });
    if (!chapter.ok) throw chapter.error;
    await confirmCharacter(runtime, project.value.id, "character-linxia", "林夏");
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
    });
    const input = {
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "林夏读完密信，知道了真正的继承人。",
      eventText: "林夏读完密信",
      resultText: "林夏知道真正继承人的身份",
      narrativeOrder: 10,
      narrativeLabel: "当晚",
      locationLabel: "书房",
      informedCharacterIds: ["character-linxia"],
      actorId: runtime.story.actorId,
    } as const;
    const gain = {
      characterId: "character-linxia",
      attributeKey: "heir-identity",
      informationId: "heir-is-mira",
    } as const;

    await expect(
      service.createEvent({
        ...input,
        knowledgeGains: [{ ...gain, characterId: "character-zhouming" }],
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_INPUT_INVALID" });
    await expect(
      service.createEvent({
        ...input,
        knowledgeGains: [{ ...gain, informationId: "contains spaces" }],
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_INPUT_INVALID" });
    await expect(
      service.createEvent({ ...input, knowledgeGains: [gain, gain] }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_INPUT_INVALID" });
    await expect(
      service.createEvent({ ...input, participantCharacterIds: ["character-not-confirmed"] }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_CHARACTER_NOT_CONFIRMED" });
  });

  it("persists 128 explicit knowledge gains when they fit and explains the bounded payload limit", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "知识边界测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "林夏读完了名单。",
    });
    if (!chapter.ok) throw chapter.error;
    await confirmCharacter(runtime, project.value.id, "character-linxia", "林夏");
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
    });
    const knowledgeGains = Array.from({ length: 128 }, (_, index) => ({
      characterId: "character-linxia",
      knowledgeLabel: `名单类别${String(index)}`,
      informationText: `名单事实${String(index)}`,
    }));
    const created = await service.createEvent({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "林夏读完了名单。",
      eventText: "林夏读完名单",
      resultText: "林夏得知名单内容",
      narrativeOrder: 10,
      narrativeLabel: "当晚",
      locationLabel: "书房",
      informedCharacterIds: ["character-linxia"],
      knowledgeGains,
      actorId: runtime.story.actorId,
    });
    expect(
      (
        created.fact.toSnapshot().structuredValue as Readonly<{
          knowledgeGains: readonly unknown[];
        }>
      ).knowledgeGains,
    ).toHaveLength(128);

    let oversizedFailure: unknown;
    try {
      await service.createEvent({
        projectId: project.value.id,
        chapterId: chapter.value.chapter.id,
        evidenceExcerpt: "林夏读完了名单。",
        eventText: "事".repeat(2_000),
        resultText: "果".repeat(2_000),
        narrativeOrder: 20,
        narrativeLabel: "时".repeat(2_000),
        locationLabel: "地".repeat(2_000),
        informedCharacterIds: ["character-linxia"],
        knowledgeGains,
        actorId: runtime.story.actorId,
      });
    } catch (cause: unknown) {
      oversizedFailure = cause;
    }
    expect(oversizedFailure).toMatchObject({ code: "CAUSAL_AUTHORING_INPUT_INVALID" });
    if (!(oversizedFailure instanceof Error)) {
      throw new Error("Expected a bounded causal authoring error.");
    }
    expect(oversizedFailure.message).toContain("拆成两个事件");
  });

  it("atomically rejects a stale current-version fence without creating a formal fact", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "版本栅栏测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "旧版本中，钟声只响了一次。",
    });
    if (!chapter.ok) throw chapter.error;
    const originalFacts = runtime.story.factService;
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
      facts: {
        createFormalUserFactWithAuthorityFence: async (command, fence) => {
          const serialized = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
          if (serialized === null) throw new Error("Development database missing.");
          const database = JSON.parse(serialized) as {
            chapters: { id: string; currentVersionId: string }[];
          };
          const storedChapter = database.chapters.find(({ id }) => id === chapter.value.chapter.id);
          if (storedChapter === undefined) throw new Error("Chapter missing.");
          storedChapter.currentVersionId = "018f0f00-0000-7000-8000-000000000099";
          window.localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));
          return originalFacts.createFormalUserFactWithAuthorityFence(command, fence);
        },
      },
    });
    await expect(
      service.createEvent({
        projectId: project.value.id,
        chapterId: chapter.value.chapter.id,
        evidenceExcerpt: "旧版本中，钟声只响了一次。",
        eventText: "钟声响起",
        resultText: "众人听见钟声",
        narrativeOrder: 10,
        narrativeLabel: "午夜",
        locationLabel: "钟楼",
        actorId: runtime.story.actorId,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_VERSION_CHANGED" });
    const parsedProjectId = parseStoryUuid(project.value.id);
    if (!parsedProjectId.ok) throw parsedProjectId.error;
    const facts = await runtime.story.facts.listByProjectId(parsedProjectId.value);
    if (!facts.ok) throw facts.error;
    expect(facts.value.filter((fact) => fact.toSnapshot().factType === "causal_event")).toEqual([]);
  });

  it("recovers an identical saved fact after projection failure instead of duplicating it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "幂等恢复测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "林夏拆开信封，看见了地图。",
    });
    if (!chapter.ok) throw chapter.error;
    const rebuildProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("projection unavailable"))
      .mockImplementation((projectId: string, branchId: string) =>
        runtime.story.causalProjector.rebuildProject(projectId, branchId),
      );
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      factStore: runtime.story.facts,
      projector: { rebuildProject },
    });
    const input = {
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "林夏拆开信封，看见了地图。",
      eventText: "林夏看见地图",
      resultText: "林夏知道地图内容",
      narrativeOrder: 10,
      narrativeLabel: "当晚",
      locationLabel: "书房",
      actorId: runtime.story.actorId,
    } as const;
    const first = await service.createEvent(input);
    expect(first).toMatchObject({ persistence: "created", projection: null });
    const recovered = await service.createEvent(input);
    expect(recovered.persistence).toBe("existing");
    expect(recovered.fact.id).toBe(first.fact.id);
    expect(recovered.projection?.graph.events).toHaveLength(1);
  });

  it("rejects a relation when an endpoint is deprecated inside the atomic save boundary", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "关系端点栅栏测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "门被打开。随后门被锁上。",
    });
    if (!chapter.ok) throw chapter.error;
    const base = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.factService,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
    });
    const first = await base.createEvent({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "门被打开。",
      eventText: "门被打开",
      resultText: "通道开放",
      narrativeOrder: 10,
      narrativeLabel: "先前",
      locationLabel: "门口",
      actorId: runtime.story.actorId,
    });
    const second = await base.createEvent({
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      evidenceExcerpt: "随后门被锁上。",
      eventText: "门被锁上",
      resultText: "通道关闭",
      narrativeOrder: 20,
      narrativeLabel: "随后",
      locationLabel: "门口",
      actorId: runtime.story.actorId,
    });
    const originalFacts = runtime.story.factService;
    const raced = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
      facts: {
        createFormalUserFactWithAuthorityFence: async (command, fence) => {
          const deprecated = await originalFacts.deprecate({
            factId: first.fact.id,
            humanConfirmed: true,
            expectedRevision: first.fact.revision,
          });
          if (!deprecated.ok) throw deprecated.error;
          return originalFacts.createFormalUserFactWithAuthorityFence(command, fence);
        },
      },
    });
    await expect(
      raced.createRelation({
        projectId: project.value.id,
        chapterId: chapter.value.chapter.id,
        evidenceExcerpt: "门被打开。随后门被锁上。",
        fromEventId: first.fact.id,
        toEventId: second.fact.id,
        kind: "causes",
        actorId: runtime.story.actorId,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_RELATION_ENDPOINT_INVALID" });
  });

  it("rejects an event when a confirmed character is deprecated inside the atomic save boundary", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "人物事务栅栏测试" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "林夏推开旧门，发现门后没有走廊。",
    });
    if (!chapter.ok) throw chapter.error;
    const character = await confirmCharacter(runtime, project.value.id, "character-linxia", "林夏");
    const originalFacts = runtime.story.factService;
    const service = new CausalFactAuthoringService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      factStore: runtime.story.facts,
      projector: runtime.story.causalProjector,
      facts: {
        createFormalUserFactWithAuthorityFence: async (command, fence) => {
          const deprecated = await originalFacts.deprecate({
            factId: character.id,
            humanConfirmed: true,
            expectedRevision: character.revision,
          });
          if (!deprecated.ok) throw deprecated.error;
          return originalFacts.createFormalUserFactWithAuthorityFence(command, fence);
        },
      },
    });

    await expect(
      service.createEvent({
        projectId: project.value.id,
        chapterId: chapter.value.chapter.id,
        evidenceExcerpt: "林夏推开旧门，发现门后没有走廊。",
        eventText: "林夏推开旧门",
        resultText: "林夏发现门后没有走廊",
        narrativeOrder: 10,
        narrativeLabel: "当晚",
        locationLabel: "旧门前",
        participantCharacterIds: ["character-linxia"],
        actorId: runtime.story.actorId,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_AUTHORING_CHARACTER_NOT_CONFIRMED" });
  });
});

async function confirmCharacter(
  runtime: ReturnType<typeof createDevelopmentRuntime>,
  projectId: string,
  entityKey: string,
  canonicalName: string,
): Promise<StoryFact> {
  const saved = await runtime.story.factService.createFormalUserFact({
    projectId,
    factType: "character_identity",
    contentText: `${canonicalName}是已确认人物。`,
    structuredValue: {
      subject: {
        kind: "character",
        entityKey,
        canonicalName,
        aliases: [canonicalName],
      },
      identity: canonicalName,
    },
    actorId: runtime.story.actorId,
    lock: false,
    humanConfirmed: true,
  });
  if (!saved.ok) throw saved.error;
  return saved.value;
}
