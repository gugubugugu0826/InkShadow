import type { CloudApiErrorCode } from "@inkshadow/contracts";

export type CloudClientLocalErrorCode =
  | "CLOUD_AUTHENTICATION_REQUIRED"
  | "CLOUD_CONFIGURATION_INVALID"
  | "CLOUD_NETWORK_UNAVAILABLE"
  | "CLOUD_PROTOCOL_INVALID_RESPONSE"
  | "CLOUD_REQUEST_ABORTED"
  | "CLOUD_REQUEST_INVALID"
  | "CLOUD_REQUEST_TIMEOUT"
  | "CLOUD_RESPONSE_TOO_LARGE";

export type CloudClientErrorCode = CloudApiErrorCode | CloudClientLocalErrorCode;

export interface CloudClientErrorInput {
  readonly code: CloudClientErrorCode;
  readonly message: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly actions?: readonly string[];
  readonly supportId?: string | null;
  readonly causeType?: string | null;
}

export class CloudClientError extends Error {
  public readonly code: CloudClientErrorCode;
  public readonly status: number | null;
  public readonly requestId: string | null;
  public readonly retryable: boolean;
  public readonly actions: readonly string[];
  public readonly supportId: string | null;
  public readonly causeType: string | null;

  public constructor(input: CloudClientErrorInput) {
    super(input.message);
    this.name = "CloudClientError";
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryable = input.retryable;
    this.actions = Object.freeze([...(input.actions ?? [])]);
    this.supportId = input.supportId ?? null;
    this.causeType = input.causeType ?? null;
  }
}

export function isCloudClientError(value: unknown): value is CloudClientError {
  return value instanceof CloudClientError;
}
