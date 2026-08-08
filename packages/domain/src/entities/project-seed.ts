export const PROJECT_SEED_VERSION = 1 as const;

export const PROJECT_SEED_FIELD_KEYS = [
  "premise",
  "genre",
  "tone",
  "characters",
  "relationships",
  "world",
  "conflict",
  "style",
  "pov",
  "boundaries",
  "currentDirection",
  "initialOutline",
  "rewriteRules",
] as const;

export type ProjectSeedFieldKey = (typeof PROJECT_SEED_FIELD_KEYS)[number];
export type ProjectSeedJourneyKind = "idea" | "import" | "professional";
export type ProjectSeedSource =
  "user_input" | "imported_text" | "import_analysis" | "professional_setup" | "ai_inference";
export type ProjectSeedConfirmation = "confirmed" | "unconfirmed" | "skipped";

export interface ProjectSeedField {
  readonly values: readonly string[];
  readonly source: ProjectSeedSource | null;
  readonly confirmation: ProjectSeedConfirmation;
  readonly origin: string | null;
  readonly updatedAt: string;
}

/**
 * The shared, resumable input aggregate for all three creation entrances.
 *
 * A field deliberately keeps provenance and confirmation next to its values. An empty field is
 * not the same as a skipped field, and an inference can never be mistaken for a user decision.
 */
export interface ProjectSeed {
  readonly version: typeof PROJECT_SEED_VERSION;
  readonly seedId: string;
  readonly journeyKind: ProjectSeedJourneyKind;
  readonly premise: ProjectSeedField;
  readonly genre: ProjectSeedField;
  readonly tone: ProjectSeedField;
  readonly characters: ProjectSeedField;
  readonly relationships: ProjectSeedField;
  readonly world: ProjectSeedField;
  readonly conflict: ProjectSeedField;
  readonly style: ProjectSeedField;
  readonly pov: ProjectSeedField;
  readonly boundaries: ProjectSeedField;
  readonly currentDirection: ProjectSeedField;
  readonly initialOutline: ProjectSeedField;
  readonly rewriteRules: ProjectSeedField;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectSeedRecord {
  readonly projectId: string;
  readonly seed: ProjectSeed;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Project-owned persistence for the creation seed once a real project exists.
 *
 * Journey snapshots remain the recovery authority before project creation. Implementations must
 * reject malformed seeds and must not let an older async write replace a newer seed revision.
 */
export interface ProjectSeedStore {
  findByProjectId(projectId: string): Promise<ProjectSeedRecord | null>;
  saveForProject(projectId: string, seed: ProjectSeed): Promise<ProjectSeedRecord>;
}

export interface ProjectSeedFieldUpdate {
  readonly values: string | readonly string[];
  readonly source: ProjectSeedSource | null;
  readonly confirmation: ProjectSeedConfirmation;
  readonly origin: string | null;
  readonly updatedAt: string;
}

export function createProjectSeed(
  input: Readonly<{
    seedId: string;
    journeyKind: ProjectSeedJourneyKind;
    now: string;
    premise?: string;
    premiseSource?: ProjectSeedSource;
    premiseConfirmation?: ProjectSeedConfirmation;
  }>,
): ProjectSeed {
  const seedId = normalizeIdentifier(input.seedId, "ProjectSeed id");
  const now = requireIsoTimestamp(input.now);
  const fields = Object.fromEntries(
    PROJECT_SEED_FIELD_KEYS.map((key) => [key, emptyField(now)]),
  ) as Record<ProjectSeedFieldKey, ProjectSeedField>;
  const premise = normalizeText(input.premise ?? "");
  if (premise.length > 0) {
    fields.premise = makeField({
      values: premise,
      source: input.premiseSource ?? "user_input",
      confirmation: input.premiseConfirmation ?? "confirmed",
      origin: "premise",
      updatedAt: now,
    });
  }
  return freezeSeed({
    version: PROJECT_SEED_VERSION,
    seedId,
    journeyKind: input.journeyKind,
    ...fields,
    createdAt: now,
    updatedAt: now,
  });
}

export function updateProjectSeedField(
  seedValue: ProjectSeed,
  key: ProjectSeedFieldKey,
  update: ProjectSeedFieldUpdate,
): ProjectSeed {
  const seed = requireProjectSeed(seedValue);
  const field = makeField(update);
  if (field.updatedAt < seed.createdAt) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_TIMESTAMP_INVALID",
      "ProjectSeed field cannot predate its seed.",
    );
  }
  return freezeSeed({
    ...seed,
    [key]: field,
    updatedAt: field.updatedAt >= seed.updatedAt ? field.updatedAt : seed.updatedAt,
  });
}

