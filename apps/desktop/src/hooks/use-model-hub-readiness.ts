import { useMemo, useSyncExternalStore } from "react";

import {
  getModelHubReadinessStore,
  type ModelHubReadinessSnapshot,
} from "../infrastructure/model-hub-readiness-store";
import type { DesktopRuntime } from "../infrastructure/runtime";

export function useModelHubReadiness(runtime: DesktopRuntime): ModelHubReadinessSnapshot {
  const store = useMemo(() => getModelHubReadinessStore(runtime), [runtime]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
