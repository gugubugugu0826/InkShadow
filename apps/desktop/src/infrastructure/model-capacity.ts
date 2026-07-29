import type { NativeModelCapacityResponse, NativeModelDescriptor } from "./runtime";
import type { NativeProviderKind } from "./model-center-store";

const WORKING_SET_HEADROOM_MULTIPLIER = 1.2;

export type LocalModelCapacityAssessment = Readonly<{
  status: "ready" | "warning" | "unknown";
  reason:
    | "memory_headroom_available"
    | "memory_headroom_insufficient"
    | "model_size_unavailable"
    | "physical_memory_unavailable"
    | "capacity_measurement_invalid";
  modelSizeBytes: number | null;
  requiredMemoryBytes: number | null;
  availableMemoryBytes: number | null;
}>;

export function canCheckModelEndpointWhileOffline(
  provider: NativeProviderKind,
  baseUrl: string,
): boolean {
  if (provider !== "ollama") {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
    return (
      host === "localhost" ||
      (host.endsWith(".localhost") && host.length > ".localhost".length) ||
      /^127(?:\.\d{1,3}){3}$/u.test(host) ||
      host === "::1" ||
      host === "::ffff:127.0.0.1"
    );
  } catch {
    return false;
  }
}

export function assessLocalModelCapacity(
  model: NativeModelDescriptor | null,
  capacity: NativeModelCapacityResponse | null,
): LocalModelCapacityAssessment {
  const modelSizeBytes = normalizePositiveSafeInteger(model?.sizeBytes);
  if (modelSizeBytes === null) {
    return assessment("unknown", "model_size_unavailable", null, null, null);
  }
  if (capacity?.physicalMemory.status !== "measured") {
    return assessment("unknown", "physical_memory_unavailable", modelSizeBytes, null, null);
  }

  const availableMemoryBytes = normalizePositiveSafeInteger(capacity.physicalMemory.availableBytes);
  const totalMemoryBytes = normalizePositiveSafeInteger(capacity.physicalMemory.totalBytes);
  const requiredMemoryBytes = Math.ceil(modelSizeBytes * WORKING_SET_HEADROOM_MULTIPLIER);
  if (
    availableMemoryBytes === null ||
    totalMemoryBytes === null ||
    availableMemoryBytes > totalMemoryBytes ||
    !Number.isSafeInteger(requiredMemoryBytes)
  ) {
    return assessment(
      "unknown",
      "capacity_measurement_invalid",
      modelSizeBytes,
      null,
      availableMemoryBytes,
    );
  }

  return availableMemoryBytes >= requiredMemoryBytes
    ? assessment(
        "ready",
        "memory_headroom_available",
        modelSizeBytes,
        requiredMemoryBytes,
        availableMemoryBytes,
      )
    : assessment(
        "warning",
        "memory_headroom_insufficient",
        modelSizeBytes,
        requiredMemoryBytes,
        availableMemoryBytes,
      );
}

function normalizePositiveSafeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function assessment(
  status: LocalModelCapacityAssessment["status"],
  reason: LocalModelCapacityAssessment["reason"],
  modelSizeBytes: number | null,
  requiredMemoryBytes: number | null,
  availableMemoryBytes: number | null,
): LocalModelCapacityAssessment {
  return Object.freeze({
    status,
    reason,
    modelSizeBytes,
    requiredMemoryBytes,
    availableMemoryBytes,
  });
}
