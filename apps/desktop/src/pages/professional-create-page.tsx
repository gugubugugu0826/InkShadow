import { parseUuidV7 as parseDomainUuidV7 } from "@inkshadow/domain";
import {
  createStoryValue,
  parseUuidV7 as parseStoryUuidV7,
  type FormalRecordKind,
  type FormalStoryRecord,
  type StoryFact,
} from "@inkshadow/story-core";
import { Badge, Button, FormField, InlineAlert, Input, Textarea } from "@inkshadow/ui";
import { useEffect, useState, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";

import {
  deriveProfessionalProjectSeed,
  parseProjectSeed,
  type ProjectSeed,
} from "../infrastructure/project-seed";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

export const PROFESSIONAL_CREATE_RECOVERY_KEY = "inkshadow.professional-create-recovery.v1";

interface ProfessionalSetupDraft {
  readonly projectName: string;
  readonly storyDirection: string;
  readonly outlineSynopsis: string;
  readonly protagonist: string;
  readonly relationship: string;
  readonly worldBackground: string;
  readonly pov: string;
  readonly style: string;
  readonly boundaries: string;
}

type ProfessionalSetupField = keyof ProfessionalSetupDraft;

interface ProfessionalCreateRecovery {
  readonly version: 1;
  readonly projectId: string | null;
  readonly projectCreatedAt: string | null;
  readonly draft: ProfessionalSetupDraft;
  readonly projectSeed: ProjectSeed;
}

interface CreatedProjectSummary {
  readonly id: string;
  readonly name: string;
}

interface ProvisioningError {
  readonly title: string;
  readonly description: string;
}

const EMPTY_DRAFT: ProfessionalSetupDraft = Object.freeze({
  projectName: "",
  storyDirection: "",
  outlineSynopsis: "",
  protagonist: "",
  relationship: "",
  worldBackground: "",
  pov: "",
  style: "",
  boundaries: "",
});

const CHARACTER_RECORD_KEY = "professional_setup.character";
const RULE_RECORD_KEY = "professional_setup.rules";

export function ProfessionalCreatePage() {
  const runtime = useRuntime();
  const [initialRecovery] = useState(readRecovery);
  const [draft, setDraft] = useState<ProfessionalSetupDraft>(initialRecovery?.draft ?? EMPTY_DRAFT);
  const [projectSeed, setProjectSeed] = useState<ProjectSeed>(
    () =>
      initialRecovery?.projectSeed ??
      deriveProfessionalProjectSeed({
        seedId: "professional:recovery",
        ...EMPTY_DRAFT,
        now: runtime.clock.now(),
      }),
  );
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(
    initialRecovery?.projectId ?? null,
  );
  const [pendingProjectCreatedAt, setPendingProjectCreatedAt] = useState<string | null>(
    initialRecovery?.projectCreatedAt ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [provisioningError, setProvisioningError] = useState<ProvisioningError | null>(null);
  const [createdProject, setCreatedProject] = useState<CreatedProjectSummary | null>(null);

  useEffect(() => {
    if (createdProject !== null) {
      clearRecovery();
      return;
    }
    writeRecovery({
      version: 1,
      projectId: pendingProjectId,
      projectCreatedAt: pendingProjectCreatedAt,
      draft,
      projectSeed,
    });
  }, [createdProject, draft, pendingProjectCreatedAt, pendingProjectId, projectSeed]);

  function updateField(field: ProfessionalSetupField, value: string): void {
    const nextDraft = { ...draft, [field]: value };
    const now = runtime.clock.now();
    setDraft(nextDraft);
    setProjectSeed((current) =>
      deriveProfessionalProjectSeed({
        seedId: current.seedId,
        ...nextDraft,
        now,
        existing: current,
      }),
    );
    setNameError(null);
    setProvisioningError(null);
  }

  async function createProjectWorkspace(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || draft.projectName.trim().length === 0) {
      return;
    }

    setSubmitting(true);
    setNameError(null);
    setProvisioningError(null);
    let projectId = pendingProjectId;
    let projectCreatedAt = pendingProjectCreatedAt;
    let projectName = draft.projectName.trim();
    let seedForProject = projectSeed;

    try {
      if (projectId === null) {
        const created = await runtime.useCases.createProject.execute({
          name: draft.projectName,
        });
        if (!created.ok) {
          setNameError(normalizeUiError(created.error).description);
          return;
        }
        projectId = created.value.id;
        projectName = created.value.name;
        projectCreatedAt = created.value.toSnapshot().createdAt;
        setPendingProjectId(projectId);
        setPendingProjectCreatedAt(projectCreatedAt);
        const normalizedDraft = { ...draft, projectName };
        const normalizedSeed = deriveProfessionalProjectSeed({
          seedId: projectSeed.seedId,
          ...normalizedDraft,
          now: runtime.clock.now(),
          existing: projectSeed,
        });
        seedForProject = normalizedSeed;
        setDraft(normalizedDraft);
        setProjectSeed(normalizedSeed);
        writeRecovery({
          version: 1,
          projectId,
          projectCreatedAt,
          draft: normalizedDraft,
          projectSeed: normalizedSeed,
        });
      }

      if (projectCreatedAt === null) {
        throw new Error("未完成创建的项目缺少安全校验信息，请从作品库打开项目确认现状。");
      }
      await runtime.projectSeeds.saveForProject(projectId, seedForProject);
      await provisionProfessionalWorkspace(runtime, projectId, projectCreatedAt, {
        ...draft,
        projectName,
      });
      setCreatedProject({ id: projectId, name: projectName });
      setPendingProjectId(null);
      setPendingProjectCreatedAt(null);
    } catch (error) {
      setProvisioningError(describeProvisioningError(error, projectId !== null));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="desktop-page settings-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to="/start">
            返回开始页
          </Link>
          <p className="page-heading__eyebrow">适合已有规划的创作者</p>
          <h1>专业创建</h1>
          <p>项目名是唯一必填项。其他准备可以按需展开，创建后仍可继续修改。</p>
        </div>
        <Badge tone="success">本地保存</Badge>
      </header>

      {createdProject === null ? (
        <form className="secret-settings" onSubmit={(event) => void createProjectWorkspace(event)}>
          {pendingProjectId !== null && (
            <InlineAlert
              tone="warning"
              title="发现未完成的专业创建"
              description="项目已经安全保存在当前设备。继续后会检查已有正文、规划和设定，只补齐缺少的内容，不会重复创建。"
            />
          )}

          {provisioningError !== null && (
            <InlineAlert
              tone="error"
              title={provisioningError.title}
              description={provisioningError.description}
            />
          )}

          <section aria-labelledby="create-empty-project-heading">
            <div className="section-heading">
              <div>
                <h2 id="create-empty-project-heading">先给作品起个名字</h2>
                <p>系统会真实创建空白第一章、项目规划，以及你明确填写的正式设定。</p>
              </div>
            </div>

            <FormField
              label="项目名称"
              hint="不会自动生成正文，也不会改动其他作品。"
              error={nameError ?? undefined}
              required
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  disabled={pendingProjectId !== null || submitting}
                  maxLength={120}
                  value={draft.projectName}
                  placeholder="例如：潮汐尽头的来信"
                  onChange={(event) => updateField("projectName", event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.nativeEvent.isComposing) {
                      event.preventDefault();
                    }
                  }}
                />
              )}
            </FormField>
          </section>

          <section aria-labelledby="optional-preparation-heading">
            <div className="section-heading">
              <div>
                <h2 id="optional-preparation-heading">需要时再准备</h2>
                <p>所有字段都可留空。填写的内容会进入真实规划或正式设定，不会只停留在表单里。</p>
              </div>
              <Badge tone="neutral">全部可选</Badge>
            </div>

            <details>
              <summary>故事方向与大纲</summary>
              <div className="secret-settings">
                <FormField label="故事方向" hint="一句话说明这部作品准备往哪里发展。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={1_000}
                      currentLength={draft.storyDirection.length}
                      value={draft.storyDirection}
                      placeholder="例如：两个互相误解的人在共同调查旧校舍传闻时逐渐靠近。"
                      onChange={(event) => updateField("storyDirection", event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <FormField label="大纲简介" hint="可以只写关键冲突、结局方向或已有章节计划。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={2_800}
                      currentLength={draft.outlineSynopsis.length}
                      value={draft.outlineSynopsis}
                      onChange={(event) =>
                        updateField("outlineSynopsis", event.currentTarget.value)
                      }
                    />
                  )}
                </FormField>
              </div>
            </details>

            <details>
              <summary>人物与世界</summary>
              <div className="secret-settings">
                <FormField label="主角" hint="姓名、身份、目标或性格，写多少都可以。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={2_000}
                      currentLength={draft.protagonist.length}
                      value={draft.protagonist}
                      onChange={(event) => updateField("protagonist", event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <FormField label="人物关系" hint="只填写已经确定、愿意作为正式设定保存的关系。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={2_000}
                      currentLength={draft.relationship.length}
                      value={draft.relationship}
                      onChange={(event) => updateField("relationship", event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <FormField label="世界背景" hint="时代、地点、社会或能力体系等已确认内容。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={4_000}
                      currentLength={draft.worldBackground.length}
                      value={draft.worldBackground}
                      onChange={(event) =>
                        updateField("worldBackground", event.currentTarget.value)
                      }
                    />
                  )}
                </FormField>
              </div>
            </details>

            <details>
              <summary>视角、风格与禁止项</summary>
              <div className="secret-settings">
                <FormField label="POV / 叙事视角" hint="例如：第一人称，或第三人称限知。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={1_000}
                      currentLength={draft.pov.length}
                      value={draft.pov}
                      onChange={(event) => updateField("pov", event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <FormField label="风格样例或说明" hint="可写风格要求，也可粘贴一小段你认可的样例。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={2_000}
                      currentLength={draft.style.length}
                      value={draft.style}
                      onChange={(event) => updateField("style", event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <FormField label="禁止项" hint="不希望出现的情节、表达和内容边界。">
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      disabled={submitting}
                      maxLength={2_000}
                      currentLength={draft.boundaries.length}
                      value={draft.boundaries}
                      onChange={(event) => updateField("boundaries", event.currentTarget.value)}
                    />
                  )}
                </FormField>
              </div>
            </details>

            <details>
              <summary>AI 分工、上下文与自动检查</summary>
              <p>
                这些能力需要先在 Model Hub
                连接并测试模型。创建项目不会假装已经配置，也不会阻止你先写正文。
              </p>
            </details>
          </section>

          <div className="settings-actions">
            <Button
              type="submit"
              loading={submitting}
              disabled={draft.projectName.trim().length === 0}
            >
              {pendingProjectId === null ? "创建项目并准备工作区" : "继续完成创建"}
            </Button>
            {pendingProjectId !== null && (
              <Link
                className="button-link button-link--secondary"
                to={`/projects/${pendingProjectId}`}
              >
                先打开已创建项目
              </Link>
            )}
          </div>
        </form>
      ) : (
        <section className="secret-settings" aria-labelledby="professional-created-heading">
          <InlineAlert
            tone="info"
            title="专业项目已准备好"
            description={`“${createdProject.name}”已创建空白第一章和项目规划；你填写的人物与规则已作为本人确认的正式设定保存。`}
          />
          <h2 id="professional-created-heading">下一步</h2>
          <nav className="settings-actions" aria-label="进入新项目">
            <Link className="button-link" to={`/projects/${createdProject.id}`}>
              进入项目正文
            </Link>
            <Link
              className="button-link button-link--secondary"
              to={`/projects/${createdProject.id}/outline`}
            >
              打开规划
            </Link>
            <Link
              className="button-link button-link--secondary"
              to={`/projects/${createdProject.id}/story`}
            >
              查看设定
            </Link>
            <Link className="button-link button-link--secondary" to="/settings#model-routing">
              配置 AI 分工
            </Link>
          </nav>
        </section>
      )}
    </div>
  );
}

async function provisionProfessionalWorkspace(
  runtime: ReturnType<typeof useRuntime>,
  projectId: string,
  expectedProjectCreatedAt: string,
  draft: ProfessionalSetupDraft,
): Promise<void> {
  const domainProjectId = parseDomainUuidV7(projectId);
  if (!domainProjectId.ok) {
    throw domainProjectId.error;
  }
  const storyProjectId = parseStoryUuidV7(projectId);
  if (!storyProjectId.ok) {
    throw storyProjectId.error;
  }

  const projectResult = await runtime.repositories.projects.findById(domainProjectId.value);
  if (!projectResult.ok) {
    throw projectResult.error;
  }
  if (projectResult.value === null) {
    throw new ProfessionalProvisioningError(
      "PROFESSIONAL_PROJECT_MISSING",
      "找不到已经创建的项目，请返回作品库确认项目状态。",
    );
  }
  const projectSnapshot = projectResult.value.toSnapshot();
  if (
    projectSnapshot.createdAt !== expectedProjectCreatedAt ||
    projectSnapshot.name !== draft.projectName.trim()
  ) {
    throw new ProfessionalProvisioningError(
      "PROFESSIONAL_RECOVERY_MISMATCH",
      "未完成创建记录与当前项目不一致。为避免改动其他作品，系统已停止补齐，请从作品库打开项目确认现状。",
    );
  }
  if (projectResult.value.status !== "active") {
    throw new ProfessionalProvisioningError(
      "PROFESSIONAL_PROJECT_INACTIVE",
      "项目已归档或移入回收站，请先恢复为可编辑状态。",
    );
  }

  const chapters = await runtime.repositories.chapters.listByProjectId(domainProjectId.value);
  if (!chapters.ok) {
    throw chapters.error;
  }
  if (!chapters.value.some((chapter) => chapter.status === "active")) {
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: domainProjectId.value,
      title: "第一章",
      content: "",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
  }

  const desiredSynopsis = buildOutlineSynopsis(draft);
  const outline = await runtime.story.outlines.findByProjectId(storyProjectId.value);
  if (!outline.ok) {
    throw outline.error;
  }
  if (outline.value === null) {
    const createdOutline = await runtime.story.outlineService.create({
      projectId,
      title: draft.projectName.trim(),
      synopsis: desiredSynopsis,
    });
    if (!createdOutline.ok) {
      throw createdOutline.error;
    }
  }

  const records = await runtime.story.formalRecords.listByProjectId(storyProjectId.value);
  if (!records.ok) {
    throw records.error;
  }
  const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
  if (!facts.ok) {
    throw facts.error;
  }

  const characterDescription = labeledLines([
    ["主角", draft.protagonist],
    ["人物关系", draft.relationship],
  ]);
  if (characterDescription.length > 0) {
    await createFormalRecordIfMissing(runtime, records.value, {
      projectId,
      kind: "character",
      recordKey: CHARACTER_RECORD_KEY,
      value: {
        title: "专业创建：人物设定",
        description: characterDescription,
        protagonist: draft.protagonist.trim(),
        relationship: draft.relationship.trim(),
        origin: "professional_setup",
        userConfirmed: true,
      },
    });
  }
  await createStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "character_identity",
    contentText: labeledLines([["主角", draft.protagonist]]),
  });
  await createStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "relationship",
    contentText: labeledLines([["人物关系", draft.relationship]]),
  });

  const ruleDescription = labeledLines([
    ["世界背景", draft.worldBackground],
    ["POV / 叙事视角", draft.pov],
    ["风格", draft.style],
    ["禁止项", draft.boundaries],
  ]);
  if (ruleDescription.length > 0) {
    await createFormalRecordIfMissing(runtime, records.value, {
      projectId,
      kind: "world_rule",
      recordKey: RULE_RECORD_KEY,
      value: {
        title: "专业创建：世界与写作规则",
        description: ruleDescription,
        worldBackground: draft.worldBackground.trim(),
        pov: draft.pov.trim(),
        style: draft.style.trim(),
        boundaries: draft.boundaries.trim(),
        origin: "professional_setup",
        userConfirmed: true,
      },
    });
  }
  await createStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "world_setting",
    contentText: labeledLines([["世界背景", draft.worldBackground]]),
  });
  await createStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "writing_rule",
    contentText: labeledLines([
      ["叙事视角", draft.pov],
      ["写作风格", draft.style],
    ]),
  });
  await createStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "writing_rule",
    contentText: labeledLines([["禁止项", draft.boundaries]]),
    lock: true,
  });
}

