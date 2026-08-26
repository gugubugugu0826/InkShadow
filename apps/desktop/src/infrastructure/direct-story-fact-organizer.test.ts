import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";

import { createDevelopmentRuntime } from "./runtime";
import { parseStoredChapterSummaryPayload } from "./chapter-summary-service";
import { adaptStoryFactContextSource } from "./story-context-source-adapter";
import {
  changedStoryFactOrganizationSpan,
  directStoryFactOrganizerNotice,
  organizeDirectStoryFacts,
  organizeCurrentSavedVersionStoryFacts,
} from "./direct-story-fact-organizer";

const CONTENT = "林澈来到钟楼。周野的真实身份是守门人。陈舟确认死亡。";

describe("direct local story-fact organization", () => {
  beforeEach(() => window.localStorage.clear());

  it("does not present zero extracted facts as a completed organization result", () => {
    expect(
      directStoryFactOrganizerNotice({
        organizedCount: 0,
        importantReviewCount: 0,
        alreadyOrganizedCount: 0,
        sourceWasCurrent: true,
      }),
    ).toBe("正文已保存；未发现有明确原文证据的新设定。你可以用一句话添加设定。");
  });

  it("expands only the changed range to its complete sentence with absolute UTF-16 offset", () => {
    expect(
      changedStoryFactOrganizationSpan(
        "林澈来到钟楼。角色：林",
        "林澈来到钟楼。角色：林澈是守塔人。",
      ),
    ).toEqual({ text: "角色：林澈是守塔人。", startOffset: 7, sourceLength: 17 });
  });

  it("extracts the required explicit character, place, relationship and event sentences as local pending facts", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "钟楼旧城" }));
    const content = [
      "周望是钟楼的管理员。",
      "周望五十七岁。",
      "周望担任钟楼管理员。",
      "周望在旧城守了三十一年。",
      "周望和赵伯是多年的老邻居。",
      "钟摆倒转。",
    ].join("");
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();
    const dependencies = {
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    } as const;
    const input = {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: version.id,
      versionCreatedAt: version.createdAt,
      acceptedText: content,
      acceptedStartOffset: 0,
      sourceLength: content.length,
      sourceContentHash: version.contentChecksum,
      currentVersionId: version.id,
      localOnly: false,
    } as const;

    const receipt = await organizeDirectStoryFacts(dependencies, input);

    expect(receipt).toEqual({
      organizedCount: 6,
      importantReviewCount: 1,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: true,
    });
    const settings = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    )
      .map((fact) => fact.toSnapshot())
      .filter(({ factType }) => factType !== "chapter_summary");
    expect(settings).toHaveLength(7);
    expect(settings.map(({ factType }) => factType)).toEqual(
      expect.arrayContaining([
        "character_profile",
        "location_setting",
        "core_relationship",
        "event_category",
      ]),
    );
    expect(
      settings.every(
        ({ status, origin, needsReview, userConfirmed }) =>
          status === "unconfirmed" && origin === "system" && needsReview && !userConfirmed,
      ),
    ).toBe(true);
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
    for (const setting of settings) {
      expect(setting.source).toMatchObject({
        chapterId: created.chapter.id,
        versionId: version.id,
        sourceLength: content.length,
      });
      expect(content.slice(setting.source.startOffset ?? -1, setting.source.endOffset ?? -1)).toBe(
        setting.source.excerpt,
      );
      expect(setting.structuredValue).toMatchObject({
        payload: {
          evidence: {
            projectId: project.id,
            chapterId: created.chapter.id,
            immutableVersionId: version.id,
            locator: {
              kind: "utf16",
              startOffset: setting.source.startOffset,
              endOffset: setting.source.endOffset,
              sourceLength: content.length,
            },
          },
        },
      });
    }
    const stagedIdentity = settings.find(({ source }) => source.excerpt === "周望是钟楼的管理员。");
    if (stagedIdentity === undefined) throw new Error("找不到待确认的人物身份。");
    const editedIdentity = expectStoryOk(
      await runtime.story.factService.editStagedAsUser({
        factId: stagedIdentity.id,
        contentText: "周望担任钟楼管理员。",
        actorId: runtime.story.actorId,
        humanConfirmed: true,
        expectedRevision: stagedIdentity.revision,
      }),
    ).toSnapshot();
    expect(editedIdentity).toMatchObject({
      status: "formal",
      origin: "user",
      structuredValue: null,
      source: stagedIdentity.source,
    });
    expect(await organizeDirectStoryFacts(dependencies, input)).toEqual({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 7,
      sourceWasCurrent: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("organizes only explicit ordinary evidence, queues important settings, and is restart-idempotent", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "直接整理" }));
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: CONTENT,
        privacyMode: "local_only",
      }),
    );
    const version = created.version.toSnapshot();
    const input = {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: version.id,
      versionCreatedAt: version.createdAt,
      acceptedText: version.content,
      acceptedStartOffset: 0,
      sourceLength: version.content.length,
      currentVersionId: created.chapter.currentVersionId,
      localOnly: true,
    } as const;

    const receipt = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      input,
    );

    expect(receipt).toEqual({
      organizedCount: 1,
      importantReviewCount: 2,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: true,
    });
    expect(directStoryFactOrganizerNotice(receipt)).toBe("已整理 3 条设定");
    const facts = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    );
    expect(facts).toHaveLength(4);
    const settingFacts = facts.filter((fact) => fact.toSnapshot().factType !== "chapter_summary");
    expect(settingFacts).toHaveLength(3);
    expect(
      settingFacts
        .map((fact) => fact.toSnapshot())
        .map((snapshot) => ({
          type: snapshot.factType,
          status: snapshot.status,
          origin: snapshot.origin,
          needsReview: snapshot.needsReview,
        })),
    ).toEqual(
      expect.arrayContaining([
        { type: "scene_tag", status: "unconfirmed", origin: "system", needsReview: true },
        {
          type: "character_identity",
          status: "unconfirmed",
          origin: "system",
          needsReview: true,
        },
        {
          type: "character_death",
          status: "unconfirmed",
          origin: "system",
          needsReview: true,
        },
      ]),
    );
    for (const fact of settingFacts) {
      const snapshot = fact.toSnapshot();
      expect(snapshot.source).toMatchObject({
        kind: "chapter_span",
        chapterId: created.chapter.id,
        versionId: version.id,
        sourceLength: CONTENT.length,
      });
      expect(
        CONTENT.slice(snapshot.source.startOffset ?? -1, snapshot.source.endOffset ?? -1),
      ).toBe(snapshot.source.excerpt);
      expect(snapshot.structuredValue).toMatchObject({
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        payload: {
          schemaVersion: "inkshadow.direct-local-story-fact.v1",
          evidence: {
            projectId: project.id,
            chapterId: created.chapter.id,
            immutableVersionId: version.id,
            sourceKind: "chapter",
            privacy: "local_only",
            currentness: "current",
          },
        },
      });
      const structuredValue = snapshot.structuredValue;
      if (structuredValue === null || typeof structuredValue !== "object") {
        throw new Error("Expected reversible structured story fact metadata.");
      }
      const replacementKey = (structuredValue as Record<string, unknown>).replacementKey;
      if (typeof replacementKey !== "string") {
        throw new Error("Expected a reversible replacement key.");
      }
      expect(replacementKey).toContain(created.chapter.id);
      expect(snapshot.source.reference).toContain(
        `:${version.id}:sha256:${version.contentChecksum}`,
      );
      expect(JSON.stringify(snapshot.structuredValue)).toMatch(/"excerptDigest":"[a-f0-9]{64}"/u);
    }
    const summary = facts.find((fact) => fact.toSnapshot().factType === "chapter_summary");
    if (summary === undefined) throw new Error("Expected the local extractive summary.");
    expect(summary.toSnapshot()).toMatchObject({
      contentText: "林澈来到钟楼。 陈舟确认死亡。",
      status: "temporary",
      origin: "system",
      needsReview: false,
      source: { versionId: version.id, startOffset: 0, endOffset: 7 },
    });
    expect(parseStoredChapterSummaryPayload(summary)).toMatchObject({
      authorityMode: "plain_non_authoritative",
      sourceVersionId: version.id,
    });

    const reopened = createDevelopmentRuntime(window.localStorage);
    const retry = await organizeDirectStoryFacts(
      {
        facts: reopened.story.facts,
        factService: reopened.story.factService,
        hasher: reopened.hasher,
        now: () => reopened.clock.now(),
      },
      input,
    );
    expect(retry).toEqual({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 3,
      sourceWasCurrent: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps one pending fact when the same immutable evidence is organized concurrently", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "并发整理" }));
    const content = "周望五十七岁。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();
    const dependencies = {
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    } as const;
    const input = {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: version.id,
      versionCreatedAt: version.createdAt,
      acceptedText: content,
      acceptedStartOffset: 0,
      sourceLength: content.length,
      sourceContentHash: version.contentChecksum,
      currentVersionId: version.id,
      localOnly: false,
    } as const;

    await Promise.all([
      organizeDirectStoryFacts(dependencies, input),
      organizeDirectStoryFacts(dependencies, input),
    ]);

    const facts = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    )
      .map((fact) => fact.toSnapshot())
      .filter(({ factType }) => factType === "character_profile");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      source: { excerpt: content, versionId: version.id },
      status: "unconfirmed",
      origin: "system",
    });
  });

  it("feeds reversible current-version facts into context and preserves deletion tombstones", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "上下文事实" }));
    const content = "林澈来到钟楼。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();
    const dependencies = {
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    } as const;

    await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: version.id,
      versionCreatedAt: version.createdAt,
      acceptedText: content,
      acceptedStartOffset: 0,
      sourceLength: content.length,
      sourceContentHash: version.contentChecksum,
      currentVersionId: version.id,
      localOnly: false,
    });
    const first = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).find((fact) => fact.toSnapshot().factType === "scene_tag");
    if (first === undefined) throw new Error("Expected a reversible scene fact.");
    expect(
      adaptStoryFactContextSource(first, {
        projectId: project.id,
        currentBranchId: null,
        currentChapterVersions: {
          [created.chapter.id]: { versionId: version.id, contentHash: version.contentChecksum },
        },
      }),
    ).toMatchObject({ included: false });

    const confirmed = expectStoryOk(
      await runtime.story.factService.confirm({
        factId: first.id,
        actorId: runtime.story.actorId,
        humanConfirmed: true,
        expectedRevision: first.revision,
      }),
    );
    expect(
      adaptStoryFactContextSource(confirmed, {
        projectId: project.id,
        currentBranchId: null,
        currentChapterVersions: {
          [created.chapter.id]: { versionId: version.id, contentHash: version.contentChecksum },
        },
      }),
    ).toMatchObject({ included: true });
    expectStoryOk(
      await runtime.story.factService.deprecate({
        factId: confirmed.id,
        humanConfirmed: true,
        expectedRevision: confirmed.revision,
      }),
    );
    const replayVersionId = version.id;
    const replay = await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: replayVersionId,
      versionCreatedAt: version.createdAt,
      acceptedText: content,
      acceptedStartOffset: 0,
      sourceLength: content.length,
      sourceContentHash: version.contentChecksum,
      currentVersionId: replayVersionId,
      localOnly: false,
    });
    expect(replay).toMatchObject({ organizedCount: 0, alreadyOrganizedCount: 1 });
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))).filter(
        (fact) => fact.toSnapshot().factType === "scene_tag",
      ),
    ).toHaveLength(1);

    const changedContent = "林澈来到塔顶。";
    expectOk(
      await runtime.useCases.editChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        content: changedContent,
        cursorOffset: changedContent.length,
      }),
    );
    const changedSaved = expectOk(
      await runtime.useCases.saveChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        reason: "manual",
        organizeLocalStoryFacts: false,
      }),
    );
    if (changedSaved.version === null) throw new Error("Expected the changed immutable version.");
    const changedVersion = changedSaved.version.toSnapshot();
    const changedVersionId = changedVersion.id;
    const changedHash = changedVersion.contentChecksum;
    await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: changedVersionId,
      versionCreatedAt: changedVersion.createdAt,
      acceptedText: changedContent,
      acceptedStartOffset: 0,
      sourceLength: changedContent.length,
      sourceContentHash: changedHash,
      currentVersionId: changedVersionId,
      localOnly: false,
    });
    const current = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).find(
      (fact) =>
        fact.toSnapshot().factType === "scene_tag" &&
        String(fact.toSnapshot().source.versionId) === String(changedVersionId),
    );
    if (current === undefined) throw new Error("Expected genuinely new reversible evidence.");
    expect(
      adaptStoryFactContextSource(current, {
        projectId: project.id,
        currentBranchId: null,
        currentChapterVersions: {
          [created.chapter.id]: { versionId: changedVersionId, contentHash: changedHash },
        },
      }),
    ).toMatchObject({ included: false });
    const confirmedCurrent = expectStoryOk(
      await runtime.story.factService.confirm({
        factId: current.id,
        actorId: runtime.story.actorId,
        humanConfirmed: true,
        expectedRevision: current.revision,
      }),
    );
    expect(
      adaptStoryFactContextSource(confirmedCurrent, {
        projectId: project.id,
        currentBranchId: null,
        currentChapterVersions: {
          [created.chapter.id]: { versionId: changedVersionId, contentHash: changedHash },
        },
      }),
    ).toMatchObject({ included: true });
  });
  it("organizes fourteen explicitly labeled categories and ignores ambiguous prose", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "显式分类" }));
    const content = [
      "角色：林澈",
      "地点：旧钟楼",
      "关系：林澈是周野的兄长",
      "关键物品：银钥匙",
      "组织势力：守夜人",
      "时间线：第三日清晨",
      "世界规则：亡者不能复生",
      "伏笔：月蚀时钟声会再次响起",
      "未解问题：是谁打开了北门",
      "写作风格：克制冷峻",
      "故事目标：林澈找到银钥匙",
      "核心冲突：林澈必须在救人和守门之间选择",
      "已发生事件：林澈打开了北门",
      "已确认事实：北门从未上锁",
      "风吹过城墙，远处似乎有什么东西。",
    ].join("\n");
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();

    const receipt = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: version.id,
        versionCreatedAt: version.createdAt,
        acceptedText: content,
        acceptedStartOffset: 0,
        sourceLength: content.length,
        currentVersionId: version.id,
        localOnly: false,
      },
    );

    expect(receipt).toMatchObject({ organizedCount: 9, importantReviewCount: 5 });
    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots).toHaveLength(15);
    const settings = snapshots.filter(({ factType }) => factType !== "chapter_summary");
    expect(settings).toHaveLength(14);
    expect(snapshots.map(({ factType }) => factType)).toEqual(
      expect.arrayContaining([
        "character_profile",
        "location_setting",
        "core_relationship",
        "key_item",
        "organization_faction",
        "timeline_marker",
        "world_rule",
        "foreshadow",
        "unresolved_question",
        "writing_style",
        "story_goal",
        "story_conflict",
        "event_category",
        "confirmed_fact",
        "chapter_summary",
      ]),
    );
    expect(
      snapshots
        .filter(({ factType }) =>
          [
            "character_profile",
            "location_setting",
            "organization_faction",
            "timeline_marker",
            "unresolved_question",
            "writing_style",
            "story_goal",
            "story_conflict",
            "event_category",
          ].includes(factType),
        )
        .every(({ status, needsReview }) => status === "unconfirmed" && needsReview),
    ).toBe(true);
    expect(
      snapshots
        .filter(({ factType }) =>
          ["core_relationship", "key_item", "world_rule", "foreshadow", "confirmed_fact"].includes(
            factType,
          ),
        )
        .every(({ status, needsReview }) => status === "unconfirmed" && needsReview),
    ).toBe(true);
    expect(settings.some(({ contentText }) => contentText?.includes("似乎") ?? false)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("extracts only directly proven facts from ordinary narrative across ten core categories", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "自然叙事" }));
    const content = [
      "林澈今年二十三岁。",
      "旧钟楼位于北城河岸。",
      "林澈正式加入了守夜人议会。",
      "银钥匙由林澈保管。",
      "周野是林澈的兄长。",
      "在这个世界，亡者不能复生。",
      "第三日清晨，林澈打开了北门。",
      "林澈为了救出周野，决定前往旧城。",
      "事实是北门从未上锁。",
      "雾里仿佛有人靠近。",
    ].join("");
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();

    const receipt = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: version.id,
        versionCreatedAt: version.createdAt,
        acceptedText: content,
        acceptedStartOffset: 0,
        sourceLength: content.length,
        currentVersionId: version.id,
        localOnly: false,
      },
    );

    expect(receipt).toMatchObject({ organizedCount: 6, importantReviewCount: 4 });
    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots).toHaveLength(11);
    const settings = snapshots.filter(({ factType }) => factType !== "chapter_summary");
    expect(settings.map(({ factType }) => factType)).toEqual(
      expect.arrayContaining([
        "character_profile",
        "location_setting",
        "organization_faction",
        "key_item_ownership",
        "core_relationship",
        "world_rule",
        "timeline_marker",
        "event_category",
        "story_goal",
        "confirmed_fact",
      ]),
    );
    expect(
      settings
        .filter(({ factType }) =>
          ["key_item_ownership", "core_relationship", "world_rule", "confirmed_fact"].includes(
            factType,
          ),
        )
        .every(({ status, needsReview }) => status === "unconfirmed" && needsReview),
    ).toBe(true);
    expect(settings.some(({ contentText }) => contentText?.includes("仿佛") ?? false)).toBe(false);
    for (const setting of settings) {
      expect(content.slice(setting.source.startOffset ?? -1, setting.source.endOffset ?? -1)).toBe(
        setting.source.excerpt,
      );
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails closed for stale evidence without creating a fact or calling a Provider", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "过期证据" }));
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: CONTENT,
      }),
    );
    const version = created.version.toSnapshot();
    const receipt = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: version.id,
        versionCreatedAt: version.createdAt,
        acceptedText: version.content,
        acceptedStartOffset: 0,
        sourceLength: version.content.length,
        currentVersionId: runtime.ids.next(),
        localOnly: false,
      },
    );
    expect(receipt.sourceWasCurrent).toBe(false);
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("recovers from only the current immutable version and never mutates正文 or versions", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "崩溃恢复" }));
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: "角色：旧角色。",
      }),
    );
    const firstVersion = created.version.toSnapshot();
    expectOk(
      await runtime.useCases.editChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        content: "角色：新角色。",
        cursorOffset: 7,
      }),
    );
    const saved = expectOk(
      await runtime.useCases.saveChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        reason: "manual",
      }),
    );
    if (saved.version === null) throw new Error("Expected a new immutable version.");
    const currentVersion = saved.version.toSnapshot();
    const versionsBefore = expectOk(
      await runtime.repositories.chapterVersions.listByChapterId(created.chapter.id),
    );
    const dependencies = {
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    } as const;

    await expect(
      organizeCurrentSavedVersionStoryFacts(dependencies, {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: firstVersion.id,
      }),
    ).resolves.toMatchObject({ sourceWasCurrent: false, organizedCount: 0 });
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toEqual([]);

    await expect(
      organizeCurrentSavedVersionStoryFacts(dependencies, {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: currentVersion.id,
      }),
    ).resolves.toMatchObject({ sourceWasCurrent: true, organizedCount: 1 });
    await expect(
      organizeCurrentSavedVersionStoryFacts(dependencies, {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: currentVersion.id,
      }),
    ).resolves.toMatchObject({ organizedCount: 0, alreadyOrganizedCount: 1 });

    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find(({ factType }) => factType === "character_profile")).toMatchObject({
      contentText: "新角色",
      source: { versionId: currentVersion.id, startOffset: 0, sourceLength: 7 },
    });
    expect(snapshots.find(({ factType }) => factType === "chapter_summary")).toMatchObject({
      contentText: "角色：新角色。",
      status: "temporary",
      origin: "system",
      source: { versionId: currentVersion.id, startOffset: 0, sourceLength: 7 },
    });
    expect(
      expectOk(await runtime.repositories.chapters.findById(created.chapter.id))?.content,
    ).toBe("角色：新角色。");
    expect(
      expectOk(await runtime.repositories.chapterVersions.listByChapterId(created.chapter.id)),
    ).toEqual(versionsBefore);
  });

  it("stages irreversible, knowledge, foreshadow and confirmed-fact conflicts for review", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "重大设定" }));
    expectStoryOk(
      await runtime.story.factService.createFormalUserFact({
        projectId: expectStoryUuid(project.id),
        factType: "character_identity",
        contentText: "林澈是守门人",
        actorId: runtime.ids.next(),
        humanConfirmed: true,
      }),
    );
    const content =
      "城门被永久封印。密室的秘密终于被她知晓。那条伏笔被取消。众人决定推翻此前已确认设定。林澈已不是守门人。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();

    const receipt = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: version.id,
        versionCreatedAt: version.createdAt,
        acceptedText: content,
        acceptedStartOffset: 0,
        sourceLength: content.length,
        currentVersionId: version.id,
        localOnly: false,
      },
    );

    expect(receipt).toMatchObject({ organizedCount: 1, importantReviewCount: 5 });
    const facts = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(facts.map(({ factType }) => factType)).toEqual(
      expect.arrayContaining([
        "irreversible_event",
        "knowledge_boundary",
        "foreshadow_status",
        "confirmed_setting_override",
        "confirmed_setting_conflict",
        "story_goal",
        "chapter_summary",
      ]),
    );
    const importantFacts = facts.filter(({ factType }) =>
      [
        "irreversible_event",
        "knowledge_boundary",
        "foreshadow_status",
        "confirmed_setting_override",
        "confirmed_setting_conflict",
      ].includes(factType),
    );
    expect(importantFacts).toHaveLength(5);
    expect(
      importantFacts.every(({ status, needsReview }) => status === "unconfirmed" && needsReview),
    ).toBe(true);
    expect(facts.find(({ factType }) => factType === "story_goal")).toMatchObject({
      status: "unconfirmed",
      needsReview: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("scans only the accepted delta and rebuilds moved evidence for the current version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "跨版本去重" }));
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: CONTENT,
      }),
    );
    const firstVersion = created.version.toSnapshot();
    const dependencies = {
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    } as const;

    await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: firstVersion.id,
      versionCreatedAt: firstVersion.createdAt,
      acceptedText: firstVersion.content,
      acceptedStartOffset: 0,
      sourceLength: firstVersion.content.length,
      currentVersionId: firstVersion.id,
      localOnly: false,
    });

    const acceptedDelta = "林澈回到塔顶。林澈来到钟楼。";
    const appendedContent = `${CONTENT}${acceptedDelta}`;
    expectOk(
      await runtime.useCases.editChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        content: appendedContent,
        cursorOffset: appendedContent.length,
      }),
    );
    const saved = expectOk(
      await runtime.useCases.saveChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        reason: "manual",
        organizeLocalStoryFacts: false,
      }),
    );
    if (saved.version === null) throw new Error("Expected the appended immutable version.");
    const appendedVersion = saved.version.toSnapshot();
    const receipt = await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: appendedVersion.id,
      versionCreatedAt: appendedVersion.createdAt,
      acceptedText: acceptedDelta,
      acceptedStartOffset: CONTENT.length,
      sourceLength: appendedContent.length,
      sourceContentHash: appendedVersion.contentChecksum,
      currentVersionId: appendedVersion.id,
      localOnly: false,
    });

    expect(receipt).toEqual({
      organizedCount: 2,
      importantReviewCount: 0,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: true,
    });
    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots).toHaveLength(6);
    const settings = snapshots.filter(({ factType }) => factType !== "chapter_summary");
    expect(settings.filter((snapshot) => snapshot.contentText === "林澈出现在钟楼")).toHaveLength(
      2,
    );
    expect(
      settings.find((snapshot) => snapshot.contentText === "林澈出现在塔顶")?.source.versionId,
    ).toBe(appendedVersion.id);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rebuilds one non-authoritative extractive summary from the current full version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "本地摘要" }));
    const firstSentence = "🌙钟声第一次响起。";
    const lastSentence = "林澈在黎明前关上北门。";
    const content = `${firstSentence}林澈穿过雾中的长街。${lastSentence}`;
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const firstVersion = created.version.toSnapshot();
    const input = {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: firstVersion.id,
      versionCreatedAt: firstVersion.createdAt,
      acceptedText: content,
      acceptedStartOffset: 0,
      sourceLength: content.length,
      currentVersionId: firstVersion.id,
      localOnly: false,
    } as const;

    await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      input,
    );
    const firstFacts = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    );
    const firstSummary = firstFacts.find(
      (fact) => fact.toSnapshot().factType === "chapter_summary",
    );
    if (firstSummary === undefined) throw new Error("Expected the first extractive summary.");
    const firstSnapshot = firstSummary.toSnapshot();
    const firstPayload = parseStoredChapterSummaryPayload(firstSummary);
    if (firstPayload === null) throw new Error("Expected a valid chapter summary payload.");
    const contentHash = expectOk(await runtime.hasher.sha256(content));
    expect(firstSnapshot).toMatchObject({
      contentText: `${firstSentence} ${lastSentence}`,
      origin: "system",
      status: "temporary",
      needsReview: false,
      userConfirmed: false,
      source: {
        versionId: firstVersion.id,
        startOffset: 0,
        endOffset: firstSentence.length,
        sourceLength: content.length,
        excerpt: firstSentence,
      },
    });
    expect(firstPayload).toMatchObject({
      sourceContentHash: contentHash,
      authorityMode: "plain_non_authoritative",
      generation: {
        providerKind: "本地确定性整理",
        modelId: "首尾句抽取摘要第一版",
        invocationId: firstVersion.id,
      },
    });
    expect(firstPayload.citations).toEqual([
      expect.objectContaining({ startOffset: 0, endOffset: firstSentence.length }),
      expect.objectContaining({
        startOffset: content.indexOf(lastSentence),
        endOffset: content.length,
      }),
    ]);

    const reopened = createDevelopmentRuntime(window.localStorage);
    const reopenedGenerate = vi.spyOn(reopened.modelGateway, "generate");
    const dependencies = {
      chapters: reopened.repositories.chapters,
      chapterVersions: reopened.repositories.chapterVersions,
      facts: reopened.story.facts,
      factService: reopened.story.factService,
      hasher: reopened.hasher,
      now: () => reopened.clock.now(),
    } as const;
    await organizeCurrentSavedVersionStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: firstVersion.id,
    });
    let summaries = expectStoryOk(
      await reopened.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).filter((fact) => fact.toSnapshot().factType === "chapter_summary");
    expect(summaries).toHaveLength(1);

    const existingSummary = summaries[0];
    if (existingSummary === undefined) throw new Error("Expected the reopened summary.");
    expectStoryOk(
      await reopened.story.factService.deprecate({
        factId: existingSummary.id,
        humanConfirmed: true,
        expectedRevision: existingSummary.revision,
      }),
    );
    await organizeCurrentSavedVersionStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: firstVersion.id,
    });
    summaries = expectStoryOk(
      await reopened.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).filter((fact) => fact.toSnapshot().factType === "chapter_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.toSnapshot().status).toBe("deprecated");

    const chapter = expectOk(await reopened.repositories.chapters.findById(created.chapter.id));
    if (chapter === null) throw new Error("Expected the reopened chapter.");
    const updatedContent = "夜色覆盖旧城。林澈终于看见晨光。";
    expectOk(
      await reopened.useCases.editChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        content: updatedContent,
        cursorOffset: updatedContent.length,
      }),
    );
    const saved = expectOk(
      await reopened.useCases.saveChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        reason: "manual",
      }),
    );
    if (saved.version === null) throw new Error("Expected the replacement immutable version.");
    const currentVersion = saved.version.toSnapshot();
    await organizeCurrentSavedVersionStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: chapter.id,
      versionId: currentVersion.id,
    });
    await expect(
      organizeCurrentSavedVersionStoryFacts(dependencies, {
        projectId: project.id,
        chapterId: chapter.id,
        versionId: firstVersion.id,
      }),
    ).resolves.toMatchObject({ sourceWasCurrent: false });
    summaries = expectStoryOk(
      await reopened.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).filter((fact) => fact.toSnapshot().factType === "chapter_summary");
    expect(summaries).toHaveLength(2);
    expect(summaries.filter((fact) => fact.toSnapshot().status === "temporary")).toHaveLength(1);
    expect(
      summaries.find((fact) => fact.toSnapshot().status === "temporary")?.toSnapshot(),
    ).toMatchObject({
      contentText: "夜色覆盖旧城。 林澈终于看见晨光。",
      source: { versionId: currentVersion.id, sourceLength: updatedContent.length },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(reopenedGenerate).not.toHaveBeenCalled();
  });

  it("keeps an equivalent user-authored fact authoritative instead of staging a duplicate", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "手动优先" }));
    expectStoryOk(
      await runtime.story.factService.createFormalUserFact({
        projectId: expectStoryUuid(project.id),
        factType: "character_profile",
        contentText: "林澈是守门人",
        actorId: runtime.ids.next(),
        humanConfirmed: true,
      }),
    );
    const content = "角色：林澈是守门人。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();

    const receipt = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: version.id,
        versionCreatedAt: version.createdAt,
        acceptedText: content,
        acceptedStartOffset: 0,
        sourceLength: content.length,
        currentVersionId: version.id,
        localOnly: false,
      },
    );

    expect(receipt).toMatchObject({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 1,
    });
    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots.filter(({ factType }) => factType === "character_profile")).toEqual([
      expect.objectContaining({ origin: "user", status: "formal", userConfirmed: true }),
    ]);
    expect(snapshots.filter(({ factType }) => factType === "chapter_summary")).toHaveLength(1);
  });

  it("keeps a user deletion as a tombstone until genuinely new正文 evidence appears", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "删除优先" }));
    const content = "林澈来到钟楼。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const version = created.version.toSnapshot();
    const dependencies = {
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    } as const;

    await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: version.id,
      versionCreatedAt: version.createdAt,
      acceptedText: content,
      acceptedStartOffset: 0,
      sourceLength: content.length,
      currentVersionId: version.id,
      localOnly: false,
    });
    const first = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).find((fact) => fact.toSnapshot().factType === "scene_tag");
    if (first === undefined) throw new Error("Expected the first automatic setting.");
    expectStoryOk(
      await runtime.story.factService.deprecate({
        factId: first.id,
        humanConfirmed: true,
        expectedRevision: first.revision,
      }),
    );

    const prefix = "夜色沉沉。";
    const movedContent = `${prefix}${content}`;
    expectOk(
      await runtime.useCases.editChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        content: movedContent,
        cursorOffset: movedContent.length,
      }),
    );
    const movedSaved = expectOk(
      await runtime.useCases.saveChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        reason: "manual",
        organizeLocalStoryFacts: false,
      }),
    );
    if (movedSaved.version === null) throw new Error("Expected the moved immutable version.");
    const movedVersion = movedSaved.version.toSnapshot();
    const replay = await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: movedVersion.id,
      versionCreatedAt: movedVersion.createdAt,
      acceptedText: content,
      acceptedStartOffset: prefix.length,
      sourceLength: movedContent.length,
      sourceContentHash: movedVersion.contentChecksum,
      currentVersionId: movedVersion.id,
      localOnly: false,
    });
    expect(replay).toMatchObject({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 1,
    });
    const afterReplay = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(afterReplay).toHaveLength(2);
    expect(afterReplay.filter(({ factType }) => factType === "scene_tag")).toHaveLength(1);

    const newEvidence = "林澈回到塔顶。";
    const newContent = `${movedContent}${newEvidence}`;
    expectOk(
      await runtime.useCases.editChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: movedSaved.chapter.revision,
        content: newContent,
        cursorOffset: newContent.length,
      }),
    );
    const newSaved = expectOk(
      await runtime.useCases.saveChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: movedSaved.chapter.revision,
        reason: "manual",
        organizeLocalStoryFacts: false,
      }),
    );
    if (newSaved.version === null) throw new Error("Expected the new evidence immutable version.");
    const newVersion = newSaved.version.toSnapshot();
    const changed = await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: newVersion.id,
      versionCreatedAt: newVersion.createdAt,
      acceptedText: newEvidence,
      acceptedStartOffset: movedContent.length,
      sourceLength: newContent.length,
      sourceContentHash: newVersion.contentChecksum,
      currentVersionId: newVersion.id,
      localOnly: false,
    });
    expect(changed).toMatchObject({ organizedCount: 1, alreadyOrganizedCount: 0 });
    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots).toHaveLength(3);
    const settings = snapshots.filter(({ factType }) => factType !== "chapter_summary");
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "deprecated", contentText: "林澈出现在钟楼" }),
        expect.objectContaining({ status: "unconfirmed", contentText: "林澈出现在塔顶" }),
      ]),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("stops before staging when a newer accepted version appears during asynchronous hashing", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(
      await runtime.useCases.createProject.execute({ name: "并发版本保护" }),
    );
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: CONTENT,
      }),
    );
    const originalVersion = created.version.toSnapshot();
    const stageAutomaticFactWithAuthorityFence = vi.spyOn(
      runtime.story.factService,
      "stageAutomaticFactWithAuthorityFence",
    );
    let advanced = false;

    const receipt = await organizeCurrentSavedVersionStoryFacts(
      {
        chapters: runtime.repositories.chapters,
        chapterVersions: runtime.repositories.chapterVersions,
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: {
          sha256: async (text: string) => {
            if (!advanced) {
              advanced = true;
              expectOk(
                await runtime.useCases.editChapter.execute({
                  chapterId: created.chapter.id,
                  expectedRevision: created.chapter.revision,
                  content: `${CONTENT}新版本已经接受。`,
                  cursorOffset: CONTENT.length + 8,
                }),
              );
              expectOk(
                await runtime.useCases.saveChapter.execute({
                  chapterId: created.chapter.id,
                  expectedRevision: created.chapter.revision,
                  reason: "manual",
                  organizeLocalStoryFacts: false,
                }),
              );
            }
            return runtime.hasher.sha256(text);
          },
        },
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: originalVersion.id,
      },
    );

    expect(receipt).toEqual({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: false,
    });
    expect(stageAutomaticFactWithAuthorityFence).not.toHaveBeenCalled();
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toHaveLength(0);
  });
  it("stops before replacing the local summary when a newer version appears during summary hashing", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(
      await runtime.useCases.createProject.execute({ name: "摘要并发保护" }),
    );
    const content = "风吹过空荡长街。远处钟声渐渐停下。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const originalVersion = created.version.toSnapshot();
    const replaceSummary = vi.spyOn(
      runtime.story.factService,
      "replaceRebuildableSystemFactWithAuthorityFence",
    );
    let fullContentHashCount = 0;

    const receipt = await organizeCurrentSavedVersionStoryFacts(
      {
        chapters: runtime.repositories.chapters,
        chapterVersions: runtime.repositories.chapterVersions,
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: {
          sha256: async (text: string) => {
            if (text === content) {
              fullContentHashCount += 1;
              if (fullContentHashCount === 2) {
                expectOk(
                  await runtime.useCases.editChapter.execute({
                    chapterId: created.chapter.id,
                    expectedRevision: created.chapter.revision,
                    content: `${content}新版本已经接受。`,
                    cursorOffset: content.length + 8,
                  }),
                );
                expectOk(
                  await runtime.useCases.saveChapter.execute({
                    chapterId: created.chapter.id,
                    expectedRevision: created.chapter.revision,
                    reason: "manual",
                    organizeLocalStoryFacts: false,
                  }),
                );
              }
            }
            return runtime.hasher.sha256(text);
          },
        },
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: originalVersion.id,
      },
    );

    expect(fullContentHashCount).toBe(2);
    expect(receipt).toEqual({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: false,
    });
    expect(replaceSummary).not.toHaveBeenCalled();
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toHaveLength(0);
  });

  it("does not persist a pending local fact when the chapter advances after the last application check", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(
      await runtime.useCases.createProject.execute({ name: "事实提交原子围栏" }),
    );
    const content = "周望是钟楼的管理员。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const originalVersion = created.version.toSnapshot();
    const originalStage = runtime.story.factService.stageAutomaticFactWithAuthorityFence.bind(
      runtime.story.factService,
    );
    let advanced = false;
    const factService = {
      replaceRebuildableSystemFactWithAuthorityFence:
        runtime.story.factService.replaceRebuildableSystemFactWithAuthorityFence.bind(
          runtime.story.factService,
        ),
      stageAutomaticFactWithAuthorityFence: async (
        ...args: Parameters<typeof runtime.story.factService.stageAutomaticFactWithAuthorityFence>
      ) => {
        if (!advanced) {
          advanced = true;
          expectOk(
            await runtime.useCases.editChapter.execute({
              chapterId: created.chapter.id,
              expectedRevision: created.chapter.revision,
              content: `${content}钟声在黎明前停下。`,
              cursorOffset: content.length,
            }),
          );
          expectOk(
            await runtime.useCases.saveChapter.execute({
              chapterId: created.chapter.id,
              expectedRevision: created.chapter.revision,
              reason: "manual",
              organizeLocalStoryFacts: false,
            }),
          );
        }
        return originalStage(...args);
      },
    };

    const receipt = await organizeCurrentSavedVersionStoryFacts(
      {
        chapters: runtime.repositories.chapters,
        chapterVersions: runtime.repositories.chapterVersions,
        facts: runtime.story.facts,
        factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: originalVersion.id,
      },
    );

    expect(advanced).toBe(true);
    expect(receipt.sourceWasCurrent).toBe(false);
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toHaveLength(0);
  });

  it("does not persist an extractive summary when the chapter advances inside its final write", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(
      await runtime.useCases.createProject.execute({ name: "摘要提交原子围栏" }),
    );
    const content = "雾从长街升起。远处的灯逐一熄灭。";
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content,
      }),
    );
    const originalVersion = created.version.toSnapshot();
    const originalReplace =
      runtime.story.factService.replaceRebuildableSystemFactWithAuthorityFence.bind(
        runtime.story.factService,
      );
    let advanced = false;
    const factService = {
      stageAutomaticFactWithAuthorityFence:
        runtime.story.factService.stageAutomaticFactWithAuthorityFence.bind(
          runtime.story.factService,
        ),
      replaceRebuildableSystemFactWithAuthorityFence: async (
        ...args: Parameters<
          typeof runtime.story.factService.replaceRebuildableSystemFactWithAuthorityFence
        >
      ) => {
        if (!advanced) {
          advanced = true;
          expectOk(
            await runtime.useCases.editChapter.execute({
              chapterId: created.chapter.id,
              expectedRevision: created.chapter.revision,
              content: `${content}钟声响起。`,
              cursorOffset: content.length,
            }),
          );
          expectOk(
            await runtime.useCases.saveChapter.execute({
              chapterId: created.chapter.id,
              expectedRevision: created.chapter.revision,
              reason: "manual",
              organizeLocalStoryFacts: false,
            }),
          );
        }
        return originalReplace(...args);
      },
    };

    const receipt = await organizeCurrentSavedVersionStoryFacts(
      {
        chapters: runtime.repositories.chapters,
        chapterVersions: runtime.repositories.chapterVersions,
        facts: runtime.story.facts,
        factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      {
        projectId: project.id,
        chapterId: created.chapter.id,
        versionId: originalVersion.id,
      },
    );

    expect(advanced).toBe(true);
    expect(receipt.sourceWasCurrent).toBe(false);
    const snapshots = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    ).map((fact) => fact.toSnapshot());
    expect(snapshots.filter(({ factType }) => factType === "chapter_summary")).toHaveLength(0);
  });

  it("retries a partially failed organization idempotently without touching the saved version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "幂等重试" }));
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: CONTENT,
      }),
    );
    const version = created.version.toSnapshot();
    const input = {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: version.id,
      versionCreatedAt: version.createdAt,
      acceptedText: version.content,
      acceptedStartOffset: 0,
      sourceLength: version.content.length,
      currentVersionId: version.id,
      localOnly: false,
    } as const;
    let writes = 0;

    await expect(
      organizeDirectStoryFacts(
        {
          facts: runtime.story.facts,
          factService: {
            replaceRebuildableSystemFactWithAuthorityFence: (...args) =>
              runtime.story.factService.replaceRebuildableSystemFactWithAuthorityFence(...args),
            stageAutomaticFactWithAuthorityFence: async (...args) => {
              writes += 1;
              if (writes === 2) throw new Error("interrupted local organization");
              return runtime.story.factService.stageAutomaticFactWithAuthorityFence(...args);
            },
          },
          hasher: runtime.hasher,
          now: () => runtime.clock.now(),
        },
        input,
      ),
    ).rejects.toThrow("interrupted local organization");
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toHaveLength(1);

    const retried = await organizeDirectStoryFacts(
      {
        facts: runtime.story.facts,
        factService: runtime.story.factService,
        hasher: runtime.hasher,
        now: () => runtime.clock.now(),
      },
      input,
    );
    expect(retried).toEqual({
      organizedCount: 0,
      importantReviewCount: 2,
      alreadyOrganizedCount: 1,
      sourceWasCurrent: true,
    });
    expect(
      expectStoryOk(await runtime.story.facts.listByProjectId(expectStoryUuid(project.id))),
    ).toHaveLength(4);
    expect(
      expectOk(await runtime.repositories.chapterVersions.listByChapterId(created.chapter.id)),
    ).toEqual([created.version]);
  });

  it("cannot roll back or mutate accepted text when local fact persistence fails", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "整理失败" }));
    const created = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: CONTENT,
      }),
    );
    const version = created.version.toSnapshot();
    const versionsBefore = expectOk(
      await runtime.repositories.chapterVersions.listByChapterId(created.chapter.id),
    );

    await expect(
      organizeDirectStoryFacts(
        {
          facts: runtime.story.facts,
          factService: {
            replaceRebuildableSystemFactWithAuthorityFence: (...args) =>
              runtime.story.factService.replaceRebuildableSystemFactWithAuthorityFence(...args),
            stageAutomaticFactWithAuthorityFence: vi.fn(() =>
              Promise.reject(new Error("local fact write failed")),
            ),
          },
          hasher: runtime.hasher,
          now: () => runtime.clock.now(),
        },
        {
          projectId: project.id,
          chapterId: created.chapter.id,
          versionId: version.id,
          versionCreatedAt: version.createdAt,
          acceptedText: version.content,
          acceptedStartOffset: 0,
          sourceLength: version.content.length,
          currentVersionId: created.chapter.currentVersionId,
          localOnly: false,
        },
      ),
    ).rejects.toThrow("local fact write failed");

    const chapterAfter = expectOk(await runtime.repositories.chapters.findById(created.chapter.id));
    expect(chapterAfter?.content).toBe(CONTENT);
    expect(
      expectOk(await runtime.repositories.chapterVersions.listByChapterId(created.chapter.id)),
    ).toEqual(versionsBefore);
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

function expectStoryUuid(value: string) {
  return expectStoryOk(parseStoryUuidV7(value));
}
