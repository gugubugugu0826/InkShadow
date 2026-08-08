import { sanitizeFilename } from "./filename.js";
import { normalizePortablePublication, type PortablePublication } from "./publication-model.js";
import { isoTimestampSchema, type PortableProjectV1 } from "./schemas.js";

export type EpubExportErrorCode =
  "EPUB_RENDER_FAILED" | "EXPORT_CANCELLED" | "EXPORT_OUTPUT_TOO_LARGE";

export type EpubExportStage = "normalizing" | "rendering" | "packaging";

export interface EpubExportProgress {
  readonly stage: EpubExportStage;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface EpubExportOptions {
  readonly generatedAt: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: EpubExportProgress) => void;
}

export interface EpubExportArtifact {
  readonly fileName: string;
  readonly mediaType: "application/epub+zip";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly issues: PortablePublication["warnings"];
}

export class EpubExportError extends Error {
  constructor(
    readonly code: EpubExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EpubExportError";
  }
}

export const EPUB_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const EPUB_MEDIA_TYPE = "application/epub+zip";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const EPUB_ROOT = "EPUB";
const ZIP_EPOCH_YEAR = 1980;
const ISO_TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const XML_INVALID_CHARACTER =
  /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu;
const METADATA_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

type PublicationChapter = PortablePublication["chapters"][number];
type PublicationBlock = PublicationChapter["blocks"][number];

interface EpubEntry {
  readonly name: string;
  readonly content: string;
  readonly compression: "STORE" | "DEFLATE";
}

export async function exportProjectToEpub(
  input: PortableProjectV1,
  options: EpubExportOptions,
): Promise<EpubExportArtifact> {
  throwIfCancelled(options.signal);
  reportProgress(options, "normalizing", 0, 1);
  const publication = normalizePortablePublication(input, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: () => throwIfCancelled(options.signal),
  });
  throwIfCancelled(options.signal);
  reportProgress(options, "normalizing", 1, 1);
  return exportPublicationToEpub(publication, options);
}

export async function exportPublicationToEpub(
  publication: PortablePublication,
  options: EpubExportOptions,
): Promise<EpubExportArtifact> {
  try {
    throwIfCancelled(options.signal);
    const generatedAt = normalizeGeneratedAt(options.generatedAt);
    const title = sanitizeMetadata(publication.project.title, "Untitled", 200);
    const description =
      publication.project.description === undefined
        ? undefined
        : sanitizeMetadata(publication.project.description, "", 1_024);
    const language = normalizeLanguage(publication.project.language);
    const identifier = sanitizeMetadata(
      `urn:inkshadow:project:${publication.project.id}`,
      "urn:inkshadow:project:untitled",
      512,
    );
    const chapters = [...publication.chapters].sort(compareChapters);
    const renderedChapters: EpubEntry[] = [];
    const renderUnits = Math.max(
      1,
      chapters.reduce((total, chapter) => total + 1 + chapter.blocks.length, 0),
    );
    let completedUnits = 0;
    reportProgress(options, "rendering", completedUnits, renderUnits);
    for (const [index, chapter] of chapters.entries()) {
      throwIfCancelled(options.signal);
      const fileName = chapterFileName(index);
      const rendered = renderChapter(chapter, language, () => {
        completedUnits += 1;
        reportProgress(options, "rendering", completedUnits, renderUnits);
      });
      completedUnits += 1;
      reportProgress(options, "rendering", completedUnits, renderUnits);
      renderedChapters.push({
        name: `${EPUB_ROOT}/${fileName}`,
        content: rendered,
        compression: "DEFLATE",
      });
    }
    if (chapters.length === 0) {
      reportProgress(options, "rendering", 1, 1);
    }

    const entries: readonly EpubEntry[] = [
      { name: "mimetype", content: EPUB_MEDIA_TYPE, compression: "STORE" },
      {
        name: "META-INF/container.xml",
        content: renderContainer(),
        compression: "DEFLATE",
      },
      {
        name: `${EPUB_ROOT}/package.opf`,
        content: renderPackage({
          chapters,
          description,
          generatedAt,
          identifier,
          language,
          title,
        }),
        compression: "DEFLATE",
      },
      {
        name: `${EPUB_ROOT}/nav.xhtml`,
        content: renderNavigation(chapters, language, title),
        compression: "DEFLATE",
      },
      {
        name: `${EPUB_ROOT}/styles.css`,
        content: renderStyles(),
        compression: "DEFLATE",
      },
      ...renderedChapters,
    ];

    const { default: JSZip } = await import("jszip");
    throwIfCancelled(options.signal);
    const zip = new JSZip();
    reportProgress(options, "packaging", 0, entries.length);
    for (const [index, entry] of entries.entries()) {
      throwIfCancelled(options.signal);
      zip.file(entry.name, entry.content, {
        binary: false,
        compression: entry.compression,
        ...(entry.compression === "DEFLATE" ? { compressionOptions: { level: 9 } } : {}),
        createFolders: false,
        date: fixedZipDate(),
      });
      reportProgress(options, "packaging", index + 1, entries.length);
    }

    const bytes = await zip.generateAsync(
      {
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
        platform: "DOS",
        streamFiles: false,
        mimeType: EPUB_MEDIA_TYPE,
      },
      () => throwIfCancelled(options.signal),
    );
    throwIfCancelled(options.signal);
    if (bytes.byteLength > EPUB_OUTPUT_LIMIT_BYTES) {
      throw new EpubExportError(
        "EXPORT_OUTPUT_TOO_LARGE",
        "The EPUB export exceeds the 64 MiB output limit.",
      );
    }

    return {
      fileName: sanitizeFilename(title, ".epub"),
      mediaType: EPUB_MEDIA_TYPE,
      bytes,
      byteLength: bytes.byteLength,
      issues: publication.warnings,
    };
  } catch (error: unknown) {
    if (error instanceof EpubExportError) {
      throw error;
    }
    if (options.signal?.aborted === true) {
      throw new EpubExportError("EXPORT_CANCELLED", "The EPUB export was cancelled.");
    }
    throw new EpubExportError(
      "EPUB_RENDER_FAILED",
      "The EPUB publication could not be rendered safely.",
    );
  }
}

