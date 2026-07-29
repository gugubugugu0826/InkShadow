import {
  Chapter,
  Project,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type ChapterSnapshot,
  type IsoUtcTimestamp,
  type ProjectSnapshot,
  type UuidV7,
} from "@inkshadow/domain";
import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";

import {
  WEB_GUEST_RECORD_FORMAT,
  WEB_GUEST_RECORD_SCHEMA_VERSION,
  parseEncryptedGuestProjectRecord,
  type EncryptedGuestProjectRecordV1,
  type EnvelopeBinding,
} from "../contracts/encrypted-guest-project";
import { GuestWorkspaceError } from "../domain/guest-workspace-error";
import { SessionProjectKeyring } from "../infrastructure/session-project-keyring";
import { WebCryptoEnvelopeService } from "../infrastructure/web-crypto-envelope-service";
import type { EncryptedProjectStore } from "../ports/encrypted-project-store";

export interface GuestEncryptedProjectDescriptor {
  readonly projectId: UuidV7;
  readonly keyVersion: number;
  readonly chapterVersion: number;
}

export interface GuestProjectSession {
  readonly project: Project;
  readonly chapter: Chapter;
}

export interface CreateEncryptedGuestProjectInput {
  readonly projectName: string;
  readonly chapterTitle: string;
  readonly chapterContent: string;
}

export interface CreateEncryptedGuestProjectOutcome {
  readonly session: GuestProjectSession;
  readonly recoveryMaterial: string;
}

interface PendingEncryptedGuestProject {
  readonly record: EncryptedGuestProjectRecordV1;
  readonly projectKey: CryptoKey;
  readonly session: GuestProjectSession;
}

export interface SaveEncryptedGuestChapterInput {
  readonly projectId: UuidV7;
  readonly expectedRevision: number;
  readonly content: string;
}

export class GuestWorkspaceService {
  readonly #pendingCreations = new Map<UuidV7, PendingEncryptedGuestProject>();
  #sessionEpoch = 0;

  public constructor(
    private readonly store: EncryptedProjectStore,
    private readonly envelopes = new WebCryptoEnvelopeService(),
    private readonly keyring = new SessionProjectKeyring(),
    private readonly ids = new CryptoUuidV7Generator(),
    private readonly clock = new SystemClock(),
  ) {}

  public async listEncryptedProjects(): Promise<readonly GuestEncryptedProjectDescriptor[]> {
    const records = await this.store.list();
    return records
      .map((record) => {
        const latest = record.chapterEnvelopes.at(-1);
        if (latest === undefined) {
          throw new GuestWorkspaceError("WEB_ENVELOPE_INVALID", "加密项目没有可恢复的章节版本。");
        }
        return {
          projectId: record.projectId,
          keyVersion: record.keyVersion,
          chapterVersion: latest.contentVersion,
        };
      })
      .sort((left, right) => right.projectId.localeCompare(left.projectId));
  }

  public async createEncryptedProject(
    input: CreateEncryptedGuestProjectInput,
  ): Promise<CreateEncryptedGuestProjectOutcome> {
    const prepared = await this.prepareEncryptedProject(input);
    try {
      await this.commitPreparedProject(prepared.session.project.id);
      return prepared;
    } catch (error) {
      this.discardPreparedProject(prepared.session.project.id);
      throw error;
    }
  }

