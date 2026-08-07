import type JSZip from "jszip";

import { sha256Hex, utf8ByteLength } from "./checksum.js";
import { IMPORT_LIMITS } from "./constants.js";
import { ImportExportError, type ImportIssue } from "./errors.js";
import {
  assertSafeInputFilename,
  getAllowedImportExtension,
  sanitizeFilename,
} from "./filename.js";
import {
  importExtractedTextDocuments,
  sanitizePlainText,
  type ImportedTextDocument,
} from "./text.js";

export interface BinaryImportProgress {
  readonly stage: "scanning" | "parsing";
  readonly fileName: string;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface BinaryImportOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BinaryImportProgress) => void;
}

interface ZipEntryMetadata {
  readonly name: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly crc32: number;
  readonly compressionMethod: number;
  readonly localExtraBytes: number;
  readonly localOffset: number;
  readonly payloadEnd: number;
}

interface ZipInspection {
  readonly entries: readonly ZipEntryMetadata[];
  readonly names: ReadonlySet<string>;
}

interface EpubSpineItem {
  readonly path: string;
}

interface MammothRawTextResult {
  readonly value: string;
  readonly messages: readonly {
    readonly type: "error" | "warning";
  }[];
}

interface MammothRawTextParser {
  extractRawText(
    input: { readonly arrayBuffer: ArrayBuffer } | { readonly buffer: unknown },
  ): Promise<MammothRawTextResult>;
}

interface ZipStreamHelper {
  on(event: "data", listener: (chunk: Uint8Array) => void): ZipStreamHelper;
  on(event: "end", listener: () => void): ZipStreamHelper;
  on(event: "error", listener: (error: unknown) => void): ZipStreamHelper;
  pause(): ZipStreamHelper;
  resume(): ZipStreamHelper;
}

interface StreamableZipObject {
  internalStream(type: "uint8array"): ZipStreamHelper;
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

export async function importDocxDocuments(
  fileName: string,
  bytes: Uint8Array,
  options: BinaryImportOptions = {},
): Promise<readonly ImportedTextDocument[]> {
  assertSafeInputFilename(fileName);
  if (getAllowedImportExtension(fileName) !== ".docx") {
    throw new ImportExportError(
      "IMPORT_EXTENSION_FORBIDDEN",
      "The DOCX parser only accepts .docx files.",
      { fileName },
    );
  }
  assertBinarySize(fileName, bytes);
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 0, totalUnits: 1 });
  const archive = inspectZipArchive(fileName, bytes, {
    documentLabel: "DOCX",
    rejectDocxActiveContent: true,
    requiredEntries: ["[content_types].xml", "_rels/.rels", "word/document.xml"],
  });
  const parserIssues = await inspectDocxXml(fileName, bytes, archive);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 1, totalUnits: 1 });
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "parsing", fileName, completedUnits: 0, totalUnits: 1 });

  try {
    const mammothModule = await import("mammoth");
    throwIfAborted(options.signal);
    const mammoth = mammothModule.default as unknown as MammothRawTextParser;
    const result = await mammoth.extractRawText(mammothInput(bytes));
    const parserErrors = result.messages.filter(({ type }) => type === "error");
    if (parserErrors.length > 0) {
      throw new ImportExportError(
        "DOCX_PARSE_FAILED",
        "The DOCX parser reported an unsafe or invalid document structure.",
        { fileName },
      );
    }
    const warningIssues = result.messages
      .filter(({ type }) => type === "warning")
      .map((): ImportIssue => ({
        severity: "warning",
        code: "DOCX_PARSER_WARNING",
        message: "The DOCX parser omitted unsupported document structure.",
        fileName,
      }));
    throwIfAborted(options.signal);
    const documents = importExtractedTextDocuments(fileName, result.value, {
      originalBytes: bytes.byteLength,
      sourceFormat: "docx",
      sourceSha256: await sha256Hex(bytes),
      parserIssues: [...parserIssues, ...warningIssues],
    });
    options.onProgress?.({ stage: "parsing", fileName, completedUnits: 1, totalUnits: 1 });
    return documents;
  } catch (error: unknown) {
    if (error instanceof ImportExportError || isAbortError(error, options.signal)) {
      throw error;
    }
    throw new ImportExportError("DOCX_PARSE_FAILED", "The DOCX file could not be parsed safely.", {
      fileName,
    });
  }
}

