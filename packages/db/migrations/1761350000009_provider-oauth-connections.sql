-- COL-2.14b — OAuth credential store for provider runtimes (Pi: Codex, Claude
-- Pro). Tokens never live in code, env vars, or YAML; the admin-API OAuth
-- callback writes them here, encrypted at rest with the worker's master key
-- (AES-256-GCM, see packages/agent-runtime/src/secret-encryption.ts).
--
-- The token blob format is opaque to Postgres — Pi's AuthStorage shape lives
-- inside the ciphertext. The repository layer never logs the plaintext.
--
-- One active connection per provider key (e.g. one row for openai_codex). A
-- reconnect REPLACES the row; the old ciphertext is gone after commit.

CREATE TABLE provider_oauth_connections (
  id              text PRIMARY KEY,
  provider_key    text NOT NULL,
  provider_api    text NOT NULL CHECK (provider_api IN (
                    'anthropic-messages', 'openai-completions',
                    'openai-responses', 'openai-codex-responses',
                    'azure-openai-responses', 'google-generative-ai',
                    'google-gemini-cli', 'google-vertex',
                    'mistral-conversations', 'bedrock-converse-stream'
                  )),
  ciphertext      bytea NOT NULL,                  -- AES-256-GCM IV || tag || body
  status          text NOT NULL CHECK (status IN (
                    'active', 'expired', 'revoked'
                  )) DEFAULT 'active',
  -- granted_by is the operator ActorId (e.g. 'human:op-1'); not a FK because
  -- audit-log and capability_grants treat actor as an opaque string and
  -- provider_identities is keyed on (actor, provider), not actor alone.
  granted_by      text NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  refreshed_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz
);

-- Only one row per provider key is allowed in a non-revoked state. The admin
-- API's reconnect flow deletes the prior row before inserting the new one.
CREATE UNIQUE INDEX provider_oauth_connections_active_idx
  ON provider_oauth_connections (provider_key)
  WHERE status <> 'revoked';

CREATE INDEX provider_oauth_connections_expiry_idx
  ON provider_oauth_connections (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

-- Grant the writer role normal CRUD; reads happen through the writer too
-- (audit logs and broker reads run inside writer transactions).
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_oauth_connections
  TO colony_writer;

-- The reader role intentionally has NO SELECT on this table — operators with
-- read-only access cannot exfiltrate ciphertext. The admin API uses the
-- writer role for the connect/callback/revoke flow.
REVOKE ALL ON provider_oauth_connections FROM colony_reader;

-- A short-lived OAuth state table holds CSRF state tokens issued during the
-- /oauth/start step. Rows are TTL'd (15 minutes) by the admin API before it
-- reads them on /oauth/callback; expired rows are also reaped by the
-- existing idempotency-retention sweep extended in 2.14c.
CREATE TABLE provider_oauth_pending_state (
  state_token   text PRIMARY KEY,
  provider_key  text NOT NULL,
  initiator     text NOT NULL,                     -- ActorId
  redirect_uri  text NOT NULL,
  pkce_verifier text,                              -- when PKCE is used
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX provider_oauth_pending_state_expiry_idx
  ON provider_oauth_pending_state (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON provider_oauth_pending_state
  TO colony_writer;
REVOKE ALL ON provider_oauth_pending_state FROM colony_reader;
