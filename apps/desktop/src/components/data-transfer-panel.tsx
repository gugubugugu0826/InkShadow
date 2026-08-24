import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { Chapter, Project } from "@inkshadow/domain";
import {
  IMPORT_LIMITS,
  ImportExportError,
  createPortableBundle,
  exportProjectToMarkdown,
  exportProjectToPlainText,
  preflightImport,
  sanitizeMarkdown,
  sanitizeFilename,
  serializePortableBundle,
  type ImportExportErrorCode,
  type ImportPreflightReport,
  type PortableProjectInput,
} from "@inkshadow/import-export/core";
import type { DocxExportErrorCode, DocxExportProgress } from "@inkshadow/import-export/docx-export";
import type { EpubExportErrorCode, EpubExportProgress } from "@inkshadow/import-export/epub-export";
import type { PdfExportErrorCode, PdfExportProgress } from "@inkshadow/import-export/pdf-export";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Input,
  Select,
  Textarea,
} from "@inkshadow/ui";
import { Link } from "react-router-dom";

import {
  createProjectReportArtifact,
  type ProjectReportKind,
} from "../infrastructure/project-report-export";
import { collectProjectExportSnapshot } from "../infrastructure/project-export-snapshot";
import {
  ExportArtifactSaveError,
  persistLastExportReceipt,
  readLastExportReceipt,
  saveExportArtifact,
  type BrowserExportArtifact,
  type ExportArtifactFormat,
  type ExportArtifactSaveReceipt,
} from "../infrastructure/export-artifact-download";
import { projectOrdinaryUiError, UiActionError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

const issueLabels: Record<ImportExportErrorCode, string> = {
  IMPORT_EMPTY: "请选择至少一个文件。",
  IMPORT_TOO_MANY_FILES: "一次选择的文件过多。",
  IMPORT_FILE_TOO_LARGE: "有文件超过单文件大小限制。",
  IMPORT_TOTAL_TOO_LARGE: "所选文件的总大小超过限制。",
  IMPORT_MIXED_FORMATS: "墨影完整备份必须单独导入，不能与文本文件混选。",
  IMPORT_DUPLICATE_FILE: "发现重复文件名或重复章节路径。",
  IMPORT_EXTENSION_FORBIDDEN: "文件扩展名不受支持。",
  IMPORT_MACRO_FORMAT_FORBIDDEN: "不接受包含宏的文件格式。",
  IMPORT_BINARY_FORMAT_FORBIDDEN: "文本导入器拒绝二进制、压缩包或办公文档。",
  IMPORT_MAGIC_MISMATCH: "文件扩展名与真实文件签名不一致。",
  IMPORT_ENCODING_UNCERTAIN: "无法无损确认文本编码，请另存为 UTF-8 后重试。",
  IMPORT_ARCHIVE_INVALID: "DOCX 或 EPUB 压缩包结构损坏、校验失败或不受支持。",
  IMPORT_ARCHIVE_LIMIT_EXCEEDED: "DOCX 或 EPUB 的解压大小、条目数或压缩比超过安全限制。",
  IMPORT_ARCHIVE_ENCRYPTED: "不支持包含加密压缩条目的 DOCX 或 EPUB。",
  IMPORT_ARCHIVE_ACTIVE_CONTENT: "DOCX 包含宏、嵌入对象或其他活动内容。",
  IMPORT_PATH_TRAVERSAL: "文件包含不安全的跨目录路径。",
  IMPORT_UNSAFE_PATH: "文件路径不符合安全规则。",
  IMPORT_UNSAFE_CONTENT: "文件包含不安全内容。",
  DOCX_PARSE_FAILED: "DOCX 无法在隔离解析器中安全读取。",
  DOCX_PARSER_WARNING: "DOCX 中不受支持的结构已被忽略。",
  EPUB_PARSE_FAILED: "EPUB 无法安全解析，请确认文件结构完整。",
  EPUB_DRM_UNSUPPORTED: "暂不支持带 DRM 或加密保护的 EPUB。",
  EPUB_CONTENT_UNAVAILABLE: "EPUB 中没有找到可导入的章节文本。",
  EPUB_ACTIVE_CONTENT_FORBIDDEN: "EPUB 包含脚本或其他活动内容，已停止导入。",
  PDF_PARSE_FAILED: "PDF 无法安全解析。",
  PDF_ENCRYPTED_UNSUPPORTED: "加密或密码保护 PDF 不受支持。",
  PDF_TEXT_UNAVAILABLE: "PDF 没有可提取文本；扫描件与 OCR 暂不支持。",
  PDF_PAGE_LIMIT_EXCEEDED: "PDF 页数超过安全上限。",
  PDF_ACTIVE_CONTENT_FORBIDDEN: "PDF 包含附件、表单、XFA 或 JavaScript。",
  IMPORT_CHAPTER_BOUNDARY_REVIEW: "章节边界置信度较低，请在写入前检查标题和正文。",
  IMPORT_CHAPTER_SPLIT: "超大章节已拆成可检查的多个部分。",
  IMPORT_INVALID_JSON: "完整备份文件内容无效。",
  BUNDLE_SCHEMA_INVALID: "完整备份结构不符合墨影便携格式。",
  BUNDLE_VERSION_UNSUPPORTED: "这个完整备份来自当前版本无法读取的版本。",
  BUNDLE_CHECKSUM_MISMATCH: "完整备份内容校验失败，文件可能已损坏或被修改。",
  BUNDLE_ENTRY_CHECKSUM_MISMATCH: "完整备份中有章节校验失败。",
  BUNDLE_MANIFEST_CONTENT_MISMATCH: "完整备份清单与实际内容不一致。",
  BUNDLE_DUPLICATE_ENTRY: "完整备份中存在重复章节。",
  BUNDLE_LIMIT_EXCEEDED: "完整备份超过安全大小限制。",
  MARKDOWN_EMPTY: "文件中没有可导入的有效文本。",
  MARKDOWN_RAW_HTML_ESCAPED: "原始 HTML 已转为普通文本。",
  MARKDOWN_EXTERNAL_REFERENCE_REMOVED: "外部链接或可执行引用已被移除。",
  HTML_MARKUP_REMOVED: "HTML 标签和属性已移除，仅保留本地文本。",
  TEXT_BOM_REMOVED: "已移除文本开头的字节顺序标记。",
};

const formatLabels: Record<ImportPreflightReport["format"], string> = {
  portable_bundle: "墨影完整备份",
  docx: "DOCX",
  epub: "EPUB",
  html: "HTML",
  markdown: "Markdown",
  pdf: "PDF",
  text: "纯文本",
  mixed: "混合文件",
  unknown: "未知格式",
};

const projectReportOptions: readonly Readonly<{ value: ProjectReportKind; label: string }>[] = [
  { value: "characters", label: "角色设定" },
  { value: "world", label: "世界观设定" },
  { value: "foreshadow", label: "伏笔" },
  { value: "timeline", label: "时间线" },
  { value: "outline", label: "大纲" },
  { value: "review", label: "审阅报告" },
  { value: "ai_usage", label: "AI 用量报告" },
];

interface ExportNotice {
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly description: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} 字节`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} 千字节`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} 兆字节`;
}

function errorDescription(error: unknown): string {
  if (error instanceof ExportArtifactSaveError) {
    return error.message;
  }
  if (error instanceof ImportExportError) {
    return issueLabels[error.code];
  }
  const epubCode = getEpubExportErrorCode(error);
  if (epubCode !== null) {
    const labels: Record<EpubExportErrorCode, string> = {
      EPUB_RENDER_FAILED: "EPUB 生成失败，项目内容没有写入不完整文件。",
      EXPORT_CANCELLED: "EPUB 导出已取消。",
      EXPORT_OUTPUT_TOO_LARGE: "EPUB 超过 64 兆字节安全上限，未生成截断文件。",
    };
    return labels[epubCode];
  }
  const pdfCode = getPdfExportErrorCode(error);
  if (pdfCode !== null) {
    const labels: Record<PdfExportErrorCode, string> = {
      PDF_RENDER_FAILED: "PDF 生成失败，没有下载不完整文件。",
      PDF_COMPLEXITY_LIMIT_EXCEEDED: "PDF 的章节、正文、区块或页数超过本地安全上限。",
      EXPORT_CANCELLED: "PDF 导出已取消。",
      EXPORT_OUTPUT_TOO_LARGE: "PDF 超过 64 兆字节安全上限，未生成截断文件。",
    };
    return labels[pdfCode];
  }
  const docxCode = getDocxExportErrorCode(error);
  if (docxCode !== null) {
    const labels: Record<DocxExportErrorCode, string> = {
      DOCX_RENDER_FAILED: "DOCX 生成失败，项目内容没有写入不完整文件。",
      EXPORT_CANCELLED: "DOCX 导出已取消。",
      EXPORT_OUTPUT_TOO_LARGE: "DOCX 超过 64 兆字节安全上限，未生成截断文件。",
    };
    return labels[docxCode];
  }
  return projectOrdinaryUiError(error).description;
}

export interface CompletedImport {
  readonly projectId: Project["id"];
  readonly firstChapterId: Chapter["id"];
  readonly projectName: string;
  readonly chapterCount: number;
}

export interface DataTransferPanelProps {
  readonly mode?: "full" | "import-only";
  readonly onImportComplete?: (completedImport: CompletedImport) => void;
}

interface ImportUiProgress {
  readonly label: string;
  readonly value: number;
  readonly maximum: number;
}

interface ImportDocumentDraft {
  readonly boundaryConfirmed: boolean;
  readonly sourceName: string;
  readonly requiresBoundaryReview: boolean;
  readonly title: string;
  readonly content: string;
}

export function DataTransferPanel({
  mode = "full",
  onImportComplete,
}: DataTransferPanelProps = {}) {
  const runtime = useRuntime();
  const [preflight, setPreflight] = useState<ImportPreflightReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importDragActive, setImportDragActive] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportUiProgress | null>(null);
  const [importCommitBusy, setImportCommitBusy] = useState(false);
  const [importProjectName, setImportProjectName] = useState("");
  const [importDocumentDrafts, setImportDocumentDrafts] = useState<readonly ImportDocumentDraft[]>(
    [],
  );
  const [completedImport, setCompletedImport] = useState<CompletedImport | null>(null);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState<
    "text" | "markdown" | "bundle" | "epub" | "docx" | "pdf" | "report" | null
  >(null);
  const [epubProgress, setEpubProgress] = useState<EpubExportProgress | null>(null);
  const [docxProgress, setDocxProgress] = useState<DocxExportProgress | null>(null);
  const [pdfProgress, setPdfProgress] = useState<PdfExportProgress | null>(null);
  const [projectReportKind, setProjectReportKind] = useState<ProjectReportKind>("characters");
  const [includeLocalOnlyChapters, setIncludeLocalOnlyChapters] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    const result = await runtime.useCases.listProjects.execute({
      statuses: ["active", "archived"],
    });
    if (result.ok) {
      setProjects(result.value);
      setSelectedProjectId((current) =>
        current.length > 0 ? current : (result.value[0]?.id ?? ""),
      );
      setTransferError(null);
    } else {
      setTransferError(projectOrdinaryUiError(result.error).description);
    }
    setProjectsLoading(false);
  }, [runtime]);

  useEffect(() => {
    if (mode === "full") {
      void Promise.resolve().then(loadProjects);
    } else {
      void Promise.resolve().then(() => setProjectsLoading(false));
    }
  }, [loadProjects, mode]);

  useEffect(() => {
    if (mode !== "full" || selectedProjectId.length === 0) {
      return;
    }
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) {
        return;
      }
      const receipt = readLastExportReceipt(window.localStorage, selectedProjectId);
      setExportNotice(receipt === null ? null : exportReceiptNotice(receipt, 0, "", true));
    });
    return () => {
      active = false;
    };
  }, [mode, selectedProjectId]);

  useEffect(
    () => () => {
      importAbortRef.current?.abort(new DOMException("Import view closed.", "AbortError"));
      exportAbortRef.current?.abort(new DOMException("Export view closed.", "AbortError"));
    },
    [],
  );

  async function inspectFiles(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    await inspectSelectedFiles(selectedFiles);
  }

  async function inspectDroppedFiles(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setImportDragActive(false);
    if (importBusy) {
      return;
    }
    await inspectSelectedFiles(Array.from(event.dataTransfer.files));
  }

  async function inspectSelectedFiles(selectedFiles: readonly File[]): Promise<void> {
    importAbortRef.current?.abort(new DOMException("Superseded import.", "AbortError"));
    const controller = new AbortController();
    importAbortRef.current = controller;
    setImportBusy(true);
    setImportProgress(null);
    setTransferError(null);
    setPreflight(null);
    setImportDocumentDrafts([]);
    setCompletedImport(null);
    try {
      assertBrowserFileSelectionLimits(selectedFiles);
      const totalBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
      const files: { readonly name: string; readonly bytes: Uint8Array }[] = [];
      let completedBytes = 0;
      for (const file of selectedFiles) {
        const bytes = await readBrowserFile(file, controller.signal, (loaded) => {
          setImportProgress({
            label: `正在读取 ${file.name}`,
            value: completedBytes + loaded,
            maximum: Math.max(totalBytes, 1),
          });
        });
        files.push({ name: file.name, bytes });
        completedBytes += bytes.byteLength;
      }
      const report = await preflightImport(files, {
        signal: controller.signal,
        onProgress: (progress) => {
          setImportProgress({
            label:
              progress.stage === "scanning"
                ? `正在安全扫描 ${progress.fileName}`
                : `正在隔离解析 ${progress.fileName}`,
            value: progress.completedUnits,
            maximum: Math.max(progress.totalUnits, 1),
          });
        },
      });
      throwIfImportAborted(controller.signal);
      setPreflight(report);
      setImportProjectName(suggestImportProjectName(report));
      setImportDocumentDrafts(documentDraftsFromReport(report));
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setTransferError(errorDescription(error));
      }
    } finally {
      if (importAbortRef.current === controller) {
        importAbortRef.current = null;
        setImportBusy(false);
        setImportProgress(null);
      }
    }
  }

  async function commitImport(): Promise<void> {
    const candidate = preflight?.candidate;
    if (preflight?.status !== "ready" || candidate === undefined) {
      return;
    }

    setImportCommitBusy(true);
    setTransferError(null);
    setCompletedImport(null);
    try {
      const chapters =
        candidate.kind === "documents"
          ? importDocumentDrafts.map((document) => {
              const title = document.title.normalize("NFKC").trim();
              if (title.length === 0) {
                throw new ImportExportError(
                  "IMPORT_UNSAFE_CONTENT",
                  "Every imported chapter must have a title.",
                  { fileName: document.sourceName },
                );
              }
              const sanitized = sanitizeMarkdown(document.content, document.sourceName);
              return {
                title: title.slice(0, 200),
                content: sanitized.markdown,
              };
            })
          : candidate.project.chapters.map((chapter) => ({
              title: chapter.title,
              content: chapter.markdown,
            }));
      const result = await runtime.useCases.importProject.execute({
        name: importProjectName,
        chapters,
      });
      if (!result.ok) {
        throw result.error;
      }
      const firstChapter = result.value.chapters[0];
      if (firstChapter === undefined) {
        throw new UiActionError(
          "IMPORT_EMPTY_RESULT",
          "导入结果中没有可打开的章节；原文件没有被修改，请检查文件内容后重新导入。",
        );
      }
      const completed: CompletedImport = {
        projectId: result.value.project.id,
        firstChapterId: firstChapter.id,
        projectName: result.value.project.name,
        chapterCount: result.value.chapters.length,
      };
      setCompletedImport(completed);
      setSelectedProjectId(result.value.project.id);
      onImportComplete?.(completed);
      if (mode === "full") {
        await loadProjects();
      }
    } catch (error: unknown) {
      setTransferError(errorDescription(error));
    } finally {
      setImportCommitBusy(false);
    }
  }

  async function exportProject(
    format: "text" | "markdown" | "bundle" | "epub" | "docx" | "pdf",
  ): Promise<void> {
    const project = projects.find(({ id }) => id === selectedProjectId);
    if (project === undefined) {
      return;
    }
    const controller =
      format === "epub" || format === "docx" || format === "pdf" ? new AbortController() : null;
    exportAbortRef.current = controller;
    setExportBusy(format);
    setEpubProgress(null);
    setDocxProgress(null);
    setPdfProgress(null);
    setTransferError(null);
    setExportNotice(null);
    let omittedLocalOnlyChapterCount = 0;
    try {
      const chaptersResult = await runtime.repositories.chapters.listByProjectId(project.id);
      if (!chaptersResult.ok) {
        throw chaptersResult.error;
      }
      const projectSnapshot = project.toSnapshot();
      const activeChapters = chaptersResult.value.filter(({ status }) => status === "active");
      omittedLocalOnlyChapterCount = includeLocalOnlyChapters
        ? 0
        : activeChapters.filter(({ privacyMode }) => privacyMode === "local_only").length;
      const chapters = activeChapters.filter(
        ({ privacyMode }) => includeLocalOnlyChapters || privacyMode !== "local_only",
      );
      if (chapters.length === 0 && omittedLocalOnlyChapterCount > 0) {
        throw new UiActionError(
          "PRIVATE_CHAPTER_EXPORT_CONFIRMATION_REQUIRED",
          "这个项目当前只有私密章节。若确实要让这些内容离开墨影的本地保护，请先勾选“包含私密章节”后重新导出。",
          "私密章节尚未导出",
        );
      }
      const input: PortableProjectInput = {
        project: {
          id: project.id,
          title: project.name,
          language: "zh-CN",
          createdAt: projectSnapshot.createdAt,
          updatedAt: projectSnapshot.updatedAt,
        },
        chapters: chapters.map((chapter, order) => ({
          id: chapter.id,
          title: chapter.title,
          order,
          markdown: chapter.content,
        })),
      };
      const exportedAt = runtime.clock.now();
      const runtimeInformation = await runtime.getRuntimeInformation();
      const bundle = await createPortableBundle(input, {
        bundleId: runtime.ids.next(),
        exportedAt,
        generatorVersion: runtimeInformation.appVersion,
      });

      if (format === "text") {
        const artifact = exportProjectToPlainText(bundle.content);
        await finishExport(artifact, "text", omittedLocalOnlyChapterCount);
      } else if (format === "markdown") {
        const artifact = exportProjectToMarkdown(bundle.content);
        await finishExport(artifact, "markdown", omittedLocalOnlyChapterCount);
      } else if (format === "bundle") {
        const content = await serializePortableBundle(bundle);
        const fileName = sanitizeFilename(project.name, ".inkshadow.json");
        await finishExport(
          { fileName, content, mediaType: "application/json" },
          "bundle",
          omittedLocalOnlyChapterCount,
        );
      } else if (format === "epub") {
        const { exportProjectToEpub } = await import("@inkshadow/import-export/epub-export");
        const artifact = await exportProjectToEpub(bundle.content, {
          generatedAt: exportedAt,
          ...(controller === null ? {} : { signal: controller.signal }),
          onProgress: setEpubProgress,
        });
        const issueSummary =
          artifact.issues.length === 0
            ? ""
            : `，含 ${String(artifact.issues.length)} 条可审阅的格式提示`;
        await finishExport(
          { fileName: artifact.fileName, mediaType: artifact.mediaType, content: artifact.bytes },
          "epub",
          omittedLocalOnlyChapterCount,
          `${formatBytes(artifact.byteLength)}${issueSummary}`,
        );
      } else if (format === "docx") {
        const { exportProjectToDocx } = await import("@inkshadow/import-export/docx-export");
        const artifact = await exportProjectToDocx(bundle.content, {
          generatedAt: exportedAt,
          ...(controller === null ? {} : { signal: controller.signal }),
          onProgress: setDocxProgress,
        });
        const issueSummary =
          artifact.issues.length === 0
            ? ""
            : `，含 ${String(artifact.issues.length)} 条可审阅的格式提示`;
        await finishExport(
          { fileName: artifact.fileName, mediaType: artifact.mediaType, content: artifact.bytes },
          "docx",
          omittedLocalOnlyChapterCount,
          `${formatBytes(artifact.byteLength)}${issueSummary}`,
        );
      } else {
        const { exportProjectToPdf, rasterizePublicationToJpegPages } =
          await import("../infrastructure/browser-pdf-page-rasterizer");
        const artifact = await exportProjectToPdf(bundle.content, {
          generatedAt: exportedAt,
          rasterize: rasterizePublicationToJpegPages,
          ...(controller === null ? {} : { signal: controller.signal }),
          onProgress: setPdfProgress,
        });
        const issueSummary =
          artifact.issues.length === 0
            ? ""
            : `，含 ${String(artifact.issues.length)} 条可审阅的格式提示`;
        await finishExport(
          { fileName: artifact.fileName, mediaType: artifact.mediaType, content: artifact.bytes },
          "pdf",
          omittedLocalOnlyChapterCount,
          `${String(artifact.pageCount)} 页图像型 PDF，${formatBytes(
            artifact.byteLength,
          )}${issueSummary}；中文外观已固定，文本不可选择`,
        );
      }
    } catch (error: unknown) {
      if (
        getEpubExportErrorCode(error) === "EXPORT_CANCELLED" ||
        getDocxExportErrorCode(error) === "EXPORT_CANCELLED" ||
        getPdfExportErrorCode(error) === "EXPORT_CANCELLED"
      ) {
        setExportNotice({
          tone: "warning",
          title: "已取消导出",
          description: `${format === "pdf" ? "PDF" : format === "epub" ? "EPUB" : "DOCX"} 生成已停止，没有下载半成品。`,
        });
      } else {
        if (error instanceof ExportArtifactSaveError) {
          rememberExportReceipt(error.receipt);
          setExportNotice(exportReceiptNotice(error.receipt, omittedLocalOnlyChapterCount));
        }
        setTransferError(errorDescription(error));
      }
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
      }
      setEpubProgress(null);
      setDocxProgress(null);
      setPdfProgress(null);
      setExportBusy(null);
    }
  }

  async function finishExport(
    artifact: BrowserExportArtifact,
    format: ExportArtifactFormat,
    omittedLocalOnlyChapterCount: number,
    detail = "",
  ): Promise<void> {
    const receipt = await saveExportArtifact(artifact, { format, mode: runtime.mode });
    rememberExportReceipt(receipt);
    setExportNotice(exportReceiptNotice(receipt, omittedLocalOnlyChapterCount, detail));
  }

  function rememberExportReceipt(receipt: ExportArtifactSaveReceipt): void {
    persistLastExportReceipt(window.localStorage, selectedProjectId, receipt);
  }

  async function exportProjectReport(): Promise<void> {
    const project = projects.find(({ id }) => id === selectedProjectId);
    if (project === undefined) {
      return;
    }
    setExportBusy("report");
    setTransferError(null);
    setExportNotice(null);
    try {
      const chaptersResult = await runtime.repositories.chapters.listByProjectId(project.id);
      if (!chaptersResult.ok) {
        throw chaptersResult.error;
      }
      const omittedLocalOnlyChapterCount = includeLocalOnlyChapters
        ? 0
        : chaptersResult.value.filter(
            ({ status, privacyMode }) => status === "active" && privacyMode === "local_only",
          ).length;
      const snapshot = await collectProjectExportSnapshot(
        {
          projects: runtime.repositories.projects,
          chapters: runtime.repositories.chapters,
          story: {
            outlines: runtime.story.outlines,
            formalRecords: runtime.story.formalRecords,
            extractionItems: runtime.story.extractionItems,
            consistencyItems: runtime.story.consistencyItems,
          },
          generationGovernance: runtime.generationGovernance,
          clock: runtime.clock,
        },
        project.id,
        { includeLocalOnlyChapters },
      );
      if (!snapshot.ok) {
        throw snapshot.error;
      }
      const artifact = createProjectReportArtifact(snapshot.value, projectReportKind);
      await finishExport(
        artifact,
        "report",
        omittedLocalOnlyChapterCount,
        `${String(artifact.recordCount)} 条记录`,
      );
    } catch (error: unknown) {
      if (error instanceof ExportArtifactSaveError) {
        rememberExportReceipt(error.receipt);
        setExportNotice(exportReceiptNotice(error.receipt));
      }
      setTransferError(errorDescription(error));
    } finally {
      setExportBusy(null);
    }
  }

  return (
    <Card id="data-transfer" className="settings-card--wide">
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle headingLevel={2}>
              {mode === "import-only" ? "安全导入原作" : "导入与导出"}
            </CardTitle>
            <CardDescription>
              文件先经过安全检查和净化，再显示可编辑的待导入内容；确认前不会写入任何项目。
            </CardDescription>
          </div>
          <Badge tone="info">本地文件</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="data-transfer-grid">
          <section className="data-transfer-section" aria-labelledby="import-title">
            <div>
              <h3 id="import-title">导入预检</h3>
              <p>
                支持本地解析 TXT、Markdown、DOCX、EPUB、静态 HTML 与可提取文本的 PDF；扫描
                PDF/OCR、宏、脚本和远程资源不会执行。
              </p>
            </div>
            <div
              className={`import-dropzone${importDragActive ? " import-dropzone--active" : ""}`}
              aria-label="拖放作品文件，或使用按钮选择文件"
              onDragEnter={(event) => {
                event.preventDefault();
                if (!importBusy) {
                  setImportDragActive(true);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setImportDragActive(false);
                }
              }}
              onDrop={(event) => void inspectDroppedFiles(event)}
            >
              <div>
                <strong>{importDragActive ? "松开即可开始安全检查" : "把作品文件拖到这里"}</strong>
                <p>单文件与单次选择均不超过 50 兆字节，最多 200 个文件。</p>
              </div>
              <div className="import-format-badges" aria-label="支持的作品格式">
                {["MD", "DOCX", "EPUB", "HTML", "PDF", "TXT"].map((format) => (
                  <Badge key={format}>{format}</Badge>
                ))}
              </div>
              <div className="settings-actions">
                <Button
                  variant="secondary"
                  disabled={importBusy}
                  onClick={() => importFileInputRef.current?.click()}
                >
                  浏览选择文件
                </Button>
                {importBusy && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      importAbortRef.current?.abort(
                        new DOMException("Import cancelled by user.", "AbortError"),
                      )
                    }
                  >
                    取消预检
                  </Button>
                )}
              </div>
              <Input
                ref={importFileInputRef}
                className="import-file-input"
                type="file"
                accept=".txt,.md,.markdown,.docx,.epub,.htm,.html,.pdf,.json,.inkshadow.json"
                multiple
                tabIndex={-1}
                disabled={importBusy}
                aria-hidden="true"
                onChange={(event) => void inspectFiles(event)}
              />
              <p className="maintenance-note">
                墨影完整备份（.inkshadow.json）也可单独选择，用于带校验清单的完整恢复。
              </p>
            </div>
            {importBusy && (
              <div className="import-progress" aria-live="polite">
                <InlineAlert
                  tone="info"
                  title="正在本机安全检查文件"
                  description={`${importProgress?.label ?? "正在准备读取"}；文件不会上传。`}
                />
                <progress
                  value={importProgress?.value ?? 0}
                  max={importProgress?.maximum ?? 1}
                  aria-label={importProgress?.label ?? "导入预检进度"}
                />
              </div>
            )}
            {preflight !== null && (
              <ImportPreview
                report={preflight}
                documentDrafts={importDocumentDrafts}
                onDocumentDraftChange={(index, next) =>
                  setImportDocumentDrafts((current) =>
                    current.map((document, currentIndex) =>
                      currentIndex === index ? next : document,
                    ),
                  )
                }
              />
            )}
            {preflight?.status === "ready" && preflight.candidate !== undefined && (
              <div className="import-confirmation">
                <FormField
                  label="导入为项目名称"
                  hint="确认后，项目、章节与首个正式版本会在同一事务中写入。"
                  required
                >
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      maxLength={120}
                      value={importProjectName}
                      disabled={importCommitBusy || completedImport !== null}
                      onChange={(event) => setImportProjectName(event.currentTarget.value)}
                    />
                  )}
                </FormField>
                <Button
                  loading={importCommitBusy}
                  disabled={
                    importCommitBusy ||
                    completedImport !== null ||
                    importProjectName.trim().length === 0 ||
                    (preflight.candidate.kind === "documents" &&
                      (importDocumentDrafts.length === 0 ||
                        importDocumentDrafts.some(
                          ({ boundaryConfirmed, content, title }) =>
                            !boundaryConfirmed ||
                            title.trim().length === 0 ||
                            content.trim().length === 0,
                        )))
                  }
                  onClick={() => void commitImport()}
                >
                  确认导入
                </Button>
              </div>
            )}
            {completedImport !== null && (
              <InlineAlert
                tone="info"
                title="导入完成"
                description={
                  <div className="import-complete">
                    <span>
                      {completedImport.projectName} 已写入 {String(completedImport.chapterCount)}{" "}
                      个章节；导入报告已确认无半成品。
                    </span>
                    {mode === "full" ? (
                      <Link
                        className="button-link"
                        to={`/projects/${completedImport.projectId}/chapters/${completedImport.firstChapterId}`}
                      >
                        打开第一章
                      </Link>
                    ) : (
                      <span>下方会自动读取作品结构并继续本次流程。</span>
                    )}
                  </div>
                }
              />
            )}
          </section>

          {mode === "full" && (
            <section className="data-transfer-section" aria-labelledby="export-title">
              <div>
                <h3 id="export-title">导出项目</h3>
                <p>
                  DOCX 适合继续排版；PDF 会在本机固定中文外观并生成不可选字的图像型文档；Markdown
                  适合阅读与分享；完整备份
                  会保留项目及章节结构并带校验清单；领域报告只包含所选项目的结构化数据。
                  {runtime.mode === "tauri"
                    ? " 每次保存都会先由你选择位置，写入后再从磁盘回读核验。"
                    : " 浏览器下载的最终位置由浏览器决定，墨影会明确标记为无法核验路径。"}
                </p>
              </div>
              {projects.length === 0 && !projectsLoading ? (
                <InlineAlert
                  tone="info"
                  title="暂无可导出的项目"
                  description="新建项目后即可在此导出；回收站项目不会出现在列表中。"
                />
              ) : (
                <>
                  <FormField label="选择项目">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={selectedProjectId}
                        loading={projectsLoading}
                        options={projects.map((project) => ({
                          value: project.id,
                          label:
                            project.status === "archived"
                              ? `${project.name}（已归档）`
                              : project.name,
                        }))}
                        onChange={(event) => {
                          setSelectedProjectId(event.currentTarget.value);
                          setIncludeLocalOnlyChapters(false);
                        }}
                      />
                    )}
                  </FormField>
                  <label className="private-export-option">
                    <input
                      type="checkbox"
                      aria-label="包含私密章节"
                      checked={includeLocalOnlyChapters}
                      disabled={exportBusy !== null}
                      onChange={(event) => setIncludeLocalOnlyChapters(event.currentTarget.checked)}
                    />
                    <span>
                      <strong>包含私密章节</strong>
                      <small>
                        默认不包含。勾选后，私密正文及其直接分析记录会写入导出文件并离开墨影的本地保护。
                      </small>
                    </span>
                  </label>
                  <div className="settings-actions">
                    <Button
                      variant="secondary"
                      loading={exportBusy === "text"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProject("text")}
                    >
                      {runtime.mode === "tauri" ? "保存 TXT" : "下载 TXT"}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={exportBusy === "markdown"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProject("markdown")}
                    >
                      {runtime.mode === "tauri" ? "保存 Markdown" : "下载 Markdown"}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={exportBusy === "epub"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProject("epub")}
                    >
                      {runtime.mode === "tauri" ? "保存 EPUB" : "下载 EPUB"}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={exportBusy === "docx"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProject("docx")}
                    >
                      {runtime.mode === "tauri" ? "保存 DOCX" : "下载 DOCX"}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={exportBusy === "pdf"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProject("pdf")}
                    >
                      {runtime.mode === "tauri" ? "保存 PDF" : "下载 PDF"}
                    </Button>
                    <Button
                      loading={exportBusy === "bundle"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProject("bundle")}
                    >
                      {runtime.mode === "tauri" ? "保存完整备份" : "下载完整备份"}
                    </Button>
                    {(exportBusy === "epub" || exportBusy === "docx" || exportBusy === "pdf") && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          exportAbortRef.current?.abort(
                            new DOMException("Export cancelled by user.", "AbortError"),
                          )
                        }
                      >
                        取消{" "}
                        {exportBusy === "pdf" ? "PDF" : exportBusy === "epub" ? "EPUB" : "DOCX"}{" "}
                        导出
                      </Button>
                    )}
                  </div>
                  {epubProgress !== null && (
                    <InlineAlert
                      tone="info"
                      title="正在生成 EPUB"
                      description={formatEpubProgress(epubProgress)}
                    />
                  )}
                  {docxProgress !== null && (
                    <InlineAlert
                      tone="info"
                      title="正在生成 DOCX"
                      description={formatDocxProgress(docxProgress)}
                    />
                  )}
                  {pdfProgress !== null && (
                    <InlineAlert
                      tone="info"
                      title="正在生成 PDF"
                      description={formatPdfProgress(pdfProgress)}
                    />
                  )}
                  <FormField label="领域报告">
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={projectReportKind}
                        options={projectReportOptions}
                        onChange={(event) =>
                          setProjectReportKind(event.currentTarget.value as ProjectReportKind)
                        }
                      />
                    )}
                  </FormField>
                  <div className="settings-actions">
                    <Button
                      variant="secondary"
                      loading={exportBusy === "report"}
                      disabled={exportBusy !== null || selectedProjectId.length === 0}
                      onClick={() => void exportProjectReport()}
                    >
                      {runtime.mode === "tauri" ? "保存领域报告" : "下载领域报告"}
                    </Button>
                  </div>
                </>
              )}
              {exportNotice !== null && (
                <InlineAlert
                  tone={exportNotice.tone}
                  title={exportNotice.title}
                  description={exportNotice.description}
                />
              )}
            </section>
          )}
        </div>

        {transferError !== null && (
          <InlineAlert tone="error" title="文件操作未完成" description={transferError} />
        )}
      </CardContent>
    </Card>
  );
}

function exportReceiptNotice(
  receipt: ExportArtifactSaveReceipt,
  omittedLocalOnlyChapterCount = 0,
  detail = "",
  restored = false,
): ExportNotice {
  const labels: Readonly<Record<ExportArtifactFormat, string>> = {
    text: "TXT",
    markdown: "Markdown",
    bundle: "墨影完整备份",
    epub: "EPUB",
    docx: "DOCX",
    pdf: "PDF",
    report: "领域报告",
  };
  const writeResultUnknown = receipt.verification === "write_result_unknown";
  const state =
    receipt.status === "success"
      ? "已写入并从磁盘回读核验"
      : receipt.status === "cancelled"
        ? "已取消，写入 0 B"
        : writeResultUnknown
          ? "保存结果不明确；文件可能已写入，请先检查刚才选择的位置再决定是否重试"
          : receipt.status === "failed"
            ? "保存失败，写入结果未获核验"
            : "已请求浏览器下载；最终位置与写入结果无法由应用核验";
  const currentTitle =
    receipt.status === "success"
      ? "导出完成"
      : receipt.status === "cancelled"
        ? "已取消保存"
        : writeResultUnknown
          ? "保存结果待确认"
          : receipt.status === "failed"
            ? "导出未完成"
            : "已请求浏览器下载";
  const title = restored ? `上次${currentTitle}` : currentTitle;
  const detailText = detail.length > 0 ? `；内容：${detail}` : "";
  const byteLengthLabel = writeResultUnknown ? "待写入内容" : "大小";
  return {
    tone:
      receipt.status === "success" || receipt.status === "browser_download" ? "info" : "warning",
    title,
    description: `${restored ? "上次回执；" : ""}格式：${labels[receipt.format]}；文件：${receipt.fileName}；位置：${receipt.path}；${byteLengthLabel}：${formatBytes(receipt.byteLength)}；状态：${state}${detailText}。文件内容已在交付前通过格式校验。${
      omittedLocalOnlyChapterCount > 0
        ? ` 已按默认保护排除 ${String(omittedLocalOnlyChapterCount)} 个私密章节及其可定位的直接分析记录。`
        : ""
    }`,
  };
}

function getEpubExportErrorCode(error: unknown): EpubExportErrorCode | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("name" in error) ||
    error.name !== "EpubExportError"
  ) {
    return null;
  }
  const code = error.code;
  return code === "EPUB_RENDER_FAILED" ||
    code === "EXPORT_CANCELLED" ||
    code === "EXPORT_OUTPUT_TOO_LARGE"
    ? code
    : null;
}

function getDocxExportErrorCode(error: unknown): DocxExportErrorCode | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("name" in error) ||
    error.name !== "DocxExportError"
  ) {
    return null;
  }
  const code = error.code;
  return code === "DOCX_RENDER_FAILED" ||
    code === "EXPORT_CANCELLED" ||
    code === "EXPORT_OUTPUT_TOO_LARGE"
    ? code
    : null;
}

function getPdfExportErrorCode(error: unknown): PdfExportErrorCode | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("name" in error) ||
    error.name !== "PdfExportError"
  ) {
    return null;
  }
  const code = error.code;
  return code === "PDF_RENDER_FAILED" ||
    code === "PDF_COMPLEXITY_LIMIT_EXCEEDED" ||
    code === "EXPORT_CANCELLED" ||
    code === "EXPORT_OUTPUT_TOO_LARGE"
    ? code
    : null;
}

function formatEpubProgress(progress: EpubExportProgress): string {
  const stageLabels: Record<EpubExportProgress["stage"], string> = {
    normalizing: "正在整理章节结构",
    rendering: "正在生成电子书页面",
    packaging: "正在封装 EPUB",
  };
  const maximum = Math.max(progress.totalUnits, 1);
  const percentage = Math.min(100, Math.round((progress.completedUnits / maximum) * 100));
  return `${stageLabels[progress.stage]} · ${String(percentage)}%`;
}

function formatDocxProgress(progress: DocxExportProgress): string {
  const stageLabels: Record<DocxExportProgress["stage"], string> = {
    normalizing: "正在整理章节结构",
    rendering: "正在生成版式",
    packaging: "正在封装文档",
  };
  const maximum = Math.max(progress.totalUnits, 1);
  const percentage = Math.min(100, Math.round((progress.completedUnits / maximum) * 100));
  return `${stageLabels[progress.stage]} · ${String(percentage)}%`;
}

function formatPdfProgress(progress: PdfExportProgress): string {
  const stageLabels: Record<PdfExportProgress["stage"], string> = {
    normalizing: "正在净化并整理章节",
    laying_out: "正在进行 A4 分页",
    rasterizing: "正在本机固定中文外观",
    assembling: "正在封装 PDF",
  };
  const maximum = Math.max(progress.totalUnits, 1);
  const percentage = Math.min(100, Math.round((progress.completedUnits / maximum) * 100));
  return `${stageLabels[progress.stage]} · ${String(percentage)}%`;
}

function documentDraftsFromReport(report: ImportPreflightReport): readonly ImportDocumentDraft[] {
  return report.candidate?.kind === "documents"
    ? report.candidate.documents.map((document) => ({
        sourceName: document.sourceName,
        requiresBoundaryReview: document.requiresBoundaryReview === true,
        boundaryConfirmed: document.requiresBoundaryReview !== true,
        title: document.title,
        content: document.markdown,
      }))
    : [];
}

function assertBrowserFileSelectionLimits(files: readonly File[]): void {
  if (files.length > IMPORT_LIMITS.maximumFiles) {
    throw new ImportExportError(
      "IMPORT_TOO_MANY_FILES",
      "The selected file count exceeds the import limit.",
    );
  }
  const oversized = files.find((file) => file.size > IMPORT_LIMITS.maximumFileBytes);
  if (oversized !== undefined) {
    throw new ImportExportError(
      "IMPORT_FILE_TOO_LARGE",
      "The import file exceeds the per-file size limit.",
      { fileName: oversized.name },
    );
  }
  if (files.reduce((total, file) => total + file.size, 0) > IMPORT_LIMITS.maximumTotalBytes) {
    throw new ImportExportError(
      "IMPORT_TOTAL_TOO_LARGE",
      "The selected files exceed the total import size limit.",
    );
  }
}

async function readBrowserFile(
  file: File,
  signal: AbortSignal,
  onProgress: (loadedBytes: number) => void,
): Promise<Uint8Array> {
  throwIfImportAborted(signal);
  const stream = (
    file as unknown as {
      stream?: () => ReadableStream<Uint8Array>;
    }
  ).stream;
  if (stream === undefined) {
    return readBrowserFileWithFileReader(file, signal, onProgress);
  }
  const reader = stream.call(file).getReader();
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      throwIfImportAborted(signal);
      if (offset + chunk.value.byteLength > bytes.byteLength) {
        throw new ImportExportError(
          "IMPORT_FILE_TOO_LARGE",
          "The selected file changed size while it was being read.",
          { fileName: file.name },
        );
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
      onProgress(offset);
      chunk = await reader.read();
    }
    throwIfImportAborted(signal);
    if (offset !== bytes.byteLength) {
      throw new ImportExportError(
        "IMPORT_UNSAFE_CONTENT",
        "The selected file could not be read completely.",
        { fileName: file.name },
      );
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function readBrowserFileWithFileReader(
  file: File,
  signal: AbortSignal,
  onProgress: (loadedBytes: number) => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    reader.addEventListener("load", () => {
      cleanup();
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(
          new ImportExportError(
            "IMPORT_UNSAFE_CONTENT",
            "The selected file could not be read completely.",
            { fileName: file.name },
          ),
        );
        return;
      }
      try {
        throwIfImportAborted(signal);
        resolve(new Uint8Array(reader.result));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error("The import was aborted."));
      }
    });
    reader.addEventListener("error", () => {
      cleanup();
      reject(
        new ImportExportError("IMPORT_UNSAFE_CONTENT", "The selected file could not be read.", {
          fileName: file.name,
        }),
      );
    });
    reader.addEventListener("abort", () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The import was aborted.", "AbortError"),
      );
    });
    reader.addEventListener("progress", (event) => onProgress(event.loaded));
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(file);
  });
}

function throwIfImportAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The import was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function suggestImportProjectName(report: ImportPreflightReport): string {
  const candidate = report.candidate;
  if (candidate?.kind === "portable_bundle") {
    return candidate.project.project.title.slice(0, 120);
  }
  if (candidate?.kind === "documents") {
    const firstTitle = candidate.documents[0]?.title ?? "导入作品";
    const suffix =
      candidate.documents.length > 1 ? ` 等 ${String(candidate.documents.length)} 章` : "";
    return `${firstTitle}${suffix}`.slice(0, 120);
  }
  return "";
}

function ImportPreview({
  documentDrafts,
  onDocumentDraftChange,
  report,
}: {
  readonly documentDrafts: readonly ImportDocumentDraft[];
  readonly onDocumentDraftChange: (index: number, next: ImportDocumentDraft) => void;
  readonly report: ImportPreflightReport;
}) {
  const candidate = report.candidate;
  const [documentPage, setDocumentPage] = useState(0);
  const documentPageSize = 5;
  const documentCount = candidate?.kind === "documents" ? candidate.documents.length : 0;
  const documentPageCount = Math.max(1, Math.ceil(documentCount / documentPageSize));
  const normalizedDocumentPage = Math.min(documentPage, documentPageCount - 1);
  const firstDocumentIndex = normalizedDocumentPage * documentPageSize;

  return (
    <div className="import-preview" aria-live="polite">
      <InlineAlert
        tone={report.status === "ready" ? "info" : "error"}
        title={report.status === "ready" ? "预检通过，尚未写入项目" : "预检未通过"}
        description={`${formatLabels[report.format]} · ${String(report.summary.fileCount)} 个文件 · ${String(report.summary.chapterCount)} 个章节 · ${formatBytes(report.summary.totalBytes)}${report.summary.checksumVerified ? " · 校验和已验证" : ""}`}
      />

      {report.issues.length > 0 && (
        <ul className="import-issues" aria-label="预检提示">
          {report.issues.map((issue, index) => (
            <li key={`${issue.code}-${String(index)}`}>
              <Badge tone={issue.severity === "blocking" ? "danger" : "warning"}>
                {issue.severity === "blocking" ? "阻止导入" : "已安全处理"}
              </Badge>
              <span>
                {issue.fileName === undefined ? "" : `${issue.fileName}：`}
                {issueLabels[issue.code]}
              </span>
            </li>
          ))}
        </ul>
      )}

      {candidate?.kind === "documents" && (
        <div className="import-document-list">
          {candidate.documents
            .slice(firstDocumentIndex, firstDocumentIndex + documentPageSize)
            .map((document, pageIndex) => {
              const index = firstDocumentIndex + pageIndex;
              const draft = documentDrafts[index];
              if (draft === undefined) {
                return null;
              }
              return (
                <article key={document.suggestedPath} className="import-document">
                  <div className="card-heading-row">
                    <h4>章节 {String(index + 1)}</h4>
                    <Badge>{formatBytes(document.sanitizedBytes)}</Badge>
                  </div>
                  <p>{document.sourceName}</p>
                  {draft.requiresBoundaryReview && (
                    <>
                      <InlineAlert
                        tone="warning"
                        title="请确认此章节边界"
                        description="解析器未把此边界视为高置信度；标题和正文可在写入前修改。"
                      />
                      <label className="import-boundary-confirmation">
                        <input
                          type="checkbox"
                          checked={draft.boundaryConfirmed}
                          onChange={(event) =>
                            onDocumentDraftChange(index, {
                              ...draft,
                              boundaryConfirmed: event.currentTarget.checked,
                            })
                          }
                        />
                        我已检查此章节的标题、起止位置和正文
                      </label>
                    </>
                  )}
                  <FormField label="章节标题" required>
                    {(fieldProps) => (
                      <Input
                        {...fieldProps}
                        value={draft.title}
                        maxLength={200}
                        onChange={(event) =>
                          onDocumentDraftChange(index, {
                            ...draft,
                            title: event.currentTarget.value,
                          })
                        }
                      />
                    )}
                  </FormField>
                  <FormField
                    label="章节正文预览"
                    hint="这里只编辑待导入内容；确认前不会写入正式项目。提交时会再次移除外链与活动标记。"
                    required
                  >
                    {(fieldProps) => (
                      <Textarea
                        {...fieldProps}
                        rows={8}
                        value={draft.content}
                        maxLength={IMPORT_LIMITS.maximumChapterBytes}
                        currentLength={draft.content.length}
                        onChange={(event) =>
                          onDocumentDraftChange(index, {
                            ...draft,
                            content: event.currentTarget.value,
                          })
                        }
                      />
                    )}
                  </FormField>
                </article>
              );
            })}
          {documentPageCount > 1 && (
            <div className="import-preview-pagination">
              <Button
                variant="secondary"
                disabled={normalizedDocumentPage === 0}
                onClick={() => setDocumentPage((current) => Math.max(0, current - 1))}
              >
                上一组章节
              </Button>
              <span>
                第 {String(normalizedDocumentPage + 1)} / {String(documentPageCount)} 组
              </span>
              <Button
                variant="secondary"
                disabled={normalizedDocumentPage >= documentPageCount - 1}
                onClick={() =>
                  setDocumentPage((current) => Math.min(documentPageCount - 1, current + 1))
                }
              >
                下一组章节
              </Button>
            </div>
          )}
        </div>
      )}

      {candidate?.kind === "portable_bundle" && (
        <div className="import-document-list">
          <div className="card-heading-row">
            <h4>{candidate.project.project.title}</h4>
            <Badge tone="success">完整备份已验证</Badge>
          </div>
          <ol className="bundle-chapter-list">
            {candidate.project.chapters.slice(0, 8).map((chapter) => (
              <li key={chapter.id}>{chapter.title}</li>
            ))}
          </ol>
          {candidate.project.chapters.length > 8 && (
            <p className="maintenance-note">
              另有 {String(candidate.project.chapters.length - 8)} 个章节。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
