import { createPool, type Pool } from "@colony/db";
import { env } from "@colony/config";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      connectionString: env().DATABASE_URL,
      role: "colony_writer",
    });
  }
  return pool;
}

export async function pingDatabase(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const result = await getPool().query<{ version: string }>(
      "SELECT version() as version",
    );
    return { ok: true, version: result.rows[0]?.version };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
