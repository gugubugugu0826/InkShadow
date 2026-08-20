import { useCallback, useEffect, useState } from "react";

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

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await runtime.writingExperience.getOrInitialize();
      setPreference(next);
      setError(null);
    } catch (cause: unknown) {
      setPreference(null);
      setError(projectOrdinaryUiError(cause).description);
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    let active = true;
    void runtime.writingExperience
      .getOrInitialize()
      .then((next) => {
        if (!active) return;
        setPreference(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setPreference(null);
        setError(projectOrdinaryUiError(cause).description);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const handleChanged = (): void => {
      if (active) void refresh();
    };
    window.addEventListener(WRITING_EXPERIENCE_CHANGED_EVENT, handleChanged);
    return () => {
      active = false;
      window.removeEventListener(WRITING_EXPERIENCE_CHANGED_EVENT, handleChanged);
    };
  }, [refresh, runtime]);

  const switchMode = useCallback(
    async (mode: WritingExperienceMode): Promise<boolean> => {
      if (preference === null || switching || mode === preference.mode) return false;
      setSwitching(true);
      try {
        const next = await runtime.writingExperience.switchMode(mode, preference.revision);
        setPreference(next);
        setError(null);
        window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
        return true;
      } catch (cause: unknown) {
        setError(projectOrdinaryUiError(cause).description);
        await refresh();
        return false;
      } finally {
        setSwitching(false);
      }
    },
    [preference, refresh, runtime, switching],
  );

  const authorizeDirectMode = useCallback(async (): Promise<boolean> => {
    if (preference === null || switching) return false;
    setSwitching(true);
    try {
      const next = await runtime.writingExperience.authorizeDirectMode(preference.revision);
      setPreference(next);
      setError(null);
      window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
      return true;
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
      await refresh();
      return false;
    } finally {
      setSwitching(false);
    }
  }, [preference, refresh, runtime, switching]);

  const revokeDirectModeAuthorization = useCallback(async (): Promise<boolean> => {
    if (preference === null || switching) return false;
    setSwitching(true);
    try {
      const next = await runtime.writingExperience.revokeDirectModeAuthorization(
        preference.revision,
      );
      setPreference(next);
      setError(null);
      window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
      return true;
    } catch (cause: unknown) {
      setError(projectOrdinaryUiError(cause).description);
      await refresh();
      return false;
    } finally {
      setSwitching(false);
    }
  }, [preference, refresh, runtime, switching]);

  return Object.freeze({
    preference,
    loading,
    switching,
    error,
    switchMode,
    authorizeDirectMode,
    revokeDirectModeAuthorization,
    refresh,
  });
}
