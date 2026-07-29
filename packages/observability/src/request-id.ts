const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type RequestIdFactory = () => string;

export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export function createRequestId(
  factory: RequestIdFactory = () => globalThis.crypto.randomUUID(),
): string {
  const requestId = factory();
  if (!isValidRequestId(requestId)) {
    throw new Error("Request ID factories must return a safe opaque identifier.");
  }
  return requestId;
}

export function resolveRequestId(
  candidate: string | null | undefined,
  factory?: RequestIdFactory,
): string {
  if (candidate !== null && candidate !== undefined && isValidRequestId(candidate)) {
    return candidate;
  }
  return createRequestId(factory);
}
