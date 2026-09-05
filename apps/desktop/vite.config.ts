import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// v0.2.17 keeps the editor draft recovery, local summary rebuild and author-visible
// status handling on the startup path. A current Rollup graph audit found only
// production modules: no source maps, tests or duplicate framework runtimes. The
// minified entry is 349,325 bytes, so retain a bounded 352 KiB ceiling instead of
// weakening behavior solely to meet the historical 300 KiB allowance.
const ENTRY_CHUNK_BUDGET_BYTES = 352 * 1024;
// v0.2.16 adds the reviewed consistency-investigation disclosure and recovery
// states to one cohesive lazy route. The minified route is 513,065 bytes, so
// allow 520 KiB without raising the aggregate payload ceiling or weakening the
// entry, stylesheet, worker, asset, source-map, or file-count checks.
const ASYNC_CHUNK_BUDGET_BYTES = 520 * 1024;
const CSS_ASSET_BUDGET_BYTES = 128 * 1024;
const WORKER_ASSET_BUDGET_BYTES = 1_536 * 1024;
const GENERAL_ASSET_BUDGET_BYTES = 2 * 1024 * 1024;
const PDFJS_WORKER_LICENSE_BANNER = `/*!
 * @licstart The following is the entire license notice for the
 * JavaScript code in this page
 *
 * Copyright 2024 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @licend The above is the entire license notice for the
 * JavaScript code in this page
 */
/**
 * pdfjsVersion = 6.1.200
 * pdfjsBuild = 6353acefe
 */`;
// The original 6 MiB aggregate allowance grew to 6 MiB + 416 KiB for the DESIGN
// and paid Novel Skill evaluation work. The v0.2.3 Windows feedback fixes add
// authoritative routing, recoverable opening state, privacy-safe diagnostics and
// responsive editor behavior. A production graph audit found no duplicated
// runtimes, source maps, test code or dynamic modules pulled into the startup
// graph. The 2026-08-29 remediation adds durable author recovery, truthful model
// dispatch receipts and the reviewed settings workflows. A current/baseline
// Rollup audit found no duplicated runtimes, source maps or test modules; the
// verified production graph grew by 60,542 bytes. Add exactly 128 KiB to the
// aggregate allowance. v0.2.16 narrowly raised only the asynchronous-chunk
// ceiling. The audited v0.2.17 editor recovery, prompt boundary and local
// summary implementation bring the complete production graph to 7,487,568
// bytes. No source maps, tests or duplicate runtimes are present, so add exactly
// 32 KiB while continuing to count every startup and lazy chunk.
// v0.2.18: allocate 64 KiB for audited authority readbacks, lossless local
// setting review and recoverable error feedback. No dependency was added;
// per-entry/chunk/worker/CSS/file-count limits are unchanged.
const TOTAL_FRONTEND_BUDGET_BYTES = 7 * 1024 * 1024 + 224 * 1024;

function isPdfJsWorkerModule(facadeModuleId: string | null): boolean {
  return (
    facadeModuleId?.replaceAll("\\", "/").includes("/pdfjs-dist/build/pdf.worker.min.mjs") === true
  );
}

function preservePdfJsWorkerLicense(): Plugin {
  return {
    name: "inkshadow-pdfjs-worker-license",
    apply: "build",
    renderChunk: {
      order: "post",
      handler(code, chunk) {
        if (!isPdfJsWorkerModule(chunk.facadeModuleId) || code.includes("@licstart")) {
          return null;
        }
        return {
          code: `${PDFJS_WORKER_LICENSE_BANNER}\n${code}`,
          map: null,
        };
      },
    },
  };
}

