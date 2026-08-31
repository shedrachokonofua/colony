/**
 * The only module in the CLI that performs network I/O. Everything else
 * depends on the ColonyClient interface, so commands stay testable.
 */

export interface ColonyClient {
  baseUrl: string;
  get<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  /** Raw response, for endpoints that return bytes (artifact downloads). */
  raw(path: string): Promise<Response>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function createClient(opts: {
  baseUrl: string;
  token: string;
  actor: string;
}): ColonyClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      "x-actor-id": opts.actor,
      "x-actor": opts.actor,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  const readError = async (res: Response): Promise<never> => {
    const status = res.status;
    let code = `HTTP_${status}`;
    let message = res.statusText || `request failed (${status})`;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    const err = errorBody(parsed);
    if (err) {
      if (typeof err.code === "string" && err.code) code = err.code;
      if (typeof err.message === "string" && err.message) message = err.message;
    }
    throw new ApiError(status, code, message);
  };

  const send = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const res = await request(method, path, body);
    if (!res.ok) return readError(res);
    return (await res.json()) as T;
  };

  return {
    baseUrl,
    get<T>(path: string, query?: Record<string, string | number | undefined>) {
      return send<T>("GET", withQuery(path, query));
    },
    post<T>(path: string, body?: unknown) {
      return send<T>("POST", path, body ?? {});
    },
    put<T>(path: string, body?: unknown) {
      return send<T>("PUT", path, body ?? {});
    },
    async raw(path: string) {
      const res = await request("GET", path);
      if (!res.ok) return readError(res);
      return res;
    },
  };
}

export function withQuery(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function errorBody(
  parsed: unknown,
): { code?: unknown; message?: unknown } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  return error as { code?: unknown; message?: unknown };
}
