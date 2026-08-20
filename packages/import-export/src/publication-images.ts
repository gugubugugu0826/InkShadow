const MAXIMUM_IMAGE_BYTES = 4 * 1024 * 1024;

export const PUBLICATION_IMAGE_LIMITS = Object.freeze({
  maximumImages: 128,
  maximumAssetEntries: 256,
  maximumImageBytes: MAXIMUM_IMAGE_BYTES,
  maximumTotalImageBytes: 24 * 1024 * 1024,
  maximumPixelCount: 20_000_000,
  maximumDimensionPixels: 8_192,
  maximumAltCharacters: 500,
  maximumSourceCharacters: 512,
  maximumInlineSourceCharacters: Math.ceil(MAXIMUM_IMAGE_BYTES / 3) * 4 + 32,
});

export type PublicationImageMediaType = "image/jpeg" | "image/png";

/**
 * An export-time, caller-owned local asset. Exporters never resolve this path
 * against the filesystem: the path is only a stable key for a byte payload
 * that the caller has already loaded from the current project.
 */
export interface PublicationImageAsset {
  readonly path: string;
  readonly mediaType: PublicationImageMediaType;
  readonly bytes: Uint8Array;
}

export interface ValidatedPublicationImage {
  readonly mediaType: PublicationImageMediaType;
  readonly bytes: Uint8Array;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface ParsedMarkdownImage {
  readonly altText: string;
  readonly source: string;
}

export interface ParsedMarkdownImageReference extends ParsedMarkdownImage {
  readonly start: number;
  readonly end: number;
}

export type PublicationImageResolution =
  | {
      readonly ok: true;
      readonly image: ValidatedPublicationImage;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "asset_duplicate"
        | "asset_missing"
        | "image_invalid"
        | "image_limit_reached"
        | "source_unsafe";
      readonly message: string;
    };

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

interface IndexedAsset {
  readonly duplicate: boolean;
  readonly value: PublicationImageAsset;
}

export class PublicationImageResolver {
  readonly #assets = new Map<string, IndexedAsset>();
  #acceptedImages = 0;
  #acceptedBytes = 0;

  constructor(assets: readonly PublicationImageAsset[] = []) {
    if (assets.length > PUBLICATION_IMAGE_LIMITS.maximumAssetEntries) {
      throw new RangeError(
        `Publication image assets exceed the fixed ${String(
          PUBLICATION_IMAGE_LIMITS.maximumAssetEntries,
        )} entry limit.`,
      );
    }
    for (const asset of assets) {
      const path = normalizeProjectAssetPath(asset.path);
      if (path === null) {
        continue;
      }
      const existing = this.#assets.get(path);
      this.#assets.set(path, {
        duplicate: existing !== undefined,
        value: existing?.value ?? asset,
      });
    }
  }

  resolve(source: string): PublicationImageResolution {
    let candidate: PublicationImageAsset;
    if (startsWithIgnoreCase(source, "data:")) {
      if (
        source.length === 0 ||
        source.length > PUBLICATION_IMAGE_LIMITS.maximumInlineSourceCharacters
      ) {
        return rejected(
          "image_limit_reached",
          "The inline image source exceeds the fixed encoded-byte limit.",
        );
      }
      const inline = decodeInlineImage(source);
      if (inline === null) {
        return rejected(
          "image_invalid",
          "The inline image is not a canonical base64 PNG or JPEG payload.",
        );
      }
      candidate = inline;
    } else {
      if (source.length === 0 || source.length > PUBLICATION_IMAGE_LIMITS.maximumSourceCharacters) {
        return rejected(
          "source_unsafe",
          "The project-local image path is empty or exceeds the fixed limit.",
        );
      }
      const path = normalizeProjectAssetPath(source);
      if (path === null) {
        return rejected(
          "source_unsafe",
          "Only an explicitly supplied project-relative asset path or an inline PNG/JPEG is allowed.",
        );
      }
      const indexed = this.#assets.get(path);
      if (indexed === undefined) {
        return rejected(
          "asset_missing",
          "The project-local image bytes were not supplied to the exporter.",
        );
      }
      if (indexed.duplicate) {
        return rejected(
          "asset_duplicate",
          "The project-local image path is ambiguous because it was supplied more than once.",
        );
      }
      candidate = indexed.value;
    }

    const validated = validatePublicationImage(candidate.mediaType, candidate.bytes);
    if (validated === null) {
      return rejected(
        "image_invalid",
        "The image bytes, declared media type, dimensions, or pixel count are invalid.",
      );
    }
    if (
      this.#acceptedImages >= PUBLICATION_IMAGE_LIMITS.maximumImages ||
      this.#acceptedBytes + validated.bytes.byteLength >
        PUBLICATION_IMAGE_LIMITS.maximumTotalImageBytes
    ) {
      return rejected(
        "image_limit_reached",
        "The publication image count or total byte budget has been reached.",
      );
    }
    this.#acceptedImages += 1;
    this.#acceptedBytes += validated.bytes.byteLength;
    return { ok: true, image: validated };
  }
}

