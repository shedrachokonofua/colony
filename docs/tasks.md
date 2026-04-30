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
  - `packages/agent-runtime`
  - `packages/config`
  - `packages/db`
  - `packages/domain`
  - `packages/observability`
  - `packages/policy`
  - `packages/provider`
  - `packages/provider-gitlab`
  - `packages/schemas`
  - `packages/testing`
  - `packages/workflows`
- Shared lint, test, typecheck, and formatting commands.
- Nix flake dev shell with Node.js LTS, npm, Temporal tooling, Postgres client tools, Kubernetes tooling, GitLab CLI, formatting/linting tools, and CI generators.
- npm workspace package layout.

**Acceptance**

- `nix develop` enters a shell with the project toolchain.
- `npm install`, `npm run typecheck`, and `npm test` run from repo root inside the dev shell.
- A trivial import from `packages/domain` works in `apps/api` and `apps/worker`.
- `packages/workflows` is documented as workflow-safe and kept separate from activities, DB, provider clients, Tool Gateway, Pi integration, process/env access, randomness, and wall-clock reads.

### COL-0.2 — Choose Framework And Tooling ADRs

- [x]

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
- Decisions align with `design.md`: TypeScript/Node, Hono + `@hono/zod-openapi` + `@scalar/hono-api-reference` for APIs, SvelteKit (Svelte 5, `@sveltejs/adapter-node`) for the Web UI, HTTP + JSON/OpenAPI, Zod schemas end-to-end, Postgres, Temporal, Nix dev shell, GitLab CI, Docker Compose for local infra with apps via `npm run dev`, and Aether-hosted deployment via in-repo OpenTofu Kubernetes resources into a `colony-dev` namespace first.

### COL-0.3 — Nix Local Development Environment

- [x]

**Depends on:** COL-0.1, COL-0.2

**Deliverables**

