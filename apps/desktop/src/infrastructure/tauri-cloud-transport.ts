import { invoke } from "@tauri-apps/api/core";
import {
  CloudAccountDeletionCancellationRequestSchema,
  CloudAccountDeletionLookupRequestSchema,
  CloudAccountDeletionSubmissionRequestSchema,
  CloudApiErrorCodeSchema,
  CloudDeletionSubmissionRequestSchema,
  CloudIdempotencyKeySchema,
  UuidV7Schema,
} from "@inkshadow/contracts";
import {
  CloudClientError,
  type CloudClientErrorCode,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "@inkshadow/cloud-client";

import type { CloudEndpoint } from "./cloud-session-vault";

interface NativeCloudRelayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface NativeCommandError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly actions: readonly string[];
  readonly requestId: string;
}

type NativeCloudDeletionCredentialInput =
  | {
      readonly operation: "request_project";
      readonly baseUrl: string;
      readonly allowInsecureLoopback: boolean;
      readonly projectId: string;
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly expectedRevision: number;
      readonly confirmationId: string;
      readonly password: string;
    }
  | {
      readonly operation: "request_account";
      readonly baseUrl: string;
      readonly allowInsecureLoopback: boolean;
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly expectedRevision: number;
      readonly confirmationId: string;
      readonly email: string;
      readonly password: string;
    }
  | {
      readonly operation: "lookup_account";
      readonly baseUrl: string;
      readonly allowInsecureLoopback: boolean;
      readonly requestId: string;
      readonly deletionRequestId?: string;
      readonly confirmationId?: string;
      readonly email: string;
      readonly password: string;
    }
  | {
      readonly operation: "cancel_account";
      readonly baseUrl: string;
      readonly allowInsecureLoopback: boolean;
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly deletionRequestId: string;
      readonly expectedDeletionRevision: number;
      readonly email: string;
      readonly password: string;
    };

const LOCAL_ERROR_CODES = new Set<CloudClientErrorCode>([
  "CLOUD_NETWORK_UNAVAILABLE",
  "CLOUD_PROTOCOL_INVALID_RESPONSE",
  "CLOUD_REQUEST_ABORTED",
  "CLOUD_REQUEST_INVALID",
  "CLOUD_REQUEST_TIMEOUT",
  "CLOUD_RESPONSE_TOO_LARGE",
]);
const RESPONSE_HEADER_ALLOWLIST = new Set(["content-type", "retry-after", "x-request-id"]);

export class TauriCloudTransport implements CloudTransport {
  public readonly handlesSessionAuthentication = true;
  public readonly handlesNativePasswordBoundary = true;

  public constructor(private readonly endpoint: CloudEndpoint) {}

  public async send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    const requestId = request.headers["X-Request-Id"] ?? request.headers["x-request-id"] ?? null;
    if (request.signal?.aborted === true) {
      throw new CloudClientError({
        code: "CLOUD_REQUEST_ABORTED",
        message: "The cloud request was canceled.",
        status: null,
        requestId,
        retryable: false,
      });
    }
    const deletionCredentialInput = createDeletionCredentialInput(
      request,
      requestId,
      this.endpoint,
    );
    if (deletionCredentialInput === null) {
      validateRequestBoundary(request, requestId);
    }

    try {
      // Tauri invoke has no cancellation primitive. Once dispatched, the native
      // command is allowed to finish so mutations are never reported as canceled
      // after the server may already have committed them.
      const response =
        deletionCredentialInput === null
          ? await invoke<unknown>("send_cloud_api_request", {
              input: {
                baseUrl: this.endpoint.baseUrl,
                allowInsecureLoopback: this.endpoint.allowInsecureLoopback === true,
                method: request.method,
                path: request.path,
                headers: { ...request.headers },
                body: request.body,
                authentication: request.authentication,
              },
            })
          : await invoke<unknown>("send_cloud_deletion_credential_request", {
              input: deletionCredentialInput,
            });
      return parseNativeResponse(response, requestId);
    } catch (cause: unknown) {
      if (cause instanceof CloudClientError) {
        throw cause;
      }
      throw normalizeNativeCloudCommandError(cause, requestId);
    }
  }
}

