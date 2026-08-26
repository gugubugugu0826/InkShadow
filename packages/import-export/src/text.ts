import { IMPORT_LIMITS } from "./constants.js";
import { ImportExportError, type ImportExportErrorCode, type ImportIssue } from "./errors.js";
import {
  assertSafeInputFilename,
  getAllowedImportExtension,
  sanitizeFilename,
} from "./filename.js";
import { utf8ByteLength } from "./checksum.js";
import {
  PublicationImageResolver,
  parseMarkdownImageReferences,
  publicationImageDataUri,
  sanitizePublicationImageAltText,
  type PublicationImageAsset,
} from "./publication-images.js";

export interface MarkdownSanitizationResult {
  readonly markdown: string;
  readonly issues: readonly ImportIssue[];
}

export interface MarkdownSanitizationOptions {
  readonly imageAssets?: readonly PublicationImageAsset[];
  readonly allowEmpty?: boolean;
}

export interface ImportedTextDocument {
  readonly sourceName: string;
  readonly title: string;
  readonly suggestedPath: string;
  readonly markdown: string;
  readonly originalBytes: number;
  readonly sanitizedBytes: number;
  readonly issues: readonly ImportIssue[];
  readonly sourceFormat?: "docx" | "epub" | "html" | "markdown" | "pdf" | "text";
  readonly sourceSha256?: string;
  readonly chapterDetectionConfidence?: number;
  readonly requiresBoundaryReview?: boolean;
}

function warning(code: ImportExportErrorCode, message: string, fileName?: string): ImportIssue {
  return {
    severity: "warning",
    code,
    message,
    ...(fileName === undefined ? {} : { fileName }),
  };
}

function fileOptions(fileName?: string): { readonly fileName?: string } {
  return fileName === undefined ? {} : { fileName };
}

function assertTextPayload(input: string, fileName?: string): string {
  if (utf8ByteLength(input) > IMPORT_LIMITS.maximumFileBytes) {
    throw new ImportExportError(
      "IMPORT_FILE_TOO_LARGE",
      "The text exceeds the per-file import limit.",
      fileOptions(fileName),
    );
  }

  const signatureInput = input.startsWith("\uFEFF") ? input.slice(1) : input;
  if (
    signatureInput.startsWith("PK\u0003\u0004") ||
    signatureInput.startsWith("%PDF-") ||
    (signatureInput.charCodeAt(0) === 0xd0 &&
      signatureInput.charCodeAt(1) === 0xcf &&
      signatureInput.charCodeAt(2) === 0x11 &&
      signatureInput.charCodeAt(3) === 0xe0)
  ) {
    throw new ImportExportError(
      "IMPORT_BINARY_FORMAT_FORBIDDEN",
      "Binary, archive, and office document payloads are not accepted by the text importer.",
      fileOptions(fileName),
    );
  }

  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) {
    throw new ImportExportError(
      "IMPORT_UNSAFE_CONTENT",
      "The text contains binary or unsafe control characters.",
      fileOptions(fileName),
    );
  }

  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function removeExternalReferences(value: string): {
  readonly value: string;
  readonly changed: boolean;
} {
  let result = value;
  result = result.replaceAll(
    /!\[([^\]\n]{0,500})\]\(([^)\n]{0,2000})\)/g,
    (_match, label: string) => `[image omitted: ${label.trim() || "unlabelled"}]`,
  );
  result = result.replaceAll(/\[([^\]\n]{1,1000})\]\(([^)\n]{0,2000})\)/g, "$1");
  result = result.replaceAll(
    /^\s*\[[^\]\n]{1,500}\]:\s*\S{1,2000}\s*$/gm,
    "[external reference removed]",
  );
  result = result.replaceAll(
    /<(?:https?|ftp|mailto):[^>\n]{1,2000}>/gi,
    "[external reference removed]",
  );
  result = result.replaceAll(
    /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s<>{}\[\]"']{1,2000}/gi,
    "[external reference removed]",
  );
  result = result.replaceAll(
    /\b(?:javascript|vbscript|file|mailto|data)\s*:/gi,
    "[unsafe scheme removed]",
  );
  return {
    value: result,
    changed: result !== value,
  };
}

