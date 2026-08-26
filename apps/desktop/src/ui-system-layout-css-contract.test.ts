import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const inDesktopPackage = process.cwd().replaceAll("\\", "/").endsWith("/apps/desktop");
const css = [
  "styles.css",
  "pages/idea-journey-page.css",
  "pages/settings-page.css",
  "pages/start-page.css",
]
  .map((path) =>
    readFileSync(
      resolve(process.cwd(), inDesktopPackage ? "src/" + path : "apps/desktop/src/" + path),
      "utf8",
    ),
  )
  .join("\n");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^$()|[\]\\{}]/gu, "\\$&");
  const declarations = [...css.matchAll(new RegExp(escaped + "\\s*\\{([^}]*)\\}", "gu"))]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  if (declarations.length === 0) {
    throw new Error("没有找到布局规则：" + selector);
  }
  return declarations.join("\n");
}

describe("ordinary UI layout contracts", () => {
  it("keeps the quick connection drawer and every footer action inside equal padding", () => {
    const drawer = rule(".quick-ai-drawer");
    const content = rule(".quick-ai-drawer__content");
    const footer = rule(".quick-ai-drawer__footer");
    const footerButton = rule(".quick-ai-drawer__footer .ink-button");

    expect(drawer).toMatch(/box-sizing:\s*border-box/u);
    expect(drawer).toMatch(/max-width:\s*100%/u);
    expect(content).toMatch(/min-width:\s*0/u);
    expect(footer).toMatch(/width:\s*100%/u);
    expect(footer).toMatch(/min-width:\s*0/u);
    expect(footer).toMatch(/flex-wrap:\s*wrap/u);
    expect(footerButton).toMatch(/min-width:\s*0/u);
    expect(footerButton).toMatch(/flex:\s*1\s+1/u);
  });

  it("does not draw an interaction focus box around a programmatically focused page title", () => {
    const routeTitle = rule('.start-page h1[tabindex="-1"]');
    expect(routeTitle).toMatch(/outline:\s*none/u);
  });

  it("keeps the idea landing card width inside its parent at narrow widths", () => {
    const card = rule(".idea-journey__idea-card");
    expect(card).toMatch(/box-sizing:\s*border-box/u);
    expect(card).toMatch(/min-width:\s*0/u);
  });

  it("keeps the frequent-provider badge at its content width", () => {
    const badge = rule(".quick-ai-drawer__provider > .ink-badge");
    expect(badge).toMatch(/width:\s*fit-content/u);
    expect(badge).toMatch(/flex:\s*0\s+0\s+auto/u);
  });

  it("uses one aligned card column for ordinary settings", () => {
    const grid = rule(".settings-page--global .settings-grid");
    const sectionNavigation = rule(".settings-section-nav");
    const constrainedLayout = rule(
      ".settings-page--global > .page-heading,\n  " +
        ".settings-page--global > .settings-section-nav,\n  " +
        ".settings-page--global > .settings-grid",
    );
    expect(grid).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    expect(grid).toMatch(/width:\s*100%/u);
    expect(sectionNavigation).toMatch(/box-sizing:\s*border-box/u);
    expect(constrainedLayout).toMatch(/max-width:\s*42\.5rem/u);
  });
});
