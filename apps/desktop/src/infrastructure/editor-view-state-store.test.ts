import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  EDITOR_VIEW_STATE_ENTRY_LIMIT,
  EDITOR_VIEW_STATE_STORAGE_KEY,
  loadEditorView,
  saveEditorTypography,
  saveEditorView,
} from "./editor-view-state-store";

const PROJECT_ID = "019c1234-0000-7000-8000-000000000001";
const CHAPTER_ID = "019c1234-0000-7000-8000-000000000002";

describe("editor view-state store", () => {
  it("persists only bounded non-content view metadata and restores UTF-16 selections", () => {
    saveEditorView(window.localStorage, {
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      selection: { start: 3, end: 5 },
      scrollTop: 420,
      typography: {
        fontFamily: "sans",
        fontSize: 20,
        lineHeight: 1.8,
        measure: "wide",
      },
      updatedAt: 7,
    });

    const serialized = window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("正文");
    expect(loadEditorView(window.localStorage, PROJECT_ID, CHAPTER_ID, 4)).toEqual({
      view: {
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        selection: { start: 3, end: 4 },
        scrollTop: 420,
        updatedAt: 7,
      },
      typography: {
        fontFamily: "sans",
        fontSize: 20,
        lineHeight: 1.8,
        measure: "wide",
      },
    });
  });

  it("removes corrupt and oversized state without blocking the editor", () => {
    window.localStorage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, "{broken");
    expect(loadEditorView(window.localStorage, PROJECT_ID, CHAPTER_ID, 10)).toEqual({
      view: null,
      typography: DEFAULT_EDITOR_TYPOGRAPHY,
    });
    expect(window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, "x".repeat(300_000));
    expect(loadEditorView(window.localStorage, PROJECT_ID, CHAPTER_ID, 10).view).toBeNull();
    expect(window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY)).toBeNull();
  });

  it("canonicalizes unknown fields, clamps typography, and bounds old chapter entries", () => {
    for (let index = 0; index < EDITOR_VIEW_STATE_ENTRY_LIMIT + 5; index += 1) {
      const suffix = (index + 10).toString(16).padStart(12, "0");
      saveEditorView(window.localStorage, {
        projectId: PROJECT_ID,
        chapterId: `019c1234-0000-7000-8000-${suffix}`,
        selection: { start: index, end: index },
        scrollTop: index,
        typography: DEFAULT_EDITOR_TYPOGRAPHY,
        updatedAt: index,
      });
    }

    const parsed = JSON.parse(
      window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY) ?? "{}",
    ) as {
      entries?: unknown[];
    };
    expect(parsed.entries).toHaveLength(EDITOR_VIEW_STATE_ENTRY_LIMIT);

    saveEditorTypography(window.localStorage, {
      fontFamily: "mono",
      fontSize: 200,
      lineHeight: 10,
      measure: "narrow",
    });
    expect(loadEditorView(window.localStorage, PROJECT_ID, CHAPTER_ID, 0).typography).toEqual({
      fontFamily: "mono",
      fontSize: 24,
      lineHeight: 2.4,
      measure: "narrow",
    });
  });

  it("strips unexpected stored body fields during canonical cleanup", () => {
    window.localStorage.setItem(
      EDITOR_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        typography: DEFAULT_EDITOR_TYPOGRAPHY,
        entries: [
          {
            projectId: PROJECT_ID,
            chapterId: CHAPTER_ID,
            selection: { start: 0, end: 0 },
            scrollTop: 0,
            updatedAt: 1,
            content: "不应留在视图状态中的正文",
          },
        ],
      }),
    );

    expect(loadEditorView(window.localStorage, PROJECT_ID, CHAPTER_ID, 10).view).not.toBeNull();
    expect(window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY)).not.toContain("正文");
  });
});