function createDeletionCredentialInput(
  request: CloudTransportRequest,
  requestId: string | null,
  endpoint: CloudEndpoint,
): NativeCloudDeletionCredentialInput | null {
  const projectMatch = /^\/v1\/projects\/([^/?#]+)\/deletion-requests$/u.exec(request.path);
  const operation =
    projectMatch !== null
      ? "request_project"
      : request.path === "/v1/account/deletion-requests"
        ? "request_account"
        : request.path === "/v1/account/deletion-request-lookups"
          ? "lookup_account"
          : request.path === "/v1/account/deletion-cancellations"
            ? "cancel_account"
            : null;
  if (operation === null) {
    return null;
  }
  const expectedAuthentication =
    operation === "request_project" || operation === "request_account" ? "session" : "none";
  if (
    request.method !== "POST" ||
    request.authentication !== expectedAuthentication ||
    request.path.includes("?")
  ) {
    throw requestBoundaryError(
      "Password reauthentication must use an exact native deletion route.",
      requestId,
    );
  }

  const common = {
    baseUrl: endpoint.baseUrl,
    allowInsecureLoopback: endpoint.allowInsecureLoopback === true,
  };
  if (operation === "request_project") {
    const projectId = UuidV7Schema.safeParse(projectMatch?.[1]);
    const body = CloudDeletionSubmissionRequestSchema.safeParse(request.body);
    const headers = validateSensitiveHeaders(request.headers, requestId, true);
    if (!projectId.success || !body.success || headers.idempotencyKey === null) {
      throw requestBoundaryError("The native project-deletion request is invalid.", requestId);
    }
    return {
      operation,
      ...common,
      projectId: projectId.data,
      requestId: headers.requestId,
      idempotencyKey: headers.idempotencyKey,
      expectedRevision: body.data.expectedRevision,
      confirmationId: body.data.confirmationId,
      password: body.data.password,
    };
  }
  if (operation === "request_account") {
    const body = CloudAccountDeletionSubmissionRequestSchema.safeParse(request.body);
    const headers = validateSensitiveHeaders(request.headers, requestId, true);
    if (!body.success || headers.idempotencyKey === null) {
      throw requestBoundaryError("The native account-deletion request is invalid.", requestId);
    }
    return {
      operation,
      ...common,
      requestId: headers.requestId,
      idempotencyKey: headers.idempotencyKey,
      expectedRevision: body.data.expectedRevision,
      confirmationId: body.data.confirmationId,
      email: body.data.email,
      password: body.data.password,
    };
  }
  if (operation === "lookup_account") {
    const body = CloudAccountDeletionLookupRequestSchema.safeParse(request.body);
    const headers = validateSensitiveHeaders(request.headers, requestId, false);
    if (!body.success) {
      throw requestBoundaryError("The native account-deletion lookup is invalid.", requestId);
    }
    return {
      operation,
      ...common,
      requestId: headers.requestId,
      ...("deletionRequestId" in body.data
        ? { deletionRequestId: body.data.deletionRequestId }
        : { confirmationId: body.data.confirmationId }),
      email: body.data.email,
      password: body.data.password,
    };
  }

  const body = CloudAccountDeletionCancellationRequestSchema.safeParse(request.body);
  const headers = validateSensitiveHeaders(request.headers, requestId, true);
  if (!body.success || headers.idempotencyKey === null) {
    throw requestBoundaryError("The native account-deletion cancellation is invalid.", requestId);
  }
  return {
    operation,
    ...common,
    requestId: headers.requestId,
    idempotencyKey: headers.idempotencyKey,
    deletionRequestId: body.data.deletionRequestId,
    expectedDeletionRevision: body.data.expectedDeletionRevision,
    email: body.data.email,
    password: body.data.password,
  };
}

function validateSensitiveHeaders(
  headers: Readonly<Record<string, string>>,
  fallbackRequestId: string | null,
  requiresIdempotencyKey: boolean,
): { readonly requestId: string; readonly idempotencyKey: string | null } {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const headerName = name.toLowerCase();
    if (
      !["x-request-id", "idempotency-key"].includes(headerName) ||
      normalized.has(headerName) ||
      !isAsciiWithoutControlCharacters(value)
    ) {
      throw requestBoundaryError(
        "The native deletion request headers are invalid.",
        fallbackRequestId,
      );
    }
    normalized.set(headerName, value);
  }
  const requestId = UuidV7Schema.safeParse(normalized.get("x-request-id"));
  const idempotencyKey = normalized.get("idempotency-key");
  const parsedIdempotencyKey =
    idempotencyKey === undefined ? null : CloudIdempotencyKeySchema.safeParse(idempotencyKey);
  if (
    !requestId.success ||
    requestId.data !== fallbackRequestId ||
    (requiresIdempotencyKey && parsedIdempotencyKey?.success !== true) ||
    (!requiresIdempotencyKey && parsedIdempotencyKey !== null) ||
    normalized.size !== (requiresIdempotencyKey ? 2 : 1)
  ) {
    throw requestBoundaryError(
      "The native deletion request headers are invalid.",
      fallbackRequestId,
    );
  }
  return {
    requestId: requestId.data,
    idempotencyKey: parsedIdempotencyKey?.success === true ? parsedIdempotencyKey.data : null,
  };
}

function parseNativeResponse(value: unknown, requestId: string | null): NativeCloudRelayResponse {
  if (!isRecord(value)) {
    throw protocolError(requestId);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("status") ||
    !keys.includes("headers") ||
    !keys.includes("body") ||
    !Number.isSafeInteger(value.status) ||
    (value.status as number) < 100 ||
    (value.status as number) > 599 ||
    !isStringRecord(value.headers)
  ) {
    throw protocolError(requestId);
  }
  if (Object.keys(value.headers).length > RESPONSE_HEADER_ALLOWLIST.size) {
    throw protocolError(requestId);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (
      name !== name.toLowerCase() ||
      !RESPONSE_HEADER_ALLOWLIST.has(name) ||
      headerValue.length > 1_024 ||
      !isAsciiWithoutControlCharacters(headerValue)
    ) {
      throw protocolError(requestId);
    }
    headers[name] = headerValue;
  }
  return Object.freeze({
    status: value.status as number,
    headers: Object.freeze(headers),
    body: value.body,
  });
}

export function normalizeNativeCloudCommandError(
  cause: unknown,
  fallbackRequestId: string | null,
): CloudClientError {
  const native = parseNativeCommandError(cause);
  if (native === null) {
    return new CloudClientError({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      message: "The native cloud gateway rejected an invalid IPC exchange.",
      status: null,
      requestId: fallbackRequestId,
      retryable: false,
      causeType: cause instanceof Error ? cause.name : "UnknownError",
    });
  }
  return new CloudClientError({
    code: normalizeErrorCode(native.code),
    message: native.message,
    status: null,
    requestId: native.requestId,
    retryable: native.retryable,
    actions: native.actions,
    causeType: "NativeCloudGateway",
  });
}

function normalizeErrorCode(code: string): CloudClientErrorCode {
  const apiCode = CloudApiErrorCodeSchema.safeParse(code);
  if (apiCode.success) {
    return apiCode.data;
  }
  if (LOCAL_ERROR_CODES.has(code as CloudClientErrorCode)) {
    return code as CloudClientErrorCode;
  }
  if (
    code.startsWith("CLOUD_SESSION_") ||
    code === "CREDENTIAL_STORE_UNAVAILABLE" ||
    code === "CLOUD_DEVICE_IDENTITY_MISMATCH"
  ) {
    return "CLOUD_AUTHENTICATION_REQUIRED";
  }
  if (code.startsWith("CLOUD_ENDPOINT_")) {
    return "CLOUD_CONFIGURATION_INVALID";
  }
  if (
    code.startsWith("CLOUD_RELAY_") ||
    code === "CLOUD_AUTHORIZATION_INPUT_FORBIDDEN" ||
    code === "CLOUD_REQUEST_INVALID"
  ) {
    return "CLOUD_REQUEST_INVALID";
  }
  return "CLOUD_PROTOCOL_INVALID_RESPONSE";
}

function parseNativeCommandError(value: unknown): NativeCommandError | null {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{2,80}$/u.test(value.code) ||
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > 500 ||
    typeof value.retryable !== "boolean" ||
    !isSafeActions(value.actions) ||
    typeof value.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requestId)
  ) {
    return null;
  }
  return {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
    actions: Object.freeze([...value.actions]),
    requestId: value.requestId,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    message: "The native cloud gateway returned an invalid response.",
    status: null,
    requestId,
    retryable: false,
  });
}

