// Unit tests for <scope-sheet>, under happy-dom: the sheet's head, banners,
// DAG card, three columns, drawer gating, and — the defect-2 lesson — the
// abandon flow emitting colony-abandon {scopeId}, the event the shell's
// _abandon handles (a bare confirm can never abandon a scope).
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

await import("./scope-sheet.js");
await import("../elements/task-drawer.js");

const PLANNED = [
  { title: "Planned first", depends_on: [], spec: "first spec" },
  { title: "Planned second", depends_on: [0], spec: "second spec" },
];

const SCOPE_CLOSED = {
  id: "col-x",
  goal: "Grow the garden",
  title: "Garden",
  status: "done",
  provider_repo_path: "so/colony",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const TASKS = [
  {
    id: "col-x.0",
    scope_id: "col-x",
    title: "First",
    spec: "s0",
    state: "merged",
    state_version: 1,
  },
  {
    id: "col-x.1",
    scope_id: "col-x",
    title: "Second",
    spec: "s1",
    state: "mr_open",
    state_version: 2,
    mr_iid: 3,
  },
];

function detail(overrides = {}) {
  return {
    scope: { ...SCOPE_CLOSED },
    tasks: TASKS,
    deps: [{ task_id: "col-x.1", depends_on_task_id: "col-x.0" }],
    runs: [],
    project: null,
    ...overrides,
  };
}

function makeSheet(detailValue, props = {}) {
  const el = document.createElement("scope-sheet");
  el.detail = detailValue;
  el.config = { gitlab_base_url: "https://gitlab.example" };
  for (const [key, value] of Object.entries(props)) {
    el[key] = value;
  }
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of [
    "colony-toggle",
    "colony-select-task",
    "colony-close-drawer",
    "colony-open-reader",
    "colony-close-reader",
    "colony-confirm",
    "colony-task-action",
    "colony-abandon",
    "colony-feedback",
  ]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("scope-sheet structure", () => {
  it("shows the loading note while detail is missing, the sheet when it lands", async () => {
    const booting = makeSheet(null);
    await booting.updateComplete;
    expect(booting.querySelector("p.boot")?.textContent).toContain("Loading");
    expect(booting.querySelector(".sheet")).toBeNull();

    const el = makeSheet(detail());
    await el.updateComplete;
    expect(el.querySelector(".sheet")).toBeTruthy();
    expect(el.querySelector(".sheet-head .goal")?.textContent).toBe("Garden");
    expect(el.querySelector(".sheet-sub .mono")?.textContent).toBe("col-x");
    expect(el.querySelector(".sheet-sub a")?.getAttribute("href")).toBe(
      "https://gitlab.example/so/colony",
    );
    expect(
      el.querySelector('.sheet-head-side .chip[data-kind="done"]')?.textContent,
    ).toBe("done");
  });

  it("truncates an untitled goal to 72 chars with an ellipsis", async () => {
    const world = detail();
    world.scope = { ...world.scope, title: "", goal: "x".repeat(80) };
    const el = makeSheet(world);
    await el.updateComplete;
    expect(el.querySelector(".sheet-head .goal")?.textContent).toBe(
      "x".repeat(72) + "…",
    );
  });

  it("links the project name through the hash router", async () => {
    const world = detail();
    world.scope = { ...SCOPE_CLOSED, project_name: "Garden Project" };
    const el = makeSheet(world);
    await el.updateComplete;
    const links = [...el.querySelectorAll(".sheet-sub a")];
    expect(
      links
        .find((a) => a.textContent === "Garden Project")
        ?.getAttribute("href"),
    ).toBe("#/project/Garden%20Project");
  });
});

describe("scope-sheet banners", () => {
  it("renders the error banner with role=alert and the wait banner", async () => {
    const el = makeSheet(detail(), { error: "boom" });
    await el.updateComplete;
    const banner = el.querySelector(".banner-error");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent?.trim()).toBe("boom");
    expect(el.querySelector(".banner-wait")).toBeNull();
  });

  it('shows "Merge request !3 is waiting for your approval." for a pending manual mr', async () => {
    const el = makeSheet(detail(), { audit: [] });
    el.detail = {
      ...el.detail,
      scope: { ...SCOPE_CLOSED, status: "active", approvals: "manual" },
      tasks: TASKS.map((t) =>
        t.id === "col-x.1" ? { ...t, state: "mr_open" } : t,
      ),
    };
    await el.updateComplete;
    expect(el.querySelector(".banner-wait")?.textContent).toBe(
      "Merge request !3 is waiting for your approval.",
    );
  });
});

describe("scope-sheet layout", () => {
  it("renders the DAG card over <task-dag> with the task count", async () => {
    const el = makeSheet(detail());
    await el.updateComplete;
    expect(
      el.querySelector("section.card.dag-card .card-head")?.textContent,
    ).toContain("Tasks");
    expect(
      el.querySelector(".dag-card .card-head span")?.textContent.trim(),
    ).toBe("2");
    expect(el.querySelector("task-dag svg.dag")).toBeTruthy();
    expect(el.querySelectorAll("task-dag g.node").length).toBe(2);
  });

  it("composes the three columns with the card elements", async () => {
    const el = makeSheet(detail(), {
      audit: [],
      scopeRunEvents: null,
      runEvents: null,
      goalOpen: true,
      planOpen: false,
    });
    await el.updateComplete;
    const cols = el.querySelectorAll(".sheet-cols .sheet-col");
    expect(cols.length).toBe(3);
    expect(cols[0].querySelector("goal-card")).toBeTruthy();
    expect(cols[0].querySelector("goal-card").scope.id).toBe("col-x");
    expect(cols[0].querySelector("goal-card").goalOpen).toBe(true);
    expect(cols[0].querySelector("activity-card")).toBeTruthy();
    // plan-card and validation-card are always composed; with no plan, no
    // architect runs, and no acceptance they render nothing — and the empty
    // cards keep no .card aside in the DOM.
    expect(cols[1].querySelector("plan-card")).toBeTruthy();
    expect(cols[1].querySelector(".card")).toBeNull();
    expect(cols[1].textContent.trim()).toBe("");
    expect(cols[2].querySelector("validation-card")).toBeTruthy();
    expect(cols[2].querySelector(".card")).toBeNull();
    expect(cols[2].textContent.trim()).toBe("");
  });

  it("shows replan history in the plan column when the audit carries one", async () => {
    const world = detail();
    world.scope = {
      ...SCOPE_CLOSED,
      status: "planning",
      plan_json: JSON.stringify({
        summary: "Do it in two steps",
        tasks: PLANNED,
      }),
    };
    const el = makeSheet(world, {
      audit: [
        {
          id: 7,
          at: new Date(Date.now() - 60_000).toISOString(),
          actor: "human:op-1",
          action: "plan.replan_requested",
          detail_json: JSON.stringify({ feedback: "split it up" }),
        },
      ],
      planOpen: true,
    });
    await el.updateComplete;
    const col = el.querySelectorAll(".sheet-cols .sheet-col")[1];
    expect(col.querySelector("plan-card")).toBeTruthy();
    expect(
      col.querySelector("plan-card .plan-summary")?.textContent?.trim(),
    ).toBe("Do it in two steps");
    // The plan is approvable while planning with a plan.
    expect(col.textContent).toContain("Approve plan");
    expect(col.textContent).toContain("split it up");
    expect(col.querySelector(".plan-history-title")?.textContent).toContain(
      "1",
    );
  });
});

describe("plan reader", () => {
  it("renders requirements, journey, per-task files and evidence, and the plan-review verdict", async () => {
    // The staged architect grounds every task; the reader is where the
    // operator judges the plan, so what the architect verified must reach it.
    const { planMarkdown } = await import("../elements/plan-card.js");
    const plan = {
      summary: "Two grounded steps",
      requirements: [{ id: "R1", text: "goal holds", tasks: [0, 1] }],
      journey: [{ after_task: 0, working_state: "A holds" }],
      acceptance: [{ description: "goal holds", command: "true" }],
      tasks: [
        {
          title: "Task A",
          spec: "Do A.",
          depends_on: [],
          files: ["src/a.ts"],
          evidence: ["bun test src/a.test.ts"],
        },
        { title: "Task B", spec: "Do B.", depends_on: [0] },
      ],
    };
    const md = planMarkdown({ title: "Scope" }, plan);
    expect(md).toContain("## Requirements");
    expect(md).toContain("**R1** goal holds — tasks 0, 1");
    expect(md).toContain("## Journey");
    expect(md).toContain("after task 0: A holds");
    expect(md).toContain("- `src/a.ts`");
    expect(md).toContain("bun test src/a.test.ts");

    const world = detail();
    world.scope = {
      ...SCOPE_CLOSED,
      status: "planning",
      plan_json: JSON.stringify(plan),
    };
    world.runs = [
      {
        id: "r-arch",
        scope_id: "col-x",
        task_id: null,
        kind: "architect",
        status: "succeeded",
        model_id: "m",
        started_at: new Date(Date.now() - 120_000).toISOString(),
        finished_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        id: "r-plan-review",
        scope_id: "col-x",
        task_id: null,
        kind: "plan_review",
        status: "succeeded",
        model_id: "m",
        started_at: new Date(Date.now() - 50_000).toISOString(),
        finished_at: new Date().toISOString(),
        evidence_json: JSON.stringify({
          verdict: "request_changes",
          findings: [{ severity: "major", note: "task 1 has no evidence" }],
        }),
      },
    ];
    const el = makeSheet(world, { planOpen: true });
    await el.updateComplete;
    const card = /** @type {any} */ el.querySelector("plan-card");
    await card.updateComplete;
    for (const line of card.querySelectorAll("run-line")) {
      await /** @type {any} */ line.updateComplete;
    }
    expect(card?.textContent).toContain(
      "plan review succeeded · request_changes",
    );
    expect(card?.textContent).toContain("task 1 has no evidence");
  });
});

describe("scope-sheet drawer", () => {
  it("renders the drawer only when both drawerOpen and a real task select", async () => {
    const el = makeSheet(detail(), {
      selectedTaskId: "col-x.1",
      drawerOpen: true,
      runEvents: null,
    });
    await el.updateComplete;
    const drawer = el.querySelector("task-drawer");
    expect(drawer?.task.id).toBe("col-x.1");
    expect(drawer?.scope.id).toBe("col-x");
    expect(drawer?.runEvents).toBeNull();

    // Same selection but the drawer closed.
    const closed = makeSheet(detail(), { selectedTaskId: "col-x.1" });
    await closed.updateComplete;
    expect(closed.querySelector("task-drawer")).toBeNull();

    // A selection that matches no task.
    const missing = makeSheet(detail(), {
      selectedTaskId: "col-x.404",
      drawerOpen: true,
    });
    await missing.updateComplete;
    expect(missing.querySelector("task-drawer")).toBeNull();
  });

  it("passes the armed confirm down so two-step drawer buttons can execute", async () => {
    const world = detail();
    world.scope = { ...SCOPE_CLOSED, status: "active", approvals: "manual" };
    const el = makeSheet(world, {
      selectedTaskId: "col-x.1",
      drawerOpen: true,
    });
    el.confirm = "merge";
    await el.updateComplete;
    const drawer = el.querySelector("task-drawer");
    expect(drawer?.confirm).toBe("merge");
    expect(
      [...drawer.querySelectorAll(".task-actions button")].some((b) =>
        b.textContent.includes("Confirm merge approval"),
      ),
    ).toBe(true);
  });
});

describe("scope-sheet abandon flow (defect 2)", () => {
  it("two-step abandon: Arm via colony-confirm, then colony-abandon {scopeId}", async () => {
    const world = detail();
    world.scope = { ...SCOPE_CLOSED, status: "active" };
    const el = makeSheet(world);
    const seen = eventsOf(el);
    await el.updateComplete;
    expect(
      el.querySelector(".sheet-head-side .btn-quiet")?.textContent,
    ).toContain("Abandon scope");
    el.querySelector(".sheet-head-side .btn-quiet").click();
    expect(seen).toEqual([["colony-confirm", { kind: "abandon" }]]);
    el.confirm = "abandon";
    await el.updateComplete;
    const confirmBtn = el.querySelector(".sheet-head-side .btn-rev");
    expect(confirmBtn?.textContent).toContain("Confirm abandon");
    confirmBtn.click();
    expect(seen[1]).toEqual(["colony-abandon", { scopeId: "col-x" }]);
  });

  it("abandoned/done scopes render no abandon button at all", async () => {
    const el = makeSheet(detail()); // status: done
    await el.updateComplete;
    expect(el.querySelector(".sheet-head-side .btn-quiet")).toBeNull();
    expect(el.querySelector(".sheet-head-side .btn-rev")).toBeNull();
  });
});

describe("scope-sheet goal and proposed-task surfaces", () => {
  it("forwards its error down to <goal-card> so the goal column can show it", async () => {
    const el = makeSheet(detail(), { error: "boom" });
    await el.updateComplete;
    const card = el.querySelector("goal-card");
    expect(card?.error).toBe("boom");
    expect(card?.querySelector(".banner-error")?.textContent?.trim()).toBe(
      "boom",
    );
  });

  it("leaves goal-card without an error banner when the sheet has none", async () => {
    const el = makeSheet(detail());
    await el.updateComplete;
    expect(el.querySelector("goal-card .banner-error")).toBeNull();
  });

  it("opens the proposed-task drawer for a plan: selection", async () => {
    const world = detail();
    world.tasks = [];
    world.deps = [];
    world.scope = {
      ...SCOPE_CLOSED,
      plan_json: JSON.stringify({ summary: "s", tasks: PLANNED }),
    };
    const el = makeSheet(world, {
      selectedTaskId: "plan:0",
      drawerOpen: true,
    });
    await el.updateComplete;
    const drawer = el.querySelector("task-drawer");
    expect(drawer?.task.id).toBe("plan:0");
    // <task-drawer> renders the monolith's proposed-task drawer from the plan.
    expect(drawer?.querySelector(".task-title")?.textContent).toBe(
      "Planned first",
    );
    expect(drawer?.querySelector(".drawer-id")?.textContent).toContain(
      "plan #0",
    );
  });

  it("tells <task-dag> whether the drawer is open, so a closed drawer un-highlights the node", async () => {
    const el = makeSheet(detail(), {
      selectedTaskId: "col-x.1",
      drawerOpen: true,
    });
    await el.updateComplete;
    const dag = el.querySelector("task-dag");
    expect(dag?.drawerOpen).toBe(true);

    el.drawerOpen = false;
    await el.updateComplete;
    expect(el.querySelector("task-dag")?.drawerOpen).toBe(false);
  });
});
