export const CREATIVE_EXTENSION_KINDS = ["translation", "short_drama"] as const;

export type CreativeExtensionKind = (typeof CREATIVE_EXTENSION_KINDS)[number];

export interface CreativeExtensionSourceAuthority {
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceChecksum: string;
}

export interface TranslationParagraphCandidate {
  readonly sourceParagraph: number;
  readonly sourceChecksum: string;
  readonly translatedText: string;
  readonly glossaryTerms: readonly string[];
}

export interface TranslationCandidatePayload {
  readonly schemaVersion: 1;
  readonly kind: "translation";
  readonly source: CreativeExtensionSourceAuthority;
  readonly targetLanguage: {
    readonly code: string;
    readonly label: string;
  };
  readonly tone: string;
  readonly glossaryVersion: string;
  readonly paragraphs: readonly TranslationParagraphCandidate[];
}

export interface ShortDramaSourceReference {
  readonly paragraphStart: number;
  readonly paragraphEnd: number;
  readonly sourceChecksum: string;
}

export interface ShortDramaDialogue {
  readonly character: string;
  readonly line: string;
  readonly stageDirection: string | null;
}

export interface ShortDramaShot {
  readonly number: number;
  readonly shotType: string;
  readonly action: string;
  readonly durationSeconds: number;
  readonly dialogue: readonly ShortDramaDialogue[];
}

export interface ShortDramaScene {
  readonly number: number;
  readonly slugline: string;
  readonly location: string;
  readonly timeOfDay: string;
  readonly durationSeconds: number;
  readonly characters: readonly string[];
  readonly sourceReferences: readonly ShortDramaSourceReference[];
  readonly shots: readonly ShortDramaShot[];
}

export interface ShortDramaEpisode {
  readonly number: number;
  readonly title: string;
  readonly durationSeconds: number;
  readonly scenes: readonly ShortDramaScene[];
}

export interface ShortDramaCandidatePayload {
  readonly schemaVersion: 1;
  readonly kind: "short_drama";
  readonly source: CreativeExtensionSourceAuthority;
  readonly title: string;
  readonly format: "vertical_micro_drama" | "standard_short_drama";
  readonly episodes: readonly ShortDramaEpisode[];
}

export type CreativeExtensionCandidatePayload =
  TranslationCandidatePayload | ShortDramaCandidatePayload;

export type CreativeExtensionProtocolErrorCode =
  | "EXTENSION_RESPONSE_TOO_LARGE"
  | "EXTENSION_RESPONSE_INVALID_JSON"
  | "EXTENSION_RESPONSE_UNSAFE"
  | "EXTENSION_RESPONSE_SCHEMA_INVALID";

export class CreativeExtensionProtocolError extends Error {
  public constructor(
    readonly code: CreativeExtensionProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreativeExtensionProtocolError";
  }
}

const MAX_RESPONSE_CODE_UNITS = 1_000_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 50_000;
const MAX_TRANSLATION_PARAGRAPHS = 2_000;
const MAX_EPISODES = 24;
const MAX_SCENES_PER_EPISODE = 64;
const MAX_SHOTS_PER_SCENE = 96;
const MAX_DIALOGUE_PER_SHOT = 24;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROHIBITED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UNSAFE_CONTROLS_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const MEANINGFUL_TEXT_PATTERN = /[^\p{White_Space}\u200B\u200C\u200D\u2060\uFEFF]/u;
const UNPAIRED_SURROGATE_PATTERN =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;

/**
 * Parses one complete provider response. The boundary intentionally rejects
 * wrappers, unknown keys and malformed structures instead of repairing them.
 */
export function parseCreativeExtensionCandidate(
  serialized: string,
): CreativeExtensionCandidatePayload {
  if (
    typeof serialized !== "string" ||
    serialized.length === 0 ||
    serialized.length > MAX_RESPONSE_CODE_UNITS
  ) {
    throw protocolError(
      "EXTENSION_RESPONSE_TOO_LARGE",
      "The creative extension response is empty or exceeds its size boundary.",
    );
  }

  const trimmed = serialized.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw protocolError(
      "EXTENSION_RESPONSE_INVALID_JSON",
      "The creative extension response must be one complete JSON object.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw protocolError(
      "EXTENSION_RESPONSE_INVALID_JSON",
      "The creative extension response is not valid JSON.",
    );
  }

  assertSafeJsonGraph(parsed);
  const root = requireObject(parsed);
  if (root.kind === "translation") {
    return parseTranslation(root);
  }
  if (root.kind === "short_drama") {
    return parseShortDrama(root);
  }
  throw schemaError("The creative extension response kind is unsupported.");
}

