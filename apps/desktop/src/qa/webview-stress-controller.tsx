import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useRuntime } from "../runtime-context";

const STRESS_CHARACTER_COUNT = 5_000_000;
const COMPOSITION_HOLD_MS = 65_000;
const EDITOR_LOAD_TIMEOUT_MS = 60_000;
const FINAL_SAVE_TIMEOUT_MS = 30_000;
const REPORT_PREFIX = "INKSHADOW_QA_WEBVIEW_STRESS";

interface ChromiumPerformanceMemory {
  readonly jsHeapSizeLimit: number;
  readonly totalJSHeapSize: number;
  readonly usedJSHeapSize: number;
}

interface ReactTrackedTextarea extends HTMLTextAreaElement {
  readonly _valueTracker?: {
    setValue(value: string): void;
  };
}

interface StressEvidence {
  readonly schemaVersion: 1;
  readonly result: "pass";
  readonly runtimeMode: "tauri";
  readonly stressCharacterCount: number;
  readonly compositionHoldMs: number;
  readonly partialCompositionPersisted: false;
  readonly partialRecoveryDraftPersisted: false;
  readonly finalStableRevisionAdvanced: true;
  readonly finalRecoveryDraftCleared: true;
  readonly finalSuffix: "中文";
  readonly editorLoadMs: number;
  readonly firstCompositionInputDispatchMs: number;
  readonly secondCompositionInputDispatchMs: number;
  readonly totalDurationMs: number;
  readonly memoryBefore: ChromiumPerformanceMemory | null;
  readonly memoryAfter: ChromiumPerformanceMemory | null;
  readonly userAgent: string;
  readonly recordedAt: string;
}

/**
 * Opt-in native WebView evidence runner.
 *
 * This module is dynamically imported only in Vite development mode when
 * VITE_INKSHADOW_QA_WEBVIEW_STRESS=1. It creates an isolated five-million
 * character project, holds a real DOM composition open across many autosave
 * windows, verifies that neither stable content nor a recovery draft crosses
 * the native SQLite boundary, then verifies one stable save after
 * compositionend. The evidence is written into the isolated QA database and
 * the native log before the window closes.
 */
export function WebViewStressController() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || runtime.mode !== "tauri") {
      return;
    }
    started.current = true;
    const abort = new AbortController();
    void runEvidence(runtime, navigate, abort.signal).catch(async (failure: unknown) => {
      const message = visibleFailure(failure);
      await logError(`${REPORT_PREFIX} FAIL ${message}`).catch(() => undefined);
      await closeQaWindow();
    });
    return () => abort.abort();
  }, [navigate, runtime]);

  return null;
}

async function runEvidence(
  runtime: ReturnType<typeof useRuntime>,
  navigate: ReturnType<typeof useNavigate>,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = performance.now();
  const initialContent = "A".repeat(STRESS_CHARACTER_COUNT);
  const memoryBefore = readPerformanceMemory();
  const projectResult = await runtime.useCases.createProject.execute({
    name: `WebView stress ${new Date().toISOString()}`,
  });
  if (!projectResult.ok) {
    throw projectResult.error;
  }
  const chapterResult = await runtime.useCases.createChapter.execute({
    projectId: projectResult.value.id,
    title: "Five million character composition",
    content: initialContent,
  });
  if (!chapterResult.ok) {
    throw chapterResult.error;
  }
  const chapterId = chapterResult.value.chapter.id;
  void navigate(`/projects/${projectResult.value.id}/chapters/${chapterId}`, { replace: true });

  const editorLoadStartedAt = performance.now();
  const textarea = await waitForEditor(initialContent.length, signal);
  const editorLoadMs = performance.now() - editorLoadStartedAt;
  const baseline = await readChapter(runtime, chapterId);
  const baselineDraft = await readRecoveryDraft(runtime, chapterId);
  if (baseline.content !== initialContent || baselineDraft !== null) {
    throw new Error("QA_BASELINE_NOT_STABLE");
  }

  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  const firstValue = `${initialContent}中`;
  const firstDispatchStartedAt = performance.now();
  setNativeTextareaValue(textarea, firstValue);
  textarea.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      data: "中",
      inputType: "insertCompositionText",
      isComposing: true,
    }),
  );
  const firstCompositionInputDispatchMs = performance.now() - firstDispatchStartedAt;
  await wait(3_000, signal);
  await requireCompositionNotPersisted(runtime, chapterId, baseline.revision, initialContent);

  const secondValue = `${initialContent}中文`;
  const secondDispatchStartedAt = performance.now();
  setNativeTextareaValue(textarea, secondValue);
  textarea.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      data: "文",
      inputType: "insertCompositionText",
      isComposing: true,
    }),
  );
  const secondCompositionInputDispatchMs = performance.now() - secondDispatchStartedAt;
  await wait(COMPOSITION_HOLD_MS, signal);
  await requireCompositionNotPersisted(runtime, chapterId, baseline.revision, initialContent);

  textarea.dispatchEvent(
    new CompositionEvent("compositionend", {
      bubbles: true,
      composed: true,
      data: "中文",
    }),
  );
  const stable = await waitForStableChapter(
    runtime,
    chapterId,
    baseline.revision,
    secondValue,
    signal,
  );
  const finalDraft = await readRecoveryDraft(runtime, chapterId);
  if (finalDraft !== null) {
    throw new Error("QA_FINAL_RECOVERY_DRAFT_RETAINED");
  }

  const evidence: StressEvidence = Object.freeze({
    schemaVersion: 1,
    result: "pass",
    runtimeMode: "tauri",
    stressCharacterCount: STRESS_CHARACTER_COUNT,
    compositionHoldMs: COMPOSITION_HOLD_MS,
    partialCompositionPersisted: false,
    partialRecoveryDraftPersisted: false,
    finalStableRevisionAdvanced: true,
    finalRecoveryDraftCleared: true,
    finalSuffix: "中文",
    editorLoadMs: rounded(editorLoadMs),
    firstCompositionInputDispatchMs: rounded(firstCompositionInputDispatchMs),
    secondCompositionInputDispatchMs: rounded(secondCompositionInputDispatchMs),
    totalDurationMs: rounded(performance.now() - startedAt),
    memoryBefore,
    memoryAfter: readPerformanceMemory(),
    userAgent: navigator.userAgent,
    recordedAt: new Date().toISOString(),
  });
  const reportResult = await runtime.useCases.createChapter.execute({
    projectId: projectResult.value.id,
    title: "__QA_WEBVIEW_STRESS_PASS__",
    content: JSON.stringify({
      ...evidence,
      finalRevision: stable.revision,
      finalContentLength: stable.content.length,
    }),
  });
  if (!reportResult.ok) {
    throw reportResult.error;
  }
  await logInfo(`${REPORT_PREFIX} PASS ${JSON.stringify(evidence)}`);
  await wait(500, signal);
  await closeQaWindow();
}

