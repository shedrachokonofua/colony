import { controlReset } from "./helpers.js";
import { expect, test } from "@playwright/test";

test.describe("console projects (demo)", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("homepage paging, back/forward/refresh, project pin on page 2", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // 1. Page 1 of the homepage project list.
    await page.goto("/?demo=1#/");
    await expect(page.locator(".pager-range")).toHaveText("1–25 of 27", {
      timeout: 15000,
    });
    await expect(page.locator(".project-row").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator(".project-row", { hasText: "Operator console" }),
    ).toBeHidden();

    const page1Names = await page.locator(".project-row").allTextContents();

    // 2. Click Next → URL #/?page=2 and distinct set of rows.
    await page.locator(".board-pager a", { hasText: "Next" }).click();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(page.locator(".project-row").first()).toBeVisible({
      timeout: 15000,
    });
    const page2Names = await page.locator(".project-row").allTextContents();
    expect(page2Names.join()).not.toEqual(page1Names.join());

    // 3. Homepage back/forward/refresh preserve the page.
    await page.goBack();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(".project-row").first()).toBeVisible({
      timeout: 15000,
    });
    await page.goForward();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(
      page.locator(".project-row", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(
      page.locator(".project-row", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });

    // 4. The demo project is pinned on homepage page 2; open it.
    await page.locator(".project-row", { hasText: "Operator console" }).click();
    await expect(page).toHaveURL(/#\/project\/Operator%20console$/);

    // 5. Project page: title, pager (27 > 25), page-1 scope cards, col-d25 not on page 1.
    await expect(
      page.locator(".board-title", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".board-pager")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".scope-card").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator(".scope-card", { hasText: "Demo scope 25" }),
    ).toBeHidden();

    // 6. Scopes Next → page 2 starts at col-d25.
    await page.locator(".board-pager a", { hasText: "Next" }).click();
    await expect(page).toHaveURL(/#\/project\/Operator%20console\?page=2$/);
    const firstCard = page.locator(".scope-card").first();
    await expect(firstCard).toContainText("col-d25");
    await expect(firstCard).toContainText("Demo scope 25");

    // 7. Project-level back/forward/refresh.
    await page.goBack();
    await expect(page).toHaveURL(/#\/project\/Operator%20console$/);
    await expect(
      page.locator(".scope-card", { hasText: "Demo scope 25" }),
    ).toBeHidden({ timeout: 15000 });
    await expect(page.locator(".scope-card").first()).toBeVisible({
      timeout: 15000,
    });
    await page.goForward();
    await expect(page).toHaveURL(/#\/project\/Operator%20console\?page=2$/);
    await expect(
      page.locator(".scope-card", { hasText: "Demo scope 25" }),
    ).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(page).toHaveURL(/#\/project\/Operator%20console\?page=2$/);
    await expect(
      page.locator(".scope-card", { hasText: "Demo scope 25" }),
    ).toBeVisible({ timeout: 15000 });

    // 8. Click col-d25 → scope sheet with crumbs.
    await page.locator(".scope-card", { hasText: "Demo scope 25" }).click();
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("Demo goal 25").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator("nav.crumbs")).toContainText("Projects");
    await expect(page.locator("nav.crumbs")).toContainText("Operator console");
    await expect(page.locator("nav.crumbs")).toContainText("col-d25");
    await expect(
      page.locator('nav.crumbs a[href="#/project/Operator%20console"]'),
    ).toBeVisible();

    // 9. Back → page-2 scope list with col-d25 re-rendered.
    await page.goBack();
    await expect(page).toHaveURL(/#\/project\/Operator%20console\?page=2$/);
    await expect(
      page.locator(".scope-card", { hasText: "Demo scope 25" }),
    ).toBeVisible({ timeout: 15000 });

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("out-of-range pages route back to page 1", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // Homepage page 99 → notice with a working link to page 1.
    await page.goto("/?demo=1#/?page=99");
    await expect(page.getByText("Past the last page.")).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("link", { name: "Back to page 1" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(".project-row").first()).toBeVisible({
      timeout: 15000,
    });

    // Project page 99 → notice routes back to project page 1.
    await page.goto("/?demo=1#/project/Operator%20console?page=99");
    await expect(page.getByText("Past the last page.")).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("link", { name: "Back to page 1" }).click();
    await expect(page).toHaveURL(/#\/project\/Operator%20console$/);
    await expect(page.locator(".scope-card").first()).toBeVisible({
      timeout: 15000,
    });

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
