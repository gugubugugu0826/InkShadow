import { expect, type Locator, type Page } from "@playwright/test";

const AUTHORIZATION_DIALOG_NAME = "启用直接模式前，请确认一次";

/**
 * Pins the one-time direct-mode disclosure to the user-visible contract. The
 * authorization covers deterministic local organization after an explicit
 * Candidate acceptance; it must not be interpreted as body-write or Provider
 * dispatch authority.
 */
export async function expectDirectModeAuthorizationDisclosure(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: AUTHORIZATION_DIALOG_NAME });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("授权本地整理，不授权联网或修改正文", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("整理过程不会调用模型，不会增加模型服务调用次数或费用。", {
      exact: true,
    }),
  ).toBeVisible();
  return dialog;
}

export async function authorizeDirectMode(page: Page): Promise<void> {
  const dialog = await expectDirectModeAuthorizationDisclosure(page);
  await dialog.getByRole("button", { name: "同意并启用直接模式" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("直接模式", { exact: true })).toBeVisible();
}

export async function dismissDirectModeAuthorization(page: Page): Promise<void> {
  const dialog = await expectDirectModeAuthorizationDisclosure(page);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function switchFreshInstallToProfessionalMode(page: Page): Promise<void> {
  await dismissDirectModeAuthorization(page);
  // Cancelling the first-use disclosure now revokes the direct-mode authority
  // and atomically selects professional mode. There is no second transition
  // button to click.
  await expect(page.getByRole("region", { name: "选择创作方式" })).toBeVisible();
  await expect(page.getByText("专业模式", { exact: true })).toBeVisible();
}
