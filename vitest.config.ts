import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    // SQLite-backed suites open temp DB files; keep file execution serial so
    // fixtures cannot stomp each other.
    fileParallelism: false,
  },
});
