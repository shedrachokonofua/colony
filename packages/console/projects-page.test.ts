import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNewProjectPayload,
  distinctRepos,
  knowledgeText,
  repoSummaryText,
  resolveComposerProject,
} from "./project-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "app.js"), "utf8");
const cssSource = readFileSync(join(here, "styles.css"), "utf8");

/** The `grid-template-columns` a selector resolves to, or null when absent. */
function gridColumnsOf(selector: string) {
  const start = cssSource.indexOf(`${selector} {`);
  if (start < 0) return null;
  const rule = cssSource.slice(start, cssSource.indexOf("}", start));
  const match = rule.match(/grid-template-columns:\s*([^;]+);/);
  return match ? match[1].trim() : null;
}

describe("project-card grid layout", () => {
  it("styles.css gives .project-cards two desktop columns", () => {
    expect(gridColumnsOf(".project-cards")).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("styles.css collapses .project-cards to one column at max-width 900px", () => {
    const mediaStart = cssSource.indexOf("@media (max-width: 900px)");
    expect(mediaStart).toBeGreaterThan(0);
    const media = cssSource.slice(
      mediaStart,
      cssSource.indexOf("}", cssSource.indexOf(".project-cards", mediaStart)),
    );
    expect(media).toContain(".project-cards");
    expect(media).toMatch(/grid-template-columns:\s*1fr/);
  });
});

describe("project-card fields", () => {
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

  it("repo summary: duplicate repo paths count once, first path wins", () => {
    expect(
      repoSummaryText([
        { repo_id: "7", repo_path: "so/colony" },
        { repo_id: "8", repo_path: "so/colony" },
        { repo_id: "9", repo_path: "so/console-e2e" },
      ]),
    ).toBe("2 connected repos · so/colony · so/console-e2e");
  });

  it("distinctRepos drops pathless entries and keeps first-seen order", () => {
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
});

describe("index card markup", () => {
  it("app.js renders project cards from .project-cards with a card per project", () => {
    expect(appSource).toContain('<div class="project-cards">');
    expect(appSource).toMatch(
      /class="project-card[^"]*"\s+href=\$\{projectHref\(project\.name\)\}/,
    );
    expect(appSource).toContain('class="project-card-name"');
    expect(appSource).toContain('class="project-card-knowledge"');
  });

  it("app.js never forces the project page's scopes into rack-single", () => {
    expect(appSource).not.toContain("rack rack-single");
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

  it("app.js POSTs the payload to /projects on the new-project route", () => {
    expect(appSource).toContain('api("/projects"');
    expect(appSource).toMatch(/routeIsNewProject\(\)\s*\?\s*renderNewProject/);
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

  it("app.js renders the fixed project as a non-editable element, not an input", () => {
    expect(appSource).toContain('class="composer-fixed"');
    const fixedBranch = appSource.slice(
      appSource.indexOf("composer-fixed"),
      appSource.indexOf('name="project"'),
    );
    expect(fixedBranch.length).toBeGreaterThan(0);
  });
});

describe("archived projects", () => {
  it("app.js offers a Show archived toggle in the index head", () => {
    expect(appSource).toContain("Show archived");
    expect(appSource).toContain("Hide archived");
    // The toggle is list state, so it survives the 2.5s poll refresh.
    expect(appSource).toMatch(/showArchived: false,/);
    expect(appSource).toMatch(
      /\$\{state\.showArchived \? "Hide archived" : "Show archived"\}/,
    );
    const reset = appSource.slice(
      appSource.indexOf('window.addEventListener("hashchange"'),
    );
    expect(reset).toContain("state.showArchived = false;");
  });

  it("the list fetch adds archived=1 only when the toggle is on", () => {
    expect(appSource).toMatch(
      /api\(\s*`\/projects\?limit=\$\{PAGE_SIZE\}&offset=\$\{offset\}\$\{archivedQuery\(\)\}`/,
    );
    const helper = appSource.slice(
      appSource.indexOf("function archivedQuery()"),
    );
    expect(helper.slice(0, helper.indexOf("\n}"))).toContain('"&archived=1"');
    // Demo mode has no archived projects: it must keep the default query.
    expect(helper.slice(0, helper.indexOf("\n}"))).toContain("!DEMO");
  });

  it("archived rows render read-only with an Unarchive action", () => {
    expect(appSource).toMatch(/function archivedProjectRow\(project\)/);
    expect(appSource).toContain('class="project-card project-row is-archived"');
    expect(appSource).toContain('<span class="chip" data-kind="archived">');
    expect(appSource).toContain(
      "mutate(`/projects/${encodeURIComponent(project.name)}/unarchive`)",
    );
    // The archived rows are partitioned out of the live list, never rendered
    // by the live card renderer.
    expect(appSource).toMatch(
      /pageRows\.filter\(\(project\) => !project\.archived_at\)/,
    );
    expect(appSource).toMatch(
      /repeat\(archived, \(project\) => project\.name, archivedProjectRow\)/,
    );
  });

  it("the project page shows an archived banner + Unarchive when archived", () => {
    expect(appSource).toContain('class="banner banner-archived"');
    expect(appSource).toMatch(
      /archivedAt\s*\n\s*\? html`<div class="banner banner-archived"/,
    );
    const page = appSource.slice(
      appSource.indexOf("function renderProjectPage()"),
      appSource.indexOf("function renderProjectRail()"),
    );
    expect(page).toContain("unarchiveButton(page.project.name)");
    expect(page).toContain("archiveButton(page.project.name)");
    // New scope is a live-project action only.
    expect(page).toMatch(/archivedAt\s*\n\s*\? unarchiveButton/);
  });

  it("archive is a two-step confirm, unarchive is not", () => {
    const archive = appSource.slice(
      appSource.indexOf("function archiveButton(projectName)"),
      appSource.indexOf("function renderTopbar()"),
    );
    expect(archive).toContain('state.confirm === "archive"');
    expect(archive).toContain('setConfirm("archive")');
    expect(archive).toContain("Confirm archive");
    expect(archive).toContain(
      "mutate(`/projects/${encodeURIComponent(projectName)}/archive`)",
    );
    const unarchive = appSource.slice(
      appSource.indexOf("function unarchiveButton(projectName)"),
      appSource.indexOf("function archiveButton(projectName)"),
    );
    expect(unarchive).not.toContain("state.confirm");
    expect(unarchive).toContain(
      "mutate(`/projects/${encodeURIComponent(projectName)}/unarchive`)",
    );
  });

  it("styles.css defines the archived banner and read-only row", () => {
    expect(cssSource).toContain(".banner-archived {");
    expect(cssSource).toContain('.chip[data-kind="archived"] {');
    expect(cssSource).toContain(".project-card.is-archived {");
  });
});

describe("project knowledge editor", () => {
  it("the textarea is only the Edit-brief view, never the default render", () => {
    // The editor must live behind the briefOpen branch, not next to an
    // unconditional demo default (which would re-open the always-open
    // textarea the spec retired).
    const editingBranch = appSource.match(/const editing = state\.briefOpen;/);
    expect(editingBranch).not.toBeNull();
    expect(appSource).not.toMatch(/DEMO && doc \? true/);
  });
});
