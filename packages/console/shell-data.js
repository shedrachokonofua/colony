// The shell's data layer: the live read path that maps a route onto shell
// state — config/auth bootstrap, then the route's page read (list, project
// sheet, or manage-files). The offline branch lives in shell-demo.js. The view
// registry loads through the same seam so a route's module graph stays off the
// shell's critical path.
import { pageFromHash } from "./pagination.js";
import {
  routeProjectName,
  routeProjectFilesName,
  routeScopeId,
} from "./router.js";
import { DEMO } from "./demo.js";
import { VIEW_ROUTES } from "./view-routes.js";
import { refreshDemo } from "./shell-demo.js";
import { consumePendingTaskSelection } from "./shell-selection.js";

export const PAGE_SIZE = 25;
const POLL_MS = 2500;

/**
 * The list-query suffix that reveals archived projects. Demo mode must not
 * send it: the demo world has no archived projects and every extra query
 * parameter is a divergence from the API's default page.
 *
 * @param {ShellState} app
 */
function archivedQuery(app) {
  return app.showArchived && !DEMO ? "&archived=1" : "";
}

/**
 * The lazy-loaded view's registration state on the shell: which route's
 * module is loaded and whether its import has settled or failed.
 *
 * @typedef {{ route: keyof typeof VIEW_ROUTES, loading: boolean, error?: string }} ViewModuleState
 */

/**
 * The state contract the shell modules read and write: the reactive
 * properties <colony-app> declares plus the methods its fragments call back
 * into. Typing the modules against this contract (never the class) keeps
 * the dependency arrows one-way — colony-app imports the shell-* modules,
 * they only ever see this shape.
 *
 * @typedef {Object} ShellState
 * @property {Record<string, any>} config
 * @property {import("./auth.js").OidcConfig | null} oidc
 * @property {import("./auth.js").Auth | null} auth
 * @property {string} actor
 * @property {Record<string, any> | null} detail
 * @property {Array<Record<string, any>>} audit
 * @property {string | null} selectedTaskId
 * @property {string | null} pendingSelectTaskId
 * @property {boolean} drawerOpen
 * @property {{ runId: string, rows: any[] } | null} runEvents
 * @property {{ runId: string, rows: any[] } | null} scopeRunEvents
 * @property {boolean} goalOpen
 * @property {boolean} planOpen
 * @property {boolean} briefOpen
 * @property {{ title: string, markdown: string } | null} reader
 * @property {{ doc: string, status: string | null } | null} projectContext
 * @property {{ name: string, project: Record<string, any> | null, scopes: any[], total: number, offset: number, page: number } | null} projectPage
 * @property {{ projects: any[], total: number, offset: number, page: number } | null} projectsPage
 * @property {{ name: string, project: Record<string, any> | null, files: any[], total: number, offset: number, page: number } | null} filesPage
 * @property {import("./project-helpers.js").RunningEntry[] | null} projectRunning
 * @property {import("./project-helpers.js").ProjectTab} projectTab
 * @property {any[] | null} projectFiles
 * @property {{ items: any[], total: number, limit: number, offset: number, counts: Record<string, number> } | null} projectFailures
 * @property {string | null} confirm
 * @property {string | null} confirmFile
 * @property {string | null} replaceFileId
 * @property {{ name: string, context_doc?: string } | null} newProjectDraft
 * @property {string} error
 * @property {boolean} showArchived
 * @property {{ name: string, params: Record<string, any> }} currentRoute
 * @property {ViewModuleState | null} viewModule
 * @property {import("./duration.js").Ticker | null} ticker
 * @property {(path: string, options?: { method?: string, body?: string, headers?: Record<string, string>, notFound?: "null" }) => Promise<any>} api
 * @property {() => Promise<void>} _refresh
 * @property {() => void} beginLogin
 * @property {() => void} signOut
 * @property {() => Promise<void>} completeLogin
 * @property {() => Promise<void>} ensureFreshToken
 * @property {(href: string) => void} navigate
 * @property {(href: string) => void} replaceHref
 * @property {(page: number | string, surface: "projects" | "project" | "files") => void} _page
 */

/**
 * Route state onto the shell: config/auth bootstrap, then the route's page
 * read. Errors surface through the shell's error banner, never a throw —
 * the poll keeps running either way.
 *
 * @param {ShellState} app
 */
