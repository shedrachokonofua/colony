# Colony Spec

An AI software team that executes a unit of work called a **scope**. Agents collaborate over a DAG of tasks, with humans looped in at defined decision points.

## Core Concepts

- **Scope** — a bounded unit of work. Represented as a Colony scope (`col-xxxx`) mirrored to a provider epic/parent issue.
- **Task** — a Colony task (`col-xxxx.N`), mirrored 1:1 to a provider issue. Dependencies live in the Task Graph.
- **Task DAG** — owned by the Task Graph as Supervisor/control-plane state. `ready_tasks(scope_id)` surfaces unblocked work; `claim_task(task_id, assignee)` atomically assigns it.
- **HITL gate** — a checkpoint requiring human approval, surfaced in the provider (issue comment, MR/PR approval, or label).
- **Artifact** — durable output: Task Graph records, provider issues/MRs/PRs/pipelines, branches, commits.

## Layering

Core systems, different jobs:

- **Task Graph (Supervisor graph + durable task memory):** first-party Postgres-backed graph of scopes, tasks, dependencies, assignments, gates, approvals, artifacts, events, and audit log. Agents normally consume Supervisor-issued task/review packets and provider mirrors, not raw graph access.
- **Git provider (collaboration + HITL):** human-visible issues, MRs/PRs, pipelines, approvals, comments. Humans read and write here. GitLab is the initial provider, but Colony talks through a provider adapter so GitHub, Gitea, Forgejo, or other platforms can be added later.
- **Web UI (operator cockpit):** Colony-native surface for supervising scopes, DAGs, runs, memory, decisions, policies, conflicts, and audit. It does not replace provider issue/MR/PR comments as the normal human-agent communication surface.
- **Sync bridge:** a thin adapter keeps Task Graph ↔ provider issues in lockstep (title, description, state, assignee). MRs/PRs and pipeline status flow from the provider back into Task Graph events/audit records.
- **Temporal (durable control plane):** owns workflow state transitions, retries, timers, idempotent event handling, and HITL waits. Large artifacts stay outside workflow history.
- **Release authority:** merge is done by the Developer after approvals; deploy/release actions are handled by a narrow Integrator/Release role when the scope requires them.

## Source of Truth

The system should avoid split-brain by assigning each field to one owner and treating other copies as projections:

| Field / event | Source of truth | Projection |
| --- | --- | --- |
| Task title / description / acceptance criteria | Task Graph, written by Supervisor from approved spec/decomposition | Provider issue + agent task packet |
| Task dependencies / DAG readiness | Task Graph | Provider labels/comments |
| Task assignment | Supervisor via atomic Task Graph claim | Provider assignee + `state:*` label + agent task packet |
| Human discussion / approval comments | Git provider | Task Graph event/audit record |
| MR/PR status / approvals / pipeline status | Git provider | Task Graph event/audit record + task status |
| Scope state | Supervisor workflow | Task Graph scope + provider epic/parent issue |
| Merge action | Developer, after gates pass | Git provider MR/PR + Task Graph event/audit record |
| Deploy / release action | Integrator / Release | Provider release/deploy record + Task Graph event/audit record |

Conflict rule: the owning system wins for ordinary projection drift. Gate, merge, close, approval, or done-state conflicts fail closed and enter reconciliation.

Availability rule: if the git provider is unreachable, Colony freezes new visible workflow and all irreversible actions. Already-claimed agent work may continue internally from the last confirmed task packet, but outputs are marked `pending_sync` and cannot be published, approved, merged, closed, or used to advance the DAG until provider reconciliation succeeds.

## Git Provider Integration

- **Human surface:** a single GitLab project (or group) initially. Humans interact through the active provider surface.
- **Provider adapter:** Colony uses a git-provider interface for issues, comments, review threads, merge requests / pull requests, approvals, branches, commits, pipeline status, labels, and user identity. GitLab is the first adapter, not a hard architectural dependency.
- **Scope mirror → epic / parent issue.** Task mirrors → child issues linked via `Closes #<issue>` on MRs/PRs.
- **Tier assumption:** GitLab Premium/Ultimate is assumed for epics and required MR approval rules in the initial adapter. If unavailable, fall back to parent issues, labels, comments, and Supervisor-enforced merge readiness checks.
- **Agent identity:** each agent runs as a dedicated provider user (bot account) with scoped tokens.
- **Routing:** provider labels (`agent:architect`, `agent:developer`, `state:*`) mirror Task Graph state; the Supervisor writes both sides.
- **Work unit:** one branch + one MR/PR per task, `Closes #<provider-issue>` and references the `col-xxxx.N` ID.
- **Events:** provider webhooks enter a dispatcher that verifies signatures, deduplicates by event/object ID, and signals the relevant Temporal workflow.
- **HITL surfaces:** issue comments (`/approve`, `/changes`), MR/PR approvals, and protected-branch rules.
- **Communication surface:** all human ↔ agent communication happens in provider issue comments, MR/PR comments, or review threads. Agents do not require a separate chat surface for scope execution.
- **Review requests:** humans can request agent or human review from issue/MR/PR comments; the dispatcher turns those comments into Supervisor workflow signals.

