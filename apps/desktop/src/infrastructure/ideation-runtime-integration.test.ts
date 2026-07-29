import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  IDEATION_STEP_KEYS,
  type IdeationStepKey,
  parseUuidV7 as parseStoryUuid,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import { DEVELOPMENT_DATABASE_KEY } from "./development-storage";
import { createDevelopmentRuntime } from "./runtime";

describe("ideation runtime integration", () => {
  it("resumes after a runtime restart and atomically creates every initial project artifact", async () => {
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    let draft = expectValue(
      await firstRuntime.story.ideationService.createQuick({
        projectName: "雾港来信",
        seed: {
          idea: "失忆邮差收到来自未来的最后一封信。",
          genre: "悬疑幻想",
          targetWords: 320_000,
          protagonistType: "谨慎但执拗的普通人",
          style: "克制、带黑色幽默",
        },
      }),
    );
    const answers = new Map<IdeationStepKey, string>([
      ["target_audience", "偏好长线谜题与人物成长的成年读者。"],
      ["world_skeleton", "邮件只在退潮后出现；读取未来信件会失去一段过去记忆。"],
      ["key_characters", "邮差阿遥、守塔人柏林、寄信人岚。"],
      ["plot_route", "追查来信来源，发现每封信都在改写一位熟人的命运。"],
      ["opening_hook", "阿遥在无人投递的邮袋里发现写着自己死亡日期的信。"],
    ] as const);
    for (const step of IDEATION_STEP_KEYS) {
      if (
        draft.toSnapshot().steps.find((candidate) => candidate.key === step)?.state !== "pending"
      ) {
        continue;
      }
      const value = answers.get(step);
      if (value === undefined) {
        throw new Error(`测试缺少 ${step} 的构思答案。`);
      }
      draft = expectValue(
        await firstRuntime.story.ideationService.apply({
          draftId: draft.id,
          expectedRevision: draft.revision,
          change: { kind: "update", step, value },
        }),
      );
    }

    const restartedRuntime = createDevelopmentRuntime(window.localStorage);
    const active = expectValue(await restartedRuntime.story.ideationService.listActive());
    expect(active).toHaveLength(1);
    expect(active[0]?.toSnapshot()).toMatchObject({
      id: draft.id,
      projectName: "雾港来信",
      revision: draft.revision,
      status: "active",
    });

    const finalized = expectValue(
      await restartedRuntime.story.ideationService.finalize({
        draftId: draft.id,
        expectedRevision: draft.revision,
      }),
    );
    const domainProjectId = expectValue(parseDomainUuid(finalized.projectId));
    const project = expectValue(
      await restartedRuntime.repositories.projects.findById(domainProjectId),
    );
    const chapters = expectValue(
      await restartedRuntime.repositories.chapters.listByProjectId(domainProjectId),
    );
    const storyProjectId = expectValue(parseStoryUuid(finalized.projectId));
    const outline = expectValue(
      await restartedRuntime.story.outlines.findByProjectId(storyProjectId),
    );
    const formalRecords = expectValue(
      await restartedRuntime.story.formalRecords.listByProjectId(storyProjectId),
    );

    expect(project).toMatchObject({ name: "雾港来信", status: "active", revision: 1 });
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({
      title: "第一章",
      content: "",
      revision: 1,
    });
    expect(outline?.toSnapshot()).toMatchObject({
      projectId: finalized.projectId,
    });
    expect(outline?.toSnapshot().nodes.map(({ kind }) => kind)).toEqual([
      "book",
      "volume",
      "chapter",
    ]);
    expect(outline?.toSnapshot().nodes[0]?.title).toBe("雾港来信");
    expect(formalRecords.map((record) => record.toSnapshot().kind).sort()).toEqual([
      "character",
      "world_rule",
    ]);
    expect(expectValue(await restartedRuntime.story.ideationService.listActive())).toEqual([]);

    const serialized = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    if (serialized === null) {
      throw new Error("原子建书后缺少开发数据库。");
    }
    const database = JSON.parse(serialized) as {
      readonly schemaVersion?: unknown;
      readonly auditEvents?: readonly {
        readonly projectId?: unknown;
        readonly action?: unknown;
      }[];
    };
    expect(database.schemaVersion).toBe(2);
    expect(database.auditEvents).toContainEqual(
      expect.objectContaining({
        projectId: finalized.projectId,
        action: "create_from_ideation",
      }),
    );

    const secondRestart = createDevelopmentRuntime(window.localStorage);
    expect(
      expectValue(await secondRestart.repositories.projects.findById(domainProjectId)),
    ).toMatchObject({ name: "雾港来信" });
    expect(
      expectValue(await secondRestart.repositories.chapters.listByProjectId(domainProjectId)),
    ).toHaveLength(1);
    expect(expectValue(await secondRestart.story.ideationService.findById(draft.id))).toMatchObject(
      {
        status: "finalized",
        projectId: finalized.projectId,
      },
    );
  });
});

function expectValue<Value>(
  result: Readonly<{ ok: true; value: Value } | { ok: false; error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}
