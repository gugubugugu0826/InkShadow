// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import type { WritingExperiencePreference } from "../infrastructure/writing-experience-store";
import { RuntimeProvider } from "../runtime-context";
import { useWritingExperience, WRITING_EXPERIENCE_CHANGED_EVENT } from "./use-writing-experience";

describe("useWritingExperience", () => {
  beforeEach(() => window.localStorage.clear());

  it("does not let an older refresh overwrite the latest preference", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const initial = await runtime.writingExperience.getOrInitialize();
    const older = { ...initial, mode: "professional" as const, revision: initial.revision + 1 };
    const latest = { ...initial, mode: "direct" as const, revision: initial.revision + 2 };
    const firstRefresh = deferred<typeof older>();
    const secondRefresh = deferred<typeof latest>();
    vi.spyOn(runtime.writingExperience, "getOrInitialize")
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
    );
    const { result } = renderHook(() => useWritingExperience(), { wrapper });
    await waitFor(() => expect(result.current.preference).toEqual(initial));

    act(() => {
      window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
    });
    act(() => {
      window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
    });
    await act(async () => {
      secondRefresh.resolve(latest);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.preference).toEqual(latest));

    await act(async () => {
      firstRefresh.resolve(older);
      await Promise.resolve();
    });
    expect(result.current.preference).toEqual(latest);
  });

  it.each(["switchMode", "authorizeDirectMode", "revokeDirectModeAuthorization"] as const)(
    "does not let a delayed refresh overwrite %s",
    async (operation) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const initial = await runtime.writingExperience.getOrInitialize();
      const next: WritingExperiencePreference = Object.freeze({
        ...initial,
        mode: operation === "authorizeDirectMode" ? "direct" : "professional",
        directLocalOrganizationAuthorizedAt:
          operation === "revokeDirectModeAuthorization"
            ? null
            : (initial.directLocalOrganizationAuthorizedAt ?? initial.updatedAt),
        initializationSource: "user",
        revision: initial.revision + 1,
      });
      const delayedRefresh = deferred<WritingExperiencePreference>();
      const pendingMutation = deferred<WritingExperiencePreference>();
      const readPreference = vi
        .spyOn(runtime.writingExperience, "getOrInitialize")
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(delayedRefresh.promise)
        .mockResolvedValue(next);
      if (operation === "switchMode") {
        vi.spyOn(runtime.writingExperience, "switchMode").mockReturnValueOnce(
          pendingMutation.promise,
        );
      } else if (operation === "authorizeDirectMode") {
        vi.spyOn(runtime.writingExperience, "authorizeDirectMode").mockReturnValueOnce(
          pendingMutation.promise,
        );
      } else {
        vi.spyOn(runtime.writingExperience, "revokeDirectModeAuthorization").mockReturnValueOnce(
          pendingMutation.promise,
        );
      }
      const wrapper = ({ children }: { readonly children: ReactNode }) => (
        <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
      );
      const { result } = renderHook(() => useWritingExperience(), { wrapper });
      await waitFor(() => expect(result.current.preference).toEqual(initial));

      act(() => {
        window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
      });
      await waitFor(() => expect(readPreference).toHaveBeenCalledTimes(2));
      let operationResult!: Promise<boolean>;
      act(() => {
        operationResult =
          operation === "switchMode"
            ? result.current.switchMode("professional")
            : operation === "authorizeDirectMode"
              ? result.current.authorizeDirectMode()
              : result.current.revokeDirectModeAuthorization();
      });
      await waitFor(() => expect(result.current.switching).toBe(true));

      await act(async () => {
        pendingMutation.resolve(next);
        await expect(operationResult).resolves.toBe(true);
      });
      await waitFor(() => {
        expect(result.current.preference).toEqual(next);
        expect(result.current.switching).toBe(false);
      });

      await act(async () => {
        delayedRefresh.resolve(initial);
        await Promise.resolve();
      });
      expect(result.current.preference).toEqual(next);
    },
  );

  it.each(["switchMode", "authorizeDirectMode", "revokeDirectModeAuthorization"] as const)(
    "does not refresh state after an unmounted %s failure",
    async (operation) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const initial = await runtime.writingExperience.getOrInitialize();
      const pendingMutation = deferred<WritingExperiencePreference>();
      const readPreference = vi
        .spyOn(runtime.writingExperience, "getOrInitialize")
        .mockResolvedValue(initial);
      if (operation === "switchMode") {
        vi.spyOn(runtime.writingExperience, "switchMode").mockReturnValueOnce(
          pendingMutation.promise,
        );
      } else if (operation === "authorizeDirectMode") {
        vi.spyOn(runtime.writingExperience, "authorizeDirectMode").mockReturnValueOnce(
          pendingMutation.promise,
        );
      } else {
        vi.spyOn(runtime.writingExperience, "revokeDirectModeAuthorization").mockReturnValueOnce(
          pendingMutation.promise,
        );
      }
      const wrapper = ({ children }: { readonly children: ReactNode }) => (
        <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
      );
      const { result, unmount } = renderHook(() => useWritingExperience(), { wrapper });
      await waitFor(() => expect(result.current.preference).toEqual(initial));
      const operationResult =
        operation === "switchMode"
          ? result.current.switchMode("professional")
          : operation === "authorizeDirectMode"
            ? result.current.authorizeDirectMode()
            : result.current.revokeDirectModeAuthorization();

      unmount();
      await act(async () => {
        pendingMutation.reject(new Error("late mutation failure"));
        await expect(operationResult).resolves.toBe(false);
      });
      expect(readPreference).toHaveBeenCalledTimes(1);
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
