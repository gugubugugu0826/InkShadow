import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import { beforeEach, describe, expect, it } from "vitest";

import { WritingFeedbackLearningService } from "./writing-feedback-learning-service";
import {
  BrowserDevelopmentWritingFeedbackStore,
  WritingFeedbackStoreError,
} from "./writing-feedback-store";

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
      acceptedChangeCount: 2,
      rejectedChangeCount: 1,
      customFeedback: null,
    });
    expect(JSON.stringify(events[0])).not.toContain("正文");
  });

  it("learns only after repeated explicit feedback and exposes the preference", async () => {
    const first = await service.recordExplicitFeedback({
      projectId: PROJECT_ID,
      feedbackCode: "more_dialogue",
    });
    expect(first.learnedPreference).toBeNull();

    const second = await service.recordExplicitFeedback({
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
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });
    await service.recordExplicitFeedback({
      projectId: PROJECT_ID,
      feedbackCode: "natural_dialogue",
    });

    const dashboard = await service.loadDashboard(PROJECT_ID);
    expect(dashboard.preferences).toHaveLength(0);
    expect(dashboard.recentEvents).toHaveLength(2);
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
});
