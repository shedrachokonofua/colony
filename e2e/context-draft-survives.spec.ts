// Defect 1: the project brief editor was bound to live(contextDoc), so the
// shell's 2.5s refresh poll rewrote textarea.value and threw away whatever the
// operator was typing. The draft now lives on the element, and the incoming
// doc is adopted only when it actually changed and the textarea is not focused.
import { controlReset } from "./helpers.js";
import { expect, test } from "@playwright/test";

// Three polls at 2.5s: a single poll could pass by landing between two
// refreshes, and the defect only bites on the repaint that follows one.
const THREE_POLLS_MS = 8000;

test.describe("project brief draft survives the refresh poll", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    // Scripted knobs are process-global; start every test at boot defaults.
    await controlReset();
  });

  test("typed brief text is still in the editor after three polls", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/?demo=1#/project/Operator%20console");
    await expect(
      page.locator(".board-title", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });

    // The editor lives on the Settings tab behind Edit brief.
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Edit brief" }).click();
    const textarea = page.locator('textarea[name="project-context"]');
    await expect(textarea).toBeVisible({ timeout: 15000 });

    const typed = `Draft in flight ${Date.now()}: poll must not eat this.`;
    await textarea.fill(typed);
    // Blur: the editor must hold the draft on its own, not only while the
    // caret sits in it.
    await textarea.blur();
    await expect(textarea).toHaveValue(typed);

    await page.waitForTimeout(THREE_POLLS_MS);

    await expect(textarea).toHaveValue(typed);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
