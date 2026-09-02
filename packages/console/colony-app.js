// <colony-app>: the console shell — hash router, 2.5s refresh poll,
// demo-aware API client, Keycloak PKCE auth (auth.js), and the
// property-down/events-up hub every view element plugs into. Light DOM (see
// base.js) so styles.css keeps styling it. The mechanics live in their
// modules: shell-data.js (refresh/poll/view loading), shell-actions.js +
// shell-events.js (the colony-* event bus), shell-view.js (the route's
// element), api-client.js (fetch + auth headers).
import { ColonyElement, html, nothing } from "./base.js";
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
import {
  loadAuth,
  beginLogin,
  completeLogin,
  ensureFreshToken,
  signOut,
} from "./auth.js";
// The shell renders <colony-topbar> and <colony-signin>; importing them here
// registers both elements the render references.
import "./topbar.js";
import "./signin.js";
import { createApi } from "./api-client.js";
import { createRunTicker } from "./duration.js";
import { refresh, loadViewModule, startPolling } from "./shell-data.js";
import { renderView, renderReaderOverlay } from "./shell-view.js";
import { LISTENED, handleEvent } from "./shell-events.js";
import {
  saveActor,
  closeDrawer,
  closeReader,
  setProjectTab,
  openTaskInScope,
  mutate as shellMutate,
} from "./shell-actions.js";

const ACTOR_KEY = "colony.actor";
export const PAGE_SIZE = 25;

function initialActor() {
  try {
    return localStorage.getItem(ACTOR_KEY) || "human:op-1";
  } catch {
    return "human:op-1";
  }
}

/**
 * Shell element <colony-app>: hash router, 2.5s refresh poll, demo-aware API
 * client, Keycloak PKCE auth, and the property-down/events-up hub every view
 * element plugs into. Light DOM (see base.js) so styles.css keeps styling it.
 *
 * The methods tests and the event bus call (`refresh`, `api`, `page`,
 * `navigate`, the action delegates) are thin one-line shims over the shell-*
 * modules; the state contract they share is the class's own reactive
 * properties.
 */
export class ColonyApp extends ColonyElement {
  static properties = {
    config: { state: true },
    oidc: { state: true },
    actor: { state: true },
    detail: { state: true },
    audit: { state: true },
    selectedTaskId: { state: true },
    drawerOpen: { state: true },
    runEvents: { state: true },
    scopeRunEvents: { state: true },
    goalOpen: { state: true },
    planOpen: { state: true },
    briefOpen: { state: true },
    settingsOpen: { state: true },
    reader: { state: true },
    projectContext: { state: true },
    projectPage: { state: true },
    projectRunning: { state: true },
    projectTab: { state: true },
    pendingSelectTaskId: { state: true },
    projectsPage: { state: true },
    filesPage: { state: true },
    projectFiles: { state: true },
    confirm: { state: true },
    confirmFile: { state: true },
    replaceFileId: { state: true },
    newProjectDraft: { state: true },
    showArchived: { state: true },
    error: { state: true },
    auth: { state: true },
    currentRoute: { state: true },
    viewModule: { state: true },
  };

