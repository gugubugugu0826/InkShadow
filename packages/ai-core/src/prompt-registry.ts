export const PROMPT_TASKS = [
  "chapter_generate",
  "selection_polish",
  "story_extract",
  "consistency_review",
  "what_if",
  "translation",
  "agent",
] as const;

export type PromptTask = (typeof PROMPT_TASKS)[number];
export type PromptVersionState = "active" | "draft" | "retired";

export interface PromptVariableDefinition {
  readonly name: string;
  readonly required: boolean;
  readonly maximumCharacters: number;
}

export interface PromptVersion {
  readonly promptId: string;
  readonly version: number;
  readonly task: PromptTask;
  readonly state: PromptVersionState;
  readonly template: string;
  readonly variables: readonly PromptVariableDefinition[];
  readonly contentHashSha256: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly changeSummary: string;
}

export interface PromptRegistrySnapshot {
  readonly promptId: string;
  readonly revision: number;
  readonly versions: readonly PromptVersion[];
}

export interface RenderedPrompt {
  readonly text: string;
  readonly trace: {
    readonly promptId: string;
    readonly version: number;
    readonly contentHashSha256: string;
    readonly task: PromptTask;
    readonly renderedVariableNames: readonly string[];
  };
}

export interface PromptActivationPlan {
  readonly promptId: string;
  readonly expectedRegistryRevision: number;
  readonly targetVersion: number;
  readonly previousActiveVersion: number | null;
  readonly kind: "activate" | "rollback";
  readonly auditEvent: "prompt_registry.activation_requested";
}

export type PromptRegistryErrorCode =
  | "PROMPT_INVALID"
  | "PROMPT_TEMPLATE_INVALID"
  | "PROMPT_VARIABLE_INVALID"
  | "PROMPT_VARIABLE_MISSING"
  | "PROMPT_VARIABLE_UNDECLARED"
  | "PROMPT_VARIABLE_TOO_LONG"
  | "PROMPT_OUTPUT_TOO_LONG"
  | "PROMPT_REGISTRY_INCONSISTENT"
  | "PROMPT_VERSION_NOT_FOUND"
  | "PROMPT_VERSION_ALREADY_ACTIVE"
  | "PROMPT_ROLLBACK_TARGET_INVALID";

export class PromptRegistryError extends Error {
  public constructor(
    readonly code: PromptRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromptRegistryError";
  }
}

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VARIABLE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const PLACEHOLDER_PATTERN = /\{\{([a-z][a-z0-9_]{0,63})\}\}/gu;
const ISO_UTC_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const MAXIMUM_TEMPLATE_CHARACTERS = 200_000;
const MAXIMUM_RENDERED_CHARACTERS = 1_000_000;

export function validatePromptVersion(value: PromptVersion): PromptVersion {
  requireIdentifier(value.promptId, "promptId");
  requireIdentifier(value.createdBy, "createdBy");
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    fail("PROMPT_INVALID", "Prompt version must be a positive safe integer.");
  }
  if (!PROMPT_TASKS.includes(value.task)) {
    fail("PROMPT_INVALID", "Prompt task is not supported.");
  }
  if (!["active", "draft", "retired"].includes(value.state)) {
    fail("PROMPT_INVALID", "Prompt state is not supported.");
  }
  if (
    value.template.length < 1 ||
    value.template.length > MAXIMUM_TEMPLATE_CHARACTERS ||
    containsUnsafeControlCharacter(value.template)
  ) {
    fail("PROMPT_TEMPLATE_INVALID", "Prompt template is empty, too large, or contains controls.");
  }
  if (!SHA256_PATTERN.test(value.contentHashSha256)) {
    fail("PROMPT_INVALID", "Prompt content hash must be a lowercase SHA-256 digest.");
  }
  if (
    !ISO_UTC_PATTERN.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.changeSummary.trim().length < 1 ||
    value.changeSummary.trim().length > 500 ||
    containsUnsafeControlCharacter(value.changeSummary)
  ) {
    fail("PROMPT_INVALID", "Prompt provenance is invalid.");
  }

  const definitions = new Map<string, PromptVariableDefinition>();
  for (const variable of value.variables) {
    if (
      !VARIABLE_PATTERN.test(variable.name) ||
      !Number.isSafeInteger(variable.maximumCharacters) ||
      variable.maximumCharacters < 1 ||
      variable.maximumCharacters > MAXIMUM_RENDERED_CHARACTERS ||
      definitions.has(variable.name)
    ) {
      fail("PROMPT_VARIABLE_INVALID", "Prompt variable definitions must be unique and bounded.");
    }
    definitions.set(variable.name, variable);
  }

  const referenced = collectPlaceholders(value.template);
  assertNoMalformedPlaceholders(value.template);
  for (const variableName of referenced) {
    if (!definitions.has(variableName)) {
      fail(
        "PROMPT_VARIABLE_UNDECLARED",
        `Prompt template references undeclared variable '${variableName}'.`,
      );
    }
  }
  for (const definition of definitions.values()) {
    if (definition.required && !referenced.includes(definition.name)) {
      fail(
        "PROMPT_VARIABLE_INVALID",
        `Required prompt variable '${definition.name}' is not used by the template.`,
      );
    }
  }
  return value;
}

