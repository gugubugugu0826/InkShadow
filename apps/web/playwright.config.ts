import { defineConfig } from "@playwright/test";

const port = 4174;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "../../test-results/web",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    colorScheme: "dark",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${String(port)} --strictPort --configLoader runner`,
    url: `http://127.0.0.1:${String(port)}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
