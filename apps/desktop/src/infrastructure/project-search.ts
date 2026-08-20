import type { ChapterRepository, ContentHasher, ProjectRepository } from "@inkshadow/application";
import {
  AppError,
  err,
  ok,
  type Chapter,
  type Clock,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import type {
  EmbeddingConfiguration,
  HybridSearchResponse,
  InMemoryHybridSearchIndex,
  SearchChunkKind,
  SearchDocument,
  SearchHealth,
  SearchIndexErrorCode,
  SearchRetrievalScope,
} from "@inkshadow/search-core";
import {
  parseUuidV7 as parseStoryUuidV7,
  type OutlineRepository,
  type OutlineSnapshot,
  type StoryFact,
  type StoryFactSnapshot,
  type StoryFactStore,
} from "@inkshadow/story-core";

import {
  ProjectSearchSnapshotStoreError,
  defaultProjectSearchRetrievalScope,
  type ProjectSearchSnapshot,
  type ProjectSearchSnapshotStore,
  type ProjectSearchSynchronization,
} from "./project-search-store";
import {
  ProjectEmbeddingServiceError,
  type ProjectEmbeddingDiagnostics,
  type ProjectSearchVectorService,
  type ProjectVectorLoad,
  type QueryEmbeddingOutcome,
} from "./project-search-vector-service";

const MAX_SEARCH_DOCUMENT_UTF8_BYTES = 48 * 1024;
const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_SEARCH_RESULTS = 100;
const COLD_SEARCH_HEALTH: SearchHealth = Object.freeze({
  generation: 0,
  mutationStatus: "ready",
  vectorStatus: "disabled",
  documentCount: 0,
  embeddingCount: 0,
  relationCount: 0,
  degradedReasons: Object.freeze([]),
});

export interface ProjectSearchSynchronizationDiagnostics {
  readonly projectId: string;
  readonly snapshotRevision: number;
  readonly documentCount: number;
  readonly upsertedCount: number;
  readonly deletedCount: number;
  readonly unchangedCount: number;
  readonly reusedSourceCount: number;
  readonly hashedDocumentCount: number;
  readonly integrityHashedDocumentCount: number;
  readonly recoveredFromIntegrityMismatch: boolean;
  readonly recoveredFromCorruption: boolean;
  readonly forced: boolean;
  readonly changed: boolean;
  readonly synchronizedAt: string;
  readonly storyFactEvidenceCount: number;
  readonly projectionOmissions: readonly ProjectSearchProjectionOmission[];
}

export const PROJECT_SEARCH_PROJECTION_OMISSION_REASONS = [
  "story_fact_source_unavailable",
  "story_fact_not_confirmed_current_canon",
  "story_fact_source_not_exact_chapter_span",
  "story_fact_source_chapter_missing",
  "story_fact_source_version_not_current",
  "story_fact_source_span_invalid",
  "story_fact_source_excerpt_mismatch",
] as const;

export type ProjectSearchProjectionOmissionReason =
  (typeof PROJECT_SEARCH_PROJECTION_OMISSION_REASONS)[number];

export interface ProjectSearchProjectionOmission {
  readonly sourceType: "story_fact_evidence";
  readonly sourceId: string | null;
  readonly reason: ProjectSearchProjectionOmissionReason;
}

export interface ProjectSearchService {
  rebuildProject(projectId: UuidV7): Promise<Result<SearchHealth, AppError>>;
  rebuildVectorProject(
    projectId: UuidV7,
    confirmationId: string | null,
  ): Promise<Result<SearchHealth, AppError>>;
  disableVectorProject(projectId: UuidV7): Promise<Result<SearchHealth, AppError>>;
  inspectEmbedding(projectId: UuidV7): Promise<Result<ProjectEmbeddingDiagnostics, AppError>>;
  search(
    projectId: UuidV7,
    query: string,
    limit?: number,
    scope?: SearchRetrievalScope,
  ): Promise<Result<HybridSearchResponse, AppError>>;
  searchFtsOnly(
    projectId: UuidV7,
    query: string,
    scope: SearchRetrievalScope,
    limit?: number,
  ): Promise<Result<HybridSearchResponse, AppError>>;
  health(): SearchHealth;
  embeddingDiagnostics(): ProjectEmbeddingDiagnostics;
  synchronizationDiagnostics(): ProjectSearchSynchronizationDiagnostics | null;
}

export interface LocalProjectSearchDependencies {
  readonly projects: ProjectRepository;
  readonly chapters: ChapterRepository;
  readonly outlines: OutlineRepository;
  readonly storyFacts: Pick<StoryFactStore, "listByProjectId">;
  readonly snapshots: ProjectSearchSnapshotStore;
  readonly hasher: ContentHasher;
  readonly clock: Clock;
  readonly vectors?: ProjectSearchVectorService;
}

interface DocumentBuildResult {
  readonly documents: readonly SearchDocument[];
  readonly reusedSourceCount: number;
  readonly hashedDocumentCount: number;
  readonly integrityHashedDocumentCount: number;
  readonly integrityMismatch: boolean;
  readonly omissions: readonly ProjectSearchProjectionOmission[];
}

interface SearchTextSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface ChapterProjectionUnit extends SearchTextSpan {
  readonly id: string;
  readonly title: string;
  readonly chunkKind: SearchChunkKind;
  readonly parentDocumentId: string | null;
  readonly sceneId: string | null;
  readonly eventId: string | null;
}

type StoryFactEvidenceResolution =
  | Readonly<{
      ok: true;
      snapshot: StoryFactSnapshot;
      chapter: Chapter;
      storyOrder: number;
      start: number;
      end: number;
    }>
  | Readonly<{
      ok: false;
      sourceId: string;
      reason: ProjectSearchProjectionOmissionReason;
    }>;

interface SynchronizationOutcome {
  readonly health: SearchHealth;
  readonly recoveredFromCorruption: boolean;
  readonly snapshot: ProjectSearchSnapshot;
  readonly projectionOmissions: readonly ProjectSearchProjectionOmission[];
}

export class LocalProjectSearchService implements ProjectSearchService {
  private index: InMemoryHybridSearchIndex | null = null;
  private indexPromise: Promise<InMemoryHybridSearchIndex> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly loadedProjects = new Set<string>();
  private readonly loadedVectorMarkers = new Map<string, string>();
  private readonly vectorLoads = new Map<string, ProjectVectorLoad>();
  private readonly verifiedDocumentIntegrity = new Map<string, ReadonlyMap<string, string>>();
  private lastDiagnostics: ProjectSearchSynchronizationDiagnostics | null = null;
  private lastVectorFailureCode: string | null = null;

  public constructor(private readonly dependencies: LocalProjectSearchDependencies) {}

  public rebuildProject(projectId: UuidV7): Promise<Result<SearchHealth, AppError>> {
    return this.runExclusive(async () => {
      const synchronized = await this.synchronizeProjectUnlocked(projectId, true);
      return synchronized.ok ? ok(synchronized.value.health) : synchronized;
    });
  }

  public rebuildVectorProject(
    projectId: UuidV7,
    confirmationId: string | null,
  ): Promise<Result<SearchHealth, AppError>> {
    return this.runExclusive(async () => {
      if (this.dependencies.vectors === undefined) {
        return err(
          new AppError({
            code: "REPOSITORY_ERROR",
            message: "Persistent embedding search is unavailable in this runtime.",
            details: { sourceCode: "MODEL_NATIVE_GATEWAY_UNAVAILABLE" },
          }),
        );
      }
      const synchronized = await this.synchronizeProjectUnlocked(projectId, false);
      if (!synchronized.ok) {
        return synchronized;
      }
      try {
        const vectorLoad = await this.dependencies.vectors.rebuildProject(
          projectId,
          synchronized.value.snapshot.documents,
          confirmationId,
        );
        const health = await this.applySynchronization(
          {
            snapshot: synchronized.value.snapshot,
            changed: false,
            upsertedDocuments: [],
            deletedDocumentIds: [],
            unchangedCount: synchronized.value.snapshot.documents.length,
          },
          true,
          vectorLoad,
        );
        return ok(health);
      } catch (cause: unknown) {
        return err(toSearchAppError(cause));
      }
    });
  }

  public disableVectorProject(projectId: UuidV7): Promise<Result<SearchHealth, AppError>> {
    return this.runExclusive(async () => {
      if (this.dependencies.vectors === undefined) {
        return ok(this.health());
      }
      const synchronized = await this.synchronizeProjectUnlocked(projectId, false);
      if (!synchronized.ok) {
        return synchronized;
      }
      try {
        await this.dependencies.vectors.resetProject(projectId);
        this.vectorLoads.delete(projectId);
        this.loadedVectorMarkers.delete(projectId);
        const disabled = await this.dependencies.vectors.synchronizeProject(
          projectId,
          synchronized.value.snapshot.documents,
          false,
        );
        const health = await this.applySynchronization(
          {
            snapshot: synchronized.value.snapshot,
            changed: false,
            upsertedDocuments: [],
            deletedDocumentIds: [],
            unchangedCount: synchronized.value.snapshot.documents.length,
          },
          true,
          disabled,
        );
        return ok(health);
      } catch (cause: unknown) {
        return err(toSearchAppError(cause));
      }
    });
  }

  public inspectEmbedding(
    projectId: UuidV7,
  ): Promise<Result<ProjectEmbeddingDiagnostics, AppError>> {
    return this.runExclusive(async () => {
      const synchronized = await this.synchronizeProjectUnlocked(projectId, false);
      if (!synchronized.ok) {
        return synchronized;
      }
      return ok(this.embeddingDiagnostics());
    });
  }

  public search(
    projectId: UuidV7,
    query: string,
    limit = 20,
    scope: SearchRetrievalScope = defaultProjectSearchRetrievalScope(projectId),
  ): Promise<Result<HybridSearchResponse, AppError>> {
    if (!isValidSearchQuery(query) || !isValidSearchLimit(limit) || scope.projectId !== projectId) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VALIDATION_FAILED",
            message: "The local search query or result limit is invalid.",
          }),
        ),
      );
    }
    if (scope.taskType !== "project_search") {
      return this.searchFtsOnly(projectId, query, scope, limit);
    }

    return this.runExclusive(async () => {
      const synchronized = await this.synchronizeProjectUnlocked(projectId, false);
      if (!synchronized.ok) {
        return synchronized;
      }

      try {
        const keywordCandidates = await this.dependencies.snapshots.findKeywordCandidates(
          projectId,
          query,
          scope,
        );
        const index = await this.getIndex();
        const vectorLoad = this.vectorLoads.get(projectId);
        let vectorQuery: QueryEmbeddingOutcome | null = null;
        if (this.dependencies.vectors !== undefined && vectorLoad !== undefined) {
          try {
            vectorQuery = await this.dependencies.vectors.embedQuery(vectorLoad, query);
          } catch (cause: unknown) {
            // FTS/keyword retrieval is the baseline. A missing Ollama process,
            // stale embedding route or query-vector failure only removes the
            // optional vector score; it must not erase locally indexed hits.
            this.lastVectorFailureCode = safeErrorCode(cause, "QUERY_EMBEDDING_FAILED");
          }
        }
        const queryEmbedding = vectorQuery?.embedding ?? null;
        if (vectorQuery !== null && vectorLoad !== undefined) {
          this.vectorLoads.set(projectId, {
            ...vectorLoad,
            diagnostics: vectorQuery.diagnostics,
          });
        }
        const response = index.search({
          projectId,
          query,
          limit,
          ...(queryEmbedding === null ? {} : { queryEmbedding }),
          ...(keywordCandidates.documentIds === null
            ? {}
            : { candidateDocumentIds: keywordCandidates.documentIds }),
        });
        const notices = [...response.notices];
        if (vectorQuery?.notice !== null && vectorQuery?.notice !== undefined) {
          notices.push(vectorQuery.notice);
        }
        if (this.lastVectorFailureCode !== null) {
          notices.push(
            `vector_service_${this.lastVectorFailureCode.toLowerCase()}_keyword_relation_fallback`,
          );
        }
        if (synchronized.value.recoveredFromCorruption) {
          notices.push("persistent_index_recovered_from_authoritative_sources");
        }
        if (synchronized.value.projectionOmissions.length > 0) {
          notices.push(
            `retrieval_projection_omitted_${[
              ...new Set(synchronized.value.projectionOmissions.map(({ reason }) => reason)),
            ].join("_")}`,
          );
        }
        if (keywordCandidates.recovered) {
          notices.push("persistent_fts5_rebuilt_from_search_documents");
        }
        if (keywordCandidates.degraded) {
          notices.push("persistent_fts5_unavailable_scope_failed_closed");
        }
        if (keywordCandidates.scopeTrace.omittedHardFilters.length > 0) {
          notices.push(
            `retrieval_scope_omitted_${keywordCandidates.scopeTrace.omittedHardFilters.join("_")}`,
          );
        }
        if (keywordCandidates.scopeTrace.authorityNeutralOmissions.length > 0) {
          notices.push(
            `retrieval_scope_authority_neutral_${keywordCandidates.scopeTrace.authorityNeutralOmissions.join("_")}`,
          );
        }
        const embeddingDiagnostics =
          this.lastVectorFailureCode === null
            ? (vectorQuery?.diagnostics ?? vectorLoad?.diagnostics ?? this.embeddingDiagnostics())
            : this.embeddingDiagnostics();
        return ok({
          ...response,
          retrievalScopeTrace: keywordCandidates.scopeTrace,
          health: mergeVectorHealth(response.health, embeddingDiagnostics),
          capabilities: {
            ...response.capabilities,
            vector: embeddingDiagnostics.status,
          },
          notices: [...new Set(notices)],
        });
      } catch (cause: unknown) {
        return err(toSearchAppError(cause));
      }
    });
  }

  public searchFtsOnly(
    projectId: UuidV7,
    query: string,
    scope: SearchRetrievalScope,
    limit = 20,
  ): Promise<Result<HybridSearchResponse, AppError>> {
    if (!isValidSearchQuery(query) || !isValidSearchLimit(limit) || scope.projectId !== projectId) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VALIDATION_FAILED",
            message: "The read-only FTS request or retrieval scope is invalid.",
          }),
        ),
      );
    }

    return this.runExclusive(async () => {
      const projectResult = await this.dependencies.projects.findById(projectId);
      if (!projectResult.ok) {
        return projectResult;
      }
      if (projectResult.value === null || projectResult.value.status === "trashed") {
        return err(
          new AppError({
            code: projectResult.value === null ? "PROJECT_NOT_FOUND" : "PROJECT_DELETED",
            message:
              projectResult.value === null
                ? "The project does not exist."
                : "The project is in the trash and cannot be searched.",
          }),
        );
      }

      try {
        const snapshot = await this.dependencies.snapshots.loadProject(projectId);
        if (snapshot === null) {
          return err(
            new AppError({
              code: "REPOSITORY_ERROR",
              message: "The authoritative local FTS snapshot has not been prepared.",
              retryable: true,
              actions: ["RETRY"],
              details: { sourceCode: "SEARCH_SNAPSHOT_REQUIRED" },
            }),
          );
        }
        const candidates = await this.dependencies.snapshots.findKeywordCandidates(
          projectId,
          query,
          scope,
        );
        const { InMemoryHybridSearchIndex: SearchIndex } = await import("@inkshadow/search-core");
        const index = new SearchIndex();
        index.rebuildProject(
          {
            projectId,
            documents: snapshot.documents,
            rebuiltAt: snapshot.indexedAt,
          },
          index.health().generation,
        );
        const response = index.search({
          projectId,
          query,
          limit,
          candidateDocumentIds: candidates.documentIds ?? Object.freeze([]),
        });
        const { embeddingConfiguration: _embeddingConfiguration, ...ftsHealth } = response.health;
        void _embeddingConfiguration;
        return ok({
          ...response,
          retrievalScopeTrace: candidates.scopeTrace,
          health: {
            ...ftsHealth,
            vectorStatus: "disabled",
            embeddingCount: 0,
          },
          capabilities: { ...response.capabilities, vector: "disabled" },
          notices: [
            ...response.notices,
            "fts_only_read_only_no_embedding_or_gateway",
            ...(candidates.degraded ? ["persistent_fts5_unavailable_scope_failed_closed"] : []),
            ...(candidates.scopeTrace.omittedHardFilters.length === 0
              ? []
              : [`retrieval_scope_omitted_${candidates.scopeTrace.omittedHardFilters.join("_")}`]),
            ...(candidates.scopeTrace.authorityNeutralOmissions.length === 0
              ? []
              : [
                  `retrieval_scope_authority_neutral_${candidates.scopeTrace.authorityNeutralOmissions.join("_")}`,
                ]),
          ],
        });
      } catch (cause: unknown) {
        return err(toSearchAppError(cause));
      }
    });
  }

  public health(): SearchHealth {
    return mergeVectorHealth(
      this.index?.health() ?? COLD_SEARCH_HEALTH,
      this.embeddingDiagnostics(),
    );
  }

  public embeddingDiagnostics(): ProjectEmbeddingDiagnostics {
    if (this.lastVectorFailureCode !== null) {
      return {
        ...EMPTY_EMBEDDING_DIAGNOSTICS,
        status: "degraded",
        reason: "vector_store_unavailable",
        queryFailureCode: this.lastVectorFailureCode,
      };
    }
    return this.dependencies.vectors?.diagnostics() ?? EMPTY_EMBEDDING_DIAGNOSTICS;
  }

  public synchronizationDiagnostics(): ProjectSearchSynchronizationDiagnostics | null {
    return this.lastDiagnostics === null ? null : { ...this.lastDiagnostics };
  }

  private async synchronizeProjectUnlocked(
    projectId: UuidV7,
    force: boolean,
  ): Promise<Result<SynchronizationOutcome, AppError>> {
    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) {
      return err(
        new AppError({
          code: "INVALID_UUID",
          message: "The project identifier cannot be used by the story index.",
        }),
      );
    }
    const [projectResult, chaptersResult, outlineResult, storyFactsResult] = await Promise.all([
      this.dependencies.projects.findById(projectId),
      this.dependencies.chapters.listByProjectId(projectId),
      this.dependencies.outlines.findByProjectId(storyProjectId.value),
      this.dependencies.storyFacts.listByProjectId(storyProjectId.value),
    ]);
    if (!projectResult.ok) {
      return projectResult;
    }
    if (projectResult.value === null) {
      await this.resetMissingOrDeletedProject(projectId);
      return err(
        new AppError({
          code: "PROJECT_NOT_FOUND",
          message: "The project does not exist.",
        }),
      );
    }
    if (projectResult.value.status === "trashed") {
      await this.resetMissingOrDeletedProject(projectId);
      return err(
        new AppError({
          code: "PROJECT_DELETED",
          message: "The project is in the trash and cannot be searched.",
          actions: ["RESTORE"],
        }),
      );
    }
    if (!chaptersResult.ok) {
      return chaptersResult;
    }
    if (!outlineResult.ok) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The story outline could not be loaded for indexing.",
          retryable: outlineResult.error.retryable,
          actions: ["RETRY"],
          details: { sourceCode: outlineResult.error.code },
        }),
      );
    }

    let persisted: ProjectSearchSnapshot | null;
    let recoveredFromCorruption = false;
    try {
      persisted = await this.dependencies.snapshots.loadProject(projectId);
    } catch (cause: unknown) {
      if (!isCorruptSnapshotFailure(cause)) {
        return err(toSearchAppError(cause));
      }
      try {
        await this.dependencies.snapshots.resetProject(projectId);
      } catch (resetCause: unknown) {
        return err(toSearchAppError(resetCause));
      }
      persisted = null;
      recoveredFromCorruption = true;
    }

    const reusableDocuments = force ? [] : (persisted?.documents ?? []);
    const chapterDocuments = await this.createChapterDocuments(
      chaptersResult.value,
      reusableDocuments,
    );
    if (!chapterDocuments.ok) {
      return chapterDocuments;
    }
    const outlineDocuments = await this.createOutlineDocuments(
      outlineResult.value?.toSnapshot() ?? null,
      reusableDocuments,
    );
    if (!outlineDocuments.ok) {
      return outlineDocuments;
    }
    const storyFactDocuments = storyFactsResult.ok
      ? await this.createStoryFactEvidenceDocuments(storyFactsResult.value, chaptersResult.value)
      : ok<DocumentBuildResult>({
          documents: Object.freeze([]),
          reusedSourceCount: 0,
          hashedDocumentCount: 0,
          integrityHashedDocumentCount: 0,
          integrityMismatch: false,
          omissions: Object.freeze([
            {
              sourceType: "story_fact_evidence",
              sourceId: null,
              reason: "story_fact_source_unavailable",
            },
          ]),
        });
    if (!storyFactDocuments.ok) {
      return storyFactDocuments;
    }
    const recoveredFromIntegrityMismatch =
      chapterDocuments.value.integrityMismatch ||
      outlineDocuments.value.integrityMismatch ||
      storyFactDocuments.value.integrityMismatch;
    recoveredFromCorruption ||= recoveredFromIntegrityMismatch;

    const documents = [
      ...chapterDocuments.value.documents,
      ...outlineDocuments.value.documents,
      ...storyFactDocuments.value.documents,
    ];
    const projectionOmissions = Object.freeze([
      ...chapterDocuments.value.omissions,
      ...outlineDocuments.value.omissions,
      ...storyFactDocuments.value.omissions,
    ]);
    const synchronizedAt = this.dependencies.clock.now();
    let synchronization: ProjectSearchSynchronization;
    try {
      synchronization = await this.dependencies.snapshots.synchronizeProject({
        projectId,
        documents,
        indexedAt: synchronizedAt,
        force,
      });
    } catch (cause: unknown) {
      if (!isCorruptSnapshotFailure(cause) || recoveredFromCorruption) {
        return err(toSearchAppError(cause));
      }
      try {
        await this.dependencies.snapshots.resetProject(projectId);
        synchronization = await this.dependencies.snapshots.synchronizeProject({
          projectId,
          documents,
          indexedAt: synchronizedAt,
          force: true,
        });
        recoveredFromCorruption = true;
      } catch (recoveryCause: unknown) {
        return err(toSearchAppError(recoveryCause));
      }
    }

    try {
      const health = await this.applySynchronization(
        synchronization,
        force || recoveredFromCorruption,
      );
      this.rememberVerifiedSnapshot(synchronization.snapshot);
      this.lastDiagnostics = Object.freeze({
        projectId,
        snapshotRevision: synchronization.snapshot.revision,
        documentCount: synchronization.snapshot.documents.length,
        upsertedCount: synchronization.upsertedDocuments.length,
        deletedCount: synchronization.deletedDocumentIds.length,
        unchangedCount: synchronization.unchangedCount,
        reusedSourceCount:
          chapterDocuments.value.reusedSourceCount +
          outlineDocuments.value.reusedSourceCount +
          storyFactDocuments.value.reusedSourceCount,
        hashedDocumentCount:
          chapterDocuments.value.hashedDocumentCount +
          outlineDocuments.value.hashedDocumentCount +
          storyFactDocuments.value.hashedDocumentCount,
        integrityHashedDocumentCount:
          chapterDocuments.value.integrityHashedDocumentCount +
          outlineDocuments.value.integrityHashedDocumentCount +
          storyFactDocuments.value.integrityHashedDocumentCount,
        recoveredFromIntegrityMismatch,
        recoveredFromCorruption,
        forced: force,
        changed: synchronization.changed,
        synchronizedAt: synchronization.snapshot.indexedAt,
        storyFactEvidenceCount: storyFactDocuments.value.documents.length,
        projectionOmissions,
      });
      return ok({
        health,
        recoveredFromCorruption,
        snapshot: synchronization.snapshot,
        projectionOmissions,
      });
    } catch (cause: unknown) {
      return err(toSearchAppError(cause));
    }
  }

  private async createChapterDocuments(
    chapters: readonly Chapter[],
    persistedDocuments: readonly SearchDocument[],
  ): Promise<Result<DocumentBuildResult, AppError>> {
    const documents: SearchDocument[] = [];
    let reusedSourceCount = 0;
    let hashedDocumentCount = 0;
    let integrityHashedDocumentCount = 0;
    let integrityMismatch = false;
    for (const [chapterIndex, chapter] of chapters.entries()) {
      if (chapter.status !== "active") {
        continue;
      }
      const snapshot = chapter.toSnapshot();
      const units = buildChapterProjectionUnits(chapter);
      const storyOrder = chapterIndex + 1;
      const reusable = findReusableChapterDocuments(chapter, units, storyOrder, persistedDocuments);
      if (reusable !== null) {
        let verified = true;
        for (const document of reusable) {
          if (this.isDocumentIntegrityVerified(document)) {
            continue;
          }
          const checksum = await this.dependencies.hasher.sha256(document.text);
          if (!checksum.ok) {
            return checksum;
          }
          integrityHashedDocumentCount += 1;
          if (checksum.value !== document.contentHash) {
            verified = false;
            integrityMismatch = true;
            break;
          }
          this.rememberDocumentIntegrity(document);
        }
        if (verified) {
          documents.push(...reusable);
          reusedSourceCount += 1;
          continue;
        }
      }

      for (const unit of units) {
        const checksum = await this.dependencies.hasher.sha256(unit.text);
        if (!checksum.ok) {
          return checksum;
        }
        hashedDocumentCount += 1;
        const document: SearchDocument = {
          id: unit.id,
          projectId: chapter.projectId,
          sourceType: "chapter",
          sourceId: chapter.id,
          sourceVersionId: chapter.currentVersionId,
          title: unit.title,
          text: unit.text,
          contentHash: checksum.value,
          updatedAt: snapshot.updatedAt,
          chunkKind: unit.chunkKind,
          parentDocumentId: unit.parentDocumentId,
          utf16Start: unit.start,
          utf16End: unit.end,
          sourceLength: chapter.content.length,
          sceneId: unit.sceneId,
          eventId: unit.eventId,
          characterIds: Object.freeze([]),
          locationIds: Object.freeze([]),
          storyTime: null,
          // Story authority uses null for the canonical/main line.
          branchId: null,
          povCharacterId: null,
          storyOrder,
          authority: "accepted_text",
          privacy: chapter.privacyMode,
          currentness: "current",
          omittedScopeFields: chapterProjectionOmissions(unit),
        };
        documents.push(document);
        this.rememberDocumentIntegrity(document);
      }
    }
    return ok({
      documents,
      reusedSourceCount,
      hashedDocumentCount,
      integrityHashedDocumentCount,
      integrityMismatch,
      omissions: Object.freeze([]),
    });
  }

  private async createStoryFactEvidenceDocuments(
    facts: readonly StoryFact[],
    chapters: readonly Chapter[],
  ): Promise<Result<DocumentBuildResult, AppError>> {
    const documents: SearchDocument[] = [];
    const omissions: ProjectSearchProjectionOmission[] = [];
    let hashedDocumentCount = 0;
    const activeChapters = new Map<string, Readonly<{ chapter: Chapter; storyOrder: number }>>();
    for (const [index, chapter] of chapters.entries()) {
      if (chapter.status === "active") {
        activeChapters.set(chapter.id, { chapter, storyOrder: index + 1 });
      }
    }
    const orderedFacts = [...facts].sort((left, right) => left.id.localeCompare(right.id));
    for (const fact of orderedFacts) {
      const resolved = resolveStoryFactEvidence(fact.toSnapshot(), activeChapters);
      if (!resolved.ok) {
        omissions.push({
          sourceType: "story_fact_evidence",
          sourceId: resolved.sourceId,
          reason: resolved.reason,
        });
        continue;
      }
      const chapterParents = buildChapterProjectionUnits(resolved.chapter).filter(
        (unit) => unit.chunkKind === "chapter",
      );
      for (const parent of chapterParents) {
        const start = Math.max(resolved.start, parent.start);
        const end = Math.min(resolved.end, parent.end);
        if (start >= end) {
          continue;
        }
        const text = resolved.chapter.content.slice(start, end);
        const checksum = await this.dependencies.hasher.sha256(text);
        if (!checksum.ok) {
          return checksum;
        }
        hashedDocumentCount += 1;
        documents.push({
          id: `story-fact-evidence:${resolved.snapshot.id}:r${String(resolved.snapshot.revision)}:${String(start)}:${String(end)}`,
          projectId: resolved.snapshot.projectId,
          sourceType: "memory",
          sourceId: resolved.snapshot.id,
          sourceVersionId: resolved.chapter.currentVersionId,
          title: `已确认设定证据 · ${resolved.snapshot.factType}`,
          text,
          contentHash: checksum.value,
          updatedAt: resolved.snapshot.updatedAt,
          chunkKind: "story_fact_evidence",
          parentDocumentId: parent.id,
          utf16Start: start,
          utf16End: end,
          sourceLength: resolved.chapter.content.length,
          sceneId: null,
          eventId: null,
          characterIds: Object.freeze([]),
          locationIds: Object.freeze([]),
          storyTime: resolved.snapshot.effectiveAt,
          branchId: resolved.snapshot.branchId,
          povCharacterId: null,
          storyOrder: resolved.storyOrder,
          authority: "confirmed_fact",
          privacy: resolved.chapter.privacyMode,
          currentness: "current",
          omittedScopeFields: Object.freeze([
            "scene",
            "event",
            "pov",
            "characters",
            "locations",
            ...(resolved.snapshot.effectiveAt === null ? ["story_time"] : []),
          ]),
        });
      }
    }
    return ok({
      documents: Object.freeze(documents),
      reusedSourceCount: 0,
      hashedDocumentCount,
      integrityHashedDocumentCount: 0,
      integrityMismatch: false,
      omissions: Object.freeze(omissions),
    });
  }

  private async createOutlineDocuments(
    outline: OutlineSnapshot | null,
    persistedDocuments: readonly SearchDocument[],
  ): Promise<Result<DocumentBuildResult, AppError>> {
    if (outline === null) {
      return ok({
        documents: [],
        reusedSourceCount: 0,
        hashedDocumentCount: 0,
        integrityHashedDocumentCount: 0,
        integrityMismatch: false,
        omissions: Object.freeze([]),
      });
    }

    const documents: SearchDocument[] = [];
    let reusedSourceCount = 0;
    let hashedDocumentCount = 0;
    let integrityHashedDocumentCount = 0;
    let integrityMismatch = false;
    for (const node of outline.nodes) {
      const reusable = findReusableOutlineDocument(outline.projectId, node, persistedDocuments);
      if (reusable !== null) {
        if (this.isDocumentIntegrityVerified(reusable)) {
          documents.push(reusable);
          reusedSourceCount += 1;
          continue;
        }
        const integrityChecksum = await this.dependencies.hasher.sha256(
          outlineDocumentHashInput(node),
        );
        if (!integrityChecksum.ok) {
          return integrityChecksum;
        }
        integrityHashedDocumentCount += 1;
        if (integrityChecksum.value === reusable.contentHash) {
          this.rememberDocumentIntegrity(reusable);
          documents.push(reusable);
          reusedSourceCount += 1;
          continue;
        }
        integrityMismatch = true;
      }
      const checksum = await this.dependencies.hasher.sha256(outlineDocumentHashInput(node));
      if (!checksum.ok) {
        return checksum;
      }
      hashedDocumentCount += 1;
      const document: SearchDocument = {
        id: `outline:${node.id}`,
        projectId: outline.projectId,
        sourceType: "outline",
        sourceId: node.id,
        sourceVersionId: `outline:${node.id}:r${String(node.revision)}`,
        title: node.title,
        text: node.synopsis,
        contentHash: checksum.value,
        updatedAt: node.updatedAt,
        chunkKind: "chapter",
        parentDocumentId: null,
        utf16Start: 0,
        utf16End: node.synopsis.length,
        sourceLength: node.synopsis.length,
        sceneId: null,
        eventId: null,
        characterIds: Object.freeze([]),
        locationIds: Object.freeze([]),
        storyTime: null,
        branchId: null,
        povCharacterId: null,
        storyOrder: null,
        authority: "rebuildable",
        privacy: "standard",
        currentness: "current",
        omittedScopeFields: Object.freeze([
          "accepted_version",
          "branch",
          "characters",
          "event",
          "locations",
          "pov",
          "scene",
          "story_order",
          "story_time",
        ]),
      };
      documents.push(document);
      this.rememberDocumentIntegrity(document);
    }
    return ok({
      documents,
      reusedSourceCount,
      hashedDocumentCount,
      integrityHashedDocumentCount,
      integrityMismatch,
      omissions: Object.freeze([]),
    });
  }

  private async applySynchronization(
    synchronization: ProjectSearchSynchronization,
    rebuild: boolean,
    preparedVectorLoad?: ProjectVectorLoad,
  ): Promise<SearchHealth> {
    const index = await this.getIndex();
    const projectId = synchronization.snapshot.projectId;
    let vectorLoad = preparedVectorLoad;
    if (vectorLoad === undefined && this.dependencies.vectors !== undefined) {
      try {
        vectorLoad = await this.dependencies.vectors.synchronizeProject(
          projectId,
          synchronization.snapshot.documents,
          synchronization.changed,
        );
        this.lastVectorFailureCode = null;
      } catch (cause: unknown) {
        this.lastVectorFailureCode = safeErrorCode(cause, "VECTOR_SERVICE_UNAVAILABLE");
        this.vectorLoads.delete(projectId);
        this.loadedVectorMarkers.delete(projectId);
      }
    }
    if (vectorLoad !== undefined) {
      this.vectorLoads.set(projectId, vectorLoad);
    }

    const desiredConfiguration = vectorLoad?.configuration ?? null;
    const currentConfiguration = index.health().embeddingConfiguration;
    const configurationChanged = !sameEmbeddingConfiguration(
      currentConfiguration,
      desiredConfiguration,
    );
    if (configurationChanged) {
      index.configureEmbedding(desiredConfiguration ?? undefined);
    }
    const vectorMarker = vectorLoadMarker(vectorLoad);
    const vectorGenerationChanged = this.loadedVectorMarkers.get(projectId) !== vectorMarker;
    const loadedEmbeddings =
      vectorLoad?.configuration === null ? undefined : vectorLoad?.embeddings;
    if (rebuild || !this.loadedProjects.has(projectId) || vectorGenerationChanged) {
      const health = index.rebuildProject(
        {
          projectId,
          documents: synchronization.snapshot.documents,
          ...(loadedEmbeddings === undefined ? {} : { embeddings: loadedEmbeddings }),
          rebuiltAt: synchronization.snapshot.indexedAt,
        },
        index.health().generation,
      );
      this.loadedProjects.add(projectId);
      this.loadedVectorMarkers.set(projectId, vectorMarker);
      return mergeVectorHealth(health, vectorLoad?.diagnostics ?? this.embeddingDiagnostics());
    }

    for (const documentId of synchronization.deletedDocumentIds) {
      index.deleteDocument(projectId, documentId);
    }
    for (const document of synchronization.upsertedDocuments) {
      index.upsertDocument(document);
    }
    if (synchronization.changed) {
      index.markProjectSynced(projectId, synchronization.snapshot.indexedAt);
    }
    return mergeVectorHealth(
      index.health(),
      vectorLoad?.diagnostics ?? this.embeddingDiagnostics(),
    );
  }

  private async resetMissingOrDeletedProject(projectId: UuidV7): Promise<void> {
    try {
      await this.dependencies.snapshots.resetProject(projectId);
    } catch {
      // Source lifecycle remains authoritative. A failed derived cleanup must
      // not turn a missing/deleted project into readable search content.
    }
    if (this.index !== null) {
      try {
        this.index.deleteProject(projectId);
      } catch {
        // The project is still blocked by the source lifecycle check above.
      }
    }
    try {
      await this.dependencies.vectors?.resetProject(projectId);
    } catch {
      // Derived vector cleanup is best-effort after source access is denied.
    }
    this.loadedProjects.delete(projectId);
    this.loadedVectorMarkers.delete(projectId);
    this.vectorLoads.delete(projectId);
    this.verifiedDocumentIntegrity.delete(projectId);
  }

  private isDocumentIntegrityVerified(document: SearchDocument): boolean {
    return (
      this.verifiedDocumentIntegrity.get(document.projectId)?.get(document.id) ===
      documentIntegrityMarker(document)
    );
  }

  private rememberDocumentIntegrity(document: SearchDocument): void {
    const project = new Map(this.verifiedDocumentIntegrity.get(document.projectId) ?? []);
    project.set(document.id, documentIntegrityMarker(document));
    this.verifiedDocumentIntegrity.set(document.projectId, project);
  }

  private rememberVerifiedSnapshot(snapshot: ProjectSearchSnapshot): void {
    this.verifiedDocumentIntegrity.set(
      snapshot.projectId,
      new Map(
        snapshot.documents.map((document) => [document.id, documentIntegrityMarker(document)]),
      ),
    );
  }

  private runExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async getIndex(): Promise<InMemoryHybridSearchIndex> {
    if (this.index !== null) {
      return this.index;
    }
    this.indexPromise ??= import("@inkshadow/search-core").then(
      ({ InMemoryHybridSearchIndex: SearchIndex }) => new SearchIndex(),
    );
    this.index = await this.indexPromise;
    return this.index;
  }
}

