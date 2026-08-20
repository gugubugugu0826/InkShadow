export const LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION =
  "inkshadow_long_form_retrieval_v1" as const;

export const LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS = Object.freeze([
  5_000, 20_000, 50_000, 200_000,
] as const);

export const LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS = Object.freeze([
  "multi_chapter",
  "multi_version",
  "multi_branch",
  "what_if",
  "flashback",
  "multi_pov",
  "conflicting_fact",
  "rejected_candidate",
  "stale_version",
  "private_chapter",
  "future_knowledge",
  "empty_query",
] as const);

export type LongFormRetrievalBenchmarkScenario =
  (typeof LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS)[number];

export type LongFormBenchmarkAuthority =
  | "accepted_body"
  | "accepted_story_fact"
  | "rejected_candidate"
  | "unverified_conflict"
  | "what_if_projection";

export interface LongFormBenchmarkDocument {
  readonly id: string;
  readonly chapterId: string;
  readonly text: string;
  readonly sourceVersionId: string;
  readonly branchId: "main" | "alternate" | "shared";
  readonly povCharacterId: "lin-wan" | "zhou-qi" | "omniscient";
  readonly storyOrder: number;
  readonly timelineOrder: number;
  readonly authority: LongFormBenchmarkAuthority;
  readonly canon: "canonical" | "non_canon";
  readonly currentness: "current" | "stale";
  readonly privacy: "ordinary" | "private";
  readonly evidenceLocator: string | null;
}

export interface LongFormBenchmarkScope {
  readonly branchId: "main";
  readonly povCharacterId: "lin-wan" | "zhou-qi" | "omniscient";
  readonly maximumStoryOrder: number;
  readonly allowPrivate: boolean;
}

export interface LongFormBenchmarkSample {
  readonly id: string;
  readonly scenario: LongFormRetrievalBenchmarkScenario;
  readonly query: string;
  readonly relevantDocumentIds: readonly string[];
  readonly scope: LongFormBenchmarkScope;
  readonly expectedEmpty: boolean;
  readonly localRerankAvailability: "available" | "unavailable_use_fts_fallback";
}

export interface LongFormRetrievalBenchmarkFixture {
  readonly fixtureVersion: typeof LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION;
  readonly characterTarget: (typeof LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS)[number];
  readonly actualCharacterCount: number;
  readonly documents: readonly LongFormBenchmarkDocument[];
  readonly samples: readonly LongFormBenchmarkSample[];
}

interface DocumentDraft extends Omit<LongFormBenchmarkDocument, "id" | "evidenceLocator"> {
  readonly key: string;
  readonly evidenceLocator?: string | null;
}

const NEUTRAL_FILLER = "潮声沿着石阶缓慢回响，窗外的云影掠过旧墙。";

/**
 * Builds the fixed benchmark corpus in memory. No generated corpus or cache is
 * written to disk, so the fixture can be rebuilt after an index restart.
 */
export function buildLongFormRetrievalBenchmarkFixtures(): readonly LongFormRetrievalBenchmarkFixture[] {
  return Object.freeze(
    LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS.map((characterTarget) =>
      buildFixture(characterTarget),
    ),
  );
}

function buildFixture(
  characterTarget: LongFormRetrievalBenchmarkFixture["characterTarget"],
): LongFormRetrievalBenchmarkFixture {
  const prefix = `long-${String(characterTarget)}`;
  const documents = baseDocumentDrafts().map((draft) => materializeDocument(prefix, draft));
  let currentCharacters = documents.reduce((total, document) => total + document.text.length, 0);
  if (currentCharacters > characterTarget) {
    throw new Error("The fixed long-form benchmark seed exceeds its smallest corpus target.");
  }
  let fillerIndex = 1;
  while (currentCharacters < characterTarget) {
    const fillerLength = Math.min(4_000, characterTarget - currentCharacters);
    documents.push(
      materializeDocument(prefix, {
        key: `filler-${String(fillerIndex).padStart(3, "0")}`,
        chapterId: `chapter-filler-${String(fillerIndex).padStart(3, "0")}`,
        text: repeatToLength(NEUTRAL_FILLER, fillerLength),
        sourceVersionId: `version-filler-${String(fillerIndex).padStart(3, "0")}`,
        branchId: "main",
        povCharacterId: "omniscient",
        storyOrder: 1,
        timelineOrder: 1,
        authority: "accepted_body",
        canon: "canonical",
        currentness: "current",
        privacy: "ordinary",
      }),
    );
    currentCharacters += fillerLength;
    fillerIndex += 1;
  }
  const samples = buildSamples(prefix);
  return Object.freeze({
    fixtureVersion: LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
    characterTarget,
    actualCharacterCount: currentCharacters,
    documents: Object.freeze(documents),
    samples,
  });
}

