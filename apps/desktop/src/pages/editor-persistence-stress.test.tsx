import { AppError, err } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { desktopPersistenceLifecycle } from "../infrastructure/persistence-lifecycle";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

const FIVE_MILLION = 5_000_000;
const MEBIBYTE = 1024 * 1024;

describe("editor persistence stress gates", () => {
  it("retains the last recovery draft and rejects route teardown after disk-full failure", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "stable-before-fault");
    const knownSafeDraft = await runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: "known-safe-recovery",
      cursorOffset: 19,
    });
    if (!knownSafeDraft.ok) {
      throw knownSafeDraft.error;
    }
    renderEditor(runtime, project.id, chapter.id);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "恢复草稿继续编辑",
      }),
    );
    expect(editor).toHaveValue("known-safe-recovery");

    const diskFull = new AppError({
      code: "SAVE_FAILED",
      message: "The local disk is full and the write was not committed.",
      details: { databaseCode: "SQLITE_DISK_FULL" },
      actions: ["EXPORT_DRAFT"],
    });
    vi.spyOn(runtime.useCases.editChapter, "execute").mockResolvedValueOnce(err(diskFull));
    fireEvent.change(editor, {
      target: { value: "newer-in-memory-text", selectionStart: 20 },
    });

    const outcome = await desktopPersistenceLifecycle.flush("route-change", 1_000);
    expect(outcome).toEqual({
      status: "failed",
      failures: [{ handlerId: `editor:${chapter.id}`, cause: diskFull }],
    });
    expect(editor).toHaveValue("newer-in-memory-text");
    const retainedDraft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    expect(retainedDraft.ok && retainedDraft.value?.content).toBe("known-safe-recovery");
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe("stable-before-fault");
  });

  it("never persists partial IME text across a simulated thirty-minute composition", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "stable-ime-baseline");
    renderEditor(runtime, project.id, chapter.id);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });

    vi.useFakeTimers();
    try {
      fireEvent.compositionStart(editor);
      fireEvent.change(editor, {
        target: { value: "仍在组合中的半成", selectionStart: 9 },
      });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);

      const draftDuringComposition = await runtime.repositories.recoveryDrafts.findByChapterId(
        chapter.id,
      );
      expect(draftDuringComposition.ok && draftDuringComposition.value).toBeNull();
      await expect(desktopPersistenceLifecycle.flush("window-close", 1_000)).resolves.toMatchObject(
        {
          status: "blocked",
        },
      );

      fireEvent.change(editor, {
        target: { value: "组合完成后的完整中文", selectionStart: 10 },
      });
      fireEvent.compositionEnd(editor, { data: "中文" });
      await expect(desktopPersistenceLifecycle.flush("window-close", 1_000)).resolves.toMatchObject(
        {
          status: "success",
        },
      );
      const completedDraft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
      expect(completedDraft.ok && completedDraft.value).toBeNull();
      const stable = await runtime.repositories.chapters.findById(chapter.id);
      expect(stable.ok && stable.value?.content).toBe("组合完成后的完整中文");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders, edits, and stably flushes exactly 5,000,000 Chinese characters within bounded resources", async () => {
    const initialHeap = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const content = "墨".repeat(FIVE_MILLION);
    // jsdom intentionally enforces a ~5 MiB localStorage quota. Production
    // uses SQLite, so this component benchmark supplies an unbounded
    // in-memory Storage implementation instead of weakening that browser
    // safety limit or adding a plaintext fallback.
    const runtime = createDevelopmentRuntime(new UnlimitedMemoryStorage());
    const { chapter, project } = await seedChapter(runtime, content);
    renderEditor(runtime, project.id, chapter.id);
    const editor = await screen.findByRole<HTMLTextAreaElement>(
      "textbox",
      { name: "章节正文" },
      { timeout: 15_000 },
    );
    const renderedAt = performance.now();

    expect(editor.value).toHaveLength(FIVE_MILLION);
    editor.setSelectionRange(FIVE_MILLION - 1, FIVE_MILLION);
    const editedContent = `${content.slice(0, -1)}影`;
    const editStartedAt = performance.now();
    fireEvent.change(editor, {
      target: {
        value: editedContent,
        selectionStart: FIVE_MILLION,
        selectionEnd: FIVE_MILLION,
      },
    });
    const editElapsedMs = performance.now() - editStartedAt;

    await expect(desktopPersistenceLifecycle.flush("route-change", 30_000)).resolves.toMatchObject({
      status: "success",
    });
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    const draft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    const completedAt = performance.now();
    const heapDeltaMiB = (process.memoryUsage().heapUsed - initialHeap) / MEBIBYTE;

    expect(editor.value).toHaveLength(FIVE_MILLION);
    expect(editor.value.endsWith("影")).toBe(true);
    expect(stable.ok && stable.value?.content.length).toBe(FIVE_MILLION);
    expect(stable.ok && stable.value?.content.endsWith("影")).toBe(true);
    expect(draft.ok && draft.value).toBeNull();
    expect(renderedAt - startedAt).toBeLessThan(15_000);
    expect(editElapsedMs).toBeLessThan(5_000);
    expect(completedAt - startedAt).toBeLessThan(30_000);
    expect(heapDeltaMiB).toBeLessThan(768);
  }, 45_000);
});

function renderEditor(
  runtime: DesktopRuntime,
  projectId: string,
  chapterId: string,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/chapters/${chapterId}`]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function seedChapter(runtime: DesktopRuntime, content: string) {
  const project = await runtime.useCases.createProject.execute({ name: "压力门禁作品" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "压力门禁章节",
    content,
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return { project: project.value, chapter: chapter.value.chapter };
}

class UnlimitedMemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  public get length(): number {
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }

  public getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.entries.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}
