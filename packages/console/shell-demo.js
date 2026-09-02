// The shell's offline data path: demo mode serves the same state slots the
// live API fills, straight from the demo world. Kept apart from shell-data.js
// because it is the one branch of refresh() that reads no network at all.
import { pageFromHash } from "./pagination.js";
import {
  routeProjectName,
  routeProjectFilesName,
  routeScopeId,
} from "./router.js";
import { demoWorld, demoContextStore, demoFileStore } from "./demo.js";
import { PAGE_SIZE } from "./shell-data.js";
import { consumePendingTaskSelection } from "./shell-selection.js";

/**
 * Serve the offline world through the shell's state slots: the scope sheet,
 * then the project or files page, then the project list.
 *
 * @param {import("./shell-data.js").ShellState} app
 */
export function refreshDemo(app) {
  const world = demoWorld();
  app.config = world.config;
  const id = routeScopeId();
  if (id) {
    const scopeRow = world.scopes.find((s) => s.id === id) ?? null;
    app.detail = scopeRow
      ? scopeRow.id === world.detail.scope.id
        ? world.detail
        : (world.runningDetails?.[scopeRow.id] ?? {
            scope: scopeRow,
            tasks: [],
            deps: [],
            runs: [],
          })
      : null;
    consumePendingTaskSelection(app, app.detail);
  } else {
    app.detail = null;
  }
  const demoName = routeProjectName();
  const filesName = routeProjectFilesName();
  const pageNo = pageFromHash(location.hash);
  if (filesName) {
    const found = world.projects.find((p) => p.name === filesName) ?? null;
    const files = demoFileStore.get(filesName) ?? [];
    const start = (pageNo - 1) * PAGE_SIZE;
    app.filesPage = {
      name: filesName,
      project: found,
      files: files.slice(start, start + PAGE_SIZE),
      total: files.length,
      offset: start,
      page: pageNo,
    };
    app.projectPage = null;
  } else {
    app.filesPage = null;
  }
  if (demoName === world.project.name) {
    const owned = world.scopes
      .filter((scope) => scope.project_name === demoName)
      .sort(
        (a, b) =>
          Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    const start = (pageNo - 1) * PAGE_SIZE;
    app.projectPage = {
      name: demoName,
      project: world.project,
      scopes: owned.slice(start, start + PAGE_SIZE),
      total: owned.length,
      offset: start,
      page: pageNo,
    };
    app.projectRunning = world.running ?? [];
    if (app.projectContext === null) {
      const stored = demoContextStore.has(demoName)
        ? { context_doc: demoContextStore.get(demoName) }
        : { context_doc: world.project.context_doc ?? "" };
      app.projectContext = { doc: stored.context_doc ?? "", status: null };
    }
    app.projectFiles = demoFileStore.get(demoName) ?? [];
  } else if (demoName) {
    const found = world.projects.find((p) => p.name === demoName) ?? null;
    app.projectPage = {
      name: demoName,
      project: found,
      scopes: [],
      total: 0,
      offset: 0,
      page: pageNo,
    };
    app.projectRunning = [];
    app.projectFiles = found ? (demoFileStore.get(demoName) ?? []) : [];
  } else {
    app.projectPage = null;
    app.projectRunning = null;
    const ordered = [...world.projects].sort(
      (a, b) =>
        Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const start = (pageNo - 1) * PAGE_SIZE;
    app.projectsPage = {
      projects: ordered.slice(start, start + PAGE_SIZE),
      total: ordered.length,
      offset: start,
      page: pageNo,
    };
  }
  app.audit = world.audit;
  if (app.drawerOpen && app.selectedTaskId === "col-a1b2c3d4.1") {
    app.runEvents = { runId: "run-gate-1", rows: world.runEvents };
  }
  app.error = "";
}
