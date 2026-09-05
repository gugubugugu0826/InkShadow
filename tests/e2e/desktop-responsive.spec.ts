import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  expectDirectModeUsesPlainLanguage,
  expectFreshInstallDirectMode,
} from "./support/writing-experience";

const DESKTOP_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
] as const;

test("keeps the creative home reachable without horizontal overflow at every desktop target", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORTS[0]);
  await page.goto("/#/start");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expectFreshInstallDirectMode(page);

  for (const viewport of DESKTOP_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/#/start");

    await expect(page.getByRole("heading", { level: 1, name: "开始写你的故事" })).toBeVisible();
    await expect(page.getByRole("link", { name: "开始创作", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "浏览作品库", exact: true })).toBeVisible();
    await expectDirectModeUsesPlainLanguage(page);
    await expectNoHorizontalPageOverflow(page);
    await expectSemanticBasics(page);
    await expect(page.locator("main")).toHaveCSS("overflow-y", "auto");
  }
});

test("uses the 680px single-column settings layout at 1024 by 640", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto("/#/start");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expectFreshInstallDirectMode(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();

  const layout = await page.locator(".settings-page > .settings-grid").evaluate((grid) => {
    const children = [...grid.children].slice(0, 2).map((child) => child.getBoundingClientRect());
    const bounds = grid.getBoundingClientRect();
    return {
      width: bounds.width,
      columns: getComputedStyle(grid).gridTemplateColumns,
      firstX: children[0]?.x ?? null,
      secondX: children[1]?.x ?? null,
      firstY: children[0]?.y ?? null,
      secondY: children[1]?.y ?? null,
    };
  });

  expect(layout.width).toBeLessThanOrEqual(680);
  expect(layout.columns.trim().split(/\s+/u)).toHaveLength(1);
  expect(layout.firstX).toBe(layout.secondX);
  expect(layout.secondY ?? 0).toBeGreaterThan(layout.firstY ?? 0);
  await expectMinimumTarget(page.getByRole("combobox", { name: "外观模式" }));
  await expectDirectModeUsesPlainLanguage(page);
  await expectNoHorizontalPageOverflow(page);
  await expectSemanticBasics(page);
  await expect(page.locator("main")).toHaveCSS("overflow-y", "auto");
});

