import { expect, test } from "@playwright/test";
import { controlReset } from "./helpers.js";

// Shared webServer knobs are process-global; smoke must not inherit
// whatever scripts earlier tests configured.
test.beforeEach(async () => {
  await controlReset();
});

test("project list empty state, brand, actor default, no page errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("/");

  // The index renders before /projects lands, and other suites sharing the
  // DB may have populated it, so the settled state is empty OR rows.
  // Assert the disjunction in one retrying expectation: snapshotting with
  // isVisible() first picked a state that this assertion then outlived.
  await expect(page.locator(".rack-empty, .project-row").first()).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator(".brand", { hasText: "COLONY" }).first(),
  ).toBeVisible();

  const actor = page.locator('input[name="actor"]');
  await expect(actor).toBeVisible();
  await expect(actor).toHaveValue("human:op-1");

  await expect(page.locator(".board").first()).toBeVisible();

  expect(errors, `uncaught pageerror: ${errors.join("; ")}`).toEqual([]);
});

test("mobile — page loads and the board is visible within the 390x844 viewport", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("/");

  await expect(page.locator(".rack-empty, .project-row").first()).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator(".brand", { hasText: "COLONY" }).first(),
  ).toBeVisible();
  await expect(page.locator(".board").first()).toBeVisible();

  if (testInfo.project.name === "mobile") {
    const viewport = page.viewportSize();
    expect(viewport?.width).toBe(390);
    // iPhone 12 viewport is 390x664 (screen 390x844); Chromium keeps that mapping.
    expect(viewport?.height).toBeGreaterThan(600);
    expect(viewport?.height).toBeLessThanOrEqual(844);
  }

  expect(errors, `uncaught pageerror: ${errors.join("; ")}`).toEqual([]);
});
