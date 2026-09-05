import { expect, test } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

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

  await switchFreshInstallToProfessionalMode(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "把你的第一个想法，写成一个故事" }),
  ).toBeVisible();
  await expect(
    page.getByText("仅开发环境：当前数据只保存在此浏览器中，不代表桌面正式版的持久化能力。", {
      exact: true,
    }),
  ).toBeVisible();

  const creationEntries = page.getByRole("region", { name: "选择创作方式" });
  const ideaEntry = creationEntries.getByRole("link", { name: /从一个想法开始/u });
  await expect(creationEntries.getByRole("link")).toHaveCount(3);
  const badgeStyles = await creationEntries
    .locator(".start-page__entry-eyebrow")
    .evaluateAll((badges) =>
      badges.map((badge) => {
        const style = getComputedStyle(badge);
        const card = badge.closest(".start-page__entry");
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          color: style.color,
          top: Math.round(
            badge.getBoundingClientRect().top - (card?.getBoundingClientRect().top ?? 0),
          ),
        };
      }),
    );
  expect(badgeStyles).toHaveLength(3);
  expect(badgeStyles[1]).toEqual(badgeStyles[0]);
  expect(badgeStyles[2]).toEqual(badgeStyles[0]);
  await expect(ideaEntry).toHaveAttribute("href", "#/create/idea");
  await expect(
    creationEntries.getByRole("link", { name: /导入小说，继续写或改写/u }),
  ).toHaveAttribute("href", "#/create/import");
  await expect(creationEntries.getByRole("link", { name: /专业创建/u })).toHaveAttribute(
    "href",
    "#/create/professional",
  );

  await expect(page.getByRole("link", { name: "浏览作品库" })).toHaveAttribute(
    "href",
    "#/projects",
  );
  await expect(page.getByRole("link", { name: "导入项目包" })).toHaveAttribute(
    "href",
    "#/settings#data-transfer",
  );

  await expect(page.getByText(/无需注册，本地保存。连接你自己的 AI 模型后/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "登录已有云账户" })).toHaveCount(0);

  await ideaEntry.click();
  await expect(page.getByRole("heading", { level: 1, name: "一句话就够了" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "一句话灵感" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("必须登录");
  expect(nonLocalRequests).toEqual([]);
});
