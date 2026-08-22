import { z } from "zod";

import {
  AI_CANDIDATE_PURPOSES,
  AI_CANDIDATE_SOURCES,
  AI_CANDIDATE_STATES,
  GENERATION_EVENT_TYPES,
  GENERATION_STATES,
  LICENSE_STATES,
  NOTIFICATION_LEVELS,
  NOTIFICATION_STATES,
  PAGE_STATES,
  SAVE_STATES,
  SYNC_STATES,
} from "./states.js";

export const CONTRACT_SCHEMA_VERSION = 1 as const;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UuidV7Schema = z.string().regex(UUID_V7_PATTERN, "Expected a UUIDv7 identifier");

export const IsoUtcTimestampSchema = z.iso.datetime();

export const PageStateSchema = z.enum(PAGE_STATES);
export const SaveStateSchema = z.enum(SAVE_STATES);
export const GenerationStateSchema = z.enum(GENERATION_STATES);
export const GenerationEventTypeSchema = z.enum(GENERATION_EVENT_TYPES);
export const SyncStateSchema = z.enum(SYNC_STATES);
export const LicenseStateSchema = z.enum(LICENSE_STATES);
export const NotificationLevelSchema = z.enum(NOTIFICATION_LEVELS);
export const NotificationStateSchema = z.enum(NOTIFICATION_STATES);
export const AiCandidateStateSchema = z.enum(AI_CANDIDATE_STATES);
export const AiCandidateSourceSchema = z.enum(AI_CANDIDATE_SOURCES);
export const AiCandidatePurposeSchema = z.enum(AI_CANDIDATE_PURPOSES);

export const ErrorActionSchema = z.enum([
  "RETRY",
  "RENAME",
  "USE_LOCAL",
  "EXPORT_DRAFT",
  "RESTORE",
  "OPEN_SETTINGS",
  "SWITCH_MODEL",
  "REDUCE_CONTEXT",
  "RESOLVE_CONFLICT",
  "REQUEST_ACCESS",
  "REAUTHENTICATE",
  "UPGRADE_CLIENT",
  "CONTACT_SUPPORT",
]);

export const AppErrorContractSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    actions: z.array(ErrorActionSchema),
    details: z.record(z.string(), z.unknown()),
    requestId: UuidV7Schema.nullable(),
    supportId: z.string().min(1).max(100).nullable(),
  })
  .strict();

export const PageStateContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    state: PageStateSchema,
    visibleContent: z.array(z.string().min(1)),
    allowedActions: z.array(z.string().min(1)),
    prohibitedActions: z.array(z.string().min(1)),
    persistence: z.enum(["saved", "unsaved", "mixed", "not_applicable"]),
    recoveryActions: z.array(ErrorActionSchema),
    error: AppErrorContractSchema.nullable(),
    blocksNavigation: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    const statesRequiringError = new Set<string>([
      "partial_error",
      "fatal_error",
      "offline",
      "forbidden",
      "conflict",
      "migrating",
      "license_limited",
      "recoverable",
    ]);
    if (statesRequiringError.has(page.state) && page.error === null) {
      context.addIssue({
        code: "custom",
        message: "This page state requires a stable error contract",
        path: ["error"],
      });
    }
  });

export const SaveStateContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    chapterId: UuidV7Schema,
    state: SaveStateSchema,
    revision: z.number().int().nonnegative(),
    baseVersionId: UuidV7Schema.nullable(),
    lastStableSavedAt: IsoUtcTimestampSchema.nullable(),
    error: AppErrorContractSchema.nullable(),
  })
  .strict()
  .superRefine((save, context) => {
    if ((save.state === "save_failed" || save.state === "conflict") && save.error === null) {
      context.addIssue({
        code: "custom",
        message: "Failed and conflicted saves require an error contract",
        path: ["error"],
      });
    }
  });

export const GenerationStateContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    generationId: UuidV7Schema,
    projectId: UuidV7Schema,
    chapterId: UuidV7Schema,
    state: GenerationStateSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    attempt: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(200),
    candidateId: UuidV7Schema.nullable(),
    error: AppErrorContractSchema.nullable(),
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((generation, context) => {
    const failed =
      generation.state === "blocked" ||
      generation.state === "failed_retryable" ||
      generation.state === "failed_final";
    if (failed && generation.error === null) {
      context.addIssue({
        code: "custom",
        message: "Blocked or failed generation requires an error contract",
        path: ["error"],
      });
    }

    const hasCandidate = generation.state === "candidate_ready" || generation.state === "completed";
    if (hasCandidate && generation.candidateId === null) {
      context.addIssue({
        code: "custom",
        message: "Completed generation must retain its candidate id",
        path: ["candidateId"],
      });
    }
  });

