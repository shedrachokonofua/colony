import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import type { ProviderProject, Scope } from "@colony/domain";
import { apiConfigFromEnv, createApiClient, type ApiError } from "$lib/api";

export const load: PageServerLoad = async ({ fetch }) => {
  const cfg = apiConfigFromEnv(process.env);
  const api = createApiClient({ ...cfg, fetch });
  let scopes: readonly Scope[] = [];
  let providerProjects: readonly ProviderProject[] = [];
  let error: string | null = null;
  try {
    [scopes, providerProjects] = await Promise.all([
      api.listScopes(),
      api.listProviderProjects().catch(() => []),
    ]);
  } catch (e) {
    const err = e as ApiError;
    error = err.message ? `${err.code}: ${err.message}` : String(e);
  }
  return { scopes, providerProjects, error };
};

export const actions: Actions = {
  create: async ({ request, fetch }) => {
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const providerProjectId = String(
      form.get("provider_project_id") ?? "",
    ).trim();
    const mirrorScope = form.get("mirror_scope") === "on";
    if (!id || !title) {
      return fail(400, { message: "Scope ID and title are required." });
    }
    const api = createApiClient({ ...apiConfigFromEnv(process.env), fetch });
    try {
      await api.createScope({
        id,
        title,
        description,
        provider_project_id: providerProjectId || undefined,
        mirror_scope: mirrorScope,
      });
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status ?? 500, {
        message: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
    throw redirect(303, `/scopes/${id}`);
  },
};
