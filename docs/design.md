# Colony Technical Design

> First-pass design document. Turns `design-outline.md` into concrete decisions, grounded in `seed.md`. Open questions are flagged inline; unresolved ones are aggregated in §21 and §22.

## 1. Executive Summary

Colony is a durable control plane for AI software work. A **scope** is a bounded unit of work decomposed into a DAG of **tasks**, executed by disposable agents collaborating through a git provider while humans remain the decision authority at defined gates. The bet: an authoritative Task Graph plus Temporal orchestration and the provider's existing collaboration surface (issues, MRs/PRs, approvals, pipelines) gives us auditability, safe retries, and human control that chat-based agent sessions cannot offer.

**First production slice:** GitLab-first provider adapter, Postgres-backed Task Graph, Temporal Supervisor workflow (one per scope), a webhook dispatcher that turns provider events into workflow signals, and sandboxed Developer/Reviewer runs launched per task/review via Kubernetes `SandboxClaim`s. Architect runs long-lived in a pi-mono session.

**Strongest invariant:** irreversible actions — merge, deploy, task close, scope close, approval gate advance — only happen when Task Graph, provider state, repo state, policy, and audit all agree. Any disagreement fails closed into reconciliation.

What makes Colony different from "a bot glued to GitLab": the Task Graph is the authoritative workflow state and durable memory, not the provider and not Temporal. The provider is a projection surface for humans. Temporal is an orchestration runtime for signals, waits, timers, retries, and per-scope control flow. Agents are disposable; continuity lives in graph state, provider artifacts, repo commits, structured output envelopes, audit, and typed memory.

## 2. Background And Problem Statement

Normal issue trackers and chat-based agent sessions are insufficient for multi-step, multi-role AI software work:

- **Private context.** Chat agents keep state in a session no one else can inspect; when the session ends, continuity is lost.
- **Weak auditability.** There is no durable record of why a decision was made, what evidence was valid at the time, or who authorized an action.
- **Unclear ownership.** When both an agent and a human edit the same artifact, split-brain state emerges (a closed ticket with an open MR, an approval on a stale commit, etc.).
- **Unsafe autonomous retries.** A crashed agent that retries without durable state can duplicate side effects or act on stale preconditions.
- **No shared notion of "done".** "Merged" is not the same as "reconciled closed". Pipeline status, review approvals, and scope acceptance must agree before an irreversible action runs.

`seed.md` names the building blocks: scopes, tasks, a DAG with `ready_tasks`/`claim_task` primitives, HITL gates, structured output envelopes, provider mirrors, reconciled done semantics, disposable agents, typed memory, and a capability model. The design problem is to turn those concepts into a reliable distributed workflow with explicit ownership, recoverability, and human control — and to do it in a way that a single small team can operate.

**Example scope used throughout this document:** _"Add CSV export to the reporting dashboard."_ The scope epic decomposes into tasks like `schema design`, `backend endpoint`, `frontend button`, `integration test`, `docs update`. It is realistic enough to surface dependencies, review loops, pipeline gates, and discovered-work proposals, but small enough to fit in a single diagram.

**Open questions:**

- Which failures from prior agent workflows are we _explicitly_ designing against? (Initial list above; expand as we observe pilot data.)
- Primary axis when axes conflict: safety vs. throughput vs. DX vs. auditability? Current answer: **safety > auditability > DX > throughput**. Pilot feedback may reorder.

## 3. Goals And Non-Goals

### Goals

1. **Durable task orchestration.** A crashed Supervisor worker, Developer run, or Reviewer run is resumed from durable Task Graph state, Temporal orchestration history, provider artifacts, and repo commits. No private agent memory is load-bearing.
2. **Provider-visible collaboration.** Every human-facing interaction happens in provider issues, MR/PR comments, review threads, and approvals. No secondary chat surface for scope execution.
3. **Deterministic ownership of state.** Each field has one source of truth (see §7); all other copies are projections.
4. **Safe HITL gates.** Spec/DAG approval, MR/PR approval, and scope close approval are policy-enforced; bypasses require explicit, audited override.
5. **Agent disposability.** Any agent can be killed and replaced without losing progress; no state transition depends on a specific run surviving.
6. **Reconciliation before irreversible action.** Merge, deploy, task close, scope close, and gate advances only proceed when Task Graph, provider, repo, pipeline, and policy agree.
7. **Auditable decisions.** Every state change ties back to a provider event, workflow action, agent envelope, or operator override, linked to timestamps and actors.

Each goal is phrased as a property the implementation can be tested against.

### Non-Goals

- **Replacing GitLab/GitHub as the human collaboration surface.** The web UI is an operator cockpit, not a communication channel.
- **General-purpose chat.** Agents do not hold open-ended chat sessions with humans; interaction is structured around tasks, reviews, and gates.
- **Fully autonomous release.** Every release/deploy path crosses at least one policy gate (even if auto-approved by policy, the gate is explicit).
- **Supporting every provider on day one.** Provider abstraction exists from the start, but only GitLab is implemented. GitHub/Gitea come later.
- **General AI workbench.** No ad-hoc code explorers, notebooks, or free-form agent tools outside the scope lifecycle.

### Success Criteria

- A crashed Developer run can be resumed by a fresh Developer run using only the task packet and repo state; no transcript replay required.
- Provider outage freezes all irreversible actions within one workflow tick; already-claimed work marked `pending_sync` resumes cleanly on recovery.
- Every merge/close/deploy action can be traced end-to-end from provider event → workflow decision → agent envelope → audit record in under 5 clicks in the web UI.
- `ready_tasks(scope_id)` and `claim_task(task_id, assignee)` are atomic under concurrent workers; no two Supervisor workers ever hand the same task to two agents.

### Open Questions

- **Web UI in MVP?** Yes. MVP includes read-only operator views early, then conflict resolution and operator override actions once reconciliation lands. Provider remains the collaboration surface.
- **Multi-provider in MVP?** Abstraction is required from day one; second adapter (GitHub) is deferred to Phase 4+.

## 4. Actors, Roles, And Capabilities

### Actors (code-level)

| Actor                | Kind                                  | Lifecycle                    |
| -------------------- | ------------------------------------- | ---------------------------- |
| Human user           | External identity                     | Long-lived provider user     |
| Architect            | Agent (long-lived pi-mono session)    | Per-scope, resumable         |
| Supervisor           | Temporal workflow                     | One per scope                |
| Developer            | Agent (pi-coding-agent session)       | Per-task                     |
| Reviewer             | Agent (pi-mono print/JSON mode)       | Per-review (fresh each time) |
| Integrator / Release | Agent or bot                          | Per-release                  |
| Memory Consolidator  | Service or scheduled workflow         | Background                   |
| Webhook Dispatcher   | Service                               | Long-lived                   |
| Tool Gateway         | Service                               | Long-lived                   |
| Provider Adapter     | Service/library behind Task Graph API | Long-lived                   |

### Role vs. Capability

Roles describe **intent** (what the actor is for). Capabilities authorize **specific actions at a specific point in the workflow** (what the actor may do right now, given scope state, task state, gate status, and policy). A role like Developer ships with a default capability bundle, but every action is re-checked against the effective capability set at the moment of the call.

### Default Capability Matrix (MVP)

`R` = read only. `W` = may write. `—` = not allowed. `G` = gated (requires open gate).

| Capability                 | Human      | Architect      | Supervisor | Developer      | Reviewer       | Integrator     | Memory Cons. |
| -------------------------- | ---------- | -------------- | ---------- | -------------- | -------------- | -------------- | ------------ |
| `graph.read`               | R (via UI) | R (via packet) | W          | R (via packet) | R (via packet) | R (via packet) | R            |
| `graph.write`              | —          | —              | W          | —              | —              | —              | —            |
| `task.claim`               | —          | —              | W          | —              | —              | —              | —            |
| `task.assign`              | —          | —              | W          | —              | —              | —              | —            |
| `task.close`               | —          | —              | W          | —              | —              | —              | —            |
| `provider.comment`         | W          | W (via Sup.)   | W          | W              | W              | W              | —            |
| `provider.issue.update`    | W          | —              | W          | —              | —              | —              | —            |
| `provider.branch.push`     | W          | —              | —          | W              | —              | —              | —            |
| `provider.mr.open`         | W          | —              | —          | W              | —              | —              | —            |
| `provider.mr.approve`      | W          | —              | —          | —              | W              | —              | —            |
| `provider.mr.merge`        | W          | —              | —          | G              | —              | —              | —            |
| `memory.candidate.write`   | —          | W              | W          | W              | W              | W              | W            |
| `memory.write`             | —          | —              | —          | —              | —              | —              | W            |
| `decision.write`           | —          | W (via cand.)  | W          | W (via cand.)  | W (via cand.)  | —              | W            |
| `sandbox.exec`             | —          | W (own)        | —          | W (own)        | W (own)        | W (own)        | W (own)      |
| `tool.call`                | —          | W (allowlist)  | —          | W (allowlist)  | W (allowlist)  | W (allowlist)  | —            |
| `tool.cli.execute`         | —          | W (profile)    | —          | W (profile)    | W (profile)    | W (profile)    | —            |
| `release.deploy`           | W          | —              | —          | —              | —              | G              | —            |
| `policy.override`          | W (policy) | —              | —          | —              | —              | —              | —            |
| `provider.admin.bootstrap` | W (admin)  | —              | —          | —              | —              | —              | —            |

Human actions are **first-class workflow events**, not trusted out-of-band mutations. They go through the webhook dispatcher, classification, and capability check just like agent actions. A casual comment becomes context; only policy-valid commands advance state.

### Open Questions

- **Enforcement order.** MVP enforces capabilities at three points: (1) Task Graph API mutations, (2) Tool Gateway calls, (3) provider write calls via the adapter. Generic CLI tools are exposed through run profiles; installing a binary does not grant its credentials or authority. Minimum sandbox egress enforcement is required before real Developer/Reviewer runs in Phase 2; deeper seccomp/profile hardening can continue in Phase 3.
- **Identity mapping.** Human provider identity → Colony permissions via an operator-managed mapping table keyed on provider user ID. Bot accounts have a separate mapping marked `role=bot`.
- **Task Graph API credentials.** Agents **do not** receive Task Graph API credentials in MVP. They only consume task/review packets and emit structured output envelopes. The Supervisor is the only normal writer.

