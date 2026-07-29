import {
  ALLOWED_BINARY_DOCUMENT_EXTENSIONS,
  ALLOWED_BUNDLE_EXTENSIONS,
  ALLOWED_TEXT_EXTENSIONS,
  IMPORT_LIMITS,
  type AllowedBinaryDocumentExtension,
  type AllowedBundleExtension,
  type AllowedTextExtension,
} from "./constants.js";
import { ImportExportError } from "./errors.js";

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_FILENAME_CHARACTERS = /[<>:"/\\|?*#%\u0000-\u001f\u007f]/g;

function normalizeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  if (!/^\.[a-z0-9.]{1,24}$/.test(normalized)) {
    throw new ImportExportError("IMPORT_UNSAFE_PATH", "The requested output extension is invalid.");
  }
  return normalized;
}

export function sanitizeFilename(input: string, extension = "", fallback = "untitled"): string {
  const normalizedExtension = extension.length === 0 ? "" : normalizeExtension(extension);
  let base = input.normalize("NFKC");

  if (normalizedExtension.length > 0 && base.toLowerCase().endsWith(normalizedExtension)) {
    base = base.slice(0, -normalizedExtension.length);
  }

  base = base
    .replaceAll(FORBIDDEN_FILENAME_CHARACTERS, "-")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^[.\s-]+|[.\s-]+$/g, "")
    .trim();

  if (base.length === 0 || base === "." || base === "..") {
    base = fallback;
  }
  if (WINDOWS_RESERVED_NAME.test(base)) {
    base = `_${base}`;
  }

  base = Array.from(base)
    .slice(0, 120)
    .join("")
    .replaceAll(/[.\s]+$/g, "");
  return `${base.length === 0 ? fallback : base}${normalizedExtension}`;
}

function decodePath(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return decoded;
      }
      decoded = next;
    } catch {
      throw new ImportExportError(
        "IMPORT_UNSAFE_PATH",
        "The path contains invalid percent encoding.",
        { path: value },
      );
    }
  }

  throw new ImportExportError(
    "IMPORT_UNSAFE_PATH",
    "The path contains excessive or ambiguous percent encoding.",
    { path: value },
  );
}

export function assertSafeInputFilename(fileName: string): void {
  const decoded = decodePath(fileName.normalize("NFKC"));
  if (
    decoded.length === 0 ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /^[A-Za-z]:/.test(decoded) ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw new ImportExportError(
      "IMPORT_PATH_TRAVERSAL",
      "Import file names must not contain paths or traversal segments.",
      { fileName },
    );
  }
}

export function assertSafeBundlePath(path: string): void {
  const compatibilityNormalized = path.normalize("NFKC");
  const normalized = decodePath(compatibilityNormalized);
  const segments = normalized.split("/");
  if (
    normalized !== compatibilityNormalized ||
    normalized.length === 0 ||
    normalized.length > IMPORT_LIMITS.maximumRelativePathCharacters ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        /[<>:"|?*]/.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment),
    )
  ) {
    throw new ImportExportError(
      "IMPORT_PATH_TRAVERSAL",
      "Bundle paths must be safe project-relative paths.",
      { path },
    );
  }

  if (
    segments[0] !== "chapters" ||
    !normalized.toLowerCase().endsWith(".md") ||
    normalized.includes(":")
  ) {
    throw new ImportExportError(
      "IMPORT_UNSAFE_PATH",
      "Bundle entries must be Markdown files under the chapters directory.",
      { path },
    );
  }
}

export function getAllowedImportExtension(
  fileName: string,
): AllowedTextExtension | AllowedBinaryDocumentExtension | AllowedBundleExtension {
  const lower = fileName.toLowerCase();
  const bundleExtension = ALLOWED_BUNDLE_EXTENSIONS.find((extension) => lower.endsWith(extension));
  if (bundleExtension !== undefined) {
    return bundleExtension;
  }

  const textExtension = ALLOWED_TEXT_EXTENSIONS.find((extension) => lower.endsWith(extension));
  if (textExtension !== undefined) {
    return textExtension;
  }
  const binaryDocumentExtension = ALLOWED_BINARY_DOCUMENT_EXTENSIONS.find((extension) =>
    lower.endsWith(extension),
  );
  if (binaryDocumentExtension !== undefined) {
    return binaryDocumentExtension;
  }

  const lastDot = lower.lastIndexOf(".");
  const extension = lastDot < 0 ? "" : lower.slice(lastDot);
  if ([".docm", ".dotm", ".xlsm", ".xltm", ".pptm", ".potm"].includes(extension)) {
    throw new ImportExportError(
      "IMPORT_MACRO_FORMAT_FORBIDDEN",
      "Macro-enabled document formats are not accepted.",
      { fileName },
    );
  }

  throw new ImportExportError(
    "IMPORT_EXTENSION_FORBIDDEN",
    "Only InkShadow JSON bundles, DOCX, text-based PDF, inert HTML, Markdown, and plain text are accepted here.",
    { fileName },
  );
}
