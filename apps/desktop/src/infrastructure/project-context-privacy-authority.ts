import type {
  ChapterPrivacyAuthoritySnapshot,
  ChapterRepository,
  ContentHasher,
} from "@inkshadow/application";
import {
  parseUuidV7,
  type Chapter,
  type ChapterPrivacyMode,
  type ChapterStatus,
} from "@inkshadow/domain";
import type { NativeModelDispatchScope } from "./native-model-gateway-contract";

export const PROJECT_CONTEXT_LOCAL_ONLY_MESSAGE =
  "这个作品包含仅本机章节，因此会读取作品资料的 AI 操作只能使用已验证的本地模型；本次请求在发送 0 字后停止。";

export type ProjectContextPrivacyErrorCode =
  | "PRIVATE_CHAPTER_LOCAL_ONLY"
  | "PROJECT_CONTEXT_PRIVACY_CHANGED"
  | "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE";

export class ProjectContextPrivacyError extends Error {
  public constructor(
    readonly code: ProjectContextPrivacyErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProjectContextPrivacyError";
  }
}

export interface ProjectContextChapterAuthority {
  readonly chapterId: string;
  readonly currentVersionId: string;
  readonly revision: number;
  readonly privacyRevision: number;
  readonly privacyMode: ChapterPrivacyMode;
  readonly status: ChapterStatus;
}

/**
 * Contains only routing authority metadata. It deliberately excludes titles,
 * 正文, excerpts, prompts, model identifiers, credentials, and user secrets.
 */
export interface ProjectContextPrivacyReceipt {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly activeChapterCount: number;
  readonly retainedChapterCount: number;
  readonly requiresVerifiedLocal: boolean;
  readonly chapters: readonly ProjectContextChapterAuthority[];
}

/**
 * A conservative project-level privacy boundary. One retained local-only
 * chapter taints every project-context AI operation. Chapter repositories list
 * active and trashed rows; permanently deleted rows are absent. Binding trashed
 * rows is required because derived StoryFact/causal evidence can still cite
 * their accepted versions until the chapter is permanently cleared.
 */
export class ProjectContextPrivacyAuthority {
  public constructor(
    private readonly chapters: Pick<
      ChapterRepository,
      "listByProjectId" | "listPrivacyAuthorityByProjectId"
    >,
    private readonly hasher: ContentHasher,
  ) {}

  public async inspect(projectIdValue: string): Promise<ProjectContextPrivacyReceipt> {
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      throw unavailable();
    }
    let bindings: ProjectContextChapterAuthority[];
    if (this.chapters.listPrivacyAuthorityByProjectId === undefined) {
      const listed = await this.chapters.listByProjectId(projectId.value).catch(() => null);
      if (!listed?.ok) {
        throw unavailable();
      }
      bindings = listed.value.map(toAuthority);
    } else {
      const listed = await this.chapters
        .listPrivacyAuthorityByProjectId(projectId.value)
        .catch(() => null);
      if (!listed?.ok) {
        throw unavailable();
      }
      bindings = listed.value.map(toAuthorityFromMetadata);
    }
    bindings.sort((left, right) => left.chapterId.localeCompare(right.chapterId));
    const canonical = JSON.stringify({
      schemaVersion: 1,
      projectId: projectId.value,
      chapters: bindings,
    });
    const fingerprint = await this.hasher.sha256(canonical).catch(() => null);
    if (!fingerprint?.ok) {
      throw unavailable();
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      projectId: projectId.value,
      fingerprint: fingerprint.value,
      activeChapterCount: bindings.filter(({ status }) => status === "active").length,
      retainedChapterCount: bindings.length,
      requiresVerifiedLocal: bindings.some(({ privacyMode }) => privacyMode === "local_only"),
      chapters: Object.freeze(bindings),
    });
  }

  public assertChapterMatches(receipt: ProjectContextPrivacyReceipt, chapter: Chapter): void {
    const binding = receipt.chapters.find(({ chapterId }) => chapterId === chapter.id);
    if (
      binding === undefined ||
      chapter.projectId !== receipt.projectId ||
      chapter.status !== "active" ||
      binding.currentVersionId !== chapter.currentVersionId ||
      binding.revision !== chapter.revision ||
      binding.privacyRevision !== chapter.privacyRevision ||
      binding.privacyMode !== chapter.privacyMode ||
      binding.status !== "active"
    ) {
      throw changed();
    }
  }

  public async assertCurrentBeforeDispatch(receipt: ProjectContextPrivacyReceipt): Promise<void> {
    const current = await this.inspect(receipt.projectId);
    if (current.fingerprint !== receipt.fingerprint) {
      throw changed();
    }
  }

  public assertRouteEligible(
    receipt: ProjectContextPrivacyReceipt,
    verifiedLocalEligible: boolean,
  ): void {
    if (receipt.requiresVerifiedLocal && !verifiedLocalEligible) {
      throw new ProjectContextPrivacyError(
        "PRIVATE_CHAPTER_LOCAL_ONLY",
        PROJECT_CONTEXT_LOCAL_ONLY_MESSAGE,
      );
    }
  }
}

export function projectContextRequiredDataDestination(
  receipt: ProjectContextPrivacyReceipt,
): "local" | undefined {
  return receipt.requiresVerifiedLocal ? "local" : undefined;
}

export function projectContextDispatchScope(
  receipt: ProjectContextPrivacyReceipt,
): NativeModelDispatchScope {
  return Object.freeze({ kind: "project_context", receipt });
}

function toAuthority(chapter: Chapter): ProjectContextChapterAuthority {
  return Object.freeze({
    chapterId: chapter.id,
    currentVersionId: chapter.currentVersionId,
    revision: chapter.revision,
    privacyRevision: chapter.privacyRevision,
    privacyMode: chapter.privacyMode,
    status: chapter.status,
  });
}

function toAuthorityFromMetadata(
  chapter: ChapterPrivacyAuthoritySnapshot,
): ProjectContextChapterAuthority {
  return Object.freeze({
    chapterId: chapter.chapterId,
    currentVersionId: chapter.currentVersionId,
    revision: chapter.chapterRevision,
    privacyRevision: chapter.privacyRevision,
    privacyMode: chapter.privacyMode,
    status: chapter.status,
  });
}

function unavailable(): ProjectContextPrivacyError {
  return new ProjectContextPrivacyError(
    "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
    "无法核对这个作品的本地隐私范围，因此没有调用 AI。请重试；若问题持续，请先检查本地数据库。",
    true,
  );
}

function changed(): ProjectContextPrivacyError {
  return new ProjectContextPrivacyError(
    "PROJECT_CONTEXT_PRIVACY_CHANGED",
    "作品的章节、版本或隐私设置在 AI 发送前发生了变化；本次请求在发送 0 字后停止。请重新运行。",
    true,
  );
}
