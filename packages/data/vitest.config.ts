import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@inkshadow/search-core": fileURLToPath(
        new URL("../search-core/src/index.ts", import.meta.url),
      ),
      "@inkshadow/story-core": fileURLToPath(
        new URL("../story-core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
