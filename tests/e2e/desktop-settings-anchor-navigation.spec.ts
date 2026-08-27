import { expect, test, type Page } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

test.use({ viewport: { width: 1280, height: 800 } });

const TARGET_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/#/start");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await switchFreshInstallToProfessionalMode(page);
});

test("restores settings anchors through keyboard, history, direct links, and refresh", async ({
  page,
}) => {
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { level: 1, name: "全局设置" })).toBeVisible();

  const transferLink = page.getByRole("link", { name: "导入与导出" });
  await transferLink.focus();
  await transferLink.press("Enter");
  await expect(page).toHaveURL(/#\/settings#data-transfer$/u);
  await assertTransferTarget(page);
  await expect(transferLink).toHaveAttribute("aria-current", "location");

  const appearanceLink = page.getByRole("link", { name: "外观", exact: true });
  await appearanceLink.click();
  await expect(page).toHaveURL(/#\/settings#appearance$/u);
  await expect(page.getByRole("heading", { name: "外观", level: 2 })).toBeFocused();
  await expect(appearanceLink).toHaveAttribute("aria-current", "location");

  await page.goBack();
  await expect(page).toHaveURL(/#\/settings#data-transfer$/u);
  await assertTransferTarget(page);

  await page.goForward();
  await expect(page).toHaveURL(/#\/settings#appearance$/u);
  await expect(page.getByRole("heading", { name: "外观", level: 2 })).toBeFocused();

  await page.goto("/#/settings#data-transfer");
  await assertTransferTarget(page);
  await page.reload();
  await assertTransferTarget(page);
});

test("keeps every global settings quick jump connected to a real target", async ({ page }) => {
  await page.goto("/#/settings");
  const quickJump = page.getByRole("navigation", { name: "全局设置快速跳转" });
  const expectedTargets = [
    ["外观", "appearance"],
    ["正文与自动保存", "writing-preferences"],
    ["写作体验", "writing-experience"],
    ["数据与隐私", "data-privacy"],
    ["AI 记忆", "ai-memory"],
    ["打开模型中心", "model-center"],
    ["同步安全", "sync-security"],
    ["本地维护", "local-maintenance"],
    ["安全更新", "secure-updates"],
    ["诊断", "diagnostics"],
    ["导入与导出", "data-transfer"],
  ] as const;

  for (const [label, targetId] of expectedTargets) {
    await expect(quickJump.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "href",
      `#/settings#${targetId}`,
    );
  }
});

test("keeps the direct writing settings export target visible after deep links and navigation", async ({
  page,
}) => {
  await page.evaluate(() => window.localStorage.clear());
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  const directQuickJump = page.getByRole("navigation", { name: "设置快速跳转" });
  const directTransferLink = directQuickJump.getByRole("link", {
    name: "导入与导出",
    exact: true,
  });
  await directTransferLink.focus();
  await directTransferLink.press("Enter");
  await expect(page).toHaveURL(/#\/settings#data-transfer$/u);
  await assertTransferTarget(page);
  const transferLink = page.getByRole("link", { name: "导入与导出", exact: true });
  await expect(transferLink).toHaveAttribute("aria-current", "location");

  const appearanceLink = page.getByRole("link", { name: "外观", exact: true });
  await appearanceLink.click();
  await expect(page).toHaveURL(/#\/settings#appearance$/u);
  await expect(page.getByRole("heading", { name: "外观", level: 2 })).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings#data-transfer$/u);
  await assertTransferTarget(page);
  await page.reload();
  await assertTransferTarget(page);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("opens the real diagnostics area from a direct writing mode deep link", async ({ page }) => {
  await page.evaluate(() => window.localStorage.clear());
  await page.goto("/#/settings#diagnostics");

  await expect(page.getByRole("heading", { level: 1, name: "全局设置" })).toBeVisible();
  const diagnosticsHeading = page.getByRole("heading", { level: 2, name: "脱敏诊断包" });
  await expect(diagnosticsHeading).toBeVisible();
  await expect(diagnosticsHeading).toBeFocused();
  await expect(page.getByRole("link", { name: "诊断", exact: true })).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expect(page.getByRole("button", { name: "下载脱敏诊断包" })).toBeVisible();
  await expect(page.getByText("不含正文与密钥", { exact: true })).toBeVisible();

  await page.reload();
  await expect(diagnosticsHeading).toBeVisible();
  await expect(diagnosticsHeading).toBeFocused();
});

test("keeps direct writing settings targets reachable at every accepted width", async ({
  page,
}) => {
  await page.evaluate(() => window.localStorage.clear());

  for (const viewport of TARGET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();

    const transferLink = page
      .getByRole("navigation", { name: "设置快速跳转" })
      .getByRole("link", { name: "导入与导出", exact: true });
    await transferLink.focus();
    await transferLink.press("Enter");
    await expect(page).toHaveURL(/#\/settings#data-transfer$/u);
    await expect(page.getByRole("heading", { level: 2, name: "导入与导出" })).toBeFocused();
    await expectNoHorizontalPageOverflow(page);

    await page.goto("/#/settings#diagnostics");
    await expect(page.getByRole("heading", { level: 2, name: "脱敏诊断包" })).toBeFocused();
    await expect(page.getByRole("button", { name: "下载脱敏诊断包" })).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
  }
});

test("keeps direct writing transfer and diagnostics reachable at equivalent 150%", async ({
  browser,
  browserName,
}) => {
  expect(browserName).toBe("chromium");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const zoomPage = await context.newPage();
  const cdp = await context.newCDPSession(zoomPage);

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 600,
      screenWidth: 1440,
      screenHeight: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await zoomPage.goto("http://127.0.0.1:1420/#/start");
    await zoomPage.evaluate(() => window.localStorage.clear());
    await zoomPage.goto("http://127.0.0.1:1420/#/settings#data-transfer");
    expect(
      await zoomPage.evaluate(() => ({
        innerWidth,
        innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
      })),
    ).toEqual({ innerWidth: 960, innerHeight: 600, screenWidth: 1440, screenHeight: 900 });

    await expect(zoomPage.getByRole("heading", { level: 2, name: "导入与导出" })).toBeFocused();
    await expectNoHorizontalPageOverflow(zoomPage);

    await zoomPage.goto("http://127.0.0.1:1420/#/settings#diagnostics");
    await expect(zoomPage.getByRole("heading", { level: 2, name: "脱敏诊断包" })).toBeFocused();
    await expect(zoomPage.getByRole("button", { name: "下载脱敏诊断包" })).toBeVisible();
    await expectNoHorizontalPageOverflow(zoomPage);
  } finally {
    await cdp.detach().catch(() => undefined);
    await context.close();
  }
});

test("keeps direct writing transfer and diagnostics reachable at equivalent 200%", async ({
  browser,
  browserName,
}) => {
  expect(browserName).toBe("chromium");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const zoomPage = await context.newPage();
  const cdp = await context.newCDPSession(zoomPage);

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: 450,
      screenWidth: 1440,
      screenHeight: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await zoomPage.goto("http://127.0.0.1:1420/#/start");
    await zoomPage.evaluate(() => window.localStorage.clear());
    await zoomPage.goto("http://127.0.0.1:1420/#/settings");
    expect(
      await zoomPage.evaluate(() => ({
        innerWidth,
        innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
      })),
    ).toEqual({ innerWidth: 720, innerHeight: 450, screenWidth: 1440, screenHeight: 900 });

    const transferLink = zoomPage
      .getByRole("navigation", { name: "设置快速跳转" })
      .getByRole("link", { name: "导入与导出", exact: true });
    await transferLink.focus();
    await transferLink.press("Enter");
    await expect(zoomPage.getByRole("heading", { level: 2, name: "导入与导出" })).toBeFocused();
    await expectNoHorizontalPageOverflow(zoomPage);

    await zoomPage.goto("http://127.0.0.1:1420/#/settings#diagnostics");
    await expect(zoomPage.getByRole("heading", { level: 2, name: "脱敏诊断包" })).toBeFocused();
    await expect(zoomPage.getByRole("button", { name: "下载脱敏诊断包" })).toBeVisible();
    await expectNoHorizontalPageOverflow(zoomPage);
  } finally {
    await cdp.detach().catch(() => undefined);
    await context.close();
  }
});

async function assertTransferTarget(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "导入与导出", level: 2 });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("heading", { name: "导出项目", level: 3 })).toBeInViewport();

  const [headingBox, mainBox] = await Promise.all([
    heading.boundingBox(),
    page.locator(".ink-app-shell__main").boundingBox(),
  ]);
  expect(headingBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect((headingBox?.y ?? 0) + 1).toBeGreaterThanOrEqual(mainBox?.y ?? 0);
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