export function sanitizeMarkdown(
  input: string,
  fileName?: string,
  options: MarkdownSanitizationOptions = {},
): MarkdownSanitizationResult {
  const issues: ImportIssue[] = [];
  let normalized = assertTextPayload(input, fileName);

  if (normalized.startsWith("\uFEFF")) {
    normalized = normalized.slice(1);
    issues.push(
      warning("TEXT_BOM_REMOVED", "A leading Unicode byte-order mark was removed.", fileName),
    );
  }

  const protectedImages = protectPublicationImages(normalized, options.imageAssets);
  normalized = protectedImages.value;
  const withoutReferences = removeExternalReferences(normalized);
  normalized = withoutReferences.value;
  if (withoutReferences.changed || protectedImages.omitted) {
    issues.push(
      warning(
        "MARKDOWN_EXTERNAL_REFERENCE_REMOVED",
        "External or executable references were converted to inert text.",
        fileName,
      ),
    );
  }

  const escapedHtml = normalized.replaceAll("<", "&lt;");
  if (escapedHtml !== normalized) {
    issues.push(
      warning(
        "MARKDOWN_RAW_HTML_ESCAPED",
        "Raw HTML was escaped and will be displayed as text.",
        fileName,
      ),
    );
  }

  let markdown = escapedHtml.trim();
  for (const [placeholder, imageMarkdown] of protectedImages.restorations) {
    markdown = markdown.replaceAll(placeholder, imageMarkdown);
  }
  if (markdown.length === 0) {
    if (options.allowEmpty === true) {
      return { markdown: "", issues };
    }
    throw new ImportExportError(
      "MARKDOWN_EMPTY",
      "The imported document has no usable text.",
      fileOptions(fileName),
    );
  }
  if (utf8ByteLength(markdown) > IMPORT_LIMITS.maximumChapterBytes) {
    throw new ImportExportError(
      "IMPORT_FILE_TOO_LARGE",
      "The sanitized chapter exceeds the chapter size limit.",
      fileOptions(fileName),
    );
  }

  return {
    markdown,
    issues,
  };
}

function protectPublicationImages(
  input: string,
  assets: readonly PublicationImageAsset[] | undefined,
): {
  readonly value: string;
  readonly restorations: ReadonlyMap<string, string>;
  readonly omitted: boolean;
} {
  let resolver: PublicationImageResolver;
  try {
    resolver = new PublicationImageResolver(assets);
  } catch (error: unknown) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      error instanceof Error ? error.message : "The publication image asset limit was exceeded.",
    );
  }
  const restorations = new Map<string, string>();
  let omitted = false;
  let fence: { readonly marker: "`" | "~"; readonly length: number } | undefined;
  const lines = input.split("\n");
  const output = lines.map((line, index) => {
    const fenceCandidate = markdownFence(line);
    if (fence !== undefined) {
      if (
        fenceCandidate?.marker === fence.marker &&
        fenceCandidate.length >= fence.length &&
        fenceCandidate.trailing.length === 0
      ) {
        fence = undefined;
      }
      return line;
    }
    if (fenceCandidate !== null) {
      fence = { marker: fenceCandidate.marker, length: fenceCandidate.length };
      return line;
    }

    const references = parseMarkdownImageReferences(line);
    if (references.length === 0) {
      return line;
    }
    let cursor = 0;
    let protectedLine = "";
    for (const [referenceIndex, parsed] of references.entries()) {
      protectedLine += line.slice(cursor, parsed.start);
      const altText = sanitizePublicationImageAltText(parsed.altText);
      const resolution = resolver.resolve(parsed.source);
      if (!resolution.ok) {
        omitted = true;
        protectedLine += `[image omitted: ${escapeImageAltText(altText || "unlabelled")}]`;
      } else {
        let placeholder = `\uE000INKSHADOW_IMAGE_${String(index)}_${String(referenceIndex)}\uE001`;
        while (input.includes(placeholder) || restorations.has(placeholder)) {
          placeholder += "_";
        }
        restorations.set(
          placeholder,
          `![${escapeImageAltText(altText)}](${publicationImageDataUri(resolution.image)})`,
        );
        protectedLine += placeholder;
      }
      cursor = parsed.end;
    }
    return protectedLine + line.slice(cursor);
  });
  return { value: output.join("\n"), restorations, omitted };
}

function markdownFence(
  line: string,
): { readonly marker: "`" | "~"; readonly length: number; readonly trailing: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  const token = match?.[1];
  if (token === undefined) {
    return null;
  }
  return {
    marker: token[0] as "`" | "~",
    length: token.length,
    trailing: (match?.[2] ?? "").trim(),
  };
}

