import { parseUuidV7 as parseDomainUuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7, type StoryFact } from "@inkshadow/story-core";
import { Badge, Button, FormField, InlineAlert, Input, Textarea } from "@inkshadow/ui";
import { useEffect, useState, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";

import {
  deriveProfessionalProjectSeed,
  parseProjectSeed,
  updateProjectSeedField,
  type ProjectSeed,
} from "../infrastructure/project-seed";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
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
  readonly otherConstraints: string;
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
  otherConstraints: "",
});

const OPTIONAL_SETUP_SECTIONS = [
  {
    summary: "故事方向与大纲",
    fields: [
      {
        field: "storyDirection",
        label: "故事方向",
        hint: "一句话说明这部作品准备往哪里发展。",
        maximum: 1_000,
        placeholder: "例如：两个互相误解的人在共同调查旧校舍传闻时逐渐靠近。",
      },
      {
        field: "outlineSynopsis",
        label: "大纲简介",
        hint: "可以只写关键冲突、结局方向或已有章节计划。",
        maximum: 2_800,
      },
    ],
  },
  {
    summary: "人物与世界",
    fields: [
      {
        field: "protagonist",
        label: "主角",
        hint: "姓名、身份、目标或性格，写多少都可以。",
        maximum: 2_000,
      },
      {
        field: "relationship",
        label: "人物关系",
        hint: "填写后会先保存为待确认设定，由你稍后确认、修改或放弃。",
        maximum: 2_000,
      },
      {
        field: "worldBackground",
        label: "世界背景",
        hint: "时代、地点、社会或能力体系等内容会先保存为待确认设定。",
        maximum: 4_000,
      },
    ],
  },
  {
    summary: "视角、风格与创作约束",
    fields: [
      {
        field: "pov",
        label: "叙事视角",
        hint: "例如：第一人称，或第三人称限知。",
        maximum: 1_000,
      },
      {
        field: "style",
        label: "风格样例或说明",
        hint: "可写风格要求，也可粘贴一小段你认可的样例。",
        maximum: 2_000,
      },
      {
        field: "boundaries",
        label: "禁止项",
        hint: "不希望出现的情节、表达和内容边界。",
        maximum: 2_000,
      },
      {
        field: "otherConstraints",
        label: "其他创作约束",
        hint: "例如章节视角、时间写法、篇幅或结构要求；会与禁止项分开保存。",
        maximum: 2_000,
      },
    ],
  },
] as const;

