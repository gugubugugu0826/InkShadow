import { sql } from "drizzle-orm";
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived", "trashed"] })
      .notNull()
      .default("active"),
    revision: integer("revision").notNull().default(1),
    deletionGeneration: integer("deletion_generation").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    trashedAt: text("trashed_at"),
    retentionUntil: text("retention_until"),
    statusBeforeTrash: text("status_before_trash", {
      enum: ["active", "archived"],
    }),
  },
  (table) => [
    check("projects_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 120`),
    check("projects_revision", sql`${table.revision} >= 1`),
    check("projects_deletion_generation", sql`${table.deletionGeneration} >= 0`),
    index("projects_status_updated_idx").on(table.status, table.updatedAt),
    uniqueIndex("projects_visible_name_unique")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.status} <> 'trashed'`),
  ],
);

export const projectDisplayIdentities = sqliteTable(
  "project_display_identities",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    displayKind: text("display_kind", {
      enum: ["author_work", "test_work", "builtin_example", "system_evaluation"],
    }).notNull(),
    provenance: text("provenance", {
      enum: ["explicit_creation", "explicit_test", "builtin_example", "evaluation_project_id"],
    }).notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "project_display_identities_pair",
      sql`(
        (${table.displayKind} = 'author_work' AND ${table.provenance} = 'explicit_creation')
        OR
        (${table.displayKind} = 'test_work' AND ${table.provenance} = 'explicit_test')
        OR
        (${table.displayKind} = 'builtin_example' AND ${table.provenance} = 'builtin_example')
        OR
        (${table.displayKind} = 'system_evaluation' AND ${table.provenance} = 'evaluation_project_id')
      )`,
    ),
    check("project_display_identities_revision", sql`${table.revision} >= 1`),
    index("project_display_identities_kind_idx").on(table.displayKind, table.projectId),
  ],
);

export const projectDisplayIdentityRevisions = sqliteTable(
  "project_display_identity_revisions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    previousDisplayKind: text("previous_display_kind", {
      enum: ["author_work", "test_work", "builtin_example", "system_evaluation"],
    }),
    displayKind: text("display_kind", {
      enum: ["author_work", "test_work", "builtin_example", "system_evaluation"],
    }).notNull(),
    provenance: text("provenance", {
      enum: ["explicit_creation", "explicit_test", "builtin_example", "evaluation_project_id"],
    }).notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.revision] }),
    check("project_display_identity_revisions_revision", sql`${table.revision} >= 1`),
    check(
      "project_display_identity_revisions_pair",
      sql`(
        (${table.displayKind} = 'author_work' AND ${table.provenance} = 'explicit_creation')
        OR
        (${table.displayKind} = 'test_work' AND ${table.provenance} = 'explicit_test')
        OR
        (${table.displayKind} = 'builtin_example' AND ${table.provenance} = 'builtin_example')
        OR
        (${table.displayKind} = 'system_evaluation' AND ${table.provenance} = 'evaluation_project_id')
      )`,
    ),
    index("project_display_identity_revisions_project_idx").on(table.projectId, table.revision),
  ],
);
export const projectSeeds = sqliteTable(
  "project_seeds",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    seedId: text("seed_id").notNull(),
    journeyKind: text("journey_kind", { enum: ["idea", "import", "professional"] }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("project_seeds_seed_id_length", sql`length(${table.seedId}) BETWEEN 1 AND 256`),
    check("project_seeds_schema_version", sql`${table.schemaVersion} = 1`),
    check("project_seeds_revision_bounds", sql`${table.revision} BETWEEN 1 AND 9007199254740991`),
    index("project_seeds_updated_idx").on(table.updatedAt, table.projectId),
  ],
);

export const storySettingsImportReceipts = sqliteTable(
  "story_settings_import_receipts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceSha256: text("source_sha256").notNull(),
    requestSha256: text("request_sha256").notNull(),
    status: text("status", { enum: ["committed", "undone"] }).notNull(),
    createdRecordIdsJson: text("created_record_ids_json").notNull(),
    updatedRecordFencesJson: text("updated_record_fences_json").notNull(),
    createdFactIdsJson: text("created_fact_ids_json").notNull(),
    createdMemoryIdsJson: text("created_memory_ids_json").notNull(),
    importedCount: integer("imported_count").notNull(),
    skippedCount: integer("skipped_count").notNull(),
    createdAt: text("created_at").notNull(),
    undoneAt: text("undone_at"),
  },
  (table) => [
    check(
      "story_settings_import_receipts_source_sha256",
      sql`length(${table.sourceSha256}) = 64 AND ${table.sourceSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "story_settings_import_receipts_request_sha256",
      sql`length(${table.requestSha256}) = 64 AND ${table.requestSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "story_settings_import_receipts_created_records_json",
      sql`json_valid(${table.createdRecordIdsJson}) AND json_type(${table.createdRecordIdsJson}) = 'array'`,
    ),
    check(
      "story_settings_import_receipts_updated_fences_json",
      sql`json_valid(${table.updatedRecordFencesJson}) AND json_type(${table.updatedRecordFencesJson}) = 'array'`,
    ),
    check(
      "story_settings_import_receipts_created_facts_json",
      sql`json_valid(${table.createdFactIdsJson}) AND json_type(${table.createdFactIdsJson}) = 'array'`,
    ),
    check(
      "story_settings_import_receipts_created_memories_json",
      sql`json_valid(${table.createdMemoryIdsJson}) AND json_type(${table.createdMemoryIdsJson}) = 'array'`,
    ),
    check(
      "story_settings_import_receipts_imported_count",
      sql`${table.importedCount} BETWEEN 0 AND 5000`,
    ),
    check(
      "story_settings_import_receipts_skipped_count",
      sql`${table.skippedCount} BETWEEN 0 AND 5000`,
    ),
    index("story_settings_import_receipts_project_source_idx").on(
      table.projectId,
      table.sourceSha256,
      table.createdAt,
      table.id,
    ),
    index("story_settings_import_receipts_project_created_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const chapters = sqliteTable(
  "chapters",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    status: text("status", { enum: ["active", "trashed"] })
      .notNull()
      .default("active"),
    revision: integer("revision").notNull().default(1),
    privacyMode: text("privacy_mode", { enum: ["standard", "local_only"] })
      .notNull()
      .default("standard"),
    privacyRevision: integer("privacy_revision").notNull().default(1),
    // The SQL migration owns the deferred FK to chapter_versions. Keeping this
    // field unreferenced here avoids a circular schema initializer in Drizzle.
    currentVersionId: text("current_version_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    trashedAt: text("trashed_at"),
  },
  (table) => [
    check("chapters_title_length", sql`length(trim(${table.title})) BETWEEN 1 AND 200`),
    check("chapters_content_length", sql`length(${table.content}) <= 5000000`),
    check("chapters_revision", sql`${table.revision} >= 1`),
    check("chapters_privacy_revision", sql`${table.privacyRevision} >= 1`),
    index("chapters_project_updated_idx").on(table.projectId, table.status, table.updatedAt),
    index("chapters_project_privacy_idx").on(
      table.projectId,
      table.privacyMode,
      table.status,
      table.createdAt,
      table.id,
    ),
  ],
);

export const chapterVersions = sqliteTable(
  "chapter_versions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    parentVersionId: text("parent_version_id"),
    sequence: integer("sequence").notNull(),
    content: text("content").notNull(),
    contentChecksum: text("content_checksum").notNull(),
    reason: text("reason", {
      enum: ["created", "autosave", "manual", "candidate_accept", "recovery", "import"],
    }).notNull(),
    sourceCandidateId: text("source_candidate_id"),
    organizeLocalStoryFacts: integer("organize_local_story_facts").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("chapter_versions_sequence", sql`${table.sequence} >= 1`),
    check("chapter_versions_local_story_facts", sql`${table.organizeLocalStoryFacts} IN (0, 1)`),
    check("chapter_versions_checksum", sql`length(${table.contentChecksum}) = 64`),
    uniqueIndex("chapter_versions_chapter_sequence_unique").on(table.chapterId, table.sequence),
    index("chapter_versions_chapter_idx").on(table.chapterId, table.sequence),
  ],
);

export const chapterValidationSnapshots = sqliteTable(
  "chapter_validation_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    chapterVersionId: text("chapter_version_id").references(() => chapterVersions.id, {
      onDelete: "cascade",
    }),
    chapterRevision: integer("chapter_revision"),
    schemaVersion: integer("schema_version").notNull(),
    ruleSetVersion: text("rule_set_version").notNull(),
    runSequence: integer("run_sequence").notNull(),
    runKind: text("run_kind", { enum: ["initial", "rerun"] }).notNull(),
    // The SQL migration owns this self-reference. Leaving it unreferenced here
    // avoids a circular Drizzle initializer while preserving the database FK.
    supersedesSnapshotId: text("supersedes_snapshot_id"),
    resultStatus: text("result_status", { enum: ["checked", "skipped"] }).notNull(),
    issueCount: integer("issue_count").notNull(),
    resultChecksumSha256: text("result_checksum_sha256").notNull(),
    resultJson: text("result_json").notNull(),
    generatedAt: text("generated_at").notNull(),
  },
  (table) => [
    check("chapter_validation_snapshots_schema", sql`${table.schemaVersion} = 1`),
    check(
      "chapter_validation_snapshots_rule_set",
      sql`length(${table.ruleSetVersion}) BETWEEN 1 AND 128`,
    ),
    check("chapter_validation_snapshots_sequence", sql`${table.runSequence} >= 1`),
    check("chapter_validation_snapshots_issue_count", sql`${table.issueCount} >= 0`),
    check("chapter_validation_snapshots_checksum", sql`length(${table.resultChecksumSha256}) = 64`),
    uniqueIndex("chapter_validation_snapshots_sequence_unique").on(
      table.chapterId,
      table.runSequence,
    ),
    index("chapter_validation_snapshots_latest_idx").on(
      table.projectId,
      table.chapterId,
      table.runSequence,
    ),
    index("chapter_validation_snapshots_version_idx").on(
      table.chapterId,
      table.chapterVersionId,
      table.ruleSetVersion,
      table.generatedAt,
    ),
  ],
);

export const recoveryDrafts = sqliteTable(
  "recovery_drafts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    baseRevision: integer("base_revision").notNull(),
    content: text("content").notNull(),
    cursorOffset: integer("cursor_offset").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("recovery_drafts_base_revision", sql`${table.baseRevision} >= 1`),
    check("recovery_drafts_cursor_offset", sql`${table.cursorOffset} >= 0`),
    uniqueIndex("recovery_drafts_chapter_unique").on(table.chapterId),
  ],
);

export const authorRecoveryRecords = sqliteTable(
  "author_recovery_records",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    schemaVersion: text("schema_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.kind] }),
    check("author_recovery_records_kind_length", sql`length(${table.kind}) BETWEEN 1 AND 64`),
    check("author_recovery_records_kind_chars", sql`${table.kind} NOT GLOB '*[^a-z0-9_]*'`),
    check(
      "author_recovery_records_schema_length",
      sql`length(${table.schemaVersion}) BETWEEN 1 AND 128`,
    ),
    check(
      "author_recovery_records_payload_object",
      sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`,
    ),
    check(
      "author_recovery_records_revision",
      sql`${table.revision} BETWEEN 1 AND 9007199254740991`,
    ),
    index("author_recovery_records_updated_idx").on(table.updatedAt, table.projectId, table.kind),
  ],
);

