import { sha256Hex, utf8Bytes } from "./checksum.js";
import {
  IMPORT_LIMITS,
  type AllowedBinaryDocumentExtension,
  type AllowedBundleExtension,
  type AllowedTextExtension,
} from "./constants.js";
import {
  importDocxDocuments,
  importEpubDocuments,
  importPdfDocuments,
  type BinaryImportProgress,
} from "./binary.js";
import { ImportExportError, type ImportIssue } from "./errors.js";
import { assertSafeInputFilename, getAllowedImportExtension } from "./filename.js";
import { parsePortableBundle } from "./portable-bundle.js";
import type { PortableProjectV1 } from "./schemas.js";
import {
  importHtmlDocument,
  importMarkdownDocument,
  importPlainTextDocument,
  type ImportedTextDocument,
} from "./text.js";

export type InMemoryImportFile =
  | {
      readonly name: string;
      readonly content: string;
      readonly bytes?: never;
      readonly encoding?: never;
    }
  | {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly content?: never;
      readonly encoding?: "utf-8" | "utf-16be" | "utf-16le";
    };

export type ImportPreflightFormat =
  "portable_bundle" | "docx" | "epub" | "html" | "markdown" | "pdf" | "text" | "mixed" | "unknown";

export interface ImportPreflightOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BinaryImportProgress) => void;
}

export type ImportPreflightCandidate =
  | {
      readonly kind: "portable_bundle";
      readonly project: PortableProjectV1;
    }
  | {
      readonly kind: "documents";
      readonly documents: readonly ImportedTextDocument[];
    };

export interface ImportPreflightSummary {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly chapterCount: number;
  readonly checksumVerified: boolean;
}

export interface ImportPreflightReport {
  readonly status: "ready" | "blocked";
  readonly format: ImportPreflightFormat;
  readonly issues: readonly ImportIssue[];
  readonly summary: ImportPreflightSummary;
  readonly candidate?: ImportPreflightCandidate;
}

type SupportedExtension =
  AllowedBinaryDocumentExtension | AllowedBundleExtension | AllowedTextExtension;

interface CheckedFile {
  readonly file: InMemoryImportFile;
  readonly extension: SupportedExtension;
  readonly byteLength: number;
}

function blockingIssue(code: ImportIssue["code"], message: string, fileName?: string): ImportIssue {
  return {
    severity: "blocking",
    code,
    message,
    ...(fileName === undefined ? {} : { fileName }),
  };
}

function errorIssue(error: unknown, fileName?: string): ImportIssue {
  if (error instanceof ImportExportError) {
    const issue = error.toIssue();
    if (issue.fileName !== undefined || fileName === undefined) {
      return issue;
    }
    return {
      ...issue,
      fileName,
    };
  }

  return blockingIssue(
    "BUNDLE_SCHEMA_INVALID",
    "The import could not be safely validated.",
    fileName,
  );
}

function isBundleExtension(extension: SupportedExtension): extension is AllowedBundleExtension {
  return extension === ".inkshadow.json" || extension === ".json";
}

function determineFormat(files: readonly CheckedFile[]): ImportPreflightFormat {
  const hasBundle = files.some(({ extension }) => isBundleExtension(extension));
  const hasMarkdown = files.some(
    ({ extension }) => extension === ".md" || extension === ".markdown",
  );
  const hasText = files.some(({ extension }) => extension === ".txt");
  const hasHtml = files.some(({ extension }) => extension === ".htm" || extension === ".html");
  const hasDocx = files.some(({ extension }) => extension === ".docx");
  const hasEpub = files.some(({ extension }) => extension === ".epub");
  const hasPdf = files.some(({ extension }) => extension === ".pdf");
  const kindCount =
    Number(hasBundle) +
    Number(hasDocx) +
    Number(hasEpub) +
    Number(hasHtml) +
    Number(hasMarkdown) +
    Number(hasPdf) +
    Number(hasText);

  if (kindCount > 1) {
    return "mixed";
  }
  if (hasBundle) {
    return "portable_bundle";
  }
  if (hasDocx) {
    return "docx";
  }
  if (hasEpub) {
    return "epub";
  }
  if (hasHtml) {
    return "html";
  }
  if (hasMarkdown) {
    return "markdown";
  }
  if (hasPdf) {
    return "pdf";
  }
  if (hasText) {
    return "text";
  }
  return "unknown";
}

