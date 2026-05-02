import { fail, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import {
  apiConfigFromEnv,
  createApiClient,
  type ApiError,
  type OAuthProviderSummary,
} from "$lib/api";
import type { ProviderProject } from "@colony/domain";

/**
 * COL-2.14d — admin OAuth provider connection page.
 *
 * Loader hits GET /admin/providers, which is capability-gated by
 * provider.oauth.connect; on 403 we render an explicit access-denied
 * notice rather than failing the entire page.
 *
 * Form actions wrap the same admin API endpoints. Each one renders the
 * same page with `error` / `notice` banners; the UI does not block on a
 * long-running OAuth round-trip. `start` returns a session_id and authorize_url
 * synchronously, the operator opens the URL in a new window, and Pi persists
 * credentials when its localhost callback succeeds. The submit form remains as
 * a fallback for providers that require manual code entry.
 */

export const load: PageServerLoad = async ({ fetch }) => {
  const cfg = apiConfigFromEnv(process.env);
  const api = createApiClient({ ...cfg, fetch });
  let providers: readonly OAuthProviderSummary[] = [];
  let projects: readonly ProviderProject[] = [];
  let error: string | null = null;
  let denied = false;
  try {
    [providers, projects] = await Promise.all([
      api.listOAuthProviders(),
      api.listProviderProjects().catch(() => []),
    ]);
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 403) denied = true;
    else error = err.message ? `${err.code}: ${err.message}` : String(e);
  }
  return { providers, projects, error, denied };
};

export const actions: Actions = {
  registerProject: async ({ request, fetch }) => {
    const cfg = apiConfigFromEnv(process.env);
    const api = createApiClient({ ...cfg, fetch });
    const form = await request.formData();
    const path = String(form.get("path") ?? "").trim();
    const providerId = String(form.get("provider_id") ?? "").trim();
    const defaultBranch = String(form.get("default_branch") ?? "").trim();
    const visibility = String(form.get("visibility") ?? "").trim();
    if (!path) {
      return fail(400, {
        action: "registerProject",
        error: "path is required",
      });
    }
    try {
      const project = await api.registerProviderProject({
        path,
        provider_id: providerId || undefined,
        default_branch: defaultBranch || undefined,
        visibility:
          visibility === "private" ||
          visibility === "internal" ||
          visibility === "public"
            ? visibility
            : undefined,
      });
      return {
        action: "registerProject" as const,
        notice: `Registered ${project.provider}:${project.path}.`,
      };
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status || 500, {
        action: "registerProject",
        error: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
  },

  start: async ({ request, fetch }) => {
    const cfg = apiConfigFromEnv(process.env);
    const api = createApiClient({ ...cfg, fetch });
    const form = await request.formData();
    const providerKey = String(form.get("provider_key") ?? "").trim();
    if (!providerKey) {
      return fail(400, { action: "start", error: "missing provider_key" });
    }
    try {
      const result = await api.beginOAuthSession(providerKey);
      return {
        action: "start" as const,
        provider_key: providerKey,
        session_id: result.session_id,
        authorize_url: result.authorize_url,
        instructions: result.instructions ?? null,
        expires_at: result.expires_at,
      };
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status || 500, {
        action: "start",
        provider_key: providerKey,
        error: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
  },

  submit: async ({ request, fetch }) => {
    const cfg = apiConfigFromEnv(process.env);
    const api = createApiClient({ ...cfg, fetch });
    const form = await request.formData();
    const providerKey = String(form.get("provider_key") ?? "").trim();
    const sessionId = String(form.get("session_id") ?? "").trim();
    const code = extractCode(String(form.get("code") ?? ""));
    if (!providerKey || !sessionId || !code) {
      return fail(400, {
        action: "submit",
        error: "provider_key, session_id, and code are all required",
      });
    }
    try {
      const result = await api.submitOAuthCode(providerKey, sessionId, code);
      return {
        action: "submit" as const,
        provider_key: providerKey,
        notice: `Connected. Granted at ${result.granted_at}.`,
      };
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status || 500, {
        action: "submit",
        provider_key: providerKey,
        session_id: sessionId,
        error: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
  },

  cancel: async ({ request, fetch }) => {
    const cfg = apiConfigFromEnv(process.env);
    const api = createApiClient({ ...cfg, fetch });
    const form = await request.formData();
    const providerKey = String(form.get("provider_key") ?? "").trim();
    const sessionId = String(form.get("session_id") ?? "").trim();
    if (!providerKey || !sessionId) {
      return fail(400, { action: "cancel", error: "missing fields" });
    }
    try {
      await api.cancelOAuthSession(providerKey, sessionId);
      return {
        action: "cancel" as const,
        provider_key: providerKey,
        notice: "Session canceled.",
      };
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status || 500, {
        action: "cancel",
        provider_key: providerKey,
        error: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
  },

  revoke: async ({ request, fetch }) => {
    const cfg = apiConfigFromEnv(process.env);
    const api = createApiClient({ ...cfg, fetch });
    const form = await request.formData();
    const providerKey = String(form.get("provider_key") ?? "").trim();
    if (!providerKey) {
      return fail(400, { action: "revoke", error: "missing provider_key" });
    }
    try {
      await api.revokeOAuthConnection(providerKey);
      return {
        action: "revoke" as const,
        provider_key: providerKey,
        notice: "Connection revoked.",
      };
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status || 500, {
        action: "revoke",
        provider_key: providerKey,
        error: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
  },
};

/**
 * Pi's per-provider OAuth fallback may ask the operator to paste
 * `http://localhost:1455/auth/callback?code=...&state=...`. Accept either the
 * full callback URL or just the code.
 */
function extractCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      return url.searchParams.get("code") ?? "";
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