export function parseStandaloneMarkdownImage(line: string): ParsedMarkdownImage | null {
  const references = parseMarkdownImageReferences(line);
  const reference = references[0];
  return references.length === 1 &&
    reference !== undefined &&
    line.slice(0, reference.start).trim().length === 0 &&
    line.slice(reference.end).trim().length === 0
    ? { altText: reference.altText, source: reference.source }
    : null;
}

export function parseMarkdownImageReferences(
  line: string,
): readonly ParsedMarkdownImageReference[] {
  const references: ParsedMarkdownImageReference[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf("![", cursor);
    if (start < 0) {
      break;
    }
    if (isEscaped(line, start)) {
      cursor = start + 2;
      continue;
    }
    const separator = line.indexOf("](", start + 2);
    if (separator < 0) {
      break;
    }
    const endMarker = line.indexOf(")", separator + 2);
    if (endMarker < 0) {
      break;
    }
    const altText = line.slice(start + 2, separator);
    const source = line.slice(separator + 2, endMarker);
    if (
      altText.length <= PUBLICATION_IMAGE_LIMITS.maximumAltCharacters &&
      !altText.includes("]") &&
      source.length > 0 &&
      !source.includes("(")
    ) {
      references.push({ altText, source, start, end: endMarker + 1 });
    }
    cursor = endMarker + 1;
  }
  return references;
}

export function publicationImageDataUri(image: ValidatedPublicationImage): string {
  return `data:${image.mediaType};base64,${encodeBase64(image.bytes)}`;
}

export function publicationImageExtension(mediaType: PublicationImageMediaType): "jpg" | "png" {
  return mediaType === "image/png" ? "png" : "jpg";
}

export function isValidatedPublicationImage(
  input: Pick<ValidatedPublicationImage, "bytes" | "mediaType" | "pixelHeight" | "pixelWidth">,
): boolean {
  const validated = validatePublicationImage(input.mediaType, input.bytes);
  return (
    validated !== null &&
    validated.pixelWidth === input.pixelWidth &&
    validated.pixelHeight === input.pixelHeight
  );
}

export function sanitizePublicationImageAltText(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      output += "\uFFFD";
    } else {
      output += character;
    }
  }
  return output.trim().slice(0, PUBLICATION_IMAGE_LIMITS.maximumAltCharacters);
}

function validatePublicationImage(
  mediaType: unknown,
  input: Uint8Array,
): ValidatedPublicationImage | null {
  if (
    (mediaType !== "image/png" && mediaType !== "image/jpeg") ||
    !(input instanceof Uint8Array) ||
    input.byteLength === 0 ||
    input.byteLength > PUBLICATION_IMAGE_LIMITS.maximumImageBytes
  ) {
    return null;
  }
  const dimensions =
    mediaType === "image/png" ? readPngDimensions(input) : readJpegDimensions(input);
  if (
    dimensions === null ||
    dimensions.width > PUBLICATION_IMAGE_LIMITS.maximumDimensionPixels ||
    dimensions.height > PUBLICATION_IMAGE_LIMITS.maximumDimensionPixels ||
    dimensions.width * dimensions.height > PUBLICATION_IMAGE_LIMITS.maximumPixelCount
  ) {
    return null;
  }
  return {
    mediaType,
    bytes: input.slice(),
    pixelWidth: dimensions.width,
    pixelHeight: dimensions.height,
  };
}

function decodeInlineImage(source: string): PublicationImageAsset | null {
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source);
  if (match === null) {
    return null;
  }
  const mediaType = match[1] as PublicationImageMediaType;
  const encoded = match[2] ?? "";
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    encoded.length > Math.ceil(PUBLICATION_IMAGE_LIMITS.maximumImageBytes / 3) * 4
  ) {
    return null;
  }
  try {
    const decoded = globalThis.atob(encoded);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    if (encodeBase64(bytes) !== encoded) {
      return null;
    }
    return { path: "inline", mediaType, bytes };
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const size = 16_384;
  for (let offset = 0; offset < bytes.length; offset += size) {
    let binary = "";
    for (const byte of bytes.subarray(offset, Math.min(offset + size, bytes.length))) {
      binary += String.fromCharCode(byte);
    }
    chunks.push(binary);
  }
  return globalThis.btoa(chunks.join(""));
}

function normalizeProjectAssetPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PUBLICATION_IMAGE_LIMITS.maximumSourceCharacters ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    return null;
  }
  const normalized = segments.filter((segment) => segment !== ".").join("/");
  return normalized.length === 0 ? null : normalized.normalize("NFC");
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  if (bytes.byteLength < 45 || signature.some((value, index) => bytes[index] !== value)) {
    return null;
  }
  let offset = 8;
  let dimensions: ImageDimensions | null = null;
  let hasImageData = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32(bytes, offset);
    if (length === null || length > bytes.byteLength - offset - 12) {
      return null;
    }
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const dataOffset = offset + 8;
    if (!pngChunkCrcMatches(bytes, offset + 4, length + 4, dataOffset + length)) {
      return null;
    }
    if (type === "IHDR") {
      if (dimensions !== null || offset !== 8 || length !== 13) {
        return null;
      }
      const width = readUint32(bytes, dataOffset);
      const height = readUint32(bytes, dataOffset + 4);
      if (width === null || height === null || width === 0 || height === 0) {
        return null;
      }
      dimensions = { width, height };
    } else if (type === "IDAT") {
      hasImageData ||= length > 0;
    } else if (type === "IEND") {
      return length === 0 && dimensions !== null && hasImageData && offset + 12 === bytes.byteLength
        ? dimensions
        : null;
    }
    offset += 12 + length;
  }
  return null;
}

function pngChunkCrcMatches(
  bytes: Uint8Array,
  start: number,
  length: number,
  checksumOffset: number,
): boolean {
  const expected = readUint32(bytes, checksumOffset);
  if (expected === null || start + length > checksumOffset) {
    return false;
  }
  let crc = 0xffffffff;
  for (let index = start; index < start + length; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0 === expected;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return null;
  }
  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let componentCount = 0;
  let hasQuantizationTable = false;
  let hasHuffmanTable = false;
  while (offset < bytes.byteLength - 2) {
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9) {
      return null;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue;
    }
    const length = readUint16(bytes, offset);
    if (length === null || length < 2 || offset + length > bytes.byteLength) {
      return null;
    }
    if (marker === 0xc0) {
      const precision = bytes[offset + 2];
      componentCount = bytes[offset + 7] ?? 0;
      if (
        dimensions !== null ||
        precision !== 8 ||
        (componentCount !== 1 && componentCount !== 3) ||
        length !== 8 + componentCount * 3
      ) {
        return null;
      }
      const height = readUint16(bytes, offset + 3);
      const width = readUint16(bytes, offset + 5);
      if (width === null || height === null || width === 0 || height === 0) {
        return null;
      }
      dimensions = { width, height };
    } else if (
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return null;
    } else if (marker === 0xdb) {
      hasQuantizationTable ||= length > 2;
    } else if (marker === 0xc4) {
      hasHuffmanTable ||= length > 2;
    } else if (marker === 0xda) {
      const scanComponents = bytes[offset + 2] ?? 0;
      if (
        dimensions === null ||
        !hasQuantizationTable ||
        !hasHuffmanTable ||
        scanComponents !== componentCount ||
        length !== 6 + scanComponents * 2
      ) {
        return null;
      }
      return hasJpegEntropyAndTerminal(bytes, offset + length) ? dimensions : null;
    }
    offset += length;
  }
  return null;
}

function hasJpegEntropyAndTerminal(bytes: Uint8Array, start: number): boolean {
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

function readUint16(bytes: Uint8Array, offset: number): number | null {
  const high = bytes[offset];
  const low = bytes[offset + 1];
  return high === undefined || low === undefined ? null : high * 256 + low;
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null;
  }
  return first * 0x1000000 + second * 0x10000 + third * 0x100 + fourth;
}

function startsWithIgnoreCase(value: string, prefix: string): boolean {
  return value.slice(0, prefix.length).toLocaleLowerCase("en-US") === prefix;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function rejected(
  reason: Extract<PublicationImageResolution, { readonly ok: false }>["reason"],
  message: string,
): PublicationImageResolution {
  return { ok: false, reason, message };
}