function findReusableChapterDocuments(
  chapter: Chapter,
  units: readonly ChapterProjectionUnit[],
  storyOrder: number,
  persistedDocuments: readonly SearchDocument[],
): readonly SearchDocument[] | null {
  const candidates = persistedDocuments
    .filter(
      (document) =>
        document.projectId === chapter.projectId &&
        document.sourceType === "chapter" &&
        document.sourceId === chapter.id,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length !== units.length) {
    return null;
  }
  const candidatesById = new Map(candidates.map((document) => [document.id, document]));
  const updatedAt = chapter.toSnapshot().updatedAt;
  const coherent = units.every((unit) => {
    const document = candidatesById.get(unit.id);
    return (
      document?.sourceVersionId === chapter.currentVersionId &&
      document.updatedAt === updatedAt &&
      document.title === unit.title &&
      document.text === unit.text &&
      document.chunkKind === unit.chunkKind &&
      document.parentDocumentId === unit.parentDocumentId &&
      document.utf16Start === unit.start &&
      document.utf16End === unit.end &&
      document.sourceLength === chapter.content.length &&
      document.sceneId === unit.sceneId &&
      document.eventId === unit.eventId &&
      sameStringValues(document.characterIds, []) &&
      sameStringValues(document.locationIds, []) &&
      document.storyTime === null &&
      document.branchId === null &&
      document.povCharacterId === null &&
      document.storyOrder === storyOrder &&
      document.authority === "accepted_text" &&
      document.privacy === chapter.privacyMode &&
      document.currentness === "current" &&
      sameStringValues(document.omittedScopeFields, chapterProjectionOmissions(unit))
    );
  });
  return coherent ? Object.freeze(candidates) : null;
}