## Roles

### Architect
- Elicits requirements from the human stakeholder (via the scope epic description / comments).
- Proposes scope decomposition: child tasks, clear inputs, outputs, acceptance criteria, and dependencies.
- Supervisor commits the approved decomposition into the Task Graph, forming the DAG.
- Owns the spec; updates it when requirements shift.
- **HITL:** requirements sign-off on the epic, scope-change approval.

### Supervisor
- Implemented as a **Temporal workflow** per scope; provider webhooks arrive as signals.
- Reads DAG state from the Task Graph (`ready_tasks`, `get_task`, dependency graph).
- Owns all normal Task Graph writes: scope/task creation, dependency updates, claims, state transitions, gates, events, and audit records.
- **Sole owner of ticket assignment** — atomically claims tasks and mirrors assignee + `state:*` to the provider. No agent self-assigns.
- Emits task packets to assigned agents from Task Graph + provider context.
- Assigns to a human when the task is out of agent scope, blocked on a human decision, or repeatedly failing.
- Routes MR/PRs to the Reviewer; requests human review when policy requires it.
- Handles human-requested reviews from provider comments and routes them to the Reviewer, Developer, Architect, or human assignee as appropriate.
- Tracks status, detects blockers, enforces HITL gates, escalates via issue comments.
- Suspends between signals; Temporal preserves state across worker restarts.
- **HITL:** escalation on ambiguity, repeated failure, or budget/time overrun.

### Developer
- Works tasks assigned by the Supervisor; reads the Supervisor task packet, provider issue/MR/PR context, and relevant repo files.
- Creates a branch per task, implements against the spec, writes tests and docs.
- Opens an MR/PR that `Closes #<provider-issue>` and references the `col-xxxx.N` ID; responds to review comments.
- Self-assesses the MR; flags it for human review if confidence is low or risk is high.
- Merges the MR/PR after the approval gate opens: Reviewer approval, required human approval, green pipeline, no blocking threads, and Supervisor merge-ready state. Merge is a mechanical action derived from open gates, not self-approval.
- **HITL:** conditional — see Review Policy.

### Reviewer
The Reviewer sits at **every HITL gate** as the agent-side pre-reviewer. Humans approve vetted, annotated artifacts — not raw ones. Assigned by the Supervisor:

- **Spec / DAG review** (before epic approval): checks task decomposition, testability of acceptance criteria, and dep correctness on the Architect's output.
- **MR/PR review** (before merge): reviews code against the issue's acceptance criteria and the spec; runs/interprets pipeline results; blocks merge on failures.
- **Scope review** (before epic close): verifies every child task's acceptance criteria are met, the epic's overall goal is satisfied, and no loose ends remain.
- Leaves comments in the provider; approves or requests changes. Does **not** merge.
- Reads Task Graph-derived context through the Supervisor task/review packet rather than mutating the graph directly.
- Can also be assigned when a human requests review in an issue comment, MR/PR comment, or review thread.

### Integrator / Release
- Performs deploy, release tagging, environment promotion, and scope closeout when those are separate from merge.
- Runs as a narrow bot/service with the minimum token needed to update release/deploy records.
- Before release/deploy, verifies all linked tasks are closed, scope review is approved, required environment checks pass, and release HITL gates are satisfied.
- Does not author code, review code, or merge task MR/PRs.
- **HITL:** release/deploy approval when the scope or environment policy requires it.

## Workflow (sketch)

