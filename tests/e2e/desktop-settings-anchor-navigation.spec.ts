import { expect, test, type Page } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

test.use({ viewport: { width: 1280, height: 800 } });

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
