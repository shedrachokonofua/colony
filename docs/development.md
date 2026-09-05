# Development

## Repository layout

TypeScript **Bun workspaces** monorepo.

- `apps/colonyd` — the single service (HTTP + reconciler + agent runs)
- `apps/cli` — operator CLI and TUI
- `packages/console` — buildless Lit web console, served by colonyd at `/`
- `packages/core` — SQLite store, state machine, retry backoff
- `packages/domain` — branded ids + domain errors + roles
- `packages/schemas` — run envelope schemas
- `packages/config` — env contract + `colony.yaml` loader
- `packages/provider`, `packages/provider-gitlab` — provider contract + GitLab adapter (plus a fake adapter for tests)
- `packages/agent-runtime` — Pi runner adapters, envelopes, workspace provisioning
- `packages/sandbox`, `packages/sandbox-in-process`, `packages/sandbox-k8s` — sandbox contract and engines
- `packages/observability` — OTel metrics and traces

## Architecture

One process, `apps/colonyd`:

- Hono HTTP API (`POST /scopes`, task/scope lifecycle, `/audit`, GitLab webhook intake)
- `setInterval` reconciler tick, single-flight, fail-isolated phases:
  1. expire dead run leases (requeue with backoff or block)
  2. poll provider facts for `mr_open` tasks
  3. advance tasks only on observed facts; dispatch prospective merge gates
  4. scope planning: architect dispatch, plan materialization (`hitl.mode` yolo/gated)
  5. dispatch implementers (bounded by `COLONYD_MAX_CONCURRENT`)
  6. scope closure and post-merge validation
- In-process agent runs (architect / implementer / reviewer) via `packages/agent-runtime` (Pi)

State machine, SQLite persistence, and backoff live in `packages/core`; run envelopes in `packages/schemas`. Envelopes are evidence, never authority: colonyd verifies branch/SHA facts with the provider before any transition.

The merge gate clones the target branch fresh, prospectively merges the task
head, scans for secrets/artifacts, and validates the combined tree with every
command in `colony.gate.yaml` before rechecking the MR head and merging the
gated SHA. The file and its non-empty command list are mandatory; malformed
configuration blocks the task for operator correction. Gates serialize per
scope.

## Running locally

```bash
nix develop
cp .env.example .env   # set GITLAB_TOKEN, COLONY_OPENAI_COMPATIBLE_API_KEY
bun install
bun run dev            # colonyd in watch mode (port 4400)
```

Colony runs on Bun, not Node: the agent runtime depends on
`@oh-my-pi/pi-coding-agent`, which ships Bun-native TypeScript, and colonyd's
own sources execute without a build step or loader.

Operator sheet: [http://localhost:4400](http://localhost:4400). Requests are attributed with `X-Actor-Id` (e.g. `human:op-1`).

Open a scope over HTTP:

```bash
curl -X POST localhost:4400/scopes \
  -H 'X-Actor-Id: human:op-1' \
  -H 'content-type: application/json' \
  -d '{"goal":"add /version endpoint","title":"version endpoint","repo":{"path":"so/my-repo"},"project":"console"}'
```

## Checks

```bash
bun run typecheck
bun test          # everything under apps/, packages/, scripts/ (includes *.integration.test.ts)
bun run test:unit # excludes integration tests
bun run lint
```

Real-GitLab acceptance (creates and deletes throwaway repositories):

```bash
GITLAB_BASE_URL=https://gitlab.example.com GITLAB_TOKEN=*** \
COLONY_CONFIG_PATH=config/colony.yaml AGENT_RUNTIME=pi \
bun scripts/acceptance.ts
```

## Web research tools

When `COLONY_SEARXNG_URL` is set and `AGENT_RUNTIME=pi`, every Pi run for architect, implementer (developer), and reviewer exposes two extra tools alongside the normal file/shell tools:

- `web_search { query }` — queries the SearXNG JSON API (`/search?q=…&format=json`) and returns `{ query, results: [{title,url,content}], resultCount }` capped to 8 results.
- `web_fetch { url }` — fetches an `https://` URL, follows up to 5 redirects, extracts text (HTML → plain text), and returns `{ url, status, contentType, content, truncated, byteCount }` capped at 200 KB.

Bounds: search results 8 (clamped 1–20), fetch 200 KB (clamped 1–1 MB), search timeout 10 s, fetch timeout 20 s, redirect cap 5 (0–10). Large bodies are truncated and `truncated: true` is returned.

SSRF / private-network policy: `web_fetch` enforces strict SSRF filtering. Literal private/loopback/multicast/reserved IPs and hostnames resolving only to non-public addresses (e.g. `localhost`, `10/8`, `192.168/16`) are blocked. The configured SearXNG host is exempt from that filter (the operator trusts that host). Redirect targets for `web_fetch` are always filtered. Credentials in URLs are rejected.

No API key: `COLONY_SEARXNG_URL` is the only configuration; no SearXNG API key is required or supported.

When `COLONY_SEARXNG_URL` is unset or empty, no web tool names are registered. A set-but-invalid value (not `https://`, embedded `user:pass@`) fails fast at colonyd boot with `COLONY_SEARXNG_URL must be an https:// URL without embedded credentials`.

## End-to-end validation

The e2e suites verify the full stack against a fake boundary and an isolated SQLite file — no real GitLab and no production credentials.

```bash
# Browser suite (Playwright desktop + mobile)
bun install --frozen-lockfile && npx playwright install chromium && npm run test:e2e
# API e2e + unit (includes *.integration.test.ts)
npm test
```

Environment overrides:

- `COLONY_TEST_CHROMIUM_PATH` — path to a Chromium binary for Playwright. Locally omit it (Playwright uses its bundled Chromium); in CI set it to the `chromium` binary provided by `nix develop` (`command -v chromium`).
- `COLONY_E2E_PORT` (default `4477`) and `COLONY_E2E_CONTROL_PORT` (default `4478`) — ports for the fake colonyd and its control server.

All suites use only the fake boundary plus a temp SQLite DB and temp dirs under `COLONY_E2E_TMP_DIR`.

## CI and images

`.gitlab-ci.yml` runs `validate → unit → e2e → build`. Build publishes the `colonyd` image (root `Dockerfile`) and the agent sandbox image (`docker/sandbox/Dockerfile`), tagged by commit SHA and `latest` on the default branch.