export function deriveIdeaProjectSeed(
  input: Readonly<{
    seedId: string;
    idea: string;
    answers: Readonly<Record<string, string>>;
    skippedQuestionKeys: readonly string[];
    now: string;
    existing?: ProjectSeed | null;
  }>,
): ProjectSeed {
  let seed =
    input.existing === undefined || input.existing === null
      ? createProjectSeed({
          seedId: input.seedId,
          journeyKind: "idea",
          now: input.now,
          premise: input.idea,
        })
      : requireProjectSeed(input.existing);
  seed = replacePremise(seed, input.idea, "user_input", "confirmed", "idea", input.now);

  const mappings: readonly (readonly [string, ProjectSeedFieldKey])[] = [
    ["genre", "genre"],
    ["tone", "tone"],
    ["protagonist", "characters"],
    ["relationship", "relationships"],
    ["world", "world"],
    ["conflict", "conflict"],
    ["style", "style"],
    ["pov", "pov"],
    ["boundaries", "boundaries"],
    ["outline", "initialOutline"],
  ];
  for (const [questionKey, fieldKey] of mappings) {
    seed = applyJourneyAnswer(seed, fieldKey, questionKey, input, input.now);
  }

  const directionKey =
    normalizeText(input.answers.direction ?? "").length > 0 ? "direction" : "opening_direction";
  seed = applyJourneyAnswer(seed, "currentDirection", directionKey, input, input.now);
  if (
    seed.initialOutline.values.length === 0 &&
    normalizeText(input.answers.direction ?? "").length > 0
  ) {
    seed = updateProjectSeedField(seed, "initialOutline", {
      values: input.answers.direction ?? "",
      source: "user_input",
      confirmation: "confirmed",
      origin: "question:direction",
      updatedAt: input.now,
    });
  }

  if (seed.genre.values.length === 0 && !input.skippedQuestionKeys.includes("genre")) {
    const inferredGenre = inferGenreFromPremise(input.idea);
    if (inferredGenre !== null) {
      seed = updateProjectSeedField(seed, "genre", {
        values: inferredGenre,
        source: "user_input",
        confirmation: "unconfirmed",
        origin: "premise_keyword",
        updatedAt: input.now,
      });
    }
  }
  return seed;
}

export function deriveImportProjectSeed(
  input: Readonly<{
    seedId: string;
    projectName: string;
    goal: string;
    presetLabels: readonly string[];
    rewriteRules: readonly string[];
    now: string;
    existing?: ProjectSeed | null;
  }>,
): ProjectSeed {
  let seed =
    input.existing === undefined || input.existing === null
      ? createProjectSeed({
          seedId: input.seedId,
          journeyKind: "import",
          now: input.now,
          premise: input.projectName,
          premiseSource: "imported_text",
        })
      : requireProjectSeed(input.existing);
  seed = replacePremise(
    seed,
    input.projectName,
    "imported_text",
    "confirmed",
    "imported_project_name",
    input.now,
  );
  const directions = uniqueTexts([input.goal, ...input.presetLabels]);
  seed = updateProjectSeedField(seed, "currentDirection", {
    values: directions,
    source: directions.length === 0 ? null : "user_input",
    confirmation: directions.length === 0 ? "unconfirmed" : "confirmed",
    origin: directions.length === 0 ? null : "rewrite_goal",
    updatedAt: input.now,
  });
  seed = updateProjectSeedField(seed, "rewriteRules", {
    values: input.rewriteRules,
    source: input.rewriteRules.length === 0 ? null : "user_input",
    confirmation: input.rewriteRules.length === 0 ? "unconfirmed" : "confirmed",
    origin: input.rewriteRules.length === 0 ? null : "rewrite_rules",
    updatedAt: input.now,
  });
  return seed;
}

