// The shell's data layer: everything that maps a route onto shell state.
// _refresh is the single read path — config/auth bootstrap, then the route's
// page read (list, project sheet, or manage-files) — and demo mode serves the
// same state slots from the offline world. The view registry loads through
// the same seam so a route's module graph stays off the shell's critical path.
import { pageFromHash } from "./pagination.js";
import {
  routeProjectName,
  routeProjectFilesName,
  routeScopeId,
} from "./router.js";
import { DEMO, demoWorld, demoContextStore, demoFileStore } from "./demo.js";
import { createRunTicker } from "./duration.js";
import { parsePlan } from "./dag.js";
import { VIEW_ROUTES } from "./view-routes.js";

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
 * @property {boolean} settingsOpen
 * @property {{ title: string, markdown: string } | null} reader
 * @property {{ doc: string, status: string | null } | null} projectContext
 * @property {{ name: string, project: Record<string, any> | null, scopes: any[], total: number, offset: number, page: number } | null} projectPage
 * @property {{ projects: any[], total: number, offset: number, page: number } | null} projectsPage
 * @property {{ name: string, project: Record<string, any> | null, files: any[], total: number, offset: number, page: number } | null} filesPage
 * @property {import("./project-helpers.js").RunningEntry[] | null} projectRunning
 * @property {import("./project-helpers.js").ProjectTab} projectTab
 * @property {any[] | null} projectFiles
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
      app.error = "";
      return;
    }
    app.filesPage = null;
    if (projectName) {
      // The project route owns this refresh: it must not touch board or
      // sheet state, and it must preserve an in-flight editor "Saved.".
      const [project, scopesPage, runningRows] = await Promise.all([
        app.api(`/projects/${encodeURIComponent(projectName)}`, {
          notFound: "null",
        }),
        app.api(
          `/scopes?limit=${PAGE_SIZE}&offset=${offset}&project=${encodeURIComponent(projectName)}`,
        ),
        app.api(`/projects/${encodeURIComponent(projectName)}/running`, {
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

/** Demo mode: serve the offline world through the same state slots. */
/** @param {ShellState} app */
function refreshDemo(app) {
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

/**
 * Select a task once its scope detail holds it. A Running-tab row navigates
 * before the sheet's detail is loaded, so the selection waits here rather
 * than being dropped: the sheet only finds tasks the detail contains.
 *
 * @param {ShellState} app
 * @param {Record<string, any> | null} detail
 */
function consumePendingTaskSelection(app, detail) {
  const taskId = app.pendingSelectTaskId;
  if (!taskId || !detail) return;
  const tasks = /** @type {any[]} */ (detail.tasks ?? []);
  if (!taskId.startsWith("plan:")) {
    if (!tasks.some((task) => task.id === taskId)) return;
  } else {
    const index = Number(taskId.slice(5));
    const plan = parsePlan(detail.scope?.plan_json);
    if (!Number.isInteger(index) || !plan?.tasks[index]) return;
  }
  app.pendingSelectTaskId = null;
  app.selectedTaskId = taskId;
  app.drawerOpen = true;
  app.confirm = null;
  app.runEvents = null;
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
