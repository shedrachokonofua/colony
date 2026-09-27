# Colony agent interface: MCP + OAuth + skill

Status: approved 2026-09-27.

## Goal

Any agent can deeply understand Colony and operate it easily:

- shell agents (Claude Code, omp, Codex) via the `colony` CLI and a file skill;
- tool-only agents, remote (OpenWebUI, Hermes) and local (Claude Desktop, Cursor), via MCP.

## Components

### 1. `/mcp` in colonyd

- Streamable HTTP MCP endpoint, stateless, mounted in the existing Hono app.
- Tools are a thin adapter: validate input, call the existing route in-process
  (`app.request`) with the caller's `Authorization` header. Same state guards,
  same audit actor, same deployed version. No business logic in the adapter.
- Tool set (~12): `colony_status` (operator summary), `list_projects`,
  `list_scopes`, `get_scope`, `get_task`, `get_run`, `run_events`,
  `open_scope`, `approve_plan`, `replan`, `scope_action`
  (pause/resume/abandon/revalidate/unblock), `task_action`
  (retry/stop/cancel/restore/unblock/amend/request-changes/approve-merge),
  `colony_guide`.
- Tools that stop or discard work carry `destructiveHint: true`.
- Server `instructions`: short mental model and safety rules.
- `colony_guide(topic?)` returns the skill's `SKILL.md` or a reference file.
- Skill files are also exposed as resources at `skill://colony/...` so native
  `io.modelcontextprotocol/skills` serving is additive once the TS SDK ships it.

### 2. OAuth (Keycloak 26.6.4, no upgrade)

colonyd:

- `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728):
  `resource = https://<host>/mcp`, `authorization_servers = [<issuer>]`,
  `scopes_supported = ["mcp"]`.
- 401 from `/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata="<metadata url>", scope="mcp"`.
- Verifier accepts tokens whose `azp`/`aud` includes `colony` (existing) or the
  MCP resource URL; realm role `admin` still required.
- Audit actor unchanged (`human:<user>` / `svc:<client>`); the token's `azp`
  is recorded in audit detail for MCP calls so the acting app is visible.

Aether (IaC, separate approval):

- Client scope `mcp` with an Audience mapper stamping the MCP resource URL and
  `colony` (workaround: Keycloak ignores RFC 8707 `resource`).
- Anonymous DCR restricted by client registration policies: trusted hosts, allowed
  client scopes including `mcp`.
- Pre-registered confidential client for OpenWebUI ("OAuth 2.1 (Static)").
- Public client with device authorization grant + `offline_access` for Hermes.
- No CIMD (experimental, needs a Keycloak rebuild/restart).

### 3. CLI

- `colony login`: device flow (humans, `colony` client with device grant) or
  client credentials (`COLONY_CLIENT_ID` / `COLONY_CLIENT_SECRET`); tokens cached
  in `~/.config/colony/credentials.json` (0600) and refreshed automatically.
  Existing `--token` / `COLONY_TOKEN` / token file remain explicit sources.

### 4. Skill `skills/colony/`

- Tracked in git, copied into the colonyd image.
- `SKILL.md`: mental model (project → scope → plan → tasks → runs → MR → merge),
  golden workflows, safety rules, CLI vs MCP.
- `references/`: lifecycle and blocked reasons, operator playbooks, failure
  investigation (absorbs `aether-colony-investigation`), Aether IaC deploy.
- Exact syntax lives in `colony --help` and MCP `tools/list`, not the skill.

## Out of scope

Colony-issued static tokens, `colony mcp` stdio bridge, CIMD, native skills
extension (until SDK support), OpenAPI generation, remaining CLI command gaps.

## Verification

- MCP e2e: SDK client against in-process colonyd (fake provider): list tools,
  call read + mutating tools, destructive hints present, `colony_guide` returns
  the skill, 401 carries resource metadata, metadata document shape.
- Token acceptance for MCP resource audience; rejection without `admin`.
- CLI login: client-credentials mint + refresh; device flow against a stub.
- Skill lint: frontmatter `name` matches directory, relative links resolve.
- Live: Claude Code (DCR), OpenWebUI (static), Hermes (device) each list tools
  and read `colony_status` against production after rollout.

## Rollout order

1. colonyd `/mcp` + metadata + skill (works immediately with existing bearer
   tokens, e.g. operator client credentials).
2. CLI `colony login`.
3. Aether Keycloak config, then per-client connection and live verification.