export async function importEpubDocuments(
  fileName: string,
  bytes: Uint8Array,
  options: BinaryImportOptions = {},
): Promise<readonly ImportedTextDocument[]> {
  assertSafeInputFilename(fileName);
  if (getAllowedImportExtension(fileName) !== ".epub") {
    throw new ImportExportError(
      "IMPORT_EXTENSION_FORBIDDEN",
      "The EPUB parser only accepts .epub files.",
      { fileName },
    );
  }
  assertBinarySize(fileName, bytes);
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 0, totalUnits: 1 });

  const archive = inspectZipArchive(fileName, bytes, {
    documentLabel: "EPUB",
    rejectDocxActiveContent: false,
    requiredEntries: ["mimetype", "meta-inf/container.xml"],
  });
  const mimeEntry = findArchiveEntry(archive, "mimetype");
  if (
    mimeEntry?.localOffset !== 0 ||
    mimeEntry.compressionMethod !== 0 ||
    mimeEntry.localExtraBytes !== 0 ||
    mimeEntry.uncompressedBytes !== 20 ||
    archive.names.has("meta-inf/encryption.xml")
  ) {
    if (archive.names.has("meta-inf/encryption.xml")) {
      throw new ImportExportError(
        "EPUB_DRM_UNSUPPORTED",
        "Encrypted or DRM-protected EPUB files are not supported.",
        { fileName },
      );
    }
    throw new ImportExportError(
      "IMPORT_ARCHIVE_INVALID",
      "The EPUB mimetype entry must be the first uncompressed archive entry.",
      { fileName },
    );
  }
  if (
    archive.entries.some(({ name }) =>
      /(?:^|\/)[^/]+\.(?:bat|cjs|class|cmd|com|dll|exe|hta|jar|js|jsx|mjs|ps1|scr|swf|ts|vbs|wasm)$/iu.test(
        name,
      ),
    )
  ) {
    throw new ImportExportError(
      "EPUB_ACTIVE_CONTENT_FORBIDDEN",
      "Script and executable EPUB resources are not accepted.",
      { fileName },
    );
  }

  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes, {
      checkCRC32: false,
      createFolders: false,
    });
    const mimetype = await readEpubEntryText(zip, mimeEntry, fileName, 128);
    if (mimetype !== "application/epub+zip") {
      throw new ImportExportError(
        "IMPORT_MAGIC_MISMATCH",
        "The EPUB mimetype declaration is missing or invalid.",
        { fileName },
      );
    }

    const containerEntry = requireArchiveEntry(archive, "META-INF/container.xml", fileName);
    const containerXml = prepareEpubXml(
      await readEpubEntryText(
        zip,
        containerEntry,
        fileName,
        IMPORT_LIMITS.maximumRelationshipBytes,
      ),
      fileName,
    );
    const packagePath = parseEpubPackagePath(containerXml, fileName);
    const packageEntry = requireArchiveEntry(archive, packagePath, fileName);
    const packageXml = prepareEpubXml(
      await readEpubEntryText(zip, packageEntry, fileName, IMPORT_LIMITS.maximumRelationshipBytes),
      fileName,
    );
    const spine = parseEpubSpine(packageXml, packagePath, fileName);
    if (spine.length === 0) {
      throw new ImportExportError(
        "EPUB_CONTENT_UNAVAILABLE",
        "The EPUB reading order has no supported text chapters.",
        { fileName },
      );
    }
    if (spine.length > IMPORT_LIMITS.maximumChapters) {
      throw new ImportExportError(
        "IMPORT_TOO_MANY_FILES",
        "The EPUB exceeds the chapter-count limit.",
        { fileName },
      );
    }

    options.onProgress?.({ stage: "scanning", fileName, completedUnits: 1, totalUnits: 1 });
    options.onProgress?.({
      stage: "parsing",
      fileName,
      completedUnits: 0,
      totalUnits: spine.length,
    });
    const sourceSha256 = await sha256Hex(bytes);
    const documents: ImportedTextDocument[] = [];
    let sanitizedTotalBytes = 0;
    for (const [index, item] of spine.entries()) {
      throwIfAborted(options.signal);
      const entry = requireArchiveEntry(archive, item.path, fileName);
      const xhtml = await readEpubEntryText(
        zip,
        entry,
        fileName,
        IMPORT_LIMITS.maximumArchiveEntryBytes,
      );
      const extracted = extractEpubChapter(xhtml, fileName, index + 1);
      if (extracted.text.length === 0) {
        options.onProgress?.({
          stage: "parsing",
          fileName,
          completedUnits: index + 1,
          totalUnits: spine.length,
        });
        continue;
      }
      const sanitized = sanitizePlainText(extracted.text, fileName);
      sanitizedTotalBytes += utf8ByteLength(sanitized.markdown);
      if (sanitizedTotalBytes > IMPORT_LIMITS.maximumTotalBytes) {
        throw new ImportExportError(
          "IMPORT_TOTAL_TOO_LARGE",
          "The extracted EPUB text exceeds the import size limit.",
          { fileName },
        );
      }
      const title = extracted.title.slice(0, IMPORT_LIMITS.maximumTitleCharacters);
      documents.push({
        sourceName: fileName,
        title,
        suggestedPath: `chapters/${sanitizeFilename(
          `${String(index + 1).padStart(4, "0")}-${title}`,
          ".md",
        )}`,
        markdown: sanitized.markdown,
        originalBytes: bytes.byteLength,
        sanitizedBytes: utf8ByteLength(sanitized.markdown),
        issues: [
          {
            severity: "info",
            code: "HTML_MARKUP_REMOVED",
            message:
              "EPUB layout and markup were removed; only inert local chapter text was imported.",
            fileName,
          },
          ...(extracted.removedExternalReferences
            ? [
                {
                  severity: "warning" as const,
                  code: "MARKDOWN_EXTERNAL_REFERENCE_REMOVED" as const,
                  message: "External EPUB references were ignored and were not requested.",
                  fileName,
                },
              ]
            : []),
          ...sanitized.issues,
        ],
        sourceFormat: "epub",
        sourceSha256,
        chapterDetectionConfidence: 1,
        requiresBoundaryReview: false,
      });
      options.onProgress?.({
        stage: "parsing",
        fileName,
        completedUnits: index + 1,
        totalUnits: spine.length,
      });
    }
    if (documents.length === 0) {
      throw new ImportExportError(
        "EPUB_CONTENT_UNAVAILABLE",
        "The EPUB has no usable chapter text.",
        { fileName },
      );
    }
    return documents;
  } catch (error: unknown) {
    if (error instanceof ImportExportError || isAbortError(error, options.signal)) {
      throw error;
    }
    throw new ImportExportError("EPUB_PARSE_FAILED", "The EPUB file could not be parsed safely.", {
      fileName,
    });
  }
}

