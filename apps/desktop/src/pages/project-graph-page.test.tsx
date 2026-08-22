import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ok } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import type {
  StoryGraphInspection,
  StoryGraphRuntimePort,
} from "../infrastructure/story-graph-runtime";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

const REBUILT_AT = "2026-07-28T00:00:00.000Z";

const EMPTY_DIAGNOSTICS = {
  formalRecordCount: 0,
  reviewItemCount: 0,
  chapterCount: 0,
  formalEntityCount: 0,
  chapterEntityCount: 0,
  relationCount: 0,
  sourceVersionCount: 0,
  skippedRelationCount: 0,
  invalidatedSupportCount: 0,
  projectionOmissionCount: 0,
  nonReviewDerivedFormalCount: 0,
  nonExtractionReviewFormalCount: 0,
  skipped: [],
  partial: false,
  stale: false,
} as const;

describe("ProjectGraphPage feature boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps confirmed story links available when the legacy projection is disabled", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const project = await base.useCases.createProject.execute({ name: "雾港档案" });
    if (!project.ok) {
      throw project.error;
    }
    const graph = graphRuntime(project.value.id);
    const runtime: DesktopRuntime = {
      ...base,
      storyGraph: graph.port,
      featureFlags: { ...base.featureFlags, graphRag: false },
    };

    renderRoute(runtime, `/projects/${project.value.id}/graph`);

    expect(await screen.findByRole("heading", { name: "故事关联", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "故事关系图" })).not.toBeInTheDocument();
    expect(await screen.findByText("还没有可用的故事关联")).toBeInTheDocument();
    expect(graph.inspectProject).not.toHaveBeenCalled();
  });

  it("preserves the old projection behind an explicit expert query", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const project = await base.useCases.createProject.execute({ name: "星河纪事" });
    if (!project.ok) {
      throw project.error;
    }
    const graph = graphRuntime(project.value.id);
    const runtime: DesktopRuntime = {
      ...base,
      storyGraph: graph.port,
      featureFlags: { ...base.featureFlags, graphRag: true },
    };
    const user = userEvent.setup();

    renderRoute(runtime, `/projects/${project.value.id}/graph?legacy=1`);

    expect(
      await screen.findByRole("heading", { name: "故事关系图", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("还没有可投影的正式故事记录")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "构建关系图" }));

    await waitFor(() => {
      expect(graph.rebuildProject).toHaveBeenCalledWith(project.value.id);
    });
    expect(graph.inspectProject).toHaveBeenCalledTimes(2);
  });

  it("offers the old projection only when flag and runtime agree", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const project = await base.useCases.createProject.execute({ name: "潮汐城" });
    if (!project.ok) {
      throw project.error;
    }
    const runtime: DesktopRuntime = {
      ...base,
      storyGraph: graphRuntime(project.value.id).port,
      featureFlags: { ...base.featureFlags, graphRag: true },
    };

    renderRoute(runtime, `/projects/${project.value.id}/graph`);

    expect(await screen.findByRole("heading", { name: "故事关联", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开旧版投影视图" })).toHaveAttribute(
      "href",
      `/projects/${project.value.id}/graph?legacy=1`,
    );
  });

  it("keeps legacy graph kinds behind understandable Chinese labels", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const project = await base.useCases.createProject.execute({ name: "旧图谱兼容" });
    if (!project.ok) {
      throw project.error;
    }
    const rawKnownKind = "character_identity";
    const rawUnknownKind = "legacy_story_node";
    const rawRelationKind = "legacy_story_edge";
    const identityId = "identity-entity";
    const legacyId = "legacy-entity";
    const source = {
      sourceId: "legacy-source",
      sourceVersionId: "legacy-version",
      contentHash: "a".repeat(64),
    };
    const graph = graphRuntime(project.value.id, {
      projectId: project.value.id,
      sourceVersions: [],
      entities: [
        {
          id: identityId,
          projectId: project.value.id,
          kind: rawKnownKind,
          label: "旧角色",
          source,
          updatedAt: REBUILT_AT,
        },
        {
          id: legacyId,
          projectId: project.value.id,
          kind: rawUnknownKind,
          label: "旧节点",
          source,
          updatedAt: REBUILT_AT,
        },
      ],
      relations: [
        {
          id: "legacy-relation",
          projectId: project.value.id,
          fromEntityId: identityId,
          toEntityId: legacyId,
          kind: rawRelationKind,
          polarity: "affirmed",
          confidence: 1,
          evidence: [],
          updatedAt: REBUILT_AT,
        },
      ],
      revision: 1,
      status: "ready",
      updatedAt: REBUILT_AT,
    });
    const runtime: DesktopRuntime = {
      ...base,
      storyGraph: graph.port,
      featureFlags: { ...base.featureFlags, graphRag: true },
    };

    renderRoute(runtime, `/projects/${project.value.id}/graph?legacy=1`);

    expect((await screen.findAllByText("角色身份")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("其他故事资料").length).toBeGreaterThan(0);
    expect(screen.getAllByText("其他关联").length).toBeGreaterThan(0);
    expect(screen.queryByText(rawKnownKind)).not.toBeInTheDocument();
    expect(screen.queryByText(rawUnknownKind)).not.toBeInTheDocument();
    expect(screen.queryByText(rawRelationKind)).not.toBeInTheDocument();
  });
});

function graphRuntime(projectId: string, projection: StoryGraphInspection["projection"] = null) {
  const inspection: StoryGraphInspection = {
    projectId,
    freshness: projection === null ? "missing" : "fresh",
    projection,
    authoritative: EMPTY_DIAGNOSTICS,
  };
  const inspectProject = vi.fn(() => Promise.resolve(ok(inspection)));
  const rebuildProject = vi.fn(() =>
    Promise.resolve(
      ok({
        ...EMPTY_DIAGNOSTICS,
        projectId,
        previousRevision: 0,
        revision: 1,
        rebuiltAt: REBUILT_AT,
        casAttempts: 1,
      }),
    ),
  );
  const port: StoryGraphRuntimePort = {
    available: true,
    inspectProject,
    rebuildProject,
    queryContext: vi.fn(() => Promise.reject(new Error("Not used by the page."))),
  };
  return { port, inspectProject, rebuildProject };
}

function renderRoute(runtime: DesktopRuntime, route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
