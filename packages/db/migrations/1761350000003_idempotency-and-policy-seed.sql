-- Idempotency store for the Task Graph API (COL-0.9) and baseline policy rows
-- with capability/provider mapping (COL-0.8).

-- ---------------------------------------------------------------------------
-- idempotency_keys
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id                  text PRIMARY KEY,
  actor_id            text NOT NULL,
  idempotency_key   text NOT NULL,
  route_fingerprint text NOT NULL,
  status_code        integer NOT NULL,
  response_json      jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idempotency_keys_dedup_idx
  ON idempotency_keys (actor_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- Baseline global policy
-- ---------------------------------------------------------------------------
INSERT INTO policies (
  id, scope, target_id, version,
  protected_paths, security_labels, always_human_review, review_loop_cap, settings
) VALUES (
  'pol-colony-global-1',
  'global',
  NULL,
  1,
  '{}',
  '{}',
  false,
  3,
  '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Provider identities (Colony / internal; GitLab uses its own in production)
-- ---------------------------------------------------------------------------
INSERT INTO provider_identities (actor, provider, provider_user_id, role, is_bot)
VALUES
  ('svc:supervisor', 'colony', '1', 'supervisor', true),
  ('agent:dev-1', 'colony', '2', 'developer', true),
  ('human:op-1', 'colony', '3', 'human', false);

-- ---------------------------------------------------------------------------
-- Capability grants (scope_id NULL = all scopes; COL-0.8 minimal)
-- ---------------------------------------------------------------------------
-- Supervisor (service) — full graph
INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
VALUES
  ('cgr-sv-01', 'svc:supervisor', 'supervisor', 'graph.read', NULL, NULL, 'human:op-1'),
  ('cgr-sv-02', 'svc:supervisor', 'supervisor', 'graph.write', NULL, NULL, 'human:op-1'),
  ('cgr-sv-03', 'svc:supervisor', 'supervisor', 'task.claim', NULL, NULL, 'human:op-1');

-- Human operator
INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
VALUES
  ('cgr-hm-01', 'human:op-1', 'human', 'graph.read', NULL, NULL, 'human:op-1'),
  ('cgr-hm-02', 'human:op-1', 'human', 'graph.write', NULL, NULL, 'human:op-1'),
  ('cgr-hm-03', 'human:op-1', 'human', 'task.claim', NULL, NULL, 'human:op-1'),
  ('cgr-hm-04', 'human:op-1', 'human', 'policy.override', NULL, NULL, 'human:op-1');

-- Developer agent — read/claim but never graph.write (enforced in policy engine too)
INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
VALUES
  ('cgr-dv-01', 'agent:dev-1', 'developer', 'graph.read', NULL, NULL, 'human:op-1'),
  ('cgr-dv-02', 'agent:dev-1', 'developer', 'task.claim', NULL, NULL, 'human:op-1');
