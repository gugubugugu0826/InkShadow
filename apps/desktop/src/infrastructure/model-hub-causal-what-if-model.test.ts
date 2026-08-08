import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModelHubCausalWhatIfModelPort,
  parseCausalWhatIfModelResponse,
} from "./model-hub-causal-what-if-model";
import type { CausalWhatIfModelHubError } from "./model-hub-causal-what-if-model";
import type { ModelHubStore } from "./model-hub-store";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";
import type { CausalWhatIfModelInput } from "./causal-what-if-simulation-service";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const SOURCE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const IMPACT_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OUTSIDE_ID = "019f9f4a-b3c7-7350-9226-000000000004";

describe("ModelHubCausalWhatIfModelPort", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses only the what_if_simulation route and records the provider call in the invocation ledger", async () => {
    const harness = createHarness();
    await seedRoute(harness.runtime.modelHub, true);
    harness.generate.mockResolvedValue({
      text: validResponse(),
      usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 0 },
    });
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.runtime.modelHub, "finishInvocation");

    const result = await harness.adapter.simulate(modelInput());

    expect(result).toEqual({
      alternateDirection: "如果主角没有拿到钥匙，他必须先取得守门人的信任。",
      effects: [
        {
          eventId: IMPACT_ID,
          summary: "密室开启被推迟，并改由守门人揭示入口。",
          confidence: 0.82,
        },
      ],
    });
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "what-if-model",
      maxOutputTokens: 8_000,
      temperature: 0.2,
    });
    expect(harness.generate.mock.calls[0]?.[0].messages[1]?.content).toContain(SOURCE_ID);
    expect(harness.generate.mock.calls[0]?.[0].messages[1]?.content).toContain(IMPACT_ID);
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ task: "what_if_simulation", routeTask: "what_if_simulation" }),
    );
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", inputTokens: 120, outputTokens: 40 }),
    );
  });

  it("fails before dispatch with actionable errors when route or structured capability is missing", async () => {
    const noRoute = createHarness();
    const noRouteStart = vi.spyOn(noRoute.runtime.modelHub, "startInvocation");
    await expect(noRoute.adapter.simulate(modelInput())).rejects.toMatchObject({
      code: "CAUSAL_WHAT_IF_ROUTE_NOT_CONFIGURED",
      sourceCode: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      dispatched: false,
    } satisfies Partial<CausalWhatIfModelHubError>);
    expect(noRoute.generate).not.toHaveBeenCalled();
    expect(noRouteStart).not.toHaveBeenCalled();

    window.localStorage.clear();
    const noStructuredOutput = createHarness();
    await seedRoute(noStructuredOutput.runtime.modelHub, false);
    const noCapabilityStart = vi.spyOn(noStructuredOutput.runtime.modelHub, "startInvocation");
    await expect(noStructuredOutput.adapter.simulate(modelInput())).rejects.toMatchObject({
      code: "CAUSAL_WHAT_IF_CAPABILITY_UNAVAILABLE",
      sourceCode: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      dispatched: false,
    } satisfies Partial<CausalWhatIfModelHubError>);
    expect(noStructuredOutput.generate).not.toHaveBeenCalled();
    expect(noCapabilityStart).not.toHaveBeenCalled();
  });

  it("rejects Markdown-wrapped JSON and keeps the real provider invocation auditable", async () => {
    const harness = createHarness();
    await seedRoute(harness.runtime.modelHub, true);
    harness.generate.mockResolvedValue({
      text: `\`\`\`json\n${validResponse()}\n\`\`\``,
      usage: null,
    });
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.runtime.modelHub, "finishInvocation");

    const simulation = harness.adapter.simulate(modelInput());
    await expect(simulation).rejects.toMatchObject({
      code: "CAUSAL_WHAT_IF_RESPONSE_INVALID",
      dispatched: true,
    } satisfies Partial<CausalWhatIfModelHubError>);
    await expect(simulation).rejects.toThrow("Markdown");

    expect(startInvocation).toHaveBeenCalledOnce();
    expect(finishInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it("rejects effects outside the supplied deterministic event scope and exact-schema violations", () => {
    expect(() =>
      parseCausalWhatIfModelResponse(
        JSON.stringify({
          schemaVersion: 1,
          alternateDirection: "越界试演",
          effects: [{ eventId: OUTSIDE_ID, summary: "无关事件变化", confidence: 0.5 }],
        }),
        new Set([SOURCE_ID, IMPACT_ID]),
      ),
    ).toThrow(
      expect.objectContaining({ code: "CAUSAL_WHAT_IF_RESPONSE_INVALID", dispatched: true }),
    );
    expect(() =>
      parseCausalWhatIfModelResponse(
        JSON.stringify({
          schemaVersion: 1,
          alternateDirection: "看似有效",
          effects: [],
          explanation: "额外字段",
        }),
        new Set([SOURCE_ID]),
      ),
    ).toThrow(expect.objectContaining({ code: "CAUSAL_WHAT_IF_RESPONSE_INVALID" }));
  });
});

