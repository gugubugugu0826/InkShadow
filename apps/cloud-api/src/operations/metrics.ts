export interface CloudPostgresPoolSnapshot {
  readonly idleConnections: number;
  readonly totalConnections: number;
  readonly waitingRequests: number;
}

export interface CloudMetricsRegistryOptions {
  readonly clock?: () => Date;
  readonly deploymentMode: "hosted" | "private";
  readonly licenseExpiryTimestampSeconds?: number | null;
  readonly licenseNotBeforeTimestampSeconds?: number | null;
  readonly poolSnapshot?: () => CloudPostgresPoolSnapshot;
}

interface RequestMetric {
  count: number;
  durationSeconds: number;
}

export class CloudMetricsRegistry {
  private readonly clock: () => Date;
  private readonly deploymentMode: "hosted" | "private";
  private readonly licenseExpiryTimestampSeconds: number | null;
  private readonly licenseNotBeforeTimestampSeconds: number | null;
  private readonly poolSnapshot: (() => CloudPostgresPoolSnapshot) | null;
  private readonly startedAtMs: number;
  private readonly requests = new Map<string, RequestMetric>();
  private ready = false;

  public constructor(options: CloudMetricsRegistryOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.deploymentMode = options.deploymentMode;
    this.licenseExpiryTimestampSeconds = options.licenseExpiryTimestampSeconds ?? null;
    this.licenseNotBeforeTimestampSeconds = options.licenseNotBeforeTimestampSeconds ?? null;
    this.poolSnapshot = options.poolSnapshot ?? null;
    this.startedAtMs = this.nowMs();
  }

  public setReady(ready: boolean): void {
    this.ready = ready;
  }

  public observeRequest(input: {
    readonly durationMs: number;
    readonly method: string;
    readonly route: string;
    readonly status: number;
  }): void {
    if (
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0 ||
      !Number.isSafeInteger(input.status)
    ) {
      return;
    }
    const method = safeLabel(input.method.toUpperCase(), "UNKNOWN");
    const route = safeRouteLabel(input.route);
    const statusClass =
      input.status >= 100 && input.status <= 599
        ? `${String(Math.floor(input.status / 100))}xx`
        : "unknown";
    const key = `${method}\u0000${route}\u0000${statusClass}`;
    const metric = this.requests.get(key) ?? { count: 0, durationSeconds: 0 };
    metric.count += 1;
    metric.durationSeconds += input.durationMs / 1_000;
    this.requests.set(key, metric);
  }

  public render(): string {
    const lines = [
      "# HELP inkshadow_build_info Static deployment information.",
      "# TYPE inkshadow_build_info gauge",
      `inkshadow_build_info{deployment_mode="${this.deploymentMode}"} 1`,
      "# HELP inkshadow_process_uptime_seconds Process uptime in seconds.",
      "# TYPE inkshadow_process_uptime_seconds gauge",
      `inkshadow_process_uptime_seconds ${formatNumber(
        Math.max(0, this.nowMs() - this.startedAtMs) / 1_000,
      )}`,
      "# HELP inkshadow_ready Whether readiness checks are currently passing.",
      "# TYPE inkshadow_ready gauge",
      `inkshadow_ready ${this.ready ? "1" : "0"}`,
      "# HELP inkshadow_http_requests_total Completed HTTP requests.",
      "# TYPE inkshadow_http_requests_total counter",
      "# HELP inkshadow_http_request_duration_seconds_sum Total HTTP request duration.",
      "# TYPE inkshadow_http_request_duration_seconds_sum counter",
      "# HELP inkshadow_http_request_duration_seconds_count Observed HTTP request count.",
      "# TYPE inkshadow_http_request_duration_seconds_count counter",
    ];
    if (this.licenseExpiryTimestampSeconds !== null) {
      lines.push(
        "# HELP inkshadow_enterprise_license_expiry_timestamp_seconds Enterprise license expiry as Unix time.",
      );
      lines.push("# TYPE inkshadow_enterprise_license_expiry_timestamp_seconds gauge");
      lines.push(
        `inkshadow_enterprise_license_expiry_timestamp_seconds ${formatNumber(
          this.licenseExpiryTimestampSeconds,
        )}`,
      );
      lines.push(
        "# HELP inkshadow_enterprise_license_valid Whether the license is inside its signed validity window.",
      );
      lines.push("# TYPE inkshadow_enterprise_license_valid gauge");
      const nowSeconds = this.nowMs() / 1_000;
      lines.push(
        `inkshadow_enterprise_license_valid ${
          (this.licenseNotBeforeTimestampSeconds === null ||
            nowSeconds >= this.licenseNotBeforeTimestampSeconds) &&
          nowSeconds <= this.licenseExpiryTimestampSeconds
            ? "1"
            : "0"
        }`,
      );
    }
    for (const [key, metric] of [...this.requests.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const [method = "UNKNOWN", route = "unknown", statusClass = "unknown"] = key.split("\u0000");
      const labels = `method="${method}",route="${route}",status_class="${statusClass}"`;
      lines.push(`inkshadow_http_requests_total{${labels}} ${String(metric.count)}`);
      lines.push(
        `inkshadow_http_request_duration_seconds_sum{${labels}} ${formatNumber(
          metric.durationSeconds,
        )}`,
      );
      lines.push(
        `inkshadow_http_request_duration_seconds_count{${labels}} ${String(metric.count)}`,
      );
    }
    const pool = this.poolSnapshot?.();
    if (pool !== undefined) {
      lines.push("# HELP inkshadow_postgres_connections PostgreSQL pool connections.");
      lines.push("# TYPE inkshadow_postgres_connections gauge");
      lines.push(
        `inkshadow_postgres_connections{state="total"} ${formatInteger(pool.totalConnections)}`,
      );
      lines.push(
        `inkshadow_postgres_connections{state="idle"} ${formatInteger(pool.idleConnections)}`,
      );
      lines.push(
        `inkshadow_postgres_connections{state="waiting"} ${formatInteger(pool.waitingRequests)}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private nowMs(): number {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The metrics clock returned an invalid time.");
    }
    return value.getTime();
  }
}

function safeRouteLabel(value: string): string {
  const segments = value.split("/");
  if (
    value.length >= 1 &&
    value.length <= 256 &&
    /^\/[A-Za-z0-9_./:{}-]*$/u.test(value) &&
    !segments.some(
      (segment) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          segment,
        ) || /^[A-Za-z0-9_-]{32,}$/u.test(segment),
    )
  ) {
    return value;
  }
  return "unknown";
}

function safeLabel(value: string, fallback: string): string {
  return /^[A-Z]{2,12}$/u.test(value) ? value : fallback;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/\.?0+$/u, "") || "0" : "0";
}

function formatInteger(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "0";
}
