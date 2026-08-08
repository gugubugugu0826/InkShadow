import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import { beforeEach, describe, expect, it } from "vitest";

import { WritingFeedbackLearningService } from "./writing-feedback-learning-service";
import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  BrowserDevelopmentWritingFeedbackStore,
  SqliteWritingFeedbackStore,
  WritingFeedbackStoreError,
  type NewWritingFeedbackEvent,
  type WritingFeedbackCode,
} from "./writing-feedback-store";

const SQLITE_MIGRATIONS = [
  "0001_core.sql",
  "0035_writing_feedback_learning.sql",
  "0053_writing_feedback_learning_policy_context.sql",
  "0054_writing_feedback_explicit_idempotency.sql",
]
  .map(readMigration)
  .join("\n");

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  public get length(): number {
    return this.values.size;
  }
  public clear(): void {
    this.values.clear();
  }
  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  public removeItem(key: string): void {
    this.values.delete(key);
  }
  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FailNextWriteStorage extends MemoryStorage {
  private shouldFail = false;

  public failNextWrite(): void {
    this.shouldFail = true;
  }

  public override setItem(key: string, value: string): void {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated storage failure");
    }
    super.setItem(key, value);
  }
}

class FailNextPreferenceWriteExecutor implements SqlExecutor {
  private shouldFail = false;

  public constructor(private readonly delegate: NodeSqliteExecutor) {}

  public failNextPreferenceWrite(): void {
    this.shouldFail = true;
  }

  public select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues: readonly SqlPrimitive[] = []): Promise<ExecuteResult> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, bindValues: readonly SqlPrimitive[] = []) =>
          transaction.select<Row>(query, bindValues),
        execute: (query: string, bindValues: readonly SqlPrimitive[] = []) => {
          if (this.shouldFail && /INSERT INTO writing_preferences/iu.test(query)) {
            this.shouldFail = false;
            return Promise.reject(new Error("simulated preference write failure"));
          }
          return transaction.execute(query, bindValues);
        },
      }),
    );
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

const PROJECT_ID = "0198929e-845b-7a8a-9f12-1234567890ab";
const CHAPTER_ID = "0198929e-845b-7a8a-9f12-1234567890ac";
const CANDIDATE_ID = "0198929e-845b-7a8a-9f12-1234567890ad";

