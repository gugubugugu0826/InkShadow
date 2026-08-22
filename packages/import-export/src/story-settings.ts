export const STORY_SETTINGS_FORMAT = "inkshadow.story-settings" as const;
export const STORY_SETTINGS_SCHEMA_VERSION = 1 as const;

const MAX_ITEMS_PER_SECTION = 2_048;
const MAX_TOTAL_ITEMS = 5_000;
const MAX_TEXT = 8_000;
const MAX_SHORT_TEXT = 240;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface StorySettingsCharacter {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly aliases: readonly string[];
  readonly shortDescription?: string;
  readonly traits: readonly string[];
  readonly currentGoal?: string;
  readonly knownInformation: readonly string[];
  readonly currentState?: string;
  readonly locked: boolean;
}

export interface StorySettingsRelationship {
  readonly id: string;
  readonly fromCharacterRef: string;
  readonly toCharacterRef: string;
  readonly relationshipType: string;
  readonly since?: string;
  readonly publicStatus?: string;
  readonly privateStatus?: string;
  readonly currentChange?: string;
  readonly evidence?: string;
}

export interface StorySettingsWorldRule {
  readonly id: string;
  readonly title: string;
  readonly rule: string;
  readonly scope?: string;
  readonly exceptions: readonly string[];
  readonly consequence?: string;
  readonly effectiveAt?: string;
  readonly evidence?: string;
  readonly locked: boolean;
}

export interface StorySettingsWritingPreference {
  readonly id: string;
  readonly content: string;
  readonly source?: string;
}

export interface StorySettingsMemory {
  readonly id: string;
  readonly level: "L1" | "L2" | "L3" | "L4";
  readonly content: string;
}

export interface StorySettingsProjectMetadata {
  readonly name?: string;
  readonly exportedAt?: string;
}

export interface InkShadowStorySettingsV1 {
  readonly format: typeof STORY_SETTINGS_FORMAT;
  readonly schemaVersion: typeof STORY_SETTINGS_SCHEMA_VERSION;
  readonly projectMetadata?: StorySettingsProjectMetadata;
  readonly characters: readonly StorySettingsCharacter[];
  readonly relationships: readonly StorySettingsRelationship[];
  readonly worldRules: readonly StorySettingsWorldRule[];
  readonly writingPreferences: readonly StorySettingsWritingPreference[];
  readonly memories: readonly StorySettingsMemory[];
}

export type StorySettingsIssueSeverity = "blocking" | "confirmation" | "warning";

export interface StorySettingsImportIssue {
  readonly severity: StorySettingsIssueSeverity;
  readonly code:
    | "INVALID_JSON"
    | "SCHEMA_VERSION_UNSUPPORTED"
    | "FIELD_INVALID"
    | "UNKNOWN_FIELD"
    | "LIMIT_EXCEEDED"
    | "DUPLICATE_ID"
    | "DUPLICATE_CHARACTER_NAME"
    | "DUPLICATE_WORLD_RULE_TITLE"
    | "CHARACTER_NAME_CONFLICT"
    | "WORLD_RULE_TITLE_CONFLICT"
    | "RELATIONSHIP_ENDPOINT_MISSING"
    | "SELF_RELATIONSHIP";
  readonly path: string;
  readonly message: string;
  readonly suggestedAction: string;
}

export interface ExistingStorySettingsIndex {
  readonly characterNames?: readonly string[];
  readonly characterAliases?: readonly string[];
  readonly worldRuleTitles?: readonly string[];
}

export interface StorySettingsPreflightReport {
  readonly status: "ready" | "blocked";
  readonly summary: Readonly<{
    importableCount: number;
    confirmationCount: number;
    errorCount: number;
    skippedCount: number;
  }>;
  readonly issues: readonly StorySettingsImportIssue[];
  readonly candidate?: InkShadowStorySettingsV1;
}

