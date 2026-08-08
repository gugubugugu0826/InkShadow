import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChapterRepository } from "@inkshadow/application";
import { Chapter, parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { CausalFactAuthoringReceipt } from "../infrastructure/causal-fact-authoring-service";
import {
  CausalFactAuthoringPanel,
  type CausalFactAuthoringPanelProps,
} from "./causal-fact-authoring-panel";

const PROJECT_ID = "018f0f00-0000-7000-8000-000000000001";
const CHAPTER_ID = "018f0f00-0000-7000-8000-000000000002";
const VERSION_ID = "018f0f00-0000-7000-8000-000000000003";
const ACTOR_ID = "018f0f00-0000-7000-8000-000000000004";
const NOW = "2026-08-08T00:00:00.000Z";

describe("CausalFactAuthoringPanel explicit knowledge gains", () => {
  it("keeps an understandable empty state and never infers knowledge from event text", async () => {
    const user = userEvent.setup();
    const { createEvent } = renderPanel();
    await fillRequiredEventFields(user);

    await user.click(screen.getByText("补充参与人物与知情范围"));
    expect(screen.getByText(/还没有记录明确知识获得.*不会授权任何 POV 知识取得/u)).toBeVisible();
    await user.click(
      within(screen.getByRole("group", { name: "事件后已经知道此事的人物" })).getByRole(
        "checkbox",
        { name: "阿莉娅" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "确认并保存事件" }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventText: "Aria 读完密信",
        informedCharacterIds: ["character-aria"],
        knowledgeGains: [],
      }),
    );
  });

  it("adds, validates, de-duplicates, removes, and submits exact structured gains", async () => {
    const user = userEvent.setup();
    const { createEvent } = renderPanel();
    await fillRequiredEventFields(user);
    await user.click(screen.getByText("补充参与人物与知情范围"));
    await user.click(
      within(screen.getByRole("group", { name: "事件后已经知道此事的人物" })).getByRole(
        "checkbox",
        { name: "阿莉娅" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "添加一条明确知识获得" }));

    const first = screen.getByRole("group", { name: "明确知识获得 1" });
    const firstCharacter = within(first).getByLabelText("谁获得了知识（第 1 条）");
    expect(firstCharacter).toHaveFocus();
    await user.selectOptions(firstCharacter, "character-aria");
    await user.type(within(first).getByLabelText("知识类别（第 1 条）"), "真实身份");
    await user.type(
      within(first).getByLabelText("人物得知的内容（第 1 条）"),
      "米拉是真正的继承人",
    );

    await user.click(screen.getByRole("button", { name: "添加一条明确知识获得" }));
    const second = screen.getByRole("group", { name: "明确知识获得 2" });
    await user.selectOptions(
      within(second).getByLabelText("谁获得了知识（第 2 条）"),
      "character-aria",
    );
    await user.type(within(second).getByLabelText("知识类别（第 2 条）"), "真实身份");
    await user.type(
      within(second).getByLabelText("人物得知的内容（第 2 条）"),
      "米拉是真正的继承人",
    );
    expect(within(second).getByText("这条人物与知识内容已经添加，请删除重复项。")).toBeVisible();

    await user.click(within(second).getByRole("button", { name: "删除第 2 条知识获得" }));
    expect(screen.queryByRole("group", { name: "明确知识获得 2" })).not.toBeInTheDocument();
    expect(firstCharacter).toHaveFocus();
    expect(screen.getByRole("button", { name: "确认并保存事件" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "确认并保存事件" }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        informedCharacterIds: ["character-aria"],
        knowledgeGains: [
          {
            characterId: "character-aria",
            knowledgeLabel: "真实身份",
            informationText: "米拉是真正的继承人",
          },
        ],
      }),
    );
  });

  it("caps dynamic knowledge rows at 128 and keeps internal identifiers out of the form", async () => {
    const user = userEvent.setup();
    renderPanel();
    await fillRequiredEventFields(user);
    await user.click(screen.getByText("补充参与人物与知情范围"));
    await user.click(
      within(screen.getByRole("group", { name: "事件后已经知道此事的人物" })).getByRole(
        "checkbox",
        { name: "阿莉娅" },
      ),
    );
    const add = screen.getByRole("button", { name: "添加一条明确知识获得" });
    for (let index = 0; index < 128; index += 1) {
      await user.click(add);
    }
    expect(screen.getAllByRole("group", { name: /明确知识获得/u })).toHaveLength(128);
    expect(add).toBeDisabled();
    expect(screen.getByText("128 / 128")).toBeVisible();
    expect(screen.queryByText(/UUID|人物标识|信息标识|知识键/u)).not.toBeInTheDocument();
  }, 15_000);

  it("submits ordinary-language prerequisites and all supported story changes", async () => {
    const user = userEvent.setup();
    const { createEvent } = renderPanel();
    await fillRequiredEventFields(user);
    await user.click(screen.getByText("补充前置条件与故事变化"));

    await user.click(screen.getByRole("button", { name: "添加前置条件" }));
    const prerequisite = screen.getByRole("group", { name: "前置条件 1" });
    await user.selectOptions(within(prerequisite).getByLabelText("条件类型"), "state");
    await user.type(within(prerequisite).getByLabelText("状态名称"), "密信仍然完整");
    await user.type(within(prerequisite).getByLabelText("条件说明"), "阿莉娅必须先拿到密信");

    await user.click(screen.getByRole("button", { name: "添加人物状态变化" }));
    const characterState = screen.getByRole("group", { name: "人物状态变化 1" });
    await user.selectOptions(within(characterState).getByLabelText("人物"), "character-aria");
    await user.type(within(characterState).getByLabelText("状态名称"), "知情状态");
    await user.type(within(characterState).getByLabelText("变化前"), "不知道");
    await user.type(within(characterState).getByLabelText("变化后"), "已经知道");

    await user.click(screen.getByRole("button", { name: "添加人物关系变化" }));
    const relationship = screen.getByRole("group", { name: "人物关系变化 1" });
    await user.selectOptions(within(relationship).getByLabelText("人物一"), "character-aria");
    await user.selectOptions(within(relationship).getByLabelText("人物二"), "character-mira");
    await user.type(within(relationship).getByLabelText("关系名称"), "信任程度");
    await user.type(within(relationship).getByLabelText("变化前"), "怀疑");
    await user.type(within(relationship).getByLabelText("变化后"), "信任");

    await user.click(screen.getByRole("button", { name: "添加物品变化" }));
    const item = screen.getByRole("group", { name: "物品变化 1" });
    await user.type(within(item).getByLabelText("物品名称"), "密信");
    await user.selectOptions(within(item).getByLabelText(/原持有人/u), "character-aria");
    await user.selectOptions(within(item).getByLabelText(/新持有人/u), "character-mira");

    await user.click(screen.getByRole("button", { name: "添加伏笔推进" }));
    const foreshadow = screen.getByRole("group", { name: "伏笔推进 1" });
    await user.type(within(foreshadow).getByLabelText("伏笔名称"), "真正继承人");
    await user.selectOptions(within(foreshadow).getByLabelText("推进阶段"), "revealed");
    await user.type(within(foreshadow).getByLabelText("本次变化"), "密信揭示继承人身份");

    expect(screen.getByRole("button", { name: "确认并保存事件" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "确认并保存事件" }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        prerequisites: [expect.objectContaining({ kind: "state", referenceLabel: "密信仍然完整" })],
        characterStateChanges: [
          expect.objectContaining({ characterId: "character-aria", attributeLabel: "知情状态" }),
        ],
        relationshipChanges: [
          expect.objectContaining({
            fromCharacterId: "character-aria",
            toCharacterId: "character-mira",
            relationshipLabel: "信任程度",
          }),
        ],
        itemChanges: [expect.objectContaining({ itemLabel: "密信", kind: "transferred" })],
        foreshadowProgress: [
          expect.objectContaining({ foreshadowLabel: "真正继承人", kind: "revealed" }),
        ],
      }),
    );
  });

  it("reports a saved fact separately when projection or page refresh is unavailable", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn().mockRejectedValue(new Error("refresh failed"));
    renderPanel({
      receipt: {
        fact: {} as CausalFactAuthoringReceipt["fact"],
        persistence: "created",
        projection: null,
        projectionError: "正式设定已安全保存，但故事关联暂时未刷新。",
      },
      onCreated,
    });
    await fillRequiredEventFields(user);
    await user.click(screen.getByRole("button", { name: "确认并保存事件" }));
    expect(await screen.findByText("正式设定已保存，页面等待刷新")).toBeVisible();
    expect(screen.getByText(/正式设定已安全保存/u)).toBeVisible();
    expect(screen.queryByText("没有保存故事关联")).not.toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});

