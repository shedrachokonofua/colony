import {
  controlPatch,
  controlReset,
  createProjectViaApi,
  createScopeViaApiAndWaitForPlan,
  pollScope,
  waitForTaskState,
} from "./helpers.js";
import { expect, test, type APIRequestContext } from "@playwright/test";

const HEADERS = { "X-Actor-Id": "human:op-1" };

test.describe("console project running tab", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") test.skip();
    await controlReset();
  });

  test("running tab persists in the hash and a row deep-links to its task", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const name = `running-proj-${Date.now()}`;
    const mergedTitle = `Merged scope ${Date.now()}`;
    const runningTitle = `Running scope ${Date.now()}`;
    await createProjectViaApi(request, { name });

    // Seed a fully merged scope FIRST while the implementer runs freely: its
    // tasks must reach a terminal state and stay out of the running list.
    const mergedScopeId = await createScopeViaApiAndWaitForPlan(request, {
      title: mergedTitle,
      goal: `Merged scope goal ${Date.now()}`,
      approvals: "manual",
      project: name,
    });
    const mergedTaskId = await driveScopeToMerged(request, mergedScopeId);

    // Hold the implementer's developer runs open so the running fixture task
    // stays "running" (with a run whose status is "running") for the whole
    // assertion instead of racing the fake engine's own state advances. The
    // merged scope above is already terminal, so this cannot disturb it.
    await controlPatch(request, { implementerStall: true });

    const runningScopeId = await createScopeViaApiAndWaitForPlan(request, {
      title: runningTitle,
      goal: `Running scope goal ${Date.now()}`,
      approvals: "manual",
      project: name,
    });
    const approve = await request.post(
      `/scopes/${encodeURIComponent(runningScopeId)}/approve-plan`,
      { headers: HEADERS },
    );
    expect(approve.ok(), `approve-plan ${approve.status()}`).toBeTruthy();
    const runningTaskId = await waitForTaskState(
      request,
      runningScopeId,
      "running",
    );
    const runningTaskTitle = await taskTitle(request, runningTaskId);

    // The held-open run must be visible as status "running".
    await expect
      .poll(
        async () => {
          const data = await pollScope(request, runningScopeId);
          return (
            data.runs.find((r) => r.task_id === runningTaskId)?.status ?? ""
          );
        },
        { timeout: 30000, intervals: [250, 500, 1000] },
      )
      .toBe("running");

    try {
      // 1. The project page renders the tab bar with both tabs and Running is
      //    not selected by default.
      await page.goto(`/#/project/${encodeURIComponent(name)}`);
      const tablist = page.locator(
        'nav.tabs[role="tablist"][aria-label="Project sections"]',
      );
      await expect(tablist).toBeVisible({ timeout: 15000 });
      const scopesTab = tablist.getByRole("tab", { name: "Scopes" });
      const runningTab = tablist.getByRole("tab", { name: "Running" });
      await expect(scopesTab).toBeVisible();
      await expect(runningTab).toBeVisible();
      await expect(runningTab).not.toHaveAttribute("aria-selected", "true");

      // 2. Clicking Running switches to the running view and the hash picks
      //    up ?tab=running; the choice survives a reload.
      await runningTab.click();
      await expect(page).toHaveURL(
        new RegExp(`#/project/${encodeURIComponent(name)}\\?tab=running$`),
      );
      await expect(page.locator(".project-running")).toBeVisible({
        timeout: 15000,
      });
      await page.reload();
      await expect(page).toHaveURL(
        new RegExp(`#/project/${encodeURIComponent(name)}\\?tab=running$`),
      );
      await expect(page.locator(".project-running")).toBeVisible({
        timeout: 15000,
      });

      // 4. The merged task's scope never appears in the running list (both
      //    fake scopes name their tasks "Task A", so key on the scope title).
      const runningList = page.locator(".running-list");
      await expect(runningList).toBeVisible({ timeout: 15000 });
      await expect(
        runningList.locator(".running-row", { hasText: mergedTitle }),
      ).toHaveCount(0);

      // 3. The seeded running row shows its scope and task titles, and
      //    activating it opens that scope's sheet with the task selected.
      const row = runningList.locator(".running-row", {
        hasText: runningTitle,
      });
      await expect(row).toHaveCount(1, { timeout: 15000 });
      await expect(row).toContainText(runningTaskTitle);
      await expect(row.locator('span[data-state="running"]')).toContainText(
        "running",
      );
      // Click the row body (not the scope chip, which stopPropagation-navigates
      // to the scope alone) so the task selection deep-link is exercised.
      await row.locator(".running-main").click();
      await expect
        .poll(() => page.url(), { timeout: 30000, intervals: [250, 500] })
        .toMatch(new RegExp(`#/${runningScopeId}$`));
      await expect(page.locator(".sheet-head").first()).toBeVisible({
        timeout: 15000,
      });
      const drawer = page.locator(
        "aside.drawer[role=dialog][aria-label='Task detail']",
      );
      await expect(drawer).toBeVisible({ timeout: 15000 });
      // The sheet's detail loads after navigation; poll until the drawer names
      // this fixture task.
      await expect
        .poll(
          async () =>
            await drawer
              .locator(".drawer-id")
              .first()
              .textContent()
              .then((t) => t ?? ""),
          { timeout: 15000, intervals: [250, 500] },
        )
        .toContain(runningTaskId);
      await expect(drawer.locator(".chip").first()).toContainText("running");
    } finally {
      await controlPatch(request, { implementerStall: false });
    }

    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});

async function taskTitle(
  request: APIRequestContext,
  taskId: string,
): Promise<string> {
  const r = await request.get(`/tasks/${encodeURIComponent(taskId)}`, {
    headers: HEADERS,
  });
  expect(r.ok(), `GET task ${r.status()} for ${taskId}`).toBeTruthy();
  const data = (await r.json()) as { task: { title: string } };
  return data.task.title;
}

/**
 * Drive every task of a scope to "merged" through the control/API surface
 * only: approve the plan, then repeatedly wait for the next open MR and
 * approve its merge until no non-terminal task remains. The fake architect
 * produces two dependent tasks, so the merge approvals run in sequence.
 * Returns the id of the last task merged.
 */
async function driveScopeToMerged(
  request: APIRequestContext,
  scopeId: string,
): Promise<string> {
  const approve = await request.post(
    `/scopes/${encodeURIComponent(scopeId)}/approve-plan`,
    { headers: HEADERS },
  );
  expect(approve.ok(), `approve-plan ${approve.status()}`).toBeTruthy();
  let lastMerged = "";
  for (;;) {
    const openTask = await waitForTaskState(request, scopeId, "mr_open", 90000);
    const approveMerge = await request.post(
      `/tasks/${encodeURIComponent(openTask)}/approve-merge`,
      { headers: HEADERS },
    );
    expect(
      approveMerge.ok(),
      `approve-merge ${approveMerge.status()} ${await approveMerge.text()}`,
    ).toBeTruthy();
    await expect
      .poll(
        async () => {
          const data = await pollScope(request, scopeId);
          return data.tasks.find((t) => t.id === openTask)?.state ?? "";
        },
        { timeout: 30000, intervals: [500, 1000] },
      )
      .toBe("merged");
    lastMerged = openTask;
    const data = await pollScope(request, scopeId);
    const remaining = data.tasks.filter(
      (t) => t.state !== "merged" && t.state !== "canceled",
    );
    if (remaining.length === 0) return lastMerged;
    // Any remaining tasks are dependents that only dispatch after the current
    // merge lands; loop to merge them too.
  }
}