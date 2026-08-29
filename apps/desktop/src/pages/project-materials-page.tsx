import { useCallback, useEffect, useMemo, useState } from "react";
import type { Chapter, Project } from "@inkshadow/domain";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  MATERIAL_LICENSE_KINDS,
  MATERIAL_RETENTION_DAYS,
  parseUuidV7 as parseStoryUuid,
  type Material,
  type MaterialLicenseKind,
  type MaterialReference,
} from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Select,
  Textarea,
  useToast,
} from "@inkshadow/ui";
import { Link, useParams } from "react-router-dom";

import { useWritingExperience } from "../hooks/use-writing-experience";
import { normalizeUiError, projectOrdinaryUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

const LICENSE_OPTIONS = MATERIAL_LICENSE_KINDS.map((license) => ({
  value: license,
  label: licenseLabel(license),
}));

interface MaterialFormState {
  readonly title: string;
  readonly sourceName: string;
  readonly author: string;
  readonly sourceUrl: string;
  readonly license: MaterialLicenseKind;
  readonly rightsBasis: string;
  readonly rightsConfirmed: boolean;
  readonly allowGeneration: boolean;
  readonly allowTraining: boolean;
  readonly tags: string;
  readonly summary: string;
  readonly body: string;
}

const EMPTY_FORM: MaterialFormState = {
  title: "",
  sourceName: "",
  author: "",
  sourceUrl: "",
  license: "permission_unknown",
  rightsBasis: "权利状态尚未确认，仅保存供人工整理。",
  rightsConfirmed: false,
  allowGeneration: false,
  allowTraining: false,
  tags: "",
  summary: "",
  body: "",
};

export function ProjectMaterialsPage() {
  const runtime = useRuntime();
  const writingExperience = useWritingExperience();
  const directMode = writingExperience.preference?.mode === "direct";
  const { toast } = useToast();
  const params = useParams<{ projectId: string }>();
  const projectIdParameter = params.projectId ?? "";
  const domainProjectId = useMemo(() => parseDomainUuid(projectIdParameter), [projectIdParameter]);
  const storyProjectId = useMemo(() => parseStoryUuid(projectIdParameter), [projectIdParameter]);
  const identifierError = !domainProjectId.ok
    ? domainProjectId.error
    : !storyProjectId.ok
      ? storyProjectId.error
      : null;
  const [project, setProject] = useState<Project | null>(null);
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);
  const [materials, setMaterials] = useState<readonly Material[]>([]);
  const [references, setReferences] = useState<
    Readonly<Record<string, readonly MaterialReference[]>>
  >({});
  const [pageState, setPageState] = useState<"loading" | "ready" | "fatal_error">("loading");
  const [pageError, setPageError] = useState<unknown>(identifierError);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<MaterialFormState>(EMPTY_FORM);
  const [referenceMaterial, setReferenceMaterial] = useState<Material | null>(null);
  const [referenceChapterId, setReferenceChapterId] = useState("");
  const [referenceNote, setReferenceNote] = useState("");
  const [deleteMaterial, setDeleteMaterial] = useState<Material | null>(null);
  const [mergeMaterial, setMergeMaterial] = useState<Material | null>(null);
  const [mergeSurvivorId, setMergeSurvivorId] = useState("");

  const load = useCallback(async () => {
    if (!domainProjectId.ok || !storyProjectId.ok) {
      setPageState("fatal_error");
      return;
    }
    setPageState("loading");
    const [projectResult, chapterResult, materialResult] = await Promise.all([
      runtime.repositories.projects.findById(domainProjectId.value),
      runtime.repositories.chapters.listByProjectId(domainProjectId.value),
      runtime.story.materials.listByProjectId(storyProjectId.value, true),
    ]);
    if (!projectResult.ok) {
      setPageError(projectResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!chapterResult.ok) {
      setPageError(chapterResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!materialResult.ok) {
      setPageError(materialResult.error);
      setPageState("fatal_error");
      return;
    }
    if (projectResult.value === null) {
      setPageError(new Error("项目不存在。"));
      setPageState("fatal_error");
      return;
    }
    const referenceResults = await Promise.all(
      materialResult.value.map(async (material) => ({
        materialId: material.id,
        result: await runtime.story.materialReferences.listByMaterialId(material.id),
      })),
    );
    const failedReference = referenceResults.find(({ result }) => !result.ok);
    if (failedReference?.result.ok === false) {
      setPageError(failedReference.result.error);
      setPageState("fatal_error");
      return;
    }
    setProject(projectResult.value);
    setChapters(chapterResult.value);
    setMaterials(materialResult.value);
    setReferences(
      Object.fromEntries(
        referenceResults.map(({ materialId, result }) => [
          materialId,
          result.ok ? result.value : [],
        ]),
      ),
    );
    setPageError(null);
    setPageState("ready");
  }, [domainProjectId, runtime, storyProjectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const readonly = project?.status !== "active";
  const normalizedPageError = pageError === null ? null : projectOrdinaryUiError(pageError);
  const activeMaterials = materials.filter(({ status }) => status === "active");
  const disposedMaterials = materials.filter(({ status }) => status !== "active");
  const referenceCount = Object.values(references).reduce(
    (total, materialReferences) => total + materialReferences.length,
    0,
  );

  function openCreate(): void {
    setForm(EMPTY_FORM);
    setActionError(null);
    setCreateOpen(true);
  }

  function updateForm<Key extends keyof MaterialFormState>(
    key: Key,
    value: MaterialFormState[Key],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeLicense(value: string): void {
    const license = value as MaterialLicenseKind;
    setForm((current) => ({
      ...current,
      license,
      ...(license === "permission_unknown"
        ? {
            rightsConfirmed: false,
            allowGeneration: false,
            allowTraining: false,
          }
        : {}),
    }));
  }

  async function createMaterial(): Promise<void> {
    if (!storyProjectId.ok || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    const fingerprint = await runtime.hasher.sha256(form.body.trim());
    if (!fingerprint.ok) {
      setBusy(false);
      setActionError(normalizeUiError(fingerprint.error).description);
      return;
    }
    const result = await runtime.story.materialService.create({
      projectId: storyProjectId.value,
      title: form.title,
      sourceName: form.sourceName,
      author: nullable(form.author),
      sourceUrl: nullable(form.sourceUrl),
      license: form.license,
      rightsBasis: form.rightsBasis,
      rightsConfirmed: form.rightsConfirmed,
      allowGeneration: form.allowGeneration,
      allowTraining: form.allowTraining,
      tags: splitTags(form.tags),
      summary: form.summary,
      body: form.body,
      contentFingerprint: fingerprint.value,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(normalizeUiError(result.error).description);
      return;
    }
    setCreateOpen(false);
    setForm(EMPTY_FORM);
    await load();
  }

  function openReference(material: Material): void {
    setReferenceMaterial(material);
    setReferenceChapterId(chapters[0]?.id ?? "");
    setReferenceNote("");
    setActionError(null);
  }

  async function createReference(): Promise<void> {
    if (referenceMaterial === null || busy) {
      return;
    }
    const chapter = chapters.find(({ id }) => id === referenceChapterId);
    if (chapter === undefined) {
      setActionError("请选择引用素材的目标章节。");
      return;
    }
    setBusy(true);
    setActionError(null);
    const result = await runtime.story.materialService.createReference({
      materialId: referenceMaterial.id,
      targetChapterId: chapter.id,
      expectedTargetVersionId: chapter.currentVersionId,
      excerptStart: 0,
      excerptEnd: Math.min(referenceMaterial.body.length, 320),
      note: referenceNote,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(normalizeUiError(result.error).description);
      return;
    }
    setReferenceMaterial(null);
    await load();
  }

  async function deleteNow(material: Material): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    const result = await runtime.story.materialService.softDelete({
      materialId: material.id,
      expectedRevision: material.revision,
      expectedReferenceCount: references[material.id]?.length ?? 0,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(normalizeUiError(result.error).description);
      return;
    }
    setDeleteMaterial(null);
    await load();
    if (directMode) {
      toast({
        title: "素材已移到可恢复区域",
        description: `素材正文会保留 ${String(MATERIAL_RETENTION_DAYS)} 天，原有引用没有删除。`,
        tone: "success",
        action: {
          label: "撤销删除",
          onClick: () => void restore(result.value),
        },
      });
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleteMaterial === null) {
      return;
    }
    await deleteNow(deleteMaterial);
  }

  async function restore(material: Material): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    const result = await runtime.story.materialService.restore({
      materialId: material.id,
      expectedRevision: material.revision,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(normalizeUiError(result.error).description);
      return;
    }
    await load();
  }

  function openMerge(material: Material): void {
    const survivor = activeMaterials.find(({ id }) => id !== material.id);
    setMergeMaterial(material);
    setMergeSurvivorId(survivor?.id ?? "");
    setActionError(null);
  }

  async function confirmMerge(): Promise<void> {
    if (mergeMaterial === null || busy) {
      return;
    }
    const survivor = activeMaterials.find(({ id }) => id === mergeSurvivorId);
    if (survivor === undefined) {
      setActionError("请选择仍然有效的保留素材。");
      return;
    }
    setBusy(true);
    setActionError(null);
    const result = await runtime.story.materialService.merge({
      sourceMaterialId: mergeMaterial.id,
      survivorMaterialId: survivor.id,
      expectedSourceRevision: mergeMaterial.revision,
      expectedSurvivorRevision: survivor.revision,
      expectedReferenceCount: references[mergeMaterial.id]?.length ?? 0,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(normalizeUiError(result.error).description);
      return;
    }
    setMergeMaterial(null);
    await load();
  }

  return (
    <div className="desktop-page material-library-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${projectIdParameter}`}>
            返回项目
          </Link>
          <p className="page-heading__eyebrow">素材库 · 权利与引用治理</p>
          <h1>{project?.name ?? "项目素材库"}</h1>
          <p>每条素材都保留来源、授权依据和引用时的出处信息；未经明确授权不会进入生成或训练。</p>
        </div>
        <div className="settings-actions">
          <Button disabled={readonly} onClick={openCreate}>
            录入素材
          </Button>
        </div>
      </header>

      <div className="material-summary" aria-label="素材库摘要">
        <Badge tone="success">{activeMaterials.length} 条有效素材</Badge>
        <Badge tone={disposedMaterials.length > 0 ? "warning" : "neutral"}>
          {disposedMaterials.length} 条已处置
        </Badge>
        <Badge tone="info">{referenceCount} 条章节引用</Badge>
      </div>

      <InlineAlert
        tone="info"
        title="用途由授权状态控制"
        description="录入和引用不会自动把素材发送给模型。生成与训练权限分别确认；来源权利未知时，两种用途都会被强制禁止。"
      />

      {readonly && project !== null && (
        <InlineAlert
          tone="warning"
          title="当前项目只读"
          description="归档或回收站项目可以核对素材与出处，但不能录入、引用、删除、恢复或合并。"
        />
      )}

      {actionError !== null && (
        <InlineAlert tone="error" title="操作没有完成" description={actionError} />
      )}

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        fallbacks={{
          fatal_error:
            normalizedPageError === null ? undefined : (
              <ErrorState
                title={normalizedPageError.title}
                description={normalizedPageError.description}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
        {materials.length === 0 ? (
          <EmptyState
            title="还没有治理素材"
            description="先录入正文与出处。即使权利尚未确认，也可以安全保存，但不会获准用于生成或训练。"
            {...(readonly
              ? {}
              : { primaryAction: { label: "录入第一条素材", onClick: openCreate } })}
          />
        ) : (
          <>
            <section aria-labelledby="active-materials-title">
              <div className="section-heading">
                <div>
                  <h2 id="active-materials-title">有效素材</h2>
                  <p>当前执行 SHA-256 精确内容去重；语义相似建议尚未启用。</p>
                </div>
                <Badge>{activeMaterials.length} 条</Badge>
              </div>
              {activeMaterials.length === 0 ? (
                <EmptyState
                  title="没有有效素材"
                  description="已删除素材仍可在下方恢复；已合并素材保留原始引用证据。"
                />
              ) : (
                <div className="material-grid">
                  {activeMaterials.map((material) => (
                    <MaterialCard
                      key={material.id}
                      material={material}
                      references={references[material.id] ?? []}
                      chapters={chapters}
                      readonly={readonly}
                      busy={busy}
                      canMerge={activeMaterials.length > 1}
                      onReference={() => openReference(material)}
                      onDelete={() => {
                        if (directMode) {
                          void deleteNow(material);
                        } else {
                          setActionError(null);
                          setDeleteMaterial(material);
                        }
                      }}
                      onMerge={() => openMerge(material)}
                    />
                  ))}
                </div>
              )}
            </section>

            {disposedMaterials.length > 0 && (
              <section className="material-disposed-section" aria-labelledby="disposed-title">
                <div className="section-heading">
                  <div>
                    <h2 id="disposed-title">已处置素材</h2>
                    <p>正文暂存 {MATERIAL_RETENTION_DAYS} 天；引用继续显示保存时的最小出处信息。</p>
                  </div>
                  <Badge tone="warning">{disposedMaterials.length} 条</Badge>
                </div>
                <div className="material-grid">
                  {disposedMaterials.map((material) => (
                    <MaterialCard
                      key={material.id}
                      material={material}
                      references={references[material.id] ?? []}
                      chapters={chapters}
                      readonly={readonly}
                      busy={busy}
                      canMerge={false}
                      onRestore={() => void restore(material)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </PageStateBoundary>

      <Dialog
        open={createOpen}
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!busy) {
            setCreateOpen(open);
          }
        }}
        title="录入治理素材"
        description="来源、权利依据与用途权限会和正文一起保存；提交前请按实际情况确认。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button loading={busy} onClick={() => void createMaterial()}>
              保存素材
            </Button>
          </>
        }
      >
        <div className="material-form">
          <div className="material-form-grid">
            <FormField label="素材标题" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.title}
                  maxLength={200}
                  onChange={(event) => updateForm("title", event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="来源名称" hint="作品、档案、采访或自有创作名称" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.sourceName}
                  maxLength={300}
                  onChange={(event) => updateForm("sourceName", event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="作者" optionalLabel="可选">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.author}
                  maxLength={200}
                  onChange={(event) => updateForm("author", event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField
              label="来源网址"
              hint="仅接受不含账号凭据的 HTTP/HTTPS 地址"
              optionalLabel="可选"
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.sourceUrl}
                  inputMode="url"
                  onChange={(event) => updateForm("sourceUrl", event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="许可类型" required>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={form.license}
                  options={LICENSE_OPTIONS}
                  onChange={(event) => changeLicense(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="标签" hint="用逗号或换行分隔" optionalLabel="可选">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.tags}
                  onChange={(event) => updateForm("tags", event.currentTarget.value)}
                />
              )}
            </FormField>
          </div>
          <FormField label="权利依据" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={form.rightsBasis}
                maxLength={500}
                currentLength={form.rightsBasis.length}
                onChange={(event) => updateForm("rightsBasis", event.currentTarget.value)}
              />
            )}
          </FormField>
          <fieldset className="material-permission-fieldset">
            <legend>用途授权</legend>
            <label>
              <input
                type="checkbox"
                checked={form.rightsConfirmed}
                disabled={form.license === "permission_unknown"}
                onChange={(event) => {
                  const confirmed = event.currentTarget.checked;
                  setForm((current) => ({
                    ...current,
                    rightsConfirmed: confirmed,
                    ...(!confirmed ? { allowGeneration: false, allowTraining: false } : {}),
                  }));
                }}
              />
              我已核对上述权利依据
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.allowGeneration}
                disabled={!form.rightsConfirmed}
                onChange={(event) => updateForm("allowGeneration", event.currentTarget.checked)}
              />
              允许作为生成参考
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.allowTraining}
                disabled={!form.rightsConfirmed}
                onChange={(event) => updateForm("allowTraining", event.currentTarget.checked)}
              />
              允许用于训练
            </label>
          </fieldset>
          <FormField label="摘要" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={form.summary}
                maxLength={1_000}
                currentLength={form.summary.length}
                onChange={(event) => updateForm("summary", event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="素材正文" hint="正文会保存在本项目本地数据库中" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={form.body}
                maxLength={100_000}
                currentLength={form.body.length}
                onChange={(event) => updateForm("body", event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={referenceMaterial !== null}
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setReferenceMaterial(null);
          }
        }}
        title="记录章节引用"
        description="引用会绑定目标章节的当前版本，并保存此刻的素材出处信息。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReferenceMaterial(null)}>
              取消
            </Button>
            <Button loading={busy} onClick={() => void createReference()}>
              确认引用
            </Button>
          </>
        }
      >
        <div className="material-form">
          <InlineAlert
            tone="info"
            title={referenceMaterial?.toSnapshot().title ?? "素材"}
            description="后续即使素材被删除或合并，这条引用仍保留原始来源、许可和内容指纹。"
          />
          <FormField label="目标章节" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={referenceChapterId}
                placeholder="请选择章节"
                options={chapters.map((chapter) => ({
                  value: chapter.id,
                  label: chapter.title,
                }))}
                onChange={(event) => setReferenceChapterId(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="引用说明" hint="说明如何使用或为何保留此出处" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={referenceNote}
                maxLength={500}
                currentLength={referenceNote.length}
                onChange={(event) => setReferenceNote(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={!directMode && deleteMaterial !== null}
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDeleteMaterial(null);
          }
        }}
        title="确认软删除素材"
        description="删除会立即撤销生成与训练用途，但不会级联删除章节引用。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteMaterial(null)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <div className="material-impact">
          <strong>{deleteMaterial?.toSnapshot().title}</strong>
          <p>
            当前影响：{deleteMaterial === null ? 0 : (references[deleteMaterial.id]?.length ?? 0)}{" "}
            条章节引用。引用保留最小出处信息，素材正文保留 {MATERIAL_RETENTION_DAYS} 天供恢复。
          </p>
        </div>
      </Dialog>

      <Dialog
        open={mergeMaterial !== null}
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setMergeMaterial(null);
          }
        }}
        title="合并重复素材"
        description="源素材会变为已合并状态；既有引用仍指向原始出处信息，不会被静默改写。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMergeMaterial(null)}>
              取消
            </Button>
            <Button loading={busy} onClick={() => void confirmMerge()}>
              确认合并
            </Button>
          </>
        }
      >
        <div className="material-form">
          <div className="material-impact">
            <strong>{mergeMaterial?.toSnapshot().title}</strong>
            <p>
              当前影响：{mergeMaterial === null ? 0 : (references[mergeMaterial.id]?.length ?? 0)}{" "}
              条章节引用。合并不会迁移或覆盖这些引用。
            </p>
          </div>
          <FormField label="保留素材" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={mergeSurvivorId}
                placeholder="请选择保留素材"
                options={activeMaterials
                  .filter(({ id }) => id !== mergeMaterial?.id)
                  .map((material) => ({
                    value: material.id,
                    label: material.toSnapshot().title,
                  }))}
                onChange={(event) => setMergeSurvivorId(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>
    </div>
  );
}

interface MaterialCardProps {
  readonly material: Material;
  readonly references: readonly MaterialReference[];
  readonly chapters: readonly Chapter[];
  readonly readonly: boolean;
  readonly busy: boolean;
  readonly canMerge: boolean;
  readonly onReference?: () => void;
  readonly onDelete?: () => void;
  readonly onMerge?: () => void;
  readonly onRestore?: () => void;
}

function MaterialCard({
  busy,
  canMerge,
  chapters,
  material,
  onDelete,
  onMerge,
  onReference,
  onRestore,
  readonly,
  references,
}: MaterialCardProps) {
  const snapshot = material.toSnapshot();
  const generationAllowed = material.canUseFor("generation");
  const trainingAllowed = material.canUseFor("training");
  return (
    <Card className="material-card">
      <CardHeader>
        <div className="material-card-heading">
          <div>
            <CardTitle>{snapshot.title}</CardTitle>
            <CardDescription>
              {snapshot.sourceName}
              {snapshot.author === null ? "" : ` · ${snapshot.author}`}
            </CardDescription>
          </div>
          <Badge tone={statusTone(snapshot.status)}>{statusLabel(snapshot.status)}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="material-badges">
          <Badge tone="info">{licenseLabel(snapshot.license)}</Badge>
          <Badge tone={generationAllowed ? "success" : "danger"}>
            生成：{generationAllowed ? "允许" : "禁止"}
          </Badge>
          <Badge tone={trainingAllowed ? "success" : "danger"}>
            训练：{trainingAllowed ? "允许" : "禁止"}
          </Badge>
        </div>
        <p className="material-summary-copy">{snapshot.summary}</p>
        <blockquote className="material-excerpt">
          {snapshot.body.slice(0, 360)}
          {snapshot.body.length > 360 ? "…" : ""}
        </blockquote>
        <dl className="material-provenance">
          <div>
            <dt>权利依据</dt>
            <dd>{snapshot.permissions.rightsBasis}</dd>
          </div>
          <div>
            <dt>内容指纹</dt>
            <dd title={snapshot.contentFingerprint}>{snapshot.contentFingerprint.slice(0, 12)}…</dd>
          </div>
          {snapshot.sourceUrl !== null && (
            <div>
              <dt>来源网址</dt>
              <dd>
                <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
                  打开来源
                </a>
              </dd>
            </div>
          )}
          {snapshot.retentionUntil !== null && (
            <div>
              <dt>正文保留至</dt>
              <dd>{formatDate(snapshot.retentionUntil)}</dd>
            </div>
          )}
          {snapshot.mergedIntoId !== null && (
            <div>
              <dt>合并到</dt>
              <dd>{snapshot.mergedIntoId.slice(0, 8)}…</dd>
            </div>
          )}
        </dl>
        {snapshot.tags.length > 0 && (
          <div className="material-badges" aria-label="素材标签">
            {snapshot.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
        <section className="material-reference-section" aria-label={`${snapshot.title} 的章节引用`}>
          <div className="material-reference-heading">
            <strong>章节引用</strong>
            <Badge tone={references.length > 0 ? "accent" : "neutral"}>
              {references.length} 条
            </Badge>
          </div>
          {references.length === 0 ? (
            <p className="material-reference-empty">尚未记录章节引用。</p>
          ) : (
            <ul className="material-reference-list">
              {references.map((reference) => {
                const referenceSnapshot = reference.toSnapshot();
                const chapter = chapters.find(
                  ({ id }) => String(id) === String(referenceSnapshot.targetChapterId),
                );
                return (
                  <li key={reference.id}>
                    <strong>{chapter?.title ?? "已移除章节"}</strong>
                    <span>{referenceSnapshot.note}</span>
                    <small>
                      保存的出处：{referenceSnapshot.provenance.sourceName} ·{" "}
                      {licenseLabel(referenceSnapshot.provenance.license)} · 版本{" "}
                      {referenceSnapshot.targetVersionId.slice(0, 8)}…
                    </small>
                    <blockquote>{referenceSnapshot.excerpt}</blockquote>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </CardContent>
      <CardFooter className="material-card-actions">
        {snapshot.status === "active" ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={readonly || busy || chapters.length === 0}
              onClick={onReference}
            >
              记录引用
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readonly || busy || !canMerge}
              onClick={onMerge}
            >
              合并到…
            </Button>
            <Button size="sm" variant="danger" disabled={readonly || busy} onClick={onDelete}>
              删除并保留引用
            </Button>
          </>
        ) : snapshot.status === "deleted" ? (
          <Button size="sm" disabled={readonly || busy} onClick={onRestore}>
            恢复素材
          </Button>
        ) : (
          <span className="material-disposition-note">已合并；原引用保持不变</span>
        )}
      </CardFooter>
    </Card>
  );
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function splitTags(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[,，\n]/u)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  ];
}

function licenseLabel(license: MaterialLicenseKind): string {
  switch (license) {
    case "owned":
      return "自有权利";
    case "licensed":
      return "已获许可";
    case "public_domain":
      return "公共领域";
    case "permission_unknown":
      return "权利未知";
  }
}

function statusLabel(status: ReturnType<Material["toSnapshot"]>["status"]): string {
  switch (status) {
    case "active":
      return "有效";
    case "deleted":
      return "已删除";
    case "merged":
      return "已合并";
  }
}

function statusTone(
  status: ReturnType<Material["toSnapshot"]>["status"],
): "success" | "warning" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "deleted":
      return "warning";
    case "merged":
      return "neutral";
  }
}

function formatDate(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}
