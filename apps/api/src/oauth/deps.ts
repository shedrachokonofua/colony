import {
  OAuthCredentialRepository,
  PolicyRepository,
  SecretEncryption,
  TaskGraphRepository,
} from "@colony/db";
import { env, loadColonyConfig } from "@colony/config";
import type { ActorId } from "@colony/domain";
import type { OAuthAdminDeps } from "./admin-routes.js";
import { OAuthSessionManager } from "./session-manager.js";
import { PiOAuthDriver } from "./pi-oauth-driver.js";
import { getPool } from "../db.js";

let singleton: OAuthAdminDeps | undefined;

export function getOAuthAdminDeps(): OAuthAdminDeps {
  if (!singleton) {
    const pool = getPool();
    const cfg = env();
    const oauthRepo = new OAuthCredentialRepository(
      pool,
      SecretEncryption.fromString(secretEncryptionKey(cfg.NODE_ENV)),
    );
    const auditRepo = new TaskGraphRepository(pool);
    const config = loadColonyConfig({
      path: cfg.COLONY_CONFIG_PATH,
      env: process.env,
      agentRuntimeOverride: cfg.AGENT_RUNTIME,
    });
    singleton = {
      config,
      oauthRepo,
      sessionManager: new OAuthSessionManager(
        new PiOAuthDriver({
          onCredentials: async ({
            providerKey,
            providerApi,
            grantedBy,
            credentials,
          }) => {
            const actor = grantedBy as ActorId;
            const meta = await oauthRepo.upsertConnection({
              providerKey,
              providerApi,
              payload: credentials,
              grantedBy,
              expiresAt: credentials.expires
                ? new Date(credentials.expires)
                : null,
            });
            await auditRepo.writeAudit({
              actor,
              action: "provider.oauth.connected",
              capability: "provider.oauth.connect",
              target_kind: "provider_oauth_connection",
              target_id: meta.id,
              reason: "admin_api_callback",
              evidence: {
                provider_key: meta.providerKey,
                provider_api: meta.providerApi,
                expires_at: meta.expiresAt,
              },
            });
          },
        }),
      ),
      policyRepo: new PolicyRepository(pool),
      auditRepo,
    };
  }
  return singleton;
}

function secretEncryptionKey(nodeEnv: string): string | undefined {
  return (
    process.env.COLONY_SECRET_ENCRYPTION_KEY ??
    (nodeEnv === "development" ? "dev-only-not-for-production" : undefined)
  );
}
