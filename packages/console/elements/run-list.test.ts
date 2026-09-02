// Unit tests for <run-list>, under happy-dom: rows key on run id, so a poll
// that re-sends the same list patches rows in place instead of rebuilding.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./test-dom.js";

// Element modules self-register into globalThis.customElements at import
// time (a static import would hoist above this setup), so the shared
// window must be installed before they load.
sharedDom();

await import("./run-list.js");

function run(id, overrides = {}) {
  return {
    id,
    kind: "implement",
    status: "succeeded",
    head_sha: "abcdef1234567890",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function makeList(runs) {
  const el = document.createElement("run-list");
  el.runs = runs;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("run-list", () => {
  it("renders one run-line per run inside the .runs wrapper", async () => {
    const el = makeList([run("r1"), run("r2"), run("r3")]);
    await el.updateComplete;
    expect(el.querySelector("section.runs")).toBeTruthy();
    expect([...el.querySelectorAll("run-line")].length).toBe(3);
    expect(el.querySelector("run-line").run.id).toBe("r1");
  });

  it("shows the monolith's empty note when there are no runs", async () => {
    const el = makeList([]);
    await el.updateComplete;
    expect(el.querySelector("p.note")?.textContent).toBe(
      "No runs on this task yet.",
    );
  });

  it("keys rows on run id: a re-sent list patches rows in place", async () => {
    const el = makeList([run("r1"), run("r2")]);
    await el.updateComplete;
    const first = el.querySelectorAll("run-line")[0];
    const second = el.querySelectorAll("run-line")[1];
    el.runs = [run("r1", { status: "failed" }), run("r2"), run("r3")];
    await el.updateComplete;
    expect([...el.querySelectorAll("run-line")].length).toBe(3);
    // repeat keyed by run.id: existing rows are reused, not rebuilt.
    expect(el.querySelectorAll("run-line")[0]).toBe(first);
    expect(el.querySelectorAll("run-line")[1]).toBe(second);
    expect(
      el
        .querySelectorAll("run-line")[0]
        .querySelector("div.run")
        .getAttribute("data-status"),
    ).toBe("failed");
  });

  it("passes config and task through to every run-line", async () => {
    const el = makeList([run("r1"), run("r2")]);
    const config = { trace_ui_base_url: "https://trace.local/" };
    const task = { cost_prediction_json: null };
    el.config = config;
    el.task = task;
    await el.updateComplete;
    for (const line of el.querySelectorAll("run-line")) {
      expect(line.config).toBe(config);
      expect(line.task).toBe(task);
    }
  });
});
