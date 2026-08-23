import {
  STORY_SETTINGS_FORMAT,
  STORY_SETTINGS_SCHEMA_VERSION,
  type InkShadowStorySettingsV1,
  type StorySettingsCharacter,
  type StorySettingsRelationship,
  type StorySettingsWorldRule,
} from "@inkshadow/import-export/core";
import type {
  FormalStoryRecord,
  MemoryRecord,
  StoryFact,
  StoryFactSnapshot,
  StoryValue,
} from "@inkshadow/story-core";

const MAX_NATURAL_LANGUAGE_SETTING = 2_000;

export type NaturalLanguageSettingCandidate =
  | Readonly<{
      kind: "relationship";
      sourceText: string;
      fromName: string;
      toName: string;
      relationshipType: string;
      since: string | null;
      suggestions: readonly string[];
    }>
  | Readonly<{
      kind: "world_rule";
      sourceText: string;
      title: string;
      rule: string;
      suggestions: readonly string[];
    }>
  | Readonly<{
      kind: "character_profile";
      sourceText: string;
      characterName: string;
      role: string | null;
      age: string | null;
      details: string | null;
      suggestions: readonly string[];
    }>
  | Readonly<{
      kind: "character_voice";
      sourceText: string;
      characterName: string;
      voice: string;
      suggestions: readonly string[];
    }>
  | Readonly<{
      kind: "manual";
      sourceText: string;
      missingInformation: string;
      suggestions: readonly string[];
    }>;

export interface LegacyGuidedOpeningRepairItem {
  readonly id: string;
  readonly kind: "character_record" | "writing_rule_record" | "incomplete_relationship";
  readonly sourceKind: "record" | "fact";
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly relationshipType: string | null;
  readonly title: string;
  readonly beforeSummary: string;
  readonly afterSummary: string;
  readonly needsUserInput: boolean;
}

export interface StorySettingsExportProjection {
  readonly bundle: InkShadowStorySettingsV1;
  readonly warnings: readonly string[];
}

export function parseNaturalLanguageSetting(value: string): NaturalLanguageSettingCandidate {
  const sourceText = normalizeNaturalLanguageInput(value);
  const relationship =
    /^(.{1,40}?)(?:和|与)(.{1,40}?)(?:是|为)(.{1,32}?)(?:关系)?(?:[，,。；;]|$)(?:.*?(?:在|从)(.{1,40}?)(?:就)?(?:认识|相识|开始))?/u.exec(
      sourceText,
    );
  if (relationship !== null) {
    const fromName = cleanEntityName(relationship[1]);
    const toName = cleanEntityName(relationship[2]);
    const relationshipType = cleanRelationshipType(relationship[3]);
    if (fromName.length > 0 && toName.length > 0 && relationshipType.length > 0) {
      const since = relationship[4]?.trim() ?? null;
      return Object.freeze({
        kind: "relationship",
        sourceText,
        fromName,
        toName,
        relationshipType,
        since,
        suggestions: Object.freeze([
          "可以补充两人何时确定关系。",
          "可以补充这段关系是否对其他人物公开。",
        ]),
      });
    }
  }

  const roleProfile =
    /^(?<character>[\p{Script=Han}A-Za-z·]{1,20})(?:是(?:一名)?|担任)(?<role>[^，,。！？]{1,80})(?:[，,]\s*(?<tail>[^。！？]{1,500}))?[。！？]?$/u.exec(
      sourceText,
    );
  const roleCharacter = cleanEntityName(roleProfile?.groups?.character);
  const role = roleProfile?.groups?.role?.trim() ?? "";
  if (roleCharacter.length > 0 && role.length > 0) {
    const tail = roleProfile?.groups?.tail?.trim() ?? null;
    const ageAndDetails =
      tail === null
        ? null
        : /^(?<age>[一二三四五六七八九十百0-9]{1,3}岁)(?:[，,]\s*(?<details>.+))?$/u.exec(tail);
    const details = ageAndDetails === null ? tail : (ageAndDetails.groups?.details?.trim() ?? null);
    return Object.freeze({
      kind: "character_profile",
      sourceText,
      characterName: roleCharacter,
      role,
      age: ageAndDetails?.groups?.age ?? null,
      details,
      suggestions: Object.freeze([
        "可以补充这个身份从何时开始。",
        "可以补充这一身份是否对其他人物公开。",
      ]),
    });
  }

  const ageProfile =
    /^(?<character>[\p{Script=Han}A-Za-z·]{1,20}?)(?<age>[一二三四五六七八九十百0-9]{1,3}岁)(?:[，,]\s*(?<details>[^。！？]{1,500}))?[。！？]?$/u.exec(
      sourceText,
    );
  const ageCharacter = cleanEntityName(ageProfile?.groups?.character);
  const age = ageProfile?.groups?.age;
  if (ageCharacter.length > 0 && age !== undefined) {
    return Object.freeze({
      kind: "character_profile",
      sourceText,
      characterName: ageCharacter,
      role: null,
      age,
      details: ageProfile?.groups?.details?.trim() ?? null,
      suggestions: Object.freeze(["可以补充年龄对应的故事时间点。"]),
    });
  }

  const voice = /^(.{1,40}?)(?:说话|讲话)(.{1,500})$/u.exec(sourceText);
  if (voice !== null) {
    const characterName = cleanEntityName(voice[1]);
    const description = voice[2]?.replace(/^[：:，,\s]+/u, "").replace(/[。\s]+$/u, "") ?? "";
    if (characterName.length > 0 && description.length > 0) {
      return Object.freeze({
        kind: "character_voice",
        sourceText,
        characterName,
        voice: description,
        suggestions: Object.freeze(["可以补充她面对不同人物时是否会改变说话方式。"]),
      });
    }
  }

  if (/(?:每当|每次|都会|必须|不能|禁止)/u.test(sourceText)) {
    return Object.freeze({
      kind: "world_rule",
      sourceText,
      title: deriveRuleTitle(sourceText),
      rule: sourceText.replace(/[。\s]+$/u, ""),
      suggestions: Object.freeze([
        "可以补充这条规则适用于哪些人物或地点。",
        "可以补充违反规则会产生什么后果。",
      ]),
    });
  }

  return Object.freeze({
    kind: "manual",
    sourceText,
    missingInformation: "缺少明确的人物、身份、年龄、关系两端或规则约束。",
    suggestions: Object.freeze(["请选择人物、关系、世界规则或写作偏好，再用结构化表单确认。"]),
  });
}

