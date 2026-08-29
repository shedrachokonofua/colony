import { describe, expect, it } from "bun:test";
import {
  PROJECT_CARDS_GRID_DESKTOP,
  PROJECT_CARDS_GRID_MOBILE,
  buildNewProjectPayload,
  knowledgeText,
  repoSummaryText,
  resolveComposerProject,
} from "./project-helpers.js";

describe("project-card markup invariants", () => {
  it("knowledge line: Brief with file count when context_doc present", () => {
    expect(knowledgeText("Some brief", 3)).toBe("Brief · 3 reference files");
    expect(knowledgeText("Some brief", 1)).toBe("Brief · 1 reference file");
  });

  it("knowledge line: No brief when context_doc empty/null", () => {
    expect(knowledgeText(null, 0)).toBe("No brief · 0 reference files");
    expect(knowledgeText("", 2)).toBe("No brief · 2 reference files");
  });

  it("repo summary: No connected repositories when empty", () => {
    expect(repoSummaryText([])).toBe("No connected repositories");
    expect(repoSummaryText(null)).toBe("No connected repositories");
  });

  it("repo summary: count + up to two paths + more indicator", () => {
    expect(
      repoSummaryText([
        { repo_id: "49", repo_path: "so/colony" },
        { repo_id: "112", repo_path: "so/console-e2e" },
      ]),
    ).toBe("2 connected repos · so/colony · so/console-e2e");

    expect(
      repoSummaryText([
        { repo_id: "1", repo_path: "a/b" },
        { repo_id: "2", repo_path: "c/d" },
        { repo_id: "3", repo_path: "e/f" },
      ]),
    ).toBe("3 connected repos · a/b · c/d +1 more");
  });

  it("repo summary: single repo", () => {
    expect(repoSummaryText([{ repo_id: "1", repo_path: "only/repo" }])).toBe(
      "1 connected repo · only/repo",
    );
  });
});

describe("project-card grid layout", () => {
  it("two-column desktop class", () => {
    expect(PROJECT_CARDS_GRID_DESKTOP).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("one-column mobile class", () => {
    expect(PROJECT_CARDS_GRID_MOBILE).toBe("1fr");
  });
});

describe("new-project payload", () => {
  it("requires name, optional context_doc", () => {
    expect(buildNewProjectPayload("Test Project", "")).toEqual({
      name: "Test Project",
    });
    expect(buildNewProjectPayload("Test", "Brief")).toEqual({
      name: "Test",
      context_doc: "Brief",
    });
  });

  it("returns null for empty/whitespace name", () => {
    expect(buildNewProjectPayload("", "Brief")).toBeNull();
    expect(buildNewProjectPayload("  ", "Brief")).toBeNull();
  });
});

describe("composer fixed-project behavior", () => {
  it("submits the fixed project when hashQueryProject is present", () => {
    expect(resolveComposerProject("Fixed Project", "Form Value")).toBe(
      "Fixed Project",
    );
    expect(resolveComposerProject("Fixed Project", "")).toBe("Fixed Project");
  });

  it("falls back to the form field when hashQueryProject is absent", () => {
    expect(resolveComposerProject(null, "Form Project")).toBe("Form Project");
    expect(resolveComposerProject("", "Form Project")).toBe("Form Project");
  });

  it("falls back to empty string when both are missing", () => {
    expect(resolveComposerProject(null, "")).toBe("");
    expect(resolveComposerProject(null, null)).toBe("");
  });
});
