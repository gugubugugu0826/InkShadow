import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentStyles = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
const tokenStyles = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const desktopStyles = readFileSync(
  resolve(process.cwd(), "../../apps/desktop/src/styles.css"),
  "utf8",
);

describe("layout style contracts", () => {
  it("constrains AppShell to the viewport and keeps main as the scroll container", () => {
    expect(componentStyles).toMatch(
      /\.ink-app-shell\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su,
    );
    expect(componentStyles).toMatch(
      /\.ink-app-shell__main\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/su,
    );
  });

  it("does not dim disabled primary button text with inherited opacity", () => {
    expect(componentStyles).toMatch(/\.ink-button:disabled\s*\{[^}]*opacity:\s*1;/su);
    expect(componentStyles).toMatch(
      /\.ink-button--primary:disabled,[^}]*background:\s*var\(--bg-active\);[^}]*color:\s*var\(--text-secondary\);/su,
    );
  });

  it("uses explicit light and dark token palettes without forcing either on the root", () => {
    expect(tokenStyles).toMatch(
      /\[data-surface="dark"\]\s*\{[^}]*color-scheme:\s*dark;[^}]*--bg-app:\s*#0e1116;/su,
    );
    expect(tokenStyles).toMatch(
      /:root:not\(\[data-surface\]\),\s*\[data-surface="light"\]\s*\{[^}]*color-scheme:\s*light;[^}]*--bg-app:\s*#f7f4ee;/su,
    );
    expect(tokenStyles).not.toMatch(
      /:root\s*,\s*\[data-surface="dark"\]\s*\{[^}]*color-scheme:\s*dark;/su,
    );
  });

  it("lets an unconfigured root follow the system dark appearance", () => {
    expect(tokenStyles).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-surface\]\)\s*\{[^}]*color-scheme:\s*dark;[^}]*--bg-app:\s*#0e1116;/su,
    );
  });

  it("defines every custom property referenced by shipped application styles", () => {
    const shippedStyles = [tokenStyles, componentStyles, desktopStyles].join("\n");
    const definitions = new Set(
      [...shippedStyles.matchAll(/(--[a-zA-Z0-9-]+)\s*:/gu)].map((match) => match[1]),
    );
    const references = new Set(
      [...shippedStyles.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/gu)].map((match) => match[1]),
    );
    const missing = [...references].filter((reference) => !definitions.has(reference)).sort();

    expect(missing).toEqual([]);
  });

  it("gives standalone routes one viewport scroll container without changing AppShell scrolling", () => {
    expect(desktopStyles).toMatch(/body\s*\{[^}]*overflow:\s*hidden;/su);
    expect(desktopStyles).toMatch(
      /#root\s*>\s*:is\([^)]*\.start-page[^)]*\.cloud-login-page[^)]*\.desktop-page[^)]*\)\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su,
    );
    expect(componentStyles).toMatch(
      /\.ink-app-shell__main\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/su,
    );
  });
});
