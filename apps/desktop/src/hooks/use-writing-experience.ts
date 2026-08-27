import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WritingExperienceMode,
  WritingExperiencePreference,
} from "../infrastructure/writing-experience-store";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

export const WRITING_EXPERIENCE_CHANGED_EVENT = "inkshadow:writing-experience-changed";

export interface WritingExperienceState {
  readonly preference: WritingExperiencePreference | null;
  readonly loading: boolean;
  readonly switching: boolean;
  readonly error: string | null;
  readonly switchMode: (mode: WritingExperienceMode) => Promise<boolean>;
  readonly authorizeDirectMode: () => Promise<boolean>;
  readonly revokeDirectModeAuthorization: () => Promise<boolean>;
  readonly refresh: () => Promise<void>;
}

export function useWritingExperience(): WritingExperienceState {
  const runtime = useRuntime();
  const [preference, setPreference] = useState<WritingExperiencePreference | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRevision = useRef(0);
  const mountedRef = useRef(false);
  const activeMutationRef = useRef<symbol | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    const isCurrent = (): boolean => operationRevision.current === revision;
    setLoading(true);
    try {
      const next = await runtime.writingExperience.getOrInitialize();
      if (isCurrent()) {
        setPreference(next);
        setError(null);
      }
    } catch (cause: unknown) {
      if (isCurrent()) {
        setPreference(null);
        setError(projectOrdinaryUiError(cause).description);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    const isCurrent = (): boolean => active && operationRevision.current === revision;
    void runtime.writingExperience
      .getOrInitialize()
      .then((next) => {
        if (!isCurrent()) return;
        setPreference(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        setPreference(null);
        setError(projectOrdinaryUiError(cause).description);
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    const handleChanged = (): void => {
      if (active) void refresh();
    };
    window.addEventListener(WRITING_EXPERIENCE_CHANGED_EVENT, handleChanged);
    return () => {
      active = false;
      mountedRef.current = false;
      operationRevision.current += 1;
      window.removeEventListener(WRITING_EXPERIENCE_CHANGED_EVENT, handleChanged);
    };
  }, [refresh, runtime]);

  const mutatePreference = useCallback(
    async (mutation: () => Promise<WritingExperiencePreference>): Promise<boolean> => {
      if (activeMutationRef.current !== null) return false;
      const token = Symbol("writing-experience-mutation");
      activeMutationRef.current = token;
      const revision = operationRevision.current + 1;
      operationRevision.current = revision;
      const isCurrent = (): boolean => mountedRef.current && operationRevision.current === revision;
      if (mountedRef.current) setSwitching(true);
      try {
        const next = await mutation();
        if (isCurrent()) {
          setPreference(next);
          setError(null);
        }
        // The write is authoritative even if its initiating component has
        // already unmounted. Other mounted consumers must re-read the store.
        window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
        return true;
      } catch (cause: unknown) {
        if (isCurrent()) {
          setError(projectOrdinaryUiError(cause).description);
          await refresh();
        }
        return false;
      } finally {
        if (activeMutationRef.current === token) {
          activeMutationRef.current = null;
          if (mountedRef.current) setSwitching(false);
        }
      }
    },
    [refresh],
  );

  const switchMode = useCallback(
    async (mode: WritingExperienceMode): Promise<boolean> => {
      if (preference === null || mode === preference.mode) return false;
      return mutatePreference(() =>
        runtime.writingExperience.switchMode(mode, preference.revision),
      );
    },
    [mutatePreference, preference, runtime],
  );

  const authorizeDirectMode = useCallback(async (): Promise<boolean> => {
    if (preference === null) return false;
    return mutatePreference(() =>
      runtime.writingExperience.authorizeDirectMode(preference.revision),
    );
  }, [mutatePreference, preference, runtime]);

  const revokeDirectModeAuthorization = useCallback(async (): Promise<boolean> => {
    if (preference === null) return false;
    return mutatePreference(() =>
      runtime.writingExperience.revokeDirectModeAuthorization(preference.revision),
    );
  }, [mutatePreference, preference, runtime]);

  return {
    preference,
    loading,
    switching,
    error,
    switchMode,
    authorizeDirectMode,
    revokeDirectModeAuthorization,
    refresh,
  };
}
