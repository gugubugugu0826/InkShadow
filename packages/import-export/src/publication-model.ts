import { portableProjectV1Schema, type PortableProjectV1 } from "./schemas.js";

export const PUBLICATION_FORMAT = "inkshadow-portable-publication";
export const PUBLICATION_VERSION = 1;

/**
 * Publication limits are deliberately independent from import error messages.
 * A publication is rejected at a boundary instead of being silently truncated.
 */
export const PUBLICATION_LIMITS = Object.freeze({
  maximumChapters: 10_000,
  maximumBlocksPerChapter: 20_000,
  maximumBlocks: 100_000,
  maximumSourceCharacters: 50 * 1024 * 1024,
  maximumTextCharacters: 50 * 1024 * 1024,
  maximumWarnings: 10_000,
  maximumListDepth: 8,
  maximumCodeLanguageCharacters: 64,
});

export type PublicationErrorCode =
  "PUBLICATION_INPUT_INVALID" | "PUBLICATION_LIMIT_EXCEEDED" | "PUBLICATION_ABORTED";

export class PublicationNormalizationError extends Error {
  readonly chapterId: string | undefined;
  readonly sourcePath: string | undefined;
  readonly limit: number | undefined;

  constructor(
    readonly code: PublicationErrorCode,
    message: string,
    options: {
      readonly chapterId?: string;
      readonly sourcePath?: string;
      readonly limit?: number;
    } = {},
  ) {
    super(message);
    this.name = "PublicationNormalizationError";
    this.chapterId = options.chapterId;
    this.sourcePath = options.sourcePath;
    this.limit = options.limit;
  }
}

export type PublicationWarningCode =
  | "PUBLICATION_INLINE_MARKUP_FLATTENED"
  | "PUBLICATION_RAW_HTML_PRESERVED_AS_TEXT"
  | "PUBLICATION_EXTERNAL_REFERENCE_FLATTENED"
  | "PUBLICATION_IMAGE_REFERENCE_REMOVED"
  | "PUBLICATION_UNSAFE_CONTROL_REMOVED"
  | "PUBLICATION_UNCLOSED_CODE_FENCE"
  | "PUBLICATION_LIST_DEPTH_CLAMPED"
  | "PUBLICATION_CODE_LANGUAGE_REMOVED"
  | "PUBLICATION_WARNING_LIMIT_REACHED";

export interface PublicationWarning {
  readonly code: PublicationWarningCode;
  readonly message: string;
  readonly chapterId?: string;
  readonly sourcePath?: string;
  readonly sourceLine?: number;
}

export type PublicationHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

interface PublicationTextBlock {
  readonly text: string;
  readonly sourceLine: number;
}

export interface PublicationHeadingBlock extends PublicationTextBlock {
  readonly kind: "heading";
  readonly level: PublicationHeadingLevel;
}

export interface PublicationParagraphBlock extends PublicationTextBlock {
  readonly kind: "paragraph";
}

export interface PublicationUnorderedListItemBlock extends PublicationTextBlock {
  readonly kind: "unorderedListItem";
  readonly depth: number;
}

export interface PublicationOrderedListItemBlock extends PublicationTextBlock {
  readonly kind: "orderedListItem";
  readonly depth: number;
  readonly ordinal: number;
}

export interface PublicationQuoteBlock extends PublicationTextBlock {
  readonly kind: "quote";
}

export interface PublicationCodeBlock extends PublicationTextBlock {
  readonly kind: "code";
  readonly language?: string;
}

export interface PublicationSceneBreakBlock {
  readonly kind: "sceneBreak";
  readonly sourceLine: number;
}

export type PublicationBlock =
  | PublicationHeadingBlock
  | PublicationParagraphBlock
  | PublicationUnorderedListItemBlock
  | PublicationOrderedListItemBlock
  | PublicationQuoteBlock
  | PublicationCodeBlock
  | PublicationSceneBreakBlock;

export interface PublicationChapter {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly sourcePath: string;
  readonly blocks: readonly PublicationBlock[];
}

export interface PortablePublication {
  readonly format: typeof PUBLICATION_FORMAT;
  readonly version: typeof PUBLICATION_VERSION;
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly language: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly chapters: readonly PublicationChapter[];
  readonly warnings: readonly PublicationWarning[];
  readonly statistics: {
    readonly chapterCount: number;
    readonly blockCount: number;
    readonly textCharacters: number;
  };
}