export const aiCandidates = sqliteTable(
  "ai_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id, {
      onDelete: "cascade",
    }),
    baseVersionId: text("base_version_id").references(() => chapterVersions.id),
    source: text("source", {
      enum: ["generate", "polish", "extract", "whatif", "agent"],
    }).notNull(),
    purpose: text("purpose", { enum: ["prose", "continuation_directions"] })
      .notNull()
      .default("prose"),
    content: text("content").notNull(),
    contentChecksum: text("content_checksum"),
    status: text("status", {
      enum: ["streaming", "ready", "accepted", "rejected", "expired"],
    }).notNull(),
    revision: integer("revision").notNull().default(1),
    incomplete: integer("incomplete", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    decidedAt: text("decided_at"),
    taskIntent: text("task_intent", {
      enum: ["legacy_full_document", "continuation", "selection_rewrite", "whole_chapter_rewrite"],
    })
      .notNull()
      .default("legacy_full_document"),
    applicationMode: text("application_mode", {
      enum: ["replace_document", "insert_at_cursor", "replace_selection"],
    })
      .notNull()
      .default("replace_document"),
    payloadKind: text("payload_kind", { enum: ["full_document", "fragment"] })
      .notNull()
      .default("full_document"),
    anchorStartUtf16: integer("anchor_start_utf16"),
    anchorEndUtf16: integer("anchor_end_utf16"),
    selectionAction: text("selection_action", {
      enum: ["selection_rewrite", "polish", "expand", "shorten"],
    }),
  },
  (table) => [
    check(
      "ai_candidates_checksum",
      sql`${table.contentChecksum} IS NULL OR length(${table.contentChecksum}) = 64`,
    ),
    check("ai_candidates_revision", sql`${table.revision} BETWEEN 1 AND 9007199254740991`),
    index("ai_candidates_chapter_status_idx").on(table.chapterId, table.status, table.createdAt),
  ],
);

export const localAuditEvents = sqliteTable(
  "local_audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    requestId: text("request_id").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("local_audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt),
  ],
);

