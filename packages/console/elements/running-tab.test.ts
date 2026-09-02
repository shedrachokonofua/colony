// Unit tests for <running-tab>, under happy-dom: the empty state, a live
// row's markup, the deep-link events a row and its scope chip bubble, and
// live durations that advance with the injected ticker.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./test-dom.js";

// Element modules self-register into globalThis.customElements at import
// time (a static import would hoist above this setup), so the shared
// window must be installed before they load.
sharedDom();

await import("./running-tab.js");

/**
 * A wall clock the test moves by hand. The element reads Date.now() on each
 * tick, so pinning it makes the tick — not the passage of test time — the
 * only thing that can change a rendered duration.
 */
function fakeClock(start) {
  let now = start;
  const realNow = Date.now;
  return {
    install() {
      Date.now = () => now;
    },
    advance(ms) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

/**
 * The injected clock: the element subscribes one callback and this drives
 * it, so a live duration advances without the test waiting on wall time.
 * start/stop are spies — the element borrows the shell's clock, so a clock
 * it stops on disconnect would kill every other surface sharing it.
 */
function manualTicker() {
  const callbacks = new Set();
  const calls = { start: 0, stop: 0 };
  return {
    calls,
    subscribe(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
    start() {
      calls.start += 1;
    },
    stop() {
      calls.stop += 1;
    },
    running() {
      return false;
    },
    tick() {
      for (const callback of callbacks) callback();
    },
  };
}

function entry(overrides = {}) {
  return {
    scope_id: "col-123",
    scope_title: "My Scope",
    task_id: "col-123.0",
    task_title: "Implement feature",
    task_state: "running",
    attempt: 2,
    run: {
      id: "run-1",
      kind: "implement",
      status: "running",
      model_id: "deepseek-v4-flash",
      started_at: new Date(Date.now() - 30_000).toISOString(),
      finished_at: null,
    },
    ...overrides,
  };
}

/** A run that has ended, so its duration is a fixed number of seconds. */
function finishedRun(startedSecondsAgo, durationSeconds) {
  const started = Date.now() - startedSecondsAgo * 1000;
  return {
    id: "run-1",
    kind: "implement",
    status: "succeeded",
    model_id: "deepseek-v4-flash",
    started_at: new Date(started).toISOString(),
    finished_at: new Date(started + durationSeconds * 1000).toISOString(),
  };
}

function makeTab(entries, props = {}) {
  const el = document.createElement("running-tab");
  el.entries = entries;
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of ["colony-open-task", "colony-open-scope"]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("running-tab empty state", () => {
  it("shows the monolith's copy when nothing is running", async () => {
    const el = makeTab([]);
    await el.updateComplete;
    const empty = el.querySelector(".running-empty.rack-empty");
    expect(empty).toBeTruthy();
    expect(empty.querySelector("p").textContent).toBe(
      "Nothing running right now.",
    );
    expect(el.querySelector(".running-list")).toBeNull();
  });

  it("adds the queued/blocked tallies when the project reports them", async () => {
    const el = makeTab([], {
      project: { task_state_counts: { queued: 3, blocked: 1 } },
    });
    await el.updateComplete;
    expect(el.querySelector(".running-tallies").textContent).toBe(
      "3 queued · 1 blocked",
    );
  });

  it("omits the tallies line when the project has no counts", async () => {
    const el = makeTab([], { project: {} });
    await el.updateComplete;
    expect(el.querySelector(".running-tallies")).toBeNull();
  });
});

describe("running-tab rows", () => {
  it("renders one row per entry with the monolith's classes", async () => {
    const el = makeTab([entry(), entry({ task_id: "col-123.1", run: null })]);
    await el.updateComplete;
    const rows = [...el.querySelectorAll(".running-list .running-row")];
    expect(rows.length).toBe(2);
    expect(rows[0].getAttribute("role")).toBe("button");
    expect(rows[0].getAttribute("tabindex")).toBe("0");
    expect(rows[0].querySelector(".running-main .scope-chip").textContent).toBe(
      "My Scope",
    );
    expect(rows[0].querySelector(".running-task-title").textContent).toBe(
      "Implement feature",
    );
    expect(rows[0].querySelector(".running-attempt").textContent).toBe(
      "attempt 2",
    );
    expect(rows[0].querySelector(".running-run-info").textContent).toBe(
      "build · deepseek-v4-flash",
    );
  });

  it("renders an entry with no run without a run-info line", async () => {
    const el = makeTab([entry({ run: null, task_state: "mr_open" })]);
    await el.updateComplete;
    const row = el.querySelector(".running-row");
    expect(row.querySelector(".running-run-info")).toBeNull();
    expect(row.querySelector(".badge").getAttribute("data-state")).toBe(
      "mr_open",
    );
    expect(row.querySelector(".running-duration").textContent).toBe("—");
    expect(
      row.querySelector(".running-duration").classList.contains("live"),
    ).toBe(false);
  });

  it("bubbles colony-open-task from the row body, and only colony-open-scope from its chip", async () => {
    const el = makeTab([entry()]);
    const seen = eventsOf(el);
    await el.updateComplete;
    const row = el.querySelector(".running-row");
    row.querySelector(".scope-chip").click();
    expect(seen).toEqual([["colony-open-scope", { id: "col-123" }]]);
    row.click();
    expect(seen[1]).toEqual([
      "colony-open-task",
      { scopeId: "col-123", taskId: "col-123.0" },
    ]);
  });

  it("opens the task from the keyboard too", async () => {
    const el = makeTab([entry()]);
    const seen = eventsOf(el);
    await el.updateComplete;
    const row = el.querySelector(".running-row");
    for (const key of ["Enter", " "]) {
      row.dispatchEvent(
        new window.KeyboardEvent("keydown", { key, bubbles: true }),
      );
    }
    expect(seen).toEqual([
      ["colony-open-task", { scopeId: "col-123", taskId: "col-123.0" }],
      ["colony-open-task", { scopeId: "col-123", taskId: "col-123.0" }],
    ]);
  });

  it("keys rows on scope:task so a re-sent list patches rows in place", async () => {
    const el = makeTab([entry(), entry({ task_id: "col-123.1" })]);
    await el.updateComplete;
    const first = el.querySelectorAll(".running-row")[0];
    const second = el.querySelectorAll(".running-row")[1];
    el.entries = [
      entry({ task_state: "mr_open", run: null }),
      entry({ task_id: "col-123.1" }),
      entry({ task_id: "col-123.2" }),
    ];
    await el.updateComplete;
    const rows = [...el.querySelectorAll(".running-row")];
    expect(rows.length).toBe(3);
    expect(rows[0]).toBe(first);
    expect(rows[1]).toBe(second);
    expect(rows[0].querySelector(".badge").getAttribute("data-state")).toBe(
      "mr_open",
    );
  });
});

describe("running-tab live durations", () => {
  it("advances a running row's duration on every tick", async () => {
    // The clock is pinned, so the tick is the only thing that can move the
    // duration: pin a run that started 30s before T0, advance the clock 30s,
    // tick once, and the row must repaint 30s -> 1m 00s. A duration that
    // only tracks `entries` would sit on the stale value.
    const start = Date.parse("2026-08-30T12:00:00.000Z");
    const clock = fakeClock(start);
    clock.install();
    try {
      const ticker = manualTicker();
      const el = makeTab([entry()], { ticker });
      await el.updateComplete;
      const duration = el.querySelector(".running-duration");
      expect(duration.classList.contains("live")).toBe(true);
      expect(duration.textContent).toBe("30s");
      expect(duration.getAttribute("aria-label")).toMatch(/^running for /);
      expect(duration.getAttribute("title")).toBe("PT30S");
      clock.advance(30_000);
      ticker.tick();
      await el.updateComplete;
      expect(duration.textContent).toBe("1m 00s");
      expect(duration.getAttribute("aria-label")).toMatch(
        /^running for 1 minute/,
      );
    } finally {
      clock.restore();
    }
  });

  it("renders a finished run's duration statically", async () => {
    const el = makeTab([
      entry({ task_state: "merged", run: finishedRun(125, 65) }),
    ]);
    await el.updateComplete;
    const duration = el.querySelector(".running-duration");
    expect(duration.classList.contains("live")).toBe(false);
    expect(duration.textContent).toBe("1m 05s");
    expect(duration.getAttribute("aria-label")).toMatch(/^ran for /);
  });

  it("borrows the clock: it neither starts nor stops it, and unsubscribes on disconnect", async () => {
    // The ticker is the shell's interval and the Running tab is only one of
    // its consumers: the project page mounts this element solely while the
    // Running tab is active, so stopping the clock on disconnect would
    // leave every other live surface frozen for the rest of the session.
    const ticker = manualTicker();
    const el = makeTab([entry()], { ticker });
    await el.updateComplete;
    expect(ticker.calls.start).toBe(0);
    expect(ticker.calls.stop).toBe(0);

    el.remove();
    expect(ticker.calls.stop).toBe(0);
    // Unsubscribed, so later ticks cannot reach a detached element.
    const ticked = () => ticker.tick();
    expect(ticked).not.toThrow();
  });

  it("re-binds when the shell hands down a different clock", async () => {
    const first = manualTicker();
    const second = manualTicker();
    const el = makeTab([entry()], { ticker: first });
    await el.updateComplete;
    const duration = el.querySelector(".running-duration");
    expect(duration.textContent).toBe("30s");

    el.ticker = second;
    await el.updateComplete;
    expect(second.calls.start).toBe(0);
    // The old clock no longer reaches the element; the new one does.
    first.tick();
    await el.updateComplete;
    expect(el.querySelector(".running-duration").textContent).toBe("30s");
    second.tick();
    await el.updateComplete;
    expect(el.querySelector(".running-duration").textContent).toMatch(
      /^\d+m|\d+s$/,
    );
  });
});