export function createStorySettingsTemplate(): InkShadowStorySettingsV1 {
  return Object.freeze({
    format: STORY_SETTINGS_FORMAT,
    schemaVersion: STORY_SETTINGS_SCHEMA_VERSION,
    projectMetadata: Object.freeze({ name: "示例作品" }),
    characters: Object.freeze([
      Object.freeze({
        id: "character.gugu",
        name: "顾顾",
        role: "女主角",
        aliases: Object.freeze([]),
        shortDescription: "观察敏锐，但不轻易表露情绪。",
        traits: Object.freeze(["直接", "重感情"]),
        currentGoal: "查清转学生隐瞒的秘密",
        knownInformation: Object.freeze([]),
        currentState: "仍在读初中",
        locked: false,
      }),
      Object.freeze({
        id: "character.dandan",
        name: "丹丹",
        role: "关键人物",
        aliases: Object.freeze([]),
        traits: Object.freeze(["克制"]),
        knownInformation: Object.freeze([]),
        locked: false,
      }),
    ]),
    relationships: Object.freeze([
      Object.freeze({
        id: "relationship.gugu-dandan",
        fromCharacterRef: "character.gugu",
        toCharacterRef: "character.dandan",
        relationshipType: "情侣",
        since: "初中相识",
        publicStatus: "尚未公开",
      }),
    ]),
    worldRules: Object.freeze([
      Object.freeze({
        id: "rule.memory-cost",
        title: "魔法的记忆代价",
        rule: "魔法每使用一次，施法者都会失去一天记忆。",
        scope: "所有施法者",
        exceptions: Object.freeze([]),
        consequence: "失去的记忆无法自然恢复",
        locked: true,
      }),
    ]),
    writingPreferences: Object.freeze([
      Object.freeze({ id: "preference.dialogue", content: "人物对话自然、克制。" }),
    ]),
    memories: Object.freeze([]),
  });
}

export function serializeStorySettings(value: InkShadowStorySettingsV1): string {
  const report = preflightStorySettings(value);
  if (report.status === "blocked" || report.candidate === undefined) {
    throw new Error("Story settings must pass preflight before export.");
  }
  return `${JSON.stringify(report.candidate, null, 2)}\n`;
}

export function preflightStorySettingsJson(
  json: string,
  existing: ExistingStorySettingsIndex = {},
): StorySettingsPreflightReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return blockedReport([
      issue(
        "blocking",
        "INVALID_JSON",
        "$",
        "文件内容无法识别为有效的故事设定。",
        "使用下载的模板重新填写，并检查逗号、引号和括号。",
      ),
    ]);
  }
  return preflightStorySettings(parsed, existing);
}

