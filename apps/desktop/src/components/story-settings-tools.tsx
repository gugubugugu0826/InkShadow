import { useEffect, useMemo, useRef, useState } from "react";
import {
  createStorySettingsTemplate,
  preflightStorySettingsJson,
  serializeStorySettings,
  type InkShadowStorySettingsV1,
  type StorySettingsPreflightReport,
} from "@inkshadow/import-export/core";
import type { FormalStoryRecord, MemoryRecord, StoryFact } from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Drawer,
  FormField,
  InlineAlert,
  Input,
  Select,
  Textarea,
} from "@inkshadow/ui";

import type { DesktopRuntime } from "../infrastructure/runtime";
import { downloadBrowserExportArtifact } from "../infrastructure/export-artifact-download";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import {
  ordinaryStorySettingsIssueAction,
  ordinaryStorySettingsIssueLocation,
  ordinaryStorySettingsIssueMessage,
} from "../infrastructure/story-settings-ordinary-language";
import {
  inspectLegacyGuidedOpeningRecords,
  parseNaturalLanguageSetting,
  projectStorySettingsForExport,
  readRelationship,
  type LegacyGuidedOpeningRepairItem,
  type NaturalLanguageSettingCandidate,
} from "../infrastructure/story-settings-authoring";
import {
  StorySettingsImportError,
  type StorySettingsConflictAction,
  type StorySettingsConflictResolution,
  type StorySettingsImportReceipt,
  type StorySettingsImportService,
  type StorySettingsLegacyRepairRelationship,
  type StorySettingsLegacyRepairSource,
} from "../infrastructure/story-settings-import-service";

const IMPORT_STEPS = [
  "选择内容",
  "格式规则",
  "模板与示例",
  "选择文件",
  "校验与预览",
  "解决冲突",
  "确认导入",
] as const;

type StorySettingsRuntime = Pick<DesktopRuntime, "ids" | "clock"> &
  Pick<DesktopRuntime, "story"> &
  Readonly<{ storySettingsImport: StorySettingsImportService | null }>;

interface StorySettingsToolsProps {
  readonly runtime: StorySettingsRuntime;
  readonly projectId: string;
  readonly projectName: string;
  readonly records: readonly FormalStoryRecord[];
  readonly facts: readonly StoryFact[];
  readonly memories: readonly MemoryRecord[];
  readonly activeSection: "characters" | "world" | "memory" | "preferences" | "other";
  readonly readonly: boolean;
  readonly onChanged: () => Promise<void> | void;
  readonly onOpenManualForm: (draft: ManualFactFormDraft) => void;
}

export interface ManualFactFormDraft {
  readonly contentText: string;
  readonly suggestedFactType: "character_identity" | "world_setting" | "writing_rule" | null;
  readonly returnFocusElementId: string;
}

interface StorySettingsConflictEntry {
  readonly kind: "character" | "world_rule";
  readonly portableId: string;
  readonly displayName: string;
  readonly existing: FormalStoryRecord;
}

interface LegacyRelationshipRepairState extends StorySettingsLegacyRepairSource {
  readonly operationId: string;
  readonly relationshipType: string | null;
}

interface LegacyFinalizeConfirmation {
  readonly relationshipFactId: string;
  readonly originalSourceRevision: number;
  readonly currentSourceRevision: number;
}