## 5. System Architecture

### Components

- **Git provider (external).** GitLab self-hosted initially. Source of truth for human discussion, MR/PR state, pipeline status, approvals.
- **Webhook Dispatcher.** Ingress service. Verifies HMAC signatures, deduplicates by `(event_id, object_id)`, classifies events, and emits Temporal signals to the relevant Supervisor workflow.
- **Temporal cluster.** Self-hosted. Durable orchestration state, retries, timers, HITL waits.
- **Supervisor Workers.** Horizontal Deployment running Temporal workflow and activity workers. Only process that writes the Task Graph in the default path.
- **Task Graph API.** A service fronting Postgres. Transactional claims, schema validation, capability checks, audit writes. Fronts the `colony` database.
- **Postgres.** One instance, three databases: `temporal`, `temporal_visibility`, `colony`.
- **Agent Sandboxes.** Kubernetes `SandboxClaim` per invocation (gVisor default; Kata for scopes that demand hardware isolation). `SandboxWarmPool` for Developer.
- **Tool Gateway.** Allowlisted outbound access and credential broker for LLM endpoints, package registries, provider credentials, and external services. Short-lived credentials per run.
- **Provider Adapter.** Library (embedded in Supervisor + Webhook Dispatcher) implementing the provider interface. GitLab-first; pluggable.
- **Web UI + API.** Operator cockpit and admin API. Read-mostly in MVP.
- **Memory subsystem.** Postgres tables + optional search index; Memory Consolidator writes accepted candidates.
- **Observability.** OTel traces, Prometheus metrics, Loki logs, Tempo traces — self-hosted Grafana stack.

### Core flow

```
provider event
   └─► Webhook Dispatcher (verify + dedup + classify)
        └─► Temporal signal to Supervisor workflow (one per scope)
             └─► Supervisor activity: read Task Graph
                  └─► transition Task Graph state (via Task Graph API)
                       └─► project to provider (labels, comments, assignees)
                            └─► if work needed: emit task/review packet
                                 └─► SandboxClaim → agent run
                                      └─► structured output envelope
                                           └─► Supervisor validates envelope
                                                └─► Task Graph write + provider projection + audit
                                                     └─► reconcile before any irreversible action
```

### Source-of-truth ownership at the architecture level

Visible at the wire:

- Provider mutations use audited paths: API mutations go through the Provider Adapter; repo operations use normal CLI tools in the sandbox with scoped bot credentials supplied by the prepared run environment. Agent sandboxes do not receive raw long-lived provider credentials.
- The Task Graph API is the only component that writes to the `colony` database.
- Temporal history holds orchestration decisions and pointers, not Task Graph authority, DAG semantics, or artifacts.
- Scope/task hierarchy, dependency edges, state versions, approvals, and audit facts remain rebuildable from the Task Graph and provider/repo artifacts even if Temporal workflow executions are restarted or replaced.
- Artifacts live in the repo (commits), the provider (MR/PRs, comments, pipelines), or Postgres tables (envelopes, audit, memory).

### Retries, idempotency, reconciliation

First-class, not afterthoughts:

- Every activity has an idempotency key derived from `(workflow_id, activity_type, logical_key)`.
- Provider writes are projection-style: the adapter reads current provider state, computes desired state, and applies the diff. Double-apply is a no-op.
- Webhook events carry provider IDs; the dispatcher maintains a dedup table with a 7-day TTL.
- The Supervisor calls `reconcile_scope(scope_id)` before merge, deploy, task close, scope close, and gate approval — and periodically as a Temporal timer (every 15 minutes per active scope).

### Open questions

- **Task Graph API vs. Web UI/API.** MVP answer: **one backend service** exposing both internal (command) and external (query) endpoints, separated by route prefix and auth middleware. Split into two services if/when contention or ownership diverges.
- **Provider sync as Temporal activity vs. separate worker.** MVP answer: **Temporal activity**, so retries and idempotency are uniform. The webhook dispatcher is the only non-Temporal provider-touching component, and it only signals — it does not write provider state.
- **First deployment target.** Aether-hosted Kubernetes from the start (production-shaped), managed from `~/projects/aether`. Local development uses the Colony Nix dev shell plus Docker Compose for Temporal and Postgres, with the Node apps running as `npm run dev` watch processes — no local Kubernetes cluster. Kubernetes validation happens on Aether in a `colony-dev` namespace via Tofu `helm_release`, so the Helm chart is the unit of deploy everywhere.

## 6. Key Technical Decisions

Each decision: **Decision / Rationale / Consequence / Revisit when**.

### ADR-1: Postgres-backed first-party Task Graph

- **Decision.** The Task Graph lives in a first-party service backed by Postgres, not delegated to an external tracker.
- **Rationale.** We need transactional `claim_task`, schema-validated envelopes, and strict append-only audit — none of which external trackers offer with adequate guarantees.
- **Consequence.** We own schema migrations, backup/restore, and query performance. Task Graph writes are centralized behind one service.
- **Revisit when.** An external system offers transactional claims and typed events (unlikely) or when the graph grows to a scale where Postgres hurts (> ~10M active tasks).

### ADR-2: GitLab-first with a provider abstraction

- **Decision.** Implement GitLab first; keep all provider-specific code behind a `ProviderAdapter` interface.
- **Rationale.** Target users run GitLab self-hosted; but coupling the system to GitLab APIs would block portability. Seed.md explicitly calls this out.
- **Consequence.** Every provider call goes through the adapter. Minor complexity overhead; prevents a painful rewrite later.
- **Revisit when.** The first non-GitLab user appears (likely GitHub). At that point we validate the abstraction with a real second implementation.

### ADR-3: Temporal owns durable orchestration, not domain state

- **Decision.** Supervisor is a Temporal workflow; HITL gates are signals/updates; retries, timers, and sleeps are Temporal primitives. Temporal does not own scope/task hierarchy, Task DAG semantics, provider mirror truth, approvals, or audit facts.
- **Rationale.** HITL waits are long (hours to days). We need durable state across worker restarts, retries with backoff, and a clean signal model.
- **Consequence.** Temporal history must stay small — IDs, versions, pointers, and orchestration choices only. Domain state changes must be committed to the Task Graph/audit log through idempotent activities. Adds operational surface (Temporal cluster).
- **Revisit when.** History bloat becomes a recurring operational issue despite discipline, or if a simpler orchestrator suffices.

### ADR-4: Provider comments/MRs/PRs are the human-agent communication surface

- **Decision.** All human-agent discussion happens in provider issues, MR/PR comments, and review threads. The web UI does not host discussion.
- **Rationale.** Collaboration record must be portable and survive Colony. Duplicating chat UIs fragments the conversation.
- **Consequence.** Web UI is read-mostly plus admin. Comments on the provider must be parsed into structured commands.
- **Revisit when.** Provider-hosted discussion proves insufficient (e.g., need to discuss across scopes or in private) — unlikely in MVP.

### ADR-5: Agents are disposable; durable continuity lives elsewhere

- **Decision.** No workflow transition depends on private agent state. Continuity lives in Task Graph, provider artifacts, repo commits, structured envelopes, audit, and memory.
- **Rationale.** A crashed or timed-out run must be replaceable by a fresh run, given only the packet.
- **Consequence.** Agents must checkpoint (commits, envelopes, memory candidates). Review/spec/scope-review steps run with fresh Reviewer.
- **Revisit when.** We observe judgment-heavy tasks that genuinely cannot checkpoint (none expected).

### ADR-6: Structured output envelopes for anything that affects workflow state

- **Decision.** Agent outputs that influence workflow state carry a machine-readable envelope (`result`, `confidence`, `requires_human`, `risk_level`, `artifacts`, `policy_flags`, `next_action`, plus role-specific fields).
- **Rationale.** Prose is for humans; routing/validation/policy/audit need structure.
- **Consequence.** Every agent output goes through envelope validation before Task Graph write. Malformed envelopes are rejected and returned for correction.
- **Revisit when.** Envelope rigidity gets in the way of a new role.

### ADR-7: Irreversible actions fail closed on drift or stale evidence

- **Decision.** Merge, deploy, task close, scope close, and gate approvals pause and record a conflict event when required facts disagree.
- **Rationale.** Auto-correcting drift risks silent overrides; pausing with a visible reconciliation is safer and auditable.
- **Consequence.** Some scopes will pause more often than a looser system; operators must unblock. Web UI needs a good conflict view.
- **Revisit when.** Pause rate during steady-state operation is painfully high despite well-behaved inputs.

### Adjacent decisions (deferred — see Open Questions)

- **pi-coding-agent as hard dependency vs. adapter.** MVP: hard dependency for Developer; other roles use pi-mono print/JSON mode. Behind an `AgentRuntimeAdapter` interface so we can swap later. Revisit when a competing runtime emerges.
- **Merge actor.** `seed.md` says Developer merges after gates open. MVP keeps this — merge is mechanical once gates open, so a narrow merge executor is not yet justified. Revisit if Developer role grows unsafe.
- **Provider abstraction depth.** MVP: adapter covers issues, comments, MRs/PRs, approvals, branches, commits, pipelines, labels, user identity, webhooks. No speculative extensions.

### Implementation decisions