export function serializeCreativeExtensionCandidate(
  candidate: CreativeExtensionCandidatePayload,
): string {
  return JSON.stringify(parseCreativeExtensionCandidate(JSON.stringify(candidate)));
}

function parseTranslation(root: Readonly<Record<string, unknown>>): TranslationCandidatePayload {
  requireExactKeys(root, [
    "schemaVersion",
    "kind",
    "source",
    "targetLanguage",
    "tone",
    "glossaryVersion",
    "paragraphs",
  ]);
  requireSchemaVersion(root.schemaVersion);
  const language = requireExactObject(root.targetLanguage, ["code", "label"]);
  const code = requireText(language.code, 2, 32, "targetLanguage.code");
  if (!LANGUAGE_CODE_PATTERN.test(code)) {
    throw schemaError("The target language code is not canonical BCP-47.");
  }
  const paragraphs = requireArray(root.paragraphs, "paragraphs", 1, MAX_TRANSLATION_PARAGRAPHS).map(
    (value, index) => parseTranslationParagraph(value, index),
  );
  const seenParagraphs = new Set<number>();
  for (const paragraph of paragraphs) {
    if (seenParagraphs.has(paragraph.sourceParagraph)) {
      throw schemaError("A translated source paragraph is duplicated.");
    }
    seenParagraphs.add(paragraph.sourceParagraph);
  }
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.sourceParagraph !== index) {
      throw schemaError("Translated source paragraphs must be contiguous and zero-based.");
    }
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "translation",
    source: parseSource(root.source),
    targetLanguage: Object.freeze({
      code,
      label: requireText(language.label, 1, 80, "targetLanguage.label"),
    }),
    tone: requireText(root.tone, 1, 120, "tone"),
    glossaryVersion: requireIdentifier(root.glossaryVersion, "glossaryVersion"),
    paragraphs: Object.freeze(paragraphs),
  });
}

function parseTranslationParagraph(value: unknown, index: number): TranslationParagraphCandidate {
  const paragraph = requireExactObject(value, [
    "sourceParagraph",
    "sourceChecksum",
    "translatedText",
    "glossaryTerms",
  ]);
  const sourceParagraph = requireInteger(
    paragraph.sourceParagraph,
    0,
    MAX_TRANSLATION_PARAGRAPHS - 1,
    `paragraphs[${String(index)}].sourceParagraph`,
  );
  const glossaryTerms = requireArray(
    paragraph.glossaryTerms,
    `paragraphs[${String(index)}].glossaryTerms`,
    0,
    128,
  ).map((term) => requireText(term, 1, 160, "glossary term"));
  if (new Set(glossaryTerms).size !== glossaryTerms.length) {
    throw schemaError("A translated paragraph contains duplicate glossary terms.");
  }
  return Object.freeze({
    sourceParagraph,
    sourceChecksum: requireSha256(paragraph.sourceChecksum, "paragraph.sourceChecksum"),
    translatedText: requireText(paragraph.translatedText, 1, 50_000, "paragraph.translatedText", {
      allowLineFeeds: true,
    }),
    glossaryTerms: Object.freeze(glossaryTerms),
  });
}

function parseShortDrama(root: Readonly<Record<string, unknown>>): ShortDramaCandidatePayload {
  requireExactKeys(root, ["schemaVersion", "kind", "source", "title", "format", "episodes"]);
  requireSchemaVersion(root.schemaVersion);
  if (root.format !== "vertical_micro_drama" && root.format !== "standard_short_drama") {
    throw schemaError("The short-drama format is invalid.");
  }
  const episodes = requireArray(root.episodes, "episodes", 1, MAX_EPISODES).map(
    parseShortDramaEpisode,
  );
  assertOrdinalSequence(episodes, "episode");
  return Object.freeze({
    schemaVersion: 1,
    kind: "short_drama",
    source: parseSource(root.source),
    title: requireText(root.title, 1, 240, "title"),
    format: root.format,
    episodes: Object.freeze(episodes),
  });
}

