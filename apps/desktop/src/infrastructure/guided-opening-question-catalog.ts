import type { ProjectSeedFieldKey } from "@inkshadow/domain";

export interface GuidedOpeningQuestionTemplate {
  readonly key: string;
  readonly prompt: string;
  readonly helper: string;
  readonly targetFields: readonly ProjectSeedFieldKey[];
  readonly options: readonly string[];
  readonly placeholder: string;
}

const question = (
  key: string,
  prompt: string,
  helper: string,
  targetField: ProjectSeedFieldKey,
  options: readonly string[],
): GuidedOpeningQuestionTemplate =>
  Object.freeze({
    key,
    prompt,
    helper,
    targetFields: Object.freeze([targetField]),
    options: Object.freeze(options),
    placeholder: "也可以自己回答。",
  });

/** One canonical local question catalog shared by legacy snapshots and the gap planner. */
export const GUIDED_OPENING_QUESTION_CATALOG: readonly GuidedOpeningQuestionTemplate[] =
  Object.freeze([
    question(
      "opening_direction",
      "你最想让这个开头接下来发生什么？",
      "确认当前场景最值得推进的方向。",
      "currentDirection",
      ["让人物立刻做出选择", "推进人物关系", "增加一个悬念", "先展示日常"],
    ),
    question(
      "tone",
      "读者看完这一段，你最想让他们留下什么感觉？",
      "确认叙述节奏与情绪目标。",
      "tone",
      ["温暖心动", "轻松好笑", "紧张悬疑", "克制伤感"],
    ),
    question(
      "protagonist",
      "为了继续写下去，主角当前最重要的特征是什么？",
      "补足会直接影响下一步行动的主角信息。",
      "characters",
      ["普通但很敏锐", "嘴硬心软", "目标感很强", "隐藏着秘密"],
    ),
    question(
      "relationship",
      "主角和关键人物目前是什么关系？",
      "澄清人物互动所依赖的当前关系。",
      "relationships",
      ["刚刚认识", "青梅竹马", "互相看不顺眼", "一方认识另一方"],
    ),
    question(
      "conflict",
      "眼前最先需要解决的麻烦是什么？",
      "确定能推动下一场景的小冲突。",
      "conflict",
      ["误会正在扩大", "秘密可能暴露", "必须共同完成一件事", "有人突然失踪"],
    ),
    question("pov", "接下来的正文要离谁的感受最近？", "避免后续叙事视角漂移。", "pov", [
      "第一人称主角",
      "第三人称跟随主角",
      "双主角轮换",
      "保持当前写法",
    ]),
    question("style", "有没有一种你希望长期保持的写法？", "记录可继续修改的写作偏好。", "style", [
      "短句和更多对话",
      "细腻但不过度",
      "节奏快、少解释",
      "画面感更强",
    ]),
    question(
      "boundaries",
      "目前有什么内容一定不要出现？",
      "记录需要优先遵守的写作边界。",
      "boundaries",
      ["不要突然加入超自然设定", "不要强行误会", "不要角色降智", "暂时没有"],
    ),
    question(
      "direction",
      "接下来一章最值得推进的是什么？",
      "记录可继续调整的下一步方向。",
      "currentDirection",
      ["让两人再次相遇", "揭开一个小秘密", "制造必须合作的事件", "先展示日常关系"],
    ),
    question("genre", "这个故事当前最接近哪种类型？", "减少后续风格和类型误判。", "genre", [
      "青春恋爱",
      "悬疑",
      "科幻",
      "奇幻",
      "都市日常",
    ]),
    question("world", "这个故事发生在怎样的地方或时代？", "补足最影响人物行动的背景。", "world", [
      "当代校园",
      "近未来城市",
      "架空小镇",
      "异世界",
      "先保持现实背景",
    ]),
    question(
      "outline",
      "目前能确定的第一段故事走向是什么？",
      "记录仍可修改的初步走向。",
      "initialOutline",
      ["相遇并被迫合作", "发现秘密并调查", "误会后重新理解", "先写日常再引出冲突"],
    ),
  ]);
