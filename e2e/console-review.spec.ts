// @ts-nocheck
// Review history regression: the envelope-first run rows seeded with the
// observed production shape, verified in a real browser at desktop and
// mobile widths with keyboard-operable coverage.
//
// Every review shape below is seeded by direct DB writes into the shared e2e
// database (node:sqlite DatabaseSync): the shared Playwright webServer
// (apps/colonyd/e2e/fake-colonyd.ts) boots with review mode off and tick.ts
// only dispatches review runs when review is required, so the scripted
// reviewer envelope path never runs. Scopes/tasks come from the public API;
// the six review rows are hand-written runs (kind='review').
// The seeded scope uses approvals:'manual' (the merge gate waits on
// task.merge_approved_sha) so the 250ms scheduler tick does not advance the
// hand-written review rows while they are asserted.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { controlReset } from "./helpers.js";

const ACTOR = "human:op-1";
const HEADERS = { "X-Actor-Id": ACTOR, "content-type": "application/json" };

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
const H4 = "d".repeat(40);
const H5 = "e".repeat(40);
const H6 = "f".repeat(40);

// The observed approved-review rationale: an 80+ char substantive summary.
const RATIONALE =
  "The change funnels every verdict write through a single store method and every read path follows it, so an approved review can never disagree with the merge gate.";
const RATIONALE_SNIPPET =
  "funnels every verdict write through a single store method";

// Evidence dimensions from the observed shape: per-dimension candidate
// counts (0,4,4,4). Counts overlap between dimensions, so they are not an
// additive total.
const OBSERVED_DIMENSIONS = [
  { name: "spec-compliance", spec_blind: false, target_files: [], findings: 0 },
  { name: "defect-scan", spec_blind: true, target_files: [], findings: 4 },
  { name: "test-coverage", spec_blind: true, target_files: [], findings: 4 },
  { name: "regression-risk", spec_blind: true, target_files: [], findings: 4 },
];

const OBSERVED_FINDINGS = [
  {
    severity: "minor",
    file: "packages/core/src/store.ts",
    note: "review-note-alpha single writer for verdicts",
  },
  {
    severity: "minor",
    file: "apps/colonyd/src/http.ts",
    note: "review-note-beta serialize the envelope once",
  },
  {
    severity: "minor",
    file: "apps/cli/src/commands/run.ts",
    note: "review-note-gamma read one recorded shape",
  },
  {
    severity: "minor",
    file: "packages/console/elements/run-line.js",
    note: "review-note-delta render the recorded findings",
  },
];

const OBSERVED_INSPECTED = Array.from({ length: 8 }, (_, i) => ({
  file: `src/observed-${i + 1}.ts`,
  note: `observed-inspected-note-${i + 1} checked against the spec`,
}));

const RC_NOTES = [
  "rc-note-blocker second writer remains",
  "rc-note-minor comment is noise",
];

