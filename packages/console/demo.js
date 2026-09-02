// Demo mode wiring: mode detection, demo-safe read paths, the local
// context/file stores, and the assembled world. The data itself lives in
// demo-data.js.

import {
  buildDemoAudit,
  buildDemoDetail,
  buildDemoFiles,
  buildDemoProject,
  buildDemoRunEvents,
  buildDemoScopes,
  buildEmptyProject,
  buildFillerProjects,
} from "./demo-data.js";

export const DEMO = new URLSearchParams(location.search).has("demo");

// Demo-safe read paths: project detail, its context, its scope page, and the
// project list (the homepage) so the whole console is driveable offline.
export const DEMO_READS =
  /^\/projects\/[^/?]+(?:\/context|\/running|\/files(?:\/\w+)?)?(?:\?.*)?$|^\/projects\?|^\/scopes\?/;

// Demo brief/file edits are purely local state: they must never hit the
// network, but the same affordances stay visible.
export const demoContextStore = new Map();
export const demoFileStore = new Map();

export function demoWorld() {
  const now = Date.now();
  const fillerProjects = buildFillerProjects(now);
  const generatedScopes = buildDemoScopes(now);
  const projectScopes = generatedScopes;
  const demoFiles = buildDemoFiles(now);
  demoFileStore.set("Operator console", demoFiles);
  const demoProject = buildDemoProject(now, projectScopes, demoFiles);
  if (demoContextStore.has(demoProject.name)) {
    demoProject.context_doc = demoContextStore.get(demoProject.name);
  }
  const emptyProject = buildEmptyProject(now);
  demoFileStore.set("Empty workspace", []);
  const detail = buildDemoDetail(now);
  const scope = detail.scope;
  return {
    config: {
      gitlab_base_url: "https://gitlab.home.shdr.ch",
      review_mode: "required",
      hitl_mode: "yolo",
      trace_ui_base_url: "https://traces.home.shdr.ch",
    },
    project: demoProject,
    projects: [...fillerProjects, demoProject, emptyProject],
    files: demoFileStore.get("Operator console") ?? demoFiles,
    scopes: [
      scope,
      {
        id: "col-0badc0de",
        goal: "Expose run token usage per scope on the console",
        title: "Usage panel",
        project_name: null,
        status: "active",
        provider_repo_path: "so/colony",
        default_branch: "main",
        plan_json: null,
        blocked_reason: null,
        created_at: new Date(now - 5 * 3600 * 1000).toISOString(),
        updated_at: new Date(now - 40 * 60 * 1000).toISOString(),
      },
      ...generatedScopes,
    ],
    detail,
    runEvents: buildDemoRunEvents(now),
    audit: buildDemoAudit(now),
  };
}
