// @ts-nocheck
import {
  controlReset,
  createProjectFileViaApi,
  createProjectViaApi,
  createScopeViaApi,
} from "./helpers.js";
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
    await expect(page.locator(".pager-range")).toHaveText("1–25 of 28", {
      timeout: 15000,
    });
    await expect(page.locator(".project-card").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator(".project-card", { hasText: "Operator console" }),
    ).toBeHidden();

    const page1Names = await page.locator(".project-card").allTextContents();

    // 2. Click Next → URL #/?page=2 and distinct set of rows.
    await page.locator(".board-pager a", { hasText: "Next" }).click();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(page.locator(".project-card").first()).toBeVisible({
      timeout: 15000,
    });
    // The card set repaints asynchronously after the hash change; poll until
    // the rendered rows differ from page 1.
    await expect
      .poll(
        () =>
          page
            .locator(".project-card")
            .allTextContents()
            .then((names) => names.join()),
        { timeout: 15000 },
      )
      .not.toEqual(page1Names.join());

    // 3. Homepage back/forward/refresh preserve the page.
    await page.goBack();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(".project-card").first()).toBeVisible({
      timeout: 15000,
    });
    await page.goForward();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(
      page.locator(".project-card", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(
      page.locator(".project-card", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });

    // 4. The demo project is pinned on homepage page 2; open it.
    await page
      .locator(".project-card", { hasText: "Operator console" })
      .click();
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

  test("the archived toggle leaves the demo index untouched", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/?demo=1#/");
    await expect(page.locator(".pager-range")).toHaveText("1–25 of 28", {
      timeout: 15000,
    });
    await page.getByRole("button", { name: "Show archived" }).click();
    // No demo project is archived, so the pager and the cards are unchanged.
    await expect(page.locator(".pager-range")).toHaveText("1–25 of 28", {
      timeout: 15000,
    });
    await expect(page.locator(".archived-section")).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(page.locator(".project-card")).toHaveCount(25);
    await page.getByRole("button", { name: "Hide archived" }).click();
    await expect(page.locator(".pager-range")).toHaveText("1–25 of 28", {
      timeout: 15000,
    });

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
    await expect(page.locator(".project-card").first()).toBeVisible({
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

  // Migrated from the frozen e2e/console-desktop.spec.ts:1268 and
  // e2e/console-mobile.spec.ts:271 demo assertions, which expected the
  // always-open context textarea as the project page's default view. The
  // spec requires a preview-first rail everywhere, demo included.
  test("demo project page renders offline with preview-first brief", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/?demo=1#/project/Operator%20console");
    await expect(
      page.locator(".board-title", { hasText: "Operator console" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".scope-card").first()).toBeVisible({
      timeout: 15000,
    });
    // The stored brief renders as Markdown on the Settings tab, not as an
    // open editor.
    await page.getByRole("tab", { name: "Settings" }).click();
    const knowledge = page
      .locator(".project-settings .card", { hasText: "Project knowledge" })
      .first();
    await expect(knowledge.locator(".knowledge-preview")).toContainText(
      "no-build lit-html",
      { timeout: 15000 },
    );
    await expect(page.locator('textarea[name="project-context"]')).toHaveCount(
      0,
    );
    // The editor still opens on demand and prefills from the stored doc.
    await page.getByRole("button", { name: "Edit brief" }).click();
    await expect(page.locator('textarea[name="project-context"]')).toHaveValue(
      /no-build lit-html/,
      { timeout: 15000 },
    );

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});

test.describe("console projects (live)", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("index cards, new project flow, manage files, fixed composer", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const name = `e2e-proj-${Date.now()}`;
    await createProjectViaApi(request, {
      name,
      context_doc: "# Workspace brief\n\nOperator-owned.",
    });
    const fileId = await createProjectFileViaApi(request, name, {
      filename: "AGENTS.md",
      media_type: "text/markdown",
      content: "# Agents\n\nWork here.",
    });
    await createProjectFileViaApi(request, name, {
      filename: "conventions.md",
      media_type: "text/markdown",
      content: "# Conventions\n\nNo CDNs.",
    });

    // 1. Index shows the project card with brief + file count + repos summary.
    await page.goto("/#/");
    await expect(page.locator(".project-index").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("link", { name: "New project" })).toBeVisible();
    // New project is the index's only primary action — New scope lives on the
    // project page. The index must not offer it at all.
    await expect(page.getByRole("link", { name: "New scope" })).toHaveCount(0);
    await expect(page.locator(".board-head a.btn-solid")).toHaveText(
      "New project",
    );
    const card = page.locator(".project-card", { hasText: name }).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator(".project-card-name")).toHaveText(name);
    await expect(card.locator(".project-card-knowledge")).toContainText(
      "Brief",
    );
    await expect(card.locator(".project-card-knowledge")).toContainText(
      "2 reference files",
    );

    // 2. New project flow: POST and route to project page.
    await page.getByRole("link", { name: "New project" }).click();
    await expect(page).toHaveURL(/#\/new-project$/);
    const freshName = `fresh-${Date.now()}`;
    await page.locator('input[name="name"]').fill(freshName);
    await page.locator('textarea[name="context_doc"]').fill("A fresh brief.");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/project/${encodeURIComponent(freshName)}$`),
    );
    await expect(
      page.locator(".board-title", { hasText: freshName }),
    ).toBeVisible({ timeout: 15000 });

    // 3. Project page: scopes rack by default, Settings tab with brief preview.
    await page.goto(`/#/project/${encodeURIComponent(name)}`);
    await expect(page.locator(".board-title", { hasText: name })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("tab", { name: "Settings" }).click();
    await expect(page.locator(".project-settings")).toBeVisible({
      timeout: 15000,
    });
    const knowledgeCard = page
      .locator(".project-settings .card", { hasText: "Project knowledge" })
      .first();
    await expect(knowledgeCard).toBeVisible();
    await expect(knowledgeCard.getByText("Workspace brief")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit brief" }),
    ).toBeVisible();
    // The always-open textarea must not be the default view.
    await expect(page.locator('textarea[name="project-context"]')).toHaveCount(
      0,
    );

    // 4. Open New scope with the project fixed and assert the composer locks it.
    await page.getByRole("link", { name: "New scope" }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/new\\?project=${encodeURIComponent(name)}$`),
    );
    const fixed = page.locator(".composer-fixed").first();
    await expect(fixed).toBeVisible({ timeout: 15000 });
    await expect(fixed).toContainText(name);
    await expect(page.locator('input[name="project"]')).toHaveCount(0);
    const goalText = `Fixed composer goal ${Date.now()}`;
    await page.locator('textarea[name="goal"]').fill(goalText);
    await page.locator('input[name="path"]').fill("so/console-e2e");
    await page.getByRole("button", { name: "Open scope" }).click();
    await expect
      .poll(() => page.url(), { timeout: 30000, intervals: [500, 1000] })
      .toMatch(/#\/col-/);
    // The scope belongs to the project.
    await expect
      .poll(
        async () => {
          const r = await request.get(
            `/scopes/${encodeURIComponent(page.url().match(/#\/(col-[a-z0-9]+)/)?.[1] ?? "")}`,
            { headers: { "X-Actor-Id": "human:op-1" } },
          );
          if (!r.ok()) return "";
          const data = (await r.json()) as {
            scope: { project_name: string | null };
          };
          return data.scope.project_name ?? "";
        },
        { timeout: 15000, intervals: [500] },
      )
      .toBe(name);

    // 5. Manage files: add/replace/delete + rail refresh.
    await page.goto(`/#/project/${encodeURIComponent(name)}/files`);
    await expect(
      page.locator(".board-title", { hasText: "files" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("AGENTS.md").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("conventions.md").first()).toBeVisible();
    // Replace AGENTS.md content/media type.
    await page
      .locator(".file-row", { hasText: "AGENTS.md" })
      .getByRole("button", { name: "Replace" })
      .click();
    await page
      .locator(".file-row", { hasText: "AGENTS.md" })
      .locator('select[name="media_type"]')
      .selectOption("text/plain");
    await page
      .locator(".file-row", { hasText: "AGENTS.md" })
      .locator('textarea[name="content"]')
      .fill("Replaced content.");
    await page
      .locator(".file-row", { hasText: "AGENTS.md" })
      .getByRole("button", { name: "Replace file" })
      .click();
    await expect(
      page
        .locator(".file-row", { hasText: "AGENTS.md" })
        .getByText("text/plain"),
    ).toBeVisible({ timeout: 15000 });
    // Add a file.
    await page.locator('input[name="filename"]').fill("notes.txt");
    await page.locator('select[name="media_type"]').selectOption("text/plain");
    await page.locator('textarea[name="content"]').fill("Notes here.");
    await page.getByRole("button", { name: "Add file" }).click();
    await expect(page.getByText("notes.txt").first()).toBeVisible({
      timeout: 15000,
    });
    // Delete a file behind a confirm step.
    await page
      .locator(".file-row", { hasText: "notes.txt" })
      .getByRole("button", { name: "Delete" })
      .click();
    const confirmDelete = page
      .locator(".file-row", { hasText: "notes.txt" })
      .getByRole("button", { name: "Confirm delete" });
    await expect(confirmDelete).toBeVisible({ timeout: 5000 });
    await confirmDelete.click();
    await expect(page.getByText("notes.txt")).toHaveCount(0, {
      timeout: 15000,
    });

    // 6. The Settings tab shows the file list after mutations.
    await page.goto(`/#/project/${encodeURIComponent(name)}`);
    await page.getByRole("tab", { name: "Settings" }).click();
    const rail = page.locator(".project-settings").first();
    await expect(rail).toBeVisible({ timeout: 15000 });
    await expect(rail.getByText("AGENTS.md").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(rail.getByText("conventions.md").first()).toBeVisible();

    // 7. Unknown project shows the honest empty state.
    await page.goto("/#/project/No%20Such%20Project");
    await expect(page.getByText(/No project named/)).toBeVisible({
      timeout: 15000,
    });

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
    void fileId;
  });

  test("archived projects: hidden by default, revealed read-only by the toggle", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const name = `e2e-arch-${Date.now()}`;
    await createProjectViaApi(request, { name });
    const liveName = `e2e-live-${Date.now()}`;
    await createProjectViaApi(request, { name: liveName });
    const archive = await request.post(
      `/projects/${encodeURIComponent(name)}/archive`,
      { headers: { "X-Actor-Id": "human:op-1" } },
    );
    expect(archive.ok(), `POST archive ${archive.status()}`).toBeTruthy();

    // 1. Default index hides the archived project.
    await page.goto("/#/");
    const liveCard = page
      .locator(".project-card", { hasText: liveName })
      .first();
    await expect(liveCard).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".project-card", { hasText: name })).toHaveCount(
      0,
      { timeout: 15000 },
    );

    // 2. Show archived reveals it read-only, with an Unarchive action.
    await page.getByRole("button", { name: "Show archived" }).click();
    const archivedCard = page
      .locator(".project-card.is-archived", { hasText: name })
      .first();
    await expect(archivedCard).toBeVisible({ timeout: 15000 });
    await expect(archivedCard.locator(".chip")).toContainText("Archived");
    await expect(
      archivedCard.getByRole("button", { name: "Unarchive" }),
    ).toBeVisible();
    // Live rows keep rendering as cards beside the archived section.
    await expect(liveCard).toBeVisible({ timeout: 15000 });

    // 3. Its project page shows the archived banner + Unarchive, and drops
    //    the New scope action (read-only).
    await page.goto(`/#/project/${encodeURIComponent(name)}`);
    await expect(page.locator(".banner-archived")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator(".banner-archived")).toContainText("Archived");
    await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New scope" })).toHaveCount(0);

    // 4. Unarchive from the list returns it to the default list.
    await page.goto("/#/");
    await page.getByRole("button", { name: "Show archived" }).click();
    await page
      .locator(".project-card.is-archived", { hasText: name })
      .first()
      .getByRole("button", { name: "Unarchive" })
      .click();
    await expect(
      page.locator(".project-card.is-archived", { hasText: name }),
    ).toHaveCount(0, { timeout: 15000 });
    // Hiding archived projects again still lists it: it is live now.
    await page.getByRole("button", { name: "Hide archived" }).click();
    await expect(
      page.locator(".project-card", { hasText: name }).first(),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".archived-section")).toHaveCount(0, {
      timeout: 15000,
    });
    // The banner is gone once it is live again.
    await page.goto(`/#/project/${encodeURIComponent(name)}`);
    await expect(page.locator(".banner-archived")).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(page.getByRole("link", { name: "New scope" })).toBeVisible({
      timeout: 15000,
    });

    // 5. Archive is a two-step confirm on a live project.
    await page.getByRole("button", { name: "Archive project" }).click();
    const confirmArchive = page.getByRole("button", {
      name: "Confirm archive",
    });
    await expect(confirmArchive).toBeVisible({ timeout: 15000 });
    await confirmArchive.click();
    await expect(page.locator(".banner-archived")).toBeVisible({
      timeout: 15000,
    });
    await page.goto("/#/");
    await expect(page.locator(".project-card", { hasText: name })).toHaveCount(
      0,
      { timeout: 15000 },
    );

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });

  test("index pagination with live projects", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // Create 26 projects so the index pages (25/page).
    for (let i = 0; i < 26; i++) {
      await createProjectViaApi(request, {
        name: `page-proj-${i}-${Date.now()}`,
      });
    }
    await page.goto("/#/");
    await expect(page.locator(".pager-range")).toHaveText(/of \d+/, {
      timeout: 15000,
    });
    await expect(page.locator(".project-card").first()).toBeVisible({
      timeout: 15000,
    });
    await page.locator(".board-pager a", { hasText: "Next" }).click();
    await expect(page).toHaveURL(/#\/\?page=2$/);
    await expect(page.locator(".project-card").first()).toBeVisible({
      timeout: 15000,
    });
    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});

test.describe("console projects (mobile)", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "mobile") test.skip();
    await controlReset();
  });

  test("mobile: one-column cards and rack, no horizontal overflow", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const name = `mobile-proj-${Date.now()}`;
    await createProjectViaApi(request, { name });
    await createProjectFileViaApi(request, name, {
      filename: "AGENTS.md",
      media_type: "text/markdown",
      content: "# Agents",
    });
    await createScopeViaApi(request, {
      title: `mobile-scope-${Date.now()}`,
      goal: "Mobile scope for rack layout",
      approvals: "manual",
      project: name,
    });

    // Index: one-column project cards.
    await page.goto("/#/");
    await expect(page.locator(".project-cards").first()).toBeVisible({
      timeout: 15000,
    });
    const cardCols = await page.evaluate(() => {
      const el = document.querySelector(".project-cards") as HTMLElement | null;
      return el ? getComputedStyle(el).gridTemplateColumns : "";
    });
    const cardTracks = cardCols.trim().split(/\s+/).filter(Boolean);
    expect(cardTracks.length, `cards grid: ${cardCols}`).toBe(1);
    await assertNoHorizontalOverflow(page);

    // Project page: scopes rack by default; Settings tab stacks its cards.
    await page.goto(`/#/project/${encodeURIComponent(name)}`);
    await page.getByRole("tab", { name: "Settings" }).click();
    await expect(page.locator(".project-settings").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("No brief yet.").first()).toBeVisible({
      timeout: 15000,
    });
    const layoutCols = await page.evaluate(() => {
      const el = document.querySelector(
        ".project-settings",
      ) as HTMLElement | null;
      return el ? getComputedStyle(el).gridTemplateColumns : "";
    });
    const layoutTracks = layoutCols.trim().split(/\s+/).filter(Boolean);
    expect(layoutTracks.length, `settings grid: ${layoutCols}`).toBe(1);
    await page.getByRole("tab", { name: "Scopes" }).click();
    // The scopes rack stacks to one column on mobile.
    const rackCols = await page.evaluate(() => {
      const el = document.querySelector(".rack") as HTMLElement | null;
      return el ? getComputedStyle(el).gridTemplateColumns : "";
    });
    const rackTracks = rackCols.trim().split(/\s+/).filter(Boolean);
    expect(rackTracks.length, `rack grid: ${rackCols}`).toBe(1);
    await assertNoHorizontalOverflow(page);

    // Manage files route on mobile.
    await page.goto(`/#/project/${encodeURIComponent(name)}/files`);
    await expect(page.getByText("AGENTS.md").first()).toBeVisible({
      timeout: 15000,
    });
    await assertNoHorizontalOverflow(page);

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});

async function assertNoHorizontalOverflow(
  page: import("@playwright/test").Page,
) {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
}
