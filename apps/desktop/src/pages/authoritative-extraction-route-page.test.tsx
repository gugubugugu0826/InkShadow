import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { AuthoritativeExtractionDesktopPort } from "../infrastructure/authoritative-extraction-runtime";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { AuthoritativeExtractionRoutePage } from "./authoritative-extraction-route-page";

const PROJECT_ID = "019fa028-0000-7000-8000-000000000301";

describe("AuthoritativeExtractionRoutePage", () => {
  it("shows the honest provider-unavailable state without touching extraction storage", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const inspect = vi.fn();
    const port = {
      availability: {
        available: false,
        reason: "provider_not_configured",
        persistence: "native_sqlite",
        providerConfigured: false,
      },
      inspect,
      runCycle: vi.fn(),
      runEvaluation: vi.fn(),
      cancel: vi.fn(),
      decideFormal: vi.fn(),
      decideReview: vi.fn(),
      undoAcceptance: vi.fn(),
      rebuildProjection: vi.fn(),
    } as unknown as AuthoritativeExtractionDesktopPort;
    const runtime: DesktopRuntime = {
      ...base,
      authoritativeExtraction: port,
      featureFlags: Object.freeze({
        ...base.featureFlags,
        graphRag: true,
        authoritativeExtraction: true,
      }),
    };

    renderRoute(runtime, `/projects/${PROJECT_ID}/extraction`);

    expect(await screen.findByRole("heading", { name: "权威事实抽取" })).toBeVisible();
    expect(screen.getByText("尚未配置真实抽取提供方")).toBeVisible();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("redirects an invalid project authority instead of opening a cross-project page", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    renderRoute(runtime, "/projects/not-a-uuid/extraction");

    expect(await screen.findByText("projects fallback")).toBeVisible();
  });
});

function renderRoute(runtime: DesktopRuntime, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RuntimeProvider runtime={runtime}>
        <Routes>
          <Route
            path="/projects/:projectId/extraction"
            element={<AuthoritativeExtractionRoutePage />}
          />
          <Route path="/projects" element={<div>projects fallback</div>} />
          <Route path="/projects/:projectId" element={<div>project fallback</div>} />
        </Routes>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
