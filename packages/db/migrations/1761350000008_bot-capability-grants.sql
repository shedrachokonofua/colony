-- COL-1.1d: default per-bot capability grants.

INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
VALUES
  ('cgr-bot-engine-issues-create', 'bot:engine', 'developer', 'provider.issues.create', NULL, NULL, 'human:op-1'),
  ('cgr-bot-engine-issues-update', 'bot:engine', 'developer', 'provider.issues.update', NULL, NULL, 'human:op-1'),
  ('cgr-bot-engine-issues-comment', 'bot:engine', 'developer', 'provider.issues.comment', NULL, NULL, 'human:op-1'),
  ('cgr-bot-engine-mr-open', 'bot:engine', 'developer', 'provider.mr.open', NULL, NULL, 'human:op-1'),
  ('cgr-bot-engine-branches-push', 'bot:engine', 'developer', 'provider.branches.push', NULL, NULL, 'human:op-1'),
  ('cgr-bot-engine-commits-read', 'bot:engine', 'developer', 'provider.commits.read', NULL, NULL, 'human:op-1'),
  ('cgr-bot-reviewer-issues-comment', 'bot:reviewer', 'reviewer', 'provider.issues.comment', NULL, NULL, 'human:op-1'),
  ('cgr-bot-reviewer-mr-approve', 'bot:reviewer', 'reviewer', 'provider.mr.approve', NULL, NULL, 'human:op-1'),
  ('cgr-bot-reviewer-mr-comment', 'bot:reviewer', 'reviewer', 'provider.mr.comment', NULL, NULL, 'human:op-1'),
  ('cgr-bot-reviewer-mr-thread', 'bot:reviewer', 'reviewer', 'provider.mr.review_thread', NULL, NULL, 'human:op-1'),
  ('cgr-bot-architect-graph-write', 'bot:architect', 'architect', 'graph.write', NULL, NULL, 'human:op-1'),
  ('cgr-bot-architect-issues-create', 'bot:architect', 'architect', 'provider.issues.create', NULL, NULL, 'human:op-1'),
  ('cgr-bot-architect-epics-create', 'bot:architect', 'architect', 'provider.epics.create', NULL, NULL, 'human:op-1'),
  ('cgr-bot-architect-epics-update', 'bot:architect', 'architect', 'provider.epics.update', NULL, NULL, 'human:op-1'),
  ('cgr-bot-architect-epics-close', 'bot:architect', 'architect', 'provider.epics.close', NULL, NULL, 'human:op-1'),
  ('cgr-bot-integrator-mr-merge', 'bot:integrator', 'integrator', 'provider.mr.merge', NULL, NULL, 'human:op-1'),
  ('cgr-bot-integrator-branches-protect', 'bot:integrator', 'integrator', 'provider.branches.protect', NULL, NULL, 'human:op-1'),
  ('cgr-bot-integrator-pipelines-read', 'bot:integrator', 'integrator', 'provider.pipelines.read', NULL, NULL, 'human:op-1'),
  ('cgr-bot-integrator-pipelines-trigger', 'bot:integrator', 'integrator', 'provider.pipelines.trigger', NULL, NULL, 'human:op-1'),
  ('cgr-bot-memory-issues-update', 'bot:memory_consolidator', 'memory_consolidator', 'provider.issues.update', NULL, NULL, 'human:op-1'),
  ('cgr-bot-memory-issues-addlabel', 'bot:memory_consolidator', 'memory_consolidator', 'provider.issues.addLabel', NULL, NULL, 'human:op-1'),
  ('cgr-bot-memory-issues-removelabel', 'bot:memory_consolidator', 'memory_consolidator', 'provider.issues.removeLabel', NULL, NULL, 'human:op-1'),
  ('cgr-bot-supervisor-graph-write', 'bot:supervisor', 'supervisor', 'graph.write', NULL, NULL, 'human:op-1'),
  ('cgr-bot-supervisor-audit-write', 'bot:supervisor', 'supervisor', 'audit.write', NULL, NULL, 'human:op-1')
ON CONFLICT (id) DO NOTHING;