export const modelProfiles = sqliteTable(
  "model_profiles",
  {
    providerId: text("provider_id").primaryKey(),
    provider: text("provider", {
      enum: ["open_ai_compatible", "ollama"],
    }).notNull(),
    baseUrl: text("base_url").notNull(),
    authentication: text("authentication", {
      enum: ["none", "bearer_keyring"],
    }).notNull(),
    selectedModel: text("selected_model"),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("model_profiles_provider_id_length", sql`length(${table.providerId}) BETWEEN 1 AND 128`),
    check("model_profiles_base_url_length", sql`length(${table.baseUrl}) BETWEEN 1 AND 2048`),
    check(
      "model_profiles_selected_model_length",
      sql`${table.selectedModel} IS NULL OR length(${table.selectedModel}) BETWEEN 1 AND 512`,
    ),
    check("model_profiles_revision", sql`${table.revision} >= 1`),
    index("model_profiles_updated_idx").on(table.updatedAt, table.providerId),
  ],
);

export const modelPricingProfiles = sqliteTable(
  "model_pricing_profiles",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProfiles.providerId, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    contextWindowTokens: integer("context_window_tokens").notNull(),
    currency: text("currency").notNull(),
    inputMicrosPerMillionTokens: integer("input_micros_per_million_tokens").notNull(),
    outputMicrosPerMillionTokens: integer("output_micros_per_million_tokens").notNull(),
    cachedInputMicrosPerMillionTokens: integer("cached_input_micros_per_million_tokens"),
    pricingVersion: text("pricing_version").notNull(),
    priceUpdatedAt: text("price_updated_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.providerId, table.modelId] }),
    check(
      "model_pricing_context_window",
      sql`${table.contextWindowTokens} BETWEEN 1 AND 100000000`,
    ),
    check("model_pricing_currency", sql`length(${table.currency}) = 3`),
    index("model_pricing_profiles_updated_idx").on(
      table.updatedAt,
      table.providerId,
      table.modelId,
    ),
  ],
);

export const aiBudgetPolicies = sqliteTable(
  "ai_budget_policies",
  {
    scopeKey: text("scope_key").primaryKey(),
    scope: text("scope", { enum: ["project", "month"] }).notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    monthKey: text("month_key"),
    currency: text("currency").notNull(),
    limitMicros: text("limit_micros").notNull(),
    enforcement: text("enforcement", { enum: ["warn", "hard"] }).notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("ai_budget_revision", sql`${table.revision} >= 1`),
    check("ai_budget_currency", sql`length(${table.currency}) = 3`),
    index("ai_budget_policies_scope_idx").on(
      table.scope,
      table.projectId,
      table.monthKey,
      table.updatedAt,
    ),
  ],
);

export const aiGenerationRuns = sqliteTable(
  "ai_generation_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    baseVersionId: text("base_version_id")
      .notNull()
      .references(() => chapterVersions.id),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    state: text("state", {
      enum: [
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
      ],
    }).notNull(),
    revision: integer("revision").notNull(),
    attempt: integer("attempt").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    estimatedCostMicros: text("estimated_cost_micros").notNull(),
    incurredCostMicros: text("incurred_cost_micros").notNull(),
    costStatus: text("cost_status", {
      enum: ["estimated", "pricing_unavailable"],
    }).notNull(),
    currency: text("currency").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    priceUpdatedAt: text("price_updated_at").notNull(),
    preflightJson: text("preflight_json").notNull(),
    candidateId: text("candidate_id").references(() => aiCandidates.id, {
      onDelete: "set null",
    }),
    failureCode: text("failure_code"),
    cancelledAt: text("cancelled_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("ai_generation_revision", sql`${table.revision} >= 1`),
    check("ai_generation_attempt", sql`${table.attempt} BETWEEN 1 AND 100`),
    index("ai_generation_runs_project_created_idx").on(table.projectId, table.createdAt, table.id),
    index("ai_generation_runs_chapter_created_idx").on(table.chapterId, table.createdAt, table.id),
  ],
);

export const modelRoleRoutes = sqliteTable(
  "model_role_routes",
  {
    role: text("role", {
      enum: [
        "fast",
        "high_quality",
        "long_context",
        "embedding",
        "validation",
        "translation",
        "local_private",
      ],
    }).primaryKey(),
    primaryProviderId: text("primary_provider_id")
      .notNull()
      .references(() => modelProfiles.providerId, { onDelete: "restrict" }),
    primaryModelId: text("primary_model_id").notNull(),
    fallbackProviderId: text("fallback_provider_id").references(() => modelProfiles.providerId, {
      onDelete: "restrict",
    }),
    fallbackModelId: text("fallback_model_id"),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "model_role_routes_primary_model",
      sql`length(${table.primaryModelId}) BETWEEN 1 AND 512`,
    ),
    check("model_role_routes_revision", sql`${table.revision} >= 1`),
    index("model_role_routes_updated_idx").on(table.updatedAt, table.role),
  ],
);

export const aiGenerationRouteSelections = sqliteTable(
  "ai_generation_route_selections",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => aiGenerationRuns.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: [
        "fast",
        "high_quality",
        "long_context",
        "embedding",
        "validation",
        "translation",
        "local_private",
      ],
    }).notNull(),
    reason: text("reason", {
      enum: ["legacy_default", "role_primary", "role_fallback", "local_demo"],
    }).notNull(),
    fallbackProviderId: text("fallback_provider_id"),
    fallbackModelId: text("fallback_model_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("ai_generation_route_selections_role_idx").on(table.role, table.createdAt)],
);

export const aiGenerationAttemptUsage = sqliteTable(
  "ai_generation_attempt_usage",
  {
    runId: text("run_id")
      .notNull()
      .references(() => aiGenerationRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    usageSource: text("usage_source", {
      enum: [
        "provider_reported",
        "provider_reported_unpriced",
        "provider_unavailable",
        "local_demo",
      ],
    }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    usagePricedEstimateMicros: text("usage_priced_estimate_micros"),
    costStatus: text("cost_status", {
      enum: ["estimated", "pricing_unavailable"],
    }).notNull(),
    currency: text("currency").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    priceUpdatedAt: text("price_updated_at").notNull(),
    reportedAt: text("reported_at").notNull(),
    privacySnapshotVersion: integer("privacy_snapshot_version"),
    privacyPolicy: text("privacy_policy", {
      enum: ["local_only", "local_preferred", "cloud_allowed"],
    }),
    dataDestination: text("data_destination", {
      enum: ["local", "remote"],
    }),
    modelInvocationId: text("model_invocation_id"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.attempt] }),
    check("ai_generation_attempt_usage_attempt", sql`${table.attempt} BETWEEN 1 AND 100`),
    index("ai_generation_attempt_usage_reported_idx").on(
      table.reportedAt,
      table.runId,
      table.attempt,
    ),
  ],
);