export function inspectLegacyGuidedOpeningRecords(
  records: readonly FormalStoryRecord[],
  facts: readonly StoryFact[],
): readonly LegacyGuidedOpeningRepairItem[] {
  const repairs: LegacyGuidedOpeningRepairItem[] = [];
  for (const record of records) {
    const snapshot = record.toSnapshot();
    const key = String(snapshot.recordKey);
    const value = storyObject(record.currentValue);
    if (
      key === "guided_opening.characters" &&
      value !== null &&
      value.schemaVersion !== "inkshadow.character-setting.v1"
    ) {
      const protagonist = stringValue(value.protagonist);
      repairs.push(
        Object.freeze({
          id: `record:${record.id}`,
          kind: "character_record",
          sourceKind: "record",
          sourceId: record.id,
          expectedRevision: record.revision,
          relationshipType: null,
          title: "整理开书人物卡",
          beforeSummary: "旧版开书人物资料混合了多个字段。",
          afterSummary:
            protagonist === null
              ? "转为“未命名主角”待补全卡片，并保留原始来源。"
              : `转为“未命名主角”卡片：${protagonist}`,
          needsUserInput: protagonist === null,
        }),
      );
    }
    if (key === "guided_opening.characters" && value !== null) {
      const relationship = stringValue(value.legacyRelationship) ?? stringValue(value.relationship);
      if (relationship !== null) {
        repairs.push(
          Object.freeze({
            id: `record-relationship:${record.id}`,
            kind: "incomplete_relationship",
            sourceKind: "record",
            sourceId: record.id,
            expectedRevision: record.revision,
            relationshipType: relationship,
            title: "补全开书人物关系",
            beforeSummary: `旧记录只保存了关系类型“${relationship}”，仍缺少两端人物。`,
            afterSummary: "请明确填写人物一、人物二和关系类型；成功保存新关系后才会整理旧字段。",
            needsUserInput: true,
          }),
        );
      }
    }
    if (
      key === "guided_opening.rules" &&
      value !== null &&
      value.schemaVersion !== "inkshadow.world-rule-setting.v1"
    ) {
      repairs.push(
        Object.freeze({
          id: `record:${record.id}`,
          kind: "writing_rule_record",
          sourceKind: "record",
          sourceId: record.id,
          expectedRevision: record.revision,
          relationshipType: null,
          title: "整理开书写作约定",
          beforeSummary: "旧版开书写作约定仍使用早期保存格式。",
          afterSummary: "转为可读的“开书写作约定”版本记录，原值仍保留在历史版本。",
          needsUserInput: false,
        }),
      );
    }
  }
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    if (
      snapshot.status !== "deprecated" &&
      isRelationshipFact(snapshot) &&
      readRelationship(snapshot) === null
    ) {
      const relationshipType = firstString(storyObject(snapshot.structuredValue), [
        "relationshipType",
        "relationship",
        "type",
      ]);
      repairs.push(
        Object.freeze({
          id: `fact:${fact.id}`,
          kind: "incomplete_relationship",
          sourceKind: "fact",
          sourceId: fact.id,
          expectedRevision: snapshot.revision,
          relationshipType,
          title: "补全没有两端的人物关系",
          beforeSummary: snapshot.contentText ?? "旧关系没有可显示内容。",
          afterSummary: "请明确填写两端人物和关系类型；新关系保存成功后才会停用这条旧事实。",
          needsUserInput: true,
        }),
      );
    }
  }
  return Object.freeze(repairs);
}