  constructor() {
    super();
    /** @type {Record<string, any>} */
    this.config = {
      gitlab_base_url: "",
      review_mode: "off",
      hitl_mode: "yolo",
      trace_ui_base_url: /** @type {string | null} */ (null),
    };
    /** @type {import("./auth.js").OidcConfig | null} */
    this.oidc = null;
    this.actor = initialActor();
    /** @type {Record<string, any> | null} */
    this.detail = null;
    /** @type {Array<Record<string, any>>} */
    this.audit = [];
    /** @type {string | null} */
    this.selectedTaskId = null;
    this.drawerOpen = false;
    /** @type {{ runId: string, rows: any[] } | null} */
    this.runEvents = null;
    /** @type {{ runId: string, rows: any[] } | null} */
    this.scopeRunEvents = null;
    this.goalOpen = false;
    this.planOpen = false;
    this.briefOpen = false;
    this.settingsOpen = false;
    /** @type {{ title: string, markdown: string } | null} */
    this.reader = null;
    /** @type {{ doc: string, status: string | null } | null} */
    this.projectContext = null;
    /** @type {import("./shell-data.js").ShellState["projectPage"]} */
    this.projectPage = null;
    /** @type {import("./shell-data.js").ShellState["projectRunning"]} */
    this.projectRunning = null;
    /** @type {import("./shell-data.js").ShellState["projectTab"]} */
    this.projectTab = hashQueryTab();
    /** @type {string | null} */
    this.pendingSelectTaskId = null;
    /** @type {import("./shell-data.js").ShellState["projectsPage"]} */
    this.projectsPage = null;
    /** @type {import("./shell-data.js").ShellState["filesPage"]} */
    this.filesPage = null;
    /** @type {any[] | null} */
    this.projectFiles = null;
    /** @type {string | null} */
    this.confirm = null;
    /** @type {string | null} */
    this.confirmFile = null;
    /** @type {string | null} */
    this.replaceFileId = null;
    /** @type {{ name: string, context_doc: string } | null} */
    this.newProjectDraft = null;
    this.showArchived = false;
    this.error = "";
    /** @type {import("./auth.js").Auth | null} */
    this.auth = null;
    /** @type {import("./shell-data.js").ShellState["currentRoute"]} */
    this.currentRoute = { name: "list", params: {} };
    /** @type {import("./shell-data.js").ViewModuleState | null} */
    this.viewModule = null;
    /**
     * The 1s clock behind a live Running-tab duration. The shell owns it
     * (one interval, not one per row) and hands it down; the consumer binds
     * what a tick does.
     *
     * @type {import("./duration.js").Ticker | null}
     */
    this.ticker = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._pollTimer = null;
    /** @type {import("./shell-data.js").ShellState["api"]} */
    this.api = createApi(this, (auth) => this.#saveAuth(auth));
    this.#parseRoute();
  }
  connectedCallback() {
    super.connectedCallback();
    this.auth = loadAuth();
    this.ticker = createRunTicker();
    this._refresh = this._refresh.bind(this);
    window.addEventListener("hashchange", this);
    document.addEventListener("visibilitychange", this);
    document.addEventListener("keydown", this);
    // Escape hatches for the shell's own toggle plumbing: confirm (the armed
    // two-step buttons) and toggle share one handler across every view.
    this.addEventListener("colony-confirm", this);
    this.addEventListener("colony-toggle", this);
    for (const type of LISTENED) this.addEventListener(type, this);
    this._pollTimer = startPolling(this);
    this.ticker.onTick(() => this.requestUpdate());
    loadViewModule(this);
    void this._refresh();
  }
  disconnectedCallback() {
    window.removeEventListener("hashchange", this);
    document.removeEventListener("visibilitychange", this);
    document.removeEventListener("keydown", this);
    for (const type of LISTENED) this.removeEventListener(type, this);
    this.ticker?.stop();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    super.disconnectedCallback();
  }

  /**
   * Events land here: window/document listeners (hashchange,
   * visibilitychange, Escape) and every colony-* event the views bubble.
   *
   * @param {Event} event
   */
  handleEvent(event) {
    if (event.type === "hashchange") {
      this._onHashChange();
      return;
    }
    if (event.type === "visibilitychange") {
      if (!document.hidden) void this._refresh();
      return;
    }
    if (event.type === "keydown") {
      const keyEvent = /** @type {KeyboardEvent} */ (event);
      if (keyEvent.key === "Escape") {
        if (this.drawerOpen) closeDrawer(this);
        if (this.reader) closeReader(this);
      }
      return;
    }
    handleEvent(this, event);
  }

  // -- Refresh --------------------------------------------------------------
  /** The single read path: route state onto this shell (shell-data.js). */
  /** @returns {Promise<void>} */
  _refresh() {
    return refresh(this);
  }

  // -- Routing --------------------------------------------------------------

  #parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    if (routeIsNew()) {
      this.currentRoute = {
        name: "newScope",
        params: { project: hashQueryProject() },
      };
      return;
    }
    if (routeIsNewProject()) {
      this.currentRoute = { name: "newProject", params: {} };
      return;
    }
    if (routeIsManageFiles()) {
      this.currentRoute = {
        name: "files",
        params: { name: routeProjectFilesName() },
      };
      return;
    }
    const projectName = routeProjectName();
    if (projectName) {
      this.currentRoute = { name: "project", params: { name: projectName } };
      return;
    }
    const scopeId = routeScopeId();
    if (scopeId) {
      this.currentRoute = { name: "scope", params: { id: scopeId } };
      return;
    }
    this.currentRoute = {
      name: "list",
      params: { page: pageFromHash(location.hash) },
    };
  }

  _onHashChange() {
    this.selectedTaskId = null;
    this.drawerOpen = false;
    this.runEvents = null;
    this.confirm = null;
    this.goalOpen = false;
    this.planOpen = false;
    this.projectContext = null;
    this.projectPage = null;
    this.projectRunning = null;
    this.projectsPage = null;
    this.filesPage = null;
    this.projectFiles = null;
    this.briefOpen = false;
    this.confirmFile = null;
    this.replaceFileId = null;
    this.newProjectDraft = null;
    this.showArchived = false;
    this.#parseRoute();
    this.projectTab = hashQueryTab();
    loadViewModule(this);
    void this._refresh();
  }

  // -- Auth -----------------------------------------------------------------

  /** Mirror the auth state onto shell state after any auth.js round-trip. */
  /** @param {import("./auth.js").Auth | null} auth */
  #saveAuth(auth) {
    this.auth = auth;
  }

  async beginLogin() {
    if (!this.oidc) return;
    this.#saveAuth(await beginLogin(this.oidc).then(() => loadAuth()));
  }

  signOut() {
    signOut(this.oidc);
    this.#saveAuth(null);
  }

  async completeLogin() {
    if (!this.oidc) return;
    this.#saveAuth(await completeLogin(this.oidc));
  }

  async ensureFreshToken() {
    if (!this.oidc) return;
    this.#saveAuth(await ensureFreshToken(this.oidc, this.auth));
  }

  // -- Mutations ------------------------------------------------------------

  /**
   * POST helper behind every shell mutation: clears any pending confirm,
   * then [api] + refresh. Tests and the event bus share this one entry.
   *
   * @param {string} path
   * @param {Record<string, unknown>} [body]
   * @returns {Promise<void>}
   */
  mutate(path, body) {
    return shellMutate(this, path, body);
  }

  // -- Navigation -----------------------------------------------------------

  /** @param {string} href */
  navigate(href) {
    if (!href || location.hash === href) return;
    location.hash = href;
  }

  /**
   * Swap the URL without a hashchange: the tab lives in the same route, so
   * navigating to it would reset the very page state the tab switches.
   *
   * @param {string} href
   */
  replaceHref(href) {
    if (!href || location.hash === href) return;
    history.replaceState(null, "", href);
  }

  /**
   * Pagination targets fixed clean bases (never the current hash, which may
   * already carry ?page=N): the monolith paged #/ (projects), the project
   * sheet, and the manage-files page. Page 1 drops the query so Previous
   * from page 2 navigates back for real.
   */
  /** @param {number | string} page @param {"projects" | "project" | "files"} surface */
  _page(page, surface) {
    const pageNo = Math.max(1, Number(page) || 1);
    /** @type {{ name?: string }} */
    const params = /** @type {{ name?: string }} */ (
      /** @type {unknown} */ (this.currentRoute.params)
    );
    const base =
      surface === "project"
        ? projectHref(params.name ?? "")
        : surface === "files"
          ? projectFilesHref(params.name ?? "")
          : "#/";
    this.navigate(hrefForPage(base, pageNo));
  }

  // -- Render ---------------------------------------------------------------

  render() {
    const signin = Boolean(this.oidc) && !this.auth;
    return html`
      <colony-topbar
        .actor=${this.actor}
        .config=${this.config}
        .auth=${this.auth}
        .oidc=${this.oidc}
        .detail=${this.detail}
      ></colony-topbar>
      ${this.error
        ? html`<div class="banner banner-error" role="alert">
            ${this.error}
          </div>`
        : nothing}
      <main class="view" id="draw">
        ${signin
          ? html`<colony-signin .error=${this.error}></colony-signin>`
          : renderView(this)}
      </main>
      ${renderReaderOverlay(this)}
    `;
  }
}

customElements.define("colony-app", ColonyApp);