function baseDocumentDrafts(): readonly DocumentDraft[] {
  const ordinary = {
    branchId: "main" as const,
    povCharacterId: "omniscient" as const,
    authority: "accepted_body" as const,
    canon: "canonical" as const,
    currentness: "current" as const,
    privacy: "ordinary" as const,
  };
  return Object.freeze([
    {
      ...ordinary,
      key: "multi-chapter-a",
      chapterId: "chapter-02",
      text: "第二章确认 银铃 海港 是守夜人的三声暗号。",
      sourceVersionId: "version-02-current",
      storyOrder: 2,
      timelineOrder: 2,
    },
    {
      ...ordinary,
      key: "multi-chapter-b",
      chapterId: "chapter-09",
      text: "第九章再次确认 银铃 海港 暗号已经交还给林晚。",
      sourceVersionId: "version-09-current",
      storyOrder: 9,
      timelineOrder: 9,
    },
    {
      ...ordinary,
      key: "multi-chapter-noise",
      chapterId: "chapter-07",
      text: "银铃 银铃 银铃 只是商队货单上的装饰名称。",
      sourceVersionId: "version-07-current",
      storyOrder: 7,
      timelineOrder: 7,
    },
    {
      ...ordinary,
      key: "version-current",
      chapterId: "chapter-03",
      text: "现行版本确认 钟楼 十一点 停摆，林晚听见最后一声。",
      sourceVersionId: "version-03-current",
      storyOrder: 3,
      timelineOrder: 3,
    },
    {
      ...ordinary,
      key: "version-stale",
      chapterId: "chapter-03",
      text: "旧稿写着 钟楼 十一点 十一点 十一点 才停摆。",
      sourceVersionId: "version-03-stale",
      storyOrder: 3,
      timelineOrder: 3,
      currentness: "stale",
    },
    {
      ...ordinary,
      key: "version-noise",
      chapterId: "chapter-04",
      text: "钟楼的修缮清单没有记录具体时间。",
      sourceVersionId: "version-04-current",
      storyOrder: 4,
      timelineOrder: 4,
    },
    {
      ...ordinary,
      key: "branch-main",
      chapterId: "chapter-05",
      text: "主线中 赤桥 密令 是把两枚铜币放在桥栏。",
      sourceVersionId: "version-05-main",
      storyOrder: 5,
      timelineOrder: 5,
    },
    {
      ...ordinary,
      key: "branch-alternate",
      chapterId: "chapter-05",
      text: "支线中 赤桥 密令 赤桥 密令 改成点燃蓝灯。",
      sourceVersionId: "version-05-alternate",
      branchId: "alternate",
      storyOrder: 5,
      timelineOrder: 5,
    },
    {
      ...ordinary,
      key: "what-if-only",
      chapterId: "chapter-what-if",
      text: "假设推演里 月港 沉没 后所有船只转向北方。",
      sourceVersionId: "version-what-if",
      authority: "what_if_projection",
      canon: "non_canon",
      storyOrder: 12,
      timelineOrder: 12,
    },
    {
      ...ordinary,
      key: "flashback-current",
      chapterId: "chapter-08",
      text: "第八章的闪回揭示 槐树 旧伤 来自林晚童年的坠落。",
      sourceVersionId: "version-08-current",
      povCharacterId: "lin-wan",
      storyOrder: 8,
      timelineOrder: 1,
    },
    {
      ...ordinary,
      key: "flashback-noise",
      chapterId: "chapter-06",
      text: "槐树 槐树 槐树 围住了无人居住的院落。",
      sourceVersionId: "version-06-current",
      povCharacterId: "lin-wan",
      storyOrder: 6,
      timelineOrder: 6,
    },
    {
      ...ordinary,
      key: "flashback-future",
      chapterId: "chapter-40",
      text: "尚未发生的段落声称 槐树 旧伤 会在终章复发。",
      sourceVersionId: "version-40-current",
      povCharacterId: "lin-wan",
      storyOrder: 40,
      timelineOrder: 40,
    },
    {
      ...ordinary,
      key: "pov-lin",
      chapterId: "chapter-10",
      text: "林晚视角只知道 蓝信 封蜡 上有一道月牙缺口。",
      sourceVersionId: "version-10-current",
      povCharacterId: "lin-wan",
      storyOrder: 10,
      timelineOrder: 10,
    },
    {
      ...ordinary,
      key: "pov-zhou",
      chapterId: "chapter-10",
      text: "周岐视角知道 蓝信 封蜡 蓝信 封蜡 内藏王室编号。",
      sourceVersionId: "version-10-current",
      povCharacterId: "zhou-qi",
      storyOrder: 10,
      timelineOrder: 10,
    },
    {
      ...ordinary,
      key: "conflict-authoritative",
      chapterId: "story-fact-01",
      text: "已接受 StoryFact 确认 王冠 归属 北境议会而非王族。",
      sourceVersionId: "fact-version-current",
      authority: "accepted_story_fact",
      storyOrder: 4,
      timelineOrder: 4,
    },
    {
      ...ordinary,
      key: "conflict-unverified",
      chapterId: "chapter-rumor",
      text: "未核实传言反复声称 王冠 归属 王冠 归属 南方王族。",
      sourceVersionId: "rumor-version",
      authority: "unverified_conflict",
      canon: "non_canon",
      storyOrder: 4,
      timelineOrder: 4,
    },
    {
      ...ordinary,
      key: "rejected-accepted",
      chapterId: "chapter-11",
      text: "已接受正文写明 白鹿 地窖 的入口藏在水井后。",
      sourceVersionId: "version-11-current",
      storyOrder: 11,
      timelineOrder: 11,
    },
    {
      ...ordinary,
      key: "rejected-candidate",
      chapterId: "candidate-rejected-01",
      text: "被拒 Candidate 写着 白鹿 地窖 白鹿 地窖 位于钟楼下。",
      sourceVersionId: "candidate-version-rejected",
      authority: "rejected_candidate",
      canon: "non_canon",
      storyOrder: 11,
      timelineOrder: 11,
    },
    {
      ...ordinary,
      key: "stale-current",
      chapterId: "chapter-12",
      text: "当前版本确认 渡船 东岸 靠岸后由林晚接管。",
      sourceVersionId: "version-12-current",
      storyOrder: 12,
      timelineOrder: 12,
    },
    {
      ...ordinary,
      key: "stale-old",
      chapterId: "chapter-12",
      text: "废弃版本反复写着 渡船 东岸 渡船 东岸 由周岐烧毁。",
      sourceVersionId: "version-12-stale",
      currentness: "stale",
      storyOrder: 12,
      timelineOrder: 12,
    },
    {
      ...ordinary,
      key: "private-only",
      chapterId: "chapter-private-01",
      text: "私密章节保存 黑曜 名册 的全部真实姓名。",
      sourceVersionId: "version-private-current",
      privacy: "private",
      storyOrder: 13,
      timelineOrder: 13,
    },
    {
      ...ordinary,
      key: "future-only",
      chapterId: "chapter-60",
      text: "未来章节才会揭示 双月 灾变 是人为制造。",
      sourceVersionId: "version-60-current",
      povCharacterId: "lin-wan",
      storyOrder: 60,
      timelineOrder: 60,
    },
    {
      ...ordinary,
      key: "incomplete-evidence",
      chapterId: "chapter-untrusted",
      text: "没有定位证据的摘录声称 银铃 海港 暗号从未存在。",
      sourceVersionId: "version-untrusted",
      canon: "non_canon",
      storyOrder: 8,
      timelineOrder: 8,
      evidenceLocator: null,
    },
  ]);
}

