// The demo world's Running-tab fixtures: the project's in-flight rows plus
// the detail payloads of the scopes that own them, so activating a row
// offline lands on a sheet that actually contains the task. Lives apart from
// demo-data.js because the rows are their own surface, not part of the
// project/scope fixtures the rest of the world is built from.

/**
 * The Running tab's rows for the demo project: the tasks still in flight,
 * each with its live run. Two rows by design — one running, one past its run
 * (mr_open) — so the surface shows both shapes offline.
 *
 * @param {number} now
 * @param {readonly import("./demo-data.d.ts").DemoScope[]} scopes
 */
export function buildDemoRunning(now, scopes) {
  const [scope0, scope1] = scopes;
  const runningTask = {
    id: `${scope0.id}.1`,
    scope_id: scope0.id,
    title: `Land ${scope0.title.toLowerCase()}`,
    spec: "",
    state: "running",
    state_version: 2,
    branch: `colony/${scope0.id}.1`,
    mr_iid: null,
    attempt: 1,
    next_retry_at: null,
    blocked_reason: null,
    created_at: scope0.created_at,
    updated_at: new Date(now - 45 * 1000).toISOString(),
  };
  const mrOpenTask = {
    id: `${scope1.id}.0`,
    scope_id: scope1.id,
    title: `Land ${scope1.title.toLowerCase()}`,
    spec: "",
    state: "mr_open",
    state_version: 3,
    branch: `colony/${scope1.id}.0`,
    mr_iid: 41,
    attempt: 1,
    next_retry_at: null,
    blocked_reason: null,
    created_at: scope1.created_at,
    updated_at: scope1.updated_at,
  };
  const runningRun = {
    id: "run-demo-running-1",
    scope_id: scope0.id,
    task_id: runningTask.id,
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
    entries: [
      {
        scope_id: scope0.id,
        scope_title: scope0.title,
        task_id: runningTask.id,
        task_title: runningTask.title,
        task_state: runningTask.state,
        attempt: runningTask.attempt,
        run: runningRun,
      },
      {
        scope_id: scope1.id,
        scope_title: scope1.title,
        task_id: mrOpenTask.id,
        task_title: mrOpenTask.title,
        task_state: mrOpenTask.state,
        attempt: mrOpenTask.attempt,
        run: null,
      },
    ],
    details: {
      [scope0.id]: {
        scope: scope0,
        tasks: [runningTask],
        deps: [],
        runs: [runningRun],
      },
      [scope1.id]: {
        scope: scope1,
        tasks: [mrOpenTask],
        deps: [],
        runs: [],
      },
    },
  };
}
