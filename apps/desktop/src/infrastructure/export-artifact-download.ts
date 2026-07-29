const DOWNLOAD_URL_RETENTION_MS = 60_000;
const MAX_DOWNLOAD_FILENAME_CHARACTERS = 180;
const SAFE_MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const UNSAFE_FILENAME_PATTERN = /[/\\\u0000-\u001f\u007f]/u;

export interface BrowserExportArtifact {
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
}

export interface BrowserExportDownloadReceipt {
  readonly fileName: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export function downloadBrowserExportArtifact(
  artifact: BrowserExportArtifact,
): BrowserExportDownloadReceipt {
  validateArtifact(artifact);
  const blobPart =
    typeof artifact.content === "string"
      ? artifact.content
      : new Uint8Array(artifact.content).buffer;
  const blob = new Blob([blobPart], {
    type:
      typeof artifact.content === "string"
        ? `${artifact.mediaType};charset=utf-8`
        : artifact.mediaType,
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.fileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch (cause: unknown) {
    URL.revokeObjectURL(url);
    throw cause;
  }
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_RETENTION_MS);
  return Object.freeze({
    fileName: artifact.fileName,
    byteLength: blob.size,
    mediaType: artifact.mediaType,
  });
}

function validateArtifact(artifact: BrowserExportArtifact): void {
  if (
    artifact.fileName.length === 0 ||
    artifact.fileName.length > MAX_DOWNLOAD_FILENAME_CHARACTERS ||
    artifact.fileName === "." ||
    artifact.fileName === ".." ||
    UNSAFE_FILENAME_PATTERN.test(artifact.fileName)
  ) {
    throw new Error("The export file name is unsafe.");
  }
  if (!SAFE_MEDIA_TYPE_PATTERN.test(artifact.mediaType)) {
    throw new Error("The export media type is invalid.");
  }
  if (
    (typeof artifact.content === "string" && artifact.content.length === 0) ||
    (artifact.content instanceof Uint8Array && artifact.content.byteLength === 0)
  ) {
    throw new Error("The export artifact is empty.");
  }
}
