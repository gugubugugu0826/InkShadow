import { expect, test } from "@playwright/test";

test("starts locally through the three creation paths without requiring cloud login", async ({
  page,
}) => {
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

  await expect(
    page.getByRole("heading", { level: 1, name: "一句想法，也能开始一部长篇" }),
  ).toBeVisible();
  await expect(page.getByText("本地优先 · 无需登录")).toBeVisible();

  const creationEntries = page.getByRole("region", { name: "选择创作方式" });
  const ideaEntry = creationEntries.getByRole("link", { name: /从一个想法开始/u });
  await expect(creationEntries.getByRole("link")).toHaveCount(3);
  await expect(ideaEntry).toHaveAttribute("href", "#/create/idea");
  await expect(
    creationEntries.getByRole("link", { name: /导入小说，继续写或改写/u }),
  ).toHaveAttribute("href", "#/create/import");
  await expect(creationEntries.getByRole("link", { name: /专业创建/u })).toHaveAttribute(
    "href",
    "#/create/professional",
  );

  await expect(page.getByRole("link", { name: "打开最近创作与作品库" })).toHaveAttribute(
    "href",
    "#/projects",
  );
  await expect(page.getByRole("link", { name: "从备份恢复" })).toHaveAttribute(
    "href",
    "#/settings#data-transfer",
  );

  await expect(page.getByText("云账户可稍后连接，本地创作功能保持完整。")).toBeVisible();
  await expect(page.getByRole("link", { name: "登录已有云账户" })).toHaveCount(0);

  await ideaEntry.click();
  await expect(page.getByRole("heading", { level: 1, name: "一句话就够了" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "一句话灵感" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("必须登录");
  expect(nonLocalRequests).toEqual([]);
});