test("keeps the 800 by 600 writing path visible and pointer targets usable", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/#/start");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expectFreshInstallDirectMode(page);

  await expectMinimumTarget(page.getByRole("link", { name: "开始创作", exact: true }));
  await expectMinimumTarget(page.getByRole("link", { name: "浏览作品库" }));
  await page.getByRole("link", { name: "开始创作", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "一句话就够了" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "一句话" })).toBeVisible();
  await expectMinimumTarget(page.getByRole("button", { name: "开始创作", exact: true }));
  await expectMinimumTarget(page.getByRole("button", { name: "直接写空白正文" }));
  await expectDirectModeUsesPlainLanguage(page);
  await expectNoHorizontalPageOverflow(page);

  await page.getByRole("button", { name: "直接写空白正文" }).click();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toBeVisible();
  await expect(page.getByText("共 0 字", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toHaveAttribute(
    "maxlength",
    "5000000",
  );
  await expectDirectModeUsesPlainLanguage(page);
  await expectNoHorizontalPageOverflow(page);
  await expectSemanticBasics(page);
  await expect(page.locator("main")).toHaveCSS("overflow-y", "auto");

  const assistantTrigger = page.getByRole("button", { name: "创作助手", exact: true });
  await assistantTrigger.click();
  const assistant = page.getByRole("dialog", { name: "创作助手" });
  await expect(assistant).toBeVisible();
  await expectDirectModeUsesPlainLanguage(page);
  await expect(page.locator(".writing-canvas")).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      assistant.evaluate(
        (panel) => document.activeElement === panel || panel.contains(document.activeElement),
      ),
    )
    .toBe(true);

  const assistantControls = assistant.locator(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const assistantControlCount = await assistantControls.count();
  expect(assistantControlCount).toBeGreaterThan(1);
  await assistantControls.nth(assistantControlCount - 1).focus();
  await page.keyboard.press("Tab");
  await expect(assistantControls.first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(assistant).toBeHidden();
  await expect(assistantTrigger).toBeFocused();
  await expect(page.locator(".writing-canvas")).not.toHaveAttribute("aria-hidden", "true");
});

test("keeps logical sizing stable on a Retina-like DPR2 display", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto("http://127.0.0.1:1420/#/start");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expectFreshInstallDirectMode(page);
    await expect(page.getByRole("heading", { level: 1, name: "开始写你的故事" })).toBeVisible();
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    await expectMinimumTarget(page.getByRole("link", { name: "开始创作", exact: true }));
    await expectNoHorizontalPageOverflow(page);

    await page.getByRole("link", { name: "开始创作", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "一句话" })).toBeVisible();
    await page.getByRole("button", { name: "直接写空白正文" }).click();
    const editor = page.getByRole("textbox", { name: "章节正文" });
    const writingCanvas = page.locator(".writing-canvas");
    await expect(editor).toBeVisible();
    await expect(writingCanvas).toHaveAttribute("data-surface", "dark");

    const primaryAction = page.locator(
      ".editor-toolbar__actions .ink-button--primary, .editor-toolbar__actions .ink-button--ai-primary",
    );
    await expect(primaryAction).toBeVisible();
    await expectMinimumTarget(primaryAction);
    await page.locator("summary", { hasText: "写作工具与排版" }).focus();
    await page.keyboard.press("Tab");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveCSS("outline-color", "rgb(113, 128, 230)");
    await expect(editor).toHaveCSS("outline-style", "solid");
    await expect(editor).toHaveCSS("outline-width", "2px");
    const appearance = await editor.evaluate((textarea) => {
      const canvas = textarea.closest(".writing-canvas");
      if (!(canvas instanceof HTMLElement)) {
        throw new Error("Writing canvas is missing");
      }
      const canvasStyle = getComputedStyle(canvas);
      const editorStyle = getComputedStyle(textarea);
      const action = document.querySelector<HTMLElement>(
        ".editor-toolbar__actions .ink-button--primary, .editor-toolbar__actions .ink-button--ai-primary",
      );
      const actionStyle = action === null ? null : getComputedStyle(action);
      const selectionProbe = document.createElement("span");
      selectionProbe.style.backgroundColor = canvasStyle.getPropertyValue("--selection");
      canvas.append(selectionProbe);
      const selectionColor = getComputedStyle(selectionProbe).backgroundColor;
      selectionProbe.remove();
      return {
        canvasBackground: canvasStyle.backgroundColor,
        canvasBorder: canvasStyle.borderColor,
        editorColor: editorStyle.color,
        editorCaret: editorStyle.caretColor,
        editorFontSize: editorStyle.fontSize,
        selectionColor,
        actionHeight: actionStyle?.height ?? "",
        actionTransitionDuration: actionStyle?.transitionDuration ?? "",
      };
    });

    expect(appearance).toEqual({
      canvasBackground: "rgb(22, 27, 34)",
      canvasBorder: "rgb(35, 42, 51)",
      editorColor: "rgb(231, 234, 240)",
      editorCaret: "rgb(113, 128, 230)",
      editorFontSize: "16px",
      selectionColor: "rgba(91, 107, 217, 0.24)",
      actionHeight: "48px",
      actionTransitionDuration: expect.any(String),
    });
    for (const duration of appearance.actionTransitionDuration.split(",")) {
      expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
    }

    await page.getByRole("button", { name: "创作助手", exact: true }).click();
    const assistant = page.getByRole("dialog", { name: "创作助手" });
    await expect(assistant).toBeVisible();
    await expectDirectModeUsesPlainLanguage(page);
    await expect(assistant).toHaveCSS("background-color", "rgb(22, 27, 34)");
    await expect(assistant).toHaveCSS("border-color", "rgb(35, 42, 51)");
    await page.keyboard.press("Escape");

    await expectNoHorizontalPageOverflow(page);
    await expectMainCanScroll(page);
    await expectSemanticBasics(page);
  } finally {
    await context.close();
  }
});

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainClientWidth: document.querySelector("main")?.clientWidth ?? 0,
    mainScrollWidth: document.querySelector("main")?.scrollWidth ?? 0,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.mainScrollWidth).toBeLessThanOrEqual(dimensions.mainClientWidth + 1);
}

async function expectMinimumTarget(locator: Locator, minimum = 44): Promise<void> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectMainCanScroll(page: Page): Promise<void> {
  const scrollState = await page.locator("main").evaluate((main) => {
    main.scrollTop = main.scrollHeight;
    return {
      clientHeight: main.clientHeight,
      scrollHeight: main.scrollHeight,
      scrollTop: main.scrollTop,
    };
  });
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.scrollTop).toBeGreaterThan(0);
}

async function expectSemanticBasics(page: Page): Promise<void> {
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("h1:visible")).toHaveCount(1);

  const audit = await page.evaluate(() => {
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const label = (element: HTMLElement): string => {
      const labelledBy = element
        .getAttribute("aria-labelledby")
        ?.split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ");
      const labels =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? [...element.labels].map((item) => item.textContent?.trim() ?? "").join(" ")
          : "";
      return (
        [
          element.getAttribute("aria-label"),
          labelledBy,
          labels,
          element.textContent,
          element.getAttribute("title"),
        ]
          .map((value) => value?.trim() ?? "")
          .find((value) => value.length > 0) ?? ""
      );
    };
    const unnamedControls = [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"]',
      ),
    ]
      .filter(visible)
      .filter((element) => label(element).length === 0)
      .map((element) => element.outerHTML.slice(0, 180));
    const ids = [...document.querySelectorAll<HTMLElement>("[id]")]
      .map((element) => element.id)
      .filter((id) => id.length > 0);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    return { duplicateIds, unnamedControls };
  });

  expect(audit.unnamedControls).toEqual([]);
  expect(audit.duplicateIds).toEqual([]);
}
