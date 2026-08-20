import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { CausalEventGraph, StoryFact } from "@inkshadow/story-core";

import { CausalEventGraphStoreError } from "../infrastructure/causal-event-graph-store";
import { CausalStoryLinksPage } from "./causal-story-links-page";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const EVENT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const BRANCH_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const FACT_ID = "019f9f4a-b3c7-7350-9226-000000000004";

const graph = CausalEventGraph.create({
  events: [
    {
      id: EVENT_ID,
      projectId: PROJECT_ID,
      branchId: "main",
      status: "confirmed",
      participantCharacterIds: ["林夏"],
      narrativeTime: { order: 1, label: "第一幕" },
      location: { locationId: "school", label: "旧校舍" },
      prerequisites: [
        {
          id: "prerequisite-one",
          kind: "state",
          referenceId: "state-has-key",
          referenceLabel: "持有旧门钥匙",
          description: "林夏先取得钥匙",
          evidence: {
            id: "evidence-prerequisite",
            chapterId: "chapter-one",
            chapterVersionId: "version-one",
            contentHash: "a".repeat(64),
            locator: "utf16:0-4/4",
            excerpt: "打开旧门",
            startOffset: 0,
            endOffset: 4,
            sourceLength: 4,
          },
        },
      ],
      eventText: "林夏打开旧门",
      resultText: "钟声响起",
      characterStateChanges: [
        {
          id: "state-change-one",
          characterId: "character-linxia",
          attributeKey: "state-courage",
          attributeLabel: "勇气",
          beforeValue: "犹豫",
          afterValue: "坚定",
          evidence: {
            id: "evidence-state",
            chapterId: "chapter-one",
            chapterVersionId: "version-one",
            contentHash: "a".repeat(64),
            locator: "utf16:0-4/4",
            excerpt: "打开旧门",
            startOffset: 0,
            endOffset: 4,
            sourceLength: 4,
          },
        },
      ],
      relationshipChanges: [
        {
          id: "relationship-change-one",
          fromCharacterId: "character-linxia",
          toCharacterId: "character-zhouming",
          relationshipKey: "relationship-trust",
          relationshipLabel: "信任程度",
          beforeValue: "怀疑",
          afterValue: "信任",
          evidence: {
            id: "evidence-relationship",
            chapterId: "chapter-one",
            chapterVersionId: "version-one",
            contentHash: "a".repeat(64),
            locator: "utf16:0-4/4",
            excerpt: "打开旧门",
            startOffset: 0,
            endOffset: 4,
            sourceLength: 4,
          },
        },
      ],
      itemChanges: [
        {
          id: "item-change-one",
          itemId: "item-key",
          itemLabel: "旧门钥匙",
          kind: "transferred",
          fromCharacterId: "character-linxia",
          toCharacterId: "character-zhouming",
          evidence: {
            id: "evidence-item",
            chapterId: "chapter-one",
            chapterVersionId: "version-one",
            contentHash: "a".repeat(64),
            locator: "utf16:0-4/4",
            excerpt: "打开旧门",
            startOffset: 0,
            endOffset: 4,
            sourceLength: 4,
          },
        },
      ],
      informedCharacterIds: ["林夏"],
      foreshadowProgress: [
        {
          id: "foreshadow-one",
          foreshadowId: "foreshadow-bell",
          foreshadowLabel: "午夜钟声",
          kind: "planted",
          description: "第一次听见异常钟声",
          evidence: {
            id: "evidence-foreshadow",
            chapterId: "chapter-one",
            chapterVersionId: "version-one",
            contentHash: "a".repeat(64),
            locator: "utf16:0-4/4",
            excerpt: "打开旧门",
            startOffset: 0,
            endOffset: 4,
            sourceLength: 4,
          },
        },
      ],
      downstreamEventIds: [],
      evidence: {
        id: "evidence-one",
        chapterId: "chapter-one",
        chapterVersionId: "version-one",
        contentHash: "a".repeat(64),
        locator: "utf16:0-4/4",
        excerpt: "打开旧门",
        startOffset: 0,
        endOffset: 4,
        sourceLength: 4,
      },
    },
  ],
  relations: [],
});