function findReusableOutlineDocument(
  projectId: string,
  node: OutlineSnapshot["nodes"][number],
  persistedDocuments: readonly SearchDocument[],
): SearchDocument | null {
  const candidates = persistedDocuments.filter(
    (document) =>
      document.projectId === projectId &&
      document.sourceType === "outline" &&
      document.sourceId === node.id,
  );
  const candidate = candidates[0];
  if (
    candidates.length !== 1 ||
    candidate?.id !== `outline:${node.id}` ||
    candidate.sourceVersionId !== `outline:${node.id}:r${String(node.revision)}` ||
    candidate.title !== node.title ||
    candidate.text !== node.synopsis ||
    candidate.updatedAt !== node.updatedAt ||
    candidate.chunkKind !== "chapter" ||
    candidate.parentDocumentId !== null ||
    candidate.utf16Start !== 0 ||
    candidate.utf16End !== node.synopsis.length ||
    candidate.sourceLength !== node.synopsis.length ||
    candidate.sceneId !== null ||
    candidate.eventId !== null ||
    !sameStringValues(candidate.characterIds, []) ||
    !sameStringValues(candidate.locationIds, []) ||
    candidate.storyTime !== null ||
    candidate.branchId !== null ||
    candidate.povCharacterId !== null ||
    candidate.storyOrder !== null ||
    candidate.authority !== "rebuildable" ||
    candidate.privacy !== "standard" ||
    candidate.currentness !== "current" ||
    !sameStringValues(candidate.omittedScopeFields, [
      "accepted_version",
      "branch",
      "characters",
      "event",
      "locations",
      "pov",
      "scene",
      "story_order",
      "story_time",
    ])
  ) {
    return null;
  }
  return candidate;
}

