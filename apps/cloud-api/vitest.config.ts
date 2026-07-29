import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every PostgreSQL integration suite intentionally targets the database
    // named by INKSHADOW_TEST_POSTGRES_URL. Running files in parallel would
    // let one suite truncate or migrate shared tables while another is using
    // them, producing both false passes and nondeterministic failures. CI can
    // regain parallelism by provisioning one database per Vitest process.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
  },
});
