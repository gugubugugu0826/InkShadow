/* eslint-disable @typescript-eslint/require-await -- synchronous in-memory fake port */
import {
  NOVEL_SKILL_EVALUATION_METRICS,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import { describe, expect, it } from "vitest";

import {
  NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_COUNT,
  NovelSkillPaidBlindReviewService,
  type NovelSkillPaidBlindReviewPort,
  type NovelSkillPaidBlindReviewScores,
  type NovelSkillPaidBlindReviewSourceItem,
  type PersistNovelSkillPaidBlindReviewScoresInput,
} from "./novel-skill-paid-blind-review-service";

const BATCH_ID = "blind-review-batch";

class FakeBlindReviewPort implements NovelSkillPaidBlindReviewPort {
  public readonly items: NovelSkillPaidBlindReviewSourceItem[] = fixedBlindItems();
  public readonly submissions: PersistNovelSkillPaidBlindReviewScoresInput[] = [];
  private readonly scored = new Set<string>();

  public async readBatchItems(
    batchId: string,
  ): Promise<readonly NovelSkillPaidBlindReviewSourceItem[]> {
    this.assertBatch(batchId);
    return [...this.items].reverse();
  }

  public async readNextUnscoredItem(
    batchId: string,
  ): Promise<NovelSkillPaidBlindReviewSourceItem | null> {
    this.assertBatch(batchId);
    return this.items.find(({ blindItemId }) => !this.scored.has(blindItemId)) ?? null;
  }

  public async submitBlindScores(
    input: PersistNovelSkillPaidBlindReviewScoresInput,
  ): Promise<void> {
    this.assertBatch(input.batchId);
    if (this.scored.has(input.blindItemId)) throw new Error("already scored");
    this.submissions.push(input);
    this.scored.add(input.blindItemId);
  }

  private assertBatch(batchId: string): void {
    if (batchId !== BATCH_ID) throw new Error("wrong batch");
  }
}

describe("NovelSkillPaidBlindReviewService", () => {
  it("returns exactly 192 randomized safe projections with thirteen empty scores", async () => {
    const port = new FakeBlindReviewPort();
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);

    const items = await service.readBatch();

    expect(items).toHaveLength(NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_COUNT);
    expect(items.map(({ position }) => position)).toEqual(
      Array.from({ length: 192 }, (_, index) => index + 1),
    );
    const first = items[0];
    if (first === undefined) throw new Error("batch missing");
    expect(Object.keys(first)).toEqual([
      "blindItemId",
      "position",
      "fixtureTaskContent",
      "boundaries",
      "lockedFacts",
      "requestedOutcome",
      "candidateOutput",
      "scores",
    ]);
    expect(Object.keys(first.scores).sort()).toEqual([...NOVEL_SKILL_EVALUATION_METRICS].sort());
    expect(Object.values(first.scores)).toEqual(Array.from({ length: 13 }, () => null));
    expect(collectKeys(first)).not.toEqual(
      expect.arrayContaining([
        "arm",
        "model",
        "modelId",
        "modelSlotId",
        "slot",
        "repetition",
        "cost",
        "hash",
        "observationId",
      ]),
    );
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.scores)).toBe(true);
  });

  it("reads the next unscored blind item without exposing persistence identity", async () => {
    const port = new FakeBlindReviewPort();
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);

    const first = await service.nextItem();
    if (first === null) throw new Error("next item missing");
    await service.submitScores({ blindItemId: first.blindItemId, scores: completeScores() });
    const second = await service.nextItem();

    expect(second?.position).toBe(2);
    expect(second?.blindItemId).not.toBe(first.blindItemId);
    expect(Object.values(second?.scores ?? {})).toEqual(Array.from({ length: 13 }, () => null));
  });

  it("submits an exact immutable thirteen-score record through the narrow port", async () => {
    const port = new FakeBlindReviewPort();
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);
    const inputScores = completeScores();

    await service.submitScores({
      blindItemId: "blind-item-00000001",
      scores: inputScores,
    });

    expect(port.submissions).toHaveLength(1);
    const submitted = port.submissions[0];
    expect(submitted).toEqual({
      batchId: BATCH_ID,
      blindItemId: "blind-item-00000001",
      scores: inputScores,
    });
    expect(Object.keys(submitted ?? {})).toEqual(["batchId", "blindItemId", "scores"]);
    expect(Object.isFrozen(submitted)).toBe(true);
    expect(Object.isFrozen(submitted?.scores)).toBe(true);
  });

  it.each([
    ["missing metric", scoresWithout("pacing")],
    ["extra metric", { ...completeScores(), hidden_metric: 0.5 }],
    ["null metric", { ...completeScores(), pacing: null }],
    ["NaN metric", { ...completeScores(), pacing: Number.NaN }],
    ["negative metric", { ...completeScores(), pacing: -0.01 }],
    ["greater-than-one metric", { ...completeScores(), pacing: 1.01 }],
  ])("rejects %s without writing any score", async (_label, unsafeScores) => {
    const port = new FakeBlindReviewPort();
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);

    await expect(
      service.submitScores({
        blindItemId: "blind-item-00000001",
        scores: unsafeScores as NovelSkillPaidBlindReviewScores,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_BLIND_REVIEW_SCORES_INVALID" });
    expect(port.submissions).toEqual([]);
  });

  it("fails closed when a source row contains any deblinding metadata", async () => {
    const port = new FakeBlindReviewPort();
    const first = port.items[0];
    if (first === undefined) throw new Error("batch missing");
    port.items[0] = {
      ...first,
      arm: "core",
      modelId: "provider-model",
      modelSlotId: "text_tier_a",
      repetition: 1,
      estimatedCostMicros: "1",
      evidenceHash: "a".repeat(64),
      observationId: "forbidden-observation",
    } as NovelSkillPaidBlindReviewSourceItem;
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);

    await expect(service.readBatch()).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_INVALID",
    });
    expect(port.submissions).toEqual([]);
  });

  it("rejects a next-item projection that drifts from the frozen batch", async () => {
    const port = new FakeBlindReviewPort();
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);
    await service.readBatch();
    const first = port.items[0];
    if (first === undefined) throw new Error("batch missing");
    port.items[0] = { ...first, candidateOutput: "被替换的 Candidate 输出" };

    await expect(service.nextItem()).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_INVALID",
    });
    expect(port.submissions).toEqual([]);
  });

  it("does not submit a syntactically valid blind id outside the frozen batch", async () => {
    const port = new FakeBlindReviewPort();
    const service = new NovelSkillPaidBlindReviewService(BATCH_ID, port);

    await expect(
      service.submitScores({
        blindItemId: "blind-item-99999999",
        scores: completeScores(),
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_INVALID" });
    expect(port.submissions).toEqual([]);
  });

  it("rejects incomplete or duplicate randomized assignments", async () => {
    const incompletePort = new FakeBlindReviewPort();
    incompletePort.items.pop();
    await expect(
      new NovelSkillPaidBlindReviewService(BATCH_ID, incompletePort).readBatch(),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_BLIND_REVIEW_BATCH_INVALID" });

    const duplicatePort = new FakeBlindReviewPort();
    const first = duplicatePort.items[0];
    const second = duplicatePort.items[1];
    if (first === undefined || second === undefined) throw new Error("batch missing");
    duplicatePort.items[1] = { ...second, position: first.position };
    await expect(
      new NovelSkillPaidBlindReviewService(BATCH_ID, duplicatePort).readBatch(),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_BLIND_REVIEW_BATCH_INVALID" });
  });
});

function fixedBlindItems(): NovelSkillPaidBlindReviewSourceItem[] {
  return Array.from({ length: 192 }, (_, index) => {
    const position = index + 1;
    return Object.freeze({
      blindItemId: `blind-item-${String(position).padStart(8, "0")}`,
      position,
      fixtureTaskContent: `原创中文小说任务 ${String(position)}`,
      boundaries: Object.freeze(["保持既定视角", "不得改写已锁定事实"]),
      lockedFacts: Object.freeze(["角色仍在当前场景", "时间线不得倒退"]),
      requestedOutcome: "续写一个具有因果推进的场景",
      candidateOutput: `隔离 Candidate 的可见正文输出 ${String(position)}`,
    });
  });
}

function completeScores(): NovelSkillPaidBlindReviewScores {
  const scores = {} as Record<NovelSkillEvaluationMetric, number>;
  NOVEL_SKILL_EVALUATION_METRICS.forEach((metric, index) => {
    scores[metric] = index / (NOVEL_SKILL_EVALUATION_METRICS.length - 1);
  });
  return Object.freeze(scores);
}

function scoresWithout(
  omitted: NovelSkillEvaluationMetric,
): Partial<Record<NovelSkillEvaluationMetric, number>> {
  return Object.fromEntries(
    Object.entries(completeScores()).filter(([metric]) => metric !== omitted),
  );
}

function collectKeys(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null) return Object.freeze([]);
  const keys = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      keys.add(key);
      visit(child);
    }
  };
  visit(value);
  return Object.freeze([...keys]);
}
