# Colony Implementation Tasks

This task plan is derived from `design.md`. It is organized as dependency-aware implementation work: ordering and **Depends on** still matter, and each task has a **progress** checkbox to tick when its **Acceptance** criteria are fully met.

## Task Format

- **Progress** — `- [ ]` / `- [x]` on the line under the task title; check only when **Acceptance** is satisfied.
- **ID** — stable task identifier.
- **Depends on** — task IDs that should land first.
- **Deliverables** — concrete files, services, schemas, behavior, or docs to produce.
- **Acceptance** — checks that prove the task is done.

## Phase 0 — Foundations

Goal: establish the TypeScript monorepo, persistence, core state model, audit, basic Temporal workflow, and read-only Web UI shell.

### COL-0.1 — Create TypeScript Monorepo Skeleton

- [x]

**Depends on:** none

**Deliverables**
- npm workspace layout for control-plane services, shared packages, schemas, and Web UI.
- Packages for:
  - `apps/api`
  - `apps/worker`
  - `apps/webhook-dispatcher`
  - `apps/tool-gateway`
  - `apps/web`
  - `packages/db`
  - `packages/domain`
  - `packages/policy`
  - `packages/provider`
  - `packages/schemas`
  - `packages/testing`
- Shared lint, test, typecheck, and formatting commands.
- Nix flake dev shell with Node.js LTS, npm, Temporal tooling, Postgres client tools, Kubernetes tooling, GitLab CLI, formatting/linting tools, and CI generators.
- npm workspace package layout.

**Acceptance**
- `nix develop` enters a shell with the project toolchain.
- `npm install`, `npm run typecheck`, and `npm test` run from repo root inside the dev shell.
- A trivial import from `packages/domain` works in `apps/api` and `apps/worker`.

### COL-0.2 — Choose Framework And Tooling ADRs

- [ ]

**Depends on:** COL-0.1

**Deliverables**
- ADR for API/Web framework selection.
- ADR for Postgres migration tooling.
- ADR for OpenAPI generation.
- ADR for local development tooling.
- ADR for TypeScript monorepo conventions.
- ADR for GitLab CI job structure and image/build strategy.
- ADR for Aether deployment ownership boundaries.

**Acceptance**
- ADRs document decision, alternatives, rationale, consequences, and revisit triggers.
- Decisions align with `design.md`: TypeScript/Node, HTTP + JSON/OpenAPI, TypeBox schemas, Postgres, Temporal, Nix dev shell, GitLab CI, `kind` local development, and Aether-hosted deployment.

### COL-0.3 — Nix Local Development Environment

- [ ]

**Depends on:** COL-0.1, COL-0.2

**Deliverables**
- `flake.nix` and lockfile for the Colony dev shell.
- Dev manifests for local Temporal, Postgres, API, worker, webhook dispatcher, tool gateway, and Web UI.
- Postgres initialization for `temporal`, `temporal_visibility`, and `colony`.
- Local configuration for fake provider adapter.
- Developer docs for booting the stack.

**Acceptance**
- A new developer can enter `nix develop` and start the local control plane from documented commands.
- API can connect to Postgres.
- Worker can connect to Temporal.
- Web UI can call the API health endpoint.

### COL-0.3a — GitLab CI Baseline

- [ ]

**Depends on:** COL-0.1, COL-0.2, COL-0.3

**Deliverables**
- `.gitlab-ci.yml`.
- Jobs for Nix flake check, install/cache, typecheck, unit tests, schema generation diff check, lint/format check.
- Buildah-compatible container build job for Aether's GitLab Kubernetes runner.
- CI docs for runner assumptions and required variables.

**Acceptance**
- GitLab CI runs on merge requests.
- Build job works with the Kubernetes runner/Buildah path documented in Aether.
- CI fails if generated schemas or OpenAPI artifacts are stale.

### COL-0.3b — Aether Deployment Integration Plan

- [ ]

**Depends on:** COL-0.2

**Deliverables**
- Deployment ownership doc describing what lives in Colony vs. `~/projects/aether`.
- Initial Aether integration notes for namespace, ingress, secrets, GitLab runner, registry, observability, and database/storage assumptions.
- List of required Aether changes as follow-up tasks or MRs.

**Acceptance**
- There is a clear boundary between app manifests in Colony and infrastructure wiring in Aether.
- Required Aether secrets, DNS/ingress, and GitLab runner assumptions are documented before deployment work starts.

