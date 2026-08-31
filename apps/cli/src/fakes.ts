/** Shared harness for command tests: a fake client and captured stdout. */

import type { ColonyClient } from "./client.js";

type Method = "get" | "post" | "put";

export interface RecordedCall {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export type Responder = (
  call: RecordedCall,
) => unknown | Promise<unknown> | Response | Promise<Response>;

/** A route that always answers with the same JSON payload. */
export function json(body: unknown): Responder {
  return () => structuredClone(body);
}

/** A route that answers with a raw HTTP response (artifact downloads). */
export function response(res: Response): Responder {
  return () => res.clone();
}

/** Fake ColonyClient: routes by method+path, records every call. */
export function fakeClient(routes: Record<string, Responder>): {
  client: ColonyClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const dispatch = async (
    method: Method,
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<unknown> => {
    calls.push({ method, path, query, body });
    const responder = routes[`${method} ${path}`];
    if (!responder) throw new Error(`no fake route for ${method} ${path}`);
    return responder({ method, path, query, body });
  };

  return {
    calls,
    client: {
      baseUrl: "https://colony.test",
      get: <T,>(path: string, query?: Record<string, string | number | undefined>) =>
        dispatch("get", path, query) as Promise<T>,
      post: <T,>(path: string, body?: unknown) => dispatch("post", path, undefined, body) as Promise<T>,
      put: <T,>(path: string, body?: unknown) => dispatch("put", path, undefined, body) as Promise<T>,
      raw: (path: string) => dispatch("get", path) as Promise<Response>,
    },
  };
}

/** Capture stdout writes so a test can assert on the rendered output. */
export function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

export function parseJsonOut(text: string): unknown {
  return JSON.parse(text);
}