function renderPanel(
  options: Readonly<{
    receipt?: CausalFactAuthoringReceipt;
    onCreated?: CausalFactAuthoringPanelProps["onCreated"];
  }> = {},
): Readonly<{ createEvent: ReturnType<typeof vi.fn> }> {
  const projectId = parseUuidV7(PROJECT_ID);
  const chapterId = parseUuidV7(CHAPTER_ID);
  const versionId = parseUuidV7(VERSION_ID);
  const now = parseIsoUtcTimestamp(NOW);
  if (!projectId.ok || !chapterId.ok || !versionId.ok || !now.ok) {
    throw new Error("Test identifiers must be valid UUIDv7 values.");
  }
  const chapter = Chapter.create({
    id: chapterId.value,
    projectId: projectId.value,
    title: "第一章",
    content: "Aria 读完密信，知道了真正的继承人。",
    initialVersionId: versionId.value,
    now: now.value,
  });
  if (!chapter.ok) throw chapter.error;
  const chapters = {
    listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [chapter.value] }),
  } as unknown as Pick<ChapterRepository, "listByProjectId">;
  const receipt =
    options.receipt ??
    ({
      fact: {},
      persistence: "created",
      projection: { graph: { events: [] } },
      projectionError: null,
    } as unknown as CausalFactAuthoringReceipt);
  const createEvent = vi.fn().mockResolvedValue(receipt);
  const service = {
    createEvent,
    createRelation: vi.fn(),
    listConfirmedCharacters: vi
      .fn()
      .mockResolvedValue([
        Object.freeze({ id: "character-aria", name: "阿莉娅" }),
        Object.freeze({ id: "character-mira", name: "米拉" }),
      ]),
  } as unknown as CausalFactAuthoringPanelProps["service"];
  render(
    <CausalFactAuthoringPanel
      projectId={PROJECT_ID}
      actorId={ACTOR_ID}
      events={[]}
      chapters={chapters}
      service={service}
      onCreated={options.onCreated ?? vi.fn()}
    />,
  );
  return Object.freeze({ createEvent });
}

async function fillRequiredEventFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByRole("option", { name: "第一章" });
  await user.type(screen.getByLabelText("发生了什么"), "Aria 读完密信");
  await user.type(screen.getByLabelText("造成了什么结果"), "Aria 知道真正继承人的身份");
  await user.type(screen.getByLabelText("故事中的时间"), "当晚");
  await user.type(screen.getByLabelText("发生地点"), "书房");
  await user.type(
    screen.getByLabelText("从已保存正文复制原文证据"),
    "Aria 读完密信，知道了真正的继承人。",
  );
}
