import { Pool, type PoolConfig } from "pg";

export const COLONY_DB_PACKAGE = "@colony/db" as const;

export type ColonyDbRole = "colony_writer" | "colony_reader";

export interface CreatePoolOptions extends PoolConfig {
  /**
   * If set, every connection in the pool runs `SET ROLE <role>` immediately
   * after connect. The Task Graph API uses `colony_writer`; the Web UI query
   * path uses `colony_reader`. Audit-log immutability relies on this.
   */
  readonly role?: ColonyDbRole;
}

export function createPool(opts: CreatePoolOptions = {}): Pool {
  const { role, ...config } = opts;
  const pool = new Pool(config);
  if (role) {
    pool.on("connect", (client) => {
      void client.query(`SET ROLE ${role}`);
    });
  }
  return pool;
}

export type { Pool, PoolConfig } from "pg";
