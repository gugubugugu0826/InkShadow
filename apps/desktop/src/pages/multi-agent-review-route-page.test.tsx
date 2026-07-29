import { render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { chapterCandidateLocation } from "./multi-agent-review-route";

describe("multi-Agent review route boundary", () => {
  it("carries the exact isolated chapter candidate in the editor URL", () => {
    expect(
      chapterCandidateLocation(
        "019f9f4a-b3c7-7350-9226-000000000001",
        "019f9f4a-b3c7-7350-9226-000000000002",
        "019f9f4a-b3c7-7350-9226-000000000003",
      ),
    ).toBe(
      "/projects/019f9f4a-b3c7-7350-9226-000000000001/chapters/019f9f4a-b3c7-7350-9226-000000000002?candidate=019f9f4a-b3c7-7350-9226-000000000003",
    );
  });

  it("keeps a direct route read-only when the default-off flag is disabled", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const created = await base.useCases.createProject.execute({
      name: "雾港审查项目",
    });
    if (!created.ok) {
      throw created.error;
    }
    const listHistory = vi.fn(() => Promise.resolve([]));
    const startReview = vi.fn();
    const runReview = vi.fn();
    const multiAgentReview = {
      acceptOutlineCandidate: vi.fn(),
      cancelReview: vi.fn(),
      exportHistory: vi.fn(),
      expireCandidate: vi.fn(),
      listHistory,
      rejectCandidate: vi.fn(),
      restartReview: vi.fn(),
      runReview,
      startReview,
    } as unknown as NonNullable<DesktopRuntime["multiAgentReview"]>;
    const runtime: DesktopRuntime = {
      ...base,
      multiAgentReview,
      featureFlags: Object.freeze({
        ...base.featureFlags,
        multiAgent: false,
      }),
    };

    renderRoute(runtime, `/projects/${created.value.id}/multi-agent-review`);

    expect(await screen.findByRole("heading", { name: "多 Agent 审查", level: 1 })).toBeVisible();
    expect(screen.getByText("多 Agent 创建功能当前关闭")).toBeVisible();
    expect(screen.queryByRole("button", { name: "开始本地审查" })).toBeNull();
    expect(screen.queryByRole("link", { name: "多 Agent 审查" })).toBeNull();
    await waitFor(() => expect(listHistory).toHaveBeenCalledWith(created.value.id, 50));
    expect(startReview).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
  });
});

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
