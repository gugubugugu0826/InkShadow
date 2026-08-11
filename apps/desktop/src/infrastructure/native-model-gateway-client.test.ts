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
        streamed?: boolean;
        usage: {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number | null;
        } | null;
      }>
    | Readonly<{
        phase: "failed";
        code: string;
        retryable: boolean;
        requestId?: string;
        httpStatus?: number | null;
        finishReason?: string | null;
        reasoningPresent?: boolean | null;
        stream?: boolean | null;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number | null;
        } | null;
      }>;
}>;

const TEST_DISPATCH_SCOPE = {
  kind: "project_context",
  receipt: {
    schemaVersion: 1,
    projectId: "019f9f4a-b3c7-7350-9226-000000000001",
    fingerprint: "a".repeat(64),
    activeChapterCount: 0,
    retainedChapterCount: 0,
    requiresVerifiedLocal: false,
    chapters: [],
  },
} as const;

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
      dispatchScope: TEST_DISPATCH_SCOPE,
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

  it("passes Gemini model resource names through to native embedding", async () => {
    tauriMocks.invoke.mockResolvedValue({
      provider: "gemini",
      endpointOrigin: "https://generativelanguage.googleapis.com",
      model: "models/text-embedding-004",
      dimension: 3,
      vectorCount: 1,
      embeddings: [[0.1, 0.2, 0.3]],
    });
    const request = {
      dispatchScope: TEST_DISPATCH_SCOPE,
      config: {
        providerId: "gemini-primary",
        provider: "gemini" as const,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        authentication: "bearer_keyring" as const,
      },
      model: "models/text-embedding-004",
      inputs: ["A safe test input."],
    };

    await expect(new TauriNativeModelGatewayClient().embed(request)).resolves.toMatchObject({
      provider: "gemini",
      model: "models/text-embedding-004",
      dimension: 3,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("embed_native_model", { request });
  });

  it("rejects Anthropic embedding before invoking the native gateway", async () => {
    const error = await new TauriNativeModelGatewayClient()
      .embed({
        dispatchScope: TEST_DISPATCH_SCOPE,
        config: {
          providerId: "claude-primary",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          authentication: "bearer_keyring",
        },
        model: "claude-sonnet",
        inputs: ["Do not send this input."],
      })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "MODEL_OPERATION_UNSUPPORTED" });
    expect(error).toHaveProperty("message", expect.stringContaining("embedding API"));
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
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
        dispatchScope: TEST_DISPATCH_SCOPE,
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

  it("invokes only the explicit Qwen rerank contract and returns index-score metadata", async () => {
    tauriMocks.invoke.mockResolvedValue({
      provider: "open_ai_compatible",
      protocol: "qwen_open_ai_compatible",
      endpointOrigin: "https://workspace.cn-beijing.maas.aliyuncs.com",
      model: "qwen3-rerank",
      rankings: [{ index: 1, relevanceScore: 0.92 }],
      inputTokens: 28,
    });
    const request = {
      dispatchScope: TEST_DISPATCH_SCOPE,
      config: {
        providerId: "qwen-beijing",
        provider: "open_ai_compatible" as const,
        baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-api/v1",
        authentication: "bearer_keyring" as const,
      },
      protocol: "qwen_open_ai_compatible" as const,
      model: "qwen3-rerank",
      query: "private query",
      documents: ["private first", "private second"],
      topN: 2,
    };

    await expect(new TauriNativeModelGatewayClient().rerank(request)).resolves.toEqual(
      expect.objectContaining({
        rankings: [{ index: 1, relevanceScore: 0.92 }],
        inputTokens: 28,
      }),
    );
    expect(tauriMocks.invoke).toHaveBeenCalledWith("rerank_native_model", { request });
  });

  it("rejects malformed or unsupported native rerank responses without echoing content", async () => {
    const client = new TauriNativeModelGatewayClient();
    const unsupported = await client
      .rerank({
        dispatchScope: TEST_DISPATCH_SCOPE,
        config: {
          providerId: "gemini",
          provider: "gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          authentication: "bearer_keyring",
        },
        protocol: "qwen_open_ai_compatible",
        model: "ranker",
        query: "must remain private",
        documents: ["private document"],
        topN: 1,
      })
      .catch((cause: unknown) => cause);
    expect(unsupported).toMatchObject({ code: "MODEL_OPERATION_UNSUPPORTED" });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();

    tauriMocks.invoke.mockResolvedValue({
      provider: "open_ai_compatible",
      protocol: "qwen_open_ai_compatible",
      endpointOrigin: "https://workspace.cn-beijing.maas.aliyuncs.com",
      model: "qwen3-rerank",
      rankings: [
        { index: 0, relevanceScore: 0.8 },
        { index: 0, relevanceScore: 0.7 },
      ],
      inputTokens: 10,
    });
    const malformed = await client
      .rerank({
        dispatchScope: TEST_DISPATCH_SCOPE,
        config: {
          providerId: "qwen",
          provider: "open_ai_compatible",
          baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-api/v1",
          authentication: "bearer_keyring",
        },
        protocol: "qwen_open_ai_compatible",
        model: "qwen3-rerank",
        query: "must remain private",
        documents: ["private document", "private second"],
        topN: 2,
      })
      .catch((cause: unknown) => cause);
    expect(malformed).toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    expect(JSON.stringify(malformed)).not.toContain("must remain private");
    expect(JSON.stringify(malformed)).not.toContain("private document");
  });

  it("preserves Gemini models/... identifiers returned by native discovery", async () => {
    const config = {
      providerId: "gemini-primary",
      provider: "gemini" as const,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      authentication: "bearer_keyring" as const,
    };
    tauriMocks.invoke.mockResolvedValue({
      provider: "gemini",
      models: [
        {
          id: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          sizeBytes: null,
        },
      ],
    });

    await expect(new TauriNativeModelGatewayClient().listModels(config)).resolves.toEqual({
      provider: "gemini",
      models: [
        {
          id: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          sizeBytes: null,
        },
      ],
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("list_native_models", {
      request: { config },
    });
  });

  it("validates an Anthropic native connection result", async () => {
    const config = {
      providerId: "claude-primary",
      provider: "anthropic" as const,
      baseUrl: "https://api.anthropic.com/v1",
      authentication: "bearer_keyring" as const,
    };
    tauriMocks.invoke.mockResolvedValue({
      provider: "anthropic",
      endpointOrigin: "https://api.anthropic.com",
      modelCount: 4,
      latencyMs: 125,
    });

    await expect(new TauriNativeModelGatewayClient().checkConnection(config)).resolves.toEqual({
      provider: "anthropic",
      endpointOrigin: "https://api.anthropic.com",
      modelCount: 4,
      latencyMs: 125,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("check_native_model_connection", {
      request: { config },
    });
  });

  it("omits Anthropic temperature 1.0 from the native generation request", async () => {
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
      if (command !== "start_native_generation") {
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
      queueMicrotask(() => {
        deliver?.(event(0, "", { phase: "started" }));
        deliver?.(event(1, "Claude output", { phase: "delta" }));
        deliver?.(event(2, "", { phase: "completed", usage: null }));
      });
      return Promise.resolve({ generationId: "generation-1", accepted: true });
    });
    const request: NativeModelGenerationInput = {
      ...input(),
      config: {
        providerId: "claude-primary",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        authentication: "bearer_keyring",
      },
      model: "claude-sonnet",
      temperature: 1,
    };

    await expect(new TauriNativeModelGatewayClient().generate(request)).resolves.toEqual({
      text: "Claude output",
      usage: null,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_native_generation", {
      request: {
        dispatchScope: request.dispatchScope,
        generationId: "generation-1",
        config: request.config,
        model: "claude-sonnet",
        messages: request.messages,
        maxOutputTokens: 128,
      },
    });
  });

  it("rejects a non-default Anthropic temperature before starting a stream", async () => {
    await expect(
      new TauriNativeModelGatewayClient().generate({
        ...input(),
        config: {
          providerId: "claude-primary",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          authentication: "bearer_keyring",
        },
        model: "claude-sonnet",
        temperature: 0.7,
      }),
    ).rejects.toMatchObject({ code: "MODEL_OPERATION_UNSUPPORTED" });
    expect(tauriMocks.listen).not.toHaveBeenCalled();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards an explicit native topP value", async () => {
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
      if (command !== "start_native_generation") {
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
      queueMicrotask(() => {
        deliver?.(event(0, "", { phase: "started" }));
        deliver?.(event(1, "Visible output", { phase: "delta" }));
        deliver?.(event(2, "", { phase: "completed", usage: null }));
      });
      return Promise.resolve({ generationId: "generation-1", accepted: true });
    });
    const request = { ...input(), topP: 0.85 };

    await expect(new TauriNativeModelGatewayClient().generate(request)).resolves.toEqual({
      text: "Visible output",
      usage: null,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_native_generation", { request });
  });

  it("rejects topP outside the native 0..1 contract before dispatch", async () => {
    for (const topP of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        new TauriNativeModelGatewayClient().generate({ ...input(), topP }),
      ).rejects.toMatchObject({ code: "MODEL_REQUEST_INVALID" });
    }
    expect(tauriMocks.listen).not.toHaveBeenCalled();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
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

  it("forwards a probe-only reasoning control and trusts the native transport observation", async () => {
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
      if (command !== "start_native_generation") {
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
      queueMicrotask(() => {
        deliver?.(event(0, "", { phase: "started" }));
        deliver?.(event(1, "OK", { phase: "delta" }));
        deliver?.(event(2, "", { phase: "completed", usage: null, streamed: false }));
      });
      return Promise.resolve({ generationId: "generation-1", accepted: true });
    });
    const request = { ...input(), reasoningMode: "disabled" as const };

    await expect(new TauriNativeModelGatewayClient().generate(request)).resolves.toEqual({
      text: "OK",
      usage: null,
      streamed: false,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_native_generation", { request });
  });

  it("preserves only redacted native failure facts and the visible character count", async () => {
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
      if (command !== "start_native_generation") {
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
      queueMicrotask(() => {
        deliver?.(event(0, "", { phase: "started" }));
        deliver?.(event(1, "可见", { phase: "delta" }));
        deliver?.(
          event(2, "", {
            phase: "failed",
            code: "MODEL_OUTPUT_TRUNCATED",
            retryable: false,
            requestId: "019f9f4a-b3c7-7350-9226-000000000099",
            httpStatus: 200,
            finishReason: "length",
            reasoningPresent: true,
            stream: true,
            usage: { inputTokens: 5, outputTokens: 8, cachedInputTokens: null },
          }),
        );
      });
      return Promise.resolve({ generationId: "generation-1", accepted: true });
    });

    await expect(new TauriNativeModelGatewayClient().generate(input())).rejects.toMatchObject({
      code: "MODEL_OUTPUT_TRUNCATED",
      retryable: false,
      diagnostics: {
        requestId: "019f9f4a-b3c7-7350-9226-000000000099",
        httpStatus: 200,
        finishReason: "length",
        visibleContentLength: 2,
        reasoningPresent: true,
        stream: true,
        inputTokens: 5,
        outputTokens: 8,
      },
    });
  });

  it("rejects a completed native stream that contains no visible candidate text", async () => {
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
        deliver?.(event(1, "", { phase: "completed", usage: null }));
      });
      return Promise.resolve({ generationId: "generation-1", accepted: true });
    });

    await expect(new TauriNativeModelGatewayClient().generate(input())).rejects.toMatchObject({
      code: "MODEL_OUTPUT_EMPTY",
    });
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
    const listModels = vi.fn<NativeModelGatewayClient["listModels"]>(() =>
      Promise.resolve({
        provider: "ollama",
        models: [{ id: "writer-model", displayName: "Writer model" }],
      }),
    );
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      listModels,
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
    expect(result.value).toMatchObject({
      content: "\n\n候选续写。",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.value.chapter.content.length,
        endUtf16: chapter.value.chapter.content.length,
      },
    });
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
    expect(listModels).toHaveBeenCalledWith({
      providerId: "local-ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
    });
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
    dispatchScope: TEST_DISPATCH_SCOPE,
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
