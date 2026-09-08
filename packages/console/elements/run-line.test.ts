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

  it("shows the active tool and its live elapsed duration", async () => {
    const el = makeLine({
      status: "running",
      finished_at: null,
      active_tool: "bash",
      active_tool_detail: "npm run test:unit",
      active_tool_started_at: new Date(Date.now() - 65_000).toISOString(),
    });
    await el.updateComplete;
    const active = el.querySelector(".active-operation");
    expect(active?.textContent.replace(/\s+/g, " ").trim()).toContain(
      "running bash: npm run test:unit",
    );
    expect(active?.querySelector("run-duration")?.textContent).toContain(
      "1m 05s",
    );
    el.run = {
      ...el.run,
      status: "succeeded",
      finished_at: new Date().toISOString(),
    };
    await el.updateComplete;
    expect(el.querySelector(".active-operation")).toBeNull();
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
    expect(el.querySelector(".meta")?.textContent).toContain(
      "provider/rate_limit",
    );
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

  it("expands a review run's dimensions with spec-blind badge, targets, and findings", async () => {
    const el = makeLine({
      kind: "review",
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: "abcdef1234567890",
        findings: [
          { severity: "major", note: "missing case", file: "src/a.ts" },
        ],
        dimensions: [
          {
            name: "spec-compliance",
            spec_blind: false,
            target_files: ["src/a.ts"],
            findings: 1,
          },
          {
            name: "defect-scan",
            spec_blind: true,
            target_files: ["src/a.ts", "src/b.ts"],
            findings: 0,
          },
        ],
        challenged: { reviewed: 2, dropped: 1 },
      }),
    });
    await el.updateComplete;
    const rows = [...el.querySelectorAll(".dimensions li")].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("spec-compliance");
    expect(rows[0]).toContain("src/a.ts");
    expect(rows[1]).toContain("defect-scan");
    expect(rows[1]).toContain("spec-blind");
    expect(rows[1]).toContain("src/a.ts, src/b.ts");
    expect(
      el.querySelector(".challenged")?.textContent?.replace(/\s+/g, " "),
    ).toContain("self-check: 2 examined · 1 set aside");
    expect(el.textContent).not.toContain("challenged reviewed");
    expect(el.querySelector(".challenged")?.textContent).toContain(
      "candidates considered but not submitted",
    );
  });

  it("leaves older verdict-only review rows and non-review rows untouched", async () => {
    const review = makeLine({
      kind: "review",
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: "abcdef1234567890",
        findings: [{ severity: "major", note: "missing case" }],
      }),
    });
    await review.updateComplete;
    expect(review.querySelector(".dimensions")).toBeNull();
    expect(review.querySelector(".challenged")).toBeNull();
    expect(review.textContent).toContain(
      "full details unavailable for this older record",
    );
    review.remove();

    const build = makeLine({
      evidence_json: JSON.stringify({
        verdict: "pass",
        dimensions: [
          {
            name: "defect-scan",
            spec_blind: true,
            target_files: ["src/a.ts"],
            findings: 0,
          },
        ],
        challenged: { reviewed: 1, dropped: 0 },
      }),
    });
    await build.updateComplete;
    expect(build.querySelector(".dimensions")).toBeNull();
    expect(build.querySelector(".challenged")).toBeNull();
    expect(build.textContent).not.toContain("unavailable");
  });

  const REVIEW_BASE = {
    kind: "review",
    status: "succeeded",
    head_sha: "abcdef1234567890",
  };

  it("renders an approve's rationale and every recorded finding", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: JSON.stringify({
        verdict: "approve",
        head_sha: "abcdef1234567890",
        dimensions: [
          {
            name: "spec-compliance",
            spec_blind: false,
            target_files: [],
            findings: 0,
          },
          {
            name: "defect-scan",
            spec_blind: true,
            target_files: [],
            findings: 4,
          },
          {
            name: "test-coverage",
            spec_blind: true,
            target_files: [],
            findings: 4,
          },
          {
            name: "regression-risk",
            spec_blind: true,
            target_files: [],
            findings: 4,
          },
        ],
        challenged: { reviewed: 11, dropped: 7 },
      }),
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        verdict: "approve",
        summary:
          "The change moves the verdict store behind one writer and every read path follows, so approved reviews can no longer disagree with the merge gate.",
        findings: [
          {
            severity: "minor",
            file: "packages/core/src/store.ts",
            note: "store only",
          },
          {
            severity: "minor",
            file: "apps/colonyd/src/http.ts",
            note: "serialize once",
          },
          {
            severity: "minor",
            file: "apps/cli/src/commands/run.ts",
            note: "read one shape",
          },
          { severity: "minor", note: "no shared helper for the fallback" },
        ],
        inspected: [
          { file: "packages/core/src/store.ts", note: "single writer" },
        ],
        dimensions: [
          {
            name: "defect-scan",
            spec_blind: true,
            target_files: ["packages/core/src/store.ts"],
            findings: 4,
          },
        ],
        challenged: { reviewed: 11, dropped: 7 },
        head_sha: "abcdef1234567890",
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".review-summary")?.textContent).toContain(
      "The change moves the verdict store behind one writer",
    );
    expect(el.querySelector(".findings-count")?.textContent).toContain(
      "4 final findings",
    );
    const rows = [...el.querySelectorAll(".findings li")].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("minor — store only");
    expect(rows[0]).toContain("packages/core/src/store.ts");
    expect(rows[3]).toContain("minor — no shared helper for the fallback");
    expect(el.querySelector(".kind")?.textContent).toContain("approve");
  });

  it("renders request_changes findings from the envelope identically", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: "abcdef1234567890",
        findings: [{ severity: "major", note: "stale evidence finding" }],
      }),
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        verdict: "request_changes",
        summary:
          "The reviewer rejects the change because the gate still writes twice.",
        findings: [
          {
            severity: "blocker",
            file: "apps/colonyd/src/main.ts",
            note: "second writer remains",
          },
          { severity: "minor", note: "comment is noise" },
        ],
        inspected: [],
        dimensions: [],
        challenged: { reviewed: 2, dropped: 0 },
        head_sha: "abcdef1234567890",
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".review-summary")?.textContent).toContain(
      "the gate still writes twice",
    );
    expect(el.querySelector(".findings-count")?.textContent).toContain(
      "2 final findings",
    );
    const rows = [...el.querySelectorAll(".findings li")].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("blocker — second writer remains");
    expect(rows[0]).toContain("apps/colonyd/src/main.ts");
    // The envelope's findings are the final ones; the evidence copy is not
    // rendered a second time.
    expect(el.textContent).not.toContain("stale evidence finding");
  });

  it("says so plainly when an approve records zero findings", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: JSON.stringify({
        verdict: "approve",
        head_sha: "abcdef1234567890",
      }),
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        verdict: "approve",
        summary:
          "A clean approve: the diff is small and covered by tests end to end.",
        findings: [],
        inspected: [{ file: "src/a.ts", note: "covered by tests" }],
        dimensions: [],
        challenged: { reviewed: 3, dropped: 3 },
        head_sha: "abcdef1234567890",
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".findings-count")?.textContent).toContain(
      "no final findings were recorded",
    );
    expect(el.querySelector(".findings")).toBeNull();
  });

  it("keeps coverage behind a disclosure below the verdict", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: JSON.stringify({
        verdict: "approve",
        head_sha: "abcdef1234567890",
      }),
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        verdict: "approve",
        summary:
          "Approved after reading every call site of the changed writer.",
        findings: [],
        inspected: [
          {
            file: "packages/core/src/store.ts",
            note: "every call site follows",
          },
        ],
        dimensions: [
          {
            name: "defect-scan",
            spec_blind: true,
            target_files: [
              "packages/core/src/store.ts",
              "apps/colonyd/src/http.ts",
            ],
            findings: 2,
          },
        ],
        challenged: { reviewed: 5, dropped: 5 },
        head_sha: "abcdef1234567890",
      }),
    });
    await el.updateComplete;
    const details = el.querySelector("details.review-coverage");
    expect(details).toBeTruthy();
    expect(details?.querySelector("summary")?.textContent).toContain(
      "review coverage",
    );
    expect(
      details
        ?.querySelector(".dimensions li")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toContain("defect-scan spec-blind · 2 candidates");
    expect(details?.textContent?.replace(/\s+/g, " ")).toContain(
      "counts may overlap, so they are not an additive total",
    );
    expect(details?.querySelector(".inspected li")?.textContent).toContain(
      "every call site follows",
    );
    expect(details?.querySelector(".spec-blind")).toBeTruthy();
    expect(details?.querySelector(".spec-blind")?.getAttribute("title")).toBe(
      "checked without seeing the task spec",
    );
    // Coverage is below the verdict, not before it.
    const reviewDetail = el.querySelector(".review-detail");
    expect(reviewDetail?.textContent?.indexOf("verdict: approve")).toBeLessThan(
      reviewDetail?.textContent?.indexOf("review coverage") ?? -1,
    );
  });

  it("escapes envelope prose instead of rendering markup", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: null,
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        verdict: "approve",
        summary: "<img src=x onerror=alert(1)> rationale",
        findings: [{ severity: "minor", note: "<script>alert(2)</script>" }],
        inspected: [],
        dimensions: [],
        challenged: { reviewed: 1, dropped: 0 },
        head_sha: "abcdef1234567890",
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".review-summary")?.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
  });

  it("falls back to evidence on a malformed envelope", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: "abcdef1234567890",
        findings: [{ severity: "major", note: "evidence fallback finding" }],
      }),
      envelope_json: "{not json",
    });
    await el.updateComplete;
    expect(el.querySelector(".review-detail")).toBeNull();
    expect(el.querySelector(".findings li")?.textContent).toContain(
      "evidence fallback finding",
    );
    expect(el.textContent).toContain(
      "full details unavailable for this older record",
    );
  });

  it("falls back to evidence when the envelope lacks a verdict", async () => {
    const el = makeLine({
      ...REVIEW_BASE,
      evidence_json: JSON.stringify({
        verdict: "approve",
        head_sha: "abcdef1234567890",
        findings: [{ severity: "minor", note: "only evidence carries it" }],
      }),
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        summary: "no verdict here",
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".review-detail")).toBeNull();
    expect(el.querySelector(".findings li")?.textContent).toContain(
      "only evidence carries it",
    );
    expect(el.textContent).toContain("unavailable");
  });

  it("states no verdict was submitted for a failed review run", async () => {
    const el = makeLine({
      kind: "review",
      status: "failed",
      error: "reviewer timed out",
      evidence_json: JSON.stringify({ head_sha: "abcdef1234567890" }),
    });
    await el.updateComplete;
    expect(el.textContent).toContain("no accepted verdict was submitted");
    expect(el.querySelector(".review-detail")).toBeNull();
  });

  it("never presents a failed head-mismatch envelope as the verdict", async () => {
    const el = makeLine({
      kind: "review",
      status: "failed",
      error: "envelope facts unverified: reviewed head_sha mismatch",
      evidence_json: JSON.stringify({ head_sha: "abcdef1234567890" }),
      envelope_json: JSON.stringify({
        kind: "reviewer_verdict",
        verdict: "approve",
        summary: "An approve the server rejected for a head SHA mismatch.",
        findings: [],
        inspected: [{ file: "src/a.ts", note: "read" }],
        dimensions: [],
        challenged: { reviewed: 1, dropped: 0 },
        head_sha: "1234567890abcdef1234567890abcdef12345678",
      }),
    });
    await el.updateComplete;
    expect(el.textContent).toContain("no accepted verdict was submitted");
    expect(el.textContent).toContain(
      "a submission was recorded but not accepted",
    );
    expect(el.querySelector(".review-detail")).toBeNull();
    expect(el.querySelector(".review-summary")).toBeNull();
    expect(el.querySelector(".kind")?.textContent).not.toContain("approve");
  });

  it("renders a plan_review envelope row unchanged", async () => {
    const el = makeLine({
      kind: "plan_review",
      status: "succeeded",
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        findings: [{ severity: "major", note: "task 1 has no evidence" }],
      }),
      envelope_json: JSON.stringify({
        kind: "plan_review_verdict",
        verdict: "request_changes",
        summary: "The plan cannot be approved until task 1 names its evidence.",
        findings: [
          { severity: "major", task: 1, note: "task 1 has no evidence" },
        ],
        inspected: [{ file: "docs/spec.md", note: "plan source" }],
      }),
    });
    await el.updateComplete;
    expect(el.querySelector(".review-detail")).toBeNull();
    expect(el.querySelector(".review-summary")).toBeNull();
    expect(
      el
        .querySelector(".findings li")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toContain("major — task 1 has no evidence");
    expect(el.querySelector(".dimensions")).toBeNull();
    expect(el.querySelector(".challenged")).toBeNull();
    expect(el.textContent).not.toContain("unavailable");
  });
});
