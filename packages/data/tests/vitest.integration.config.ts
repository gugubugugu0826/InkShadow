import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  resolve: {
    alias: {
      "@inkshadow/application": fileURLToPath(
        new URL("../../application/src/index.ts", import.meta.url),
      ),
      "@inkshadow/contracts/states": fileURLToPath(
        new URL("../../contracts/src/states.ts", import.meta.url),
      ),
      "@inkshadow/domain": fileURLToPath(new URL("../../domain/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
