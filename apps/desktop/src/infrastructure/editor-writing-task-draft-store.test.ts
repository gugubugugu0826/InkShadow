import { describe, expect, it } from "vitest";

import {
  clearEditorWritingTaskDraft,
  loadOrCreateEditorWritingSessionId,
  loadEditorWritingTaskDraft,
  saveEditorWritingTaskDraft,
  settleEditorWritingTaskDraft,
  type EditorWritingTaskDraftIdentity,
} from "./editor-writing-task-draft-store";

const BASE_IDENTITY: EditorWritingTaskDraftIdentity = Object.freeze({
  projectId: "project-a",
  chapterId: "chapter-a",
  versionId: "version-a",
  sessionId: "session-a",
  task: "continuation",
  selection: null,
});

describe("editor writing task draft store", () => {
  it("isolates requirements by project, chapter, version and task inside this session", () => {
    const storage = memoryStorage();
    saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "续写到密信被发现为止。");

    expect(loadEditorWritingTaskDraft(storage, BASE_IDENTITY)).toEqual({
      ok: true,
      value: "续写到密信被发现为止。",
    });
    expect(
      loadEditorWritingTaskDraft(storage, { ...BASE_IDENTITY, projectId: "project-b" }),
    ).toEqual({ ok: true, value: "" });
    expect(
      loadEditorWritingTaskDraft(storage, { ...BASE_IDENTITY, chapterId: "chapter-b" }),
    ).toEqual({ ok: true, value: "" });
    expect(
      loadEditorWritingTaskDraft(storage, { ...BASE_IDENTITY, versionId: "version-b" }),
    ).toEqual({ ok: true, value: "" });
    expect(
      loadEditorWritingTaskDraft(storage, { ...BASE_IDENTITY, sessionId: "session-b" }),
    ).toEqual({ ok: true, value: "" });
    expect(
      loadEditorWritingTaskDraft(storage, {
        ...BASE_IDENTITY,
        task: "selection_rewrite",
        selection: { start: 0, end: 4 },
      }),
    ).toEqual({ ok: true, value: "" });
  });

  it("isolates every selection task and exact range without storing selected正文", () => {
    const storage = memoryStorage();
    const rewrite = {
      ...BASE_IDENTITY,
      task: "selection_rewrite" as const,
      selection: { start: 2, end: 8 },
    };
    saveEditorWritingTaskDraft(storage, rewrite, "改成第一人称。");

    expect(loadEditorWritingTaskDraft(storage, rewrite)).toEqual({
      ok: true,
      value: "改成第一人称。",
    });
    expect(loadEditorWritingTaskDraft(storage, { ...rewrite, task: "polish" as const })).toEqual({
      ok: true,
      value: "",
    });
    expect(
      loadEditorWritingTaskDraft(storage, { ...rewrite, selection: { start: 3, end: 8 } }),
    ).toEqual({ ok: true, value: "" });
    expect([...storage.values()].join("\n")).not.toContain("被选中的正文不应写入草稿键");

    clearEditorWritingTaskDraft(storage, rewrite);
    expect(loadEditorWritingTaskDraft(storage, rewrite)).toEqual({ ok: true, value: "" });
  });

  it("rejects corrupt and overlong values instead of leaking them into another task", () => {
    const storage = memoryStorage();
    storage.setItem("inkshadow.editor-writing-task-draft.v1:broken", "{not-json");
    saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "a".repeat(2_001));
    expect(loadEditorWritingTaskDraft(storage, BASE_IDENTITY)).toEqual({ ok: true, value: "" });
  });

  it("reports a corrupt value at the exact draft key without deleting the original bytes", () => {
    const storage = memoryStorage();
    expect(saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "保留这条要求")).toBe(true);
    const draftKey = [...storage.keys()].find((key) =>
      key.startsWith("inkshadow.editor-writing-task-draft.v1:"),
    );
    expect(draftKey).toBeDefined();
    if (draftKey === undefined) {
      throw new Error("Expected the exact writing draft key to be present.");
    }
    storage.setItem(draftKey, "{not-json");

    expect(loadEditorWritingTaskDraft(storage, BASE_IDENTITY)).toEqual({
      ok: false,
      value: "",
      error: "DRAFT_CORRUPT",
      rawPreserved: true,
    });
    expect(saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "不要覆盖损坏原值")).toBe(false);
    expect(storage.getItem(draftKey)).toBe("{not-json");
  });

  it("recovers one stable writing session after restart and rotates it with the正文 version", () => {
    const storage = memoryStorage();
    const scope = { projectId: "project-a", chapterId: "chapter-a", versionId: "version-a" };
    const first = loadOrCreateEditorWritingSessionId(storage, scope, () => "session-a");
    const afterRestart = loadOrCreateEditorWritingSessionId(storage, scope, () => "must-not-run");
    const nextVersion = loadOrCreateEditorWritingSessionId(
      storage,
      { ...scope, versionId: "version-b" },
      () => "session-b",
    );

    expect(first).toBe("session-a");
    expect(afterRestart).toBe("session-a");
    expect(nextVersion).toBe("session-b");
  });

  it("reports storage failures instead of pretending a requirement was saved", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    };
    expect(saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "保留这条要求")).toBe(false);
    expect(
      loadOrCreateEditorWritingSessionId(storage, BASE_IDENTITY, () => "session-a"),
    ).toBeNull();
  });

  it.each(["generation_succeeded", "cancelled_before_dispatch"] as const)(
    "clears only the exact draft after the terminal outcome %s",
    (outcome) => {
      const storage = memoryStorage();
      saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "这一轮已经结算");

      expect(settleEditorWritingTaskDraft(storage, BASE_IDENTITY, outcome)).toBe(true);
      expect(loadEditorWritingTaskDraft(storage, BASE_IDENTITY)).toEqual({ ok: true, value: "" });
    },
  );

  it.each(["in_progress", "failed_final", "recoverable_failure", "result_needs_review"] as const)(
    "preserves a recoverable draft while the task outcome is %s",
    (outcome) => {
      const storage = memoryStorage();
      saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "保留到任务可以安全恢复");

      expect(settleEditorWritingTaskDraft(storage, BASE_IDENTITY, outcome)).toBe(true);
      expect(loadEditorWritingTaskDraft(storage, BASE_IDENTITY)).toEqual({
        ok: true,
        value: "保留到任务可以安全恢复",
      });
    },
  );

  it("never lets a late terminal result clear a newer chapter, version, task or selection draft", () => {
    const storage = memoryStorage();
    const lateIdentities: readonly EditorWritingTaskDraftIdentity[] = [
      BASE_IDENTITY,
      { ...BASE_IDENTITY, chapterId: "chapter-old" },
      { ...BASE_IDENTITY, versionId: "version-old" },
      {
        ...BASE_IDENTITY,
        task: "selection_rewrite",
        selection: { start: 0, end: 4 },
      },
      {
        ...BASE_IDENTITY,
        task: "selection_rewrite",
        selection: { start: 4, end: 8 },
      },
    ];
    const currentIdentity: EditorWritingTaskDraftIdentity = {
      ...BASE_IDENTITY,
      task: "selection_rewrite",
      selection: { start: 8, end: 12 },
    };
    for (const [index, identity] of lateIdentities.entries()) {
      saveEditorWritingTaskDraft(storage, identity, `旧异步要求 ${String(index)}`);
    }
    saveEditorWritingTaskDraft(storage, currentIdentity, "当前选区要求");

    for (const identity of lateIdentities) {
      settleEditorWritingTaskDraft(storage, identity, "generation_succeeded");
    }

    expect(loadEditorWritingTaskDraft(storage, currentIdentity)).toEqual({
      ok: true,
      value: "当前选区要求",
    });
  });

  it("preserves a newer requirement written to the same identity while an older result is late", () => {
    const storage = memoryStorage();
    saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "生成开始时的要求");
    saveEditorWritingTaskDraft(storage, BASE_IDENTITY, "用户随后修改的要求");

    expect(
      settleEditorWritingTaskDraft(
        storage,
        BASE_IDENTITY,
        "generation_succeeded",
        "生成开始时的要求",
      ),
    ).toBe(true);
    expect(loadEditorWritingTaskDraft(storage, BASE_IDENTITY)).toEqual({
      ok: true,
      value: "用户随后修改的要求",
    });
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    keys: () => values.keys(),
    values: () => values.values(),
  };
}
