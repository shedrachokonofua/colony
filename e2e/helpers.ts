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
      title: opts.title ?? opts.goal.slice(0, 120),
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
  const body = (await res.json()) as { id: string };
  return body.id as string;
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

// The exports below run inside the page through page.evaluate: Playwright
// serialises each as source, so none may reference another binding in this
// module — a shared local would be undefined on the far side. The repo's
// tsconfig carries no DOM lib (server code shares it), so each reaches its
// globals through globalThis instead of naming them.

/**
 * Select the first `chars` characters of `selector`'s first text node and
 * return the selected length, or -1 when the host or its text is missing.
 * page.evaluate passes exactly one argument, so the pair travels as a tuple.
 */
export function selectFirstText([selector, chars]: [string, number]): number {
  const view = globalThis as unknown as {
    document: {
      querySelector(selector: string): unknown;
      createTreeWalker(
        root: unknown,
        filter: number,
      ): {
        nextNode(): { length: number } | null;
      };
      createRange(): {
        setStart(node: unknown, offset: number): void;
        setEnd(node: unknown, offset: number): void;
      };
    };
    NodeFilter: { SHOW_TEXT: number };
    getSelection(): {
      removeAllRanges(): void;
      addRange(range: unknown): void;
      toString(): string;
    } | null;
  };
  const host = view.document.querySelector(selector);
  if (!host) return -1;
  const walker = view.document.createTreeWalker(
    host,
    view.NodeFilter.SHOW_TEXT,
  );
  const node = walker.nextNode();
  if (!node) return -1;
  const range = view.document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(chars, node.length));
  const selection = view.getSelection();
  if (!selection) return -1;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString().length;
}

/**
 * Remember the node {@link selectFirstText} selects inside: `selector`'s first
 * text node, stashed on globalThis because page.evaluate serialises this
 * function alone. Whether that exact node is still there is the strictest
 * statement of "the surface was not re-rendered" — it catches a rebuild that
 * restored an equivalent selection, which a length check cannot.
 */
export function markFirstText(selector: string): boolean {
  const view = globalThis as unknown as {
    document: {
      querySelector(selector: string): unknown;
      createTreeWalker(root: unknown, filter: number): { nextNode(): unknown };
    };
    NodeFilter: { SHOW_TEXT: number };
    __colonyProbe?: Map<string, unknown>;
  };
  const host = view.document.querySelector(selector);
  if (!host) return false;
  const node = view.document
    .createTreeWalker(host, view.NodeFilter.SHOW_TEXT)
    .nextNode();
  if (!node) return false;
  if (!view.__colonyProbe) view.__colonyProbe = new Map();
  view.__colonyProbe.set(selector, node);
  return true;
}

/**
 * Whether `selector`'s first text node is still the one {@link markFirstText}
 * stashed, i.e. the subtree was reused rather than rebuilt.
 */
export function firstTextSurvived(selector: string): boolean {
  const view = globalThis as unknown as {
    document: {
      querySelector(selector: string): unknown;
      createTreeWalker(root: unknown, filter: number): { nextNode(): unknown };
    };
    NodeFilter: { SHOW_TEXT: number };
    __colonyProbe?: Map<string, unknown>;
  };
  const host = view.document.querySelector(selector);
  if (!host) return false;
  const node = view.document
    .createTreeWalker(host, view.NodeFilter.SHOW_TEXT)
    .nextNode();
  return Boolean(node) && node === view.__colonyProbe?.get(selector);
}

/** The length of the page's current text selection, or -1. */
export function selectionLength(): number {
  const selection = (
    globalThis as unknown as {
      getSelection(): { toString(): string } | null;
    }
  ).getSelection();
  return selection ? selection.toString().length : -1;
}

/** Whether the named custom element is defined in the page. */
export function customElementDefined(name: string): boolean {
  const registry = (
    globalThis as unknown as {
      customElements: { get(name: string): unknown };
    }
  ).customElements;
  return Boolean(registry.get(name));
}

/**
 * The computed `display`, `gap`, and `align-items` of the first node matching
 * `selector`, or null when it is absent. A run row's layout comes from
 * styles.css, so reading it back is what proves the class is wired to a rule
 * rather than merely present in the markup.
 */
export function computedLayout(selector: string): {
  display: string;
  gap: string;
  align: string;
} | null {
  const view = globalThis as unknown as {
    document: { querySelector(selector: string): unknown };
    getComputedStyle(node: unknown): {
      display: string;
      gap: string;
      alignItems: string;
    };
  };
  const node = view.document.querySelector(selector);
  if (!node) return null;
  const style = view.getComputedStyle(node);
  return {
    display: style.display,
    gap: style.gap,
    align: style.alignItems,
  };
}