### COL-0.4 — Core Domain Types And State Machines

- [ ]

**Depends on:** COL-0.1

**Deliverables**
- TypeScript domain types for scopes, tasks, dependencies, assignments, gates, reviews, approvals, artifacts, events, audit records, agent runs, provider mirrors, policies, capability grants.
- Enumerations for scope states and task states from `design.md`.
- Transition validation helpers with owner/precondition metadata.

**Acceptance**
- Unit tests cover valid and invalid state transitions.
- Invalid transitions produce structured errors with code, message, details, and retriable flag.

### COL-0.5 — Envelope And Packet Schemas

- [ ]

**Depends on:** COL-0.1, COL-0.4

**Deliverables**
- TypeBox schemas for:
  - task packet
  - review packet
  - scope review packet
  - architect decomposition envelope
  - developer completion envelope
  - reviewer review envelope
  - discovered work envelope
  - blocked envelope
  - merge readiness envelope
  - scope review envelope
- Generated JSON Schema artifacts in `/schemas`.
- Required freshness metadata on every state-affecting envelope.

**Acceptance**
- Runtime validation rejects malformed envelopes.
- Runtime validation rejects envelopes missing `packet_hash`, `task_graph_version`, `provider_event_ts`, `commit_sha`, `policy_version`, or `memory_bundle_version` where applicable.
- Schema examples from `design.md` validate.

### COL-0.6 — Initial Postgres Schema

- [ ]

**Depends on:** COL-0.2, COL-0.4

**Deliverables**
- Migrations for:
  - `scopes`
  - `tasks`
  - `task_dependencies`
  - `assignments`
  - `gates`
  - `reviews`
  - `approvals`
  - `artifacts`
  - `events`
  - `audit_log`
  - `agent_runs`
  - `provider_mirrors`
  - `policies`
  - `capability_grants`
  - provider identity mapping
- Indexes for state queries and dependency readiness.
- Insert-only database permissions for `audit_log`.

**Acceptance**
- Migrations apply cleanly to an empty `colony` database.
- Migrations can be rolled forward in local development.
- Tests verify `audit_log` cannot be updated or deleted by the app role.

### COL-0.7 — Task Graph Repository Layer

- [ ]

**Depends on:** COL-0.4, COL-0.6

**Deliverables**
- Repository methods for scope/task CRUD.
- `ready_tasks(scope_id)`.
- `claim_task(task_id, assignee, expected_state_version)`.
- `record_event`.
- `write_audit`.
- `get_task_packet` query shape stub.

**Acceptance**
- Concurrent `claim_task` test proves exactly one claimant wins.
- `ready_tasks` excludes tasks with open blocking dependencies.
- Every mutation writes an audit event in the same transaction.

### COL-0.8 — Minimal Policy Engine

- [ ]

**Depends on:** COL-0.4, COL-0.6

**Deliverables**
- `evaluate(actor, action, context)`.
- `get_effective_policy(scope_id)`.
- Minimal capability grants for Supervisor, Developer, Reviewer, human operator, and service accounts.
- Provider identity mapping lookup.

**Acceptance**
- Mutating actions fail without a matching capability.
- Supervisor graph writes pass with the correct service identity.
- Agents cannot receive `graph.write`.
- Policy decisions are auditable.

### COL-0.9 — Task Graph API

- [ ]

**Depends on:** COL-0.5, COL-0.7, COL-0.8

**Deliverables**
- HTTP + JSON API for:
  - creating/listing scopes
  - creating/listing tasks
  - `ready_tasks`
  - `claim_task`
  - `record_event`
  - `get_scope`
  - `get_task`
  - `get_audit_log`
- Idempotency-key middleware for mutating endpoints.
- Structured error format.
- OpenAPI generation.

**Acceptance**
- API contract is generated and checked in.
- Mutating endpoints require identity, capability, preconditions, and audit.
- Duplicate idempotency keys return prior result.

### COL-0.10 — Temporal Skeleton Scope Workflow

- [ ]

**Depends on:** COL-0.3, COL-0.7

**Deliverables**
- Temporal worker package.
- `supervisor-<scope_id>` workflow skeleton.
- Activities for reading scope/task state and recording workflow events.
- Signal handlers for provider event, approval, changes requested, pipeline update, and operator override.

