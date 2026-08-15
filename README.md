# Colony

Colony is an AI software factory. A human opens a bounded **scope**, colonyd decomposes it into a dependency graph of tasks with an architect agent, implementer agents build each task on a branch, and a deterministic prospective-merge gate decides whether the work merges. Everything is reconciled from two sources of truth: one SQLite file and the Git provider.

V1 (Temporal per-scope supervisor, Postgres, five services) is preserved on the `v1-archive` branch / `v1-final` tag.

## Architecture

One process, `apps/colonyd`:

- Hono HTTP API (`POST /scopes`, task/scope lifecycle, `/audit`, GitLab webhook intake)
- `setInterval` reconciler tick, single-flight, fail-isolated phases:
  1. expire dead run leases (requeue with backoff or block)
  2. poll provider facts for `mr_open` tasks
  3. advance tasks only on observed facts; dispatch prospective merge gates
  4. scope planning: architect dispatch, plan materialization (`hitl.mode` yolo/gated)
  5. dispatch implementers (bounded by `COLONYD_MAX_CONCURRENT`)
  6. scope closure
- In-process agent runs (architect / implementer / merge gate) via `packages/agent-runtime` (Pi)

State machine, SQLite persistence, and backoff live in `packages/core`; envelopes in `packages/schemas` (`ArchitectDecompositionV2`, `ImplementerCompletionV2`). Envelopes are evidence, never authority: colonyd verifies branch/SHA facts with the provider before any transition.

The merge gate clones the target branch fresh, prospectively merges the task head, scans for secrets/artifacts, runs `colony.gate.yaml` commands, rechecks the MR head, and merges with the gated SHA. Gates serialize per scope.

## Repository layout

TypeScript **npm workspaces** monorepo (Node **24+**).

- `apps/colonyd` — the single service (HTTP + reconciler + agent runs)
- `packages/core` — SQLite store, state machine, retry backoff
- `packages/domain` — branded ids + domain errors + roles
- `packages/schemas` — V2 envelope schemas
- `packages/config` — env contract + colony.yaml loader
- `packages/provider`, `packages/provider-gitlab` — provider contract + GitLab adapter (also a fake adapter for tests)
- `packages/agent-runtime` — Pi runner adapters, envelopes, workspace provisioning
- `packages/observability` — OTel metrics

## Development

```bash
nix develop
cp .env.example .env   # set GITLAB_TOKEN, COLONY_OPENAI_COMPATIBLE_API_KEY
npm install
npm run dev            # colonyd in watch mode (port 4400)
```

Open a scope:

```bash
curl -X POST localhost:4400/scopes \
  -H 'X-Actor-Id: human:op-1' \
  -H 'content-type: application/json' \
  -d '{"goal":"add /version endpoint","project":{"path":"so/my-project"}}'
```

Checks:

```bash
npm run typecheck
npm test          # unit + fake e2e (loop.integration.test.ts)
npm run test:unit # unit only
npm run lint
```

Real-GitLab acceptance:

```bash
GITLAB_BASE_URL=https://gitlab.home.shdr.ch GITLAB_TOKEN=*** \
COLONY_CONFIG_PATH=config/colony.yaml AGENT_RUNTIME=pi \
npx tsx scripts/v2-acceptance.ts
```