  /**
   * Builds the encrypted record without persisting it. The UI can show the
   * one-time recovery material first and only commit after the user confirms
   * that it has been saved outside the browser.
   */
  public async prepareEncryptedProject(
    input: CreateEncryptedGuestProjectInput,
  ): Promise<CreateEncryptedGuestProjectOutcome> {
    const operationEpoch = this.#sessionEpoch;
    const now = this.clock.now();
    const projectId = this.ids.next();
    const chapterId = this.ids.next();
    const versionId = this.ids.next();
    const projectResult = Project.create({
      id: projectId,
      name: input.projectName,
      now,
    });
    if (!projectResult.ok) {
      throw new GuestWorkspaceError("WEB_VALIDATION_FAILED", "项目名称需包含 1–120 个可见字符。");
    }
    const chapterResult = Chapter.create({
      id: chapterId,
      projectId,
      title: input.chapterTitle,
      content: input.chapterContent,
      initialVersionId: versionId,
      now,
    });
    if (!chapterResult.ok) {
      throw new GuestWorkspaceError("WEB_VALIDATION_FAILED", "请检查章节标题和正文长度后重试。");
    }

    const keyVersion = 1;
    const createdKey = await this.envelopes.createProjectKey(projectId, keyVersion);
    try {
      const projectEnvelope = await this.envelopes.encryptJson(
        createdKey.projectKey,
        projectBinding(projectId, keyVersion),
        projectResult.value.toSnapshot(),
      );
      const chapterEnvelope = await this.envelopes.encryptJson(
        createdKey.projectKey,
        chapterBinding(projectId, chapterId, keyVersion, 1),
        chapterResult.value.toSnapshot(),
      );
      const record = parseEncryptedGuestProjectRecord({
        format: WEB_GUEST_RECORD_FORMAT,
        schemaVersion: WEB_GUEST_RECORD_SCHEMA_VERSION,
        projectId,
        keyVersion,
        recovery: createdKey.recovery,
        projectEnvelope,
        chapterEnvelopes: [chapterEnvelope],
      });

      this.assertOperationEpoch(operationEpoch);
      const session = {
        project: projectResult.value,
        chapter: chapterResult.value,
      };
      this.#pendingCreations.set(projectId, {
        record,
        projectKey: createdKey.projectKey,
        session,
      });
      return {
        session,
        recoveryMaterial: createdKey.recoveryMaterial,
      };
    } catch (error) {
      this.#pendingCreations.delete(projectId);
      this.keyring.delete(projectId);
      throw error;
    }
  }

  public async commitPreparedProject(projectId: UuidV7): Promise<GuestProjectSession> {
    const operationEpoch = this.#sessionEpoch;
    const pending = this.#pendingCreations.get(projectId);
    if (pending === undefined) {
      throw new GuestWorkspaceError(
        "WEB_PROJECT_LOCKED",
        "待保存的项目已因页面锁定而清除，请重新创建。",
      );
    }

    await this.store.create(pending.record);
    this.assertOperationEpoch(operationEpoch);
    this.keyring.set(projectId, pending.projectKey);
    this.#pendingCreations.delete(projectId);
    return pending.session;
  }

  public discardPreparedProject(projectId: UuidV7): void {
    this.#sessionEpoch += 1;
    this.#pendingCreations.delete(projectId);
    this.keyring.delete(projectId);
  }

  public async unlockProject(
    projectId: UuidV7,
    recoveryMaterial: string,
  ): Promise<GuestProjectSession> {
    const operationEpoch = this.#sessionEpoch;
    const record = await this.requireRecord(projectId);
    try {
      const projectKey = await this.envelopes.unlockProjectKey(
        projectId,
        record.keyVersion,
        record.recovery,
        recoveryMaterial,
      );
      const session = await this.decryptSession(record, projectKey);
      this.assertOperationEpoch(operationEpoch);
      this.keyring.set(projectId, projectKey);
      return session;
    } catch {
      this.keyring.delete(projectId);
      throw new GuestWorkspaceError(
        "WEB_UNLOCK_FAILED",
        "恢复材料错误，或浏览器密文已损坏。项目保持锁定；请核对完整恢复材料后重试。",
      );
    }
  }

  public async saveChapter(input: SaveEncryptedGuestChapterInput): Promise<GuestProjectSession> {
    const operationEpoch = this.#sessionEpoch;
    const projectKey = this.keyring.get(input.projectId);
    const record = await this.requireRecord(input.projectId);
    const session = await this.decryptSession(record, projectKey);
    if (session.chapter.revision !== input.expectedRevision) {
      throw new GuestWorkspaceError(
        "WEB_REVISION_CONFLICT",
        "章节已出现新版本。请锁定后重新解锁，再确认内容。",
        true,
      );
    }

    const saved = session.chapter.saveContent({
      content: input.content,
      expectedRevision: input.expectedRevision,
      newVersionId: this.ids.next(),
      now: this.clock.now(),
    });
    if (!saved.ok) {
      throw new GuestWorkspaceError(
        "WEB_VALIDATION_FAILED",
        saved.error.code === "NO_CHANGES"
          ? "正文没有变化，无需保存。"
          : "正文过长或包含无效内容，未保存。",
      );
    }

    const envelope = await this.envelopes.encryptJson(
      projectKey,
      chapterBinding(input.projectId, saved.value.id, record.keyVersion, saved.value.revision),
      saved.value.toSnapshot(),
    );
    await this.store.appendChapter(input.projectId, input.expectedRevision, envelope);
    this.assertOperationEpoch(operationEpoch);

    return {
      project: session.project,
      chapter: saved.value,
    };
  }

  public async exportEncryptedProject(projectId: UuidV7): Promise<string> {
    const record = await this.requireRecord(projectId);
    return JSON.stringify(record, null, 2);
  }

  public lock(projectId: UuidV7): void {
    this.#sessionEpoch += 1;
    this.#pendingCreations.delete(projectId);
    this.keyring.delete(projectId);
  }

  public lockAll(): void {
    this.#sessionEpoch += 1;
    this.#pendingCreations.clear();
    this.keyring.clear();
  }

  public isUnlocked(projectId: UuidV7): boolean {
    return this.keyring.has(projectId);
  }

  private async decryptSession(
    record: EncryptedGuestProjectRecordV1,
    projectKey: CryptoKey,
  ): Promise<GuestProjectSession> {
    const latestChapter = record.chapterEnvelopes.at(-1);
    if (latestChapter === undefined) {
      throw new GuestWorkspaceError("WEB_ENVELOPE_INVALID", "加密项目没有可恢复的章节版本。");
    }
    const projectValue = await this.envelopes.decryptJson(
      projectKey,
      record.projectEnvelope,
      projectBinding(record.projectId, record.keyVersion),
    );
    const chapterValue = await this.envelopes.decryptJson(
      projectKey,
      latestChapter,
      chapterBinding(
        record.projectId,
        latestChapter.objectId,
        record.keyVersion,
        latestChapter.contentVersion,
      ),
    );
    const project = rehydrateProject(projectValue, record.projectId);
    const chapter = rehydrateChapter(
      chapterValue,
      record.projectId,
      latestChapter.objectId,
      latestChapter.contentVersion,
    );
    return { project, chapter };
  }

  private async requireRecord(projectId: UuidV7): Promise<EncryptedGuestProjectRecordV1> {
    const record = await this.store.get(projectId);
    if (record === null) {
      throw new GuestWorkspaceError("WEB_PROJECT_NOT_FOUND", "当前浏览器中没有这个加密项目。");
    }
    return record;
  }

  private assertOperationEpoch(expectedEpoch: number): void {
    if (this.#sessionEpoch !== expectedEpoch) {
      throw new GuestWorkspaceError(
        "WEB_PROJECT_LOCKED",
        "页面已进入安全锁定状态；本次操作未重新载入明文或项目密钥。",
      );
    }
  }
}

