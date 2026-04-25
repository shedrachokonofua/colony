-- COL-2.14c — Grant `provider.oauth.connect` to the human operator so the
-- admin OAuth flow (Codex / Claude Pro) is reachable from the Web UI. This
-- mirrors the policy.override grant in the seed migration; the capability
-- is intentionally not granted to any agent role.

INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
VALUES
  ('cgr-hm-oauth', 'human:op-1', 'human', 'provider.oauth.connect', NULL, NULL, 'human:op-1');
