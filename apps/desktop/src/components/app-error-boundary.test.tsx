// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectDesktopDiagnosticArtifact } from "../infrastructure/diagnostics";
import { createDevelopmentRuntime } from "../infrastructure/runtime";
import {
  forgetUiRouteDiagnosticsMemoryForTests,
  readSafeUiRouteIncidents,
} from "../infrastructure/ui-route-diagnostics";
import { AppErrorBoundary } from "./app-error-boundary";

const PROJECT_ID = "018f0000-0000-7000-8000-000000000011";
const CHAPTER_ID = "018f0000-0000-7000-8000-000000000012";
const CANDIDATE_ID = "018f0000-0000-7000-8000-000000000013";
const FIXED_NOW = "2026-08-22T06:07:08.009Z";

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "/start";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("shows and persists a redacted support record for malformed legacy editor data", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const owner = {};
    let malformed = true;
    const sensitiveMessage =
      "旧 Candidate 含正文：不应保存；sk-secret；C:/Users/writer/private-project.txt";

    function LegacyEditorView() {
      if (malformed) {
        const error = Object.assign(new TypeError(sensitiveMessage), {
          code: "LEGACY_CANDIDATE_METADATA_INVALID",
        });
        error.stack = [
          `TypeError: ${sensitiveMessage}`,
          "    at EditorPage (C:/Users/writer/InkShadow/apps/desktop/src/pages/editor-page.tsx:88:7)",
        ].join("\n");
        throw error;
      }
      return <p>旧数据已进入可恢复页面状态</p>;
    }

    render(
      <AppErrorBoundary
        diagnosticOwner={owner}
        now={() => FIXED_NOW}
        route={() =>
          `#/projects/${PROJECT_ID}/chapters/${CHAPTER_ID}?candidate=${CANDIDATE_ID}&token=never-store`
        }
      >
        <LegacyEditorView />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "这个页面暂时没有正常打开" })).toBeVisible();
    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
    expect(screen.queryByText(sensitiveMessage)).not.toBeInTheDocument();
    expect(screen.getByText(/已保存的正文、版本和本地备份不会/u)).toBeVisible();

    const incident = readSafeUiRouteIncidents(owner)[0];
    expect(incident).toMatchObject({
      route: "/projects/:projectId/chapters/:chapterId?candidate=:candidateId",
      triggerIds: { projectId: PROJECT_ID, chapterId: CHAPTER_ID, candidateId: CANDIDATE_ID },
      componentName: "AppErrorBoundary",
      normalizedErrorCode: "LEGACY_CANDIDATE_METADATA_INVALID",
      errorType: "TypeError",
      applicationStack: [
        "TypeError: LEGACY_CANDIDATE_METADATA_INVALID",
        "at EditorPage (apps/desktop/src/pages/editor-page.tsx:88:7)",
      ],
      recovered: false,
    });
    expect(incident?.reactComponentStack.some((frame) => frame.includes("LegacyEditorView"))).toBe(
      true,
    );
    expect(incident?.fingerprint).toMatch(/^ui-[0-9a-f]{8}$/u);

    const persistedBeforeRecovery = storageText();
    for (const secret of [
      sensitiveMessage,
      "不应保存",
      "sk-secret",
      "C:/Users",
      "private-project",
      "never-store",
    ]) {
      expect(persistedBeforeRecovery).not.toContain(secret);
    }

    malformed = false;
    fireEvent.click(screen.getByRole("button", { name: "重试当前页面" }));
    expect(screen.getByText("旧数据已进入可恢复页面状态")).toBeVisible();
    expect(readSafeUiRouteIncidents(owner)[0]).toMatchObject({
      diagnosticId: incident?.diagnosticId,
      recovered: true,
      recoveryAction: "retry",
    });

    forgetUiRouteDiagnosticsMemoryForTests(owner);
    const runtimeAfterReload = createDevelopmentRuntime(window.localStorage);
    const artifact = await collectDesktopDiagnosticArtifact(runtimeAfterReload);
    expect(artifact.bundle.recentUiFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticId: incident?.diagnosticId,
          normalizedErrorCode: "LEGACY_CANDIDATE_METADATA_INVALID",
          recovered: true,
        }),
      ]),
    );
    expect(JSON.stringify(artifact.bundle.recentUiFailures)).not.toContain(sensitiveMessage);
  });

  it("records returning to the start page as a recovery without raw exception detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const owner = {};
    function BrokenView() {
      if (window.location.hash === "#/start") return <p>创作首页已恢复</p>;
      throw new Error("private remote detail");
    }
    window.location.hash = "/projects";

    render(
      <AppErrorBoundary diagnosticOwner={owner} now={() => FIXED_NOW}>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
    expect(screen.queryByText("private remote detail")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回创作首页" }));
    expect(window.location.hash).toBe("#/start");
    expect(readSafeUiRouteIncidents(owner)[0]).toMatchObject({
      recovered: true,
      recoveryAction: "navigate_start",
    });
  });
});

function storageText(): string {
  return Array.from({ length: window.localStorage.length }, (_, index) => {
    const key = window.localStorage.key(index);
    return key === null ? "" : `${key}:${window.localStorage.getItem(key) ?? ""}`;
  }).join("\n");
}
