import type { NovelSkillEvaluationFixture } from "./novel-skill-evaluation.js";

/**
 * Six additional, original Chinese micro-contracts. They are purpose-written
 * test material, not imported books or commercial-fiction excerpts.
 */
export const ADDITIONAL_NOVEL_SKILL_EVALUATION_FIXTURES: readonly NovelSkillEvaluationFixture[] = [
  {
    fixtureId: "zh.historical.dialogue.voice",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "character_voice_check",
    invocationMode: "critic",
    genreTags: ["historical"],
    coverageDimensions: ["literary", "multi_character_dialogue"],
    input:
      "沈砚是谨慎的抄书人，对长辈始终用敬语。草稿中他忽然拍案道：‘老头，你少管我。’此前没有失控情节。",
    lockedFacts: ["沈砚是抄书人", "对长辈用敬语", "没有失控情节"],
    boundaries: ["指出具体失配台词", "不补写人物经历"],
    requestedOutcome: "判断声纹是否偏离，并给出不改变剧情的修订方向。",
  },
  {
    fixtureId: "zh.scifi.world_rule",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "contradiction_check",
    invocationMode: "critic",
    genreTags: ["science_fiction"],
    coverageDimensions: ["timeline", "rule_conflict"],
    input:
      "殖民站规定跨舱门移动必须经过十五分钟气闸循环。正文写林岚在警报后三分钟内从农业舱跑到医疗舱；故事没有直通管道。",
    lockedFacts: ["跨舱门需十五分钟", "没有直通管道", "行动只过去三分钟"],
    boundaries: ["引用规则和时间", "不编造豁免条款"],
    requestedOutcome: "给出可证实的世界规则冲突及修复方向。",
  },
  {
    fixtureId: "zh.xianxia.foreshadow",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "outline_planning",
    invocationMode: "collaborator",
    genreTags: ["xianxia"],
    coverageDimensions: ["fantasy", "web_novel"],
    input: "陆迟捡到刻着北斗的残片，只知道它来自旧矿洞。师父尚未解释来历，敌对宗门尚未登场。",
    lockedFacts: ["残片来自旧矿洞", "师父尚未解释", "敌对宗门未登场"],
    boundaries: ["不可提前揭示残片用途", "只规划一个可见线索"],
    requestedOutcome: "提出不泄露谜底的下一场景目标和伏笔推进。",
  },
  {
    fixtureId: "zh.suspense.rewrite.dialogue",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "rewrite",
    invocationMode: "revision",
    genreTags: ["suspense"],
    coverageDimensions: ["suspense", "rewrite"],
    input: "雨停后门铃响了三次。许闻没有开门，他把录音笔塞进抽屉，反复说自己不害怕。",
    lockedFacts: ["门铃响三次", "许闻没有开门", "录音笔在抽屉"],
    boundaries: ["增加对话张力但不改动作顺序", "不增加门外人身份"],
    requestedOutcome: "改写为更自然的紧张对话，保留已知事实。",
  },
  {
    fixtureId: "zh.slice_of_life.summary",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "chapter_summary",
    invocationMode: "collaborator",
    genreTags: ["slice_of_life"],
    coverageDimensions: ["literary"],
    input:
      "阿禾替邻居照看猫两天，发现猫把钥匙踢进沙发底。她没有进卧室，只在客厅找到钥匙并留下纸条。",
    lockedFacts: ["照看两天", "钥匙在沙发底", "没有进入卧室"],
    boundaries: ["摘要不添加动机", "区分事件和猜测"],
    requestedOutcome: "生成简洁、可追溯的章节摘要。",
  },
  {
    fixtureId: "zh.romance.preference.polish",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "polish",
    invocationMode: "revision",
    genreTags: ["romance"],
    coverageDimensions: ["literary"],
    input: "顾念把伞递给周澈，说你先走。周澈没有接，只把伞柄推回去。两人站在站台边，列车还没进站。",
    lockedFacts: ["伞被递出又推回", "两人仍在站台", "列车未进站"],
    boundaries: ["偏好短句和克制描写", "不让角色直接告白"],
    requestedOutcome: "不新增剧情地润色节奏与细节。",
  },
] as const;
