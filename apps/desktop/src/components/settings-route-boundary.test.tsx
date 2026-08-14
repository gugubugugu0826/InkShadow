import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { readSafeUiRouteIncidents } from "../infrastructure/ui-route-diagnostics";
import { RuntimeProvider } from "../runtime-context";
import { SettingsRouteBoundary } from "./settings-route-boundary";

describe("SettingsRouteBoundary", () => {
  it("keeps a local, redacted recovery surface and records recovery", () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    let shouldThrow = true;
    const sensitiveMessage = "sk-secret at C:/Users/writer/正文.txt";
    function InjectedFailure() {
      if (shouldThrow) throw new Error(sensitiveMessage);
      return <p>设置页面已恢复</p>;
    }

    render(
      <RuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={["/settings#model-center"]}>
          <main aria-label="保留的应用外壳">
            <SettingsRouteBoundary>
              <InjectedFailure />
            </SettingsRouteBoundary>
          </main>
        </MemoryRouter>
      </RuntimeProvider>,
    );

    expect(screen.getByRole("main", { name: "保留的应用外壳" })).toBeInTheDocument();
    expect(screen.getByText("设置页面暂时没有正常打开")).toBeInTheDocument();
    expect(screen.queryByText(sensitiveMessage)).not.toBeInTheDocument();
    expect(readSafeUiRouteIncidents(runtime)[0]).toMatchObject({
      route: "/settings#model-center",
      phase: "render",
      normalizedErrorCode: "UI_RENDER_FAILED",
      recovered: false,
    });

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "重试设置页面" }));

    expect(screen.getByText("设置页面已恢复")).toBeInTheDocument();
    expect(readSafeUiRouteIncidents(runtime)[0]?.recovered).toBe(true);
  });

  it("classifies a safe lazy-load failure separately from a render failure", () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    function LazyFailure(): ReactElement {
      throw Object.assign(new Error("sensitive chunk URL"), { code: "UI_LAZY_LOAD_FAILED" });
    }

    render(
      <RuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={["/settings#model-center"]}>
          <SettingsRouteBoundary>
            <LazyFailure />
          </SettingsRouteBoundary>
        </MemoryRouter>
      </RuntimeProvider>,
    );

    expect(readSafeUiRouteIncidents(runtime)[0]).toMatchObject({
      phase: "lazy_load",
      normalizedErrorCode: "UI_LAZY_LOAD_FAILED",
    });
    expect(screen.queryByText("sensitive chunk URL")).not.toBeInTheDocument();
  });
});
