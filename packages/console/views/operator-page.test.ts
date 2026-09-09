// Unit tests for <operator-page>, under happy-dom: the five sections render
// the GET /operator/summary payload verbatim — awaiting-merge rows carry
// their scope and task link, a stalled run is flagged and sorted first,
// restart incidents collapse to ONE line, unclassified faults show the
// served (already redacted) detail with a run link, every section has its
// own empty-state copy, and the 7d toggle emits the window the shell
// refetches.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

await import("./operator-page.js");

/**
 * A GET /operator/summary payload: the shape apps/colonyd/src/
 * operator-summary.ts serves. Every field the view reads is here, so a
 * rename on either side of the contract fails this suite.
 */
function summary(overrides = {}) {
  return {
    window: "24h",
    window_start: "2026-09-08T12:00:00.000Z",
    generated_at: new Date(Date.now() - 30_000).toISOString(),
    waiting_on_you: {
      plan_approvals: [{ scope_id: "col-plan1111" }],
      awaiting_merge: [
        {
          scope_id: "col-a1b2c3d4",
          task_id: "col-a1b2c3d4.1",
          head_sha: "b9c0d1e2f30415263748a9b0c1d2e3f401234567",
        },
      ],
      blocked_tasks: [
        {
          scope_id: "col-a1b2c3d4",
          task_id: "col-a1b2c3d4.2",
          blocked_reason: "architect died: glpa...7hbQ refused",
          age: "PT900S",
        },
      ],
      blocked_scopes: [
        {
          scope_id: "col-blocked",
          blocked_reason: "no acceptance command passed",
          age: "PT3600S",
        },
      ],
    },
    live: [
      {
        id: "run-fresh",
        kind: "implement",
        model_id: "deepseek-v4-flash",
        scope_id: "col-fresh111",
        task_id: "col-fresh111.1",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        last_progress_at: new Date(Date.now() - 30_000).toISOString(),
        active_tool: "bash",
        stalled: false,
      },
      {
        id: "run-stalled",
        kind: "review",
        model_id: "mimo-v2.5-pro",
        scope_id: "col-stall11",
        task_id: "col-stall11.1",
        started_at: new Date(Date.now() - 900_000).toISOString(),
        last_progress_at: new Date(Date.now() - 900_000).toISOString(),
        active_tool: "read",
        stalled: true,
      },
    ],
    metrics: {
      runs_by_kind_status: {
        "implement:succeeded": 3,
        "review:failed": 1,
        "merge_gate:running": 1,
      },
      merges: 2,
      verdicts: 4,
      per_model: {
        "deepseek-v4-flash": {
          runs: 3,
          succeeded: 2,
          failed: 1,
          timeouts: 1,
          completion_rate: 2 / 3,
          median_ms: 420_000,
          p90_ms: 900_000,
        },
      },
      faults_by_layer: { model: 1, unknown: 2 },
      faults_by_layer_code: { "model:wall_timeout": 1 },
      // One outage that reaped two runs: the page must print one line.
      restart_incidents: { incidents: 1, reaped_runs: 2 },
      validation: { pass: 1, fail: 1 },
    },
    unclassified: [
      {
        run_id: "run-unclass",
        kind: "implement",
        model_id: "deepseek-v4-flash",
        task_id: "col-a1b2c3d4.2",
        finished_at: new Date(Date.now() - 120_000).toISOString(),
        // The redacted copy colonyd served: this suite asserts the page
        // prints it verbatim and never the raw secret it replaced.
        detail: "glpa...7hbQ refused the push",
      },
    ],
    deploy: {
      version: "abc1234",
      started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      restart_incidents: { incidents: 1, reaped_runs: 2 },
    },
    ...overrides,
  };
}

/** An empty fleet: every section must fall back to its own copy. */
function emptySummary(overrides = {}) {
  return {
    ...summary(),
    waiting_on_you: {
      plan_approvals: [],
      awaiting_merge: [],
      blocked_tasks: [],
      blocked_scopes: [],
    },
    live: [],
    metrics: {
      runs_by_kind_status: {},
      merges: 0,
      verdicts: 0,
      per_model: {},
      faults_by_layer: {},
      faults_by_layer_code: {},
      restart_incidents: { incidents: 0, reaped_runs: 0 },
      validation: { pass: 0, fail: 0 },
    },
    unclassified: [],
    ...overrides,
  };
}

