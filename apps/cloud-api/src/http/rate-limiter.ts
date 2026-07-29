export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface CloudRateLimiter {
  consume(options: {
    readonly key: string;
    readonly limit: number;
    readonly now: Date;
    readonly windowMs: number;
  }): Promise<RateLimitDecision>;
}

interface WindowRecord {
  count: number;
  expiresAtMs: number;
}

export class InMemoryFixedWindowRateLimiter implements CloudRateLimiter {
  private readonly records = new Map<string, WindowRecord>();

  public constructor(private readonly maximumEntries = 100_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("The rate-limiter entry bound must be a positive integer.");
    }
  }

  public consume(options: {
    readonly key: string;
    readonly limit: number;
    readonly now: Date;
    readonly windowMs: number;
  }): Promise<RateLimitDecision> {
    validateOptions(options);
    const nowMs = options.now.getTime();
    let record = this.records.get(options.key);
    if (record === undefined || record.expiresAtMs <= nowMs) {
      if (this.records.size >= this.maximumEntries) {
        this.removeExpired(nowMs);
      }
      if (this.records.size >= this.maximumEntries) {
        return Promise.resolve({
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(options.windowMs / 1_000)),
        });
      }
      record = { count: 0, expiresAtMs: nowMs + options.windowMs };
      this.records.set(options.key, record);
    }
    record.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((record.expiresAtMs - nowMs) / 1_000));
    return Promise.resolve({
      allowed: record.count <= options.limit,
      retryAfterSeconds: record.count <= options.limit ? 0 : retryAfterSeconds,
    });
  }

  private removeExpired(nowMs: number): void {
    for (const [key, record] of this.records) {
      if (record.expiresAtMs <= nowMs) {
        this.records.delete(key);
      }
    }
  }
}

function validateOptions(options: {
  readonly key: string;
  readonly limit: number;
  readonly now: Date;
  readonly windowMs: number;
}): void {
  if (options.key.length < 1 || options.key.length > 1_024) {
    throw new Error("The rate-limit key is invalid.");
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000_000) {
    throw new Error("The rate limit is invalid.");
  }
  if (
    !Number.isSafeInteger(options.windowMs) ||
    options.windowMs < 1_000 ||
    options.windowMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error("The rate-limit window is invalid.");
  }
  if (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) {
    throw new Error("The rate-limit clock is invalid.");
  }
}
