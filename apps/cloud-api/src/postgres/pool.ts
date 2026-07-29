import { Pool, type PoolConfig } from "pg";

export interface CloudPostgresPoolOptions {
  readonly certificateAuthority?: string | undefined;
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly maximumConnections?: number;
  readonly requireTls?: boolean;
}

export function createCloudPostgresPool(options: CloudPostgresPoolOptions): Pool {
  const connection = validateConnectionString(
    options.connectionString,
    options.requireTls !== false,
  );
  const maximumConnections = options.maximumConnections ?? 10;
  if (
    !Number.isSafeInteger(maximumConnections) ||
    maximumConnections < 1 ||
    maximumConnections > 100
  ) {
    throw new Error("Cloud PostgreSQL maximumConnections is outside the supported range.");
  }
  const config: PoolConfig = {
    connectionString: connection.connectionString,
    application_name: options.applicationName ?? "inkshadow-cloud-api",
    max: maximumConnections,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    ...(connection.tls
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(options.certificateAuthority === undefined
              ? {}
              : { ca: validateCertificateAuthority(options.certificateAuthority) }),
          },
        }
      : {}),
  };
  if (options.certificateAuthority !== undefined && !connection.tls) {
    throw new Error("A cloud PostgreSQL certificate authority requires TLS.");
  }
  return new Pool(config);
}

function validateConnectionString(
  value: string,
  requireTls: boolean,
): { readonly connectionString: string; readonly tls: boolean } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud PostgreSQL connection string is invalid.");
  }
  const postgresProtocol = url.protocol === "postgres:" || url.protocol === "postgresql:";
  if (!postgresProtocol || url.username === "" || url.hostname === "" || url.pathname === "/") {
    throw new Error("Cloud PostgreSQL connection string is incomplete.");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const explicitlyTls = ["require", "verify-ca", "verify-full"].includes(
    url.searchParams.get("sslmode") ?? "",
  );
  if (requireTls && !loopback && !explicitlyTls) {
    throw new Error("Remote cloud PostgreSQL connections must explicitly require TLS.");
  }
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), tls: explicitlyTls };
}

function validateCertificateAuthority(value: string): string {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 65_536 ||
    !value.includes("-----BEGIN CERTIFICATE-----") ||
    !value.includes("-----END CERTIFICATE-----")
  ) {
    throw new Error("Cloud PostgreSQL certificate authority PEM is invalid.");
  }
  return value;
}
