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
} from "./router.js";
import {
  DEMO,
  DEMO_READS,
  demoWorld,
  demoContextStore,
  demoFileStore,
} from "./demo.js";
import {
  buildNewProjectPayload,
  resolveComposerProject,
} from "./project-helpers.js";
import { mdFragment } from "./markdown.js";

const ACTOR_KEY = "colony.actor";
const AUTH_KEY = "colony.auth";
const PKCE_KEY = "colony.pkce";
const PAGE_SIZE = 25;
const POLL_MS = 2500;

// Views the shell loads lazily; later tasks register these modules.
const VIEW_ROUTES = {
  list: "./views/project-list.js",
  project: "./views/project-sheet.js",
  files: "./views/project-files.js",
  newProject: "./views/project-new.js",
  newScope: "./views/scope-new.js",
  scope: "./views/scope-detail.js",
};

function initialActor() {
  try {
    return localStorage.getItem(ACTOR_KEY) || "human:op-1";
  } catch {
    return "human:op-1";
  }
}

function loadAuth() {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeJwt(token) {
  try {
    return JSON.parse(
      atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
    );
  } catch {
    return {};
  }
}

function taskSelectionExists(detail, taskId) {
  if (taskId.startsWith("plan:")) {
    const index = Number(taskId.slice(5));
    let plan = null;
    try {
      plan = JSON.parse(detail.scope.plan_json);
    } catch {
      return false;
    }
    return Number.isInteger(index) && Boolean(plan?.tasks?.[index]);
  }
  return detail.tasks.some((task) => task.id === taskId);
}

/**
 * Shell element <colony-app>: hash router, 2.5s refresh poll, demo-aware API
 * client, Keycloak PKCE auth, and the property-down/events-up hub every view
 * element plugs into. Light DOM (see base.js) so styles.css keeps styling it.
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
    reader: { state: true },
    projectContext: { state: true },
    projectPage: { state: true },
    projectsPage: { state: true },
    filesPage: { state: true },
    projectFiles: { state: true },
    confirm: { state: true },
    confirmFile: { state: true },
    replaceFileId: { state: true },
    newProjectDraft: { state: true },
    error: { state: true },
    auth: { state: true },
    currentRoute: { state: true },
    viewModule: { state: true },
  };

  constructor() {
    super();
    this.config = {
      gitlab_base_url: "",
      review_mode: "off",
      hitl_mode: "yolo",
      trace_ui_base_url: null,
    };
    this.oidc = null;
    this.actor = initialActor();
    this.detail = null;
    this.audit = [];
    this.selectedTaskId = null;
    this.drawerOpen = false;
    this.runEvents = null;
    this.scopeRunEvents = null;
    this.goalOpen = false;
    this.planOpen = false;
    this.briefOpen = false;
    this.reader = null;
    this.projectContext = null;
    this.projectPage = null;
    this.projectsPage = null;
    this.filesPage = null;
    this.projectFiles = null;
    this.confirm = null;
    this.confirmFile = null;
    this.replaceFileId = null;
    this.newProjectDraft = null;
    this.error = "";
    this.auth = null;
    this.currentRoute = { name: "list", params: {} };
    this.viewModule = null;
    this.#parseRoute();
  }

  connectedCallback() {
    super.connectedCallback();
    this.auth = loadAuth();
    this._refresh = this._refresh.bind(this);
    window.addEventListener("hashchange", this);
    document.addEventListener("visibilitychange", this);
    // Escape hatches for the monolith handlers later tasks' views reuse:
    // confirm/toggle/save-context flow through these.
    this.addEventListener("colony-confirm", this);
    this.addEventListener("colony-toggle", this);
    this.addEventListener("colony-save-context", this);
    for (const type of [
      "colony-navigate",
      "colony-actor-change",
      "colony-signin",
      "colony-signout",
      "colony-open-scope",
      "colony-select-task",
      "colony-close-drawer",
      "colony-file-confirm",
      "colony-file-replace-toggle",
      "colony-file-replace",
      "colony-file-delete",
      "colony-file-upload",
      "colony-create-project",
      "colony-create-scope",
      "colony-task-action",
      "colony-abandon",
      "colony-open-reader",
      "colony-close-reader",
      "colony-page",
      "colony-feedback",
    ]) {
      this.addEventListener(type, this);
    }
    this._startPolling();
    this.#loadViewModule();
    void this._refresh();
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this);
    document.removeEventListener("visibilitychange", this);
    for (const type of this.#LISTENED) this.removeEventListener(type, this);
    this._stopPolling();
    super.disconnectedCallback();
  }

  #LISTENED = [
    "colony-navigate",
    "colony-actor-change",
    "colony-signin",
    "colony-signout",
    "colony-open-scope",
    "colony-select-task",
    "colony-close-drawer",
    "colony-confirm",
    "colony-toggle",
    "colony-save-context",
    "colony-file-confirm",
    "colony-file-replace-toggle",
    "colony-file-replace",
    "colony-file-delete",
    "colony-file-upload",
    "colony-create-project",
    "colony-create-scope",
    "colony-task-action",
    "colony-abandon",
    "colony-open-reader",
    "colony-close-reader",
    "colony-page",
    "colony-feedback",
  ];

  handleEvent(event) {
    if (event.type === "hashchange") {
      this._onHashChange();
      return;
    }
    if (event.type === "visibilitychange") {
      if (!document.hidden) void this._refresh();
      return;
    }
    const detail = event.detail ?? {};
    switch (event.type) {
      case "colony-navigate":
        this._navigate(detail.href);
        break;
      case "colony-actor-change":
        this._saveActor(detail.actor);
        break;
      case "colony-signin":
        void this.beginLogin();
        break;
      case "colony-signout":
        this.signOut();
        break;
      case "colony-open-scope":
        this._openScope(detail.id);
        break;
      case "colony-select-task":
        this._selectTask(detail.taskId);
        break;
      case "colony-close-drawer":
        this._closeDrawer();
        break;
      case "colony-confirm":
        this._confirm(detail.kind);
        break;
      case "colony-toggle":
        this._toggle(detail.key);
        break;
      case "colony-save-context":
        void this._saveContext(detail.project, detail.context_doc);
        break;
      case "colony-file-confirm":
        this._confirmFile(detail.fileId);
        break;
      case "colony-file-replace-toggle":
        this._toggleReplaceFile(detail.fileId);
        break;
      case "colony-file-replace":
        void this._replaceFile(detail);
        break;
      case "colony-file-delete":
        void this._deleteFile(detail);
        break;
      case "colony-file-upload":
        void this._uploadFile(detail);
        break;
      case "colony-create-project":
        void this._createProject(detail);
        break;
      case "colony-create-scope":
        void this._createScope(detail);
        break;
      case "colony-task-action":
        void this._taskAction(detail.taskId, detail.action);
        break;
      case "colony-abandon":
        void this._abandon(detail.scopeId);
        break;
      case "colony-open-reader":
        this._openReader(detail.title, detail.markdown);
        break;
      case "colony-close-reader":
        this._closeReader();
        break;
      case "colony-page":
        this._page(detail.page, detail.surface);
        break;
      case "colony-feedback":
        void this._feedback(detail.path, detail.body ?? {});
        break;
      default:
        break;
    }
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
    this.projectsPage = null;
    this.filesPage = null;
    this.projectFiles = null;
    this.briefOpen = false;
    this.confirmFile = null;
    this.replaceFileId = null;
    this.newProjectDraft = null;
    this.#parseRoute();
    this.#loadViewModule();
    void this._refresh();
  }

  /** First hit of a view module is async; keep the shell's loading state brief. */
  #loadViewModule() {
    // Capture the route now: the import settles later, and reading
    // this.currentRoute in the callback would label a module with whatever
    // route is current by then (a hashchange mid-flight mislabels it).
    const route = this.currentRoute.name;
    const viewFile = VIEW_ROUTES[route];
    if (!viewFile) {
      this.viewModule = null;
      return;
    }
    if (this.viewModule?.route === route) return;
    this.viewModule = { route, loading: true };
    import(viewFile)
      .then((module) => {
        if (this.currentRoute.name !== route) return;
        this.viewModule = { route, module, loading: false };
      })
      .catch(() => {
        if (this.currentRoute.name === route) this.viewModule = null;
      });
  }

  // -- Poll -----------------------------------------------------------------

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      if (document.hidden) return;
      void this._refresh();
    }, POLL_MS);
  }

  _stopPolling() {
    if (!this._pollTimer) return;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  // -- API ------------------------------------------------------------------

  async #api(path, options = {}) {
    if (DEMO && !DEMO_READS.test(path)) throw new Error("demo");
    const headers = {
      ...(this.oidc && this.auth
        ? { Authorization: `Bearer ${this.auth.token}` }
        : { "X-Actor-Id": this.actor }),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    };
    const res = await fetch(path, { ...options, headers });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.status === 401 && this.oidc && this.auth) {
      this.#saveAuth(null);
      throw new Error("Signed out — session expired.");
    }
    if (!res.ok) {
      if (options.notFound === "null" && res.status === 404) return null;
      const message =
        data?.error?.message ||
        data?.error?.code ||
        `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    return data;
  }

  /** POST helper: clears any pending confirm, then [#api] + refresh. */
  async #mutate(path, body) {
    this.confirm = null;
    try {
      await this.#api(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      await this._refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  // -- Auth (Keycloak authorization-code + PKCE; colonyd validates the token)

  #saveAuth(auth) {
    this.auth = auth;
    try {
      if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      else sessionStorage.removeItem(AUTH_KEY);
    } catch {
      /* storage unavailable: keep the in-memory session only */
    }
  }

  async beginLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem(
      PKCE_KEY,
      JSON.stringify({ verifier, nonce, hash: location.hash }),
    );
    const params = new URLSearchParams({
      client_id: this.oidc.client_id,
      redirect_uri: `${location.origin}/`,
      response_type: "code",
      scope: "openid profile email",
      state: nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    location.assign(
      `${this.oidc.issuer}/protocol/openid-connect/auth?${params}`,
    );
  }

  async #tokenGrant(body) {
    const res = await fetch(
      `${this.oidc.issuer}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.oidc.client_id,
          ...body,
        }),
      },
    );
    if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
    const data = await res.json();
    const claims = decodeJwt(data.access_token);
    this.#saveAuth({
      token: data.access_token,
      refresh: data.refresh_token,
      exp: (claims.exp || 0) * 1000,
      username: claims.preferred_username || claims.email || "operator",
    });
  }

  async #completeLogin() {
    const query = new URLSearchParams(location.search);
    const code = query.get("code");
    if (!code) return;
    const stash = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    sessionStorage.removeItem(PKCE_KEY);
    history.replaceState(null, "", `/${stash?.hash || ""}`);
    if (!stash || stash.nonce !== query.get("state")) return;
    await this.#tokenGrant({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${location.origin}/`,
      code_verifier: stash.verifier,
    });
  }

  async #ensureFreshToken() {
    if (!this.auth) return;
    if (Date.now() < this.auth.exp - 60_000) return;
    try {
      await this.#tokenGrant({
        grant_type: "refresh_token",
        refresh_token: this.auth.refresh,
      });
    } catch {
      this.#saveAuth(null);
    }
  }

  signOut() {
    const issuer = this.oidc?.issuer;
    this.#saveAuth(null);
    if (issuer) {
      const params = new URLSearchParams({
        client_id: this.oidc.client_id,
        post_logout_redirect_uri: `${location.origin}/`,
      });
      location.assign(`${issuer}/protocol/openid-connect/logout?${params}`);
    }
  }

  // -- Refresh --------------------------------------------------------------

  async _refresh() {
    try {
      if (DEMO) {
        this.#refreshDemo();
        return;
      }
      this.config = await this.#api("/ui/config");
      this.oidc = this.config.oidc || null;
      if (this.oidc) {
        if (new URLSearchParams(location.search).has("code")) {
          await this.#completeLogin();
        }
        await this.#ensureFreshToken();
        if (!this.auth) {
          this.error = "";
          return;
        }
      }
      const pageNo = pageFromHash(location.hash);
      const offset = (pageNo - 1) * PAGE_SIZE;
      const projectName = routeProjectName();
      const filesName = routeProjectFilesName();
      if (filesName) {
        const [project, filesPage] = await Promise.all([
          this.#api(`/projects/${encodeURIComponent(filesName)}`, {
            notFound: "null",
          }),
          this.#api(
            `/projects/${encodeURIComponent(filesName)}/files?limit=${PAGE_SIZE}&offset=${offset}`,
          ),
        ]);
        this.filesPage = {
          name: filesName,
          project: project === null ? null : project.project,
          files: filesPage.files ?? [],
          total: filesPage.total ?? 0,
          offset,
          page: pageNo,
        };
        this.projectPage = null;
        this.error = "";
        return;
      }
      this.filesPage = null;
      if (projectName) {
        // The project route owns this refresh: it must not touch board or
        // sheet state, and it must preserve an in-flight editor "Saved.".
        const [project, scopesPage] = await Promise.all([
          this.#api(`/projects/${encodeURIComponent(projectName)}`, {
            notFound: "null",
          }),
          this.#api(
            `/scopes?limit=${PAGE_SIZE}&offset=${offset}&project=${encodeURIComponent(projectName)}`,
          ),
        ]);
        this.projectPage = {
          name: projectName,
          project: project === null ? null : project.project,
          scopes: scopesPage.scopes,
          total: scopesPage.total,
          offset,
          page: pageNo,
        };
        // Seed the editor from the same read Save round-trips through so the
        // prefill cannot drift from what Save persists.
        if (this.projectContext === null && project) {
          const stored = await this.#api(
            `/projects/${encodeURIComponent(projectName)}/context`,
          );
          this.projectContext = { doc: stored.context_doc ?? "", status: null };
        }
        if (this.projectFiles === null && project) {
          const filesPage = await this.#api(
            `/projects/${encodeURIComponent(projectName)}/files?limit=${PAGE_SIZE}&offset=0`,
          );
          this.projectFiles = filesPage.files ?? [];
        }
        this.error = "";
        return;
      }
      this.projectPage = null;
      const projectsPage = await this.#api(
        `/projects?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      this.projectsPage = {
        projects: projectsPage.projects ?? [],
        total: projectsPage.total ?? 0,
        offset,
        page: pageNo,
      };
      const id = routeScopeId();
      if (id) {
        const [detail, audit] = await Promise.all([
          this.#api(`/scopes/${encodeURIComponent(id)}`),
          this.#api(`/audit?scope_id=${encodeURIComponent(id)}&limit=1000`),
        ]);
        this.detail = detail;
        this.audit = audit.events;
        if (
          this.projectContext === null &&
          detail.project &&
          detail.project.context_doc !== undefined
        ) {
          this.projectContext = {
            doc: detail.project.context_doc ?? "",
            status: null,
          };
        }
        if (
          this.selectedTaskId &&
          !taskSelectionExists(detail, this.selectedTaskId)
        ) {
          this.selectedTaskId = null;
          this.drawerOpen = false;
        }
        await this.#refreshRunEvents(detail);
      } else {
        this.detail = null;
        this.projectContext = null;
        this.audit = (await this.#api("/audit?limit=12")).events;
      }
      this.error = "";
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Demo mode: serve the offline world through the same state slots. */
  #refreshDemo() {
    const world = demoWorld();
    this.config = world.config;
    const id = routeScopeId();
    if (id) {
      const scopeRow = world.scopes.find((s) => s.id === id) ?? null;
      this.detail = scopeRow
        ? scopeRow.id === world.detail.scope.id
          ? world.detail
          : { scope: scopeRow, tasks: [], deps: [], runs: [] }
        : null;
    } else {
      this.detail = null;
    }
    const demoName = routeProjectName();
    const filesName = routeProjectFilesName();
    const pageNo = pageFromHash(location.hash);
    if (filesName) {
      const found = world.projects.find((p) => p.name === filesName) ?? null;
      const files = demoFileStore.get(filesName) ?? [];
      const start = (pageNo - 1) * PAGE_SIZE;
      this.filesPage = {
        name: filesName,
        project: found,
        files: files.slice(start, start + PAGE_SIZE),
        total: files.length,
        offset: start,
        page: pageNo,
      };
      this.projectPage = null;
    } else {
      this.filesPage = null;
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
      this.projectPage = {
        name: demoName,
        project: world.project,
        scopes: owned.slice(start, start + PAGE_SIZE),
        total: owned.length,
        offset: start,
        page: pageNo,
      };
      if (this.projectContext === null) {
        const stored = demoContextStore.has(demoName)
          ? { context_doc: demoContextStore.get(demoName) }
          : { context_doc: world.project.context_doc ?? "" };
        this.projectContext = { doc: stored.context_doc ?? "", status: null };
      }
      this.projectFiles = demoFileStore.get(demoName) ?? [];
    } else if (demoName) {
      const found = world.projects.find((p) => p.name === demoName) ?? null;
      this.projectPage = {
        name: demoName,
        project: found,
        scopes: [],
        total: 0,
        offset: 0,
        page: pageNo,
      };
      this.projectFiles = found ? (demoFileStore.get(demoName) ?? []) : [];
    } else {
      this.projectPage = null;
      const ordered = [...world.projects].sort(
        (a, b) =>
          Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      const start = (pageNo - 1) * PAGE_SIZE;
      this.projectsPage = {
        projects: ordered.slice(start, start + PAGE_SIZE),
        total: ordered.length,
        offset: start,
        page: pageNo,
      };
    }
    this.audit = world.audit;
    if (this.drawerOpen && this.selectedTaskId === "col-a1b2c3d4.1") {
      this.runEvents = { runId: "run-gate-1", rows: world.runEvents };
    }
    this.error = "";
  }

  /** Live agent feed for the drawer's most recent running run, if any. */
  async #refreshRunEvents(detail) {
    const targets = [];
    if (this.drawerOpen && this.selectedTaskId) {
      const liveRun = [...(detail.runs || [])]
        .reverse()
        .find(
          (run) =>
            run.task_id === this.selectedTaskId && run.status === "running",
        );
      if (liveRun) targets.push(liveRun);
    }
    // Scope-level architect runs stream into the Plan card so planning is
    // never a black box.
    const architect = (detail.runs || []).find(
      (run) => run.kind === "architect" && run.status === "running",
    );
    if (architect) targets.push(architect);
    if (!targets.length) {
      this.runEvents = null;
      this.scopeRunEvents = null;
      return;
    }
    try {
      const feeds = await Promise.all(
        targets.map(async (run) => ({
          runId: run.id,
          rows: (await this.#api(`/runs/${encodeURIComponent(run.id)}/events`))
            .events,
        })),
      );
      const drawerTarget = targets.find((run) => run !== architect);
      this.runEvents = drawerTarget
        ? (feeds.find((f) => f.runId === drawerTarget.id) ?? null)
        : null;
      this.scopeRunEvents = architect
        ? (feeds.find((f) => f.runId === architect.id) ?? null)
        : null;
    } catch {
      this.runEvents = null;
      this.scopeRunEvents = null;
    }
  }

  // -- Actions (event handlers) ---------------------------------------------

  _navigate(href) {
    if (!href || location.hash === href) return;
    location.hash = href;
  }

  _saveActor(actor) {
    const next = String(actor ?? "").trim();
    if (!next || next === this.actor) return;
    this.actor = next;
    try {
      localStorage.setItem(ACTOR_KEY, next);
    } catch {
      /* private mode: keep the actor for this page only */
    }
    void this._refresh();
  }

  _openScope(id) {
    if (!id) return;
    this._navigate(`#/${id}`);
  }

  _selectTask(taskId) {
    this.selectedTaskId = taskId;
    this.drawerOpen = true;
    this.confirm = null;
    this.runEvents = null;
    void this._refresh();
  }

  _closeDrawer() {
    this.drawerOpen = false;
    this.runEvents = null;
  }

  _confirm(kind) {
    this.confirm = kind;
  }

  _toggle(key) {
    this[key] = !this[key];
  }

  async _saveContext(project, context_doc) {
    const page = this.projectPage;
    const name = project ?? page?.name;
    if (!name) return;
    const doc = String(context_doc ?? "").trim() ? context_doc : null;
    this.projectContext = { doc: context_doc ?? "", status: "saving" };
    if (DEMO) {
      // Demo brief editing is purely local state, never a network write.
      demoContextStore.set(name, doc);
      this.projectContext = { doc: context_doc ?? "", status: "saved" };
      return;
    }
    try {
      await this.#api(`/projects/${encodeURIComponent(name)}/context`, {
        method: "PUT",
        body: JSON.stringify({ context_doc: doc }),
      });
      this.projectContext = { doc: context_doc ?? "", status: "saved" };
      await this._refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.projectContext = { doc: context_doc ?? "", status: null };
    }
  }

  _confirmFile(fileId) {
    this.confirmFile = this.confirmFile === fileId ? null : fileId;
  }

  _toggleReplaceFile(fileId) {
    this.replaceFileId = this.replaceFileId === fileId ? null : fileId;
    this.confirmFile = null;
  }

  async #fileTarget(fileId) {
    const name = routeProjectFilesName();
    const page = this.filesPage;
    if (!name || !page?.project) return null;
    if (DEMO) {
      demoFileStore.set(
        name,
        (demoFileStore.get(name) ?? []).filter((f) => f.id !== fileId),
      );
      this.confirmFile = null;
      await this._refresh();
      return null;
    }
    return name;
  }

  async _deleteFile({ fileId }) {
    const name = await this.#fileTarget(fileId);
    if (!name) return;
    try {
      await this.#api(
        `/projects/${encodeURIComponent(name)}/files/${encodeURIComponent(fileId)}`,
        { method: "DELETE" },
      );
      this.confirmFile = null;
      await this._refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async _replaceFile({ fileId, content, media_type }) {
    const page = this.filesPage;
    if (DEMO) {
      const files = demoFileStore.get(page.name) ?? [];
      demoFileStore.set(
        page.name,
        files.map((f) =>
          f.id === fileId
            ? {
                ...f,
                media_type,
                byte_size: new TextEncoder().encode(content).length,
                updated_at: new Date().toISOString(),
              }
            : f,
        ),
      );
      this.replaceFileId = null;
      await this._refresh();
      return;
    }
    if (!page?.project) return;
    try {
      await this.#api(
        `/projects/${encodeURIComponent(page.name)}/files/${encodeURIComponent(fileId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ media_type, content }),
        },
      );
      this.replaceFileId = null;
      await this._refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async _uploadFile({ filename, media_type, content }) {
    const page = this.filesPage;
    if (!page?.project) return;
    if (DEMO) {
      const files = demoFileStore.get(page.name) ?? [];
      demoFileStore.set(page.name, [
        ...files,
        {
          id: `demo-file-${Date.now()}`,
          filename,
          media_type,
          byte_size: new TextEncoder().encode(content).length,
          sha256: "d".repeat(64),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
      await this._refresh();
      return;
    }
    try {
      await this.#api(`/projects/${encodeURIComponent(page.name)}/files`, {
        method: "POST",
        body: JSON.stringify({ filename, media_type, content }),
      });
      await this._refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async _createProject({ name, context_doc }) {
    const payload = buildNewProjectPayload(name, context_doc);
    if (!payload) return;
    try {
      await this.#api("/projects", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      this.newProjectDraft = null;
      this._navigate(projectHref(payload.name));
    } catch (err) {
      this.newProjectDraft = { name, context_doc };
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async _createScope({ goal, title, project, repo, approvals }) {
    const trimmedGoal = String(goal ?? "").trim();
    const path = String(repo?.path ?? "").trim();
    if (!trimmedGoal || !path) return;
    // When the composer was opened from a project, the project is fixed: the
    // operator cannot silently change it.
    const fixedProject = resolveComposerProject(
      hashQueryProject(),
      project ?? null,
    );
    try {
      const scope = await this.#api("/scopes", {
        method: "POST",
        body: JSON.stringify({
          goal: trimmedGoal,
          ...(title ? { title } : {}),
          approvals: approvals || "auto",
          repo: { path },
          ...(fixedProject ? { project: fixedProject } : {}),
        }),
      });
      this._navigate(`#/${scope.id}`);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async _taskAction(taskId, action) {
    if (!taskId || !action) return;
    await this.#mutate(`/tasks/${encodeURIComponent(taskId)}/${action}`);
  }

  async _abandon(scopeId) {
    await this.#mutate(`/scopes/${encodeURIComponent(scopeId)}/abandon`);
  }

  _openReader(title, markdown) {
    this.reader = { title, markdown };
  }

  _closeReader() {
    this.reader = null;
  }

  /**
   * Pagination targets fixed clean bases (never the current hash, which may
   * already carry ?page=N): the monolith paged #/ (projects), the project
   * sheet, and the manage-files page. Page 1 drops the query so Previous
   * from page 2 navigates back for real.
   */
  _page(page, surface) {
    const pageNo = Math.max(1, Number(page) || 1);
    const base =
      surface === "project"
        ? projectHref(this.currentRoute.params.name ?? "")
        : surface === "files"
          ? projectFilesHref(this.currentRoute.params.name ?? "")
          : "#/";
    this._navigate(hrefForPage(base, pageNo));
  }

  async _feedback(path, body) {
    const feedback = String(body?.feedback ?? "").trim();
    if (!feedback) return;
    await this.#mutate(path, { feedback });
  }

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
          : this.#view()}
      </main>
      ${this.#readerOverlay()}
    `;
  }

  #view() {
    if (this.viewModule?.loading) {
      return html`<p class="note">Loading…</p>`;
    }
    const routes = this.viewModule?.module?.routes;
    if (!routes) return nothing;
    const view = routes[this.currentRoute.name];
    return view
      ? view(this.currentRoute.params, this)
      : html`<p class="note">No view for #/${this.currentRoute.name}</p>`;
  }

  #readerOverlay() {
    if (!this.reader) return nothing;
    return html`<div
      class="reader-overlay"
      @click=${(event) => {
        if (event.target === event.currentTarget) this._closeReader();
      }}
    >
      <div
        class="reader"
        role="dialog"
        aria-modal="true"
        aria-label=${this.reader.title}
      >
        <header class="reader-head">
          <p>${this.reader.title}</p>
          <button class="btn btn-quiet" @click=${() => this._closeReader()}>
            Close
          </button>
        </header>
        <div class="reader-body md">${mdFragment(this.reader.markdown)}</div>
      </div>
    </div>`;
  }
}

customElements.define("colony-app", ColonyApp);