function projectBinding(projectId: UuidV7, keyVersion: number): EnvelopeBinding {
  return {
    projectId,
    objectType: "project",
    objectId: projectId,
    keyVersion,
    contentVersion: 1,
  };
}

function chapterBinding(
  projectId: UuidV7,
  chapterId: UuidV7,
  keyVersion: number,
  contentVersion: number,
): EnvelopeBinding {
  return {
    projectId,
    objectType: "chapter",
    objectId: chapterId,
    keyVersion,
    contentVersion,
  };
}

function rehydrateProject(value: unknown, expectedProjectId: UuidV7): Project {
  if (!isProjectSnapshot(value)) {
    throw invalidDecryptedPayload();
  }
  const project = Project.rehydrate(value);
  if (!project.ok || project.value.id !== expectedProjectId || project.value.status !== "active") {
    throw invalidDecryptedPayload();
  }
  return project.value;
}

function rehydrateChapter(
  value: unknown,
  expectedProjectId: UuidV7,
  expectedChapterId: UuidV7,
  expectedRevision: number,
): Chapter {
  if (!isChapterSnapshot(value)) {
    throw invalidDecryptedPayload();
  }
  const chapter = Chapter.rehydrate(value);
  if (
    !chapter.ok ||
    chapter.value.id !== expectedChapterId ||
    chapter.value.projectId !== expectedProjectId ||
    chapter.value.revision !== expectedRevision ||
    chapter.value.status !== "active"
  ) {
    throw invalidDecryptedPayload();
  }
  return chapter.value;
}

function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isUuid(value.id) &&
    typeof value.name === "string" &&
    (value.status === "active" || value.status === "archived" || value.status === "trashed") &&
    isPositiveInteger(value.revision) &&
    isNonNegativeInteger(value.deletionGeneration) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.archivedAt) &&
    isNullableTimestamp(value.trashedAt) &&
    isNullableTimestamp(value.retentionUntil) &&
    (value.statusBeforeTrash === null ||
      value.statusBeforeTrash === "active" ||
      value.statusBeforeTrash === "archived")
  );
}

function isChapterSnapshot(value: unknown): value is ChapterSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isUuid(value.id) &&
    isUuid(value.projectId) &&
    typeof value.title === "string" &&
    typeof value.content === "string" &&
    (value.status === "active" || value.status === "trashed") &&
    isPositiveInteger(value.revision) &&
    isUuid(value.currentVersionId) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.trashedAt)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is UuidV7 {
  return typeof value === "string" && parseUuidV7(value).ok;
}

function isTimestamp(value: unknown): value is IsoUtcTimestamp {
  return typeof value === "string" && parseIsoUtcTimestamp(value).ok;
}

function isNullableTimestamp(value: unknown): value is IsoUtcTimestamp | null {
  return value === null || isTimestamp(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidDecryptedPayload(): GuestWorkspaceError {
  return new GuestWorkspaceError(
    "WEB_ENVELOPE_INVALID",
    "解密内容未通过项目领域校验，未载入任何正文。",
  );
}
