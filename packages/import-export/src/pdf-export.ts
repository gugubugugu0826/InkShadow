import { sanitizeFilename } from "./filename.js";
import { normalizePortablePublication, type PortablePublication } from "./publication-model.js";
import {
  PUBLICATION_IMAGE_LIMITS,
  isValidatedPublicationImage,
  type PublicationImageAsset,
} from "./publication-images.js";
import { isoTimestampSchema, type PortableProjectV1 } from "./schemas.js";

export type PdfExportErrorCode =
  | "PDF_RENDER_FAILED"
  | "PDF_COMPLEXITY_LIMIT_EXCEEDED"
  | "EXPORT_CANCELLED"
  | "EXPORT_OUTPUT_TOO_LARGE";

export type PdfExportStage = "normalizing" | "laying_out" | "rasterizing" | "assembling";

export interface PdfExportProgress {
  readonly stage: PdfExportStage;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface PdfRasterizerProgress {
  readonly stage: "laying_out" | "rasterizing";
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface PdfRasterPage {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly jpegBytes: Uint8Array;
}

export interface PdfPageRasterizerContext {
  readonly signal?: AbortSignal;
  readonly renderSpec: typeof PDF_RENDER_SPEC;
  readonly reportProgress: (progress: PdfRasterizerProgress) => void;
}

export type PdfPageRasterizer = (
  publication: PortablePublication,
  context: PdfPageRasterizerContext,
) => AsyncIterable<PdfRasterPage> | Iterable<PdfRasterPage>;

export interface PdfExportOptions {
  /**
   * Explicit time input keeps the package deterministic and prevents an
   * exporter from consulting the system clock.
   */
  readonly generatedAt: string;
  readonly rasterize: PdfPageRasterizer;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PdfExportProgress) => void;
  readonly imageAssets?: readonly PublicationImageAsset[];
}

export interface PdfAssemblyOptions {
  readonly title: string;
  readonly generatedAt: string;
  readonly pages: readonly PdfRasterPage[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PdfExportProgress) => void;
}

export interface PdfExportArtifact {
  readonly fileName: string;
  readonly mediaType: "application/pdf";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly pageCount: number;
  /**
   * Pages are intentionally rasterized so CJK glyphs never depend on a PDF
   * viewer's font substitution. This also means text is not selectable.
   */
  readonly renderingMode: "image-based";
  readonly issues: PortablePublication["warnings"];
}

export class PdfExportError extends Error {
  constructor(
    readonly code: PdfExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfExportError";
  }
}

export const PDF_RENDER_SPEC = Object.freeze({
  pageWidthPoints: 595.28,
  pageHeightPoints: 841.89,
  pixelWidth: 1_240,
  pixelHeight: 1_754,
  jpegQuality: 0.9,
});

export const PDF_EXPORT_LIMITS = Object.freeze({
  maximumPages: 1_000,
  maximumOutputBytes: 64 * 1024 * 1024,
  maximumPageJpegBytes: 8 * 1024 * 1024,
  maximumTextCharacters: 2 * 1024 * 1024,
  maximumBlocks: 50_000,
  maximumChapters: 2_000,
  maximumMetadataCharacters: 1_024,
});

const PDF_MEDIA_TYPE = "application/pdf";
const PDF_PAGE_WIDTH = "595.28";
const PDF_PAGE_HEIGHT = "841.89";
const ISO_TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PDF_METADATA_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const JPEG_BASELINE_START_OF_FRAME = 0xc0;
const PUBLICATION_BLOCK_KINDS = new Set([
  "heading",
  "paragraph",
  "unorderedListItem",
  "orderedListItem",
  "quote",
  "code",
  "sceneBreak",
  "image",
]);

interface JpegDimensions {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly precision: number;
}

interface JpegFrame extends JpegDimensions {
  readonly componentIds: ReadonlySet<number>;
  readonly quantizationTableIds: ReadonlySet<number>;
}

interface JpegHuffmanTables {
  readonly dc: ReadonlySet<number>;
  readonly ac: ReadonlySet<number>;
}

class ByteWriter {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  pushAscii(value: string): void {
    for (const character of value) {
      if ((character.codePointAt(0) ?? 0) > 0x7f) {
        throw new PdfExportError(
          "PDF_RENDER_FAILED",
          "The PDF assembler received non-ASCII structural content.",
        );
      }
    }
    this.pushBytes(new TextEncoder().encode(value));
  }