- **Control plane language:** TypeScript on Node.js. Supervisor workers, Task Graph API, Webhook Dispatcher, Tool Gateway, Provider Adapter, Policy Engine, Memory API, and Web UI all live in one TypeScript monorepo.
- **Why TypeScript:** Temporal's TypeScript SDK is official and supports workers, workflows, activities, testing, and OTel interceptors. Pi is also TypeScript/Node (`@mariozechner/pi-coding-agent` and related packages), so the Supervisor can integrate the agent runtime through a native SDK boundary instead of wrapping a JS CLI from another backend language. Shared packet/envelope/policy types can be reused across workers, APIs, and the Web UI.
- **Rust position:** Rust is not used for MVP Temporal workflow code because Temporal's Rust SDK is still prerelease/prototype. Rust remains a good future option for isolated high-assurance helpers, CLIs, sandbox-side utilities, or performance-sensitive libraries after the workflow boundary is stable.
- **Go position:** Go is a credible alternative because Temporal's Go SDK is mature and stable, but it is not the MVP choice. The Pi integration cost and cross-language type/API duplication outweigh Go's operational simplicity for the first production slice.
- **Envelope schemas:** Zod schemas, stored in `/schemas/envelopes/`, with generated JSON Schema artifacts for validation, documentation, and cross-language compatibility if Rust/Go helpers are added later. The same Zod schemas serve the HTTP boundary (via `@hono/zod-openapi`), agent envelope validation, and DB JSON column validation — one schema library end-to-end.
- **API transport:** HTTP + JSON with OpenAPI for the MVP. gRPC is deferred until payload size, streaming, or latency proves HTTP is the bottleneck.
- **API framework:** Hono with `@hono/zod-openapi` (zod-native OpenAPI generation) and `@scalar/hono-api-reference` for the docs UI, mirroring the `~/projects/seven30/foundry` pattern. Runs standalone on `@hono/node-server` for `apps/api`, `apps/webhook-dispatcher`, and `apps/tool-gateway`.
- **Web framework:** SvelteKit (Svelte 5, `@sveltejs/adapter-node`) for `apps/web`. The web app is a pure frontend calling `apps/api` over HTTP; it does not host backend routes.

## 7. Domain Model And Data Ownership

### Entities

| Entity              | Owner      | Description                                                                               |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `scopes`            | Task Graph | Scope metadata, state, provider epic ID                                                   |
| `tasks`             | Task Graph | Task metadata, state, acceptance criteria                                                 |
| `task_dependencies` | Task Graph | Edges: `blocks`, `parent_child`, `related`, `discovered_from`, `duplicates`, `supersedes` |
| `assignments`       | Task Graph | Current assignee + history                                                                |
| `gates`             | Task Graph | Gate definitions and current status                                                       |
| `reviews`           | Task Graph | Review request + result envelope                                                          |
| `approvals`         | Task Graph | Approval facts keyed on `(artifact, actor, commit_sha)`                                   |
| `artifacts`         | Task Graph | Pointers to provider MR/PR/issue, repo commits, pipeline runs                             |
| `events`            | Task Graph | Append-only timeline                                                                      |
| `audit_log`         | Task Graph | Append-only, capability-gated record of decisions                                         |
| `agent_runs`        | Task Graph | Run metadata, sandbox ID, packet hash, output envelope hash                               |
| `memory_records`    | Memory     | Typed, provenance-linked, validity-windowed memory                                        |
| `memory_candidates` | Memory     | Pending proposals from agents                                                             |
| `capabilities`      | Policy     | Role + context → action allow/deny                                                        |
| `policies`          | Policy     | Project/scope/task-level policy config                                                    |
| `provider_projects` | Task Graph | Provider repo/project registry, independent of scopes                                     |
| `scope_targets`     | Task Graph | Provider projects/repos in scope, with roles such as frontend/backend/data/infra          |
| `task_targets`      | Task Graph | Primary and secondary provider projects/repos for each task                               |
| `provider_mirrors`  | Task Graph | Mapping between Colony IDs and provider IDs                                               |

### Source of truth (per field)

Derived from `seed.md` §Source of Truth:

| Field / event                                  | Source of truth                                       | Projection(s)                                      |
| ---------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Task title / description / acceptance criteria | Task Graph (written by Supervisor from approved spec) | Provider issue body + agent task packet            |
| Task dependencies / DAG readiness              | Task Graph                                            | Provider labels/comments                           |
| Task assignment                                | Supervisor via atomic Task Graph claim                | Provider assignee + `state:*` label                |
| Human discussion / approval comments           | Git provider                                          | Task Graph `events` + `audit_log`                  |
| MR/PR status / approvals / pipeline status     | Git provider                                          | Task Graph `events` + `artifacts`                  |
| Scope state                                    | Supervisor workflow                                   | Task Graph `scopes` + provider epic/parent issue   |
| Merge action                                   | Developer (after gates pass)                          | Provider MR/PR state + Task Graph event + audit    |
| Deploy / release action                        | Integrator/Release                                    | Provider release record + Task Graph event + audit |

**Conflict rule.** Owning system wins for ordinary projection drift (e.g., label de-sync). Gate/merge/close/approval/done-state conflicts **fail closed** and enter reconciliation.

### Projection, version, freshness

Every projection carries:

- `source_version` — the version/timestamp of the source at projection time.
- `projected_at` — wall clock.
- `freshness_ttl` — when the projection becomes suspect and triggers periodic reconcile.

**Colony IDs vs. provider IDs.** Every entity gets a Colony ID (`col-xxxx` for scopes, `col-xxxx.N` for tasks). Provider IDs live in `provider_mirrors`, never as primary keys. A scope can survive provider migration because Colony IDs are stable.

**Provider project targeting.** A scope is not assumed to belong to one repo. A single scope may cover frontend, backend, data, infra, docs, and shared-library projects. Provider account credentials and webhook/OAuth setup are environment configuration; the set of provider projects Colony may touch is Task Graph data. `provider_projects` records repo/project identity (`provider`, `provider_project_id`, `path`, `default_branch`, metadata). `scope_targets` declares the projects in a scope and their role. `task_targets` assigns each task one primary project and optional secondary affected projects. Provider adapter calls receive project context per operation; global env vars may provide a local default for dogfooding but are not the durable model.

### ERD sketch (not locked)

```
scopes ──┬── tasks ──┬── task_dependencies
         │           ├── assignments
         │           ├── gates ── approvals, reviews
         │           ├── artifacts
         │           ├── task_targets ── provider_projects
         │           └── agent_runs
         ├── scope_targets ── provider_projects
         └── events (polymorphic, scope_id/task_id FK)
             audit_log (append-only, every mutation)
             provider_mirrors (col_id, provider_id, provider, provider_project_id, entity_type)
```

Exact columns are deferred to the schema-freeze milestone (Phase 0 end).

### Open Questions

- **Minimum MVP schema.** Target: scopes, tasks, task_dependencies, assignments, gates, approvals, artifacts, events, audit_log, agent_runs, provider_projects, scope_targets, task_targets, provider_mirrors, policies, capability_grants. Memory tables can trail by one phase.
- **Audit log storage.** MVP: Postgres table with `INSERT`-only RLS policy and no `UPDATE`/`DELETE` grants. Separate event store is a Phase 4 consideration; cryptographic integrity (Merkle or signed chain) is deferred unless a compliance requirement forces it earlier.
- **Memory in `colony` database.** MVP: yes, same database, separate schema (`colony.memory_*`). Split if/when isolation or scaling requires.

## 8. Task Lifecycle And State Machine

### Scope states

```
draft → decomposition_proposed → decomposition_approved
      → active → scope_review_requested → scope_review_approved
      → closed
      (branch states: blocked, conflict, canceled)
```

### Task states

```
created → ready (gated by deps)
      → claimed (by Supervisor, atomic)
      → in_progress
      → review_requested
      → changes_requested  ← back to in_progress
      → merge_ready
      → merged
      → closed (reconciled)
      (branch states: blocked, conflict, failed, canceled, pending_sync)
```

### Transitions, owners, preconditions

| From → To                              | Owner                    | Precondition                                                                            |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `created → ready`                      | Supervisor               | No open blocking deps; spec/DAG approved                                                |
| `ready → claimed`                      | Supervisor               | Atomic: `UPDATE ... WHERE state='ready'` with `RETURNING`                               |
| `claimed → in_progress`                | Supervisor               | Agent packet delivered + run started                                                    |
| `in_progress → review_requested`       | Supervisor               | Developer envelope `next_action=request_review`                                         |
| `review_requested → changes_requested` | Supervisor               | Reviewer envelope `result=changes_requested`                                            |
| `review_requested → merge_ready`       | Supervisor               | Reviewer approval + human approval (if required) + pipeline green + no blocking threads |
| `merge_ready → merged`                 | Developer (via provider) | Gate open + merge fast-forward or linear; verified by webhook                           |
| `merged → closed`                      | Supervisor               | Reconcile: MR merged at expected SHA + provider issue closed + audit event written      |
| any → `blocked`                        | Supervisor               | Classified blocker (missing approval, failing pipeline, external dep)                   |
| any → `conflict`                       | Supervisor               | Reconciliation disagreement                                                             |
| any → `pending_sync`                   | Supervisor               | Provider unreachable during write                                                       |

### Critical transactional operations

- **`ready_tasks(scope_id)`** — SELECT tasks in `ready` state with no open blocking deps, ordered by priority + creation time. Read-only; uses indexes on `(scope_id, state)` and `task_dependencies(to_task_id, type)`.
- **`claim_task(task_id, assignee)`** — `UPDATE tasks SET state='claimed', assignee=$2, claim_version=claim_version+1 WHERE task_id=$1 AND state='ready' RETURNING *`. Returns null if already claimed (caller retries with next ready task).

### Invalid transitions

Rejected by the Supervisor with an audit event and a provider comment (if provider reachable):

- `created → claimed` without `ready`.
- `in_progress → merged` without `review_requested → merge_ready`.
- `changes_requested → merge_ready` without a new `review_requested` cycle.
- `closed → anything` (except reopen via explicit reopen command with capability).
- Any transition whose `state_version` does not match the caller's expected version (optimistic concurrency).

### Open Questions

- **Exact state names + provider label taxonomy.** Labels `state:ready`, `state:claimed`, `state:in_progress`, `state:review_requested`, `state:changes_requested`, `state:merge_ready`, `state:merged`, `state:blocked`, `state:conflict`, `state:pending_sync`. `agent:architect`, `agent:developer`, `agent:reviewer`, `agent:integrator`, `agent:human`.
- **Claim leases vs. durable claims.** MVP: **durable until released**. Supervisor reassigns via explicit policy (timeout, operator override). Leases with heartbeats add complexity we don't yet need. Revisit if stuck runs become common.
- **Partial completion after crash.** Whatever the agent committed lives in the branch; the envelope (partial or missing) is audit-recorded. A fresh Developer run reads the branch + original task packet + any review comments and continues. No separate "partial" state needed.

## 9. Workflow Orchestration With Temporal

### Workflow shape

