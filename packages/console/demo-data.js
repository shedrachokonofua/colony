// Demo world fixtures. Pure builders over a `now` timestamp so the whole
// offline world is reconstructable and testable without a browser; demo.js
// wires them to Date.now() and local (context/file) stores.

// Demo volume: enough projects and scopes to exercise page 2 on both surfaces.
export const DEMO_PROJECT_COUNT = 27;
export const DEMO_SCOPES_IN_PROJECT = 27;

export const DEMO_SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const DEMO_SHA_B = "b9c0d1e2f30415263748a9b0c1d2e3f401234567";
// The gate run must look perpetually "running", so its start moves with now.
export const DEMO_GATE_STARTED = new Date(Date.now() - 12 * 1000).toISOString();

// Filler projects: DEMO_PROJECT_COUNT - 1 of them, each strictly newer than
// the demo project, so "Operator console" sorts at index DEMO_PROJECT_COUNT - 1
// = offset 25 — the first row of the homepage's page 2.
export function buildFillerProjects(now) {
  return Array.from({ length: DEMO_PROJECT_COUNT - 1 }, (_, i) => ({
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
  }));
}

// Generated Operator-console scopes. Hand-authored scopes are newer than
// every generated one but are not owned by this project, so d25 is exactly
// the 26th row (offset 25): the first row of the project's scopes page 2.
export function buildDemoScopes(now) {
  return Array.from({ length: DEMO_SCOPES_IN_PROJECT }, (_, i) => {
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
  });
}

const ZERO_STATUS_COUNTS = {
  draft: 0,
  planning: 0,
  active: 0,
  validating: 0,
  blocked: 0,
  done: 0,
  abandoned: 0,
};

export function buildDemoProject(now, scopes, files) {
  const statusCounts = { ...ZERO_STATUS_COUNTS };
  for (const s of scopes) statusCounts[s.status] += 1;
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
    scope_count: scopes.length,
    status_counts: statusCounts,
    last_activity_at: new Date(
      Math.max(...scopes.map((s) => Date.parse(s.updated_at))),
    ).toISOString(),
    file_count: files.length,
    file_bytes: files.reduce((sum, f) => sum + f.byte_size, 0),
    repositories: [
      { repo_id: "49", repo_path: "so/colony" },
      { repo_id: "112", repo_path: "so/console-e2e" },
    ],
  };
  return demoProject;
}

// A second demo project with no brief, no files, and no scopes so the
// empty states are visible offline.
export function buildEmptyProject(now) {
  return {
    name: "Empty workspace",
    context_doc: null,
    created_at: new Date(now - 40 * 86400 * 1000).toISOString(),
    updated_at: new Date(now - 40 * 86400 * 1000).toISOString(),
    scope_count: 0,
    status_counts: { ...ZERO_STATUS_COUNTS },
    last_activity_at: null,
    file_count: 0,
    file_bytes: 0,
    repositories: [],
  };
}

export function buildDemoFiles(now) {
  return [
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
}

export function buildDemoDetail(now) {
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
    created_at: new Date(now - 36 * 60 * 1000).toISOString(),
    updated_at: new Date(now - 12 * 1000).toISOString(),
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
      updated_at: new Date(now - 20 * 60 * 1000).toISOString(),
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
      updated_at: new Date(now - 12 * 1000).toISOString(),
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
      started_at: new Date(now - 4 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 2 * 60 * 1000).toISOString(),
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
      started_at: new Date(now - 35 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 33 * 60 * 1000).toISOString(),
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
      started_at: new Date(now - 30 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 24 * 60 * 1000).toISOString(),
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
      started_at: new Date(now - 18 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 8 * 60 * 1000).toISOString(),
    },
  ];
  return { scope, tasks, deps, runs };
}

export function buildDemoRunEvents(now) {
  return [
    {
      id: 1,
      run_id: "run-gate-1",
      at: new Date(now - 11 * 1000).toISOString(),
      event: "tool_call",
      detail_json: JSON.stringify({ tool: "bash", isError: false }),
    },
    {
      id: 2,
      run_id: "run-gate-1",
      at: new Date(now - 6 * 1000).toISOString(),
      event: "tool_call",
      detail_json: JSON.stringify({ tool: "read", isError: false }),
    },
    {
      id: 3,
      run_id: "run-gate-1",
      at: new Date(now - 3 * 1000).toISOString(),
      event: "pi_model_fallback",
      detail_json: JSON.stringify({
        role: "developer",
        level: "warn",
        from: "deepseek-v4-flash",
        to: "mimo-v2.5-pro",
      }),
    },
  ];
}

export function buildDemoAudit(now) {
  return [
    {
      id: 10,
      at: new Date(now - 28 * 60 * 1000).toISOString(),
      actor: "human:op-1",
      action: "plan.replan_requested",
      detail_json: JSON.stringify({
        feedback:
          "Split the rollout check from the migration task and make the rollback path explicit.",
      }),
    },
    {
      id: 9,
      at: new Date(now - 12 * 1000).toISOString(),
      actor: "svc:colonyd",
      action: "run.start",
      detail_json: JSON.stringify({ kind: "merge_gate" }),
    },
    {
      id: 8,
      at: new Date(now - 4 * 60 * 1000).toISOString(),
      actor: "agent:run-rev-1",
      action: "review.approved",
      detail_json: "{}",
    },
    {
      id: 7,
      at: new Date(now - 20 * 60 * 1000).toISOString(),
      actor: "svc:colonyd",
      action: "mr.merged",
      detail_json: "{}",
    },
  ];
}