function validateRequestBoundary(request: CloudTransportRequest, requestId: string | null): void {
  const normalizedHeaders = new Set<string>();
  if (Object.keys(request.headers).length > 2) {
    throw requestBoundaryError("The native cloud relay accepts at most two headers.", requestId);
  }
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      !["x-request-id", "idempotency-key"].includes(normalized) ||
      normalizedHeaders.has(normalized) ||
      value.length < 1 ||
      value.length > 512 ||
      !isAsciiWithoutControlCharacters(value)
    ) {
      throw requestBoundaryError(
        normalized === "authorization"
          ? "Authorization credentials cannot cross the WebView boundary."
          : "The native cloud relay request headers are invalid.",
        requestId,
      );
    }
    normalizedHeaders.add(normalized);
  }

  const routePath = request.path.split("?", 1)[0] ?? "";
  if (
    request.method === "GET" &&
    /^\/v1\/teams\/[^/]+\/projects\/[^/]+\/keys\/[^/]+\/envelopes\/current-device$/u.test(routePath)
  ) {
    throw requestBoundaryError(
      "Current-device team envelope ciphertext must use the dedicated native verification command.",
      requestId,
    );
  }
  if (
    request.method === "POST" &&
    [
      "/v1/auth/sessions",
      "/v1/identity/verifications",
      "/v1/auth/session-rotations",
      "/v1/auth/session-revocations",
    ].includes(routePath)
  ) {
    throw requestBoundaryError(
      "Session credential routes must use their dedicated native commands.",
      requestId,
    );
  }
  if (containsForbiddenCredentialField(request.body)) {
    throw requestBoundaryError("Session credentials cannot cross the WebView boundary.", requestId);
  }
}

function containsForbiddenCredentialField(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  let inspected = 0;
  while (pending.length > 0) {
    inspected += 1;
    if (inspected > 100_000) {
      return true;
    }
    const current = pending.pop();
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (visited.has(current)) {
      return true;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      for (const child of current as unknown[]) {
        pending.push(child);
      }
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
      if (
        ["authorization", "accesstoken", "password", "refreshtoken", "tokens"].includes(normalized)
      ) {
        return true;
      }
      pending.push(child);
    }
  }
  return false;
}

function isAsciiWithoutControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f || code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function isSafeActions(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (action: unknown) => typeof action === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(action),
    )
  );
}

function requestBoundaryError(message: string, requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_REQUEST_INVALID",
    message,
    status: null,
    requestId,
    retryable: false,
  });
}