export async function importPdfDocuments(
  fileName: string,
  bytes: Uint8Array,
  options: BinaryImportOptions = {},
): Promise<readonly ImportedTextDocument[]> {
  assertSafeInputFilename(fileName);
  if (getAllowedImportExtension(fileName) !== ".pdf") {
    throw new ImportExportError(
      "IMPORT_EXTENSION_FORBIDDEN",
      "The PDF parser only accepts .pdf files.",
      { fileName },
    );
  }
  assertBinarySize(fileName, bytes);
  if (!hasPdfSignature(bytes)) {
    throw new ImportExportError(
      "IMPORT_MAGIC_MISMATCH",
      "The file extension says PDF but the PDF signature is missing.",
      { fileName },
    );
  }
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 1, totalUnits: 1 });

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof Worker !== "undefined" && pdfjs.GlobalWorkerOptions.workerSrc.length === 0) {
    const workerAsset = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerAsset.default;
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    disableAutoFetch: true,
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    enableXfa: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 1,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    throwIfAborted(options.signal);
    if (document.numPages > IMPORT_LIMITS.maximumPdfPages) {
      throw new ImportExportError(
        "PDF_PAGE_LIMIT_EXCEEDED",
        "The PDF exceeds the safe page-count limit.",
        { fileName },
      );
    }

    const [attachments, fieldObjects, hasJavaScript] = await Promise.all([
      document.getAttachments(),
      document.getFieldObjects(),
      document.hasJSActions(),
    ]);
    if (document.isPureXfa || attachments !== null || fieldObjects !== null || hasJavaScript) {
      throw new ImportExportError(
        "PDF_ACTIVE_CONTENT_FORBIDDEN",
        "PDF attachments, forms, XFA, and JavaScript are not accepted.",
        { fileName },
      );
    }

    const pages: string[] = [];
    let extractedTextBytes = 0;
    options.onProgress?.({
      stage: "parsing",
      fileName,
      completedUnits: 0,
      totalUnits: document.numPages,
    });
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent({
        disableNormalization: false,
        includeMarkedContent: false,
      });
      let pageText = "";
      for (const item of text.items) {
        if (!("str" in item)) {
          continue;
        }
        pageText += item.str;
        if (item.hasEOL) {
          pageText += "\n";
        }
      }
      page.cleanup();
      const normalizedPage = pageText.trim();
      pages.push(normalizedPage);
      extractedTextBytes += utf8ByteLength(normalizedPage) + (pageNumber === 1 ? 0 : 2);
      if (extractedTextBytes > IMPORT_LIMITS.maximumTotalBytes) {
        throw new ImportExportError(
          "IMPORT_TOTAL_TOO_LARGE",
          "The extracted PDF text exceeds the import size limit.",
          { fileName },
        );
      }
      options.onProgress?.({
        stage: "parsing",
        fileName,
        completedUnits: pageNumber,
        totalUnits: document.numPages,
      });
    }
    const extracted = pages.filter((page) => page.length > 0).join("\n\n");
    if (extracted.length === 0) {
      throw new ImportExportError(
        "PDF_TEXT_UNAVAILABLE",
        "The PDF has no extractable text; scanned PDF and OCR import are not supported.",
        { fileName },
      );
    }
    throwIfAborted(options.signal);
    return importExtractedTextDocuments(fileName, extracted, {
      originalBytes: bytes.byteLength,
      sourceFormat: "pdf",
      sourceSha256: await sha256Hex(bytes),
    });
  } catch (error: unknown) {
    if (error instanceof ImportExportError || isAbortError(error, options.signal)) {
      throw error;
    }
    if (isPdfPasswordError(error)) {
      throw new ImportExportError(
        "PDF_ENCRYPTED_UNSUPPORTED",
        "Encrypted or password-protected PDF files are not supported.",
        { fileName },
      );
    }
    throw new ImportExportError("PDF_PARSE_FAILED", "The PDF file could not be parsed safely.", {
      fileName,
    });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

function assertBinarySize(fileName: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new ImportExportError("IMPORT_UNSAFE_CONTENT", "The import file is empty.", {
      fileName,
    });
  }
  if (bytes.byteLength > IMPORT_LIMITS.maximumFileBytes) {
    throw new ImportExportError(
      "IMPORT_FILE_TOO_LARGE",
      "The import file exceeds the per-file size limit.",
      { fileName },
    );
  }
}

