import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "./node_modules/.vite",
  resolve: {
    alias: [
      {
        find: "@inkshadow/contracts",
        replacement: fileURLToPath(
          new URL("../../packages/contracts/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/domain",
        replacement: fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)),
      },
      {
        find: "@inkshadow/platform",
        replacement: fileURLToPath(
          new URL("../../packages/platform/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/ui",
        replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    execArgv: ["--no-experimental-webstorage"],
    clearMocks: true,
    restoreMocks: true,
  },
});