1. Human opens a scope epic/parent issue in the provider; sync mirrors it to a Task Graph scope.
2. Architect elicits requirements → proposes child tasks and dependencies.
3. Reviewer does **spec/DAG review**. **[HITL: approve epic]**
4. Supervisor commits approved decomposition to the Task Graph.
5. Webhook fires → Supervisor wakes, runs `ready_tasks`, claims a task, assigns agent or human in the provider.
6. Developer branches, commits, opens MR/PR closing the provider issue. **[HITL: MR/PR approval]**
7. Reviewer does **MR/PR review**; human review added if self-flagged, required by settings, or requested in provider comments.
8. Pipeline green + approvals + no blocking threads + Supervisor merge-ready state → Developer merges.
9. Supervisor closes the task, advances the DAG.
10. When all children close, Reviewer does **scope review**. **[HITL: approve epic close]** → Integrator/Supervisor marks scope done according to policy.

## Review Policy

Every HITL gate gets an agent review; human review is conditional.

- **Agent review (always):** the Reviewer approves or requests changes on the gated artifact (spec/DAG, MR/PR, or scope).
- **Human review (conditional):** required when either
  - the Reviewer self-flags it (low confidence, high risk, ambiguous spec), **or**
  - project settings require it (e.g. protected paths, security-sensitive labels, always-on mode), **or**
  - a human requests review in an issue comment, MR/PR comment, or review thread.
- The gate only opens once both applicable approvals are in.

## Refinement Loop

When any reviewer (agent or human) requests changes, the artifact goes back to its original author for refinement:

- **Trigger:** "changes requested" on any HITL gate, a human review request, or a review/comment thread the Supervisor flags as actionable.
- **Routing:** Supervisor re-assigns the artifact to the author agent — Architect for spec/DAG, Developer for MR/PRs.
- **Context:** the author reads feedback from provider issue/MR/PR comments and the task history in the Task Graph; updates the artifact and requests re-review in the provider.
- **Bound:** capped at **N iterations** per gate. On exhaustion, Supervisor escalates to a human (assigns the ticket).
- **Audit:** every iteration is recorded by the Supervisor as a Task Graph event/audit record — full trail is preserved, not squashed.

## Task Graph Primitives

The graph is implemented by Colony, not delegated to an external tracker. It keeps the useful agent-facing semantics of structured task graph systems while fitting the Supervisor/Postgres control plane.

- **Entities:** `scopes`, `tasks`, `task_dependencies`, `assignments`, `gates`, `reviews`, `approvals`, `artifacts`, `events`, `audit_log`, `agent_runs`.
- **Dependency types:** `blocks`, `parent_child`, `related`, `discovered_from`, `duplicates`, `supersedes`.
- **Core queries/commands:** `ready_tasks(scope_id)`, `claim_task(task_id, assignee)`, `get_task_packet(task_id)`, `add_dependency(child, parent, type)`, `request_review(target_id)`, `record_approval(gate_id)`, `close_task(task_id)`.
- **Concurrency rule:** claims and state transitions are transactional; a task can only move forward when its current state and gate requirements match the expected preconditions.
- **Compaction:** closed task history can be summarized for agent context, but raw audit events remain queryable.

## HITL Policy (sketch)

Humans are pulled in when:
- Requirements are ambiguous or changing.
- Confidence is below threshold on a decision.
- An action is irreversible or high-stakes (merge, deploy, external comms).
- An agent has retried and failed.
- Budget, time, or scope bounds are at risk.

## Reconciliation

Colony reconciles provider events, Task Graph state, pipeline status, approvals, and repo state before any irreversible action. Disagreement is workflow state, not undefined behavior.

- **Fail closed:** merge, deploy, task close, scope close, and approval gates pause when required facts disagree.
- **Conflict event:** the Supervisor records the mismatch in the Task Graph and posts a provider comment when the provider is reachable.
- **Provider outage:** no new task claims, no provider-visible updates, no approvals, no merges, no closes. Already-claimed agents may keep working from their last confirmed task packet; their outputs stay internal as `pending_sync`.
- **Recovery:** when the provider returns, Colony reconciles `pending_sync` outputs against current provider state. Matching work is published or advanced; conflicting work becomes a `conflict` event for human/Supervisor resolution.
- **Override:** human override must be explicit and audited. Casual issue edits or comments are interpreted as events, not automatic permission to bypass policy.

## Done Semantics

Done is a reconciled state, not a single external event. A task or scope is only done when the provider surface, repo state, policy gates, Task Graph state, and audit trail agree.

