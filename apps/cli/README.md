# `@colony/cli`

Operator CLI and terminal user interface (TUI) for the Colony control plane.

## Installation

Run `bun install` at the repository root, then link the CLI binary globally:

```bash
bun install
cd apps/cli && bun link
```

The `colony` binary is now available in your `$PATH`.

Alternatively, invoke the entry point directly with `bun`:

```bash
bun apps/cli/src/main.ts <command> [flags]
```

## Authentication & Connection Setup

### Logging In

`colony login` authenticates against the OIDC issuer and stores credentials in `~/.config/colony/credentials.json` (mode `0600`):

- **Device flow** (default, `colony login`): OAuth 2.0 Device Authorization Grant (RFC 8628) with client id `colony-cli` (override with `COLONY_OIDC_CLIENT_ID`) and scope `openid offline_access`. The CLI prints a verification URL and user code to stderr and polls the token endpoint until you authorize. A refresh token is stored so the CLI can renew the session.
- **Client credentials** (`colony login --client-credentials`): the `client_credentials` grant with `--client-id`/`--client-secret` or `COLONY_CLIENT_ID`/`COLONY_CLIENT_SECRET`. The secret is kept in `credentials.json` (mode `0600`) so the CLI can re-mint tokens on demand.

The issuer defaults to `https://auth.shdr.ch/realms/aether`; override it with `--issuer` or `COLONY_OIDC_ISSUER`. Endpoints are discovered from `<issuer>/.well-known/openid-configuration`. `colony logout` deletes `~/.config/colony/credentials.json`. Tokens are never printed.

### Precedence Chains

The CLI resolves connection settings and credentials using the following precedence chains:

- **Server URL**:
  1. `--server <url>` flag
  2. `COLONY_URL` environment variable
  3. Default fallback: `https://colony.home.shdr.ch`
- **API Token**:
  1. `--token <t>` flag
  2. `COLONY_TOKEN` environment variable
  3. `~/.config/colony/credentials.json` (from `colony login`). When the access token has less than 60 seconds to live, the CLI renews it first: refresh-token grant when a `refresh_token` is stored, re-mint via the stored client secret for `client_credentials` sessions. The renewed token is written back to the file.
  4. Legacy token file: `~/.config/colony/token` (file permissions `0600`)
  5. In-memory `client_credentials` mint when both `COLONY_CLIENT_ID` and `COLONY_CLIENT_SECRET` are set (uses `COLONY_OIDC_ISSUER` if present; nothing is written to disk)
- **Audited Actor**:
  1. `--actor <a>` flag
  2. `COLONY_ACTOR` environment variable
  3. Current system user: `$USER` (fallback: `unknown`)

### Credentials File

`~/.config/colony/credentials.json` records the login so later commands can renew the token without another login (`expires_at` is epoch milliseconds):

```json
{
  "issuer": "https://auth.shdr.ch/realms/aether",
  "client_id": "colony-cli",
  "grant": "device",
  "access_token": "…",
  "refresh_token": "…",
  "expires_at": 1790000000000
}
```

A `client_credentials` login additionally stores `client_secret` for re-minting; the file is always written with mode `0600`.

### Token File Bootstrap (Legacy)

The pre-OIDC token file is still honored after `credentials.json`. To use it, write your token to the configuration file:

```bash
mkdir -p ~/.config/colony && printf '%s' TOKEN > ~/.config/colony/token && chmod 600 ~/.config/colony/token
```

### Actionable Auth Errors

If an API request fails with HTTP status `401 Unauthorized` or `403 Forbidden`, the CLI outputs a single actionable line identifying the active token source:

```text
auth failed (401): token from ~/.config/colony/token — check it, or set --token / ~/.config/colony/token
```

The message specifies whether the rejected token originated from `--token`, `COLONY_TOKEN`, `~/.config/colony/credentials.json`, `~/.config/colony/token`, or an in-memory env-var mint.

## Global Flags

The following global flags are supported by every subcommand:

- `--server <url>`: colonyd base URL (defaults to `$COLONY_URL` or `https://colony.home.shdr.ch`).
- `--token <t>`: API token (defaults to `$COLONY_TOKEN`, then `colony login` credentials or `~/.config/colony/token`).
- `--actor <a>`: Audited actor identifier (defaults to `$COLONY_ACTOR` or `$USER`).
- `--json`: Format command output as machine-readable JSON on stdout.

## Subcommands

Every subcommand and its accepted flags:

