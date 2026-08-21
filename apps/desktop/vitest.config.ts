import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: "./.vite-cache",
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@inkshadow/ai-core",
        replacement: fileURLToPath(new URL("../../packages/ai-core/src/index.ts", import.meta.url)),
      },
      {
        find: "@inkshadow/config",
        replacement: fileURLToPath(new URL("../../packages/config/src/index.ts", import.meta.url)),
      },
      {
        find: "@inkshadow/cloud-client",
        replacement: fileURLToPath(
          new URL("../../packages/cloud-client/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/ui/styles.css",
        replacement: fileURLToPath(
          new URL("../../packages/ui/src/styles/index.css", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/platform",
        replacement: fileURLToPath(
          new URL("../../packages/platform/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/import-export/core",
        replacement: fileURLToPath(
          new URL("../../packages/import-export/src/core.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/import-export/docx-export",
        replacement: fileURLToPath(
          new URL("../../packages/import-export/src/docx-export.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/import-export/epub-export",
        replacement: fileURLToPath(
          new URL("../../packages/import-export/src/epub-export.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/import-export/pdf-export",
        replacement: fileURLToPath(
          new URL("../../packages/import-export/src/pdf-export.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/import-export",
        replacement: fileURLToPath(
          new URL("../../packages/import-export/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/task-engine",
        replacement: fileURLToPath(
          new URL("../../packages/task-engine/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/search-core",
        replacement: fileURLToPath(
          new URL("../../packages/search-core/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/story-core",
        replacement: fileURLToPath(
          new URL("../../packages/story-core/src/index.ts", import.meta.url),
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
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Node 26 exposes an experimental process-wide localStorage object. It is
    // not the jsdom Window storage and shadows the browser test environment in
    // workers unless explicitly disabled. Keep the project command stable on
    // both Node 24 (CI) and Node 26 (supported local development).
    execArgv: ["--no-experimental-webstorage"],
    // Several browser-level suites intentionally render the complete desktop
    // shell and exercise real file-backed SQLite/ZIP boundaries. GitHub's
    // Windows runner repeatedly timed out unrelated 5s/15s SQLite tests when
    // two files shared its constrained disk and CPU, while each passed well
    // within its unchanged limit in isolation. Keep file execution serial;
    // assertions and per-test timeouts remain unchanged.
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true,
  },
});