describe("causal story links page", () => {
  it("shows confirmed evidence and traces impact without changing the story", async () => {
    const traceImpacts = vi.fn().mockResolvedValue({
      projectId: PROJECT_ID,
      branchId: "main",
      changedEventIds: [EVENT_ID],
      impactedEvents: [
        {
          eventId: "raw-downstream-event-id",
          depth: 1,
          pathEventIds: [EVENT_ID, "raw-downstream-event-id"],
        },
      ],
      cycleEdgesSkipped: [],
      truncated: false,
      truncationReasons: [],
      capabilities: {
        deterministicImpactTraversal: "ready",
        alternatePlotGeneration: "available_via_governed_service",
        uiIntegration: "available_via_governed_service",
      },
    });
    render(
      <MemoryRouter>
        <CausalStoryLinksPage
          projectId={PROJECT_ID}
          graph={{
            loadProjectBranch: vi.fn().mockResolvedValue(graph),
            replace: vi.fn(),
            append: vi.fn(),
            traceImpacts,
          }}
          projector={{ rebuildProject: vi.fn() } as never}
          whatIf={{ simulate: vi.fn(), list: vi.fn().mockResolvedValue([]) }}
          whatIfEnabled={true}
          authoring={{
            createEvent: vi.fn(),
            createRelation: vi.fn(),
            listConfirmedCharacters: vi.fn().mockResolvedValue([]),
          }}
          chapters={{ listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [] }) }}
          actorId="019f9f4a-b3c7-7350-9226-000000000005"
          legacyProjectionAvailable={false}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "林夏打开旧门" })).toBeInTheDocument();
    expect(screen.getByText("“打开旧门”")).toBeInTheDocument();
    expect(screen.getByText(/持有旧门钥匙.*林夏先取得钥匙/u)).toBeInTheDocument();
    expect(screen.getByText(/勇气.*犹豫.*坚定/u)).toBeInTheDocument();
    expect(screen.getByText(/信任程度.*怀疑.*信任/u)).toBeInTheDocument();
    expect(screen.getByText(/旧门钥匙.*转移/u)).toBeInTheDocument();
    expect(screen.getByText(/午夜钟声.*埋设.*第一次听见异常钟声/u)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(EVENT_ID);
    expect(document.body).not.toHaveTextContent("character-linxia");
    expect(document.body).not.toHaveTextContent("character-zhouming");
    await userEvent.click(screen.getByRole("button", { name: "试演改变它会影响哪里" }));
    await waitFor(() => expect(traceImpacts).toHaveBeenCalled());
    expect(screen.getByText(/后续事件 1.*相隔 1 层/u)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-downstream-event-id");
  });

  it("fully gates ordinary what-if UI and provider access when the feature is closed", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const simulate = vi.fn();
    const traceImpacts = vi.fn();
    render(
      <MemoryRouter>
        <CausalStoryLinksPage
          projectId={PROJECT_ID}
          graph={{
            loadProjectBranch: vi.fn().mockResolvedValue(graph),
            replace: vi.fn(),
            append: vi.fn(),
            traceImpacts,
          }}
          projector={{ rebuildProject: vi.fn() } as never}
          whatIf={{ simulate, list }}
          whatIfEnabled={false}
          authoring={{
            createEvent: vi.fn(),
            createRelation: vi.fn(),
            listConfirmedCharacters: vi.fn().mockResolvedValue([]),
          }}
          chapters={{ listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [] }) }}
          actorId="019f9f4a-b3c7-7350-9226-000000000005"
          legacyProjectionAvailable={false}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "林夏打开旧门" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "试演改变它会影响哪里" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("想改变什么")).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    expect(traceImpacts).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it("generates an isolated alternate direction only after showing deterministic impact", async () => {
    const created = StoryFact.create({
      id: FACT_ID,
      projectId: PROJECT_ID,
      factType: "what_if_simulation",
      contentText: "林夏先去找老师，钟声因此延后。",
      structuredValue: {
        schema: "inkshadow.causal-what-if.v1",
        hypothesis: "林夏没有打开旧门",
        sourceEventId: EVENT_ID,
        deterministicImpactEventIds: [],
        alternateDirection: "林夏先去找老师，钟声因此延后。",
        effects: [],
        sandbox: true,
        changesFormalStory: false,
      },
      source: { kind: "system_derivation", reference: `causal-what-if:${BRANCH_ID}:${EVENT_ID}` },
      branchId: BRANCH_ID,
      confidence: 0.5,
      status: "branch",
      origin: "system",
      needsReview: false,
      humanConfirmed: false,
      now: "2026-08-01T00:00:00.000Z",
    });
    if (!created.ok) throw created.error;
    const simulate = vi.fn().mockResolvedValue({
      branchId: BRANCH_ID,
      fact: created.value,
      deterministicImpactCount: 0,
      truncated: false,
    });
    render(
      <MemoryRouter>
        <CausalStoryLinksPage
          projectId={PROJECT_ID}
          graph={{
            loadProjectBranch: vi.fn().mockResolvedValue(graph),
            replace: vi.fn(),
            append: vi.fn(),
            traceImpacts: vi.fn().mockResolvedValue({
              projectId: PROJECT_ID,
              branchId: "main",
              changedEventIds: [EVENT_ID],
              impactedEvents: [],
              cycleEdgesSkipped: [],
              truncated: false,
              truncationReasons: [],
              capabilities: {
                deterministicImpactTraversal: "ready",
                alternatePlotGeneration: "available_via_governed_service",
                uiIntegration: "available_via_governed_service",
              },
            }),
          }}
          projector={{ rebuildProject: vi.fn() } as never}
          whatIf={{ simulate, list: vi.fn().mockResolvedValue([]) }}
          whatIfEnabled={true}
          authoring={{
            createEvent: vi.fn(),
            createRelation: vi.fn(),
            listConfirmedCharacters: vi.fn().mockResolvedValue([]),
          }}
          chapters={{ listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [] }) }}
          actorId="019f9f4a-b3c7-7350-9226-000000000005"
          legacyProjectionAvailable={false}
        />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "试演改变它会影响哪里" }));
    await userEvent.type(screen.getByLabelText("想改变什么"), "林夏没有打开旧门");
    await userEvent.click(screen.getByRole("button", { name: "生成另一条剧情方案" }));
    await waitFor(() =>
      expect(simulate).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        sourceEventId: EVENT_ID,
        hypothesis: "林夏没有打开旧门",
      }),
    );
    expect(await screen.findByText("林夏先去找老师，钟声因此延后。")).toBeInTheDocument();
    expect(screen.getByText(/正式正文、确认设定和主因果链保持不变/u)).toBeInTheDocument();
  });

  it("projects fatal graph failures into safe ordinary-language recovery guidance", async () => {
    const rawMessage = "SQLITE_BUSY: fatal-causal-graph-sentinel";
    render(
      <MemoryRouter>
        <CausalStoryLinksPage
          projectId={PROJECT_ID}
          graph={{
            loadProjectBranch: vi
              .fn()
              .mockRejectedValue(
                new CausalEventGraphStoreError("CAUSAL_GRAPH_UNAVAILABLE", rawMessage, true),
              ),
            replace: vi.fn(),
            append: vi.fn(),
            traceImpacts: vi.fn(),
          }}
          projector={{ rebuildProject: vi.fn() } as never}
          whatIf={{ simulate: vi.fn(), list: vi.fn().mockResolvedValue([]) }}
          whatIfEnabled={false}
          authoring={{
            createEvent: vi.fn(),
            createRelation: vi.fn(),
            listConfirmedCharacters: vi.fn().mockResolvedValue([]),
          }}
          chapters={{ listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [] }) }}
          actorId="019f9f4a-b3c7-7350-9226-000000000005"
          legacyProjectionAvailable={false}
        />
      </MemoryRouter>,
    );

    const errorState = await screen.findByRole("alert");
    expect(errorState).toHaveTextContent("发生了未预期的本地错误");
    expect(errorState).toHaveTextContent("请先重试");
    expect(document.body).not.toHaveTextContent("CAUSAL_GRAPH_UNAVAILABLE");
    expect(document.body).not.toHaveTextContent(rawMessage);
  });

  it("does not expose raw graph details when an inline operation fails", async () => {
    const rawMessage = "SQLITE_CORRUPT: trace-impact-sentinel";
    render(
      <MemoryRouter>
        <CausalStoryLinksPage
          projectId={PROJECT_ID}
          graph={{
            loadProjectBranch: vi.fn().mockResolvedValue(graph),
            replace: vi.fn(),
            append: vi.fn(),
            traceImpacts: vi
              .fn()
              .mockRejectedValue(
                new CausalEventGraphStoreError("CAUSAL_GRAPH_UNAVAILABLE", rawMessage, true),
              ),
          }}
          projector={{ rebuildProject: vi.fn() } as never}
          whatIf={{ simulate: vi.fn(), list: vi.fn().mockResolvedValue([]) }}
          whatIfEnabled={true}
          authoring={{
            createEvent: vi.fn(),
            createRelation: vi.fn(),
            listConfirmedCharacters: vi.fn().mockResolvedValue([]),
          }}
          chapters={{ listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [] }) }}
          actorId="019f9f4a-b3c7-7350-9226-000000000005"
          legacyProjectionAvailable={false}
        />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "试演改变它会影响哪里" }));

    const inlineError = await screen.findByText(/发生了未预期的本地错误/u);
    expect(inlineError).toHaveTextContent("已保存的正文和设定没有改变");
    expect(document.body).not.toHaveTextContent("CAUSAL_GRAPH_UNAVAILABLE");
    expect(document.body).not.toHaveTextContent(rawMessage);
  });
});
