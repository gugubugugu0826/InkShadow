import { expect, test, type Locator, type Page } from "@playwright/test";

import { authorizeDirectMode } from "./support/writing-experience";

const TARGET_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
] as const;

const PHYSICAL_ZOOM_VIEWPORT = { width: 1440, height: 900 } as const;
const TWO_HUNDRED_PERCENT_CSS_VIEWPORT = { width: 720, height: 450 } as const;

test("keeps every primary writing region reachable at 1440, 1280, 1024, and 800", async ({
  page,
}) => {
  await page.setViewportSize(TARGET_VIEWPORTS[0]);
  const editorUrl = await openFreshSampleEditor(page);

  for (const viewport of TARGET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto(editorUrl);

    const workspace = page.locator(".editor-workspace");
    const editor = page.getByRole("textbox", { name: "章节正文" });
    await expect(workspace).toBeVisible();
    await expect(editor).toBeVisible();
    await expectFocusable(editor);
    await expectMinimumWidth(editor);
    await expectMinimumTarget(primaryEditorAction(page));
    await expectFocusable(primaryEditorAction(page));
    await expectNoHorizontalPageOverflow(page);

    if (viewport.width <= 1024) {
      await expect(workspace).toHaveAttribute("data-chapter-panel", "drawer");
      await expect(workspace).toHaveAttribute("data-assistant-panel", "drawer");
      await exerciseCompactWritingPanels(page);
    } else {
      await expect(page.getByRole("navigation", { name: "章节列表" })).toBeVisible();
      await expect(page.getByRole("complementary", { name: "AI 创作助手" })).toBeVisible();
      await expectFocusable(page.getByRole("button", { name: "收起章节列表" }));
      await expectFocusable(page.getByRole("button", { name: "收起 AI 创作助手" }));
    }
  }
});

