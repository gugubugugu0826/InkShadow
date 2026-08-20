import { EmptyState, ErrorState } from "@inkshadow/ui";
import { parseUuidV7, type UuidV7 } from "@inkshadow/domain";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { downloadBrowserExportArtifact } from "../infrastructure/export-artifact-download";
import type { GovernedCreativeExtensionSource } from "../infrastructure/governed-creative-extensions-runtime";
import { useRuntime } from "../runtime-context";
import { GovernedCreativeExtensionsPage } from "./governed-creative-extensions-page";

type SourceState =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "ready"; source: GovernedCreativeExtensionSource }>;

export function GovernedCreativeExtensionsRoutePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string; chapterId: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");
  const chapterId = parseUuidV7(params.chapterId ?? "");
  const projectIdValue = projectId.ok ? projectId.value : null;
  const chapterIdValue = chapterId.ok ? chapterId.value : null;
  const [source, setSource] = useState<SourceState>({ state: "loading" });

  useEffect(() => {
    let active = true;
    if (projectIdValue === null || chapterIdValue === null) {
      const timer = window.setTimeout(() => {
        if (active) {
          setSource({ state: "failed" });
        }
      }, 0);
      return () => {
        active = false;
        window.clearTimeout(timer);
      };
    }

    const timer = window.setTimeout(() => {
      void loadSource(runtime, projectIdValue, chapterIdValue)
        .then((loaded) => {
          if (active) {
            setSource(loaded);
          }
        })
        .catch(() => {
          if (active) {
            setSource({ state: "failed" });
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [chapterIdValue, projectIdValue, runtime]);

  if (projectIdValue === null || chapterIdValue === null || source.state === "failed") {
    return (
      <div className="desktop-page">
        <ErrorState
          headingLevel={1}
          title="无法打开创作扩展"
          description="项目、章节或当前权威版本无效。请返回项目列表并重新选择仍存在的章节。"
          primaryAction={{ label: "返回项目列表", onClick: () => void navigate("/projects") }}
        />
      </div>
    );
  }
  if (runtime.governedCreativeExtensions === null) {
    return (
      <div className="desktop-page">
        <EmptyState
          headingLevel={1}
          kind="feature_limited"
          title="创作扩展仅在桌面安全运行时可用"
          description="浏览器开发模式不会伪装桌面数据库审计、预算或本机模型出口。"
          primaryAction={{ label: "返回项目列表", onClick: () => void navigate("/projects") }}
        />
      </div>
    );
  }
  if (source.state === "loading") {
    return (
      <div className="desktop-page">
        <p role="status">正在校验章节来源版本…</p>
      </div>
    );
  }
  if (source.state === "missing") {
    return (
      <div className="desktop-page">
        <EmptyState
          headingLevel={1}
          kind="no_data"
          title="章节来源不存在"
          description="请返回项目并选择一个仍存在的章节。"
          primaryAction={{ label: "返回项目列表", onClick: () => void navigate("/projects") }}
        />
      </div>
    );
  }

  return (
    <GovernedCreativeExtensionsPage
      runtime={runtime.governedCreativeExtensions}
      projectId={projectIdValue}
      source={source.source}
      onExportHistory={(filename, content) => {
        downloadBrowserExportArtifact({
          fileName: filename,
          mediaType: "application/json",
          content,
        });
      }}
    />
  );
}

async function loadSource(
  runtime: ReturnType<typeof useRuntime>,
  projectId: UuidV7,
  chapterId: UuidV7,
): Promise<SourceState> {
  const [projectResult, chapterResult] = await Promise.all([
    runtime.repositories.projects.findById(projectId),
    runtime.repositories.chapters.findById(chapterId),
  ]);
  if (!projectResult.ok || !chapterResult.ok) {
    return { state: "failed" };
  }
  const project = projectResult.value;
  const chapter = chapterResult.value;
  if (project === null || chapter === null) {
    return { state: "missing" };
  }
  if (chapter.projectId !== project.id) {
    return { state: "failed" };
  }

  const versionResult = await runtime.repositories.chapterVersions.findVersionById(
    chapter.currentVersionId,
  );
  if (!versionResult.ok) {
    return { state: "failed" };
  }
  const version = versionResult.value;
  if (version === null) {
    return { state: "missing" };
  }
  const snapshot = version.toSnapshot();
  if (
    snapshot.projectId !== project.id ||
    snapshot.chapterId !== chapter.id ||
    snapshot.id !== chapter.currentVersionId
  ) {
    return { state: "failed" };
  }
  return {
    state: "ready",
    source: Object.freeze({
      projectId: project.id,
      chapterId: chapter.id,
      sourceVersionId: snapshot.id,
      sourceChecksum: snapshot.contentChecksum,
      chapterTitle: chapter.title,
      sourceText: snapshot.content,
    }),
  };
}