export function deriveProfessionalProjectSeed(
  input: Readonly<{
    seedId: string;
    projectName: string;
    storyDirection: string;
    outlineSynopsis: string;
    protagonist: string;
    relationship: string;
    worldBackground: string;
    pov: string;
    style: string;
    boundaries: string;
    now: string;
    existing?: ProjectSeed | null;
  }>,
): ProjectSeed {
  let seed =
    input.existing === undefined || input.existing === null
      ? createProjectSeed({
          seedId: input.seedId,
          journeyKind: "professional",
          now: input.now,
          premise: input.storyDirection || input.projectName,
          premiseSource: "professional_setup",
        })
      : requireProjectSeed(input.existing);
  seed = replacePremise(
    seed,
    input.storyDirection || input.projectName,
    "professional_setup",
    "confirmed",
    "professional_setup",
    input.now,
  );
  const values: readonly (readonly [ProjectSeedFieldKey, string, string])[] = [
    ["currentDirection", input.storyDirection, "professional_setup.story_direction"],
    ["initialOutline", input.outlineSynopsis, "professional_setup.outline"],
    ["characters", input.protagonist, "professional_setup.protagonist"],
    ["relationships", input.relationship, "professional_setup.relationship"],
    ["world", input.worldBackground, "professional_setup.world"],
    ["pov", input.pov, "professional_setup.pov"],
    ["style", input.style, "professional_setup.style"],
    ["boundaries", input.boundaries, "professional_setup.boundaries"],
  ];
  for (const [field, value, origin] of values) {
    const normalized = normalizeText(value);
    seed = updateProjectSeedField(seed, field, {
      values: normalized,
      source: normalized.length === 0 ? null : "professional_setup",
      confirmation: normalized.length === 0 ? "unconfirmed" : "confirmed",
      origin: normalized.length === 0 ? null : origin,
      updatedAt: input.now,
    });
  }
  return seed;
}

export function parseProjectSeed(value: unknown): ProjectSeed | null {
  try {
    return requireProjectSeed(value);
  } catch {
    return null;
  }
}

function applyJourneyAnswer(
  seed: ProjectSeed,
  fieldKey: ProjectSeedFieldKey,
  questionKey: string,
  input: Readonly<{
    answers: Readonly<Record<string, string>>;
    skippedQuestionKeys: readonly string[];
  }>,
  now: string,
): ProjectSeed {
  if (input.skippedQuestionKeys.includes(questionKey)) {
    return updateProjectSeedField(seed, fieldKey, {
      values: [],
      source: "user_input",
      confirmation: "skipped",
      origin: `question:${questionKey}`,
      updatedAt: now,
    });
  }
  const value = normalizeText(input.answers[questionKey] ?? "");
  if (value.length === 0) return seed;
  return updateProjectSeedField(seed, fieldKey, {
    values: value,
    source: "user_input",
    confirmation: "confirmed",
    origin: `question:${questionKey}`,
    updatedAt: now,
  });
}

function replacePremise(
  seed: ProjectSeed,
  value: string,
  source: ProjectSeedSource,
  confirmation: ProjectSeedConfirmation,
  origin: string,
  now: string,
): ProjectSeed {
  const normalized = normalizeText(value);
  return updateProjectSeedField(seed, "premise", {
    values: normalized,
    source: normalized.length === 0 ? null : source,
    confirmation: normalized.length === 0 ? "unconfirmed" : confirmation,
    origin: normalized.length === 0 ? null : origin,
    updatedAt: now,
  });
}

function emptyField(now: string): ProjectSeedField {
  return Object.freeze({
    values: Object.freeze([]),
    source: null,
    confirmation: "unconfirmed",
    origin: null,
    updatedAt: now,
  });
}

function makeField(input: ProjectSeedFieldUpdate): ProjectSeedField {
  const values = uniqueTexts(typeof input.values === "string" ? [input.values] : input.values);
  if (input.source !== null && !PROJECT_SEED_SOURCES.includes(input.source)) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_SOURCE_INVALID",
      "ProjectSeed source is invalid.",
    );
  }
  if (!PROJECT_SEED_CONFIRMATIONS.includes(input.confirmation)) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_CONFIRMATION_INVALID",
      "ProjectSeed confirmation state is invalid.",
    );
  }
  if (values.length > 0 && input.source === null) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_SOURCE_REQUIRED",
      "A populated ProjectSeed field requires provenance.",
    );
  }
  if (input.confirmation === "skipped" && values.length > 0) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_SKIPPED_WITH_VALUE",
      "A skipped ProjectSeed field cannot keep a value.",
    );
  }
  const origin =
    input.origin === null ? null : normalizeIdentifier(input.origin, "ProjectSeed origin");
  return Object.freeze({
    values,
    source: input.source,
    confirmation: input.confirmation,
    origin,
    updatedAt: requireIsoTimestamp(input.updatedAt),
  });
}

