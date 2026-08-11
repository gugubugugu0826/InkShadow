import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: "../../.tmp/vite-infrastructure-cache",
  resolve: {
    alias: [
      {
        find: "@inkshadow/ai-core",
        replacement: fileURLToPath(new URL("../../packages/ai-core/src/index.ts", import.meta.url)),
      },
      {
        find: "@inkshadow/data",
        replacement: fileURLToPath(new URL("../../packages/data/src/index.ts", import.meta.url)),
      },
      {
        find: "@inkshadow/domain",
        replacement: fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)),
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
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/infrastructure/model-hub-exact-evaluation-target.test.ts",
      "src/infrastructure/novel-skill-paid-blind-review-service.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-archived-project.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-control-sqlite-store.integration.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-control-sqlite-store.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-lazy-coordinator.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-payload-authority.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-runner.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-sqlite-store.integration.test.ts",
      "src/infrastructure/novel-skill-paid-evaluation-sqlite-store.test.ts",
    ],
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true,
  },
});
