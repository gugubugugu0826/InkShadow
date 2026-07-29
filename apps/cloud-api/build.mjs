import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["fastify", "pg", "zod"],
  format: "esm",
  legalComments: "none",
  outfile: "dist/cloud-api.mjs",
  platform: "node",
  sourcemap: true,
  target: "node24",
});
