/* eslint-disable react-refresh/only-export-components -- the startup helpers and provider share one persisted appearance contract. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const APPEARANCE_PREFERENCE_STORAGE_KEY = "inkshadow.appearance.preference.v1";
export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];
export type ResolvedAppearanceSurface = Exclude<AppearancePreference, "system">;

interface AppearancePreferenceContextValue {
  readonly preference: AppearancePreference;
  readonly resolvedSurface: ResolvedAppearanceSurface;
  readonly setPreference: (preference: AppearancePreference) => void;
}

const AppearancePreferenceContext = createContext<AppearancePreferenceContextValue | null>(null);

export function readAppearancePreference(storage: Pick<Storage, "getItem">): AppearancePreference {
  try {
    const stored = storage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY);
    return isAppearancePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyAppearancePreference(
  preference: AppearancePreference,
  targetDocument: Pick<Document, "documentElement"> = document,
): void {
  const root = targetDocument.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-surface");
    return;
  }
  root.setAttribute("data-surface", preference);
}

export function initializeAppearancePreference(
  targetDocument: Pick<Document, "documentElement"> = document,
  storage: Pick<Storage, "getItem"> = window.localStorage,
): AppearancePreference {
  const preference = readAppearancePreference(storage);
  applyAppearancePreference(preference, targetDocument);
  return preference;
}

export function AppearancePreferenceProvider({ children }: { readonly children: ReactNode }) {
  const [mediaQuery] = useState<MediaQueryList | null>(() => systemColorSchemeQuery());
  const [preference, setPreferenceState] = useState<AppearancePreference>(() =>
    readAppearancePreference(window.localStorage),
  );
  const [systemSurface, setSystemSurface] = useState<ResolvedAppearanceSurface>(() =>
    resolveSystemSurface(mediaQuery),
  );

  useLayoutEffect(() => {
    applyAppearancePreference(preference);
    persistAppearancePreference(preference);
  }, [preference]);

  useEffect(() => {
    if (mediaQuery === null) {
      return;
    }
    const handleSystemChange = (event: MediaQueryListEvent) => {
      setSystemSurface(event.matches ? "dark" : "light");
      if (preference === "system") {
        applyAppearancePreference("system");
      }
    };
    mediaQuery.addEventListener("change", handleSystemChange);
    return () => {
      mediaQuery.removeEventListener("change", handleSystemChange);
    };
  }, [mediaQuery, preference]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage ||
        event.key !== APPEARANCE_PREFERENCE_STORAGE_KEY
      ) {
        return;
      }
      setPreferenceState(isAppearancePreference(event.newValue) ? event.newValue : "system");
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setPreference = useCallback((nextPreference: AppearancePreference) => {
    applyAppearancePreference(nextPreference);
    persistAppearancePreference(nextPreference);
    setPreferenceState(nextPreference);
  }, []);
  const value = useMemo<AppearancePreferenceContextValue>(
    () => ({
      preference,
      resolvedSurface: preference === "system" ? systemSurface : preference,
      setPreference,
    }),
    [preference, setPreference, systemSurface],
  );

  return (
    <AppearancePreferenceContext.Provider value={value}>
      {children}
    </AppearancePreferenceContext.Provider>
  );
}

export function useAppearancePreference(): AppearancePreferenceContextValue {
  const value = useContext(AppearancePreferenceContext);
  if (value === null) {
    throw new Error("useAppearancePreference must be used inside AppearancePreferenceProvider.");
  }
  return value;
}

function isAppearancePreference(value: unknown): value is AppearancePreference {
  return typeof value === "string" && (APPEARANCE_PREFERENCES as readonly string[]).includes(value);
}

function persistAppearancePreference(preference: AppearancePreference): void {
  try {
    window.localStorage.setItem(APPEARANCE_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // A blocked storage backend must not prevent the application from opening.
  }
}

function systemColorSchemeQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

function resolveSystemSurface(mediaQuery: MediaQueryList | null): ResolvedAppearanceSurface {
  return mediaQuery?.matches === true ? "dark" : "light";
}