async function createFormalRecordIfMissing(
  runtime: ReturnType<typeof useRuntime>,
  existingRecords: readonly FormalStoryRecord[],
  input: Readonly<{
    projectId: string;
    kind: FormalRecordKind;
    recordKey: string;
    value: unknown;
  }>,
): Promise<void> {
  const existing = existingRecords.find(
    (record) => record.toSnapshot().recordKey === input.recordKey,
  );
  if (existing !== undefined) {
    return;
  }

  const parsedValue = createStoryValue(input.value);
  if (!parsedValue.ok) {
    throw parsedValue.error;
  }
  const created = await runtime.story.formalRecordService.create({
    projectId: input.projectId,
    kind: input.kind,
    recordKey: input.recordKey,
    value: parsedValue.value,
    actorId: runtime.story.actorId,
    humanConfirmed: true,
  });
  if (!created.ok) {
    throw created.error;
  }
}

async function createStoryFactIfMissing(
  runtime: ReturnType<typeof useRuntime>,
  existingFacts: readonly StoryFact[],
  input: Readonly<{
    projectId: string;
    factType: string;
    contentText: string;
    lock?: boolean;
  }>,
): Promise<void> {
  if (input.contentText.length === 0) {
    return;
  }
  const exists = existingFacts.some((fact) => {
    const snapshot = fact.toSnapshot();
    return (
      snapshot.status !== "deprecated" &&
      snapshot.factType === input.factType &&
      snapshot.contentText === input.contentText
    );
  });
  if (exists) {
    return;
  }
  const created = await runtime.story.factService.createFormalUserFact({
    projectId: input.projectId,
    factType: input.factType,
    contentText: input.contentText,
    actorId: runtime.story.actorId,
    lock: input.lock ?? false,
    humanConfirmed: true,
  });
  if (!created.ok) {
    throw created.error;
  }
}

