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
  "src/components/data-transfer-panel.tsx",
  "apps/desktop/src/components/data-transfer-panel.tsx",
);

function rule(selector: RegExp): string | undefined {
  return selector.exec(styles)?.groups?.body;
}

describe("data transfer responsive layout contract", () => {
  it("allows the heading, content, and action labels to reflow without horizontal clipping", () => {
    expect(panel).toContain('className="card-heading-row data-transfer-heading"');
    expect(rule(/\.data-transfer-heading\s*\{(?<body>[^}]*)\}/u)).toMatch(/flex-wrap:\s*wrap;/u);
    expect(rule(/\.data-transfer-heading\s*>\s*div\s*\{(?<body>[^}]*)\}/u)).toMatch(
      /min-width:\s*0;/u,
    );
    expect(rule(/\.data-transfer-section \.ink-button__label\s*\{(?<body>[^}]*)\}/u)).toMatch(
      /overflow-wrap:\s*anywhere;/u,
    );
  });

  it("uses a single shrinking column and full-width actions at narrow or high-zoom layouts", () => {
    expect(styles).toMatch(
      /@media \(max-width:\s*64rem\)[\s\S]*?\.data-transfer-grid[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*44\.9375rem\)[\s\S]*?\.data-transfer-section \.settings-actions[\s\S]*?flex-direction:\s*column;/u,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*44\.9375rem\)[\s\S]*?\.data-transfer-section \.settings-actions\s*>\s*:is\(button, a\)[\s\S]*?width:\s*100%;/u,
    );
  });
});
