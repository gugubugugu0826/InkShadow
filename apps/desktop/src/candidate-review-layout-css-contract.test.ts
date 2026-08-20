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

const desktopStyles = [
  readWorkspaceFile("src/styles.css", "apps/desktop/src/styles.css"),
  readWorkspaceFile(
    "src/components/candidate-decision.css",
    "apps/desktop/src/components/candidate-decision.css",
  ),
].join("\n");
const uiStyles = readWorkspaceFile(
  "../../packages/ui/src/styles/components.css",
  "packages/ui/src/styles/components.css",
);

function rule(styles: string, selector: RegExp): string | undefined {
  return selector.exec(styles)?.groups?.body;
}

describe("Candidate review layout CSS contract", () => {
  it("keeps the header and footer fixed around one bounded main scroller", () => {
    const panelRule = rule(uiStyles, /\.ink-overlay__panel\s*\{(?<body>[^}]*)\}/u);
    const contentRule = rule(uiStyles, /\.ink-overlay__content\s*\{(?<body>[^}]*)\}/u);
    const candidatePanelRule = rule(
      desktopStyles,
      /\.candidate-review-overlay\s*\{(?<body>[^}]*)\}/u,
    );
    const reviewBodyRule = rule(desktopStyles, /\.candidate-review-dialog\s*\{(?<body>[^}]*)\}/u);

    expect(panelRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/u);
    expect(panelRule).toMatch(/overflow:\s*hidden;/u);
    expect(contentRule).toMatch(/overflow-y:\s*auto;/u);
    expect(candidatePanelRule).toMatch(/width:\s*min\(72rem,/u);
    expect(candidatePanelRule).toMatch(/height:\s*min\(52rem,/u);
    expect(reviewBodyRule).toMatch(/min-height:\s*0;/u);
    expect(reviewBodyRule).toMatch(/min-width:\s*0;/u);
  });

  it("does not create a scrollbar for each conflict or diff preview", () => {
    const conflictPreviewRule = rule(
      desktopStyles,
      /\.candidate-review-dialog__three-way pre\s*\{(?<body>[^}]*)\}/u,
    );
    const diffPreviewRule = rule(
      desktopStyles,
      /\.candidate-diff-viewer__comparison pre\s*\{(?<body>[^}]*)\}/u,
    );
    const editorRule = rule(
      desktopStyles,
      /\.candidate-review-dialog__editor \.ink-textarea\s*\{(?<body>[^}]*)\}/u,
    );

    expect(conflictPreviewRule).not.toMatch(/overflow|max-height/u);
    expect(diffPreviewRule).not.toMatch(/overflow|max-height/u);
    expect(editorRule).toMatch(/overflow-y:\s*auto;/u);
    expect(editorRule).toMatch(/resize:\s*none;/u);
  });

  it("retains a 44px primary decision target", () => {
    const largeButtonRule = rule(uiStyles, /\.ink-button--lg\s*\{(?<body>[^}]*)\}/u);
    expect(largeButtonRule).toMatch(/height:\s*var\(--control-lg\);/u);
  });

  it("gives every inline Candidate decision surface one keyboard-focusable main scroller", () => {
    const surfaceRule = rule(desktopStyles, /\.candidate-decision-surface\s*\{(?<body>[^}]*)\}/u);
    const contentRule = rule(
      desktopStyles,
      /\.candidate-decision-surface\s*>\s*\.ink-card__content\s*\{(?<body>[^}]*)\}/u,
    );
    const footerRule = rule(
      desktopStyles,
      /\.candidate-decision-surface\s*>\s*\.ink-card__footer\s*\{(?<body>[^}]*)\}/u,
    );
    const textareaRule = rule(
      desktopStyles,
      /\.candidate-decision-surface \.ink-textarea\s*\{(?<body>[^}]*)\}/u,
    );

    expect(surfaceRule).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/u);
    expect(surfaceRule).not.toMatch(/overflow:\s*hidden;/u);
    expect(contentRule).toMatch(/min-width:\s*0;/u);
    expect(contentRule).toMatch(/min-height:\s*0;/u);
    expect(contentRule).toMatch(/overflow-y:\s*auto;/u);
    expect(footerRule).toMatch(/border-top:/u);
    expect(textareaRule).toMatch(/overflow-y:\s*visible;/u);
    expect(textareaRule).toMatch(/resize:\s*none;/u);
  });
});
