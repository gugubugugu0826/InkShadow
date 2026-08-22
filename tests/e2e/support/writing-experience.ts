import { expect, type Page } from "@playwright/test";

const DIRECT_MODE_TECHNICAL_LANGUAGE =
  /AI\s*助手|候选|调用|上下文|路由|追踪|令牌|模型服务|Candidate|invocation|context|route|trace|token/iu;

/** Verifies the safe, plain-language state used by a brand-new local install. */
export async function expectFreshInstallDirectMode(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "开始写你的故事" })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始创作", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(DIRECT_MODE_TECHNICAL_LANGUAGE);
}

/** Keeps direct-mode pages pinned to ordinary author-facing language. */
export async function expectDirectModeUsesPlainLanguage(page: Page): Promise<void> {
  await expect(page.getByRole("main")).not.toContainText(DIRECT_MODE_TECHNICAL_LANGUAGE);
}

export async function switchFreshInstallToProfessionalMode(page: Page): Promise<void> {
  await expectFreshInstallDirectMode(page);
  await page.getByRole("button", { name: "打开更多选项" }).click();
  const menu = page.getByRole("menu", { name: "更多选项" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "切换专业模式" }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("region", { name: "选择创作方式" })).toBeVisible();
  await expect(page.getByRole("button", { name: "搜索页面与命令" })).toBeVisible();
}
