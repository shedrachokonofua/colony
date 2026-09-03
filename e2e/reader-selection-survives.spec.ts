// Defect 4: the markdown reader re-rendered on every refresh, and rewriting
// its DOM throws away the operator's text selection. <markdown-reader> now
// renders only when the markdown string actually changes, so a poll that
// re-sends the same text leaves the DOM — and the selection — alone.
import {
  controlReset,
  firstTextSurvived,
  markFirstText,
  selectFirstText,
  selectionLength,
} from "./helpers.js";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The spec's floor (3s) is two 2.5s refresh polls plus slack, and the shell
// also repaints on its 1s duration clock while a live run is on screen.
const HOLD_MS = 5000;
const READER = ".knowledge-preview markdown-reader";

test.describe("markdown reader keeps the operator's selection", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("a selection inside the reader survives the refresh poll", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await openBriefReader(page);

    const selected = await page.evaluate(selectFirstText, [
      READER,
      20,
    ] satisfies [string, number]);
    expect(selected, "the brief must render selectable text").toBeGreaterThan(
      0,
    );
    // Remember the selected node as well as the selection: a poll that
    // rebuilt the subtree from the same markdown could restore an identical
    // selection length while still dropping the operator's scroll position.
    expect(await page.evaluate(markFirstText, READER)).toBe(true);

    await page.waitForTimeout(HOLD_MS);

    // The selection, and the exact text behind it: a reader that re-rendered
    // into different nodes leaves the operator with nothing selected.
    await expect
      .poll(() => page.evaluate(selectionLength), { timeout: 5000 })
      .toBe(selected);
    await expect(page.evaluate(firstTextSurvived, READER)).resolves.toBe(true);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("a selection in the task spec reader survives the refresh poll", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    // The drawer's spec <pre> is the other text surface a poll repaints; it
    // renders the identical string, which is exactly the case the old
    // unconditional re-render broke.
    await page.goto("/?demo=1#/col-a1b2c3d4");
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });
    await page.locator("rect.node-hit[role=button]").nth(2).click();
    await expect(page.locator("aside.drawer[role=dialog]")).toBeVisible({
      timeout: 15000,
    });
    const spec = page.locator("aside.drawer pre.spec");
    await expect(spec).toBeVisible({ timeout: 15000 });

    const selected = await page.evaluate(selectFirstText, [
      "aside.drawer pre.spec",
      20,
    ] satisfies [string, number]);
    expect(selected, "the spec must render selectable text").toBeGreaterThan(0);
    expect(await page.evaluate(markFirstText, "aside.drawer pre.spec")).toBe(
      true,
    );

    await page.waitForTimeout(HOLD_MS);

    await expect(
      page.evaluate(firstTextSurvived, "aside.drawer pre.spec"),
    ).resolves.toBe(true);

    await expect
      .poll(() => page.evaluate(selectionLength), { timeout: 5000 })
      .toBe(selected);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});

/** The brief's read-only preview, the surface the poll re-feeds unchanged. */
async function openBriefReader(page: Page): Promise<void> {
  await page.goto("/?demo=1#/project/Operator%20console");
  await expect(
    page.locator(".board-title", { hasText: "Operator console" }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.locator(READER)).toBeVisible({ timeout: 15000 });
}