async function requireCompositionNotPersisted(
  runtime: ReturnType<typeof useRuntime>,
  chapterId: Parameters<ReturnType<typeof useRuntime>["repositories"]["chapters"]["findById"]>[0],
  baselineRevision: number,
  baselineContent: string,
): Promise<void> {
  const current = await readChapter(runtime, chapterId);
  const draft = await readRecoveryDraft(runtime, chapterId);
  if (
    current.revision !== baselineRevision ||
    current.content !== baselineContent ||
    draft !== null
  ) {
    throw new Error("QA_PARTIAL_COMPOSITION_PERSISTED");
  }
}

async function readChapter(
  runtime: ReturnType<typeof useRuntime>,
  chapterId: Parameters<ReturnType<typeof useRuntime>["repositories"]["chapters"]["findById"]>[0],
) {
  const result = await runtime.repositories.chapters.findById(chapterId);
  if (!result.ok) {
    throw result.error;
  }
  if (result.value === null) {
    throw new Error("QA_CHAPTER_MISSING");
  }
  return result.value.toSnapshot();
}

async function readRecoveryDraft(
  runtime: ReturnType<typeof useRuntime>,
  chapterId: Parameters<
    ReturnType<typeof useRuntime>["repositories"]["recoveryDrafts"]["findByChapterId"]
  >[0],
) {
  const result = await runtime.repositories.recoveryDrafts.findByChapterId(chapterId);
  if (!result.ok) {
    throw result.error;
  }
  return result.value?.toSnapshot() ?? null;
}

async function waitForStableChapter(
  runtime: ReturnType<typeof useRuntime>,
  chapterId: Parameters<ReturnType<typeof useRuntime>["repositories"]["chapters"]["findById"]>[0],
  baselineRevision: number,
  expectedContent: string,
  signal: AbortSignal,
) {
  const deadline = performance.now() + FINAL_SAVE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    throwIfAborted(signal);
    const chapter = await readChapter(runtime, chapterId);
    if (chapter.revision > baselineRevision && chapter.content === expectedContent) {
      return chapter;
    }
    await wait(200, signal);
  }
  throw new Error("QA_FINAL_AUTOSAVE_TIMEOUT");
}

async function waitForEditor(
  expectedLength: number,
  signal: AbortSignal,
): Promise<HTMLTextAreaElement> {
  const deadline = performance.now() + EDITOR_LOAD_TIMEOUT_MS;
  while (performance.now() < deadline) {
    throwIfAborted(signal);
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="章节正文"]');
    if (textarea !== null && textarea.value.length === expectedLength && !textarea.disabled) {
      return textarea;
    }
    await wait(100, signal);
  }
  throw new Error("QA_EDITOR_LOAD_TIMEOUT");
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const tracked = textarea as ReactTrackedTextarea;
  const previous = textarea.value;
  textarea.value = value;
  tracked._valueTracker?.setValue(previous);
}

function readPerformanceMemory(): ChromiumPerformanceMemory | null {
  const memory = (performance as Performance & { readonly memory?: ChromiumPerformanceMemory })
    .memory;
  return memory === undefined
    ? null
    : Object.freeze({
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
        totalJSHeapSize: memory.totalJSHeapSize,
        usedJSHeapSize: memory.usedJSHeapSize,
      });
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("WebView stress evidence was cancelled.", "AbortError"));
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("WebView stress evidence was cancelled.", "AbortError");
  }
}

function visibleFailure(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "code" in failure &&
    typeof failure.code === "string"
  ) {
    return failure.code;
  }
  if (failure instanceof Error) {
    return failure.message.slice(0, 160);
  }
  return "QA_UNKNOWN_FAILURE";
}

async function closeQaWindow(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  await getCurrentWindow()
    .close()
    .catch(() => undefined);
}
