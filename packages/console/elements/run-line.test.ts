// Unit tests for <run-line>, under happy-dom: the row mirrors the monolith's
// runLine — kind label, status, live duration, trace link, findings — with
// the same CSS classes.
// @ts-nocheck
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "bun:test";

// reactive-element's happy-dom mode patches `window.HTMLElement`, so the
// Window globals must be installed before `../base.js` (and therefore lit)
// is imported; dynamic import here is the sequencing primitive.
const win = new Window({ url: "https://console.local/" });
win.window = win;
globalThis.window = win;
globalThis.document = win.document;
globalThis.customElements = win.customElements;
globalThis.HTMLElement = win.HTMLElement;

await import("./run-line.js");
await import("./run-duration.js");

const BASE_RUN = {
  id: "run-1",
  kind: "implement",
  status: "succeeded",
  model_id: "glm-5.3-flash",
  head_sha: "abcdef1234567890",
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: "2026-01-01T00:02:05.000Z",
  error: null,
  evidence_json: null,
  trace_id: null,
};

function makeLine(overrides = {}) {
  const el = document.createElement("run-line");
  el.run = { ...BASE_RUN, ...overrides };
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("run-line", () => {
  it("renders kind label, status and meta with monolith classes", async () => {
    const el = makeLine();
    await el.updateComplete;
    const root = el.querySelector("div.run-line");
    expect(root.getAttribute("data-status")).toBe("succeeded");
    expect(el.querySelector(".kind")?.textContent).toContain("build");
    expect(el.querySelector(".kind")?.textContent).toContain("succeeded");
    expect(el.querySelector(".meta")?.textContent).toContain("glm-5.3-flash");
    expect(el.querySelector(".meta")?.textContent).toContain("abcdef1");
  });

  it("maps every run kind through KIND_LABEL", async () => {
    const labels = {
      architect: "plan",
      merge_gate: "gate",
      validate: "validate",
      review: "review",
    };
    for (const [kind, label] of Object.entries(labels)) {
      const el = makeLine({ kind });
      await el.updateComplete;
      expect(el.querySelector(".kind")?.textContent).toContain(label);
      el.remove();
    }
  });

  it("renders a run-duration with the run's timestamps", async () => {
    const el = makeLine();
    await el.updateComplete;
    const duration = el.querySelector("run-duration");
    expect(duration).toBeTruthy();
    expect(duration.startedAt).toBe(BASE_RUN.started_at);
    expect(duration.finishedAt).toBe(BASE_RUN.finished_at);
    expect(duration.textContent).toContain("2m 05s");
  });

  it("renders the trace link only when config and trace_id exist", async () => {
    const el = makeLine();
    await el.updateComplete;
    expect(el.querySelector("a.run-trace")).toBeNull();
    el.config = { trace_ui_base_url: "https://trace.local/?id={trace_id}" };
    el.run = { ...BASE_RUN, trace_id: "abc123" };
    await el.updateComplete;
    const link = el.querySelector("a.run-trace");
    expect(link?.getAttribute("href")).toBe("https://trace.local/?id=abc123");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  it("renders evidence findings and verdict", async () => {
    const el = makeLine({
      evidence_json: JSON.stringify({
        verdict: "pass",
        findings: [
          { severity: "high", note: "MR description empty", file: null },
        ],
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".kind")?.textContent).toContain("pass");
    const items = [...el.querySelectorAll(".findings li")];
    expect(items.length).toBe(1);
    expect(items[0].textContent?.replace(/\s+/g, " ").trim()).toContain(
      "high — MR description empty",
    );
  });

  it("shows the run error on the meta line", async () => {
    const el = makeLine({ status: "failed", error: "boom" });
    await el.updateComplete;
    expect(el.querySelector("div.run-line").getAttribute("data-status")).toBe(
      "failed",
    );
    expect(el.querySelector(".meta")?.textContent).toContain("boom");
  });

  it("renders nothing without a run", async () => {
    const el = document.createElement("run-line");
    document.body.append(el);
    await el.updateComplete;
    expect(el.querySelector("div.run-line")).toBeNull();
  });

  it("renders a cost-prediction line when a task with one is attached", async () => {
    const el = makeLine();
    el.task = {
      cost_prediction_json: JSON.stringify({
        predicted_ms: 90_000,
        budget_ms: 600_000,
        files_touched: 3,
        sample_size: 12,
        flagged: false,
        model_version: "v1",
      }),
    };
    await el.updateComplete;
    expect(el.textContent?.replace(/\s+/g, " ")).toContain(
      "predicted 1m 30s · budget 10m",
    );
  });
});