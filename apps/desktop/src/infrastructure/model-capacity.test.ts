import { describe, expect, it } from "vitest";

import type { NativeModelCapacityResponse } from "./runtime";
import { assessLocalModelCapacity, canCheckModelEndpointWhileOffline } from "./model-capacity";

const GIB = 1024 ** 3;

describe("assessLocalModelCapacity", () => {
  it("reports preliminary readiness only when measured free memory includes headroom", () => {
    expect(
      assessLocalModelCapacity(
        { id: "qwen", displayName: "Qwen", sizeBytes: 4 * GIB },
        capacity(8 * GIB, 16 * GIB),
      ),
    ).toMatchObject({
      status: "ready",
      reason: "memory_headroom_available",
      requiredMemoryBytes: Math.ceil(4 * GIB * 1.2),
    });
  });

  it("warns when the installed model file exceeds the conservative memory budget", () => {
    expect(
      assessLocalModelCapacity(
        { id: "large", displayName: "Large", sizeBytes: 8 * GIB },
        capacity(6 * GIB, 16 * GIB),
      ),
    ).toMatchObject({
      status: "warning",
      reason: "memory_headroom_insufficient",
      availableMemoryBytes: 6 * GIB,
    });
  });

  it("does not invent a verdict without model size or trustworthy memory measurements", () => {
    expect(
      assessLocalModelCapacity(
        { id: "unknown", displayName: "Unknown" },
        capacity(8 * GIB, 16 * GIB),
      ),
    ).toMatchObject({ status: "unknown", reason: "model_size_unavailable" });

    expect(
      assessLocalModelCapacity(
        { id: "known", displayName: "Known", sizeBytes: 4 * GIB },
        {
          ...capacity(8 * GIB, 16 * GIB),
          physicalMemory: {
            status: "unavailable",
            totalBytes: null,
            availableBytes: null,
            reason: "query_failed",
          },
        },
      ),
    ).toMatchObject({ status: "unknown", reason: "physical_memory_unavailable" });
  });
});

describe("canCheckModelEndpointWhileOffline", () => {
  it("permits only explicit loopback Ollama endpoints", () => {
    for (const endpoint of [
      "http://127.0.0.1:11434",
      "http://127.12.3.4:11434",
      "http://localhost:11434",
      "https://ollama.localhost",
      "http://[::1]:11434",
    ]) {
      expect(canCheckModelEndpointWhileOffline("ollama", endpoint), endpoint).toBe(true);
    }
    expect(canCheckModelEndpointWhileOffline("ollama", "https://ollama.example")).toBe(false);
    expect(canCheckModelEndpointWhileOffline("open_ai_compatible", "http://127.0.0.1:11434")).toBe(
      false,
    );
    expect(canCheckModelEndpointWhileOffline("ollama", "not a URL")).toBe(false);
  });
});

function capacity(
  availableMemoryBytes: number,
  totalMemoryBytes: number,
): NativeModelCapacityResponse {
  return {
    logicalCpuCount: 8,
    physicalMemory: {
      status: "measured",
      totalBytes: totalMemoryBytes,
      availableBytes: availableMemoryBytes,
      reason: null,
    },
    applicationDataDisk: {
      status: "measured",
      totalBytes: 512 * GIB,
      availableBytes: 200 * GIB,
      reason: null,
    },
    gpuMemory: {
      status: "unavailable",
      totalBytes: null,
      availableBytes: null,
      reason: "gpu_capacity_not_measured",
    },
  };
}