  pushBytes(value: Uint8Array): void {
    if (value.byteLength === 0) {
      return;
    }
    this.#chunks.push(value);
    this.#length += value.byteLength;
    if (this.#length > PDF_EXPORT_LIMITS.maximumOutputBytes) {
      throw new PdfExportError(
        "EXPORT_OUTPUT_TOO_LARGE",
        "The PDF export exceeds the 64 MiB output limit.",
      );
    }
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

export async function exportProjectToPdf(
  input: PortableProjectV1,
  options: PdfExportOptions,
): Promise<PdfExportArtifact> {
  throwIfCancelled(options.signal);
  reportProgress(options, "normalizing", 0, 1);
  try {
    const publication = normalizePortablePublication(input, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.imageAssets === undefined ? {} : { imageAssets: options.imageAssets }),
      onProgress: () => {
        throwIfCancelled(options.signal);
      },
    });
    throwIfCancelled(options.signal);
    reportProgress(options, "normalizing", 1, 1);
    return await exportPublicationToPdf(publication, options);
  } catch (error: unknown) {
    throw normalizeExportError(error, options.signal);
  }
}

export async function exportPublicationToPdf(
  publication: PortablePublication,
  options: PdfExportOptions,
): Promise<PdfExportArtifact> {
  try {
    throwIfCancelled(options.signal);
    assertPublicationWithinPdfLimits(publication);
    const generatedAt = normalizeGeneratedAt(options.generatedAt);
    const title = sanitizeMetadata(publication.project.title, "Untitled", 200);
    const pages: PdfRasterPage[] = [];
    let rasterBytes = 0;

    const source = options.rasterize(publication, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      renderSpec: PDF_RENDER_SPEC,
      reportProgress(progress) {
        throwIfCancelled(options.signal);
        reportProgress(options, progress.stage, progress.completedUnits, progress.totalUnits);
      },
    });

    for await (const page of source) {
      throwIfCancelled(options.signal);
      if (pages.length >= PDF_EXPORT_LIMITS.maximumPages) {
        throw new PdfExportError(
          "PDF_COMPLEXITY_LIMIT_EXCEEDED",
          `The PDF export exceeds the ${String(PDF_EXPORT_LIMITS.maximumPages)} page limit.`,
        );
      }
      assertRasterPage(page);
      rasterBytes += page.jpegBytes.byteLength;
      if (rasterBytes > PDF_EXPORT_LIMITS.maximumOutputBytes) {
        throw new PdfExportError(
          "EXPORT_OUTPUT_TOO_LARGE",
          "The rasterized PDF pages exceed the 64 MiB output limit.",
        );
      }
      pages.push({
        pixelWidth: page.pixelWidth,
        pixelHeight: page.pixelHeight,
        jpegBytes: page.jpegBytes.slice(),
      });
    }
    throwIfCancelled(options.signal);
    if (pages.length === 0) {
      throw new PdfExportError("PDF_RENDER_FAILED", "The PDF renderer did not produce any pages.");
    }

    const bytes = assembleRasterizedPdf({
      title,
      generatedAt,
      pages,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    return Object.freeze({
      fileName: sanitizeFilename(title, ".pdf"),
      mediaType: PDF_MEDIA_TYPE,
      bytes,
      byteLength: bytes.byteLength,
      pageCount: pages.length,
      renderingMode: "image-based",
      issues: publication.warnings,
    });
  } catch (error: unknown) {
    throw normalizeExportError(error, options.signal);
  }
}

/**
 * Deterministic, DOM-independent PDF assembler. It accepts only validated A4
 * JPEG pages and emits no links, scripts, forms, attachments, or remote
 * references.
 */
export function assembleRasterizedPdf(options: PdfAssemblyOptions): Uint8Array {
  try {
    throwIfCancelled(options.signal);
    const generatedAt = normalizeGeneratedAt(options.generatedAt);
    const title = sanitizeMetadata(options.title, "Untitled", 200);
    if (options.pages.length === 0) {
      throw new PdfExportError("PDF_RENDER_FAILED", "A PDF must contain at least one page.");
    }
    if (options.pages.length > PDF_EXPORT_LIMITS.maximumPages) {
      throw new PdfExportError(
        "PDF_COMPLEXITY_LIMIT_EXCEEDED",
        `The PDF export exceeds the ${String(PDF_EXPORT_LIMITS.maximumPages)} page limit.`,
      );
    }
    for (const page of options.pages) {
      throwIfCancelled(options.signal);
      assertRasterPage(page);
    }

    const writer = new ByteWriter();
    const pageIds = options.pages.map((_page, index) => 3 + index * 3);
    const infoId = 3 + options.pages.length * 3;
    const objectCount = infoId;
    const offsets = Array<number>(objectCount + 1).fill(0);
    writer.pushBytes(
      Uint8Array.of(
        0x25,
        0x50,
        0x44,
        0x46,
        0x2d,
        0x31,
        0x2e,
        0x37,
        0x0a,
        0x25,
        0xe2,
        0xe3,
        0xcf,
        0xd3,
        0x0a,
      ),
    );

    const writeObject = (id: number, writeBody: () => void): void => {
      throwIfCancelled(options.signal);
      offsets[id] = writer.length;
      writer.pushAscii(`${String(id)} 0 obj\n`);
      writeBody();
      writer.pushAscii("\nendobj\n");
    };

    reportAssemblyProgress(options, 0, objectCount);
    writeObject(1, () => {
      writer.pushAscii("<< /Type /Catalog /Pages 2 0 R >>");
    });
    reportAssemblyProgress(options, 1, objectCount);
    writeObject(2, () => {
      writer.pushAscii(
        `<< /Type /Pages /Count ${String(options.pages.length)} /Kids [${pageIds
          .map((id) => `${String(id)} 0 R`)
          .join(" ")}] >>`,
      );
    });
    reportAssemblyProgress(options, 2, objectCount);

    for (const [index, page] of options.pages.entries()) {
      const pageId = pageIds[index];
      if (pageId === undefined) {
        throw new PdfExportError("PDF_RENDER_FAILED", "The PDF page index is invalid.");
      }
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      const content = new TextEncoder().encode(
        `q\n${PDF_PAGE_WIDTH} 0 0 ${PDF_PAGE_HEIGHT} 0 0 cm\n/Im0 Do\nQ\n`,
      );
      writeObject(pageId, () => {
        writer.pushAscii(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] ` +
            `/Resources << /XObject << /Im0 ${String(imageId)} 0 R >> >> ` +
            `/Contents ${String(contentId)} 0 R >>`,
        );
      });
      reportAssemblyProgress(options, pageId, objectCount);
      writeObject(imageId, () => {
        writer.pushAscii(
          `<< /Type /XObject /Subtype /Image /Width ${String(page.pixelWidth)} ` +
            `/Height ${String(page.pixelHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
            `/Interpolate false /Filter /DCTDecode /Length ${String(page.jpegBytes.byteLength)} >>\nstream\n`,
        );
        writer.pushBytes(page.jpegBytes);
        writer.pushAscii("\nendstream");
      });
      reportAssemblyProgress(options, imageId, objectCount);
      writeObject(contentId, () => {
        writer.pushAscii(`<< /Length ${String(content.byteLength)} >>\nstream\n`);
        writer.pushBytes(content);
        writer.pushAscii("endstream");
      });
      reportAssemblyProgress(options, contentId, objectCount);
    }

    writeObject(infoId, () => {
      const timestamp = pdfTimestamp(generatedAt);
      writer.pushAscii(
        `<< /Title ${pdfUtf16HexString(title)} /Creator ${pdfUtf16HexString("InkShadow")} ` +
          `/Producer ${pdfUtf16HexString("InkShadow deterministic image PDF exporter")} ` +
          `/Subject ${pdfUtf16HexString(
            "Image-based offline rasterized A4 publication; text is not selectable.",
          )} ` +
          `/Keywords ${pdfUtf16HexString("InkShadow, image-based, offline, A4")} ` +
          `/CreationDate (${timestamp}) /ModDate (${timestamp}) >>`,
      );
    });
    reportAssemblyProgress(options, objectCount, objectCount);

    const xrefOffset = writer.length;
    writer.pushAscii(`xref\n0 ${String(objectCount + 1)}\n`);
    writer.pushAscii("0000000000 65535 f \n");
    for (let id = 1; id <= objectCount; id += 1) {
      const offset = offsets[id];
      if (offset === undefined || offset <= 0 || offset > 9_999_999_999) {
        throw new PdfExportError("PDF_RENDER_FAILED", "The PDF object offset is invalid.");
      }
      writer.pushAscii(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }
    writer.pushAscii(
      `trailer\n<< /Size ${String(objectCount + 1)} /Root 1 0 R /Info ${String(
        infoId,
      )} 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`,
    );
    throwIfCancelled(options.signal);
    return writer.finish();
  } catch (error: unknown) {
    throw normalizeExportError(error, options.signal);
  }
}

function assertPublicationWithinPdfLimits(publication: PortablePublication): void {
  const candidate: unknown = publication;
  if (!isRecord(candidate)) {
    throw new PdfExportError("PDF_RENDER_FAILED", "The publication model is invalid.");
  }
  if (candidate.format !== "inkshadow-portable-publication" || candidate.version !== 1) {
    throw new PdfExportError("PDF_RENDER_FAILED", "The publication model is invalid.");
  }
  const project = candidate.project;
  const chapters = candidate.chapters;
  if (!isRecord(project) || typeof project.title !== "string" || !isUnknownArray(chapters)) {
    throw new PdfExportError("PDF_RENDER_FAILED", "The publication model is invalid.");
  }
  const projectTitle = project.title;
  const description = project.description;
  if (description !== undefined && typeof description !== "string") {
    throw new PdfExportError("PDF_RENDER_FAILED", "The publication metadata is invalid.");
  }
  if (chapters.length > PDF_EXPORT_LIMITS.maximumChapters) {
    throw new PdfExportError(
      "PDF_COMPLEXITY_LIMIT_EXCEEDED",
      `The PDF export exceeds the ${String(PDF_EXPORT_LIMITS.maximumChapters)} chapter limit.`,
    );
  }

  let blocks = 0;
  let textCharacters = projectTitle.length + (description?.length ?? 0);
  let imageCount = 0;
  let imageBytes = 0;
  for (const chapter of chapters) {
    if (!isRecord(chapter)) {
      throw new PdfExportError("PDF_RENDER_FAILED", "A publication chapter is invalid.");
    }
    const chapterTitle = chapter.title;
    const chapterBlocks = chapter.blocks;
    if (typeof chapterTitle !== "string" || !isUnknownArray(chapterBlocks)) {
      throw new PdfExportError("PDF_RENDER_FAILED", "A publication chapter is invalid.");
    }
    blocks += chapterBlocks.length;
    textCharacters += chapterTitle.length;
    if (blocks > PDF_EXPORT_LIMITS.maximumBlocks) {
      throw new PdfExportError(
        "PDF_COMPLEXITY_LIMIT_EXCEEDED",
        `The PDF export exceeds the ${String(PDF_EXPORT_LIMITS.maximumBlocks)} block limit.`,
      );
    }
    for (const block of chapterBlocks) {
      if (!isRecord(block)) {
        throw new PdfExportError("PDF_RENDER_FAILED", "A publication block is invalid.");
      }
      const kind = block.kind;
      const text = block.text;
      if (typeof kind !== "string" || !PUBLICATION_BLOCK_KINDS.has(kind)) {
        throw new PdfExportError("PDF_RENDER_FAILED", "A publication block is invalid.");
      }
      if (kind !== "sceneBreak" && typeof text !== "string") {
        if (kind !== "image") {
          throw new PdfExportError("PDF_RENDER_FAILED", "A publication text block is invalid.");
        }
      }
      if (typeof text === "string") {
        textCharacters += text.length;
      }
      if (textCharacters > PDF_EXPORT_LIMITS.maximumTextCharacters) {
        throw new PdfExportError(
          "PDF_COMPLEXITY_LIMIT_EXCEEDED",
          `The PDF export exceeds the ${String(
            PDF_EXPORT_LIMITS.maximumTextCharacters,
          )} character limit.`,
        );
      }
      if (kind === "image") {
        const mediaType = block.mediaType;
        const bytes = block.bytes;
        const pixelWidth = block.pixelWidth;
        const pixelHeight = block.pixelHeight;
        const altText = block.altText;
        if (
          (mediaType !== "image/png" && mediaType !== "image/jpeg") ||
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength === 0 ||
          bytes.byteLength > PUBLICATION_IMAGE_LIMITS.maximumImageBytes ||
          typeof pixelWidth !== "number" ||
          typeof pixelHeight !== "number" ||
          !Number.isSafeInteger(pixelWidth) ||
          !Number.isSafeInteger(pixelHeight) ||
          pixelWidth <= 0 ||
          pixelHeight <= 0 ||
          pixelWidth > PUBLICATION_IMAGE_LIMITS.maximumDimensionPixels ||
          pixelHeight > PUBLICATION_IMAGE_LIMITS.maximumDimensionPixels ||
          pixelWidth * pixelHeight > PUBLICATION_IMAGE_LIMITS.maximumPixelCount ||
          typeof altText !== "string" ||
          altText.length > PUBLICATION_IMAGE_LIMITS.maximumAltCharacters ||
          !isValidatedPublicationImage({
            bytes,
            mediaType,
            pixelHeight,
            pixelWidth,
          })
        ) {
          throw new PdfExportError("PDF_RENDER_FAILED", "A publication image block is invalid.");
        }
        imageCount += 1;
        imageBytes += bytes.byteLength;
        if (
          imageCount > PUBLICATION_IMAGE_LIMITS.maximumImages ||
          imageBytes > PUBLICATION_IMAGE_LIMITS.maximumTotalImageBytes
        ) {
          throw new PdfExportError(
            "PDF_COMPLEXITY_LIMIT_EXCEEDED",
            "The PDF publication exceeds the fixed image budget.",
          );
        }
        textCharacters += altText.length;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function assertRasterPage(page: PdfRasterPage): void {
  if (
    !Number.isSafeInteger(page.pixelWidth) ||
    !Number.isSafeInteger(page.pixelHeight) ||
    page.pixelWidth !== PDF_RENDER_SPEC.pixelWidth ||
    page.pixelHeight !== PDF_RENDER_SPEC.pixelHeight ||
    !(page.jpegBytes instanceof Uint8Array)
  ) {
    throw new PdfExportError(
      "PDF_RENDER_FAILED",
      "A rasterized page does not match the fixed A4 render specification.",
    );
  }
  if (page.jpegBytes.byteLength > PDF_EXPORT_LIMITS.maximumPageJpegBytes) {
    throw new PdfExportError(
      "EXPORT_OUTPUT_TOO_LARGE",
      "A rasterized PDF page exceeds the 8 MiB page limit.",
    );
  }
  const dimensions = readJpegDimensions(page.jpegBytes);
  if (
    dimensions?.width !== page.pixelWidth ||
    dimensions.height !== page.pixelHeight ||
    dimensions.precision !== 8 ||
    dimensions.components !== 3
  ) {
    throw new PdfExportError(
      "PDF_RENDER_FAILED",
      "A rasterized page is not a supported 8-bit RGB JPEG with the required A4 dimensions.",
    );
  }
}

function readJpegDimensions(bytes: Uint8Array): JpegDimensions | null {
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return null;
  }
  const quantizationTableIds = new Set<number>();
  const huffmanTableIds = {
    dc: new Set<number>(),
    ac: new Set<number>(),
  };
  let frame: JpegFrame | null = null;
  let offset = 2;
  while (offset < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (bytes[offset] === 0xff && offset < bytes.byteLength - 2) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (
      marker === undefined ||
      marker === 0x00 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return null;
    }
    const high = bytes[offset];
    const low = bytes[offset + 1];
    if (high === undefined || low === undefined) {
      return null;
    }
    const length = high * 256 + low;
    if (length < 2 || offset + length > bytes.byteLength) {
      return null;
    }
    if (marker === 0xdb) {
      if (!readJpegQuantizationTables(bytes, offset + 2, offset + length, quantizationTableIds)) {
        return null;
      }
    } else if (marker === 0xc4) {
      if (!readJpegHuffmanTables(bytes, offset + 2, offset + length, huffmanTableIds)) {
        return null;
      }
    } else if (marker === JPEG_BASELINE_START_OF_FRAME) {
      if (frame !== null) {
        return null;
      }
      frame = readJpegBaselineFrame(bytes, offset, length);
      if (frame === null) {
        return null;
      }
    } else if (marker === 0xda) {
      if (
        frame === null ||
        !readJpegStartOfScan(bytes, offset, length, frame, quantizationTableIds, huffmanTableIds) ||
        !hasJpegEntropyAndTerminalEoi(bytes, offset + length)
      ) {
        return null;
      }
      return frame;
    } else if (
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return null;
    }
    offset += length;
  }
  return null;
}

function readJpegQuantizationTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  tableIds: Set<number>,
): boolean {
  let offset = start;
  let tables = 0;
  while (offset < end) {
    const descriptor = bytes[offset];
    if (descriptor === undefined) {
      return false;
    }
    const precision = descriptor >> 4;
    const tableId = descriptor & 0x0f;
    if ((precision !== 0 && precision !== 1) || tableId > 3) {
      return false;
    }
    offset += 1 + 64 * (precision + 1);
    if (offset > end) {
      return false;
    }
    tableIds.add(tableId);
    tables += 1;
  }
  return tables > 0 && offset === end;
}

function readJpegHuffmanTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  tables: { readonly dc: Set<number>; readonly ac: Set<number> },
): boolean {
  let offset = start;
  let tableCount = 0;
  while (offset < end) {
    const descriptor = bytes[offset];
    if (descriptor === undefined || offset + 17 > end) {
      return false;
    }
    const tableClass = descriptor >> 4;
    const tableId = descriptor & 0x0f;
    if ((tableClass !== 0 && tableClass !== 1) || tableId > 3) {
      return false;
    }
    let symbolCount = 0;
    for (let index = 1; index <= 16; index += 1) {
      symbolCount += bytes[offset + index] ?? 0;
    }
    if (symbolCount < 1 || symbolCount > 256 || offset + 17 + symbolCount > end) {
      return false;
    }
    (tableClass === 0 ? tables.dc : tables.ac).add(tableId);
    offset += 17 + symbolCount;
    tableCount += 1;
  }
  return tableCount > 0 && offset === end;
}

function readJpegBaselineFrame(
  bytes: Uint8Array,
  offset: number,
  length: number,
): JpegFrame | null {
  const precision = bytes[offset + 2];
  const heightHigh = bytes[offset + 3];
  const heightLow = bytes[offset + 4];
  const widthHigh = bytes[offset + 5];
  const widthLow = bytes[offset + 6];
  const components = bytes[offset + 7];
  if (
    precision === undefined ||
    heightHigh === undefined ||
    heightLow === undefined ||
    widthHigh === undefined ||
    widthLow === undefined ||
    components === undefined ||
    components < 1 ||
    components > 4 ||
    length !== 8 + components * 3
  ) {
    return null;
  }
  const componentIds = new Set<number>();
  const quantizationTableIds = new Set<number>();
  for (let index = 0; index < components; index += 1) {
    const componentOffset = offset + 8 + index * 3;
    const componentId = bytes[componentOffset];
    const sampling = bytes[componentOffset + 1];
    const tableId = bytes[componentOffset + 2];
    if (
      componentId === undefined ||
      sampling === undefined ||
      tableId === undefined ||
      componentIds.has(componentId) ||
      sampling >> 4 < 1 ||
      sampling >> 4 > 4 ||
      (sampling & 0x0f) < 1 ||
      (sampling & 0x0f) > 4 ||
      tableId > 3
    ) {
      return null;
    }
    componentIds.add(componentId);
    quantizationTableIds.add(tableId);
  }
  const width = widthHigh * 256 + widthLow;
  const height = heightHigh * 256 + heightLow;
  if (width === 0 || height === 0) {
    return null;
  }
  return {
    precision,
    height,
    width,
    components,
    componentIds,
    quantizationTableIds,
  };
}

function readJpegStartOfScan(
  bytes: Uint8Array,
  offset: number,
  length: number,
  frame: JpegFrame,
  quantizationTableIds: ReadonlySet<number>,
  huffmanTables: JpegHuffmanTables,
): boolean {
  const scanComponents = bytes[offset + 2];
  if (
    scanComponents === undefined ||
    scanComponents !== frame.components ||
    length !== 6 + scanComponents * 2 ||
    [...frame.quantizationTableIds].some((tableId) => !quantizationTableIds.has(tableId))
  ) {
    return false;
  }
  const seenComponents = new Set<number>();
  for (let index = 0; index < scanComponents; index += 1) {
    const componentId = bytes[offset + 3 + index * 2];
    const tableSelector = bytes[offset + 4 + index * 2];
    if (
      componentId === undefined ||
      tableSelector === undefined ||
      !frame.componentIds.has(componentId) ||
      seenComponents.has(componentId) ||
      !huffmanTables.dc.has(tableSelector >> 4) ||
      !huffmanTables.ac.has(tableSelector & 0x0f)
    ) {
      return false;
    }
    seenComponents.add(componentId);
  }
  const spectralOffset = offset + 3 + scanComponents * 2;
  return (
    bytes[spectralOffset] === 0 &&
    bytes[spectralOffset + 1] === 63 &&
    bytes[spectralOffset + 2] === 0
  );
}

function hasJpegEntropyAndTerminalEoi(bytes: Uint8Array, start: number): boolean {
  let offset = start;
  let entropyBytes = 0;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      entropyBytes += 1;
      offset += 1;
      continue;
    }
    let markerOffset = offset + 1;
    while (bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset];
    if (marker === 0x00) {
      entropyBytes += 1;
      offset = markerOffset + 1;
      continue;
    }
    if (marker !== undefined && marker >= 0xd0 && marker <= 0xd7) {
      offset = markerOffset + 1;
      continue;
    }
    return marker === 0xd9 && markerOffset === bytes.byteLength - 1 && entropyBytes > 0;
  }
  return false;
}

function normalizeGeneratedAt(value: string): string {
  if (!ISO_TIMESTAMP_WITH_OFFSET.test(value) || !isoTimestampSchema.safeParse(value).success) {
    throw new PdfExportError(
      "PDF_RENDER_FAILED",
      "generatedAt must be a valid ISO 8601 timestamp with a time-zone offset.",
    );
  }
  return new Date(value).toISOString();
}

function sanitizeMetadata(value: string, fallback: string, maximum: number): string {
  const sanitized = replaceIsolatedUtf16Surrogates(value)
    .replaceAll(PDF_METADATA_CONTROL, "\uFFFD")
    .trim();
  let truncated = "";
  let scalarValues = 0;
  for (const character of sanitized) {
    if (scalarValues >= maximum) {
      break;
    }
    truncated += character;
    scalarValues += 1;
  }
  return truncated.length === 0 ? fallback : truncated;
}

function replaceIsolatedUtf16Surrogates(value: string): string {
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += value.slice(index, index + 2);
        index += 1;
      } else {
        sanitized += "\uFFFD";
      }
      continue;
    }
    sanitized += current >= 0xdc00 && current <= 0xdfff ? "\uFFFD" : value.charAt(index);
  }
  return sanitized;
}

