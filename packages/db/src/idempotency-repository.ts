import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ActorId } from "@colony/domain";

export interface CachedIdempotentResponse {
  readonly route_fingerprint: string;
  readonly status_code: number;
  readonly response_json: unknown;
}

/**
 * Deduplicate mutating task-graph API calls (COL-0.9).
 */
export class IdempotencyRepository {
  constructor(private readonly pool: Pool) {}

  async withActorKeyLock<T>(
    actor: ActorId,
    idempotencyKey: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${actor}:${idempotencyKey}`],
      );
      const result = await work();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // best effort; original error surfaces below
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getCached(
    actor: ActorId,
    idempotencyKey: string,
  ): Promise<CachedIdempotentResponse | null> {
    const { rows } = await this.pool.query<{
      route_fingerprint: string;
      status_code: number;
      response_json: unknown;
    }>(
      `SELECT route_fingerprint, status_code, response_json FROM idempotency_keys
       WHERE actor_id = $1 AND idempotency_key = $2`,
      [actor, idempotencyKey],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      route_fingerprint: r.route_fingerprint,
      status_code: r.status_code,
      response_json: r.response_json,
    };
  }

  async store(
    actor: ActorId,
    idempotencyKey: string,
    routeFingerprint: string,
    status_code: number,
    response_json: unknown,
  ): Promise<void> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO idempotency_keys
         (id, actor_id, idempotency_key, route_fingerprint, status_code, response_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        id,
        actor,
        idempotencyKey,
        routeFingerprint,
        status_code,
        JSON.stringify(response_json),
      ],
    );
  }
}