**Acceptance**
- Local Temporal can start a scope workflow.
- Signals are recorded as Task Graph events.
- Workflow history stores pointers/normalized data only, not large payloads.

### COL-0.11 — Webhook Dispatcher Skeleton

- [ ]

**Depends on:** COL-0.3, COL-0.10

**Deliverables**
- Ingress service for provider webhooks.
- Signature verification interface.
- Dedup table usage with `(event_id, object_id)` and TTL.
- Event classifier skeleton.
- Temporal signal dispatch to `supervisor-<scope_id>`.

**Acceptance**
- Duplicate webhook events are ignored.
- Invalid signatures are rejected.
- Valid synthetic events signal the matching workflow.

### COL-0.12 — Read-Only Web UI Shell

- [ ]

**Depends on:** COL-0.9

**Deliverables**
- Web UI shell.
- Scope list/detail page.
- Task list/detail page.
- Audit timeline page.
- API client generated from OpenAPI or shared API types.

**Acceptance**
- Synthetic scope/task/audit data is visible in the UI.
- UI shows task state, dependencies, current assignment, and recent audit records.

### COL-0.13 — Phase 0 End-To-End Acceptance

- [ ]

**Depends on:** COL-0.7, COL-0.9, COL-0.10, COL-0.11, COL-0.12, COL-0.3a

**Deliverables**
- Automated test or scripted demo that creates a synthetic scope and tasks.
- Concurrent claim test through API or repository layer.
- Audit visibility in Web UI.

**Acceptance**
- Exactly one of two concurrent claimers wins.
- Every mutation appears in `audit_log`.
- Web UI displays the synthetic scope/task/audit trail.

## Phase 1 — Scope/Task Mirror And Supervisor Workflow

Goal: mirror GitLab scope/task artifacts, ingest provider events, and run Supervisor assignment logic without executing agents yet.

### COL-1.1 — Provider Adapter Interface

- [ ]

**Depends on:** COL-0.2, COL-0.4

**Deliverables**
- TypeScript `ProviderAdapter` interface for issues, epics/parent issues, comments, labels, assignees, MRs/PRs, approvals, branches, commits, pipelines, users, webhooks.
- Provider domain types separate from Colony domain types.
- Fake provider adapter for tests.

**Acceptance**
- Fake adapter supports create/update/comment/label flows.
- Adapter methods return stable provider IDs and normalized metadata.

### COL-1.2 — GitLab Adapter: Issues, Comments, Labels

- [ ]

**Depends on:** COL-1.1

**Deliverables**
- GitLab implementation for issue create/update/close/reopen.
- Comment posting.
- Label add/remove.
- Assignee update.
- User identity lookup.

**Acceptance**
- Integration test against mock or local GitLab covers issue mirror lifecycle.
- Provider IDs are stored only in `provider_mirrors`.

### COL-1.3 — Scope And Task Mirror

- [ ]

**Depends on:** COL-0.7, COL-1.2

**Deliverables**
- Scope epic/parent issue -> Task Graph scope mirror.
- Task -> provider issue mirror.
- Projection version metadata.
- Provider projection writes through Supervisor activities.

**Acceptance**
- Creating a scope creates or links the provider parent issue.
- Creating a task creates or links a provider issue.
- Projection drift can be detected from stored version metadata.

### COL-1.4 — Provider Command Parser

- [ ]

**Depends on:** COL-0.8, COL-1.1

**Deliverables**
- Parser for first-line commands:
  - `/approve`
  - `/changes <prose>`
  - `/review @agent|@user`
  - `/block <reason>`
  - `/unblock`
  - `/override <reason>`
- `needs_clarification` response path.
- Untrusted provider text handling.

**Acceptance**
- Ambiguous/malformed commands do not mutate state.
- Parsed commands include actor, provider artifact, timestamp, and raw comment reference.
- Provider prose is stored as context, not instructions.

### COL-1.5 — Webhook Classification

- [ ]

**Depends on:** COL-1.4, COL-0.11

**Deliverables**
- Classification into `valid_command`, `context_update`, `review_feedback`, `approval`, `conflict`, `noop`, `needs_clarification`.
- Signal payloads for Supervisor workflow.

**Acceptance**
- Unit tests classify comment, issue edit, label change, close/reopen, approval, MR update, pipeline update.
- Classification is audit-recorded.

### COL-1.6 — Supervisor Ready/Claim/Assign Loop