function outlineDocumentHashInput(node: OutlineSnapshot["nodes"][number]): string {
  return `${node.title}\n${node.synopsis}\n${node.kind}\n${String(node.locked)}`;
}

function documentIntegrityMarker(document: SearchDocument): string {
  return `${document.sourceVersionId}\u0000${document.contentHash}`;
}

function resolveStoryFactEvidence(
  snapshot: StoryFactSnapshot,
  activeChapters: ReadonlyMap<string, Readonly<{ chapter: Chapter; storyOrder: number }>>,
): StoryFactEvidenceResolution {
  if (
    snapshot.status !== "formal" ||
    !snapshot.userConfirmed ||
    snapshot.needsReview ||
    snapshot.deprecated
  ) {
    return {
      ok: false,
      sourceId: snapshot.id,
      reason: "story_fact_not_confirmed_current_canon",
    };
  }
  const source = snapshot.source;
  if (
    source.kind !== "chapter_span" ||
    source.chapterId === null ||
    source.versionId === null ||
    source.startOffset === null ||
    source.endOffset === null ||
    source.sourceLength === null
  ) {
    return {
      ok: false,
      sourceId: snapshot.id,
      reason: "story_fact_source_not_exact_chapter_span",
    };
  }
  const chapterAuthority = activeChapters.get(source.chapterId);
  if (
    chapterAuthority === undefined ||
    String(chapterAuthority.chapter.projectId) !== String(snapshot.projectId)
  ) {
    return {
      ok: false,
      sourceId: snapshot.id,
      reason: "story_fact_source_chapter_missing",
    };
  }
  if (String(source.versionId) !== String(chapterAuthority.chapter.currentVersionId)) {
    return {
      ok: false,
      sourceId: snapshot.id,
      reason: "story_fact_source_version_not_current",
    };
  }
  if (
    !Number.isSafeInteger(source.startOffset) ||
    !Number.isSafeInteger(source.endOffset) ||
    !Number.isSafeInteger(source.sourceLength) ||
    source.startOffset < 0 ||
    source.endOffset <= source.startOffset ||
    source.endOffset > chapterAuthority.chapter.content.length ||
    source.sourceLength !== chapterAuthority.chapter.content.length
  ) {
    return {
      ok: false,
      sourceId: snapshot.id,
      reason: "story_fact_source_span_invalid",
    };
  }
  const exactText = chapterAuthority.chapter.content.slice(source.startOffset, source.endOffset);
  if (source.excerpt !== null && source.excerpt !== exactText) {
    return {
      ok: false,
      sourceId: snapshot.id,
      reason: "story_fact_source_excerpt_mismatch",
    };
  }
  return {
    ok: true,
    snapshot,
    chapter: chapterAuthority.chapter,
    storyOrder: chapterAuthority.storyOrder,
    start: source.startOffset,
    end: source.endOffset,
  };
}

