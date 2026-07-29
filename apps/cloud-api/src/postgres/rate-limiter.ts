import type { Pool } from "pg";

import type { CloudRateLimiter, RateLimitDecision } from "../http/rate-limiter.js";
import { hashUtf8 } from "../security/canonical-hash.js";

export class PostgresFixedWindowRateLimiter implements CloudRateLimiter {
  public constructor(private readonly pool: Pool) {}

  public async consume(options: {
    readonly key: string;
    readonly limit: number;
    readonly now: Date;
    readonly windowMs: number;
  }): Promise<RateLimitDecision> {
    validateOptions(options);
    const result = await this.pool.query<{
      expires_at: Date;
      request_count: number;
    }>(
      `INSERT INTO cloud_rate_limit_windows (
         key_hash_sha256,
         request_count,
         window_started_at,
         expires_at
       ) VALUES ($1, 1, $2, $3)
       ON CONFLICT (key_hash_sha256) DO UPDATE
       SET request_count = CASE
             WHEN cloud_rate_limit_windows.expires_at <= EXCLUDED.window_started_at
               THEN 1
             ELSE LEAST(cloud_rate_limit_windows.request_count + 1, 1000001)
           END,
           window_started_at = CASE
             WHEN cloud_rate_limit_windows.expires_at <= EXCLUDED.window_started_at
               THEN EXCLUDED.window_started_at
             ELSE cloud_rate_limit_windows.window_started_at
           END,
           expires_at = CASE
             WHEN cloud_rate_limit_windows.expires_at <= EXCLUDED.window_started_at
               THEN EXCLUDED.expires_at
             ELSE cloud_rate_limit_windows.expires_at
           END
       RETURNING request_count, expires_at`,
      [hashUtf8(options.key), options.now, new Date(options.now.getTime() + options.windowMs)],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      !Number.isSafeInteger(row.request_count) ||
      !(row.expires_at instanceof Date) ||
      !Number.isFinite(row.expires_at.getTime())
    ) {
      throw new Error("PostgreSQL returned an invalid rate-limit window.");
    }
    const allowed = row.request_count <= options.limit;
    return {
      allowed,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((row.expires_at.getTime() - options.now.getTime()) / 1_000)),
    };
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
