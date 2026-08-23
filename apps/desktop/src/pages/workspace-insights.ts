import type { AiCandidate } from "@inkshadow/domain";

export interface WorkspaceInsights {
  readonly todayNetCharacters: number;
  readonly currentStreakDays: number;
  readonly readyCandidateCount: number;
}

export interface WorkspaceVersionMetric {
  readonly chapterId: string;
  readonly contentLength: number;
  readonly createdAt: string;
}

export function countReadyProseCandidates(
  candidates: readonly Pick<AiCandidate, "purpose" | "status">[],
): number {
  return candidates.filter(
    (candidate) => candidate.purpose === "prose" && candidate.status === "ready",
  ).length;
}

export function calculateWorkspaceInsights(
  versions: readonly WorkspaceVersionMetric[],
  readyCandidateCount: number,
  now = new Date(),
): WorkspaceInsights {
  const startToday = startOfLocalDay(now);
  const startTomorrow = new Date(startToday);
  startTomorrow.setDate(startTomorrow.getDate() + 1);
  const versionsByChapter = new Map<string, WorkspaceVersionMetric[]>();
  const activityDays = new Set<string>();

  for (const version of versions) {
    const createdAt = new Date(version.createdAt);
    if (!Number.isFinite(createdAt.getTime())) continue;
    activityDays.add(localDayKey(createdAt));
    const chapterVersions = versionsByChapter.get(version.chapterId) ?? [];
    chapterVersions.push(version);
    versionsByChapter.set(version.chapterId, chapterVersions);
  }

  let todayNetCharacters = 0;
  for (const chapterVersions of versionsByChapter.values()) {
    const ordered = [...chapterVersions].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
    const beforeToday = ordered.filter(
      ({ createdAt }) => new Date(createdAt).getTime() < startToday.getTime(),
    );
    const today = ordered.filter(({ createdAt }) => {
      const timestamp = new Date(createdAt).getTime();
      return timestamp >= startToday.getTime() && timestamp < startTomorrow.getTime();
    });
    const latestToday = today.at(-1);
    if (latestToday !== undefined) {
      todayNetCharacters += latestToday.contentLength - (beforeToday.at(-1)?.contentLength ?? 0);
    }
  }

  const yesterday = new Date(startToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const cursor = activityDays.has(localDayKey(startToday))
    ? new Date(startToday)
    : activityDays.has(localDayKey(yesterday))
      ? yesterday
      : null;
  let currentStreakDays = 0;
  while (cursor !== null && activityDays.has(localDayKey(cursor))) {
    currentStreakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return Object.freeze({
    todayNetCharacters,
    currentStreakDays,
    readyCandidateCount,
  });
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function localDayKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}