export interface PublicationNormalizationProgress {
  readonly phase: "validating" | "normalizing" | "complete";
  readonly completedChapters: number;
  readonly totalChapters: number;
  readonly completedBlocks: number;
}

export interface PublicationNormalizationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PublicationNormalizationProgress) => void;
}

interface WarningContext {
  readonly chapterId?: string;
  readonly sourcePath?: string;
  readonly sourceLine?: number;
}

interface ChapterContext {
  readonly chapterId: string;
  readonly sourcePath: string;
}

interface ParsedFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly language?: string;
  readonly languageRemoved: boolean;
}

interface ParsedListItem {
  readonly depth: number;
  readonly depthClamped: boolean;
  readonly text: string;
}

interface ParsedOrderedListItem extends ParsedListItem {
  readonly ordinal: number;
}

class WarningCollector {
  readonly #warnings: PublicationWarning[] = [];
  readonly #deduplicationKeys = new Set<string>();
  #limitReached = false;

  add(code: PublicationWarningCode, message: string, context: WarningContext = {}): void {
    const key = `${context.chapterId ?? "project"}\u0000${context.sourcePath ?? ""}\u0000${code}`;
    if (this.#deduplicationKeys.has(key)) {
      return;
    }
    this.#deduplicationKeys.add(key);

    if (this.#warnings.length >= PUBLICATION_LIMITS.maximumWarnings - 1) {
      if (!this.#limitReached) {
        this.#limitReached = true;
        this.#warnings.push(
          Object.freeze({
            code: "PUBLICATION_WARNING_LIMIT_REACHED",
            message:
              "Additional publication warnings were summarized after the fixed warning-detail limit was reached.",
          }),
        );
      }
      return;
    }

    this.#warnings.push(
      Object.freeze({
        code,
        message,
        ...(context.chapterId === undefined ? {} : { chapterId: context.chapterId }),
        ...(context.sourcePath === undefined ? {} : { sourcePath: context.sourcePath }),
        ...(context.sourceLine === undefined ? {} : { sourceLine: context.sourceLine }),
      }),
    );
  }

  values(): readonly PublicationWarning[] {
    return Object.freeze([...this.#warnings]);
  }
}

class PublicationBudget {
  sourceCharacters = 0;
  textCharacters = 0;
  blockCount = 0;

  addSourceCharacters(characters: number, context: ChapterContext | undefined): void {
    this.sourceCharacters += characters;
    if (this.sourceCharacters > PUBLICATION_LIMITS.maximumSourceCharacters) {
      throw limitError("source characters", PUBLICATION_LIMITS.maximumSourceCharacters, context);
    }
  }

  addText(text: string, context: ChapterContext | undefined): void {
    this.textCharacters += text.length;
    if (this.textCharacters > PUBLICATION_LIMITS.maximumTextCharacters) {
      throw limitError(
        "publication text characters",
        PUBLICATION_LIMITS.maximumTextCharacters,
        context,
      );
    }
  }

  addBlock(chapterBlockCount: number, context: ChapterContext): void {
    if (chapterBlockCount > PUBLICATION_LIMITS.maximumBlocksPerChapter) {
      throw limitError(
        "blocks in one chapter",
        PUBLICATION_LIMITS.maximumBlocksPerChapter,
        context,
      );
    }
    this.blockCount += 1;
    if (this.blockCount > PUBLICATION_LIMITS.maximumBlocks) {
      throw limitError("publication blocks", PUBLICATION_LIMITS.maximumBlocks, context);
    }
  }
}

function limitError(
  subject: string,
  limit: number,
  context: ChapterContext | undefined,
): PublicationNormalizationError {
  return new PublicationNormalizationError(
    "PUBLICATION_LIMIT_EXCEEDED",
    `The ${subject} exceed the fixed publication limit of ${String(limit)}.`,
    {
      ...(context ?? {}),
      limit,
    },
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PublicationNormalizationError(
      "PUBLICATION_ABORTED",
      "Publication normalization was cancelled before completion.",
    );
  }
}

function reportProgress(
  options: PublicationNormalizationOptions,
  progress: PublicationNormalizationProgress,
): void {
  assertNotAborted(options.signal);
  options.onProgress?.(Object.freeze(progress));
  assertNotAborted(options.signal);
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function warningContext(chapter: ChapterContext | undefined, sourceLine?: number): WarningContext {
  return {
    ...(chapter === undefined
      ? {}
      : {
          chapterId: chapter.chapterId,
          sourcePath: chapter.sourcePath,
        }),
    ...(sourceLine === undefined ? {} : { sourceLine }),
  };
}

function replaceUnsafeControls(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  let changed = false;
  let output = "";
  for (const character of input) {
    const code = character.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      output += "\uFFFD";
      changed = true;
    } else {
      output += character;
    }
  }
  if (changed) {
    warnings.add(
      "PUBLICATION_UNSAFE_CONTROL_REMOVED",
      "Unsupported control characters were replaced with visible replacement characters for publication.",
      context,
    );
  }
  return output;
}

function containsRawHtml(input: string): boolean {
  for (let index = 0; index < input.length - 1; index += 1) {
    if (input[index] !== "<") {
      continue;
    }
    const next = input[index + 1];
    if (
      next === "/" ||
      next === "!" ||
      next === "?" ||
      (next !== undefined && /[A-Za-z]/u.test(next))
    ) {
      return true;
    }
  }
  return false;
}

function flattenMarkdownReferences(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  const withoutImages = input.replaceAll(
    /!\[([^\]\n]{0,500})\]\(([^)\n]{0,2000})\)/gu,
    (_match, label: string) => {
      const normalizedLabel = label.trim();
      return `[image omitted: ${normalizedLabel.length === 0 ? "unlabelled" : normalizedLabel}]`;
    },
  );
  const withoutLinks = withoutImages.replaceAll(
    /\[([^\]\n]{1,1000})\]\(([^)\n]{0,2000})\)/gu,
    (_match, label: string) => label,
  );

  if (withoutImages !== input) {
    warnings.add(
      "PUBLICATION_IMAGE_REFERENCE_REMOVED",
      "An image reference was replaced with inert alt text; publication normalization never requests images.",
      context,
    );
  }
  if (withoutLinks !== withoutImages) {
    warnings.add(
      "PUBLICATION_EXTERNAL_REFERENCE_FLATTENED",
      "A link destination was removed while its visible label was retained as publication text.",
      context,
    );
  }
  return withoutLinks;
}