function buildChapterProjectionUnits(chapter: Chapter): readonly ChapterProjectionUnit[] {
  const chapterSpans = splitSearchText(chapter.content);
  const chapterUnits = chapterSpans.map((span, index): ChapterProjectionUnit => ({
    ...span,
    id: `chapter:${chapter.id}:${String(index)}`,
    title:
      chapterSpans.length === 1 ? chapter.title : `${chapter.title} · 片段 ${String(index + 1)}`,
    chunkKind: "chapter",
    parentDocumentId: null,
    sceneId: null,
    eventId: null,
  }));
  const sceneUnits: ChapterProjectionUnit[] = [];
  for (const scene of sceneSpans(chapter.content)) {
    for (const parent of chapterUnits) {
      const child = intersectTrimmedSpan(scene, parent);
      if (child === null) {
        continue;
      }
      const id = `scene:${chapter.id}:${String(child.start)}:${String(child.end)}`;
      sceneUnits.push({
        ...child,
        id,
        title: `${chapter.title} · 场景`,
        chunkKind: "scene",
        parentDocumentId: parent.id,
        sceneId: id,
        eventId: null,
      });
    }
  }
  const paragraphUnits: ChapterProjectionUnit[] = [];
  for (const paragraph of paragraphSpans(chapter.content)) {
    for (const parent of sceneUnits) {
      const child = intersectTrimmedSpan(paragraph, parent);
      if (child === null) {
        continue;
      }
      paragraphUnits.push({
        ...child,
        id: `paragraph:${chapter.id}:${String(child.start)}:${String(child.end)}`,
        title: `${chapter.title} · 段落`,
        chunkKind: "paragraph",
        parentDocumentId: parent.id,
        sceneId: parent.sceneId,
        eventId: null,
      });
    }
  }

  // Event chunks are deterministic sentence-level evidence spans. They are
  // retrieval granularity only and never claim a semantic event extraction.
  const eventUnits: ChapterProjectionUnit[] = [];
  for (const paragraph of paragraphUnits) {
    for (const event of eventSpans(paragraph)) {
      const id = `event:${chapter.id}:${String(event.start)}:${String(event.end)}`;
      eventUnits.push({
        ...event,
        id,
        title: `${chapter.title} · 事件段`,
        chunkKind: "event",
        parentDocumentId: paragraph.id,
        sceneId: paragraph.sceneId,
        eventId: id,
      });
    }
  }

  const dialogueUnits: ChapterProjectionUnit[] = [];
  const dialogueIds = new Set<string>();
  for (const event of eventUnits) {
    for (const dialogue of dialogueSpans(event)) {
      const id = `dialogue:${chapter.id}:${String(dialogue.start)}:${String(dialogue.end)}`;
      if (dialogueIds.has(id)) {
        continue;
      }
      dialogueIds.add(id);
      dialogueUnits.push({
        ...dialogue,
        id,
        title: `${chapter.title} · 对话`,
        chunkKind: "dialogue",
        parentDocumentId: event.id,
        sceneId: event.sceneId,
        eventId: event.id,
      });
    }
  }
  return Object.freeze([
    ...chapterUnits,
    ...sceneUnits,
    ...paragraphUnits,
    ...eventUnits,
    ...dialogueUnits,
  ]);
}