export const aiDeferredGenerationRequests = sqliteTable(
  "ai_deferred_generation_requests",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    baseVersionId: text("base_version_id")
      .notNull()
      .references(() => chapterVersions.id),
    modelRole: text("model_role", {
      enum: [
        "fast",
        "high_quality",
        "long_context",
        "embedding",
        "validation",
        "translation",
        "local_private",
      ],
    }).notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    approvedInputTokens: integer("approved_input_tokens").notNull(),
    approvedEstimateMicros: text("approved_estimate_micros").notNull(),
    currency: text("currency").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    priceUpdatedAt: text("price_updated_at").notNull(),
    status: text("status", {
      enum: ["waiting_network", "blocked_stale", "cancelled", "consumed"],
    }).notNull(),
    revision: integer("revision").notNull(),
    consumedRunId: text("consumed_run_id").references(() => aiGenerationRuns.id, {
      onDelete: "set null",
    }),
    cancelledAt: text("cancelled_at"),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("ai_deferred_generation_revision", sql`${table.revision} >= 1`),
    index("ai_deferred_generation_chapter_idx").on(
      table.chapterId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("ai_deferred_generation_active_unique")
      .on(table.chapterId, table.modelRole)
      .where(sql`${table.status} = 'waiting_network'`),
  ],
);

export const searchIndexState = sqliteTable(
  "search_index_state",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    documentCount: integer("document_count").notNull().default(0),
    contentCharacters: integer("content_characters").notNull().default(0),
    indexedAt: text("indexed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("search_index_state_schema", sql`${table.schemaVersion} = 1`),
    check("search_index_state_revision", sql`${table.revision} >= 1`),
    check("search_index_state_document_count", sql`${table.documentCount} BETWEEN 0 AND 100000`),
    check(
      "search_index_state_content_characters",
      sql`${table.contentCharacters} BETWEEN 0 AND 64000000`,
    ),
    index("search_index_state_updated_idx").on(table.updatedAt, table.projectId),
  ],
);

export const searchIndexDocuments = sqliteTable(
  "search_index_documents",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => searchIndexState.projectId, { onDelete: "cascade" }),
    documentId: text("document_id").notNull(),
    sourceType: text("source_type", {
      enum: ["chapter", "outline", "character", "world", "foreshadow", "material", "memory"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    title: text("title").notNull(),
    searchText: text("search_text").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    normalizedSearchText: text("normalized_search_text").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    importance: real("importance").notNull().default(0),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    indexedAt: text("indexed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.documentId] }),
    check("search_index_documents_title", sql`length(trim(${table.title})) BETWEEN 1 AND 500`),
    check("search_index_documents_text", sql`length(${table.searchText}) <= 2000000`),
    check("search_index_documents_hash", sql`length(${table.contentHash}) = 64`),
    index("search_index_documents_source_idx").on(
      table.projectId,
      table.sourceType,
      table.sourceId,
      table.documentId,
    ),
    index("search_index_documents_version_idx").on(
      table.projectId,
      table.sourceVersionId,
      table.contentHash,
    ),
    index("search_index_documents_updated_idx").on(
      table.projectId,
      table.sourceUpdatedAt,
      table.documentId,
    ),
  ],
);

export const searchVectorIndexState = sqliteTable(
  "search_vector_index_state",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => searchIndexState.projectId, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    generation: integer("generation").notNull(),
    modelId: text("model_id").notNull(),
    dimension: integer("dimension").notNull(),
    status: text("status", {
      enum: ["ready", "rebuild_required", "degraded"],
    }).notNull(),
    lastRebuiltAt: text("last_rebuilt_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("search_vector_index_state_schema", sql`${table.schemaVersion} = 1`),
    check("search_vector_index_state_generation", sql`${table.generation} >= 1`),
    check("search_vector_index_state_model", sql`length(trim(${table.modelId})) BETWEEN 1 AND 256`),
    check("search_vector_index_state_dimension", sql`${table.dimension} BETWEEN 1 AND 4096`),
    index("search_vector_index_state_status_idx").on(
      table.status,
      table.updatedAt,
      table.projectId,
    ),
  ],
);

export const searchVectorEmbeddings = sqliteTable(
  "search_vector_embeddings",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => searchVectorIndexState.projectId, { onDelete: "cascade" }),
    documentId: text("document_id").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    contentHash: text("content_hash").notNull(),
    modelId: text("model_id").notNull(),
    dimension: integer("dimension").notNull(),
    vectorBlob: blob("vector_blob", { mode: "buffer" }).notNull(),
    vectorNorm: real("vector_norm").notNull(),
    indexedAt: text("indexed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.documentId] }),
    foreignKey({
      columns: [table.projectId, table.documentId],
      foreignColumns: [searchIndexDocuments.projectId, searchIndexDocuments.documentId],
    }).onDelete("cascade"),
    check(
      "search_vector_embeddings_source_version",
      sql`length(${table.sourceVersionId}) BETWEEN 1 AND 256`,
    ),
    check("search_vector_embeddings_hash", sql`length(${table.contentHash}) = 64`),
    check("search_vector_embeddings_dimension", sql`${table.dimension} BETWEEN 1 AND 4096`),
    check("search_vector_embeddings_norm", sql`${table.vectorNorm} > 0`),
    index("search_vector_embeddings_provenance_idx").on(
      table.projectId,
      table.modelId,
      table.sourceVersionId,
      table.contentHash,
      table.documentId,
    ),
  ],
);

export const graphRagProjectionState = sqliteTable(
  "graph_rag_projection_state",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    revision: integer("revision").notNull(),
    status: text("status", { enum: ["ready", "paused", "corrupt"] }).notNull(),
    sourceVersionCount: integer("source_version_count").notNull(),
    entityCount: integer("entity_count").notNull(),
    relationCount: integer("relation_count").notNull(),
    evidenceCount: integer("evidence_count").notNull(),
    lastRebuiltAt: text("last_rebuilt_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("graph_rag_projection_schema", sql`${table.schemaVersion} = 1`),
    check("graph_rag_projection_revision", sql`${table.revision} >= 1`),
    index("graph_rag_projection_state_status_idx").on(
      table.status,
      table.updatedAt,
      table.projectId,
    ),
  ],
);

export const authoritativeStoryGraphState = sqliteTable(
  "authoritative_story_graph_state",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    authorityEpoch: integer("authority_epoch").notNull().default(0),
    projectedEpoch: integer("projected_epoch"),
    projectedGraphRevision: integer("projected_graph_revision"),
    projectionComplete: integer("projection_complete", { mode: "boolean" }),
    diagnosticsJson: text("diagnostics_json"),
  },
  (table) => [
    check("authoritative_story_graph_schema", sql`${table.schemaVersion} = 1`),
    check(
      "authoritative_story_graph_authority_epoch",
      sql`${table.authorityEpoch} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "authoritative_story_graph_projected_epoch",
      sql`${table.projectedEpoch} IS NULL OR ${table.projectedEpoch} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "authoritative_story_graph_projected_revision",
      sql`${table.projectedGraphRevision} IS NULL OR ${table.projectedGraphRevision} >= 1`,
    ),
    check(
      "authoritative_story_graph_projection_complete",
      sql`${table.projectionComplete} IS NULL OR ${table.projectionComplete} IN (0, 1)`,
    ),
    check(
      "authoritative_story_graph_diagnostics_json",
      sql`${table.diagnosticsJson} IS NULL OR (json_valid(${table.diagnosticsJson}) AND json_type(${table.diagnosticsJson}) = 'object')`,
    ),
    check(
      "authoritative_story_graph_publication",
      sql`(
        (
          ${table.projectedEpoch} IS NULL
          AND ${table.projectedGraphRevision} IS NULL
          AND ${table.projectionComplete} IS NULL
          AND ${table.diagnosticsJson} IS NULL
        )
        OR (
          ${table.projectedEpoch} IS NOT NULL
          AND ${table.projectedGraphRevision} IS NOT NULL
          AND ${table.projectionComplete} IS NOT NULL
          AND ${table.diagnosticsJson} IS NOT NULL
          AND ${table.projectedEpoch} <= ${table.authorityEpoch}
        )
      )`,
    ),
    index("authoritative_story_graph_freshness_idx").on(
      table.projectId,
      table.authorityEpoch,
      table.projectedEpoch,
      table.projectedGraphRevision,
    ),
  ],
);