function requireProjectSeed(value: unknown): ProjectSeed {
  if (
    !isRecord(value) ||
    value.version !== PROJECT_SEED_VERSION ||
    !isProjectSeedJourneyKind(value.journeyKind) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw new ProjectSeedValidationError("PROJECT_SEED_INVALID", "ProjectSeed is invalid.");
  }
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const fields = Object.fromEntries(
    PROJECT_SEED_FIELD_KEYS.map((key) => {
      const field: unknown = value[key];
      if (!isRecord(field)) {
        throw new ProjectSeedValidationError(
          "PROJECT_SEED_INVALID",
          `ProjectSeed ${key} is invalid.`,
        );
      }
      return [
        key,
        makeField({
          values: isStringArray(field.values) ? field.values : failInvalidField(key),
          source: isProjectSeedSourceOrNull(field.source) ? field.source : failInvalidField(key),
          confirmation: isProjectSeedConfirmation(field.confirmation)
            ? field.confirmation
            : failInvalidField(key),
          origin:
            field.origin === null || typeof field.origin === "string"
              ? field.origin
              : failInvalidField(key),
          updatedAt: typeof field.updatedAt === "string" ? field.updatedAt : failInvalidField(key),
        }),
      ];
    }),
  ) as Record<ProjectSeedFieldKey, ProjectSeedField>;
  if (
    Object.values(fields).some(
      (field) => field.updatedAt < createdAt || field.updatedAt > updatedAt,
    )
  ) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_TIMESTAMP_INVALID",
      "ProjectSeed field timestamp falls outside its seed revision.",
    );
  }
  return freezeSeed({
    version: PROJECT_SEED_VERSION,
    seedId:
      typeof value.seedId === "string"
        ? normalizeIdentifier(value.seedId, "ProjectSeed id")
        : failInvalidSeed(),
    journeyKind: value.journeyKind,
    ...fields,
    createdAt,
    updatedAt,
  });
}

function freezeSeed(value: ProjectSeed): ProjectSeed {
  return Object.freeze(value);
}

function uniqueTexts(values: readonly string[]): readonly string[] {
  const normalized = values.map(normalizeText).filter((value) => value.length > 0);
  const unique = [...new Set(normalized)];
  if (unique.length > 64 || unique.some((value) => value.length > 4_000)) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_VALUE_TOO_LARGE",
      "ProjectSeed field exceeds its safe local storage limit.",
    );
  }
  return Object.freeze(unique);
}

function normalizeText(value: string): string {
  // Seed values are author-owned natural language. Canonical composition keeps
  // equivalent Unicode sequences stable without compatibility-folding Chinese
  // punctuation, full-width prose, or other deliberate typography.
  return value.normalize("NFC").replaceAll(/\r\n?/gu, "\n").trim();
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ProjectSeedValidationError("PROJECT_SEED_IDENTIFIER_INVALID", `${label} is invalid.`);
  }
  return normalized;
}

function inferGenreFromPremise(premise: string): string | null {
  const normalized = premise.normalize("NFKC");
  const genres = [
    "青春恋爱轻小说",
    "青春恋爱",
    "轻小说",
    "悬疑",
    "科幻",
    "奇幻",
    "都市",
    "历史",
    "武侠",
    "仙侠",
  ];
  return genres.find((genre) => normalized.includes(genre)) ?? null;
}

function requireIsoTimestamp(value: string): string {
  if (!isIsoTimestamp(value)) {
    throw new ProjectSeedValidationError(
      "PROJECT_SEED_TIMESTAMP_INVALID",
      "ProjectSeed timestamp is invalid.",
    );
  }
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isProjectSeedSourceOrNull(value: unknown): value is ProjectSeedSource | null {
  return value === null || isProjectSeedSource(value);
}

function isProjectSeedSource(value: unknown): value is ProjectSeedSource {
  return (
    value === "user_input" ||
    value === "imported_text" ||
    value === "import_analysis" ||
    value === "professional_setup" ||
    value === "ai_inference"
  );
}

function isProjectSeedConfirmation(value: unknown): value is ProjectSeedConfirmation {
  return value === "confirmed" || value === "unconfirmed" || value === "skipped";
}

function isProjectSeedJourneyKind(value: unknown): value is ProjectSeedJourneyKind {
  return value === "idea" || value === "import" || value === "professional";
}

function failInvalidField(key: ProjectSeedFieldKey): never {
  throw new ProjectSeedValidationError("PROJECT_SEED_INVALID", `ProjectSeed ${key} is invalid.`);
}

function failInvalidSeed(): never {
  throw new ProjectSeedValidationError("PROJECT_SEED_INVALID", "ProjectSeed is invalid.");
}

export class ProjectSeedValidationError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectSeedValidationError";
  }
}

const PROJECT_SEED_SOURCES = [
  "user_input",
  "imported_text",
  "import_analysis",
  "professional_setup",
  "ai_inference",
] as const;
const PROJECT_SEED_CONFIRMATIONS = ["confirmed", "unconfirmed", "skipped"] as const;
