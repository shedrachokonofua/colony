// The shell's route parsing and the surface reset a navigation triggers.
// <colony-app> delegates both: parsing is pure over location.hash, and the
// reset is a fixed list of the transient slots a new route must not inherit.
import { pageFromHash, hrefForPage } from "./pagination.js";
import {
  routeScopeId,
  routeIsNew,
  routeIsNewProject,
  routeIsManageFiles,
  routeProjectFilesName,
  routeProjectName,
  projectHref,
  projectFilesHref,
  hashQueryProject,
  hashQueryTab,
} from "./router.js";
import { loadViewModule } from "./shell-data.js";

/**
 * The route the current hash names, or the paginated list when it names none.
 *
 * @returns {import("./shell-data.js").ShellState["currentRoute"]}
 */
export function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (routeIsNew()) {
    return { name: "newScope", params: { project: hashQueryProject() } };
  }
  if (routeIsNewProject()) return { name: "newProject", params: {} };
  if (routeIsManageFiles()) {
    return { name: "files", params: { name: routeProjectFilesName() } };
  }
  const projectName = routeProjectName();
  if (projectName) return { name: "project", params: { name: projectName } };
  const scopeId = routeScopeId();
  if (scopeId) return { name: "scope", params: { id: scopeId } };
  return { name: "list", params: { page: pageFromHash(location.hash) } };
}

/**
 * Re-route the shell after a hashchange: drop every transient surface the
 * previous route owned, re-read the route and its tab, load the new view
 * module, and refresh.
 *
 * @param {import("./shell-data.js").ShellState} app
 */
export function onHashChange(app) {
  app.selectedTaskId = null;
  app.drawerOpen = false;
  app.runEvents = null;
  app.confirm = null;
  app.goalOpen = false;
  app.planOpen = false;
  app.projectContext = null;
  app.projectPage = null;
  app.projectRunning = null;
  app.projectsPage = null;
  app.filesPage = null;
  app.projectFiles = null;
  app.briefOpen = false;
  app.confirmFile = null;
  app.replaceFileId = null;
  app.newProjectDraft = null;
  app.showArchived = false;
  app.currentRoute = parseRoute();
  app.projectTab = hashQueryTab();
  loadViewModule(app);
  void app._refresh();
}

/**
 * Pagination targets fixed clean bases (never the current hash, which may
 * already carry ?page=N): the monolith paged #/ (projects), the project
 * sheet, and the manage-files page. Page 1 drops the query so Previous from
 * page 2 navigates back for real.
 *
 * @param {import("./shell-data.js").ShellState} app
 * @param {number | string} page
 * @param {"projects" | "project" | "files"} surface
 */
export function pageTo(app, page, surface) {
  const pageNo = Math.max(1, Number(page) || 1);
  const params = /** @type {{ name?: string }} */ (
    /** @type {unknown} */ (app.currentRoute.params)
  );
  const base =
    surface === "project"
      ? projectHref(params.name ?? "")
      : surface === "files"
        ? projectFilesHref(params.name ?? "")
        : "#/";
  app.navigate(hrefForPage(base, pageNo));
}
