import pg from "pg";
import { env } from "@colony/config";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env().DATABASE_URL });
  }
  return pool;
}

export async function pingDatabase(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const result = await getPool().query<{ version: string }>("SELECT version() as version");
    return { ok: true, version: result.rows[0]?.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
