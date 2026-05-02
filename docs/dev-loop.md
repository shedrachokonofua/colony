# Local Dev Loop

Colony's local loop is three things: a Nix shell for the toolchain, Docker Compose for Temporal + Postgres, and `npm run dev` for the five app processes. No local Kubernetes — Kubernetes behavior is validated on Aether `colony-dev` (see [ADR-004](./adr/004-local-development-tooling.md) and [ADR-007](./adr/007-aether-deployment-boundaries.md)).

## Prerequisites

- Nix with flakes enabled.
- A Docker-compatible runtime on your laptop: Docker Desktop, Colima, or Podman. The dev shell warns if neither `docker` nor `podman` is on PATH.
- LAN access to the home-lab GitLab (for the webhook round-trip test). Optional for pure app iteration.

The Nix dev shell provides Node 24, npm, Temporal CLI, Postgres client, kubectl/Helm/k9s, GitLab CLI, Buildah/Podman, `docker-compose`, Prettier, and actionlint. You do not need these installed on your host.

## First boot

```sh
# 1. Enter the dev shell (provides all pinned tooling).
nix develop

# 2. Copy .env.example to .env and fill in what you need.
cp .env.example .env
# Edit .env — at minimum set GITLAB_* values if you want the webhook round-trip.

# 3. Install workspace deps.
npm install

# 4. Boot Temporal + Postgres.
docker-compose up -d
# Wait for healthchecks — roughly 20s on first boot.

# 5. Start all five apps in watch mode.
npm run dev
```

After `npm run dev`, you should have:

| Service                   | URL                                                |
| ------------------------- | -------------------------------------------------- |
| `apps/api`                | http://localhost:4000/health, /docs, /openapi.json |
| `apps/tool-gateway`       | http://localhost:4200/health                       |
| `apps/webhook-dispatcher` | http://localhost:4100/webhook/gitlab (POST)        |
| `apps/web`                | http://localhost:3000                              |
| Temporal UI               | http://localhost:8233                              |
| Postgres                  | `postgres://colony:colony@localhost:5432/colony`   |

The web page at `localhost:3000` fetches the API `/health` on every load and renders the DB status — this is the end-to-end heartbeat.

## Ports

Ports are read from `.env` (`API_PORT`, `WEBHOOK_DISPATCHER_PORT`, `TOOL_GATEWAY_PORT`, `WEB_PORT`). Defaults match the table above.

## Pointing at the home-lab GitLab

Provider provisioning (group, project, bot users, bot PATs, OAuth Application for Web UI sign-in, project webhook) is a single API operation: `POST /admin/provider/bootstrap` on `apps/api`. The only credential a human supplies is one **GitLab admin PAT**; everything else is created over the GitLab admin API. Bootstrap returns role-keyed bot tokens as `GITLAB_BOT_<ROLE>_TOKEN`; `GITLAB_TOKEN` remains the engine/developer alias for current local wiring. See `design.md` §10 "Provider Bootstrap" and tasks `COL-1.1a`/`COL-1.1b`.

Run bootstrap with a request-scoped GitLab admin PAT:

```sh
curl -X POST http://localhost:4000/admin/provider/bootstrap \
  -H 'X-Actor-Id: human:op-1' \
  -H 'X-Admin-Token: <gitlab-admin-pat>' \
  -H 'Content-Type: application/json' \
  -d @bootstrap-dev.json
```

The operation returns provider resource IDs and a redacted `.env` snippet, and writes an audit record with a hash of the admin credential. For break-glass setup or debugging, the equivalent manual fallback is:

1. **Create a dev project on home-lab GitLab.**
2. **Create bot accounts** through bootstrap when possible. If you are bypassing bootstrap for local dogfooding, create at least an engine bot (`colony-engine`) with a personal access token scoped to `api`, `read_repository`, `write_repository`. Put the token in `.env` as `GITLAB_BOT_ENGINE_TOKEN` and the back-compat alias `GITLAB_TOKEN`. Additional roles use `GITLAB_BOT_REVIEWER_TOKEN`, `GITLAB_BOT_ARCHITECT_TOKEN`, `GITLAB_BOT_INTEGRATOR_TOKEN`, `GITLAB_BOT_MEMORY_CONSOLIDATOR_TOKEN`, and `GITLAB_BOT_SUPERVISOR_TOKEN`. Record the numeric project ID for the local default/dogfood project in `GITLAB_DEV_PROJECT_ID` and the base URL in `GITLAB_BASE_URL` (e.g. `https://gitlab.home.shdr.ch`). This is only the local default project; the durable architecture supports scopes that span multiple GitLab projects through Task Graph provider targets.
3. **Pick a webhook secret** — any random string (`openssl rand -hex 32`) — and put it in `.env` as `GITLAB_WEBHOOK_SECRET`.
4. **Work out the webhook URL.** The dispatcher runs on your laptop at `http://<laptop-lan-address>:$WEBHOOK_DISPATCHER_PORT/webhook/gitlab`. Set `PUBLIC_HOST` in `.env` to the laptop's LAN name or IP (e.g. `10.0.4.10`). On restart, the dispatcher logs the exact URL GitLab should POST to.
5. **In GitLab project → Settings → Webhooks**, add:
   - URL: the one the dispatcher logged.
   - Secret token: the value of `GITLAB_WEBHOOK_SECRET`.
   - Triggers: Issues events (for now), and whichever others you want exercised.
   - SSL verification: off for the plain-HTTP `PUBLIC_HOST` URL.