function enforceDesktopBundlePolicy(): Plugin {
  return {
    name: "inkshadow-desktop-bundle-policy",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        let totalBytes = 0;
        const outputSizes: { readonly fileName: string; readonly bytes: number }[] = [];
        for (const output of Object.values(bundle)) {
          if (output.fileName.endsWith(".map")) {
            throw new Error(`Source map ${output.fileName} must not ship in a desktop release.`);
          }
          if (output.type === "chunk") {
            const bytes = Buffer.byteLength(output.code, "utf8");
            totalBytes += bytes;
            outputSizes.push({ fileName: output.fileName, bytes });
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
          outputSizes.push({ fileName: output.fileName, bytes });
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
          const largestOutputs = outputSizes
            .sort((left, right) => right.bytes - left.bytes)
            .slice(0, 12)
            .map(({ fileName, bytes }) => `${fileName} (${String(bytes)} bytes)`)
            .join(", ");
          throw new Error(
            `The desktop frontend is ${String(totalBytes)} bytes and exceeds its ${String(TOTAL_FRONTEND_BUDGET_BYTES)} byte total release budget. Largest outputs: ${largestOutputs}`,
          );
        }
      },
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
  worker: {
    plugins: () => [preservePdfJsWorkerLicense()],
    rollupOptions: {
      output: {
        banner: ({ facadeModuleId }) =>
          isPdfJsWorkerModule(facadeModuleId) ? PDFJS_WORKER_LICENSE_BANNER : "",
      },
    },
  },
  build: {
    modulePreload: false,
    target: "es2022",
    // Do not ship readable application source alongside commercial desktop bundles.
    sourcemap: false,
    cssMinify: "lightningcss",
    minify: "terser",
    terserOptions: {
      ecma: 2022,
      // Runtime diagnostics capture real component call stacks. Keep only the
      // route-boundary names needed to identify those frames in minified builds.
      keep_fnames:
        /^(?:AppErrorBoundary|DesktopPersistenceBoundary|DesktopRoutes|EditorPage|SettingsRouteBoundary)$/u,
      // Rollup's production chunks are ECMAScript modules. Declaring that fact lets
      // Terser safely optimize module-scoped bindings without property mangling.
      module: true,
      compress: {
        // Additional passes are semantics-preserving and recover repeated helper
        // patterns across the large desktop orchestration chunks.
        ecma: 2022,
        passes: 3,
        toplevel: true,
      },
      format: {
        ecma: 2022,
      },
      mangle: {
        toplevel: true,
      },
    },
    rollupOptions: {
      output: {
        // Merge very small route fragments so their import/export wrappers and
        // duplicated bootstrap code do not dominate the installed application.
        experimentalMinChunkSize: 160_000,
        generatedCode: "es2015",
        manualChunks(moduleId) {
          const normalizedModuleId = moduleId.replaceAll("\\", "/");
          // The store is an ordinary runtime dependency shared by the root
          // runtime and the dynamically loaded authoritative readiness check.
          // Give that real shared dependency its own counted startup chunk so
          // Rollup does not hoist its full implementation into the entry.
          if (normalizedModuleId.endsWith("/apps/desktop/src/infrastructure/model-hub-store.ts")) {
            return "model-hub-store-runtime";
          }
          if (
            [
              "/apps/desktop/src/infrastructure/consistency-investigation-query-plan.ts",
              "/apps/desktop/src/infrastructure/consistency-investigation-service.ts",
              "/apps/desktop/src/infrastructure/consistency-investigation-store.ts",
              "/apps/desktop/src/infrastructure/consistency-investigation-tool-registry.ts",
            ].some((modulePath) => normalizedModuleId.endsWith(modulePath))
          ) {
            return "consistency-investigation-runtime";
          }
          if (
            normalizedModuleId.endsWith(
              "/apps/desktop/src/infrastructure/consistency-repair-candidate-service.ts",
            )
          ) {
            return "consistency-repair-candidate-runtime";
          }
          if (
            normalizedModuleId.includes(
              "/apps/desktop/src/infrastructure/continuous-story-state-",
            ) ||
            normalizedModuleId.endsWith(
              "/apps/desktop/src/infrastructure/model-hub-continuous-story-state-model.ts",
            )
          ) {
            return "continuous-story-runtime";
          }
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
            normalizedModuleId.includes("/project-search")
          ) {
            return "desktop-search-runtime";
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
          return undefined;
        },
      },
    },
  },
});
