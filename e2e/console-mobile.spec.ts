// @ts-nocheck
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { controlReset } from "./helpers.js";

function mobileOnly(
  args: { browserName: string },
  testInfo: { project: { name: string } },
) {
  return testInfo.project.name !== "mobile" || args.browserName !== "chromium";
}

async function assertMobileViewport(page: Page) {
  const vp = page.viewportSize();
  expect(vp?.width).toBe(390);
  expect(vp?.height).toBeGreaterThan(600);
  expect(vp?.height).toBeLessThanOrEqual(844);
}

async function assertNoHorizontalOverflow(page: Page) {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    overflow.scrollWidth,
    `scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.innerWidth + 1);
}

async function assertBoardSingleColumn(page: Page) {
  const cols = await page.evaluate(() => {
    const el = document.querySelector(".board") as HTMLElement | null;
    return el ? getComputedStyle(el).gridTemplateColumns : "";
  });
  const tracks = cols.trim().split(/\s+/).filter(Boolean);
  expect(tracks.length, `board gridTemplateColumns: ${cols}`).toBe(1);
}

async function assertSheetColsSingleColumn(page: Page) {
  const cols = await page.evaluate(() => {
    const el = document.querySelector(".sheet-cols") as HTMLElement | null;
    return el ? getComputedStyle(el).gridTemplateColumns : "";
  });
  const tracks = cols.trim().split(/\s+/).filter(Boolean);
  expect(tracks.length, `sheet-cols gridTemplateColumns: ${cols}`).toBe(1);
}

async function waitForScopeDetail(page: Page, scopeId: string) {
  await expect
    .poll(
      async () => {
        const hash = await page.evaluate(() => location.hash);
        const hasScope = await page
          .locator(".goal, .sheet-head")
          .first()
          .isVisible()
          .catch(() => false);
        return hash.includes(scopeId) && hasScope;
      },
      { timeout: 30000 },
    )
    .toBe(true);
}

async function createScopeViaApi(
  page: Page,
  opts: { title?: string; goal: string; path?: string; approvals?: string },
) {
  const title =
    opts.title ??
    `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const goal = opts.goal;
  const repoPath = opts.path ?? "so/console-e2e";
  const res = await page.request.post("/scopes", {
    headers: {
      "X-Actor-Id": "human:op-1",
      "content-type": "application/json",
    },
    data: {
      title,
      goal,
      approvals: opts.approvals as unknown as "auto" | "manual" | undefined,
      repo: { path: repoPath },
    },
  });
  expect(res.ok(), `POST /scopes ${res.status()} ${await res.text()}`).toBe(
    true,
  );
  const body = (await res.json()) as {
    id: string;
    title: string;
    goal: string;
  };
  return body;
}

