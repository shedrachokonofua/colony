// Operator amendment: two integration defects the modular cutover introduced
// that no unit test could see, because both only bite once the modules are
// wired into the running shell.
//
// 1. The shell's render references <colony-topbar> and <colony-signin>, but
//    neither module was imported for side effects: the browser never defined
//    the elements, so the topbar (and with it the actor input) stayed empty.
// 2. <run-line> inherited the monolith's CSS contract — the row is the
//    monolith's div.run, styled at styles.css .run — and the port drifted off
//    the class, leaving run history rows unstyled.
import {
  computedLayout,
  controlReset,
  customElementDefined,
} from "./helpers.js";
import { expect, test } from "@playwright/test";

const RUN_ROW = "aside.drawer run-line .run";

test.describe("cutover wiring the module graph cannot prove", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("the topbar renders its actor input", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/?demo=1#/");
    const topbar = page.locator("header.topbar");
    await expect(topbar).toBeVisible({ timeout: 15000 });

    // The element must be upgraded, not merely present: an unimported module
    // leaves the tag in the DOM with nothing rendered inside it.
    await expect(
      topbar.locator("a.brand", { hasText: "COLONY" }),
    ).toBeVisible();
    await expect(topbar.locator("nav.crumbs")).toBeVisible();

    const actor = topbar.locator('input[name="actor"]');
    await expect(actor).toBeVisible();
    await expect(actor).toHaveValue("human:op-1");

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("the sign-in element is defined for OIDC deployments", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/?demo=1#/");
    await expect(page.locator("header.topbar")).toBeVisible({
      timeout: 15000,
    });
    // No OIDC config in demo mode, so the card is not rendered — but the
    // custom element it names must be defined or the OIDC branch would render
    // an inert tag.
    await expect
      .poll(() => page.evaluate(customElementDefined, "colony-signin"))
      .toBe(true);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("run rows carry the styled .run class", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    // The demo scope's mr_open task owns two runs, so its drawer lists rows.
    await page.goto("/?demo=1#/col-a1b2c3d4");
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });
    const hits = page.locator("rect.node-hit[role=button]");
    await expect(hits.first()).toBeVisible({ timeout: 15000 });
    await hits.nth(1).click();
    const drawer = page.locator("aside.drawer[role=dialog]");
    await expect(drawer).toBeVisible({ timeout: 15000 });

    const rows = page.locator(RUN_ROW);
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    expect(await rows.count()).toBeGreaterThan(0);

    // The class only earns its place if styles.css actually styles it: a
    // renamed class would still be "present" while the row lost its flex
    // layout.
    const layout = await page.evaluate(computedLayout, RUN_ROW);
    expect(layout, `no run row at ${RUN_ROW}`).not.toBeNull();
    expect(layout?.display, `run row lost its layout: ${layout?.display}`).toBe(
      "flex",
    );
    expect(layout?.align).toBe("baseline");
    expect(layout?.gap).not.toBe("normal");

    // The status dot is the other half of the .run contract.
    const dot = rows.first().locator("i");
    await expect(dot).toBeVisible();
    const dotBox = await dot.boundingBox();
    expect(dotBox?.width ?? 0).toBeGreaterThan(0);
    expect(dotBox?.height ?? 0).toBeGreaterThan(0);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