export function StorySettingsTools(props: StorySettingsToolsProps) {
  const [plainLanguageOpen, setPlainLanguageOpen] = useState(false);
  const [plainLanguage, setPlainLanguage] = useState("");
  const [plainCandidate, setPlainCandidate] = useState<NaturalLanguageSettingCandidate | null>(
    null,
  );
  const [plainBusy, setPlainBusy] = useState(false);
  const [plainReceipt, setPlainReceipt] = useState<StorySettingsImportReceipt | null>(null);
  const [legacyRelationshipRepair, setLegacyRelationshipRepair] =
    useState<LegacyRelationshipRepairState | null>(null);
  const [legacyFinalizeConfirmation, setLegacyFinalizeConfirmation] =
    useState<LegacyFinalizeConfirmation | null>(null);
  const [legacyRepairCompleted, setLegacyRepairCompleted] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [importStep, setImportStep] = useState(0);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<StorySettingsPreflightReport | null>(null);
  const [resolutions, setResolutions] = useState<
    Readonly<Record<string, StorySettingsConflictResolution>>
  >({});
  const [importBusy, setImportBusy] = useState(false);
  const [receipt, setReceipt] = useState<StorySettingsImportReceipt | null>(null);
  const [notice, setNotice] = useState<Readonly<{
    tone: "info" | "warning" | "error";
    title: string;
    description: string;
  }> | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairBusyId, setRepairBusyId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileInspectionSequence = useRef(0);
  const importOperationId = useRef<string | null>(null);
  const receiptInspectionSequence = useRef(0);
  const manualFormFrame = useRef<number | null>(null);
  const plainLanguageTriggerId = `story-settings-plain-language-${props.projectId}`;

  const characterRecords = useMemo(
    () => props.records.filter(({ kind }) => kind === "character"),
    [props.records],
  );
  const worldRuleRecords = useMemo(
    () => props.records.filter(({ kind }) => kind === "world_rule"),
    [props.records],
  );
  const existingCharacterByName = useMemo(() => {
    const index = new Map<string, FormalStoryRecord>();
    for (const record of characterRecords) {
      const value = storyObject(record.currentValue);
      const name = readString(value.name);
      if (name !== null) index.set(normalizeName(name), record);
      for (const alias of readStringList(value.aliases)) {
        index.set(normalizeName(alias), record);
      }
    }
    return index;
  }, [characterRecords]);
  const existingWorldRuleByTitle = useMemo(() => {
    const index = new Map<string, FormalStoryRecord>();
    for (const record of worldRuleRecords) {
      const title = readString(storyObject(record.currentValue).title);
      if (title !== null) index.set(normalizeName(title), record);
    }
    return index;
  }, [worldRuleRecords]);
  const existingSettingsIndex = useMemo(
    () => ({
      characterNames: characterRecords
        .map((record) => readString(storyObject(record.currentValue).name))
        .filter((value): value is string => value !== null),
      characterAliases: characterRecords.flatMap((record) =>
        readStringList(storyObject(record.currentValue).aliases),
      ),
      worldRuleTitles: worldRuleRecords
        .map((record) => readString(storyObject(record.currentValue).title))
        .filter((value): value is string => value !== null),
    }),
    [characterRecords, worldRuleRecords],
  );
  const legacyRepairs = useMemo(
    () => inspectLegacyGuidedOpeningRecords(props.records, props.facts),
    [props.facts, props.records],
  );
  const relationshipRows = useMemo(
    () =>
      props.facts
        .map((fact) => ({ fact, snapshot: fact.toSnapshot() }))
        .filter(({ snapshot }) => snapshot.status !== "deprecated")
        .map(({ fact, snapshot }) => ({ fact, relationship: readRelationship(snapshot) }))
        .filter(
          (
            entry,
          ): entry is Readonly<{
            fact: StoryFact;
            relationship: NonNullable<ReturnType<typeof readRelationship>>;
          }> => entry.relationship !== null,
        ),
    [props.facts],
  );

  useEffect(() => {
    if (!transferOpen || props.runtime.storySettingsImport === null) return;
    const inspectionSequence = receiptInspectionSequence.current + 1;
    receiptInspectionSequence.current = inspectionSequence;
    const service = props.runtime.storySettingsImport;
    void (async () => {
      try {
        const recent = await service.listRecentReceipts(props.projectId, 20);
        if (receiptInspectionSequence.current !== inspectionSequence) return;
        const latestCommitted = recent.find(({ status }) => status === "committed");
        if (latestCommitted !== undefined) setReceipt(latestCommitted);
      } catch (cause: unknown) {
        if (receiptInspectionSequence.current !== inspectionSequence) return;
        setNotice({
          tone: "error",
          title: "无法读取最近导入记录",
          description: `${projectOrdinaryUiError(cause).description} 当前页面内容没有改变，可关闭后重试。`,
        });
      }
    })();
    return () => {
      if (receiptInspectionSequence.current === inspectionSequence) {
        receiptInspectionSequence.current += 1;
      }
    };
  }, [props.projectId, props.runtime.storySettingsImport, transferOpen]);

  useEffect(
    () => () => {
      if (manualFormFrame.current !== null) {
        window.cancelAnimationFrame(manualFormFrame.current);
      }
    },
    [],
  );

  const conflicts = useMemo<readonly StorySettingsConflictEntry[]>(() => {
    const candidate = preflight?.candidate;
    if (candidate === undefined) return [];
    const characterConflicts = candidate.characters.flatMap((character) => {
      const existing = [character.name, ...character.aliases]
        .map((name) => existingCharacterByName.get(normalizeName(name)))
        .find((record) => record !== undefined);
      return existing === undefined
        ? []
        : [
            {
              kind: "character" as const,
              portableId: character.id,
              displayName: character.name,
              existing,
            },
          ];
    });
    const worldRuleConflicts = candidate.worldRules.flatMap((rule) => {
      const existing = existingWorldRuleByTitle.get(normalizeName(rule.title));
      return existing === undefined
        ? []
        : [{ kind: "world_rule" as const, portableId: rule.id, displayName: rule.title, existing }];
    });
    return [...characterConflicts, ...worldRuleConflicts];
  }, [existingCharacterByName, existingWorldRuleByTitle, preflight?.candidate]);
  const unresolvedConflictCount = conflicts.filter(
    ({ portableId }) => resolutions[portableId] === undefined,
  ).length;

  function parsePlainLanguage(): void {
    setNotice(null);
    try {
      setPlainCandidate(parseNaturalLanguageSetting(plainLanguage));
    } catch (cause: unknown) {
      setNotice(errorNotice(cause));
    }
  }

  async function confirmPlainCandidate(): Promise<void> {
    if (plainCandidate === null || props.readonly || plainBusy) return;
    if (legacyRelationshipRepair !== null && plainCandidate.kind !== "relationship") {
      setNotice({
        tone: "warning",
        title: "还没有完整的两端人物关系",
        description: "请明确写出人物一、人物二和关系类型；旧来源保持不变。",
      });
      return;
    }
    if (plainCandidate.kind === "manual") {
      setPlainLanguageOpen(false);
      if (manualFormFrame.current !== null) {
        window.cancelAnimationFrame(manualFormFrame.current);
      }
      const draft: ManualFactFormDraft = {
        contentText: plainLanguage,
        suggestedFactType: suggestedManualFactType(props.activeSection),
        returnFocusElementId: plainLanguageTriggerId,
      };
      manualFormFrame.current = window.requestAnimationFrame(() => {
        manualFormFrame.current = null;
        props.onOpenManualForm(draft);
      });
      return;
    }
    if (props.runtime.storySettingsImport === null) {
      setNotice({
        tone: "warning",
        title: "当前预览环境不写入本地数据库",
        description: "桌面版会在确认后使用单一事务写入；你仍可以使用结构化手动表单。",
      });
      return;
    }
    setPlainBusy(true);
    setNotice(null);
    try {
      if (legacyRelationshipRepair !== null) {
        const existingRelationship =
          await props.runtime.storySettingsImport.findLegacyRepairRelationship({
            projectId: props.projectId,
            source: {
              kind: legacyRelationshipRepair.kind,
              sourceId: legacyRelationshipRepair.sourceId,
              expectedRevision: legacyRelationshipRepair.expectedRevision,
            },
          });
        if (existingRelationship !== null) {
          if (
            existingRelationship.expectedSourceRevision !==
              legacyRelationshipRepair.expectedRevision &&
            !sameLegacyFinalizeConfirmation(
              legacyFinalizeConfirmation,
              existingRelationship,
              legacyRelationshipRepair.expectedRevision,
            )
          ) {
            setLegacyFinalizeConfirmation({
              relationshipFactId: existingRelationship.relationshipFactId,
              originalSourceRevision: existingRelationship.expectedSourceRevision,
              currentSourceRevision: legacyRelationshipRepair.expectedRevision,
            });
            setNotice({
              tone: "warning",
              title: "旧来源已变化，需要再次确认",
              description:
                "完整关系已经保存，本次不会重复创建。旧来源在上次确认后又有修改；请核对当前内容，然后再次点击“确认按当前版本完成迁移”，墨影才会按当前修订号安全收尾。",
            });
            return;
          }
          setLegacyFinalizeConfirmation(null);
          const cleaned = await finalizeLegacyRelationshipRepair(
            legacyRelationshipRepair,
            existingRelationship.relationshipFactId,
          );
          await props.onChanged();
          if (!cleaned) {
            setNotice({
              tone: "warning",
              title: "新关系仍然安全，旧来源尚未收尾",
              description:
                "已复用先前保存的完整关系，没有重复创建。旧来源在本次收尾期间再次变化；请关闭后从待整理列表重新打开，核对当前内容并再次确认。",
            });
            return;
          }
          setLegacyRepairCompleted(true);
          setPlainCandidate(null);
          setPlainLanguage("");
          setNotice({
            tone: "info",
            title: "旧关系迁移已完成",
            description: "已复用先前保存的新关系，本次只完成旧来源的安全收尾。",
          });
          return;
        }
      }
      const bundle = plainCandidateBundle(plainCandidate);
      const characterResolutions: Record<string, StorySettingsConflictResolution> = {};
      const worldRuleResolutions: Record<string, StorySettingsConflictResolution> = {};
      for (const character of bundle.characters) {
        const existing = existingCharacterByName.get(normalizeName(character.name));
        if (existing !== undefined) {
          characterResolutions[character.id] = {
            action:
              plainCandidate.kind === "character_voice" ||
              plainCandidate.kind === "character_profile"
                ? "merge"
                : "keep_current",
            existingRecordId: existing.id,
            expectedRevision: existing.revision,
            expectedCurrentVersion: existing.toSnapshot().currentVersion,
          };
        }
      }
      for (const rule of bundle.worldRules) {
        const existing = existingWorldRuleByTitle.get(normalizeName(rule.title));
        if (existing !== undefined) {
          worldRuleResolutions[rule.id] = {
            action: "merge",
            existingRecordId: existing.id,
            expectedRevision: existing.revision,
            expectedCurrentVersion: existing.toSnapshot().currentVersion,
          };
        }
      }
      const committed = await props.runtime.storySettingsImport.import({
        operationId: legacyRelationshipRepair?.operationId ?? props.runtime.ids.next(),
        projectId: props.projectId,
        actorId: props.runtime.story.actorId,
        bundle,
        resolutions: {
          characters: characterResolutions,
          worldRules: worldRuleResolutions,
        },
        ...(legacyRelationshipRepair === null
          ? {}
          : {
              legacyRepairSource: {
                kind: legacyRelationshipRepair.kind,
                sourceId: legacyRelationshipRepair.sourceId,
                expectedRevision: legacyRelationshipRepair.expectedRevision,
              },
            }),
        humanConfirmed: true,
      });
      setPlainReceipt(committed);
      if (legacyRelationshipRepair !== null) {
        const relationshipFactId = committed.createdFactIds[0];
        if (relationshipFactId === undefined) {
          throw new Error("新关系已提交，但导入收据没有记录关系事实编号。");
        }
        const cleaned = await finalizeLegacyRelationshipRepair(
          legacyRelationshipRepair,
          relationshipFactId,
        );
        await props.onChanged();
        if (!cleaned) {
          setNotice({
            tone: "warning",
            title: "新关系已保存，旧提示仍保留",
            description:
              "旧来源在收尾时发生变化，因此没有被停用或改写。新关系和导入收据均已保留；请关闭后从待整理列表重新打开，核对当前内容并再次确认，系统不会创建第二条关系。",
          });
          return;
        }
        setLegacyRepairCompleted(true);
        setPlainCandidate(null);
        setPlainLanguage("");
        setNotice({
          tone: "info",
          title: "旧关系已补全并完成迁移",
          description: "新关系已保存为正式事实，旧来源已按原修订号安全整理；本地整理建议没有写入。",
        });
        return;
      }
      await props.onChanged();
      setPlainCandidate(null);
      setPlainLanguage("");
      setNotice({
        tone: "info",
        title: "设定已保存",
        description: "只写入了你刚才确认的字段；本地整理建议没有被当成事实。",
      });
    } catch (cause: unknown) {
      setNotice(errorNotice(cause));
    } finally {
      setPlainBusy(false);
    }
  }

  async function finalizeLegacyRelationshipRepair(
    repair: LegacyRelationshipRepairState,
    relationshipFactId: string,
  ): Promise<boolean> {
    if (repair.kind === "fact") {
      const source = props.facts.find(({ id }) => id === repair.sourceId);
      if (source?.revision !== repair.expectedRevision) return false;
      const deprecated = await props.runtime.story.factService.deprecate({
        factId: repair.sourceId,
        humanConfirmed: true,
        expectedRevision: repair.expectedRevision,
      });
      return deprecated.ok;
    }
    const source = props.records.find(({ id }) => id === repair.sourceId);
    if (source?.revision !== repair.expectedRevision) return false;
    const current = storyObject(source.currentValue);
    const next: Record<string, unknown> = { ...current };
    delete next.relationship;
    delete next.legacyRelationship;
    next.legacyRelationshipMigration = {
      schemaVersion: "inkshadow.legacy-relationship-migration.v1",
      relationshipFactId,
      supersedesSourceId: repair.sourceId,
    };
    const changed = await props.runtime.story.formalRecordService.edit({
      recordId: repair.sourceId,
      value: next,
      actorId: props.runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: repair.expectedRevision,
    });
    return changed.ok;
  }

  async function undoPlainImport(): Promise<void> {
    if (
      plainReceipt?.status !== "committed" ||
      props.runtime.storySettingsImport === null ||
      props.readonly ||
      plainBusy ||
      legacyRepairCompleted
    ) {
      return;
    }
    setPlainBusy(true);
    try {
      const undone = await props.runtime.storySettingsImport.undo({
        receiptId: plainReceipt.id,
        projectId: props.projectId,
        actorId: props.runtime.story.actorId,
        humanConfirmed: true,
      });
      setPlainReceipt(undone);
      setLegacyRelationshipRepair((current) =>
        current === null ? null : { ...current, operationId: props.runtime.ids.next() },
      );
      await props.onChanged();
      setNotice({
        tone: "info",
        title: "本次一句话设定已撤销",
        description: "撤销只处理这张导入收据记录的新内容，原有设定保持不变。",
      });
    } catch (cause: unknown) {
      setNotice(errorNotice(cause));
    } finally {
      setPlainBusy(false);
    }
  }

  function downloadTemplate(): void {
    downloadBrowserExportArtifact({
      fileName: "inkshadow-story-settings-template.json",
      mediaType: "application/json",
      content: serializeStorySettings(createStorySettingsTemplate()),
    });
  }

  function downloadSettings(scope: "all" | "current"): void {
    try {
      const projected = projectStorySettingsForExport({
        projectName: props.projectName,
        exportedAt: props.runtime.clock.now(),
        records: props.records,
        facts: props.facts,
        memories: props.memories,
      });
      const bundle =
        scope === "all" ? projected.bundle : filterBundle(projected.bundle, props.activeSection);
      const content = serializeStorySettings(bundle);
      downloadBrowserExportArtifact({
        fileName: safeExportName(props.projectName, scope),
        mediaType: "application/json",
        content,
      });
      setNotice({
        tone: projected.warnings.length > 0 ? "warning" : "info",
        title: scope === "all" ? "全部故事设定已导出" : "当前分类已导出",
        description:
          projected.warnings.length === 0
            ? "导出包已再次通过同一套导入预检，且不包含密钥、提示词或隐藏推理。"
            : `${String(projected.warnings.length)} 项不完整或不稳定内容未进入导出包，可在待补全区查看。`,
      });
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "故事设定没有导出",
        description: `${projectOrdinaryUiError(cause).description} 没有产生可下载的半成品，请检查设定后重试。`,
      });
    }
  }

  async function inspectFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    const inspectionSequence = fileInspectionSequence.current + 1;
    fileInspectionSequence.current = inspectionSequence;
    receiptInspectionSequence.current += 1;
    importOperationId.current = props.runtime.ids.next();
    setImportFileName(null);
    setPreflight(null);
    setResolutions({});
    setReceipt(null);
    setNotice(null);
    if (!file.name.toLocaleLowerCase().endsWith(".json")) {
      setNotice({
        tone: "error",
        title: "只接受墨影设定文件",
        description: "请使用当前应用下载的设定模板；普通小说文件请从“导入小说”入口处理。",
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setNotice({
        tone: "error",
        title: "设定文件过大",
        description: "单个故事设定文件不得超过 5 兆字节。请拆分后重新预检。",
      });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (fileInspectionSequence.current !== inspectionSequence) return;
      setNotice({
        tone: "error",
        title: "无法读取设定文件",
        description: "文件可能已被移动、占用或读取权限已失效。请重新选择文件后再试。",
      });
      return;
    }
    if (fileInspectionSequence.current !== inspectionSequence) return;
    const report = preflightStorySettingsJson(text, existingSettingsIndex);
    setImportFileName(file.name);
    setPreflight(report);
    setResolutions({});
    setReceipt(null);
    setImportStep(report.status === "blocked" ? 4 : 5);
  }

  async function confirmImport(): Promise<void> {
    if (
      props.readonly ||
      props.runtime.storySettingsImport === null ||
      preflight?.candidate === undefined ||
      preflight.status === "blocked" ||
      unresolvedConflictCount > 0 ||
      importBusy
    ) {
      return;
    }
    setImportBusy(true);
    setNotice(null);
    try {
      const operationId = importOperationId.current ?? props.runtime.ids.next();
      importOperationId.current = operationId;
      const committed = await props.runtime.storySettingsImport.import({
        operationId,
        projectId: props.projectId,
        actorId: props.runtime.story.actorId,
        bundle: preflight.candidate,
        resolutions: {
          characters: Object.fromEntries(
            preflight.candidate.characters.flatMap((character) => {
              const resolution = resolutions[character.id];
              return resolution === undefined ? [] : [[character.id, resolution]];
            }),
          ),
          worldRules: Object.fromEntries(
            preflight.candidate.worldRules.flatMap((rule) => {
              const resolution = resolutions[rule.id];
              return resolution === undefined ? [] : [[rule.id, resolution]];
            }),
          ),
        },
        humanConfirmed: true,
      });
      setReceipt(committed);
      await props.onChanged();
      setNotice({
        tone: "info",
        title: "故事设定已导入",
        description: `同一事务写入 ${String(committed.importedCount)} 项，跳过 ${String(committed.skippedCount)} 项；可在此撤销。`,
      });
    } catch (cause: unknown) {
      setNotice(errorNotice(cause));
    } finally {
      setImportBusy(false);
    }
  }

  async function undoImport(): Promise<void> {
    if (
      receipt === null ||
      props.runtime.storySettingsImport === null ||
      props.readonly ||
      importBusy
    )
      return;
    setImportBusy(true);
    try {
      const undone = await props.runtime.storySettingsImport.undo({
        receiptId: receipt.id,
        projectId: props.projectId,
        actorId: props.runtime.story.actorId,
        humanConfirmed: true,
      });
      setReceipt(undone);
      importOperationId.current = props.runtime.ids.next();
      await props.onChanged();
      setNotice({
        tone: "info",
        title: "本次导入已撤销",
        description: "导入前已有的设定与版本历史保持不变。",
      });
    } catch (cause: unknown) {
      setNotice(errorNotice(cause));
    } finally {
      setImportBusy(false);
    }
  }

  async function repairLegacyRecord(item: LegacyGuidedOpeningRepairItem): Promise<void> {
    if (props.readonly || repairBusyId !== null) return;
    const record = props.records.find(({ id }) => id === item.sourceId);
    if (item.kind === "incomplete_relationship") {
      setRepairOpen(false);
      setPlainLanguage("");
      setPlainCandidate(null);
      setPlainReceipt(null);
      setLegacyRepairCompleted(false);
      setLegacyFinalizeConfirmation(null);
      setLegacyRelationshipRepair({
        kind: item.sourceKind,
        sourceId: item.sourceId,
        expectedRevision: item.expectedRevision,
        operationId: props.runtime.ids.next(),
        relationshipType: item.relationshipType,
      });
      setPlainLanguageOpen(true);
      return;
    }
    if (record === undefined) return;
    setRepairBusyId(item.id);
    try {
      const current = storyObject(record.currentValue);
      const protagonist = readString(current.protagonist);
      const legacyRelationship =
        readString(current.legacyRelationship) ?? readString(current.relationship);
      const changed =
        item.kind === "character_record"
          ? {
              schemaVersion: "inkshadow.character-setting.v1",
              name: readString(current.name) ?? "未命名主角",
              shortDescription: protagonist ?? "由旧版开书引导保留，等待补全。",
              aliases: [],
              traits: [],
              knownInformation: [],
              source: "guided_opening_legacy_repair",
              ...(legacyRelationship === null ? {} : { legacyRelationship }),
            }
          : {
              ...current,
              schemaVersion: "inkshadow.world-rule-setting.v1",
              title: "开书写作约定",
              rule: readableLegacyRule(current),
              exceptions: readStringList(current.exceptions),
              locked: current.locked === true,
              source: "guided_opening_legacy_repair",
            };
      const result = await props.runtime.story.formalRecordService.edit({
        recordId: record.id,
        value: changed,
        actorId: props.runtime.story.actorId,
        humanConfirmed: true,
        expectedRevision: record.revision,
      });
      if (!result.ok) throw result.error;
      await props.onChanged();
      setNotice({
        tone: "info",
        title: "旧记录已整理为可读设定",
        description:
          "原始值保留在上一版本，可在版本历史中撤回；没有两端的人物关系仍未转为正式事实。",
      });
    } catch (cause: unknown) {
      setNotice(errorNotice(cause));
    } finally {
      setRepairBusyId(null);
    }
  }

  return (
    <>
      <section className="story-settings-tools" aria-labelledby="story-settings-tools-title">
        <div>
          <h2 id="story-settings-tools-title">快速维护故事设定</h2>
          <p>可以用一句话整理成待确认的设定草稿，也可以使用规范文件批量导入；确认前不会写入。</p>
        </div>
        <div className="story-governance-actions">
          <Button
            id={plainLanguageTriggerId}
            variant="secondary"
            disabled={props.readonly}
            onClick={() => {
              setPlainCandidate(null);
              setLegacyRelationshipRepair(null);
              setLegacyRepairCompleted(false);
              setLegacyFinalizeConfirmation(null);
              setPlainLanguageOpen(true);
            }}
          >
            用一句话添加设定
          </Button>
          <Button variant="secondary" onClick={() => setTransferOpen(true)}>
            导入或导出
          </Button>
          {legacyRepairs.length > 0 && (
            <Button variant="secondary" onClick={() => setRepairOpen(true)}>
              整理 {String(legacyRepairs.length)} 条旧记录
            </Button>
          )}
        </div>
      </section>

      {notice !== null && (
        <InlineAlert
          tone={notice.tone}
          title={notice.title}
          description={notice.description}
          onDismiss={() => setNotice(null)}
        />
      )}

      {props.activeSection === "characters" && (
        <section className="story-relationship-section" aria-labelledby="story-relationships-title">
          <div className="section-heading section-heading--compact">
            <div>
              <h2 id="story-relationships-title">人物关系</h2>
              <p>关系必须明确连接两个人物；缺少任一端的旧内容只进入待补全区。</p>
            </div>
            <Badge>{String(relationshipRows.length)} 条稳定关系</Badge>
          </div>
          {relationshipRows.length === 0 ? (
            <p className="story-governance-copy">还没有两端完整的人物关系。</p>
          ) : (
            <div className="story-relationship-list">
              {relationshipRows.map(({ fact, relationship }) => (
                <article key={fact.id} className="story-relationship-row">
                  <strong>
                    {characterDisplayName(characterRecords, relationship.from)} ↔{" "}
                    {characterDisplayName(characterRecords, relationship.to)}
                  </strong>
                  <span>{relationship.type}</span>
                  <span>{relationship.since ?? "起始时间待补充"}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <Drawer
        open={plainLanguageOpen}
        onOpenChange={(open) => {
          setPlainLanguageOpen(open);
          if (!open) setLegacyFinalizeConfirmation(null);
        }}
        title={legacyRelationshipRepair === null ? "用一句话添加设定" : "补全旧版人物关系"}
        description={
          legacyRelationshipRepair === null
            ? "先在本机整理为待确认的设定草稿；只有你确认的字段会成为正式设定。"
            : "旧来源尚未完成迁移。请明确填写两端人物和关系类型；新关系保存成功后才会整理旧来源。"
        }
        footer={
          <div className="story-governance-actions">
            <Button variant="secondary" onClick={() => setPlainLanguageOpen(false)}>
              取消
            </Button>
            <Button
              disabled={plainCandidate === null || plainBusy || props.readonly}
              onClick={() => void confirmPlainCandidate()}
            >
              {plainCandidate?.kind === "manual"
                ? "打开手动表单"
                : legacyRelationshipRepair === null
                  ? "确认并保存"
                  : legacyFinalizeConfirmation === null
                    ? "保存新关系并完成迁移"
                    : "确认按当前版本完成迁移"}
            </Button>
          </div>
        }
      >
        <div className="story-settings-drawer-content">
          {legacyRelationshipRepair !== null && (
            <InlineAlert
              tone="warning"
              title="这是一项待补全迁移"
              description={`旧来源只提供了${legacyRelationshipRepair.relationshipType === null ? "不完整的关系信息" : `关系类型“${legacyRelationshipRepair.relationshipType}”`}。请按“人物一和人物二是某种关系”的完整句式填写；确认前旧来源不会改变。`}
            />
          )}
          <FormField
            label="描述人物、关系或规则"
            hint="例如：顾顾和丹丹是情侣关系，在初中就认识了。"
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                rows={5}
                maxLength={2_000}
                value={plainLanguage}
                onChange={(event) => {
                  setPlainLanguage(event.currentTarget.value);
                  setPlainCandidate(null);
                  setLegacyFinalizeConfirmation(null);
                }}
              />
            )}
          </FormField>
          <Button
            variant="secondary"
            disabled={plainLanguage.trim().length === 0}
            onClick={parsePlainLanguage}
          >
            整理为待确认设定
          </Button>
          {plainCandidate !== null && <PlainCandidatePreview candidate={plainCandidate} />}
          {plainReceipt?.status === "committed" && (
            <InlineAlert
              tone="info"
              title="本次保存已有可追溯收据"
              description={
                legacyRepairCompleted
                  ? "旧来源也已完成版本化迁移；如需整体回退，请使用版本历史或导入前备份。"
                  : "新内容已隔离记录，可在没有后续依赖时撤销本次保存。"
              }
            />
          )}
          {plainReceipt?.status === "committed" && !legacyRepairCompleted && (
            <Button
              variant="secondary"
              disabled={plainBusy || props.readonly}
              onClick={() => void undoPlainImport()}
            >
              撤销本次一句话设定
            </Button>
          )}
        </div>
      </Drawer>

      <Drawer
        open={transferOpen}
        onOpenChange={setTransferOpen}
        title="导入与导出故事设定"
        description="只接受墨影设定文件；文件留在本机，先预检再确认。"
        footer={
          <div className="story-governance-actions">
            <Button variant="secondary" onClick={() => setTransferOpen(false)}>
              关闭
            </Button>
            {importStep > 0 && (
              <Button variant="secondary" onClick={() => setImportStep((step) => step - 1)}>
                上一步
              </Button>
            )}
            {importStep < IMPORT_STEPS.length - 1 && (
              <Button onClick={() => setImportStep((step) => Math.min(step + 1, 6))}>下一步</Button>
            )}
          </div>
        }
      >
        <div className="story-settings-import-layout">
          <ol className="story-settings-import-steps" aria-label="导入步骤">
            {IMPORT_STEPS.map((label, index) => (
              <li key={label} aria-current={importStep === index ? "step" : undefined}>
                <button type="button" onClick={() => setImportStep(index)}>
                  <span>{String(index + 1)}</span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <div className="story-settings-import-stage">
            <ImportStage
              step={importStep}
              fileName={importFileName}
              report={preflight}
              conflicts={conflicts}
              resolutions={resolutions}
              receipt={receipt}
              importServiceAvailable={props.runtime.storySettingsImport !== null}
              readonly={props.readonly}
              importBusy={importBusy}
              unresolvedConflictCount={unresolvedConflictCount}
              onChooseFile={() => fileInput.current?.click()}
              onDownloadTemplate={downloadTemplate}
              onViewExample={() => {
                fileInspectionSequence.current += 1;
                receiptInspectionSequence.current += 1;
                importOperationId.current = props.runtime.ids.next();
                setResolutions({});
                setReceipt(null);
                setPreflight(
                  preflightStorySettingsJson(
                    serializeStorySettings(createStorySettingsTemplate()),
                    existingSettingsIndex,
                  ),
                );
                setImportFileName("内置示例（未选择本地文件）");
                setImportStep(4);
              }}
              onResolution={(id, resolution) =>
                setResolutions((current) => ({ ...current, [id]: resolution }))
              }
              onConfirm={() => void confirmImport()}
              onUndo={() => void undoImport()}
              onExportCurrent={() => downloadSettings("current")}
              onExportAll={() => downloadSettings("all")}
            />
          </div>
          <Input
            ref={fileInput}
            className="import-file-input"
            type="file"
            accept=".json"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              input.value = "";
              void inspectFile(file);
            }}
          />
        </div>
      </Drawer>

      <Drawer
        open={repairOpen}
        onOpenChange={setRepairOpen}
        title="整理旧版开书设定"
        description="先预览再逐条处理；原始值保留在版本历史，不完整关系不会自动成为正式事实。"
        footer={
          <Button variant="secondary" onClick={() => setRepairOpen(false)}>
            关闭
          </Button>
        }
      >
        <div className="story-settings-repair-list">
          {legacyRepairs.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.beforeSummary}</CardDescription>
              </CardHeader>
              <CardContent>
                <p>{item.afterSummary}</p>
                {item.needsUserInput && <Badge tone="warning">需要你补充</Badge>}
              </CardContent>
              <CardFooter>
                <Button
                  size="sm"
                  disabled={props.readonly || repairBusyId !== null}
                  onClick={() => void repairLegacyRecord(item)}
                >
                  {item.needsUserInput ? "补全后确认" : "确认整理"}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </Drawer>
    </>
  );
}

function PlainCandidatePreview({
  candidate,
}: {
  readonly candidate: NaturalLanguageSettingCandidate;
}) {
  if (candidate.kind === "manual") {
    return (
      <InlineAlert
        tone="info"
        title="需要你选择设定类型"
        description={candidate.missingInformation + " 原句已保留，可以继续使用结构化手动表单。"}
      />
    );
  }
  const details =
    candidate.kind === "relationship"
      ? [
          ["人物一", candidate.fromName],
          ["人物二", candidate.toName],
          ["关系", candidate.relationshipType],
          ["相识时间", candidate.since ?? "待补充"],
        ]
      : candidate.kind === "world_rule"
        ? [
            ["规则名称", candidate.title],
            ["规则内容", candidate.rule],
          ]
        : candidate.kind === "character_profile"
          ? [
              ["人物", candidate.characterName],
              ["身份或任职", candidate.role ?? "待补充"],
              ["年龄", candidate.age ?? "待补充"],
              ["补充说明", candidate.details ?? "待补充"],
            ]
          : [
              ["人物", candidate.characterName],
              ["说话方式", candidate.voice],
            ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>待确认的结构化设定</CardTitle>
        <CardDescription>下面内容尚未写入。</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="story-settings-candidate-fields">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="story-settings-ai-suggestions">
          <strong>本地整理建议（不会自动写入）</strong>
          <ul>
            {candidate.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

interface ImportStageProps {
  readonly step: number;
  readonly fileName: string | null;
  readonly report: StorySettingsPreflightReport | null;
  readonly conflicts: readonly StorySettingsConflictEntry[];
  readonly resolutions: Readonly<Record<string, StorySettingsConflictResolution>>;
  readonly receipt: StorySettingsImportReceipt | null;
  readonly importServiceAvailable: boolean;
  readonly readonly: boolean;
  readonly importBusy: boolean;
  readonly unresolvedConflictCount: number;
  readonly onChooseFile: () => void;
  readonly onDownloadTemplate: () => void;
  readonly onViewExample: () => void;
  readonly onResolution: (id: string, resolution: StorySettingsConflictResolution) => void;
  readonly onConfirm: () => void;
  readonly onUndo: () => void;
  readonly onExportCurrent: () => void;
  readonly onExportAll: () => void;
}

function ImportStage(props: ImportStageProps) {
  if (props.step === 0) {
    return (
      <div>
        <h3>选择要处理的内容</h3>
        <p>导入可以包含人物、两端完整的关系、世界规则、写作偏好和可选记忆。</p>
        <InlineAlert
          tone="info"
          title="原项目不会被覆盖"
          description="文件先做完整预检；冲突逐项决定，正式写入使用单一事务并保留撤销记录。"
        />
        <div className="story-governance-actions">
          <Button variant="secondary" onClick={props.onExportCurrent}>
            导出当前分类
          </Button>
          <Button variant="secondary" onClick={props.onExportAll}>
            导出全部故事设定
          </Button>
        </div>
      </div>
    );
  }
  if (props.step === 1) {
    return (
      <div>
        <h3>唯一支持的机器格式</h3>
        <p>文件必须是墨影设定文件，包含格式标记、版本标记和明确分类数组。</p>
        <ul>
          <li>人物使用稳定编号；同名与别名会在预检中报告。</li>
          <li>每条关系必须引用两个不同的人物编号。</li>
          <li>未知字段会标出精确路径，不会静默写入。</li>
          <li>文件不会包含接口密钥、模型原始响应或隐藏推理。</li>
        </ul>
      </div>
    );
  }
  if (props.step === 2) {
    return (
      <div>
        <h3>从模板开始最稳妥</h3>
        <p>下载模板后只修改示例内容；不要删除模板中的文件格式和版本信息。</p>
        <div className="story-governance-actions">
          <Button onClick={props.onDownloadTemplate}>下载设定模板</Button>
          <Button variant="secondary" onClick={props.onViewExample}>
            查看并预检示例
          </Button>
        </div>
      </div>
    );
  }
  if (props.step === 3) {
    return (
      <div>
        <h3>选择本地设定文件</h3>
        <p>单个文件上限 5 兆字节；不会上传，也不会把普通小说文件误当成设定。</p>
        <Button onClick={props.onChooseFile}>选择墨影设定文件</Button>
        {props.fileName !== null && <p>已选择：{props.fileName}</p>}
      </div>
    );
  }
  if (props.step === 4) {
    return <PreflightSummary report={props.report} fileName={props.fileName} />;
  }
  if (props.step === 5) {
    return (
      <div>
        <h3>逐项解决冲突</h3>
        {props.conflicts.length === 0 ? (
          <InlineAlert tone="info" title="没有名称冲突" description="可以进入最后确认。" />
        ) : (
          <div className="story-settings-conflicts">
            {props.conflicts.map(({ kind, portableId, displayName, existing }) => (
              <FormField
                key={`${kind}:${portableId}`}
                label={`${kind === "character" ? "人物" : "世界规则"}“${displayName}”已存在`}
                hint="不会直接覆盖；请逐项选择处理方式。"
              >
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={props.resolutions[portableId]?.action ?? ""}
                    placeholder="请选择"
                    options={[
                      { value: "merge", label: "合并字段" },
                      { value: "new_copy", label: "新建副本" },
                      { value: "use_import", label: "使用导入内容创建新版本" },
                      { value: "keep_current", label: "保留当前内容" },
                    ]}
                    onChange={(event) =>
                      props.onResolution(portableId, {
                        action: event.currentTarget.value as StorySettingsConflictAction,
                        existingRecordId: existing.id,
                        expectedRevision: existing.revision,
                        expectedCurrentVersion: existing.toSnapshot().currentVersion,
                      })
                    }
                  />
                )}
              </FormField>
            ))}
          </div>
        )}
        {props.unresolvedConflictCount > 0 && (
          <InlineAlert
            tone="warning"
            title={`${String(props.unresolvedConflictCount)} 项冲突尚未决定`}
            description="解决全部冲突后才能提交；当前项目没有被修改。"
          />
        )}
      </div>
    );
  }
  return (
    <div>
      <h3>确认导入</h3>
      <PreflightSummary report={props.report} fileName={props.fileName} />
      {!props.importServiceAvailable && (
        <InlineAlert
          tone="warning"
          title="当前预览环境无法提交"
          description="请在桌面版中打开同一项目；预检与模板仍可使用。"
        />
      )}
      {props.receipt?.status === "committed" ? (
        <InlineAlert
          tone="info"
          title="导入已完成"
          description={`写入 ${String(props.receipt.importedCount)} 项，跳过 ${String(props.receipt.skippedCount)} 项。`}
        />
      ) : props.receipt?.status === "undone" ? (
        <InlineAlert tone="info" title="导入已撤销" description="导入前已有内容保持不变。" />
      ) : null}
      <div className="story-governance-actions">
        <Button
          disabled={
            props.importBusy ||
            props.readonly ||
            !props.importServiceAvailable ||
            props.report?.status !== "ready" ||
            props.unresolvedConflictCount > 0 ||
            props.receipt?.status === "committed"
          }
          onClick={props.onConfirm}
        >
          确认并原子导入
        </Button>
        {props.receipt?.status === "committed" && (
          <Button
            variant="secondary"
            disabled={props.importBusy || props.readonly}
            onClick={props.onUndo}
          >
            撤销本次导入
          </Button>
        )}
      </div>
    </div>
  );
}

function PreflightSummary({
  report,
  fileName,
}: {
  readonly report: StorySettingsPreflightReport | null;
  readonly fileName: string | null;
}) {
  if (report === null) {
    return (
      <InlineAlert tone="warning" title="尚未预检" description="请先选择设定文件或查看示例。" />
    );
  }
  return (
    <div className="story-settings-preflight">
      <h3>校验与预览</h3>
      <p>{fileName ?? "未命名设定文件"}</p>
      <div className="story-settings-preflight-counts">
        <Badge tone={report.status === "ready" ? "success" : "danger"}>
          可导入 {String(report.summary.importableCount)} 项
        </Badge>
        <Badge tone={report.summary.confirmationCount > 0 ? "warning" : "neutral"}>
          需确认 {String(report.summary.confirmationCount)} 项
        </Badge>
        <Badge tone={report.summary.errorCount > 0 ? "danger" : "neutral"}>
          错误 {String(report.summary.errorCount)} 项
        </Badge>
        <Badge>跳过 {String(report.summary.skippedCount)} 项</Badge>
      </div>
      {report.issues.length > 0 && (
        <ul className="story-settings-issue-list">
          {report.issues.map((issue, index) => (
            <li key={`${issue.path}:${issue.code}:${String(index)}`}>
              <strong>{ordinaryStorySettingsIssueLocation(issue)}</strong>：
              {ordinaryStorySettingsIssueMessage(issue)}{" "}
              <span>{ordinaryStorySettingsIssueAction(issue)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function plainCandidateBundle(
  candidate: Exclude<NaturalLanguageSettingCandidate, { kind: "manual" }>,
): InkShadowStorySettingsV1 {
  const base = {
    format: "inkshadow.story-settings" as const,
    schemaVersion: 1 as const,
    characters: [],
    relationships: [],
    worldRules: [],
    writingPreferences: [],
    memories: [],
  };
  if (candidate.kind === "relationship") {
    return {
      ...base,
      characters: [
        portableCharacter("character.statement.from", candidate.fromName),
        portableCharacter("character.statement.to", candidate.toName),
      ],
      relationships: [
        {
          id: "relationship.statement",
          fromCharacterRef: "character.statement.from",
          toCharacterRef: "character.statement.to",
          relationshipType: candidate.relationshipType,
          ...(candidate.since === null ? {} : { since: candidate.since }),
        },
      ],
    };
  }
  if (candidate.kind === "world_rule") {
    return {
      ...base,
      worldRules: [
        {
          id: "rule.statement",
          title: candidate.title,
          rule: candidate.rule,
          exceptions: [],
          locked: false,
        },
      ],
    };
  }
  if (candidate.kind === "character_profile") {
    const shortDescription = [
      candidate.age === null ? null : "年龄：" + candidate.age,
      candidate.details,
    ]
      .filter((value): value is string => value !== null)
      .join("；");
    return {
      ...base,
      characters: [
        {
          ...portableCharacter("character.statement.profile", candidate.characterName),
          ...(candidate.role === null ? {} : { role: candidate.role }),
          ...(shortDescription.length === 0 ? {} : { shortDescription }),
        },
      ],
    };
  }
  return {
    ...base,
    characters: [
      {
        ...portableCharacter("character.statement.voice", candidate.characterName),
        shortDescription: `说话方式：${candidate.voice}`,
      },
    ],
  };
}

function suggestedManualFactType(
  section: StorySettingsToolsProps["activeSection"],
): ManualFactFormDraft["suggestedFactType"] {
  if (section === "characters") return "character_identity";
  if (section === "world") return "world_setting";
  if (section === "preferences") return "writing_rule";
  return null;
}

function portableCharacter(
  id: string,
  name: string,
): InkShadowStorySettingsV1["characters"][number] {
  return { id, name, aliases: [], traits: [], knownInformation: [], locked: false };
}

function filterBundle(
  bundle: InkShadowStorySettingsV1,
  section: StorySettingsToolsProps["activeSection"],
): InkShadowStorySettingsV1 {
  if (section === "characters") {
    return { ...bundle, worldRules: [], writingPreferences: [], memories: [] };
  }
  if (section === "world") {
    return { ...bundle, characters: [], relationships: [], writingPreferences: [], memories: [] };
  }
  if (section === "memory") {
    return { ...bundle, characters: [], relationships: [], worldRules: [], writingPreferences: [] };
  }
  if (section === "preferences") {
    return { ...bundle, characters: [], relationships: [], worldRules: [], memories: [] };
  }
  return bundle;
}

function characterDisplayName(records: readonly FormalStoryRecord[], reference: string): string {
  const record = records.find(({ id }) => id === reference);
  return readString(storyObject(record?.currentValue).name) ?? "待补全人物";
}

function readableLegacyRule(value: Readonly<Record<string, unknown>>): string {
  const direct = ["rule", "writingRules", "forbidden", "style", "pov", "tone", "boundaries"]
    .map((key) => readableLegacyField(value[key]))
    .filter((entry): entry is string => entry !== null);
  return direct.length > 0 ? direct.join("；") : "旧版开书约定已保留，等待补全。";
}

function readableLegacyField(value: unknown): string | null {
  const direct = readString(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => readString(entry))
      .filter((entry): entry is string => entry !== null);
    return items.length > 0 ? items.join("、") : null;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .flatMap(([key, entry]) => {
        const text = readString(entry);
        return text === null ? [] : [`${key}：${text}`];
      })
      .join("、");
    return entries.length > 0 ? entries : null;
  }
  return null;
}

function safeExportName(projectName: string, scope: "all" | "current"): string {
  const safe = projectName.replaceAll(/[/\\\u0000-\u001f\u007f]/gu, "-").trim() || "墨影";
  return `${safe}-${scope === "all" ? "全部故事设定" : "当前分类"}.story-settings.json`;
}

function storyObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : Object.freeze({});
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = readString(entry);
        return parsed === null ? [] : [parsed];
      })
    : [];
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function sameLegacyFinalizeConfirmation(
  confirmation: LegacyFinalizeConfirmation | null,
  relationship: StorySettingsLegacyRepairRelationship,
  currentSourceRevision: number,
): boolean {
  return (
    confirmation !== null &&
    confirmation.relationshipFactId === relationship.relationshipFactId &&
    confirmation.originalSourceRevision === relationship.expectedSourceRevision &&
    confirmation.currentSourceRevision === currentSourceRevision
  );
}

function errorNotice(cause: unknown): Readonly<{
  tone: "error";
  title: string;
  description: string;
}> {
  const projected = projectOrdinaryUiError(cause);
  if (cause instanceof StorySettingsImportError) {
    return {
      tone: "error",
      title: "设定没有写入",
      description: projected.description,
    };
  }
  return {
    tone: "error",
    title: projected.title,
    description: projected.description,
  };
}