function escapeImageAltText(value: string): string {
  return value
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll("\\", "＼")
    .replaceAll("[", "［")
    .replaceAll("]", "］");
}

function escapeMarkdownSyntax(input: string): string {
  return escapeHtml(input)
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_[\]#>|])/g, "\\$1");
}

export function sanitizePlainText(input: string, fileName?: string): MarkdownSanitizationResult {
  const issues: ImportIssue[] = [];
  let normalized = assertTextPayload(input, fileName);

  if (normalized.startsWith("\uFEFF")) {
    normalized = normalized.slice(1);
    issues.push(
      warning("TEXT_BOM_REMOVED", "A leading Unicode byte-order mark was removed.", fileName),
    );
  }

  const externalReferences = removeExternalReferences(normalized);
  if (externalReferences.changed) {
    issues.push(
      warning(
        "MARKDOWN_EXTERNAL_REFERENCE_REMOVED",
        "Network references were converted to inert text.",
        fileName,
      ),
    );
  }

  const markdown = escapeMarkdownSyntax(externalReferences.value).trim();
  if (markdown.length === 0) {
    throw new ImportExportError(
      "MARKDOWN_EMPTY",
      "The imported document has no usable text.",
      fileOptions(fileName),
    );
  }
  if (utf8ByteLength(markdown) > IMPORT_LIMITS.maximumChapterBytes) {
    throw new ImportExportError(
      "IMPORT_FILE_TOO_LARGE",
      "The sanitized chapter exceeds the chapter size limit.",
      fileOptions(fileName),
    );
  }

  return {
    markdown,
    issues,
  };
}

function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.(?:docx|epub|html?|markdown|md|pdf|txt)$/i, "")
    .normalize("NFKC")
    .trim()
    .slice(0, IMPORT_LIMITS.maximumTitleCharacters);
}

interface ExtractedSection {
  readonly title: string;
  readonly text: string;
}

export interface ImportExtractedTextOptions {
  readonly originalBytes: number;
  readonly sourceFormat: "docx" | "pdf";
  readonly sourceSha256: string;
  readonly parserIssues?: readonly ImportIssue[];
}

const CHAPTER_HEADING =
  /^(?:(?:第[零〇一二三四五六七八九十百千万两\d]{1,12}[章节卷回部篇集])|(?:(?:chapter|part|book)\s+(?:[0-9ivxlcdm]+)))(?:[\s：:、.—-]+.{1,120})?$/iu;

/**
 * Converts text extracted by a non-rendering binary parser into previewable
 * chapter candidates. Low-confidence boundaries remain explicitly reviewable;
 * this function never writes project data.
 */
export function importExtractedTextDocuments(
  fileName: string,
  content: string,
  options: ImportExtractedTextOptions,
): readonly ImportedTextDocument[] {
  assertSafeInputFilename(fileName);
  assertDocumentExtension(fileName, [`.${options.sourceFormat}`]);
  const normalized = content
    .replaceAll("\f", "\n\n")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
  if (normalized.length === 0) {
    throw new ImportExportError(
      options.sourceFormat === "pdf" ? "PDF_TEXT_UNAVAILABLE" : "MARKDOWN_EMPTY",
      "The imported document has no extractable text.",
      { fileName },
    );
  }
  if (utf8ByteLength(normalized) > IMPORT_LIMITS.maximumTotalBytes) {
    throw new ImportExportError(
      "IMPORT_TOTAL_TOO_LARGE",
      "The extracted document text exceeds the import size limit.",
      { fileName },
    );
  }

  const baseTitle = titleFromFileName(fileName) || "Untitled";
  const detected = detectExtractedSections(normalized, baseTitle);
  const bounded = detected.sections.flatMap((section) => splitOversizedSection(section));
  if (bounded.length > IMPORT_LIMITS.maximumChapters) {
    throw new ImportExportError(
      "IMPORT_TOO_MANY_FILES",
      "The extracted document exceeds the chapter-count limit.",
      { fileName },
    );
  }

  const reviewIssue =
    detected.confidence < 0.75
      ? warning(
          "IMPORT_CHAPTER_BOUNDARY_REVIEW",
          "Chapter boundaries were not detected confidently and must be reviewed before import.",
          fileName,
        )
      : undefined;
  const splitIssue =
    bounded.length > detected.sections.length
      ? warning(
          "IMPORT_CHAPTER_SPLIT",
          "Oversized detected chapters were split into reviewable parts.",
          fileName,
        )
      : undefined;
  const commonIssues = [
    ...(options.parserIssues ?? []),
    ...(reviewIssue === undefined ? [] : [reviewIssue]),
    ...(splitIssue === undefined ? [] : [splitIssue]),
  ];

  return bounded.map((section, index) => {
    const result = sanitizePlainText(section.text, fileName);
    const title =
      bounded.length === 1
        ? section.title
        : section.title.length > 0
          ? section.title
          : `${baseTitle} ${String(index + 1)}`;
    return {
      sourceName: fileName,
      title,
      suggestedPath: `chapters/${sanitizeFilename(
        bounded.length === 1 ? title : `${String(index + 1).padStart(4, "0")}-${title}`,
        ".md",
      )}`,
      markdown: result.markdown,
      originalBytes: options.originalBytes,
      sanitizedBytes: utf8ByteLength(result.markdown),
      issues: [...commonIssues, ...result.issues],
      sourceFormat: options.sourceFormat,
      sourceSha256: options.sourceSha256,
      chapterDetectionConfidence: detected.confidence,
      requiresBoundaryReview: detected.confidence < 0.75 || splitIssue !== undefined,
    };
  });
}

