// Defect 3: the drawer's amend/feedback textareas were one shared pair, so a
// draft typed for one task surfaced under whichever task the operator opened
// next. Drafts are now keyed by task id: switching away stashes the texts under
// the old task's id and opening another task loads its own (or empty) texts.
import { controlReset } from "./helpers.js";
import { expect, test } from "@playwright/test";

test.describe("task drawer keeps one draft per task", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("a draft typed on task A never appears on task B, and returns with A", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/?demo=1#/col-a1b2c3d4");
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });

    const hits = page.locator("rect.node-hit[role=button]");
    await expect(hits.first()).toBeVisible({ timeout: 15000 });
    // The demo scope's DAG: 0 merged, 1 mr_open (carries a feedback form as
    // well as the amend form), 2 queued.
    const taskA = hits.nth(2);
    const taskB = hits.nth(1);
    const drawer = page.locator("aside.drawer[role=dialog]");
    const close = page.locator("button.drawer-close");
    const feedback = page.locator('aside.drawer textarea[name="feedback"]');

    // 1. Task A: type a draft into its amend textarea.
    await taskA.click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(feedback).toHaveCount(1);
    const typed = `draft-for-A-${Date.now()}`;
    await feedback.first().fill(typed);
    await expect(feedback.first()).toHaveValue(typed);

    // 2. Close drawer, then click task B: assert textarea empty (B has no draft).
    await close.click();
    await expect(drawer).toBeHidden({ timeout: 5000 });
    await taskB.click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    // B is mr_open, so it carries both the feedback and the amend textarea;
    // neither may show A's draft.
    await expect(feedback).toHaveCount(2);
    for (const value of await feedback.evaluateAll((nodes) =>
      nodes.map((node) => /** @type {HTMLTextAreaElement} */ node.value),
    )) {
      expect(value, `task B inherited task A's draft: ${value}`).toBe("");
    }

    // 3. Close drawer, re-click task A: assert the textarea shows the draft typed earlier.
    await close.click();
    await expect(drawer).toBeHidden({ timeout: 5000 });
    await taskA.click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(feedback).toHaveCount(1);
    await expect(feedback.first()).toHaveValue(typed);

    // 4. A draft survives the refresh poll too: isolation is per task, not a
    //    side effect of the paint that opened the drawer.
    await page.waitForTimeout(5000);
    await expect(feedback.first()).toHaveValue(typed);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