6. **Fire a test event.** Open an issue on the dev project. The dispatcher should log a structured JSON line in its stdout, and the request returns 200.

The Web UI will surface the same operation as an "Set up provider" admin action once the cockpit lands.

Note: the dispatcher currently records events to stdout as a COL-0.3 placeholder. The Task Graph `events` table is now defined by the schema migration (COL-0.6); the dispatcher will write through the repository layer once COL-0.7 / COL-0.11 land.

## Operator UI path for an existing GitLab project

COL-3.5.4 adds a script-free path for pointing Colony at an already-created GitLab project:

1. Start the local stack and open `http://localhost:3000/admin/providers`.
2. In "Registered projects", enter the GitLab project path, for example `group/project`. If you know the numeric GitLab project id, include it; otherwise the API resolves the path through the configured GitLab adapter.
3. Open `http://localhost:3000/scopes` and create a new scope with a title, description, optional project picker, and the mirror checkbox enabled.
4. Open the new scope detail page. While the scope is still `draft`, use "Run architect" to call `POST /scopes/:id/decomposition-request`.
5. Review and approve the architect decomposition from the provider comments/UI path, then watch the scope detail page as tasks move through claim, plan review, implementation, review, merge, and close states.

The API endpoints behind the UI are `POST /admin/provider/projects`, `GET /admin/provider/projects`, `POST /scopes`, and `POST /scopes/:id/decomposition-request`. All mutating provider-admin calls require the same `provider.bootstrap` policy path as bootstrap.

## Running individual apps

```sh
npm --workspace @colony/api run dev
npm --workspace @colony/worker run dev
npm --workspace @colony/webhook-dispatcher run dev
npm --workspace @colony/tool-gateway run dev
npm --workspace @colony/web run dev
```

## Stopping the stack

```sh
# Stop app watchers: Ctrl+C in the npm run dev terminal.
# Stop infra:
docker-compose down

# Nuke Postgres data and start fresh:
docker-compose down -v
```

## Typecheck, test, lint

```sh
npm run typecheck   # tsc for apps+packages, svelte-check for apps/web
npm test            # vitest across the repo
npm run test:unit   # fast tests only; mirrors CI's unit stage
npm run lint        # eslint
npm run format:check
```

## Database migrations

Migrations live in `packages/db/migrations/` and are applied with `node-pg-migrate` (ADR-002).

```sh
# Apply all pending migrations to the database in DATABASE_URL.
DATABASE_URL=postgres://colony:colony@localhost:5432/colony npm run db:migrate

# Roll back the last migration (dev only — prod is forward-only).
DATABASE_URL=postgres://colony:colony@localhost:5432/colony npm run db:migrate:down
```

The migration step is not run automatically by `npm run dev` — bring up Compose, then migrate, then start the apps. The `colony_writer` and `colony_reader` roles are created by the first migration; `audit_log` insert-only enforcement is in the third.

## Database integration tests

`packages/db/test/migrations.test.ts` runs against a real Postgres and proves that `audit_log` is insert-only under `colony_writer`. The test is gated on `COLONY_TEST_DATABASE_URL` so it skips when the var is unset (default for `npm test`). To run it:

```sh
# Recreate a clean test database, then run.
docker exec colony-postgres psql -U colony -d colony \
  -c "DROP DATABASE IF EXISTS colony_test;" \
  -c "CREATE DATABASE colony_test;"

COLONY_TEST_DATABASE_URL=postgres://colony:colony@localhost:5432/colony_test \
  npx vitest run packages/db
```

The CI-style integration entrypoint is:

```sh
COLONY_TEST_DATABASE_URL=postgres://colony:colony@localhost:5432/colony_test \
  npm run test:integration
```

Integration tests are organized per app/package as they land so failures map to the service that owns the behavior. Existing unit-level HTTP boundary tests are not duplicated in the integration stage.

## Kubernetes validation (Aether)

There is no local k8s. When you need to validate the chart or a k8s-specific behavior, deploy to Aether's `colony-dev` namespace via Tofu. That workflow lands in COL-1.9. Until then, `npm run dev` + the home-lab GitLab webhook loop is the complete inner cycle.

## Troubleshooting

- **`run-p: command not found`** → `npm install` at the repo root; `npm-run-all2` provides `run-p` in `node_modules/.bin/`.
- **Webhook returns 401** → `X-Gitlab-Token` header must exactly match `GITLAB_WEBHOOK_SECRET` (case-sensitive, no whitespace).
- **Postgres major upgrade** (16 → 17 etc.) → existing volume is incompatible; run `docker-compose down -v` to reset.
- **Temporal schema warnings on first boot** → `temporalio/auto-setup` applies all migrations on first run; subsequent starts are quiet.
- **Web dev server refuses to start on port 3000** → the config uses `strictPort: true`. Stop whatever else is on that port or change `WEB_PORT`.
