import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRelativeStyles = resolve(process.cwd(), "src/styles.css");
const desktopStyles = readFileSync(
  existsSync(packageRelativeStyles)
    ? packageRelativeStyles
    : resolve(process.cwd(), "apps/desktop/src/styles.css"),
  "utf8",
);

describe("editor layout CSS contract", () => {
  it("keeps the padded editor page inside its element boundary", () => {
    const editorPageRule = /\.editor-page\s*\{(?<body>[^}]*)\}/u.exec(desktopStyles)?.groups?.body;

    expect(editorPageRule).toBeDefined();
    expect(editorPageRule).toMatch(/box-sizing:\s*border-box;/u);
    expect(editorPageRule).toMatch(/width:\s*100%;/u);
    expect(editorPageRule).toMatch(/overflow:\s*hidden;/u);
  });

  it("defines responsive assistant width defaults before runtime resizing overrides them", () => {
    const workspaceRule = /\.editor-workspace\s*\{(?<body>[^}]*)\}/u.exec(desktopStyles)?.groups
      ?.body;
    const compactDesktopRule =
      /@media\s*\(max-width:\s*80rem\)\s*and\s*\(min-width:\s*64\.0625rem\)\s*\{\s*\.editor-workspace\s*\{(?<body>[^}]*)\}/u.exec(
        desktopStyles,
      )?.groups?.body;

    expect(workspaceRule).toMatch(
      /--editor-assistant-width:\s*clamp\(20rem,\s*24vw,\s*22\.5rem\);/u,
    );
    expect(compactDesktopRule).toMatch(/--editor-assistant-width:\s*18rem;/u);
  });

  it("lets compact assistant drawer top and bottom constraints own its height", () => {
    const assistantPanelRule =
      /\.candidate-panel--chapters,\s*\.candidate-panel--assistant\s*\{(?<body>[^}]*)\}/u.exec(
        desktopStyles,
      )?.groups?.body;
    const assistantOverlayMatch = /\.candidate-panel--assistant-overlay\s*\{(?<body>[^}]*)\}/u.exec(
      desktopStyles,
    );
    const assistantOverlayRule = assistantOverlayMatch?.groups?.body;

    expect(assistantPanelRule).toMatch(/height:\s*100%;/u);
    expect(assistantOverlayRule).toBeDefined();
    expect(assistantOverlayRule).toMatch(/top:\s*var\(--topbar-height\);/u);
    expect(assistantOverlayRule).toMatch(/bottom:\s*var\(--statusbar-height\);/u);
    expect(assistantOverlayRule).toMatch(/height:\s*auto;/u);
    expect(assistantOverlayMatch?.index ?? -1).toBeGreaterThan(
      desktopStyles.indexOf(".candidate-panel--chapters"),
    );
  });

  it("keeps direct assistant actions at the touch target height inside the scrollable drawer", () => {
    const assistantActionRule =
      /\.candidate-panel--assistant\s*>\s*\.ink-button\s*\{(?<body>[^}]*)\}/u.exec(desktopStyles)
        ?.groups?.body;

    expect(assistantActionRule).toBeDefined();
    expect(assistantActionRule).toMatch(/min-height:\s*var\(--control-lg\);/u);
    expect(assistantActionRule).toMatch(/flex-shrink:\s*0;/u);
  });
});
