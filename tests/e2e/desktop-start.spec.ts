import { expect, test } from "@playwright/test";

test("starts locally without registration or an enabled cloud entry", async ({ page }) => {
  const nonLocalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      nonLocalRequests.push(url.origin);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.goto("/#/");
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();

  await expect(page.getByRole("heading", { level: 1, name: "从你的设备开始创作" })).toBeVisible();
  await expect(page.getByRole("link", { name: "登录已有云账户" })).toHaveCount(0);
  await expect(page.getByText("云账户稍后登录；本地工作区功能保持完整。")).toBeVisible();

  await page.getByRole("link", { name: "本地开始" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "项目" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("必须登录");
  expect(nonLocalRequests).toEqual([]);
});
