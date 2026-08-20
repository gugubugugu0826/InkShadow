import {
  createLazyConsistencyInvestigationRuntime,
  type ConsistencyInvestigationRuntimePort,
} from "./consistency-investigation-port";
import type { TauriConsistencyInvestigationFactoryInput } from "./consistency-investigation-tauri-factory";

/** Keeps the optional Agent's dynamic-import ownership outside the root runtime module. */
export function createLazyTauriConsistencyInvestigationRuntime(
  input: TauriConsistencyInvestigationFactoryInput,
): ConsistencyInvestigationRuntimePort {
  return createLazyConsistencyInvestigationRuntime(async () => {
    const { createTauriConsistencyInvestigationService } =
      await import("./consistency-investigation-tauri-factory");
    return createTauriConsistencyInvestigationService(input);
  });
}