function inspectZipArchive(
  fileName: string,
  bytes: Uint8Array,
  options: {
    readonly documentLabel: "DOCX" | "EPUB";
    readonly rejectDocxActiveContent: boolean;
    readonly requiredEntries: readonly string[];
  },
): ZipInspection {
  if (bytes.byteLength < 4 || readUint32(bytes, 0) !== ZIP_LOCAL_FILE_HEADER) {
    throw new ImportExportError(
      "IMPORT_MAGIC_MISMATCH",
      `The file extension says ${options.documentLabel} but the ZIP signature is missing.`,
      { fileName },
    );
  }
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw archiveInvalid(fileName, options.documentLabel);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentBytes = view.getUint16(eocdOffset + 20, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === ZIP64_SENTINEL_16 ||
    centralBytes === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32 ||
    entryCount > IMPORT_LIMITS.maximumArchiveEntries ||
    eocdOffset + 22 + commentBytes !== bytes.byteLength ||
    centralOffset + centralBytes !== eocdOffset
  ) {
    throw archiveInvalid(fileName, options.documentLabel);
  }

  const entries: ZipEntryMetadata[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw archiveInvalid(fileName, options.documentLabel);
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const entryCommentBytes = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      compressedBytes === ZIP64_SENTINEL_32 ||
      uncompressedBytes === ZIP64_SENTINEL_32 ||
      localOffset === ZIP64_SENTINEL_32 ||
      entryDisk !== 0 ||
      nameBytes === 0 ||
      nextOffset > eocdOffset ||
      ![0, 8].includes(compressionMethod)
    ) {
      throw archiveInvalid(fileName, options.documentLabel);
    }
    let name: string;
    try {
      name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    } catch {
      throw archiveInvalid(fileName, options.documentLabel);
    }
    const normalizedName = name.replaceAll("\\", "/").normalize("NFKC");
    const comparisonName = normalizedName.toLowerCase();
    const pathSegments = normalizedName.split("/");
    const contentSegments = normalizedName.endsWith("/") ? pathSegments.slice(0, -1) : pathSegments;
    if (
      normalizedName !== name ||
      (options.documentLabel === "EPUB" &&
        normalizedName.length > IMPORT_LIMITS.maximumRelativePathCharacters) ||
      normalizedName.startsWith("/") ||
      /^[a-z]:/iu.test(normalizedName) ||
      /[\u0000-\u001f\u007f:?*<>|%]/u.test(normalizedName) ||
      (options.documentLabel === "EPUB" && normalizedName.includes("#")) ||
      contentSegments.some(
        (segment) => segment.length === 0 || segment === "." || segment === "..",
      ) ||
      names.has(comparisonName) ||
      localOffsets.has(localOffset)
    ) {
      throw new ImportExportError(
        "IMPORT_UNSAFE_PATH",
        `The ${options.documentLabel} archive contains an unsafe or duplicate path.`,
        { fileName },
      );
    }
    names.add(comparisonName);
    localOffsets.add(localOffset);
    const localHeader = assertMatchingLocalZipHeader({
      bytes,
      centralOffset,
      compressedBytes,
      compressionMethod,
      crc32,
      fileName,
      flags,
      localOffset,
      name,
      documentLabel: options.documentLabel,
      uncompressedBytes,
      view,
    });
    totalCompressed += compressedBytes;
    totalUncompressed += uncompressedBytes;
    if (
      uncompressedBytes > IMPORT_LIMITS.maximumArchiveEntryBytes ||
      totalUncompressed > IMPORT_LIMITS.maximumArchiveExpandedBytes ||
      (uncompressedBytes > 0 &&
        uncompressedBytes / Math.max(compressedBytes, 1) >
          IMPORT_LIMITS.maximumArchiveCompressionRatio)
    ) {
      throw new ImportExportError(
        "IMPORT_ARCHIVE_LIMIT_EXCEEDED",
        `The ${options.documentLabel} archive exceeds safe expansion limits.`,
        { fileName },
      );
    }
    if ((flags & (0x1 | 0x40 | 0x2000)) !== 0) {
      throw new ImportExportError(
        "IMPORT_ARCHIVE_ENCRYPTED",
        `Encrypted ${options.documentLabel} archive entries are not supported.`,
        { fileName },
      );
    }
    if (
      options.rejectDocxActiveContent &&
      (/(?:^|\/)(?:vbaproject\.bin|activex\/|embeddings\/|customui\/)/iu.test(comparisonName) ||
        comparisonName.endsWith(".bin"))
    ) {
      throw new ImportExportError(
        "IMPORT_ARCHIVE_ACTIVE_CONTENT",
        "Macro, embedded object, ActiveX, and binary DOCX content is not accepted.",
        { fileName },
      );
    }
    entries.push({
      name: normalizedName,
      compressedBytes,
      uncompressedBytes,
      crc32,
      compressionMethod,
      localExtraBytes: localHeader.localExtraBytes,
      localOffset,
      payloadEnd: localHeader.payloadEnd,
    });
    offset = nextOffset;
  }
  if (
    offset !== eocdOffset ||
    totalCompressed > bytes.byteLength ||
    !options.requiredEntries.every((name) => names.has(name.toLowerCase()))
  ) {
    throw archiveInvalid(fileName, options.documentLabel);
  }
  const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  if (
    localOrder[0]?.localOffset !== 0 ||
    localOrder.some((entry, index) => {
      const next = localOrder[index + 1];
      return next !== undefined && entry.payloadEnd > next.localOffset;
    })
  ) {
    throw archiveInvalid(fileName, options.documentLabel);
  }
  return { entries, names };
}

