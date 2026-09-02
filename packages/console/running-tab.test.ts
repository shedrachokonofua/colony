// The project Running tab, pinned against the modules that actually ship it:
// ?tab= routing round-trip (parse -> serialize), the row model every entry is
// derived into, the empty state's tallies line, and the demo/live data paths
// that feed the surface. Markup assertions live with the element that renders
// them (elements/running-tab.test.ts, views/project-page.test.ts).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemoRunning, buildDemoScopes } from "./demo-data.js";
import {
  deriveRunningRow,
  formatRunningEmptyTallies,
  parseProjectTab,
  serializeProjectTabHref,
} from "./project-helpers.js";
import type { ProjectTab } from "./project-helpers.d.ts";
import type { DerivedRunningRow, RunningEntry } from "./project-helpers.d.ts";

// demo.js reads location.search at module top level and bun tests run with
// no location global, so seed one and pull demo.js in after it. (demo.test.ts
// does the same; seeding here keeps this file order-independent.)
if (!("location" in globalThis)) {
  Object.defineProperty(globalThis, "location", {
    value: { hash: "", search: "" },
    configurable: true,
    writable: true,
  });
}
const { DEMO_READS } = await import("./demo.js");

const here = dirname(fileURLToPath(import.meta.url));
const cssSource = readFileSync(join(here, "styles.css"), "utf8");
const shellSource = readFileSync(join(here, "shell-data.js"), "utf8");

describe("Running tab - Tab routing round-trip", () => {
  it("parses ?tab=running and valid tabs, falling back to 'scopes' on invalid/absent tab", () => {
    expect(parseProjectTab("#/project/colony?tab=running")).toBe("running");
    expect(parseProjectTab("#/project/colony?tab=settings")).toBe("settings");
    expect(parseProjectTab("#/project/colony?tab=scopes")).toBe("scopes");
    expect(parseProjectTab("tab=running")).toBe("running");
    expect(parseProjectTab("#/project/colony?tab=unknown")).toBe("scopes");
    expect(parseProjectTab("#/project/colony")).toBe("scopes");
    expect(parseProjectTab(null)).toBe("scopes");
  });

  it("serializes back to #/project/<name>?tab=... while preserving other query params", () => {
    expect(
      serializeProjectTabHref("#/project/colony", "colony", "running"),
    ).toBe("#/project/colony?tab=running");

    expect(
      serializeProjectTabHref(
        "#/project/colony?project=other",
        "colony",
        "running",
      ),
    ).toBe("#/project/colony?project=other&tab=running");

    expect(
      new URLSearchParams(
        serializeProjectTabHref(
          "#/project/colony?tab=running&project=other",
          "colony",
          "settings",
        ).split("?")[1],
      ).get("tab"),
    ).toBe("settings");
    expect(
      new URLSearchParams(
        serializeProjectTabHref(
          "#/project/colony?tab=running&project=other",
          "colony",
          "settings",
        ).split("?")[1],
      ).get("project"),
    ).toBe("other");

    // Switching to "scopes" clears the ?tab= parameter
    expect(
      serializeProjectTabHref(
        "#/project/colony?tab=running&project=other",
        "colony",
        "scopes",
      ),
    ).toBe("#/project/colony?project=other");
  });

  it("round-trips every tab through parse(serialize(...))", () => {
    const tabs: ProjectTab[] = ["scopes", "running", "settings"];
    for (const tab of tabs) {
      const href = serializeProjectTabHref("#/project/colony", "colony", tab);
      expect(parseProjectTab(href)).toBe(tab);
    }
  });

  it("escapes a project name that needs encoding", () => {
    const href = serializeProjectTabHref("#/project/a b", "a b", "running");
    expect(href).toBe("#/project/a%20b?tab=running");
    // The pager's ?page= rides alongside the tab without either losing it.
    expect(parseProjectTab(`${href}&page=2`)).toBe("running");
  });
});