function chapterProjectionOmissions(unit: ChapterProjectionUnit): readonly string[] {
  return Object.freeze(
    [
      ...(unit.sceneId === null ? ["scene"] : []),
      ...(unit.eventId === null ? ["event"] : []),
      "characters",
      "locations",
      "pov",
      "story_time",
    ].sort(),
  );
}

function splitSearchText(text: string): readonly SearchTextSpan[] {
  if (utf8Length(text) <= MAX_SEARCH_DOCUMENT_UTF8_BYTES) {
    return Object.freeze([{ start: 0, end: text.length, text }]);
  }

  const chunks: SearchTextSpan[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const codePoint = text.codePointAt(end);
      if (codePoint === undefined) {
        break;
      }
      const codePointBytes = utf8CodePointLength(codePoint);
      if (bytes + codePointBytes > MAX_SEARCH_DOCUMENT_UTF8_BYTES) {
        break;
      }
      bytes += codePointBytes;
      end += codePoint > 0xffff ? 2 : 1;
    }
    if (end === start) {
      throw new Error("A search document code point exceeds the UTF-8 chunk limit.");
    }
    chunks.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) {
      break;
    }
    start = end;
  }
  return Object.freeze(chunks);
}

function paragraphSpans(text: string): readonly SearchTextSpan[] {
  const spans: SearchTextSpan[] = [];
  const lines = /[^\r\n]+/gu;
  for (const match of text.matchAll(lines)) {
    const start = match.index;
    const value = match[0];
    const trimmed = trimSourceSpan(text, start, start + value.length);
    if (trimmed !== null) {
      spans.push(trimmed);
    }
  }
  return Object.freeze(spans);
}

