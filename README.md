# Colony

Colony runs coding agents against a repository unattended. You give it a
goal; it plans the goal as a graph of tasks, runs one agent per task in
parallel on separate branches, and merges each branch only after your
checks pass in a clean clone. You approve plans and read merge requests.

[![status](https://img.shields.io/badge/status-early%20access-orange)](#status)
[![license](https://img.shields.io/badge/license-TBD-lightgrey)](#license)

[Example](#a-scope-start-to-finish) · [Why](#why-colony) · [Run it](#run-it) · [Use it](#use-it) · [Adapt it](#adapt-it) · [Deploy](#deploy) · [Status](#status)

## A scope, start to finish

On 2026-08-16 an operator gave Colony this goal against an empty GitLab
project:

> Build a self-hostable Reddit clone as a production-ready Docker image.
> Link aggregator: posts, up/down votes, nested comments, ranked front page.
> Auth with sessions, no OAuth. Communities: create, join, list, post into.
> Server-rendered UI, SQLite, one container. Multi-stage Dockerfile, port
> 8080, compose file, README with exact commands, and a `colony.gate.yaml`
> that `docker build`s the image so the merge gate proves it packages.

Four minutes later the architect proposed nine tasks. It put the entire
schema in task 2 so that no two feature tasks would ever write competing
migrations, and left voting and comments to run in parallel:

```
1 skeleton ─ 2 schema ─ 3 auth ─ 4 communities ─ 5 posts ─┬─ 6 voting ───┬─ 8 docker ─ 9 gate+README+smoke
                                                           └─ 7 comments ─┘
```

Two hours and fifty-two minutes after that, nine merge requests were on
`main` and the scope's own acceptance run had built the image and passed
the smoke test. Along the way:

- The reviewer sent task 7 back once: the comment tree was assembled by
  iterating a Go map, so ordering was random despite the `ORDER BY`.
- The gate refused task 7 once: it conflicted with task 6, which had landed
  in parallel. The task was requeued and re-implemented on the new `main`.
- GitLab rejected the very first merge with `401`. After three identical
  failures Colony blocked the task and waited. The operator fixed the token
  and pressed unblock. That, and creating the scope, were the only two human
  actions among 174 audit events.

The full timeline, plan, and evidence are in
[docs/examples/reddit-clone.md](docs/examples/reddit-clone.md).

## Why Colony

**You manage goals, not agents.** A scope is the unit of work. The
architect turns it into a dependency graph; the graph decides what runs
next; you are asked only when a decision is yours: approve a plan, unblock
a task, approve a merge if you asked for that.

**Merges are earned, not claimed.** An agent saying "done" is evidence. The
branch, the commit, the merge request, and the merge are facts Colony reads
back from your Git host before it changes any state. The gate merges the
candidate onto the target in a fresh clone, scans the diff for secrets,
runs the commands in `colony.gate.yaml`, requires a green pipeline if the
project has CI, and merges only the exact commit it tested.

**Every part you would want to swap is swappable.** Git host, agent
runtime, sandbox engine, model per role, notification sink, artifact
store. Colony's own history was built on a rotating set of open and
low-cost models; the gate, not the model, guards `main`.

**It runs itself.** `colonyd` is one process whose state is one SQLite
database plus your Git host. Restart it mid-run and it resumes; dead runs
are reaped, their tokens revoked, their tasks requeued. Since August 2026
this repository's merge requests have been implemented, gated, and merged
by Colony.

## Run it

You need [Bun](https://bun.sh) 1.3+, Git, a GitLab project token with
`api` scope (GitLab is the Git host adapter that ships today, see
[Status](#status)), and one OpenAI-compatible endpoint.

```sh
git clone <repo-url> colony && cd colony
bun install
```

`.env`:

```dotenv
GITLAB_BASE_URL=https://gitlab.example.com
GITLAB_TOKEN=glpat-...
COLONY_OPENAI_COMPATIBLE_API_KEY=sk-...
COLONY_CONFIG_PATH=config/colony.yaml
COLONYD_MAX_CONCURRENT=3        # implementers running at once
```

`config/colony.yaml`, with review on so every merge request is checked
before the gate:

```yaml
agent_runtime: pi
review: { mode: required }
providers:
  openai:
    api: openai-completions
    base_url: https://api.openai.com/v1
    auth: { kind: api_key, value: COLONY_OPENAI_COMPATIBLE_API_KEY }
    models:
      - id: gpt-5.5
agents:
  architect: { provider: openai, model: gpt-5.5 }
  developer: { provider: openai, model: gpt-5.5 }
  reviewer: { provider: openai, model: gpt-5.5 }
  plan_reviewer: { provider: openai, model: gpt-5.5 }
```

In the repository Colony will work on, tell the gate what "passes" means:

```yaml
# colony.gate.yaml
commands:
  - make test
```

Start it:

```sh
bun run dev          # http://localhost:4400
```

The console is at that URL. For the CLI:

```sh
(cd apps/cli && bun link)
export COLONY_URL=http://localhost:4400
```

A working default for everything else (fallback models, sandboxes,
notifications, artifact storage) is in
[`config/colony.example.yaml`](config/colony.example.yaml).

> With the default in-process engine, agents run as the `colonyd` user on
> the host with workspace confinement only. Start with a repository you are
> willing to let an agent modify, or run agents in
> [Kubernetes sandboxes](#deploy).

## Use it

**1. Give the project standing context.** Anything every agent should know
about the codebase: conventions, forbidden areas, how to run tests.

```sh
colony context my-project --set brief.md
```

**2. Write the goal and open a scope.** Outcomes, constraints, and what
done looks like, for an engineer who cannot ask questions.

```sh
colony open goal.md --title "Reddit clone" --repo group/reddit-clone --project my-project
```

**3. Approve the plan.** In a few minutes the scope sheet shows the
architect's proposal: each task's spec, files, evidence, and dependencies.
Approve it, or send it back with feedback.

```sh
colony scope col-d4bed30a          # read the plan
colony approve col-d4bed30a        # or: colony replan col-d4bed30a --feedback notes.md
```

**4. Watch, or don't.** Tasks whose dependencies are merged get an agent,
a branch, and a merge request. The scope sheet's graph shows each task's
state live; click one for its run feed and merge request. The TUI
(`colony` with no arguments) shows the same on a terminal.

```sh
colony logs <run-id> -f            # stream one agent's events
```

**5. Act when asked.** A push notification (ntfy) arrives when a plan or
merge awaits you, or a task blocks. Your options:

| Situation                                          | Action                                          |
| -------------------------------------------------- | ----------------------------------------------- |
| Task blocked (retries exhausted, infra error)      | fix the cause, `colony task T unblock`          |
| A merge request needs a change                     | `colony task T request-changes --feedback f.md` |
| The spec was wrong                                 | `colony task T amend --spec s.md`               |
| Stop everything for a while                        | `colony pause S` / `colony resume S`            |
| Manual scope (`open --manual`): approve each merge | `colony task T approve-merge --sha SHA`         |

Every action is also a button on the scope sheet, and every action lands in
the audit log with your actor id.

**6. Done.** When the last task merges, Colony re-clones `main` and runs the
acceptance commands the architect put in the plan. Pass, and the scope is
`done`. Fail, and the architect gets up to two repair rounds before the
scope blocks and you are asked.

How much you are asked is two settings: `hitl.mode` (`gated`: you approve
every plan; `yolo`: plans auto-approve) and `review.mode` (`required`: an
LLM reviewer must approve each merge request head; `off`). `open --manual`
adds a human merge approval per task on top of the gate.

## Adapt it

Two kinds of knobs. The first is configuration:

| What                                       | Where                                               | Options today                                                                             |
| ------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Model per role, fallbacks, concurrency cap | `agents:` and `providers:` in `colony.yaml`         | any OpenAI-compatible endpoint; per-role `fallback_models`; per-model `max_parallel_runs` |
| What must pass before a merge              | `colony.gate.yaml` in the target repository         | shell commands, timeout                                                                   |
| What must pass for the scope               | architect's acceptance commands; editable per scope | shell commands run on a fresh clone of `main`                                             |
| Where agents run                           | `sandbox.engine`                                    | `in-process`, `kubernetes`                                                                |
| Who is told                                | `notifications.sinks`                               | ntfy                                                                                      |
| Where run artifacts go                     | `artifacts.kind`                                    | local disk, S3                                                                            |
| Agent web access                           | `COLONY_SEARXNG_URL`                                | SearXNG search + SSRF-filtered fetch                                                      |
| Metrics and traces                         | `COLONY_METRICS_PORT`, `OTEL_EXPORTER_OTLP_*`       | Prometheus, OTLP                                                                          |

The second is code. Each of these is a TypeScript interface with one
production implementation and a fake the test suite runs against.
Implement the interface, register it where the existing one is
constructed, and the rest of Colony does not know the difference:

| Boundary          | Interface                                                                                                 | Ships                                     | Add one                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| Git host          | [`ProviderAdapter`](packages/provider/src/index.ts): repos, branches, MRs, pipelines, webhooks            | GitLab                                    | `packages/provider-<host>`, constructed in `apps/colonyd/src/main.ts` |
| Agent runtime     | [`AgentRuntimeAdapter`](packages/agent-runtime/src/adapter.ts): start, status, output, cancel             | [Pi](https://github.com/can1357/oh-my-pi) | `packages/agent-runtime`, selected by `agent_runtime:`                |
| Sandbox engine    | [`SandboxEngine`](packages/sandbox/src/exec-protocol.ts): provision, exec, read, write, destroy           | in-process, Kubernetes (Kata VMs)         | `packages/sandbox-<engine>`, selected by `sandbox.engine:`            |
| Notification sink | sender registered in [`apps/colonyd/src/notifications/sinks.ts`](apps/colonyd/src/notifications/sinks.ts) | ntfy                                      | add a sender and a `kind`                                             |

## Deploy

**Docker.** The image contains no `config/colony.yaml`; mount yours, and
mount `data/` so the database, artifacts, and session transcripts persist:

```sh
docker build -t colonyd .
docker run --env-file .env -p 4400:4400 \
  -v "$PWD/config/colony.yaml:/workspace/config/colony.yaml:ro" \
  -v "$PWD/data:/workspace/data" \
  colonyd
```

**Kubernetes with isolated agents.** Install the agent-sandbox controller
(v0.4, `Sandbox` CRD) and a `kata` RuntimeClass, add the namespace,
NetworkPolicy, and RBAC from
[`packages/sandbox-k8s/README.md`](packages/sandbox-k8s/README.md), then set
`sandbox.engine: kubernetes`. Each agent run becomes a Kata VM pod:
non-root, no service-account token, capabilities dropped, egress limited by
your NetworkPolicy.

**State.** SQLite in WAL mode at `COLONYD_DB_PATH`, run artifacts under
`artifacts.local.dir`, session transcripts under `sessions_dir`. Back up
all three; use `sqlite3 .backup` or stop `colonyd` for the database.
Health at `/health`, readiness at `/ready`.

## Status

Early access. Colony builds itself daily, but interfaces and the SQLite
schema still change without a migration path.

- **GitLab is the only Git host adapter today.** The interface is
  host-agnostic and has a fake adapter; GitHub is an adapter waiting to be
  written.
- **API-key model providers only.** Subscription OAuth (Codex, Claude) is
  accepted by the config schema but rejected by the runtime.
- **Bun, not Node.** The agent runtime ships Bun-native TypeScript.

## Documentation

[Worked example](docs/examples/reddit-clone.md) ·
[Configuration reference](config/colony.example.yaml) ·
[CLI and TUI](apps/cli/README.md) ·
[Kubernetes sandboxes](packages/sandbox-k8s/README.md) ·
[Development and tests](docs/development.md)

## License

TBD.