export async function refresh(app) {
  try {
    if (DEMO) {
      refreshDemo(app);
      return;
    }
    const config = /** @type {any} */ (await app.api("/ui/config"));
    app.config = config;
    app.oidc = config.oidc || null;
    if (app.oidc) {
      if (new URLSearchParams(location.search).has("code")) {
        await app.completeLogin();
      }
      await app.ensureFreshToken();
      if (!app.auth) {
        app.error = "";
        return;
      }
    }
    const pageNo = pageFromHash(location.hash);
    const offset = (pageNo - 1) * PAGE_SIZE;
    const projectName = routeProjectName();
    const filesName = routeProjectFilesName();
    if (filesName) {
      const [project, filesPage] = await Promise.all([
        app.api(`/projects/${encodeURIComponent(filesName)}`, {
          notFound: "null",
        }),
        app.api(
          `/projects/${encodeURIComponent(filesName)}/files?limit=${PAGE_SIZE}&offset=${offset}`,
        ),
      ]);
      app.filesPage = {
        name: filesName,
        project: project === null ? null : project.project,
        files: filesPage.files ?? [],
        total: filesPage.total ?? 0,
        offset,
        page: pageNo,
      };
      app.projectPage = null;
      app.projectRunning = null;
      app.projectFailures = null;
      app.error = "";
      return;
    }
    app.filesPage = null;
    if (projectName) {
      // The project route owns this refresh: it must not touch board or
      // sheet state, and it must preserve an in-flight editor "Saved.".
      const [project, scopesPage, runningRows, failuresData] = await Promise.all([
        app.api(`/projects/${encodeURIComponent(projectName)}`, {
          notFound: "null",
        }),
        app.api(
          `/scopes?limit=${PAGE_SIZE}&offset=${offset}&project=${encodeURIComponent(projectName)}`,
        ),
        app.api(`/projects/${encodeURIComponent(projectName)}/running`, {
          notFound: "null",
        }),
        app.api(`/projects/${encodeURIComponent(projectName)}/failures`, {
          notFound: "null",
        }),
      ]);
      app.projectPage = {
        name: projectName,
        project: project === null ? null : project.project,
        scopes: scopesPage.scopes,
        total: scopesPage.total,
        offset,
        page: pageNo,
      };
      app.projectRunning = Array.isArray(runningRows) ? runningRows : [];
      app.projectFailures = failuresData ?? null;
      // Seed the editor from the same read Save round-trips through so the
      // prefill cannot drift from what Save persists.
      if (app.projectContext === null && project) {
        const stored = await app.api(
          `/projects/${encodeURIComponent(projectName)}/context`,
        );
        app.projectContext = { doc: stored.context_doc ?? "", status: null };
      }
      if (app.projectFiles === null && project) {
        const filesPage = await app.api(
          `/projects/${encodeURIComponent(projectName)}/files?limit=${PAGE_SIZE}&offset=0`,
        );
        app.projectFiles = filesPage.files ?? [];
      }
      app.error = "";
      return;
    }
    app.projectPage = null;
    app.projectRunning = null;
    app.projectFailures = null;
    const projectsPage = await app.api(
      `/projects?limit=${PAGE_SIZE}&offset=${offset}${archivedQuery(app)}`,
    );
    app.projectsPage = {
      projects: projectsPage.projects ?? [],
      total: projectsPage.total ?? 0,
      offset,
      page: pageNo,
    };
    const id = routeScopeId();
    if (id) {
      const [detail, audit] = await Promise.all([
        app.api(`/scopes/${encodeURIComponent(id)}`),
        app.api(`/audit?scope_id=${encodeURIComponent(id)}&limit=1000`),
      ]);
      app.detail = detail;
      app.audit = audit.events;
      consumePendingTaskSelection(app, detail);
      if (
        app.projectContext === null &&
        detail.project &&
        detail.project.context_doc !== undefined
      ) {
        app.projectContext = {
          doc: detail.project.context_doc ?? "",
          status: null,
        };
      }
      await refreshRunEvents(app, detail);
    } else {
      app.detail = null;
      app.projectContext = null;
      app.audit = (await app.api("/audit?limit=12")).events;
    }
    app.error = "";
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/** Live agent feed for the drawer's most recent running run, if any. */
/**
 * @param {ShellState} app
 * @param {Record<string, any>} detail
 */
async function refreshRunEvents(app, detail) {
  /** @type {any[]} */
  const targets = [];
  if (app.drawerOpen && app.selectedTaskId) {
    const runs = /** @type {any[]} */ (detail.runs || []);
    const liveRun = [...runs]
      .reverse()
      .find(
        (run) => run.task_id === app.selectedTaskId && run.status === "running",
      );
    if (liveRun) targets.push(liveRun);
  }
  // Scope-level architect runs stream into the Plan card so planning is
  // never a black box.
  const runs = /** @type {any[]} */ (detail.runs || []);
  const architect = runs.find(
    (run) => run.kind === "architect" && run.status === "running",
  );
  if (architect) targets.push(architect);
  if (!targets.length) {
    app.runEvents = null;
    app.scopeRunEvents = null;
    return;
  }
  try {
    const feeds = await Promise.all(
      targets.map(async (run) => ({
        runId: run.id,
        rows: (await app.api(`/runs/${encodeURIComponent(run.id)}/events`))
          .events,
      })),
    );
    const drawerTarget = targets.find((run) => run !== architect);
    app.runEvents = drawerTarget
      ? (feeds.find((f) => f.runId === drawerTarget.id) ?? null)
      : null;
    app.scopeRunEvents = architect
      ? (feeds.find((f) => f.runId === architect.id) ?? null)
      : null;
  } catch {
    app.runEvents = null;
    app.scopeRunEvents = null;
  }
}

/**
 * Lazy-load the route's view module. The route is captured now: the import
 * settles later, and reading currentRoute in the callback would label a
 * module with whatever route is current by then (a hashchange mid-flight
 * mislabels it). A failed import surfaces through the shell's error banner —
 * a blank <main> hides the failure.
 *
 * @param {ShellState} app
 */
export function loadViewModule(app) {
  const route = /** @type {keyof typeof VIEW_ROUTES} */ (app.currentRoute.name);
  if (!VIEW_ROUTES[route]) {
    app.viewModule = null;
    return;
  }
  if (app.viewModule?.route === route) return;
  app.viewModule = { route, loading: true };
  import(VIEW_ROUTES[route][0])
    .then(() => {
      if (app.currentRoute.name !== route) return;
      app.viewModule = { route, loading: false };
    })
    .catch((err) => {
      if (app.currentRoute.name !== route) return;
      const msg = err instanceof Error ? err.message : String(err);
      app.viewModule = { route, loading: false, error: msg };
      app.error = msg;
    });
}

/** The shell's 2.5s refresh poll; document.hidden ticks are skipped. */
/**
 * @param {ShellState} app
 * @returns {ReturnType<typeof setInterval>}
 */
export function startPolling(app) {
  return setInterval(() => {
    if (document.hidden) return;
    void app._refresh();
  }, POLL_MS);
}
