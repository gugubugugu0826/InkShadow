import type { AcceptedChapterPipelineInput } from "./accepted-chapter-pipeline";
import { organizeCurrentSavedVersionStoryFacts } from "./direct-story-fact-organizer";
import type { DesktopRuntime } from "./runtime";

type DirectFactPreflightRuntime = Pick<
  DesktopRuntime,
  "clock" | "hasher" | "repositories" | "story"
>;

/**
 * Keeps every accepted-version execution path on the same local fact boundary.
 * Professional mode leaves its existing review workflow untouched.
 */
export async function ensureCurrentSavedVersionStoryFactsForDirectMode(
  runtime: DirectFactPreflightRuntime,
  input: AcceptedChapterPipelineInput,
): Promise<void> {
  if (input.organizeLocalStoryFacts !== true) return;
  await organizeCurrentSavedVersionStoryFacts(
    {
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      hasher: runtime.hasher,
      now: () => runtime.clock.now(),
    },
    input,
  );
}