function detectExtractedSections(
  content: string,
  fallbackTitle: string,
): {
  readonly confidence: number;
  readonly sections: readonly ExtractedSection[];
} {
  const lines = content.split("\n");
  const headingIndexes = lines.flatMap((line, index) =>
    CHAPTER_HEADING.test(line.trim()) ? [index] : [],
  );
  if (headingIndexes.length === 0) {
    return {
      confidence: 0.5,
      sections: [{ title: fallbackTitle, text: content }],
    };
  }

  const sections: ExtractedSection[] = [];
  const firstHeading = headingIndexes[0];
  const preface = lines.slice(0, firstHeading).join("\n").trim();
  if (preface.length > 0) {
    sections.push({ title: fallbackTitle, text: preface });
  }
  for (let index = 0; index < headingIndexes.length; index += 1) {
    const start = headingIndexes[index];
    if (start === undefined) {
      continue;
    }
    const end = headingIndexes[index + 1] ?? lines.length;
    const detectedTitle = lines[start]?.trim();
    const title =
      detectedTitle === undefined || detectedTitle.length === 0
        ? `${fallbackTitle} ${String(index + 1)}`
        : detectedTitle;
    const body = lines
      .slice(start + 1, end)
      .join("\n")
      .trim();
    sections.push({
      title,
      text: body.length === 0 ? title : body,
    });
  }
  return {
    confidence: headingIndexes.length >= 2 ? 0.9 : 0.8,
    sections,
  };
}

function splitOversizedSection(section: ExtractedSection): readonly ExtractedSection[] {
  if (utf8ByteLength(section.text) <= IMPORT_LIMITS.maximumChapterBytes) {
    return [section];
  }
  const chunks = splitTextAtByteLimit(section.text, IMPORT_LIMITS.maximumChapterBytes);
  return chunks.map((text, index) => ({
    title: `${section.title}（${String(index + 1)}）`,
    text,
  }));
}

