// Defect 5: the duration clock was gated on "the operator is not editing", so
// a running run's duration froze the moment a textarea took focus — the ticker
// stopped, or its repaint was skipped, for as long as the operator typed. The
// clock now runs whenever a live duration is on screen, editing or not.
import { controlReset } from "./helpers.js";
import { expect, test } from "@playwright/test";

const FOCUS_HOLD_MS = 6000;
// Six seconds of holding focus, minus a second of slack for the first tick's
// phase: the duration must have advanced, not merely repainted once.
const MIN_ADVANCE_S = 4;

/**
 * Parse the text content of a <run-duration> element into seconds.
 * formatDuration produces:
 * - "<1s" -> 0
 * - `${s}s` -> s
 * - `${m}m ${s}s` -> m * 60 + s
 * - `${h}h ${m}m` -> h * 3600 + m * 60
 */
function parseDurationSec(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "<1s") return 0;
  const secMatch = /^(\d+)s$/.exec(trimmed);
  if (secMatch) return Number(secMatch[1]);
  const minSecMatch = /^(\d+)m\s+(\d+)s$/.exec(trimmed);
  if (minSecMatch) return Number(minSecMatch[1]) * 60 + Number(minSecMatch[2]);
  const hourMinMatch = /^(\d+)h\s+(\d+)m$/.exec(trimmed);
  if (hourMinMatch)
    return Number(hourMinMatch[1]) * 3600 + Number(hourMinMatch[2]) * 60;
  throw new Error(`unrecognized duration format: "${text}"`);
}

test.describe("a live duration keeps running while the operator types", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("the drawer's run duration advances across six focused seconds", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    // The demo scope carries a perpetually running merge-gate run on its
    // mr_open task, so the sheet mounts a live duration.
    await page.goto("/?demo=1#/col-a1b2c3d4");
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });
    const hits = page.locator("rect.node-hit[role=button]");
    await expect(hits.first()).toBeVisible({ timeout: 15000 });
    await hits.nth(1).click();
    const drawer = page.locator("aside.drawer[role=dialog]");
    await expect(drawer).toBeVisible({ timeout: 15000 });

    const duration = drawer.locator("run-duration").first();
    await expect(duration).toBeVisible({ timeout: 15000 });
    await expect(duration).toHaveText(/^(<1s|\d+s|\d+m\s+\d+s|\d+h\s+\d+m)$/);
    const before = parseDurationSec(await duration.innerText());

    // Focus a textarea and hold it: this is the state that used to freeze the
    // clock.
    const textarea = drawer.locator('textarea[name="feedback"]').first();
    await expect(textarea).toBeVisible({ timeout: 15000 });
    await textarea.focus();
    await expect(textarea).toBeFocused();

    await page.waitForTimeout(FOCUS_HOLD_MS);

    await expect(textarea).toBeFocused();
    await expect(duration).toHaveText(/^(<1s|\d+s|\d+m\s+\d+s|\d+h\s+\d+m)$/);
    const after = parseDurationSec(await duration.innerText());
    expect(
      after - before,
      `duration froze while editing: ${before}s → ${after}s`,
    ).toBeGreaterThanOrEqual(MIN_ADVANCE_S);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