- [ ]

**Depends on:** COL-0.10, COL-1.3, COL-1.5

**Deliverables**
- Workflow logic to evaluate `ready_tasks`.
- Atomic `claim_task`.
- Provider projection for assignee and `state:*` label.
- "Would assign Developer" stop point.

**Acceptance**
- Approved mock decomposition produces ready tasks.
- Supervisor claims exactly one ready task and mirrors assignment to provider.
- No agent sandbox is started.

### COL-1.7 — Web UI Provider Sync Views

- [ ]

**Depends on:** COL-1.3, COL-1.6

**Deliverables**
- Scope/task provider mirror status.
- Provider sync timestamps and projection version.
- Workflow state display.

**Acceptance**
- UI shows whether a scope/task is synced, pending, or drifted.
- UI links to provider issue URLs.

### COL-1.8 — Phase 1 End-To-End Acceptance

- [ ]

**Depends on:** COL-1.2, COL-1.6, COL-1.7

**Deliverables**
- Scripted GitLab or fake-provider demo.

**Acceptance**
- Open provider parent issue -> scope mirror appears.
- Approve mock decomposition -> `state:ready` tasks appear.
- Supervisor claims a task and mirrors assignment/provider label.

### COL-1.9 — Aether Preview Deployment

- [ ]

**Depends on:** COL-0.3b, COL-1.8

**Deliverables**
- Kubernetes manifests or Helm/Kustomize structure for API, worker, webhook dispatcher, tool gateway, Web UI, and required service accounts.
- GitLab CI deploy job targeting the Aether Kubernetes environment.
- Aether MR/task list for ingress, secrets, registry access, observability, and namespace setup.

**Acceptance**
- Preview deployment runs in Aether with fake provider mode.
- Web UI is reachable through the Aether ingress path.
- Logs/traces/metrics flow into Aether observability where available.

## Phase 2 — Developer, Reviewer, And Merge Flow

Goal: execute real Developer and Reviewer runs in sandboxes with minimum egress enforcement, packets, envelopes, MR/PR lifecycle, review gates, and pipeline ingestion.

### COL-2.1 — Minimum Sandbox Egress Enforcement

- [ ]

**Depends on:** COL-0.3, COL-0.8

**Deliverables**
- Sandbox launch profile for Developer and Reviewer.
- Default-deny egress.
- No direct Task Graph API access from agent sandboxes.
- Provider API access through Provider Adapter only.
- Git/package/LLM access through Tool Gateway allowlists.

**Acceptance**
- Agent sandbox cannot reach Task Graph API.
- Agent sandbox can access allowed git/package endpoints through Tool Gateway.
- Denied egress is logged.

### COL-2.2 — Tool Gateway Git And Package Proxy

- [ ]

**Depends on:** COL-0.8, COL-2.1

**Deliverables**
- Tool Gateway capability checks.
- Git proxy path for branch fetch/push.
- Package registry allowlist.
- Per-run credential handling and redaction.
- Tool call audit records.

**Acceptance**
- Developer can push a branch only with `provider.branch.push`.
- Unauthorized git/package calls fail and are audited.
- Secrets are not present in logs.

### COL-2.3 — Agent Runtime Adapter

- [ ]

**Depends on:** COL-0.5, COL-2.1

**Deliverables**
- `start_run(packet, runtime_profile)`.
- `get_run_status`.
- `get_run_output`.
- `cancel_run`.
- pi-coding-agent integration for Developer.
- pi-mono print/JSON integration for Reviewer.

**Acceptance**
- Fake agent run can return a valid envelope.
- Malformed envelope is rejected.
- Run metadata stores sandbox ID, packet hash, output envelope hash.

### COL-2.4 — Task And Review Packet Generation

- [ ]

**Depends on:** COL-0.5, COL-1.6

**Deliverables**
- Task packet builder.
- Review packet builder.
- Packet hashing.
- Packet freshness metadata.
- Untrusted provider text separation.

**Acceptance**
- Packet includes required IDs, provider context, repo context, acceptance criteria, policy, capabilities, freshness, and required outputs.
- Provider comments are quoted/provenance-linked and cannot become system instructions.

### COL-2.5 — Developer Execution Flow

- [ ]

**Depends on:** COL-2.2, COL-2.3, COL-2.4

