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

Provider provisioning (group, project, bot users, bot PATs, OAuth Application for Web UI sign-in, project webhook) is a single API operation: `POST /admin/provider/bootstrap` on `apps/api`. The only credential a human supplies is one **GitLab admin PAT**; everything else is created over the GitLab admin API. See `design.md` §10 "Provider Bootstrap" and tasks `COL-1.1a`.

For environments where the bootstrap operation hasn't landed yet (i.e. before COL-1.1a ships), use this manual fallback:

1. **Create a dev project on home-lab GitLab.**
2. **Create one bot account** (e.g. `colony-engine`) with a personal access token scoped to `api`, `read_repository`, `write_repository`. Put the token in `.env` as `GITLAB_TOKEN`. Record the numeric project ID in `GITLAB_DEV_PROJECT_ID` and the base URL in `GITLAB_BASE_URL` (e.g. `https://gitlab.home.shdr.ch`).
3. **Pick a webhook secret** — any random string (`openssl rand -hex 32`) — and put it in `.env` as `GITLAB_WEBHOOK_SECRET`.
4. **Work out the webhook URL.** The dispatcher runs on your laptop at `http://<laptop-lan-address>:$WEBHOOK_DISPATCHER_PORT/webhook/gitlab`. Set `PUBLIC_HOST` in `.env` to the laptop's LAN name or IP (e.g. `10.0.4.10`). On restart, the dispatcher logs the exact URL GitLab should POST to.
5. **In GitLab project → Settings → Webhooks**, add:
   - URL: the one the dispatcher logged.
   - Secret token: the value of `GITLAB_WEBHOOK_SECRET`.
   - Triggers: Issues events (for now), and whichever others you want exercised.
   - SSL verification: off for the plain-HTTP `PUBLIC_HOST` URL.
6. **Fire a test event.** Open an issue on the dev project. The dispatcher should log a structured JSON line in its stdout, and the request returns 200.

Once COL-1.1a ships, the same end state is reached with: `curl -X POST http://localhost:4000/admin/provider/bootstrap -H 'X-Admin-Token: <gitlab-admin-pat>' -d @bootstrap-dev.json` (one admin PAT, one call). The Web UI will surface the same operation as an "Set up provider" admin action once the cockpit lands.

Note: the dispatcher currently records events to stdout as a COL-0.3 placeholder. The Task Graph `events` table lands in COL-0.6 and will be wired in then.

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
npm run lint        # eslint
npm run format:check
```

## Kubernetes validation (Aether)

There is no local k8s. When you need to validate the chart or a k8s-specific behavior, deploy to Aether's `colony-dev` namespace via Tofu. That workflow lands in COL-1.9. Until then, `npm run dev` + the home-lab GitLab webhook loop is the complete inner cycle.

## Troubleshooting

- **`run-p: command not found`** → `npm install` at the repo root; `npm-run-all2` provides `run-p` in `node_modules/.bin/`.
- **Webhook returns 401** → `X-Gitlab-Token` header must exactly match `GITLAB_WEBHOOK_SECRET` (case-sensitive, no whitespace).
- **Postgres major upgrade** (16 → 17 etc.) → existing volume is incompatible; run `docker-compose down -v` to reset.
- **Temporal schema warnings on first boot** → `temporalio/auto-setup` applies all migrations on first run; subsequent starts are quiet.
- **Web dev server refuses to start on port 3000** → the config uses `strictPort: true`. Stop whatever else is on that port or change `WEB_PORT`.