- **Task done:** MR/PR is merged at the expected commit; provider issue is closed or marked complete; required pipeline/review/approval facts are recorded; Task Graph task is closed; close audit event is written; dependent tasks are re-evaluated.
- **Scope done:** every child task is reconciled closed; no `pending_sync` or `conflict` events remain; scope review is approved; required human close approval is present if policy requires it; provider epic/parent issue and Task Graph scope are closed; close audit event is written.
- **Auto-close:** provider-native issue auto-close is allowed, but the Supervisor verifies it and closes or comments when reconciliation requires cleanup.
- **Not done:** merged but not reconciled, closed but not merged, approved on stale state, or advanced with missing audit is not done.

## Discovered Work

New work discovered mid-flight is captured as a proposal before it becomes a task. Agents and humans may propose work from implementation findings, review comments, failed tests, ambiguity, or provider comments, but they cannot silently expand the scope.

- **Proposal record:** source task/comment/MR/PR, proposer, reason, evidence, suggested title, urgency, proposed dependency relationship, and recommendation (`blocker`, `follow_up`, `scope_change`, `bug`, `test_gap`, `cleanup`).
- **Supervisor classification:** the Supervisor classifies each proposal as `blocker`, `in_scope_follow_up`, `out_of_scope_follow_up`, `scope_change`, or `rejected`.
- **Human approval default:** no discovered work becomes a Task Graph task until a human explicitly approves it in the provider, unless project policy explicitly allows auto-accept for that proposal class.
- **Accepted blocker:** if approved as a blocker, the current task is blocked and the new task is inserted before it in the DAG.
- **Accepted follow-up:** if approved as non-blocking, the current task may still close once its acceptance criteria are met; the new task is linked as follow-up work.
- **Rejected proposal:** rejected work remains in the audit trail and provider discussion but does not affect DAG readiness.

## Structured Outputs

Agent outputs that affect workflow state must include a machine-readable envelope plus a human-readable explanation. Prose is for humans; the envelope is for routing, validation, policy, and audit.

- **Envelope fields:** `result`, `confidence`, `requires_human`, `risk_level`, `artifacts`, `policy_flags`, `next_action`, and role-specific fields.
- **Applies to:** Architect decomposition, Developer completion report, Reviewer review result, human-needed flags, discovered work proposals, blocked/failed status, merge readiness, and scope review.
- **Validation:** the Supervisor validates envelopes before changing Task Graph state. Malformed, incomplete, contradictory, or unauthorized outputs are rejected and returned for correction or escalated.
- **Human readability:** the provider comment/MR/PR description still includes normal prose explaining the decision, evidence, risks, and requested next step.
- **Audit:** accepted envelopes are stored as Task Graph events and linked to the provider comment, MR/PR, commit, or artifact that produced them.

## Supervisor Enforcement

The Supervisor is a validation gatekeeper for Colony state. It may reject transitions, commands, agent outputs, merge readiness claims, approvals, or closures that do not satisfy current state, policy, schema, or reconciliation rules.

- **Rejects invalid state:** missing task ID, missing linked MR/PR, stale pipeline, approval on stale commit, unresolved blocker, malformed structured envelope, unauthorized role action, unapproved discovered work, or close/merge before gates open.
- **Fail by pausing:** rejection records an audit event and pauses the affected task/scope instead of guessing.
- **Explain visibly:** when useful and provider is reachable, the Supervisor posts a clear provider comment explaining what is missing or invalid.
- **No command guessing:** ambiguous or malformed human commands are not inferred. The Supervisor replies with the accepted format or asks for clarification.
- **No surprise correction:** the Supervisor does not automatically reopen/undo provider-side human actions unless policy explicitly enables auto-correction. Premature closes, manual merges, or other out-of-band changes become reconciliation conflicts.

## Human Intervention

Human provider actions are first-class workflow events, not out-of-band damage. Colony ingests them, classifies them, and either applies them, asks for clarification, records context, or marks a conflict.

- **Ingested actions:** comments, issue edits, label changes, assignment changes, close/reopen, MR/PR approvals, review comments, manual merges, and branch updates.
- **Classification:** `valid_command`, `context_update`, `review_feedback`, `approval`, `conflict`, `noop`, or `needs_clarification`.
- **Policy-valid only:** human actions may inform or request state changes, but only policy-valid actions advance Colony state.
- **Casual comments:** normal discussion becomes task/scope context, not an implicit command.
- **Manual changes:** manual closes, merges, assignment changes, or branch updates trigger reconciliation instead of being ignored.
- **Review feedback:** human review comments can route work back to the author even without a formal command when the Supervisor classifies them as actionable.
- **Audit:** every ingested human action is linked to provider user, timestamp, provider artifact, and resulting Colony event.