**Deliverables**
- Supervisor activity to start Developer run.
- Branch creation/fetch/push through Tool Gateway git proxy.
- Developer completion envelope ingestion.
- MR/PR open through Provider Adapter.

**Acceptance**
- Developer run can produce branch + MR for a task.
- Completion envelope must reference MR and commit artifact.
- Stale envelope freshness is rejected.

### COL-2.6 — GitLab Adapter: MR/PR, Commits, Pipelines

- [ ]

**Depends on:** COL-1.2

**Deliverables**
- MR open/update/comment/close/merge.
- Commit lookup and diff summary.
- Pipeline status lookup and webhook normalization.
- Approval lookup.

**Acceptance**
- Integration test covers MR creation, pipeline status ingestion, and approval status normalization.

### COL-2.7 — Reviewer Execution Flow

- [ ]

**Depends on:** COL-2.3, COL-2.4, COL-2.6

**Deliverables**
- Supervisor activity to start Reviewer run.
- Review packet generation.
- Reviewer envelope validation.
- Provider comment for approval or changes requested.
- Review finding persistence.

**Acceptance**
- Reviewer approval moves task toward `merge_ready` when other gates pass.
- Reviewer changes requested moves task to `changes_requested`.
- Findings include severity, evidence, acceptance criterion reference, confidence.

### COL-2.8 — HITL Gate Enforcement

- [ ]

**Depends on:** COL-0.8, COL-1.4, COL-2.7

**Deliverables**
- Spec/DAG approval gate.
- MR/PR approval gate.
- Human review conditional rules.
- Stale approval invalidation on new commit, failed pipeline, changes requested, or policy version change.

**Acceptance**
- Gate opens only when all applicable approvals/checks are present.
- New commit invalidates approval on prior SHA.
- Human `/approve` is ignored if actor lacks capability.

### COL-2.9 — Merge And Close Flow

- [ ]

**Depends on:** COL-2.6, COL-2.8

**Deliverables**
- `merge_ready` transition.
- Developer-initiated gated merge through provider write path.
- Webhook verification of merged commit.
- Task close after merge + provider issue close + audit.

**Acceptance**
- No merge without current approvals, green pipeline, no blocking threads, and Task Graph `merge_ready`.
- Task does not close until provider issue and MR state reconcile.

### COL-2.10 — Phase 2 End-To-End Acceptance

- [ ]

**Depends on:** COL-1.9, COL-2.5, COL-2.7, COL-2.8, COL-2.9

**Deliverables**
- CSV-export example task through real MR.

**Acceptance**
- Task goes `ready -> claimed -> in_progress -> review_requested -> merge_ready -> merged -> closed`.
- Reviewer approval, green pipeline, and human `/approve` are required.
- Audit trail links provider event, workflow action, envelope hash, and resulting state version.

## Phase 3 — Reconciliation, Conflicts, And Pending Sync

Goal: make drift, provider outages, manual changes, stale evidence, and operator overrides explicit workflow states.

### COL-3.1 — Reconciliation Engine

- [ ]

**Depends on:** COL-2.9

**Deliverables**
- `reconcile_scope(scope_id)`.
- Checks for MR state, commit SHA, pipeline status, approvals, provider issue state, labels, audit, `pending_sync`, conflicts.
- Reconcile report type.

**Acceptance**
- Reconcile detects stale commit approval.
- Reconcile detects provider issue closed while MR is open.
- Reconcile auto-corrects label drift.

### COL-3.2 — Periodic Reconciliation Timer

- [ ]

**Depends on:** COL-3.1

**Deliverables**
- Temporal 15-minute active scope reconcile timer.
- Reconcile activity idempotency keys.

**Acceptance**
- Active scopes reconcile periodically.
- Repeated reconcile with no drift is a no-op.

### COL-3.3 — Provider Outage And Pending Sync

- [ ]

**Depends on:** COL-3.1

**Deliverables**
- Adapter health check.
- Freeze provider-visible actions.
- Mark already-claimed agent outputs as `pending_sync`.
- Recovery publish/diff flow.
- 72-hour abandon threshold.

**Acceptance**
- Provider outage blocks new visible actions and irreversible actions.
- Already-claimed work can finish internally but cannot advance DAG until reconciliation.
- Recovery publishes matching outputs and conflicts mismatches.

### COL-3.4 — Conflict State And Resolution

- [ ]

**Depends on:** COL-3.1

