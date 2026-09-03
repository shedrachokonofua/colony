// Unit tests for <run-line>, under happy-dom: the row mirrors the monolith's
// runLine — kind label, status, live duration, trace link, findings — with
// the same CSS classes.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./test-dom.js";

// Element modules self-register into globalThis.customElements at import
// time (a static import would hoist above this setup), so the shared
// window must be installed before they load.
sharedDom();

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
    const root = el.querySelector("div.run");
    expect(root.getAttribute("data-status")).toBe("succeeded");
    expect(el.querySelector(".kind")?.textContent).toContain("build");
    expect(el.querySelector(".kind")?.textContent).toContain("succeeded");
    expect(el.querySelector(".meta")?.textContent).toContain("glm-5.3-flash");
    expect(el.querySelector(".meta")?.textContent).toContain("abcdef1");
  });

  it("carries the monolith's rel() age on the meta line", async () => {
    const el = makeLine();
    await el.updateComplete;
    expect(el.querySelector(".meta")?.textContent).toMatch(
      /\d+[sdh] ago|just now/,
    );
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
    expect(el.querySelector("div.run").getAttribute("data-status")).toBe(
      "failed",
    );
    expect(el.querySelector(".meta")?.textContent).toContain("boom");
  });

  it("renders a layer/code span on failed runs with fault", async () => {
    const el = makeLine({
      status: "failed",
      fault: { layer: "provider", code: "rate_limit" },
      error: "429 Too Many Requests",
    });
    await el.updateComplete;
    expect(el.querySelector(".meta")?.textContent).toContain("provider/rate_limit");
  });

  it("renders an unknown badge with class fault-unknown when fault layer is unknown", async () => {
    const el = makeLine({
      status: "failed",
      fault: { layer: "unknown", code: "unclassified" },
      error: "weird error",
    });
    await el.updateComplete;
    const badge = el.querySelector(".fault-unknown");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("unknown");
    expect(el.querySelector(".meta")?.textContent).toContain("unclassified");
  });

  it("renders nothing without a run", async () => {
    const el = document.createElement("run-line");
    document.body.append(el);
    await el.updateComplete;
    expect(el.querySelector("div.run")).toBeNull();
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