export function preflightStorySettings(
  value: unknown,
  existing: ExistingStorySettingsIndex = {},
): StorySettingsPreflightReport {
  const issues: StorySettingsImportIssue[] = [];
  if (!isRecord(value)) {
    return blockedReport([
      issue("blocking", "FIELD_INVALID", "$", "设定包必须是一个对象。", "下载模板后重试。"),
    ]);
  }
  reportUnknownFields(
    value,
    [
      "format",
      "schemaVersion",
      "projectMetadata",
      "characters",
      "relationships",
      "worldRules",
      "writingPreferences",
      "memories",
    ],
    "$",
    issues,
  );
  if (
    value.format !== STORY_SETTINGS_FORMAT ||
    value.schemaVersion !== STORY_SETTINGS_SCHEMA_VERSION
  ) {
    issues.push(
      issue(
        "blocking",
        "SCHEMA_VERSION_UNSUPPORTED",
        "$.schemaVersion",
        "这不是当前版本支持的墨影故事设定文件。",
        "使用当前应用下载的模板，或先用兼容版本转换。",
      ),
    );
  }

  const projectMetadata = parseProjectMetadata(value.projectMetadata, issues);
  const characters = parseArray(value.characters, "$.characters", issues, parseCharacter);
  const relationships = parseArray(
    value.relationships,
    "$.relationships",
    issues,
    parseRelationship,
  );
  const worldRules = parseArray(value.worldRules, "$.worldRules", issues, parseWorldRule);
  const writingPreferences = parseArray(
    value.writingPreferences,
    "$.writingPreferences",
    issues,
    parseWritingPreference,
  );
  const memories = parseArray(value.memories, "$.memories", issues, parseMemory);
  const allItems = [
    ...characters,
    ...relationships,
    ...worldRules,
    ...writingPreferences,
    ...memories,
  ];
  if (allItems.length > MAX_TOTAL_ITEMS) {
    issues.push(
      issue(
        "blocking",
        "LIMIT_EXCEEDED",
        "$",
        `设定包最多包含 ${String(MAX_TOTAL_ITEMS)} 项。`,
        "拆分为多个设定包后分别预检。",
      ),
    );
  }
  reportDuplicateIds(allItems, issues);
  reportCharacterConflicts(characters, existing, issues);
  reportWorldRuleConflicts(worldRules, existing, issues);
  reportRelationshipReferences(characters, relationships, issues);

  const errorCount = issues.filter(({ severity }) => severity === "blocking").length;
  const confirmationCount = issues.filter(({ severity }) => severity === "confirmation").length;
  const candidate: InkShadowStorySettingsV1 | undefined =
    errorCount === 0
      ? Object.freeze({
          format: STORY_SETTINGS_FORMAT,
          schemaVersion: STORY_SETTINGS_SCHEMA_VERSION,
          ...(projectMetadata === undefined ? {} : { projectMetadata }),
          characters: Object.freeze(characters),
          relationships: Object.freeze(relationships),
          worldRules: Object.freeze(worldRules),
          writingPreferences: Object.freeze(writingPreferences),
          memories: Object.freeze(memories),
        })
      : undefined;
  return Object.freeze({
    status: errorCount === 0 ? "ready" : "blocked",
    summary: Object.freeze({
      importableCount: errorCount === 0 ? allItems.length : 0,
      confirmationCount,
      errorCount,
      skippedCount: 0,
    }),
    issues: Object.freeze(issues),
    ...(candidate === undefined ? {} : { candidate }),
  });
}

function parseProjectMetadata(
  value: unknown,
  issues: StorySettingsImportIssue[],
): StorySettingsProjectMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    invalidField(issues, "$.projectMetadata", "项目信息必须是对象。", "删除该字段或按模板填写。");
    return undefined;
  }
  reportUnknownFields(value, ["name", "exportedAt"], "$.projectMetadata", issues);
  const name = optionalText(value.name, "$.projectMetadata.name", issues, MAX_SHORT_TEXT);
  const exportedAt = optionalText(value.exportedAt, "$.projectMetadata.exportedAt", issues, 64);
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(exportedAt === undefined ? {} : { exportedAt }),
  });
}

function parseCharacter(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): StorySettingsCharacter | null {
  if (!isRecord(value)) return invalidItem(issues, path, "人物必须是对象。");
  reportUnknownFields(
    value,
    [
      "id",
      "name",
      "role",
      "aliases",
      "shortDescription",
      "traits",
      "currentGoal",
      "knownInformation",
      "currentState",
      "locked",
    ],
    path,
    issues,
  );
  const id = requiredId(value.id, `${path}.id`, issues);
  const name = requiredText(value.name, `${path}.name`, issues, MAX_SHORT_TEXT);
  if (id === null || name === null) return null;
  return Object.freeze({
    id,
    name,
    ...optionalField(value.role, `${path}.role`, issues, MAX_SHORT_TEXT, "role"),
    aliases: stringList(value.aliases, `${path}.aliases`, issues),
    ...optionalField(
      value.shortDescription,
      `${path}.shortDescription`,
      issues,
      MAX_TEXT,
      "shortDescription",
    ),
    traits: stringList(value.traits, `${path}.traits`, issues),
    ...optionalField(value.currentGoal, `${path}.currentGoal`, issues, MAX_TEXT, "currentGoal"),
    knownInformation: stringList(value.knownInformation, `${path}.knownInformation`, issues),
    ...optionalField(value.currentState, `${path}.currentState`, issues, MAX_TEXT, "currentState"),
    locked: booleanField(value.locked, `${path}.locked`, issues, false),
  });
}

