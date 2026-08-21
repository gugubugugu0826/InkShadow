import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  LONG_MODEL_HUB_BASE_URL,
  LONG_MODEL_HUB_CONNECTION_ID,
  LONG_MODEL_HUB_MODEL_ID,
  LONG_MODEL_HUB_PROVIDER_NAME,
  LONG_MODEL_HUB_RETIRED_PROVIDER_NAME,
  seedLongModelHubFixture,
} from "./support/model-hub";

const TARGET_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
] as const;

for (const colorScheme of ["light", "dark"] as const) {
  test(`keeps long Model Hub authority data reachable at every width in ${colorScheme}`, async ({
    page,
  }) => {
    await page.goto("/#/start");
    await page.evaluate(() => window.localStorage.clear());
    await seedLongModelHubFixture(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });

    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto("/#/settings#model-center");
      await expect(page.getByRole("heading", { name: "InkShadow 模型中心" })).toBeVisible();
      await selectConnection(page, LONG_MODEL_HUB_CONNECTION_ID);
      await expect(
        page.getByRole("combobox", { name: /^已连接的供应商/u }).locator("option:checked"),
      ).toContainText(LONG_MODEL_HUB_PROVIDER_NAME);
      await openExpertSettings(page);
      await expect(page.getByLabel("Base URL")).toHaveValue(LONG_MODEL_HUB_BASE_URL);
      await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue(
        LONG_MODEL_HUB_MODEL_ID,
      );
      await expectNoPageOrCardOverflow(page);

      const retiredHistory = page.getByText(/已退役连接历史/u).first();
      await retiredHistory.click();
      await expect(
        page.getByText(LONG_MODEL_HUB_RETIRED_PROVIDER_NAME, { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/已退役|已停用/u).first()).toBeVisible();
      await expect(page.getByText("MODEL_HUB_CONNECTION_RETIRED", { exact: true })).toHaveCount(0);
      await expectNoPageOrCardOverflow(page);

      await page.goto("/#/settings#model-routing");
      await expect(page.getByRole("heading", { name: "模型中心 · AI 分工" })).toBeVisible();
      await openExpertSettings(page);
      await expect(page.getByText(LONG_MODEL_HUB_MODEL_ID, { exact: false }).first()).toBeVisible();
      await expect(page.getByText(/123\.456789|123456789|USD/u).first()).toBeVisible();
      await expectNoPageOrCardOverflow(page);
    }
  });
}

test("keeps long Model Hub data usable at DPR2 and equivalent 200%", async ({
  browser,
  browserName,
}) => {
  expect(browserName).toBe("chromium");
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto("/#/start");
    await page.evaluate(() => window.localStorage.clear());
    await seedLongModelHubFixture(page);
    await page.goto("/#/settings#model-center");
    await expect(page.getByRole("heading", { name: "InkShadow 模型中心" })).toBeVisible();
    await selectConnection(page, LONG_MODEL_HUB_CONNECTION_ID);
    await expectNoPageOrCardOverflow(page);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);

    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 720,
        height: 450,
        screenWidth: 1440,
        screenHeight: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: "InkShadow 模型中心" })).toBeVisible();
      await selectConnection(page, LONG_MODEL_HUB_CONNECTION_ID);
      await openExpertSettings(page);
      await expect(page.getByLabel("Base URL")).toHaveValue(LONG_MODEL_HUB_BASE_URL);
      await expectNoPageOrCardOverflow(page);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } finally {
    await context.close();
  }
});

async function selectConnection(page: Page, id: string): Promise<void> {
  const select = page.getByRole("combobox", { name: /^已连接的供应商/u });
  await expect(select).toBeEnabled();
  await select.selectOption(id);
  await expect(select).toHaveValue(id);
}

async function openExpertSettings(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /专家设置/u });
  await trigger.scrollIntoViewIfNeeded();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function expectNoPageOrCardOverflow(page: Page): Promise<void> {
  const pageOverflow = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    mainClientWidth: document.querySelector("main")?.clientWidth ?? 0,
    mainScrollWidth: document.querySelector("main")?.scrollWidth ?? 0,
  }));
  expect(pageOverflow.documentScrollWidth).toBeLessThanOrEqual(
    pageOverflow.documentClientWidth + 1,
  );
  expect(pageOverflow.mainScrollWidth).toBeLessThanOrEqual(pageOverflow.mainClientWidth + 1);

  const overflow = await visibleOverflow(page.locator(".ink-card, .settings-section, form"));
  expect(overflow).toEqual([]);
}

async function visibleOverflow(locator: Locator): Promise<readonly unknown[]> {
  return locator.evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element, index) => ({
        index,
        label:
          element.querySelector("h1, h2, h3, h4, [role='heading']")?.textContent?.trim() ??
          element.tagName,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      .filter(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth + 1),
  );
}
