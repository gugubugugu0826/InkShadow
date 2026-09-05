export function formatRequirementConfirmationSummary(
  requirement: string | null | undefined,
): string {
  const original = requirement?.trim() ?? "";
  if (original.length === 0) return "未填写额外要求";
  const characters = Array.from(original);
  return characters.length <= 60
    ? original
    : `${characters.slice(0, 60).join("")}…（展开详情查看完整要求）`;
}

export function contextEntryExcerpt(entry: Readonly<{ id: string; content: string }>): string {
  let display = entry.content;
  if (entry.id.startsWith("story-fact:")) {
    const header = /^\[([^\]\n]+)\]\n类型：([a-zA-Z0-9_.-]+)\n/u.exec(entry.content);
    if (header !== null) {
      const status =
        header[1] === "用户已确认的正式事实"
          ? "正式设定／已确认"
          : header[1] === "已确认并锁定的规则"
            ? "正式设定／已锁定"
            : header[1] === "当前分支的用户事实（不是主线正式事实）"
              ? "仅当前试演剧情"
              : "临时资料／不是硬规则";
      const type = FACT_LABELS[header[2] ?? ""] ?? "其他设定";
      const body = entry.content.slice(header[0].length);
      const text = /^内容：([\s\S]*?)(?=\n(?:结构化值|生效位置|失效位置|仅适用分支)：|$)/u.exec(
        body,
      )?.[1];
      const readableText = text?.trim() ?? "";
      display = `${status} · ${type}：${readableText.length > 0 ? readableText : "结构化资料已保留，请到设定页核对。"}`;
    }
  }
  const normalized = display.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "这项资料没有可展示的文字摘要。";
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 140)}…`;
}

const FACT_LABELS: Readonly<Record<string, string>> = {
  character_identity: "人物身份",
  character_profile: "人物档案",
  character_state: "人物状态",
  "character.state": "人物状态",
  character_attribute: "人物属性",
  character_ability: "人物能力",
  character_voice: "人物说话方式",
  relationship: "人物关系",
  core_relationship: "人物关系",
  relationship_change: "关系变化",
  world_setting: "世界设定",
  world_rule: "世界规则",
  location: "地点",
  writing_rule: "写作要求",
  timeline_event: "时间线事件",
  event: "明确事件",
  causal_event: "因果事件",
  causal_relation: "事件因果关系",
  foreshadow: "伏笔",
  pov_knowledge: "人物已知信息",
};