function buildOutlineSynopsis(draft: ProfessionalSetupDraft): string {
  const synopsis = labeledLines([
    ["故事方向", draft.storyDirection],
    ["大纲简介", draft.outlineSynopsis],
  ]);
  return synopsis.length > 0
    ? synopsis
    : "这是一个刚创建的空白规划，可以从故事方向、卷章结构或下一场景开始补充。";
}

function labeledLines(values: readonly (readonly [string, string])[]): string {
  return values
    .flatMap(([label, value]) => {
      const normalized = value.trim();
      return normalized.length === 0 ? [] : [`${label}：${normalized}`];
    })
    .join("\n");
}

function describeProvisioningError(error: unknown, projectCreated: boolean): ProvisioningError {
  const normalized = normalizeUiError(error);
  const storyCode = readErrorCode(error);
  const reason =
    error instanceof ProfessionalProvisioningError
      ? error.message
      : storyCode !== null &&
          (storyCode.startsWith("STORY_") ||
            storyCode.startsWith("OUTLINE_") ||
            storyCode.startsWith("FORMAL_"))
        ? `本地规划或设定没有通过安全写入检查（${storyCode}）。`
        : normalized.description;
  return projectCreated
    ? {
        title: "项目已创建，准备工作尚未完成",
        description: `${reason} 已完成的内容仍保存在本地。调整相关输入或恢复项目状态后，再点“继续完成创建”；系统会检查已有内容并只补齐缺失部分。`,
      }
    : {
        title: "未能创建项目",
        description: `${reason} 当前填写内容仍保留在本页，可以修正后重试。`,
      };
}

