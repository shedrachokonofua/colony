import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "app.js"), "utf8");
const cssSource = readFileSync(join(here, "styles.css"), "utf8");

/**
 * The console is a no-build browser script: its pure helpers are declared at
 * module top level but never exported. Evaluate the exact function source the
 * UI runs against the test's inputs — no copy-paste, no dead constants.
 */
function evalAppFunction(name: string) {
  const start = appSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js has no function ${name}`);
  let depth = 0;
  let end = appSource.indexOf("{", start);
  for (let i = end; i < appSource.length; i++) {
    if (appSource[i] === "{") depth++;
    else if (appSource[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return new Function(`return (${appSource.slice(start, end)})`)();
}

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
  const knowledgeText = evalAppFunction("knowledgeText");
  const repoSummaryText = evalAppFunction("repoSummaryText");

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
  const buildNewProjectPayload = evalAppFunction("buildNewProjectPayload");

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
  const resolveComposerProject = evalAppFunction("resolveComposerProject");

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
