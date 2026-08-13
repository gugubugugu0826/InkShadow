import {
  MODEL_PROVIDER_KINDS,
  NOVEL_AI_TASKS,
  type ModelProviderKind,
  type NovelAiTask,
} from "./model-hub-provider-registry";

export const MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY = "inkshadow.model-hub.connection-intent.v1";
export const MODEL_HUB_CONNECTION_INTENT_TTL_MS = 30 * 60 * 1_000;

export interface ModelHubConnectionIntent {
  readonly schemaVersion: 1;
  readonly task: NovelAiTask;
  readonly providerKind: ModelProviderKind;
  readonly providerModelId: string;
  readonly catalogRegistryVersion: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SaveModelHubConnectionIntentInput {
  readonly task: NovelAiTask;
  readonly providerKind: ModelProviderKind;
  readonly providerModelId: string;
  readonly catalogRegistryVersion: string;
  readonly now: string;
}

export function saveModelHubConnectionIntent(
  storage: Storage,
  input: SaveModelHubConnectionIntentInput,
): ModelHubConnectionIntent | null {
  const createdAt = parseTimestamp(input.now);
  if (
    createdAt === null ||
    !NOVEL_AI_TASKS.includes(input.task) ||
    !MODEL_PROVIDER_KINDS.includes(input.providerKind) ||
    !isBoundedIdentifier(input.providerModelId, 160) ||
    !isBoundedIdentifier(input.catalogRegistryVersion, 96)
  ) {
    return null;
  }
  const intent = Object.freeze({
    schemaVersion: 1 as const,
    task: input.task,
    providerKind: input.providerKind,
    providerModelId: input.providerModelId,
    catalogRegistryVersion: input.catalogRegistryVersion,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + MODEL_HUB_CONNECTION_INTENT_TTL_MS).toISOString(),
  });
  try {
    storage.setItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY, JSON.stringify(intent));
    return intent;
  } catch {
    return null;
  }
}

export function loadModelHubConnectionIntent(
  storage: Storage,
  now: string,
  catalogRegistryVersion: string,
): ModelHubConnectionIntent | null {
  const nowTimestamp = parseTimestamp(now);
  if (nowTimestamp === null) return clearAndReturnNull(storage);
  let parsed: unknown;
  try {
    const serialized = storage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY);
    if (serialized === null) return null;
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return clearAndReturnNull(storage);
  }
  if (!isModelHubConnectionIntent(parsed, catalogRegistryVersion, nowTimestamp)) {
    return clearAndReturnNull(storage);
  }
  return parsed;
}

export function clearModelHubConnectionIntent(storage: Storage): void {
  try {
    storage.removeItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY);
  } catch {
    // A blocked storage backend already behaves as a fail-closed empty intent.
  }
}

function isModelHubConnectionIntent(
  value: unknown,
  catalogRegistryVersion: string,
  nowTimestamp: number,
): value is ModelHubConnectionIntent {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  const expectedKeys = [
    "catalogRegistryVersion",
    "createdAt",
    "expiresAt",
    "providerKind",
    "providerModelId",
    "schemaVersion",
    "task",
  ];
  if (Object.keys(value).sort().join("\u0000") !== expectedKeys.join("\u0000")) return false;
  if (
    typeof value.task !== "string" ||
    !NOVEL_AI_TASKS.includes(value.task as NovelAiTask) ||
    typeof value.providerKind !== "string" ||
    !MODEL_PROVIDER_KINDS.includes(value.providerKind as ModelProviderKind) ||
    !isBoundedIdentifier(value.providerModelId, 160) ||
    !isBoundedIdentifier(value.catalogRegistryVersion, 96) ||
    value.catalogRegistryVersion !== catalogRegistryVersion ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return false;
  }
  const createdAt = parseTimestamp(value.createdAt);
  const expiresAt = parseTimestamp(value.expiresAt);
  return (
    createdAt !== null &&
    expiresAt !== null &&
    expiresAt - createdAt === MODEL_HUB_CONNECTION_INTENT_TTL_MS &&
    createdAt <= nowTimestamp &&
    expiresAt > nowTimestamp
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clearAndReturnNull(storage: Storage): null {
  clearModelHubConnectionIntent(storage);
  return null;
}