- `flake.nix` and lockfile for the Colony dev shell.
- `docker-compose.yml` for local Temporal and Postgres, with `temporal`, `temporal_visibility`, and `colony` databases initialized.
- Per-app `npm run dev` scripts so API, worker, webhook dispatcher, tool gateway, and Web UI run as native watch processes against the Compose infra.
- Local configuration pointing the provider adapter at the home-lab GitLab over the LAN (dedicated Colony dev group/project, separate bot token, webhook URL pointing at the laptop's LAN address). The fake provider adapter from COL-1.1 remains a test-only fixture, not the `npm run dev` default.
- Developer docs for booting the stack (`docker compose up` + `npm run dev`), with Aether `colony-dev` called out as the k8s validation target (not a local k8s cluster).

**Acceptance**

- A new developer can enter `nix develop`, run `docker compose up`, and start the control plane apps with `npm run dev` from documented commands.
- API can connect to Postgres.
- Worker can connect to Temporal.
- Web UI can call the API health endpoint.
- A test issue created in the home-lab GitLab dev project fires a webhook to the local webhook dispatcher over the LAN and lands as a Task Graph event.

### COL-0.3a — GitLab CI Baseline

- [x]

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

- [x]

**Depends on:** COL-0.2

**Deliverables**

- Deployment ownership doc describing what lives in Colony vs. `~/projects/aether`.
- Initial Aether integration notes for namespace, ingress, secrets, GitLab runner, registry, observability, and database/storage assumptions.
- List of required Aether changes as follow-up tasks or MRs.

**Acceptance**

- There is a clear boundary between app manifests in Colony and infrastructure wiring in Aether.
- Required Aether secrets, DNS/ingress, and GitLab runner assumptions are documented before deployment work starts.

### COL-0.4 — Core Domain Types And State Machines

- [x]

**Depends on:** COL-0.1

**Deliverables**

- TypeScript domain types for scopes, tasks, dependencies, assignments, gates, reviews, approvals, artifacts, events, audit records, agent runs, provider mirrors, policies, capability grants.
- Enumerations for scope states and task states from `design.md`.
- Transition validation helpers with owner/precondition metadata.

**Acceptance**

- Unit tests cover valid and invalid state transitions.
- Invalid transitions produce structured errors with code, message, details, and retriable flag.

### COL-0.5 — Envelope And Packet Schemas

- [x]

**Depends on:** COL-0.1, COL-0.4

**Deliverables**

- Zod schemas (shared between agent envelope validation and the Hono HTTP boundary via `@hono/zod-openapi`) for:
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

- [x]

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

- [x]

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

- [x]

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

- [x]

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

- [x]

**Depends on:** COL-0.3, COL-0.7

**Deliverables**

- Temporal worker package.
- `supervisor-<scope_id>` workflow skeleton in `packages/workflows`.
- Activities for reading scope/task state and recording workflow events.
- Signal handlers for provider event, approval, changes requested, pipeline update, and operator override.

**Acceptance**

- Local Temporal can start a scope workflow.
- Signals are recorded as Task Graph events.
- Workflow history stores pointers/normalized data only, not large payloads.
- Workflow code does not import DB, provider adapter, Tool Gateway, config, observability setup, or agent runtime packages directly.

### COL-0.11 — Webhook Dispatcher Skeleton

- [x]

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

- [x]

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

- [x]

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

Goal: mirror GitLab scope/task artifacts, ingest provider events, and run Supervisor assignment logic without executing agents yet. Scopes may span multiple repos/projects; any single-project GitLab setting is only a local default for dogfooding and adapter tests.

### COL-1.1 — Provider Adapter Interface

- [x]

**Depends on:** COL-0.2, COL-0.4

**Deliverables**

- TypeScript `ProviderAdapter` interface for issues, epics/parent issues, comments, labels, assignees, MRs/PRs, approvals, branches, commits, pipelines, users, webhooks, and **bootstrap (provision groups, projects, bot users, bot PATs, OAuth Application, webhook from a request-scoped admin credential)**.
- Provider domain types separate from Colony domain types.
- Fake provider adapter for tests.

**Acceptance**

- Fake adapter supports create/update/comment/label flows and an in-memory bootstrap that returns deterministic IDs.
- Adapter methods return stable provider IDs and normalized metadata.

### COL-1.1a — Provider Bootstrap Operation

- [x]

**Depends on:** COL-0.8, COL-0.9, COL-1.1

**Deliverables**

- `ProviderAdapter.bootstrap(spec)` GitLab implementation: idempotent provisioning of group, project, role-keyed bot users marked `bot=true`, per-bot PATs with role-scoped permissions, instance-wide OAuth Application for Web UI sign-in, and the project webhook (URL + secret).
- API endpoint on `apps/api`: `POST /admin/provider/bootstrap` taking a request-scoped admin credential and returning a structured result + redacted `.env` snippet.
- Capability `provider.admin.bootstrap` granted only to a human admin actor; never to agents.
- Audit event written for every bootstrap action with actor, redacted result, and a hash of the admin credential.
- Re-running the operation rotates tokens and corrects drift idempotently.

**Acceptance**

- Running bootstrap against a clean home-lab GitLab project creates all resources and returns IDs.
- Re-running is a no-op (or rotates tokens when configured) and writes a second audit event.
- Admin credential is never persisted; capability check denies non-admin actors.
- Two-environment workflow (dev + prod) works by invoking with two different specs.

### COL-1.2 — GitLab Adapter: Issues, Comments, Labels

- [x]

**Depends on:** COL-1.1

**Deliverables**

- GitLab implementation for issue create/update/close/reopen.
- Comment posting.
- Label add/remove.
- Assignee update.
- User identity lookup.

**Acceptance**

- Integration test against the home-lab GitLab covers issue mirror lifecycle.
- Provider IDs are stored only in `provider_mirrors`; any project/repo context needed by adapter calls is passed explicitly rather than read from a durable singleton.
- GitLab-specific dependencies live in `packages/provider-gitlab`, not `packages/provider`.

### COL-1.1b — Generalize Bootstrap To N Bots

- [x]

**Depends on:** COL-1.1a

**Deliverables**

- `BootstrapBotSpec` accepted as a record/list keyed by role name rather than the hardcoded `{ engine, reviewer }` shape.
- `ProviderBootstrapResult.bot_users` and `bot_tokens` mirror the role keying.
- GitLab adapter loops over the bot spec, calling `users.create` + `personal_access_tokens` per entry idempotently. Existing `engine`/`reviewer` defaults remain when `bots` is omitted so older callers don't break.
- Predefined role set seeded by default: `engine` (developer), `reviewer`, `architect`, `integrator`, `memory_consolidator`, `supervisor` (service identity, no provider writes).
- Fake adapter mirrors the same shape.
- `secrets/dev.yaml` shape documented as a _map_ of role → token rather than a single `GITLAB_TOKEN` (with `GITLAB_TOKEN` retained as the default `engine` alias for back-compat with current adapter constructor wiring).

**Acceptance**

- A bootstrap call with five bots provisions five GitLab users + five PATs and returns them keyed by role.
- Re-running rotates each PAT idempotently without leaving orphan users.
- Adding a new role (e.g. `data_steward`) requires only a config-side spec entry, no code change to the adapter or bootstrap result type.
- Live test against home-lab GitLab covers at least three roles end-to-end.

### COL-1.1c — Persist Bot Registry To `provider_identities`

- [x]

**Depends on:** COL-1.1b, COL-0.8

**Deliverables**

- Bootstrap writes one `provider_identities` row per minted bot mapping a Colony actor ID (e.g. `bot:engine`, `bot:architect`) to the provider user ID, with `is_bot=true` and the role set correctly.
- Repository method `getProviderIdentitiesForRole(role)` so the Tool Gateway can resolve "give me the bot for this role" at request time.
- Audit trail per identity write.
- `task bots:list` reads `provider_identities` and prints role → username → token-fingerprint (no plaintext tokens).

**Acceptance**

- After bootstrap, every bot has a row in `provider_identities` with the correct role and `is_bot=true`.
- Identity lookups by role return the canonical bot for that role.
- Re-running bootstrap is a no-op against the registry (no duplicate rows; existing rows update in place).

### COL-1.1d — Per-Bot Capability Grants

- [x]

**Depends on:** COL-1.1c

**Deliverables**

- Seed migration that grants each bot role its capability set:
  - `bot:engine` — `provider.issues.*`, `provider.mr.*`, `provider.branches.*`, `provider.commits.*`.
  - `bot:reviewer` — `provider.issues.comment`, `provider.mr.approve`, `provider.mr.comment`, `provider.mr.review_thread`.
  - `bot:architect` — `graph.write` (scoped), `provider.issues.create`, `provider.epics.*`.
  - `bot:integrator` — `provider.mr.merge`, `provider.branches.protect`, `provider.pipelines.*`.
  - `bot:memory_consolidator` — `provider.issues.update`, `provider.issues.addLabel/removeLabel`.
  - `bot:supervisor` — service-only: `graph.write`, `audit.write`, no provider writes.
- Tool Gateway resolves the calling actor's role → picks the right bot's PAT for the underlying adapter call. Token narrowing is implicit in this lookup.
- Capability check refuses if the calling actor's role doesn't carry the capability for the requested op.

**Acceptance**

- An agent with role `developer` calling `provider.mr.merge` is denied; an agent with role `integrator` is allowed.
- The token sent to GitLab varies per role: `bot:engine`'s PAT for engine-shaped calls, `bot:reviewer`'s PAT for review calls.
- Audit log records the bot identity used for every adapter call.

### COL-1.1e — Per-Namespace Bot Scoping

- [x]

**Depends on:** COL-1.1d, COL-1.2b

**Deliverables**

- `provider_identities` extended with `allowed_namespaces: text[]` (empty array = unrestricted; populated array = allowlist).
- Tool Gateway pre-flight: resolves `ProviderProjectRef.path` (or its namespace prefix) against the calling bot's allowed list before invoking the adapter; refuses with a typed error otherwise.
- Provider-side defense-in-depth path documented: bots removed from GitLab admin, added only to specific groups they should reach. (Operational change, not code — keep the homelab posture optional.)
- `task bots:scope` operator command to set/extend `allowed_namespaces` for a bot.

**Acceptance**

- A bot with `allowed_namespaces=['colony']` calling `issues.create` against a project under `other-org/...` is denied at the gateway.
- A bot with empty `allowed_namespaces` falls back to "anything that succeeds at the provider" (homelab default).
- Scope changes are auditable.

### COL-1.1f — Bot Lifecycle Operator UX

- [x]

**Depends on:** COL-1.1c

**Deliverables**

- `task bots:add ROLE=architect` mints a new bot, rotates its PAT, persists `provider_identities`, updates `secrets/dev.yaml` with the new token (encrypted in place), writes audit row.
- `task bots:rotate [ROLE=...]` rotates one or all PATs and re-encrypts `secrets/dev.yaml`.
- `task bots:list` prints role / username / token-fingerprint / scope.
- `task bots:remove ROLE=...` revokes the PAT, marks the GitLab user disabled, writes audit row, leaves the `provider_identities` row with a `disabled_at` timestamp (no hard delete — preserves audit referential integrity).

**Acceptance**

- An operator can add a new role, rotate it, and remove it without touching the codebase.
- `secrets/dev.yaml` after rotation decrypts to a fresh token map; old tokens are revoked GitLab-side.
- `bots:list` matches what `provider_identities` says is current.

### COL-1.2b — Multi-Repo Provider Target Model

- [x]

**Depends on:** COL-0.7, COL-1.2

**Deliverables**

- Domain and repository types for provider project/repo registry:
  - `provider_projects` — provider, provider project ID/path, default branch, visibility, metadata.
  - `scope_targets` — many provider projects per scope, with roles such as `primary`, `frontend`, `backend`, `data`, `infra`, `docs`, or `shared`.
  - `task_targets` — one primary provider project per task plus optional secondary affected projects.
- Migration(s), repository methods, and tests for registering provider projects and linking scope/task targets.
- Provider adapter operation shapes updated so issue/MR/branch/pipeline calls receive project context per operation; local `GITLAB_DEV_PROJECT_ID` remains a test/dogfood default only.
- Webhook lookup design updated to include provider project ID/path when resolving provider events to `provider_mirrors`.

**Acceptance**

- A single scope can be linked to at least two GitLab projects in tests.
- Tasks can be created with distinct primary provider projects under the same scope.
- Provider mirror uniqueness includes enough project/repo context to avoid collisions across GitLab projects.
- Existing single-project local dev flow still works by registering `GITLAB_DEV_PROJECT_ID` as the default provider project.

### COL-1.3 — Scope And Task Mirror

- [x]

**Depends on:** COL-1.2b

**Deliverables**

- Scope epic/parent issue -> Task Graph scope mirror, associated with one or more provider project targets.
- Task -> provider issue mirror in the task's primary provider project.
- Multi-repo decomposition support: frontend/backend/data/etc. tasks under one scope can target different provider projects.
- Projection version metadata.
- Provider projection writes through Supervisor activities.

**Acceptance**

- Creating a scope creates or links the provider parent issue.
- Creating a task creates or links a provider issue in the correct provider project.
- One scope with at least two provider projects can create tasks mirrored to different GitLab projects.
- Projection drift can be detected from stored version metadata.

### COL-1.4 — Provider Command Parser

- [x]

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

- [x]

**Depends on:** COL-1.4, COL-0.11

**Deliverables**

- Classification into `valid_command`, `context_update`, `review_feedback`, `approval`, `conflict`, `noop`, `needs_clarification`.
- Signal payloads for Supervisor workflow.

**Acceptance**

- Unit tests classify comment, issue edit, label change, close/reopen, approval, MR update, pipeline update.
- Classification is audit-recorded.

### COL-1.6 — Supervisor Ready/Claim/Assign Loop

- [x]

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

- [x]

**Depends on:** COL-1.3, COL-1.6

**Deliverables**

- Scope/task provider mirror status.
- Provider sync timestamps and projection version.
- Workflow state display.

**Acceptance**

- UI shows whether a scope/task is synced, pending, or drifted.
- UI links to provider issue URLs.

### COL-1.8 — Phase 1 End-To-End Acceptance

- [x]

**Depends on:** COL-1.2, COL-1.6, COL-1.7

**Deliverables**

- Scripted demo against the home-lab GitLab dev project.

**Acceptance**

- Open provider parent issue -> scope mirror appears.
- Approve mock decomposition -> `state:ready` tasks appear.
- Supervisor claims a task and mirrors assignment/provider label.

### COL-1.9 — Aether Preview Deployment

- [x]

**Depends on:** COL-0.3b, COL-1.8

**Deliverables**

- In-repo Tofu module at `tofu/` deploying Colony directly to the Aether host cluster (not into the seven30 vcluster). Apply authority is Colony, per ADR-007. Resources are written via `kubernetes_*` providers — no Helm chart for Colony's own services. Covers API, worker, webhook dispatcher, tool gateway, Web UI, ServiceAccounts, HTTPRoutes attached to Aether's main Gateway, plus a preview in-namespace **Postgres** StatefulSet and Postgres ingress NetworkPolicy. The first preview reuses Aether's existing Dokku Temporal deployment through `grpc.temporal.home.shdr.ch:443` rather than installing Temporal in `colony-dev`; `SandboxTemplate` CRs land alongside agent-sandbox controller availability (Phase 2).
- `tofu/main.tf` with `backend "http"` against `gitlab.home.shdr.ch/api/v4/projects/49/terraform/state/colony`, `kubernetes` / `vault` providers, and explicit kubeconfig path support for local and CI runs. Reads OpenBao via `data "vault_kv_secret_v2"` and writes `kubernetes_secret_v1` directly (no ESO on host).
- Namespaces created from the module: `colony-dev` first, with `*-dev.home.shdr.ch` hostnames. `colony` (prod control plane) and `colony-sandboxes` (Phase 2 agent pods) land in later iterations.
- GitLab CI `plan` and `apply` jobs (already declared in `.gitlab-ci.yml`) flip on once `tofu/main.tf` exists. Apply is `when: manual` on `main`.
- Runtime images use Debian slim plus CA roots so Temporal's native bridge can load glibc and validate `grpc.temporal.home.shdr.ch:443`.
- `kv/colony/gitlab` is populated in OpenBao for the dev deployment. `GITLAB_DEV_PROJECT_ID` / `GITLAB_PROJECT_ID` point at the Colony GitLab project for the current dogfood preview.

**Acceptance**

- Preview deployment runs in the Aether host cluster's `colony-dev` namespace pointed at the home-lab GitLab dev project.
- Web UI is reachable at `https://colony-dev.home.shdr.ch/` through Aether's existing main Gateway.
- API, tool gateway, and webhook dispatcher health endpoints return `200` through their public `*-dev.home.shdr.ch` hostnames.
- The worker starts, connects to Temporal at `grpc.temporal.home.shdr.ch:443`, and polls `colony-supervisor`.
- Tofu local apply reconciles the cluster state cleanly; CI plan/apply wiring is committed for main/manual reconciliation.

## Phase 2 — Developer, Reviewer, And Merge Flow

Goal: execute real Developer and Reviewer runs in sandboxes with minimum egress enforcement, packets, envelopes, MR/PR lifecycle, review gates, and pipeline ingestion.

### COL-2.1 — Minimum Sandbox Egress Enforcement

- [x]

**Depends on:** COL-0.3, COL-0.8

**Deliverables**

- Sandbox launch profile for Developer and Reviewer.
- Default-deny egress.
- No direct Task Graph API access from agent sandboxes.
- Provider API access through Provider Adapter only.
- Repo/package/LLM access only through deployer-approved egress, scoped credentials, or Tool Gateway allowlists.

**Acceptance**

- Agent sandbox cannot reach Task Graph API.
- Agent sandbox can access only approved repo/package/LLM endpoints for the selected run environment.
- Denied egress is logged.

### COL-2.2 — Tool Gateway Credentials And Egress

- [x]

**Depends on:** COL-0.8, COL-2.1

**Deliverables**

- Tool Gateway capability checks.
- Scoped provider bot credential resolution for prepared sandbox environments.
- Package registry and external-service allowlists.
- Per-run credential handling and redaction.
- Tool call audit records.

**Acceptance**

- Developer can push a branch with normal `git` only when the run has a scoped credential and `provider.branches.push`.
- Unauthorized credential or package access fails and is audited.
- Secrets are not present in logs.

### COL-2.3 — Agent Skill Bundle Registry

- [x]

**Depends on:** COL-2.1

**Deliverables**

- Skill bundle manifest type for read-only agent instructions and references.
- Configured skill source paths scanned for `SKILL.md` entries.
- Per-skill metadata: name, description, source, content hash, and mount path.
- Run manifest section recording selected skills and hashes.
- Validation that skill mounts are read-only and live under Colony-owned sandbox paths.

**Acceptance**

- Agent run setup can select a subset of registered skills without mounting the whole source repository.
- Duplicate skill names or mount paths are rejected.
- Run metadata records the exact skill names and hashes used.

### COL-2.4 — Generic CLI Tool Manifests

- [x]

**Depends on:** COL-2.1, COL-2.3

**Deliverables**

- Generic CLI tool manifest type with name, executable, resolver, package reference, env allowlist, args policy label, and required capabilities.
- `tool.cli.execute` capability for prepared-environment CLI execution.
- Runtime validation that CLI tool presence does not automatically grant capabilities.
- Run manifest section recording selected CLI tools and their resolver/package references.

**Acceptance**

- A sandbox profile can declare ordinary CLI tools without Colony knowing the target system behind them.
- Adding a CLI tool to the prepared environment does not add its required capability to the actor.
- Provider credential resolution does not treat generic CLI execution as provider API authority.

### COL-2.5 — Nix-Backed Sandbox Tool Materialization

- [x]

**Depends on:** COL-2.4

**Deliverables**

- Nix profile manifest with flake reference, package refs, and resolved profile hash.
- Sandbox preparation step that materializes declared CLI tools onto the agent `PATH`.
- Audit/run metadata for resolved tool versions or profile hash.
- Fallback resolver contract for deployers that satisfy tools through images or platform templates instead of Nix.

**Acceptance**

- A run can receive a prepared environment with normal CLI binaries available on `PATH`.
- The resolved Nix/tool profile is pinned or hash-recorded in run metadata.
- No secrets or credentials are introduced by installing CLI packages alone.

### COL-2.6 — Deployer Runtime Bindings

- [x]

**Depends on:** COL-2.4, COL-2.5

**Deliverables**

- Deployer-owned binding model for env vars, read-only config mounts, credentials, egress, and service account/RBAC choices.
- Runtime binding input accepted by `start_run` without hard-coding specific external systems.
- Documentation that skills and CLI tools are requests/inputs, while deployer bindings provide actual environment authority.
- Local/dev and pilot/prod guidance for permissive vs. restrictive network posture.

**Acceptance**

- The same CLI tool manifest can be bound differently by different deployments.
- Credentials/config mounts are explicit run inputs and are not implied by skill or package selection.
- Run metadata records which deployer binding name/hash was applied.

### COL-2.7 — Agent Runtime Adapter

- [x]

**Depends on:** COL-0.5, COL-2.1, COL-2.3, COL-2.4, COL-2.5, COL-2.6

**Deliverables**

- `start_run(packet, run_environment)`.
- `get_run_status`.
- `get_run_output`.
- `cancel_run`.
- pi-coding-agent integration for Developer.
- pi-mono print/JSON integration for Reviewer.

**Acceptance**

- Fake agent run can return a valid envelope.
- Malformed envelope is rejected.
- Run metadata stores sandbox ID, packet hash, output envelope hash.
- Pi-specific integration lives in `packages/agent-runtime`, not in workflow code.

**Status:** complete. The adapter shell, fake adapter, `PiAgentRuntimeAdapter`, concrete Pi runners, packet hashing, envelope capture/validation, and worker runtime selection are landed. Pi-specific code lives in `packages/agent-runtime`; runtime wiring lives in `apps/worker/src/agent-runtime-factory.ts`.

### COL-2.8 — Task And Review Packet Generation

- [x]

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

### COL-2.9 — Developer Execution Flow

- [x]

**Depends on:** COL-2.2, COL-2.7, COL-2.8

**Deliverables**

- Supervisor activity to start Developer run.
- Branch creation/fetch/push through normal `git` in the prepared sandbox using scoped provider bot credentials.
- Developer completion envelope ingestion.
- MR/PR open through Provider Adapter.

**Acceptance**

- Developer run can produce branch + MR for a task.
- Completion envelope must reference MR and commit artifact.
- Stale envelope freshness is rejected.

**Status:** complete. The supervisor activity (`apps/worker/src/developer-run.ts`), branch/MR open through the provider adapter, completion-envelope ingestion, freshness check, and `claimed -> in_progress -> review_requested` transitions are landed. Live Pi/Kimi Developer execution has been exercised against home-lab GitLab; fake mode remains the deterministic CI default.

### COL-2.10 — GitLab Adapter: MR/PR, Commits, Pipelines

- [x]

**Depends on:** COL-1.2

**Deliverables**

- MR open/update/comment/close/merge.
- Commit lookup and diff summary.
- Pipeline status lookup and webhook normalization.
- Approval lookup.

**Acceptance**

- Integration test covers MR creation, pipeline status ingestion, and approval status normalization.

### COL-2.11 — Reviewer Execution Flow

- [x]

**Depends on:** COL-2.7, COL-2.8, COL-2.10

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

**Status:** complete. Review packet generation, Pi reviewer envelope capture/validation, provider review comments, finding persistence, and approval/changes-requested state effects are landed. Live Pi reviewer smoke has been exercised; fake mode remains the deterministic CI default.

### COL-2.12 — HITL Gate Enforcement

- [x]

**Depends on:** COL-0.8, COL-1.4, COL-2.11

**Deliverables**

- Spec/DAG approval gate.
- MR/PR approval gate.
- Human review conditional rules.
- Stale approval invalidation on new commit, failed pipeline, changes requested, or policy version change.

**Acceptance**

- Gate opens only when all applicable approvals/checks are present.
- New commit invalidates approval on prior SHA.
- Human `/approve` is ignored if actor lacks capability.

### COL-2.13 — Merge And Close Flow

- [x]

**Depends on:** COL-2.10, COL-2.12

**Deliverables**

- `merge_ready` transition.
- Developer-initiated gated merge through provider write path.
- Webhook verification of merged commit.
- Task close after merge + provider issue close + audit.

**Acceptance**

- No merge without current approvals, green pipeline, no blocking threads, and Task Graph `merge_ready`.
- Task does not close until provider issue and MR state reconcile.

### COL-2.14 — Phase 2 End-To-End Acceptance

- [x]

**Depends on:** COL-1.9, COL-2.9, COL-2.11, COL-2.12, COL-2.13, COL-2.15, COL-2.16

**Deliverables**

- `task acceptance:phase2` (or `npm run acceptance:phase2`) target that drives a CSV-export example task through a real MR with `AGENT_RUNTIME=pi` against the home-lab GitLab — there is no fake-runtime acceptance variant. The fake adapter is reserved for unit/integration tests that need determinism.
- Documented prerequisites (Pi SDK installed, LLM credential present, GitLab project), tear-down behaviour, and observable failure modes (Pi SDK import failure, missing LLM credential, envelope schema fail, LLM rate-limit) surfaced in Colony's UI rather than only in stderr.

**Acceptance**

- Task goes `ready -> claimed -> in_progress -> review_requested -> merge_ready -> merged -> closed` end-to-end against home-lab GitLab.
- Reviewer approval, green pipeline, and human `/approve` are required.
- Audit trail links provider event, workflow action, envelope hash, and resulting state version. Run IDs, sandbox IDs, packet hashes, and envelope hashes carry no `fake-` prefixes.
- Developer envelope is produced by `@mariozechner/pi-coding-agent`; reviewer envelope is produced by `@mariozechner/pi-agent-core`.

**Status:** complete. `task acceptance:phase2` drives a real CSV-export task end-to-end against home-lab GitLab with `AGENT_RUNTIME=pi`: kimi-k2.6 developer (Ollama Cloud via LiteLLM) submits a schema-valid envelope through the structured-output finalization path; gpt-5.5 reviewer (Codex OAuth) reads the real MR diff and approves; human `/approve` and green pipeline gates open; the merge fires; the task closes. Failure modes (Pi import, missing credential, envelope rejection, runtime exception) land in the scope's audit (`acceptance.runtime.error`, `developer.run.rejected` with `rejection_reason`).

### COL-2.15 — Pi Runner Implementation

- [x]

**Depends on:** COL-2.7

**Background:** see `docs/research/pi-integration.md` for the full SDK survey, runner sketches, envelope-via-tool-call recommendation, and the 10-item ordered punch list.

**Deliverables**

- Concrete `PiRunner` implementations behind `PiAgentRuntimeAdapter`, **using Pi as an embedded TypeScript library** (direct `import` from `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, and `@mariozechner/pi-ai` — there is no package literally named `pi-mono`; design.md's "pi-mono SDK" maps to `pi-agent-core`. Not a child-process CLI):
  - `PiCodingAgentRunner` for the Developer role — drives a `pi-coding-agent` session in-process; preferred envelope path is a single terminal `submit_developer_completion` TypeBox-typed tool that the agent must call to end the loop.
  - `PiMonoRunner` for the Reviewer role — drives the smaller `pi-agent-core` `Agent` in-process (read-only tools, fresh per review, lower turn/cost ceilings); preferred envelope path is a single terminal `submit_reviewer_review` TypeBox-typed tool.
- Run supervision: timeout, cancel (Pi's native cancellation/AbortSignal where available), structured logging redacting LLM/provider secrets.
- In-process plumbing for the packet (function arg), tool profile (`PATH` of the surrounding sandbox), credentials (resolved through the Tool Gateway broker before SDK call), and writable scratch dir.
- Schema-conforming output: prefer Pi's structured-output / tool-call mechanism so the SDK returns data that already conforms to the Colony envelope schema; otherwise post-validate and mark `envelope_rejected` on parse failure.
- Per-run isolation lives at the surrounding boundary (Node process / Kubernetes sandbox pod), not at the Pi call site.

**Acceptance**

- A unit/integration test imports the Pi SDK in-process, runs a synthetic packet through `PiCodingAgentRunner`, and gets back a schema-valid `developer_completion` envelope.
- A unit/integration test imports the Pi SDK in-process, runs a synthetic review packet through `PiMonoRunner` (print/JSON mode), and gets back a schema-valid `reviewer_review` envelope.
- Cancel during run resolves the run as `canceled` with no orphan async work (timers, fetches, child Pi sessions) leaking past the activity boundary.

### COL-2.16 — Runtime Selection And Wiring

- [x]

**Depends on:** COL-2.15

**Deliverables**

- `AGENT_RUNTIME` config (`fake` | `pi`) read by `apps/worker` (and any other adapter consumer) at startup.
- Default to `fake` in tests, `pi` in pilot/prod; explicit ADR-style note in `packages/agent-runtime` README.
- Worker constructs the appropriate `AgentRuntimeAdapter` from config, with role-specific runner selection (`developer -> @mariozechner/pi-coding-agent`, `reviewer -> @mariozechner/pi-agent-core`).
- Pi SDK imports are gated through dynamic `import()` so CI tests with `AGENT_RUNTIME=fake` never resolve the Pi package tree or require LLM secrets to be present.
- `developer-run.ts` / `reviewer-run.ts` no longer hard-code `FakeAgentRuntimeAdapter` defaults at activity-instance level; wiring flows from the worker bootstrap.

**Acceptance**

- `AGENT_RUNTIME=fake npm test` runs deterministic CI tests with the fake adapter.
- `AGENT_RUNTIME=pi` makes the worker dial the real pi binaries, verified by a smoke test that startRun → succeeded against a trivial packet.
- Misconfiguration (missing binaries, missing LLM secret) fails fast at worker boot with a structured error, not at first envelope.

## Phase 3 — Real Scope Lifecycle, Reconciliation, And Closeout

Goal: make Colony usable for a real project by the end of this phase. The Phase 3 boundary is a complete `scope -> CRS` flow, where CRS means a closed, reconciled scope: a human opens a scope, Architect proposes a reviewed/approved decomposition, Supervisor commits the DAG, Developer/Reviewer/HITL gates drive every task through merge and close, reconciliation blocks unsafe drift, and the scope receives a close review and closes only when no `pending_sync` or `conflict` residue remains. Phase 4 work should be enhancements, not prerequisites for running a real scope.

**Phase 3 audit findings**

- Architect decomposition is currently schema-supported but not implemented as a real run, approval gate, or DAG commit flow.
- Scope state transitions exist in the domain model but the repository/API/worker do not yet expose the full `draft -> decomposition_proposed -> decomposition_approved -> active -> scope_review_requested -> scope_review_approved -> closed` path.
- Phase 2 acceptance proves the task MR loop by scripting activities directly; the Supervisor workflow still needs to orchestrate Developer, Reviewer, gates, merge, close, and reconciliation from signals/state.
- Scope close review packet/envelope schemas exist, but there is no close readiness evaluator, Reviewer run, human close approval, provider close projection, or acceptance test.
- The UI can show scope/task/audit/provider sync data, but Phase 3 needs operator actions for conflicts, pending sync, requeue/cancel, and scope close readiness.

### COL-3.0 — Real Scope Intake And State Transitions

- [x]

**Depends on:** COL-1.3, COL-2.16

**Deliverables**

- Scope intake path from API/UI and provider parent issue/epic into a `draft` Task Graph scope with explicit provider targets.
- Repository/API methods for audited scope state transitions with expected `state_version` preconditions.
- Provider projection for scope-level state labels and close/reopen drift.
- Command or UI action to request Architect decomposition for an intake-ready scope.
- Idempotent scope target registration for one or more provider projects before decomposition.

**Acceptance**

- A real provider scope artifact can create or link a Colony scope with at least one provider target.
- Invalid scope transitions are rejected with structured errors and audit.
- Scope state/projection drift is visible before any task DAG is committed.

**Status:** complete. Audited scope state transitions with `state_version` checks are implemented in the repository and API, mirrored scopes project state-label changes back to the provider, and the decomposition request action registers provider targets idempotently before Architect work starts. Verified by DB-backed API integration tests against a disposable Postgres container.

### COL-3.0a — Architect Decomposition And Spec/DAG Gate

- [x]

**Depends on:** COL-3.0, COL-2.7, COL-2.8, COL-2.12

**Deliverables**

- Architect packet/prompt/run path using the Pi runtime adapter and the existing `architect.decomposition` envelope schema.
- Persistence for proposed decomposition artifacts before approval: scope brief version, proposed tasks, dependencies, target project mapping, assumptions, open questions, packet hash, envelope hash.
- Fresh Reviewer spec/DAG review against the Architect output before human sign-off.
- Human `/approve` handling for the spec/DAG gate; `/changes` routes back to Architect without committing tasks.
- DAG commit activity that validates task IDs, dependencies, acceptance criteria, target mappings, and writes tasks/dependencies/provider mirrors in one audited transaction.

**Acceptance**

- A real scope can reach `decomposition_proposed` from an Architect envelope.
- No Task Graph tasks are created before Reviewer approval and required human approval.
- Approved decomposition commits tasks, dependencies, task targets, and provider issue mirrors, then transitions the scope to `active`.
- Stale or mismatched decomposition envelopes are rejected and surfaced in audit/UI.

**Status:** complete. Architect run path (`packages/agent-runtime` schema + builder + `PiArchitectRunner`, `apps/worker/src/architect-run.ts` activity), Reviewer spec/DAG run (`apps/worker/src/decomposition-review-run.ts` with synthetic `<scope_id>.0` task_id + proposal serialized into provider_context), provider `/approve` + `/changes` routing (webhook dispatcher mirror lookup tags `command_target=scope_decomposition`, supervisor workflow dispatches to `applyDecompositionCommand` activity that approves `review_approved` proposals or records human-side changes_requested), and Web UI Decomposition tab on the scope detail page surfacing every proposal with reviewer/human-approval status, proposed tasks/dependencies, architect assumptions, and open questions (expanded by default for non-committed proposals).

### COL-3.1 — Reconciliation Engine

- [x]

**Depends on:** COL-2.13

**Deliverables**

- `reconcile_scope(scope_id)`.
- Checks for MR state, commit SHA, pipeline status, approvals, provider issue state, labels, audit, `pending_sync`, conflicts.
- Reconcile report type.

**Acceptance**

- Reconcile detects stale commit approval.
- Reconcile detects provider issue closed while MR is open.
- Reconcile auto-corrects label drift.

**Status:** complete. `createReconcileScope` checks provider issue/MR snapshots, active approvals, mirrored artifacts, and provider state labels. It reports stale commit approvals and issue-closed/MR-open conflicts with audit/event evidence, and auto-corrects Colony-owned state label drift.

### COL-3.1a — Supervisor Lifecycle Orchestration

- [ ]

**Depends on:** COL-3.0a, COL-2.13, COL-3.1

**Deliverables**

- Workflow state loop that drives ready tasks through claim, Developer run, MR gate open, Reviewer run, human approval/pipeline ingestion, gate evaluation, merge, task close, and reconciliation.
- Signal routing from provider comments/MR/pipeline/webhooks to the correct workflow activity instead of relying on acceptance scripts to call activities directly.
- Idempotency keys for each side-effecting lifecycle activity.
- Durable handling for retries, agent run failures, envelope rejection, and `changes_requested -> in_progress` rework loops.

**Acceptance**

- The Supervisor workflow, not a script, can drive a real task from `ready` to `closed` once the required provider events arrive.
- Duplicate signals and activity retries do not duplicate provider writes, MRs, approvals, merges, or audit records.
- `changes_requested` re-enters Developer work and requires a fresh review before merge readiness.

**Status:** in progress. Commit `1b60d62` moved the happy-path task loop into `scopeSupervisorWorkflow`. Commit `a7c55c0` added the `changes_requested -> in_progress` refinement loop: webhook dispatcher tags task-level `/changes` comments with `command_target=task`, the supervisor workflow dispatches to `requestTaskRework` which transitions the task back through `changes_requested` to `in_progress`, invalidates every active approval on the task's MR artifact (fresh review required), and the workflow re-drives `driveClaimedTask` after the signal batch. `review_loop_cap` enforces the loop ceiling. Provider command routing covers `provider_event` (scope-decomposition + task-rework), `approval`, `pipeline_update`, `changes_requested` (workflow-level via the rework path), and the reconciliation timer. Remaining work for the deep version of this task before marking complete: explicit idempotency keys threaded through every lifecycle activity invocation (current activities are naturally idempotent via state-machine guards but don't dedupe at the audit layer), durable retry tuning beyond `maximumAttempts: 1`, and an `operator_override` workflow handler. These are defense-in-depth and tracked under COL-3.5/COL-3.7 acceptance.

### COL-3.2 — Periodic Reconciliation Timer

- [x]

**Depends on:** COL-3.1

**Deliverables**

- Temporal 15-minute active scope reconcile timer.
- Reconcile activity idempotency keys.

**Acceptance**

- Active scopes reconcile periodically.
- Repeated reconcile with no drift is a no-op.

**Status:** complete. The supervisor workflow waits up to 15 minutes for signals; on timeout it calls `reconcileScope` with a deterministic activity idempotency key and then retries the ready-task claim loop. The reconciliation engine remains idempotent for no-drift repeats.

### COL-3.3 — Provider Outage And Pending Sync

- [ ]

**Depends on:** COL-3.1, COL-3.1a

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

**Depends on:** COL-3.1, COL-3.1a

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

### COL-3.5a — Blocker And Requeue Handling

- [ ]

**Depends on:** COL-3.1a, COL-3.5

**Deliverables**

- Ingestion for Developer/Reviewer `blocked` envelopes into task `blocked` state with blocker class, expected unblock, referenced artifacts, and provider comment.
- `/block`, `/unblock`, manual requeue, and run cancel semantics wired through capability checks and audit.
- Retry/requeue policy for failed or canceled agent runs, including a loop cap before human assignment.
- UI visibility for blocked tasks and required human/external action.

**Acceptance**

- A blocked agent envelope moves the task to `blocked` without losing packet/envelope/run evidence.
- `/unblock` or operator requeue returns the task to the correct prior lifecycle state only when the blocker is resolved.
- Repeated failed runs stop at a human-visible blocked state instead of looping indefinitely.

### COL-3.5b — Scope Close Review And Closure

- [ ]

**Depends on:** COL-3.1a, COL-3.3, COL-3.4

**Deliverables**

- Close readiness evaluator: all child tasks closed, no active blockers, no `pending_sync`, no unresolved conflicts, required provider artifacts present, and latest reconciliation report clean.
- Scope review packet builder using `scope_review` packet schema with child task statuses, merged artifacts, rejected/accepted follow-ups, unresolved residue, and release state.
- Reviewer scope-close run using `scope_review` envelope schema.
- Scope close gate with human approval when policy requires it.
- Provider scope artifact close projection and audited `scope.closed` transition.

**Acceptance**

- A scope with all tasks closed transitions to `scope_review_requested` and receives a fresh Reviewer close review.
- Scope close is blocked when any child task is open, any `pending_sync` remains, any conflict is unresolved, or required audit evidence is missing.
- Approved close review plus required human approval transitions the scope through `scope_review_approved` to `closed` and closes the provider scope artifact.

### COL-3.6 — Web UI Conflict Operations

- [ ]

**Depends on:** COL-3.4, COL-3.5, COL-3.5a, COL-3.5b

**Deliverables**

- Conflict/reconciliation view.
- Scope close readiness view.
- Resolve conflict action.
- Operator override action.
- Manual requeue.
- Run cancel.
- Scope cancel.

**Acceptance**

- UI shows conflict class, detected facts, expected facts, source provider artifact, and recovery options.
- UI shows why a scope can or cannot close.
- UI writes are capability checked and audited.

### COL-3.7 — Phase 3 End-To-End Acceptance

- [x]

**Depends on:** COL-3.0a, COL-3.1a, COL-3.3, COL-3.4, COL-3.5b, COL-3.6

**Deliverables**

- `task acceptance:phase3` target that drives a small real scope against home-lab GitLab with `AGENT_RUNTIME=pi`.
- Real Architect decomposition of the scope into at least two tasks with one blocking dependency.
- Workflow-driven task execution, review, human approval, pipeline ingestion, merge, task close, and scope close review.
- Outage scenario test.
- Manual merge conflict scenario test.

**Acceptance**

- Scope runs `draft -> decomposition_proposed -> decomposition_approved -> active -> scope_review_requested -> scope_review_approved -> closed`.
- At least one task is created from Architect output, implemented, reviewed, merged, reconciled, and closed without scripting internal activities directly.
- Scope close is blocked until every child task is reconciled closed and no `pending_sync` or `conflict` remains.
- Provider outage prevents irreversible actions.
- Pending sync recovers cleanly after provider return.
- Manual merge creates conflict visible in UI.

## Phase 3.5 — Output Quality, Operator UX, And Sandboxing

Goal: between the working scope-to-closed-scope flow (Phase 3) and the operational maturity work (Phase 4), close the gaps that surface as soon as Colony is pointed at a real project and run unattended: weak code review, no replan when the DAG is wrong, no operator UI, and unsandboxed agent execution on the host. Phase 3.5 items must keep the Phase 3 acceptance flow green and additively improve it.

### COL-3.5.1 — Multi-Model Role Wiring

- [ ]

**Depends on:** COL-3.7

**Deliverables**

- Developer role on a coding-tuned non-Codex model (kimi-k2.6 / glm-5.1 / deepseek / qwen) via the existing `openai_compatible` provider in `config/colony.yaml`.
- Architect and reviewer roles stay on Codex/gpt-5.5.
- Prompt validation pass against the non-Codex developer model: tool-call adherence, envelope shape, schema conformance.
- Bench-runners harness updated so the developer benchmark covers the new model.

**Acceptance**

- Phase 3 acceptance passes end-to-end with developer on the non-Codex model.
- Per-run developer cost on the EchoPress demo drops at least 5x versus gpt-5.5 thinking:high.
- Bench numbers recorded for the new model in `docs/research/`.

### COL-3.5.2 — Sandbox Every Agent Run

- [ ]

**Depends on:** COL-3.7

**Deliverables**

- A real deployer behind `AgentRunEnvironment.runtimeBinding` that launches a per-run sandbox (container locally, agent-sandbox CR on Aether) instead of the current `local-permissive` host execution.
- Every runner (`pi-coding-agent-runner`, `pi-mono-runner`, `pi-architect-runner`, plus any future runner) executes inside the sandbox uniformly. Role-specific tools gate at registration, not at the sandbox boundary.
- Default-deny egress: per-run network policy allows only the LLM provider, GitLab API for the run's project, and (for developer) the package registry. Anything else is refused at the network layer.
- Token isolation: the per-task scoped GitLab token lives only in the sandbox env; master `GITLAB_TOKEN` and any host secrets stay out of every agent run.
- No host filesystem leakage: sandbox cwd is a per-run volume; existing `/tmp/colony-pi-runs/<runId>` host clones are removed.
- Audit records for sandbox start, network egress decisions, and sandbox stop, joined to the existing `agent_run` rows.

**Acceptance**

- Phase 3 acceptance passes end-to-end with all roles sandboxed.
- Bash inside any runner cannot read host-side colony source, the master `GITLAB_TOKEN`, or any other host secret.
- Network requests to non-allowlisted hosts are refused and audited; the test harness asserts at least one such denial is recorded.
- Sandbox lifecycle (start/stop) is audited per run.

### COL-3.5.3 — Reviewer With Workspace And Diff Inspection

- [ ]

**Depends on:** COL-3.5.2

**Deliverables**

- Code reviewer (`pi-mono-runner`) gets `read`, `grep`, `find`, `ls`, and `bash` tools against the sandboxed clone of the MR head.
- Reviewer ceilings tightened relative to the developer (~30 turns, ~$5) so it inspects, not rewrites.
- Reviewer system prompt updated to expect a real working tree (rolling back the "reason from packet only" wording added during Phase 3 debugging).
- `prepareArguments` zod-validation on submit tools stays in place so reviewer envelope errors remain self-correcting.

**Acceptance**

- Phase 3 acceptance passes with the workspace-enabled reviewer.
- Reviewer detects at least one class of issue invisible from `diff_summary` alone (e.g., a duplicated helper, a stale test that wasn't updated, a public type contract change). Captured in a regression test.
- Reviewer does not regress into thinking-only churn the way Phase 3 debug runs did; the bench harness records a turn distribution.

### COL-3.5.4 — Operator UX For Real Projects

- [ ]

**Depends on:** COL-3.5.2

**Deliverables**

- Admin-side flow to register an existing GitLab project against `provider_projects` (UI form + API endpoint) so Colony can be pointed at a repo without hand-rolling DB inserts.
- "New scope" UI on `/scopes` with title, description, and project picker; calls existing `POST /scopes` and the supervisor mirroring path.
- "Run architect" action on draft scopes that triggers `POST /scopes/:id/decomposition-request` from the UI.
- Documentation (`docs/dev-loop.md` or new) describing the end-to-end UI path: register project → create scope → run architect → review → approve → watch tasks merge.

**Acceptance**

- An operator can drive a scope from draft to closed without running any script, only via the web UI and provider comments.
- Existing `acceptance:phase3` target keeps passing unchanged.

### COL-3.5.5 — Temporal-Driven End-To-End Harness

- [ ]

**Depends on:** COL-3.5.2

**Deliverables**

- New acceptance target (`acceptance:phase3-temporal` or replace the bypass path in `acceptance:phase3`) that drives a scope through `scopeSupervisorWorkflow` instead of calling activity functions directly.
- Provider webhook events drive workflow signals end-to-end (no direct repo activity calls in the harness).
- Heartbeat, retry, and signal-driven state transitions are exercised at least once in the run.

**Acceptance**

- Acceptance target passes against home-lab GitLab.
- Run produces Temporal workflow history showing every state transition, signal, and activity retry.
- Killing the worker mid-run and restarting it does not corrupt scope state; the workflow resumes from history.

### COL-3.5.6 — Per-Task Planning Gate

- [ ]

**Depends on:** COL-3.5.3

**Deliverables**

- New `developer_plan` envelope schema: brief approach, files to touch, tests to add, risks. Mirrors the architect/reviewer envelope shape.
- New `plan_review` envelope schema (specialized reviewer per phase, not a merged omni-reviewer).
- New plan reviewer runner + prompt; reuses the sandboxed runner pattern.
- New task states: `claimed -> plan_proposed -> plan_review -> in_progress` (with `changes_requested` looping back to `plan_proposed`).
- DB columns + repository helpers for the plan envelope artifact.
- Plan review loop cap (mirror existing `review_loop_cap`).

**Acceptance**

- Developer cannot write code before the plan envelope is reviewer-approved.
- A failing plan review routes back to the developer for revision; loop terminates at the cap.
- Phase 3 acceptance passes with the new gate inserted.

### COL-3.5.7 — Architect Re-Plan On Developer Escalation

- [ ]

**Depends on:** COL-3.5.6

**Deliverables**

- Supervisor activity that, given (current DAG state, developer escalation/blocker envelope, completed and in-flight tasks), invokes the architect with a delta-mode packet.
- Extension to architect envelope (or new `architect_replan` variant) that adds, removes, or rewrites _remaining_ tasks without disturbing merged ones.
- State-machine support for inserting new tasks mid-scope and retiring/redirecting blocked tasks; reuses the planning gate's transitions where applicable.
- Audit trail recording the trigger envelope, the architect's delta, and the resulting DAG diff.

**Acceptance**

- A developer escalation that names "task N depends on something not in the DAG" produces a re-plan that adds the missing prerequisite and retargets task N.
- In-flight tasks not affected by the delta keep running uninterrupted.
- Re-plan attempts are bounded; runaway re-plans are audited and blocked.

### COL-3.5.8 — Phase 3.5 End-To-End Acceptance

- [ ]

**Depends on:** COL-3.5.1, COL-3.5.2, COL-3.5.3, COL-3.5.4, COL-3.5.5, COL-3.5.6, COL-3.5.7

**Deliverables**

- A target that drives a real scope on an existing GitLab project from the operator UI, through Temporal, through sandboxed runs of architect → developer plan → plan review → developer code → code review → merge, with at least one architect re-plan triggered by a developer escalation.
- Multi-model wiring active (developer on non-Codex, architect/reviewer on Codex).
- Egress denial assertion (sandbox refuses an off-allowlist call recorded in audit).

**Acceptance**

- All other Phase 3 and 3.5 acceptance targets continue to pass.
- The target completes in a single operator session without any direct script-driven activity calls.

## Phase 4 — Memory, Policy Hardening, Release, And Second Provider

Goal: enhance the real-project flow after Phase 3 with durable memory/decision records, richer policy, release/deploy automation, richer UI, and a second provider. Phase 4 items must not be required for the basic scope-to-closed-scope path.

### COL-4.1 — Memory Tables And Candidate Flow

- [ ]

**Depends on:** COL-0.6, COL-2.8

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

**Depends on:** COL-2.12, COL-3.5

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

- Phase 3 real-project acceptance still passes with memory/policy/release features enabled.
- Scope runs decomposition -> tasks -> MR review/merge -> scope review -> release gate without regressing closeout safety.
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
- Shared observability setup lives in `packages/observability` and is imported by apps, not workflow definitions.

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
3. COL-1.2b
4. COL-1.1b — generalize bootstrap to N bots
5. COL-1.1c — persist bot registry
6. COL-1.1d — per-bot capability grants
7. COL-1.3
8. COL-1.4
9. COL-1.5
10. COL-1.6
11. COL-1.8
12. COL-1.9

COL-1.1e (per-namespace bot scoping) and COL-1.1f (bot lifecycle UX) are tracked separately — land them in parallel with COL-1.5/1.6 once agents start making real adapter calls.

Phase 2 should not start real Developer/Reviewer execution until COL-2.1 minimum sandbox egress enforcement is complete.

After Phase 2, the Phase 3 real-project critical path is:

1. COL-3.0 — real scope intake and audited scope transitions
2. COL-3.0a — Architect decomposition, spec/DAG review, and approved DAG commit
3. COL-3.1 — reconciliation engine
4. COL-3.1a — Supervisor-driven task lifecycle orchestration
5. COL-3.3 — provider outage and pending sync semantics
6. COL-3.4 — conflict state and resolution
7. COL-3.5 — operator override flow
8. COL-3.5a — blocker and requeue handling
9. COL-3.5b — scope close review and closure
10. COL-3.6 — UI operations for conflict, requeue, cancel, and close readiness
11. COL-3.7 — real scope-to-closed-scope acceptance

COL-3.2 is already complete and should remain a guardrail in every active-scope workflow.
