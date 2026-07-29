import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "./node_modules/.vite",
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
  },
});