async function assertViewport(
  page: Page,
  testInfo: { project: { name: string } },
) {
  const vp = page.viewportSize();
  const expected = testInfo.project.name === "mobile" ? 390 : 1440;
  expect(vp?.width).toBe(expected);
  if (testInfo.project.name === "mobile") {
    expect(vp?.height).toBeGreaterThan(600);
    expect(vp?.height).toBeLessThanOrEqual(844);
  }
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

async function createScopeViaApi(
  request: import("@playwright/test").APIRequestContext,
  opts: { title: string; goal: string },
): Promise<string> {
  const res = await request.post("/scopes", {
    headers: HEADERS,
    data: {
      title: opts.title,
      goal: opts.goal,
      approvals: "manual",
      repo: { path: "so/console-e2e" },
    },
  });
  expect(res.ok(), `POST /scopes ${res.status()} ${await res.text()}`).toBe(
    true,
  );
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function waitForPlan(
  request: import("@playwright/test").APIRequestContext,
  scopeId: string,
) {
  await expect
    .poll(
      async () => {
        const r = await request.get(`/scopes/${encodeURIComponent(scopeId)}`, {
          headers: HEADERS,
        });
        if (!r.ok()) return null;
        const data = (await r.json()) as {
          scope: { status: string; plan_json: string | null };
        };
        return data.scope.status === "planning" && data.scope.plan_json
          ? data.scope.plan_json
          : null;
      },
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .not.toBeNull();
}

async function taskIdsForScope(
  request: import("@playwright/test").APIRequestContext,
  scopeId: string,
): Promise<string[]> {
  const r = await request.get(`/scopes/${encodeURIComponent(scopeId)}`, {
    headers: HEADERS,
  });
  expect(r.ok()).toBeTruthy();
  const data = (await r.json()) as { tasks: { id: string }[] };
  return data.tasks.map((t) => t.id);
}

// Direct-DB seeding of the six review shapes onto one task. Returns the run
// ids for scoped cleanup. The tick never rewrites a finished review row, and
// with approvals:'manual' no merge gate advances the task while asserted.
function seedReviewRows(
  dbPath: string,
  scopeId: string,
  taskId: string,
): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys=OFF");
    const lease = new Date(Date.now() + 3600_000).toISOString();
    const base = Date.now() - 3600_000;
    const at = (offsetMs: number) =>
      new Date(base + offsetMs)
        .toISOString()
        .replace("T", " ")
        .replace("Z", "");
    const insert = db.prepare(
      `INSERT INTO runs (id, scope_id, task_id, kind, status, lease_expires_at,
        base_sha, head_sha, envelope_json, evidence_json, error,
        started_at, finished_at)
       VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows: Array<{
      status: string;
      head: string;
      envelope: unknown;
      evidence: unknown;
      error: string | null;
    }> = [
      // (1) The observed approved-review shape: evidence carries the verdict,
      // head sha, dimensions and challenged counters only; the envelope
      // carries the rationale, findings, inspected files and coverage.
      {
        status: "succeeded",
        head: H1,
        evidence: {
          verdict: "approve",
          head_sha: H1,
          dimensions: OBSERVED_DIMENSIONS,
          challenged: { reviewed: 11, dropped: 7 },
        },
        envelope: {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: RATIONALE,
          findings: OBSERVED_FINDINGS,
          inspected: OBSERVED_INSPECTED,
          dimensions: OBSERVED_DIMENSIONS,
          challenged: { reviewed: 11, dropped: 7 },
          head_sha: H1,
        },
        error: null,
      },
      // (2) A request_changes review showing its findings.
      {
        status: "succeeded",
        head: H2,
        evidence: {
          verdict: "request_changes",
          head_sha: H2,
          findings: [{ severity: "major", note: "stale evidence copy" }],
          dimensions: OBSERVED_DIMENSIONS,
          challenged: { reviewed: 2, dropped: 0 },
        },
        envelope: {
          kind: "reviewer_verdict",
          verdict: "request_changes",
          summary:
            "The reviewer rejects the change because the gate still writes the verdict twice.",
          findings: [
            {
              severity: "blocker",
              file: "apps/colonyd/src/main.ts",
              note: RC_NOTES[0],
            },
            { severity: "minor", note: RC_NOTES[1] },
          ],
          inspected: [{ file: "src/a.ts", note: "rc inspected note" }],
          dimensions: OBSERVED_DIMENSIONS,
          challenged: { reviewed: 2, dropped: 0 },
          head_sha: H2,
        },
        error: null,
      },
      // (3) An approval with zero final findings: absent list items read as
      // zero, not as missing data.
      {
        status: "succeeded",
        head: H3,
        evidence: { verdict: "approve", head_sha: H3 },
        envelope: {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary:
            "A clean approval: the diff touches one writer, every caller follows it, and the full suite passes without regressions.",
          findings: [],
          inspected: [
            { file: "src/a.ts", note: "zero-findings inspected note" },
          ],
          dimensions: OBSERVED_DIMENSIONS,
          challenged: { reviewed: 3, dropped: 3 },
          head_sha: H3,
        },
        error: null,
      },
      // (4) An evidence-only legacy row: no envelope_json at all.
      {
        status: "succeeded",
        head: H4,
        evidence: {
          verdict: "request_changes",
          head_sha: H4,
          findings: [
            {
              severity: "major",
              file: "src/legacy.ts",
              note: "legacy-evidence-note missing case",
            },
          ],
        },
        envelope: null,
        error: null,
      },
      // (5) A malformed envelope_json row falls back to evidence.
      {
        status: "succeeded",
        head: H5,
        evidence: {
          verdict: "request_changes",
          head_sha: H5,
          findings: [
            {
              severity: "major",
              file: "src/mal.ts",
              note: "malformed-evidence-note stale fallback",
            },
          ],
        },
        envelope: "{not json",
        error: null,
      },
      // (6) A failed review run with no accepted verdict. Its envelope is a
      // submission the server rejected, so it must never read as the verdict.
      {
        status: "failed",
        head: H6,
        evidence: { head_sha: H6 },
        envelope: {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary:
            "This rejected submission must never appear as the verdict on a failed run.",
          findings: [
            {
              severity: "minor",
              file: "src/x.ts",
              note: "failed-hidden-note must stay hidden",
            },
          ],
          inspected: [{ file: "src/x.ts", note: "failed inspected note" }],
          dimensions: OBSERVED_DIMENSIONS,
          challenged: { reviewed: 1, dropped: 0 },
          head_sha: H6,
        },
        error: "reviewer timed out",
      },
    ];
    const runIds: string[] = [];
    rows.forEach((row, i) => {
      const id = randomUUID();
      runIds.push(id);
      insert.run(
        id,
        scopeId,
        taskId,
        row.status,
        lease,
        row.head,
        row.head,
        row.envelope === null
          ? null
          : typeof row.envelope === "string"
            ? row.envelope
            : JSON.stringify(row.envelope),
        JSON.stringify(row.evidence),
        row.error,
        at(i * 60_000),
        row.status === "failed"
          ? at(i * 60_000 + 30_000)
          : at(i * 60_000 + 30_000),
      );
    });
    db.exec("PRAGMA foreign_keys=ON");
    return runIds;
  } finally {
    db.close();
  }
}

// Scoped cleanup: only rows belonging to this spec's scopes/tasks/runs, so
// later spec files sharing the single worker/server/DB file are unaffected.
function cleanupSeeded(pool: {
  scopes: string[];
  tasks: string[];
  runs: string[];
}) {
  const tmp = process.env.COLONY_E2E_TMP_DIR;
  if (!tmp) return;
  if (pool.scopes.length === 0) return;
  const dbPath = join(tmp, "console.db");
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys=OFF");
      const scopeList = pool.scopes
        .map((s) => `'${s.replace(/'/g, "''")}'`)
        .join(",");
      const taskList =
        pool.tasks.length > 0
          ? pool.tasks.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")
          : null;
      const runList =
        pool.runs.length > 0
          ? pool.runs.map((r) => `'${r.replace(/'/g, "''")}'`).join(",")
          : null;
      if (taskList)
        db.exec(`DELETE FROM task_deps WHERE task_id IN (${taskList})`);
      if (taskList)
        db.exec(`DELETE FROM observations WHERE task_id IN (${taskList})`);
      if (runList)
        db.exec(`DELETE FROM run_events WHERE run_id IN (${runList})`);
      if (taskList) db.exec(`DELETE FROM runs WHERE task_id IN (${taskList})`);
      db.exec(`DELETE FROM runs WHERE scope_id IN (${scopeList})`);
      if (taskList) db.exec(`DELETE FROM tasks WHERE id IN (${taskList})`);
      try {
        db.exec("DROP TRIGGER IF EXISTS audit_no_delete");
        db.exec("DROP TRIGGER IF EXISTS audit_no_update");
      } catch {}
      db.exec(`DELETE FROM audit WHERE scope_id IN (${scopeList})`);
      db.exec(
        "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END",
      );
      db.exec(
        "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END",
      );
      db.exec(`DELETE FROM scopes WHERE id IN (${scopeList})`);
      db.exec("PRAGMA foreign_keys=ON");
    } finally {
      db.close();
    }
  } catch {
    // best-effort scoped cleanup
  }
}

