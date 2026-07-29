export function chapterCandidateLocation(
  projectId: string,
  chapterId: string,
  candidateId: string,
): string {
  const query = new URLSearchParams({ candidate: candidateId });
  return `/projects/${projectId}/chapters/${chapterId}?${query.toString()}`;
}
