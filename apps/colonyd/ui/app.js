(() => {
  const ACTOR_KEY = "colony.actor";
  const DEMO = new URLSearchParams(location.search).has("demo");
  let snapshot = "";

  const KIND_LABEL = {
    architect: "plan",
    implement: "build",
    review: "review",
    merge_gate: "gate",
  };

  const state = {
    config: { gitlab_base_url: "", review_mode: "off", hitl_mode: "yolo" },
    oidc: null,
    actor: localStorage.getItem(ACTOR_KEY) || "human:op-1",
    scopes: [],
    detail: null,
    audit: [],
    selectedTaskId: null,
    goalOpen: false,
    planOpen: false,
    auth: loadAuth(),
    error: "",
    confirm: null,
    poll: 0,
  };

  const app = document.getElementById("app");
  const AUTH_KEY = "colony.auth";

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
      render();
    }
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function attr(value) {
    return esc(value).replaceAll("'", "&#39;");
  }

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

  function waitingOnYou(scope, tasks) {
    if (!scope) return "";
    if (scope.status === "planning" && scope.plan_json) {
      return "Plan is waiting for your approval.";
    }
    if (scope.status === "planning") return "Architect is drawing the plan.";
    if (scope.status === "blocked") {
      return scope.blocked_reason || "Scope is blocked.";
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
      snapshot = "";
      render();
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

  const DEMO_SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const DEMO_SHA_B = "b9c0d1e2f30415263748a9b0c1d2e3f401234567";

  function demoWorld() {
    const scope = {
      id: "col-a1b2c3d4",
      goal: "Add a /version endpoint that returns the running colonyd SHA",
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
        id: "run-rev-0",
        scope_id: scope.id,
        task_id: "col-a1b2c3d4.0",
        kind: "review",
        status: "succeeded",
        head_sha: DEMO_SHA_A,
        evidence_json: JSON.stringify({
          verdict: "approve",
          head_sha: DEMO_SHA_A,
        }),
        error: null,
        started_at: new Date(Date.now() - 23 * 60 * 1000).toISOString(),
        finished_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
      },
      {
        id: "run-gate-0",
        scope_id: scope.id,
        task_id: "col-a1b2c3d4.0",
        kind: "merge_gate",
        status: "succeeded",
        head_sha: DEMO_SHA_A,
        error: null,
        evidence_json: JSON.stringify({ verdict: "pass" }),
        started_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
        finished_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
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
      {
        id: "run-rev-1",
        scope_id: scope.id,
        task_id: "col-a1b2c3d4.1",
        kind: "review",
        status: "succeeded",
        head_sha: DEMO_SHA_B,
        evidence_json: JSON.stringify({
          verdict: "approve",
          head_sha: DEMO_SHA_B,
        }),
        error: null,
        started_at: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
        finished_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
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
      const preds = (incoming.get(id) || []).filter((pred) =>
        ids.includes(pred),
      );
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

  function latestGate(detail, taskId) {
    return [...(detail?.runs || [])]
      .reverse()
      .find((run) => run.kind === "merge_gate" && run.task_id === taskId);
  }

  function renderDag(detail) {
    const { nodes, edges } = graphModel(detail);
    if (!nodes.length) {
      const runningPlan = (detail?.runs || []).some(
        (run) => run.kind === "architect" && run.status === "running",
      );
      return `<p class="note">${
        runningPlan
          ? "Architect is drawing the plan."
          : "No tasks on this sheet yet."
      }</p>`;
    }
    const { pos, width, height } = layoutDag(nodes, edges);
    const edgeMarkup = edges
      .map((edge) => {
        const from = pos.get(edge.depends_on_task_id);
        const to = pos.get(edge.task_id);
        if (!from || !to) return "";
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x - 3;
        const y2 = to.y + to.h / 2;
        const c = Math.max(30, (x2 - x1) * 0.45);
        return `<path class="edge" marker-end="url(#arrow)" d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}" />`;
      })
      .join("");
    const nodeMarkup = nodes
      .map((node) => {
        const box = pos.get(node.id);
        const live = liveRunFor(detail, node.id);
        const selected = state.selectedTaskId === node.id;
        const tail = node.id.slice(
          node.id.lastIndexOf(node.proposed ? ":" : ".") + 1,
        );
        const classes = [
          "g-node",
          "node",
          selected ? "is-selected" : "",
          live ? "is-live" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<g class="${classes}" data-state="${attr(node.state)}" data-task="${attr(node.id)}">
          <rect class="node-box${node.proposed ? " is-proposed" : ""}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" />
          <rect class="node-bar" x="${box.x + 5}" y="${box.y + 5}" width="3" height="${box.h - 10}" />
          <foreignObject x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}">
            <div class="node-html" xmlns="http://www.w3.org/1999/xhtml">
              <span class="ntitle">${esc(node.title)}</span>
              <span class="nstate">${esc(node.state)}${
                live ? ` · ${esc(KIND_LABEL[live.kind] || live.kind)}` : ""
              }<span class="nid">#${esc(tail)}</span></span>
            </div>
          </foreignObject>
          <rect class="node-hit" tabindex="0" role="button" aria-label="${attr(node.title)}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" data-task="${attr(node.id)}" />
        </g>`;
      })
      .join("");
    return `<svg class="dag" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task dependency graph">
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path class="edge-head" d="M0,0 L8,4 L0,8 z" />
        </marker>
      </defs>
      ${edgeMarkup}${nodeMarkup}</svg>`;
  }

  function selectedTask(detail) {
    if (!detail) return null;
    return (
      detail.tasks.find((task) => task.id === state.selectedTaskId) ||
      detail.tasks.find((task) => liveRunFor(detail, task.id)) ||
      detail.tasks.find((task) => task.state === "blocked") ||
      detail.tasks.find((task) => task.state === "mr_open") ||
      detail.tasks.at(-1) ||
      null
    );
  }

  function runsForTask(detail, taskId) {
    return (detail.runs || []).filter((run) => run.task_id === taskId);
  }

  function renderRuns(detail, task) {
    if (!task) {
      const architect = (detail?.runs || []).filter(
        (run) => run.kind === "architect",
      );
      if (!architect.length) {
        return `<p class="note">Select a task on the graph.</p>`;
      }
      return architect.map(runLine).join("");
    }
    const rows = runsForTask(detail, task.id);
    if (!rows.length) return `<p class="note">No runs on this task yet.</p>`;
    return rows.map(runLine).join("");
  }

  function runLine(run) {
    const evidence = parseEvidence(run.evidence_json);
    const findings = Array.isArray(evidence?.findings)
      ? `<ul class="findings">${evidence.findings
          .map(
            (finding) =>
              `<li>${esc(finding.severity)} — ${esc(finding.note)}${
                finding.file ? ` (${esc(finding.file)})` : ""
              }</li>`,
          )
          .join("")}</ul>`
      : "";
    const verdict = evidence?.verdict ? ` · ${evidence.verdict}` : "";
    return `<div class="run" data-status="${attr(run.status)}">
      <i></i>
      <div>
        <p class="kind">${esc(KIND_LABEL[run.kind] || run.kind)} ${esc(run.status)}${esc(verdict)}</p>
        <p class="meta">${esc(shortSha(run.head_sha))} · ${esc(rel(run.finished_at || run.started_at))}${
          run.error ? ` · ${esc(run.error)}` : ""
        }</p>
        ${findings}
      </div>
    </div>`;
  }

  function taskActionButtons(task) {
    const buttons = [];
    if (task?.state === "blocked") {
      buttons.push(
        `<button class="btn btn-solid" data-act="unblock">Unblock</button>`,
      );
    }
    const waiting =
      task?.state === "queued" &&
      task.next_retry_at &&
      Date.parse(task.next_retry_at) > Date.now();
    if (waiting) {
      buttons.push(
        `<button class="btn" data-act="retry">Run now — skip backoff</button>`,
      );
    }
    if (task && !["merged", "canceled"].includes(task.state)) {
      const cancel =
        state.confirm === "cancel"
          ? `<button class="btn btn-rev" data-act="cancel-yes">Confirm cancel</button>`
          : `<button class="btn btn-quiet" data-act="cancel">Cancel task</button>`;
      buttons.push(cancel);
    }
    return buttons.length
      ? `<div class="task-actions">${buttons.join("")}</div>`
      : "";
  }

  function abandonButton(scope) {
    if (!scope || ["done", "abandoned"].includes(scope.status)) return "";
    return state.confirm === "abandon"
      ? `<button class="btn btn-rev" data-act="abandon-yes">Confirm abandon</button>`
      : `<button class="btn btn-quiet" data-act="abandon">Abandon scope</button>`;
  }

  function renderTopbar() {
    const id = routeScopeId();
    const account = state.oidc
      ? state.auth
        ? `<div class="sign account">
            <span class="whoami mono">${esc(state.auth.username)}</span>
            <button class="btn btn-quiet" data-act="signout">Sign out</button>
          </div>`
        : `<div class="sign"></div>`
      : `<form class="sign" data-form="sign">
          <label>
            <span>Operator</span>
            <input name="actor" value="${attr(state.actor)}" spellcheck="false" />
          </label>
        </form>`;
    return `<header class="topbar">
      <a class="brand" href="#/">COLONY</a>
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/">Board</a>
        ${id ? `<span class="crumb-sep">/</span><span class="crumb mono">${esc(id)}</span>` : ""}
      </nav>
      ${account}
    </header>`;
  }

  function renderSignin() {
    return `<div class="signin">
      <div class="card signin-card">
        <p class="signin-brand">COLONY</p>
        <p class="note">
          Sign in with your aether account to operate the factory.
        </p>
        ${state.error ? `<div class="banner banner-error" role="alert">${esc(state.error)}</div>` : ""}
        <button class="btn btn-solid" data-act="signin">Sign in</button>
      </div>
    </div>`;
  }

  function renderBoard() {
    const cards = state.scopes.length
      ? state.scopes
          .slice()
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
          .map(
            (
              scope,
            ) => `<button class="scope-card" data-open="${attr(scope.id)}">
              <span class="scope-top">
                <span class="chip" data-kind="${attr(scope.status)}">${esc(scope.status)}</span>
                <span class="scope-time">${esc(rel(scope.updated_at))}</span>
              </span>
              <span class="scope-goal">${esc(scope.goal)}</span>
              <span class="scope-meta">
                <span class="mono">${esc(scope.id)}</span>
                <span>${esc(scope.provider_project_path)}</span>
              </span>
            </button>`,
          )
          .join("")
      : `<p class="rack-empty">No scopes yet. Describe a goal and a GitLab project, then open a scope.</p>`;
    return `
      ${state.error ? `<div class="banner banner-error" role="alert">${esc(state.error)}</div>` : ""}
      <div class="board" id="draw">
        <section>
          <h1 class="board-title">Scopes</h1>
          <div class="rack">${cards}</div>
        </section>
        <div class="board-side">
          <aside class="card">
            <p class="card-head">Open a scope</p>
            <div class="card-body">
              <form class="composer" data-form="open">
                <p class="composer-hint">
                  Colony plans the work, opens merge requests, and merges what
                  passes.
                </p>
                <label class="field">
                  <span>Goal</span>
                  <textarea name="goal" required placeholder="What should the factory build?"></textarea>
                </label>
                <label class="field">
                  <span>GitLab project path</span>
                  <input name="path" required placeholder="so/my-project" autocomplete="off" />
                </label>
                <button class="btn btn-solid" type="submit">Open scope</button>
              </form>
            </div>
          </aside>
          ${renderActivity()}
        </div>
      </div>`;
  }

  function renderSheet() {
    const detail = state.detail;
    const scope = detail?.scope;
    if (!scope) {
      return `<p class="boot">Loading scope…</p>`;
    }
    const task = selectedTask(detail);
    if (task && state.selectedTaskId !== task.id)
      state.selectedTaskId = task.id;
    const wait = waitingOnYou(scope, detail.tasks);
    const pathUrl = gitlabProjectUrl(scope.provider_project_path);
    const longGoal = scope.goal.length > 180;
    const taskCount = detail.tasks.length;
    return `
      <header class="sheet-head">
        <div class="sheet-head-main">
          <h1 class="goal${longGoal && !state.goalOpen ? " is-clamped" : ""}">${esc(scope.goal)}</h1>
          ${
            longGoal
              ? `<button class="goal-toggle" data-act="toggle-goal">${
                  state.goalOpen ? "Show less" : "Show full goal"
                }</button>`
              : ""
          }
          <p class="sheet-sub">
            <span class="mono">${esc(scope.id)}</span>
            ${
              pathUrl
                ? `<a href="${attr(pathUrl)}">${esc(scope.provider_project_path)}</a>`
                : `<span>${esc(scope.provider_project_path)}</span>`
            }
            <span>updated ${esc(rel(scope.updated_at))}</span>
          </p>
        </div>
        <div class="sheet-head-side">
          <span class="chip" data-kind="${attr(scope.status)}">${esc(scope.status)}</span>
          ${abandonButton(scope)}
        </div>
      </header>
      ${state.error ? `<div class="banner banner-error" role="alert">${esc(state.error)}</div>` : ""}
      ${wait ? `<div class="banner banner-wait">${esc(wait)}</div>` : ""}
      <section class="card dag-card" id="draw">
        <p class="card-head">Tasks${taskCount ? ` <span>${taskCount}</span>` : ""}</p>
        <div class="card-body">${renderDag(detail)}</div>
      </section>
      <div class="sheet-cols">
        <div class="sheet-col">
          ${renderPlanCard(scope)}
          ${renderTaskCard(scope, task)}
        </div>
        <div class="sheet-col">
          <aside class="card">
            <p class="card-head">Runs</p>
            <div class="card-body runs">${renderRuns(state.detail, task)}</div>
          </aside>
        </div>
        <div class="sheet-col">
          ${renderActivity()}
        </div>
      </div>`;
  }

  function renderPlanCard(scope) {
    const plan = parsePlan(scope.plan_json);
    if (!plan) return "";
    const summary = plan.summary || "Ready for approval.";
    const approvable = scope.status === "planning";
    return `<aside class="card">
      <p class="card-head">Plan</p>
      <div class="card-body">
        <p class="plan-summary${state.planOpen ? " is-open" : ""}">${esc(summary)}</p>
        ${
          summary.length > 360
            ? `<button class="goal-toggle" data-act="toggle-plan">${
                state.planOpen ? "Show less" : "Show more"
              }</button>`
            : ""
        }
        ${
          approvable
            ? `<div class="plan-actions"><button class="btn btn-solid" data-act="approve">Approve plan</button></div>`
            : ""
        }
      </div>
    </aside>`;
  }

  function renderTaskCard(scope, task) {
    const sha = [...(state.detail?.runs || [])]
      .reverse()
      .find((run) => run.task_id === task?.id && run.head_sha)?.head_sha;
    const mr = task?.mr_iid
      ? mrUrl(scope.provider_project_path, task.mr_iid)
      : "";
    const commit = sha ? commitUrl(scope.provider_project_path, sha) : "";
    return `<aside class="card">
      <p class="card-head">Task${task ? `<span class="mono">#${esc(task.id.slice(task.id.lastIndexOf(".") + 1))}</span>` : ""}</p>
      <div class="card-body">${
        task
          ? `<p class="task-title">${esc(task.title)}</p>
             <p class="task-meta">${esc(task.id)} · ${esc(task.state)}${
               task.attempt ? ` · attempt ${esc(task.attempt)}` : ""
             }${
               task.next_retry_at && Date.parse(task.next_retry_at) > Date.now()
                 ? ` · next attempt in ${esc(Math.max(1, Math.round((Date.parse(task.next_retry_at) - Date.now()) / 60000)))}m`
                 : ""
             }</p>
             ${
               task.blocked_reason
                 ? `<p class="wait-inline">${esc(task.blocked_reason)}</p>`
                 : ""
             }
             <div class="links">
               ${mr ? `<a href="${attr(mr)}">Merge request !${esc(task.mr_iid)}</a>` : ""}
               ${commit ? `<a href="${attr(commit)}">${esc(shortSha(sha))}</a>` : ""}
               ${task.branch ? `<span class="mono">${esc(task.branch)}</span>` : ""}
             </div>
             <pre class="spec">${esc(task.spec)}</pre>
             ${taskActionButtons(task)}`
          : `<p class="note">Select a task on the graph.</p>`
      }</div>
    </aside>`;
  }

  function renderActivity() {
    const rows = state.audit
      .slice(0, 10)
      .map(
        (row) => `<li>
          <span class="when">${esc(rel(row.at))}</span>
          <span><span class="what">${esc(row.action)}</span><span class="who">${esc(row.actor)}</span></span>
        </li>`,
      )
      .join("");
    return `<aside class="card">
      <p class="card-head">Activity</p>
      <div class="card-body">
        <ul class="activity">${rows || `<li><span class="note">Nothing yet.</span></li>`}</ul>
      </div>
    </aside>`;
  }

  function render() {
    app.className = "app";
    const view =
      state.oidc && !state.auth
        ? renderSignin()
        : routeScopeId()
          ? renderSheet()
          : renderBoard();
    app.innerHTML = `${renderTopbar()}<main class="view">${view}</main>`;
  }

  async function refresh() {
    try {
      if (DEMO) {
        const world = demoWorld();
        state.config = world.config;
        state.scopes = world.scopes;
        const id = routeScopeId();
        state.detail = id === world.detail.scope.id ? world.detail : null;
        state.audit = world.audit;
        if (id && id === world.detail.scope.id && !state.selectedTaskId) {
          state.selectedTaskId = "col-a1b2c3d4.1";
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
          snapshot = "";
          render();
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
        }
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

  function isEditing() {
    const el = document.activeElement;
    return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA";
  }

  function paint() {
    const next = JSON.stringify({
      route: routeScopeId(),
      scopes: state.scopes,
      detail: state.detail,
      audit: state.audit.map((row) => [row.id, row.action, row.at]),
      error: state.error,
      selected: state.selectedTaskId,
      confirm: state.confirm,
      goalOpen: state.goalOpen,
      planOpen: state.planOpen,
      actor: state.actor,
      signedIn: state.auth?.username || "",
    });
    if (next === snapshot) return;
    snapshot = next;
    render();
  }

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
      snapshot = "";
      render();
    }
  }

  app.addEventListener("click", (event) => {
    const open = event.target.closest("[data-open]");
    if (open) {
      location.hash = `#/${open.getAttribute("data-open")}`;
      return;
    }
    const hit = event.target.closest("[data-task]");
    if (hit && routeScopeId()) {
      state.selectedTaskId = hit.getAttribute("data-task");
      state.confirm = null;
      render();
      return;
    }
    const act = event.target.closest("[data-act]");
    if (!act) return;
    const action = act.getAttribute("data-act");
    const scope = state.detail?.scope;
    const task = selectedTask(state.detail);
    if (action === "approve" && scope)
      mutate(`/scopes/${scope.id}/approve-plan`);
    if (action === "abandon") {
      state.confirm = "abandon";
      render();
    }
    if (action === "abandon-yes" && scope)
      mutate(`/scopes/${scope.id}/abandon`);
    if (action === "unblock" && task) mutate(`/tasks/${task.id}/unblock`);
    if (action === "retry" && task) mutate(`/tasks/${task.id}/retry`);
    if (action === "cancel") {
      state.confirm = "cancel";
      render();
    }
    if (action === "cancel-yes" && task) mutate(`/tasks/${task.id}/cancel`);
    if (action === "signin") void beginLogin();
    if (action === "signout") signOut();
    if (action === "toggle-goal") {
      state.goalOpen = !state.goalOpen;
      render();
    }
    if (action === "toggle-plan") {
      state.planOpen = !state.planOpen;
      render();
    }
  });

  app.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const hit = event.target.closest("[data-task]");
    if (!hit) return;
    event.preventDefault();
    state.selectedTaskId = hit.getAttribute("data-task");
    render();
  });

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("form");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.form === "sign") {
      const actor = String(new FormData(form).get("actor") || "").trim();
      if (!actor) return;
      state.actor = actor;
      localStorage.setItem(ACTOR_KEY, actor);
      await refresh();
      return;
    }
    if (form.dataset.form === "open") {
      const data = new FormData(form);
      const goal = String(data.get("goal") || "").trim();
      const path = String(data.get("path") || "").trim();
      if (!goal || !path) return;
      try {
        const scope = await api("/scopes", {
          method: "POST",
          body: JSON.stringify({ goal, project: { path } }),
        });
        location.hash = `#/${scope.id}`;
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        render();
      }
    }
  });

  app.addEventListener("focusout", (event) => {
    const form = event.target.closest('form[data-form="sign"]');
    if (!form) return;
    const actor = String(new FormData(form).get("actor") || "").trim();
    if (actor && actor !== state.actor) {
      state.actor = actor;
      localStorage.setItem(ACTOR_KEY, actor);
    }
  });

  window.addEventListener("hashchange", () => {
    state.selectedTaskId = null;
    state.confirm = null;
    state.goalOpen = false;
    state.planOpen = false;
    void refresh();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void refresh();
  });

  void refresh();
  state.poll = window.setInterval(() => {
    if (document.hidden || isEditing()) return;
    void refresh();
  }, 2500);
})();