function assertMatchingLocalZipHeader({
  bytes,
  centralOffset,
  compressedBytes,
  compressionMethod,
  crc32,
  documentLabel,
  fileName,
  flags,
  localOffset,
  name,
  uncompressedBytes,
  view,
}: {
  readonly bytes: Uint8Array;
  readonly centralOffset: number;
  readonly compressedBytes: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly fileName: string;
  readonly flags: number;
  readonly localOffset: number;
  readonly name: string;
  readonly uncompressedBytes: number;
  readonly documentLabel: "DOCX" | "EPUB";
  readonly view: DataView;
}): Readonly<{ localExtraBytes: number; payloadEnd: number }> {
  if (
    localOffset + 30 > centralOffset ||
    view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER
  ) {
    throw archiveInvalid(fileName, documentLabel);
  }
  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  const localCrc32 = view.getUint32(localOffset + 14, true);
  const localCompressedBytes = view.getUint32(localOffset + 18, true);
  const localUncompressedBytes = view.getUint32(localOffset + 22, true);
  const localNameBytes = view.getUint16(localOffset + 26, true);
  const localExtraBytes = view.getUint16(localOffset + 28, true);
  const payloadOffset = localOffset + 30 + localNameBytes + localExtraBytes;
  if (
    localFlags !== flags ||
    localMethod !== compressionMethod ||
    ((flags & 0x8) === 0
      ? localCrc32 !== crc32 ||
        localCompressedBytes !== compressedBytes ||
        localUncompressedBytes !== uncompressedBytes
      : (localCrc32 !== 0 && localCrc32 !== crc32) ||
        (localCompressedBytes !== 0 && localCompressedBytes !== compressedBytes) ||
        (localUncompressedBytes !== 0 && localUncompressedBytes !== uncompressedBytes)) ||
    payloadOffset + compressedBytes > centralOffset
  ) {
    throw archiveInvalid(fileName, documentLabel);
  }
  let localName: string;
  try {
    localName = textDecoder.decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes),
    );
  } catch {
    throw archiveInvalid(fileName, documentLabel);
  }
  if (localName !== name) {
    throw archiveInvalid(fileName, documentLabel);
  }
  return { localExtraBytes, payloadEnd: payloadOffset + compressedBytes };
}

async function inspectDocxXml(
  fileName: string,
  bytes: Uint8Array,
  archive: ZipInspection,
): Promise<readonly ImportIssue[]> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes, {
      checkCRC32: false,
      createFolders: false,
    });
    const issues: ImportIssue[] = [];
    const xmlEntries = archive.entries.filter(
      ({ name }) =>
        name.toLowerCase().endsWith(".rels") ||
        ["[content_types].xml", "word/document.xml"].includes(name.toLowerCase()),
    );
    for (const { name, uncompressedBytes } of xmlEntries) {
      const normalizedName = name.toLowerCase();
      const xmlLimit =
        normalizedName === "word/document.xml"
          ? IMPORT_LIMITS.maximumArchiveEntryBytes
          : IMPORT_LIMITS.maximumRelationshipBytes;
      if (uncompressedBytes > xmlLimit) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "The DOCX contains oversized XML control data.",
          { fileName },
        );
      }
      const entry = zip.file(name);
      if (entry === null) {
        throw archiveInvalid(fileName);
      }
      const xml = await entry.async("string");
      if (utf8ByteLength(xml) > xmlLimit || /<!\s*(?:doctype|entity)\b/iu.test(xml)) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "The DOCX contains oversized or unsafe XML declarations.",
          { fileName },
        );
      }
      if (
        normalizedName === "[content_types].xml" &&
        /(?:macroEnabled|activeX|oleObject)/iu.test(xml)
      ) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "Macro-enabled, ActiveX, and embedded-object DOCX content is not accepted.",
          { fileName },
        );
      }
      if (normalizedName === "word/document.xml" && /<w:altChunk\b/iu.test(xml)) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "Alternative embedded DOCX content is not accepted.",
          { fileName },
        );
      }
      if (normalizedName.endsWith(".rels") && hasExternalRelationship(xml)) {
        issues.push({
          severity: "warning",
          code: "MARKDOWN_EXTERNAL_REFERENCE_REMOVED",
          message: "External DOCX relationships were ignored and were not requested.",
          fileName,
        });
      }
    }
    return issues;
  } catch (error: unknown) {
    if (error instanceof ImportExportError) {
      throw error;
    }
    throw archiveInvalid(fileName);
  }
}

function findArchiveEntry(archive: ZipInspection, path: string): ZipEntryMetadata | undefined {
  const normalized = path.normalize("NFKC");
  return archive.entries.find(({ name }) => name === normalized);
}

function requireArchiveEntry(
  archive: ZipInspection,
  path: string,
  fileName: string,
): ZipEntryMetadata {
  const entry = findArchiveEntry(archive, path);
  if (entry === undefined || entry.name.endsWith("/")) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "The EPUB references a missing or invalid archive entry.",
      { fileName, path },
    );
  }
  return entry;
}