function parseRelationship(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): StorySettingsRelationship | null {
  if (!isRecord(value)) return invalidItem(issues, path, "人物关系必须是对象。");
  const keys = [
    "id",
    "fromCharacterRef",
    "toCharacterRef",
    "relationshipType",
    "since",
    "publicStatus",
    "privateStatus",
    "currentChange",
    "evidence",
  ];
  reportUnknownFields(value, keys, path, issues);
  const id = requiredId(value.id, `${path}.id`, issues);
  const from = requiredId(value.fromCharacterRef, `${path}.fromCharacterRef`, issues);
  const to = requiredId(value.toCharacterRef, `${path}.toCharacterRef`, issues);
  const type = requiredText(
    value.relationshipType,
    `${path}.relationshipType`,
    issues,
    MAX_SHORT_TEXT,
  );
  if (id === null || from === null || to === null || type === null) return null;
  return Object.freeze({
    id,
    fromCharacterRef: from,
    toCharacterRef: to,
    relationshipType: type,
    ...optionalFields(value, path, issues, [
      "since",
      "publicStatus",
      "privateStatus",
      "currentChange",
      "evidence",
    ]),
  });
}

function parseWorldRule(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): StorySettingsWorldRule | null {
  if (!isRecord(value)) return invalidItem(issues, path, "世界规则必须是对象。");
  reportUnknownFields(
    value,
    [
      "id",
      "title",
      "rule",
      "scope",
      "exceptions",
      "consequence",
      "effectiveAt",
      "evidence",
      "locked",
    ],
    path,
    issues,
  );
  const id = requiredId(value.id, `${path}.id`, issues);
  const title = requiredText(value.title, `${path}.title`, issues, MAX_SHORT_TEXT);
  const rule = requiredText(value.rule, `${path}.rule`, issues, MAX_TEXT);
  if (id === null || title === null || rule === null) return null;
  return Object.freeze({
    id,
    title,
    rule,
    ...optionalFields(value, path, issues, ["scope", "consequence", "effectiveAt", "evidence"]),
    exceptions: stringList(value.exceptions, `${path}.exceptions`, issues),
    locked: booleanField(value.locked, `${path}.locked`, issues, false),
  });
}

function parseWritingPreference(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): StorySettingsWritingPreference | null {
  if (!isRecord(value)) return invalidItem(issues, path, "写作偏好必须是对象。");
  reportUnknownFields(value, ["id", "content", "source"], path, issues);
  const id = requiredId(value.id, `${path}.id`, issues);
  const content = requiredText(value.content, `${path}.content`, issues, MAX_TEXT);
  if (id === null || content === null) return null;
  return Object.freeze({
    id,
    content,
    ...optionalField(value.source, `${path}.source`, issues, MAX_SHORT_TEXT, "source"),
  });
}

function parseMemory(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): StorySettingsMemory | null {
  if (!isRecord(value)) return invalidItem(issues, path, "记忆必须是对象。");
  reportUnknownFields(value, ["id", "level", "content"], path, issues);
  const id = requiredId(value.id, `${path}.id`, issues);
  const content = requiredText(value.content, `${path}.content`, issues, MAX_TEXT);
  const level = ["L1", "L2", "L3", "L4"].includes(String(value.level))
    ? (value.level as StorySettingsMemory["level"])
    : null;
  if (level === null)
    invalidField(
      issues,
      `${path}.level`,
      "记忆层级必须是 L1、L2、L3 或 L4。",
      "选择模板中的一个层级。",
    );
  if (id === null || content === null || level === null) return null;
  return Object.freeze({ id, level, content });
}

