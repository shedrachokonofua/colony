# Colony

Colony is an AI software team control plane. A human opens a bounded **scope**, Colony decomposes it into a dependency graph of tasks, agents implement and review the work, and human-in-the-loop gates decide when specs, merges, releases, and closeout may proceed.

The source of truth is Colony’s Task Graph and audit log; Git providers are the collaboration surface where humans review issues, comments, MRs/PRs, approvals, and pipelines. GitLab is the first adapter, but the system is designed around provider abstractions, durable Temporal workflows, explicit capabilities, structured agent outputs, and reconciled “done” semantics.

## Documentation

| Document                 | Purpose                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| [`seed.md`](seed.md)     | Original architecture seed: roles, HITL policy, reconciliation, packets, deployment sketch |
| [`design.md`](design.md) | Technical design: components, domain model, APIs, security, rollout                        |
| [`tasks.md`](tasks.md)   | Dependency-aware implementation plan (Phase 0–4), with per-task progress checkboxes        |

## Repository layout

TypeScript **npm workspaces** monorepo (Node **22+**).

**Applications** (`apps/`):

- `api` — Task Graph / HTTP API (future)
- `worker` — Temporal worker (future)
- `webhook-dispatcher` — Provider webhooks (future)
- `tool-gateway` — Allowlisted tool/proxy egress (future)
- `web` — Operator web UI (future)

**Packages** (`packages/`):

- `domain` — Core domain types and state (future)
- `db` — Persistence layer (future)
- `policy` — Capability / policy engine (future)
- `provider` — Provider adapter interfaces and implementations (future)
- `schemas` — TypeBox / envelope schemas (future)
- `testing` — Shared test helpers (future)

## Development

The canonical toolchain lives in a **Nix flake** so local environments match CI and infrastructure assumptions (Node, Temporal CLI, Postgres client, Kubernetes tooling, GitLab CLI, container tools).

Enter the dev shell, install dependencies, and run checks:

```bash
nix develop
npm install
npm run typecheck
npm test
npm run lint
```

Formatting:

```bash
npm run format        # write
npm run format:check  # verify only
```

Validate the flake:

```bash
nix flake check
```

---

_Implementation status: Phase 0 foundations in progress; see [`tasks.md`](tasks.md) for the critical path._