test.describe("console mobile", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "mobile") test.skip();
    // The webServer's scripted knobs are process-global: start every test
    // from boot defaults so ordering cannot leak stalls/failure scripts.
    await controlReset();
  });

  test.afterAll(async () => {
    const tmp = process.env.COLONY_E2E_TMP_DIR;
    if (!tmp) return;
    const dbPath = join(tmp, "console.db");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec("DELETE FROM task_deps");
      db.exec("DELETE FROM observations");
      db.exec("DELETE FROM run_events");
      db.exec("DELETE FROM runs");
      db.exec("DELETE FROM tasks");
      // audit has append-only trigger — temporarily drop it
      try {
        db.exec("DROP TRIGGER IF EXISTS audit_no_delete");
        db.exec("DROP TRIGGER IF EXISTS audit_no_update");
      } catch {}
      db.exec("DELETE FROM audit");
      db.exec("DELETE FROM scopes");
      db.exec(
        "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END",
      );
      db.exec(
        "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END",
      );
      db.exec("PRAGMA foreign_keys=ON");
      db.close();
    } catch {
      // best-effort cleanup for smoke empty-state isolation
    }
  });

  test("empty state on mobile shows placeholder within viewport", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");
    await assertMobileViewport(page);
    await expect(page.locator(".board").first()).toBeVisible({
      timeout: 15000,
    });

    const emptyMsg = page.getByText("No scopes yet — open the first one.");
    const hasEmpty = (await emptyMsg.count()) > 0;
    if (hasEmpty) {
      await expect(emptyMsg.first()).toBeVisible({ timeout: 15000 });
      await expect(emptyMsg.first()).toBeInViewport({ timeout: 15000 });
    } else {
      await page.route("**/scopes?*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ scopes: [], total: 0, limit: 25, offset: 0 }),
        }),
      );
      await page.reload();
      await expect(emptyMsg.first()).toBeVisible({ timeout: 15000 });
      await expect(emptyMsg.first()).toBeInViewport({ timeout: 15000 });
      await page.unroute("**/scopes?*");
    }
    await assertNoHorizontalOverflow(page);
    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("error state on mobile shows banner within viewport", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");
    await assertMobileViewport(page);
    await expect(page.locator(".board").first()).toBeVisible({
      timeout: 15000,
    });
    await page.route("**/scopes*", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "PROVIDER_UNREACHABLE", message: "502 Bad Gateway" },
        }),
      }),
    );
    await page.goto("/");
    const banner = page.locator(".banner-error[role=alert]").first();
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toBeInViewport({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
    await page.unroute("**/scopes*");
    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("responsive board at 390x844: single column, crumbs hidden, no overflow", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");
    await assertMobileViewport(page);

    await expect(page.locator(".board").first()).toBeVisible({
      timeout: 15000,
    });
    await assertBoardSingleColumn(page);
    // crumbs hidden via @media (max-width:900px) { .crumbs { display:none } }
    await expect(page.locator(".crumbs")).toBeHidden({ timeout: 15000 });
    const boardSidePosition = await page.evaluate(() => {
      const el = document.querySelector(".board-side") as HTMLElement | null;
      return el ? getComputedStyle(el).position : "";
    });
    expect(boardSidePosition).toBe("static");
    await expect(page.getByRole("link", { name: "New scope" })).toBeVisible();
    await expect(page.locator(".rack-empty, .scope-card").first()).toBeVisible({
      timeout: 15000,
    });
    await assertNoHorizontalOverflow(page);

    const scope = await createScopeViaApi(page, {
      title: `board-scope-${Date.now()}`,
      goal: "board overflow check goal — verify responsive layout on detail",
    });
    await page.goto(`/#/${scope.id}`);
    await expect(page.locator(".sheet-cols").first()).toBeVisible({
      timeout: 15000,
    });
    await assertSheetColsSingleColumn(page);
    await assertNoHorizontalOverflow(page);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("touch navigation: New scope, create, card, DAG drawer", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");
    await assertMobileViewport(page);
    await expect(page.locator(".board").first()).toBeVisible({
      timeout: 15000,
    });

    const newScopeLink = page.getByRole("link", { name: "New scope" });
    await expect(newScopeLink).toBeVisible({ timeout: 15000 });
    await newScopeLink.tap();

    await expect(page).toHaveURL(/#\/new/, { timeout: 15000 });
    const titleInput = page.locator('input[name="title"]');
    const goalInput = page.locator('textarea[name="goal"]');
    const pathInput = page.locator('input[name="path"]');
    await expect(titleInput).toBeVisible({ timeout: 15000 });
    await expect(goalInput).toBeVisible({ timeout: 15000 });
    await expect(pathInput).toBeVisible({ timeout: 15000 });

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    await titleInput.tap();
    await titleInput.fill(`Mobile Touch ${uniq}`);
    await goalInput.tap();
    await goalInput.fill(
      `Touch creation goal ${uniq} — verify tap-fill and submit`,
    );
    await pathInput.tap();
    await pathInput.fill("so/console-e2e");

    const submit = page.getByRole("button", { name: "Open scope" });
    await expect(submit).toBeVisible({ timeout: 15000 });
    await submit.tap();

    await expect
      .poll(
        async () => {
          const h = await page.evaluate(() => location.hash);
          return h.startsWith("#/") && !h.includes("#/new") ? h : "";
        },
        { timeout: 30000 },
      )
      .toMatch(/^#\/col-/);
    const hash = await page.evaluate(() => location.hash);
    const scopeId = hash.replace(/^#\//, "");
    expect(scopeId).toMatch(/^col-/);
    await waitForScopeDetail(page, scopeId);
    await assertNoHorizontalOverflow(page);

    await page.goto("/");
    await expect(page.locator(".board").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator(".scope-card").first()).toBeVisible({
      timeout: 30000,
    });
    const card = page.locator(".scope-card").first();
    await card.tap();
    await expect
      .poll(async () => await page.evaluate(() => location.hash), {
        timeout: 15000,
      })
      .toMatch(/#\//);
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });

    await expect
      .poll(async () => await page.locator("rect.node-hit").count(), {
        timeout: 30000,
      })
      .toBeGreaterThan(0);
    const nodeHit = page.locator("rect.node-hit").first();
    await expect(nodeHit).toBeVisible({ timeout: 15000 });
    await nodeHit.tap();

    const drawer = page.locator(".drawer[role='dialog']").first();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    const closeBtn = page.locator('button[aria-label="Close task detail"]');
    await expect(closeBtn).toBeVisible({ timeout: 15000 });
    await closeBtn.tap();
    await expect(drawer).toBeHidden({ timeout: 15000 });

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("scope detail on mobile: stacked cards, replan form, validation", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    const scope = await createScopeViaApi(page, {
      title: `detail-${Date.now()}`,
      goal: `Detail stacking goal ${Date.now()} — verify Goal Plan Validation stack`,
      approvals: "manual",
    });
    await page.goto(`/#/${scope.id}`);
    await assertMobileViewport(page);
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });

    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const el = document.querySelector(".sheet-cols");
            return el ? getComputedStyle(el).gridTemplateColumns : "";
          }),
        { timeout: 30000 },
      )
      .toBeTruthy();
    await assertSheetColsSingleColumn(page);

    await expect(page.locator(".card").first()).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () => await page.locator(".sheet-cols .card").count(), {
        timeout: 30000,
      })
      .toBeGreaterThanOrEqual(2);

    const goalCard = page
      .locator(".sheet-cols .card", { hasText: "Goal" })
      .first();
    const planCard = page
      .locator(".sheet-cols .card", { hasText: "Plan" })
      .first();
    await expect(goalCard).toBeVisible({ timeout: 15000 });
    // plan may take a tick to appear
    await expect(planCard).toBeVisible({ timeout: 30000 });

    await goalCard.scrollIntoViewIfNeeded();
    await expect(goalCard).toBeInViewport({ timeout: 15000 });
    await planCard.scrollIntoViewIfNeeded();
    await expect(planCard).toBeInViewport({ timeout: 15000 });

    const stacked = await page.evaluate(() => {
      const cards = [
        ...document.querySelectorAll(".sheet-cols .card"),
      ] as HTMLElement[];
      if (cards.length < 2) return false;
      const rects = cards.map((c) => c.getBoundingClientRect());
      for (let i = 1; i < rects.length; i++) {
        if (rects[i].top < rects[i - 1].bottom - 5) return false;
      }
      return true;
    });
    expect(stacked, "cards should stack vertically").toBe(true);

    const feedbackArea = page.locator('textarea[name="feedback"]').first();
    await expect(feedbackArea).toBeVisible({ timeout: 30000 });
    await feedbackArea.tap();
    const feedbackText = `Replan feedback ${Date.now()} — please revise`;
    await feedbackArea.fill(feedbackText);
    const replanBtn = page.getByRole("button", { name: "Request replan" });
    await expect(replanBtn).toBeVisible({ timeout: 15000 });
    await replanBtn.tap();

    const history = page.locator(".plan-history");
    await expect(history).toBeVisible({ timeout: 30000 });
    await expect(history.getByText(feedbackText.slice(0, 20))).toBeVisible({
      timeout: 30000,
    });

    // Validation list criteria are visible once acceptance_json exists (after plan) or in validating.
    // For manual planning scopes, acceptance_json is null until materialize; validation card is hidden then.
    // Our detail scope is still in planning with acceptance_json=null, so the validation card may be absent.
    // Assert either: validation list visible OR plan still present (validation will appear post-approve).
    const validationCount = await page.locator(".validation-list li").count();
    if (validationCount > 0) {
      const validationCard = page
        .locator(".card", { hasText: "Validation" })
        .first();
      await expect(validationCard).toBeVisible({ timeout: 15000 });
      await validationCard.scrollIntoViewIfNeeded();
      await expect(validationCard).toBeInViewport({ timeout: 15000 });
      await expect(page.locator(".validation-desc").first()).toBeVisible({
        timeout: 15000,
      });
    } else {
      // create a scope that has validation available to prove criteria visibility on mobile
      const vScope = await createScopeViaApi(page, {
        title: `validation-${Date.now()}`,
        goal: `Validation visibility ${Date.now()}`,
      });
      await page.goto(`/#/${vScope.id}`);
      await expect
        .poll(async () => await page.locator(".validation-list li").count(), {
          timeout: 30000,
        })
        .toBeGreaterThan(0);
      const vCard = page.locator(".card", { hasText: "Validation" }).first();
      await expect(vCard).toBeVisible({ timeout: 15000 });
      await vCard.scrollIntoViewIfNeeded();
      await expect(vCard).toBeInViewport({ timeout: 15000 });
      await expect(page.locator(".validation-desc").first()).toBeVisible({
        timeout: 15000,
      });
      await assertNoHorizontalOverflow(page);
      // navigate back to original for overflow check context
      await page.goto(`/#/${scope.id}`);
    }

    await assertNoHorizontalOverflow(page);
    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("plan action on mobile: approve plan materializes DAG", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    const scope = await createScopeViaApi(page, {
      title: `approve-${Date.now()}`,
      goal: `Approve plan goal ${Date.now()} — DAG nodes materialize`,
      approvals: "manual",
    });
    await page.goto(`/#/${scope.id}`);
    await assertMobileViewport(page);
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });

    const approveBtn = page.getByRole("button", { name: "Approve plan" });
    await expect(approveBtn).toBeVisible({ timeout: 30000 });
    await approveBtn.tap();

    await expect
      .poll(async () => await page.locator("rect.node-hit").count(), {
        timeout: 30000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const hash = location.hash.replace(/^#\/?/, "");
            if (!hash || hash === "new") return "";
            const res = await fetch(`/scopes/${encodeURIComponent(hash)}`, {
              headers: { "X-Actor-Id": "human:op-1" },
            });
            if (!res.ok) return "";
            const data = (await res.json()) as {
              scope?: { status?: string };
            };
            return data.scope?.status ?? "";
          }),
        { timeout: 30000 },
      )
      .toBe("active");

    const statusChip = page.locator(".sheet-head-side .chip").first();
    await expect(statusChip).toHaveText(/active/, { timeout: 15000 });

    await assertNoHorizontalOverflow(page);
    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("confirmation flow on mobile: abandon scope", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(mobileOnly({ browserName }, testInfo), "mobile only");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    const scope = await createScopeViaApi(page, {
      title: `abandon-${Date.now()}`,
      goal: `Abandon scope goal ${Date.now()} — confirmation flow`,
      approvals: "manual",
    });
    await page.goto(`/#/${scope.id}`);
    await assertMobileViewport(page);
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });

    const abandonBtn = page.getByRole("button", { name: "Abandon scope" });
    await expect(abandonBtn).toBeVisible({ timeout: 15000 });
    await abandonBtn.tap();

    const confirmBtn = page.getByRole("button", { name: "Confirm abandon" });
    await expect(confirmBtn).toBeVisible({ timeout: 15000 });

    const statusBefore = await page
      .locator(".sheet-head-side .chip")
      .first()
      .innerText();
    expect(statusBefore).not.toMatch(/abandoned/);

    await confirmBtn.tap();

    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const hash = location.hash.replace(/^#\/?/, "");
            if (!hash || hash === "new") return "";
            const res = await fetch(`/scopes/${encodeURIComponent(hash)}`, {
              headers: { "X-Actor-Id": "human:op-1" },
            });
            if (!res.ok) return "";
            const data = (await res.json()) as {
              scope?: { status?: string };
            };
            return data.scope?.status ?? "";
          }),
        { timeout: 30000 },
      )
      .toBe("abandoned");

    await expect(page.locator(".sheet-head-side .chip").first()).toHaveText(
      /abandoned/,
      { timeout: 15000 },
    );

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
