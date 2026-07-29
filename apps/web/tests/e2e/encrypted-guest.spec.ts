import { expect, test, type Page } from "@playwright/test";

const DATABASE_NAME = "inkshadow-web-guest-v1";
const OBJECT_STORE_NAME = "encrypted-projects";
const PROJECT_CANARY = "E2E_PROJECT_CANARY_18ce";
const BODY_CANARY = "E2E_BODY_CANARY_d92a：雨线把远山切成了灰色的层次。";
const UPDATED_CANARY = "E2E_UPDATED_CANARY_66ab：灯塔在第三次潮汐前熄灭。";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (databaseName) => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Test database deletion failed."));
      };
      request.onblocked = () => {
        reject(new Error("Test database deletion was blocked."));
      };
    });
  }, DATABASE_NAME);
  await page.reload();
});

test("persists ciphertext only and refreshes back to a locked project", async ({ page }) => {
  const riskDialog = page.getByRole("dialog", {
    name: "进入浏览器 Guest 工作区前",
  });
  await expect(riskDialog).toContainText("清理站点数据");
  await riskDialog.getByRole("button", { name: "我理解风险，进入工作区" }).click();

  await page.getByRole("textbox", { name: "项目名称" }).fill(PROJECT_CANARY);
  await page.getByRole("textbox", { name: "首章标题" }).fill("密文首章");
  await page.getByRole("textbox", { name: /^首章正文/u }).fill(BODY_CANARY);
  await page.getByRole("button", { name: "创建加密项目" }).click();

  const recoveryDialog = page.getByRole("dialog", { name: "现在保存恢复材料" });
  const recoveryMaterial = (
    await recoveryDialog.getByTestId("recovery-material").textContent()
  )?.trim();
  expect(recoveryMaterial).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await inspectBrowserStorage(page)).recordCount).toBe(0);
  await recoveryDialog.getByRole("checkbox", { name: /我已把恢复材料保存到浏览器之外/u }).check();
  await recoveryDialog.getByRole("button", { name: "我已另存，保存密文项目" }).click();

  const initialStorage = await inspectBrowserStorage(page);
  expect(initialStorage.localStorage).toEqual({});
  expect(initialStorage.sessionStorage).toEqual({});
  expect(initialStorage.serializedRecord).not.toContain(PROJECT_CANARY);
  expect(initialStorage.serializedRecord).not.toContain("密文首章");
  expect(initialStorage.serializedRecord).not.toContain(BODY_CANARY);
  expect(initialStorage.serializedRecord).not.toContain(recoveryMaterial);
  expect(initialStorage.recordKeys).toEqual([
    "chapterEnvelopes",
    "format",
    "keyVersion",
    "projectEnvelope",
    "projectId",
    "recovery",
    "schemaVersion",
  ]);
  expect(initialStorage.chapterEnvelopeKeys).toEqual([
    "algorithm",
    "ciphertext",
    "contentVersion",
    "keyVersion",
    "nonce",
    "objectId",
    "objectType",
    "projectId",
    "schemaVersion",
  ]);
  expect(initialStorage.chapterNonces).toHaveLength(1);

  await page.getByRole("textbox", { name: /^章节正文/u }).fill(UPDATED_CANARY);
  await page.getByRole("button", { name: "保存密文版本" }).click();
  await expect(page.getByText("密文版本已保存")).toBeVisible();

  const savedStorage = await inspectBrowserStorage(page);
  expect(savedStorage.serializedRecord).not.toContain(UPDATED_CANARY);
  expect(savedStorage.chapterNonces).toHaveLength(2);
  expect(new Set(savedStorage.chapterNonces).size).toBe(2);
  expect(savedStorage.localStorage).toEqual({});
  expect(savedStorage.sessionStorage).toEqual({});

  await page.reload();
  const refreshedRiskDialog = page.getByRole("dialog", {
    name: "进入浏览器 Guest 工作区前",
  });
  await refreshedRiskDialog.getByRole("button", { name: "我理解风险，进入工作区" }).click();
  await expect(page.getByText("已锁定")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^章节正文/u })).toHaveCount(0);

  const recoveryInput = page.getByLabel("恢复材料");
  await recoveryInput.fill(changeLastCharacter(recoveryMaterial ?? ""));
  await page.getByRole("button", { name: "仅本次会话解锁" }).click();
  await expect(page.getByText(/WEB_UNLOCK_FAILED/u)).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^章节正文/u })).toHaveCount(0);

  await recoveryInput.fill(recoveryMaterial ?? "");
  await page.getByRole("button", { name: "仅本次会话解锁" }).click();
  await expect(page.getByRole("textbox", { name: /^章节正文/u })).toHaveValue(UPDATED_CANARY);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });
  await expect(page.getByRole("textbox", { name: /^章节正文/u })).toHaveCount(0);
  await expect(page.getByText("已锁定")).toBeVisible();
});

test("keeps the first-use workflow keyboard-operable at a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");

  const riskDialog = page.getByRole("dialog", {
    name: "进入浏览器 Guest 工作区前",
  });
  const acceptButton = riskDialog.getByRole("button", {
    name: "我理解风险，进入工作区",
  });
  await expect(acceptButton).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Guest 写作工作区" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "项目名称" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "首章标题" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^首章正文/u })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

async function inspectBrowserStorage(page: Page): Promise<{
  recordCount: number;
  serializedRecord: string;
  chapterNonces: string[];
  recordKeys: string[];
  chapterEnvelopeKeys: string[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}> {
  return page.evaluate(
    async ({ databaseName, objectStoreName }) => {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 1);
        open.onerror = () => {
          reject(open.error ?? new Error("Test database could not be opened."));
        };
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction(objectStoreName, "readonly");
          const request = transaction.objectStore(objectStoreName).getAll();
          request.onsuccess = () => {
            resolve(request.result as unknown[]);
          };
          request.onerror = () => {
            reject(request.error ?? new Error("Test records could not be read."));
          };
        };
      });
      const first = records[0] as { chapterEnvelopes?: { nonce?: unknown }[] } | undefined;
      return {
        recordCount: records.length,
        serializedRecord: JSON.stringify(records),
        chapterNonces:
          first?.chapterEnvelopes?.flatMap((envelope) =>
            typeof envelope.nonce === "string" ? [envelope.nonce] : [],
          ) ?? [],
        recordKeys: first === undefined ? [] : Object.keys(first).sort(),
        chapterEnvelopeKeys:
          first?.chapterEnvelopes?.[0] === undefined
            ? []
            : Object.keys(first.chapterEnvelopes[0]).sort(),
        localStorage: Object.fromEntries(
          Array.from({ length: localStorage.length }, (_, index) => {
            const key = localStorage.key(index) ?? "";
            return [key, localStorage.getItem(key) ?? ""];
          }),
        ),
        sessionStorage: Object.fromEntries(
          Array.from({ length: sessionStorage.length }, (_, index) => {
            const key = sessionStorage.key(index) ?? "";
            return [key, sessionStorage.getItem(key) ?? ""];
          }),
        ),
      };
    },
    {
      databaseName: DATABASE_NAME,
      objectStoreName: OBJECT_STORE_NAME,
    },
  );
}

function changeLastCharacter(value: string): string {
  const last = value.at(-1);
  if (last === undefined) {
    throw new Error("Recovery material must not be empty.");
  }
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}
