import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  NativeImageGenerationError,
  TauriNativeImageGenerationGateway,
} from "./native-image-generation-gateway";

describe("Tauri native image generation gateway", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("uses an opaque destination ticket and validates the content-free file receipt", async () => {
    invoke
      .mockResolvedValueOnce({ ticket: "a".repeat(64), fileName: "scene.png" })
      .mockResolvedValueOnce({
        provider: "open_ai_compatible",
        endpointOrigin: "https://images.example",
        model: "image-model-from-catalog",
        fileName: "scene.png",
        mediaType: "image/png",
        bytesWritten: 12_345,
        usage: { inputTokens: 7, outputTokens: 11, cachedInputTokens: null },
      });
    const gateway = new TauriNativeImageGenerationGateway();
    const destination = await gateway.chooseDestination();
    if (destination === null) {
      throw new Error("The native destination fixture was cancelled unexpectedly.");
    }
    const receipt = await gateway.generateToFile({
      destinationTicket: destination.ticket,
      config: {
        providerId: "connection-1",
        provider: "open_ai_compatible",
        baseUrl: "https://images.example/v1",
        authentication: "bearer_keyring",
      },
      model: "image-model-from-catalog",
      prompt: "PRIVATE_IMAGE_PROMPT",
    });

    expect(destination).toEqual({ ticket: "a".repeat(64), fileName: "scene.png" });
    expect(receipt).toMatchObject({ fileName: "scene.png", bytesWritten: 12_345 });
    expect(invoke).toHaveBeenNthCalledWith(1, "choose_native_image_destination");
    expect(invoke).toHaveBeenNthCalledWith(2, "generate_native_image_to_file", expect.anything());
    const nativeRequest: unknown = invoke.mock.calls[1]?.[1];
    expect(nativeRequest).toMatchObject({
      request: {
        destinationTicket: "a".repeat(64),
        model: "image-model-from-catalog",
        prompt: "PRIVATE_IMAGE_PROMPT",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_IMAGE_PROMPT");
    expect(JSON.stringify(receipt)).not.toMatch(/apiKey|secret|baseUrl/iu);
  });

  it("rejects malformed native results instead of trusting a path or media claim", async () => {
    invoke.mockResolvedValue({
      provider: "open_ai_compatible",
      endpointOrigin: "https://images.example",
      model: "image-model-from-catalog",
      fileName: "../escape.png",
      mediaType: "image/png",
      bytesWritten: 12,
      usage: null,
    });
    const gateway = new TauriNativeImageGenerationGateway();

    await expect(
      gateway.generateToFile({
        destinationTicket: "b".repeat(64),
        config: {
          providerId: "connection-1",
          provider: "open_ai_compatible",
          baseUrl: "https://images.example/v1",
          authentication: "none",
        },
        model: "image-model-from-catalog",
        prompt: "safe prompt",
      }),
    ).rejects.toBeInstanceOf(NativeImageGenerationError);
  });

  it("maps native codes to ordinary-language errors without exposing provider bodies", async () => {
    invoke.mockRejectedValue({
      code: "MODEL_HTTP_UNAUTHORIZED",
      message: "secret provider body",
      retryable: false,
    });
    const gateway = new TauriNativeImageGenerationGateway();

    const error = await gateway.chooseDestination().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "MODEL_HTTP_UNAUTHORIZED", retryable: false });
    expect((error as Error).message).toContain("API Key");
    expect((error as Error).message).not.toContain("secret provider body");
  });
});
