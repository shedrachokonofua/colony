import type { Pool } from "pg";
import type {
  ActorId,
  Capability,
  Policy,
  PolicyId,
  PolicyScope,
  ProviderIdentity,
  ScopeId,
} from "@colony/domain";
import { CAPABILITIES } from "@colony/domain";

const isCapability = (s: string): s is Capability =>
  (CAPABILITIES as readonly string[]).includes(s);

interface PolicyRow {
  id: string;
  scope: string;
  target_id: string | null;
  version: number;
  protected_paths: string[];
  security_labels: string[];
  always_human_review: boolean;
  review_loop_cap: number;
  settings: Record<string, unknown>;
  created_at: Date;
}

const toIso = (d: Date): string => d.toISOString();

function mapPolicyRow(
  r: PolicyRow,
  scope: PolicyScope,
  target: Policy["target_id"],
  id: PolicyId,
  version: number,
): Policy {
  return {
    id,
    scope,
    target_id: target,
    version,
    protected_paths: r.protected_paths,
    security_labels: r.security_labels,
    always_human_review: r.always_human_review,
    review_loop_cap: r.review_loop_cap,
    settings: r.settings,
    created_at: toIso(r.created_at),
  };
}

/**
 * Policy materialization for a scope (COL-0.8).
 * `getEffectivePolicy` returns the scope row when one exists, otherwise the
 * global row — it does **not** field-merge a scope row on top of global.
 */
export class PolicyRepository {
  constructor(private readonly pool: Pool) {}

  async getGlobalPolicy(): Promise<Policy> {
    const { rows: g } = await this.pool.query<PolicyRow>(
      `SELECT * FROM policies
       WHERE scope = 'global' AND target_id IS NULL
       ORDER BY version DESC
       LIMIT 1`,
    );
    const global = g[0];
    if (!global) {
      throw new Error("missing global policy row");
    }
    return mapPolicyRow(
      global,
      "global",
      undefined,
      global.id as PolicyId,
      global.version,
    );
  }

  /**
   * Effective policy for a scope: the scope-specific row when present, otherwise global.
   */
  async getEffectivePolicy(scopeId: ScopeId): Promise<Policy> {
    const { rows: s } = await this.pool.query<PolicyRow>(
      `SELECT * FROM policies
       WHERE scope = 'scope' AND target_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [scopeId],
    );
    const sc = s[0];
    if (sc) {
      return mapPolicyRow(sc, "scope", scopeId, sc.id as PolicyId, sc.version);
    }
    return this.getGlobalPolicy();
  }

  /**
   * Grants the actor can use in the given scope: global (scope_id NULL) or
   * scope-targeted rows.
   */
  async getCapabilityGrantsForActor(
    actor: ActorId,
    scopeId: ScopeId | null,
  ): Promise<ReadonlySet<Capability>> {
    const params: unknown[] = [actor];
    let whereScope = "scope_id IS NULL";
    if (scopeId !== null) {
      params.push(scopeId);
      whereScope = `(scope_id IS NULL OR scope_id = $2)`;
    }
    const { rows } = await this.pool.query<{ capability: string }>(
      `SELECT capability FROM capability_grants
       WHERE actor = $1
         AND (expires_at IS NULL OR expires_at > now())
         AND task_id IS NULL
         AND ${whereScope}`,
      params,
    );
    const set = new Set<Capability>();
    for (const r of rows) {
      if (isCapability(r.capability)) {
        set.add(r.capability);
      }
    }
    return set;
  }

  /**
   * Default provider is `colony` for the internal / seeded identity table.
   */
  async getProviderIdentity(
    actor: ActorId,
    provider: string = "colony",
  ): Promise<ProviderIdentity | null> {
    const { rows } = await this.pool.query<{
      actor: string;
      provider: string;
      provider_user_id: string;
      role: ProviderIdentity["role"];
      is_bot: boolean;
    }>(
      `SELECT actor, provider, provider_user_id, role, is_bot
       FROM provider_identities
       WHERE actor = $1 AND provider = $2`,
      [actor, provider],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      actor: r.actor as ActorId,
      provider: r.provider,
      provider_user_id: r.provider_user_id,
      role: r.role,
      is_bot: r.is_bot,
    };
  }
}