export function validatePromptRegistry(snapshot: PromptRegistrySnapshot): PromptRegistrySnapshot {
  requireIdentifier(snapshot.promptId, "promptId");
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    fail("PROMPT_REGISTRY_INCONSISTENT", "Prompt registry revision must be positive.");
  }
  if (snapshot.versions.length < 1 || snapshot.versions.length > 10_000) {
    fail("PROMPT_REGISTRY_INCONSISTENT", "Prompt registry version count is invalid.");
  }

  const versionNumbers = new Set<number>();
  let activeCount = 0;
  let task: PromptTask | null = null;
  for (const version of snapshot.versions) {
    validatePromptVersion(version);
    if (version.promptId !== snapshot.promptId || versionNumbers.has(version.version)) {
      fail(
        "PROMPT_REGISTRY_INCONSISTENT",
        "Prompt versions must belong to one registry and have unique version numbers.",
      );
    }
    if (task !== null && task !== version.task) {
      fail("PROMPT_REGISTRY_INCONSISTENT", "A prompt registry cannot mix prompt tasks.");
    }
    task = version.task;
    versionNumbers.add(version.version);
    activeCount += version.state === "active" ? 1 : 0;
  }
  if (activeCount > 1) {
    fail("PROMPT_REGISTRY_INCONSISTENT", "A prompt registry can have at most one active version.");
  }
  return snapshot;
}

export function resolveActivePrompt(snapshot: PromptRegistrySnapshot): PromptVersion | null {
  validatePromptRegistry(snapshot);
  return snapshot.versions.find(({ state }) => state === "active") ?? null;
}

export function renderPromptVersion(
  versionValue: PromptVersion,
  values: Readonly<Record<string, string>>,
): RenderedPrompt {
  const version = validatePromptVersion(versionValue);
  const definitions = new Map(version.variables.map((entry) => [entry.name, entry]));
  const suppliedNames = Object.keys(values).sort();
  for (const suppliedName of suppliedNames) {
    if (!definitions.has(suppliedName)) {
      fail(
        "PROMPT_VARIABLE_UNDECLARED",
        `Prompt value '${suppliedName}' has no variable definition.`,
      );
    }
  }

  for (const definition of definitions.values()) {
    const supplied = values[definition.name];
    if (definition.required && (supplied === undefined || supplied.length === 0)) {
      fail("PROMPT_VARIABLE_MISSING", `Prompt variable '${definition.name}' is required.`);
    }
    if (supplied !== undefined) {
      if (
        supplied.length > definition.maximumCharacters ||
        containsUnsafeControlCharacter(supplied)
      ) {
        fail(
          "PROMPT_VARIABLE_TOO_LONG",
          `Prompt variable '${definition.name}' is too long or contains unsafe controls.`,
        );
      }
    }
  }

  const text = version.template.replaceAll(
    PLACEHOLDER_PATTERN,
    (_placeholder: string, name: string) => values[name] ?? "",
  );
  if (text.length > MAXIMUM_RENDERED_CHARACTERS) {
    fail("PROMPT_OUTPUT_TOO_LONG", "Rendered prompt exceeds the bounded output size.");
  }
  return {
    text,
    trace: {
      promptId: version.promptId,
      version: version.version,
      contentHashSha256: version.contentHashSha256,
      task: version.task,
      renderedVariableNames: suppliedNames,
    },
  };
}

export function planPromptActivation(
  snapshotValue: PromptRegistrySnapshot,
  targetVersion: number,
): PromptActivationPlan {
  const snapshot = validatePromptRegistry(snapshotValue);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    fail("PROMPT_VERSION_NOT_FOUND", "Prompt target version is invalid.");
  }
  const target = snapshot.versions.find(({ version }) => version === targetVersion);
  if (target === undefined) {
    fail("PROMPT_VERSION_NOT_FOUND", "Prompt target version does not exist.");
  }
  if (target.state === "active") {
    fail("PROMPT_VERSION_ALREADY_ACTIVE", "Prompt target version is already active.");
  }
  const current = snapshot.versions.find(({ state }) => state === "active") ?? null;
  const kind = target.state === "retired" ? "rollback" : "activate";
  if (
    kind === "rollback" &&
    (current === null ||
      target.version >= current.version ||
      Date.parse(target.createdAt) >= Date.parse(current.createdAt))
  ) {
    fail(
      "PROMPT_ROLLBACK_TARGET_INVALID",
      "A rollback target must be an older retired prompt version.",
    );
  }
  return {
    promptId: snapshot.promptId,
    expectedRegistryRevision: snapshot.revision,
    targetVersion,
    previousActiveVersion: current?.version ?? null,
    kind,
    auditEvent: "prompt_registry.activation_requested",
  };
}

function collectPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function assertNoMalformedPlaceholders(template: string): void {
  const withoutValidPlaceholders = template.replaceAll(PLACEHOLDER_PATTERN, "");
  if (withoutValidPlaceholders.includes("{{") || withoutValidPlaceholders.includes("}}")) {
    fail(
      "PROMPT_TEMPLATE_INVALID",
      "Prompt templates may only contain declared {{variable_name}} placeholders.",
    );
  }
}

function containsUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

function requireIdentifier(value: string, field: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail("PROMPT_INVALID", `${field} must be a bounded portable identifier.`);
  }
}

function fail(code: PromptRegistryErrorCode, message: string): never {
  throw new PromptRegistryError(code, message);
}
