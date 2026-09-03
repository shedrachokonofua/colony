// Defect 2: the new-scope composer bound its fields to live() values, so the
// shell's 2.5s refresh poll forced the DOM value back and wiped the half-typed
// project/title/goal. Each field now holds an internal draft that a poll
// cannot overwrite.
import { controlReset } from "./helpers.js";
import { expect, test } from "@playwright/test";

// Three polls at 2.5s: the wipe only happens on a repaint, and one poll can
// slip between two refreshes.
const THREE_POLLS_MS = 8000;

test.describe("new-scope composer draft survives the refresh poll", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("a typed project name is still in the field after three polls", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/?demo=1#/new");
    // The route carries no ?project=, so the composer renders the free input
    // rather than the fixed-project link.
    const input = page.locator('input[name="project"]');
    await expect(input).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".composer-fixed")).toHaveCount(0);

    const typed = `draft-project-${Date.now()}`;
    await input.fill(typed);
    await expect(input).toHaveValue(typed);

    // The field keeps focus the whole time: a focused input is the case the
    // old live() binding broke worst, because the caret jumped too.
    await page.waitForTimeout(THREE_POLLS_MS);

    await expect(input).toHaveValue(typed);
    await expect(input).toBeFocused();

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