export const GenerationEventSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    generationId: UuidV7Schema,
    type: GenerationEventTypeSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdAt: IsoUtcTimestampSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const SyncStateContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    projectId: UuidV7Schema,
    state: SyncStateSchema,
    localRevision: z.number().int().nonnegative(),
    remoteCursor: z.string().min(1).max(500).nullable(),
    pendingChanges: z.number().int().nonnegative(),
    error: AppErrorContractSchema.nullable(),
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();

export const LocalDataAccessSchema = z
  .object({
    read: z.literal(true),
    edit: z.literal(true),
    backup: z.literal(true),
    export: z.literal(true),
  })
  .strict();

export const LicenseStateContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    state: LicenseStateSchema,
    entitlements: z.array(z.string().min(1).max(100)),
    validUntil: IsoUtcTimestampSchema.nullable(),
    localDataAccess: LocalDataAccessSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();

export const NotificationContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    id: UuidV7Schema,
    level: NotificationLevelSchema,
    state: NotificationStateSchema,
    dedupeKey: z.string().min(1).max(200),
    title: z.string().min(1).max(160),
    message: z.string().min(1).max(1_000),
    objectRoute: z.string().min(1).max(500).nullable(),
    createdAt: IsoUtcTimestampSchema,
    readAt: IsoUtcTimestampSchema.nullable(),
    expiresAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((notification, context) => {
    if (notification.level === "blocking" && notification.expiresAt !== null) {
      context.addIssue({
        code: "custom",
        message: "Blocking notifications cannot expire automatically",
        path: ["expiresAt"],
      });
    }

    if (notification.state === "read" && notification.readAt === null) {
      context.addIssue({
        code: "custom",
        message: "Read notifications require readAt",
        path: ["readAt"],
      });
    }
  });

export const AiCandidateContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    id: UuidV7Schema,
    projectId: UuidV7Schema,
    chapterId: UuidV7Schema.nullable(),
    purpose: AiCandidatePurposeSchema.default("prose"),
    source: AiCandidateSourceSchema,
    baseVersionId: UuidV7Schema.nullable(),
    content: z.string().max(5_000_000),
    contentChecksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable(),
    status: AiCandidateStateSchema,
    incomplete: z.boolean(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    decidedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.purpose === "continuation_directions" && candidate.status === "accepted") {
      context.addIssue({
        code: "custom",
        message: "Continuation directions cannot be accepted as chapter prose",
        path: ["status"],
      });
    }

    if (candidate.chapterId !== null && candidate.baseVersionId === null) {
      context.addIssue({
        code: "custom",
        message: "Chapter candidates require a base version",
        path: ["baseVersionId"],
      });
    }

    if (
      candidate.status !== "streaming" &&
      (candidate.content.length === 0 || candidate.contentChecksum === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Persisted candidates require content and checksum",
        path: ["content"],
      });
    }

    const isDecided =
      candidate.status === "accepted" ||
      candidate.status === "rejected" ||
      candidate.status === "expired";
    if (isDecided !== (candidate.decidedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Candidate terminal state and decidedAt must agree",
        path: ["decidedAt"],
      });
    }
  });

export type AppErrorContract = z.infer<typeof AppErrorContractSchema>;
export type PageStateContract = z.infer<typeof PageStateContractSchema>;
export type SaveStateContract = z.infer<typeof SaveStateContractSchema>;
export type GenerationStateContract = z.infer<typeof GenerationStateContractSchema>;
export type GenerationEvent = z.infer<typeof GenerationEventSchema>;
export type SyncStateContract = z.infer<typeof SyncStateContractSchema>;
export type LicenseStateContract = z.infer<typeof LicenseStateContractSchema>;
export type NotificationContract = z.infer<typeof NotificationContractSchema>;
export type AiCandidateContract = z.infer<typeof AiCandidateContractSchema>;