function makePage(payload = summary(), props = {}) {
  const el = document.createElement("operator-page");
  el.summary = payload;
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

/** The section card whose head reads `title`. */
function section(el, title) {
  return [...el.querySelectorAll(".operator-section")].find((node) =>
    node.querySelector(".card-head")?.textContent?.includes(title),
  );
}

function sectionText(el, title) {
  return section(el, title)?.textContent ?? "";
}

/** Links of one element's rows: [href, text], the way an operator reads them. */
function links(el) {
  return [...el.querySelectorAll("a")].map((a) => [
    a.getAttribute("href"),
    a.textContent.trim(),
  ]);
}

function eventsOf(el) {
  const seen = [];
  for (const type of [
    "colony-navigate",
    "colony-operator-window",
    "colony-open-task",
  ]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("operator-page structure", () => {
  it("renders the five sections in order under one title", async () => {
    const el = makePage();
    await el.updateComplete;
    expect(el.querySelector(".board-title")?.textContent).toBe("Operator");
    expect(
      [...el.querySelectorAll(".operator-section .card-head")].map((node) =>
        node.textContent.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "Waiting on you",
      "Live (2)",
      "Metrics",
      "Unclassified faults (1)",
      "Deploy",
    ]);
  });

  it("shows the loading note until the summary lands", async () => {
    const el = document.createElement("operator-page");
    document.body.append(el);
    await el.updateComplete;
    expect(el.textContent).toContain("Loading operator summary");
    expect(el.querySelector(".operator-section")).toBeNull();
  });

  it("renders the error banner with role=alert", async () => {
    const el = makePage(summary(), { error: "summary unavailable" });
    await el.updateComplete;
    const banner = el.querySelector(".banner-error");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent?.trim()).toBe("summary unavailable");
  });
});

describe("operator-page waiting on you", () => {
  it("renders the awaiting-merge row with its scope and task links", async () => {
    const el = makePage();
    await el.updateComplete;
    const waiting = section(el, "Waiting on you");
    const merge = waiting.querySelector(".operator-group:nth-child(2)");
    const hrefs = [...merge.querySelectorAll("a")].map((a) => [
      a.getAttribute("href"),
      a.textContent.trim(),
    ]);
    // The task anchor carries the scope's hash (so a middle-click still
    // lands on the scope) and emits colony-open-task on a plain click —
    // the shell's deferred-selection route. See the navigation test below.
    expect(hrefs).toEqual([
      ["#/col-a1b2c3d4", "col-a1b2c3d4"],
      ["#/col-a1b2c3d4", "col-a1b2c3d4.1"],
    ]);
    expect(merge.textContent).toContain("b9c0d1e");
  });

  it("prints the server's count beside the rows it describes", async () => {
    // Invariant: counts shown equal rows below. The head count is the array
    // the server computed — never a client-side recount.
    const el = makePage();
    await el.updateComplete;
    const waiting = section(el, "Waiting on you");
    expect(waiting.textContent).toContain("Plans to approve (1)");
    expect(waiting.textContent).toContain("Merges to approve (1)");
    expect(waiting.textContent).toContain("Blocked tasks (1)");
    expect(waiting.textContent).toContain("Blocked scopes (1)");
    expect(waiting.querySelectorAll(".operator-row").length).toBe(4);
  });

  it("clicking a scope link bubbles colony-navigate with its hash", async () => {
    const el = makePage();
    const seen = eventsOf(el);
    await el.updateComplete;
    const link = section(el, "Waiting on you").querySelector("a");
    link.click();
    expect(seen).toEqual([["colony-navigate", { href: "#/col-plan1111" }]]);
  });

  it("clicking a task link bubbles colony-open-task, not an invented route", async () => {
    // The task's own route is the shell's deferred selection: it parks the
    // id and opens the drawer once the scope's detail lands. A `?task=`
    // hash would be a second, unparsed routing shape.
    const el = makePage();
    const seen = eventsOf(el);
    await el.updateComplete;
    const merge = section(el, "Waiting on you").querySelector(
      ".operator-group:nth-child(2)",
    );
    const taskLink = [...merge.querySelectorAll("a")][1];
    taskLink.click();
    expect(seen).toEqual([
      [
        "colony-open-task",
        { scopeId: "col-a1b2c3d4", taskId: "col-a1b2c3d4.1" },
      ],
    ]);
  });

  it("renders the empty state when nothing is waiting", async () => {
    const el = makePage(emptySummary());
    await el.updateComplete;
    expect(sectionText(el, "Waiting on you")).toContain(
      "Nothing is waiting on you",
    );
    expect(
      section(el, "Waiting on you").querySelectorAll(".operator-row").length,
    ).toBe(0);
  });
});

describe("operator-page live", () => {
  it("sorts the stalled run first and flags it", async () => {
    const el = makePage();
    await el.updateComplete;
    const rows = [...section(el, "Live").querySelectorAll(".operator-row")];
    expect(rows).toHaveLength(2);
    // Stalled first: a run that outlived its lease needs a decision now.
    expect(rows[0].classList.contains("is-stalled")).toBe(true);
    expect(rows[1].classList.contains("is-stalled")).toBe(false);
    expect(rows[0].textContent).toContain("stalled");
    expect(rows[1].textContent).toContain("live");
    expect(rows[0].textContent).toContain("run-stalled");
  });

  it("links every live row's scope and task", async () => {
    const el = makePage();
    await el.updateComplete;
    const hrefs = [...section(el, "Live").querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "#/col-stall11",
      "#/col-stall11",
      "#/col-fresh111",
      "#/col-fresh111",
    ]);
  });

  it("reads the server's live count, not a recount", async () => {
    const el = makePage(summary({ live: summary().live.slice(0, 1) }));
    await el.updateComplete;
    expect(
      section(el, "Live").querySelector(".card-head")?.textContent,
    ).toContain("Live (1)");
    expect(section(el, "Live").querySelectorAll(".operator-row")).toHaveLength(
      1,
    );
  });

  it("renders the empty state when nothing is running", async () => {
    const el = makePage(emptySummary());
    await el.updateComplete;
    expect(sectionText(el, "Live")).toContain("Nothing is running right now.");
  });
});

describe("operator-page metrics", () => {
  it("renders runs-by-role x outcome, per model, and faults by layer", async () => {
    const el = makePage();
    await el.updateComplete;
    const metrics = section(el, "Metrics");
    const tables = [...metrics.querySelectorAll(".operator-table")];
    expect(tables).toHaveLength(3);
    // Rows are role="row" elements (see operator-page.js): real tables to
    // assistive tech, and the only shape lit renders under happy-dom.
    const rows = (table) =>
      [...table.querySelectorAll("[role='row']")]
        .slice(1)
        .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
    expect(rows(tables[0])).toEqual([
      ["build", "succeeded", "3"],
      ["review", "failed", "1"],
      ["gate", "running", "1"],
    ]);
    expect(rows(tables[1])).toEqual([
      ["deepseek-v4-flash", "67% of 3", "1", "7m 00s"],
    ]);
    expect(rows(tables[2])).toEqual([
      ["model", "1"],
      ["unknown", "2"],
    ]);
    // The header row is the first row of each table.
    expect(
      [...tables[0].querySelectorAll("[role='columnheader']")].map((th) =>
        th.textContent.trim(),
      ),
    ).toEqual(["Role", "Outcome", "Runs"]);
  });

  it("prints merges and verdicts as the server counted them", async () => {
    const el = makePage();
    await el.updateComplete;
    expect(
      section(el, "Metrics").querySelector(".operator-tally")?.textContent,
    ).toMatch(/2\s+merges.*4\s+verdicts/s);
  });

  it("collapses a restart batch into exactly one line", async () => {
    // The invariant the whole page exists to keep: one outage that reaped
    // two runs is one line, not two. Two lines would read as two outages.
    const el = makePage();
    await el.updateComplete;
    const head = [
      ...section(el, "Metrics").querySelectorAll(".operator-group"),
    ].find((group) => group.textContent.includes("Restart incidents"));
    const lines = [...head.querySelectorAll("p, li, tr")].filter(
      (node) => !node.classList.contains("operator-group-head"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent.replace(/\s+/g, " ").trim()).toBe(
      "1 restart incident reaped 2 runs.",
    );
    // The two victims are counted in the line itself, never as extra rows.
    expect(head.querySelectorAll(".operator-table")).toHaveLength(0);
  });

  it("renders the empty state when the window holds no runs", async () => {
    const el = makePage(emptySummary());
    await el.updateComplete;
    expect(sectionText(el, "Metrics")).toContain("No runs in this window");
  });

  it("renders the no-incident copy when nothing restarted", async () => {
    const el = makePage(
      summary({
        metrics: {
          ...summary().metrics,
          restart_incidents: { incidents: 0, reaped_runs: 0 },
        },
      }),
    );
    await el.updateComplete;
    expect(sectionText(el, "Metrics")).toContain("No restart incidents");
  });
});

describe("operator-page unclassified faults", () => {
  it("shows the served redacted detail and links the run's task", async () => {
    const el = makePage();
    await el.updateComplete;
    const faults = section(el, "Unclassified faults");
    expect(faults.querySelector(".operator-detail")?.textContent).toBe(
      "glpa...7hbQ refused the push",
    );
    // The count above the list is the server's, and it equals the rows.
    expect(faults.querySelector(".card-head")?.textContent).toContain("(1)");
    expect(faults.querySelectorAll(".operator-row")).toHaveLength(1);
    expect(
      [...faults.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ).toEqual(["#/col-a1b2c3d4", "#/col-a1b2c3d4"]);
  });

  it("never renders an unredacted detail the server did not send", async () => {
    // The page prints the served string verbatim; it has no raw source to
    // leak. Break the contract — hand it a bare secret — and the page still
    // shows only what it was given, because it never writes its own copy.
    const el = makePage(
      summary({
        unclassified: [
          {
            run_id: "run-raw",
            kind: "implement",
            model_id: null,
            task_id: null,
            finished_at: null,
            detail: "glpat-secretvalue0000abcd refused",
          },
        ],
      }),
    );
    await el.updateComplete;
    const detail = section(el, "Unclassified faults").querySelector(
      ".operator-detail",
    );
    expect(detail?.textContent).toBe("glpat-secretvalue0000abcd refused");
    // No second, client-derived rendering path exists to print more.
    expect(
      section(el, "Unclassified faults").querySelectorAll(".operator-detail"),
    ).toHaveLength(1);
  });

  it("renders the empty state when the window has no unclassified fault", async () => {
    const el = makePage(emptySummary());
    await el.updateComplete;
    expect(sectionText(el, "Unclassified faults")).toContain(
      "No unclassified faults in this window.",
    );
  });
});

describe("operator-page deploy", () => {
  it("renders version, uptime and restarts", async () => {
    const el = makePage();
    await el.updateComplete;
    const deploy = section(el, "Deploy");
    const pairs = [...deploy.querySelectorAll(".operator-deploy div")].map(
      (row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector("dd")?.textContent.trim(),
      ],
    );
    expect(pairs).toEqual([
      ["Version", "abc1234"],
      ["Uptime", "3h ago"],
      ["Restarts", "1"],
    ]);
  });
});

describe("operator-page window toggle", () => {
  it("emits colony-operator-window 7d so the shell refetches the summary", async () => {
    // The toggle does not recompute anything: it asks for a different
    // server window, which is the only way the counts and rows stay one
    // dataset.
    const el = makePage();
    const seen = eventsOf(el);
    await el.updateComplete;
    const tabs = [...el.querySelectorAll(".tabs .tab")];
    expect(tabs.map((tab) => tab.textContent.trim())).toEqual([
      "24 hours",
      "7 days",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    tabs[1].click();
    expect(seen).toEqual([["colony-operator-window", { window: "7d" }]]);
  });

  it("clicking the active window emits nothing", async () => {
    const el = makePage();
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector(".tabs .tab").click();
    expect(seen).toEqual([]);
  });

  it("marks the window the shell is showing", async () => {
    const el = makePage(summary({ window: "7d" }), { window: "7d" });
    await el.updateComplete;
    const tabs = [...el.querySelectorAll(".tabs .tab")];
    // The 7d window is only real once the payload agrees: the toggle shows
    // the shell's choice, never a value the server has not served.
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
  });

  it("names the window the payload came from", async () => {
    const el = makePage(summary({ window: "7d" }));
    await el.updateComplete;
    expect(el.querySelector(".operator-generated")?.textContent).toContain(
      "7 days",
    );
  });
});
