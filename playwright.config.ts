import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local quickstart: npx playwright install chromium && npm run test:e2e
// (Chromium only — never WebKit/Firefox).
// CI path: COLONY_TEST_CHROMIUM_PATH to a system Chromium.

const tmp =
  process.env.COLONY_E2E_TMP_DIR ??
  mkdtempSync(join(tmpdir(), "colony-e2e-playwright-"));
process.env.COLONY_E2E_TMP_DIR = tmp;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  fullyParallel: false,
  globalTeardown: "./e2e/teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:4477",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // @ts-expect-error — Playwright 1.62 moved executablePath to launchOptions; spec contract requires top-level
        executablePath: process.env.COLONY_TEST_CHROMIUM_PATH || undefined,
        launchOptions: {
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          executablePath: process.env.COLONY_TEST_CHROMIUM_PATH || undefined,
        },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 12"],
        browserName: "chromium" as const,
        // @ts-expect-error — Playwright 1.62 moved executablePath to launchOptions; spec contract requires top-level
        executablePath: process.env.COLONY_TEST_CHROMIUM_PATH || undefined,
        launchOptions: {
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          executablePath: process.env.COLONY_TEST_CHROMIUM_PATH || undefined,
        },
      },
    },
  ],
  webServer: {
    command: "bun run apps/colonyd/e2e/fake-colonyd.ts",
    url: "http://127.0.0.1:4477/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      COLONY_E2E_DB_PATH: join(tmp, "console.db"),
      COLONY_E2E_PORT: process.env.COLONY_E2E_PORT ?? "4477",
      COLONY_E2E_CONTROL_PORT: process.env.COLONY_E2E_CONTROL_PORT ?? "4478",
    },
  },
});
