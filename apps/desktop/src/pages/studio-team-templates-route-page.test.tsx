import { ToastProvider } from "@inkshadow/ui";
import type { CloudQueryOptions } from "@inkshadow/cloud-client";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import type {
  ApplyPublishedStudioTeamTemplateOutcome,
  StudioTeamTemplateListView,
} from "../infrastructure/studio-team-template-coordinator";
import type { StudioTeamTemplateSessionContext } from "../infrastructure/studio-team-template-service";
import type { StudioTeamTemplateRuntime } from "../infrastructure/studio-team-template-runtime";
import { RuntimeProvider } from "../runtime-context";
import { StudioTeamTemplatesRoutePage } from "./studio-team-templates-route-page";

const TEAM_ID = uuid(1);
const TENANT_ID = uuid(2);
const MEMBERSHIP_ID = uuid(3);
const DEVICE_ID = uuid(4);

describe("StudioTeamTemplatesRoutePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("resolves session authority, local project revision and pending receipts before reading", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const created = await base.useCases.createProject.execute({ name: "Team templates" });
    if (!created.ok) {
      throw created.error;
    }
    const context: StudioTeamTemplateSessionContext = {
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: created.value.id,
      membershipId: MEMBERSHIP_ID,
      deviceId: DEVICE_ID,
      role: "author",
      membershipState: "active",
      assignmentState: "active",
    };
    const listTemplates =
      vi.fn<
        (
          context: StudioTeamTemplateSessionContext,
          options?: CloudQueryOptions,
        ) => Promise<StudioTeamTemplateListView>
      >();
    listTemplates.mockResolvedValue({
      requestId: uuid(10),
      items: [],
      nextCursor: null,
    });
    const recoverPendingApplications =
      vi.fn<
        (
          context: StudioTeamTemplateSessionContext,
          options?: Readonly<{ limit?: number; signal?: AbortSignal }>,
        ) => Promise<readonly ApplyPublishedStudioTeamTemplateOutcome[]>
      >();
    recoverPendingApplications.mockResolvedValue([]);
    const resolveContext =
      vi.fn<
        (
          teamId: string,
          projectId: string,
          signal?: AbortSignal,
        ) => Promise<StudioTeamTemplateSessionContext>
      >();
    resolveContext.mockResolvedValue(context);
    const templateRuntime = {
      coordinator: {
        capabilities: vi.fn().mockReturnValue({
          read: true,
          create: true,
          createVersion: true,
          clone: true,
          apply: true,
          publish: false,
          archive: false,
        }),
        listTemplates,
        applyPublished: vi.fn(),
        archiveTemplate: vi.fn(),
        clonePublished: vi.fn(),
        createDraft: vi.fn(),
        exportTemplateHistory: vi.fn(),
        publishDraft: vi.fn(),
        retryApplicationRecord: vi.fn(),
      },
      isMutationEnabled: () => true,
      isOnline: () => true,
      resolveContext,
      recoverPendingApplications,
    } as unknown as StudioTeamTemplateRuntime;
    const runtime: DesktopRuntime = {
      ...base,
      studioTeamTemplates: templateRuntime,
      featureFlags: Object.freeze({
        ...base.featureFlags,
        teamCollaboration: true,
        cloudSync: true,
      }),
    };

    renderRoute(runtime, `/teams/${TEAM_ID}/projects/${created.value.id}/templates`);

    expect(await screen.findByRole("heading", { name: "加密团队模板", level: 1 })).toBeVisible();
    expect(screen.getByText("还没有团队模板")).toBeVisible();
    await waitFor(() => expect(resolveContext).toHaveBeenCalledTimes(1));
    const resolveCall = resolveContext.mock.calls[0];
    expect(resolveCall?.[0]).toBe(TEAM_ID);
    expect(resolveCall?.[1]).toBe(created.value.id);
    expect(resolveCall?.[2]).toBeInstanceOf(AbortSignal);
    const recoveryCall = recoverPendingApplications.mock.calls[0];
    expect(recoveryCall?.[0]).toEqual(context);
    expect(recoveryCall?.[1]?.limit).toBe(50);
    expect(recoveryCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const listCall = listTemplates.mock.calls[0];
    expect(listCall?.[0]).toEqual(context);
    expect(listCall?.[1]?.limit).toBe(50);
    expect(listCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never fabricates encrypted cloud templates in browser development mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    renderRoute(runtime, `/teams/${TEAM_ID}/projects/${uuid(20)}/templates`);

    expect(await screen.findByText("加密团队模板不可用")).toBeVisible();
    expect(screen.getByText(/浏览器开发模式不会伪造远端成功/u)).toBeVisible();
  });

  it("keeps an invalid route code out of the ordinary error card", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    renderRoute(runtime, `/teams/${TEAM_ID}/projects/not-a-project/templates`);

    expect(await screen.findByText("无法打开团队模板")).toBeVisible();
    expect(screen.queryByText("TEAM_TEMPLATE_ROUTE_SCOPE_INVALID")).not.toBeInTheDocument();
  });
});

function renderRoute(runtime: DesktopRuntime, route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route
              path="/teams/:teamId/projects/:projectId/templates"
              element={<StudioTeamTemplatesRoutePage />}
            />
            <Route path="/teams" element={<div>Team workspace</div>} />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function uuid(index: number): string {
  return `019f9f4a-b3c7-7350-9226-${String(index).padStart(12, "0")}`;
}
