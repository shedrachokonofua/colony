import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    // DB test suites (packages/db) share a single local Postgres and each
    // rebuilds the public schema on beforeAll. Running files in parallel
    // causes them to stomp each other's fixtures.
    fileParallelism: false,
  },
});
