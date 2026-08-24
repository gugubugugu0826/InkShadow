import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { StudioReviewRoutePage } from "./studio-review-route-page";

describe("StudioReviewRoutePage", () => {
  it("keeps the unavailable runtime code out of the ordinary error card", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    render(
      <MemoryRouter initialEntries={[`/teams/${uuid(1)}/projects/${uuid(2)}/reviews`]}>
        <RuntimeProvider runtime={runtime}>
          <Routes>
            <Route
              path="/teams/:teamId/projects/:projectId/reviews"
              element={<StudioReviewRoutePage />}
            />
          </Routes>
        </RuntimeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("团队加密审阅不可用")).toBeVisible();
    expect(screen.queryByText("REVIEW_RUNTIME_UNAVAILABLE")).not.toBeInTheDocument();
  });
});

function uuid(index: number): string {
  return `019f9f4a-b3c7-7350-9226-${String(index).padStart(12, "0")}`;
}