function parseShortDramaEpisode(value: unknown, index: number): ShortDramaEpisode {
  const episode = requireExactObject(value, ["number", "title", "durationSeconds", "scenes"]);
  const scenes = requireArray(
    episode.scenes,
    `episodes[${String(index)}].scenes`,
    1,
    MAX_SCENES_PER_EPISODE,
  ).map(parseShortDramaScene);
  assertOrdinalSequence(scenes, "scene");
  const durationSeconds = requireInteger(
    episode.durationSeconds,
    1,
    7_200,
    "episode.durationSeconds",
  );
  if (sumDurations(scenes) !== durationSeconds) {
    throw schemaError("Episode duration must equal the sum of its scene durations.");
  }
  return Object.freeze({
    number: requireInteger(episode.number, 1, MAX_EPISODES, "episode.number"),
    title: requireText(episode.title, 1, 240, "episode.title"),
    durationSeconds,
    scenes: Object.freeze(scenes),
  });
}

function parseShortDramaScene(value: unknown, index: number): ShortDramaScene {
  const scene = requireExactObject(value, [
    "number",
    "slugline",
    "location",
    "timeOfDay",
    "durationSeconds",
    "characters",
    "sourceReferences",
    "shots",
  ]);
  const characters = requireArray(scene.characters, "scene.characters", 1, 64).map((item) =>
    requireText(item, 1, 120, "scene character"),
  );
  if (new Set(characters).size !== characters.length) {
    throw schemaError("A short-drama scene contains duplicate characters.");
  }
  const sourceReferences = requireArray(
    scene.sourceReferences,
    "scene.sourceReferences",
    1,
    64,
  ).map(parseShortDramaSourceReference);
  let previousReferenceEnd = -1;
  for (const reference of sourceReferences) {
    if (reference.paragraphStart <= previousReferenceEnd) {
      throw schemaError(
        "Short-drama source references must be ordered, unique and non-overlapping.",
      );
    }
    previousReferenceEnd = reference.paragraphEnd;
  }
  const shots = requireArray(
    scene.shots,
    `scenes[${String(index)}].shots`,
    1,
    MAX_SHOTS_PER_SCENE,
  ).map(parseShortDramaShot);
  assertOrdinalSequence(shots, "shot");
  const sceneCharacters = new Set(characters);
  for (const shot of shots) {
    for (const dialogue of shot.dialogue) {
      if (!sceneCharacters.has(dialogue.character)) {
        throw schemaError("Every dialogue character must be declared by its scene.");
      }
    }
  }
  const durationSeconds = requireInteger(scene.durationSeconds, 1, 1_800, "scene.durationSeconds");
  if (sumDurations(shots) !== durationSeconds) {
    throw schemaError("Scene duration must equal the sum of its shot durations.");
  }
  return Object.freeze({
    number: requireInteger(scene.number, 1, MAX_SCENES_PER_EPISODE, "scene.number"),
    slugline: requireText(scene.slugline, 1, 240, "scene.slugline"),
    location: requireText(scene.location, 1, 160, "scene.location"),
    timeOfDay: requireText(scene.timeOfDay, 1, 80, "scene.timeOfDay"),
    durationSeconds,
    characters: Object.freeze(characters),
    sourceReferences: Object.freeze(sourceReferences),
    shots: Object.freeze(shots),
  });
}

function parseShortDramaSourceReference(value: unknown): ShortDramaSourceReference {
  const reference = requireExactObject(value, ["paragraphStart", "paragraphEnd", "sourceChecksum"]);
  const paragraphStart = requireInteger(
    reference.paragraphStart,
    0,
    MAX_TRANSLATION_PARAGRAPHS - 1,
    "sourceReference.paragraphStart",
  );
  const paragraphEnd = requireInteger(
    reference.paragraphEnd,
    paragraphStart,
    MAX_TRANSLATION_PARAGRAPHS - 1,
    "sourceReference.paragraphEnd",
  );
  return Object.freeze({
    paragraphStart,
    paragraphEnd,
    sourceChecksum: requireSha256(reference.sourceChecksum, "sourceReference.sourceChecksum"),
  });
}

