import { sanitizeFilename } from "@inkshadow/import-export/core";

import type { ProjectExportSnapshot } from "./project-export-snapshot";

export const PROJECT_REPORT_KINDS = [
  "characters",
  "world",
  "foreshadow",
  "timeline",
  "outline",
  "review",
  "ai_usage",
] as const;

export type ProjectReportKind = (typeof PROJECT_REPORT_KINDS)[number];

export interface ProjectReportArtifact {
  readonly fileName: string;
  readonly mediaType: "application/json";
  readonly content: string;
  readonly kind: ProjectReportKind;
  readonly recordCount: number;
}

const REPORT_FILE_LABELS: Readonly<Record<ProjectReportKind, string>> = Object.freeze({
  characters: "角色",
  world: "世界观",
  foreshadow: "伏笔",
  timeline: "时间线",
  outline: "大纲",
  review: "审阅报告",
  ai_usage: "AI用量报告",
});

export function createProjectReportArtifact(
  snapshot: ProjectExportSnapshot,
  kind: ProjectReportKind,
): ProjectReportArtifact {
  const selected = selectReportData(snapshot, kind);
  const payload = {
    format: "inkshadow_project_report",
    version: 1,
    kind,
    exportedAt: snapshot.exportedAt,
    project: {
      id: snapshot.project.id,
      title: snapshot.project.name,
      revision: snapshot.project.revision,
      updatedAt: snapshot.project.updatedAt,
    },
    count: selected.recordCount,
    data: selected.data,
  };
  return Object.freeze({
    fileName: sanitizeFilename(
      `${snapshot.project.name}-${REPORT_FILE_LABELS[kind]}`,
      ".json",
      `inkshadow-${kind}`,
    ),
    mediaType: "application/json",
    content: `${JSON.stringify(payload, null, 2)}\n`,
    kind,
    recordCount: selected.recordCount,
  });
}

function selectReportData(
  snapshot: ProjectExportSnapshot,
  kind: ProjectReportKind,
): Readonly<{ readonly data: unknown; readonly recordCount: number }> {
  if (kind === "outline") {
    return {
      data: snapshot.outline,
      recordCount: snapshot.outline?.nodes.length ?? 0,
    };
  }
  if (kind === "review") {
    return {
      data: snapshot.review,
      recordCount: snapshot.review.extraction.length + snapshot.review.consistency.length,
    };
  }
  if (kind === "ai_usage") {
    return {
      data: snapshot.aiUsage,
      recordCount: snapshot.aiUsage.length,
    };
  }

  const recordKind =
    kind === "characters"
      ? "character"
      : kind === "world"
        ? "world_rule"
        : kind === "foreshadow"
          ? "foreshadow"
          : "timeline_event";
  const records = snapshot.formalRecords.filter((record) => record.kind === recordKind);
  return {
    data: records,
    recordCount: records.length,
  };
}
