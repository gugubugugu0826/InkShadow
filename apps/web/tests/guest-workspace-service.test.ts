import { describe, expect, it } from "vitest";

import { GuestWorkspaceService } from "../src/application/guest-workspace-service";
import type {
  CipherEnvelopeV1,
  EncryptedGuestProjectRecordV1,
} from "../src/contracts/encrypted-guest-project";
import type { EncryptedGuestDraftRecordV1 } from "../src/contracts/encrypted-guest-draft";
import type { EncryptedProjectStore } from "../src/ports/encrypted-project-store";
import { MemoryEncryptedProjectStore } from "./helpers/memory-encrypted-project-store";

const PROJECT_NAME_CANARY = "PLAINTEXT_PROJECT_CANARY_9a0f";
const ORIGINAL_BODY_CANARY = "PLAINTEXT_BODY_CANARY_1f54：风吹过没有名字的港口。";
const UPDATED_BODY_CANARY = "PLAINTEXT_BODY_CANARY_f7b2：她终于拆开那封信。";

describe("encrypted Guest workspace integration", () => {
  it("does not persist a prepared project until recovery material is confirmed", async () => {
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const prepared = await service.prepareEncryptedProject({
      projectName: "两阶段提交",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });

    expect(await store.list()).toHaveLength(0);
    expect(service.isUnlocked(prepared.session.project.id)).toBe(false);

    const committed = await service.commitPreparedProject(prepared.session.project.id);
    expect(committed.chapter.content).toBe(ORIGINAL_BODY_CANARY);
    expect(await store.list()).toHaveLength(1);
    expect(service.isUnlocked(prepared.session.project.id)).toBe(true);
  });

  it("drops a prepared key and record when the page session is locked", async () => {
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const prepared = await service.prepareEncryptedProject({
      projectName: "不留孤儿密文",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });

    service.lockAll();

    await expect(service.commitPreparedProject(prepared.session.project.id)).rejects.toMatchObject({
      code: "WEB_PROJECT_LOCKED",
    });
    expect(await store.list()).toHaveLength(0);
    expect(service.isUnlocked(prepared.session.project.id)).toBe(false);
  });

  it("persists only ciphertext, never recovery material or Web Storage keys", async () => {
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: PROJECT_NAME_CANARY,
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const serialized = JSON.stringify(store.inspect(created.session.project.id));

    expect(serialized).not.toContain(PROJECT_NAME_CANARY);
    expect(serialized).not.toContain("第一章");
    expect(serialized).not.toContain(ORIGINAL_BODY_CANARY);
    expect(serialized).not.toContain(created.recoveryMaterial);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(created.session.chapter.content).toBe(ORIGINAL_BODY_CANARY);
  });

  it("recovers a ciphertext-only temporary draft after locking and clears it after commit", async () => {
    const store = new MemoryEncryptedProjectStore();
    const firstPage = new GuestWorkspaceService(store);
    const created = await firstPage.createEncryptedProject({
      projectName: "临时草稿恢复",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });

    await firstPage.preserveTemporaryDraft({
      projectId: created.session.project.id,
      expectedRevision: created.session.chapter.revision,
      content: UPDATED_BODY_CANARY,
    });
    const encryptedDraft = store.inspectTemporaryDraft(created.session.project.id);
    expect(encryptedDraft).not.toBeNull();
    const serializedDraft = JSON.stringify(encryptedDraft);
    expect(serializedDraft).not.toContain(UPDATED_BODY_CANARY);
    expect(serializedDraft).not.toContain(created.recoveryMaterial);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);

    firstPage.lockAll();
    const nextPage = new GuestWorkspaceService(store);
    const unlocked = await nextPage.unlockProject(
      created.session.project.id,
      created.recoveryMaterial,
    );
    expect(unlocked.chapter.content).toBe(ORIGINAL_BODY_CANARY);
    expect(unlocked.recoveredDraft).toEqual({
      baseRevision: 1,
      content: UPDATED_BODY_CANARY,
    });

    const saved = await nextPage.saveChapter({
      projectId: created.session.project.id,
      expectedRevision: unlocked.chapter.revision,
      content: unlocked.recoveredDraft?.content ?? "",
    });
    expect(saved.chapter.content).toBe(UPDATED_BODY_CANARY);
    expect(store.inspectTemporaryDraft(created.session.project.id)).toBeNull();

    nextPage.lockAll();
    const finalPage = new GuestWorkspaceService(store);
    const finalUnlock = await finalPage.unlockProject(
      created.session.project.id,
      created.recoveryMaterial,
    );
    expect(finalUnlock.chapter.content).toBe(UPDATED_BODY_CANARY);
    expect(finalUnlock.recoveredDraft).toBeUndefined();
  });

  it("appends unique encrypted chapter versions and locks a fresh page session", async () => {
    const store = new MemoryEncryptedProjectStore();
    const firstPage = new GuestWorkspaceService(store);
    const created = await firstPage.createEncryptedProject({
      projectName: "雾港来信",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const saved = await firstPage.saveChapter({
      projectId: created.session.project.id,
      expectedRevision: 1,
      content: UPDATED_BODY_CANARY,
    });
    const record = store.inspect(created.session.project.id);

    expect(saved.chapter.revision).toBe(2);
    expect(record.chapterEnvelopes).toHaveLength(2);
    expect(record.chapterEnvelopes[0]?.nonce).not.toBe(record.chapterEnvelopes[1]?.nonce);
    expect(JSON.stringify(record)).not.toContain(UPDATED_BODY_CANARY);

    const refreshedPage = new GuestWorkspaceService(store);
    expect(refreshedPage.isUnlocked(created.session.project.id)).toBe(false);
    await expect(
      refreshedPage.saveChapter({
        projectId: created.session.project.id,
        expectedRevision: 2,
        content: "must stay locked",
      }),
    ).rejects.toMatchObject({ code: "WEB_PROJECT_LOCKED" });

    await expect(
      refreshedPage.unlockProject(
        created.session.project.id,
        flipBase64UrlCharacter(created.recoveryMaterial),
      ),
    ).rejects.toMatchObject({ code: "WEB_UNLOCK_FAILED" });
    expect(refreshedPage.isUnlocked(created.session.project.id)).toBe(false);

    const unlocked = await refreshedPage.unlockProject(
      created.session.project.id,
      created.recoveryMaterial,
    );
    expect(unlocked.chapter.content).toBe(UPDATED_BODY_CANARY);
    expect(refreshedPage.isUnlocked(created.session.project.id)).toBe(true);
  });

  it("rejects a tampered persisted envelope without exposing plaintext", async () => {
    const store = new MemoryEncryptedProjectStore();
    const creator = new GuestWorkspaceService(store);
    const created = await creator.createEncryptedProject({
      projectName: "密文完整性",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const record = store.inspect(created.session.project.id);
    const latest = record.chapterEnvelopes.at(-1);
    if (latest === undefined) {
      throw new Error("Test chapter envelope is missing.");
    }
    store.replaceForTest({
      ...record,
      chapterEnvelopes: [
        {
          ...latest,
          ciphertext: flipBase64UrlCharacter(latest.ciphertext),
        },
      ],
    });

    const refreshed = new GuestWorkspaceService(store);
    await expect(
      refreshed.unlockProject(created.session.project.id, created.recoveryMaterial),
    ).rejects.toMatchObject({ code: "WEB_UNLOCK_FAILED" });
    expect(refreshed.isUnlocked(created.session.project.id)).toBe(false);
  });

  it("allows exactly one concurrent writer for the same expected chapter revision", async () => {
    const store = new MemoryEncryptedProjectStore();
    const firstPage = new GuestWorkspaceService(store);
    const created = await firstPage.createEncryptedProject({
      projectName: "并发密文版本",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const secondPage = new GuestWorkspaceService(store);
    await secondPage.unlockProject(created.session.project.id, created.recoveryMaterial);

    const outcomes = await Promise.allSettled([
      firstPage.saveChapter({
        projectId: created.session.project.id,
        expectedRevision: 1,
        content: "并发写入 A",
      }),
      secondPage.saveChapter({
        projectId: created.session.project.id,
        expectedRevision: 1,
        content: "并发写入 B",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "WEB_REVISION_CONFLICT" },
    });
    expect(store.inspect(created.session.project.id).chapterEnvelopes).toHaveLength(2);
  });

  it("rejects a persisted record that reuses an AES-GCM nonce", async () => {
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "nonce 完整性",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const record = store.inspect(created.session.project.id);
    const chapterEnvelope = record.chapterEnvelopes[0];
    if (chapterEnvelope === undefined) {
      throw new Error("Test chapter envelope is missing.");
    }
    store.replaceForTest({
      ...record,
      projectEnvelope: {
        ...record.projectEnvelope,
        nonce: chapterEnvelope.nonce,
      },
    });

    await expect(service.listEncryptedProjects()).rejects.toMatchObject({
      code: "WEB_ENVELOPE_INVALID",
    });
  });

  it("does not let an in-flight unlock restore a key after the page locks", async () => {
    const stored = new MemoryEncryptedProjectStore();
    const creator = new GuestWorkspaceService(stored);
    const created = await creator.createEncryptedProject({
      projectName: "异步锁定栅栏",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const delayedStore = new DelayedGetEncryptedProjectStore(stored);
    const unlockingPage = new GuestWorkspaceService(delayedStore);

    const unlock = unlockingPage.unlockProject(
      created.session.project.id,
      created.recoveryMaterial,
    );
    await delayedStore.waitUntilGetStarts();
    unlockingPage.lockAll();
    delayedStore.releaseGet();

    await expect(unlock).rejects.toMatchObject({ code: "WEB_UNLOCK_FAILED" });
    expect(unlockingPage.isUnlocked(created.session.project.id)).toBe(false);
  });

  it("imports a validated encrypted backup only when its recovery material matches", async () => {
    const sourceStore = new MemoryEncryptedProjectStore();
    const source = new GuestWorkspaceService(sourceStore);
    const created = await source.createEncryptedProject({
      projectName: "离线恢复闭环",
      chapterTitle: "归航",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const backup = await source.exportEncryptedProject(created.session.project.id);

    const restoredStore = new MemoryEncryptedProjectStore();
    const restoredPage = new GuestWorkspaceService(restoredStore);
    const restored = await restoredPage.importEncryptedProject(backup, created.recoveryMaterial);

    expect(restored.project.name).toBe("离线恢复闭环");
    expect(restored.chapter.title).toBe("归航");
    expect(restored.chapter.content).toBe(ORIGINAL_BODY_CANARY);
    expect(restoredPage.isUnlocked(created.session.project.id)).toBe(true);
    expect(await restoredStore.list()).toHaveLength(1);
    expect(JSON.stringify(restoredStore.inspect(created.session.project.id))).not.toContain(
      ORIGINAL_BODY_CANARY,
    );
  });

  it("rejects invalid, mismatched and tampered imports without persisting a record", async () => {
    const source = new GuestWorkspaceService(new MemoryEncryptedProjectStore());
    const created = await source.createEncryptedProject({
      projectName: "拒绝损坏备份",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const backup = await source.exportEncryptedProject(created.session.project.id);
    const parsed = JSON.parse(backup) as EncryptedGuestProjectRecordV1;
    const latest = parsed.chapterEnvelopes.at(-1);
    if (latest === undefined) {
      throw new Error("Test chapter envelope is missing.");
    }
    const tampered = JSON.stringify({
      ...parsed,
      chapterEnvelopes: [
        ...parsed.chapterEnvelopes.slice(0, -1),
        {
          ...latest,
          ciphertext: flipBase64UrlCharacter(latest.ciphertext),
        },
      ],
    });

    const store = new MemoryEncryptedProjectStore();
    const importer = new GuestWorkspaceService(store);
    await expect(
      importer.importEncryptedProject("{not-json", created.recoveryMaterial),
    ).rejects.toMatchObject({ code: "WEB_ENVELOPE_INVALID" });
    await expect(
      importer.importEncryptedProject(backup, flipBase64UrlCharacter(created.recoveryMaterial)),
    ).rejects.toMatchObject({ code: "WEB_UNLOCK_FAILED" });
    await expect(
      importer.importEncryptedProject(tampered, created.recoveryMaterial),
    ).rejects.toMatchObject({ code: "WEB_UNLOCK_FAILED" });

    expect(await store.list()).toHaveLength(0);
    expect(importer.isUnlocked(created.session.project.id)).toBe(false);
  });

  it("rejects importing a duplicate project identifier without replacing existing ciphertext", async () => {
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "重复导入",
      chapterTitle: "第一章",
      chapterContent: ORIGINAL_BODY_CANARY,
    });
    const original = store.inspect(created.session.project.id);
    const backup = await service.exportEncryptedProject(created.session.project.id);
    service.lockAll();

    await expect(
      service.importEncryptedProject(backup, created.recoveryMaterial),
    ).rejects.toMatchObject({ code: "WEB_PROJECT_ALREADY_EXISTS" });

    expect(await store.list()).toHaveLength(1);
    expect(store.inspect(created.session.project.id)).toEqual(original);
    expect(service.isUnlocked(created.session.project.id)).toBe(false);
  });
});

function flipBase64UrlCharacter(value: string): string {
  const first = value[0];
  if (first === undefined) {
    throw new Error("Test value must not be empty.");
  }
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

class DelayedGetEncryptedProjectStore implements EncryptedProjectStore {
  readonly #getStarted = deferredSignal();
  readonly #release = deferredSignal();

  public constructor(private readonly delegate: EncryptedProjectStore) {}

  public list(): Promise<readonly EncryptedGuestProjectRecordV1[]> {
    return this.delegate.list();
  }

  public async get(projectId: string): Promise<EncryptedGuestProjectRecordV1 | null> {
    this.#getStarted.resolve();
    await this.#release.promise;
    return this.delegate.get(projectId);
  }

  public create(record: EncryptedGuestProjectRecordV1): Promise<void> {
    return this.delegate.create(record);
  }

  public appendChapter(
    projectId: string,
    expectedContentVersion: number,
    envelope: CipherEnvelopeV1,
  ): Promise<void> {
    return this.delegate.appendChapter(projectId, expectedContentVersion, envelope);
  }

  public getTemporaryDraft(projectId: string): Promise<EncryptedGuestDraftRecordV1 | null> {
    return this.delegate.getTemporaryDraft(projectId);
  }

  public putTemporaryDraft(record: EncryptedGuestDraftRecordV1): Promise<void> {
    return this.delegate.putTemporaryDraft(record);
  }

  public deleteTemporaryDraft(projectId: string): Promise<void> {
    return this.delegate.deleteTemporaryDraft(projectId);
  }

  public waitUntilGetStarts(): Promise<void> {
    return this.#getStarted.promise;
  }

  public releaseGet(): void {
    this.#release.resolve();
  }
}

function deferredSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
