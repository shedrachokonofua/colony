# Colony

Colony is a self-hosted control plane that turns a written engineering goal
into merged code. It plans the goal as a graph of tasks, runs one coding
agent per task in parallel on its own branch and merge request, tests every
merge request against the target branch before merging it, and then runs
the goal's acceptance commands against the merged result.

You operate it from a web console, a terminal UI, a CLI, or the HTTP API. It
runs as a single process backed by SQLite and your Git host.

[![status](https://img.shields.io/badge/status-early%20access-orange)](#status)
[![license](https://img.shields.io/badge/license-TBD-lightgrey)](#license)

[Example](#a-scope-start-to-finish) · [Concepts](#concepts) · [Lifecycle](#how-a-scope-runs) · [Agents](#agents) · [Models](#models-and-fallbacks) · [Architecture](#architecture) · [Sandboxes](#sandboxes) · [Install](#install) · [Deploy](#deploy) · [Interfaces](#interfaces) · [Integrations](#integrations) · [Status](#status)

## A scope, start to finish

An operator opened a scope against an empty GitLab project with this goal:

> Build a self-hostable Reddit clone as a production-ready Docker image.
> Posts, up/down votes, nested comments, ranked front page. Auth with
> sessions, no OAuth. Communities: create, join, list, post into.
> Server-rendered UI, SQLite, one container. Multi-stage Dockerfile, port
> 8080, compose file, README with exact commands, and a `colony.gate.yaml`
> that `docker build`s the image so the merge gate proves it packages.

Four minutes later the architect proposed nine tasks. It put the whole
schema in task 2 so no two feature tasks would write competing migrations,
and left voting and comments to run in parallel. The operator approved
the plan; the console showed it fill in from left to right:

![Scope sheet: the task graph across the top, with goal, plan, and activity cards beneath](docs/images/scope-sheet.png)

This is the scope sheet after the fact: the task graph by dependency, each
node in its final state; beneath it the goal as written, the architect's
plan and its run, and the audit feed. Every operator action (approve a
plan, unblock a task, request changes) is a button here and lands in the
audit log with your actor id.

Task 7, nested comments, is the one to click on:

![Task drawer: spec, merge request, and the run history including a reviewer's request_changes finding](docs/images/task-drawer.png)

The drawer shows the spec the architect wrote, the branch and merge
request, and every run against the task in order. The reviewer rejected
the first implementation: the comment tree was assembled by iterating a Go
map, so ordering was random despite the `ORDER BY`. The developer fixed
it and the reviewer approved. Then the merge gate found a conflict with
task 6, which had merged in parallel meanwhile; the task was requeued,
re-implemented on the new `main`, approved again, and the gate merged the
exact SHA it had tested.

Two hours and fifty-two minutes after the goal was written, nine merge
requests were on `main` and the scope's acceptance run had built the image
and passed the smoke test. Of 174 audit events, two were human: opening
the scope, and one `unblock` after GitLab had answered the first merge
with `401` three times and the operator fixed the token. The full timeline
and plan are in [docs/examples/reddit-clone.md](docs/examples/reddit-clone.md).

## Concepts

**Project.** A named container for related work. It holds a Markdown brief
and reference files that every agent working under the project receives:
architecture notes, conventions, forbidden areas, how to run the tests.
Projects have a scopes list, a running-tasks tab, and settings.

**Scope.** One goal against one repository: the goal text, the plan, the
acceptance commands, an approval mode (`auto` or `manual` merges), and a
status: `draft`, `planning`, `active`, `validating`, `blocked`, `paused`,
`done`, `abandoned`. A scope belongs to a project or stands alone.

**Task.** One node of the plan: a spec, its dependencies on other tasks, and
one branch and merge request. Task ids are `scope.N`. A task is `queued`
until its dependencies merge, then `running`, `mr_open`, `merged`, or
`blocked` if it needs you. Tasks record retry attempts, reviewer findings,
and any feedback you gave them.

**Run.** One execution attempt, attached to a scope and usually a task.
Kinds: `architect`, `plan_review`, `implement`, `review`, `merge_gate`,
`validate`. A run keeps its lease, base and head SHAs, the model that
actually ran it, its event stream, its evidence, and its artifacts. Runs
are what you read when something goes wrong.

## How a scope runs

```mermaid
flowchart LR
  G[Goal] --> A[Architect plans]
  A --> PR{Plan reviewer}
  PR -->|request_changes| A
  PR -->|approve| H{You approve?}
  H -->|replan with feedback| A
  H -->|approve| T[Task graph]
  T --> D[Developer per ready task]
  D --> R{Reviewer}
  R -->|request_changes| D
  R -->|approve| MG[Merge gate]
  MG -->|fail / conflict| D
  MG -->|merge| T
  T -->|all tasks terminal| V[Acceptance on fresh clone]
  V -->|pass| DONE[done]
  V -->|fail| A2[Architect repairs, max 2 rounds]
  A2 --> T
```

1. **Plan.** The architect inspects the repository and produces a task
   graph: per task, a spec, the files it expects to touch, the evidence
   commands that prove it, and its dependencies. It also writes the scope's
   acceptance commands.
2. **Review the plan.** With `review.mode: required`, a plan reviewer reads
   the plan against the checked-out repository and approves or sends it
   back with findings; the architect revises. After ten rejections the
   scope blocks and asks you.
3. **Approve.** With `hitl.mode: gated` you read the plan in the console and
   approve it or send it back with feedback. `yolo` skips this step.
4. **Implement in parallel.** Every task whose dependencies have merged gets
   a developer run on its own branch, up to `COLONYD_MAX_CONCURRENT` at
   once and within per-model limits. The developer pushes, runs the spec's
   evidence commands, and reports the branch and head SHA. Colony confirms
   the branch and commit exist on the Git host before opening the merge
   request.
5. **Review the code.** With `review.mode: required`, a reviewer reads the
   exact merge request head and approves or requests changes with findings.
   Changes requested requeue the developer with the findings; approvals are
   tied to the SHA, so a new push is re-reviewed.
6. **Gate and merge.** The merge gate clones the target branch fresh, merges
   the candidate head into it, scans the diff for secrets and stray
   credential files, runs the commands in the repository's
   `colony.gate.yaml`, re-checks that the merge request head has not moved,
   and merges that exact commit. If GitLab refuses because the head's
   pipeline is still running, the gate holds and retries on the next tick.
   A conflict or failing command requeues the task. Gates serialize per
   scope so parallel tasks land one at a time.
7. **Validate.** When every task is terminal and at least one merged, Colony
   clones the default branch fresh and runs the acceptance commands with no
   credentials. Pass: `done`. Fail: the architect gets the failure evidence
   and up to two repair rounds (fix the acceptance criteria, or append
   repair tasks to the graph); then the scope blocks and asks you.

Retries are bounded (`COLONYD_MAX_ATTEMPTS`, default 3) with exponential
backoff. Failures caused by infrastructure (a `401` from the Git host, a
provider outage) do not consume attempts; failures caused by the agent do.
Every state change is reconciled by a single-flight tick that reads facts
back from the Git host, so a restarted `colonyd` resumes where it stopped:
expired leases are reaped, their tokens revoked, and their tasks requeued.

## Agents

Four LLM roles, each configured separately, plus two deterministic
processes that use no model.

| Role              | Runs when                                   | Reads                                         | Produces                                                           |
| ----------------- | ------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| **Architect**     | Scope created; replan; validation failed    | Goal, project brief and files, the repository | Task graph with specs, dependencies, evidence commands; acceptance |
| **Plan reviewer** | Plan proposed, `review.mode: required`      | Plan, the repository                          | `approve` or `request_changes` with findings                       |
| **Developer**     | Task ready; reviewer or gate sent it back   | Task spec, project context, prior findings    | Commits on the task branch, evidence, head SHA                     |
| **Reviewer**      | Merge request open, `review.mode: required` | The exact merge request head                  | `approve` or `request_changes` with findings and files inspected   |
| Merge gate        | Reviewer approved (or review off)           | Fresh clone, `colony.gate.yaml`               | Merge of the tested SHA, or evidence of the failure                |
| Validation        | All tasks terminal                          | Fresh default-branch clone, acceptance list   | `done`, or evidence for the architect's repair round               |

The architect runs in two stages with separate context: a planning stage
that inspects the repository and drafts, and a verification stage that
checks the draft against the goal and the repository and emits the final,
size-checked plan. Reviewer approvals require inspected files and a
substantive summary; a bare "looks good" is rejected by schema.

Agents run on [Pi](https://github.com/can1357/oh-my-pi) as the agent
runtime. Each agent receives a packet: its role's instructions, the project
brief and reference files, the scope goal, the task spec, and any prior
findings. Agents can be given web access (`COLONY_SEARXNG_URL`: search plus
an SSRF-filtered fetch). A fake runtime (`AGENT_RUNTIME=fake`) exercises
the whole control plane without a model or a Git host and is what the test
suite runs against.

## Models and fallbacks

Each role names a provider and a model. Any OpenAI-compatible or Anthropic
endpoint works; the example config routes everything through a LiteLLM
gateway.

```yaml
providers:
  gateway:
    api: openai-completions
    base_url: https://litellm.example.com/v1
    auth: { kind: api_key, value: LITELLM_API_KEY } # env var name
    models:
      - id: deepseek-v4-flash
        context_window: 1048576
        max_tokens: 384000
      - id: glm-5.2
        max_parallel_runs: 2 # cap concurrent runs on this model
      - id: kimi-k3

agents:
  architect: { provider: gateway, model: glm-5.2 }
  plan_reviewer: { provider: gateway, model: kimi-k3 }
  developer:
    provider: gateway
    model: deepseek-v4-flash
    fallback_models: [glm-5.2, kimi-k3]
    thinking_level: high
    timeout_ms: 1800000
    max_turns: 250
  reviewer:
    provider: gateway
    model: kimi-k3
    fallback_models: [glm-5.2]
```

Fallbacks work at two points:

- **At dispatch.** If the primary model is at its `max_parallel_runs`, the
  run starts on the first fallback with a free slot instead of waiting.
- **During a run.** If the model errors or the provider is unavailable
  mid-session, the runtime fails over to the next model in
  `fallback_models` inside the same session and attempt, with the same
  capacity check.

The run records the model that actually finished it, the fallback event is
in the run's event stream, and every model that contributed to a merged
task is written into the merge provenance. Fallbacks are same-provider and
ordered. `plan_reviewer` inherits the `reviewer` entry if omitted.
Per-role `thinking_level`, `timeout_ms`, and `max_turns` bound cost;
per-model `cost` lets the console estimate spend per task.

## Architecture

```mermaid
flowchart TB
  subgraph clients [Operators]
    UI[Web console]
    TUI[TUI / CLI]
    API[HTTP API]
  end
  subgraph colonyd [colonyd, one process]
    HTTP[Hono HTTP server: API + console assets + webhooks]
    TICK[Tick: reconcile, dispatch, gate, validate]
    DB[(SQLite, WAL)]
    RUNS[Run registry: leases, tokens, drain]
    NOTIFY[Notifier]
    ART[Artifact store]
  end
  subgraph exec [Execution]
    RT[Agent runtime: Pi]
    SB[Sandbox engine: in-process or Kubernetes]
  end
  GIT[Git host: GitLab]
  LLM[Model providers]
  UI --> HTTP
  TUI --> HTTP
  API --> HTTP
  HTTP --> DB
  TICK --> DB
  TICK --> RUNS --> RT --> SB
  RT --> LLM
  TICK --> GIT
  GIT -->|webhooks| HTTP
  NOTIFY --> NTFY[ntfy]
  RUNS --> ART
```

| Component     | Where                                                   | Responsibility                                                                                                                                    |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colonyd`     | `apps/colonyd`                                          | The daemon. Boots config, store, provider, runtime, sandbox engine; serves HTTP; runs the tick every `COLONYD_TICK_MS` (15 s); drains on shutdown |
| Tick          | `apps/colonyd/src/tick.ts`                              | One deterministic pass: expire leases, poll the Git host, advance review/gate/merge, plan, dispatch developers, close scopes, validate            |
| Run handlers  | `apps/colonyd/src/runs/`                                | One module per run kind: `architect`, `plan-review`, `implement`, `review`, `merge-gate`, `validate`, `extend`                                    |
| Store         | `packages/core`                                         | SQLite schema, state machine (allowed transitions, backoff), audit log, plan materialization                                                      |
| Schemas       | `packages/schemas`                                      | Zod contracts for every agent envelope: plan, completion, verdicts. Agents that do not conform fail the run                                       |
| Agent runtime | `packages/agent-runtime`                                | `AgentRuntimeAdapter`: Pi runners per role, packet building, model failover, fake runtime                                                         |
| Sandboxes     | `packages/sandbox`, `sandbox-in-process`, `sandbox-k8s` | `SandboxEngine` protocol (provision, exec, read, write, destroy) and its two engines                                                              |
| Git host      | `packages/provider`, `packages/provider-gitlab`         | `ProviderAdapter`: repos, branches, merge requests, pipelines, webhooks; GitLab implementation and a fake                                         |
| Console       | `packages/console`                                      | Web UI: Lit web components served by `colonyd` at `/`, no build step, no CDN. `?demo` runs it offline on fixture data                             |
| CLI and TUI   | `apps/cli`                                              | `colony` binary: every operator action as a subcommand with `--json`; a live TUI with no arguments                                                |
| Config        | `packages/config`                                       | `colony.yaml` schema (providers, agents, review, HITL, sandbox, notifications, artifacts) and the environment contract                            |
| Observability | `packages/observability`                                | OpenTelemetry traces per run, Prometheus metrics on `COLONY_METRICS_PORT`; the console links each run to its trace                                |

State is one SQLite database (WAL) plus your Git host. Colony treats the Git
host as the source of truth for branches, commits, merge request heads, and
merges: an agent's claim is verified against it before any state changes.
Run artifacts go to local disk or S3; session transcripts to
`sessions_dir`. Agents get per-run scoped tokens that are revoked when the
run ends.

## Sandboxes

Where agents and acceptance commands execute is `sandbox.engine`. The merge
gate is not sandboxed by either engine: it clones and runs
`colony.gate.yaml` commands in `colonyd`'s own `/tmp`, so the daemon's
environment needs whatever your gate commands need.

**`in-process`** (default). Agent shells are child processes of `colonyd`
with the run's workspace as their root, a private `HOME`/`TMPDIR`, and an
allow-listed environment. This is workspace confinement, not isolation: an
agent runs as the `colonyd` user on the same kernel. Use it on a repository
you are willing to let an agent modify, or run `colonyd` itself in a
container.

**`kubernetes`**. Each run gets a `Sandbox` custom resource handled by the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller
(v0.4), which creates a Kata VM-backed pod: non-root (uid 1000), no
service-account token, all capabilities dropped, `RuntimeDefault` seccomp,
an ephemeral workspace volume. The prepared workspace is streamed into the
pod; commands run over `pods/exec`; the pod is destroyed when the run ends.
Developer sandboxes get 2 CPU / 4 GiB; reviewer and validation sandboxes
1 CPU / 2 GiB. Egress is whatever your NetworkPolicy allows, keyed on the
`colony.shdr.ch/sandbox-role` pod label. Acceptance validation runs in the
sandbox too; only the merge gate stays on the daemon.

The sandbox image (`docker/sandbox/Dockerfile`) contains Node 24, Bun, git,
tar, and Chromium; it carries no Colony code. Add your project's toolchain
to it and set `sandbox.kubernetes.image`.

## Install

Requirements: [Bun](https://bun.sh) 1.3.14, Git, a GitLab project token
with `api` scope, one model endpoint with an API key.

```sh
git clone <repo-url> colony && cd colony
bun install
cp .env.example .env
```

`.env`:

```dotenv
GITLAB_BASE_URL=https://gitlab.example.com
GITLAB_TOKEN=glpat-...
LITELLM_API_KEY=sk-...
COLONY_CONFIG_PATH=config/colony.yaml
COLONYD_MAX_CONCURRENT=3
```

`config/colony.yaml`: the `providers` and `agents` blocks from
[Models and fallbacks](#models-and-fallbacks), plus:

```yaml
agent_runtime: pi
hitl: { mode: gated } # you approve every plan
review: { mode: required } # plan reviewer and code reviewer on
sandbox: { engine: in-process }
```

In each repository Colony will work on, say what a merge must pass:

```yaml
# colony.gate.yaml
commands:
  - make test
```

Run:

```sh
bun run dev # console and API on http://localhost:4400
```

Then in the console: **New project**, paste the brief, add reference files,
**New scope**, write the goal for an engineer who cannot ask questions,
and wait for the plan to appear. [`config/colony.example.yaml`](config/colony.example.yaml)
documents every setting.

Without OIDC, the API trusts the `X-Actor-Id` header the console sends; bind
to localhost or put it behind your own authentication. Set
`COLONY_OIDC_ISSUER`, `COLONY_OIDC_CLIENT_ID`, and `COLONY_OIDC_REQUIRED_ROLE`
to require a bearer token from your identity provider instead.

## Deploy

### Docker Compose

One container running `colonyd`, built from the repository `Dockerfile`.
The image ships without a config file; you mount `colony.yaml` and a
`data/` directory for the database, artifacts, and transcripts.

```yaml
# compose.yaml
services:
  colonyd:
    build: .
    env_file: .env
    environment:
      COLONY_CONFIG_PATH: /workspace/config/colony.yaml
      COLONYD_DB_PATH: /workspace/data/colonyd.db
    ports:
      - "127.0.0.1:4400:4400"
    volumes:
      - ./config/colony.yaml:/workspace/config/colony.yaml:ro
      - ./data:/workspace/data
    restart: unless-stopped
```

```sh
mkdir -p data && chown 1000:1000 data # the image runs as uid 1000
docker compose up -d
curl -fsS localhost:4400/health
```

The container has git and a shell, not your project's toolchain. With
`sandbox.engine: in-process`, agents and acceptance commands run inside
it, so extend the image with what your repositories need, or move agent
execution to Kubernetes sandboxes below.

### Kubernetes

Two independent pieces: the daemon, and optionally a sandbox per agent run.

**The daemon.** A Deployment of the same image with:

- a PersistentVolumeClaim mounted at `/workspace/data`;
- `colony.yaml` from a ConfigMap, credentials from a Secret;
- liveness on `/health`, readiness on `/ready` (503 once draining starts);
- `terminationGracePeriodSeconds` of at least `COLONY_DRAIN_TIMEOUT_MS`
  (default 10 min) plus 60 s, so in-flight runs finish before the pod dies.

**Isolated agent runs.** Set `sandbox.engine: kubernetes`. Each run then
gets its own Kata VM pod (see [Sandboxes](#sandboxes)). The cluster needs,
per [`packages/sandbox-k8s/README.md`](packages/sandbox-k8s/README.md):

- the agent-sandbox v0.4 controller serving the `agents.x-k8s.io` `Sandbox` CRD;
- a `RuntimeClass` named `kata`;
- the `colony-sandboxes` namespace (configurable) with a NetworkPolicy on
  the `colony.shdr.ch/sandbox-role` label;
- RBAC for `colonyd` to `get`/`list`/`create`/`delete` sandboxes and
  `list` pods and use `pods/exec` in that namespace;
- your sandbox image built from `docker/sandbox/Dockerfile`, set as
  `sandbox.kubernetes.image`.

The engine uses in-cluster credentials when present and the default
kubeconfig otherwise. Colony ships no manifests or chart.
[`config/colony.deploy.yaml`](config/colony.deploy.yaml) is the config of
the cluster that builds Colony itself and shows a complete
Kubernetes-engine setup.

### Operations

**Back up** `COLONYD_DB_PATH` (with `sqlite3 .backup`, or stop `colonyd`
first), `artifacts.local.dir`, and `sessions_dir`.

**Observe** with OpenTelemetry traces (`OTEL_EXPORTER_OTLP_*`; every run
is a trace the console links to) and Prometheus metrics on
`COLONY_METRICS_PORT`.

**Get paged** through `notifications.sinks` (ntfy) when a plan awaits
approval, a task blocks, or a merge lands; severity thresholds, per-class
cooldowns, and a digest window keep it quiet.

## Interfaces

Everything below is the same HTTP API; the console, TUI, and CLI are
clients of it.

**Web console** at `/`. Projects list; project page with scopes, running
tasks, brief and reference files, settings; scope sheet with the task graph,
plan, acceptance results, activity, and a task drawer with the spec, merge
request, every run with its findings, a live event feed for the running
one, and the action buttons: unblock, stop and retry, run now, request
changes, amend spec, cancel, restore, approve merge.

**TUI.** `colony` with no arguments: live scopes and tasks in the terminal.

**CLI.** One subcommand per action, `--json` for scripts:

```sh
colony context my-project --set brief.md
colony open goal.md --title "Reddit clone" --repo group/reddit-clone --project my-project
colony scope col-d4bed30a
colony approve col-d4bed30a            # or: colony replan col-d4bed30a --feedback notes.md
colony logs <run-id> -f
colony artifacts <run-id>              # then: get <artifact-id> -o FILE
colony task col-d4bed30a.7 unblock
colony task col-d4bed30a.7 request-changes --feedback f.md
colony task col-d4bed30a.7 amend --spec s.md
colony pause col-d4bed30a && colony resume col-d4bed30a
colony task col-d4bed30a.7 approve-merge --sha <sha>   # scopes opened with --manual
```

Install: `(cd apps/cli && bun link)`, then `COLONY_URL=http://localhost:4400`.
Full reference in [apps/cli/README.md](apps/cli/README.md).

**HTTP API.** Routes in `apps/colonyd/src/http.ts`: `/projects` (brief,
files, running), `/scopes` (plan approval, replan, pause, resume, unblock,
acceptance, revalidate), `/tasks` (stop, cancel, restore, unblock, amend,
retry, request-changes, approve-merge), `/runs` (status, abort, events,
artifacts), `/audit`, `/health`, `/ready`, and the GitLab webhook. Send
`X-Actor-Id` or an OIDC bearer token. Examples in
[docs/development.md](docs/development.md).

## Integrations

| Boundary          | Interface                                                           | Shipped                           | Where to add one                                                |
| ----------------- | ------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| Git host          | [`ProviderAdapter`](packages/provider/src/index.ts)                 | GitLab                            | `packages/provider-<host>`, wired in `apps/colonyd/src/main.ts` |
| Agent runtime     | [`AgentRuntimeAdapter`](packages/agent-runtime/src/adapter.ts)      | Pi; fake for tests                | `packages/agent-runtime`, selected by `agent_runtime:`          |
| Sandbox engine    | [`SandboxEngine`](packages/sandbox/src/exec-protocol.ts)            | in-process, Kubernetes (Kata)     | `packages/sandbox-<engine>`, selected by `sandbox.engine:`      |
| Model provider    | `providers:` in `colony.yaml`                                       | OpenAI-compatible, Anthropic APIs | Config only                                                     |
| Notification sink | [`notifications/sinks.ts`](apps/colonyd/src/notifications/sinks.ts) | ntfy                              | Add a sender and a `kind`                                       |
| Artifact store    | `artifacts.kind` in `colony.yaml`                                   | local disk, S3                    | Config only                                                     |
| Operator auth     | `COLONY_OIDC_*`                                                     | Any OIDC issuer, or `X-Actor-Id`  | Config only                                                     |
| Telemetry         | `OTEL_EXPORTER_OTLP_*`, `COLONY_METRICS_PORT`                       | OTLP traces, Prometheus metrics   | Config only                                                     |

Each code boundary has one production implementation and a fake the test
suite runs against; a new implementation registers where the existing one
is constructed.

## Status

Early access. Colony has planned, implemented, reviewed, gated, and merged
its own merge requests since August 2026. Interfaces and the SQLite schema
still change without a migration path. GitLab is the supported Git host;
model providers authenticate with API keys.

## Documentation

[Worked example](docs/examples/reddit-clone.md) ·
[Configuration reference](config/colony.example.yaml) ·
[CLI and TUI](apps/cli/README.md) ·
[Kubernetes sandboxes](packages/sandbox-k8s/README.md) ·
[Development, tests, API](docs/development.md)

## License

TBD.