- **One Supervisor workflow per scope.** Workflow ID: `supervisor-<scope_id>`.
- **No child workflow per task in MVP.** Task lifecycle, parent/child meaning, and DAG readiness are Task Graph state. The scope workflow calls activities that claim tasks, emit packets, observe runs, and reconcile state. Introduce task child workflows only if long-running task loops become operationally painful, and never as the authoritative DAG representation.
- **No child workflow per review** — reviews are short enough to run as activities with retry policies.

### Provider events → workflow inputs

| Provider event                       | Temporal mechanism                                      |
| ------------------------------------ | ------------------------------------------------------- |
| Issue/MR/PR webhook                  | Signal to scope workflow                                |
| Human `/approve`, `/changes` comment | Signal                                                  |
| Pipeline completion                  | Signal                                                  |
| Operator override from web UI        | Update (synchronous response with acceptance/rejection) |
| Conflict resolution from web UI      | Update                                                  |

Signals vs. updates: **signal** if fire-and-forget with async acknowledgment via audit; **update** if the caller needs a synchronous decision (accepted/rejected).

### Activities

| Activity               | Purpose                                     | Idempotency key                          |
| ---------------------- | ------------------------------------------- | ---------------------------------------- |
| `SyncProviderIssue`    | Write provider projection for a task        | `(task_id, target_version)`              |
| `ProposeDecomposition` | Invoke Architect                            | `(scope_id, spec_version)`               |
| `RunReview`            | Invoke Reviewer                             | `(artifact_id, commit_sha, review_type)` |
| `ClaimTask`            | Atomic DB claim                             | `(scope_id, ready_set_hash, attempt_n)`  |
| `StartSandbox`         | Create `SandboxClaim`                       | `(run_id)`                               |
| `ValidateEnvelope`     | Schema + capability check                   | `(run_id, envelope_hash)`                |
| `UpdateProvider`       | Write projection (labels, comments, status) | `(target_id, target_version)`            |
| `ReconcileScope`       | Cross-system consistency check              | `(scope_id, tick)`                       |

### Retry policies

- **Default:** exponential backoff, initial 1s, max interval 5m, max 5 attempts.
- **Provider writes:** max 3 attempts; on failure mark `pending_sync` and raise a signal for the scope workflow.
- **Agent runs:** max 1 retry; on second failure, enter refinement loop or escalate to human (see §12).

### Timers and HITL waits

- **Stalled gate timer.** Each gate carries a deadline (default 72h). On expiry, Supervisor emits `gate_stalled` and posts a provider comment.
- **HITL wait.** Implemented as a Temporal condition wait, woken by signal when the approval arrives. Timeout → escalation to operator.
- **Reconciliation tick.** Timer every 15m per active scope.

### Workflow history hygiene

**MUST NOT** enter workflow history:

- Large diffs, raw agent transcripts, logs, test output.
- Full provider webhook payloads (only normalized event IDs + classified action).
- Artifacts themselves — only artifact pointers (`(kind, id, uri, hash)`).

Everything large goes to Postgres, object storage, or stays in the provider. Temporal history holds orchestration choices and pointers.

### Versioning

Temporal `patched(...)` for in-place workflow changes; major state-machine changes ship as a new task type (`TaskV2`) migrated by a background workflow. Target: no stuck workflows across a breaking change.

### Open Questions

- **Workflow boundary.** Decided above: one scope workflow for MVP; activities for task/review side effects. Task child workflows are deferred until measured operational pain justifies them.
- **Signals vs. updates.** Listed above; confirm during API review.
- **Workflow versioning cadence.** MVP: prefer backward-compatible state machine additions; reserve `TaskV2` for a real breaking change (no speculation).

## 10. Git Provider Integration

### Adapter interface (sketch)

```
ProviderAdapter {
  bootstrap:    provision_environment (idempotent: groups, projects, bot users, bot PATs,
                                       OAuth app, webhook — admin-credentialed)
  issues:       create, update, close, reopen, add_label, remove_label, comment
  epics:        create, update, close (GitLab Premium; fallback parent-issue)
  mr:           open, update, approve, unapprove, merge, close, comment, add_review_thread
  branches:     create, delete, protect
  commits:      get, diff
  pipelines:    get_status, trigger (optional)
  users:        resolve_by_id, resolve_by_username
  webhooks:     register, unregister, verify_signature
}
```

### GitLab-first assumptions

- **Tier.** GitLab Premium/Ultimate for epics and MR approval rules.
- **Fallback (if Premium unavailable).** Parent issues instead of epics. Approvals via `/approve` comment + Supervisor-enforced merge readiness. Protected-branch rules still required.
- **Bot accounts.** Bootstrap creates role-keyed bot users by default: `engine`/developer, `reviewer`, `architect`, `integrator`, `memory_consolidator`, and `supervisor`. Additional roles can be supplied in the bootstrap spec without changing the adapter contract. The split avoids GitLab MR self-approval issues, lets the Tool Gateway pick the narrowest role token per provider call, and preserves per-role attribution in both GitLab and Colony audit. `GITLAB_TOKEN` remains the engine alias for current local wiring; role-keyed tokens are emitted as `GITLAB_BOT_<ROLE>_TOKEN`.
- **Multi-repo scopes.** GitLab project context is not a singleton. One Colony scope can target multiple GitLab projects, e.g. frontend, backend, data, infra, and docs repos. The provider adapter takes a project target on issue/MR/branch/pipeline operations. The Supervisor chooses the target from `scope_targets` and `task_targets`; a local `GITLAB_DEV_PROJECT_ID` can be used only as a default project for local dogfooding and adapter tests.

### Provider Bootstrap

Provisioning a new provider environment (groups, projects, bot users, bot PATs, OAuth Application, project webhook) is a first-class **provider adapter operation**, not a one-off shell script. Every adapter exposes:

```
ProviderAdapter.bootstrap(spec): Promise<BootstrapResult>
```

- **Input:** a request-scoped admin credential (e.g. GitLab admin PAT) plus a config (group/project names, bot names, redirect URIs, webhook URL, scopes per role). Bootstrap may create an initial project, but additional target projects are registered as Task Graph provider projects and can be added later without changing global credentials.
- **Behavior:** idempotent — checks existing resources by name and creates only what's missing; rotates tokens when policy says.
- **Output:** structured result listing created/existing resource IDs and a redacted `.env` snippet for the operator.
- **Surface:** invoked by the operator via the Web UI ("Set up provider") or a capability-gated API endpoint on `apps/api`. The admin credential is request-scoped — it is never stored at rest in Colony.
- **Capability:** `provider.admin.bootstrap` (granted only to a human admin actor; never to agents). Every bootstrap action writes a Task Graph audit event with the actor, the redacted result, and a hash of the admin credential used.
- **GitLab implementation** uses `POST /api/v4/users` (with `bot=true`, `skip_confirmation=true`), `POST /api/v4/users/:id/personal_access_tokens`, `POST /api/v4/groups`, `POST /api/v4/projects`, `POST /api/v4/applications`, and `POST /api/v4/projects/:id/hooks`. One admin PAT is the only human-touched credential; everything else is created over the API.
- **Re-running** the operation is the rotation/drift-correction path. Two environments (dev and prod) are two invocations against their environment bootstrap specs. Multi-repo operation within one environment is modeled by registering multiple provider projects and linking scopes/tasks to them.

### Webhook handling

1. **Signature verification.** HMAC per-project secret; reject on mismatch with 401.
2. **Deduplication.** `(event_id, object_id)` dedup table, 7-day TTL.
3. **Classification.** Map event → `valid_command`, `context_update`, `review_feedback`, `approval`, `conflict`, `noop`, or `needs_clarification`.
4. **Signal dispatch.** Look up `scope_id` from `provider_mirrors` using provider, project/repo ID, entity type, and provider entity ID; send signal to `supervisor-<scope_id>`.
5. **Provider projection writes.** The webhook dispatcher **does not** write to the provider. Provider API writes are performed by Supervisor activities through the Provider Adapter; repo operations from agent runs use scoped bot credentials in the prepared sandbox environment.

### Periodic reconciliation

In addition to webhook-driven sync, every 15 minutes per active scope:

- Re-fetch MR/PR status, pipeline status, approval list for all active artifacts.
- Diff against `provider_mirrors` projection, scoped to each active provider project target.
- Emit `drift_detected` events on mismatch; trigger `ReconcileScope`.

### Provider outage behavior

- Freeze all new provider-visible actions (`provider.*` capabilities denied).
- Already-claimed agent runs continue; their outputs are marked `pending_sync` in `agent_runs`.
- On recovery: reconcile each `pending_sync` output against current provider state. Matching → publish. Conflicting → `conflict` event.

### Accepted comment commands

MVP command set (case-insensitive, must be first line of comment):

| Command                             | Meaning                                     |
| ----------------------------------- | ------------------------------------------- |
| `/approve`                          | Human approval for the current gate         |
| `/changes <prose>`                  | Request changes; prose captured as feedback |
| `/review @agent` or `/review @user` | Request agent or human review               |
| `/block <reason>`                   | Human marks task blocked                    |
| `/unblock`                          | Human clears blocker                        |
| `/override <reason>`                | Policy override (requires capability)       |

Ambiguous or malformed commands → Supervisor posts a `needs_clarification` reply with accepted syntax. **No command guessing.**

### Open Questions

- **Premium features required for MVP.** Epics (nice-to-have; fallback exists). Required MR approvals (nice-to-have; Supervisor enforces anyway). Answer: **MVP works on Core/Free**; Premium features are used when available but not required.
- **Periodic reconciliation.** Decided: yes, every 15m per active scope.
- **Command syntax.** Listed above; anything else is rejected.

## 11. Agent Runtime, Packets, And Structured Outputs

### Packets

**Task packet** (Developer + Architect when working on decomposition):

```
{
  "scope_id", "task_id", "provider_issue",
  "repo": { "url", "branch", "base_commit" },
  "goal", "acceptance_criteria": [...], "non_goals": [...],
  "dependencies": [ { "task_id", "state" } ],
  "provider_context": { "recent_comments": [...], "labels": [...] },
  "memory_bundle": { "decisions": [...], "semantic": [...], "procedural": [...] },
  "policy": { "constraints": [...], "protected_paths": [...] },
  "capabilities": [...],
  "required_outputs": [...],
  "tool_permissions": [...],
  "sandbox_profile": "developer-default",
  "known_risks": [...],
  "time_budget_minutes": 60,
  "freshness": {
    "provider_event_ts", "commit_sha", "policy_version",
    "memory_bundle_version", "task_graph_version"
  }
}
```

