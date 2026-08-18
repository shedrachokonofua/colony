export interface HttpResult {
  status: number;
  body: unknown;
}

export async function http(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; actor?: string | null; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.actor !== null) {
    const actor = opts.actor ?? "human:e2e";
    if (actor) headers["X-Actor-Id"] = actor;
  }
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const rawHeaders: Record<string, string> = { ...headers };
  // Allow omitting actor entirely when opts.actor === null: don't send header
  if (opts.actor === null) delete rawHeaders["X-Actor-Id"];

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: rawHeaders,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

/**
 * Raw fetch variant for invalid JSON / bad signature tests.
 * Sends body as raw string so we can test malformed JSON.
 */
export async function httpRaw(
  port: number,
  method: string,
  path: string,
  rawBody: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...extraHeaders };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: rawBody,
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

export async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  budgetMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch (err) {
      // transient
      void label;
      void err;
    }
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
