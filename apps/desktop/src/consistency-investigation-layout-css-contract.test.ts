import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readWorkspaceFile(packagePath: string, workspacePath: string): string {
  const packageRelative = resolve(process.cwd(), packagePath);
  return readFileSync(
    existsSync(packageRelative) ? packageRelative : resolve(process.cwd(), workspacePath),
    "utf8",
  );
}

const styles = readWorkspaceFile("src/styles.css", "apps/desktop/src/styles.css");
const panel = readWorkspaceFile(
  "src/components/consistency-investigation-panel.tsx",
  "apps/desktop/src/components/consistency-investigation-panel.tsx",
);

describe("consistency investigation task graph layout contract", () => {
  it("gives multi-step task summaries a dedicated readable rhythm", () => {
    expect(panel).toContain(
      'className="chapter-check-history consistency-investigation-task-graph"',
    );
    expect(styles).toMatch(
      /\.consistency-investigation-task-graph\s*\{[^}]*gap:\s*var\(--space-3\);/u,
    );
    expect(styles).toMatch(
      /\.consistency-investigation-task-graph\s+li\s*\{[^}]*line-height:\s*1\.65;/u,
    );
  });
});
