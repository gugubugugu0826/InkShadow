import { utf8ByteLength } from "./checksum.js";
import { IMPORT_LIMITS } from "./constants.js";
import { ImportExportError, type ImportIssue } from "./errors.js";
import { sanitizeFilename } from "./filename.js";
import {
  portableChapterV1Schema,
  portableProjectV1Schema,
  type PortableChapterV1,
  type PortableProjectV1,
} from "./schemas.js";
import { sanitizeMarkdown, sanitizePlainText } from "./text.js";
import type { PublicationImageAsset } from "./publication-images.js";

export interface MarkdownExportArtifact {
  readonly fileName: string;
  readonly mediaType: "text/markdown";
  readonly content: string;
  readonly byteLength: number;
  readonly issues: readonly ImportIssue[];
}

export interface MarkdownExportOptions {
  readonly imageAssets?: readonly PublicationImageAsset[];
}

function schemaError(
  subject: string,
  result: {
    readonly error: {
      readonly issues: readonly {
        readonly message: string;
        readonly path: readonly PropertyKey[];
      }[];
    };
  },
): ImportExportError {
  const first = result.error.issues[0];
  const path = first?.path.map(String).join(".") ?? "";
  return new ImportExportError(
    "BUNDLE_SCHEMA_INVALID",
    `${subject} is invalid${path.length === 0 ? "" : ` at ${path}`}: ${first?.message ?? "schema validation failed"}`,
  );
}

function finishArtifact(
  fileName: string,
  sections: readonly string[],
  issues: readonly ImportIssue[],
): MarkdownExportArtifact {
  const content = `${sections.join("\n\n").trim()}\n`;
  const byteLength = utf8ByteLength(content);
  if (byteLength > IMPORT_LIMITS.maximumBundleBytes) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      "The Markdown export exceeds the portable export size limit.",
      { fileName },
    );
  }

  return {
    fileName,
    mediaType: "text/markdown",
    content,
    byteLength,
    issues,
  };
}

export function exportChapterToMarkdown(
  input: PortableChapterV1,
  options: MarkdownExportOptions = {},
): MarkdownExportArtifact {
  const parsed = portableChapterV1Schema.safeParse(input);
  if (!parsed.success) {
    throw schemaError("Chapter export input", parsed);
  }

  const title = sanitizePlainText(parsed.data.title);
  const body = sanitizeMarkdown(parsed.data.markdown, parsed.data.path, {
    ...options,
    allowEmpty: true,
  });
  return finishArtifact(
    sanitizeFilename(parsed.data.title, ".md"),
    [`# ${title.markdown}`, body.markdown],
    [...title.issues, ...body.issues],
  );
}

export function exportProjectToMarkdown(
  input: PortableProjectV1,
  options: MarkdownExportOptions = {},
): MarkdownExportArtifact {
  const parsed = portableProjectV1Schema.safeParse(input);
  if (!parsed.success) {
    throw schemaError("Project export input", parsed);
  }

  const issues: ImportIssue[] = [];
  const projectTitle = sanitizePlainText(parsed.data.project.title);
  issues.push(...projectTitle.issues);
  const sections: string[] = [`# ${projectTitle.markdown}`];

  const description = parsed.data.project.description?.trim();
  if (description !== undefined && description.length > 0) {
    const safeDescription = sanitizePlainText(description);
    sections.push(safeDescription.markdown);
    issues.push(...safeDescription.issues);
  }

  for (const chapter of [...parsed.data.chapters].sort((left, right) => left.order - right.order)) {
    const title = sanitizePlainText(chapter.title);
    const body = sanitizeMarkdown(chapter.markdown, chapter.path, {
      ...options,
      allowEmpty: true,
    });
    sections.push(`## ${title.markdown}\n\n${body.markdown}`);
    issues.push(...title.issues, ...body.issues);
  }

  return finishArtifact(sanitizeFilename(parsed.data.project.title, ".md"), sections, issues);
}
