import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { BrowserDevelopmentModelCenterStore, TauriModelCenterStore } from "./model-center-store";
import {
  BrowserDevelopmentModelRoutingStore,
  DEVELOPMENT_MODEL_ROUTING_KEY,
  TauriModelRoutingStore,
} from "./model-routing-store";

const NOW = "2026-07-27T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };
const migration = [
  readMigration("0001_core.sql"),
  readMigration("0002_tasks_notifications.sql"),
  readMigration("0004_model_profiles.sql"),
  readMigration("0005_ai_generation_governance.sql"),
  readMigration("0007_model_routing_usage.sql"),
].join("\n");

describe("model routing stores", () => {
  it("snapshots selected models and applies revision CAS in SQLite", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const models = new TauriModelCenterStore(executor, clock);
    await seedProfiles(models);
    const routes = new TauriModelRoutingStore(executor, clock);

    const created = await routes.saveRoute({
      role: "high_quality",
      primaryProviderId: "cloud-writer",
      fallbackProviderId: "ollama-local",
      expectedRevision: null,
    });

    expect(created).toMatchObject({
      role: "high_quality",
      primaryModelId: "writer-large",
      fallbackModelId: "qwen-local",
      revision: 1,
    });
    await expect(
      routes.saveRoute({
        role: "high_quality",
        primaryProviderId: "ollama-local",
        fallbackProviderId: null,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "MODEL_ROUTING_REVISION_CONFLICT" });
    await executor.close();
  });

  it("persists only bounded route metadata in browser development storage", async () => {
    const models = new BrowserDevelopmentModelCenterStore(window.localStorage, clock);
    await seedProfiles(models);
    const routes = new BrowserDevelopmentModelRoutingStore(window.localStorage, clock, models);

    await routes.saveRoute({
      role: "translation",
      primaryProviderId: "cloud-writer",
      fallbackProviderId: "ollama-local",
      expectedRevision: null,
    });
    await expect(routes.findRoute("translation")).resolves.toMatchObject({
      primaryModelId: "writer-large",
      fallbackModelId: "qwen-local",
    });

    const serialized = window.localStorage.getItem(DEVELOPMENT_MODEL_ROUTING_KEY) ?? "";
    expect(serialized).not.toMatch(/content|prompt|messages|api[_-]?key|secret|credential/iu);
  });

  it("rejects profiles that have no selected model", async () => {
    const models = new BrowserDevelopmentModelCenterStore(window.localStorage, clock);
    await models.save({
      providerId: "empty-profile",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: null,
      expectedRevision: null,
    });
    const routes = new BrowserDevelopmentModelRoutingStore(window.localStorage, clock, models);

    await expect(
      routes.saveRoute({
        role: "fast",
        primaryProviderId: "empty-profile",
        fallbackProviderId: null,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_ROUTING_PROFILE_NOT_READY" });
  });
});

async function seedProfiles(
  models: TauriModelCenterStore | BrowserDevelopmentModelCenterStore,
): Promise<void> {
  await models.save({
    providerId: "cloud-writer",
    provider: "open_ai_compatible",
    baseUrl: "https://models.example/v1",
    authentication: "none",
    selectedModel: "writer-large",
    pricing: {
      contextWindowTokens: 64_000,
      currency: "USD",
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 2_000_000,
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: "test-v1",
      priceUpdatedAt: NOW,
    },
    expectedRevision: null,
  });
  await models.save({
    providerId: "ollama-local",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    authentication: "none",
    selectedModel: "qwen-local",
    pricing: {
      contextWindowTokens: 32_000,
      currency: "USD",
      inputMicrosPerMillionTokens: 0,
      outputMicrosPerMillionTokens: 0,
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: "local-zero",
      priceUpdatedAt: NOW,
    },
    expectedRevision: null,
  });
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
