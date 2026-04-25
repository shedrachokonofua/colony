import type { Pool } from "pg";
import type {
  ActorId,
  Capability,
  Policy,
  PolicyId,
  PolicyScope,
  ProviderIdentity,
  Role,
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

interface ProviderIdentityRow {
  actor: string;
  provider: string;
  provider_user_id: string;
  provider_username: string | null;
  role: ProviderIdentity["role"];
  is_bot: boolean;
  token_fingerprint: string | null;
  allowed_namespaces: string[];
  disabled_at: Date | null;
}

function mapProviderIdentityRow(r: ProviderIdentityRow): ProviderIdentity {
  return {
    actor: r.actor as ActorId,
    provider: r.provider,
    provider_user_id: r.provider_user_id,
    provider_username: r.provider_username ?? undefined,
    role: r.role,
    is_bot: r.is_bot,
    token_fingerprint: r.token_fingerprint ?? undefined,
    allowed_namespaces: r.allowed_namespaces,
    disabled_at: r.disabled_at ? toIso(r.disabled_at) : undefined,
  };
}

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
    const { rows } = await this.pool.query<ProviderIdentityRow>(
      `SELECT actor, provider, provider_user_id, provider_username, role, is_bot,
              token_fingerprint, allowed_namespaces, disabled_at
       FROM provider_identities
       WHERE actor = $1 AND provider = $2
         AND disabled_at IS NULL`,
      [actor, provider],
    );
    const r = rows[0];
    if (!r) return null;
    return mapProviderIdentityRow(r);
  }

  async upsertProviderIdentity(input: {
    readonly actor: ActorId;
    readonly provider: string;
    readonly provider_user_id: string;
    readonly provider_username?: string;
    readonly role: Role;
    readonly is_bot: boolean;
    readonly token_fingerprint?: string;
    readonly allowed_namespaces?: readonly string[];
  }): Promise<ProviderIdentity> {
    const { rows } = await this.pool.query<ProviderIdentityRow>(
      `INSERT INTO provider_identities
         (actor, provider, provider_user_id, provider_username, role, is_bot,
          token_fingerprint, allowed_namespaces, disabled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
       ON CONFLICT (actor, provider) DO UPDATE
       SET provider_user_id = EXCLUDED.provider_user_id,
           provider_username = EXCLUDED.provider_username,
           role = EXCLUDED.role,
           is_bot = EXCLUDED.is_bot,
           token_fingerprint = EXCLUDED.token_fingerprint,
           allowed_namespaces = EXCLUDED.allowed_namespaces,
           disabled_at = NULL
       RETURNING actor, provider, provider_user_id, provider_username, role,
                 is_bot, token_fingerprint, allowed_namespaces, disabled_at`,
      [
        input.actor,
        input.provider,
        input.provider_user_id,
        input.provider_username ?? null,
        input.role,
        input.is_bot,
        input.token_fingerprint ?? null,
        [...(input.allowed_namespaces ?? [])],
      ],
    );
    return mapProviderIdentityRow(rows[0]);
  }

  async listProviderIdentities(
    provider = "gitlab",
  ): Promise<ReadonlyArray<ProviderIdentity>> {
    const { rows } = await this.pool.query<ProviderIdentityRow>(
      `SELECT actor, provider, provider_user_id, provider_username, role, is_bot,
              token_fingerprint, allowed_namespaces, disabled_at
       FROM provider_identities
       WHERE provider = $1
       ORDER BY role, actor`,
      [provider],
    );
    return rows.map(mapProviderIdentityRow);
  }

  async getProviderIdentitiesForRole(
    role: Role,
    provider = "gitlab",
  ): Promise<ReadonlyArray<ProviderIdentity>> {
    const { rows } = await this.pool.query<ProviderIdentityRow>(
      `SELECT actor, provider, provider_user_id, provider_username, role, is_bot,
              token_fingerprint, allowed_namespaces, disabled_at
       FROM provider_identities
       WHERE provider = $1 AND role = $2 AND disabled_at IS NULL
       ORDER BY actor`,
      [provider, role],
    );
    return rows.map(mapProviderIdentityRow);
  }

  async setProviderIdentityAllowedNamespaces(input: {
    readonly actor: ActorId;
    readonly provider: string;
    readonly allowed_namespaces: readonly string[];
  }): Promise<ProviderIdentity | null> {
    const { rows } = await this.pool.query<ProviderIdentityRow>(
      `UPDATE provider_identities
       SET allowed_namespaces = $3
       WHERE actor = $1 AND provider = $2
       RETURNING actor, provider, provider_user_id, provider_username, role,
                 is_bot, token_fingerprint, allowed_namespaces, disabled_at`,
      [input.actor, input.provider, [...input.allowed_namespaces]],
    );
    return rows[0] ? mapProviderIdentityRow(rows[0]) : null;
  }

  async disableProviderIdentity(input: {
    readonly actor: ActorId;
    readonly provider: string;
  }): Promise<ProviderIdentity | null> {
    const { rows } = await this.pool.query<ProviderIdentityRow>(
      `UPDATE provider_identities
       SET disabled_at = now()
       WHERE actor = $1 AND provider = $2
       RETURNING actor, provider, provider_user_id, provider_username, role,
                 is_bot, token_fingerprint, allowed_namespaces, disabled_at`,
      [input.actor, input.provider],
    );
    return rows[0] ? mapProviderIdentityRow(rows[0]) : null;
  }

  async grantCapabilitiesForActor(input: {
    readonly actor: ActorId;
    readonly role: Role;
    readonly capabilities: readonly Capability[];
    readonly granted_by: ActorId;
  }): Promise<void> {
    for (const capability of input.capabilities) {
      await this.pool.query(
        `INSERT INTO capability_grants
           (id, actor, role, capability, scope_id, task_id, granted_by)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          `cgr-${input.actor.replace(/[^a-zA-Z0-9]+/g, "-")}-${capability.replace(/[^a-zA-Z0-9]+/g, "-")}`,
          input.actor,
          input.role,
          capability,
          input.granted_by,
        ],
      );
    }
  }
}
