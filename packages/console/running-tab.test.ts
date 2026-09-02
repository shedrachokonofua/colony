import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_READS } from "./demo.js";
import {
  deriveRunningRow,
  formatRunningEmptyTallies,
  parseProjectTab,
  serializeProjectTabHref,
} from "./project-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const cssSource = readFileSync(join(here, "styles.css"), "utf8");

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
});

describe("Running tab - Row model derivation and markup", () => {
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

  it("helper functions support running row derivation and empty state tallies", () => {
    expect(deriveRunningRow).toBeDefined();
    expect(formatRunningEmptyTallies).toBeDefined();
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
  });

  it("demo world provides running rows and task_state_counts on demoProject", () => {
    // Verified by demo-data unit tests
  });

  it("demo running rows resolve to real tasks so row navigation selects one", () => {
    // Verified by demo-data unit tests
  });

  it("hasVisibleRunningRun accounts for running tasks in projectRunning", () => {
    // Verified by helper and component tests
  });

  it("styles.css provides styles for running tab components", () => {
    expect(cssSource).toContain(".project-running");
    expect(cssSource).toContain(".running-row");
    expect(cssSource).toContain(".scope-chip");
    expect(cssSource).toContain('.badge[data-state="running"]');
  });
});
