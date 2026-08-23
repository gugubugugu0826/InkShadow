import type { StorySettingsPreflightReport } from "@inkshadow/import-export/core";

type StorySettingsPreflightIssue = StorySettingsPreflightReport["issues"][number];

const PATH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  format: "文件格式",
  schemaVersion: "文件版本",
  projectMetadata: "项目信息",
  name: "名称",
  exportedAt: "导出时间",
  characters: "人物",
  relationships: "人物关系",
  worldRules: "世界规则",
  writingPreferences: "写作偏好",
  memories: "记忆",
  id: "编号",
  role: "身份",
  aliases: "别名",
  shortDescription: "简介",
  traits: "人物特征",
  currentGoal: "当前目标",
  knownInformation: "已知信息",
  currentState: "当前状态",
  locked: "是否固定",
  fromCharacterRef: "起点人物",
  toCharacterRef: "终点人物",
  relationshipType: "关系类型",
  since: "关系开始时间",
  title: "标题",
  rule: "规则内容",
  scope: "适用范围",
  consequence: "后果",
  effectiveAt: "生效时间",
  evidence: "依据",
  exceptions: "例外",
  content: "内容",
  source: "来源",
  level: "记忆层级",
});

export function ordinaryStorySettingsIssueLocation(issue: StorySettingsPreflightIssue): string {
  if (issue.path === "$" || issue.path.length === 0) {
    return "整个设定文件";
  }
  const segments = issue.path.replace(/^\$\.?/u, "").split(".");
  return segments
    .map((segment, index) => {
      const matched = /^([^\[]+)(?:\[(\d+)\])?$/u.exec(segment);
      if (matched === null) return "相关内容";
      const field = matched[1] ?? "";
      const label =
        issue.code === "UNKNOWN_FIELD" && index === segments.length - 1
          ? "未识别内容"
          : (PATH_LABELS[field] ?? "相关内容");
      const itemIndex = matched[2];
      return itemIndex === undefined ? label : `${label}第 ${String(Number(itemIndex) + 1)} 项`;
    })
    .join(" → ");
}

export function ordinaryStorySettingsIssueMessage(issue: StorySettingsPreflightIssue): string {
  if (issue.code === "UNKNOWN_FIELD") {
    return "发现当前版本不认识的内容；为避免遗漏，本次导入已停止。";
  }
  if (issue.code === "FIELD_INVALID" && issue.path.endsWith(".locked")) {
    return "“是否固定”只能填写“是”或“否”。";
  }
  if (issue.code === "DUPLICATE_ID") {
    return "有多条设定使用了同一个编号。";
  }
  if (issue.code === "RELATIONSHIP_ENDPOINT_MISSING") {
    return "人物关系的一端没有对应的人物。";
  }
  return replaceInternalTerms(issue.message);
}

export function ordinaryStorySettingsIssueAction(issue: StorySettingsPreflightIssue): string {
  if (issue.code === "UNKNOWN_FIELD") {
    return "删除未识别内容，或把它移到格式说明支持的位置后重新预检。";
  }
  if (issue.code === "FIELD_INVALID" && issue.path.endsWith(".locked")) {
    return "删除这项以使用默认选择，或明确选择“是”或“否”。";
  }
  if (issue.code === "DUPLICATE_ID") {
    return "请为每条设定使用不同的编号。";
  }
  if (issue.code === "RELATIONSHIP_ENDPOINT_MISSING") {
    return "补充对应人物，或重新选择关系两端的人物。";
  }
  return replaceInternalTerms(issue.suggestedAction);
}

function replaceInternalTerms(text: string): string {
  return text
    .replace(/guided_opening(?:\.[A-Za-z0-9_-]+)?/gu, "旧版开书资料")
    .replace(/\bid\b/gu, "编号")
    .replace(/\bcharacters\b/gu, "人物列表")
    .replace(/\bformat\b/gu, "文件格式")
    .replace(/\bschemaVersion\b/gu, "文件版本")
    .replace(/\btrue\b/gu, "“是”")
    .replace(/\bfalse\b/gu, "“否”")
    .replace(/布尔值/gu, "“是”或“否”");
}
