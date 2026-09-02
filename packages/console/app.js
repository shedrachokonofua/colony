import { html, svg, render as litRender, nothing } from "lit";
import { classMap } from "lit-html/directives/class-map.js";
import { repeat } from "lit-html/directives/repeat.js";
import { live } from "lit-html/directives/live.js";
import {
  createRunTicker,
  durationAriaLabel,
  formatDuration,
  isoDuration,
  runDurationMs,
} from "./duration.js";
import { costPredictionLines, parseCostPrediction } from "./cost-prediction.js";
import { traceHref } from "./trace-link.js";
import {
  deriveRunningRow,
  formatRunningEmptyTallies,
  parseProjectTab,
  serializeProjectTabHref,
} from "./project-helpers.js";
import {
  hrefForPage,
  outOfRange,
  pageCount,
  pageFromHash,
} from "./pagination.js";

const ACTOR_KEY = "colony.actor";
const AUTH_KEY = "colony.auth";
const DEMO = new URLSearchParams(location.search).has("demo");
// Demo-safe read paths: project detail, its context, its scope page, and the
// project list (the homepage) so the whole console is driveable offline.
const DEMO_READS =
  /^\/projects\/[^/?]+(?:\/context|\/running|\/files(?:\/\w+)?)?(?:\?.*)?$|^\/projects\?|^\/scopes\?/;

// Demo volume: enough projects and scopes to exercise page 2 on both surfaces.
const DEMO_PROJECT_COUNT = 27;
const DEMO_SCOPES_IN_PROJECT = 27;

// Pure helpers for the project surfaces. They live here (not a module) so the
// unit tests can bind to the exact source the UI runs, and so the console
// stays a single no-build script.

function repoSummaryText(repositories) {
  const repos = distinctRepos(repositories);
  if (repos.length === 0) return "No connected repositories";
  const count = repos.length;
  const shown = repos.slice(0, 2).map((r) => r.repo_path);
  const more = count > 2 ? ` +${count - 2} more` : "";
  return `${count} connected repo${count === 1 ? "" : "s"} · ${shown.join(" · ")}${more}`;
}

/** Connected repositories deduped by repo_path, preserving first-seen order. */
function distinctRepos(repositories) {
  const seen = new Set();
  const out = [];
  for (const repo of repositories ?? []) {
    if (!repo?.repo_path || seen.has(repo.repo_path)) continue;
    seen.add(repo.repo_path);
    out.push(repo);
  }
  return out;
}

function knowledgeText(context_doc, file_count) {
  const brief = context_doc ? "Brief" : "No brief";
  const n = file_count ?? 0;
  return `${brief} · ${n} reference file${n === 1 ? "" : "s"}`;
}

/** First non-heading paragraph of the brief, flattened to one plain line. */
function projectDescription(context_doc) {
  const doc = String(context_doc ?? "");
  for (const block of doc.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (lines.length) return lines.join(" ");
  }
  return "";
}

function resolveComposerProject(fixedProject, formValue) {
  const fixed = fixedProject != null ? String(fixedProject).trim() : "";
  if (fixed) return fixed;
  return String(formValue ?? "").trim();
}

function buildNewProjectPayload(name, context_doc) {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) return null;
  const doc = String(context_doc ?? "").trim();
  const body = { name: trimmedName };
  if (doc) body.context_doc = doc;
  return body;
}

const KIND_LABEL = {
  architect: "plan",
  implement: "build",
  review: "review",
  merge_gate: "gate",
  validate: "validate",
};

const state = {
  config: {
    gitlab_base_url: "",
    review_mode: "off",
    hitl_mode: "yolo",
    trace_ui_base_url: null,
  },
  oidc: null,
  actor: localStorage.getItem(ACTOR_KEY) || "human:op-1",
  detail: null,
  audit: [],
  selectedTaskId: null,
  drawerOpen: false,
  runEvents: null,
  scopeRunEvents: null,
  goalOpen: false,
  planOpen: false,
  reader: null,
  projectContext: null,
  projectPage: null,
  projectsPage: null,
  filesPage: null,
  projectFiles: null,
  projectRunning: null,
  pendingSelectTaskId: null,
  projectTab: hashQueryTab(),
  showArchived: false,
  briefOpen: false,
  confirmFile: null,
  replaceFileId: null,
  newProjectDraft: null,
  auth: loadAuth(),
  error: "",
  confirm: null,
  poll: 0,
  durationTicker: null,
};

const app = document.getElementById("app");
app.textContent = "";

// ---------------------------------------------------------------------------
// Auth (Keycloak authorization-code + PKCE; colonyd validates the bearer)
// ---------------------------------------------------------------------------

