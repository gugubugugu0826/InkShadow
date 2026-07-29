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
  SearchDocument,
  SearchHealth,
  SearchIndexErrorCode,
} from "@inkshadow/search-core";
import {
  parseUuidV7 as parseStoryUuidV7,
  type OutlineRepository,
  type OutlineSnapshot,
} from "@inkshadow/story-core";

import {
  ProjectSearchSnapshotStoreError,
  type ProjectSearchSnapshot,
  type ProjectSearchSnapshotStore,
  type ProjectSearchSynchronization,
} from "./project-search-store";
import {
  ProjectEmbeddingServiceError,
  type ProjectEmbeddingDiagnostics,
  type ProjectSearchVectorService,
  type ProjectVectorLoad,
} from "./project-search-vector-service";

const MAX_SEARCH_DOCUMENT_UTF8_BYTES = 48 * 1024;
const SEARCH_DOCUMENT_OVERLAP_UTF8_BYTES = 1_024;
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
  ): Promise<Result<HybridSearchResponse, AppError>>;
  health(): SearchHealth;
  embeddingDiagnostics(): ProjectEmbeddingDiagnostics;
  synchronizationDiagnostics(): ProjectSearchSynchronizationDiagnostics | null;
}

export interface LocalProjectSearchDependencies {
  readonly projects: ProjectRepository;
  readonly chapters: ChapterRepository;
  readonly outlines: OutlineRepository;
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
}

interface SynchronizationOutcome {
  readonly health: SearchHealth;
  readonly recoveredFromCorruption: boolean;
  readonly snapshot: ProjectSearchSnapshot;
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
  ): Promise<Result<HybridSearchResponse, AppError>> {
    if (!isValidSearchQuery(query) || !isValidSearchLimit(limit)) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VALIDATION_FAILED",
            message: "The local search query or result limit is invalid.",
          }),
        ),
      );
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
        );
        const index = await this.getIndex();
        const vectorLoad = this.vectorLoads.get(projectId);
        const vectorQuery =
          this.dependencies.vectors === undefined || vectorLoad === undefined
            ? null
            : await this.dependencies.vectors.embedQuery(vectorLoad, query);
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
          ...(queryEmbedding !== null
            ? {}
            : keywordCandidates.documentIds === null
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
        if (keywordCandidates.recovered) {
          notices.push("persistent_fts5_rebuilt_from_search_documents");
        }
        if (keywordCandidates.degraded) {
          notices.push("persistent_fts5_unavailable_in_memory_fallback");
        }
        const embeddingDiagnostics =
          vectorQuery?.diagnostics ?? vectorLoad?.diagnostics ?? this.embeddingDiagnostics();
        return ok({
          ...response,
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
    const [projectResult, chaptersResult, outlineResult] = await Promise.all([
      this.dependencies.projects.findById(projectId),
      this.dependencies.chapters.listByProjectId(projectId),
      this.dependencies.outlines.findByProjectId(storyProjectId.value),
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
    const recoveredFromIntegrityMismatch =
      chapterDocuments.value.integrityMismatch || outlineDocuments.value.integrityMismatch;
    recoveredFromCorruption ||= recoveredFromIntegrityMismatch;

    const documents = [...chapterDocuments.value.documents, ...outlineDocuments.value.documents];
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
          chapterDocuments.value.reusedSourceCount + outlineDocuments.value.reusedSourceCount,
        hashedDocumentCount:
          chapterDocuments.value.hashedDocumentCount + outlineDocuments.value.hashedDocumentCount,
        integrityHashedDocumentCount:
          chapterDocuments.value.integrityHashedDocumentCount +
          outlineDocuments.value.integrityHashedDocumentCount,
        recoveredFromIntegrityMismatch,
        recoveredFromCorruption,
        forced: force,
        changed: synchronization.changed,
        synchronizedAt: synchronization.snapshot.indexedAt,
      });
      return ok({
        health,
        recoveredFromCorruption,
        snapshot: synchronization.snapshot,
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
    for (const chapter of chapters) {
      if (chapter.status !== "active") {
        continue;
      }
      const snapshot = chapter.toSnapshot();
      const reusable = findReusableChapterDocuments(chapter, persistedDocuments);
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

      const chunks = splitSearchText(chapter.content);
      for (const [chunkIndex, text] of chunks.entries()) {
        const checksum = await this.dependencies.hasher.sha256(text);
        if (!checksum.ok) {
          return checksum;
        }
        hashedDocumentCount += 1;
        const document: SearchDocument = {
          id: `chapter:${chapter.id}:${String(chunkIndex)}`,
          projectId: chapter.projectId,
          sourceType: "chapter",
          sourceId: chapter.id,
          sourceVersionId: chapter.currentVersionId,
          title:
            chunks.length === 1
              ? chapter.title
              : `${chapter.title} · 片段 ${String(chunkIndex + 1)}`,
          text,
          contentHash: checksum.value,
          updatedAt: snapshot.updatedAt,
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
  const expectedChunks = splitSearchText(chapter.content);
  if (candidates.length !== expectedChunks.length) {
    return null;
  }
  const updatedAt = chapter.toSnapshot().updatedAt;
  const coherent = candidates.every((document, index) => {
    const expectedTitle =
      candidates.length === 1 ? chapter.title : `${chapter.title} · 片段 ${String(index + 1)}`;
    return (
      document.id === `chapter:${chapter.id}:${String(index)}` &&
      document.sourceVersionId === chapter.currentVersionId &&
      document.updatedAt === updatedAt &&
      document.title === expectedTitle &&
      document.text === expectedChunks[index]
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
    candidate.updatedAt !== node.updatedAt
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

function splitSearchText(text: string): readonly string[] {
  if (utf8Length(text) <= MAX_SEARCH_DOCUMENT_UTF8_BYTES) {
    return [text];
  }

  const chunks: string[] = [];
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
    chunks.push(text.slice(start, end));
    if (end === text.length) {
      break;
    }

    let overlapStart = end;
    let overlapBytes = 0;
    while (overlapStart > start) {
      const previous = previousCodePointStart(text, overlapStart);
      const codePoint = text.codePointAt(previous);
      if (codePoint === undefined) {
        break;
      }
      const codePointBytes = utf8CodePointLength(codePoint);
      if (overlapBytes + codePointBytes > SEARCH_DOCUMENT_OVERLAP_UTF8_BYTES) {
        break;
      }
      overlapStart = previous;
      overlapBytes += codePointBytes;
    }
    start = overlapStart;
  }
  return chunks;
}

function previousCodePointStart(value: string, exclusiveEnd: number): number {
  const previous = exclusiveEnd - 1;
  if (
    previous > 0 &&
    isLowSurrogate(value.charCodeAt(previous)) &&
    isHighSurrogate(value.charCodeAt(previous - 1))
  ) {
    return previous - 1;
  }
  return previous;
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

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
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