describe("writing feedback learning", () => {
  let store: BrowserDevelopmentWritingFeedbackStore;
  let service: WritingFeedbackLearningService;

  beforeEach(() => {
    store = new BrowserDevelopmentWritingFeedbackStore(new MemoryStorage());
    service = new WritingFeedbackLearningService(
      store,
      new CryptoUuidV7Generator(),
      new SystemClock(),
    );
  });

  it("records content-free candidate actions", async () => {
    await service.recordAction({
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      candidateId: CANDIDATE_ID,
      action: "partially_accepted",
      applicationStrategy: "apply_changes",
      acceptedChangeCount: 2,
      rejectedChangeCount: 1,
    });

    const events = await store.listEvents(PROJECT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "partially_accepted",
      learningEnabledAtEvent: true,
      acceptedChangeCount: 2,
      rejectedChangeCount: 1,
      customFeedback: null,
    });
    expect(JSON.stringify(events[0])).not.toContain("正文");
  });

  it("learns only after repeated explicit feedback and exposes the preference", async () => {
    const first = await service.recordExplicitFeedback({
      idempotencyKey: "more-dialogue-1",
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    expect(first.learnedPreference).toBeNull();

    const second = await service.recordExplicitFeedback({
      idempotencyKey: "more-dialogue-2",
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    expect(second.learnedPreference).toMatchObject({
      source: "feedback_pattern",
      evidenceCount: 2,
      enabled: true,
    });
    expect((await service.loadDashboard(PROJECT_ID)).preferences[0]?.preferenceText).toContain(
      "人物对话",
    );
  });

  it("can pause learning while retaining the explicit local event", async () => {
    let policy = await store.getPolicy(PROJECT_ID);
    policy = await service.setLearningEnabled(policy, false);
    expect(policy.learningEnabled).toBe(false);

    await service.recordExplicitFeedback({
      idempotencyKey: "paused-natural-dialogue-1",
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });
    await service.recordExplicitFeedback({
      idempotencyKey: "paused-natural-dialogue-2",
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });

    let dashboard = await service.loadDashboard(PROJECT_ID);
    expect(dashboard.preferences).toHaveLength(0);
    expect(dashboard.recentEvents).toHaveLength(2);
    expect(dashboard.recentEvents.every((event) => !event.learningEnabledAtEvent)).toBe(true);

    policy = await service.setLearningEnabled(policy, true);
    const firstEnabled = await service.recordExplicitFeedback({
      idempotencyKey: "enabled-natural-dialogue-1",
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });
    expect(firstEnabled.learnedPreference).toBeNull();
    const secondEnabled = await service.recordExplicitFeedback({
      idempotencyKey: "enabled-natural-dialogue-2",
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });
    expect(secondEnabled.learnedPreference).toMatchObject({ evidenceCount: 2 });
    dashboard = await service.loadDashboard(PROJECT_ID);
    expect(dashboard.preferences).toHaveLength(1);
  });

  it("normalizes and hashes repeated custom feedback into a visible editable preference", async () => {
    const first = await service.recordExplicitFeedback({
      idempotencyKey: "custom-feedback-1",
      projectId: PROJECT_ID,
      customFeedback: "  Avoid   summary endings  ",
    });
    expect(first.learnedPreference).toBeNull();
    const second = await service.recordExplicitFeedback({
      idempotencyKey: "custom-feedback-2",
      projectId: PROJECT_ID,
      customFeedback: "avoid summary endings",
    });

    expect(second.event.customFeedbackNormalizedHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.learnedPreference).toMatchObject({
      preferenceText: "avoid summary endings",
      sourceFeedbackCode: null,
      sourceFeedbackHash: second.event.customFeedbackNormalizedHash,
      evidenceCount: 2,
      enabled: true,
    });
    expect(JSON.stringify(second.event)).not.toContain("章节正文");
  });

  it("rejects 501-character custom feedback without recording or truncating it", async () => {
    await expect(
      service.recordExplicitFeedback({
        idempotencyKey: "oversized-custom-feedback",
        projectId: PROJECT_ID,
        customFeedback: "x".repeat(501),
      }),
    ).rejects.toMatchObject({ code: "WRITING_FEEDBACK_INVALID" });
    expect(await store.listEvents(PROJECT_ID)).toHaveLength(0);
  });

  it("reuses a stable explicit-feedback identity without double counting evidence", async () => {
    const first = await service.recordExplicitFeedback({
      idempotencyKey: "retry-safe-feedback-1",
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    const retriedFirst = await service.recordExplicitFeedback({
      idempotencyKey: "retry-safe-feedback-1",
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    expect(retriedFirst.event.id).toBe(first.event.id);
    expect(await store.listEvents(PROJECT_ID)).toHaveLength(1);

    const second = await service.recordExplicitFeedback({
      idempotencyKey: "retry-safe-feedback-2",
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    expect(second.learnedPreference).toMatchObject({ evidenceCount: 2, revision: 1 });
    const retriedSecond = await service.recordExplicitFeedback({
      idempotencyKey: "retry-safe-feedback-2",
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    expect(retriedSecond.event.id).toBe(second.event.id);
    expect(retriedSecond.learnedPreference).toMatchObject({ evidenceCount: 2, revision: 1 });
    expect(await store.listEvents(PROJECT_ID)).toHaveLength(2);
  });

  it("rolls back the event when the atomic preference write fails and permits retry", async () => {
    const storage = new FailNextWriteStorage();
    const atomicStore = new BrowserDevelopmentWritingFeedbackStore(storage);
    const atomicService = new WritingFeedbackLearningService(
      atomicStore,
      new CryptoUuidV7Generator(),
      new SystemClock(),
    );
    await atomicService.recordExplicitFeedback({
      idempotencyKey: "atomic-feedback-1",
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });
    storage.failNextWrite();
    await expect(
      atomicService.recordExplicitFeedback({
        idempotencyKey: "atomic-feedback-2",
        projectId: PROJECT_ID,
        feedbackCode: "natural_dialogue",
      }),
    ).rejects.toMatchObject({ code: "WRITING_FEEDBACK_UNAVAILABLE" });
    expect(await atomicStore.listEvents(PROJECT_ID)).toHaveLength(1);
    expect(await atomicStore.listPreferences(PROJECT_ID)).toHaveLength(0);

    const retry = await atomicService.recordExplicitFeedback({
      idempotencyKey: "atomic-feedback-2",
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });
    expect(retry.learnedPreference).toMatchObject({ evidenceCount: 2 });
    expect(await atomicStore.listEvents(PROJECT_ID)).toHaveLength(2);
  });

  it("rolls back the SQLite event and preference together when the preference write fails", async () => {
    const executor = new FailNextPreferenceWriteExecutor(new NodeSqliteExecutor(SQLITE_MIGRATIONS));
    const sqliteStore = new SqliteWritingFeedbackStore(executor);
    const sqliteService = new WritingFeedbackLearningService(
      sqliteStore,
      new CryptoUuidV7Generator(),
      new SystemClock(),
    );
    try {
      await executor.execute(
        `INSERT INTO projects (
           id, name, status, revision, deletion_generation, created_at, updated_at
         ) VALUES (?, 'Feedback atomicity', 'active', 1, 0, ?, ?)`,
        [PROJECT_ID, "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
      );
      await sqliteService.recordExplicitFeedback({
        idempotencyKey: "sqlite-atomic-feedback-1",
        projectId: PROJECT_ID,
        feedbackCode: "natural_dialogue",
      });
      executor.failNextPreferenceWrite();
      await expect(
        sqliteService.recordExplicitFeedback({
          idempotencyKey: "sqlite-atomic-feedback-2",
          projectId: PROJECT_ID,
          feedbackCode: "natural_dialogue",
        }),
      ).rejects.toMatchObject({ code: "WRITING_FEEDBACK_UNAVAILABLE" });
      expect(await sqliteStore.listEvents(PROJECT_ID)).toHaveLength(1);
      expect(await sqliteStore.listPreferences(PROJECT_ID)).toHaveLength(0);

      const retried = await sqliteService.recordExplicitFeedback({
        idempotencyKey: "sqlite-atomic-feedback-2",
        projectId: PROJECT_ID,
        feedbackCode: "natural_dialogue",
      });
      expect(retried.learnedPreference).toMatchObject({ evidenceCount: 2 });
      expect(await sqliteStore.listEvents(PROJECT_ID)).toHaveLength(2);
    } finally {
      await executor.close();
    }
  });

  it("supports editing, disabling, deleting, and clearing visible preferences", async () => {
    let manual = await service.addManualPreference(PROJECT_ID, "不要使用网络流行语。 ");
    expect(manual.preferenceText).toBe("不要使用网络流行语。");
    manual = await service.editPreference(manual, "避免网络流行语和总结式结尾。");
    manual = await service.setPreferenceEnabled(manual, false);
    expect(manual).toMatchObject({ revision: 3, enabled: false });
    await service.deletePreference(manual);
    expect((await store.listPreferences(PROJECT_ID)).length).toBe(0);

    await service.addManualPreference(PROJECT_ID, "偏好短句。");
    await service.addManualPreference(PROJECT_ID, "增加对话。");
    expect(await service.clearPreferences(PROJECT_ID)).toBe(2);
    expect(await store.listPreferences(PROJECT_ID)).toHaveLength(0);
  });

  it("uses compare-and-swap when toggling policy", async () => {
    const initial = await store.getPolicy(PROJECT_ID);
    await service.setLearningEnabled(initial, false);
    await expect(service.setLearningEnabled(initial, false)).rejects.toBeInstanceOf(
      WritingFeedbackStoreError,
    );
  });

  it("counts the full enabled event ledger beyond the recent 500-event dashboard window", async () => {
    const ids = new CryptoUuidV7Generator();
    const now = new SystemClock().now();
    for (let index = 0; index < 510; index += 1) {
      await store.recordEvent(explicitCodeEvent(ids.next(), "more_dialogue", now));
    }
    const first = await store.synchronizeLearnedPreference({
      id: ids.next(),
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
      preferenceText: "增加人物对话。",
      evidenceThreshold: 2,
      now,
    });
    expect(first?.evidenceCount).toBe(510);

    for (let index = 0; index < 10; index += 1) {
      await store.recordEvent(explicitCodeEvent(ids.next(), "more_dialogue", now));
    }
    const updated = await store.synchronizeLearnedPreference({
      id: ids.next(),
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
      preferenceText: "增加人物对话。",
      evidenceThreshold: 2,
      now,
    });
    expect(updated?.evidenceCount).toBe(520);
  });

  it("converges two windows racing to create the same learned preference", async () => {
    const ids = new CryptoUuidV7Generator();
    const now = new SystemClock().now();
    await store.recordEvent(explicitCodeEvent(ids.next(), "natural_dialogue", now));
    await store.recordEvent(explicitCodeEvent(ids.next(), "natural_dialogue", now));

    const [left, right] = await Promise.all([
      store.synchronizeLearnedPreference({
        id: ids.next(),
        projectId: PROJECT_ID,
        feedbackCode: "natural_dialogue",
        preferenceText: "让对话更自然。",
        evidenceThreshold: 2,
        now,
      }),
      store.synchronizeLearnedPreference({
        id: ids.next(),
        projectId: PROJECT_ID,
        feedbackCode: "natural_dialogue",
        preferenceText: "让对话更自然。",
        evidenceThreshold: 2,
        now,
      }),
    ]);

    expect(left?.id).toBe(right?.id);
    expect(await store.listPreferences(PROJECT_ID)).toHaveLength(1);
  });
});

function explicitCodeEvent(
  id: string,
  feedbackCode: WritingFeedbackCode,
  createdAt: string,
): NewWritingFeedbackEvent {
  return Object.freeze({
    id,
    projectId: PROJECT_ID,
    chapterId: null,
    candidateId: null,
    action: "explicit_feedback",
    feedbackCode,
    customFeedback: null,
    customFeedbackNormalizedHash: null,
    idempotencyKey: null,
    applicationStrategy: null,
    acceptedChangeCount: null,
    rejectedChangeCount: null,
    createdAt,
  });
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