export function ProfessionalCreatePage() {
  const runtime = useRuntime();
  const [initialRecovery] = useState(readRecovery);
  const [draft, setDraft] = useState<ProfessionalSetupDraft>(initialRecovery?.draft ?? EMPTY_DRAFT);
  const [projectSeed, setProjectSeed] = useState<ProjectSeed>(
    () =>
      initialRecovery?.projectSeed ??
      deriveProfessionalSetupSeed({
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
      deriveProfessionalSetupSeed({
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
          setNameError(projectOrdinaryUiError(created.error).description);
          return;
        }
        projectId = created.value.id;
        projectName = created.value.name;
        projectCreatedAt = created.value.toSnapshot().createdAt;
        setPendingProjectId(projectId);
        setPendingProjectCreatedAt(projectCreatedAt);
        const normalizedDraft = { ...draft, projectName };
        const normalizedSeed = deriveProfessionalSetupSeed({
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
                <p>系统会真实创建空白第一章和项目规划；人物与世界设定会先等待你确认。</p>
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
                <p>
                  所有字段都可留空。填写的内容会完整保存在本地，并按规划、待确认设定或写作约束分别使用。
                </p>
              </div>
              <Badge tone="neutral">全部可选</Badge>
            </div>

            {OPTIONAL_SETUP_SECTIONS.map((section) => (
              <details key={section.summary}>
                <summary>{section.summary}</summary>
                <div className="secret-settings">
                  {section.fields.map(({ field, label, hint, maximum, ...optional }) => (
                    <FormField key={field} label={label} hint={hint}>
                      {(fieldProps) => (
                        <Textarea
                          {...fieldProps}
                          {...optional}
                          disabled={submitting}
                          maxLength={maximum}
                          currentLength={draft[field].length}
                          value={draft[field]}
                          onChange={(event) => updateField(field, event.currentTarget.value)}
                        />
                      )}
                    </FormField>
                  ))}
                </div>
              </details>
            ))}

            <details>
              <summary>创作任务安排、上下文与自动检查</summary>
              <p>
                这些能力需要先在模型中心
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
            description={`“${createdProject.name}”已创建空白第一章和项目规划；人物与世界内容已保存为待确认设定，写作偏好和禁止项已分别保存。`}
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
              配置创作任务安排
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

  const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
  if (!facts.ok) {
    throw facts.error;
  }

  await ensureStoryFact(runtime, facts.value, {
    projectId,
    factType: "character_profile",
    contentText: labeledLines([["主角", draft.protagonist]]),
    pending: true,
  });
  await ensureStoryFact(runtime, facts.value, {
    projectId,
    factType: "core_relationship",
    contentText: labeledLines([["人物关系", draft.relationship]]),
    pending: true,
  });
  await ensureStoryFact(runtime, facts.value, {
    projectId,
    factType: "world_rule",
    contentText: labeledLines([["世界背景", draft.worldBackground]]),
    pending: true,
  });
  if (draft.pov.trim().length > 0) {
    await ensureProfessionalPreference(
      runtime,
      projectId,
      "professional_setup.pov",
      "叙事视角",
      draft.pov,
    );
  }
  if (draft.style.trim().length > 0) {
    await ensureProfessionalPreference(
      runtime,
      projectId,
      "professional_setup.style",
      "写作风格",
      draft.style,
    );
  }
  await ensureStoryFact(runtime, facts.value, {
    projectId,
    factType: "writing_constraint",
    contentText: labeledLines([
      ["禁止项", draft.boundaries],
      ["其他创作约束", draft.otherConstraints],
    ]),
    lock: true,
  });
}

async function ensureProfessionalPreference(
  runtime: ReturnType<typeof useRuntime>,
  projectId: string,
  identity: string,
  label: string,
  rawValue: string,
): Promise<void> {
  const value = rawValue.trim();
  if (value.length === 0) return;
  const chunks = splitPreferenceText(value, 440);
  for (const [index, chunk] of chunks.entries()) {
    const segmented = chunks.length > 1;
    await runtime.story.writingFeedback.ensureManualPreference(
      projectId,
      segmented ? `${identity}.part.${String(index + 1)}` : identity,
      segmented
        ? `${label}（第 ${String(index + 1)}/${String(chunks.length)} 段）：${chunk}`
        : `${label}：${chunk}`,
    );
  }
}

function splitPreferenceText(value: string, maximumUtf16Length: number): readonly string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + maximumUtf16Length);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value.charAt(end - 1))) end -= 1;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return Object.freeze(chunks);
}

async function ensureStoryFact(
  runtime: ReturnType<typeof useRuntime>,
  existingFacts: readonly StoryFact[],
  input: Readonly<{
    projectId: string;
    factType: string;
    contentText: string;
    pending?: boolean;
    lock?: boolean;
  }>,
): Promise<void> {
  if (input.contentText.length === 0) return;
  const exists = existingFacts.some((fact) => {
    const snapshot = fact.toSnapshot();
    return snapshot.factType === input.factType && snapshot.contentText === input.contentText;
  });
  if (exists) return;
  const command = {
    projectId: input.projectId,
    factType: input.factType,
    contentText: input.contentText,
    actorId: runtime.story.actorId,
  };
  const result = input.pending
    ? await runtime.story.factService.stageUserDraftFact(command)
    : await runtime.story.factService.createFormalUserFact({
        ...command,
        lock: input.lock ?? false,
        humanConfirmed: true,
      });
  if (!result.ok) throw result.error;
}

function deriveProfessionalSetupSeed(
  input: Parameters<typeof deriveProfessionalProjectSeed>[0],
): ProjectSeed {
  let seed = deriveProfessionalProjectSeed(input);
  for (const key of ["characters", "relationships", "world"] as const) {
    const field = seed[key];
    if (field.values.length === 0) continue;
    seed = updateProjectSeedField(seed, key, {
      values: field.values,
      source: field.source,
      confirmation: "unconfirmed",
      origin: field.origin,
      updatedAt: input.now,
    });
  }
  return seed;
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
  const normalized = projectOrdinaryUiError(error);
  const storyCode = readErrorCode(error);
  const reason =
    error instanceof ProfessionalProvisioningError
      ? error.message
      : storyCode !== null &&
          (storyCode.startsWith("STORY_") ||
            storyCode.startsWith("OUTLINE_") ||
            storyCode.startsWith("FORMAL_"))
        ? "本地规划或设定没有通过安全写入检查。"
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
    const recoveredDraft = Object.freeze({
      ...(Object.fromEntries(fields.map((field) => [field, draft[field]])) as Omit<
        ProfessionalSetupDraft,
        "otherConstraints"
      >),
      otherConstraints: typeof draft.otherConstraints === "string" ? draft.otherConstraints : "",
    });
    const recoveredSeed = parseProjectSeed(value.projectSeed);
    const recoveryTime = new Date().toISOString();
    return {
      version: 1,
      projectId,
      projectCreatedAt,
      draft: recoveredDraft,
      projectSeed: deriveProfessionalSetupSeed({
        seedId: recoveredSeed?.seedId ?? `professional:${projectId ?? "recovery"}`,
        ...recoveredDraft,
        now: recoveryTime,
        ...(recoveredSeed === null ? {} : { existing: recoveredSeed }),
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
