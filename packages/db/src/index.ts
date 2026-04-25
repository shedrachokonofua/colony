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

type PoolConfigWithAsyncOnConnect = Omit<PoolConfig, "onConnect"> & {
  readonly onConnect?: (
    client: Parameters<NonNullable<PoolConfig["onConnect"]>>[0],
  ) => void | Promise<void>;
};

export function createPool(opts: CreatePoolOptions = {}): Pool {
  const { role, onConnect, ...config } = opts;
  const runUserOnConnect:
    | PoolConfigWithAsyncOnConnect["onConnect"]
    | undefined = onConnect;
  const poolConfig: PoolConfigWithAsyncOnConnect = {
    ...config,
    async onConnect(client) {
      await runUserOnConnect?.(client);
      if (role) {
        await client.query(`SET ROLE ${role}`);
      }
    },
  };
  return new Pool(poolConfig);
}

export type { Pool, PoolConfig } from "pg";

export * from "./errors.js";
export * from "./idempotency-repository.js";
export * from "./policy-repository.js";
export * from "./provider-project-repository.js";
export * from "./repository.js";
export * from "./review-gate-repository.js";