function createHarness(): Readonly<{
  runtime: DesktopRuntime;
  adapter: ModelHubCausalWhatIfModelPort;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
}> {
  const development = createDevelopmentRuntime(window.localStorage);
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    generate,
    listModels: () => Promise.reject(new Error("not used")),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    cancelGeneration: () => Promise.resolve(false),
  };
  const runtime: DesktopRuntime = {
    ...development,
    mode: "tauri",
    modelGateway,
    credentials: {
      getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
      save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
      delete: () => Promise.resolve({ configured: false, lastFour: null }),
    },
  };
  return Object.freeze({
    runtime,
    generate,
    adapter: new ModelHubCausalWhatIfModelPort(runtime),
  });
}

async function seedRoute(modelHub: ModelHubStore, includeStructuredOutput: boolean): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: "what-if-connection",
    providerKind: "google_gemini",
    displayName: "What-if connection",
    credentialRef: "keyring:model-hub:what-if",
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: "what-if-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "what-if-catalog",
        providerModelId: "what-if-model",
        lifecycle: "stable",
        inputTokenLimit: 500_000,
        outputTokenLimit: 20_000,
        staleAfter: "2030-01-01T00:00:00.000Z",
      },
    ],
  });
  await modelHub.recordCapabilityScan({
    scanId: "what-if-scan",
    catalogEntryId: "what-if-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "what-if-adapter-test-v1",
    evidence: [
      {
        id: "what-if-text-evidence",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      ...(includeStructuredOutput
        ? [
            {
              id: "what-if-structured-evidence",
              capability: "structured_output" as const,
              verdict: "supported" as const,
              evidenceSource: "lightweight_probe" as const,
            },
          ]
        : []),
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: "what-if-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "what-if-adapter-test-v1",
    expectedRevision: null,
  });
  await modelHub.saveTaskRoute({
    task: "what_if_simulation",
    primaryCatalogEntryId: "what-if-catalog",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

function modelInput(): CausalWhatIfModelInput {
  return Object.freeze({
    projectId: PROJECT_ID,
    hypothesis: "如果主角没有拿到钥匙？",
    sourceEvent: eventContext(SOURCE_ID, "主角拿到钥匙"),
    impactedEvents: Object.freeze([eventContext(IMPACT_ID, "主角打开密室")]),
    relations: Object.freeze([
      {
        id: "relation-source-impact",
        fromEventId: SOURCE_ID,
        toEventId: IMPACT_ID,
        kind: "causes",
        evidenceReference: "version:0-6",
      },
    ]),
    lockedRules: Object.freeze([{ id: "rule-one", content: "密室只能由钥匙或守门人开启。" }]),
  });
}

function eventContext(id: string, event: string) {
  return Object.freeze({
    id,
    event,
    result: `${event}的结果`,
    narrativeTime: "第一天",
    location: "旧屋",
    participants: Object.freeze(["hero"]),
    evidenceReference: "version:0-6",
  });
}

function validResponse(): string {
  return JSON.stringify({
    schemaVersion: 1,
    alternateDirection: "如果主角没有拿到钥匙，他必须先取得守门人的信任。",
    effects: [
      {
        eventId: IMPACT_ID,
        summary: "密室开启被推迟，并改由守门人揭示入口。",
        confidence: 0.82,
      },
    ],
  });
}
