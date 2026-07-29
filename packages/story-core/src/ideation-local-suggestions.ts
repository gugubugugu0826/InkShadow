import type { IdeationDraft, IdeationStepKey } from "./ideation.js";

export interface LocalIdeationSuggestion {
  readonly content: string;
  readonly provenance: "local_template";
  readonly variant: 0 | 1 | 2;
}

const MAX_SOURCE_EXCERPT = 480;

export function buildLocalIdeationSuggestion(
  draft: IdeationDraft,
  step: IdeationStepKey,
  variantValue: number,
): LocalIdeationSuggestion {
  const variant = normalizeVariant(variantValue);
  const values = Object.fromEntries(
    draft.toSnapshot().steps.map((item) => [item.key, excerpt(item.value)]),
  ) as Record<IdeationStepKey, string>;
  const premise = values.premise || "一个尚待展开的核心命题";
  const genre = values.genre || "长篇叙事";
  const protagonist = values.protagonist_drive || "必须作出代价明确的选择";
  const content = suggestionBuilders[step][variant]({
    ...values,
    premise,
    genre,
    protagonist_drive: protagonist,
  });
  return Object.freeze({
    content,
    provenance: "local_template",
    variant,
  });
}

type SuggestionContext = Record<IdeationStepKey, string>;
type SuggestionBuilder = (context: SuggestionContext) => string;

const suggestionBuilders: Record<
  IdeationStepKey,
  readonly [SuggestionBuilder, SuggestionBuilder, SuggestionBuilder]
> = {
  genre: [
    ({ premise }) => `以“${premise}”为核心的悬疑成长长篇。`,
    ({ premise }) => `围绕“${premise}”展开的现实底色幻想故事。`,
    ({ premise }) => `以“${premise}”驱动的群像冒险与伦理抉择。`,
  ],
  target_audience: [
    ({ genre }) => `偏好${genre}、人物成长和持续谜题的成年读者。`,
    ({ genre }) => `希望在${genre}中获得强情节推进与情感回报的连载读者。`,
    ({ genre }) => `重视${genre}设定自洽、角色关系和长期伏笔的核心读者。`,
  ],
  premise: [
    ({ genre, protagonist_drive }) =>
      `在一个日常规则突然失效的${genre}世界里，主角为了${protagonist_drive}，必须揭开一项会改变自身身份的真相。`,
    ({ genre, protagonist_drive }) =>
      `${genre}故事：主角原本只想${protagonist_drive}，却发现每次靠近目标都会让另一个重要之人承担代价。`,
    ({ genre, protagonist_drive }) =>
      `当一项被所有人接受的规则被证明是谎言，主角以${protagonist_drive}为起点，卷入无法独善其身的${genre}冲突。`,
  ],
  protagonist_drive: [
    ({ premise }) => `查明“${premise}”背后的真相，并保护自己仍愿意相信的人。`,
    ({ premise }) => `证明自己能改变“${premise}”造成的既定结局，即使必须失去现有身份。`,
    ({ premise }) => `在“${premise}”带来的两难中弥补旧错，同时拒绝把代价转嫁给无辜者。`,
  ],
  world_skeleton: [
    ({ premise }) =>
      `世界以三层规则运转：公开规则维持日常秩序；隐秘规则解释“${premise}”；代价规则确保任何越界都会留下可追踪后果。`,
    ({ premise }) =>
      `围绕“${premise}”设置三个相互制衡的区域或组织，各自掌握部分真相，资源流动会改变权力与普通人的生活。`,
    ({ premise }) =>
      `让世界中的技术、制度或能力都服务于“${premise}”，并为每种便利规定稀缺来源、使用代价和不可撤销的边界。`,
  ],
  key_characters: [
    ({ protagonist_drive }) =>
      `主角：被“${protagonist_drive}”推动；镜像角色：追求同一目标却接受相反代价；守门人：掌握关键规则；情感锚点：让选择具有私人后果。`,
    ({ protagonist_drive }) =>
      `主角承担行动线；搭档不断质疑“${protagonist_drive}”；对手提供看似更有效的道路；见证者保存被双方忽略的事实。`,
    ({ protagonist_drive }) =>
      `核心四人分别代表欲望、责任、秩序与自由，他们都对“${protagonist_drive}”有不同解释，关系变化直接推动剧情转折。`,
  ],
  plot_route: [
    ({ premise, protagonist_drive }) =>
      `开端：异常让“${premise}”无法回避；中段：主角以${protagonist_drive}为目标连续试错并付出代价；转折：发现目标本身建立在误解上；终局：在两种真实损失之间作出不可撤销的选择。`,
    ({ premise, protagonist_drive }) =>
      `调查线揭示“${premise}”的表层机制，关系线不断挑战${protagonist_drive}，两线在中点合并；后半程由主角主动设局，终局回收开篇承诺。`,
    ({ premise, protagonist_drive }) =>
      `以三次升级组织长篇：个人危机、群体危机、规则危机。每次升级都让${protagonist_drive}更难实现，并迫使主角修正对“${premise}”的理解。`,
  ],
  opening_hook: [
    ({ premise }) =>
      `第一场景先展示一个与“${premise}”有关、无法用常识解释的具体后果，并在场景结束前让主角承担责任。`,
    ({ premise }) =>
      `用一次看似成功却留下矛盾证据的行动开篇；最后一句证明“${premise}”已经影响到主角最私密的生活。`,
    ({ premise }) =>
      `从倒计时中的失败现场切入，只交代足够行动信息；在主角找到出口时，揭示“${premise}”使出口本身成为更大问题。`,
  ],
  output_spec: [
    () =>
      "采用有限视角；每章只推进一个主要目标并留下可回答的问题；重要设定先以行动后果呈现，再补解释。",
    () => "保持章级目标—阻碍—选择—后果结构；关键转折前后各留一处可回看证据；避免无来源的全知说明。",
    () =>
      "开篇三章完成角色承诺、核心异常与第一次主动选择；中段每卷改变一次关系结构；终局回收主问题与主要伏笔。",
  ],
};

function normalizeVariant(value: number): 0 | 1 | 2 {
  if (!Number.isSafeInteger(value)) {
    return 0;
  }
  const normalized = ((value % 3) + 3) % 3;
  return normalized === 0 ? 0 : normalized === 1 ? 1 : 2;
}

function excerpt(value: string): string {
  return value.length <= MAX_SOURCE_EXCERPT ? value : `${value.slice(0, MAX_SOURCE_EXCERPT)}…`;
}
