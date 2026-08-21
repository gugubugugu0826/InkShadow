import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IsoUtcTimestamp } from "@inkshadow/domain";

import { recoverOrphanedCapabilityProbeInvocationsAtStartup } from "./capability-probe-startup-recovery";
import { BrowserDevelopmentModelHubStore } from "./model-hub-store";
import { executeAuditedModelHubTextCapabilityProbe } from "./model-hub-text-capability-probe";
import type { NativeModelGenerationInput } from "./runtime";

const NOW = "2026-08-20T12:00:00.000Z" as IsoUtcTimestamp;
const clock = Object.freeze({ now: () => NOW });

beforeEach(() => {
  window.localStorage.clear();
});

describe("capability probe startup recovery", () => {
  it.each([
    {
      label: "发送前退出",
      dispatched: false,
      status: "failed" as const,
      errorCode: "CAPABILITY_PROBE_NOT_DISPATCHED",
      receipt: { notDispatchedCount: 1, ambiguousCount: 0 },
    },
    {
      label: "发送后退出",
      dispatched: true,
      status: "timed_out" as const,
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
      receipt: { notDispatchedCount: 0, ambiguousCount: 1 },
    },
  ])("$label后重启只结算一次且绝不重发", async (scenario) => {
    const firstProcess = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    const target = await seedProbeTarget(firstProcess);
    let running = await firstProcess.startInvocation({
      id: `probe-${scenario.dispatched ? "dispatched" : "predispatch"}`,
      task: "capability_probe",
      routeTask: null,
      connectionId: target.connectionId,
      catalogEntryId: target.catalogEntryId,
      providerKindSnapshot: "openai",
      modelIdSnapshot: "probe-model",
      routeReason: "user_override",
      attempt: 1,
      privacyPolicy: "cloud_allowed",
      dataDestination: "remote",
      maximumCostMicros: null,
      currency: null,
    });
    if (scenario.dispatched) {
      running = await firstProcess.markInvocationDispatched({
        id: running.id,
        dispatchedAt: NOW,
        expectedRevision: running.revision,
      });
    }

    await expect(
      firstProcess.recordCapabilityScan({
        scanId: `premature-scan-${running.id}`,
        catalogEntryId: target.catalogEntryId,
        modelInvocationId: running.id,
        scanKind: "lightweight_probe",
        status: "failed",
        evidenceVersion: "startup-recovery-test-v1",
        errorCode: "PROBE_INTERRUPTED",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_INVOCATION_INVALID" });

    const restarted = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await expect(recoverOrphanedCapabilityProbeInvocationsAtStartup(restarted)).resolves.toEqual({
      inspectedInvocationCount: 1,
      ...scenario.receipt,
      failedRecoveryCount: 0,
    });
    await expect(restarted.findInvocation(running.id)).resolves.toMatchObject({
      status: scenario.status,
      errorCode: scenario.errorCode,
      providerDispatchStartedAt: scenario.dispatched ? NOW : null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: null,
    });

    const terminalScan = restarted.recordCapabilityScan({
      scanId: `terminal-scan-${running.id}`,
      catalogEntryId: target.catalogEntryId,
      modelInvocationId: running.id,
      scanKind: "lightweight_probe",
      status: "failed",
      evidenceVersion: "startup-recovery-test-v1",
      errorCode: scenario.errorCode,
    });
    if (scenario.dispatched) {
      await expect(terminalScan).rejects.toMatchObject({
        code: "MODEL_HUB_CAPABILITY_INVOCATION_INVALID",
      });
      const failures = await restarted.listRecentAiFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0]?.diagnosticId).toBe(`model_invocation:${running.id}`);
    } else {
      await expect(terminalScan).resolves.toEqual([]);
    }

    const secondRestart = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await expect(
      recoverOrphanedCapabilityProbeInvocationsAtStartup(secondRestart),
    ).resolves.toEqual({
      inspectedInvocationCount: 0,
      notDispatchedCount: 0,
      ambiguousCount: 0,
      failedRecoveryCount: 0,
    });
    await expect(secondRestart.findInvocation(running.id)).resolves.toMatchObject({
      status: scenario.status,
      errorCode: scenario.errorCode,
      revision: running.revision + 1,
    });
  });

  it("keeps a completed provider call unlinked when ledger settlement fails, then recovers it as uncertain", async () => {
    const firstProcess = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    const target = await seedProbeTarget(firstProcess);
    const generate = vi.fn().mockResolvedValue({
      text: "OK",
      usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: null },
      streamed: false,
    });
    const failSettlement = vi.fn().mockRejectedValue(new Error("simulated ledger write failure"));

    await expect(
      executeAuditedModelHubTextCapabilityProbe({
        gateway: { generate },
        modelHub: {
          startInvocation: firstProcess.startInvocation.bind(firstProcess),
          markInvocationDispatched: firstProcess.markInvocationDispatched.bind(firstProcess),
          finishInvocation: failSettlement,
          findInvocation: firstProcess.findInvocation.bind(firstProcess),
        },
        clock,
        providerKind: "openai",
        generationId: "019f9f4a-b3c7-7350-9226-000000000302",
        invocationId: "capability-probe-settlement-failure",
        connection: {
          id: target.connectionId,
          revision: 1,
          providerKind: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
        catalogEntry: { id: target.catalogEntryId, revision: 1, providerModelId: "probe-model" },
        config: {
          providerId: "capability-probe-recovery-provider",
          provider: "open_ai_compatible",
          baseUrl: "https://api.openai.com/v1",
          authentication: "none",
          retryLimit: 0,
        },
        model: "probe-model",
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(generate).toHaveBeenCalledOnce();
    expect(failSettlement).toHaveBeenCalledOnce();
    await expect(
      firstProcess.findInvocation("capability-probe-settlement-failure"),
    ).resolves.toMatchObject({
      status: "running",
      providerDispatchStartedAt: NOW,
    });
    await expect(
      firstProcess.recordCapabilityScan({
        scanId: "capability-probe-settlement-failure-scan",
        catalogEntryId: target.catalogEntryId,
        modelInvocationId: "capability-probe-settlement-failure",
        scanKind: "lightweight_probe",
        status: "failed",
        evidenceVersion: "startup-recovery-test-v1",
        errorCode: "INVOCATION_COMMIT_FAILED",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_INVOCATION_INVALID" });

    const restarted = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await expect(recoverOrphanedCapabilityProbeInvocationsAtStartup(restarted)).resolves.toEqual({
      inspectedInvocationCount: 1,
      notDispatchedCount: 0,
      ambiguousCount: 1,
      failedRecoveryCount: 0,
    });
    await expect(
      restarted.findInvocation("capability-probe-settlement-failure"),
    ).resolves.toMatchObject({
      status: "timed_out",
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
  });

  it("settles a callback failure after the native receipt as uncertain without resending", async () => {
    const store = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    const target = await seedProbeTarget(store);
    const generate = vi.fn(async (input: NativeModelGenerationInput) => {
      const ledger = input.invocationDispatchLedger;
      if (ledger === undefined) throw new Error("测试没有收到原生调用账本边界。");
      const dispatched = await store.markInvocationDispatched({
        id: ledger.invocationId,
        dispatchedAt: NOW,
        expectedRevision: ledger.expectedRevision,
      });
      await input.onInvocationDispatchAccepted?.({
        invocationId: dispatched.id,
        dispatchedAt: dispatched.providerDispatchStartedAt ?? NOW,
        revision: dispatched.revision,
      });
      return {
        text: "OK",
        usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: null },
        streamed: false,
      };
    });

    await expect(
      executeAuditedModelHubTextCapabilityProbe({
        gateway: { supportsNativeInvocationDispatchLedger: true, generate },
        modelHub: store,
        clock,
        providerKind: "openai",
        generationId: "019f9f4a-b3c7-7350-9226-000000000312",
        invocationId: "capability-probe-post-receipt-callback-failure",
        connection: {
          id: target.connectionId,
          revision: 1,
          providerKind: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
        catalogEntry: { id: target.catalogEntryId, revision: 1, providerModelId: "probe-model" },
        config: {
          providerId: "capability-probe-recovery-provider",
          provider: "open_ai_compatible",
          baseUrl: "https://api.openai.com/v1",
          authentication: "none",
          retryLimit: 0,
        },
        model: "probe-model",
        onProviderDispatchStarted: () => {
          throw new Error("simulated local callback failure after native receipt");
        },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESULT_AMBIGUOUS" });
    expect(generate).toHaveBeenCalledOnce();
    await expect(
      store.findInvocation("capability-probe-post-receipt-callback-failure"),
    ).resolves.toMatchObject({
      status: "timed_out",
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
      providerDispatchStartedAt: NOW,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("leaves a lost native receipt for startup recovery when the ledger cannot be read", async () => {
    const firstProcess = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    const target = await seedProbeTarget(firstProcess);
    const generate = vi.fn(async (input: NativeModelGenerationInput) => {
      const ledger = input.invocationDispatchLedger;
      if (ledger === undefined) throw new Error("测试没有收到原生调用账本边界。");
      await firstProcess.markInvocationDispatched({
        id: ledger.invocationId,
        dispatchedAt: NOW,
        expectedRevision: ledger.expectedRevision,
      });
      throw Object.assign(new Error("simulated invoke response loss"), {
        code: "MODEL_TRANSPORT_FAILED",
        diagnostics: Object.freeze({ stage: "transport" }),
      });
    });

    await expect(
      executeAuditedModelHubTextCapabilityProbe({
        gateway: { supportsNativeInvocationDispatchLedger: true, generate },
        modelHub: {
          startInvocation: firstProcess.startInvocation.bind(firstProcess),
          markInvocationDispatched: firstProcess.markInvocationDispatched.bind(firstProcess),
          finishInvocation: firstProcess.finishInvocation.bind(firstProcess),
          findInvocation: vi.fn().mockRejectedValue(new Error("simulated ledger read failure")),
        },
        clock,
        providerKind: "openai",
        generationId: "019f9f4a-b3c7-7350-9226-000000000313",
        invocationId: "capability-probe-lost-native-receipt",
        connection: {
          id: target.connectionId,
          revision: 1,
          providerKind: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
        catalogEntry: { id: target.catalogEntryId, revision: 1, providerModelId: "probe-model" },
        config: {
          providerId: "capability-probe-recovery-provider",
          provider: "open_ai_compatible",
          baseUrl: "https://api.openai.com/v1",
          authentication: "none",
          retryLimit: 0,
        },
        model: "probe-model",
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(generate).toHaveBeenCalledOnce();
    await expect(
      firstProcess.findInvocation("capability-probe-lost-native-receipt"),
    ).resolves.toMatchObject({
      status: "running",
      providerDispatchStartedAt: NOW,
    });

    const restarted = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await expect(recoverOrphanedCapabilityProbeInvocationsAtStartup(restarted)).resolves.toEqual({
      inspectedInvocationCount: 1,
      notDispatchedCount: 0,
      ambiguousCount: 1,
      failedRecoveryCount: 0,
    });
    await expect(
      restarted.findInvocation("capability-probe-lost-native-receipt"),
    ).resolves.toMatchObject({
      status: "timed_out",
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
    expect(generate).toHaveBeenCalledOnce();
  });
});

async function seedProbeTarget(store: BrowserDevelopmentModelHubStore): Promise<{
  readonly connectionId: string;
  readonly catalogEntryId: string;
}> {
  const connectionId = "capability-probe-recovery-connection";
  const catalogEntryId = "capability-probe-recovery-catalog";
  await store.saveConnection({
    id: connectionId,
    providerKind: "openai",
    displayName: "恢复测试模型服务",
    credentialRef: "keyring:model-hub:recovery-test",
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    enabled: true,
    expectedRevision: null,
  });
  await store.syncCatalog({
    syncId: "capability-probe-recovery-sync",
    connectionId,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: catalogEntryId,
        providerModelId: "probe-model",
        displayName: "恢复测试模型",
      },
    ],
  });
  return { connectionId, catalogEntryId };
}