export function projectStorySettingsForExport(
  input: Readonly<{
    projectName: string;
    exportedAt: string;
    records: readonly FormalStoryRecord[];
    facts: readonly StoryFact[];
    memories: readonly MemoryRecord[];
  }>,
): StorySettingsExportProjection {
  const warnings: string[] = [];
  const characters: StorySettingsCharacter[] = [];
  const characterRefs = new Map<string, string>();
  for (const record of input.records.filter(({ kind }) => kind === "character")) {
    const snapshot = record.toSnapshot();
    const value = storyObject(record.currentValue);
    const name = firstString(value, ["name", "title", "canonicalName"]);
    const legacyProtagonist = stringValue(value?.protagonist);
    const resolvedName =
      name ?? (String(snapshot.recordKey) === "guided_opening.characters" ? "未命名主角" : null);
    if (resolvedName === null) {
      warnings.push("有一条人物记录没有可导出的名称，已跳过。");
      continue;
    }
    const portableId = `character.${record.id}`;
    const aliases = stringArray(value?.aliases);
    const role = firstString(value, ["role"]);
    const shortDescription =
      firstString(value, ["shortDescription", "description"]) ?? legacyProtagonist;
    const currentGoal = firstString(value, ["currentGoal"]);
    const currentState = firstString(value, ["currentState"]);
    characters.push(
      Object.freeze({
        id: portableId,
        name: resolvedName,
        ...(role === null ? {} : { role }),
        aliases,
        ...(shortDescription === null ? {} : { shortDescription }),
        traits: stringArray(value?.traits),
        ...(currentGoal === null ? {} : { currentGoal }),
        knownInformation: stringArray(value?.knownInformation),
        ...(currentState === null ? {} : { currentState }),
        locked: booleanValue(value?.locked) ?? false,
      }),
    );
    for (const ref of [String(snapshot.recordKey), record.id, resolvedName, ...aliases]) {
      characterRefs.set(normalizeReference(ref), portableId);
    }
  }

  const relationships: StorySettingsRelationship[] = [];
  const writingPreferences: InkShadowStorySettingsV1["writingPreferences"][number][] = [];
  for (const fact of input.facts.filter(
    (candidate) => candidate.toSnapshot().status !== "deprecated",
  )) {
    const snapshot = fact.toSnapshot();
    if (isRelationshipFact(snapshot)) {
      const relation = readRelationship(snapshot);
      if (relation === null) {
        warnings.push("有一条人物关系缺少两端人物，保留在项目待补全区但不写入导出包。");
        continue;
      }
      const from = characterRefs.get(normalizeReference(relation.from));
      const to = characterRefs.get(normalizeReference(relation.to));
      if (from === undefined || to === undefined) {
        warnings.push("有一条人物关系无法稳定对应到两端人物，已跳过。");
        continue;
      }
      const evidence = relation.evidence ?? snapshot.source.excerpt;
      relationships.push(
        Object.freeze({
          id: `relationship.${fact.id}`,
          fromCharacterRef: from,
          toCharacterRef: to,
          relationshipType: relation.type,
          ...(relation.since === null ? {} : { since: relation.since }),
          ...(relation.publicStatus === null ? {} : { publicStatus: relation.publicStatus }),
          ...(relation.privateStatus === null ? {} : { privateStatus: relation.privateStatus }),
          ...(relation.currentChange === null ? {} : { currentChange: relation.currentChange }),
          ...(evidence === null ? {} : { evidence }),
        }),
      );
    } else if (snapshot.factType === "writing_rule" && snapshot.contentText !== null) {
      writingPreferences.push(
        Object.freeze({
          id: `preference.${fact.id}`,
          content: snapshot.contentText,
          source:
            firstString(storyObject(snapshot.structuredValue), ["source"]) ??
            friendlySource(snapshot),
        }),
      );
    }
  }

  const worldRules: StorySettingsWorldRule[] = [];
  for (const record of input.records.filter(({ kind }) => kind === "world_rule")) {
    const value = storyObject(record.currentValue);
    const title = firstString(value, ["title"]);
    const rule = firstString(value, ["rule", "description"]);
    if (title === null || rule === null) {
      warnings.push("有一条规则记录缺少可导出的标题或内容，已跳过。");
      continue;
    }
    const scope = firstString(value, ["scope"]);
    const consequence = firstString(value, ["consequence"]);
    const effectiveAt = firstString(value, ["effectiveAt"]);
    const evidence = firstString(value, ["evidence"]);
    worldRules.push(
      Object.freeze({
        id: `rule.${record.id}`,
        title,
        rule,
        ...(scope === null ? {} : { scope }),
        exceptions: stringArray(value?.exceptions),
        ...(consequence === null ? {} : { consequence }),
        ...(effectiveAt === null ? {} : { effectiveAt }),
        ...(evidence === null ? {} : { evidence }),
        locked: booleanValue(value?.locked) ?? false,
      }),
    );
  }

  return Object.freeze({
    bundle: Object.freeze({
      format: STORY_SETTINGS_FORMAT,
      schemaVersion: STORY_SETTINGS_SCHEMA_VERSION,
      projectMetadata: Object.freeze({ name: input.projectName, exportedAt: input.exportedAt }),
      characters: Object.freeze(characters),
      relationships: Object.freeze(relationships),
      worldRules: Object.freeze(worldRules),
      writingPreferences: Object.freeze(writingPreferences),
      memories: Object.freeze(
        input.memories.map((memory) => {
          const snapshot = memory.toSnapshot();
          return Object.freeze({
            id: `memory.${memory.id}`,
            level: snapshot.level,
            content: snapshot.content,
          });
        }),
      ),
    }),
    warnings: Object.freeze(warnings),
  });
}