async function readEpubEntryText(
  zip: JSZip,
  metadata: ZipEntryMetadata,
  fileName: string,
  maximumBytes: number,
): Promise<string> {
  if (metadata.uncompressedBytes > maximumBytes) {
    throw new ImportExportError(
      "IMPORT_ARCHIVE_LIMIT_EXCEEDED",
      "An EPUB control or chapter entry exceeds its safe size limit.",
      { fileName, path: metadata.name },
    );
  }
  const entry = zip.file(metadata.name);
  if (entry === null) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "The EPUB archive changed while its reading order was being validated.",
      { fileName, path: metadata.name },
    );
  }
  const entryBytes = await readZipEntryBytesBounded(
    entry as unknown as StreamableZipObject,
    metadata.uncompressedBytes,
    fileName,
    metadata.name,
  );
  if (
    entryBytes.byteLength !== metadata.uncompressedBytes ||
    entryBytes.byteLength > maximumBytes ||
    crc32(entryBytes) !== metadata.crc32
  ) {
    throw new ImportExportError(
      "IMPORT_ARCHIVE_INVALID",
      "The EPUB archive entry does not match its validated size or checksum.",
      { fileName, path: metadata.name },
    );
  }
  try {
    let decoded: string;
    let actualEncoding: "utf-8" | "utf-16be" | "utf-16le";
    if (hasPrefix(entryBytes, [0xff, 0xfe])) {
      actualEncoding = "utf-16le";
      decoded = new TextDecoder("utf-16le", { fatal: true }).decode(entryBytes.subarray(2));
    } else if (hasPrefix(entryBytes, [0xfe, 0xff])) {
      actualEncoding = "utf-16be";
      decoded = new TextDecoder("utf-16be", { fatal: true }).decode(entryBytes.subarray(2));
    } else {
      actualEncoding = "utf-8";
      const offset = hasPrefix(entryBytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
      decoded = textDecoder.decode(entryBytes.subarray(offset));
    }
    assertMatchingEpubEncodingDeclaration(decoded, actualEncoding, fileName, metadata.name);
    return decoded;
  } catch (error: unknown) {
    if (error instanceof ImportExportError) {
      throw error;
    }
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "An EPUB XML or XHTML entry is not valid UTF-8 or UTF-16 text.",
      { fileName, path: metadata.name },
    );
  }
}

function readZipEntryBytesBounded(
  entry: StreamableZipObject,
  maximumBytes: number,
  fileName: string,
  path: string,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let settled = false;
    const stream = entry.internalStream("uint8array");
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.pause();
      reject(
        error instanceof Error ? error : new Error("Archive stream failed.", { cause: error }),
      );
    };
    stream
      .on("data", (chunk) => {
        if (settled) {
          return;
        }
        totalBytes += chunk.byteLength;
        if (totalBytes > maximumBytes) {
          fail(
            new ImportExportError(
              "IMPORT_ARCHIVE_INVALID",
              "The EPUB archive expanded beyond its validated entry size.",
              { fileName, path },
            ),
          );
          return;
        }
        chunks.push(chunk.slice());
      })
      .on("error", fail)
      .on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        const result = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(result);
      })
      .resume();
  });
}

function assertMatchingEpubEncodingDeclaration(
  text: string,
  actualEncoding: "utf-8" | "utf-16be" | "utf-16le",
  fileName: string,
  path: string,
): void {
  const declaration = /^\s*<\?xml\b[\s\S]{0,500}?\?>/iu.exec(text)?.[0];
  const declared =
    declaration === undefined
      ? undefined
      : /\bencoding\s*=\s*["']\s*([^"'\s]+)\s*["']/iu.exec(declaration)?.[1]?.toLowerCase();
  const declarationIsMalformed = /^\s*<\?xml\b/iu.test(text) && declaration === undefined;
  const encodingIsMalformed =
    declaration !== undefined && /\bencoding\s*=/iu.test(declaration) && declared === undefined;
  const matches =
    !declarationIsMalformed &&
    !encodingIsMalformed &&
    (declared === undefined ||
      (actualEncoding === "utf-8" && (declared === "utf-8" || declared === "utf8")) ||
      (actualEncoding === "utf-16le" && (declared === "utf-16" || declared === "utf-16le")) ||
      (actualEncoding === "utf-16be" && (declared === "utf-16" || declared === "utf-16be")));
  if (!matches) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "An EPUB XML or XHTML encoding declaration does not match its bytes.",
      { fileName, path },
    );
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function prepareEpubXml(xml: string, fileName: string): string {
  if (
    /<!\s*(?:doctype|entity)\b/iu.test(xml) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(xml)
  ) {
    throw new ImportExportError(
      "EPUB_ACTIVE_CONTENT_FORBIDDEN",
      "EPUB package XML must not contain document types, entities, or unsafe controls.",
      { fileName },
    );
  }
  const prepared = xml
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "")
    .replaceAll(/<\?[\s\S]*?\?>/gu, "");
  if (/<!--|-->|<!\[CDATA\[|\]\]>|<\?|\?>/u.test(prepared)) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "The EPUB package XML contains malformed comments or processing instructions.",
      { fileName },
    );
  }
  return prepared;
}

function parseEpubPackagePath(containerXml: string, fileName: string): string {
  const rootfiles = readUniqueXmlSection(containerXml, "rootfiles", fileName);
  const rootfile = [...rootfiles.matchAll(/<(?:[a-z][\w.-]*:)?rootfile\b[^>]*\/?\s*>/giu)]
    .map(([tag]) => tag)
    .find(
      (tag) =>
        readXmlAttribute(tag, "media-type")?.toLowerCase() === "application/oebps-package+xml",
    );
  const fullPath = rootfile === undefined ? undefined : readXmlAttribute(rootfile, "full-path");
  if (fullPath === undefined || fullPath.length === 0) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "The EPUB container does not declare a package document.",
      { fileName },
    );
  }
  return resolveEpubReference("", fullPath, fileName);
}