function baseReport(
  files: readonly InMemoryImportFile[],
  issues: readonly ImportIssue[],
  format: ImportPreflightFormat,
  chapterCount: number,
  checksumVerified: boolean,
  candidate?: ImportPreflightCandidate,
): ImportPreflightReport {
  const status = issues.some(({ severity }) => severity === "blocking") ? "blocked" : "ready";
  const summary: ImportPreflightSummary = {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + importFileByteLength(file), 0),
    chapterCount,
    checksumVerified,
  };

  return {
    status,
    format,
    issues,
    summary,
    ...(status === "ready" && candidate !== undefined ? { candidate } : {}),
  };
}

function inspectFiles(files: readonly InMemoryImportFile[], issues: ImportIssue[]): CheckedFile[] {
  const checked: CheckedFile[] = [];
  const names = new Set<string>();

  for (const file of files) {
    try {
      assertSafeInputFilename(file.name);
      const normalizedName = file.name.normalize("NFKC").toLocaleLowerCase();
      if (names.has(normalizedName)) {
        throw new ImportExportError("IMPORT_DUPLICATE_FILE", "Import file names must be unique.", {
          fileName: file.name,
        });
      }
      names.add(normalizedName);

      const extension = getAllowedImportExtension(file.name);
      const byteLength = importFileByteLength(file);
      const maximumBytes = isBundleExtension(extension)
        ? IMPORT_LIMITS.maximumBundleBytes
        : IMPORT_LIMITS.maximumFileBytes;
      if (byteLength > maximumBytes) {
        throw new ImportExportError(
          "IMPORT_FILE_TOO_LARGE",
          "The import file exceeds its allowed size.",
          { fileName: file.name },
        );
      }
      checked.push({
        file,
        extension,
        byteLength,
      });
    } catch (error) {
      issues.push(errorIssue(error, file.name));
    }
  }

  return checked;
}

async function preflightBundle(
  files: readonly InMemoryImportFile[],
  checked: readonly CheckedFile[],
  issues: ImportIssue[],
): Promise<ImportPreflightReport> {
  if (checked.length !== 1 || files.length !== 1) {
    issues.push(
      blockingIssue(
        "IMPORT_MIXED_FORMATS",
        "A Portable Bundle JSON file must be imported by itself.",
      ),
    );
    return baseReport(files, issues, "mixed", 0, false);
  }

  const checkedFile = checked[0];
  if (checkedFile === undefined) {
    return baseReport(files, issues, "portable_bundle", 0, false);
  }

  try {
    const bundle = await parsePortableBundle(decodeTextFile(checkedFile));
    return baseReport(files, issues, "portable_bundle", bundle.content.chapters.length, true, {
      kind: "portable_bundle",
      project: bundle.content,
    });
  } catch (error) {
    issues.push(errorIssue(error, checkedFile.file.name));
    return baseReport(files, issues, "portable_bundle", 0, false);
  }
}

async function preflightDocuments(
  files: readonly InMemoryImportFile[],
  checked: readonly CheckedFile[],
  issues: ImportIssue[],
  format: ImportPreflightFormat,
  options: ImportPreflightOptions,
): Promise<ImportPreflightReport> {
  const documents: ImportedTextDocument[] = [];
  const suggestedPaths = new Set<string>();
  const issueKeys = new Set(issues.map(issueKey));

  for (const checkedFile of checked) {
    throwIfAborted(options.signal);
    if (isBundleExtension(checkedFile.extension)) {
      continue;
    }

    try {
      const parsedDocuments = await parseCheckedDocument(checkedFile, options);
      for (const document of parsedDocuments) {
        const normalizedPath = document.suggestedPath.normalize("NFKC").toLocaleLowerCase();
        if (suggestedPaths.has(normalizedPath)) {
          throw new ImportExportError(
            "IMPORT_DUPLICATE_FILE",
            "Multiple files resolve to the same chapter path.",
            {
              fileName: checkedFile.file.name,
              path: document.suggestedPath,
            },
          );
        }
        suggestedPaths.add(normalizedPath);
        documents.push(document);
        for (const issue of document.issues) {
          const key = issueKey(issue);
          if (!issueKeys.has(key)) {
            issueKeys.add(key);
            issues.push(issue);
          }
        }
      }
    } catch (error) {
      if (isAbortError(error, options.signal)) {
        throw error;
      }
      issues.push(errorIssue(error, checkedFile.file.name));
    }
  }

  const sanitizedTotalBytes = documents.reduce(
    (total, document) => total + document.sanitizedBytes,
    0,
  );
  if (sanitizedTotalBytes > IMPORT_LIMITS.maximumTotalBytes) {
    issues.push(
      blockingIssue(
        "IMPORT_TOTAL_TOO_LARGE",
        "The sanitized documents exceed the total import size limit.",
      ),
    );
  }

  return baseReport(files, issues, format, documents.length, false, {
    kind: "documents",
    documents,
  });
}

