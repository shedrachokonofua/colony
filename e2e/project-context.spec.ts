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

  test("scope sheet edits and persists the project context document", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    const stamp = Date.now();
    const project = `e2e-context-${stamp}`;
    const goal = `Project context editing ${stamp}`;
    await createScopeViaApi(request, {
      title: `ctx-${stamp}`,
      goal,
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

    await page.goto("/#/");
    await expect(page.locator(".board").first()).toBeVisible({
      timeout: 15000,
    });
    const card = page
      .locator(".scope-card", { hasText: `ctx-${stamp}` })
      .first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    await expect.poll(() => page.url(), { timeout: 15000 }).toMatch(/#\/col-/);

    const sheet = page.locator(".sheet-head").first();
    await expect(sheet).toBeVisible({ timeout: 15000 });
    const cardHead = page
      .locator(".card-head", { hasText: "Project context" })
      .first();
    await expect(cardHead).toBeVisible({ timeout: 15000 });

    const textarea = page.locator('textarea[name="project-context"]');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(
      "Prefer bun over npm. Postgres runs on :5433.",
    );

    const typed = `Architecture decision record ${stamp}: use bun workspaces.`;
    await textarea.fill(typed);
    await page.getByRole("button", { name: "Save context" }).click();
    await expect(page.locator(".pc-status", { hasText: "Saved." })).toBeVisible(
      { timeout: 15000 },
    );

    // The audited API holds exactly what the editor sent.
    const stored = await request.get(
      `/projects/${encodeURIComponent(project)}/context`,
      { headers: { "X-Actor-Id": ACTOR } },
    );
    expect(stored.ok()).toBeTruthy();
    await expect(stored.json()).resolves.toEqual({ context_doc: typed });

    // A reload re-reads through GET /scopes/:id -> persisted text shows.
    await page.reload();
    const textareaAfter = page.locator('textarea[name="project-context"]');
    await expect(textareaAfter).toBeVisible({ timeout: 15000 });
    await expect(textareaAfter).toHaveValue(typed);

    // Clearing stores null.
    await textareaAfter.fill("");
    await page.getByRole("button", { name: "Save context" }).click();
    await expect(page.locator(".pc-status", { hasText: "Saved." })).toBeVisible(
      { timeout: 15000 },
    );
    const cleared = await request.get(
      `/projects/${encodeURIComponent(project)}/context`,
      { headers: { "X-Actor-Id": ACTOR } },
    );
    expect(cleared.ok()).toBeTruthy();
    await expect(cleared.json()).resolves.toEqual({ context_doc: null });

    expect(errors).toEqual([]);
  });
});
