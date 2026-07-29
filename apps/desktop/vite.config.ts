import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const ENTRY_CHUNK_BUDGET_BYTES = 300 * 1024;
const ASYNC_CHUNK_BUDGET_BYTES = 500 * 1024;
const CSS_ASSET_BUDGET_BYTES = 128 * 1024;
const WORKER_ASSET_BUDGET_BYTES = 1_536 * 1024;
const GENERAL_ASSET_BUDGET_BYTES = 2 * 1024 * 1024;
const TOTAL_FRONTEND_BUDGET_BYTES = 6 * 1024 * 1024;

function enforceDesktopBundlePolicy(): Plugin {
  return {
    name: "inkshadow-desktop-bundle-policy",
    apply: "build",
    generateBundle(_options, bundle) {
      let totalBytes = 0;
      for (const output of Object.values(bundle)) {
        if (output.fileName.endsWith(".map")) {
          throw new Error(`Source map ${output.fileName} must not ship in a desktop release.`);
        }
        if (output.type === "chunk") {
          const bytes = Buffer.byteLength(output.code, "utf8");
          totalBytes += bytes;
          const maximum = output.isEntry ? ENTRY_CHUNK_BUDGET_BYTES : ASYNC_CHUNK_BUDGET_BYTES;
          const nearBudget = bytes > maximum * 0.9;
          const largestModules = nearBudget
            ? Object.entries(output.modules)
                .map(([moduleId, details]) => ({
                  moduleId,
                  bytes: details.renderedLength,
                }))
                .sort((left, right) => right.bytes - left.bytes)
                .slice(0, 8)
                .map(
                  ({ moduleId, bytes: moduleBytes }) =>
                    `${moduleId.replaceAll("\\", "/")} (${String(moduleBytes)} bytes)`,
                )
                .join(", ")
            : "";
          if (bytes > maximum) {
            throw new Error(
              `${output.fileName} is ${String(bytes)} bytes and exceeds its ${String(maximum)} byte desktop release budget. Largest modules: ${largestModules}`,
            );
          }
          if (nearBudget) {
            this.warn(
              `${output.fileName} uses ${String(bytes)} of ${String(maximum)} allowed bytes. Largest modules: ${largestModules}`,
            );
          }
          continue;
        }
        const bytes =
          typeof output.source === "string"
            ? Buffer.byteLength(output.source, "utf8")
            : output.source.byteLength;
        totalBytes += bytes;
        const maximum = output.fileName.endsWith(".css")
          ? CSS_ASSET_BUDGET_BYTES
          : output.fileName.includes(".worker.")
            ? WORKER_ASSET_BUDGET_BYTES
            : GENERAL_ASSET_BUDGET_BYTES;
        if (bytes > maximum) {
          throw new Error(
            `${output.fileName} is ${String(bytes)} bytes and exceeds its ${String(maximum)} byte desktop asset budget.`,
          );
        }
      }
      if (totalBytes > TOTAL_FRONTEND_BUDGET_BYTES) {
        throw new Error(
          `The desktop frontend is ${String(totalBytes)} bytes and exceeds its ${String(TOTAL_FRONTEND_BUDGET_BYTES)} byte total release budget.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), enforceDesktopBundlePolicy()],
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
        find: "@inkshadow/import-export/docx-export",
        replacement: fileURLToPath(
          new URL("../../packages/import-export/src/docx-export.ts", import.meta.url),
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
        find: "@inkshadow/observability",
        replacement: fileURLToPath(
          new URL("../../packages/observability/src/index.ts", import.meta.url),
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
        find: "@inkshadow/sync-core",
        replacement: fileURLToPath(
          new URL("../../packages/sync-core/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@inkshadow/ui",
        replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
      },
    ],
  },
  clearScreen: false,
  // Only product-owned, explicitly public build variables may cross into the WebView bundle.
  // In particular, TAURI_SIGNING_* and unrelated VITE_* values must remain native/build-only.
  envPrefix: ["VITE_INKSHADOW_"],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    // Do not ship readable application source alongside commercial desktop bundles.
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          const normalizedModuleId = moduleId.replaceAll("\\", "/");
          if (
            normalizedModuleId.includes("/node_modules/react/") ||
            normalizedModuleId.includes("/node_modules/react-dom/") ||
            normalizedModuleId.includes("/node_modules/react-router/") ||
            normalizedModuleId.includes("/node_modules/react-router-dom/") ||
            normalizedModuleId.includes("/node_modules/scheduler/")
          ) {
            return "react-shell-runtime";
          }
          if (
            normalizedModuleId.includes("/apps/desktop/src/infrastructure/") &&
            [
              "/cloud-",
              "/project-key-",
              "/tauri-cloud-",
              "/sync-",
              "/incoming-content-",
              "/marketplace-",
              "/outgoing-content-",
              "/content-sync-",
              "/studio-review-",
              "/studio-team-",
            ].some((marker) => normalizedModuleId.includes(marker))
          ) {
            return "desktop-cloud-orchestration";
          }
          if (
            normalizedModuleId.includes("/apps/desktop/src/infrastructure/") &&
            [
              "/authoritative-extraction-",
              "/desktop-close-",
              "/development-",
              "/generation-",
              "/fine-tuning-",
              "/governed-creative-",
              "/ideation-",
              "/material-storage",
              "/model-center-",
              "/model-routing-",
              "/multi-agent-",
              "/native-authoritative-",
              "/native-embedding-",
              "/native-governed-",
              "/project-search",
              "/story-graph-",
              "/story-storage",
              "/task-center-",
            ].some((marker) => normalizedModuleId.includes(marker))
          ) {
            return "desktop-local-orchestration";
          }
          if (
            normalizedModuleId.includes("commonjsHelpers.js") ||
            normalizedModuleId.includes("commonjs-dynamic-modules")
          ) {
            return "commonjs-runtime";
          }
          if (normalizedModuleId.includes("/packages/domain/")) {
            return "domain-runtime";
          }
          if (normalizedModuleId.includes("/packages/application/")) {
            return "application-runtime";
          }
          if (normalizedModuleId.includes("/packages/contracts/")) {
            return "contracts-runtime";
          }
          if (normalizedModuleId.includes("/packages/data/src/schema")) {
            return "data-schema-runtime";
          }
          if (
            normalizedModuleId.includes("/packages/data/src/access-sqlite-store") ||
            normalizedModuleId.includes("/packages/data/src/cloud-deletion-journal-sqlite-store") ||
            normalizedModuleId.includes("/packages/data/src/project-key-sqlite-store") ||
            normalizedModuleId.includes("/packages/data/src/sync-")
          ) {
            return "data-cloud-runtime";
          }
          if (normalizedModuleId.includes("/packages/data/")) {
            return "data-runtime";
          }
          if (normalizedModuleId.includes("/packages/story-core/")) {
            return "story-runtime";
          }
          if (normalizedModuleId.includes("/packages/sync-core/")) {
            return "sync-runtime";
          }
          if (normalizedModuleId.includes("/node_modules/jszip/")) {
            return "zip-runtime";
          }
          if (normalizedModuleId.includes("/node_modules/pdfjs-dist/")) {
            return "pdf-import";
          }
          if (
            normalizedModuleId.includes("/node_modules/@xmldom/") ||
            normalizedModuleId.includes("/node_modules/xmlbuilder/")
          ) {
            return "docx-xml";
          }
          if (normalizedModuleId.includes("/node_modules/mammoth/")) {
            return "docx-import";
          }
          return undefined;
        },
      },
    },
  },
});