**Deliverables**
- Conflict event model.
- Conflict states for task/scope.
- Auto-resolve classes: label drift, projection mismatch, stale-pipeline-clear-on-new-green.
- Human-required classes: manual merge/close, stale commit + human approval, policy violation, unauthorized action.

**Acceptance**
- Manual merge creates conflict.
- Missing audit blocks close.
- Auto-resolvable label drift is corrected and audited.

### COL-3.5 — Operator Override Flow

- [ ]

**Depends on:** COL-3.4, COL-1.4

**Deliverables**
- `/override <reason>` handling.
- UI override action.
- `policy.override` capability check.
- Audit record with operator identity and reason.

**Acceptance**
- Override without reason is rejected.
- Override without capability is rejected and audited.
- Successful override links actor, reason, target, previous state, new state.

### COL-3.6 — Web UI Conflict Operations

- [ ]

**Depends on:** COL-3.4, COL-3.5

**Deliverables**
- Conflict/reconciliation view.
- Resolve conflict action.
- Operator override action.
- Manual requeue.
- Run cancel.
- Scope cancel.

**Acceptance**
- UI shows conflict class, detected facts, expected facts, source provider artifact, and recovery options.
- UI writes are capability checked and audited.

### COL-3.7 — Phase 3 End-To-End Acceptance

- [ ]

**Depends on:** COL-3.3, COL-3.4, COL-3.6

**Deliverables**
- Outage scenario test.
- Manual merge conflict scenario test.

**Acceptance**
- Provider outage prevents irreversible actions.
- Pending sync recovers cleanly after provider return.
- Manual merge creates conflict visible in UI.

## Phase 4 — Memory, Policy Hardening, Release, And Second Provider

Goal: add durable memory/decision records, richer policy, release role, richer UI, and prove provider abstraction with GitHub.

### COL-4.1 — Memory Tables And Candidate Flow

- [ ]

**Depends on:** COL-0.6, COL-2.4

**Deliverables**
- `memory_records`.
- `memory_candidates`.
- Candidate proposal API.
- Conservative Supervisor acceptance path.
- Supersede/expire operations.

**Acceptance**
- Agents can propose but not directly write shared memory.
- Accepted memory records link to source artifact/run/evidence.

### COL-4.2 — Memory Retrieval Into Packets

- [ ]

**Depends on:** COL-4.1

**Deliverables**
- Memory bundle retrieval by scope/task/type/filter.
- 2KB-per-type budget enforcement.
- Decision/procedural/policy bundle injection into task/review packets.

**Acceptance**
- Packets include relevant accepted decisions.
- Raw memory is not dumped wholesale.

### COL-4.3 — Decision Records

- [ ]

**Depends on:** COL-4.1

**Deliverables**
- Decision record schema.
- Fields for problem, alternatives, selected option, assumptions, evidence, affected files/modules, rollback plan, owner, revisit trigger.
- UI summary view.

**Acceptance**
- Accepted decision record appears in task packet when relevant.
- Decision can be superseded or expired.

### COL-4.4 — Policy Hardening

- [ ]

**Depends on:** COL-2.8, COL-3.5

**Deliverables**
- Protected path policies.
- Security-sensitive labels.
- Always-human-review mode.
- Per-scope namespace thresholds.
- Discovered-work auto-accept policy classes, default none.

**Acceptance**
- Protected path forces human review.
- Security-sensitive scope forces human review.
- Discovered work does not become a task unless policy/human approval allows it.

### COL-4.5 — Discovered Work Workflow

- [ ]

**Depends on:** COL-4.4

**Deliverables**
- Proposal record for discovered work.
- Supervisor classification: blocker, in-scope follow-up, out-of-scope follow-up, scope change, rejected.
- Approval flow.
- DAG insertion for accepted blocker.
- Follow-up linkage.

**Acceptance**
- Rejected proposal remains in audit but does not affect readiness.
- Accepted blocker blocks current task and inserts dependency.
- Accepted follow-up does not block current task.

### COL-4.6 — Integrator / Release Role

- [ ]

**Depends on:** COL-3.1, COL-4.4

**Deliverables**
- Integrator packet.
- Release/deploy precheck.
- Release gate.
- Release/deploy audit record.
- Dry-run deploy path for pilot.

**Acceptance**
- No deploy without all linked tasks closed and release gate approved.
- Release action is attributable to Integrator/Release role.

### COL-4.7 — Richer Web UI Views

