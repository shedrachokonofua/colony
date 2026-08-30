// Unit tests for <task-dag>, under happy-dom: the SVG mirrors the monolith's
// renderDag over ../dag.js layout — edges keyed by dependency, node boxes
// with title/state/live labels, proposed nodes from an unapproved plan — and
// node hits select tasks with mouse and keyboard.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./test-dom.js";

sharedDom();

await import("./task-dag.js");

const SCOPE = {
  id: "col-x",
  goal: "g",
  plan_json: JSON.stringify({
    summary: "s",
    tasks: [
      { title: "Planned first", depends_on: [], spec: "a" },
      { title: "Planned second", depends_on: [0], spec: "b" },
    ],
  }),
};

const TASKS = [
  {
    id: "col-x.0",
    scope_id: SCOPE.id,
    title: "First",
    spec: "s0",
    state: "merged",
    state_version: 1,
  },
  {
    id: "col-x.1",
    scope_id: SCOPE.id,
    title: "Second",
    spec: "s1",
    state: "mr_open",
    state_version: 2,
  },
];

const DEPS = [{ task_id: "col-x.1", depends_on_task_id: "col-x.0" }];

function detail(overrides = {}) {
  return {
    scope: SCOPE,
    tasks: TASKS,
    deps: DEPS,
    runs: [],
    project: null,
    ...overrides,
  };
}

function makeDag(detailValue, selectedTaskId = null) {
  const el = document.createElement("task-dag");
  el.detail = detailValue;
  el.selectedTaskId = selectedTaskId;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("task-dag", () => {
  it("renders the monolith's svg.dag with a node per task and an edge per dep", async () => {
    const el = makeDag(detail());
    await el.updateComplete;
    const svg = el.querySelector("svg.dag");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Task dependency graph");
    expect(svg.querySelector("defs marker#arrow")).toBeTruthy();
    expect([...svg.querySelectorAll("g.node.dag-node")].length).toBe(2);
    expect(el.querySelectorAll("path.edge.dag-edge").length).toBe(1);
    expect(el.querySelectorAll("rect.node-hit").length).toBe(2);
  });

  it("node markup carries title, state chip data, and the #serial tail", async () => {
    const el = makeDag(detail());
    await el.updateComplete;
    const groups = [...el.querySelectorAll("g.node.dag-node")];
    expect(groups[0].getAttribute("data-state")).toBe("merged");
    expect(groups[0].querySelector(".ntitle")?.textContent).toBe("First");
    expect(groups[0].querySelector(".nstate")?.textContent).toContain(
      "merged",
    );
    expect(groups[0].querySelector(".nid")?.textContent).toBe("#0");
    expect(groups[1].getAttribute("data-state")).toBe("mr_open");
    expect(groups[1].querySelector(".nid")?.textContent).toBe("#1");
  });

  it("marks the selected node is-selected and only while selected", async () => {
    const el = makeDag(detail(), "col-x.1");
    await el.updateComplete;
    const groups = [...el.querySelectorAll("g.node.dag-node")];
    expect(groups[0].classList.contains("is-selected")).toBe(false);
    expect(groups[1].classList.contains("is-selected")).toBe(true);
    el.selectedTaskId = null;
    await el.updateComplete;
    expect([...el.querySelectorAll("g.node.dag-node")][1].classList.contains("is-selected")).toBe(false);
  });

  it("labels a node live with its running run's kind and duration", async () => {
    const el = makeDag(
      detail({
        runs: [
          {
            id: "r1",
            task_id: "col-x.1",
            kind: "merge_gate",
            status: "running",
            started_at: new Date(Date.now() - 65_000).toISOString(),
            finished_at: null,
          },
        ],
      }),
    );
    await el.updateComplete;
    const live = [...el.querySelectorAll("g.node.dag-node")][1];
    expect(live.classList.contains("is-live")).toBe(true);
    expect(live.querySelector(".nstate")?.textContent).toContain("gate");
    expect(live.querySelector(".nstate")?.textContent).toMatch(/1m|0m/);
  });

  it("falls back to the plan's proposed nodes before approval", async () => {
    const el = makeDag(detail({ tasks: [], deps: [] }));
    await el.updateComplete;
    const groups = [...el.querySelectorAll("g.node.dag-node")];
    expect(groups.length).toBe(2);
    expect(groups[0].querySelector(".nid")?.textContent).toBe("#0");
    for (const group of groups) {
      expect(group.querySelector(".node-box.is-proposed")).toBeTruthy();
    }
  });

  it("proposed edges wire plan:N indices like detail deps", async () => {
    const el = makeDag(detail({ tasks: [], deps: [] }));
    await el.updateComplete;
    expect(el.querySelectorAll("path.edge.dag-edge").length).toBe(1);
  });

  it("shows the monolith's empty notes for a taskless, planless scope", async () => {
    const planless = detail({ tasks: [], deps: [], runs: [] });
    planless.scope = { ...SCOPE, plan_json: null };
    const idle = makeDag(planless);
    await idle.updateComplete;
    expect(idle.querySelector("p.note")?.textContent).toContain(
      "No tasks on this sheet yet.",
    );
    const planning = makeDag(
      detail({
        tasks: [],
        deps: [],
        runs: [
          {
            id: "ra",
            task_id: null,
            kind: "architect",
            status: "running",
            started_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    planning.detail = { ...planning.detail, scope: { ...SCOPE, plan_json: null } };
    await planning.updateComplete;
    expect(planning.querySelector("p.note")?.textContent).toContain(
      "Architect is drawing the plan.",
    );
  });

  it("renders nothing meaningful for missing detail", async () => {
    const el = makeDag(null);
    await el.updateComplete;
    expect(el.querySelector("p.note")?.textContent).toContain(
      "No tasks on this sheet yet.",
    );
    expect(el.querySelector("svg.dag")).toBeNull();
  });
});

describe("task-dag selection", () => {
  it("clicks on a node hit select the task via colony-select-task", async () => {
    const el = makeDag(detail());
    const seen = [];
    el.addEventListener("colony-select-task", (event) =>
      seen.push(event.detail),
    );
    await el.updateComplete;
    el.querySelectorAll("rect.node-hit")[0].dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    expect(seen).toEqual([{ taskId: "col-x.0" }]);
  });

  it("keyboard Enter and Space select; other keys do not", async () => {
    const el = makeDag(detail());
    const seen = [];
    el.addEventListener("colony-select-task", (event) =>
      seen.push(event.detail),
    );
    await el.updateComplete;
    const hit = el.querySelectorAll("rect.node-hit")[1];
    expect(hit.getAttribute("tabindex")).toBe("0");
    expect(hit.getAttribute("role")).toBe("button");
    expect(hit.getAttribute("aria-label")).toBe("Second");
    for (const key of ["Enter", " "]) {
      hit.dispatchEvent(
        new window.KeyboardEvent("keydown", { key, bubbles: true }),
      );
    }
    expect(seen).toEqual([
      { taskId: "col-x.1" },
      { taskId: "col-x.1" },
    ]);
    seen.length = 0;
    hit.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(seen).toEqual([]);
  });

  it("proposed plan nodes select their plan:<index> id", async () => {
    const el = makeDag(detail({ tasks: [], deps: [] }));
    const seen = [];
    el.addEventListener("colony-select-task", (event) =>
      seen.push(event.detail),
    );
    await el.updateComplete;
    el.querySelectorAll("rect.node-hit")[1].dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    expect(seen).toEqual([{ taskId: "plan:1" }]);
  });
});