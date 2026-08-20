import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  fitCandidateDecisionTextarea,
  handleCandidateDecisionNavigation,
} from "./candidate-decision-navigation";

describe("Candidate decision keyboard navigation", () => {
  it.each([
    ["PageDown", 340],
    ["End", 3_600],
    ["Home", 0],
    ["PageUp", 0],
  ] as const)("handles %s on the single focused main scroller", (key, expectedTop) => {
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 4_000 },
    });
    scroller.scrollTop = key === "PageUp" ? 200 : 0;
    scroller.addEventListener("keydown", (event) => {
      handleCandidateDecisionNavigation(event);
    });

    fireEvent.keyDown(scroller, { key });

    expect(scroller.scrollTop).toBe(expectedTop);
  });

  it("does not steal Home or End from a nested Candidate editor", () => {
    const scroller = document.createElement("div");
    const editor = document.createElement("textarea");
    scroller.append(editor);
    scroller.scrollTop = 120;
    const listener = vi.fn((event: KeyboardEvent) => {
      handleCandidateDecisionNavigation(event);
    });
    scroller.addEventListener("keydown", listener);

    fireEvent.keyDown(editor, { key: "Home" });

    expect(listener).toHaveBeenCalledOnce();
    expect(scroller.scrollTop).toBe(120);
  });

  it("expands a Candidate editor so it does not become a second scroller", () => {
    const editor = document.createElement("textarea");
    Object.defineProperty(editor, "scrollHeight", { configurable: true, value: 10_681 });

    fitCandidateDecisionTextarea(editor);

    expect(editor.style.height).toBe("10681px");
  });
});
