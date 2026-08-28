import { describe, expect, it } from "vitest";

import { describeModelHubCatalogEntrySource } from "./model-hub-catalog-presentation";
import type { ModelCatalogEntry } from "./model-hub-store";

describe("Model Hub catalog source presentation", () => {
  it.each([
    ["manual", false, "手动添加"],
    ["official_preset", false, "内置预设"],
    ["provider_api", false, "从服务商读取"],
    ["legacy", false, "旧版本本机记录"],
    ["provider_api", true, "本机保留的服务商目录"],
  ] as const)(
    "shows persisted %s source without inferring from model count",
    (source, cached, label) => {
      const description = describeModelHubCatalogEntrySource(entry(source), { cached });

      expect(description).toContain(label);
      expect(description).toContain("2026年8月28日");
    },
  );

  it("never describes a manual row as provider discovery, including cached-warning state", () => {
    const description = describeModelHubCatalogEntrySource(entry("manual"), { cached: true });

    expect(description).toContain("手动添加");
    expect(description).not.toContain("从服务商读取");
    expect(description).not.toContain("服务商目录");
  });
});

function entry(catalogSource: ModelCatalogEntry["catalogSource"]): ModelCatalogEntry {
  return Object.freeze({
    id: `catalog-${catalogSource}`,
    connectionId: "connection-1",
    providerModelId: "model-1",
    displayName: "model-1",
    ownedBy: null,
    catalogSource,
    availability: "available",
    lifecycle: "stable",
    inputTokenLimit: null,
    outputTokenLimit: null,
    firstDiscoveredAt: "2026-08-28T01:02:03.000Z",
    lastSeenAt: "2026-08-28T01:02:03.000Z",
    staleAfter: null,
    lastSyncId: "sync-1",
    revision: 1,
  });
}