export const graphRagSourceVersions = sqliteTable(
  "graph_rag_source_versions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => graphRagProjectionState.projectId, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    state: text("state", { enum: ["current", "superseded", "deleted"] }).notNull(),
    createdAt: text("created_at").notNull(),
    invalidatedAt: text("invalidated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.sourceId, table.sourceVersionId] }),
    uniqueIndex("graph_rag_source_reference_unique").on(
      table.projectId,
      table.sourceId,
      table.sourceVersionId,
      table.contentHash,
    ),
    uniqueIndex("graph_rag_source_current_unique")
      .on(table.projectId, table.sourceId)
      .where(sql`${table.state} = 'current'`),
    index("graph_rag_source_versions_created_idx").on(
      table.projectId,
      table.sourceId,
      table.createdAt,
      table.sourceVersionId,
    ),
  ],
);

export const graphRagEntities = sqliteTable(
  "graph_rag_entities",
  {
    projectId: text("project_id").notNull(),
    entityId: text("entity_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    documentId: text("document_id"),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.entityId] }),
    foreignKey({
      columns: [table.projectId, table.sourceId, table.sourceVersionId, table.sourceContentHash],
      foreignColumns: [
        graphRagSourceVersions.projectId,
        graphRagSourceVersions.sourceId,
        graphRagSourceVersions.sourceVersionId,
        graphRagSourceVersions.contentHash,
      ],
    }).onDelete("cascade"),
    index("graph_rag_entities_source_idx").on(
      table.projectId,
      table.sourceId,
      table.sourceVersionId,
      table.entityId,
    ),
  ],
);

export const graphRagRelationIdentities = sqliteTable(
  "graph_rag_relation_identities",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => graphRagProjectionState.projectId, { onDelete: "cascade" }),
    relationId: text("relation_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    kind: text("kind").notNull(),
    polarity: text("polarity", { enum: ["affirmed", "negated"] }).notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.relationId] }),
    uniqueIndex("graph_rag_relation_identity_binding_unique").on(
      table.projectId,
      table.relationId,
      table.fromEntityId,
      table.toEntityId,
      table.kind,
      table.polarity,
    ),
  ],
);

export const graphRagRelations = sqliteTable(
  "graph_rag_relations",
  {
    projectId: text("project_id").notNull(),
    relationId: text("relation_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    kind: text("kind").notNull(),
    polarity: text("polarity", { enum: ["affirmed", "negated"] }).notNull(),
    confidence: real("confidence").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.relationId] }),
    foreignKey({
      columns: [table.projectId, table.fromEntityId],
      foreignColumns: [graphRagEntities.projectId, graphRagEntities.entityId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.toEntityId],
      foreignColumns: [graphRagEntities.projectId, graphRagEntities.entityId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.projectId,
        table.relationId,
        table.fromEntityId,
        table.toEntityId,
        table.kind,
        table.polarity,
      ],
      foreignColumns: [
        graphRagRelationIdentities.projectId,
        graphRagRelationIdentities.relationId,
        graphRagRelationIdentities.fromEntityId,
        graphRagRelationIdentities.toEntityId,
        graphRagRelationIdentities.kind,
        graphRagRelationIdentities.polarity,
      ],
    }).onDelete("cascade"),
    index("graph_rag_relations_outgoing_idx").on(
      table.projectId,
      table.fromEntityId,
      table.kind,
      table.confidence,
      table.relationId,
    ),
    index("graph_rag_relations_incoming_idx").on(
      table.projectId,
      table.toEntityId,
      table.kind,
      table.confidence,
      table.relationId,
    ),
  ],
);

export const graphRagRelationEvidence = sqliteTable(
  "graph_rag_relation_evidence",
  {
    projectId: text("project_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    relationId: text("relation_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    spanStartOffset: integer("span_start_offset").notNull(),
    spanEndOffset: integer("span_end_offset").notNull(),
    spanEncoding: text("span_encoding", { enum: ["utf16"] }).notNull(),
    quote: text("quote").notNull(),
    spanHash: text("span_hash").notNull(),
    citationLabel: text("citation_label").notNull(),
    citationLocator: text("citation_locator").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.evidenceId] }),
    uniqueIndex("graph_rag_evidence_ordinal_unique").on(
      table.projectId,
      table.relationId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.projectId, table.relationId],
      foreignColumns: [graphRagRelations.projectId, graphRagRelations.relationId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.sourceId, table.sourceVersionId, table.sourceContentHash],
      foreignColumns: [
        graphRagSourceVersions.projectId,
        graphRagSourceVersions.sourceId,
        graphRagSourceVersions.sourceVersionId,
        graphRagSourceVersions.contentHash,
      ],
    }).onDelete("cascade"),
    index("graph_rag_evidence_source_idx").on(
      table.projectId,
      table.sourceId,
      table.sourceVersionId,
      table.spanStartOffset,
      table.evidenceId,
    ),
  ],
);

