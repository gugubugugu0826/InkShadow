import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@inkshadow/contracts/states": fileURLToPath(
        new URL("../contracts/src/states.ts", import.meta.url),
      ),
      "@inkshadow/domain": fileURLToPath(new URL("../domain/src/index.ts", import.meta.url)),
      "@inkshadow/search-core": fileURLToPath(
        new URL("../search-core/src/index.ts", import.meta.url),
      ),
      "@inkshadow/story-core": fileURLToPath(
        new URL("../story-core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
