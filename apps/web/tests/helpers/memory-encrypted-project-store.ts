import {
  appendChapterEnvelope,
  parseEncryptedGuestProjectRecord,
  type CipherEnvelopeV1,
  type EncryptedGuestProjectRecordV1,
} from "../../src/contracts/encrypted-guest-project";
import { GuestWorkspaceError } from "../../src/domain/guest-workspace-error";
import type { EncryptedProjectStore } from "../../src/ports/encrypted-project-store";

export class MemoryEncryptedProjectStore implements EncryptedProjectStore {
  readonly #records = new Map<string, EncryptedGuestProjectRecordV1>();

  public list(): Promise<readonly EncryptedGuestProjectRecordV1[]> {
    return Promise.resolve([...this.#records.values()].map(cloneRecord));
  }

  public get(projectId: string): Promise<EncryptedGuestProjectRecordV1 | null> {
    const record = this.#records.get(projectId);
    return Promise.resolve(record === undefined ? null : cloneRecord(record));
  }

  public create(record: EncryptedGuestProjectRecordV1): Promise<void> {
    if (this.#records.has(record.projectId)) {
      return Promise.reject(
        new GuestWorkspaceError("WEB_PROJECT_ALREADY_EXISTS", "这个加密项目已存在于当前浏览器。"),
      );
    }
    this.#records.set(record.projectId, cloneRecord(record));
    return Promise.resolve();
  }

  public appendChapter(
    projectId: string,
    expectedContentVersion: number,
    envelope: CipherEnvelopeV1,
  ): Promise<void> {
    const record = this.#records.get(projectId);
    if (record === undefined) {
      return Promise.reject(
        new GuestWorkspaceError("WEB_PROJECT_NOT_FOUND", "当前浏览器中没有这个加密项目。"),
      );
    }
    this.#records.set(
      projectId,
      cloneRecord(appendChapterEnvelope(record, expectedContentVersion, envelope)),
    );
    return Promise.resolve();
  }

  public inspect(projectId: string): EncryptedGuestProjectRecordV1 {
    const record = this.#records.get(projectId);
    if (record === undefined) {
      throw new Error("Test project record is missing.");
    }
    return cloneRecord(record);
  }

  public replaceForTest(record: EncryptedGuestProjectRecordV1): void {
    this.#records.set(record.projectId, structuredClone(record));
  }
}

function cloneRecord(record: EncryptedGuestProjectRecordV1): EncryptedGuestProjectRecordV1 {
  return parseEncryptedGuestProjectRecord(structuredClone(record));
}