export function readRelationship(snapshot: StoryFactSnapshot): Readonly<{
  from: string;
  to: string;
  type: string;
  since: string | null;
  publicStatus: string | null;
  privateStatus: string | null;
  currentChange: string | null;
  evidence: string | null;
}> | null {
  const value = storyObject(snapshot.structuredValue);
  if (value === null) return null;
  const from = firstString(value, ["fromCharacterRef", "fromCharacterId", "fromName"]);
  const to = firstString(value, ["toCharacterRef", "toCharacterId", "toName"]);
  const type = firstString(value, ["relationshipType", "relationship", "type"]);
  if (from === null || to === null || type === null || from === to) return null;
  return Object.freeze({
    from,
    to,
    type,
    since: firstString(value, ["since"]),
    publicStatus: firstString(value, ["publicStatus"]),
    privateStatus: firstString(value, ["privateStatus"]),
    currentChange: firstString(value, ["currentChange", "change"]),
    evidence: firstString(value, ["evidence"]),
  });
}

export function isRelationshipFact(snapshot: StoryFactSnapshot): boolean {
  return (
    snapshot.factType === "relationship" ||
    snapshot.factType === "core_relationship" ||
    snapshot.factType === "relationship_change"
  );
}

function normalizeNaturalLanguageInput(value: string): string {
  const normalized = value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_NATURAL_LANGUAGE_SETTING ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`设定需要 1–${String(MAX_NATURAL_LANGUAGE_SETTING)} 个可读字符。`);
  }
  return normalized;
}

function cleanEntityName(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^(?:人物|角色|主角)[：:\s]*/u, "")
    .replace(/[，,。；;：:\s]+$/u, "");
}

function cleanRelationshipType(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/关系$/u, "")
    .replace(/[，,。；;：:\s]+$/u, "");
}

function deriveRuleTitle(value: string): string {
  const normalized = value.replace(/[。！？!?\s]+$/u, "");
  return normalized.length <= 24 ? normalized : `${normalized.slice(0, 22)}…`;
}

function friendlySource(snapshot: StoryFactSnapshot): string {
  return snapshot.source.kind === "user_statement" ? "用户确认" : "保留原始来源";
}

function normalizeReference(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function storyObject(value: StoryValue | undefined): Readonly<Record<string, StoryValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, StoryValue>>)
    : null;
}

function stringValue(value: StoryValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: StoryValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function firstString(
  value: Readonly<Record<string, StoryValue>> | null,
  keys: readonly string[],
): string | null {
  if (value === null) return null;
  for (const key of keys) {
    const resolved = stringValue(value[key]);
    if (resolved !== null) return resolved;
  }
  return null;
}

function stringArray(value: StoryValue | undefined): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]);
}
