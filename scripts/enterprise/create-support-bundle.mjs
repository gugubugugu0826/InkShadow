import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const ROUTE_TEMPLATE = /^\/[A-Za-z0-9./:_-]{1,255}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const MAXIMUM_INPUT_BYTES = 1024 * 1024;

export function createSupportBundle(input, now = new Date()) {
  requireRecord(input, "diagnostic input");
  exactKeys(input, [
    "schemaVersion",
    "appVersion",
    "deploymentMode",
    "configuration",
    "health",
    "errorCounts",
    "recentEvents",
  ]);
  if (
    input.schemaVersion !== 1 ||
    typeof input.appVersion !== "string" ||
    !SEMVER.test(input.appVersion) ||
    !["hosted", "private"].includes(input.deploymentMode)
  ) {
    fail("Diagnostic identity fields are invalid.");
  }
  const configuration = validateConfiguration(input.configuration);
  const health = validateHealth(input.health);
  const errorCounts = validateErrorCounts(input.errorCounts);
  const recentEvents = validateRecentEvents(input.recentEvents);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("The support-bundle clock is invalid.");
  }
  return {
    schemaVersion: 1,
    supportId: randomUUID(),
    generatedAt: now.toISOString(),
    appVersion: input.appVersion,
    deploymentMode: input.deploymentMode,
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
    },
    configuration,
    health,
    errorCounts,
    recentEvents,
    exclusions: [
      "api_keys",
      "authorization_headers",
      "database_urls",
      "device_private_keys",
      "emails",
      "file_contents",
      "full_prompts",
      "oidc_tokens",
      "passwords",
      "personal_paths",
      "project_prose",
      "recovery_codes",
    ],
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputPath = options.get("input");
  const outputPath = options.get("output");
  if (inputPath === undefined || outputPath === undefined || options.size !== 2) {
    fail("Usage: node create-support-bundle.mjs --input <snapshot.json> --output <bundle.json>");
  }
  const inputBuffer = await readFile(path.resolve(inputPath));
  if (inputBuffer.length > MAXIMUM_INPUT_BYTES) {
    fail("Diagnostic input exceeds the 1 MiB limit.");
  }
  let input;
  try {
    input = JSON.parse(inputBuffer.toString("utf8"));
  } catch {
    fail("Diagnostic input is not valid JSON.");
  }
  const bundle = createSupportBundle(input);
  await writeFile(path.resolve(outputPath), `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`Support bundle ${bundle.supportId} created.\n`);
}

function validateConfiguration(value) {
  requireRecord(value, "configuration");
  exactKeys(value, [
    "databaseTlsRequired",
    "httpsRequired",
    "minimumClientVersion",
    "oidcProviderCount",
    "licensedTeamCount",
    "teamInvitationDeliveryConfigured",
  ]);
  if (
    typeof value.databaseTlsRequired !== "boolean" ||
    typeof value.httpsRequired !== "boolean" ||
    typeof value.teamInvitationDeliveryConfigured !== "boolean" ||
    typeof value.minimumClientVersion !== "string" ||
    !SEMVER.test(value.minimumClientVersion)
  ) {
    fail("Diagnostic configuration fields are invalid.");
  }
  return {
    databaseTlsRequired: value.databaseTlsRequired,
    httpsRequired: value.httpsRequired,
    minimumClientVersion: value.minimumClientVersion,
    oidcProviderCount: boundedInteger(value.oidcProviderCount, 0, 64, "oidcProviderCount"),
    licensedTeamCount: boundedInteger(value.licensedTeamCount, 0, 1024, "licensedTeamCount"),
    teamInvitationDeliveryConfigured: value.teamInvitationDeliveryConfigured,
  };
}

function validateHealth(value) {
  requireRecord(value, "health");
  exactKeys(value, [
    "ready",
    "postgresIdleConnections",
    "postgresTotalConnections",
    "postgresWaitingRequests",
  ]);
  if (typeof value.ready !== "boolean") {
    fail("Diagnostic health readiness is invalid.");
  }
  return {
    ready: value.ready,
    postgresIdleConnections: boundedInteger(
      value.postgresIdleConnections,
      0,
      10_000,
      "postgresIdleConnections",
    ),
    postgresTotalConnections: boundedInteger(
      value.postgresTotalConnections,
      0,
      10_000,
      "postgresTotalConnections",
    ),
    postgresWaitingRequests: boundedInteger(
      value.postgresWaitingRequests,
      0,
      100_000,
      "postgresWaitingRequests",
    ),
  };
}

function validateErrorCounts(value) {
  if (!Array.isArray(value) || value.length > 256) {
    fail("Diagnostic error counts are invalid.");
  }
  const seen = new Set();
  return value.map((entry) => {
    requireRecord(entry, "error count");
    exactKeys(entry, ["code", "count"]);
    if (typeof entry.code !== "string" || !ERROR_CODE.test(entry.code) || seen.has(entry.code)) {
      fail("Diagnostic error code is invalid or duplicated.");
    }
    seen.add(entry.code);
    return {
      code: entry.code,
      count: boundedInteger(entry.count, 0, Number.MAX_SAFE_INTEGER, "error count"),
    };
  });
}

function validateRecentEvents(value) {
  if (!Array.isArray(value) || value.length > 500) {
    fail("Diagnostic recent events are invalid.");
  }
  return value.map((entry) => {
    requireRecord(entry, "recent event");
    exactKeys(entry, ["at", "requestId", "code", "route", "durationMs"]);
    if (
      typeof entry.at !== "string" ||
      !ISO_UTC.test(entry.at) ||
      !Number.isFinite(Date.parse(entry.at)) ||
      typeof entry.requestId !== "string" ||
      !UUID_V7.test(entry.requestId) ||
      typeof entry.code !== "string" ||
      !ERROR_CODE.test(entry.code) ||
      typeof entry.route !== "string" ||
      !isSafeRouteTemplate(entry.route)
    ) {
      fail("A diagnostic recent event is invalid.");
    }
    return {
      at: new Date(entry.at).toISOString(),
      requestId: entry.requestId,
      code: entry.code,
      route: entry.route,
      durationMs: boundedInteger(entry.durationMs, 0, 3_600_000, "durationMs"),
    };
  });
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail("Diagnostic data contains an unsupported field.");
  }
}

function isSafeRouteTemplate(value) {
  if (!ROUTE_TEMPLATE.test(value) || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  return value
    .slice(1)
    .split("/")
    .every((segment) => {
      if (segment.startsWith(":")) {
        return /^:[A-Za-z][A-Za-z0-9]*$/u.test(segment);
      }
      return (
        /^[a-z][a-z0-9-]*$/u.test(segment) &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          segment,
        ) &&
        !/^[A-Za-z0-9_-]{32,}$/u.test(segment)
      );
    });
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside the supported range.`);
  }
  return value;
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("Arguments must use --name value pairs.");
    }
    const normalized = name.slice(2);
    if (parsed.has(normalized)) {
      fail(`Duplicate --${normalized}.`);
    }
    parsed.set(normalized, value);
  }
  return parsed;
}

function fail(message) {
  throw new Error(message);
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Support bundle generation failed."}\n`,
    );
    process.exitCode = 1;
  });
}
