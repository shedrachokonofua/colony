import { describe, expect, it } from "bun:test";
import {
  buildNewProjectPayload,
  distinctRepos,
  knowledgeText,
  repoSummaryText,
  resolveComposerProject,
} from "./project-helpers.js";

describe("knowledgeText", () => {
  it("knowledge line: Brief with file count when context_doc present", () => {
    expect(knowledgeText("Some brief", 3)).toBe("Brief · 3 reference files");
    expect(knowledgeText("Some brief", 1)).toBe("Brief · 1 reference file");
  });

  it("knowledge line: No brief when context_doc empty/null", () => {
    expect(knowledgeText(null, 0)).toBe("No brief · 0 reference files");
    expect(knowledgeText("", 2)).toBe("No brief · 2 reference files");
  });
});

describe("repoSummaryText", () => {
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

  it("repo summary: duplicate repo paths count once, first path wins", () => {
    expect(
      repoSummaryText([
        { repo_id: "7", repo_path: "so/colony" },
        { repo_id: "8", repo_path: "so/colony" },
        { repo_id: "9", repo_path: "so/console-e2e" },
      ]),
    ).toBe("2 connected repos · so/colony · so/console-e2e");
  });
});

describe("distinctRepos", () => {
  it("drops pathless entries and keeps first-seen order", () => {
    expect(
      distinctRepos([
        { repo_id: "2", repo_path: "b/c" },
        { repo_id: "1", repo_path: "a/b" },
        { repo_id: "3", repo_path: "b/c" },
        { repo_path: null },
      ]),
    ).toEqual([
      { repo_id: "2", repo_path: "b/c" },
      { repo_id: "1", repo_path: "a/b" },
    ]);
  });

  it("treats null/undefined input as empty", () => {
    expect(distinctRepos(null)).toEqual([]);
    expect(distinctRepos(undefined)).toEqual([]);
  });
});

describe("buildNewProjectPayload", () => {
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

  it("trims name and context_doc", () => {
    expect(buildNewProjectPayload("  Padded  ", "  Doc ")).toEqual({
      name: "Padded",
      context_doc: "Doc",
    });
  });
});

describe("resolveComposerProject", () => {
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

  it("trims both sources", () => {
    expect(resolveComposerProject("  Fixed  ", "Form")).toBe("Fixed");
    expect(resolveComposerProject(null, "  Form  ")).toBe("Form");
  });
});
