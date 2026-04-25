-- COL-1.1a: only the human operator/admin may run provider bootstrap.
INSERT INTO capability_grants (
  id, actor, role, capability, scope_id, task_id, granted_by
)
VALUES (
  'cgr-hm-05',
  'human:op-1',
  'human',
  'provider.admin.bootstrap',
  NULL,
  NULL,
  'human:op-1'
)
ON CONFLICT (id) DO NOTHING;
