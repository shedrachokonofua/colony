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
const listSource = readFileSync(join(here, "views/project-list.js"), "utf8");
const composerSource = readFileSync(
  join(here, "views/project-create.js"),
  "utf8",
);
const scopeSource = readFileSync(join(here, "views/scope-create.js"), "utf8");
const shellSource = readFileSync(join(here, "colony-app.js"), "utf8");
// The shell's createProject action POSTs the payload; it ships in
// shell-actions.js since the cutover split the shell's event handlers out.
const shellActionsSource = readFileSync(join(here, "shell-actions.js"), "utf8");
// The archived-projects query lives in the shell's data layer; the toggle
// and the read-only rows live in the views that render them.
const shellDataSource = readFileSync(join(here, "shell-data.js"), "utf8");
const pageSource = readFileSync(join(here, "views/project-page.js"), "utf8");
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
      distinctRepos([
        { repo_id: "7", repo_path: "so/colony" },
        { repo_id: "8", repo_path: "so/colony" },
        { repo_id: "9", repo_path: "so/console-e2e" },
      ]).length,
    ).toBe(2);
  });

  it("repo summary: distinctRepos dedupes identical repo lists", () => {
    const repos = [
      { repo_id: "7", repo_path: "so/colony" },
      { repo_id: "8", repo_path: "so/colony" },
      { repo_id: "9", repo_path: "so/console-e2e" },
    ];
    const summary = repoSummaryText(repos);
    expect(summary.startsWith("2 connected repos")).toBe(true);
    expect(summary).toContain("so/colony");
    expect(summary).toContain("so/console-e2e");
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
  it("project-list renders project cards from .project-cards with a card per project", () => {
    expect(listSource).toContain('<div class="project-cards">');
    expect(listSource).toMatch(/href=\$\{projectHref\(project\.name\)\}/);
    expect(listSource).toContain('class="project-card-name"');
    expect(listSource).toContain('class="project-card-knowledge"');
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

  it("the shell POSTs the payload to /projects on the new-project route", () => {
    expect(shellActionsSource).toContain('api("/projects"');
  });

  it("the new-project composer renders the fixed project as a non-editable element, not an input", () => {
    expect(scopeSource).toContain('class="composer-fixed"');
    const fixedBranch = scopeSource.slice(
      scopeSource.indexOf("composer-fixed"),
      scopeSource.indexOf('name="project"'),
    );
    expect(fixedBranch.length).toBeGreaterThan(0);
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

describe("archived projects", () => {
  it("project-list offers a Show archived toggle in the index head", () => {
    expect(listSource).toContain("Show archived");
    expect(listSource).toContain("Hide archived");
    // The toggle is shell state (reset on hashchange), passed down; the
    // button reflects it via aria-pressed.
    expect(shellSource).toContain("showArchived = false;");
    expect(listSource).toContain("aria-pressed=${this.showArchived}");
    expect(listSource).toMatch(
      /\$\{this\.showArchived \? "Hide archived" : "Show archived"\}/,
    );
  });

  it("the list fetch adds archived=1 only when the toggle is on", () => {
    expect(shellDataSource).toMatch(
      /`\/projects\?limit=\$\{PAGE_SIZE\}&offset=\$\{offset\}\$\{archivedQuery\(app\)\}`/,
    );
    const helper = shellDataSource.slice(
      shellDataSource.indexOf("function archivedQuery(app)"),
    );
    expect(helper.slice(0, helper.indexOf("\n}"))).toContain('"&archived=1"');
    // Demo mode has no archived projects: it must keep the default query.
    expect(helper.slice(0, helper.indexOf("\n}"))).toContain("!DEMO");
  });

  it("archived rows render read-only with an Unarchive action", () => {
    expect(listSource).toMatch(/function archivedProjectRow\(project\)/);
    expect(listSource).toContain(
      'class="project-card project-row is-archived"',
    );
    expect(listSource).toContain('<span class="chip" data-kind="archived">');
    expect(listSource).toContain(
      "`/projects/${encodeURIComponent(project.name)}/unarchive`",
    );
    // The archived rows are partitioned out of the live list, never rendered
    // by the live card renderer.
    expect(listSource).toMatch(
      /pageRows\.filter\(\(project\) => !project\.archived_at\)/,
    );
    expect(listSource).toMatch(
      /repeat\(\n\s*archived,\n\s*\(project\) => project\.name,\n\s*archivedProjectRow,?\n\s*\)/,
    );
  });

  it("the project page shows an archived banner + Unarchive when archived", () => {
    expect(pageSource).toContain('class="banner banner-archived"');
    expect(pageSource).toMatch(
      /archivedAt\n\s*\? html`<div class="banner banner-archived"/,
    );
    expect(pageSource).toContain("this.#unarchiveButton(page.project.name)");
    expect(pageSource).toContain("this.#archiveButton(page.project.name)");
    // New scope is a live-project action only.
    expect(pageSource).toMatch(/archivedAt\n\s*\? this\.#unarchiveButton/);
  });

  it("archive is a two-step confirm, unarchive is not", () => {
    const archive = pageSource.slice(
      pageSource.indexOf("#archiveButton(projectName) {"),
    );
    expect(archive).toContain('this.confirm === "archive"');
    expect(archive).toContain('colony-confirm", { kind: "archive" }');
    expect(archive).toContain("Confirm archive");
    expect(archive).toContain(
      "`/projects/${encodeURIComponent(projectName)}/archive`",
    );
    const unarchive = pageSource.slice(
      pageSource.indexOf("#unarchiveButton(projectName) {"),
      pageSource.indexOf("/**\n   * The monolith's archiveButton"),
    );
    expect(unarchive).not.toContain("this.confirm");
    expect(unarchive).toContain(
      "`/projects/${encodeURIComponent(projectName)}/unarchive`",
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
    // The editor must live behind the editing branch, not next to an
    // unconditional demo default (which would re-open the always-open
    // textarea the spec retired).
    expect(composerSource).not.toBeUndefined();
    const contextCardSource = readFileSync(
      join(here, "elements/project-context-card.js"),
      "utf8",
    );
    expect(contextCardSource).toContain("this.editing ? nothing :");
    expect(contextCardSource).not.toMatch(/DEMO && doc \? true/);
  });
});
