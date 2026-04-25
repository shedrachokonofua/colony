export const ROLES = [
  "human",
  "architect",
  "supervisor",
  "developer",
  "reviewer",
  "integrator",
  "memory_consolidator",
] as const;

export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "graph.read",
  "graph.write",
  "task.claim",
  "task.assign",
  "task.close",
  "provider.comment",
  "provider.issue.update",
  "provider.branch.push",
  "provider.mr.open",
  "provider.mr.approve",
  "provider.mr.merge",
  "memory.candidate.write",
  "memory.write",
  "decision.write",
  "sandbox.exec",
  "tool.call",
  "release.deploy",
  "policy.override",
  "provider.admin.bootstrap",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
