// The shell's API client: one fetch wrapper every read and mutation
// round-trips through. Headers carry either the Keycloak bearer token or the
// demo/actor identity; non-JSON bodies come back as raw text; tolerated 404s
// resolve to null. Demo mode serves reads from the offline world and refuses
// writes, so the UI exercises the same code path offline.
import { DEMO, DEMO_READS } from "./demo.js";

/**
 * Build the shell's api() method bound to its reactive state: headers depend
 * on the live auth/actor state, a 401 clears the auth state through
 * saveAuth, and errors surface through the shell's error banner.
 *
 * @param {{
 *   oidc: unknown,
 *   auth: import("./auth.js").Auth | null,
 *   actor: string,
 * }} shell
 * @param {(auth: import("./auth.js").Auth | null) => void} saveAuth
 * @returns {(path: string, options?: {
 *   method?: string,
 *   body?: string,
 *   headers?: Record<string, string>,
 *   notFound?: "null",
 * }) => Promise<any>}
 */
export function createApi(shell, saveAuth) {
  return async function api(path, options = {}) {
    if (DEMO && !DEMO_READS.test(path)) throw new Error("demo");
    const headers = {
      ...(shell.oidc && shell.auth
        ? { Authorization: `Bearer ${shell.auth.token}` }
        : { "X-Actor-Id": shell.actor }),
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
    if (res.status === 401 && shell.oidc && shell.auth) {
      saveAuth(null);
      throw new Error("Signed out — session expired.");
    }
    if (!res.ok) {
      if (options.notFound === "null" && res.status === 404) return null;
      const message =
        data?.error?.message ||
        data?.error?.code ||
        `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    return data;
  };
}
