export const PAGE_STATES = [
  "initial",
  "loading",
  "empty",
  "ready",
  "partial_error",
  "fatal_error",
  "offline",
  "forbidden",
  "readonly",
  "conflict",
  "migrating",
  "background_work",
  "license_limited",
  "recoverable",
] as const;

export type PageState = (typeof PAGE_STATES)[number];

export const SAVE_STATES = [
  "clean",
  "dirty",
  "saving",
  "saved_local",
  "pending_sync",
  "save_failed",
  "conflict",
  "readonly",
] as const;

export type SaveState = (typeof SAVE_STATES)[number];

export const GENERATION_STATES = [
  "prechecking",
  "blocked",
  "queued",
  "retrieving",
  "generating",
  "validating",
  "candidate_ready",
  "failed_retryable",
  "failed_final",
  "cancelled",
  "completed",
] as const;

export type GenerationState = (typeof GENERATION_STATES)[number];

export const GENERATION_EVENT_TYPES = [
  "started",
  "context",
  "delta",
  "validation",
  "candidate_ready",
  "completed",
  "failed",
  "cancelled",
  "heartbeat",
] as const;

export type GenerationEventType = (typeof GENERATION_EVENT_TYPES)[number];

export const SYNC_STATES = [
  "disabled",
  "synced",
  "pending",
  "syncing",
  "paused",
  "offline",
  "reauth_required",
  "key_error",
  "conflict",
  "quota_exceeded",
  "device_revoked",
  "version_incompatible",
] as const;

export type SyncState = (typeof SYNC_STATES)[number];

export const LICENSE_STATES = [
  "trial",
  "active",
  "renewal_due",
  "payment_failed",
  "grace_period",
  "expired",
  "cancelled_active",
  "refunding",
  "refunded",
  "enterprise_invalid",
  "offline_expiring",
  "offline_expired",
] as const;

export type LicenseState = (typeof LICENSE_STATES)[number];

export const NOTIFICATION_LEVELS = ["toast", "inline", "inbox", "blocking"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_STATES = [
  "created",
  "queued",
  "visible",
  "read",
  "acted",
  "dismissed",
  "expired",
  "failed_delivery",
] as const;

export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export const AI_CANDIDATE_STATES = [
  "streaming",
  "ready",
  "accepted",
  "rejected",
  "expired",
] as const;

export type AiCandidateState = (typeof AI_CANDIDATE_STATES)[number];

export const AI_CANDIDATE_SOURCES = ["generate", "polish", "extract", "whatif", "agent"] as const;

export type AiCandidateSource = (typeof AI_CANDIDATE_SOURCES)[number];

export const NOTIFICATION_TRANSITIONS = {
  created: ["queued"],
  queued: ["visible", "failed_delivery"],
  visible: ["read", "acted", "dismissed", "expired"],
  read: ["acted", "dismissed", "expired"],
  acted: [],
  dismissed: ["expired"],
  expired: [],
  failed_delivery: ["queued"],
} as const satisfies Readonly<Record<NotificationState, readonly NotificationState[]>>;

export const SAVE_TRANSITIONS = {
  clean: ["dirty", "readonly"],
  dirty: ["saving", "readonly"],
  saving: ["saved_local", "pending_sync", "save_failed", "conflict", "readonly"],
  saved_local: ["dirty", "readonly"],
  pending_sync: ["clean", "dirty", "readonly"],
  save_failed: ["saving", "readonly"],
  conflict: ["saving", "readonly"],
  readonly: [],
} as const satisfies Readonly<Record<SaveState, readonly SaveState[]>>;
