import { describe, expect, it } from "bun:test";
import {
  DEMO_PROJECT_COUNT,
  DEMO_SCOPES_IN_PROJECT,
  DEMO_SHA_A,
  DEMO_SHA_B,
  buildDemoDetail,
  buildDemoFiles,
  buildDemoProject,
  buildDemoScopes,
  buildEmptyProject,
  buildFillerProjects,
} from "./demo-data.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

describe("demo constants", () => {
  it("size the demo world for page-2 exercise", () => {
    expect(DEMO_PROJECT_COUNT).toBe(27);
    expect(DEMO_SCOPES_IN_PROJECT).toBe(27);
    expect(DEMO_SHA_A).toMatch(/^[0-9a-f]{40}$/);
    expect(DEMO_SHA_B).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("buildFillerProjects", () => {
  it("creates DEMO_PROJECT_COUNT - 1 fillers, newest first, one hour apart", () => {
    const fillers = buildFillerProjects(NOW);
    expect(fillers).toHaveLength(DEMO_PROJECT_COUNT - 1);
    expect(fillers[0].name).toBe("Demo project 00");
    expect(fillers.at(-1)?.name).toBe("Demo project 25");
    expect(Date.parse(fillers[0].updated_at)).toBe(NOW - 3600_000);
    expect(Date.parse(fillers[1].updated_at)).toBe(NOW - 2 * 3600_000);
    for (const filler of fillers) {
      expect(filler.context_doc).toBeNull();
      expect(filler.scope_count).toBe(0);
      expect(filler.repositories).toEqual([]);
      expect(filler.last_activity_at).toBeNull();
    }
  });

  it("every filler is strictly newer than the pinned demo project", () => {
    const fillers = buildFillerProjects(NOW);
    const demo = buildDemoProject(
      NOW,
      buildDemoScopes(NOW),
      buildDemoFiles(NOW),
    );
    for (const filler of fillers) {
      expect(Date.parse(filler.updated_at)).toBeGreaterThan(
        Date.parse(demo.updated_at),
      );
    }
  });
});

describe("buildDemoScopes", () => {
  it("creates DEMO_SCOPES_IN_PROJECT generated scopes owned by Operator console", () => {
    const scopes = buildDemoScopes(NOW);
    expect(scopes).toHaveLength(DEMO_SCOPES_IN_PROJECT);
    expect(scopes[0].id).toBe("col-d00");
    expect(scopes.at(-1)?.id).toBe("col-d26");
    for (const scope of scopes) {
      expect(scope.project_name).toBe("Operator console");
      expect(["active", "validating", "done", "blocked"]).toContain(
        scope.status,
      );
    }
  });

  it("stamps created one hour apart starting three hours back, updated a minute later", () => {
    const scopes = buildDemoScopes(NOW);
    expect(Date.parse(scopes[0].created_at)).toBe(NOW - 3 * 3600_000);
    expect(Date.parse(scopes[1].created_at)).toBe(NOW - 4 * 3600_000);
    expect(Date.parse(scopes[0].updated_at)).toBe(
      Date.parse(scopes[0].created_at) + 60_000,
    );
  });
});

describe("buildDemoProject", () => {
  const scopes = buildDemoScopes(NOW);
  const files = buildDemoFiles(NOW);
  const project = buildDemoProject(NOW, scopes, files);

  it("pins the Operator console project with counts derived from inputs", () => {
    expect(project.name).toBe("Operator console");
    expect(project.scope_count).toBe(DEMO_SCOPES_IN_PROJECT);
    expect(project.status_counts).toEqual({
      draft: 0,
      planning: 0,
      active: 7,
      validating: 7,
      blocked: 6,
      done: 7,
      abandoned: 0,
    });
    expect(project.file_count).toBe(2);
    expect(project.file_bytes).toBe(512 + 1280);
    expect(project.repositories).toEqual([
      { repo_id: "49", repo_path: "so/colony" },
      { repo_id: "112", repo_path: "so/console-e2e" },
    ]);
  });

  it("last_activity_at is the newest scope update", () => {
    const newest = Math.max(...scopes.map((s) => Date.parse(s.updated_at)));
    expect(Date.parse(project.last_activity_at!)).toBe(newest);
  });

  it("updated_at lands DEMO_PROJECT_COUNT + 1 hours back, behind every filler", () => {
    expect(Date.parse(project.updated_at)).toBe(
      NOW - (DEMO_PROJECT_COUNT + 1) * 3600_000,
    );
  });
});

describe("buildDemoDetail", () => {
  const detail = buildDemoDetail(NOW);

  it("returns the pinned scope with its task chain", () => {
    expect(detail.scope.id).toBe("col-a1b2c3d4");
    expect(detail.tasks.map((t) => t.id)).toEqual([
      "col-a1b2c3d4.0",
      "col-a1b2c3d4.1",
      "col-a1b2c3d4.2",
    ]);
    expect(detail.deps).toEqual([
      { task_id: "col-a1b2c3d4.1", depends_on_task_id: "col-a1b2c3d4.0" },
      { task_id: "col-a1b2c3d4.2", depends_on_task_id: "col-a1b2c3d4.1" },
    ]);
  });

  it("runs carry the demo SHAs and a perpetually-running gate", () => {
    const gate = detail.runs.find((r) => r.id === "run-gate-1");
    expect(gate?.status).toBe("running");
    expect(gate?.head_sha).toBe(DEMO_SHA_B);
    expect(gate?.finished_at).toBeNull();
    const impl = detail.runs.find((r) => r.id === "run-impl-0");
    expect(impl?.head_sha).toBe(DEMO_SHA_A);
  });

  it("timestamps derive from now, not Date.now()", () => {
    const scope = detail.scope as { created_at: string; updated_at: string };
    expect(Date.parse(scope.created_at)).toBe(NOW - 36 * 60 * 1000);
    expect(Date.parse(scope.updated_at)).toBe(NOW - 12 * 1000);
  });
});

describe("buildEmptyProject / buildDemoFiles", () => {
  it("empty project exposes every zeroed surface", () => {
    const empty = buildEmptyProject(NOW);
    expect(empty.name).toBe("Empty workspace");
    expect(empty.context_doc).toBeNull();
    expect(empty.scope_count).toBe(0);
    expect(empty.file_count).toBe(0);
    expect(empty.repositories).toEqual([]);
    expect(empty.last_activity_at).toBeNull();
  });

  it("demo files carry markdown fixtures sized into the project", () => {
    const files = buildDemoFiles(NOW);
    expect(files.map((f) => f.filename)).toEqual([
      "AGENTS.md",
      "conventions.md",
    ]);
    expect(files.every((f) => f.media_type === "text/markdown")).toBe(true);
  });
});
