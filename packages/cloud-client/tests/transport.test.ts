import { describe, expect, it, vi } from "vitest";

import {
  CloudClientError,
  FetchCloudTransport,
  createMonotonicCloudRequestIdFactory,
} from "../src/index.js";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000009";

describe("FetchCloudTransport", () => {
  it("requires HTTPS except for explicitly enabled loopback development", () => {
    expect(
      () =>
        new FetchCloudTransport({
          baseUrl: "http://api.example.com",
        }),
    ).toThrowError(CloudClientError);
    expect(
      () =>
        new FetchCloudTransport({
          baseUrl: "http://localhost:8787",
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new FetchCloudTransport({
          baseUrl: "https://user:secret@example.com",
        }),
    ).toThrowError(CloudClientError);
  });

  it("omits ambient credentials, rejects redirects and parses bounded JSON", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": REQUEST_ID,
            "set-cookie": "must-not-be-exposed=1",
          },
        }),
      ),
    );
    const transport = new FetchCloudTransport({
      baseUrl: "https://api.example.com/base",
      fetchImplementation,
    });

    const response = await transport.send({
      method: "POST",
      path: "/v1/test",
      authentication: "none",
      headers: { "X-Request-Id": REQUEST_ID },
      body: { encrypted: "ciphertext" },
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://api.example.com/base/v1/test"),
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
    expect(response.body).toEqual({ accepted: true });
    expect(response.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      "x-request-id": REQUEST_ID,
    });
  });

  it("rejects oversized responses before parsing them", async () => {
    const transport = new FetchCloudTransport({
      baseUrl: "https://api.example.com",
      maximumResponseBytes: 1_024,
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify({ value: "x".repeat(2_000) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    await expect(
      transport.send({
        method: "GET",
        path: "/v1/test",
        authentication: "none",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_RESPONSE_TOO_LARGE",
      requestId: REQUEST_ID,
    });
  });
});

describe("cloud request ids", () => {
  it("creates monotonic UUIDv7 identifiers when the host clock does not advance", () => {
    const factory = createMonotonicCloudRequestIdFactory(
      () => 1_722_038_400_000,
      (target) => target.fill(0),
    );
    const first = factory();
    const second = factory();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(second > first).toBe(true);
  });
});
