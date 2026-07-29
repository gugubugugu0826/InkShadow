import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: [
      {
        find: "@inkshadow/ui/styles.css",
        replacement: fileURLToPath(
          new URL("../../packages/ui/src/styles/index.css", import.meta.url),
        ),
      },
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
  clearScreen: false,
  envPrefix: ["VITE_INKSHADOW_WEB_"],
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
};
