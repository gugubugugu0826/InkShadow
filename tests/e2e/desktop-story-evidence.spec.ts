import { expect, test, type Page } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

test.use({
  hasTouch: true,
  viewport: { width: 1280, height: 800 },
});

test.beforeEach(async ({ page }) => {
  await page.goto("/#/start");
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await switchFreshInstallToProfessionalMode(page);
  await page.goto("/#/projects");
  await expect(page.getByRole("heading", { level: 1, name: "项目" })).toBeVisible();
});

test("expands story evidence with mouse, keyboard, and touch without losing trigger focus", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await createProject(page, "设定证据浏览器验收");
  const projectHref = await page
    .getByRole("link", { name: "打开", exact: true })
    .getAttribute("href");
  const projectId = /^#\/projects\/([^/]+)$/u.exec(projectHref ?? "")?.[1];
  if (projectId === undefined) {
    throw new Error("无法从作品库读取测试项目标识。");
  }

  await page.goto("/#/settings#writing-experience");
  await page.getByRole("button", { name: "直接写作" }).click();
  const authorization = page.getByRole("dialog", { name: "启用直接模式前，请确认一次" });
  if ((await authorization.count()) > 0) {
    await authorization.getByRole("button", { name: "同意并启用直接模式" }).click();
  }
  await expect(page.getByRole("heading", { level: 2, name: "写作方式" })).toBeVisible();
  await expect(page.getByText("当前使用简洁的直接写作界面。", { exact: true })).toBeVisible();

  await page.goto(`/#/projects/${projectId}/story`);
  await expect(page.getByRole("heading", { level: 2, name: "当前设定" })).toBeVisible();
  await page.getByRole("button", { name: "添加设定" }).click();
  const createDialog = page.getByRole("dialog", { name: "添加设定" });
  await createDialog.getByRole("textbox", { name: "内容" }).fill("旧城钟楼每天午夜倒转一次。");
  await createDialog.getByRole("button", { name: "保存设定" }).click();

  const evidenceButton = page.getByRole("button", { name: "查看证据" });
  await expect(evidenceButton).toHaveAttribute("aria-expanded", "false");
  const regionId = await evidenceButton.getAttribute("aria-controls");
  expect(regionId).not.toBeNull();

  await evidenceButton.click();
  const collapseEvidenceButton = page.getByRole("button", { name: "收起证据" });
  await expect(collapseEvidenceButton).toHaveAttribute("aria-expanded", "true");
  await expect(collapseEvidenceButton).toBeFocused();
  const evidenceRegion = page.getByRole("region", { name: "证据" });
  await expect(evidenceRegion).toHaveAttribute("id", regionId ?? "");
  await expect(evidenceRegion).toBeVisible();

  await collapseEvidenceButton.press("Enter");
  const reopenedEvidenceButton = page.getByRole("button", { name: "查看证据" });
  await expect(reopenedEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(reopenedEvidenceButton).toBeFocused();
  await expect(evidenceRegion).toHaveCount(0);

  await reopenedEvidenceButton.tap();
  await expect(page.getByRole("button", { name: "收起证据" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("region", { name: "证据" })).toBeVisible();
});

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByRole("textbox", { name: "项目名称" }).fill(name);
  await dialog.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
}