class ProfessionalProvisioningError extends Error {
  public constructor(
    public readonly code:
      | "PROFESSIONAL_PROJECT_MISSING"
      | "PROFESSIONAL_RECOVERY_MISMATCH"
      | "PROFESSIONAL_PROJECT_INACTIVE",
    message: string,
  ) {
    super(message);
    this.name = "ProfessionalProvisioningError";
  }
}

function readErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function readRecovery(): ProfessionalCreateRecovery | null {
  try {
    const serialized = window.localStorage.getItem(PROFESSIONAL_CREATE_RECOVERY_KEY);
    if (serialized === null) {
      return null;
    }
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.draft)) {
      return null;
    }
    const projectId = value.projectId;
    if (projectId !== null && typeof projectId !== "string") {
      return null;
    }
    if (typeof projectId === "string" && !parseDomainUuidV7(projectId).ok) {
      return null;
    }
    const projectCreatedAt = value.projectCreatedAt;
    if (
      projectCreatedAt !== null &&
      (typeof projectCreatedAt !== "string" || !Number.isFinite(Date.parse(projectCreatedAt)))
    ) {
      return null;
    }
    if ((projectId === null) !== (projectCreatedAt === null)) {
      return null;
    }
    const draft = value.draft;
    const fields: readonly ProfessionalSetupField[] = [
      "projectName",
      "storyDirection",
      "outlineSynopsis",
      "protagonist",
      "relationship",
      "worldBackground",
      "pov",
      "style",
      "boundaries",
    ];
    if (fields.some((field) => typeof draft[field] !== "string")) {
      return null;
    }
    const recoveredDraft = Object.freeze(
      Object.fromEntries(
        fields.map((field) => [field, draft[field]]),
      ) as unknown as ProfessionalSetupDraft,
    );
    return {
      version: 1,
      projectId,
      projectCreatedAt,
      draft: recoveredDraft,
      projectSeed:
        parseProjectSeed(value.projectSeed) ??
        deriveProfessionalProjectSeed({
          seedId: `professional:${projectId ?? "recovery"}`,
          ...recoveredDraft,
          now: new Date().toISOString(),
        }),
    };
  } catch {
    return null;
  }
}

function writeRecovery(recovery: ProfessionalCreateRecovery): void {
  try {
    window.localStorage.setItem(PROFESSIONAL_CREATE_RECOVERY_KEY, JSON.stringify(recovery));
  } catch {
    // The in-memory state still allows the current attempt to continue safely.
  }
}

function clearRecovery(): void {
  try {
    window.localStorage.removeItem(PROFESSIONAL_CREATE_RECOVERY_KEY);
  } catch {
    // Successful persisted project artifacts do not depend on clearing this convenience draft.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