**Review packet** — adds `mr_id`, `commit_sha`, `diff_summary`, `developer_envelope`, `pipeline_artifacts`.

**Scope review packet** — adds `child_task_statuses`, `merged_artifacts`, `unresolved_conflicts`, `pending_sync_items`, `accepted_followups`, `rejected_proposals`, `scope_acceptance_criteria`, `release_deploy_state`.

### Structured output envelopes

Every envelope includes:

```
{
  "result":            "done" | "changes_requested" | "approved" | "blocked" | "escalate",
  "confidence":        0.0 .. 1.0,
  "requires_human":    bool,
  "risk_level":        "low" | "medium" | "high",
  "artifacts":         [ { "kind", "id", "uri", "hash" } ],
  "policy_flags":      [...],
  "next_action":       "request_review" | "merge" | "close" | "wait_human" | ...,
  "freshness": {
    "packet_hash": "...",
    "task_graph_version": "...",
    "provider_event_ts": "...",
    "commit_sha": "...",
    "policy_version": "...",
    "memory_bundle_version": "..."
  },
  "rationale":         "...prose...",
  "role_specific":     { ... }
}
```

**Developer completion example:**

```json
{
  "result": "done",
  "confidence": 0.82,
  "requires_human": false,
  "risk_level": "medium",
  "artifacts": [
    {
      "kind": "mr",
      "id": "!42",
      "uri": "https://gitlab.example.com/...",
      "hash": "sha:abc123"
    },
    { "kind": "commit", "id": "abc123", "uri": "...", "hash": "abc123" }
  ],
  "policy_flags": [],
  "next_action": "request_review",
  "freshness": {
    "packet_hash": "sha256:packet123",
    "task_graph_version": "42",
    "provider_event_ts": "2026-04-23T15:12:00Z",
    "commit_sha": "abc123",
    "policy_version": "7",
    "memory_bundle_version": "3"
  },
  "rationale": "Implemented CSV export endpoint with streaming and content-type header. Tests cover empty and large datasets.",
  "role_specific": {
    "tests_added": [
      "export_csv_test.go:TestStreaming",
      "export_csv_test.go:TestEmpty"
    ],
    "self_review_notes": "Pagination edge case untested; flagging for reviewer."
  }
}
```

**Reviewer finding example:**

```json
{
  "result": "changes_requested",
  "confidence": 0.9,
  "requires_human": false,
  "risk_level": "medium",
  "artifacts": [
    { "kind": "mr", "id": "!42", "uri": "...", "hash": "sha:abc123" }
  ],
  "next_action": "return_to_author",
  "freshness": {
    "packet_hash": "sha256:reviewpacket456",
    "task_graph_version": "45",
    "provider_event_ts": "2026-04-23T15:40:00Z",
    "commit_sha": "abc123",
    "policy_version": "7",
    "memory_bundle_version": "3"
  },
  "rationale": "Pagination edge case is a real bug; streaming closes the writer early on empty results.",
  "role_specific": {
    "findings": [
      {
        "severity": "major",
        "evidence": "export_csv.go:L88 — early return before header flush",
        "acceptance_criterion_ref": "AC-3",
        "suggested_fix": "Flush header before early return; or return 204 with no body.",
        "confidence": 0.9
      }
    ]
  }
}
```

### Validation

- **Schema validation.** Versioned Zod schemas stored in the TypeScript schema package, with generated JSON Schema artifacts checked into `/schemas/envelopes/<role>.v<N>.json`.
- **Capability check.** Does this actor, in this scope/task state, have the capabilities implied by `next_action`?
- **Freshness check.** Does the envelope's `freshness` match current state within tolerance?

Malformed → returned to the author with specific errors; capped retries before escalation to human.

### Agent runtime

- **Architect:** pi-mono SDK long-lived session, one per scope. Suspended between signals; resumable.
- **Developer:** pi-coding-agent full session, per-task.
- **Reviewer:** pi-mono print/JSON mode, fresh per review. No session reuse — enforces independent judgment.
- **Integrator/Release:** pi-mono print/JSON mode or a narrow bot script; minimal token surface.

Behind `AgentRuntimeAdapter` so we can swap runtimes if needed.

### Open Questions

- **Envelope validation strictness in MVP.** Strict schema validation (reject malformed); lenient `rationale` content (accept any prose).
- **Schema versioning.** Each envelope version gets a distinct filename + `"version"` field in the envelope. Old versions remain readable; Supervisor writes the current version.
- **Correction loop.** Malformed → automatic retry (1 attempt) with specific errors → return to author → human escalation after N iterations.

## 12. HITL Gates, Review Policy, And Refinement Loops

### Gates

| Gate           | When                               | Required approvals                                                                    |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Spec/DAG       | After Architect decomposition      | Reviewer approval + human approval                                                    |
| MR/PR          | After Developer `review_requested` | Reviewer approval + (human approval if policy) + green pipeline + no blocking threads |
| Scope close    | After all child tasks closed       | Reviewer scope-review approval + (human approval if policy)                           |
| Release/deploy | Before release/deploy              | Integrator precheck + human approval (if policy)                                      |

Gate-specific policies (protected paths, security labels) can raise additional approval requirements.

### Review policy

- **Agent review: always.** Every HITL gate gets a Reviewer envelope before opening.
- **Human review: conditional.** Required when:
  1. Reviewer self-flags (`requires_human=true`, or low confidence < 0.6, or `risk_level=high`), **or**
  2. Project settings require it (protected paths, security-sensitive labels, always-on mode), **or**
  3. A human requests review via `/review @user`.
- A gate opens only after **both applicable approvals** are in.

### Refinement loop

- **Trigger.** `changes_requested` on a gate; human review request; actionable review thread classified by Supervisor.
- **Routing.** Architect owns spec/DAG; Developer owns MR/PR; Reviewer re-reviews.
- **Context.** Author reads provider comments + task history + memory bundle.
- **Cap.** Default **N=3** iterations per gate. On exhaustion, Supervisor escalates to human (reassigns).

### Stale approvals / evidence invalidation

Approvals are keyed on `(artifact_id, actor, commit_sha, pipeline_id)`. Any of:

- New commit on the branch,
- New failed pipeline,
- New `changes_requested`,
- Policy version change affecting the artifact

invalidates approvals on that artifact. Supervisor re-requests review.

### Open Questions

- **Loop cap N.** MVP: **3**, per gate. Revisit with pilot data.
- **Risk signals forcing human review.** Initial list: `risk_level=high`, `policy_flags` containing `protected_path_touched`, scopes labeled `security-sensitive`, release/deploy scopes.
- **Human override of failed agent review.** Not allowed by default. Requires `policy.override` capability + explicit `/override <reason>` comment + audit record. Operators can configure per-scope.

## 13. Reconciliation, Consistency, And Failure Modes

### Reconciliation points

Before: merge, deploy, task close, scope close, any gate approval.

Checks:

- MR/PR state vs. Task Graph state.
- Commit SHA on MR vs. approval record SHA.
- Pipeline status vs. merge-readiness record.
- Approvals: required set vs. recorded set, against current commit.
- Provider issue state vs. Task Graph task state.
- Labels projection matches Task Graph.

### Conflict classes

| Class                              | Detected by          | System response                                | Human message         | Recovery                                                    |
| ---------------------------------- | -------------------- | ---------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| Provider drift (label mismatch)    | Periodic reconcile   | Auto-correct projection                        | None (audit only)     | Auto                                                        |
| Stale commit (approval on old SHA) | Pre-merge check      | Pause, invalidate approvals, re-request review | Provider comment + UI | Re-review                                                   |
| Stale pipeline                     | Pre-merge check      | Pause                                          | Comment               | Wait for green pipeline                                     |
| Manual merge                       | Webhook classify     | `conflict` event, Task Graph reconcile         | Comment               | Supervisor reconciles if matches expected state; else human |
| Manual close                       | Webhook classify     | `conflict` event                               | Comment               | Operator confirms or reopens                                |
| Label mismatch                     | Periodic reconcile   | Auto-correct                                   | None                  | Auto                                                        |
| Missing audit                      | Pre-close check      | Pause                                          | UI conflict view      | Operator                                                    |
| Malformed output                   | Envelope validate    | Reject, return to author                       | Provider comment      | Retry/escalate                                              |
| Unauthorized action                | Capability check     | Reject, audit, alert                           | UI alert              | Operator                                                    |
| Provider outage                    | Adapter health check | Freeze visible actions                         | UI banner             | Wait for provider                                           |

### Fail-closed invariants

- No merge without matching approvals on current commit + green pipeline + Task Graph `merge_ready`.
- No task close without merged MR at expected SHA + provider issue closed + audit.
- No scope close without every child reconciled closed + scope review approved + no `pending_sync` or `conflict`.
- No deploy without all linked tasks closed + release gate approval.

### Recovery from `pending_sync`

On provider return:

1. List `agent_runs` with outputs marked `pending_sync`.
2. For each: fetch current provider state; diff against the expected state at run completion.
3. Match → publish (write projection, advance state).
4. Conflict → `conflict` event + provider comment + UI entry.

**Abandon threshold.** `pending_sync` outputs older than **72h** with no successful publish are marked `abandoned` and require operator action. (Configurable.)

### Idempotency and deduplication

- Every workflow action carries an idempotency key (see §9).
- Provider writes are projection-diff style (apply only the delta).
- Webhook dispatcher dedupes events by `(event_id, object_id)`, 7-day TTL.
- Task Graph writes use optimistic concurrency (`state_version`).

### Open Questions

- **Auto-resolve vs. human resolve.** Auto: label drift, projection mismatch, stale-pipeline-clear-on-new-green. Human: manual merge/close, stale commit + human approval, policy violation, unauthorized action.
- **`pending_sync` lifetime.** 72h default (configurable).
- **Override mechanism.** `/override <reason>` comment + `policy.override` capability + audit event with operator identity + reason.

## 14. Security, Isolation, And Policy Enforcement

### Isolation