function parseEpubSpine(
  packageXml: string,
  packagePath: string,
  fileName: string,
): readonly EpubSpineItem[] {
  const manifestXml = readUniqueXmlSection(packageXml, "manifest", fileName);
  const spineXml = readUniqueXmlSection(packageXml, "spine", fileName);
  const manifest = new Map<
    string,
    { readonly path: string; readonly mediaType: string; readonly properties: ReadonlySet<string> }
  >();
  for (const match of manifestXml.matchAll(/<(?:[a-z][\w.-]*:)?item\b[^>]*\/?>/giu)) {
    const tag = match[0];
    const id = readXmlAttribute(tag, "id");
    const href = readXmlAttribute(tag, "href");
    const mediaType = readXmlAttribute(tag, "media-type")?.toLowerCase();
    if (id === undefined || href === undefined || mediaType === undefined || manifest.has(id)) {
      throw new ImportExportError(
        "EPUB_PARSE_FAILED",
        "The EPUB manifest contains an invalid or duplicate item.",
        { fileName },
      );
    }
    const properties = new Set(
      (readXmlAttribute(tag, "properties") ?? "")
        .split(/\s+/u)
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    );
    manifest.set(id, {
      path: resolveEpubReference(packagePath, href, fileName),
      mediaType,
      properties,
    });
    if (manifest.size > IMPORT_LIMITS.maximumArchiveEntries) {
      throw new ImportExportError(
        "IMPORT_TOO_MANY_FILES",
        "The EPUB manifest exceeds the safe entry-count limit.",
        { fileName },
      );
    }
  }

  const spine: EpubSpineItem[] = [];
  const seenPaths = new Set<string>();
  let spineEntryCount = 0;
  for (const match of spineXml.matchAll(/<(?:[a-z][\w.-]*:)?itemref\b[^>]*\/?>/giu)) {
    spineEntryCount += 1;
    if (spineEntryCount > IMPORT_LIMITS.maximumChapters) {
      throw new ImportExportError(
        "IMPORT_TOO_MANY_FILES",
        "The EPUB spine exceeds the chapter-count limit.",
        { fileName },
      );
    }
    const tag = match[0];
    if (readXmlAttribute(tag, "linear")?.toLowerCase() === "no") {
      continue;
    }
    const idref = readXmlAttribute(tag, "idref");
    const item = idref === undefined ? undefined : manifest.get(idref);
    if (item === undefined) {
      throw new ImportExportError(
        "EPUB_PARSE_FAILED",
        "The EPUB spine references an unknown manifest item.",
        { fileName },
      );
    }
    if (item.properties.has("scripted") || item.properties.has("remote-resources")) {
      throw new ImportExportError(
        "EPUB_ACTIVE_CONTENT_FORBIDDEN",
        "Scripted EPUB chapters and remote-resource declarations are not accepted.",
        { fileName, path: item.path },
      );
    }
    if (item.properties.has("nav")) {
      continue;
    }
    if (!new Set(["application/xhtml+xml", "text/html"]).has(item.mediaType)) {
      continue;
    }
    const comparisonPath = item.path.toLowerCase();
    if (!seenPaths.has(comparisonPath)) {
      seenPaths.add(comparisonPath);
      spine.push({ path: item.path });
    }
  }
  return spine;
}

function readUniqueXmlSection(xml: string, localName: string, fileName: string): string {
  const escapedName = localName.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [
    ...xml.matchAll(
      new RegExp(
        `<(?:[a-z][\\w.-]*:)?${escapedName}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*(?:[a-z][\\w.-]*:)?${escapedName}\\s*>`,
        "giu",
      ),
    ),
  ];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      `The EPUB XML must contain exactly one ${localName} section.`,
      { fileName },
    );
  }
  return matches[0][1];
}

function readXmlAttribute(tag: string, name: string): string | undefined {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu").exec(tag);
  return match?.[2] === undefined ? undefined : decodeXmlEntities(match[2]);
}

