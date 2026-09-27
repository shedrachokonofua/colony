---
name: colony
description: Operate the Colony agent factory — open and drive scopes (goals decomposed into plans, tasks, runs, merge requests), approve or reject plans, pause/resume/abandon work, unblock stuck tasks, and diagnose failed runs or model problems. Use when a user asks about Colony, scopes, tasks, runs, plans, merge requests from agents, blocked factory work, factory operations, or investigating run/model failures in the Aether environment.
---

# Colony

Colony runs software work as a factory. Mental model:

**project → scope → plan → tasks → runs → MR → merge**

- A **project** groups related work. Its brief (Markdown) and reference
  files are handed to every agent working under it.
- A **scope** is one goal against one repository. An architect agent
  decomposes it into a **plan**: a dependency-ordered graph of tasks.
- The plan waits for operator approval. Approving materializes the tasks;
  rejecting with feedback sends the architect back to revise.
- Each **task** is delivered as a merge request. A task walks
  `queued → running → mr_open → merged`; `blocked` and `canceled` are
  recoverable by the operator.
- A **run** is one agent invocation (architect, implement, review,
  merge_gate, validate, plan_review). Runs emit events and artifacts.
- When every task is merged, the scope is **validated** against its
  acceptance checks and becomes `done`.

Exact states and legal transitions: [references/lifecycle.md](references/lifecycle.md).

## Interfaces

The same HTTP API behind everything; pick by agent kind:

- **CLI `colony`** (shell agents, humans): exact syntax lives in
  `colony --help`, not here.
- **MCP `/mcp`** (tool-only agents): exact parameters live in `tools/list`.
  `colony_guide(topic)` returns this file and the references; the same text
  is served as `skill://colony/...` resources.

## Golden workflow

1. **Survey.** `colony_status` (CLI: `colony status`) — plan approvals
   waiting, merges awaiting sign-off, blocked work, live/stalled runs.
2. **Read before acting.** `get_scope` → `get_task` → `get_run` →
   `run_events`. Never act on an ID you have not just read.
3. **Act.** `approve_plan` / `replan`, `scope_action`, `task_action`
   (CLI: `colony approve`, `colony replan`, `colony pause`, `colony task`).
4. **Verify.** Re-read the entity; the new state and the audit trail are
   the proof, not the tool's return.

Procedures: [references/playbooks.md](references/playbooks.md).

## Safety rules

- State guards refuse stale actions with `409 CONFLICT`. Re-read, then
  decide — never blindly retry.
- `abandon` (scope) and `cancel` (task) **discard work permanently**.
  `pause` is the reversible hold; prefer it.
- `approve_plan` starts real work and real spend. Approve only what the
  user asked for.
- Unblock a task only with run/event evidence that its blocker is gone —
  not because time passed. See
  [references/investigation.md](references/investigation.md) for the
  deployment-to-revival gate.
- Everything is audited under your identity. Report exact IDs
  (`col-d4bed30a`, `col-d4bed30a.7`, run IDs) in your answers.

## Deploying Colony itself

Rolling out a new colonyd to Aether is a strictly IaC procedure —
never `kubectl set image`. See [references/deploy.md](references/deploy.md).