function splitTextAtByteLimit(content: string, maximumBytes: number): readonly string[] {
  const chunks: string[] = [];
  let remaining = content.trim();
  while (utf8ByteLength(remaining) > maximumBytes) {
    let low = 1;
    let high = remaining.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8ByteLength(remaining.slice(0, middle)) <= maximumBytes) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    let boundary = low;
    const paragraphBoundary = remaining.lastIndexOf("\n\n", boundary);
    const lineBoundary = remaining.lastIndexOf("\n", boundary);
    const whitespaceBoundary = remaining.lastIndexOf(" ", boundary);
    const preferredBoundary = Math.max(paragraphBoundary, lineBoundary, whitespaceBoundary);
    if (preferredBoundary >= Math.floor(boundary * 0.6)) {
      boundary = preferredBoundary;
    }
    if (
      boundary > 0 &&
      boundary < remaining.length &&
      isLowSurrogate(remaining.charCodeAt(boundary)) &&
      isHighSurrogate(remaining.charCodeAt(boundary - 1))
    ) {
      boundary -= 1;
    }
    const chunk = remaining.slice(0, boundary).trim();
    if (chunk.length === 0) {
      throw new ImportExportError(
        "IMPORT_FILE_TOO_LARGE",
        "The extracted chapter could not be split safely.",
      );
    }
    chunks.push(chunk);
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function assertDocumentExtension(fileName: string, expected: readonly string[]): void {
  const extension = getAllowedImportExtension(fileName);
  if (!expected.includes(extension)) {
    throw new ImportExportError(
      "IMPORT_EXTENSION_FORBIDDEN",
      `The ${extension} file extension does not match this importer.`,
      { fileName },
    );
  }
}

export function importMarkdownDocument(fileName: string, content: string): ImportedTextDocument {
  assertSafeInputFilename(fileName);
  assertDocumentExtension(fileName, [".md", ".markdown"]);
  const originalBytes = utf8ByteLength(content);
  const result = sanitizeMarkdown(content, fileName);
  const title = titleFromFileName(fileName) || "Untitled";

  return {
    sourceName: fileName,
    title,
    suggestedPath: `chapters/${sanitizeFilename(title, ".md")}`,
    markdown: result.markdown,
    originalBytes,
    sanitizedBytes: utf8ByteLength(result.markdown),
    issues: result.issues,
  };
}

export function importPlainTextDocument(fileName: string, content: string): ImportedTextDocument {
  assertSafeInputFilename(fileName);
  assertDocumentExtension(fileName, [".txt"]);
  const originalBytes = utf8ByteLength(content);
  const result = sanitizePlainText(content, fileName);
  const title = titleFromFileName(fileName) || "Untitled";

  return {
    sourceName: fileName,
    title,
    suggestedPath: `chapters/${sanitizeFilename(title, ".md")}`,
    markdown: result.markdown,
    originalBytes,
    sanitizedBytes: utf8ByteLength(result.markdown),
    issues: result.issues,
  };
}

export function importHtmlDocument(fileName: string, content: string): ImportedTextDocument {
  assertSafeInputFilename(fileName);
  assertDocumentExtension(fileName, [".htm", ".html"]);
  const originalBytes = utf8ByteLength(content);
  const normalized = assertTextPayload(content, fileName);
  const activeElement =
    /<\s*\/?\s*(?:applet|audio|base|button|canvas|embed|form|frame|frameset|iframe|img|input|link|math|meta|object|script|select|source|style|svg|template|textarea|track|video)\b/iu;
  if (activeElement.test(normalized)) {
    throw new ImportExportError(
      "IMPORT_UNSAFE_CONTENT",
      "HTML containing active, embedded, form, style, or remote-resource elements is not accepted.",
      { fileName },
    );
  }

  const withoutComments = normalized
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/<!DOCTYPE[^>]*>/giu, "")
    .replaceAll(/<\?[\s\S]*?\?>/gu, "");
  const bodyMatch = /<\s*body(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*body\s*>/iu.exec(withoutComments);
  let text =
    bodyMatch?.[1] ?? withoutComments.replaceAll(/<\s*head\b[\s\S]*?<\s*\/\s*head\s*>/giu, "");
  text = text
    .replaceAll(/<\s*br(?:\s[^>]*)?\/?\s*>/giu, "\n")
    .replaceAll(/<\s*li(?:\s[^>]*)?>/giu, "\n• ")
    .replaceAll(
      /<\s*\/\s*(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\s*>/giu,
      "\n",
    )
    .replaceAll(/<[^>]{0,10000}>/gu, "")
    .replaceAll(/&(?:#x([a-f0-9]{1,6})|#([0-9]{1,7})|([a-z]{2,8}));/giu, decodeHtmlEntity)
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n");
  const result = sanitizePlainText(text, fileName);
  const title = titleFromFileName(fileName) || "Untitled";
  return {
    sourceName: fileName,
    title,
    suggestedPath: `chapters/${sanitizeFilename(title, ".md")}`,
    markdown: result.markdown,
    originalBytes,
    sanitizedBytes: utf8ByteLength(result.markdown),
    issues: [
      warning(
        "HTML_MARKUP_REMOVED",
        "HTML markup and attributes were removed; only inert local text was imported.",
        fileName,
      ),
      ...result.issues,
    ],
  };
}

function decodeHtmlEntity(
  entity: string,
  hexadecimal: string | undefined,
  decimal: string | undefined,
  named: string | undefined,
): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  if (named !== undefined) {
    return namedEntities[named.toLocaleLowerCase()] ?? entity;
  }
  const codePoint = Number.parseInt(
    hexadecimal ?? decimal ?? "",
    hexadecimal === undefined ? 10 : 16,
  );
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
}