function sceneSpans(text: string): readonly SearchTextSpan[] {
  const spans: SearchTextSpan[] = [];
  const boundary =
    /(?:\r?\n[^\S\r\n]*\r?\n)|(?:^|\r?\n)[^\S\r\n]*(?:\*{3,}|-{3,}|#{3,})[^\S\r\n]*(?=\r?\n|$)/gmu;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const span = trimSourceSpan(text, start, match.index);
    if (span !== null) {
      spans.push(span);
    }
    start = match.index + match[0].length;
  }
  const finalSpan = trimSourceSpan(text, start, text.length);
  if (finalSpan !== null) {
    spans.push(finalSpan);
  }
  return Object.freeze(spans);
}

function eventSpans(paragraph: ChapterProjectionUnit): readonly SearchTextSpan[] {
  const spans: SearchTextSpan[] = [];
  const sentences = /[^。！？!?；;\r\n]+(?:[。！？!?；;]+[”」』"']*|$)/gu;
  for (const match of paragraph.text.matchAll(sentences)) {
    const span = trimSourceSpan(
      paragraph.text,
      match.index,
      match.index + match[0].length,
      paragraph.start,
    );
    if (span !== null) {
      spans.push(span);
    }
  }
  return Object.freeze(spans);
}

function intersectTrimmedSpan(span: SearchTextSpan, parent: SearchTextSpan): SearchTextSpan | null {
  const start = Math.max(span.start, parent.start);
  const end = Math.min(span.end, parent.end);
  if (start >= end) {
    return null;
  }
  return trimSourceSpan(span.text, start - span.start, end - span.start, span.start);
}

function trimSourceSpan(
  source: string,
  start: number,
  end: number,
  offset = 0,
): SearchTextSpan | null {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(source[trimmedStart] ?? "")) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/u.test(source[trimmedEnd - 1] ?? "")) {
    trimmedEnd -= 1;
  }
  if (trimmedStart === trimmedEnd) {
    return null;
  }
  return Object.freeze({
    start: offset + trimmedStart,
    end: offset + trimmedEnd,
    text: source.slice(trimmedStart, trimmedEnd),
  });
}

