import { controlReset, createScopeViaApi } from "./helpers.js";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

const ACTOR = "human:op-1";

async function putContext(
  request: APIRequestContext,
  project: string,
  doc: string | null,
): Promise<void> {
  const res = await request.put(
    `/projects/${encodeURIComponent(project)}/context`,
    {
      headers: { "X-Actor-Id": ACTOR },
      data: { context_doc: doc },
    },
  );
  expect(res.ok()).toBeTruthy();
}

test.describe("project context in the console", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    // Scripted knobs are process-global; start every test at boot defaults.
    await controlReset();
  });

  test("project page edits, persists, and lists the project's scopes", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    const stamp = Date.now();
    const project = `e2e-context-${stamp}`;
    await createScopeViaApi(request, {
      title: `ctx-${stamp}`,
      goal: `Project context editing ${stamp}`,
      approvals: "manual",
      project,
    });
    await page.addInitScript(() => {
      localStorage.setItem("colony.actor", "human:op-1");
    });

    // Pre-seed a doc so prefill proves the read path before typing.
    await putContext(
      request,
      project,
      "Prefer bun over npm. Postgres runs on :5433.",
    );

    await page.goto(`/#/project/${encodeURIComponent(project)}`);
    await expect(
      page.locator(".board-title", { hasText: project }),
    ).toBeVisible({
      timeout: 15000,
    });

    // The editor is behind an Edit brief button (the always-open textarea
    // is not the default view); reveal it and confirm it prefills from the
    // stored document.
    await page.getByRole("button", { name: "Edit brief" }).click();
    const textarea = page.locator('textarea[name="project-context"]');
    await expect(textarea).toBeVisible({ timeout: 15000 });
    await expect(textarea).toHaveValue(
      "Prefer bun over npm. Postgres runs on :5433.",
    );

    // The scope created above shows up as a board-identical card with a chip.
    const card = page
      .locator(".scope-card", { hasText: `ctx-${stamp}` })
      .first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator(".chip").first()).toContainText("planning");

    // Typing and saving persists through PUT /projects/:name/context.
    const typed = `Architecture decision record ${stamp}: use bun workspaces.`;
    await textarea.fill(typed);
    await page.getByRole("button", { name: "Save context" }).click();
    await expect(page.locator(".pc-status", { hasText: "Saved." })).toBeVisible(
      {
        timeout: 15000,
      },
    );
    const stored = await request.get(
      `/projects/${encodeURIComponent(project)}/context`,
      { headers: { "X-Actor-Id": ACTOR } },
    );
    expect(stored.ok()).toBeTruthy();
    await expect(stored.json()).resolves.toEqual({ context_doc: typed });

    // A reload re-reads the persisted text through GET /projects/:name.
    await page.reload();
    await page.getByRole("button", { name: "Edit brief" }).click();
    const textareaAfter = page.locator('textarea[name="project-context"]');
    await expect(textareaAfter).toHaveValue(typed, { timeout: 15000 });

    // Cards on the project page navigate to the scope sheet like the board's do.
    await card.click();
    await expect.poll(() => page.url(), { timeout: 15000 }).toMatch(/#\/col-/);
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });

    expect(errors).toEqual([]);
  });

  test("New scope from a project pins the create form's project", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    const stamp = Date.now();
    const project = `e2e-new-${stamp}`;
    await createScopeViaApi(request, {
      title: `new-${stamp}`,
      goal: `New scope prefill ${stamp}`,
      approvals: "manual",
      project,
    });
    await page.addInitScript(() => {
      localStorage.setItem("colony.actor", "human:op-1");
    });

    await page.goto(`/#/project/${encodeURIComponent(project)}`);
    await expect(
      page.locator(".board-title", { hasText: project }),
    ).toBeVisible({
      timeout: 15000,
    });

    await page.locator('a[href^="#/new?project="]').first().click();
    await expect
      .poll(() => page.url(), { timeout: 15000 })
      .toMatch(/#\/new\?project=/);
    // The project is shown as a fixed non-editable element, not a text
    // input: the operator cannot silently change it.
    const fixed = page.locator(".composer-fixed").first();
    await expect(fixed).toBeVisible({ timeout: 15000 });
    await expect(fixed).toContainText(project);
    await expect(page.locator('input[name="project"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("unknown project renders an honest empty state, not a crash", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto(`/#/project/does-not-exist-${Date.now()}`);
    await expect(page.locator(".project-page .rack-empty")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator(".project-page")).toContainText(
      "No project named",
    );

    expect(errors).toEqual([]);
  });
});