function parseArray<T>(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
  parser: (item: unknown, itemPath: string, issues: StorySettingsImportIssue[]) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    invalidField(issues, path, "该字段必须是数组。", "保留空数组，或按模板逐项填写。");
    return [];
  }
  if (value.length > MAX_ITEMS_PER_SECTION) {
    issues.push(
      issue(
        "blocking",
        "LIMIT_EXCEEDED",
        path,
        `单类设定最多 ${String(MAX_ITEMS_PER_SECTION)} 项。`,
        "拆分文件后重试。",
      ),
    );
  }
  return value.slice(0, MAX_ITEMS_PER_SECTION).flatMap((item, index) => {
    const parsed = parser(item, `${path}[${String(index)}]`, issues);
    return parsed === null ? [] : [parsed];
  });
}

function reportDuplicateIds(
  items: readonly { readonly id: string }[],
  issues: StorySettingsImportIssue[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      issues.push(
        issue(
          "blocking",
          "DUPLICATE_ID",
          "$",
          `设定编号“${item.id}”重复。`,
          "为每一项设置不同的 id。",
        ),
      );
    }
    seen.add(item.id);
  }
}

function reportCharacterConflicts(
  characters: readonly StorySettingsCharacter[],
  existing: ExistingStorySettingsIndex,
  issues: StorySettingsImportIssue[],
): void {
  const names = new Map<string, string>();
  const existingNames = new Set(
    [...(existing.characterNames ?? []), ...(existing.characterAliases ?? [])].map(normalizeName),
  );
  characters.forEach((character, index) => {
    for (const name of [character.name, ...character.aliases]) {
      const normalized = normalizeName(name);
      const prior = names.get(normalized);
      if (prior !== undefined && prior !== character.id) {
        issues.push(
          issue(
            "blocking",
            "DUPLICATE_CHARACTER_NAME",
            `$.characters[${String(index)}].name`,
            `“${name}”同时指向多个导入人物，关系引用无法无歧义地解析。`,
            "先在文件中合并或重命名重复人物，再重新预检。",
          ),
        );
      }
      names.set(normalized, character.id);
      if (existingNames.has(normalized)) {
        issues.push(
          issue(
            "confirmation",
            "CHARACTER_NAME_CONFLICT",
            `$.characters[${String(index)}].name`,
            `“${name}”与当前项目的人物名称或别名相同。`,
            "选择合并、保留当前内容或新建副本。",
          ),
        );
      }
    }
  });
}

function reportWorldRuleConflicts(
  worldRules: readonly StorySettingsWorldRule[],
  existing: ExistingStorySettingsIndex,
  issues: StorySettingsImportIssue[],
): void {
  const importedTitles = new Set<string>();
  const existingTitles = new Set((existing.worldRuleTitles ?? []).map(normalizeName));
  worldRules.forEach((rule, index) => {
    const normalizedTitle = normalizeName(rule.title);
    if (importedTitles.has(normalizedTitle)) {
      issues.push(
        issue(
          "blocking",
          "DUPLICATE_WORLD_RULE_TITLE",
          `$.worldRules[${String(index)}].title`,
          `“${rule.title}”在导入文件中重复，无法安全创建两个同名正式规则。`,
          "先在文件中合并或重命名重复的世界规则，再重新预检。",
        ),
      );
    }
    importedTitles.add(normalizedTitle);
    if (existingTitles.has(normalizedTitle)) {
      issues.push(
        issue(
          "confirmation",
          "WORLD_RULE_TITLE_CONFLICT",
          `$.worldRules[${String(index)}].title`,
          `“${rule.title}”与当前项目的世界规则标题相同。`,
          "选择合并、保留当前内容或新建副本。",
        ),
      );
    }
  });
}