export const multiAgentReviewSessions = sqliteTable(
  "multi_agent_review_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    restartOfSessionId: text("restart_of_session_id"),
    mode: text("mode", {
      enum: [
        "brainstorm",
        "outline_review",
        "character_review",
        "world_review",
        "commercial_review",
        "plot_planning",
      ],
    }).notNull(),
    targetKind: text("target_kind", { enum: ["chapter", "outline"] }).notNull(),
    chapterId: text("chapter_id").references(() => chapters.id, {
      onDelete: "cascade",
    }),
    baseVersionId: text("base_version_id").references(() => chapterVersions.id),
    baseOutlineRevision: integer("base_outline_revision"),
    baseAuthorityChecksum: text("base_authority_checksum").notNull(),
    userRequest: text("user_request").notNull(),
    status: text("status", {
      enum: ["idle", "running", "candidate_ready", "needs_input", "failed", "paused", "cancelled"],
    }).notNull(),
    revision: integer("revision").notNull(),
    attempt: integer("attempt").notNull(),
    maximumRounds: integer("maximum_rounds").notNull(),
    maximumTurns: integer("maximum_turns").notNull(),
    maximumInputTokens: integer("maximum_input_tokens").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    maximumCostMicros: integer("maximum_cost_micros").notNull(),
    maximumDurationMs: integer("maximum_duration_ms").notNull(),
    currency: text("currency").notNull(),
    cancellationRequested: integer("cancellation_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    failureCode: text("failure_code"),
    startedAt: text("started_at").notNull(),
    deadlineAt: text("deadline_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("multi_agent_sessions_project_idempotency_unique").on(
      table.projectId,
      table.idempotencyKey,
    ),
    index("multi_agent_sessions_project_history_idx").on(
      table.projectId,
      table.updatedAt,
      table.id,
    ),
    check("multi_agent_sessions_request_hash", sql`length(${table.requestFingerprint}) = 64`),
    check("multi_agent_sessions_authority_hash", sql`length(${table.baseAuthorityChecksum}) = 64`),
    check("multi_agent_sessions_revision", sql`${table.revision} >= 1`),
    check("multi_agent_sessions_attempt", sql`${table.attempt} BETWEEN 1 AND 1000`),
    check("multi_agent_sessions_rounds", sql`${table.maximumRounds} BETWEEN 1 AND 16`),
    check("multi_agent_sessions_turns", sql`${table.maximumTurns} BETWEEN 1 AND 128`),
  ],
);

export const multiAgentReviewParticipants = sqliteTable(
  "multi_agent_review_participants",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => multiAgentReviewSessions.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    role: text("role", {
      enum: ["planner", "drafter", "critic", "continuity_reviewer", "editor"],
    }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    status: text("status", {
      enum: ["idle", "working", "done", "needs_input", "error", "paused", "cancelled"],
    }).notNull(),
    providerId: text("provider_id").notNull(),
    providerKind: text("provider_kind", {
      enum: ["open_ai_compatible", "ollama"],
    }).notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    authentication: text("authentication", {
      enum: ["none", "bearer_keyring"],
    }).notNull(),
    providerProfileRevision: integer("provider_profile_revision").notNull(),
    modelId: text("model_id").notNull(),
    modelRevision: text("model_revision").notNull(),
    maximumTurns: integer("maximum_turns").notNull(),
    contextWindowTokens: integer("context_window_tokens").notNull(),
    inputMicrosPerMillionTokens: integer("input_micros_per_million_tokens").notNull(),
    outputMicrosPerMillionTokens: integer("output_micros_per_million_tokens").notNull(),
    cachedInputMicrosPerMillionTokens: integer("cached_input_micros_per_million_tokens"),
    pricingVersion: text("pricing_version").notNull(),
    priceUpdatedAt: text("price_updated_at").notNull(),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.participantId] }),
    uniqueIndex("multi_agent_participants_session_ordinal_unique").on(
      table.sessionId,
      table.ordinal,
    ),
    index("multi_agent_participants_session_status_idx").on(
      table.sessionId,
      table.enabled,
      table.status,
      table.ordinal,
    ),
  ],
);

export const multiAgentReviewTurns = sqliteTable(
  "multi_agent_review_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => multiAgentReviewSessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    attempt: integer("attempt").notNull(),
    participantId: text("participant_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    resultFingerprint: text("result_fingerprint"),
    generationId: text("generation_id").notNull(),
    runRevisionBefore: integer("run_revision_before").notNull(),
    status: text("status", {
      enum: ["working", "completed", "needs_input", "failed", "cancelled"],
    }).notNull(),
    reservationInputTokens: integer("reservation_input_tokens").notNull(),
    reservationOutputTokens: integer("reservation_output_tokens").notNull(),
    reservationCostMicros: integer("reservation_cost_micros").notNull(),
    publicMessage: text("public_message"),
    responseJson: text("response_json"),
    usageSource: text("usage_source", {
      enum: ["provider_reported", "provider_unavailable"],
    }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    costMicros: integer("cost_micros"),
    errorCode: text("error_code"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("multi_agent_turns_session_sequence_unique").on(table.sessionId, table.sequence),
    uniqueIndex("multi_agent_turns_session_idempotency_unique").on(
      table.sessionId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.sessionId, table.participantId],
      foreignColumns: [
        multiAgentReviewParticipants.sessionId,
        multiAgentReviewParticipants.participantId,
      ],
    }).onDelete("cascade"),
    index("multi_agent_turns_session_history_idx").on(table.sessionId, table.sequence, table.id),
  ],
);

export const multiAgentReviewConclusions = sqliteTable(
  "multi_agent_review_conclusions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id")
      .notNull()
      .references(() => multiAgentReviewTurns.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    category: text("category", {
      enum: [
        "must_change",
        "suggested_change",
        "optional_enhancement",
        "disputed_opinion",
        "convertible_task",
      ],
    }).notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    taskProposalJson: text("task_proposal_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("multi_agent_conclusions_turn_ordinal_unique").on(
      table.sessionId,
      table.turnId,
      table.ordinal,
    ),
    index("multi_agent_conclusions_session_category_idx").on(
      table.sessionId,
      table.category,
      table.turnId,
      table.ordinal,
    ),
  ],
);

