import { z } from "zod";

import { IMPORT_LIMITS, PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_VERSION } from "./constants.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const SHA_256_HEX = /^[a-f0-9]{64}$/;
const UNSAFE_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_IDENTIFIER, "Identifier contains unsupported characters.");

const titleSchema = z
  .string()
  .min(1)
  .max(IMPORT_LIMITS.maximumTitleCharacters)
  .refine((value) => value === value.trim(), "Title must be trimmed.")
  .refine((value) => !/[\r\n]/.test(value), "Title must be a single line.")
  .refine((value) => !UNSAFE_TEXT_CONTROL.test(value), "Title contains unsafe control characters.");

const descriptionSchema = z
  .string()
  .max(100_000)
  .refine(
    (value) => !UNSAFE_TEXT_CONTROL.test(value),
    "Description contains unsafe control characters.",
  );

export const isoTimestampSchema = z.iso.datetime({ offset: true }).max(40);

export const sha256ChecksumSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(SHA_256_HEX, "Expected a lowercase SHA-256 digest."),
  })
  .strict();

export const portableProjectMetadataV1Schema = z
  .object({
    id: identifierSchema,
    title: titleSchema,
    description: descriptionSchema.optional(),
    language: z.string().min(2).max(35).regex(LANGUAGE_TAG),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const portableChapterV1Schema = z
  .object({
    id: identifierSchema,
    title: titleSchema,
    order: z
      .number()
      .int()
      .min(0)
      .max(IMPORT_LIMITS.maximumChapters - 1),
    path: z.string().min(1).max(IMPORT_LIMITS.maximumRelativePathCharacters),
    markdown: z.string().max(IMPORT_LIMITS.maximumChapterBytes),
  })
  .strict();

export const portableProjectV1Schema = z
  .object({
    project: portableProjectMetadataV1Schema,
    chapters: z.array(portableChapterV1Schema).max(IMPORT_LIMITS.maximumChapters),
  })
  .strict();

export const portableManifestEntryV1Schema = z
  .object({
    id: identifierSchema,
    kind: z.literal("chapter"),
    order: z
      .number()
      .int()
      .min(0)
      .max(IMPORT_LIMITS.maximumChapters - 1),
    path: z.string().min(1).max(IMPORT_LIMITS.maximumRelativePathCharacters),
    mediaType: z.literal("text/markdown"),
    byteLength: z.number().int().min(0).max(IMPORT_LIMITS.maximumChapterBytes),
    checksum: sha256ChecksumSchema,
  })
  .strict();

export const portableManifestV1Schema = z
  .object({
    format: z.literal(PORTABLE_BUNDLE_FORMAT),
    version: z.literal(PORTABLE_BUNDLE_VERSION),
    bundleId: identifierSchema,
    exportedAt: isoTimestampSchema,
    generator: z
      .object({
        name: z.literal("InkShadow"),
        version: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/),
      })
      .strict(),
    project: z
      .object({
        id: identifierSchema,
        title: titleSchema,
        language: z.string().min(2).max(35).regex(LANGUAGE_TAG),
      })
      .strict(),
    counts: z
      .object({
        chapters: z.number().int().min(0).max(IMPORT_LIMITS.maximumChapters),
      })
      .strict(),
    contentBytes: z.number().int().min(1).max(IMPORT_LIMITS.maximumTotalBytes),
    checksum: sha256ChecksumSchema,
    entries: z.array(portableManifestEntryV1Schema).max(IMPORT_LIMITS.maximumManifestEntries),
  })
  .strict();

export const portableBundleV1Schema = z
  .object({
    manifest: portableManifestV1Schema,
    content: portableProjectV1Schema,
  })
  .strict();

export const portableChapterInputSchema = portableChapterV1Schema
  .omit({ path: true })
  .extend({
    path: portableChapterV1Schema.shape.path.optional(),
  })
  .strict();

export const portableProjectInputSchema = z
  .object({
    project: portableProjectMetadataV1Schema,
    chapters: z.array(portableChapterInputSchema).max(IMPORT_LIMITS.maximumChapters),
  })
  .strict();

export const portableBundleMetadataSchema = z
  .object({
    bundleId: identifierSchema,
    exportedAt: isoTimestampSchema,
    generatorVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/),
  })
  .strict();

export const portableBundleSchemaCatalog = Object.freeze({
  bundleV1: portableBundleV1Schema,
  chapterInput: portableChapterInputSchema,
  chapterV1: portableChapterV1Schema,
  checksum: sha256ChecksumSchema,
  exportMetadata: portableBundleMetadataSchema,
  manifestEntryV1: portableManifestEntryV1Schema,
  manifestV1: portableManifestV1Schema,
  projectInput: portableProjectInputSchema,
  projectMetadataV1: portableProjectMetadataV1Schema,
  projectV1: portableProjectV1Schema,
});

export type Sha256Checksum = z.infer<typeof sha256ChecksumSchema>;
export type PortableProjectMetadataV1 = z.infer<typeof portableProjectMetadataV1Schema>;
export type PortableChapterV1 = z.infer<typeof portableChapterV1Schema>;
export type PortableProjectV1 = z.infer<typeof portableProjectV1Schema>;
export type PortableManifestEntryV1 = z.infer<typeof portableManifestEntryV1Schema>;
export type PortableManifestV1 = z.infer<typeof portableManifestV1Schema>;
export type PortableBundleV1 = z.infer<typeof portableBundleV1Schema>;
export type PortableChapterInput = z.infer<typeof portableChapterInputSchema>;
export type PortableProjectInput = z.infer<typeof portableProjectInputSchema>;
export type PortableBundleMetadata = z.infer<typeof portableBundleMetadataSchema>;