function dialogueSpans(paragraph: ChapterProjectionUnit): readonly SearchTextSpan[] {
  const matches: SearchTextSpan[] = [];
  const quoted = /[“「『"][^”」』"\r\n]+[”」』"]/gu;
  for (const match of paragraph.text.matchAll(quoted)) {
    const start = paragraph.start + match.index;
    matches.push(Object.freeze({ start, end: start + match[0].length, text: match[0] }));
  }
  if (matches.length === 0 && /^(?:[-—]|[^：:\r\n]{1,30}[：:])/u.test(paragraph.text)) {
    matches.push(
      Object.freeze({
        start: paragraph.start,
        end: paragraph.end,
        text: paragraph.text,
      }),
    );
  }
  return Object.freeze(matches);
}

function sameStringValues(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      bytes += utf8CodePointLength(codePoint);
    }
  }
  return bytes;
}

function utf8CodePointLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  return codePoint <= 0xffff ? 3 : 4;
}

function isValidSearchQuery(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return normalized.length >= 1 && normalized.length <= MAX_SEARCH_QUERY_LENGTH;
}

function isValidSearchLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SEARCH_RESULTS;
}

function isCorruptSnapshotFailure(cause: unknown): boolean {
  return (
    cause instanceof ProjectSearchSnapshotStoreError && cause.code === "SEARCH_SNAPSHOT_CORRUPT"
  );
}

function toSearchAppError(cause: unknown): AppError {
  if (cause instanceof ProjectEmbeddingServiceError) {
    return new AppError({
      code: cause.code.includes("CONFIRMATION") ? "VALIDATION_FAILED" : "REPOSITORY_ERROR",
      message: cause.message,
      retryable: cause.retryable,
      actions: cause.retryable ? ["RETRY"] : [],
      details: { sourceCode: cause.code },
    });
  }
  if (cause instanceof ProjectSearchSnapshotStoreError) {
    if (cause.code === "SEARCH_SCOPE_INVALID") {
      return new AppError({
        code: "VALIDATION_FAILED",
        message: "The retrieval scope is incomplete or invalid.",
        details: { sourceCode: cause.code },
      });
    }
    return new AppError({
      code: "REPOSITORY_ERROR",
      message: "The persistent local search snapshot is unavailable.",
      retryable: cause.retryable,
      actions: cause.retryable ? ["RETRY"] : ["CONTACT_SUPPORT"],
      details: { sourceCode: cause.code },
    });
  }
  const searchCode = readSearchIndexErrorCode(cause);
  if (searchCode !== null) {
    const invalidInput =
      searchCode === "INVALID_QUERY" ||
      searchCode === "INVALID_DOCUMENT" ||
      searchCode === "INVALID_EMBEDDING" ||
      searchCode === "INVALID_RELATION" ||
      searchCode === "PROJECT_MISMATCH";
    return new AppError({
      code: invalidInput ? "VALIDATION_FAILED" : "REPOSITORY_ERROR",
      message: invalidInput
        ? "The local search request or index source is invalid."
        : "The local search index could not be synchronized.",
      retryable: !invalidInput,
      actions: invalidInput ? [] : ["RETRY"],
      details: { sourceCode: searchCode },
    });
  }
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The local search index is unavailable.",
    retryable: true,
    actions: ["RETRY"],
  });
}

function sameEmbeddingConfiguration(
  left: EmbeddingConfiguration | undefined,
  right: EmbeddingConfiguration | null,
): boolean {
  return (
    (left === undefined && right === null) ||
    (left !== undefined &&
      right !== null &&
      left.modelId === right.modelId &&
      left.dimension === right.dimension)
  );
}

function vectorLoadMarker(load: ProjectVectorLoad | undefined): string {
  if (load === undefined) {
    return "disabled";
  }
  return [
    load.diagnostics.status,
    load.diagnostics.generation ?? "none",
    load.configuration?.modelId ?? "none",
    load.configuration?.dimension ?? "none",
  ].join(":");
}

function mergeVectorHealth(
  health: SearchHealth,
  diagnostics: ProjectEmbeddingDiagnostics,
): SearchHealth {
  const { embeddingConfiguration: _currentConfiguration, ...healthWithoutConfiguration } = health;
  void _currentConfiguration;
  const degradedReasons = new Set(health.degradedReasons);
  if (diagnostics.reason !== null && diagnostics.status !== "disabled") {
    degradedReasons.add(diagnostics.reason);
  }
  return {
    ...healthWithoutConfiguration,
    vectorStatus: diagnostics.status,
    embeddingCount: diagnostics.embeddingCount,
    ...(diagnostics.dimension === null || diagnostics.confirmationId === null
      ? {}
      : {
          embeddingConfiguration: {
            modelId: diagnostics.confirmationId,
            dimension: diagnostics.dimension,
          },
        }),
    ...(diagnostics.lastRebuiltAt === null ? {} : { lastRebuiltAt: diagnostics.lastRebuiltAt }),
    degradedReasons: [...degradedReasons].sort(),
  };
}

function safeErrorCode(cause: unknown, fallback: string): string {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,79}$/u.test(cause.code)
    ? cause.code
    : fallback;
}

const EMPTY_EMBEDDING_DIAGNOSTICS: ProjectEmbeddingDiagnostics = Object.freeze({
  status: "disabled",
  reason: "no_embedding_route",
  providerId: null,
  provider: null,
  model: null,
  dimension: null,
  embeddingCount: 0,
  generation: null,
  destination: null,
  endpointOrigin: null,
  endpointUrl: null,
  confirmationId: null,
  lastRebuiltAt: null,
  queryFailureCode: null,
});

function readSearchIndexErrorCode(cause: unknown): SearchIndexErrorCode | null {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("name" in cause) ||
    cause.name !== "SearchIndexError" ||
    !("code" in cause) ||
    typeof cause.code !== "string"
  ) {
    return null;
  }
  const codes: readonly SearchIndexErrorCode[] = [
    "INVALID_DOCUMENT",
    "INVALID_EMBEDDING",
    "INVALID_RELATION",
    "INVALID_QUERY",
    "INDEX_PAUSED",
    "GENERATION_CONFLICT",
    "PROJECT_MISMATCH",
  ];
  return codes.includes(cause.code as SearchIndexErrorCode)
    ? (cause.code as SearchIndexErrorCode)
    : null;
}