test.describe("review history", () => {
  const pool: { scopes: string[]; tasks: string[]; runs: string[] } = {
    scopes: [],
    tasks: [],
    runs: [],
  };

  test.beforeEach(async ({ page }) => {
    // The webServer's scripted knobs are process-global: start every test
    // from boot defaults so ordering cannot leak stalls/failure scripts.
    await controlReset();
    await page.addInitScript(() => {
      localStorage.setItem("colony.actor", "human:op-1");
    });
  });

  test.afterAll(async () => {
    cleanupSeeded(pool);
  });

  test("seeded review shapes render honestly with keyboard-operable coverage", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const scopeId = await createScopeViaApi(request, {
      title: `Review history ${uniq}`,
      goal: `Review history regression goal ${uniq} — envelope-first run rows at every width`,
    });
    pool.scopes.push(scopeId);
    await waitForPlan(request, scopeId, 30000);
    const approve = await request.post(`/scopes/${scopeId}/approve-plan`, {
      headers: HEADERS,
    });
    expect(approve.ok(), `approve-plan ${await approve.text()}`).toBe(true);
    await expect
      .poll(async () => await taskIdsForScope(request, scopeId), {
        timeout: 30000,
        intervals: [250, 500, 1000],
      })
      .not.toEqual([]);
    const taskIds = await taskIdsForScope(request, scopeId);
    const taskId = taskIds[0];
    pool.tasks.push(...taskIds);

    const tmp = process.env.COLONY_E2E_TMP_DIR;
    expect(tmp, "COLONY_E2E_TMP_DIR is set by playwright config").toBeTruthy();
    pool.runs.push(
      ...seedReviewRows(join(tmp!, "console.db"), scopeId, taskId),
    );

    await page.goto(`/#/${scopeId}`);
    await assertViewport(page, testInfo);
    await expect(page.locator(".sheet-head").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator("svg.dag").first()).toBeVisible({
      timeout: 15000,
    });

    // Open the seeded task's drawer: the Runs history lives per task.
    const hits = page.locator("rect.node-hit[role=button]");
    await expect(hits.first()).toBeVisible({ timeout: 15000 });
    const drawer = page.locator(
      "aside.drawer[role=dialog][aria-label='Task detail']",
    );
    const hitCount = await hits.count();
    let opened = false;
    for (let i = 0; i < hitCount && !opened; i++) {
      await hits.nth(i).click();
      await expect(drawer).toBeVisible({ timeout: 5000 });
      const idText =
        (await drawer.locator(".drawer-id").first().textContent()) ?? "";
      if (idText.includes(taskId)) {
        opened = true;
      } else {
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden({ timeout: 5000 });
      }
    }
    expect(opened, `drawer for seeded task ${taskId}`).toBe(true);

    // No trace is ever opened: the seeded rows carry no trace_id, so every
    // verdict, rationale and finding below is visible in the history itself.
    await expect(drawer.getByText(RATIONALE_SNIPPET).first()).toBeVisible({
      timeout: 15000,
    });
    expect(await drawer.locator("a.run-trace").count()).toBe(0);

    // (1) The observed approved shape: rationale, all four finding notes and
    // the final count render without opening any trace.
    const approved = page.locator("run-line", {
      hasText: "review-note-alpha single writer for verdicts",
    });
    await expect(approved.getByText(RATIONALE_SNIPPET)).toBeVisible();
    for (const finding of OBSERVED_FINDINGS) {
      await expect(approved.getByText(finding.note)).toBeVisible();
    }
    await expect(approved.locator(".findings-count")).toHaveText(
      /4 final findings/,
    );
    expect(await approved.locator(".findings li").count()).toBe(4);
    await expect(approved.locator(".review-verdict")).toHaveText(
      /verdict: approve/,
    );

    // (2) request_changes shows its recorded findings.
    const rejected = page.locator("run-line", { hasText: RC_NOTES[0] });
    await expect(rejected.getByText(RC_NOTES[0])).toBeVisible();
    await expect(rejected.getByText(RC_NOTES[1])).toBeVisible();
    await expect(rejected.locator(".findings-count")).toHaveText(
      /2 final findings/,
    );
    await expect(rejected.locator(".review-verdict")).toHaveText(
      /verdict: request_changes/,
    );
    // The envelope's findings are final: the evidence copy is not repeated.
    await expect(rejected.getByText("stale evidence copy")).toHaveCount(0);

    // (3) An approval with zero final findings says zero, not missing.
    const clean = page.locator("run-line", {
      hasText: "zero-findings inspected note",
    });
    await expect(clean.locator(".findings-count")).toHaveText(
      /no final findings were recorded/,
    );
    expect(await clean.locator(".findings").count()).toBe(0);

    // (4) Evidence-only legacy row: the evidence finding renders and the row
    // says the rest is gone instead of inventing it.
    const legacy = page.locator("run-line", {
      hasText: "legacy-evidence-note missing case",
    });
    await expect(
      legacy.getByText("legacy-evidence-note missing case"),
    ).toBeVisible();
    await expect(legacy.getByText(/full details unavailable/)).toBeVisible();
    expect(await legacy.locator(".review-detail").count()).toBe(0);

    // (5) Malformed envelope_json falls back to evidence with the same note.
    const malformed = page.locator("run-line", {
      hasText: "malformed-evidence-note stale fallback",
    });
    await expect(
      malformed.getByText("malformed-evidence-note stale fallback"),
    ).toBeVisible();
    await expect(malformed.getByText(/full details unavailable/)).toBeVisible();
    expect(await malformed.locator(".review-detail").count()).toBe(0);

    // (6) Failed review: no accepted verdict, and the rejected envelope is
    // never presented as the verdict.
    const failed = page.locator("run-line", {
      hasText: "reviewer timed out",
    });
    await expect(
      failed.getByText("no accepted verdict was submitted"),
    ).toBeVisible();
    await expect(
      failed.getByText("a submission was recorded but not accepted"),
    ).toBeVisible();
    expect(await failed.locator(".review-detail").count()).toBe(0);
    expect(await failed.locator(".review-summary").count()).toBe(0);
    await expect(
      failed.getByText("failed-hidden-note must stay hidden"),
    ).toHaveCount(0);
    expect(
      (await failed.locator(".kind").first().textContent()) ?? "",
    ).not.toContain("approve");

    // Coverage sits behind one keyboard-operable disclosure below the
    // verdict: Tab to the control, Enter/Space toggles it.
    const summary = approved
      .locator("details.review-coverage > summary")
      .first();
    await summary.scrollIntoViewIfNeeded();
    for (let i = 0; i < 150; i++) {
      const onTarget = await summary.evaluate(
        (el) => el === document.activeElement,
      );
      if (onTarget) break;
      await page.keyboard.press("Tab");
      if (i === 149) {
        const onTargetAfter = await summary.evaluate(
          (el) => el === document.activeElement,
        );
        expect(onTargetAfter, "Tab reaches the coverage disclosure").toBe(true);
      }
    }
    // Focus is visible: the focused summary underlines at every viewport.
    const decoration = await summary.evaluate(
      (el) => getComputedStyle(el).textDecorationLine,
    );
    expect(decoration, "focused disclosure shows a visible focus").toContain(
      "underline",
    );
    const details = approved.locator("details.review-coverage").first();
    await expect(details).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(
      details.getByText("observed-inspected-note-1 checked against the spec"),
    ).toBeVisible();
    await expect(details.getByText(/spec-compliance/)).toBeVisible();
    await expect(details.getByText(/self-check:/)).toBeVisible();
    await page.keyboard.press(" ");
    await expect(details).not.toHaveAttribute("open", "");

    await assertNoHorizontalOverflow(page);
    expect(errors, `pageerror: ${errors.join("; ")}`).toEqual([]);
  });
});