- **Kubernetes** namespaces per scope for high-risk / long-lived scopes; shared namespace otherwise with per-sandbox RBAC, quotas, NetworkPolicies.
- **Sandbox runtime:** gVisor default. Kata for scopes policy-flagged `requires_hardware_isolation`.
- **Sandbox templates:** `SandboxTemplate` per role (architect, developer, reviewer, integrator); `SandboxClaim` per invocation. `SandboxWarmPool` for Developer (cold-start absorption).
- **Sandbox FS:** ephemeral; repo checkout + scratch space; no persistence across runs.

### Network policy

Default-deny egress. Allowlist:

- Active git provider API + webhooks.
- Tool Gateway endpoint.
- LLM endpoints (via Tool Gateway).
- Package registries (via Tool Gateway).
- Task Graph API — **not** allowed from agent sandboxes by default. Agents consume packets; outputs return via workflow.

### Secrets

- **External Secrets Operator + Vault.**
- **Short-lived provider tokens:** scoped per role-keyed bot, 24h rotation. Initial provisioning and subsequent rotation go through the Provider Bootstrap operation (§10) or the operator bot lifecycle command.
- **LLM API keys:** held only by Tool Gateway; never injected into agent sandbox.
- **Per-run secrets:** scoped to sandbox lifetime, revoked on run completion.

### Capability enforcement points

1. Task Graph API (mutation endpoints).
2. Tool Gateway (external effect calls).
3. Provider Adapter (provider writes).

All three check the effective capability set derived from: actor identity, role, scope/task state, gate status, policy version.

### Threat model (concrete)

| Threat                                | Mitigation                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised agent run                 | Sandbox isolation; capability checks at every boundary; short-lived secrets                                                                                                      |
| Prompt injection via provider comment | Provider text treated as untrusted data; packet separates instructions from quoted context; structured command parsing; no command guessing; review of discovered-work proposals |
| Leaked token                          | Short-lived rotation; Vault audit; token scoping per bot                                                                                                                         |
| Malicious dependency                  | Package registry allowlist; SBOM on merge (later phase)                                                                                                                          |
| Provider webhook spoofing             | HMAC signature verification; per-project secret                                                                                                                                  |
| Unsafe tool call                      | Tool Gateway allowlist; capability check; audit every call                                                                                                                       |
| Supply chain on Colony itself         | Pinned CRD/controller versions; signed container images                                                                                                                          |

### Open Questions

- **gVisor vs. Kata.** gVisor default for MVP; Kata only when policy requires.
- **Default network access.** Developer: allowlist-only to package registries commonly needed (npm, pypi, rubygems, maven, deb/rpm). Expand via policy.
- **Secret rotation.** 24h per bot token; per-run secrets revoked on completion.

### Untrusted provider text rule

Issue comments, MR/PR comments, review threads, labels, and provider-authored descriptions are untrusted input. Packets must separate Colony instructions from provider context, quote provider text as data, and preserve provenance. Raw provider text can influence context and review findings, but cannot grant capabilities, change policy, bypass gates, or become executable shell/tool instructions without Supervisor classification and capability checks.

## 15. Memory, Decisions, And Evidence

### Memory types

| Type       | Purpose                                | Lifetime                        |
| ---------- | -------------------------------------- | ------------------------------- |
| Working    | Current packet, run scratchpad         | Run-scoped                      |
| Episodic   | What happened: runs, failures, reviews | Long-lived                      |
| Semantic   | Stable facts about repo/domain         | Long-lived                      |
| Procedural | How work is done: checklists, rituals  | Long-lived                      |
| Policy     | What is allowed                        | Long-lived, read-only to agents |
| Decision   | Why choices were made                  | Long-lived, versioned           |

### Candidate workflow

Agents emit **memory candidates** (not direct writes). Candidates carry: proposed fact, type, scope, evidence, source artifact, source run. Consolidator or Supervisor accepts/rejects/supersedes/expires.

### Retrieval

Task/review packets receive a **small relevant memory bundle** (≤ ~2KB per type). Raw memory is searched on demand; no wholesale dump into agent context.

### Decision records

Every significant engineering choice records:

- Problem framing.
- Alternatives.
- Selected option.
- Assumptions.
- Evidence (commit SHAs, test results, doc links).
- Affected files/modules.
- Rollback plan.
- Owner.
- Revisit trigger.

Decisions are linked into packets via `memory_bundle.decisions`.

### Evidence validity

- Pipeline green: valid for a commit SHA only.
- Approval: invalidated by new commits on the branch.
- Architecture assumption: carries `valid_until` date or commit-range.

On decay: trigger review, refresh, warning, or discovered-work proposal per policy.

### Open Questions

- **MVP-critical types.** Decision + Procedural + Policy. Episodic/Semantic are Phase 4.
- **First Memory Consolidator.** MVP: **Supervisor** itself, with a conservative accept policy (accept only when candidate is unambiguous and evidence is durable). Dedicated consolidator in Phase 4.
- **Vector search.** Phase 4. MVP uses Postgres full-text search + metadata filters.

## 16. APIs And Internal Interfaces

### Task Graph API (command + query)

Commands (mutations; Supervisor-only in default path):

- `ready_tasks(scope_id) → [task_id]`
- `claim_task(task_id, assignee, expected_state_version) → task | null`
- `get_task_packet(task_id) → TaskPacket`
- `add_dependency(child_id, parent_id, type)`
- `request_review(target_id, review_type) → review_id`
- `record_approval(gate_id, actor, artifact_hash)`
- `close_task(task_id, reason)`
- `record_event(entity, type, payload)`
- `reconcile_scope(scope_id) → ReconcileReport`

Queries (for web UI + admins):

- `get_scope(scope_id)`, `list_scopes(filter)`
- `get_task(task_id)`, `list_tasks(scope_id, filter)`
- `get_audit_log(entity_id, range)`

All mutations require:

- **Caller identity** (service account + actor).
- **Capability** matching the action.
- **Preconditions** (state, version).
- **Audit event** written in the same transaction.

### Provider Adapter API

See §10. Pluggable; GitLab implementation first.

### Tool Gateway API

- `call(tool_id, params, capability_token) → ToolResult`
- Every call logged; secrets redacted.

### Agent Runtime Adapter

- `start_run(packet, run_environment) → run_handle`
- `get_run_status(run_handle)`
- `get_run_output(run_handle) → Envelope`
- `cancel_run(run_handle)`

### Policy Engine

- `evaluate(actor, action, context) → allow | deny + reason`
- `get_effective_policy(scope_id) → PolicyBundle`
- Embedded as a library inside the Task Graph API **and** the Tool Gateway. Not a separate service in MVP. Policy source: Postgres `policies` table + repo-level policy files.

### Memory API

- `propose_candidate(candidate)`
- `get_bundle(scope_id, task_id, type, filter) → MemoryBundle`
- `consolidate_candidate(candidate_id, action)` — Consolidator only.

### Web UI/API

- Read-mostly. Write endpoints: conflict resolution, operator override, manual requeue.

### Transport

- **MVP:** HTTP + JSON request/response APIs with OpenAPI contracts, explicit schemas, and idempotency. Performance is not expected to be the first bottleneck.

### Idempotency, auth, errors

- **Idempotency:** every mutating endpoint accepts an `Idempotency-Key` header; duplicates return prior result.
- **Auth:** mTLS between control-plane components; JWT for web UI; OAuth/OIDC for humans.
- **Errors:** structured (`code`, `message`, `details`, `retriable`); retriable errors set `Retry-After` where applicable.

### Open Questions

- **API transport.** HTTP + JSON with OpenAPI for MVP; revisit gRPC only if measurements require it.
- **Task Graph API queries.** Decided: same service exposes both (separate route prefix + auth).
- **Policy engine location.** Decided: embedded library in Task Graph API + Tool Gateway.

## 17. Web UI And Operator Experience

### Positioning

The web UI is an **operator cockpit**, not the primary collaboration channel. Provider comments remain the human-agent discussion surface. The UI answers operator questions the provider cannot: _why is this blocked? what changed? who/what can act? what evidence is stale? what must be approved?_

### MVP views (read, plus limited write)

| View                         | Purpose                                                                                                               | Write actions in MVP                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Scope dashboard              | Scope status, DAG, blocked work, active gates, pending reviews, conflicts, `pending_sync`, budget                     | None                                    |
| Task graph                   | Deps, readiness, claims, state, discovered-work proposals                                                             | None                                    |
| Run view                     | Agent runs, packets, sandbox status, tool calls, logs, artifacts, envelopes, retries, failures                        | Cancel run                              |
| Review/gate view             | Approvals, required checks, unresolved findings, stale evidence, merge readiness                                      | None                                    |
| Conflict/reconciliation view | Mismatches; resolution status; override records                                                                       | **Resolve conflict; operator override** |
| Audit view                   | Timeline of provider events, graph transitions, agent outputs, tool calls, approvals, merges, releases, memory writes | None                                    |

Deferred beyond the first MVP slice: richer memory/decision and policy authoring views. Read-only memory/decision summaries may appear earlier if they are needed to explain task context.

### Design principles

- Surface **why** a task is or is not ready (dep graph, gate requirements, stale evidence).
- Never duplicate provider comment workflows.
- Every state change links to its source (provider event, workflow action, envelope, override).

### Open Questions

- **MVP UI is read-only first, then conflict resolution + operator override once reconciliation is implemented.**
- **Operator-only actions needing Colony-native surface:** conflict resolution, operator override, manual requeue, scope cancel, run cancel, override audit view.
- **Audit access.** Full audit limited to operators; stakeholders see a filtered view (decisions + gate outcomes, not raw transcripts).

## 18. Observability And Audit

### Telemetry

- **Traces.** OTel; `scope_id`, `task_id`, `run_id`, `workflow_id` as span attributes. Trace per pi session; spans propagate across Supervisor activities.
- **Metrics.** Prometheus. Golden signals: workflow latency per gate, claim contention, envelope rejection rate, provider write retries, sandbox cold-start latency, tool-gateway error rate, reconciliation mismatch rate.
- **Logs.** Loki. Per-run logs stored by `run_id`.
- **Traces backend.** Tempo.

### Audit (compliance-grade)

