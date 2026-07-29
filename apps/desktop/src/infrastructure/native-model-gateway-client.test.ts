import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

import {
  createConfiguredModelCandidate,
  createDevelopmentRuntime,
  TauriNativeModelGatewayClient,
  type DesktopRuntime,
  type NativeModelGatewayClient,
  type NativeModelGenerationInput,
} from "./runtime";

type TestGenerationEvent = Readonly<{
  generationId: string;
  sequence: number;
  delta: string;
  status:
    | Readonly<{ phase: "started" | "delta" | "cancelled" }>
    | Readonly<{
        phase: "completed";
        usage: {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number | null;
        } | null;
      }>
    | Readonly<{ phase: "failed"; code: string; retryable: boolean }>;
}>;

describe("Tauri native model gateway client", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
  });

  it("invokes the strict native embedding command and validates the response contract", async () => {
    tauriMocks.invoke.mockResolvedValue({
      provider: "open_ai_compatible",
      endpointOrigin: "https://example.test",
      model: "embed-1",
      dimension: 2,
      vectorCount: 2,
      embeddings: [
        [1, 0],
        [0, 1],
      ],
    });
    const request = {
      config: {
        providerId: "provider-1",
        provider: "open_ai_compatible" as const,
        baseUrl: "https://example.test/tenant/v1",
        authentication: "none" as const,
      },
      model: "embed-1",
      inputs: ["private one", "private two"],
    };

    await expect(new TauriNativeModelGatewayClient().embed(request)).resolves.toMatchObject({
      model: "embed-1",
      dimension: 2,
      vectorCount: 2,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("embed_native_model", {
      request,
    });
  });

  it("rejects malformed native embedding results without echoing input text", async () => {
    tauriMocks.invoke.mockResolvedValue({
      provider: "ollama",
      endpointOrigin: "http://127.0.0.1:11434",
      model: "embed-1",
      dimension: 2,
      vectorCount: 1,
      embeddings: [[Number.NaN, 0]],
    });

    const error = await new TauriNativeModelGatewayClient()
      .embed({
        config: {
          providerId: "local",
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          authentication: "none",
        },
        model: "embed-1",
        inputs: ["private query must not escape"],
      })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    expect(JSON.stringify(error)).not.toContain("private query must not escape");
  });

  it("accepts the native zero-based event sequence and accumulates streamed text", async () => {
    let deliver: ((event: TestGenerationEvent) => void) | null = null;
    const unlisten = vi.fn();
    tauriMocks.listen.mockImplementation(
      (
        _eventName: string,
        handler: (event: Readonly<{ payload: TestGenerationEvent }>) => void,
      ) => {
        deliver = (event) => handler({ payload: event });
        return Promise.resolve(unlisten);
      },
    );
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command !== "start_native_generation") {
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
      queueMicrotask(() => {
        deliver?.(event(0, "", { phase: "started" }));
        deliver?.(event(1, "墨", { phase: "delta" }));
        deliver?.(event(2, "影", { phase: "delta" }));
        deliver?.(
          event(3, "", {
            phase: "completed",
            usage: {
              inputTokens: 42,
              outputTokens: 7,
              cachedInputTokens: 10,
            },
          }),
        );
      });
      return Promise.resolve({ generationId: "generation-1", accepted: true });
    });
    const onDelta = vi.fn();

    await expect(new TauriNativeModelGatewayClient().generate(input(onDelta))).resolves.toEqual({
      text: "墨影",
      usage: {
        inputTokens: 42,
        outputTokens: 7,
        cachedInputTokens: 10,
      },
    });

    expect(onDelta).toHaveBeenNthCalledWith(1, "墨");
    expect(onDelta).toHaveBeenNthCalledWith(2, "墨影");
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("rejects a sequence gap and requests best-effort native cancellation", async () => {
    let deliver: ((event: TestGenerationEvent) => void) | null = null;
    tauriMocks.listen.mockImplementation(
      (
        _eventName: string,
        handler: (event: Readonly<{ payload: TestGenerationEvent }>) => void,
      ) => {
        deliver = (event) => handler({ payload: event });
        return Promise.resolve(vi.fn());
      },
    );
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "start_native_generation") {
        queueMicrotask(() => {
          deliver?.(event(1, "", { phase: "started" }));
        });
        return Promise.resolve({ generationId: "generation-1", accepted: true });
      }
      if (command === "cancel_native_generation") {
        return Promise.resolve({
          generationId: "generation-1",
          cancellationRequested: true,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await expect(new TauriNativeModelGatewayClient().generate(input())).rejects.toMatchObject({
      code: "MODEL_EVENT_SEQUENCE_INVALID",
    });
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith("cancel_native_generation", {
        request: { generationId: "generation-1" },
      });
    });
  });

  it("persists completed native output as an isolated candidate without changing正文", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await developmentRuntime.useCases.createProject.execute({
      name: "原生候选测试",
    });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await developmentRuntime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "稳定正文。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    await developmentRuntime.modelCenter.save({
      providerId: "local-ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((request) => {
      request.onDelta?.("候选");
      request.onDelta?.("候选续写。");
      return Promise.resolve({
        text: "候选续写。",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: null,
        },
      });
    });
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      listModels: () => Promise.reject(new Error("not used")),
      checkConnection: () => Promise.reject(new Error("not used")),
      embed: () => Promise.reject(new Error("not used")),
      generate,
      cancelGeneration: () => Promise.resolve(false),
    };
    const nativeRuntime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    };
    const onDelta = vi.fn();

    const result = await createConfiguredModelCandidate(
      nativeRuntime,
      chapter.value.chapter.id,
      onDelta,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.status).toBe("ready");
    expect(result.value.content).toBe("稳定正文。\n\n候选续写。");
    expect(onDelta).toHaveBeenLastCalledWith("候选续写。");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "writer-model",
        config: {
          providerId: "local-ollama",
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          authentication: "none",
        },
      }),
    );
    const stableChapter = await developmentRuntime.repositories.chapters.findById(
      chapter.value.chapter.id,
    );
    expect(stableChapter.ok && stableChapter.value?.content).toBe("稳定正文。");
    const candidates = await developmentRuntime.repositories.aiCandidates.listByChapterId(
      chapter.value.chapter.id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(1);
  });
});

function input(onDelta?: (accumulatedText: string) => void): NativeModelGenerationInput {
  return {
    generationId: "generation-1",
    config: {
      providerId: "provider-1",
      provider: "open_ai_compatible",
      baseUrl: "https://example.test/v1",
      authentication: "none",
    },
    model: "model-1",
    messages: [{ role: "user", content: "Continue." }],
    maxOutputTokens: 128,
    ...(onDelta === undefined ? {} : { onDelta }),
  };
}

function event(
  sequence: number,
  delta: string,
  status: TestGenerationEvent["status"],
): TestGenerationEvent {
  return {
    generationId: "generation-1",
    sequence,
    delta,
    status,
  };
}