describe("Running tab - Row model derivation", () => {
  it("derives row model for an entry with a live run", () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const entry = {
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
        started_at: startedAt,
      },
    };

    const derived = deriveRunningRow(entry);
    expect(derived.scopeId).toBe("col-123");
    expect(derived.scopeTitle).toBe("My Scope");
    expect(derived.taskId).toBe("col-123.0");
    expect(derived.taskTitle).toBe("Implement feature");
    expect(derived.taskState).toBe("running");
    expect(derived.attempt).toBe(2);
    expect(derived.attemptText).toBe("attempt 2");
    expect(derived.hasRun).toBe(true);
    expect(derived.runKind).toBe("implement");
    expect(derived.runModel).toBe("deepseek-v4-flash");
    expect(derived.startedAt).toBe(startedAt);
    expect(derived.isRunning).toBe(true);
    expect(derived.run?.status).toBe("running");
  });

  it("derives row model for an entry with run: null (e.g. mr_open)", () => {
    const entry = {
      scope_id: "col-456",
      scope_title: "Review Scope",
      task_id: "col-456.1",
      task_title: "Wait for MR merge",
      task_state: "mr_open",
      attempt: 1,
      run: null,
    };

    const derived = deriveRunningRow(entry);
    expect(derived.scopeId).toBe("col-456");
    expect(derived.scopeTitle).toBe("Review Scope");
    expect(derived.taskId).toBe("col-456.1");
    expect(derived.taskTitle).toBe("Wait for MR merge");
    expect(derived.taskState).toBe("mr_open");
    expect(derived.attempt).toBe(1);
    expect(derived.attemptText).toBe("attempt 1");
    expect(derived.hasRun).toBe(false);
    expect(derived.runKind).toBe("");
    expect(derived.runModel).toBe("");
    expect(derived.startedAt).toBe(null);
    expect(derived.isRunning).toBe(false);
  });

  it("falls back to the ids for a row with no titles", () => {
    const derived = deriveRunningRow({
      scope_id: "col-789",
      task_id: "col-789.2",
      run: null,
    });
    expect(derived.scopeTitle).toBe("col-789");
    expect(derived.taskTitle).toBe("col-789.2");
    expect(derived.taskState).toBe("queued");
    expect(derived.attemptText).toBe("attempt 0");
  });
});

describe("Running tab - Empty state", () => {
  it("formats tallies line when task_state_counts present", () => {
    expect(
      formatRunningEmptyTallies({
        queued: 3,
        blocked: 1,
        running: 0,
        mr_open: 0,
        merged: 5,
        canceled: 0,
      }),
    ).toBe("3 queued · 1 blocked");
  });

  it("returns null when task_state_counts is missing or null", () => {
    expect(formatRunningEmptyTallies(null)).toBe(null);
    expect(formatRunningEmptyTallies(undefined)).toBe(null);
  });

  it("formats empty tallies correctly when present", () => {
    expect(
      formatRunningEmptyTallies({
        queued: 1,
        blocked: 0,
        running: 0,
        mr_open: 0,
        merged: 0,
        canceled: 0,
      }),
    ).toBe("1 queued · 0 blocked");
  });
});

describe("Running tab - Demo mode and live ticker", () => {
  it("DEMO_READS matches /projects/<name>/running", () => {
    expect(DEMO_READS.test("/projects/Operator%20console/running")).toBe(true);
    expect(DEMO_READS.test("/projects/colony/running")).toBe(true);
    // The running read is the only /running path that resolves offline; a
    // deeper one would fall through to the live API and fail the demo.
    expect(DEMO_READS.test("/projects/colony/running/extra")).toBe(false);
  });

  it("demo running rows resolve to real tasks so row navigation selects one", () => {
    const now = Date.parse("2026-08-30T12:00:00.000Z");
    const scopes = buildDemoScopes(now);
    const { entries, details } = buildDemoRunning(now, scopes);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const derived = deriveRunningRow(entry);
      // Every row's scope has a detail payload containing its task, so a row
      // click lands on a sheet that can actually select the task.
      const detail = details[derived.scopeId];
      expect(detail).toBeDefined();
      expect(detail.scope.id).toBe(derived.scopeId);
      expect(
        detail.tasks.some(
          (task: Record<string, unknown>) => task.id === derived.taskId,
        ),
      ).toBe(true);
    }
  });

  it("demo rows carry a live run and a past-run row, both typed for the row model", () => {
    const now = Date.parse("2026-08-30T12:00:00.000Z");
    const { entries } = buildDemoRunning(now, buildDemoScopes(now));
    const derived = entries.map((entry: RunningEntry) =>
      deriveRunningRow(entry),
    );
    const live = derived.filter((row: DerivedRunningRow) => row.isRunning);
    const idle = derived.filter((row: DerivedRunningRow) => !row.hasRun);
    expect(live.length).toBe(1);
    expect(live[0].runModel).toBeTruthy();
    expect(live[0].startedAt).toBeTruthy();
    expect(idle.length).toBe(1);
    expect(idle[0].taskState).toBe("mr_open");
  });

  it("live refresh reads the project's running rows", () => {
    // The route's read must be in the project branch of refresh(), next to
    // the scopes page it shares the project with.
    expect(shellSource).toContain(
      "`/projects/${encodeURIComponent(projectName)}/running`",
    );
    expect(shellSource).toContain(
      "app.projectRunning = Array.isArray(runningRows) ? runningRows : [];",
    );
  });

  it("styles.css provides styles for running tab components", () => {
    expect(cssSource).toContain(".project-running");
    expect(cssSource).toContain(".running-row");
    expect(cssSource).toContain(".scope-chip");
    expect(cssSource).toContain('.badge[data-state="running"]');
  });
});