Separate from debugging telemetry. Written to `audit_log` (Postgres, append-only). Captures:

- Every state transition in Task Graph.
- Every gate approval, merge, close, release, override.
- Every envelope accepted by the Supervisor.
- Every tool call and its capability check result.
- Every human action and its classification.

Each audit record links: actor, timestamp, provider event (if any), workflow action, envelope hash, resulting state version.

### Retention

- **Debug logs:** 30 days.
- **Traces:** 14 days (full) + 90 days (sampled 1/10).
- **Audit:** **indefinite** in MVP; retention policy deferred until legal/compliance input arrives.
- **Transcripts + diffs:** 90 days default; per-scope policy can extend.

### Integrity

- Audit is append-only via DB role grants (no `UPDATE`/`DELETE`).
- Cryptographic integrity (Merkle / signed chain) deferred; revisit if compliance requires it.

### Dashboards/alerts (before production pilot)

- Alert: provider webhook signature failures spike.
- Alert: reconciliation mismatch rate above baseline.
- Alert: envelope rejection rate above baseline.
- Alert: sandbox cold-start p99 regression.
- Dashboard: per-scope state machine progress.
- Dashboard: gate queue depth.
- Dashboard: `pending_sync` count + age.

### Open Questions

- **Retention.** Audit: indefinite pending legal input. Transcripts/diffs: 90 days default.
- **Cryptographic integrity.** Deferred.
- **Production pilot alerts.** Listed above.

## 19. Deployment, Environments, And Operations

### Kubernetes shape

Per the diagram in `seed.md` §Deployment:

- **Webhook Dispatcher** Deployment, ingress-exposed.
- **Temporal** cluster (self-hosted).
- **Supervisor Workers** Deployment, horizontal.
- **Web UI + API** Deployment.
- **Task Graph API** Deployment (same binary as Web UI/API in MVP, separate route prefix).
- **Postgres** StatefulSet (single instance; HA later).
- **Agent Sandboxes** via `SandboxClaim` (kubernetes-sigs/agent-sandbox).
- **Tool Gateway** Deployment.
- **Observability** Grafana stack.
- **External Secrets Operator + Vault.**

### Packaging and deployment wiring

- **Helm chart at `charts/colony/`** is the unit of deploy. It ships Colony's own services (Webhook Dispatcher, Supervisor Workers, Task Graph API / Web UI, Tool Gateway, Memory Consolidator), per-role `SandboxTemplate`s, ServiceAccounts, NetworkPolicies, and the HTTPRoutes that front Colony.
- **Platform prerequisites stay Aether-owned** and are not installed by the Colony chart: Temporal, Postgres (CNPG), cert-manager + step-issuer, Cilium, Gateway API, the kubernetes-sigs agent-sandbox controller + CRDs, OpenBao/SOPS, and observability. The chart assumes they are present; Aether is where they are installed.
- **Tofu drives the apply.** Aether holds `tofu/home/kubernetes/colony.tf` with a `helm_release.colony` resource, values rendered via `yamlencode({ ... })`, secrets via `var.secrets["..."]`, and HTTPRoute/StepIssuer resources alongside, matching Aether's existing per-app pattern (`headlamp.tf`, `cert_manager.tf`).
- **Chart distribution.** The chart is published to the GitLab OCI registry in CI; Tofu pulls it by version. During early iteration, `helm_release` may reference a local path for fast iteration against `colony-dev`.
- **Environment progression.** `colony-dev` namespace first (isolated release name, `*-dev.home.shdr.ch` hostnames, separate bot tokens, shares cluster-scoped CRDs/controllers with prod). Prod lands in `colony-system` + `colony-sandboxes` once the dev loop is stable.

### Namespace strategy

- `colony-system` — control plane (dispatcher, Temporal, Supervisor workers, API, UI, gateway).
- `colony-sandboxes` — shared agent sandbox namespace for low-risk scopes.
- `colony-scope-<scope_id>` — per-scope namespace for high-risk / long-lived scopes.

### Postgres databases

- `temporal`, `temporal_visibility` — Temporal.
- `colony` — Task Graph, audit, run metadata, memory, policy.

Separate roles:

- `temporal_user` — Temporal only.
- `colony_writer` — Task Graph API writer.
- `colony_reader` — Web UI queries.

Split into a dedicated Postgres when contention shows in `pg_stat_activity`, when backup/retention policies diverge, or when a Temporal–Postgres version pin blocks an app upgrade.

### Implementation stack

- **Language/runtime:** TypeScript on Node.js.
- **Package shape:** one TypeScript monorepo for Supervisor workers, Task Graph API, Web UI/API, Tool Gateway, Webhook Dispatcher, Provider Adapter, Policy Engine, Memory API, packet/envelope schemas, workflow-safe code, agent runtime integration, shared config, shared observability, and tests.
- **Workflow boundary:** Temporal workflow definitions live in a deterministic workflow-safe package. Activities, DB access, provider clients, Tool Gateway calls, Pi integration, wall-clock reads, random values, and process/env access stay outside workflow code.
- **Temporal SDK:** `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/client`, `@temporalio/testing`, and OTel interceptors.
- **Agent runtime:** pi-mono / pi-coding-agent packages, pinned by deployment and isolated behind an agent-runtime package. Developer runs still execute in sandboxes, but the control plane talks to Pi through TypeScript SDK boundaries where practical.
- **Schemas:** Zod as the source for packet/envelope schemas, with JSON Schema output checked into `/schemas/` for validation and interoperability. The same Zod schemas are reused at the HTTP boundary via `@hono/zod-openapi`.
- **API framework:** Hono on `@hono/node-server` for `apps/api`, `apps/webhook-dispatcher`, and `apps/tool-gateway`, with `@hono/zod-openapi` generating OpenAPI from Zod and `@scalar/hono-api-reference` serving docs under `/docs`. Matches the `~/projects/seven30/foundry` pattern.
- **Web framework:** SvelteKit (Svelte 5) with `@sveltejs/adapter-node` for `apps/web`. Talks to `apps/api` over HTTP.
- **API contracts:** HTTP + JSON with OpenAPI generated from the Hono + Zod layer.
- **Migrations:** TypeScript-friendly Postgres migration tooling selected in Phase 0, with migrations checked into the repo and run before service rollout.
- **Developer environment:** Nix flake dev shell is the source of truth for Node.js, npm, Temporal tooling, Postgres client tools, Kubernetes tools, GitLab CLI, formatting, linting, and CI parity.
- **CI/CD:** GitLab CI is the project CI system. Pipelines run Nix-backed checks, typecheck, tests, schema generation checks, migration checks, container builds, and deployment jobs.

Why this stack: Temporal's TypeScript SDK is official, Pi is TypeScript/Node, and the Web UI is naturally TypeScript. Using one language for the control plane and UI reduces the first-slice integration cost, lets packet/envelope/policy types stay shared, and avoids an extra Go/Rust-to-Node process boundary around the agent runtime.

Rust is explicitly deferred for MVP Temporal workflow code because Temporal's Rust SDK is still prerelease/prototype. It can be introduced later for isolated helpers or sandbox-side utilities where Rust's safety/performance is worth the boundary.

### Local development

Local development uses `nix develop` as the entry point. The dev shell provides Node.js LTS, npm, Temporal tooling, Postgres client tools, Kubernetes tooling, GitLab CLI, formatting/linting tools, and any generators used by CI. npm workspaces remain the TypeScript package layout, but Nix owns toolchain versions.

Local integration uses Docker Compose for Temporal and Postgres (with the three databases provisioned), and the Node apps run as `npm run dev` watch processes directly — not inside containers, not inside a local k8s cluster. Unit tests use the in-memory fake provider adapter; integration and `npm run dev` flows point at the home-lab GitLab over the LAN against a dedicated Colony dev project with a separate bot token, so the real provider is always the default once past unit tests. Kubernetes behavior is validated on Aether, not locally.

The production-like environment is Aether: the private-cloud infrastructure repo at `~/projects/aether`. The Colony Helm chart (`charts/colony/`), its Tofu `helm_release` wiring, secrets (OpenBao/SOPS), GitLab runner assumptions, DNS/ingress (Gateway API + cert-manager + step-ca), and observability integration are designed against Aether's Talos Kubernetes cluster, GitLab, and Grafana stack. Early iteration targets a `colony-dev` namespace before prod `colony-system` / `colony-sandboxes`.

### Migrations

- Task Graph migration tooling is TypeScript-based and selected in Phase 0.
- Temporal uses its supported schema migration path.
- Order: `colony` migrations run before service rollout; backward-compatible additions preferred over breaking changes.

### Backup/restore

- Postgres: nightly full + WAL shipping; RPO target 5 minutes, RTO 1 hour.
- Temporal: rely on Temporal's schema backup + WAL.
- Object storage (envelopes, logs): provider-native lifecycle.

### Worker rollout

- Temporal workflow versioning via `patched(...)` for small changes.
- Supervisor workers rolled via standard k8s rolling update; graceful shutdown waits for active activity completion.

### Open Questions

- **Local dev tooling.** Decided: Nix dev shell + npm workspaces + Docker Compose for Temporal/Postgres + `npm run dev` for app processes. No local k8s cluster; Kubernetes validation happens on Aether in `colony-dev`. Requirement: preserve production-relevant seams without making local setup painful.
- **CI/CD.** Decided: GitLab CI with Nix-backed jobs.
- **First production-like environment.** Aether-hosted Kubernetes with the full stack; bot users and tokens provisioned via the Provider Bootstrap operation (§10); one GitLab project may be used as the first local dogfood/default target, but the Task Graph model supports registering multiple GitLab projects per environment and assigning scope/task targets across them.
- **Backup RPO/RTO.** 5 min / 1 hour for Task Graph + audit. Refine with pilot SLOs.

## 20. Rollout Plan And Milestones

### Phase 0 — Foundations (schema + ingestion + audit)

Deliverables:

- Postgres `colony` schema: scopes, tasks, task_dependencies, assignments, gates, approvals, artifacts, events, audit_log, agent_runs, provider_projects, scope_targets, task_targets, provider_mirrors.
- Minimal policy schema: policies, capability grants, provider identity mapping.
- Task Graph API: core CRUD + `claim_task` + `ready_tasks` + audit writes.
- Webhook dispatcher: signature verify + dedup + classify + signal stub.
- Temporal cluster + skeleton scope workflow.
- Implementation ADRs: TypeScript monorepo conventions, framework selection, Postgres migration tooling, OpenAPI generation, and local development environment.
- Web UI shell with read-only scope/task/audit views backed by the query API.

