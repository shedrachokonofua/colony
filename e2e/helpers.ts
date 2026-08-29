import { expect, type APIRequestContext } from "@playwright/test";

const ACTOR = "human:op-1";
const HEADERS = { "X-Actor-Id": ACTOR };

export async function createScopeViaApi(
  request: APIRequestContext,
  opts: {
    title?: string;
    goal: string;
    approvals?: "manual" | "auto";
    project?: string;
  },
): Promise<string> {
  const res = await request.post("/scopes", {
    headers: HEADERS,
    data: {
      goal: opts.goal,
      ...(opts.title ? { title: opts.title } : {}),
      approvals: opts.approvals ?? "manual",
      repo: { path: "so/console-e2e" },
      ...(opts.project ? { project: opts.project } : {}),
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.id as string;
}

export async function createProjectViaApi(
  request: APIRequestContext,
  opts: { name: string; context_doc?: string },
): Promise<void> {
  const res = await request.post("/projects", {
    headers: HEADERS,
    data: {
      name: opts.name,
      ...(opts.context_doc ? { context_doc: opts.context_doc } : {}),
    },
  });
  expect(res.ok(), `POST /projects ${res.status()} ${await res.text()}`).toBe(
    true,
  );
}

export async function createProjectFileViaApi(
  request: APIRequestContext,
  name: string,
  opts: { filename: string; media_type: string; content: string },
): Promise<string> {
  const res = await request.post(
    `/projects/${encodeURIComponent(name)}/files`,
    {
      headers: HEADERS,
      data: {
        filename: opts.filename,
        media_type: opts.media_type,
        content: opts.content,
      },
    },
  );
  expect(res.ok(), `POST files ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { file: { id: string } };
  return body.file.id as string;
}

export async function waitForPlan(
  request: APIRequestContext,
  scopeId: string,
  timeoutMs = 30000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get(`/scopes/${encodeURIComponent(scopeId)}`, {
          headers: HEADERS,
        });
        if (!r.ok()) return null;
        const data = (await r.json()) as {
          scope: { status: string; plan_json: string | null };
        };
        return data.scope.status === "planning" && data.scope.plan_json
          ? data.scope.plan_json
          : null;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .not.toBeNull();
}

export async function createScopeViaApiAndWaitForPlan(
  request: APIRequestContext,
  opts: { title?: string; goal: string; approvals?: "manual" | "auto" },
  timeoutMs = 30000,
): Promise<string> {
  const id = await createScopeViaApi(request, opts);
  await waitForPlan(request, id, timeoutMs);
  return id;
}

export async function waitForScopeStatus(
  request: APIRequestContext,
  scopeId: string,
  status: string,
  timeoutMs = 30000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get(`/scopes/${encodeURIComponent(scopeId)}`, {
          headers: HEADERS,
        });
        if (!r.ok()) return "";
        const data = (await r.json()) as { scope: { status: string } };
        return data.scope.status;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBe(status);
}

export async function waitForTaskState(
  request: APIRequestContext,
  scopeId: string,
  state: string,
  timeoutMs = 30000,
): Promise<string> {
  let found = "";
  await expect
    .poll(
      async () => {
        const r = await request.get(`/scopes/${encodeURIComponent(scopeId)}`, {
          headers: HEADERS,
        });
        if (!r.ok()) return "";
        const data = (await r.json()) as {
          tasks: { id: string; state: string }[];
        };
        const t = data.tasks.find((x) => x.state === state);
        if (t) found = t.id;
        return t ? t.state : "";
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBe(state);
  return found;
}

export async function pollScope(
  request: APIRequestContext,
  scopeId: string,
): Promise<{
  scope: { status: string; plan_json: string | null; id: string };
  tasks: { id: string; state: string }[];
  runs: {
    kind: string;
    status: string;
    evidence_json: string | null;
    task_id: string | null;
  }[];
}> {
  const r = await request.get(`/scopes/${encodeURIComponent(scopeId)}`, {
    headers: HEADERS,
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as {
    scope: { status: string; plan_json: string | null; id: string };
    tasks: { id: string; state: string }[];
    runs: {
      kind: string;
      status: string;
      evidence_json: string | null;
      task_id: string | null;
    }[];
  };
}

const CONTROL_PORT = process.env.COLONY_E2E_CONTROL_PORT ?? "4478";
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;

export async function controlPatch(
  request: APIRequestContext,
  patch: Record<string, unknown>,
): Promise<void> {
  // Use fetch directly so baseURL does not interfere; request fixture can also do absolute URLs
  const res = await request.post(`${CONTROL_URL}/control/script`, {
    data: patch,
  });
  // Fallback to global fetch if request.post to control fails due to baseURL handling
  if (!res.ok()) {
    const f = await fetch(`${CONTROL_URL}/control/script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    expect(f.ok).toBeTruthy();
    return;
  }
  expect(res.ok()).toBeTruthy();
}

/**
 * Restore the shared webServer's scripted knobs to boot defaults. The knobs
 * are process-global, so every test MUST start from a clean script or it
 * inherits stalls/failure modes its predecessors configured - the suite then
 * passes in isolation and fails in the full run.
 */
export async function controlReset(): Promise<void> {
  const res = await fetch(`${CONTROL_URL}/control/reset`, { method: "POST" });
  expect(res.ok).toBeTruthy();
}