export const multiAgentReviewSourceReferences = sqliteTable(
  "multi_agent_review_source_references",
  {
    conclusionId: text("conclusion_id")
      .notNull()
      .references(() => multiAgentReviewConclusions.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind", {
      enum: ["chapter", "outline_node", "material", "project_rule", "turn"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceVersionId: text("source_version_id"),
    sourceChecksum: text("source_checksum").notNull(),
    modelLabel: text("model_label").notNull(),
    authoritativeLabel: text("authoritative_label").notNull(),
    excerpt: text("excerpt"),
  },
  (table) => [
    primaryKey({ columns: [table.conclusionId, table.ordinal] }),
    index("multi_agent_source_refs_source_idx").on(
      table.kind,
      table.sourceId,
      table.conclusionId,
      table.ordinal,
    ),
  ],
);

export const multiAgentReviewCandidates = sqliteTable(
  "multi_agent_review_candidates",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .unique()
      .references(() => multiAgentReviewSessions.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: ["chapter", "outline"] }).notNull(),
    chapterCandidateId: text("chapter_candidate_id")
      .unique()
      .references(() => aiCandidates.id, { onDelete: "no action" }),
    baseVersionId: text("base_version_id").references(() => chapterVersions.id),
    baseOutlineRevision: integer("base_outline_revision"),
    payloadJson: text("payload_json").notNull(),
    payloadChecksum: text("payload_checksum").notNull(),
    status: text("status", {
      enum: ["ready", "accepted", "rejected", "expired"],
    }).notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    decidedAt: text("decided_at"),
    acceptedOutlineSnapshotJson: text("accepted_outline_snapshot_json"),
    acceptedOutlineRevision: integer("accepted_outline_revision"),
  },
  (table) => [
    index("multi_agent_candidates_project_status_idx").on(
      table.projectId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    check("multi_agent_candidates_payload_hash", sql`length(${table.payloadChecksum}) = 64`),
    check(
      "multi_agent_candidates_revision_bounds",
      sql`${table.revision} BETWEEN 1 AND 9007199254740991`,
    ),
  ],
);

export const governedExtensionEgressReceipts = sqliteTable(
  "governed_extension_egress_receipts",
  {
    receiptDigest: text("receipt_digest").primaryKey(),
    kind: text("kind", { enum: ["translation", "short_drama"] }).notNull(),
    providerId: text("provider_id").notNull(),
    baseUrl: text("base_url").notNull(),
    modelId: text("model_id").notNull(),
    dataCategoriesJson: text("data_categories_json").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => chapterVersions.id, { onDelete: "restrict" }),
    priceVersion: text("price_version").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    // The SQL migration intentionally owns this non-FK link so restore and
    // project deletion do not create a receipt/request dependency cycle.
    requestId: text("request_id"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (table) => [
    index("governed_extension_receipts_expiry_idx").on(table.expiresAt, table.consumedAt),
    check(
      "governed_extension_receipts_digest",
      sql`length(${table.receiptDigest}) = 64 AND ${table.receiptDigest} = lower(${table.receiptDigest})`,
    ),
    check(
      "governed_extension_receipts_fingerprint",
      sql`length(${table.requestFingerprint}) = 64 AND length(${table.scopeFingerprint}) = 64`,
    ),
  ],
);

export const governedExtensionBudgets = sqliteTable(
  "governed_extension_budgets",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    monthKey: text("month_key").notNull(),
    currency: text("currency").notNull(),
    limitMicros: integer("limit_micros").notNull(),
    spentMicros: integer("spent_micros").notNull().default(0),
    reservedMicros: integer("reserved_micros").notNull().default(0),
    activeRequests: integer("active_requests").notNull().default(0),
    maximumConcurrent: integer("maximum_concurrent").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.monthKey] }),
    check(
      "governed_extension_budgets_amounts",
      sql`${table.limitMicros} >= 0 AND ${table.spentMicros} >= 0 AND ${table.reservedMicros} >= 0`,
    ),
    check(
      "governed_extension_budgets_concurrency",
      sql`${table.activeRequests} BETWEEN 0 AND 1000 AND ${table.maximumConcurrent} BETWEEN 1 AND 1000`,
    ),
  ],
);

export const governedExtensionRequests = sqliteTable(
  "governed_extension_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => chapterVersions.id, { onDelete: "restrict" }),
    sourceChecksum: text("source_checksum").notNull(),
    kind: text("kind", { enum: ["translation", "short_drama"] }).notNull(),
    attempt: integer("attempt").notNull(),
    retryOfRequestId: text("retry_of_request_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    requestSnapshotJson: text("request_snapshot_json").notNull(),
    providerLocation: text("provider_location", { enum: ["loopback", "remote"] }).notNull(),
    providerId: text("provider_id").notNull(),
    baseUrl: text("base_url").notNull(),
    modelId: text("model_id").notNull(),
    dataCategoriesJson: text("data_categories_json").notNull(),
    inputMicrosPerMillionTokens: integer("input_micros_per_million_tokens").notNull(),
    outputMicrosPerMillionTokens: integer("output_micros_per_million_tokens").notNull(),
    currency: text("currency").notNull(),
    priceVersion: text("price_version").notNull(),
    priceUpdatedAt: text("price_updated_at").notNull(),
    maximumInputTokens: integer("maximum_input_tokens").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    reservedCostMicros: integer("reserved_cost_micros").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    receiptDigest: text("receipt_digest").references(
      () => governedExtensionEgressReceipts.receiptDigest,
      { onDelete: "restrict" },
    ),
    status: text("status", {
      enum: ["running", "candidate_ready", "cancelled", "failed_retryable", "failed_final"],
    }).notNull(),
    revision: integer("revision").notNull().default(1),
    // SQL owns the deferred FK to governed_extension_candidates. Leaving the
    // Drizzle field unreferenced avoids a circular schema initializer.
    candidateId: text("candidate_id"),
    usageSource: text("usage_source", {
      enum: ["provider_reported", "provider_unavailable"],
    }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    calculatedCostMicros: integer("calculated_cost_micros"),
    providerReceiptDigest: text("provider_receipt_digest"),
    cancellationRequested: integer("cancellation_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    errorCode: text("error_code"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("governed_extension_requests_idempotency_unique").on(
      table.projectId,
      table.kind,
      table.idempotencyKey,
    ),
    index("governed_extension_requests_history_idx").on(
      table.projectId,
      table.kind,
      table.createdAt,
      table.id,
    ),
    index("governed_extension_requests_recovery_idx").on(table.status, table.updatedAt, table.id),
    check("governed_extension_requests_source_hash", sql`length(${table.sourceChecksum}) = 64`),
    check("governed_extension_requests_attempt", sql`${table.attempt} BETWEEN 1 AND 100`),
    check(
      "governed_extension_requests_token_caps",
      sql`${table.maximumInputTokens} BETWEEN 1 AND 10000000 AND ${table.maximumOutputTokens} BETWEEN 1 AND 10000000`,
    ),
  ],
);

export const governedExtensionCandidates = sqliteTable(
  "governed_extension_candidates",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .unique()
      .references(() => governedExtensionRequests.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => chapterVersions.id, { onDelete: "restrict" }),
    sourceChecksum: text("source_checksum").notNull(),
    kind: text("kind", { enum: ["translation", "short_drama"] }).notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadChecksum: text("payload_checksum").notNull(),
    status: text("status", { enum: ["ready", "accepted", "rejected", "expired"] }).notNull(),
    revision: integer("revision").notNull().default(1),
    formalOutputId: text("formal_output_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [
    index("governed_extension_candidates_history_idx").on(
      table.projectId,
      table.kind,
      table.status,
      table.updatedAt,
      table.id,
    ),
    check("governed_extension_candidates_source_hash", sql`length(${table.sourceChecksum}) = 64`),
    check("governed_extension_candidates_payload_hash", sql`length(${table.payloadChecksum}) = 64`),
  ],
);

export const governedExtensionAuditEvents = sqliteTable(
  "governed_extension_audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    entityType: text("entity_type", {
      enum: ["request", "receipt", "candidate", "budget"],
    }).notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action", {
      enum: [
        "receipt_issued",
        "request_started",
        "request_replayed",
        "request_cancelled",
        "request_failed",
        "candidate_published",
        "candidate_accept",
        "candidate_reject",
        "candidate_expire",
        "reservation_recovered",
      ],
    }).notNull(),
    correlationId: text("correlation_id").notNull(),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    baseUrlDigest: text("base_url_digest"),
    requestFingerprint: text("request_fingerprint"),
    errorCode: text("error_code"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("governed_extension_audit_entity_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const chapterTranslations = sqliteTable(
  "chapter_translations",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .unique()
      .references(() => governedExtensionCandidates.id, { onDelete: "restrict" }),
    acceptAuditEventId: text("accept_audit_event_id")
      .notNull()
      .unique()
      .references(() => governedExtensionAuditEvents.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => chapterVersions.id, { onDelete: "restrict" }),
    sourceChecksum: text("source_checksum").notNull(),
    targetLanguageCode: text("target_language_code").notNull(),
    targetLanguageLabel: text("target_language_label").notNull(),
    tone: text("tone").notNull(),
    glossaryVersion: text("glossary_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("chapter_translations_chapter_idx").on(
      table.chapterId,
      table.targetLanguageCode,
      table.createdAt,
      table.id,
    ),
  ],
);

