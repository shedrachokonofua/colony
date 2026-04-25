import type { PageServerLoad } from "./$types";
import type { Scope } from "@colony/domain";
import { apiConfigFromEnv, createApiClient, type ApiError } from "$lib/api";

export const load: PageServerLoad = async ({ fetch }) => {
  const cfg = apiConfigFromEnv(process.env);
  const api = createApiClient({ ...cfg, fetch });
  let scopes: readonly Scope[] = [];
  let error: string | null = null;
  try {
    scopes = await api.listScopes();
  } catch (e) {
    const err = e as ApiError;
    error = err.message ? `${err.code}: ${err.message}` : String(e);
  }
  return { scopes, error };
};
