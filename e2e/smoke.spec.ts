import { expect, test } from "@playwright/test";
import { controlReset } from "./helpers.js";

// Shared webServer knobs are process-global; smoke must not inherit
// whatever scripts earlier tests configured.
test.beforeEach(async () => {
  await controlReset();
});

test("board empty state, brand, actor default, no page errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("/");

  // Empty state may be populated by other desktop tests sharing the DB; tolerate both
  const emptyVisible = await page
    .getByText("No scopes yet — open the first one.")
    .isVisible()
    .catch(() => false);
  if (emptyVisible) {
    await expect(
      page.getByText("No scopes yet — open the first one."),
    ).toBeVisible();
  } else {
    await expect(page.locator(".board").first()).toBeVisible();
  }
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

  const emptyVisible = await page
    .getByText("No scopes yet — open the first one.")
    .isVisible()
    .catch(() => false);
  if (emptyVisible) {
    await expect(
      page.getByText("No scopes yet — open the first one."),
    ).toBeVisible();
  } else {
    await expect(page.locator(".board").first()).toBeVisible();
  }
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
