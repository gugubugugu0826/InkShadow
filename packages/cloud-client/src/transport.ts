import { CloudClientError } from "./errors.js";

export type CloudHttpMethod = "DELETE" | "GET" | "POST" | "PUT";

export interface CloudTransportRequest {
  readonly method: CloudHttpMethod;
  readonly path: string;
  readonly authentication: "none" | "session";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal?: AbortSignal;
}

export interface CloudTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface CloudTransport {
  readonly handlesSessionAuthentication?: boolean;
  /**
   * True only when password-bearing operations are terminated by a dedicated
   * native credential command rather than a generic request relay.
   */
  readonly handlesNativePasswordBoundary?: boolean;
  send(request: CloudTransportRequest): Promise<CloudTransportResponse>;
}

export interface FetchCloudTransportOptions {
  readonly baseUrl: string;
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const EXPOSED_RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id"] as const;

export class FetchCloudTransport implements CloudTransport {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maximumRequestBytes: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: FetchCloudTransportOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowInsecureLoopback === true);
    this.timeoutMs = requireBoundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      1_000,
      120_000,
    );
    this.maximumRequestBytes = requireBoundedInteger(
      options.maximumRequestBytes ?? DEFAULT_MAXIMUM_BYTES,
      "maximumRequestBytes",
      1_024,
      DEFAULT_MAXIMUM_BYTES,
    );
    this.maximumResponseBytes = requireBoundedInteger(
      options.maximumResponseBytes ?? DEFAULT_MAXIMUM_BYTES,
      "maximumResponseBytes",
      1_024,
      DEFAULT_MAXIMUM_BYTES,
    );
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  public async send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    const path = normalizeRelativePath(request.path);
    const target = new URL(`${this.baseUrl.pathname}${path}`, this.baseUrl);
    const serializedBody = request.body === null ? null : JSON.stringify(request.body);
    if (
      serializedBody !== null &&
      new TextEncoder().encode(serializedBody).byteLength > this.maximumRequestBytes
    ) {
      throw new CloudClientError({
        code: "CLOUD_REQUEST_INVALID",
        message: "The cloud request exceeds the configured size limit.",
        status: null,
        requestId: request.headers["X-Request-Id"] ?? null,
        retryable: false,
      });
    }

    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort();
    }, this.timeoutMs);
    const externalAbort = () => {
      timeoutController.abort();
    };
    request.signal?.addEventListener("abort", externalAbort, { once: true });

    try {
      const response = await this.fetchImplementation(target, {
        method: request.method,
        headers: {
          ...request.headers,
          Accept: "application/json",
          ...(serializedBody === null ? {} : { "Content-Type": "application/json" }),
        },
        ...(serializedBody === null ? {} : { body: serializedBody }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: timeoutController.signal,
      });
      const responseHeaders = selectResponseHeaders(response.headers);
      const body = await readBoundedJson(
        response,
        this.maximumResponseBytes,
        request.headers["X-Request-Id"] ?? null,
      );
      return {
        status: response.status,
        headers: responseHeaders,
        body,
      };
    } catch (cause: unknown) {
      if (cause instanceof CloudClientError) {
        throw cause;
      }
      const externalAborted = request.signal?.aborted === true;
      const timedOut = timeoutController.signal.aborted && !externalAborted;
      throw new CloudClientError({
        code: timedOut
          ? "CLOUD_REQUEST_TIMEOUT"
          : externalAborted
            ? "CLOUD_REQUEST_ABORTED"
            : "CLOUD_NETWORK_UNAVAILABLE",
        message: timedOut
          ? "The cloud request timed out."
          : externalAborted
            ? "The cloud request was canceled."
            : "The cloud service could not be reached.",
        status: null,
        requestId: request.headers["X-Request-Id"] ?? null,
        retryable: !externalAborted,
        causeType: cause instanceof Error ? cause.name : "UnknownError",
      });
    } finally {
      clearTimeout(timeoutHandle);
      request.signal?.removeEventListener("abort", externalAbort);
    }
  }
}

function normalizeBaseUrl(value: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("Cloud base URL is invalid.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw configurationError("Cloud base URL cannot contain credentials, query or fragment.");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.protocol !== "https:" &&
    !(allowInsecureLoopback && loopback && url.protocol === "http:")
  ) {
    throw configurationError(
      "Cloud base URL must use HTTPS; explicit HTTP is limited to loopback development.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function normalizeRelativePath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#")
  ) {
    throw configurationError("Cloud request path must be an absolute relative path.");
  }
  const parsed = new URL(value, "https://inkshadow.invalid");
  if (parsed.origin !== "https://inkshadow.invalid") {
    throw configurationError("Cloud request path cannot change the configured origin.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  requestId: string | null,
): Promise<unknown> {
  if (response.status === 204 || response.body === null) {
    return null;
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/problem+json") {
    throw protocolError("Cloud response did not use a supported JSON content type.", requestId);
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isSafeInteger(Number(declaredLength)) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw responseTooLarge(requestId);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw responseTooLarge(requestId);
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) as unknown;
  } catch {
    throw protocolError("Cloud response contained invalid JSON.", requestId);
  } finally {
    combined.fill(0);
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

function selectResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of EXPOSED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) {
      selected[name] = value;
    }
  }
  return Object.freeze(selected);
}

function requireBoundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`${field} is outside the supported range.`);
  }
  return value;
}

function configurationError(message: string): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_CONFIGURATION_INVALID",
    message,
    status: null,
    requestId: null,
    retryable: false,
  });
}

function protocolError(message: string, requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    message,
    status: null,
    requestId,
    retryable: false,
  });
}

function responseTooLarge(requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_RESPONSE_TOO_LARGE",
    message: "The cloud response exceeds the configured size limit.",
    status: null,
    requestId,
    retryable: false,
  });
}
