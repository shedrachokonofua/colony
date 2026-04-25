import type { LayoutServerLoad } from "./$types";
import { apiConfigFromEnv } from "$lib/api";

export const load: LayoutServerLoad = () => {
  const { baseUrl, actor } = apiConfigFromEnv(process.env);
  return { apiBase: baseUrl, actor };
};