const EXTERNAL_SCHEMES = Object.freeze([
  "https://",
  "http://",
  "ftp://",
  "file://",
  "mailto:",
  "javascript:",
  "vbscript:",
  "data:",
]);

function startsWithIgnoreCase(input: string, search: string, position: number): boolean {
  if (position + search.length > input.length) {
    return false;
  }
  return input.slice(position, position + search.length).toLowerCase() === search;
}

function isReferenceTerminator(character: string | undefined): boolean {
  return (
    character === undefined ||
    /\s/u.test(character) ||
    character === "<" ||
    character === ">" ||
    character === "{" ||
    character === "}" ||
    character === "[" ||
    character === "]" ||
    character === ")" ||
    character === '"' ||
    character === "'"
  );
}

function removeExternalSchemes(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  let output = "";
  let changed = false;
  let index = 0;
  while (index < input.length) {
    const scheme = EXTERNAL_SCHEMES.find((candidate) =>
      startsWithIgnoreCase(input, candidate, index),
    );
    if (scheme === undefined) {
      output += input[index] ?? "";
      index += 1;
      continue;
    }

    changed = true;
    output += "[external reference removed]";
    index += scheme.length;
    while (index < input.length && !isReferenceTerminator(input[index])) {
      index += 1;
    }
  }

  if (changed) {
    warnings.add(
      "PUBLICATION_EXTERNAL_REFERENCE_FLATTENED",
      "An external or executable reference was converted to inert publication text.",
      context,
    );
  }
  return output;
}

