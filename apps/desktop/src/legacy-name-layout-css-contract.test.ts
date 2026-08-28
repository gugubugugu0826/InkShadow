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
const projectsPage = readWorkspaceFile(
  "src/pages/projects-page.tsx",
  "apps/desktop/src/pages/projects-page.tsx",
);
const workspacePage = readWorkspaceFile(
  "src/pages/workspace-page.tsx",
  "apps/desktop/src/pages/workspace-page.tsx",
);

describe("legacy project and chapter name layout contract", () => {
  it("keeps the original value while bounding unusually long visible headings", () => {
    expect(projectsPage).toMatch(
      /<CardTitle[\s\S]*?className="project-library-page__project-title"[\s\S]*?headingLevel=\{2\}[\s\S]*?title=\{project\.name\}/u,
    );
    expect(workspacePage).toMatch(
      /<CardTitle[\s\S]*?className="workspace-page__chapter-title"[\s\S]*?title=\{chapter\.title\}/u,
    );
    expect(styles).toMatch(
      /\.project-library-page__project-title,[\s\S]*?\.workspace-page__chapter-title\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*-webkit-line-clamp:\s*3;/u,
    );
  });
});