function pdfUtf16HexString(value: string): string {
  const sanitized = sanitizeMetadata(value, "", PDF_EXPORT_LIMITS.maximumMetadataCharacters);
  let result = "FEFF";
  for (let index = 0; index < sanitized.length; index += 1) {
    result += sanitized.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${result}>`;
}

function pdfTimestamp(value: string): string {
  const date = new Date(value);
  const component = (number: number): string => String(number).padStart(2, "0");
  return (
    "D:" +
    String(date.getUTCFullYear()).padStart(4, "0") +
    component(date.getUTCMonth() + 1) +
    component(date.getUTCDate()) +
    component(date.getUTCHours()) +
    component(date.getUTCMinutes()) +
    component(date.getUTCSeconds()) +
    "Z"
  );
}

function reportProgress(
  options: Pick<PdfExportOptions, "onProgress" | "signal">,
  stage: PdfExportStage,
  completedUnits: number,
  totalUnits: number,
): void {
  throwIfCancelled(options.signal);
  options.onProgress?.(
    Object.freeze({
      stage,
      completedUnits,
      totalUnits: Math.max(totalUnits, 1),
    }),
  );
  throwIfCancelled(options.signal);
}

function reportAssemblyProgress(
  options: Pick<PdfAssemblyOptions, "onProgress" | "signal">,
  completedUnits: number,
  totalUnits: number,
): void {
  reportProgress(options, "assembling", completedUnits, totalUnits);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PdfExportError("EXPORT_CANCELLED", "The PDF export was cancelled.");
  }
}

function normalizeExportError(error: unknown, signal: AbortSignal | undefined): PdfExportError {
  if (error instanceof PdfExportError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new PdfExportError("EXPORT_CANCELLED", "The PDF export was cancelled.");
  }
  return new PdfExportError("PDF_RENDER_FAILED", "The PDF document could not be rendered safely.");
}