Acceptance: a synthetic scope can be created, a task claimed atomically by two concurrent Supervisor workers (exactly one wins), every mutation appears in `audit_log`, and the Web UI can display the synthetic scope/task/audit trail.

### Phase 1 — Scope/task mirror + Supervisor workflow

Deliverables:

- Provider adapter (GitLab) for issues, comments, labels.
- Scope epic/parent issue → Task Graph scope mirror; task → provider issue mirror in the task's primary provider project.
- Multi-repo scope targeting: register provider projects, link multiple provider projects to one scope, and assign primary/secondary provider project targets to tasks.
- Supervisor workflow: receive signal, run `ready_tasks`, `claim_task`, assign agent via provider label + assignee, post comment.
- Web UI read views for mirrored scopes/tasks, provider sync status, and workflow state.
- No agent execution yet — the workflow stops at "would assign Developer."

Acceptance: open a GitLab epic/parent issue, see scope mirrored; approve a mock decomposition that spans at least two GitLab projects; see `state:ready` tasks appear in the correct provider projects.

### Phase 2 — Developer + Reviewer + merge

Deliverables:

- Agent sandbox (SandboxClaim) for Developer + Reviewer.
- Minimum sandbox egress enforcement: no direct Task Graph access, provider API through Provider Adapter, repo access through scoped bot credentials, package/LLM access through deployer-approved egress or Tool Gateway allowlists.
- pi-coding-agent integration for Developer; pi-mono print/JSON for Reviewer.
- Task packet + review packet generation.
- Developer envelope validation; Reviewer envelope validation.
- MR/PR open, review, approval, merge flow.
- Pipeline status ingestion.
- HITL gates on spec/DAG and MR/PR.

Acceptance: end-to-end CSV-export example scope completes a task from `ready` to `closed` with real code in a real MR, Reviewer approval, pipeline green, and `/approve` from a human.

### Phase 3 — Reconciliation + conflict + `pending_sync`

Deliverables:

- `reconcile_scope` activity + periodic timer.
- Conflict classification + `conflict` events + UI surface.
- `pending_sync` handling + recovery on provider return.
- Operator override flow + audit.
- Web UI actions for conflict resolution, operator override, manual requeue, run cancel, and scope cancel.

Acceptance: inject provider outage → no irreversible actions proceed; on recovery, in-flight work reconciles cleanly. Inject a manual merge → `conflict` event appears.

### Phase 4 — Memory, policy hardening, release role

Deliverables:

- Memory tables + candidate flow + retrieval into packets.
- Decision records wired into packets.
- Richer Web UI views for memory, decisions, and policy inspection/authoring.
- Integrator/Release role + release gate.
- Policy engine hardening (protected paths, security labels).
- Second provider adapter (GitHub) as a validation of the abstraction.

Acceptance: full scope (decomposition → closed) across ≥3 tasks with memory-informed context; release gate exercised at least once; GitHub adapter passes the same E2E suite as GitLab.

### Open Questions

- **First E2E demo scope.** CSV export (defined in §2).
- **Protected-branch repos.** Phase 2 targets a non-protected branch; Phase 3 introduces protected branches + required approvals.
- **What remains mocked in the first pilot.** Release/deploy pipeline can remain a dry-run in Phase 2–3; memory retrieval can return empty bundles in Phase 2.

## 21. Risks And Tradeoffs

### Major risks

| Risk                              | Impact                          | Mitigation                                                                                             | Owner     |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| Workflow complexity               | Slow delivery, bugs             | Thin vertical slice first (§20); strict state machine (§8); fail-closed invariants (§13)               | Tech lead |
| Provider API drift                | Outage, incorrect projection    | Periodic reconcile; provider integration tests; pin provider library versions                          | Platform  |
| Agent prompt injection            | Compromise, unsafe action       | Structured command parsing; capability checks; sandbox isolation                                       | Security  |
| False confidence in agent reviews | Bad merges                      | Reviewer+human for high-risk; envelope `confidence` + `risk_level` drives escalation; post-merge audit | Tech lead |
| Stale evidence                    | Approval-on-stale-SHA incidents | Evidence validity (§15); invalidation on new commit; pre-merge reconcile                               | Tech lead |
| Temporal history bloat            | Workflow failures, slow replay  | No artifacts in history; pointers only; periodic history size metric                                   | Platform  |
| Sandbox overhead                  | Cost, latency                   | Warm pool for Developer; shared namespace for low-risk scopes                                          | Platform  |
| Premature provider abstraction    | Wasted effort                   | Concrete GitLab-first; abstraction proven by Phase 4 GitHub adapter                                    | Tech lead |
| Memory quality                    | Bad retrieval pollutes context  | Conservative consolidation policy; provenance links; easy supersession                                 | Platform  |
| Operational burden                | Small team can't run it         | Start with single-cluster; observable by default; runbooks per failure class                           | Ops       |

### Intentional tradeoffs

- **Slower irreversible actions** in exchange for reconciliation + auditability. Pause rate will be higher than a looser system; this is intended.
- **No wholesale memory in agent context** in exchange for relevance and audit. Agents may occasionally miss context; we prefer that over context pollution.
- **One Postgres for MVP** in exchange for operational simplicity. Split later when metrics demand it.
- **Provider remains the collaboration surface** in exchange for portability + no chat UI to maintain.
- **Temporal dependency** in exchange for durable orchestration with bounded engineering cost.

### Open Questions

- **Most likely MVP-killer.** Complexity of the state machine colliding with real provider edge cases. Mitigated by thin vertical slice + E2E scope.
- **Relaxable checks in local/internal.** Capability enforcement at Tool Gateway can be log-only in dev; sandbox isolation can drop to plain containers in local development. Never relaxed in pilot/prod.
- **Acceptable operational burden at pilot.** One oncall, one backup; manual conflict resolution expected; daily reconcile report.

## 22. Appendix

### Glossary

- **Scope** — bounded unit of AI software work; Colony ID `col-xxxx`; mirrored to provider epic.
- **Task** — subunit; Colony ID `col-xxxx.N`; 1:1 with provider issue.
- **DAG** — directed acyclic graph of tasks, owned by Task Graph.
- **Packet** — bounded, signed context delivered to an agent run.
- **Envelope** — structured output from an agent, validated by Supervisor.
- **HITL gate** — approval checkpoint in the provider.
- **Reconciliation** — cross-system consistency check before any irreversible action.
- **`pending_sync`** — output produced during provider outage, waiting to publish.
- **Projection** — a derived copy of a fact whose source of truth lives elsewhere.

### State diagrams

See §8 (scope + task state machines). To be rendered as images in the appendix during Phase 0.

### Provider event examples

- Issue created / updated / closed.
- Comment created (plain; command).
- MR opened / updated / approved / merged / closed.
- Pipeline status change.
- Branch push / delete.
- Label changed / assignee changed.

### Envelope JSON schemas

Canonical schemas at `/schemas/envelopes/`. Initial files:

- `architect.decomposition.v1.json`
- `developer.completion.v1.json`
- `reviewer.review.v1.json`
- `discovered_work.v1.json`
- `blocked.v1.json`
- `merge_readiness.v1.json`
- `scope_review.v1.json`

Each schema carries `$id`, `$schema`, `version`, and required + optional fields. Examples in §11.

### Table sketches

Locked at Phase 0 end. Not duplicated here.

### ADR links

Decisions 1–7 inline in §6. Future ADRs live in `/docs/adr/` once implementation begins.

### Threat model details

See §14. Full STRIDE-style worksheet during Phase 0.

### Sample provider comments

- `/approve` — human approval.
- `/changes AC-3 pagination edge case still broken` — human changes-request with specifics.
- `/review @colony-reviewer` — request re-review.
- `/block waiting on infra ticket INF-123` — human block.
- `/override emergency release, security hotfix — SRE approved` — override with reason.

### References to `seed.md`

- Core concepts — §Core Concepts.
- Source-of-truth table — §Source of Truth.
- Role descriptions — §Roles.
- Workflow sketch — §Workflow.
- Review policy + refinement loop — §Review Policy, §Refinement Loop.
- Task Graph primitives — §Task Graph Primitives.
- Reconciliation — §Reconciliation.
- Done semantics — §Done Semantics.
- Discovered work — §Discovered Work.
- Structured outputs — §Structured Outputs.
- Supervisor enforcement — §Supervisor Enforcement.
- Human intervention — §Human Intervention.
- Capability model — §Capability Model.
- Packets — §Task And Review Packets.
- Tech stack + deployment — §Tech Stack, §Deployment.

### Open Questions (aggregated — deferred)

From outline + design decisions still open:

- Exact shape of the TypeScript `ProviderAdapter` interface.
- ~~TypeScript framework selection for Task Graph API / Web UI API.~~ Resolved: Hono + `@hono/zod-openapi` for APIs; SvelteKit for `apps/web`.
- TypeScript Postgres migration library.
- Per-scope namespace policy thresholds (what flags a scope as "high-risk").
- Discovered-work auto-accept classes (if any) per policy.
- Human approval override of failed agent review: policy-configurable or always denied in MVP.
- Memory candidate acceptance policy detail.
- Audit cryptographic integrity (deferred unless compliance requires).
- Retention policy (legal input pending).

### Example scope used throughout: _Add CSV export to reporting dashboard_

Decomposition used in diagrams and payload samples:

- `col-0001.1 — schema: CSV export record format` (Architect + Developer)
- `col-0001.2 — backend streaming endpoint` (Developer; depends on .1)
- `col-0001.3 — frontend export button + download flow` (Developer; depends on .2)
- `col-0001.4 — integration test covering large + empty datasets` (Developer; depends on .2, .3)
- `col-0001.5 — docs update` (Developer; depends on .3)

Exercised gates: spec/DAG approval (after Architect), MR/PR approval ×5, scope close approval.

---

_End of first pass. Phase 0 schema freeze + ADR write-up are the next milestones before implementation begins._
