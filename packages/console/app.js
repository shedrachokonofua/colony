import {
  html,
  svg,
  render as litRender,
  nothing,
  classMap,
  repeat,
  live,
} from "/ui/vendor/lit-html.js";

const ACTOR_KEY = "colony.actor";
const AUTH_KEY = "colony.auth";
const DEMO = new URLSearchParams(location.search).has("demo");

const KIND_LABEL = {
  architect: "plan",
  implement: "build",
  review: "review",
  merge_gate: "gate",
  validate: "validate",
};

const state = {
  config: { gitlab_base_url: "", review_mode: "off", hitl_mode: "yolo" },
  oidc: null,
  actor: localStorage.getItem(ACTOR_KEY) || "human:op-1",
  scopes: [],
  detail: null,
  audit: [],
  selectedTaskId: null,
  drawerOpen: false,
  runEvents: null,
  scopeRunEvents: null,
  goalOpen: false,
  planOpen: false,
  boardFilter: "all",
  boardQuery: "",
  auth: loadAuth(),
  error: "",
  confirm: null,
  poll: 0,
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
  if (!hash || hash === "new") return null;
  return hash;
}

function routeIsNew() {
  return location.hash.replace(/^#\/?/, "") === "new";
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

function scopeTitle(scope) {
  if (!scope) return "";
  if (scope.title) return scope.title;
  return scope.goal.length > 72
    ? `${scope.goal.slice(0, 72).trimEnd()}…`
    : scope.goal;
}

function waitingOnYou(scope, tasks) {
  if (!scope) return "";
  if (scope.status === "planning" && scope.plan_json) {
    return "Plan is waiting for your approval.";
  }
  if (scope.status === "planning") return "Architect is drawing the plan.";
  if (scope.status === "validating") {
    return "Validating the goal on the default branch — running acceptance criteria against a fresh checkout.";
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

function gitlabProjectUrl(path) {
  const base = state.config.gitlab_base_url.replace(/\/$/, "");
  if (!base || !path) return "";
  return `${base}/${path}`;
}

function mrUrl(path, iid) {
  const project = gitlabProjectUrl(path);
  return project && iid ? `${project}/-/merge_requests/${iid}` : "";
}

function commitUrl(path, sha) {
  const project = gitlabProjectUrl(path);
  return project && sha ? `${project}/-/commit/${sha}` : "";
}

async function api(path, options = {}) {
  if (DEMO) throw new Error("demo");
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

function demoWorld() {
  const scope = {
    id: "col-a1b2c3d4",
    goal: "Add a /version endpoint that returns the running colonyd SHA",
    title: "Version endpoint",
    status: "active",
    provider_project_id: "49",
    provider_project_path: "so/colony",
    default_branch: "main",
    plan_json: null,
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
      id: "run-arch",
      scope_id: scope.id,
      task_id: null,
      kind: "architect",
      status: "succeeded",
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
      started_at: new Date(Date.now() - 12 * 1000).toISOString(),
      finished_at: null,
    },
    {
      id: "run-impl-1",
      scope_id: scope.id,
      task_id: "col-a1b2c3d4.1",
      kind: "implement",
      status: "succeeded",
      head_sha: DEMO_SHA_B,
      error: null,
      started_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
      finished_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    },
  ];
  const runEvents = [
    {
      id: 1,
      run_id: "run-gate-1",
      at: new Date(Date.now() - 11 * 1000).toISOString(),
      event: "pi_tool_call",
      detail_json: JSON.stringify({ tool: "bash", isError: false }),
    },
    {
      id: 2,
      run_id: "run-gate-1",
      at: new Date(Date.now() - 6 * 1000).toISOString(),
      event: "pi_tool_call",
      detail_json: JSON.stringify({ tool: "read", isError: false }),
    },
  ];
  return {
    config: {
      gitlab_base_url: "https://gitlab.home.shdr.ch",
      review_mode: "required",
      hitl_mode: "yolo",
    },
    scopes: [
      scope,
      {
        id: "col-deadbeef",
        goal: "Retire the leftover colony-dev hostname",
        title: null,
        status: "done",
        provider_project_path: "so/aether",
        default_branch: "main",
        plan_json: null,
        blocked_reason: null,
        created_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      },
    ],
    detail: { scope, tasks, deps, runs },
    runEvents,
    audit: [
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

async function submitOpenScope(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const goal = String(data.get("goal") || "").trim();
  const title = String(data.get("title") || "").trim();
  const path = String(data.get("path") || "").trim();
  const approvals = String(data.get("approvals") || "auto");
  if (!goal || !path) return;
  try {
    const scope = await api("/scopes", {
      method: "POST",
      body: JSON.stringify({
        goal,
        ...(title ? { title } : {}),
        approvals,
        project: { path },
      }),
    });
    location.hash = `#/${scope.id}`;
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
            <span class="nstate">${node.state}${
              live ? ` · ${KIND_LABEL[live.kind] || live.kind}` : ""
            }<span class="nid">#${tail}</span></span>
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
        detail = [d.tool, d.isError ? "error" : ""].filter(Boolean).join(" · ");
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
  return html`<div class="run" data-status=${run.status}>
    <i></i>
    <div>
      <p class="kind">
        ${KIND_LABEL[run.kind] || run.kind} ${run.status}${verdict}
      </p>
      <p class="meta">
        ${shortSha(run.head_sha)} ·
        ${rel(run.finished_at || run.started_at)}${run.error
          ? ` · ${run.error}`
          : ""}
      </p>
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

function renderTopbar() {
  const id = routeScopeId();
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
      <a href="#/">Board</a>
      ${routeIsNew()
        ? html`<span class="crumb-sep">/</span>
            <span class="crumb">new scope</span>`
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

const BOARD_FILTERS = [
  { key: "all", label: "All" },
  { key: "needs-you", label: "Needs you" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
  { key: "abandoned", label: "Abandoned" },
];

function scopeMatchesFilter(scope) {
  switch (state.boardFilter) {
    case "needs-you":
      return (
        (scope.status === "planning" && Boolean(scope.plan_json)) ||
        scope.status === "blocked"
      );
    case "running":
      return ["planning", "active", "validating"].includes(scope.status);
    case "done":
      return scope.status === "done";
    case "abandoned":
      return scope.status === "abandoned";
    default:
      return true;
  }
}

function scopeMatchesQuery(scope) {
  const q = state.boardQuery.trim().toLowerCase();
  if (!q) return true;
  return [scope.title, scope.goal, scope.id, scope.provider_project_path]
    .filter(Boolean)
    .some((field) => field.toLowerCase().includes(q));
}

function renderBoard() {
  const sorted = state.scopes
    .slice()
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const visible = sorted.filter(
    (scope) => scopeMatchesFilter(scope) && scopeMatchesQuery(scope),
  );
  const cards = visible.length
    ? repeat(
        visible,
        (scope) => scope.id,
        (scope) =>
          html`<button class="scope-card" @click=${() => openScope(scope.id)}>
            <span class="scope-top">
              <span class="chip" data-kind=${scope.status}
                >${scope.status}</span
              >
              <span class="scope-time">${rel(scope.updated_at)}</span>
            </span>
            <span class="scope-goal">${scopeTitle(scope)}</span>
            <span class="scope-meta">
              <span class="mono">${scope.id}</span>
              <span>${scope.provider_project_path}</span>
            </span>
          </button>`,
      )
    : html`<p class="rack-empty">
        ${state.scopes.length
          ? "No scopes match this filter."
          : "No scopes yet — open the first one."}
      </p>`;
  return html`
    ${state.error
      ? html`<div class="banner banner-error" role="alert">${state.error}</div>`
      : nothing}
    <div class="board" id="draw">
      <section class="board-main">
        <div class="board-head">
          <h1 class="board-title">Scopes</h1>
          <a class="btn btn-solid" href="#/new">New scope</a>
        </div>
        <div class="board-filters">
          ${BOARD_FILTERS.map(
            (f) =>
              html`<button
                class=${classMap({
                  "filter-chip": true,
                  "is-active": state.boardFilter === f.key,
                })}
                @click=${() => {
                  state.boardFilter = f.key;
                  paint();
                }}
              >
                ${f.label}
              </button>`,
          )}
          <input
            class="board-search"
            type="search"
            placeholder="Search title, goal, id, project…"
            .value=${live(state.boardQuery)}
            @input=${(event) => {
              state.boardQuery = event.target.value;
              paint();
            }}
          />
        </div>
        <div class="rack">${cards}</div>
      </section>
      <div class="board-side">${renderActivity()}</div>
    </div>
  `;
}

function renderCreate() {
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
            <label class="field">
              <span>Title <em>optional</em></span>
              <input
                name="title"
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
              <span>GitLab project path</span>
              <input
                name="path"
                required
                placeholder="so/my-project"
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
  const wait = waitingOnYou(scope, detail.tasks);
  const pathUrl = gitlabProjectUrl(scope.provider_project_path);
  const taskCount = detail.tasks.length;
  return html`
    <header class="sheet-head">
      <div class="sheet-head-main">
        <h1 class="goal">${scopeTitle(scope)}</h1>
        <p class="sheet-sub">
          <span class="mono">${scope.id}</span>
          ${pathUrl
            ? html`<a href=${pathUrl}>${scope.provider_project_path}</a>`
            : html`<span>${scope.provider_project_path}</span>`}
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
      <div class="sheet-col">${renderGoalCard(scope)}</div>
      <div class="sheet-col">${renderPlanCard(scope, detail)}</div>
      <div class="sheet-col">${renderValidationCard(scope, detail)}</div>
      <div class="sheet-col">${renderActivity()}</div>
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
      ${summary.length > 360
        ? html`<button class="goal-toggle" @click=${() => toggle("planOpen")}>
            ${state.planOpen ? "Show less" : "Show more"}
          </button>`
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
  const summary =
    latest && evidence
      ? evidence.passed
        ? "All criteria passed"
        : `Failed: ${failedCount} criteria did not pass`
      : null;
  return html`<aside class="card">
    <p class="card-head">Validation</p>
    <div class="card-body">
      ${summary
        ? html`<p
            class=${classMap({
              "validation-summary": true,
              "is-passed": evidence.passed,
              "is-failed": !evidence.passed,
            })}
          >
            ${summary}
          </p>`
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
                ${failed && result.tail?.length
                  ? html`<pre class="runlog">${result.tail.join("\n")}</pre>`
                  : nothing}
              </div>
            </li>`;
          },
        )}
      </ul>
    </div>
  </aside>`;
}

function renderDrawer(scope, task) {
  const sha = [...(state.detail?.runs || [])]
    .reverse()
    .find((run) => run.task_id === task.id && run.head_sha)?.head_sha;
  const mr = task.mr_iid ? mrUrl(scope.provider_project_path, task.mr_iid) : "";
  const commit = sha ? commitUrl(scope.provider_project_path, sha) : "";
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
      <div class="links">
        ${mr ? html`<a href=${mr}>Merge request !${task.mr_iid}</a>` : nothing}
        ${commit ? html`<a href=${commit}>${shortSha(sha)}</a>` : nothing}
        ${task.branch
          ? html`<span class="mono">${task.branch}</span>`
          : nothing}
      </div>
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

function paint() {
  const view =
    state.oidc && !state.auth
      ? renderSignin()
      : routeIsNew()
        ? renderCreate()
        : routeScopeId()
          ? renderSheet()
          : renderBoard();
  litRender(
    html`${renderTopbar()}
      <main class="view">${view}</main>`,
    app,
  );
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    if (DEMO) {
      const world = demoWorld();
      state.config = world.config;
      state.scopes = world.scopes;
      const id = routeScopeId();
      state.detail = id === world.detail.scope.id ? world.detail : null;
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
    state.scopes = await api("/scopes");
    const id = routeScopeId();
    if (id) {
      const [detail, audit] = await Promise.all([
        api(`/scopes/${encodeURIComponent(id)}`),
        api(`/audit?scope_id=${encodeURIComponent(id)}&limit=20`),
      ]);
      state.detail = detail;
      state.audit = audit;
      if (
        state.selectedTaskId &&
        !detail.tasks.some((task) => task.id === state.selectedTaskId)
      ) {
        state.selectedTaskId = null;
        state.drawerOpen = false;
      }
      await refreshRunEvents(detail);
    } else {
      state.detail = null;
      state.audit = await api("/audit?limit=12");
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
        rows: await api(`/runs/${encodeURIComponent(run.id)}/events`),
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

window.addEventListener("hashchange", () => {
  state.selectedTaskId = null;
  state.drawerOpen = false;
  state.runEvents = null;
  state.confirm = null;
  state.goalOpen = false;
  state.planOpen = false;
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

void refresh();
state.poll = window.setInterval(() => {
  if (document.hidden || isEditing()) return;
  void refresh();
}, 2500);
