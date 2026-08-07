import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { CausalEventGraph, StoryFact } from "@inkshadow/story-core";

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
      prerequisites: [],
      eventText: "林夏打开旧门",
      resultText: "钟声响起",
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      informedCharacterIds: ["林夏"],
      foreshadowProgress: [],
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
      impactedEvents: [],
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
          authoring={{ createEvent: vi.fn(), createRelation: vi.fn() }}
          chapters={{ listByProjectId: vi.fn().mockResolvedValue({ ok: true, value: [] }) }}
          actorId="019f9f4a-b3c7-7350-9226-000000000005"
          legacyProjectionAvailable={false}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "林夏打开旧门" })).toBeInTheDocument();
    expect(screen.getByText("“打开旧门”")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "试演改变它会影响哪里" }));
    await waitFor(() => expect(traceImpacts).toHaveBeenCalled());
    expect(screen.getByText("当前没有找到会被这个改变波及的已确认后续事件。")).toBeInTheDocument();
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
          authoring={{ createEvent: vi.fn(), createRelation: vi.fn() }}
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
});