## Web UI

Colony has a web UI for operators and stakeholders who need to see the system itself. The provider remains the normal collaboration and HITL surface; the web UI is for observability, control, and governance.

- **Scope dashboard:** scope status, child DAG, blocked work, active gates, pending reviews, conflicts, `pending_sync`, budget/time status.
- **Task graph view:** dependencies, readiness, claims, state transitions, discovered-work proposals, and why a task is or is not ready.
- **Run view:** agent runs, packets, capabilities, sandbox status, tool calls, logs, artifacts, structured outputs, retries, and failures.
- **Review/gate view:** approvals, required checks, unresolved findings, stale evidence, merge readiness, and close readiness.
- **Memory/decision view:** retrieved memory bundles, memory candidates, accepted/superseded facts, active decisions, evidence decay, and governing invariants.
- **Policy view:** effective project/scope/task policy, capability grants, protected paths, approval rules, sandbox profiles, and override history.
- **Conflict/reconciliation view:** mismatches between provider, repo, Task Graph, policy, and memory; resolution status; human override records.
- **Audit view:** immutable timeline of provider events, graph transitions, agent outputs, tool calls, approvals, merges, releases, and memory writes.
- **Guardrail:** the web UI may expose administrative actions, but human-agent discussion and normal review comments stay in the provider so the collaboration record remains portable.

## Colony Memory

Agents are disposable, but Colony memory is durable. Agents may use short-lived working memory, but shared memory belongs to Colony, is typed, provenance-linked, permissioned, and retrieved into task/review packets.

- **Working memory:** current task packet, active constraints, run scratchpad, and pending outputs. Short-lived.
- **Episodic memory:** what happened: agent runs, attempts, failures, review loops, conflicts, outcomes, and recovery paths.
- **Semantic memory:** stable facts about the repo, architecture, domain, ownership, integrations, and constraints.
- **Procedural memory:** how work should be done: checklists, workflows, test rituals, deployment steps, and recurring project practices.
- **Policy memory:** what is allowed: approval rules, protected paths, sandbox profiles, tool permissions, escalation thresholds. Read-only to normal agents.
- **Decision memory:** why choices were made: options considered, decision, assumptions, evidence, affected files/modules, rollback plan, and validity window.
- **Temporal facts:** facts can change. Memory records support `valid_from`, `valid_to`, confidence, source artifact, source actor, and invalidation/supersession.
- **Candidate writes:** agents do not directly mutate shared memory. They emit structured memory candidates; Supervisor or a memory consolidator accepts, rejects, supersedes, or expires them.
- **Curated retrieval:** task/review packets receive a small relevant memory bundle. Raw memory is searched on demand; it is not dumped wholesale into agent context.

## Agent Disposability

Continuity lives in Task Graph, provider artifacts, repo state, structured outputs, audit trail, and Colony Memory, not private agent sessions.

- **Fresh judgment:** important judgment steps use fresh context and durable artifacts. Spec review, MR/PR review, and scope review should generally run with a fresh Reviewer.
- **No hidden dependency:** no state transition may require private agent memory to interpret.
- **Checkpoint artifacts:** in-progress work should checkpoint commits, diffs, logs, test output, notes, or structured envelopes where possible.
- **Crash recovery:** agent crash, timeout, or replacement creates an event; another agent can continue from the task/review packet.
- **Context isolation:** agents get only the context they need. Shared facts must be written back through artifacts, structured outputs, or memory candidates.

## Decision And Evidence Memory

Colony should remember not only what was done, but why it was considered valid at the time.

- **Decision records:** significant engineering choices are recorded with problem framing, alternatives, selected option, assumptions, evidence, affected files/modules, rollback plan, and owner.
- **Evidence validity:** evidence has scope and freshness. A green pipeline is valid for a commit SHA; an approval may be invalidated by new commits; an architecture assumption may expire.
- **Evidence decay:** stale evidence triggers review, refresh, warning, or discovered-work proposal depending on policy.
- **Verification loop:** failed measurement, drift, or violated invariant can reopen a decision, block a gate, or create a discovered-work proposal.
- **Decision retrieval:** relevant active decisions and governing invariants are injected into task/review packets before implementation and review.

