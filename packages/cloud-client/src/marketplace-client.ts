import {
  CloudApiErrorResponseSchema,
  CloudCursorSchema,
  CloudIdempotencyKeySchema,
  CloudOpaqueTokenSchema,
} from "@inkshadow/contracts";
import {
  CloudMarketplaceAppealDispositionRequestSchema,
  CloudMarketplaceAppealRequestSchema,
  CloudMarketplaceAppealResponseSchema,
  CloudMarketplaceArtifactKindSchema,
  CloudMarketplaceCatalogResponseSchema,
  CloudMarketplaceDownloadRequestSchema,
  CloudMarketplaceDownloadResponseSchema,
  CloudMarketplaceModerationQueueResponseSchema,
  CloudMarketplaceModerationRequestSchema,
  CloudMarketplaceReportDispositionRequestSchema,
  CloudMarketplaceReportRequestSchema,
  CloudMarketplaceReportResponseSchema,
  CloudMarketplaceSubmissionRequestSchema,
  CloudMarketplaceSubmissionResponseSchema,
  CloudMarketplaceWithdrawalRequestSchema,
  type CloudMarketplaceAppealDispositionRequest,
  type CloudMarketplaceAppealRequest,
  type CloudMarketplaceAppealResponse,
  type CloudMarketplaceArtifactKind,
  type CloudMarketplaceCatalogResponse,
  type CloudMarketplaceDownloadRequest,
  type CloudMarketplaceDownloadResponse,
  type CloudMarketplaceModerationQueueResponse,
  type CloudMarketplaceModerationRequest,
  type CloudMarketplaceReportDispositionRequest,
  type CloudMarketplaceReportRequest,
  type CloudMarketplaceReportResponse,
  type CloudMarketplaceSubmissionRequest,
  type CloudMarketplaceSubmissionResponse,
  type CloudMarketplaceWithdrawalRequest,
} from "@inkshadow/contracts/marketplace";
import { UuidV7Schema } from "@inkshadow/contracts";

import type { CloudAccessTokenProvider } from "./client.js";
import { CloudClientError, isCloudClientError } from "./errors.js";
import { createMonotonicCloudRequestIdFactory, type CloudRequestIdFactory } from "./request-id.js";
import type { CloudHttpMethod, CloudTransport, CloudTransportResponse } from "./transport.js";

export interface CloudMarketplaceClientOptions {
  readonly accessTokens?: CloudAccessTokenProvider;
  readonly requestIdFactory?: CloudRequestIdFactory;
  readonly transport: CloudTransport;
}

export interface CloudMarketplaceMutationOptions {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface CloudMarketplaceQueryOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CloudMarketplaceCatalogOptions extends CloudMarketplaceQueryOptions {
  readonly kind?: CloudMarketplaceArtifactKind | null;
}

interface RuntimeSchema<Output> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: Output } | { readonly success: false };
}

interface ExecuteOptions<Input, Output> {
  readonly body: Input | null;
  readonly expectedStatus: number;
  readonly idempotencyKey?: string;
  readonly inputSchema: RuntimeSchema<Input> | null;
  readonly method: CloudHttpMethod;
  readonly outputSchema: RuntimeSchema<Output>;
  readonly path: string;
  readonly signal?: AbortSignal;
}

export class CloudMarketplaceClient {
  private readonly accessTokens: CloudAccessTokenProvider | null;
  private readonly requestIdFactory: CloudRequestIdFactory;
  private readonly transport: CloudTransport;

  public constructor(options: CloudMarketplaceClientOptions) {
    this.accessTokens = options.accessTokens ?? null;
    this.requestIdFactory = options.requestIdFactory ?? createMonotonicCloudRequestIdFactory();
    this.transport = options.transport;
  }

