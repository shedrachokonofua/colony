import type { PageServerLoad } from "./$types";

type HealthBody = {
  ok: boolean;
  service: string;
  db: { ok: boolean; version?: string; error?: string };
};

const API_BASE =
  process.env["COLONY_API_URL"] ??
  `http://localhost:${process.env["API_PORT"] ?? 4000}`;

export const load: PageServerLoad = async ({ fetch }) => {
  let status: number | null = null;
  let body: HealthBody | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(`${API_BASE}/health`);
    status = res.status;
    body = (await res.json()) as HealthBody;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { apiBase: API_BASE, status, body, error };
};
