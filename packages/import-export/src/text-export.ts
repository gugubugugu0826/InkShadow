import { utf8ByteLength } from "./checksum.js";
import { IMPORT_LIMITS } from "./constants.js";
import { ImportExportError, type ImportIssue } from "./errors.js";
import { sanitizeFilename } from "./filename.js";
import { portableProjectV1Schema, type PortableProjectV1 } from "./schemas.js";
import { sanitizeMarkdown, sanitizePlainText } from "./text.js";

export interface PlainTextExportArtifact {
  readonly fileName: string;
  readonly mediaType: "text/plain";
  readonly content: string;
  readonly byteLength: number;
  readonly issues: readonly ImportIssue[];
}

export function exportProjectToPlainText(input: PortableProjectV1): PlainTextExportArtifact {
  const parsed = portableProjectV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new ImportExportError("BUNDLE_SCHEMA_INVALID", "Project text export input is invalid.");
  }

  const issues: ImportIssue[] = [];
  const projectTitle = sanitizePlainText(parsed.data.project.title);
  issues.push(...projectTitle.issues);
  const sections = [markdownToPlainText(projectTitle.markdown)];
  const description = parsed.data.project.description?.trim();
  if (description !== undefined && description.length > 0) {
    const safeDescription = sanitizePlainText(description);
    issues.push(...safeDescription.issues);
    sections.push(markdownToPlainText(safeDescription.markdown));
  }

  for (const chapter of [...parsed.data.chapters].sort((left, right) => left.order - right.order)) {
    const title = sanitizePlainText(chapter.title);
    const body = sanitizeMarkdown(chapter.markdown, chapter.path, { allowEmpty: true });
    issues.push(...title.issues, ...body.issues);
    sections.push(
      `${markdownToPlainText(title.markdown)}\n\n${markdownToPlainText(body.markdown)}`.trim(),
    );
  }

  const content = `${sections.join("\n\n").trim()}\n`;
  const byteLength = utf8ByteLength(content);
  if (byteLength > IMPORT_LIMITS.maximumBundleBytes) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      "The plain-text export exceeds the portable export size limit.",
    );
  }
  return {
    fileName: sanitizeFilename(parsed.data.project.title, ".txt"),
    mediaType: "text/plain",
    content,
    byteLength,
    issues,
  };
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/^[ \t]*```[^\n]*$/gm, "")
    .replaceAll(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replaceAll(/^[ \t]*>[ \t]?/gm, "")
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll(/(\*\*)(.*?)\1/g, "$2")
    .replaceAll(/(^|[^\p{L}\p{N}_\\])__([^\n]+?)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replaceAll(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replaceAll(/(^|[^\p{L}\p{N}_\\])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replaceAll(/~~(.*?)~~/g, "$1")
    .replaceAll(/`([^`\n]+)`/g, "$1")
    .replaceAll(/\\([\\`*{}[\]()#+.!_-])/g, "$1")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}