function renderContainer(): string {
  return `${XML_DECLARATION}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="${EPUB_ROOT}/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
}

function renderPackage(input: {
  readonly chapters: readonly PublicationChapter[];
  readonly description: string | undefined;
  readonly generatedAt: string;
  readonly identifier: string;
  readonly language: string;
  readonly title: string;
}): string {
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="styles" href="styles.css" media-type="text/css"/>',
    ...input.chapters.map(
      (_chapter, index) =>
        `<item id="chapter-${String(index + 1)}" href="${chapterFileName(index)}" media-type="application/xhtml+xml"/>`,
    ),
  ].join("");
  const spine = input.chapters
    .map((_chapter, index) => `<itemref idref="chapter-${String(index + 1)}"/>`)
    .join("");
  const description =
    input.description === undefined || input.description.length === 0
      ? ""
      : `<dc:description>${escapeXml(input.description)}</dc:description>`;
  return [
    XML_DECLARATION,
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="',
    escapeXml(input.language),
    '"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">',
    `<dc:identifier id="pub-id">${escapeXml(input.identifier)}</dc:identifier>`,
    `<dc:title>${escapeXml(input.title)}</dc:title>`,
    '<dc:creator id="creator">InkShadow</dc:creator>',
    `<dc:language>${escapeXml(input.language)}</dc:language>`,
    description,
    `<meta property="dcterms:modified">${escapeXml(epubModifiedTimestamp(input.generatedAt))}</meta>`,
    "</metadata><manifest>",
    manifest,
    "</manifest><spine>",
    spine,
    "</spine></package>",
  ].join("");
}

function renderNavigation(
  chapters: readonly PublicationChapter[],
  language: string,
  title: string,
): string {
  const items = chapters
    .map(
      (chapter, index) =>
        `<li><a href="${chapterFileName(index)}">${escapeXml(chapter.title)}</a></li>`,
    )
    .join("");
  return `${XML_DECLARATION}<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}"><head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body><nav epub:type="toc" id="toc" aria-labelledby="toc-title"><h1 id="toc-title">目录</h1><ol>${items}</ol></nav></body></html>`;
}

function renderChapter(
  chapter: PublicationChapter,
  language: string,
  onBlockRendered: () => void,
): string {
  const body: string[] = [];
  for (let index = 0; index < chapter.blocks.length; index += 1) {
    const block = chapter.blocks[index];
    if (block === undefined) {
      continue;
    }
    if (block.kind === "unorderedListItem" || block.kind === "orderedListItem") {
      const kind = block.kind;
      const depth = clampListDepth(block.depth);
      const items: PublicationBlock[] = [];
      while (index < chapter.blocks.length) {
        const candidate = chapter.blocks[index];
        if (candidate?.kind !== kind || clampListDepth(candidate.depth) !== depth) {
          break;
        }
        items.push(candidate);
        onBlockRendered();
        index += 1;
      }
      index -= 1;
      if (kind === "unorderedListItem") {
        body.push(
          `<ul class="list-depth-${String(depth)}">${items
            .map((item) => `<li>${renderText("text" in item ? item.text : "")}</li>`)
            .join("")}</ul>`,
        );
      } else {
        const orderedItems = items.filter(
          (item): item is Extract<PublicationBlock, { readonly kind: "orderedListItem" }> =>
            item.kind === "orderedListItem",
        );
        const firstOrdinal = orderedItems[0]?.ordinal ?? 1;
        body.push(
          `<ol class="list-depth-${String(depth)}" start="${String(firstOrdinal)}">${orderedItems
            .map(
              (item) =>
                `<li value="${String(Math.max(1, item.ordinal))}">${renderText(item.text)}</li>`,
            )
            .join("")}</ol>`,
        );
      }
      continue;
    }
    body.push(renderBlock(block));
    onBlockRendered();
  }
  const title = escapeXml(chapter.title);
  return `${XML_DECLARATION}<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}"><head><meta charset="UTF-8"/><title>${title}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body epub:type="bodymatter"><section epub:type="chapter"><h1>${title}</h1>${body.join("")}</section></body></html>`;
}