- `colony login [--client-credentials] [--client-id ID] [--client-secret SECRET] [--issuer URL]`
  Authenticate and store credentials in `~/.config/colony/credentials.json` (mode `0600`). The default is the OAuth device flow (client `colony-cli`, override with `COLONY_OIDC_CLIENT_ID`); `--client-credentials` mints with a client secret from the flags or `COLONY_CLIENT_ID`/`COLONY_CLIENT_SECRET`.
- `colony logout`
  Delete stored credentials.

- `colony scopes [--project P] [--page N]`
  List scopes across the system or filtered by project, paginated 25 per page.
- `colony scope <id>`
  Show detailed status, task list, and run summaries for a scope.
- `colony open <file|-> --title T [--project P] [--repo PATH] [--manual] [--create-project]`
  Open a new scope with a goal file or stdin (`-`). Requires `--repo PATH`. If `--project` is provided, unknown projects are refused unless `--create-project` is set. Use `--manual` to enforce manual approval gating.
- `colony approve <id>`
  Approve the planned task DAG for a scope in `planning` status.
- `colony replan <id> --feedback <file|->`
  Request a scope replan with operator feedback provided from a file or stdin (`-`).
- `colony abandon <id> [--yes]`
  Abandon a scope and terminate active runs. Prompts for confirmation unless `--yes` is supplied.
- `colony revalidate <id>`
- `colony pause <id>`: abort the scope's live runs, requeue their tasks, and hold the scope until `resume`
- `colony resume <id>`: return a paused scope to the status it left
  Trigger a fresh post-merge validation run for a scope.
- `colony task <id> [retry|stop|cancel|restore|unblock | amend --spec <file|-> | request-changes --feedback <file|-> | approve-merge --sha <sha>]`
  Inspect a task or execute task-level lifecycle mutations:
  - `task <id>`: Inspect task state, MR, attempt count, model, and spec summary.
  - `task <id> retry`: Re-queue a failed or stopped task attempt.
  - `task <id> stop`: Stop a running task run.
  - `task <id> cancel`: Cancel a queued or running task.
  - `task <id> restore`: Restore a canceled or abandoned task back to queued.
  - `task <id> unblock`: Clear blocked state and re-queue the task.
  - `task <id> amend --spec <file|->`: Append an authoritative spec amendment.
  - `task <id> request-changes --feedback <file|->`: Request reviewer changes with feedback.
  - `task <id> approve-merge --sha <sha>`: Approve merging the MR at the specified commit SHA.
- `colony runs <scope-id>`
  List all runs associated with a scope.
- `colony run <run-id>`
  Inspect a single run, showing its kind, status, model, scope, task, timing, and failure reason if failed.
- `colony logs <run-id> [-f]`
  Stream or display event logs for a run. Pass `-f` (or `--follow`) to stream live events until completion.
- `colony artifacts <run-id> [get <artifact-id> -o FILE]`
  List artifacts produced by a run, or download an artifact to a local file using `get <artifact-id> -o FILE`.
- `colony projects`
  List all registered projects, showing name, scope count, file count, and last update timestamp.
- `colony project <name>`
  Show details for a specific project.
- `colony context <name> [--set <file|->]`
  Print a project's context document, or update it by providing `--set <file|->`.
- `colony audit [--scope S] [--task T] [-n N]`
  Display recent operator audit log events, optionally filtered by scope ID or task ID (default limit: 25).
- `colony status`
  Display control plane health, draining status, scope counts by status, and active runs.

## Terminal User Interface (TUI)

Launch the interactive dashboard by running `colony` with no arguments in an interactive terminal (TTY):

```bash
colony
```

### Requirements

- Minimum terminal size: **80 columns by 24 rows** (80x24).

### Key Map

| Key                   | Action                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `j` / `k` / `↓` / `↑` | Navigate items in the active pane (scopes or tasks)                 |
| `h` / `l`             | Switch focus between Scopes list (`h`) and Tasks list (`l`)         |
| `a`                   | Approve plan for the selected scope                                 |
| `R`                   | Request replan for the selected scope (opens `$VISUAL` / `$EDITOR`) |
| `A`                   | Abandon the selected scope (prompts for `y`/`n` confirmation)       |
| `r`                   | Retry the selected task                                             |
| `s`                   | Stop the selected task                                              |
| `u`                   | Unblock the selected task                                           |
| `m`                   | Approve merge for the selected task (prompts for commit SHA)        |
| `q` / `Ctrl+C`        | Quit TUI                                                            |

## Exit Codes

- `0`: Success.
- `1`: API, network, or runtime command error.
- `2`: Usage error (invalid arguments, missing required flags, unknown subcommand/project).