test("keeps ordinary project cards inside their responsive columns", async ({ page }) => {
  await page.setViewportSize(TARGET_VIEWPORTS[0]);
  const editorUrl = await openFreshSampleEditor(page);
  const projectId = projectIdFromEditorUrl(editorUrl);
  const ordinaryAreas = ["outline", "story", "checks"] as const;

  for (const viewport of TARGET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const area of ordinaryAreas) {
      await page.goto(`/#/projects/${projectId}/${area}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalPageOverflow(page);
      await expectVisibleCardsNoInternalHorizontalOverflow(page);
    }
  }
});

test("keeps writing, Story Settings import, and all 22 Model Hub tasks reachable at 200%", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(60_000);
  expect(browserName).toBe("chromium");
  const context = await browser.newContext({
    viewport: PHYSICAL_ZOOM_VIEWPORT,
    colorScheme: "dark",
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: TWO_HUNDRED_PERCENT_CSS_VIEWPORT.width,
      height: TWO_HUNDRED_PERCENT_CSS_VIEWPORT.height,
      screenWidth: PHYSICAL_ZOOM_VIEWPORT.width,
      screenHeight: PHYSICAL_ZOOM_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const editorUrl = await openFreshSampleEditor(page);
    const zoomEvidence = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
    }));
    expect(zoomEvidence).toEqual({
      innerWidth: TWO_HUNDRED_PERCENT_CSS_VIEWPORT.width,
      innerHeight: TWO_HUNDRED_PERCENT_CSS_VIEWPORT.height,
      screenWidth: PHYSICAL_ZOOM_VIEWPORT.width,
      screenHeight: PHYSICAL_ZOOM_VIEWPORT.height,
      devicePixelRatio: 1,
    });

    const editor = page.getByRole("textbox", { name: "章节正文" });
    await expect(editor).toBeVisible();
    await expectFocusable(editor);
    await expectMinimumWidth(editor);
    await expectMinimumTarget(primaryEditorAction(page));
    await expectFocusable(primaryEditorAction(page));
    const primaryNavigation = page.getByRole("navigation", { name: "墨影主导航" });
    await expect(primaryNavigation).toBeVisible();
    await expectFocusable(primaryNavigation.getByRole("link", { name: "正文", exact: true }));
    await expectNoHorizontalPageOverflow(page);
    await expect(page.locator(".editor-workspace")).toHaveAttribute("data-chapter-panel", "drawer");
    await exerciseCompactWritingPanels(page);

    const projectId = projectIdFromEditorUrl(editorUrl);
    await page.goto(`/#/projects/${projectId}/story`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
    await expectVisibleCardsNoInternalHorizontalOverflow(page);

    const transferTrigger = page.getByRole("button", { name: "导入或导出" });
    await transferTrigger.scrollIntoViewIfNeeded();
    await expectFocusable(transferTrigger);
    await transferTrigger.click();

    const importDrawer = page.getByRole("dialog", { name: "导入与导出故事设定" });
    await expect(importDrawer).toBeVisible();
    await expectNoHorizontalOverflow(importDrawer);
    const importContent = importDrawer.locator(".ink-overlay__content");
    await expectScrollable(importContent);
    const importSteps = importDrawer.getByRole("list", { name: "导入步骤" });
    await expect(importSteps.getByRole("button")).toHaveCount(7);
    const confirmStep = importSteps.getByRole("button", { name: /确认导入/u });
    await confirmStep.scrollIntoViewIfNeeded();
    await expectFocusable(confirmStep);
    await page.keyboard.press("Escape");
    await expect(importDrawer).toBeHidden();
    await expect(transferTrigger).toBeFocused();

    await page.goto("/#/settings#model-routing");
    await expect(page.getByRole("heading", { level: 1, name: "模型中心 · AI 分工" })).toBeVisible();
    const expertSettings = page.getByRole("button", { name: /专家设置/u });
    await expertSettings.scrollIntoViewIfNeeded();
    await expectFocusable(expertSettings);
    if ((await expertSettings.getAttribute("aria-expanded")) !== "true") {
      await expertSettings.click();
    }
    await expect(expertSettings).toHaveAttribute("aria-expanded", "true");

    const taskCoverage = page.getByText(/逐项覆盖 22 类小说任务/u);
    await taskCoverage.scrollIntoViewIfNeeded();
    await expect(taskCoverage).toBeVisible();
    await expect(page.getByText(/22 类小说任务由模型中心负责/u)).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
    await expectMainReachedScrolledContent(page, taskCoverage);
  } finally {
    await cdp.detach().catch(() => undefined);
    await context.close();
  }
});

test("keeps the 200% writing path usable in light appearance", async ({ browser, browserName }) => {
  expect(browserName).toBe("chromium");
  const context = await browser.newContext({
    viewport: PHYSICAL_ZOOM_VIEWPORT,
    colorScheme: "light",
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: TWO_HUNDRED_PERCENT_CSS_VIEWPORT.width,
      height: TWO_HUNDRED_PERCENT_CSS_VIEWPORT.height,
      screenWidth: PHYSICAL_ZOOM_VIEWPORT.width,
      screenHeight: PHYSICAL_ZOOM_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await openFreshSampleEditor(page);
    const editor = page.getByRole("textbox", { name: "章节正文" });
    await expect(page.locator(".writing-canvas")).toHaveAttribute("data-surface", "light");
    await expectMinimumWidth(editor);
    await expectMinimumTarget(primaryEditorAction(page));
    await expectNoHorizontalPageOverflow(page);
    await expect(page.locator(".editor-workspace")).toHaveAttribute(
      "data-assistant-panel",
      "drawer",
    );
    await exerciseCompactWritingPanels(page);
  } finally {
    await cdp.detach().catch(() => undefined);
    await context.close();
  }
});

async function openFreshSampleEditor(page: Page): Promise<string> {
  await page.goto("/#/start");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await authorizeDirectMode(page);
  await page.getByRole("button", { name: "体验示例作品" }).click();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toBeVisible();
  return page.url();
}

async function exerciseCompactWritingPanels(page: Page): Promise<void> {
  const chapterTrigger = page.getByRole("button", { name: "章节", exact: true });
  const assistantTrigger = page.getByRole("button", { name: "AI 助手", exact: true });
  await expectMinimumTarget(chapterTrigger);
  await expectMinimumTarget(assistantTrigger);
  await expectFocusable(chapterTrigger);
  await expectFocusable(assistantTrigger);

  await chapterTrigger.click();
  const chapterDrawer = page.getByRole("dialog", { name: "章节" });
  await expect(chapterDrawer).toBeVisible();
  await expect(chapterDrawer.getByRole("navigation", { name: "章节抽屉" })).toBeVisible();
  await expectNoHorizontalOverflow(chapterDrawer);
  await page.keyboard.press("Escape");
  await expect(chapterDrawer).toBeHidden();
  await expect(chapterTrigger).toBeFocused();

  await assistantTrigger.click();
  const assistantDrawer = page.getByRole("dialog", { name: "AI 创作助手" });
  await expect(assistantDrawer).toBeVisible();
  await expectNoHorizontalOverflow(assistantDrawer);
  const assistantClose = assistantDrawer.getByRole("button", { name: "关闭 AI 创作助手" });
  await expectMinimumTarget(assistantClose);
  await expectFocusable(assistantClose);
  await page.keyboard.press("Escape");
  await expect(assistantDrawer).toBeHidden();
  await expect(assistantTrigger).toBeFocused();
}

function primaryEditorAction(page: Page): Locator {
  return page.locator(
    ".editor-toolbar__actions .ink-button--primary, .editor-toolbar__actions .ink-button--ai-primary",
  );
}

function projectIdFromEditorUrl(editorUrl: string): string {
  const match = /#\/projects\/([^/]+)\/chapters\//u.exec(editorUrl);
  if (match?.[1] === undefined) {
    throw new Error(`Could not read a project id from ${editorUrl}`);
  }
  return match[1];
}

async function expectFocusable(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.focus();
  await expect(locator).toBeFocused();
}

async function expectMinimumWidth(locator: Locator, minimum = 320): Promise<void> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectMinimumTarget(locator: Locator, minimum = 44): Promise<void> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    mainClientWidth: document.querySelector("main")?.clientWidth ?? 0,
    mainScrollWidth: document.querySelector("main")?.scrollWidth ?? 0,
  }));
  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.documentClientWidth + 1);
  expect(dimensions.mainScrollWidth).toBeLessThanOrEqual(dimensions.mainClientWidth + 1);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const dimensions = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectVisibleCardsNoInternalHorizontalOverflow(page: Page): Promise<void> {
  const overflowingCards = await page.locator(".ink-card").evaluateAll((cards) =>
    cards
      .filter((card) => card.getClientRects().length > 0)
      .map((card, index) => ({
        index,
        label:
          card.querySelector("h1, h2, h3, h4, [role='heading']")?.textContent?.trim() ??
          "未命名卡片",
        clientWidth: card.clientWidth,
        scrollWidth: card.scrollWidth,
      }))
      .filter(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth + 1),
  );
  expect(overflowingCards).toEqual([]);
}

async function expectScrollable(locator: Locator): Promise<void> {
  const scrollState = await locator.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.scrollTop).toBeGreaterThan(0);
}

async function expectMainReachedScrolledContent(page: Page, target: Locator): Promise<void> {
  const main = page.locator("main");
  const [mainScrollTop, mainBounds, targetBounds] = await Promise.all([
    main.evaluate((element) => element.scrollTop),
    main.boundingBox(),
    target.boundingBox(),
  ]);
  expect(mainScrollTop).toBeGreaterThan(0);
  expect(mainBounds).not.toBeNull();
  expect(targetBounds).not.toBeNull();
  expect(targetBounds?.y ?? 0).toBeGreaterThanOrEqual(mainBounds?.y ?? 0);
  expect((targetBounds?.y ?? 0) + (targetBounds?.height ?? 0)).toBeLessThanOrEqual(
    (mainBounds?.y ?? 0) + (mainBounds?.height ?? 0) + 1,
  );
}
