-- COL-1.1c/e/f: durable provider bot registry and namespace scoping.

ALTER TABLE provider_identities
  ADD COLUMN IF NOT EXISTS provider_username text,
  ADD COLUMN IF NOT EXISTS token_fingerprint text,
  ADD COLUMN IF NOT EXISTS allowed_namespaces text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

CREATE INDEX IF NOT EXISTS provider_identities_role_idx
  ON provider_identities (provider, role)
  WHERE disabled_at IS NULL;
