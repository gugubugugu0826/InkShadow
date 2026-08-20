import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";

import { createDevelopmentRuntime } from "./runtime";
import {
  directStoryFactOrganizerNotice,
  organizeDirectStoryFacts,
} from "./direct-story-fact-organizer";

const CONTENT = "林澈来到钟楼。周野的真实身份是守门人。陈舟确认死亡。";

describe("direct local story-fact organization", () => {
  beforeEach(() => window.localStorage.clear());

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
    expect(directStoryFactOrganizerNotice(receipt)).toBe(
      "已整理 1 条；有 2 条重要设定需要你确认。",
    );
    const facts = expectStoryOk(
      await runtime.story.facts.listByProjectId(expectStoryUuid(project.id)),
    );
    expect(facts).toHaveLength(3);
    expect(
      facts
        .map((fact) => fact.toSnapshot())
        .map((snapshot) => ({
          type: snapshot.factType,
          status: snapshot.status,
          origin: snapshot.origin,
          needsReview: snapshot.needsReview,
        })),
    ).toEqual(
      expect.arrayContaining([
        { type: "scene_tag", status: "temporary", origin: "system", needsReview: false },
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
    for (const fact of facts) {
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
        evidence: {
          projectId: project.id,
          chapterId: created.chapter.id,
          immutableVersionId: version.id,
          sourceKind: "chapter",
          privacy: "local_only",
          currentness: "current",
        },
      });
      expect(JSON.stringify(snapshot.structuredValue)).toMatch(/"excerptDigest":"[a-f0-9]{64}"/u);
    }

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

    expect(receipt).toMatchObject({ organizedCount: 0, importantReviewCount: 5 });
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
      ]),
    );
    const organizedFacts = facts.filter(({ origin }) => origin === "system");
    expect(
      organizedFacts.every(({ status, needsReview }) => status === "unconfirmed" && needsReview),
    ).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it("scans only the accepted delta when a later version appends new prose", async () => {
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
    const appendedVersionId = runtime.ids.next();
    const receipt = await organizeDirectStoryFacts(dependencies, {
      projectId: project.id,
      chapterId: created.chapter.id,
      versionId: appendedVersionId,
      versionCreatedAt: runtime.clock.now(),
      acceptedText: acceptedDelta,
      acceptedStartOffset: CONTENT.length,
      sourceLength: appendedContent.length,
      currentVersionId: appendedVersionId,
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
    expect(snapshots).toHaveLength(5);
    expect(snapshots.filter((snapshot) => snapshot.contentText === "林澈出现在钟楼")).toHaveLength(
      2,
    );
    expect(
      snapshots.find((snapshot) => snapshot.contentText === "林澈出现在塔顶")?.source.versionId,
    ).toBe(appendedVersionId);
    expect(generate).not.toHaveBeenCalled();
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
            stageAutomaticFact: vi.fn(() => Promise.reject(new Error("local fact write failed"))),
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
