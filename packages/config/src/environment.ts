import { z } from "zod";

const environmentBooleanSchema = z.preprocess((value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const syncApiUrlSchema = z.url().refine(
  (value: string) => {
    const url = new URL(value);
    const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
  },
  {
    message: "Sync API URLs must use HTTPS, except for loopback development.",
  },
);

export const runtimeEnvironmentSchema = z
  .object({
    appEnvironment: z.enum(["development", "test", "production"]).default("development"),
    logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
    telemetryEnabled: environmentBooleanSchema.default(false),
    updateChannel: z.enum(["stable", "beta", "nightly"]).default("stable"),
    syncApiUrl: syncApiUrlSchema.optional(),
    localServiceHost: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
    localServicePort: z.coerce.number().int().min(1024).max(65_535).default(32_787),
  })
  .strict();

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function parseRuntimeEnvironment(source: EnvironmentSource): RuntimeEnvironment {
  return runtimeEnvironmentSchema.parse({
    appEnvironment: source.INKSHADOW_APP_ENV,
    logLevel: source.INKSHADOW_LOG_LEVEL,
    telemetryEnabled: source.INKSHADOW_TELEMETRY_ENABLED,
    updateChannel: source.INKSHADOW_UPDATE_CHANNEL,
    syncApiUrl: source.INKSHADOW_SYNC_API_URL,
    localServiceHost: source.INKSHADOW_LOCAL_SERVICE_HOST,
    localServicePort: source.INKSHADOW_LOCAL_SERVICE_PORT,
  });
}