function isEscaped(input: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function stripPairedToken(
  input: string,
  token: string,
): {
  readonly value: string;
  readonly changed: boolean;
} {
  let output = "";
  let cursor = 0;
  let changed = false;
  while (cursor < input.length) {
    let opening = input.indexOf(token, cursor);
    while (opening >= 0 && isEscaped(input, opening)) {
      opening = input.indexOf(token, opening + token.length);
    }
    if (opening < 0) {
      output += input.slice(cursor);
      break;
    }

    let closing = input.indexOf(token, opening + token.length);
    while (closing >= 0 && isEscaped(input, closing)) {
      closing = input.indexOf(token, closing + token.length);
    }
    if (closing <= opening + token.length) {
      output += input.slice(cursor, opening + token.length);
      cursor = opening + token.length;
      continue;
    }

    const content = input.slice(opening + token.length, closing);
    const first = content[0];
    const last = content.at(-1);
    if (
      first === undefined ||
      last === undefined ||
      /\s/u.test(first) ||
      /\s/u.test(last) ||
      (token === "_" &&
        ((opening > 0 && /[\p{L}\p{N}]/u.test(input[opening - 1] ?? "")) ||
          /[\p{L}\p{N}]/u.test(input[closing + 1] ?? "")))
    ) {
      output += input.slice(cursor, opening + token.length);
      cursor = opening + token.length;
      continue;
    }

    output += input.slice(cursor, opening);
    output += content;
    cursor = closing + token.length;
    changed = true;
  }
  return { value: output, changed };
}

function flattenInlineMarkup(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  let value = input;
  let changed = false;
  for (const token of ["**", "__", "~~", "`", "*", "_"]) {
    const result = stripPairedToken(value, token);
    value = result.value;
    changed ||= result.changed;
  }
  if (changed) {
    warnings.add(
      "PUBLICATION_INLINE_MARKUP_FLATTENED",
      "Inline emphasis or code markup was flattened while its visible text was retained.",
      context,
    );
  }
  return value;
}

function normalizeInlineText(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  let output = replaceUnsafeControls(input, warnings, context);
  if (containsRawHtml(output)) {
    warnings.add(
      "PUBLICATION_RAW_HTML_PRESERVED_AS_TEXT",
      "Raw HTML-like markup was preserved only as inert publication text and was never parsed.",
      context,
    );
  }
  output = flattenMarkdownReferences(output, warnings, context);
  output = removeExternalSchemes(output, warnings, context);
  return flattenInlineMarkup(output, warnings, context);
}

function normalizeLiteralText(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  const output = replaceUnsafeControls(input, warnings, context);
  if (containsRawHtml(output)) {
    warnings.add(
      "PUBLICATION_RAW_HTML_PRESERVED_AS_TEXT",
      "Raw HTML-like markup was preserved only as inert publication text and was never parsed.",
      context,
    );
  }
  return output;
}

function normalizeMetadataText(
  input: string,
  warnings: WarningCollector,
  context: WarningContext,
): string {
  return removeExternalSchemes(normalizeLiteralText(input, warnings, context), warnings, context);
}

function leadingIndent(line: string): {
  readonly characters: number;
  readonly width: number;
} {
  let characters = 0;
  let width = 0;
  while (characters < line.length) {
    const character = line[characters];
    if (character === " ") {
      characters += 1;
      width += 1;
      continue;
    }
    if (character === "\t") {
      characters += 1;
      width += 4;
      continue;
    }
    break;
  }
  return { characters, width };
}

function parseHeading(line: string): {
  readonly level: PublicationHeadingLevel;
  readonly text: string;
} | null {
  const indent = leadingIndent(line);
  if (indent.width > 3) {
    return null;
  }
  let cursor = indent.characters;
  while (cursor < line.length && line[cursor] === "#") {
    cursor += 1;
  }
  const count = cursor - indent.characters;
  if (count < 1 || count > 6) {
    return null;
  }
  const next = line[cursor];
  if (next !== undefined && next !== " " && next !== "\t") {
    return null;
  }
  const level = count as PublicationHeadingLevel;
  return {
    level,
    text: line.slice(cursor).trim(),
  };
}

function parseFenceOpening(line: string): ParsedFence | null {
  const indent = leadingIndent(line);
  if (indent.width > 3) {
    return null;
  }
  const marker = line[indent.characters];
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  let cursor = indent.characters;
  while (line[cursor] === marker) {
    cursor += 1;
  }
  const length = cursor - indent.characters;
  if (length < 3) {
    return null;
  }

  const info = line.slice(cursor).trim();
  if (marker === "`" && info.includes("`")) {
    return null;
  }
  if (info.length === 0) {
    return { marker, length, languageRemoved: false };
  }

  const language = info.split(/\s+/u, 1)[0] ?? "";
  const safeLanguage =
    language.length > 0 &&
    language.length <= PUBLICATION_LIMITS.maximumCodeLanguageCharacters &&
    /^[A-Za-z0-9][A-Za-z0-9._+#-]*$/u.test(language);
  return {
    marker,
    length,
    ...(safeLanguage ? { language } : {}),
    languageRemoved: !safeLanguage,
  };
}

function isFenceClosing(line: string, fence: ParsedFence): boolean {
  const indent = leadingIndent(line);
  if (indent.width > 3 || line[indent.characters] !== fence.marker) {
    return false;
  }
  let cursor = indent.characters;
  while (line[cursor] === fence.marker) {
    cursor += 1;
  }
  return cursor - indent.characters >= fence.length && line.slice(cursor).trim().length === 0;
}

function parseUnorderedListItem(line: string): ParsedListItem | null {
  const indent = leadingIndent(line);
  const marker = line[indent.characters];
  const following = line[indent.characters + 1];
  if (
    (marker !== "-" && marker !== "*" && marker !== "+") ||
    (following !== " " && following !== "\t")
  ) {
    return null;
  }
  const rawDepth = Math.floor(indent.width / 2);
  return {
    depth: Math.min(rawDepth, PUBLICATION_LIMITS.maximumListDepth),
    depthClamped: rawDepth > PUBLICATION_LIMITS.maximumListDepth,
    text: line.slice(indent.characters + 2).trimEnd(),
  };
}

function parseOrderedListItem(line: string): ParsedOrderedListItem | null {
  const indent = leadingIndent(line);
  let cursor = indent.characters;
  while (cursor < line.length && /[0-9]/u.test(line[cursor] ?? "")) {
    cursor += 1;
    if (cursor - indent.characters > 9) {
      return null;
    }
  }
  if (cursor === indent.characters || (line[cursor] !== "." && line[cursor] !== ")")) {
    return null;
  }
  const following = line[cursor + 1];
  if (following !== " " && following !== "\t") {
    return null;
  }
  const ordinal = Number.parseInt(line.slice(indent.characters, cursor), 10);
  if (!Number.isSafeInteger(ordinal)) {
    return null;
  }
  const rawDepth = Math.floor(indent.width / 2);
  return {
    depth: Math.min(rawDepth, PUBLICATION_LIMITS.maximumListDepth),
    depthClamped: rawDepth > PUBLICATION_LIMITS.maximumListDepth,
    ordinal,
    text: line.slice(cursor + 2).trimEnd(),
  };
}

function parseQuote(line: string): string | null {
  const indent = leadingIndent(line);
  if (indent.width > 3 || line[indent.characters] !== ">") {
    return null;
  }
  const following = line[indent.characters + 1];
  const contentStart =
    following === " " || following === "\t" ? indent.characters + 2 : indent.characters + 1;
  return line.slice(contentStart).trimEnd();
}

function isSceneBreak(line: string): boolean {
  let marker: string | undefined;
  let count = 0;
  for (const character of line.trim()) {
    if (character === " " || character === "\t") {
      continue;
    }
    if (character !== "-" && character !== "*" && character !== "_") {
      return false;
    }
    marker ??= character;
    if (character !== marker) {
      return false;
    }
    count += 1;
  }
  return count >= 3;
}

function normalizeChapter(
  chapter: PortableProjectV1["chapters"][number],
  warnings: WarningCollector,
  budget: PublicationBudget,
  options: PublicationNormalizationOptions,
  progress: {
    readonly completedChapters: number;
    readonly totalChapters: number;
  },
): PublicationChapter {
  const pathContext = {
    chapterId: chapter.id,
  };
  const pathWithoutLines = chapter.path.replaceAll("\r", "\uFFFD").replaceAll("\n", "\uFFFD");
  if (pathWithoutLines !== chapter.path) {
    warnings.add(
      "PUBLICATION_UNSAFE_CONTROL_REMOVED",
      "Line breaks in a source path were replaced with visible replacement characters for publication.",
      pathContext,
    );
  }
  const sanitizedPath = replaceUnsafeControls(pathWithoutLines, warnings, pathContext);
  const context: ChapterContext = {
    chapterId: chapter.id,
    sourcePath: sanitizedPath,
  };
  budget.addSourceCharacters(
    chapter.id.length + chapter.title.length + chapter.path.length + chapter.markdown.length,
    context,
  );
  const title = normalizeMetadataText(chapter.title, warnings, warningContext(context));
  budget.addText(title, context);

  const markdown = chapter.markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = markdown.split("\n");
  const blocks: PublicationBlock[] = [];
  let paragraphStartLine = 0;
  let paragraphLines: string[] = [];
  let fence: ParsedFence | undefined;
  let fenceStartLine = 0;
  let codeLines: string[] = [];

  const addBlock = (block: PublicationBlock): void => {
    blocks.push(Object.freeze(block));
    budget.addBlock(blocks.length, context);
    if ("text" in block) {
      budget.addText(block.text, context);
    }
  };

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    const text = normalizeInlineText(
      paragraphLines.join("\n"),
      warnings,
      warningContext(context, paragraphStartLine),
    );
    addBlock({
      kind: "paragraph",
      text,
      sourceLine: paragraphStartLine,
    });
    paragraphLines = [];
    paragraphStartLine = 0;
  };

  const flushCode = (unclosed: boolean): void => {
    if (fence === undefined) {
      return;
    }
    const codeContext = warningContext(context, fenceStartLine);
    if (fence.languageRemoved) {
      warnings.add(
        "PUBLICATION_CODE_LANGUAGE_REMOVED",
        "An unsupported code-fence language label was omitted from the publication model.",
        codeContext,
      );
    }
    if (unclosed) {
      warnings.add(
        "PUBLICATION_UNCLOSED_CODE_FENCE",
        "An unclosed code fence was safely treated as code through the end of the chapter.",
        codeContext,
      );
    }
    const text = normalizeLiteralText(codeLines.join("\n"), warnings, codeContext);
    addBlock({
      kind: "code",
      text,
      sourceLine: fenceStartLine,
      ...(fence.language === undefined ? {} : { language: fence.language }),
    });
    fence = undefined;
    fenceStartLine = 0;
    codeLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (index % 128 === 0) {
      reportProgress(options, {
        phase: "normalizing",
        completedChapters: progress.completedChapters,
        totalChapters: progress.totalChapters,
        completedBlocks: budget.blockCount,
      });
    } else {
      assertNotAborted(options.signal);
    }

    const line = lines[index] ?? "";
    const sourceLine = index + 1;
    if (fence !== undefined) {
      if (isFenceClosing(line, fence)) {
        flushCode(false);
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const openingFence = parseFenceOpening(line);
    if (openingFence !== null) {
      flushParagraph();
      fence = openingFence;
      fenceStartLine = sourceLine;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const heading = parseHeading(line);
    if (heading !== null) {
      flushParagraph();
      addBlock({
        kind: "heading",
        level: heading.level,
        text: normalizeInlineText(heading.text, warnings, warningContext(context, sourceLine)),
        sourceLine,
      });
      continue;
    }

    if (isSceneBreak(line)) {
      flushParagraph();
      addBlock({ kind: "sceneBreak", sourceLine });
      continue;
    }

    const unordered = parseUnorderedListItem(line);
    if (unordered !== null) {
      flushParagraph();
      if (unordered.depthClamped) {
        warnings.add(
          "PUBLICATION_LIST_DEPTH_CLAMPED",
          "List indentation was clamped to the fixed publication nesting limit.",
          warningContext(context, sourceLine),
        );
      }
      addBlock({
        kind: "unorderedListItem",
        depth: unordered.depth,
        text: normalizeInlineText(unordered.text, warnings, warningContext(context, sourceLine)),
        sourceLine,
      });
      continue;
    }

    const ordered = parseOrderedListItem(line);
    if (ordered !== null) {
      flushParagraph();
      if (ordered.depthClamped) {
        warnings.add(
          "PUBLICATION_LIST_DEPTH_CLAMPED",
          "List indentation was clamped to the fixed publication nesting limit.",
          warningContext(context, sourceLine),
        );
      }
      addBlock({
        kind: "orderedListItem",
        depth: ordered.depth,
        ordinal: ordered.ordinal,
        text: normalizeInlineText(ordered.text, warnings, warningContext(context, sourceLine)),
        sourceLine,
      });
      continue;
    }

    const quote = parseQuote(line);
    if (quote !== null) {
      flushParagraph();
      addBlock({
        kind: "quote",
        text: normalizeInlineText(quote, warnings, warningContext(context, sourceLine)),
        sourceLine,
      });
      continue;
    }

    if (paragraphLines.length === 0) {
      paragraphStartLine = sourceLine;
    }
    paragraphLines.push(line.trimEnd());
  }

  flushParagraph();
  flushCode(true);

  return Object.freeze({
    id: chapter.id,
    title,
    order: chapter.order,
    sourcePath: sanitizedPath,
    blocks: Object.freeze(blocks),
  });
}

/**
 * Revalidates and normalizes a portable project into the only semantic block
 * shapes shared by document exporters. The function performs no I/O, never
 * resolves HTML, links, or images, and never truncates body text.
 */
export function normalizePortablePublication(
  input: PortableProjectV1,
  options: PublicationNormalizationOptions = {},
): PortablePublication {
  reportProgress(options, {
    phase: "validating",
    completedChapters: 0,
    totalChapters: 0,
    completedBlocks: 0,
  });
  const parsed = portableProjectV1Schema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue?.path.map(String).join(".");
    throw new PublicationNormalizationError(
      "PUBLICATION_INPUT_INVALID",
      `The publication source is invalid${
        path === undefined || path.length === 0 ? "" : ` at ${path}`
      }: ${firstIssue?.message ?? "schema validation failed"}.`,
    );
  }
  if (parsed.data.chapters.length > PUBLICATION_LIMITS.maximumChapters) {
    throw limitError("chapters", PUBLICATION_LIMITS.maximumChapters, undefined);
  }

  const budget = new PublicationBudget();
  const warnings = new WarningCollector();
  const projectContext = warningContext(undefined);
  budget.addSourceCharacters(
    parsed.data.project.id.length +
      parsed.data.project.title.length +
      (parsed.data.project.description?.length ?? 0),
    undefined,
  );
  const projectTitle = normalizeMetadataText(parsed.data.project.title, warnings, projectContext);
  budget.addText(projectTitle, undefined);
  const projectDescription =
    parsed.data.project.description === undefined
      ? undefined
      : normalizeMetadataText(
          parsed.data.project.description.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
          warnings,
          projectContext,
        );
  if (projectDescription !== undefined) {
    budget.addText(projectDescription, undefined);
  }

  const sortedChapters = parsed.data.chapters
    .map((chapter, inputIndex) => ({ chapter, inputIndex }))
    .sort(
      (left, right) =>
        left.chapter.order - right.chapter.order ||
        compareText(left.chapter.id, right.chapter.id) ||
        compareText(left.chapter.path, right.chapter.path) ||
        left.inputIndex - right.inputIndex,
    );
  const chapters: PublicationChapter[] = [];
  reportProgress(options, {
    phase: "normalizing",
    completedChapters: 0,
    totalChapters: sortedChapters.length,
    completedBlocks: 0,
  });
  for (const { chapter } of sortedChapters) {
    chapters.push(
      normalizeChapter(chapter, warnings, budget, options, {
        completedChapters: chapters.length,
        totalChapters: sortedChapters.length,
      }),
    );
    reportProgress(options, {
      phase: "normalizing",
      completedChapters: chapters.length,
      totalChapters: sortedChapters.length,
      completedBlocks: budget.blockCount,
    });
  }

  reportProgress(options, {
    phase: "complete",
    completedChapters: chapters.length,
    totalChapters: chapters.length,
    completedBlocks: budget.blockCount,
  });
  return Object.freeze({
    format: PUBLICATION_FORMAT,
    version: PUBLICATION_VERSION,
    project: Object.freeze({
      id: parsed.data.project.id,
      title: projectTitle,
      ...(projectDescription === undefined ? {} : { description: projectDescription }),
      language: parsed.data.project.language,
      createdAt: parsed.data.project.createdAt,
      updatedAt: parsed.data.project.updatedAt,
    }),
    chapters: Object.freeze(chapters),
    warnings: warnings.values(),
    statistics: Object.freeze({
      chapterCount: chapters.length,
      blockCount: budget.blockCount,
      textCharacters: budget.textCharacters,
    }),
  });
}