function renderBlock(
  block: Exclude<
    PublicationBlock,
    { readonly kind: "unorderedListItem" } | { readonly kind: "orderedListItem" }
  >,
): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(6, block.level + 1);
      return `<h${String(level)}>${renderText(block.text)}</h${String(level)}>`;
    }
    case "paragraph":
      return `<p>${renderText(block.text)}</p>`;
    case "quote":
      return `<blockquote><p>${renderText(block.text)}</p></blockquote>`;
    case "code": {
      const languageClass =
        block.language === undefined ? "" : ` class="language-${escapeXml(block.language)}"`;
      return `<pre><code${languageClass}>${escapeXml(block.text)}</code></pre>`;
    }
    case "sceneBreak":
      return '<hr class="scene-break" aria-label="场景分隔"/>';
  }
}

function renderText(value: string): string {
  return escapeXml(value).replaceAll("\n", "<br/>");
}

function renderStyles(): string {
  return [
    '@charset "UTF-8";',
    "html { color: #24211c; background: #fcfaf6; }",
    'body { margin: 5%; font-family: "Noto Serif CJK SC", "Source Han Serif SC", serif; font-size: 1em; line-height: 1.75; }',
    "section { max-width: 44em; margin: 0 auto; }",
    'h1, h2, h3, h4, h5, h6 { font-family: "Noto Sans CJK SC", sans-serif; line-height: 1.35; break-after: avoid; }',
    "h1 { text-align: center; margin: 2em 0 1.5em; }",
    "p { margin: 0; text-indent: 2em; orphans: 2; widows: 2; }",
    "blockquote { margin: 1em 1.5em; padding-left: 1em; border-left: 0.2em solid #9aa3b2; }",
    "blockquote p, li p { text-indent: 0; }",
    "pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 0.8em; background: #f0ede7; }",
    "code { font-family: monospace; }",
    "ul, ol { margin: 0.75em 0 0.75em 2em; }",
    ".list-depth-1 { margin-left: 3em; }",
    ".list-depth-2, .list-depth-3, .list-depth-4, .list-depth-5, .list-depth-6, .list-depth-7, .list-depth-8 { margin-left: 4em; }",
    ".scene-break { width: 30%; margin: 2em auto; border: 0; border-top: 0.08em solid #9aa3b2; }",
    "nav ol { line-height: 1.8; }",
    "nav a { color: inherit; text-decoration: none; }",
  ].join("\n");
}

function normalizeGeneratedAt(value: string): string {
  if (!ISO_TIMESTAMP_WITH_OFFSET.test(value) || !isoTimestampSchema.safeParse(value).success) {
    throw new EpubExportError(
      "EPUB_RENDER_FAILED",
      "generatedAt must be a valid ISO 8601 timestamp with a time-zone offset.",
    );
  }
  return new Date(value).toISOString();
}

function epubModifiedTimestamp(value: string): string {
  return value.replace(/\.\d{3}Z$/u, "Z");
}

function normalizeLanguage(value: string): string {
  const normalized = sanitizeMetadata(value, "und", 35);
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(normalized) ? normalized : "und";
}

function sanitizeMetadata(value: string, fallback: string, maximumCharacters: number): string {
  const normalized = sanitizeXmlText(value)
    .replaceAll(METADATA_CONTROL, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(normalized).slice(0, maximumCharacters).join("");
  return bounded.length === 0 ? fallback : bounded;
}

function sanitizeXmlText(value: string): string {
  return value.replaceAll(XML_INVALID_CHARACTER, "\uFFFD");
}

function escapeXml(value: string): string {
  return sanitizeXmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function chapterFileName(index: number): string {
  return `chapter-${String(index + 1).padStart(5, "0")}.xhtml`;
}

function compareChapters(left: PublicationChapter, right: PublicationChapter): number {
  return left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function clampListDepth(depth: number): number {
  return Math.max(0, Math.min(8, depth));
}

function fixedZipDate(): Date {
  return new Date(Date.UTC(ZIP_EPOCH_YEAR, 0, 1, 0, 0, 0, 0));
}

function reportProgress(
  options: EpubExportOptions,
  stage: EpubExportStage,
  completedUnits: number,
  totalUnits: number,
): void {
  throwIfCancelled(options.signal);
  options.onProgress?.({ stage, completedUnits, totalUnits });
  throwIfCancelled(options.signal);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new EpubExportError("EXPORT_CANCELLED", "The EPUB export was cancelled.");
  }
}