export async function preflightImport(
  files: readonly InMemoryImportFile[],
  options: ImportPreflightOptions = {},
): Promise<ImportPreflightReport> {
  throwIfAborted(options.signal);
  const issues: ImportIssue[] = [];
  if (files.length === 0) {
    issues.push(blockingIssue("IMPORT_EMPTY", "Select at least one file to import."));
    return baseReport(files, issues, "unknown", 0, false);
  }
  if (files.length > IMPORT_LIMITS.maximumFiles) {
    issues.push(
      blockingIssue(
        "IMPORT_TOO_MANY_FILES",
        `At most ${String(IMPORT_LIMITS.maximumFiles)} files can be imported at once.`,
      ),
    );
    return baseReport(files, issues, "unknown", 0, false);
  }

  const checked = inspectFiles(files, issues);
  const format = determineFormat(checked);
  const totalBytes = files.reduce((total, file) => total + importFileByteLength(file), 0);
  if (totalBytes > IMPORT_LIMITS.maximumTotalBytes) {
    issues.push(
      blockingIssue(
        "IMPORT_TOTAL_TOO_LARGE",
        "The selected files exceed the total import size limit.",
      ),
    );
    return baseReport(files, issues, format, 0, false);
  }

  const containsBundle = checked.some(({ extension }) => isBundleExtension(extension));

  if (containsBundle) {
    return preflightBundle(files, checked, issues);
  }
  return preflightDocuments(files, checked, issues, format, options);
}

async function parseCheckedDocument(
  checkedFile: CheckedFile,
  options: ImportPreflightOptions,
): Promise<readonly ImportedTextDocument[]> {
  if (checkedFile.extension === ".docx") {
    return importDocxDocuments(checkedFile.file.name, importFileBytes(checkedFile.file), options);
  }
  if (checkedFile.extension === ".epub") {
    return importEpubDocuments(checkedFile.file.name, importFileBytes(checkedFile.file), options);
  }
  if (checkedFile.extension === ".pdf") {
    return importPdfDocuments(checkedFile.file.name, importFileBytes(checkedFile.file), options);
  }

  const content = decodeTextFile(checkedFile);
  const document =
    checkedFile.extension === ".txt"
      ? importPlainTextDocument(checkedFile.file.name, content)
      : checkedFile.extension === ".htm" || checkedFile.extension === ".html"
        ? importHtmlDocument(checkedFile.file.name, content)
        : importMarkdownDocument(checkedFile.file.name, content);
  const sourceFormat =
    checkedFile.extension === ".txt"
      ? "text"
      : checkedFile.extension === ".htm" || checkedFile.extension === ".html"
        ? "html"
        : "markdown";
  return [
    {
      ...document,
      sourceFormat,
      sourceSha256: await sha256Hex(importFileBytes(checkedFile.file)),
      chapterDetectionConfidence: 1,
      requiresBoundaryReview: false,
    },
  ];
}

function importFileBytes(file: InMemoryImportFile): Uint8Array {
  if ("bytes" in file) {
    return file.bytes;
  }
  return utf8Bytes(file.content);
}

function importFileByteLength(file: InMemoryImportFile): number {
  return importFileBytes(file).byteLength;
}

function decodeTextFile(checkedFile: CheckedFile): string {
  if ("content" in checkedFile.file) {
    return checkedFile.file.content;
  }
  const bytes = checkedFile.file.bytes;
  const encoding = checkedFile.file.encoding ?? detectEncoding(bytes);
  const offset =
    encoding === "utf-8" && hasPrefix(bytes, [0xef, 0xbb, 0xbf])
      ? 3
      : (encoding === "utf-16be" || encoding === "utf-16le") &&
          (hasPrefix(bytes, [0xfe, 0xff]) || hasPrefix(bytes, [0xff, 0xfe]))
        ? 2
        : 0;
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    throw new ImportExportError(
      "IMPORT_ENCODING_UNCERTAIN",
      "The text encoding could not be determined without lossy replacement.",
      { fileName: checkedFile.file.name },
    );
  }
}

function detectEncoding(bytes: Uint8Array): "utf-8" | "utf-16be" | "utf-16le" {
  if (hasPrefix(bytes, [0xff, 0xfe])) {
    return "utf-16le";
  }
  if (hasPrefix(bytes, [0xfe, 0xff])) {
    return "utf-16be";
  }
  return "utf-8";
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function issueKey(issue: ImportIssue): string {
  return `${issue.severity}\u0000${issue.code}\u0000${issue.fileName ?? ""}\u0000${issue.path ?? ""}`;
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