function loadAuth() {
  try {
    const raw = sessionStorage.getItem("colony.auth");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  state.auth = auth;
  if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  else sessionStorage.removeItem(AUTH_KEY);
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function beginLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(
    "colony.pkce",
    JSON.stringify({ verifier, nonce, hash: location.hash }),
  );
  const params = new URLSearchParams({
    client_id: state.oidc.client_id,
    redirect_uri: `${location.origin}/`,
    response_type: "code",
    scope: "openid profile email",
    state: nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(
    `${state.oidc.issuer}/protocol/openid-connect/auth?${params}`,
  );
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

async function tokenGrant(body) {
  const res = await fetch(
    `${state.oidc.issuer}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: state.oidc.client_id,
        ...body,
      }),
    },
  );
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  const data = await res.json();
  const claims = decodeJwt(data.access_token);
  saveAuth({
    token: data.access_token,
    refresh: data.refresh_token,
    exp: (claims.exp || 0) * 1000,
    username: claims.preferred_username || claims.email || "operator",
  });
}

async function completeLogin() {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  if (!code) return;
  const stash = JSON.parse(sessionStorage.getItem("colony.pkce") || "null");
  sessionStorage.removeItem("colony.pkce");
  history.replaceState(null, "", `/${stash?.hash || ""}`);
  if (!stash || stash.nonce !== query.get("state")) return;
  await tokenGrant({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${location.origin}/`,
    code_verifier: stash.verifier,
  });
}

async function ensureFreshToken() {
  if (!state.auth) return;
  if (Date.now() < state.auth.exp - 60_000) return;
  try {
    await tokenGrant({
      grant_type: "refresh_token",
      refresh_token: state.auth.refresh,
    });
  } catch {
    saveAuth(null);
  }
}

function signOut() {
  const issuer = state.oidc?.issuer;
  saveAuth(null);
  if (issuer) {
    const params = new URLSearchParams({
      client_id: state.oidc.client_id,
      post_logout_redirect_uri: `${location.origin}/`,
    });
    location.assign(`${issuer}/protocol/openid-connect/logout?${params}`);
  } else {
    paint();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
}

function rel(iso) {
  if (!iso) return "—";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 8) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function routeScopeId() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (
    !hash ||
    hash.startsWith("?") ||
    NEW_ROUTE.test(hash) ||
    NEW_PROJECT_ROUTE.test(hash) ||
    PROJECT_ROUTE.test(hash)
  )
    return null;
  return hash;
}

const PROJECT_ROUTE = /^project\/([^/?]+)/;
const FILES_ROUTE = /^project\/([^/?]+)\/files(?:$|\?)/;
// Create route, optionally carrying a query (e.g. #/new?project=X).
const NEW_ROUTE = /^new(?:$|\?)/;
const NEW_PROJECT_ROUTE = /^new-project(?:$|\?)/;

function routeIsNew() {
  return NEW_ROUTE.test(location.hash.replace(/^#\/?/, ""));
}

function routeIsNewProject() {
  return NEW_PROJECT_ROUTE.test(location.hash.replace(/^#\/?/, ""));
}

function routeIsManageFiles() {
  return FILES_ROUTE.test(location.hash.replace(/^#\/?/, ""));
}

function routeProjectFilesName() {
  const match = location.hash.replace(/^#\/?/, "").match(FILES_ROUTE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Decoded project name from `#/project/<name>`, or null on any other route. */
function routeProjectName() {
  const match = location.hash.replace(/^#\/?/, "").match(PROJECT_ROUTE);
  return match ? decodeURIComponent(match[1]) : null;
}

function projectHref(name) {
  return `#/project/${encodeURIComponent(name)}`;
}

function hashQueryTab() {
  return parseProjectTab(location.hash);
}

/** The `?project=` query of the current hash route, or null when absent. */
function hashQueryProject() {
  const q = location.hash.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("project");
}

const BRAND_MARK = html`<svg
  class="brand-mark"
  viewBox="0 0 24 24"
  aria-hidden="true"
>
  <path
    class="cell cell-a"
    d="M7 2.5 L11.5 5 L11.5 10 L7 12.5 L2.5 10 L2.5 5 Z"
  />
  <path
    class="cell cell-b"
    d="M17 6.5 L21.5 9 L21.5 14 L17 16.5 L12.5 14 L12.5 9 Z"
  />
  <path
    class="cell cell-c"
    d="M8.5 12.5 L13 15 L13 20 L8.5 22.5 L4 20 L4 15 Z"
  />
</svg>`;

function parseEvidence(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePlan(raw) {
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw);
    if (!plan || !Array.isArray(plan.tasks)) return null;
    return plan;
  } catch {
    return null;
  }
}
function parseAuditDetail(raw) {
  if (!raw) return {};
  try {
    const detail = JSON.parse(raw);
    return detail && typeof detail === "object" ? detail : {};
  } catch {
    return {};
  }
}

function scopeTitle(scope) {
  if (!scope) return "";
  if (scope.title) return scope.title;
  return scope.goal.length > 72
    ? `${scope.goal.slice(0, 72).trimEnd()}…`
    : scope.goal;
}

function latestValidateRun(detail) {
  const runs = (detail?.runs || []).filter((run) => run.kind === "validate");
  return runs
    .slice()
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    .pop();
}

function waitingOnYou(scope, tasks, detail) {
  if (!scope) return "";
  if (scope.status === "planning" && scope.plan_json) {
    return "Plan is waiting for your approval.";
  }
  if (scope.status === "planning") return "Architect is drawing the plan.";
  if (scope.status === "validating") {
    const latest = latestValidateRun(detail);
    if (latest?.status === "failed") {
      return "Validation failed — fix the goal on the default branch, then run validation again.";
    }
    if (latest?.status === "running") {
      return "Validating the goal on the default branch — running acceptance criteria against a fresh checkout.";
    }
    return "Waiting for validation to start.";
  }
  if (scope.status === "blocked") {
    return scope.blocked_reason || "Scope is blocked.";
  }
  if (scope.approvals === "manual") {
    const awaiting = (tasks || []).filter(
      (task) => task.state === "mr_open" && !task.merge_approved_sha,
    );
    if (awaiting.length === 1) {
      return `Merge request !${awaiting[0].mr_iid} is waiting for your approval.`;
    }
    if (awaiting.length > 1) {
      return `${awaiting.length} merge requests are waiting for your approval.`;
    }
  }
  const blocked = (tasks || []).filter((task) => task.state === "blocked");
  if (blocked.length === 1) {
    return `${blocked[0].title} is blocked.`;
  }
  if (blocked.length > 1) return `${blocked.length} tasks are blocked.`;
  return "";
}

function gitlabRepoUrl(path) {
  const base = state.config.gitlab_base_url.replace(/\/$/, "");
  if (!base || !path) return "";
  return `${base}/${path}`;
}

function mrUrl(path, iid) {
  const repo = gitlabRepoUrl(path);
  return repo && iid ? `${repo}/-/merge_requests/${iid}` : "";
}

function commitUrl(path, sha) {
  const repo = gitlabRepoUrl(path);
  return repo && sha ? `${repo}/-/commit/${sha}` : "";
}

async function api(path, options = {}) {
  if (DEMO) {
    // The project route reads through the demo world so #/project/… stays
    // fully offline; every other path keeps its demo guard.
    if (!DEMO_READS.test(path)) throw new Error("demo");
  }
  const headers = {
    ...(state.oidc && state.auth
      ? { Authorization: `Bearer ${state.auth.token}` }
      : { "X-Actor-Id": state.actor }),
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
  if (res.status === 401 && state.oidc && state.auth) {
    saveAuth(null);
    paint();
    throw new Error("Signed out — session expired.");
  }
  if (!res.ok) {
    // A missing resource is a renderable state, not a crash: callers that
    // pass notFound: "null" get null back and paint an honest empty page.
    if (options.notFound === "null" && res.status === 404) return null;
    const message =
      data?.error?.message ||
      data?.error?.code ||
      `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Demo world (?demo)
// ---------------------------------------------------------------------------

const DEMO_SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DEMO_SHA_B = "b9c0d1e2f30415263748a9b0c1d2e3f401234567";
const DEMO_GATE_STARTED = new Date(Date.now() - 12 * 1000).toISOString();

// Demo brief/file edits are purely local state: they must never hit the
// network, but the same affordances stay visible.
const demoContextStore = new Map();
const demoFileStore = new Map();

function demoWorld() {
  const now = Date.now();
  // Filler projects: DEMO_PROJECT_COUNT - 1 of them, each strictly newer than
  // the demo project, so "Operator console" sorts at index DEMO_PROJECT_COUNT - 1
  // = offset 25 — the first row of the homepage's page 2.
  const fillerProjects = Array.from(
    { length: DEMO_PROJECT_COUNT - 1 },
    (_, i) => ({
      name: `Demo project ${String(i).padStart(2, "0")}`,
      context_doc: null,
      created_at: new Date(now - (i + 1) * 3600_000).toISOString(),
      updated_at: new Date(now - (i + 1) * 3600_000).toISOString(),
      scope_count: 0,
      status_counts: {
        draft: 0,
        planning: 0,
        active: 0,
        validating: 0,
        blocked: 0,
        done: 0,
        abandoned: 0,
      },
      last_activity_at: null,
      file_count: 0,
      file_bytes: 0,
      repositories: [],
    }),
  );
  // Generated Operator-console scopes. Hand-authored scopes are newer than
  // every generated one but are not owned by this project, so d25 is exactly
  // the 26th row (offset 25): the first row of the project's scopes page 2.
  const generatedScopes = Array.from(
    { length: DEMO_SCOPES_IN_PROJECT },
    (_, i) => {
      const created = new Date(now - (i + 3) * 3600_000);
      return {
        id: `col-d${String(i).padStart(2, "0")}`,
        goal: `Demo goal ${String(i).padStart(2, "0")}`,
        title: `Demo scope ${String(i).padStart(2, "0")}`,
        project_name: "Operator console",
        status: ["active", "validating", "done", "blocked"][i % 4],
        provider_repo_path: "so/colony",
        default_branch: "main",
        plan_json: null,
        acceptance_json: null,
        blocked_reason: null,
        created_at: created.toISOString(),
        updated_at: new Date(created.getTime() + 60_000).toISOString(),
      };
    },
  );
  const projectScopes = generatedScopes;
  const statusCounts = {
    draft: 0,
    planning: 0,
    active: 0,
    validating: 0,
    blocked: 0,
    done: 0,
    abandoned: 0,
  };
  for (const s of projectScopes) statusCounts[s.status] += 1;
  const demoFiles = [
    {
      id: "demo-file-1",
      filename: "AGENTS.md",
      media_type: "text/markdown",
      byte_size: 512,
      sha256: "a".repeat(64),
      created_at: new Date(now - 20 * 86400 * 1000).toISOString(),
      updated_at: new Date(now - 20 * 86400 * 1000).toISOString(),
    },
    {
      id: "demo-file-2",
      filename: "conventions.md",
      media_type: "text/markdown",
      byte_size: 1280,
      sha256: "b".repeat(64),
      created_at: new Date(now - 18 * 86400 * 1000).toISOString(),
      updated_at: new Date(now - 18 * 86400 * 1000).toISOString(),
    },
  ];
  demoFileStore.set("Operator console", demoFiles);
  const demoProject = {
    name: "Operator console",
    context_doc:
      "Console is no-build lit-html served straight from packages/console. " +
      "Light theme, white and deep blues, no external CDNs.",
    created_at: new Date(now - 30 * 86400 * 1000).toISOString(),
    // Exactly DEMO_PROJECT_COUNT - 1 >= 25 filler projects are strictly newer,
    // so the demo project lands inside the page-2 window (offset 25).
    updated_at: new Date(
      now - (DEMO_PROJECT_COUNT + 1) * 3600_000,
    ).toISOString(),
    scope_count: projectScopes.length,
    status_counts: statusCounts,
    task_state_counts: {
      queued: 4,
      running: 1,
      mr_open: 1,
      merged: 12,
      blocked: 2,
      canceled: 0,
    },
    last_activity_at: new Date(
      Math.max(...projectScopes.map((s) => Date.parse(s.updated_at))),
    ).toISOString(),
    file_count: demoFiles.length,
    file_bytes: demoFiles.reduce((sum, f) => sum + f.byte_size, 0),
    repositories: [
      { repo_id: "49", repo_path: "so/colony" },
      { repo_id: "112", repo_path: "so/console-e2e" },
    ],
  };
  if (demoContextStore.has(demoProject.name)) {
    demoProject.context_doc = demoContextStore.get(demoProject.name);
  }
  // A second demo project with no brief, no files, and no scopes so the
  // empty states are visible offline.
  const emptyProject = {
    name: "Empty workspace",
    context_doc: null,
    created_at: new Date(now - 40 * 86400 * 1000).toISOString(),
    updated_at: new Date(now - 40 * 86400 * 1000).toISOString(),
    scope_count: 0,
    status_counts: {
      draft: 0,
      planning: 0,
      active: 0,
      validating: 0,
      blocked: 0,
      done: 0,
      abandoned: 0,
    },
    task_state_counts: {
      queued: 0,
      running: 0,
      mr_open: 0,
      merged: 0,
      blocked: 0,
      canceled: 0,
    },
    last_activity_at: null,
    file_count: 0,
    file_bytes: 0,
    repositories: [],
  };
  demoFileStore.set("Empty workspace", []);
  const scope = {
    id: "col-a1b2c3d4",
    goal: "Add a /version endpoint that returns the running colonyd SHA",
    title: "Version endpoint",
    status: "validating",
    project_name: null,
    provider_repo_id: "49",
    provider_repo_path: "so/colony",
    default_branch: "main",
    plan_json: JSON.stringify({
      summary:
        "One vertical task builds the Stage-1 site: **SvelteKit** + adapter-node, landing page, `/sample-report` from a static fixture, and `POST /api/waitlist` with rate limiting.",
      acceptance: [
        {
          description:
            "Fresh checkout: install, typecheck, tests, build all green.",
          command: "npm ci && npm run typecheck && npm test && npm run build",
        },
      ],
      tasks: [
        {
          title: "Build the Stage-1 landing page",
          depends_on: [],
          spec: "# Goal\n\nBuild the complete site.\n\n## Waitlist\n\n- `POST /api/waitlist` validates server-side\n- token bucket per IP, returns `429` when exhausted\n\n```ts\nexport function take(ip: string): boolean {\n  return bucket.take(ip);\n}\n```\n\n> Stage 1 must not ask visitors for real prospect data.",
        },
      ],
    }),
    acceptance_json: JSON.stringify([
      {
        description:
          "Fresh checkout: the full test suite passes against isolated temp SQLite + fake boundary.",
        command: "npm ci --no-audit >/dev/null 2>&1 && npm test",
      },
      {
        description:
          "GET /version returns the running colonyd SHA with content-type application/json.",
        command: "curl -sS localhost:4400/version | jq -e .sha",
      },
    ]),
    blocked_reason: null,
    created_at: new Date(Date.now() - 36 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 12 * 1000).toISOString(),
  };
  const tasks = [
    {
      id: "col-a1b2c3d4.0",
      scope_id: scope.id,
      title: "Return /version as JSON",
      spec: 'GET /version returns {"sha": "..."} from COLONY_VERSION.',
      state: "merged",
      state_version: 4,
      branch: "colony/col-a1b2c3d4.0",
      mr_iid: 12,
      attempt: 0,
      next_retry_at: null,
      blocked_reason: null,
      created_at: scope.created_at,
      updated_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    },
    {
      id: "col-a1b2c3d4.1",
      scope_id: scope.id,
      title: "Wire /version into the health page",
      spec: "Health payload includes the same sha without breaking {ok, service}.",
      state: "mr_open",
      state_version: 3,
      branch: "colony/col-a1b2c3d4.1",
      mr_iid: 13,
      attempt: 1,
      next_retry_at: null,
      blocked_reason: null,
      created_at: scope.created_at,
      updated_at: new Date(Date.now() - 12 * 1000).toISOString(),
    },
    {
      id: "col-a1b2c3d4.2",
      scope_id: scope.id,
      title: "Acceptance check for /version",
      spec: "Scenario asserts GET /version matches the image tag.",
      state: "queued",
      state_version: 0,
      branch: null,
      mr_iid: null,
      attempt: 0,
      next_retry_at: null,
      blocked_reason: null,
      created_at: scope.created_at,
      updated_at: scope.created_at,
    },
  ];
  const deps = [
    { task_id: "col-a1b2c3d4.1", depends_on_task_id: "col-a1b2c3d4.0" },
    { task_id: "col-a1b2c3d4.2", depends_on_task_id: "col-a1b2c3d4.1" },
  ];
  const runs = [
    {
      id: "run-validate",
      scope_id: scope.id,
      task_id: null,
      kind: "validate",
      status: "failed",
      model_id: null,
      head_sha: DEMO_SHA_A,
      started_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      finished_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      error: null,
      // Real acceptance commands often discard their own output; the card
      // must render a failed criterion without an empty output pane.
      evidence_json: JSON.stringify({
        passed: false,
        results: [
          { index: 0, exit_code: 255, tail: [""] },
          { index: 1, exit_code: 0, tail: [""] },
        ],
      }),
    },
    {
      id: "run-arch",
      scope_id: scope.id,
      task_id: null,
      kind: "architect",
      status: "succeeded",
      model_id: "deepseek-v4-flash",
      head_sha: null,
      error: null,
      evidence_json: null,
      envelope_json: null,
      started_at: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      finished_at: new Date(Date.now() - 33 * 60 * 1000).toISOString(),
    },
    {
      id: "run-impl-0",
      scope_id: scope.id,
      task_id: "col-a1b2c3d4.0",
      kind: "implement",
      status: "succeeded",
      head_sha: DEMO_SHA_A,
      error: null,
      evidence_json: null,
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      finished_at: new Date(Date.now() - 24 * 60 * 1000).toISOString(),
    },
    {
      id: "run-gate-1",
      scope_id: scope.id,
      task_id: "col-a1b2c3d4.1",
      kind: "merge_gate",
      status: "running",
      head_sha: DEMO_SHA_B,
      error: null,
      evidence_json: null,
      started_at: DEMO_GATE_STARTED,
      finished_at: null,
    },
    {
      id: "run-impl-1",
      scope_id: scope.id,
      task_id: "col-a1b2c3d4.1",
      kind: "implement",
      status: "succeeded",
      model_id: "deepseek-v4-flash",
      head_sha: DEMO_SHA_B,
      error: null,
      trace_id: "demo-trace-run-impl-1",
      started_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
      finished_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    },
  ];
  const runEvents = [
    {
      id: 1,
      run_id: "run-gate-1",
      at: new Date(Date.now() - 11 * 1000).toISOString(),
      event: "tool_call",
      detail_json: JSON.stringify({ tool: "bash", isError: false }),
    },
    {
      id: 2,
      run_id: "run-gate-1",
      at: new Date(Date.now() - 6 * 1000).toISOString(),
      event: "tool_call",
      detail_json: JSON.stringify({ tool: "read", isError: false }),
    },
    {
      id: 3,
      run_id: "run-gate-1",
      at: new Date(Date.now() - 3 * 1000).toISOString(),
      event: "pi_model_fallback",
      detail_json: JSON.stringify({
        role: "developer",
        level: "warn",
        from: "deepseek-v4-flash",
        to: "mimo-v2.5-pro",
      }),
    },
  ];
  // The Running tab's rows navigate into their scope and select the task, so
  // those two scopes need real tasks offline — not just list entries.
  const [runningScope0, runningScope1] = generatedScopes;
  const runningTasks = [
    {
      id: `${runningScope0.id}.0`,
      scope_id: runningScope0.id,
      title: `Draft ${runningScope0.title.toLowerCase()}`,
      spec: "",
      state: "merged",
      state_version: 3,
      branch: `colony/${runningScope0.id}.0`,
      mr_iid: 40,
      attempt: 0,
      next_retry_at: null,
      blocked_reason: null,
      created_at: runningScope0.created_at,
      updated_at: runningScope0.updated_at,
    },
    {
      id: `${runningScope0.id}.1`,
      scope_id: runningScope0.id,
      title: `Land ${runningScope0.title.toLowerCase()}`,
      spec: "",
      state: "running",
      state_version: 2,
      branch: `colony/${runningScope0.id}.1`,
      mr_iid: null,
      attempt: 1,
      next_retry_at: null,
      blocked_reason: null,
      created_at: runningScope0.created_at,
      updated_at: new Date(now - 45 * 1000).toISOString(),
    },
  ];
  const mrOpenTask = {
    id: `${runningScope1.id}.0`,
    scope_id: runningScope1.id,
    title: `Land ${runningScope1.title.toLowerCase()}`,
    spec: "",
    state: "mr_open",
    state_version: 3,
    branch: `colony/${runningScope1.id}.0`,
    mr_iid: 41,
    attempt: 1,
    next_retry_at: null,
    blocked_reason: null,
    created_at: runningScope1.created_at,
    updated_at: runningScope1.updated_at,
  };
  const runningRun = {
    id: "run-demo-running-1",
    scope_id: runningScope0.id,
    task_id: runningTasks[1].id,
    kind: "implement",
    status: "running",
    model_id: "deepseek-v4-flash",
    head_sha: null,
    error: null,
    evidence_json: null,
    started_at: new Date(now - 45 * 1000).toISOString(),
    finished_at: null,
  };
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
        created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      },
      ...generatedScopes,
    ],
    running: [
      {
        scope_id: runningScope0.id,
        scope_title: runningScope0.title,
        task_id: runningTasks[1].id,
        task_title: runningTasks[1].title,
        task_state: runningTasks[1].state,
        attempt: runningTasks[1].attempt,
        run: runningRun,
      },
      {
        scope_id: runningScope1.id,
        scope_title: runningScope1.title,
        task_id: mrOpenTask.id,
        task_title: mrOpenTask.title,
        task_state: mrOpenTask.state,
        attempt: mrOpenTask.attempt,
        run: null,
      },
    ],
    detail: { scope, tasks, deps, runs },
    // Detail payloads for the Running tab's two scopes, so activating a row
    // offline lands on a sheet that actually contains the task.
    runningDetails: {
      [runningScope0.id]: {
        scope: runningScope0,
        tasks: runningTasks,
        deps: [],
        runs: [runningRun],
      },
      [runningScope1.id]: {
        scope: runningScope1,
        tasks: [mrOpenTask],
        deps: [],
        runs: [],
      },
    },
    runEvents,
    audit: [
      {
        id: 10,
        at: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
        actor: "human:op-1",
        action: "plan.replan_requested",
        detail_json: JSON.stringify({
          feedback:
            "Split the rollout check from the migration task and make the rollback path explicit.",
        }),
      },
      {
        id: 9,
        at: new Date(Date.now() - 12 * 1000).toISOString(),
        actor: "svc:colonyd",
        action: "run.start",
        detail_json: JSON.stringify({ kind: "merge_gate" }),
      },
      {
        id: 8,
        at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        actor: "agent:run-rev-1",
        action: "review.approved",
        detail_json: "{}",
      },
      {
        id: 7,
        at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        actor: "svc:colonyd",
        action: "mr.merged",
        detail_json: "{}",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function mutate(path, body) {
  state.confirm = null;
  try {
    await api(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    await refresh();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    paint();
  }
}

function openTaskInScope(scopeId, taskId) {
  state.pendingSelectTaskId = taskId;
  openScope(scopeId);
}

function openScope(id) {
  location.hash = `#/${id}`;
}

async function submitFeedback(event, path) {
  event.preventDefault();
  const feedback = String(
    new FormData(event.target).get("feedback") || "",
  ).trim();
  if (!feedback) return;
  await mutate(path, { feedback });
}

function selectTask(taskId) {
  state.selectedTaskId = taskId;
  state.drawerOpen = true;
  state.confirm = null;
  state.runEvents = null;
  paint();
  void refresh();
}

function closeDrawer() {
  state.drawerOpen = false;
  state.runEvents = null;
  paint();
}

function setConfirm(kind) {
  state.confirm = kind;
  paint();
}

function toggle(key) {
  state[key] = !state[key];
  paint();
}

/**
 * The list-query suffix that reveals archived projects. Demo mode must not
 * send it: the demo world has no archived projects and every extra query
 * parameter is a divergence from the API's default page.
 */
function archivedQuery() {
  return state.showArchived && !DEMO ? "&archived=1" : "";
}

/** Flip the archived-projects toggle; the 2.5s poll re-reads this state. */
function toggleShowArchived() {
  state.showArchived = !state.showArchived;
  // Hiding archived projects must not leave the old page's rows on screen
  // while the refetch is in flight: drop the page and refetch first, then
  // paint. Showing them keeps the current rows, so it repaints immediately.
  if (state.showArchived) {
    paint();
    void refresh();
    return;
  }
  state.projectsPage = null;
  void refresh();
}

function setProjectTab(tab) {
  state.projectTab = tab;
  state.briefOpen = false;
  const projectName = routeProjectName();
  if (projectName) {
    const newHash = serializeProjectTabHref(location.hash, projectName, tab);
    if (newHash !== location.hash) {
      history.replaceState(null, "", newHash);
    }
  }
  paint();
}

async function submitOpenScope(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const goal = String(data.get("goal") || "").trim();
  const title = String(data.get("title") || "").trim();
  const path = String(data.get("path") || "").trim();
  const approvals = String(data.get("approvals") || "auto");
  if (!goal || !path) return;
  // When the composer was opened from a project, the project is fixed: the
  // operator cannot silently change it.
  const project = resolveComposerProject(
    hashQueryProject(),
    data.get("project"),
  );
  try {
    const scope = await api("/scopes", {
      method: "POST",
      body: JSON.stringify({
        goal,
        ...(title ? { title } : {}),
        approvals,
        repo: { path },
        ...(project ? { project } : {}),
      }),
    });
    location.hash = `#/${scope.id}`;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    paint();
  }
}

async function saveProjectContext(value) {
  const page = state.projectPage;
  if (!page?.project) return;
  const doc = value.trim() ? value : null;
  state.projectContext = { doc: value, status: "saving" };
  paint();
  if (DEMO) {
    // Demo brief editing is purely local state, never a network write.
    demoContextStore.set(page.project.name, doc);
    page.project.context_doc = doc;
    state.projectContext = { doc: value, status: "saved" };
    paint();
    return;
  }
  try {
    await api(`/projects/${encodeURIComponent(page.project.name)}/context`, {
      method: "PUT",
      body: JSON.stringify({ context_doc: doc }),
    });
    // Keep the editor open with "Saved." status — matching the original
    // always-open save flow. The user closes it via Cancel.
    state.projectContext = { doc: value, status: "saved" };
    await refresh();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.projectContext = { doc: value, status: null };
    paint();
  }
}

async function submitNewProject(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const name = String(data.get("name") || "").trim();
  const context_doc = String(data.get("context_doc") || "").trim();
  if (!name) return;
  const payload = buildNewProjectPayload(name, context_doc);
  if (!payload) return;
  try {
    await api("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.newProjectDraft = null;
    location.hash = projectHref(name);
  } catch (err) {
    state.newProjectDraft = { name, context_doc };
    state.error = err instanceof Error ? err.message : String(err);
    paint();
  }
}

function setConfirmFile(fileId) {
  state.confirmFile = state.confirmFile === fileId ? null : fileId;
  paint();
}

function toggleReplaceFile(fileId) {
  state.replaceFileId = state.replaceFileId === fileId ? null : fileId;
  state.confirmFile = null;
  paint();
}

async function addProjectFile(event) {
  event.preventDefault();
  const page = state.filesPage;
  if (!page?.project) return;
  const data = new FormData(event.target);
  const filename = String(data.get("filename") || "").trim();
  const media_type = String(data.get("media_type") || "").trim();
  const content = String(data.get("content") || "");
  if (!filename || !media_type) return;
  if (DEMO) {
    const files = demoFileStore.get(page.project.name) ?? [];
    demoFileStore.set(page.project.name, [
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
    await refresh();
    return;
  }
  try {
    await api(`/projects/${encodeURIComponent(page.project.name)}/files`, {
      method: "POST",
      body: JSON.stringify({ filename, media_type, content }),
    });
    await refresh();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    paint();
  }
}

async function replaceProjectFile(event, fileId) {
  event.preventDefault();
  const page = state.filesPage;
  if (!page?.project) return;
  const data = new FormData(event.target);
  const media_type = String(data.get("media_type") || "").trim();
  const content = String(data.get("content") || "");
  if (DEMO) {
    const files = demoFileStore.get(page.project.name) ?? [];
    demoFileStore.set(
      page.project.name,
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
    state.replaceFileId = null;
    await refresh();
    return;
  }
  try {
    await api(
      `/projects/${encodeURIComponent(page.project.name)}/files/${encodeURIComponent(fileId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ media_type, content }),
      },
    );
    state.replaceFileId = null;
    await refresh();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    paint();
  }
}

async function deleteProjectFile(fileId) {
  const page = state.filesPage;
  if (!page?.project) return;
  if (DEMO) {
    demoFileStore.set(
      page.project.name,
      (demoFileStore.get(page.project.name) ?? []).filter(
        (f) => f.id !== fileId,
      ),
    );
    state.confirmFile = null;
    await refresh();
    return;
  }
  try {
    await api(
      `/projects/${encodeURIComponent(page.project.name)}/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
    );
    state.confirmFile = null;
    await refresh();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    paint();
  }
}

async function submitActor(event) {
  event.preventDefault();
  const actor = String(new FormData(event.target).get("actor") || "").trim();
  if (!actor) return;
  state.actor = actor;
  localStorage.setItem(ACTOR_KEY, actor);
  await refresh();
}

function saveActor(event) {
  const actor = event.target.value.trim();
  if (actor && actor !== state.actor) {
    state.actor = actor;
    localStorage.setItem(ACTOR_KEY, actor);
  }
}

// ---------------------------------------------------------------------------
// Task graph
// ---------------------------------------------------------------------------

function layoutDag(nodes, edges) {
  const ids = nodes.map((node) => node.id);
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (incoming.has(edge.task_id)) {
      incoming.get(edge.task_id).push(edge.depends_on_task_id);
    }
  }
  const level = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const preds = (incoming.get(id) || []).filter((pred) => ids.includes(pred));
    const depth = preds.length ? Math.max(...preds.map(depthOf)) + 1 : 0;
    visiting.delete(id);
    level.set(id, depth);
    return depth;
  };
  ids.forEach(depthOf);
  const columns = [];
  for (const id of ids) {
    const depth = level.get(id) || 0;
    (columns[depth] ||= []).push(id);
  }
  const colW = 264;
  const rowH = 96;
  const padX = 16;
  const padY = 16;
  const w = 224;
  const h = 76;
  const pos = new Map();
  columns.forEach((column, x) => {
    column.forEach((id, y) => {
      pos.set(id, { x: padX + x * colW, y: padY + y * rowH, w, h });
    });
  });
  const width = padX * 2 + Math.max(columns.length, 1) * colW - (colW - w);
  const height =
    padY * 2 + Math.max(1, ...columns.map((column) => column.length)) * rowH;
  return { pos, width, height };
}

function graphModel(detail) {
  if (!detail) return { nodes: [], edges: [] };
  if (detail.tasks.length) {
    return {
      nodes: detail.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        proposed: false,
      })),
      edges: detail.deps,
    };
  }
  const plan = parsePlan(detail.scope.plan_json);
  if (!plan) return { nodes: [], edges: [] };
  return {
    nodes: plan.tasks.map((task, index) => ({
      id: `plan:${index}`,
      title: task.title,
      state: "queued",
      proposed: true,
    })),
    edges: plan.tasks.flatMap((task, index) =>
      (task.depends_on || []).map((dep) => ({
        task_id: `plan:${index}`,
        depends_on_task_id: `plan:${dep}`,
      })),
    ),
  };
}

function liveRunFor(detail, taskId) {
  return (detail?.runs || []).find(
    (run) => run.status === "running" && run.task_id === taskId,
  );
}

function nodeKeydown(event, id) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  selectTask(id);
}

function renderDag(detail) {
  const { nodes, edges } = graphModel(detail);
  if (!nodes.length) {
    const runningPlan = (detail?.runs || []).some(
      (run) => run.kind === "architect" && run.status === "running",
    );
    return html`<p class="note">
      ${runningPlan
        ? "Architect is drawing the plan."
        : "No tasks on this sheet yet."}
    </p>`;
  }
  const { pos, width, height } = layoutDag(nodes, edges);
  const edgeMarkup = repeat(
    edges,
    (edge) => `${edge.depends_on_task_id}->${edge.task_id}`,
    (edge) => {
      const from = pos.get(edge.depends_on_task_id);
      const to = pos.get(edge.task_id);
      if (!from || !to) return svg``;
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x - 3;
      const y2 = to.y + to.h / 2;
      const c = Math.max(30, (x2 - x1) * 0.45);
      return svg`<path class="edge" marker-end="url(#arrow)"
        d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}" />`;
    },
  );
  const nodeMarkup = repeat(
    nodes,
    (node) => node.id,
    (node) => {
      const box = pos.get(node.id);
      const live = liveRunFor(detail, node.id);
      const selected = state.selectedTaskId === node.id && state.drawerOpen;
      const tail = node.id.slice(
        node.id.lastIndexOf(node.proposed ? ":" : ".") + 1,
      );
      return svg`<g
        class=${classMap({
          "g-node": true,
          node: true,
          "is-selected": selected,
          "is-live": Boolean(live),
        })}
        data-state=${node.state}>
        <rect class=${classMap({ "node-box": true, "is-proposed": node.proposed })}
          x=${box.x} y=${box.y} width=${box.w} height=${box.h} />
        <rect class="node-bar" x=${box.x + 5} y=${box.y + 5} width="3" height=${box.h - 10} />
        <foreignObject x=${box.x} y=${box.y} width=${box.w} height=${box.h}>
          <div class="node-html" xmlns="http://www.w3.org/1999/xhtml">
            <span class="ntitle">${node.title}</span>
            <span class="nstate"
              >${node.state}${
                live
                  ? ` · ${KIND_LABEL[live.kind] || live.kind}${(() => {
                      const ms = runDurationMs(live, Date.now());
                      return ms === null ? "" : ` ${formatDuration(ms)}`;
                    })()}`
                  : ""
              }<span class="nid">#${tail}</span></span
            >
          </div>
        </foreignObject>
        <rect class="node-hit" tabindex="0" role="button"
          aria-label=${node.title}
          x=${box.x} y=${box.y} width=${box.w} height=${box.h}
          @click=${() => selectTask(node.id)}
          @keydown=${(event) => nodeKeydown(event, node.id)} />
      </g>`;
    },
  );
  return html`<svg
    class="dag"
    width=${width}
    height=${height}
    viewBox="0 0 ${width} ${height}"
    role="img"
    aria-label="Task dependency graph"
  >
    <defs>
      <marker
        id="arrow"
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="6.5"
        markerHeight="6.5"
        orient="auto-start-reverse"
      >
        <path class="edge-head" d="M0,0 L8,4 L0,8 z" />
      </marker>
    </defs>
    ${edgeMarkup}${nodeMarkup}
  </svg>`;
}

/**
 * Select a task once its scope detail holds it. A Running-tab row navigates
 * before the sheet's detail is loaded, so the selection waits here rather
 * than being dropped: the sheet's selectedTask(detail) only finds tasks that
 * are present.
 */
function consumePendingTaskSelection(detail) {
  const taskId = state.pendingSelectTaskId;
  if (!taskId || !detail) return;
  if (!taskSelectionExists(detail, taskId)) return;
  state.pendingSelectTaskId = null;
  state.selectedTaskId = taskId;
  state.drawerOpen = true;
  state.confirm = null;
  state.runEvents = null;
}

function taskSelectionExists(detail, taskId) {
  if (taskId.startsWith("plan:")) {
    const index = Number(taskId.slice(5));
    const plan = parsePlan(detail.scope.plan_json);
    return Number.isInteger(index) && Boolean(plan?.tasks?.[index]);
  }
  return detail.tasks.some((task) => task.id === taskId);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function selectedTask(detail) {
  if (!detail || !state.selectedTaskId) return null;
  return detail.tasks.find((task) => task.id === state.selectedTaskId) || null;
}

function runsForTask(detail, taskId) {
  return (detail.runs || []).filter((run) => run.task_id === taskId);
}

function renderRuns(detail, task) {
  const rows = runsForTask(detail, task.id);
  if (!rows.length) {
    return html`<p class="note">No runs on this task yet.</p>`;
  }
  const latestLive = [...rows]
    .reverse()
    .find((run) => run.status === "running");
  return repeat(
    rows,
    (run) => run.id,
    (run) =>
      html`${runLine(run)}${run === latestLive ? renderRunLog(run) : nothing}`,
  );
}

function renderRunLog(run) {
  return renderFeedLog(state.runEvents, run);
}

function renderScopeRunLog(run) {
  return renderFeedLog(state.scopeRunEvents, run);
}

function renderFeedLog(feed, run) {
  if (!feed || feed.runId !== run.id) return nothing;
  if (!feed.rows.length) {
    return html`<p class="note runlog-empty">No agent activity yet.</p>`;
  }
  const lines = repeat(
    feed.rows.slice(-40),
    (row) => row.id,
    (row) => {
      let detail = "";
      try {
        const d = JSON.parse(row.detail_json);
        if (row.event === "pi_model_fallback" && d.from && d.to) {
          detail = `${d.from} → ${d.to}`;
        } else if (typeof d.phase === "string" && d.phase) {
          detail = d.phase;
        } else {
          detail = [d.tool, d.isError ? "error" : ""]
            .filter(Boolean)
            .join(" · ");
        }
      } catch {
        detail = "";
      }
      return html`<li>
        <span class="when">${rel(row.at)}</span>
        <span class="ev">${row.event}</span>
        ${detail ? html`<span class="evd">${detail}</span>` : nothing}
      </li>`;
    },
  );
  return html`<ul class="runlog">
    ${lines}
  </ul>`;
}

function runLine(run) {
  const traceUrl = traceHref(state.config, run);
  const evidence = parseEvidence(run.evidence_json);
  const findings = Array.isArray(evidence?.findings)
    ? html`<ul class="findings">
        ${evidence.findings.map(
          (finding) =>
            html`<li>
              ${finding.severity} —
              ${finding.note}${finding.file ? ` (${finding.file})` : ""}
            </li>`,
        )}
      </ul>`
    : nothing;
  const verdict = evidence?.verdict ? ` · ${evidence.verdict}` : "";
  const ms = runDurationMs(run, Date.now());
  const dur =
    ms === null
      ? html`<span class="dur">—</span>`
      : html`<time
          class="dur"
          datetime=${isoDuration(ms)}
          title=${`started ${run.started_at}${run.finished_at ? `, finished ${run.finished_at}` : ""}`}
          aria-label=${durationAriaLabel(run, Date.now())}
          >${formatDuration(ms)}</time
        >`;
  return html`<div class="run" data-status=${run.status}>
    <i></i>
    <div>
      <p class="kind">
        ${KIND_LABEL[run.kind] || run.kind} ${run.status}${verdict}
      </p>
      <p class="meta">
        ${run.model_id ? `${run.model_id} · ` : ""} ${shortSha(run.head_sha)} ·
        ${rel(run.finished_at || run.started_at)} ·
        ${dur}${run.error ? ` · ${run.error}` : ""}
      </p>
      ${traceUrl
        ? html`<a
            class="run-trace"
            href=${traceUrl}
            target="_blank"
            rel="noopener"
            >Trace</a
          >`
        : nothing}
      ${findings}
    </div>
  </div>`;
}

function taskActionButtons(task) {
  const buttons = [];
  if (task?.state === "blocked") {
    buttons.push(
      html`<button
        class="btn btn-solid"
        @click=${() => mutate(`/tasks/${task.id}/unblock`)}
      >
        Unblock
      </button>`,
    );
  }
  if (
    task?.state === "mr_open" &&
    state.detail?.scope?.approvals === "manual"
  ) {
    buttons.push(
      task.merge_approved_sha
        ? html`<button class="btn" disabled>
            Merge approved — gate pending
          </button>`
        : state.confirm === "merge"
          ? html`<button
              class="btn btn-solid"
              @click=${() => mutate(`/tasks/${task.id}/approve-merge`)}
            >
              Confirm merge approval
            </button>`
          : html`<button
              class="btn btn-solid"
              @click=${() => setConfirm("merge")}
            >
              Approve merge
            </button>`,
    );
  }
  if (task?.state === "running") {
    buttons.push(
      state.confirm === "stop"
        ? html`<button
            class="btn btn-solid"
            @click=${() => mutate(`/tasks/${task.id}/stop`)}
          >
            Confirm stop and retry
          </button>`
        : html`<button class="btn" @click=${() => setConfirm("stop")}>
            Stop run and retry
          </button>`,
    );
  }
  if (task?.state === "canceled") {
    buttons.push(
      html`<button
        class="btn btn-solid"
        @click=${() => mutate(`/tasks/${task.id}/restore`)}
      >
        Restore task
      </button>`,
    );
  }
  const waiting =
    task?.state === "queued" &&
    task.next_retry_at &&
    Date.parse(task.next_retry_at) > Date.now();
  if (waiting) {
    buttons.push(
      html`<button
        class="btn"
        @click=${() => mutate(`/tasks/${task.id}/retry`)}
      >
        Run now — skip backoff
      </button>`,
    );
  }
  if (task && !["merged", "canceled"].includes(task.state)) {
    buttons.push(
      state.confirm === "cancel"
        ? html`<button
            class="btn btn-rev"
            @click=${() => mutate(`/tasks/${task.id}/cancel`)}
          >
            Confirm permanent cancel
          </button>`
        : html`<button
            class="btn btn-quiet"
            @click=${() => setConfirm("cancel")}
          >
            Cancel task permanently
          </button>`,
    );
  }
  return buttons.length
    ? html`<div class="task-actions">${buttons}</div>`
    : nothing;
}

function abandonButton(scope) {
  if (!scope || ["done", "abandoned"].includes(scope.status)) return nothing;
  return state.confirm === "abandon"
    ? html`<button
        class="btn btn-rev"
        @click=${() => mutate(`/scopes/${scope.id}/abandon`)}
      >
        Confirm abandon
      </button>`
    : html`<button class="btn btn-quiet" @click=${() => setConfirm("abandon")}>
        Abandon scope
      </button>`;
}

/**
 * Archived projects are read-only: the only action is Unarchive, and it
 * needs no confirm step (it restores, it does not destroy).
 */
function unarchiveButton(projectName) {
  return html`<button
    class="btn"
    @click=${() =>
      mutate(`/projects/${encodeURIComponent(projectName)}/unarchive`)}
  >
    Unarchive
  </button>`;
}

/** Going the other way hides the project, so it stays behind a confirm. */
function archiveButton(projectName) {
  return state.confirm === "archive"
    ? html`<button
        class="btn btn-rev"
        @click=${() =>
          mutate(`/projects/${encodeURIComponent(projectName)}/archive`)}
      >
        Confirm archive
      </button>`
    : html`<button class="btn btn-quiet" @click=${() => setConfirm("archive")}>
        Archive project
      </button>`;
}

function renderTopbar() {
  const id = routeScopeId();
  const scopeProject = id ? state.detail?.scope?.project_name || null : null;
  const account = state.oidc
    ? state.auth
      ? html`<div class="sign account">
          <span class="whoami mono">${state.auth.username}</span>
          <button class="btn btn-quiet" @click=${signOut}>Sign out</button>
        </div>`
      : html`<div class="sign"></div>`
    : html`<form class="sign" @submit=${submitActor}>
        <label>
          <span>Operator</span>
          <input
            name="actor"
            .value=${live(state.actor)}
            spellcheck="false"
            @change=${saveActor}
          />
        </label>
      </form>`;
  return html`<header class="topbar">
    <a class="brand" href="#/">${BRAND_MARK}<span>COLONY</span></a>
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="#/">Projects</a>
      ${routeProjectName()
        ? html`<span class="crumb-sep">/</span>
            <a class="crumb" href=${projectHref(routeProjectName())}
              >${routeProjectName()}</a
            >`
        : nothing}
      ${routeIsNew()
        ? html`<span class="crumb-sep">/</span>
            <span class="crumb">new scope</span>`
        : nothing}
      ${routeIsNewProject()
        ? html`<span class="crumb-sep">/</span>
            <span class="crumb">new project</span>`
        : nothing}
      ${routeIsManageFiles()
        ? html`<span class="crumb-sep">/</span>
            <a class="crumb" href=${projectHref(routeProjectFilesName())}
              >${routeProjectFilesName()}</a
            >
            <span class="crumb-sep">/</span>
            <span class="crumb">files</span>`
        : nothing}
      ${scopeProject
        ? html`<span class="crumb-sep">/</span>
            <a class="crumb" href=${projectHref(scopeProject)}
              >${scopeProject}</a
            >`
        : nothing}
      ${id
        ? html`<span class="crumb-sep">/</span>
            <span class="crumb mono">${id}</span>`
        : nothing}
    </nav>
    ${account}
  </header>`;
}

function renderSignin() {
  return html`<div class="signin">
    <div class="card signin-card">
      <p class="signin-brand">${BRAND_MARK}COLONY</p>
      <p class="note">
        Sign in with your aether account to operate the factory.
      </p>
      ${state.error
        ? html`<div class="banner banner-error" role="alert">
            ${state.error}
          </div>`
        : nothing}
      <button class="btn btn-solid" @click=${() => void beginLogin()}>
        Sign in
      </button>
    </div>
  </div>`;
}

const PAGE_SIZE = 25;

function scopeCard(scope) {
  return html`<button class="scope-card" @click=${() => openScope(scope.id)}>
    <span class="scope-top">
      <span class="chip" data-kind=${scope.status}>${scope.status}</span>
      <span class="scope-time">${rel(scope.updated_at)}</span>
    </span>
    <span class="scope-goal">${scopeTitle(scope)}</span>
    <span class="scope-meta">
      <span class="mono">${scope.id}</span>
      <span>${scope.provider_repo_path}</span>
      ${scope.project_name
        ? html`<a
            class="scope-project"
            href=${projectHref(scope.project_name)}
            @click=${(event) => event.stopPropagation()}
            >${scope.project_name}</a
          >`
        : nothing}
    </span>
  </button>`;
}

function projectCard(project) {
  const counts = project.status_counts ?? {};
  const chips = Object.entries(counts).filter(([, n]) => n > 0);
  const fileCount = project.file_count ?? 0;
  const repoSummary = repoSummaryText(project.repositories);
  return html`<a
    class="project-card project-row"
    href=${projectHref(project.name)}
  >
    <span class="project-card-name">${project.name}</span>
    <span class="project-card-meta">
      <span class="mono"
        >${project.scope_count}
        scope${project.scope_count === 1 ? "" : "s"}</span
      >
      ${chips.length
        ? chips.map(
            ([status, count]) =>
              html`<span class="chip" data-kind=${status}
                >${status} ${count}</span
              >`,
          )
        : nothing}
      <span class="mono">${rel(project.last_activity_at)}</span>
    </span>
    <span class="project-card-repos">${repoSummary}</span>
    <span class="project-card-knowledge"
      >${knowledgeText(project.context_doc, fileCount)}</span
    >
  </a>`;
}

/**
 * Read-only row for an archived project. The name is not a link target of
 * its own — the row's only actions are View project (scopes stay visible
 * through history) and Unarchive.
 */
function archivedProjectRow(project) {
  return html`<div class="project-card project-row is-archived">
    <span class="project-card-name">${project.name}</span>
    <span class="project-card-meta">
      <span class="chip" data-kind="archived">Archived</span>
      <span class="mono">${rel(project.archived_at)}</span>
      <span class="mono"
        >${project.scope_count}
        scope${project.scope_count === 1 ? "" : "s"}</span
      >
      <a class="project-card-link" href=${projectHref(project.name)}
        >View project</a
      >
    </span>
    <button
      class="btn btn-quiet"
      @click=${() =>
        mutate(`/projects/${encodeURIComponent(project.name)}/unarchive`)}
    >
      Unarchive
    </button>
  </div>`;
}

function renderPager({ base, page, total, items, label }) {
  if (total <= PAGE_SIZE) return nothing;
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min((page - 1) * PAGE_SIZE + items, total);
  return html`<nav class="board-pager" aria-label=${label}>
    <a class="btn btn-quiet" href=${hrefForPage(base, Math.max(1, page - 1))}>
      Previous
    </a>
    <span class="pager-range mono">${from}–${to} of ${total}</span>
    <a
      class="btn btn-quiet"
      href=${hrefForPage(base, Math.min(pageCount(total, PAGE_SIZE), page + 1))}
    >
      Next
    </a>
  </nav>`;
}

function renderProjectList() {
  const page = state.projectsPage;
  const pageRows = page?.projects ?? [];
  // The default fetch never returns archived projects, but a toggle flip
  // repaints before its refetch lands — partition so the two never cross.
  const rows = pageRows.filter((project) => !project.archived_at);
  const archived = pageRows.filter((project) => project.archived_at);
  const total = page?.total ?? 0;
  const items = rows.length;
  const pageNo = page?.page ?? 1;
  const base = "#/";
  return html`
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    <div class="project-index board" id="draw">
      <div class="board-head">
        <h1 class="board-title">Projects</h1>
        <div class="board-head-actions">
          <button
            class="btn btn-quiet"
            aria-pressed=${state.showArchived}
            @click=${toggleShowArchived}
          >
            ${state.showArchived ? "Hide archived" : "Show archived"}
          </button>
          <a class="btn btn-solid" href="#/new-project">New project</a>
        </div>
      </div>
      ${total === 0
        ? html`<div class="rack-empty">
            <p>No projects yet</p>
            <a class="btn btn-solid" href="#/new-project">New project</a>
          </div>`
        : items === 0 && archived.length === 0
          ? html`<div class="rack-empty">
              <p>Past the last page.</p>
              <a class="btn btn-solid" href=${hrefForPage(base, 1)}
                >Back to page 1</a
              >
            </div>`
          : nothing}
      ${items
        ? html`<div class="project-cards">
            ${repeat(rows, (project) => project.name, projectCard)}
          </div>`
        : nothing}
      ${state.showArchived && archived.length
        ? html`<section class="archived-section">
            <p class="archived-head">Archived</p>
            <div class="project-cards">
              ${repeat(archived, (project) => project.name, archivedProjectRow)}
            </div>
          </section>`
        : nothing}
      ${renderPager({
        base,
        page: pageNo,
        total,
        items,
        label: "Project pages",
      })}
    </div>
  `;
}

function renderRunningRow(entry) {
  const row = deriveRunningRow(entry);
  const nowMs = Date.now();
  const runMs = row.hasRun && row.run ? runDurationMs(row.run, nowMs) : null;
  const durationLabel =
    row.hasRun && row.run ? durationAriaLabel(row.run, nowMs) : undefined;
  const durationText = runMs !== null ? formatDuration(runMs) : "—";
  const durationIso = runMs !== null ? isoDuration(runMs) : undefined;
  const runKind = row.runKind ? (KIND_LABEL[row.runKind] ?? row.runKind) : "";
  const runInfo = [runKind, row.runModel].filter(Boolean).join(" · ");

  return html`
    <div
      class="running-row"
      tabindex="0"
      role="button"
      @click=${() => openTaskInScope(row.scopeId, row.taskId)}
      @keydown=${(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTaskInScope(row.scopeId, row.taskId);
        }
      }}
    >
      <div class="running-main">
        <span
          class="scope-chip mono"
          @click=${(e) => {
            e.stopPropagation();
            openScope(row.scopeId);
          }}
          >${row.scopeTitle}</span
        >
        <span class="running-task-title">${row.taskTitle}</span>
      </div>
      <div class="running-meta">
        <span class="badge" data-state=${row.taskState}>${row.taskState}</span>
        <span class="running-attempt mono">${row.attemptText}</span>
        ${runInfo
          ? html`<span class="running-run-info">${runInfo}</span>`
          : nothing}
        <span
          class=${classMap({
            "running-duration": true,
            mono: true,
            live: row.isRunning,
          })}
          aria-label=${durationLabel || nothing}
          title=${durationIso || nothing}
          >${durationText}</span
        >
      </div>
    </div>
  `;
}

function renderRunningTab() {
  const page = state.projectPage;
  const list = state.projectRunning ?? [];
  if (!list.length) {
    const counts = page?.project?.task_state_counts;
    const tallies = formatRunningEmptyTallies(counts);
    return html`<div class="running-empty rack-empty">
      <p>Nothing running right now.</p>
      ${tallies
        ? html`<p class="running-tallies mono">${tallies}</p>`
        : nothing}
    </div>`;
  }
  return html`<div class="running-list">
    ${repeat(
      list,
      (entry) => `${entry.scope_id}:${entry.task_id}`,
      renderRunningRow,
    )}
  </div>`;
}

function renderProjectPage() {
  const page = state.projectPage;
  if (!page?.name) return renderProjectList();
  if (!page.project) {
    return html`<div class="project-page" id="draw">
      <p class="rack-empty">
        No project named “${page.name}” — scopes group under a project once one
        of them names it.
      </p>
    </div>`;
  }
  const counts = page.project.status_counts ?? {};
  const chips = Object.entries(counts).filter(([, n]) => n > 0);
  const base = projectHref(page.project.name);
  const scopes = page.scopes ?? [];
  const description = projectDescription(page.project.context_doc);
  const tab = state.projectTab;
  const archivedAt = page.project.archived_at ?? null;
  return html`
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    <div class="project-page" id="draw">
      ${archivedAt
        ? html`<div class="banner banner-archived" role="status">
            Archived ${rel(archivedAt)}
          </div>`
        : nothing}
      <header class="board-head">
        <h1 class="board-title">${page.project.name}</h1>
        <div class="board-head-actions">
          ${archivedAt
            ? unarchiveButton(page.project.name)
            : html`${archiveButton(page.project.name)}
                <a
                  class="btn btn-solid"
                  href=${`#/new?project=${encodeURIComponent(page.project.name)}`}
                  >New scope</a
                >`}
        </div>
      </header>
      ${description
        ? html`<p class="project-desc">${description}</p>`
        : nothing}
      <p class="project-meta mono">
        <span
          >${page.project.scope_count}
          scope${page.project.scope_count === 1 ? "" : "s"}</span
        >
        updated ${rel(page.project.updated_at)}
      </p>
      ${chips.length
        ? html`<p class="project-counts">
            ${chips.map(
              ([status, count]) =>
                html`<span class="chip" data-kind=${status}
                  >${status} ${count}</span
                >`,
            )}
          </p>`
        : nothing}
      <nav class="tabs" role="tablist" aria-label="Project sections">
        ${[
          ["scopes", "Scopes"],
          ["running", "Running"],
          ["settings", "Settings"],
        ].map(
          ([id, label]) =>
            html`<button
              class="tab"
              role="tab"
              aria-selected=${tab === id}
              @click=${() => setProjectTab(id)}
            >
              ${label}
            </button>`,
        )}
      </nav>
      ${tab === "settings"
        ? html`<div class="project-settings">${renderProjectRail()}</div>`
        : tab === "running"
          ? html`<section class="project-running">
              ${renderRunningTab()}
            </section>`
          : html`<section class="project-scopes">
              ${page.total > 0 && scopes.length === 0
                ? html`<div class="rack-empty">
                    <p>Past the last page.</p>
                    <a class="btn btn-solid" href=${hrefForPage(base, 1)}
                      >Back to page 1</a
                    >
                    <a class="btn btn-quiet" href="#/">All projects</a>
                  </div>`
                : scopes.length
                  ? html`<div class="rack">
                      ${repeat(scopes, (scope) => scope.id, scopeCard)}
                    </div>`
                  : html`<p class="rack-empty">
                      No scopes in this project yet.
                    </p>`}
              ${renderPager({
                base,
                page: page.page,
                total: page.total,
                items: scopes.length,
                label: "Project scope pages",
              })}
            </section>`}
    </div>
  `;
}

function renderProjectRail() {
  const page = state.projectPage;
  if (!page?.project) return nothing;
  const project = page.project;
  const files = state.projectFiles ?? [];
  const repos = distinctRepos(project.repositories);
  return html`${renderProjectContextCard()}
    <aside class="card">
      <p class="card-head">Connected repositories</p>
      <div class="card-body">
        ${repos.length
          ? html`<ul class="repo-list">
              ${repos.map(
                (repo) =>
                  html`<li>
                    <a href=${gitlabRepoUrl(repo.repo_path)}
                      >${repo.repo_path}</a
                    >
                  </li>`,
              )}
            </ul>`
          : html`<p class="note">No connected repositories</p>`}
      </div>
    </aside>`;
}

function renderProjectContextCard() {
  const page = state.projectPage;
  if (!page?.project) return nothing;
  const project = page.project;
  const saved = state.projectContext;
  const storedDoc = project.context_doc ?? "";
  const doc = saved === null ? storedDoc : saved.doc;
  const files = state.projectFiles ?? [];
  const editing = state.briefOpen;
  return html`<aside class="card">
    <p class="card-head">
      Project knowledge
      ${!editing
        ? html`<button
            class="btn btn-quiet"
            @click=${() => toggle("briefOpen")}
          >
            ${doc ? "Edit brief" : "Add brief"}
          </button>`
        : nothing}
    </p>
    <div class="card-body">
      ${editing
        ? html`<form
            class="project-context"
            @submit=${(event) => {
              event.preventDefault();
              void saveProjectContext(
                String(new FormData(event.target).get("project-context") ?? ""),
              );
            }}
          >
            <textarea
              name="project-context"
              class="mono"
              placeholder="Background every agent packet in this project carries: architecture notes, conventions, constraints."
              .value=${live(doc)}
            ></textarea>
            <div class="pc-actions">
              <button class="btn" type="submit">Save context</button>
              <button
                class="btn btn-quiet"
                type="button"
                @click=${() => toggle("briefOpen")}
              >
                Cancel
              </button>
              ${saved?.status === "saving"
                ? html`<span class="pc-status">Saving…</span>`
                : saved?.status === "saved"
                  ? html`<span class="pc-status is-saved">Saved.</span>`
                  : nothing}
            </div>
          </form>`
        : doc
          ? html`<div class="knowledge-preview md">${mdFragment(doc)}</div>`
          : html`<p class="note">No brief yet.</p>`}
      ${files.length
        ? html`<ul class="file-list">
            ${files.map(
              (file) =>
                html`<li>
                  <span class="mono">${file.filename}</span>
                  <span>${file.media_type}</span>
                  <span class="mono">${file.byte_size} B</span>
                </li>`,
            )}
          </ul>`
        : nothing}
      <a
        class="btn btn-quiet"
        href=${`#/project/${encodeURIComponent(project.name)}/files`}
        >Manage files</a
      >
    </div>
  </aside>`;
}

function renderNewProject() {
  return html`
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    <div class="create" id="draw">
      <aside class="card create-card">
        <p class="card-head">New project</p>
        <div class="card-body">
          <form class="composer" @submit=${submitNewProject}>
            <label class="field">
              <span>Name</span>
              <input
                name="name"
                required
                maxlength="120"
                placeholder="Project name"
                autocomplete="off"
                .value=${live(state.newProjectDraft?.name ?? "")}
              />
            </label>
            <label class="field">
              <span>Brief <em>optional Markdown</em></span>
              <textarea
                name="context_doc"
                rows="10"
                placeholder="Background every agent packet in this project carries: architecture notes, conventions, constraints."
                .value=${live(state.newProjectDraft?.context_doc ?? "")}
              ></textarea>
            </label>
            <div class="create-actions">
              <button class="btn btn-solid" type="submit">
                Create project
              </button>
              <a class="btn btn-quiet" href="#/">Cancel</a>
            </div>
          </form>
        </div>
      </aside>
    </div>
  `;
}

function renderManageFiles() {
  const page = state.filesPage;
  if (!page?.name) return renderProjectList();
  if (!page.project) {
    return html`<div class="project-page" id="draw">
      <p class="rack-empty">
        No project named “${page.name}” — scopes group under a project once one
        of them names it.
      </p>
    </div>`;
  }
  const files = page.files ?? [];
  const base = `#/project/${encodeURIComponent(page.project.name)}/files`;
  return html`
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    <div class="project-page" id="draw">
      <header class="board-head">
        <h1 class="board-title">${page.project.name} · files</h1>
        <a class="btn btn-quiet" href=${projectHref(page.project.name)}
          >Back to project</a
        >
      </header>
      <section class="project-files">
        ${page.total > 0 && files.length === 0
          ? html`<div class="rack-empty">
              <p>Past the last page.</p>
              <a class="btn btn-solid" href=${hrefForPage(base, 1)}
                >Back to page 1</a
              >
            </div>`
          : files.length
            ? repeat(files, (file) => file.id, fileRow)
            : html`<p class="rack-empty">No reference files yet.</p>`}
      </section>
      ${renderPager({
        base,
        page: page.page,
        total: page.total,
        items: files.length,
        label: "Project file pages",
      })}
      <aside class="card">
        <p class="card-head">Add a file</p>
        <div class="card-body">
          <form class="composer" @submit=${addProjectFile}>
            <label class="field">
              <span>Filename</span>
              <input
                name="filename"
                required
                maxlength="255"
                placeholder="AGENTS.md"
                autocomplete="off"
              />
            </label>
            <label class="field">
              <span>Media type</span>
              <select name="media_type">
                <option value="text/plain">text/plain</option>
                <option value="text/markdown">text/markdown</option>
              </select>
            </label>
            <label class="field">
              <span>Content</span>
              <textarea name="content" rows="10"></textarea>
            </label>
            <div class="create-actions">
              <button class="btn btn-solid" type="submit">Add file</button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  `;
}

function fileRow(file) {
  const replacing = state.replaceFileId === file.id;
  return html`<div class="file-row">
    <div class="file-row-main">
      <span class="file-row-name">${file.filename}</span>
      <span class="file-row-meta mono"
        >${file.media_type} · ${file.byte_size} bytes</span
      >
    </div>
    <div class="create-actions">
      ${state.confirmFile === file.id
        ? html`<button
            class="btn btn-rev"
            @click=${() => deleteProjectFile(file.id)}
          >
            Confirm delete
          </button>`
        : html`<button
            class="btn btn-quiet"
            @click=${() => setConfirmFile(file.id)}
          >
            Delete
          </button>`}
      <button class="btn btn-quiet" @click=${() => toggleReplaceFile(file.id)}>
        ${replacing ? "Cancel replace" : "Replace"}
      </button>
    </div>
    ${replacing
      ? html`<form
          class="composer"
          @submit=${(event) => replaceProjectFile(event, file.id)}
        >
          <label class="field">
            <span>Media type</span>
            <select name="media_type">
              <option
                value="text/plain"
                ?selected=${file.media_type === "text/plain"}
              >
                text/plain
              </option>
              <option
                value="text/markdown"
                ?selected=${file.media_type === "text/markdown"}
              >
                text/markdown
              </option>
            </select>
          </label>
          <label class="field">
            <span>Content</span>
            <textarea name="content" rows="8"></textarea>
          </label>
          <div class="create-actions">
            <button class="btn" type="submit">Replace file</button>
          </div>
        </form>`
      : nothing}
  </div>`;
}

function renderCreate() {
  const fixedProject = hashQueryProject();
  return html`
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    <div class="create" id="draw">
      <aside class="card create-card">
        <p class="card-head">Open a scope</p>
        <div class="card-body">
          <form class="composer" @submit=${submitOpenScope}>
            <p class="composer-hint">
              Colony plans the work, opens merge requests, and merges what
              passes. Write the goal like a brief for an engineer who cannot ask
              questions: outcomes, constraints, and what done looks like.
            </p>
            ${fixedProject
              ? html`<p class="composer-fixed">
                  Project:
                  <a href=${projectHref(fixedProject)}>${fixedProject}</a>
                </p>`
              : html`<label class="field">
                  <span>Project <em>optional</em></span>
                  <input
                    name="project"
                    maxlength="120"
                    placeholder="Project this scope belongs to"
                    autocomplete="off"
                  />
                </label>`}
            <label class="field">
              <span>Title</span>
              <input
                name="title"
                required
                maxlength="120"
                placeholder="Short label for the board"
                autocomplete="off"
              />
            </label>
            <label class="field">
              <span>Goal</span>
              <textarea
                name="goal"
                required
                rows="12"
                placeholder="What should the factory build?"
              ></textarea>
            </label>
            <label class="field">
              <span>GitLab repo path</span>
              <input
                name="path"
                required
                placeholder="so/my-repo"
                autocomplete="off"
              />
            </label>
            <label class="field">
              <span>Approvals</span>
              <select name="approvals">
                <option value="manual">
                  Manual — you approve the plan and every merge
                </option>
                <option value="auto">
                  Automatic — plan and merges run unattended
                </option>
              </select>
            </label>
            <div class="create-actions">
              <button class="btn btn-solid" type="submit">Open scope</button>
              <a class="btn btn-quiet" href="#/">Cancel</a>
            </div>
          </form>
        </div>
      </aside>
    </div>
  `;
}

function renderSheet() {
  const detail = state.detail;
  const scope = detail?.scope;
  if (!scope) {
    return html`<p class="boot">Loading scope…</p>`;
  }
  const task = selectedTask(detail);
  const wait = waitingOnYou(scope, detail.tasks, detail);
  const pathUrl = gitlabRepoUrl(scope.provider_repo_path);
  const taskCount = detail.tasks.length;
  return html`
    <header class="sheet-head">
      <div class="sheet-head-main">
        <h1 class="goal">${scopeTitle(scope)}</h1>
        <p class="sheet-sub">
          <span class="mono">${scope.id}</span>
          ${pathUrl
            ? html`<a href=${pathUrl}>${scope.provider_repo_path}</a>`
            : html`<span>${scope.provider_repo_path}</span>`}
          ${scope.project_name
            ? html`<a href=${projectHref(scope.project_name)}
                >${scope.project_name}</a
              >`
            : nothing}
          <span>updated ${rel(scope.updated_at)}</span>
        </p>
      </div>
      <div class="sheet-head-side">
        <span class="chip" data-kind=${scope.status}>${scope.status}</span>
        ${scope.approvals === "manual"
          ? html`<span class="chip">manual approvals</span>`
          : nothing}
        ${abandonButton(scope)}
      </div>
    </header>
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    ${wait ? html`<div class="banner banner-wait">${wait}</div>` : nothing}
    <section class="card dag-card" id="draw">
      <p class="card-head">
        Tasks${taskCount ? html` <span>${taskCount}</span>` : nothing}
      </p>
      <div class="card-body">${renderDag(detail)}</div>
    </section>
    <div class="sheet-cols">
      <div class="sheet-col">${renderGoalCard(scope)} ${renderActivity()}</div>
      <div class="sheet-col">${renderPlanCard(scope, detail)}</div>
      <div class="sheet-col">${renderValidationCard(scope, detail)}</div>
    </div>
    ${state.drawerOpen
      ? task
        ? renderDrawer(scope, task)
        : state.selectedTaskId?.startsWith("plan:")
          ? renderPlanTaskDrawer(scope, Number(state.selectedTaskId.slice(5)))
          : nothing
      : nothing}
  `;
}

function renderGoalCard(scope) {
  const long = scope.goal.length > 420;
  return html`<aside class="card">
    <p class="card-head">Goal</p>
    <div class="card-body">
      <p
        class=${classMap({
          "plan-summary": true,
          "is-open": state.goalOpen || !long,
        })}
      >
        ${scope.goal}
      </p>
      ${long
        ? html`<button class="goal-toggle" @click=${() => toggle("goalOpen")}>
            ${state.goalOpen ? "Show less" : "Show more"}
          </button>`
        : nothing}
    </div>
  </aside>`;
}

function renderPlanCard(scope, detail) {
  const plan = parsePlan(scope.plan_json);
  const architectRuns = (detail?.runs || []).filter(
    (run) => run.kind === "architect",
  );
  const replanRequests = state.audit.flatMap((row) => {
    if (row.action !== "plan.replan_requested") return [];
    const feedback = parseAuditDetail(row.detail_json).feedback;
    return typeof feedback === "string" && feedback.trim()
      ? [{ ...row, feedback }]
      : [];
  });
  if (!plan && !architectRuns.length) return nothing;
  const summary = plan
    ? plan.summary || "Ready for approval."
    : scope.status === "planning"
      ? "Architect is drawing the plan."
      : "";
  const approvable = scope.status === "planning" && plan;
  return html`<aside class="card">
    <p class="card-head">Plan</p>
    <div class="card-body">
      ${summary
        ? html`<p
            class=${classMap({
              "plan-summary": true,
              "is-open": state.planOpen,
            })}
          >
            ${summary}
          </p>`
        : nothing}
      ${plan
        ? html`<button
            class="goal-toggle"
            @click=${() => openReader("Plan", planMarkdown(scope, plan))}
          >
            Expand plan
          </button>`
        : summary.length > 360
          ? html`<button class="goal-toggle" @click=${() => toggle("planOpen")}>
              ${state.planOpen ? "Show less" : "Show more"}
            </button>`
          : nothing}
      ${replanRequests.length
        ? html`<section
            class="plan-history"
            aria-label="Replan request history"
          >
            <p class="plan-history-title">
              Replan requests <span>${replanRequests.length}</span>
            </p>
            <ol>
              ${repeat(
                replanRequests,
                (row) => row.id,
                (row) =>
                  html`<li>
                    <p class="plan-history-meta">
                      <span>${rel(row.at)}</span><span>${row.actor}</span>
                    </p>
                    <p>${row.feedback}</p>
                  </li>`,
              )}
            </ol>
          </section>`
        : nothing}
      ${approvable
        ? html`<div class="plan-actions">
              <button
                class="btn btn-solid"
                @click=${() => mutate(`/scopes/${scope.id}/approve-plan`)}
              >
                Approve plan
              </button>
            </div>
            <form
              class="feedback"
              @submit=${(event) =>
                submitFeedback(event, `/scopes/${scope.id}/replan`)}
            >
              <textarea
                name="feedback"
                required
                placeholder="What should the architect change? Rejecting re-plans with this feedback."
              ></textarea>
              <button class="btn" type="submit">Request replan</button>
            </form>`
        : nothing}
      ${architectRuns.length
        ? html`<div class="runs runs-inline">
            ${architectRuns.map(
              (run) =>
                html`${runLine(run)}${run.status === "running"
                  ? renderScopeRunLog(run)
                  : nothing}`,
            )}
          </div>`
        : nothing}
    </div>
  </aside>`;
}

function renderValidationCard(scope, detail) {
  let acceptance = null;
  if (scope.acceptance_json) {
    try {
      const parsed = JSON.parse(scope.acceptance_json);
      if (Array.isArray(parsed)) acceptance = parsed;
    } catch {
      acceptance = null;
    }
  }
  const validateRuns = (detail?.runs || []).filter(
    (run) => run.kind === "validate",
  );
  if ((!acceptance || !acceptance.length) && !validateRuns.length) {
    return nothing;
  }
  const latest = validateRuns
    .slice()
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    .pop();
  const evidence = latest ? parseEvidence(latest.evidence_json) : null;
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  const failedCount = results.filter((result) => result.exit_code !== 0).length;
  const failed = Boolean(latest && latest.status === "failed");
  const running = Boolean(latest && latest.status === "running");
  const summary =
    latest && evidence
      ? evidence.passed
        ? "All criteria passed"
        : `Failed: ${failedCount} criteria did not pass`
      : running
        ? "Validation is running…"
        : null;
  return html`<aside class="card">
    <p class="card-head">Validation</p>
    <div class="card-body">
      ${summary
        ? html`<p
            class=${classMap({
              "validation-summary": true,
              "is-passed": Boolean(evidence?.passed),
              "is-failed": Boolean(evidence && !evidence.passed),
            })}
          >
            ${summary}${(() => {
              if (!latest) return nothing;
              const ms = runDurationMs(latest, Date.now());
              if (ms === null) return nothing;
              return html` ·
                <time
                  class="dur"
                  datetime=${isoDuration(ms)}
                  title=${`started ${latest.started_at}${latest.finished_at ? `, finished ${latest.finished_at}` : ""}`}
                  aria-label=${durationAriaLabel(latest, Date.now())}
                  >${formatDuration(ms)}</time
                >`;
            })()}
          </p>`
        : nothing}
      ${(scope.status === "validating" || scope.status === "blocked") && failed
        ? html`<button
            class="btn btn-solid validation-retry"
            @click=${() =>
              mutate(
                scope.status === "blocked"
                  ? `/scopes/${scope.id}/unblock`
                  : `/scopes/${scope.id}/revalidate`,
              )}
          >
            Run validation again
          </button>`
        : nothing}
      <ul class="validation-list">
        ${repeat(
          acceptance || [],
          (item, i) => i,
          (item, i) => {
            const result = results.find((r) => r.index === i);
            const pending = !result;
            const failed = result && result.exit_code !== 0;
            return html`<li
              class=${classMap({
                "validation-item": true,
                "is-pending": pending,
                "is-passed": !pending && !failed,
                "is-failed": Boolean(failed),
              })}
            >
              <span class="validation-marker">
                ${pending ? "…" : failed ? "✕" : "✓"}
              </span>
              <div class="validation-detail">
                <p class="validation-desc">
                  ${item?.description || `Criterion ${i + 1}`}
                </p>
                ${item?.command
                  ? html`<code class="mono validation-cmd"
                      >${item.command}</code
                    >`
                  : nothing}
                ${(() => {
                  // Acceptance commands often discard their own output
                  // (>/dev/null 2>&1); a tail of blank lines must not render
                  // as an empty output pane.
                  const tail = (result?.tail || [])
                    .join("\n")
                    .replace(/\s+$/, "");
                  return failed && tail
                    ? html`<pre class="runlog">${tail}</pre>`
                    : nothing;
                })()}
              </div>
            </li>`;
          },
        )}
      </ul>
    </div>
  </aside>`;
}

function renderCostPrediction(task) {
  const prediction = parseCostPrediction(task);
  if (!prediction) return nothing;
  const lines = costPredictionLines(prediction);
  return html`<div class="cost-prediction">
    <p class="card-head cost-prediction-head">
      Size prediction
      ${prediction.flagged
        ? html`<span class="chip" data-kind="blocked">over budget</span>`
        : html`<span class="cost-prediction-ok">within budget</span>`}
    </p>
    <div class="cost-prediction-body">
      ${lines.map((line) => html`<p class="task-meta">${line}</p>`)}
    </div>
  </div>`;
}

function renderDrawer(scope, task) {
  const sha = [...(state.detail?.runs || [])]
    .reverse()
    .find((run) => run.task_id === task.id && run.head_sha)?.head_sha;
  const mr = task.mr_iid ? mrUrl(scope.provider_repo_path, task.mr_iid) : "";
  const commit = sha ? commitUrl(scope.provider_repo_path, sha) : "";
  const retryWait =
    task.next_retry_at && Date.parse(task.next_retry_at) > Date.now()
      ? ` · next attempt in ${Math.max(1, Math.round((Date.parse(task.next_retry_at) - Date.now()) / 60000))}m`
      : "";
  return html`<aside class="drawer" role="dialog" aria-label="Task detail">
    <div class="drawer-head">
      <span class="chip" data-kind=${task.state}>${task.state}</span>
      <span class="mono drawer-id">${task.id}</span>
      <button
        class="btn btn-quiet drawer-close"
        @click=${closeDrawer}
        aria-label="Close task detail"
      >
        ✕
      </button>
    </div>
    <div class="drawer-body">
      <p class="task-title">${task.title}</p>
      <p class="task-meta">
        ${task.attempt
          ? `attempt ${task.attempt}`
          : "first attempt"}${retryWait}
      </p>
      ${task.blocked_reason
        ? html`<p class="wait-inline">${task.blocked_reason}</p>`
        : nothing}
      ${renderCostPrediction(task)}
      <div class="links">
        ${mr ? html`<a href=${mr}>Merge request !${task.mr_iid}</a>` : nothing}
        ${commit ? html`<a href=${commit}>${shortSha(sha)}</a>` : nothing}
        ${task.branch
          ? html`<span class="mono">${task.branch}</span>`
          : nothing}
      </div>
      <button
        class="goal-toggle"
        @click=${() => openReader(task.title, task.spec)}
      >
        Expand spec
      </button>
      <pre class="spec">${task.spec}</pre>
      ${task.state === "mr_open"
        ? html`<form
            class="feedback"
            @submit=${(event) =>
              submitFeedback(event, `/tasks/${task.id}/request-changes`)}
          >
            <textarea
              name="feedback"
              required
              placeholder="Feedback for the agent — requeues the task with your notes."
            ></textarea>
            <button class="btn" type="submit">Request changes</button>
          </form>`
        : nothing}
      ${!["merged", "canceled"].includes(task.state)
        ? html`<form
            class="feedback"
            @submit=${(event) =>
              submitFeedback(event, `/tasks/${task.id}/amend-spec`)}
          >
            <textarea
              name="feedback"
              required
              placeholder="Amend the spec — authoritative for the implementer AND the reviewer."
            ></textarea>
            <button class="btn" type="submit">Amend spec</button>
          </form>`
        : nothing}
      ${taskActionButtons(task)}
      <p class="card-head drawer-runs-head">Runs</p>
      <div class="runs">${renderRuns(state.detail, task)}</div>
    </div>
  </aside>`;
}

function renderPlanTaskDrawer(scope, index) {
  const plan = parsePlan(scope.plan_json);
  const planTask = plan?.tasks?.[index];
  if (!planTask) return nothing;
  return html`<aside class="drawer" role="dialog" aria-label="Planned task">
    <div class="drawer-head">
      <span class="chip">proposed</span>
      <span class="mono drawer-id">plan #${index}</span>
      <button
        class="btn btn-quiet drawer-close"
        @click=${closeDrawer}
        aria-label="Close task detail"
      >
        ✕
      </button>
    </div>
    <div class="drawer-body">
      <p class="task-title">${planTask.title}</p>
      <p class="task-meta">
        ${(planTask.depends_on || []).length
          ? `depends on ${(planTask.depends_on || []).map((d) => `#${d}`).join(", ")}`
          : "no dependencies"}
      </p>
      <pre class="spec spec-tall">${planTask.spec}</pre>
      <p class="note">
        This task is proposed — approve or reject the plan from the Plan card.
      </p>
    </div>
  </aside>`;
}

function renderActivity() {
  const rows = state.audit.slice(0, 10);
  return html`<aside class="card">
    <p class="card-head">Activity</p>
    <div class="card-body">
      <ul class="activity">
        ${rows.length
          ? repeat(
              rows,
              (row) => row.id,
              (row) =>
                html`<li>
                  <span class="when">${rel(row.at)}</span>
                  <span>
                    <span class="what">${row.action}</span>
                    <span class="who">${row.actor}</span>
                  </span>
                </li>`,
            )
          : html`<li><span class="note">Nothing yet.</span></li>`}
      </ul>
    </div>
  </aside>`;
}

let _paintDepth = 0;

// ---------------------------------------------------------------------------
// Markdown reader: safe subset renderer for agent-authored plan/spec text.
// Escapes EVERYTHING first, then rebuilds a small grammar: headings, fenced
// code, lists, blockquotes, bold/italic/inline code, http(s) links.

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mdInline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

function renderMarkdown(source) {
  const lines = escapeHtml(source).split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let fence = false;
  let fenceBuf = [];
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      if (fence) {
        out.push(
          `<pre class="md-code"><code>${fenceBuf.join("\n")}</code></pre>`,
        );
        fenceBuf = [];
        fence = false;
      } else {
        closeList();
        fence = true;
      }
      continue;
    }
    if (fence) {
      fenceBuf.push(raw);
      continue;
    }
    const line = raw;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = Math.min(h[1].length + 1, 5);
      out.push(`<h${level}>${mdInline(h[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      out.push(
        `<blockquote>${mdInline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`,
      );
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  if (fence)
    out.push(`<pre class="md-code"><code>${fenceBuf.join("\n")}</code></pre>`);
  closeList();
  return out.join("\n");
}

function mdFragment(markdown) {
  // Our renderer escapes all input before rebuilding markup, so this HTML is
  // console-authored, never agent-authored.
  const tpl = document.createElement("template");
  tpl.innerHTML = renderMarkdown(markdown);
  return tpl.content;
}

function openReader(title, markdown) {
  state.reader = { title, markdown };
  paint();
}

function closeReader() {
  state.reader = null;
  paint();
}

function planMarkdown(scope, plan) {
  const parts = [`# Plan — ${scopeTitle(scope)}`, "", plan.summary || ""];
  if (Array.isArray(plan.acceptance) && plan.acceptance.length) {
    parts.push("", "## Acceptance criteria");
    for (const a of plan.acceptance) {
      parts.push(`- ${a.description}`, "", "```", a.command, "```");
    }
  }
  (plan.tasks || []).forEach((task, index) => {
    const deps = (task.depends_on || []).length
      ? ` (depends on ${task.depends_on.join(", ")})`
      : "";
    parts.push(
      "",
      `## Task ${index}: ${task.title}${deps}`,
      "",
      task.spec || "",
    );
  });
  return parts.join("\n");
}

function renderReader() {
  if (!state.reader) return nothing;
  return html`<div
    class="reader-overlay"
    @click=${(event) => {
      if (event.target === event.currentTarget) closeReader();
    }}
  >
    <div
      class="reader"
      role="dialog"
      aria-modal="true"
      aria-label=${state.reader.title}
    >
      <header class="reader-head">
        <p>${state.reader.title}</p>
        <button class="btn btn-quiet" @click=${closeReader}>Close</button>
      </header>
      <div class="reader-body md">${mdFragment(state.reader.markdown)}</div>
    </div>
  </div>`;
}

function paint() {
  if (_paintDepth > 0) return;
  _paintDepth++;
  try {
    const view =
      state.oidc && !state.auth
        ? renderSignin()
        : routeIsNew()
          ? renderCreate()
          : routeIsNewProject()
            ? renderNewProject()
            : routeIsManageFiles()
              ? renderManageFiles()
              : routeScopeId()
                ? renderSheet()
                : routeProjectName()
                  ? renderProjectPage()
                  : renderProjectList();
    litRender(
      html`${renderTopbar()}
        <main class="view">${view}</main>
        ${renderReader()}`,
      app,
    );
  } finally {
    _paintDepth--;
  }
  syncDurationTicker();
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    if (DEMO) {
      const world = demoWorld();
      state.config = world.config;
      const id = routeScopeId();
      if (id) {
        const scopeRow = world.scopes.find((s) => s.id === id) ?? null;
        state.detail = scopeRow
          ? scopeRow.id === world.detail.scope.id
            ? world.detail
            : (world.runningDetails[scopeRow.id] ?? {
                scope: scopeRow,
                tasks: [],
                deps: [],
                runs: [],
              })
          : null;
        consumePendingTaskSelection(state.detail);
      } else {
        state.detail = null;
      }
      const demoName = routeProjectName();
      const filesName = routeProjectFilesName();
      const pageNo = pageFromHash(location.hash);
      if (filesName) {
        // The demo world serves the project's reference files offline.
        const found = world.projects.find((p) => p.name === filesName) ?? null;
        const files = demoFileStore.get(filesName) ?? [];
        const start = (pageNo - 1) * PAGE_SIZE;
        state.filesPage = {
          name: filesName,
          project: found,
          files: files.slice(start, start + PAGE_SIZE),
          total: files.length,
          offset: start,
          page: pageNo,
        };
        state.projectPage = null;
      } else {
        state.filesPage = null;
      }
      if (demoName === world.project.name) {
        // Page the demo project's scopes with the same rule the API uses:
        // updated_at DESC, id (tie-break), so ?page=2 starts at col-d25.
        const owned = world.scopes
          .filter((scope) => scope.project_name === demoName)
          .sort(
            (a, b) =>
              Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          );
        const start = (pageNo - 1) * PAGE_SIZE;
        state.projectPage = {
          name: demoName,
          project: world.project,
          scopes: owned.slice(start, start + PAGE_SIZE),
          total: owned.length,
          offset: start,
          page: pageNo,
        };
        state.projectRunning = world.running ?? [];
        // Same seeding path as live refresh(): read the stored doc through
        // the demo-served GET so the editor prefills offline. Local edits
        // are kept in demoContextStore so an edited brief survives re-render.
        if (state.projectContext === null) {
          const stored = demoContextStore.has(demoName)
            ? { context_doc: demoContextStore.get(demoName) }
            : { context_doc: world.project.context_doc ?? "" };
          state.projectContext = {
            doc: stored.context_doc ?? "",
            status: null,
          };
        }
        state.projectFiles = demoFileStore.get(demoName) ?? [];
      } else if (demoName) {
        const found =
          demoName === world.project.name
            ? world.project
            : (world.projects.find((p) => p.name === demoName) ?? null);
        state.projectPage = {
          name: demoName,
          project: found,
          scopes: [],
          total: 0,
          offset: 0,
          page: pageNo,
        };
        state.projectRunning = [];
        state.projectFiles = found ? (demoFileStore.get(demoName) ?? []) : [];
      } else {
        state.projectPage = null;
        state.projectRunning = null;
        // Sort the demo world's projects exactly like the API (row
        // updated_at DESC, name), then page. This keeps the demo ordering
        // pin: "Operator console" lands at offset 25, page 2.
        const ordered = [...world.projects].sort(
          (a, b) =>
            Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        );
        const start = (pageNo - 1) * PAGE_SIZE;
        state.projectsPage = {
          projects: ordered.slice(start, start + PAGE_SIZE),
          total: ordered.length,
          offset: start,
          page: pageNo,
        };
      }
      state.audit = world.audit;
      if (state.drawerOpen && state.selectedTaskId === "col-a1b2c3d4.1") {
        state.runEvents = { runId: "run-gate-1", rows: world.runEvents };
      }
      state.error = "";
      paint();
      return;
    }
    state.config = await api("/ui/config");
    state.oidc = state.config.oidc || null;
    if (state.oidc) {
      if (new URLSearchParams(location.search).has("code")) {
        await completeLogin();
      }
      await ensureFreshToken();
      if (!state.auth) {
        state.error = "";
        paint();
        return;
      }
    }
    const pageNo = pageFromHash(location.hash);
    const offset = (pageNo - 1) * PAGE_SIZE;
    const projectName = routeProjectName();
    const filesName = routeProjectFilesName();
    if (filesName) {
      const [project, filesPage] = await Promise.all([
        api(`/projects/${encodeURIComponent(filesName)}`, {
          notFound: "null",
        }),
        api(
          `/projects/${encodeURIComponent(filesName)}/files?limit=${PAGE_SIZE}&offset=${offset}`,
        ),
      ]);
      state.filesPage = {
        name: filesName,
        project: project === null ? null : project.project,
        files: filesPage.files ?? [],
        total: filesPage.total ?? 0,
        offset,
        page: pageNo,
      };
      state.projectPage = null;
      state.projectRunning = null;
      state.error = "";
      paint();
      return;
    }
    state.filesPage = null;
    if (projectName) {
      // The project route owns this refresh: it must not touch board or sheet
      // state, and it must preserve an in-flight editor status ("Saved.").
      const [project, scopesPage, runningRows] = await Promise.all([
        api(`/projects/${encodeURIComponent(projectName)}`, {
          notFound: "null",
        }),
        api(
          `/scopes?limit=${PAGE_SIZE}&offset=${offset}&project=${encodeURIComponent(projectName)}`,
        ),
        api(`/projects/${encodeURIComponent(projectName)}/running`, {
          notFound: "null",
        }),
      ]);
      state.projectPage = {
        name: projectName,
        project: project === null ? null : project.project,
        scopes: scopesPage.scopes,
        total: scopesPage.total,
        offset,
        page: pageNo,
      };
      state.projectRunning = Array.isArray(runningRows) ? runningRows : [];
      // Seed the editor from the same read the save round-trips through, so
      // prefill cannot drift from what Save will persist. An unknown project
      // has no document to read.
      if (state.projectContext === null && project) {
        const stored = await api(
          `/projects/${encodeURIComponent(projectName)}/context`,
        );
        state.projectContext = { doc: stored.context_doc ?? "", status: null };
      }
      if (state.projectFiles === null && project) {
        const filesPage = await api(
          `/projects/${encodeURIComponent(projectName)}/files?limit=${PAGE_SIZE}&offset=0`,
        );
        state.projectFiles = filesPage.files ?? [];
      }
      state.error = "";
      paint();
      return;
    }
    state.projectPage = null;
    state.projectRunning = null;
    const projectsPage = await api(
      `/projects?limit=${PAGE_SIZE}&offset=${offset}${archivedQuery()}`,
    );
    state.projectsPage = {
      projects: projectsPage.projects ?? [],
      total: projectsPage.total ?? 0,
      offset,
      page: pageNo,
    };
    const id = routeScopeId();
    if (id) {
      const [detail, audit] = await Promise.all([
        api(`/scopes/${encodeURIComponent(id)}`),
        api(`/audit?scope_id=${encodeURIComponent(id)}&limit=1000`),
      ]);
      state.detail = detail;
      state.audit = audit.events;
      consumePendingTaskSelection(detail);
      if (
        state.projectContext === null &&
        detail.project &&
        detail.project.context_doc !== undefined
      ) {
        state.projectContext = {
          doc: detail.project.context_doc ?? "",
          status: null,
        };
      }
      if (
        state.selectedTaskId &&
        !taskSelectionExists(detail, state.selectedTaskId)
      ) {
        state.selectedTaskId = null;
        state.drawerOpen = false;
      }
      await refreshRunEvents(detail);
    } else {
      state.detail = null;
      state.projectContext = null;
      state.audit = (await api("/audit?limit=12")).events;
    }
    state.error = "";
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  paint();
}

/** Live agent feed for the drawer's most recent running run, if any. */
async function refreshRunEvents(detail) {
  const targets = [];
  if (state.drawerOpen && state.selectedTaskId) {
    const live = [...(detail.runs || [])]
      .reverse()
      .find(
        (run) =>
          run.task_id === state.selectedTaskId && run.status === "running",
      );
    if (live) targets.push(live);
  }
  // Scope-level architect runs stream into the Plan card so planning is
  // never a black box.
  const architect = (detail.runs || []).find(
    (run) => run.kind === "architect" && run.status === "running",
  );
  if (architect) targets.push(architect);
  if (!targets.length) {
    state.runEvents = null;
    state.scopeRunEvents = null;
    return;
  }
  try {
    const feeds = await Promise.all(
      targets.map(async (run) => ({
        runId: run.id,
        rows: (await api(`/runs/${encodeURIComponent(run.id)}/events`)).events,
      })),
    );
    const drawerTarget = targets.find((run) => run !== architect);
    state.runEvents = drawerTarget
      ? (feeds.find((f) => f.runId === drawerTarget.id) ?? null)
      : null;
    state.scopeRunEvents = architect
      ? (feeds.find((f) => f.runId === architect.id) ?? null)
      : null;
  } catch {
    state.runEvents = null;
    state.scopeRunEvents = null;
  }
}

// ---------------------------------------------------------------------------
// Global listeners
// ---------------------------------------------------------------------------

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.drawerOpen) closeDrawer();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.reader) closeReader();
});

window.addEventListener("hashchange", () => {
  state.selectedTaskId = null;
  state.drawerOpen = false;
  state.runEvents = null;
  state.confirm = null;
  state.goalOpen = false;
  state.planOpen = false;
  state.projectContext = null;
  state.projectPage = null;
  state.projectsPage = null;
  state.filesPage = null;
  state.projectFiles = null;
  state.projectRunning = null;
  state.projectTab = hashQueryTab();
  state.showArchived = false;
  state.briefOpen = false;
  state.confirmFile = null;
  state.replaceFileId = null;
  state.newProjectDraft = null;
  void refresh();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void refresh();
});

function isEditing() {
  const el = document.activeElement;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA";
}

function hasVisibleRunningRun() {
  const detail = state.detail;
  if (detail) {
    const runs = detail.runs || [];
    // Any running run on the current scope is considered visible:
    // drawer runs, plan architect runs, validation, or DAG live nodes all
    // surface through the rendered sheet so a single check covers them.
    if (runs.some((run) => run.status === "running")) return true;
  }
  if (state.projectTab === "running" && state.projectPage) {
    const runningList = state.projectRunning;
    if (Array.isArray(runningList)) {
      if (runningList.some((entry) => entry?.run?.status === "running")) {
        return true;
      }
    }
  }
  return false;
}

function syncDurationTicker() {
  const needsTick = hasVisibleRunningRun();
  if (needsTick) {
    if (!state.durationTicker) {
      state.durationTicker = createRunTicker(
        () => {
          if (document.hidden || isEditing()) return;
          if (!hasVisibleRunningRun()) {
            state.durationTicker?.stop();
            return;
          }
          paint();
        },
        { intervalMs: 1000 },
      );
    }
    if (!state.durationTicker.running()) state.durationTicker.start();
  } else {
    state.durationTicker?.stop();
  }
}

void refresh();
state.poll = window.setInterval(() => {
  if (document.hidden || isEditing()) return;
  void refresh();
}, 2500);