function buildSamples(prefix: string): readonly LongFormBenchmarkSample[] {
  const scope = (
    povCharacterId: LongFormBenchmarkScope["povCharacterId"] = "omniscient",
    maximumStoryOrder = 20,
  ): LongFormBenchmarkScope =>
    Object.freeze({ branchId: "main", povCharacterId, maximumStoryOrder, allowPrivate: false });
  const sample = (
    key: string,
    scenario: LongFormRetrievalBenchmarkScenario,
    query: string,
    relevantKeys: readonly string[],
    sampleScope: LongFormBenchmarkScope,
    options: Readonly<{
      expectedEmpty?: boolean;
      localRerankAvailability?: LongFormBenchmarkSample["localRerankAvailability"];
    }> = {},
  ): LongFormBenchmarkSample =>
    Object.freeze({
      id: `${prefix}:sample:${key}`,
      scenario,
      query,
      relevantDocumentIds: Object.freeze(
        relevantKeys.map((documentKey) => `${prefix}:${documentKey}`),
      ),
      scope: sampleScope,
      expectedEmpty: options.expectedEmpty ?? false,
      localRerankAvailability: options.localRerankAvailability ?? "available",
    });

  return Object.freeze([
    sample(
      "multi-chapter",
      "multi_chapter",
      "银铃 海港",
      ["multi-chapter-a", "multi-chapter-b"],
      scope(),
    ),
    sample("multi-version", "multi_version", "钟楼 十一点", ["version-current"], scope()),
    sample("multi-branch", "multi_branch", "赤桥 密令", ["branch-main"], scope()),
    sample("what-if", "what_if", "月港 沉没", [], scope(), { expectedEmpty: true }),
    sample("flashback", "flashback", "槐树 旧伤", ["flashback-current"], scope("lin-wan", 12)),
    sample("multi-pov", "multi_pov", "蓝信 封蜡", ["pov-lin"], scope("lin-wan", 12), {
      localRerankAvailability: "unavailable_use_fts_fallback",
    }),
    sample(
      "conflicting-fact",
      "conflicting_fact",
      "王冠 归属",
      ["conflict-authoritative"],
      scope(),
    ),
    sample("rejected-candidate", "rejected_candidate", "白鹿 地窖", ["rejected-accepted"], scope()),
    sample("stale-version", "stale_version", "渡船 东岸", ["stale-current"], scope()),
    sample("private", "private_chapter", "黑曜 名册", [], scope(), { expectedEmpty: true }),
    sample("future", "future_knowledge", "双月 灾变", [], scope("lin-wan", 20), {
      expectedEmpty: true,
    }),
    sample("empty", "empty_query", "星砂 回声", [], scope(), { expectedEmpty: true }),
  ]);
}

function materializeDocument(prefix: string, draft: DocumentDraft): LongFormBenchmarkDocument {
  const id = `${prefix}:${draft.key}`;
  return Object.freeze({
    id,
    chapterId: `${prefix}:${draft.chapterId}`,
    text: draft.text,
    sourceVersionId: `${prefix}:${draft.sourceVersionId}`,
    branchId: draft.branchId,
    povCharacterId: draft.povCharacterId,
    storyOrder: draft.storyOrder,
    timelineOrder: draft.timelineOrder,
    authority: draft.authority,
    canon: draft.canon,
    currentness: draft.currentness,
    privacy: draft.privacy,
    evidenceLocator:
      draft.evidenceLocator === null
        ? null
        : `chapter:${prefix}:${draft.chapterId}#0-${String(draft.text.length)}`,
  });
}

function repeatToLength(seed: string, length: number): string {
  if (length < 1) {
    return "";
  }
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}