## Execution Loop Discipline

Colony uses bounded improvement loops, not endless autonomous retries.

- **Plan strengthening:** Architect output can be reviewed by a fresh agent before human sign-off.
- **Review packets:** Reviewer findings are structured observations with severity, evidence, affected artifact, acceptance-criterion link, confidence, and suggested fix.
- **Resolution tracking:** Developer fixes are matched against review observations; unresolved findings keep the gate closed.
- **Bounded loops:** plan/refinement/review loops have caps. Repeated failure escalates to a human instead of continuing indefinitely.
- **Skills as capabilities:** role packets may include versioned skill bundles and tool permissions. Skills are loaded only when relevant and their use is audit-visible.

## Capability Model

Roles describe what an actor is for; capabilities decide what an actor may do right now. Every action that changes provider state, Task Graph state, memory, merge status, release state, or external systems is checked against explicit capabilities derived from project policy, scope state, task state, actor identity, and gate status.

- **Role defaults:** roles provide baseline intent, but policy grants concrete capabilities per scope/task/run.
- **Capability examples:** `graph.read`, `graph.write`, `task.claim`, `task.assign`, `task.close`, `provider.comment`, `provider.issue.update`, `provider.branch.push`, `provider.mr.open`, `provider.review.approve`, `provider.mr.merge`, `memory.candidate.write`, `memory.write`, `decision.write`, `sandbox.exec`, `tool.call`, `release.deploy`, `policy.override`.
- **Human:** may comment, request review, approve, or override only when provider identity and project policy allow it.
- **Architect:** may propose decomposition/spec changes; does not directly write the Task Graph.
- **Supervisor:** may write Task Graph state, assign work, validate transitions, and route events; does not author code.
- **Developer:** may push branches, open MR/PRs, write provider comments, and merge only after the gate opens.
- **Reviewer:** may review, comment, approve, or request changes; does not merge.
- **Memory consolidator:** may write shared memory from accepted memory candidates.
- **Integrator / Release:** may deploy, promote environments, tag releases, and close release records; does not author or review code.
- **Tool gateway:** may execute external effects only when the requesting run has the required capability.

## Task And Review Packets

Agents receive bounded packets from the Supervisor instead of discovering all context and authority on their own. Packets are lightweight contracts, not a rigid protocol: enough structure for resumability, validation, and audit, with prose briefs for judgment-heavy work.

- **Task packet:** scope/task IDs, provider issue, repo/branch, goal, acceptance criteria, non-goals, dependency status, relevant provider context, relevant memory, active decisions, policy constraints, capabilities, required outputs, tool permissions, sandbox profile, known risks, and time budget.
- **Review packet:** scope/task IDs, provider issue, MR/PR, commit SHA, diff summary, acceptance criteria, Developer completion envelope, pipeline/test artifacts, relevant comments, active decisions, policy constraints, required review checks, capabilities, known risks.
- **Scope review packet:** scope goal, child task statuses, merged artifacts, unresolved conflicts, `pending_sync`, accepted follow-ups, rejected proposals, scope acceptance criteria, policy constraints, release/deploy state, and required close checks.
- **Freshness:** packets carry enough freshness metadata to invalidate stale outputs: provider event timestamp, commit SHA, policy version, memory bundle version, and Task Graph version.
- **Audit link:** each packet is linked to the agent run and the structured output it produced.
- **Evolvable schema:** packet fields can grow as Colony learns; early versions should favor clarity and recovery over perfect completeness.

## Tech Stack

Colony control plane is self-hosted. External LLM endpoints and git providers may be used through adapters/gateways.

