import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentStyles = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
const tokenStyles = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const desktopStyles = readFileSync(
  resolve(process.cwd(), "../../apps/desktop/src/styles.css"),
  "utf8",
);
const editorSource = readFileSync(
  resolve(process.cwd(), "../../apps/desktop/src/pages/editor-page.tsx"),
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

  it("matches the DESIGN v0.3.1b shared token contract", () => {
    expect(tokenStyles).toMatch(/--shell-bg:\s*#0e1116;/u);
    expect(tokenStyles).toMatch(/--shell-border:\s*#232a33;/u);
    expect(tokenStyles).toMatch(/--paper-bg:\s*#f7f4ee;/u);
    expect(tokenStyles).toMatch(/--paper-border:\s*#efeae2;/u);
    expect(tokenStyles).toMatch(/--accent-strong:\s*#4554c4;/u);
    expect(tokenStyles).toMatch(/--success:\s*#2f9e68;/u);
    expect(tokenStyles).toMatch(/--warning:\s*#d9781a;/u);
    expect(tokenStyles).toMatch(/--danger:\s*#b84040;/u);
    expect(tokenStyles).toMatch(/--sidebar-w-collapsed:\s*3\.25rem;/u);
    expect(tokenStyles).toMatch(/--btn-h-primary:\s*2\.75rem;/u);
    expect(tokenStyles).toMatch(/--btn-h-secondary:\s*2\.5rem;/u);
    expect(tokenStyles).toMatch(/--btn-h-inline:\s*1\.9375rem;/u);
    expect(tokenStyles).toMatch(/--editor-font-size:\s*1rem;/u);
    expect(tokenStyles).toMatch(/--editor-line-height:\s*1\.75;/u);
    expect(tokenStyles).toMatch(/--editor-content-max:\s*var\(--content-max\);/u);
    expect(tokenStyles).toMatch(/--content-max:\s*45rem;/u);
    expect(tokenStyles).toMatch(/--icon-stroke-width:\s*1\.75;/u);
    expect(componentStyles).toMatch(
      /\.ink-prose\s*\{[^}]*max-width:\s*var\(--editor-content-max\);[^}]*font-family:\s*var\(--font-body\);[^}]*font-size:\s*var\(--editor-font-size\);[^}]*line-height:\s*var\(--editor-line-height\);/su,
    );
  });

  it("keeps high-contrast status text helpers on both surfaces", () => {
    expect(tokenStyles).toMatch(
      /\[data-surface="dark"\]\s*\{[^}]*--success-text:\s*#48dfa9;[^}]*--warning-text:\s*#ffc35b;[^}]*--danger-text:\s*#ff7379;/su,
    );
    expect(tokenStyles).toMatch(
      /\[data-surface="light"\]\s*\{[^}]*--success-text:\s*#087a53;[^}]*--warning-text:\s*#8a5600;[^}]*--danger-text:\s*#b4232c;/su,
    );
    expect(componentStyles).toMatch(/@media\s*\(forced-colors:\s*active\)/u);
  });

  it("applies the icon stroke through currentColor and the shared 1.75 token", () => {
    expect(componentStyles).toMatch(
      /\.ink-icon\s*\{[^}]*color:\s*inherit;[^}]*stroke:\s*currentcolor;[^}]*stroke-width:\s*var\(--icon-stroke-width\);/su,
    );
    expect(componentStyles).toMatch(
      /\.ink-button__icon\s*>\s*svg,[^}]*stroke-width:\s*var\(--icon-stroke-width\);/su,
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

  it("keeps compact text links at the shared 44px pointer target", () => {
    expect(desktopStyles).toMatch(
      /\.desktop-topbar__ai-status\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*var\(--btn-h-primary\);[^}]*align-items:\s*center;/su,
    );
    expect(desktopStyles).toMatch(
      /\.start-page__secondary a\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*var\(--btn-h-primary\);[^}]*align-items:\s*center;/su,
    );
  });

  it("uses solid surfaces instead of gradients across shipped UI", () => {
    expect(desktopStyles).not.toMatch(/(?:linear|radial)-gradient\(/u);
    expect(componentStyles).not.toMatch(/(?:linear|radial)-gradient\(/u);
  });

  it("collapses global settings to the 680px single-column DESIGN layout at 1024px", () => {
    expect(desktopStyles).toMatch(
      /@media\s*\(max-width:\s*64rem\)\s*\{[^}]*\.settings-page > \.page-heading,[^}]*\.settings-page > \.settings-grid\s*\{[^}]*max-width:\s*42\.5rem;/su,
    );
    expect(desktopStyles).toMatch(
      /@media\s*\(max-width:\s*64rem\)\s*\{[\s\S]*?\.settings-grid,[\s\S]*?\.model-center-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/u,
    );
  });

  it("keeps the P43 editor, assistant, diff, context, error, and drawer surfaces token driven", () => {
    expect(editorSource).toMatch(
      /className=\{`writing-canvas[^`]*`\}[\s\S]*?data-surface=\{resolvedSurface\}/u,
    );
    expect(desktopStyles).toMatch(/\.writing-canvas\s*\{[^}]*background:\s*var\(--bg-surface\);/su);
    expect(desktopStyles).toMatch(
      /\.writing-textarea \.ink-textarea\s*\{[^}]*color:\s*var\(--text-primary\);[^}]*font-size:\s*var\(--editor-font-size/u,
    );
    expect(desktopStyles).toMatch(
      /\.candidate-panel\s*\{[^}]*overflow:\s*auto;[^}]*background:\s*var\(--bg-surface\);/su,
    );
    expect(desktopStyles).toMatch(
      /\.candidate-content pre\s*\{[^}]*background:\s*var\(--bg-sunken\);[^}]*color:\s*var\(--text-secondary\);/su,
    );
    expect(desktopStyles).toMatch(
      /\.candidate-diff-viewer__comparison section\s*\{[^}]*background:\s*var\(--bg-subtle\);/su,
    );
    expect(desktopStyles).toMatch(
      /\.context-sources__summary\s*\{[^}]*border:[^;]*var\(--accent-border\);[^}]*background:\s*var\(--accent-soft\);/su,
    );
    expect(desktopStyles).toMatch(
      /\.generation-error-card\s*\{[^}]*border:[^;]*var\(--danger-text\);[^}]*background:\s*var\(--danger-soft\);/su,
    );
    expect(desktopStyles).toMatch(
      /\.editor-assistant-backdrop\s*\{[^}]*background:\s*var\(--overlay-scrim\);/su,
    );
    expect(componentStyles).toMatch(
      /\.ink-overlay__panel\s*\{[^}]*background:\s*var\(--bg-overlay\);[^}]*color:\s*var\(--text-primary\);/su,
    );
  });

  it("keeps dark editor text, secondary copy, focus, and disabled states readable", () => {
    expect(contrastRatio("#e7eaf0", "#161b22")).toBeGreaterThanOrEqual(7);
    expect(contrastRatio("#9aa3b2", "#161b22")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#7180e6", "#161b22")).toBeGreaterThanOrEqual(4.5);
    expect(tokenStyles).toMatch(
      /\[data-surface="dark"\]\s*\{[^}]*--text-primary:\s*#e7eaf0;[^}]*--text-secondary:\s*#9aa3b2;[^}]*--text-disabled:\s*#697384;[^}]*--focus-ring:\s*#7180e6;[^}]*--selection:\s*rgb\(91 107 217 \/ 24%\);[^}]*--caret:\s*#7180e6;/su,
    );
    expect(componentStyles).toMatch(
      /\.ink-button--primary:disabled,[^}]*background:\s*var\(--bg-active\);[^}]*color:\s*var\(--text-secondary\);/su,
    );
    expect(componentStyles).toMatch(
      /\.ink-field-control\[data-disabled\]\s*\{[^}]*background:\s*var\(--bg-active\);[^}]*opacity:\s*1;/su,
    );
  });

  it("exposes visible caret, selection, editor focus, and reduced-motion contracts", () => {
    expect(componentStyles).toMatch(/\.ink-textarea\s*\{[^}]*caret-color:\s*var\(--caret\);/su);
    expect(tokenStyles).toMatch(/::selection\s*\{[^}]*background:\s*var\(--selection\);/su);
    expect(desktopStyles).toMatch(
      /\.writing-textarea \.ink-textarea:focus-visible\s*\{[^}]*outline:\s*0\.125rem solid var\(--focus-ring\);[^}]*outline-offset:\s*-0\.25rem;/su,
    );
    expect(tokenStyles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*scroll-behavior:\s*auto !important;[^}]*animation-duration:\s*1ms !important;[^}]*transition-duration:\s*1ms !important;/su,
    );
  });

  it("keeps logical typography and controls independent from display pixel density", () => {
    expect(tokenStyles).not.toMatch(/@media\s*\(min-resolution:/u);
    expect(componentStyles).not.toMatch(/@media\s*\(min-resolution:/u);
    expect(desktopStyles).not.toMatch(/@media\s*\(min-resolution:/u);
    expect(tokenStyles).toMatch(/--editor-font-size:\s*1rem;/u);
    expect(tokenStyles).toMatch(/--btn-h-primary:\s*2\.75rem;/u);
    expect(tokenStyles).toMatch(/--btn-h-secondary:\s*2\.5rem;/u);
  });
});

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = /^#(?<red>[\da-f]{2})(?<green>[\da-f]{2})(?<blue>[\da-f]{2})$/iu.exec(
    hex,
  )?.groups;
  if (channels === undefined) {
    throw new Error(`Invalid hex colour: ${hex}`);
  }
  return [channels.red, channels.green, channels.blue]
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
    )
    .reduce(
      (luminance, channel, index) => luminance + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
}
