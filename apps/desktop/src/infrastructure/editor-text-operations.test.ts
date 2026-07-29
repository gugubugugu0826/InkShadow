import { describe, expect, it } from "vitest";

import {
  EDITOR_CONTENT_LIMIT,
  EDITOR_HISTORY_OPERATION_LIMIT,
  EDITOR_REPLACE_ALL_LIMIT,
  createEditorEditFromSelectionTransition,
  createEditorEditFromTransition,
  createEditorRangeEdit,
  createEmptyEditorHistory,
  findLiteral,
  recordEditorEdit,
  redoEditorEdit,
  replaceAllLiteral,
  sanitizePlainTextPaste,
  undoEditorEdit,
} from "./editor-text-operations";

describe("editor text operations", () => {
  it("undoes and redoes compact edits without crossing the chapter-load baseline", () => {
    const baseline = "第一章";
    const changed = "第一章：雾港";
    const edit = createEditorEditFromTransition(
      baseline,
      changed,
      { start: baseline.length, end: baseline.length },
      { start: changed.length, end: changed.length },
    );
    expect(edit).not.toBeNull();
    if (edit === null) {
      return;
    }

    const recorded = recordEditorEdit(createEmptyEditorHistory(), edit);
    const undone = undoEditorEdit(recorded, changed);
    expect(undone?.content).toBe(baseline);
    expect(undone?.selection).toEqual({ start: baseline.length, end: baseline.length });
    expect(undone && undoEditorEdit(undone.history, undone.content)).toBeNull();

    const redone = undone && redoEditorEdit(undone.history, undone.content);
    expect(redone?.content).toBe(changed);
    expect(redone?.selection).toEqual({ start: changed.length, end: changed.length });
  });

  it("invalidates redo after a new edit and keeps history bounded", () => {
    let history = createEmptyEditorHistory();
    let content = "";
    for (let index = 0; index < EDITOR_HISTORY_OPERATION_LIMIT + 15; index += 1) {
      const edit = createEditorRangeEdit(
        content,
        { start: content.length, end: content.length },
        String(index % 10),
      );
      if (edit === null) {
        throw new Error("Test edit unexpectedly exceeded the content limit.");
      }
      history = recordEditorEdit(history, edit.edit);
      content = edit.content;
    }
    expect(history.past).toHaveLength(EDITOR_HISTORY_OPERATION_LIMIT);

    const undone = undoEditorEdit(history, content);
    expect(undone).not.toBeNull();
    if (undone === null) {
      return;
    }
    const replacement = createEditorRangeEdit(
      undone.content,
      { start: undone.content.length, end: undone.content.length },
      "新",
    );
    if (replacement === null) {
      throw new Error("Test edit unexpectedly exceeded the content limit.");
    }
    const diverged = recordEditorEdit(undone.history, replacement.edit);
    expect(diverged.future).toHaveLength(0);
  });

  it("records a one-character edit in a million-character chapter without retaining snapshots", () => {
    const before = "甲".repeat(1_000_000);
    const after = `${before}乙`;
    const edit = createEditorEditFromSelectionTransition(
      before,
      after,
      { start: before.length, end: before.length },
      { start: after.length, end: after.length },
    );
    expect(edit).toMatchObject({
      start: 1_000_000,
      removedText: "",
      insertedText: "乙",
    });
    if (edit === null) {
      return;
    }
    const history = recordEditorEdit(createEmptyEditorHistory(), edit);
    expect(history.payloadUnits).toBe(1);
  });

  it("finds literal metacharacters forward and backward with deterministic wrapping", () => {
    const content = "a.*b / a.*b";
    expect(findLiteral(content, "a.*b", 1, "next")).toEqual({
      start: 7,
      end: 11,
      wrapped: false,
    });
    expect(findLiteral(content, "a.*b", content.length, "next")).toEqual({
      start: 0,
      end: 4,
      wrapped: true,
    });
    expect(findLiteral(content, "a.*b", 1, "previous")).toEqual({
      start: 0,
      end: 4,
      wrapped: false,
    });
    expect(findLiteral(content, "不存在", 0, "next")).toBeNull();
  });

  it("replaces literal matches without regex evaluation and enforces hard bounds", () => {
    expect(replaceAllLiteral("a.*b a.*b", "a.*b", "$&")).toEqual({
      ok: true,
      content: "$& $&",
      replacements: 2,
      selection: { start: 3, end: 5 },
    });
    expect(replaceAllLiteral("正文", "", "替换")).toEqual({
      ok: false,
      reason: "EMPTY_QUERY",
    });
    expect(replaceAllLiteral("甲".repeat(EDITOR_REPLACE_ALL_LIMIT + 1), "甲", "乙")).toEqual({
      ok: false,
      reason: "TOO_MANY_MATCHES",
    });
    expect(replaceAllLiteral("甲", "甲", "乙".repeat(EDITOR_CONTENT_LIMIT + 1))).toEqual({
      ok: false,
      reason: "REPLACEMENT_TOO_LARGE",
    });
  });

  it("normalizes pasted text while preserving tabs and newlines", () => {
    expect(
      sanitizePlainTextPaste(
        "第一行\r\n\t第二行\u0000\u0007\u061C\u200E\u200F\u202E危险\u2066\uFEFF",
      ),
    ).toBe("第一行\n\t第二行危险");
  });
});