- **Agent runtime:** [pi-mono / pi-coding-agent](https://github.com/badlogic/pi-mono) — SDK for long-lived agents (Architect), print/JSON mode for ephemeral ones (Supervisor activities, Reviewer), full coding-agent session for Developer. Pin exact versions per deployment.
- **Task graph & agent memory:** first-party Postgres-backed Task Graph in `colony`. Supervisor workers are the only normal writers; agents receive task/review packets.
- **Colony Memory:** typed memory subsystem backed by Postgres and optional search/vector/graph indexes. Agents propose memory candidates; Supervisor or a consolidator writes accepted memory.
- **Orchestration:** [Temporal](https://temporal.io/) self-hosted. Supervisor logic is Temporal workflows-as-code — HITL gates are signals/updates, refinement loop is an activity with retry policy, DAG advance is a loop over `ready_tasks(scope_id)`. Keep transcripts/diffs/logs outside workflow history.
- **Web UI:** Colony operator cockpit backed by Task Graph, audit log, run artifacts, policy, memory, and provider sync state.
- **Agent isolation:** [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox). `SandboxTemplate` per role, `SandboxClaim` per invocation, gVisor default (Kata if a scope demands hardware isolation). `SandboxWarmPool` for Developer to absorb cold-start tax. Pin CRD/controller versions.
- **Human surface:** Git provider, GitLab self-hosted first. Webhooks are the heartbeat source.
- **Persistence:** one Postgres instance, multiple databases:
  - `temporal`, `temporal_visibility` — Temporal cluster.
  - `colony` — Task Graph, run history, cost, HITL audit, cache. Separate role so connection strings can't leak.
  - Split into a dedicated Postgres when contention shows up in `pg_stat_activity`, when backup/retention policies diverge, or when a Temporal–Postgres version pin blocks an app upgrade.

## Deployment (Kubernetes)

```
                  Provider Webhooks
                         │
                         ▼
           ┌──────────────────────────┐
           │  Webhook Dispatcher      │  Deployment, ingress-exposed
           │  HMAC verify + dedup     │
           └──────────────┬───────────┘
                          ▼
                    ┌─────────────┐
                    │  Temporal   │  durable heartbeat + workflows-as-code
                    └──────┬──────┘
                           ▼
              ┌────────────────────────┐
              │ Colony Web UI + API    │  operator cockpit + admin actions
              └────────┬───────────────┘
                       ▼
              ┌────────────────────────┐
              │ Supervisor Workers     │  Deployment, horizontal
              │  ready_tasks / claim   │
              │  creates SandboxClaims │
              └────────┬───────────────┘
                       ▼
   ┌────────────────────────────────────────────────────┐
   │           Agent Sandboxes (gVisor / Kata)          │
   │  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
   │  │ Architect   │ │ Developer   │ │ Reviewer     │  │
   │  │ long-lived  │ │ per-task    │ │ per-review   │  │
   │  │ pi session  │ │ pi-coding-  │ │ read-only    │  │
   │  │             │ │ agent       │ │ pi session   │  │
   │  └─────────────┘ └─────────────┘ └──────────────┘  │
   └──────────────┬─────────────────────────────────────┘
                  │
        ┌─────────┴──────────┬──────────────────┐
        ▼                    ▼                  ▼
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │ Task Graph   │   │  Postgres    │   │ Git provider │
  │ API/service  │   │  (shared)    │   │  (external)  │
  └──────────────┘   └──────────────┘   └──────────────┘
```

**Notes:**
- Namespace per scope/epic for high-risk or long-lived scopes; otherwise shared namespace with per-sandbox RBAC, quotas, and NetworkPolicies.
- Task Graph API/service fronts Postgres so agents never touch graph tables directly. In the default path, only Supervisor workers write to it; other agents receive task/review packets. Transactional claims, auth, audit, conflict handling, and JSON schema validation live there.
- NetworkPolicies: agent egress limited to the active git provider, Task Graph API when explicitly allowed, tool gateway, and LLM endpoints.
- Tool gateway: agents call the git provider, LLMs, package registries, and external services through auditable allowlisted tools. Secrets are redacted and credentials are short-lived.
- Secrets via External Secrets Operator + Vault; per-agent provider bot tokens, LLM API keys.
- Observability: OTel traces per pi session, scope/task ID as span attributes, ship to self-hosted Grafana (Tempo / Loki / Prometheus).

## Open Questions

- Review escalation heuristics: what signals trigger the "flag for human" path?
- Settings surface: where does the "always require human" config live (project variables, file in repo)?
- Refinement loop cap `N` — per-gate, or global? What's a sane default?
- Task Graph ↔ provider sync cadence: event-driven only, or event-driven plus periodic reconciliation?
- Do any non-Supervisor agents ever call the Task Graph API directly, or only receive task/review packets?
- Label taxonomy for `state:*` and `agent:*` — define the full set.
- One project per scope, or shared project with epics scoping work?
- How does the Architect gather requirements — chat thread, issue template, both?
- Secrets and token scopes per bot account.
- Task Graph API shape — internal library, HTTP/gRPC service, or both?