function reportRelationshipReferences(
  characters: readonly StorySettingsCharacter[],
  relationships: readonly StorySettingsRelationship[],
  issues: StorySettingsImportIssue[],
): void {
  const ids = new Set(characters.map(({ id }) => id));
  relationships.forEach((relationship, index) => {
    for (const [field, reference] of [
      ["fromCharacterRef", relationship.fromCharacterRef],
      ["toCharacterRef", relationship.toCharacterRef],
    ] as const) {
      if (!ids.has(reference)) {
        issues.push(
          issue(
            "blocking",
            "RELATIONSHIP_ENDPOINT_MISSING",
            `$.relationships[${String(index)}].${field}`,
            `关系端点“${reference}”不在 characters 中。`,
            "补充对应人物，或改为有效的人物 id。",
          ),
        );
      }
    }
    if (relationship.fromCharacterRef === relationship.toCharacterRef) {
      issues.push(
        issue(
          "blocking",
          "SELF_RELATIONSHIP",
          `$.relationships[${String(index)}]`,
          "人物关系必须连接两个不同的人物。",
          "选择两个不同人物；人物的内在冲突请记录为人物状态，而不是关系。",
        ),
      );
    }
  });
}

function requiredId(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): string | null {
  if (typeof value !== "string" || !PORTABLE_ID.test(value)) {
    invalidField(
      issues,
      path,
      "id 只能使用字母、数字、点、下划线、冒号和短横线，且长度不超过 128。",
      "使用模板示例格式填写稳定 id。",
    );
    return null;
  }
  return value;
}

function requiredText(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
  maximum: number,
): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    hasControl(value)
  ) {
    invalidField(
      issues,
      path,
      `需要 1–${String(maximum)} 个可读字符。`,
      "填写非空文字并移除控制字符。",
    );
    return null;
  }
  return value.normalize("NFC").trim();
}

function optionalText(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, path, issues, maximum) ?? undefined;
}

function optionalField<K extends string>(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
  maximum: number,
  key: K,
): Partial<Record<K, string>> {
  const parsed = optionalText(value, path, issues, maximum);
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<K, string>);
}

function optionalFields(
  value: Readonly<Record<string, unknown>>,
  path: string,
  issues: StorySettingsImportIssue[],
  keys: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      keys.flatMap((key) => {
        const parsed = optionalText(value[key], `${path}.${key}`, issues, MAX_TEXT);
        return parsed === undefined ? [] : [[key, parsed]];
      }),
    ),
  );
}

function stringList(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 128) {
    invalidField(issues, path, "该字段必须是最多 128 项的文字数组。", "按模板使用列表填写。");
    return Object.freeze([]);
  }
  const parsed = value.flatMap((item, index) => {
    const text = requiredText(item, `${path}[${String(index)}]`, issues, MAX_SHORT_TEXT);
    return text === null ? [] : [text];
  });
  return Object.freeze([...new Set(parsed)]);
}

function booleanField(
  value: unknown,
  path: string,
  issues: StorySettingsImportIssue[],
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    invalidField(
      issues,
      path,
      "该字段必须是 true 或 false。",
      "删除字段以使用默认值，或填写布尔值。",
    );
    return fallback;
  }
  return value;
}

function reportUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  issues: StorySettingsImportIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push(
        issue(
          "blocking",
          "UNKNOWN_FIELD",
          `${path}.${key}`,
          `字段“${key}”无法识别；为避免静默丢失内容，本次导入已停止。`,
          "删除该字段，或把内容移动到格式说明支持的字段后重新预检。",
        ),
      );
    }
  }
}

function invalidItem(issues: StorySettingsImportIssue[], path: string, message: string): null {
  invalidField(issues, path, message, "按下载模板填写该项。");
  return null;
}

function invalidField(
  issues: StorySettingsImportIssue[],
  path: string,
  message: string,
  action: string,
): void {
  issues.push(issue("blocking", "FIELD_INVALID", path, message, action));
}

function issue(
  severity: StorySettingsIssueSeverity,
  code: StorySettingsImportIssue["code"],
  path: string,
  message: string,
  suggestedAction: string,
): StorySettingsImportIssue {
  return Object.freeze({ severity, code, path, message, suggestedAction });
}

function blockedReport(issues: readonly StorySettingsImportIssue[]): StorySettingsPreflightReport {
  return Object.freeze({
    status: "blocked",
    summary: Object.freeze({
      importableCount: 0,
      confirmationCount: 0,
      errorCount: issues.length,
      skippedCount: 0,
    }),
    issues: Object.freeze([...issues]),
  });
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function hasControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