export const shortDramaScripts = sqliteTable(
  "short_drama_scripts",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .unique()
      .references(() => governedExtensionCandidates.id, { onDelete: "restrict" }),
    acceptAuditEventId: text("accept_audit_event_id")
      .notNull()
      .unique()
      .references(() => governedExtensionAuditEvents.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => chapterVersions.id, { onDelete: "restrict" }),
    sourceChecksum: text("source_checksum").notNull(),
    title: text("title").notNull(),
    format: text("format", {
      enum: ["vertical_micro_drama", "standard_short_drama"],
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("short_drama_scripts_chapter_idx").on(table.chapterId, table.createdAt, table.id),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProjectDisplayIdentityRow = typeof projectDisplayIdentities.$inferSelect;
export type NewProjectDisplayIdentityRow = typeof projectDisplayIdentities.$inferInsert;
export type ProjectDisplayIdentityRevisionRow = typeof projectDisplayIdentityRevisions.$inferSelect;
export type NewProjectDisplayIdentityRevisionRow =
  typeof projectDisplayIdentityRevisions.$inferInsert;
export type ProjectSeedRow = typeof projectSeeds.$inferSelect;
export type NewProjectSeedRow = typeof projectSeeds.$inferInsert;
export type StorySettingsImportReceiptRow = typeof storySettingsImportReceipts.$inferSelect;
export type NewStorySettingsImportReceiptRow = typeof storySettingsImportReceipts.$inferInsert;
export type ChapterRow = typeof chapters.$inferSelect;
export type NewChapterRow = typeof chapters.$inferInsert;
export type ChapterVersionRow = typeof chapterVersions.$inferSelect;
export type NewChapterVersionRow = typeof chapterVersions.$inferInsert;
export type ChapterValidationSnapshotRow = typeof chapterValidationSnapshots.$inferSelect;
export type NewChapterValidationSnapshotRow = typeof chapterValidationSnapshots.$inferInsert;
export type RecoveryDraftRow = typeof recoveryDrafts.$inferSelect;
export type AuthorRecoveryRecordRow = typeof authorRecoveryRecords.$inferSelect;
export type AiCandidateRow = typeof aiCandidates.$inferSelect;
export type ModelProfileRow = typeof modelProfiles.$inferSelect;
export type ModelPricingProfileRow = typeof modelPricingProfiles.$inferSelect;
export type AiBudgetPolicyRow = typeof aiBudgetPolicies.$inferSelect;
export type AiGenerationRunRow = typeof aiGenerationRuns.$inferSelect;
export type ModelRoleRouteRow = typeof modelRoleRoutes.$inferSelect;
export type AiGenerationRouteSelectionRow = typeof aiGenerationRouteSelections.$inferSelect;
export type AiGenerationAttemptUsageRow = typeof aiGenerationAttemptUsage.$inferSelect;
export type AiDeferredGenerationRequestRow = typeof aiDeferredGenerationRequests.$inferSelect;
export type SearchIndexStateRow = typeof searchIndexState.$inferSelect;
export type SearchIndexDocumentRow = typeof searchIndexDocuments.$inferSelect;
export type SearchVectorIndexStateRow = typeof searchVectorIndexState.$inferSelect;
export type SearchVectorEmbeddingRow = typeof searchVectorEmbeddings.$inferSelect;
export type GraphRagProjectionStateRow = typeof graphRagProjectionState.$inferSelect;
export type AuthoritativeStoryGraphStateRow = typeof authoritativeStoryGraphState.$inferSelect;
export type GraphRagSourceVersionRow = typeof graphRagSourceVersions.$inferSelect;
export type GraphRagEntityRow = typeof graphRagEntities.$inferSelect;
export type GraphRagRelationIdentityRow = typeof graphRagRelationIdentities.$inferSelect;
export type GraphRagRelationRow = typeof graphRagRelations.$inferSelect;
export type GraphRagRelationEvidenceRow = typeof graphRagRelationEvidence.$inferSelect;
export type MultiAgentReviewSessionRow = typeof multiAgentReviewSessions.$inferSelect;
export type MultiAgentReviewParticipantRow = typeof multiAgentReviewParticipants.$inferSelect;
export type MultiAgentReviewTurnRow = typeof multiAgentReviewTurns.$inferSelect;
export type MultiAgentReviewConclusionRow = typeof multiAgentReviewConclusions.$inferSelect;
export type MultiAgentReviewSourceReferenceRow =
  typeof multiAgentReviewSourceReferences.$inferSelect;
export type MultiAgentReviewCandidateRow = typeof multiAgentReviewCandidates.$inferSelect;
export type GovernedExtensionEgressReceiptRow = typeof governedExtensionEgressReceipts.$inferSelect;
export type NewGovernedExtensionEgressReceiptRow =
  typeof governedExtensionEgressReceipts.$inferInsert;
export type GovernedExtensionBudgetRow = typeof governedExtensionBudgets.$inferSelect;
export type NewGovernedExtensionBudgetRow = typeof governedExtensionBudgets.$inferInsert;
export type GovernedExtensionRequestRow = typeof governedExtensionRequests.$inferSelect;
export type NewGovernedExtensionRequestRow = typeof governedExtensionRequests.$inferInsert;
export type GovernedExtensionCandidateRow = typeof governedExtensionCandidates.$inferSelect;
export type NewGovernedExtensionCandidateRow = typeof governedExtensionCandidates.$inferInsert;
export type GovernedExtensionAuditEventRow = typeof governedExtensionAuditEvents.$inferSelect;
export type NewGovernedExtensionAuditEventRow = typeof governedExtensionAuditEvents.$inferInsert;
export type ChapterTranslationRow = typeof chapterTranslations.$inferSelect;
export type NewChapterTranslationRow = typeof chapterTranslations.$inferInsert;
export type ShortDramaScriptRow = typeof shortDramaScripts.$inferSelect;
export type NewShortDramaScriptRow = typeof shortDramaScripts.$inferInsert;