function resolveEpubReference(
  baseFilePath: string,
  rawReference: string,
  fileName: string,
): string {
  const withoutFragment = rawReference.split("#", 1)[0] ?? "";
  if (
    withoutFragment.length === 0 ||
    withoutFragment.includes("?") ||
    withoutFragment.startsWith("/") ||
    withoutFragment.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(withoutFragment)
  ) {
    throw new ImportExportError(
      "EPUB_ACTIVE_CONTENT_FORBIDDEN",
      "The EPUB reading order contains an external or invalid reference.",
      { fileName, path: rawReference },
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new ImportExportError("IMPORT_UNSAFE_PATH", "The EPUB path encoding is invalid.", {
      fileName,
      path: rawReference,
    });
  }
  const normalized = decoded.replaceAll("\\", "/").normalize("NFKC");
  if (
    normalized !== decoded ||
    normalized.includes("%") ||
    /[\u0000-\u001f\u007f:#?*<>|]/u.test(normalized)
  ) {
    throw new ImportExportError("IMPORT_UNSAFE_PATH", "The EPUB path is unsafe or ambiguous.", {
      fileName,
      path: rawReference,
    });
  }

  const baseSegments = baseFilePath.includes("/")
    ? baseFilePath.slice(0, baseFilePath.lastIndexOf("/")).split("/")
    : [];
  const segments = [...baseSegments];
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new ImportExportError(
          "IMPORT_PATH_TRAVERSAL",
          "The EPUB path escapes the archive root.",
          { fileName, path: rawReference },
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = segments.join("/");
  if (resolved.length === 0 || resolved.length > IMPORT_LIMITS.maximumRelativePathCharacters) {
    throw new ImportExportError("IMPORT_UNSAFE_PATH", "The EPUB path is empty or too long.", {
      fileName,
      path: rawReference,
    });
  }
  return resolved;
}

function extractEpubChapter(
  xhtml: string,
  fileName: string,
  chapterNumber: number,
): { readonly title: string; readonly text: string; readonly removedExternalReferences: boolean } {
  const inertXhtml = xhtml.replaceAll(/<!--[\s\S]*?-->/gu, "").replaceAll(/<\?[\s\S]*?\?>/gu, "");
  if (/<!--|-->|<\?|\?>/u.test(inertXhtml)) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "The EPUB chapter contains malformed comments or processing instructions.",
      { fileName },
    );
  }
  if (
    /<!\s*entity\b/iu.test(inertXhtml) ||
    /<!\s*doctype\b[^>]*(?:\[|\b(?:public|system)\b)/iu.test(inertXhtml) ||
    /<\s*\/?\s*(?:[a-z][\w.-]*:)?(?:applet|audio|button|canvas|embed|form|frame|frameset|iframe|input|object|script|select|source|template|textarea|track|video)\b/iu.test(
      inertXhtml,
    ) ||
    /\s(?:[a-z][\w.-]*:)?on[a-z][a-z0-9_-]*\s*=/iu.test(inertXhtml)
  ) {
    throw new ImportExportError(
      "EPUB_ACTIVE_CONTENT_FORBIDDEN",
      "The EPUB chapter contains scripts, active controls, or external entity declarations.",
      { fileName },
    );
  }
  const removedExternalReferences =
    /\b(?:href|src|poster)\s*=\s*(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(inertXhtml);
  const titleSource =
    /<\s*h[1-6]\b[^>]*>([\s\S]*?)<\s*\/\s*h[1-6]\s*>/iu.exec(inertXhtml)?.[1] ??
    /<\s*title\b[^>]*>([\s\S]*?)<\s*\/\s*title\s*>/iu.exec(inertXhtml)?.[1];
  const fallbackTitle = `第 ${String(chapterNumber)} 章`;
  const title = assertSafeEpubTitle(
    compactEpubText((titleSource ?? "").replaceAll(/<[^>]{0,10000}>/gu, "")).slice(
      0,
      IMPORT_LIMITS.maximumTitleCharacters,
    ) || fallbackTitle,
    fileName,
  );
  const body = /<\s*body\b[^>]*>([\s\S]*?)<\s*\/\s*body\s*>/iu.exec(inertXhtml)?.[1] ?? inertXhtml;
  const text = compactEpubText(
    body
      .replaceAll(
        /<\s*(?:head|style|svg|math)\b[^>]*>[^]*?<\s*\/\s*(?:head|style|svg|math)\s*>/giu,
        "",
      )
      .replaceAll(/<\s*br\b[^>]*\/?>/giu, "\n")
      .replaceAll(
        /<\s*\/\s*(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\s*>/giu,
        "\n",
      )
      .replaceAll(/<[^>]{0,10000}>/gu, ""),
  );
  return { title, text, removedExternalReferences };
}

function assertSafeEpubTitle(title: string, fileName: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(title)) {
    throw new ImportExportError(
      "EPUB_PARSE_FAILED",
      "The EPUB chapter title contains unsafe control characters.",
      { fileName },
    );
  }
  return title;
}

function compactEpubText(input: string): string {
  return decodeXmlEntities(input)
    .replaceAll("\u00a0", " ")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeXmlEntities(input: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return input.replaceAll(
    /&(?:#x([a-f0-9]{1,6})|#([0-9]{1,7})|([a-z][a-z0-9]{1,31}));/giu,
    (
      entity,
      hexadecimal: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
    ) => {
      if (name !== undefined) {
        return named[name.toLowerCase()] ?? entity;
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
        return "�";
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function hasExternalRelationship(xml: string): boolean {
  return /<Relationship\b(?=[^>]*\bTargetMode\s*=\s*["']External["'])[^>]*>/giu.test(xml);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(bytes, offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    return -1;
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function archiveInvalid(
  fileName: string,
  documentLabel: "DOCX" | "EPUB" = "DOCX",
): ImportExportError {
  return new ImportExportError(
    "IMPORT_ARCHIVE_INVALID",
    `The ${documentLabel} archive structure is invalid or unsupported.`,
    { fileName },
  );
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}

function mammothInput(
  bytes: Uint8Array,
): { readonly arrayBuffer: ArrayBuffer } | { readonly buffer: unknown } {
  const maybeBuffer = (
    globalThis as unknown as {
      readonly Buffer?: {
        from(value: Uint8Array): unknown;
      };
    }
  ).Buffer;
  return maybeBuffer === undefined
    ? { arrayBuffer: exactArrayBuffer(bytes) }
    : { buffer: maybeBuffer.from(bytes) };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("The import was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (signal?.aborted === true && error === signal.reason)
  );
}

function isPdfPasswordError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PasswordException"
  );
}