function parseShortDramaShot(value: unknown): ShortDramaShot {
  const shot = requireExactObject(value, [
    "number",
    "shotType",
    "action",
    "durationSeconds",
    "dialogue",
  ]);
  const dialogue = requireArray(shot.dialogue, "shot.dialogue", 0, MAX_DIALOGUE_PER_SHOT).map(
    parseShortDramaDialogue,
  );
  return Object.freeze({
    number: requireInteger(shot.number, 1, MAX_SHOTS_PER_SCENE, "shot.number"),
    shotType: requireText(shot.shotType, 1, 80, "shot.shotType"),
    action: requireText(shot.action, 1, 4_000, "shot.action", {
      allowLineFeeds: true,
    }),
    durationSeconds: requireInteger(shot.durationSeconds, 1, 600, "shot.durationSeconds"),
    dialogue: Object.freeze(dialogue),
  });
}

function parseShortDramaDialogue(value: unknown): ShortDramaDialogue {
  const dialogue = requireExactObject(value, ["character", "line", "stageDirection"]);
  return Object.freeze({
    character: requireText(dialogue.character, 1, 120, "dialogue.character"),
    line: requireText(dialogue.line, 1, 2_000, "dialogue.line"),
    stageDirection:
      dialogue.stageDirection === null
        ? null
        : requireText(dialogue.stageDirection, 1, 1_000, "dialogue.stageDirection"),
  });
}

function parseSource(value: unknown): CreativeExtensionSourceAuthority {
  const source = requireExactObject(value, ["chapterId", "sourceVersionId", "sourceChecksum"]);
  return Object.freeze({
    chapterId: requireIdentifier(source.chapterId, "source.chapterId"),
    sourceVersionId: requireIdentifier(source.sourceVersionId, "source.sourceVersionId"),
    sourceChecksum: requireSha256(source.sourceChecksum, "source.sourceChecksum"),
  });
}

function assertSafeJsonGraph(value: unknown): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw protocolError(
        "EXTENSION_RESPONSE_TOO_LARGE",
        "The creative extension response graph exceeds its structural boundary.",
      );
    }
    if (typeof node === "string") {
      if (UNSAFE_CONTROLS_PATTERN.test(node) || UNPAIRED_SURROGATE_PATTERN.test(node)) {
        throw protocolError(
          "EXTENSION_RESPONSE_UNSAFE",
          "The creative extension response contains unsafe Unicode.",
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        if (PROHIBITED_KEYS.has(key)) {
          throw protocolError(
            "EXTENSION_RESPONSE_UNSAFE",
            "The creative extension response contains a prohibited object key.",
          );
        }
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
}

function requireExactObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const object = requireObject(value);
  requireExactKeys(object, keys);
  return object;
}

function requireObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError("An object was required in the creative extension response.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw schemaError("The creative extension response contains missing or unexpected fields.");
  }
}

function requireArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw schemaError(`${field} exceeds its item boundary.`);
  }
  return value;
}

function requireSchemaVersion(value: unknown): void {
  if (value !== 1) {
    throw schemaError("The creative extension response schema version is unsupported.");
  }
}

function requireInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw schemaError(`${field} must be a bounded safe integer.`);
  }
  return value as number;
}

function requireIdentifier(value: unknown, field: string): string {
  const identifier = requireText(value, 1, 256, field);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw schemaError(`${field} is not a safe identifier.`);
  }
  return identifier;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw schemaError(`${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireText(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  options: { readonly allowLineFeeds?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim().length < minimum ||
    !MEANINGFUL_TEXT_PATTERN.test(value) ||
    value.includes("\r") ||
    (options.allowLineFeeds !== true && value.includes("\n")) ||
    UNSAFE_CONTROLS_PATTERN.test(value) ||
    UNPAIRED_SURROGATE_PATTERN.test(value)
  ) {
    throw schemaError(`${field} is not valid bounded public text.`);
  }
  return value;
}

function assertOrdinalSequence(
  values: readonly { readonly number: number }[],
  label: string,
): void {
  values.forEach((value, index) => {
    if (value.number !== index + 1) {
      throw schemaError(`The ${label} sequence must be contiguous and one-based.`);
    }
  });
}

function sumDurations(values: readonly { readonly durationSeconds: number }[]): number {
  return values.reduce((sum, value) => sum + value.durationSeconds, 0);
}

function schemaError(message: string): CreativeExtensionProtocolError {
  return protocolError("EXTENSION_RESPONSE_SCHEMA_INVALID", message);
}

function protocolError(
  code: CreativeExtensionProtocolErrorCode,
  message: string,
): CreativeExtensionProtocolError {
  return new CreativeExtensionProtocolError(code, message);
}