  public listCatalog(
    options: CloudMarketplaceCatalogOptions = {},
  ): Promise<CloudMarketplaceCatalogResponse> {
    const kind =
      options.kind === null || options.kind === undefined
        ? null
        : CloudMarketplaceArtifactKindSchema.parse(options.kind);
    return this.execute({
      body: null,
      expectedStatus: 200,
      inputSchema: null,
      method: "GET",
      outputSchema: CloudMarketplaceCatalogResponseSchema,
      path: `/v1/marketplace/artifacts${buildQuery({
        cursor: normalizeCursor(options.cursor),
        kind,
        limit: normalizeLimit(options.limit),
      })}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  public submitVersion(
    request: CloudMarketplaceSubmissionRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    return this.executeMutation(
      "/v1/marketplace/artifacts/submissions",
      request,
      CloudMarketplaceSubmissionRequestSchema,
      CloudMarketplaceSubmissionResponseSchema,
      201,
      options,
    );
  }

  public moderateVersion(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceModerationRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    return this.executeMutation(
      `/v1/marketplace/artifacts/${pathId(artifactId)}/versions/${pathId(versionId)}/moderation`,
      request,
      CloudMarketplaceModerationRequestSchema,
      CloudMarketplaceSubmissionResponseSchema,
      200,
      options,
    );
  }

  public reportVersion(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceReportRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceReportResponse> {
    return this.executeMutation(
      `/v1/marketplace/artifacts/${pathId(artifactId)}/versions/${pathId(versionId)}/reports`,
      request,
      CloudMarketplaceReportRequestSchema,
      CloudMarketplaceReportResponseSchema,
      201,
      options,
    );
  }

  public withdrawVersion(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceWithdrawalRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    return this.executeMutation(
      `/v1/marketplace/artifacts/${pathId(artifactId)}/versions/${pathId(versionId)}/withdrawals`,
      request,
      CloudMarketplaceWithdrawalRequestSchema,
      CloudMarketplaceSubmissionResponseSchema,
      200,
      options,
    );
  }

  public appealVersion(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceAppealRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceAppealResponse> {
    return this.executeMutation(
      `/v1/marketplace/artifacts/${pathId(artifactId)}/versions/${pathId(versionId)}/appeals`,
      request,
      CloudMarketplaceAppealRequestSchema,
      CloudMarketplaceAppealResponseSchema,
      201,
      options,
    );
  }

  public disposeReport(
    reportId: string,
    request: CloudMarketplaceReportDispositionRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceReportResponse> {
    return this.executeMutation(
      `/v1/marketplace/reports/${pathId(reportId)}/dispositions`,
      request,
      CloudMarketplaceReportDispositionRequestSchema,
      CloudMarketplaceReportResponseSchema,
      200,
      options,
    );
  }

  public disposeAppeal(
    appealId: string,
    request: CloudMarketplaceAppealDispositionRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceAppealResponse> {
    return this.executeMutation(
      `/v1/marketplace/appeals/${pathId(appealId)}/dispositions`,
      request,
      CloudMarketplaceAppealDispositionRequestSchema,
      CloudMarketplaceAppealResponseSchema,
      200,
      options,
    );
  }

  public download(
    artifactId: string,
    request: CloudMarketplaceDownloadRequest,
    options: CloudMarketplaceMutationOptions,
  ): Promise<CloudMarketplaceDownloadResponse> {
    return this.executeMutation(
      `/v1/marketplace/artifacts/${pathId(artifactId)}/downloads`,
      request,
      CloudMarketplaceDownloadRequestSchema,
      CloudMarketplaceDownloadResponseSchema,
      200,
      options,
    );
  }

  public listModerationQueue(
    options: CloudMarketplaceQueryOptions = {},
  ): Promise<CloudMarketplaceModerationQueueResponse> {
    return this.execute({
      body: null,
      expectedStatus: 200,
      inputSchema: null,
      method: "GET",
      outputSchema: CloudMarketplaceModerationQueueResponseSchema,
      path: `/v1/marketplace/moderation/queue${buildQuery({
        cursor: normalizeCursor(options.cursor),
        limit: normalizeLimit(options.limit),
      })}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private executeMutation<Input, Output>(
    path: string,
    request: Input,
    inputSchema: RuntimeSchema<Input>,
    outputSchema: RuntimeSchema<Output>,
    expectedStatus: number,
    options: CloudMarketplaceMutationOptions,
  ): Promise<Output> {
    return this.execute({
      body: request,
      expectedStatus,
      idempotencyKey: options.idempotencyKey,
      inputSchema,
      method: "POST",
      outputSchema,
      path,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private async execute<Input, Output>(options: ExecuteOptions<Input, Output>): Promise<Output> {
    const requestId = requireRequestId(this.requestIdFactory());
    const body =
      options.inputSchema === null
        ? null
        : parseInput(options.inputSchema, options.body, requestId);
    const headers: Record<string, string> = { "X-Request-Id": requestId };
    if (options.method === "GET") {
      if (options.idempotencyKey !== undefined) {
        throw requestError("Marketplace reads cannot use idempotency keys.", requestId);
      }
    } else {
      const key = CloudIdempotencyKeySchema.safeParse(options.idempotencyKey);
      if (!key.success) {
        throw requestError("Marketplace mutations require a stable idempotency key.", requestId);
      }
      headers["Idempotency-Key"] = key.data;
    }
    if (this.transport.handlesSessionAuthentication !== true) {
      headers.Authorization = `Bearer ${await this.readAccessToken(requestId)}`;
    }

    let response: CloudTransportResponse;
    try {
      response = await this.transport.send({
        method: options.method,
        path: options.path,
        authentication: "session",
        headers,
        body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause: unknown) {
      if (isCloudClientError(cause)) {
        throw cause;
      }
      throw new CloudClientError({
        actions: ["RETRY", "USE_LOCAL"],
        causeType: cause instanceof Error ? cause.name : "UnknownError",
        code: "CLOUD_NETWORK_UNAVAILABLE",
        message: "The marketplace service could not be reached.",
        requestId,
        retryable: true,
        status: null,
      });
    }
    if (response.status !== options.expectedStatus) {
      throw parseServerError(response, requestId);
    }
    const correlatedRequestId = response.headers["x-request-id"];
    if (correlatedRequestId !== undefined && correlatedRequestId !== requestId) {
      throw protocolError("Marketplace response request correlation did not match.", requestId);
    }
    const parsed = options.outputSchema.safeParse(response.body);
    if (
      !parsed.success ||
      typeof parsed.data !== "object" ||
      parsed.data === null ||
      !("requestId" in parsed.data) ||
      parsed.data.requestId !== requestId
    ) {
      throw protocolError("Marketplace response violated its published contract.", requestId);
    }
    return parsed.data;
  }

  private async readAccessToken(requestId: string): Promise<string> {
    if (this.accessTokens === null) {
      throw authenticationRequired(requestId, null);
    }
    let token: string | null;
    try {
      token = await this.accessTokens.readAccessToken();
    } catch (cause: unknown) {
      throw authenticationRequired(requestId, cause instanceof Error ? cause.name : "UnknownError");
    }
    const parsed = CloudOpaqueTokenSchema.safeParse(token);
    if (!parsed.success) {
      throw authenticationRequired(requestId, null);
    }
    return parsed.data;
  }
}

function parseInput<Output>(
  schema: RuntimeSchema<Output>,
  value: unknown,
  requestId: string,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw requestError("Marketplace request violated its published contract.", requestId);
  }
  return parsed.data;
}

function pathId(value: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw requestError("Marketplace route identifiers must be UUIDv7 values.", null);
  }
  return encodeURIComponent(parsed.data);
}

function normalizeCursor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = CloudCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw requestError("Marketplace cursor is invalid.", null);
  }
  return parsed.data;
}

function normalizeLimit(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw requestError("Marketplace page size is invalid.", null);
  }
  return value;
}

function buildQuery(values: Readonly<Record<string, string | number | null>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value !== null) {
      query.set(name, String(value));
    }
  }
  const serialized = query.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

function parseServerError(response: CloudTransportResponse, requestId: string): CloudClientError {
  const parsed = CloudApiErrorResponseSchema.safeParse(response.body);
  if (!parsed.success || parsed.data.requestId !== requestId) {
    return protocolError("Marketplace error response violated its published contract.", requestId);
  }
  return new CloudClientError({
    actions: parsed.data.error.actions,
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    requestId,
    retryable: parsed.data.error.retryable,
    status: response.status,
    supportId: parsed.data.error.supportId,
  });
}

function requireRequestId(value: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw new CloudClientError({
      code: "CLOUD_CONFIGURATION_INVALID",
      message: "Marketplace request-id generation violated the UUIDv7 contract.",
      requestId: null,
      retryable: false,
      status: null,
    });
  }
  return parsed.data;
}

function requestError(message: string, requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_REQUEST_INVALID",
    message,
    requestId,
    retryable: false,
    status: null,
  });
}

function protocolError(message: string, requestId: string): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    message,
    requestId,
    retryable: false,
    status: null,
  });
}

function authenticationRequired(requestId: string, causeType: string | null): CloudClientError {
  return new CloudClientError({
    actions: ["REAUTHENTICATE"],
    causeType,
    code: "CLOUD_AUTHENTICATION_REQUIRED",
    message: "Marketplace access requires an active cloud session.",
    requestId,
    retryable: false,
    status: null,
  });
}