- [ ]

**Depends on:** COL-4.2, COL-4.3, COL-4.4

**Deliverables**
- Memory/decision view.
- Policy view.
- Scope close readiness view.
- Filtered stakeholder audit view.

**Acceptance**
- Operator can see why memory/decision context was included in a packet.
- Operator can see effective policy for a scope/task.

### COL-4.8 — GitHub Adapter

- [ ]

**Depends on:** COL-1.1, COL-3.1

**Deliverables**
- GitHub implementation of provider adapter for issues, comments, PRs, reviews, branches, commits, checks, labels, users, webhooks.
- Provider parity test suite reused from GitLab.

**Acceptance**
- GitHub adapter passes the same provider contract tests as GitLab where equivalent features exist.
- Gaps are documented as adapter capability differences.

### COL-4.9 — Phase 4 End-To-End Acceptance

- [ ]

**Depends on:** COL-4.2, COL-4.5, COL-4.6, COL-4.8

**Deliverables**
- Full multi-task scope demo across at least three tasks.
- Memory-informed packet.
- Release gate.
- GitHub provider adapter test.

**Acceptance**
- Scope runs decomposition -> tasks -> MR review/merge -> scope review -> release gate -> closed.
- No `pending_sync` or `conflict` remains at scope close.
- GitHub adapter passes provider E2E suite.

## Cross-Cutting Work

These tasks run alongside phases when their dependencies are available.

### COL-X.1 — Observability Baseline

- [ ]

**Depends on:** COL-0.3

**Deliverables**
- OTel traces with `scope_id`, `task_id`, `run_id`, `workflow_id`.
- Prometheus metrics for workflow latency, claim contention, envelope rejection rate, provider write retries, sandbox cold-start latency, tool gateway errors, reconciliation mismatches.
- Loki log labels by service and run ID.

**Acceptance**
- A synthetic scope can be followed across API, workflow, worker activity, and audit via trace IDs.

### COL-X.1a — GitLab CI Hardening

- [ ]

**Depends on:** COL-0.3a, COL-2.10

**Deliverables**
- Pipeline stages for unit, integration, E2E, image build, scan, deploy preview, deploy Aether.
- GitLab registry image tagging strategy.
- Protected branch/tag deploy rules.
- CI variables/secrets documented with Aether/OpenBao/SOPS ownership.

**Acceptance**
- MR pipeline gates code quality and tests.
- Protected deploy jobs cannot run from unprotected refs.
- Container images are pushed to the GitLab registry with commit SHA tags.

### COL-X.2 — Audit Integrity And Retention Baseline

- [ ]

**Depends on:** COL-0.6

**Deliverables**
- Audit retention policy defaults.
- Transcript/diff retention defaults.
- Optional future cryptographic integrity ADR.

**Acceptance**
- Audit records are append-only.
- Retention settings are configurable by environment.

### COL-X.3 — Threat Model Worksheet

- [ ]

**Depends on:** COL-0.4, COL-2.1

**Deliverables**
- STRIDE-style worksheet for compromised agent run, prompt injection, leaked token, malicious dependency, webhook spoofing, unsafe tool call, supply chain compromise.
- Mitigation tasks linked back to implementation work.

**Acceptance**
- Every threat in `design.md` maps to at least one mitigation or explicit accepted risk.

### COL-X.4 — Runbooks

- [ ]

**Depends on:** COL-3.1

**Deliverables**
- Provider outage runbook.
- Manual merge conflict runbook.
- Stale approval runbook.
- Sandbox failure runbook.
- Temporal workflow stuck/replay runbook.

**Acceptance**
- Each runbook includes detection, impact, operator steps, verification, and rollback/escalation.

## Initial Critical Path

1. COL-0.1
2. COL-0.2
3. COL-0.3
4. COL-0.3a
5. COL-0.3b
6. COL-0.4
7. COL-0.6
8. COL-0.7
9. COL-0.8
10. COL-0.9
11. COL-0.10
12. COL-0.11
13. COL-0.12
14. COL-0.13

After Phase 0, the next critical path is:

1. COL-1.1
2. COL-1.2
3. COL-1.3
4. COL-1.4
5. COL-1.5
6. COL-1.6
7. COL-1.8
8. COL-1.9

Phase 2 should not start real Developer/Reviewer execution until COL-2.1 minimum sandbox egress enforcement is complete.
